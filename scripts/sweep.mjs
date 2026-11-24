#!/usr/bin/env node
// 量測：node sweep.mjs <設定檔> [頁面 id ...] [--site=before|after|both] [--jobs=3] [--compare=<舊 run>[:<site>]]
// 產生「待看的線索」，不是缺陷判定。
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadPlaywright, siteUrl, nowIso, parseArgs, csv, pickSites, makeRun, siteInfo, describeSite, toolInfo, toolLine, rerunCommand, checkFlags, inside, logProgress, finishRun, notify, previousRunLines } from "./lib/config.mjs";
import { BrowserPool, newPage, checkEnv, openWithRetry, prepareLayout, sleep, smokeCheck } from "./lib/browser.mjs";
import { classify, parseChecks, ALL_CHECKS, groupReview, tallyByReason, worstPhrase, fmtWidths, fmtPages, CHECK_NAME, demoteReappeared } from "./lib/group.mjs";
import { shootBucket } from "./lib/evidence.mjs";
import { parseCompareSpec, buildBaseline, compareGroups, compareConditions, loadBaselineFromRun, summarize } from "./lib/compare.mjs";

const EVIDENCE_MAX = 40; // 最多幾組附代表截圖
const LIST_MAX = 80; // 主清單最多列幾組（其餘只記數量，完整在 sweep-groups.json）

const { positional, opt } = parseArgs(process.argv.slice(2));
const [configFile, ...pageArgs] = positional;
let cfg;
try {
  checkFlags(opt, ["site", "run", "jobs", "pages", "profiles", "no-breakpoints", "with-breakpoints", "no-smoke", "compare", "checks", "notify"]);
  cfg = loadConfig(configFile);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const pw = await loadPlaywright(cfg).catch((e) => {
  console.error(e.message);
  process.exit(2);
});
const fail2 = (m) => { console.error(m); process.exit(2); };

let pages = cfg.pages || [];
const pageIds = [...pageArgs, ...csv(opt.pages)];
if (pageIds.length) {
  const missing = pageIds.filter((i) => !pages.some((p) => p.id === i));
  if (missing.length) fail2(`設定檔沒有這些頁面：${missing.join(", ")}`);
  pages = pages.filter((p) => pageIds.includes(p.id));
}
if (!pages.length) fail2("沒有要量的頁面（設定檔 pages 是空的）");

// 沒指定 --site：有 after 就量 after，否則量唯一的那個網站
let sites;
try {
  sites = pickSites(cfg, opt.site, { prefer: "after" });
} catch (e) {
  fail2(e.message);
}
let jobs = 3;
if (opt.jobs !== undefined) {
  jobs = Number(opt.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) fail2(`--jobs 要是 1–16 的整數，收到「${opt.jobs}」`);
}
// 比對對象：有 --compare 就讀舊 run（起跑前先確認讀得到）；--site=both 且沒有 --compare 時，after 對本次的 before
// 被比對的是 after（沒有就是第一個網站）
const cmpTarget = sites.includes("after") ? "after" : sites[0];
let cmpBase = null; // --compare 讀進來的基準；null 且 cmpInRun 為真時用本次的 before
let cmpOverride = false;
const cmpInRun = !opt.compare && sites.includes("before") && sites.includes("after");
if (opt.compare !== undefined) {
  try {
    if (typeof opt.run === "string" && parseCompareSpec(opt.compare).run === opt.run) fail2("--run 不能和 --compare 的 run 同名，會把基準蓋掉");
    cmpBase = loadBaselineFromRun(cfg.outDir, opt.compare, cmpTarget);
  } catch (e) {
    fail2(e.message);
  }
  cmpOverride = sites.length > 1;
}
// --checks：逗號列表；regression = 回歸預設集；沒給 = 全部
let enabledChecks;
try {
  enabledChecks = parseChecks(opt.checks);
} catch (e) {
  fail2(e.message);
}
const allProfiles = Object.entries(cfg.profiles).map(([name, p]) => ({ name, ...p }));
const profFilter = csv(opt.profiles);
if (profFilter.length) {
  const missing = profFilter.filter((n) => !cfg.profiles[n]);
  if (missing.length) fail2(`設定檔沒有這些 profile：${missing.join(", ")}`);
}
const profiles = profFilter.length ? allProfiles.filter((p) => profFilter.includes(p.name)) : allProfiles;
// 指定 --profiles 時預設不量斷點（斷點會用到最接近的 profile 高度），要量加 --with-breakpoints
const doBreakpoints = !opt["no-breakpoints"] && (!profFilter.length || opt["with-breakpoints"]);

// ===== 頁面內量測（會被序列化進瀏覽器，不能引用外面的變數）=====
function measurePage(a) {
  const { width, minTap, doJump, doTap } = a;
  const on = new Set(a.checks);
  const cssList = a.cssList || [];
  const out = { overflow: [], clipped: [], scrollbox: [], shortLastLine: [], tap: [], invisible: [], fixedCover: [] };
  const lines = {};
  const sizes = {};
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  window.__tqaN = window.__tqaN || 0;
  const tag = (el) => {
    let id = el.getAttribute("data-tqa");
    if (!id) {
      id = String(++window.__tqaN);
      el.setAttribute("data-tqa", id);
    }
    return id;
  };
  const dr = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) });
  const text40 = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const sel = (el) => {
    const parts = [];
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && n !== document.documentElement && d < 4; d++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const tid = n.getAttribute("data-testid");
      if (n.id && !/\d{3,}|:/.test(n.id)) { parts.unshift(`${s}#${CSS.escape(n.id)}`); break; }
      if (tid) { parts.unshift(`${s}[data-testid="${tid}"]`); break; }
      const cls = [...n.classList].filter((c) => !/[:\[\]\/()]/.test(c) && c.length < 30).slice(0, 2);
      if (cls.length) s += "." + cls.map((c) => CSS.escape(c)).join(".");
      const p = n.parentElement;
      if (p) {
        const sib = [...p.children].filter((c) => c.tagName === n.tagName);
        if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const srOnly = (r) => r.width <= 1 || r.height <= 1;
  // 每條線索附：tokens（標籤、id、class、testid，給字串例外精確比對）、matches（符合哪些例外 css）、
  // pid（父元素標記，只合併同一父層的兄弟）、sig／clone（跑馬燈複製的元素）
  const CLONE = '[class*="clone" i], [class*="duplicate" i], [data-clone], [data-duplicate], [class*="marquee" i] [aria-hidden="true"]';
  const srcOf = (el) => {
    const i = el.tagName === "IMG" ? el : el.querySelector("img");
    return i ? (i.currentSrc || i.src || "").slice(-60) : "";
  };
  const meta = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tokens: [el.tagName.toLowerCase(), el.id, el.getAttribute("data-testid"), ...el.classList].filter(Boolean),
      matches: cssList.filter((c) => { try { return el.matches(c); } catch { return false; } }),
      pid: el.parentElement ? tag(el.parentElement) : undefined,
      sig: `${el.tagName.toLowerCase()}|${Math.round(r.width)}x${Math.round(r.height)}|${srcOf(el) || text40(el)}`,
      clone: !!el.closest(CLONE),
    };
  };
  const refs = new Map(); // 線索 → 元素（去重用，不會傳回 Node）
  const add = (check, el, entry) => {
    Object.assign(entry, meta(el));
    refs.set(entry, el);
    out[check].push(entry);
  };
  const push = (check, el, value, extra = {}) =>
    add(check, el, { selector: sel(el), text: text40(el), rect: dr(el.getBoundingClientRect()), value, ...extra });

  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|SVG|HEAD|TEMPLATE)$/i;
  const all = [...document.body.querySelectorAll("*")].filter((e) => !SKIP.test(e.tagName) && !e.closest("svg"));
  const TEXT_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "A", "BUTTON", "SPAN", "DD", "DT", "TD", "TH", "LABEL", "DIV"]);
  const hasDirectText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const textEls = all.filter((e) => TEXT_TAGS.has(e.tagName) && hasDirectText(e));

  // ---- 行數 / 最後一行 ----
  const collectNodes = (el, acc = []) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (n.nodeValue.trim()) acc.push(n);
      } else if (n.nodeType === 1 && !SKIP.test(n.tagName)) {
        const cs = getComputedStyle(n);
        if ((cs.display.startsWith("inline") || cs.display === "contents") && cs.visibility !== "hidden") {
          const r = n.getBoundingClientRect();
          if (cs.display === "contents" || !srOnly(r)) collectNodes(n, acc);
        }
      }
    }
    return acc;
  };
  const range = document.createRange();
  const lineGroups = (nodes) => {
    const rs = [];
    for (const n of nodes) {
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rs.push(r);
    }
    rs.sort((p, q) => p.top - q.top || p.left - q.left);
    const gs = [];
    for (const r of rs) {
      const g = gs[gs.length - 1];
      if (g && Math.abs(r.top - g.top) <= 2) {
        g.left = Math.min(g.left, r.left);
        g.right = Math.max(g.right, r.right);
      } else gs.push({ top: r.top, left: r.left, right: r.right });
    }
    return gs;
  };
  const lastLineText = (nodes, top) => {
    let s = "";
    for (let i = nodes.length - 1; i >= 0; i--) {
      const v = nodes[i].nodeValue;
      let off = v.length;
      while (off > 0) {
        let start = off - 1;
        if (start > 0 && /[\uDC00-\uDFFF]/.test(v[start]) && /[\uD800-\uDBFF]/.test(v[start - 1])) start--;
        range.setStart(nodes[i], start);
        range.setEnd(nodes[i], off);
        const r = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
        if (r && Math.abs(r.top - top) > 2) return s;
        s = v.slice(start, off) + s; // 被折疊的空白沒有矩形，一併帶著，最後 trim
        off = start;
      }
    }
    return s;
  };
  const contentWidth = (el) => {
    let b = el;
    while (b && getComputedStyle(b).display.startsWith("inline")) b = b.parentElement;
    b = b || el;
    const cs = getComputedStyle(b);
    return b.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  };
  for (const el of textEls) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (srOnly(r)) continue;
    const nodes = collectNodes(el);
    if (!nodes.length) continue;
    const gs = lineGroups(nodes);
    if (!gs.length) continue;
    const id = tag(el);
    lines[id] = gs.length;
    if (on.has("shortLastLine") && gs.length >= 2) {
      const last = gs[gs.length - 1];
      const lw = last.right - last.left;
      const bw = contentWidth(el);
      if (bw > 0 && lw < bw * 0.5) {
        const t = lastLineText(nodes, last.top).trim();
        const gc = [...seg.segment(t)].filter((x) => x.segment.trim()).length;
        if (t && (lw < bw * 0.15 || gc <= 2)) {
          push("shortLastLine", el, { lines: gs.length, lastLineWidth: Math.round(lw), blockWidth: Math.round(bw), lastLine: t });
        }
      }
    }
  }
  // ---- 尺寸（圖片、影片、按鈕）----
  for (const el of document.querySelectorAll('img, video, button, [role="button"]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (srOnly(r)) continue;
    sizes[tag(el)] = [r.width, r.height];
  }

  // ---- 橫向溢出 ----
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (on.has("overflow") && sw > width + 1) {
    out.overflow.push({ selector: "html", text: "", rect: { x: 0, y: 0, width: sw, height: 0 }, value: { scrollWidth: sw, viewport: width } });
    const clipped = (el) => {
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === "fixed") return true;
        if (p !== el && p !== document.body && /(hidden|clip|auto|scroll)/.test(cs.overflowX) && p.getBoundingClientRect().right <= width + 1) return true;
      }
      return false;
    };
    const cand = new Set(all.filter((el) => visible(el) && el.getBoundingClientRect().right > width + 1 && !clipped(el)));
    for (const el of cand) {
      if (el.parentElement && cand.has(el.parentElement)) continue; // 只列最外層
      push("overflow", el, { right: Math.round(el.getBoundingClientRect().right), viewport: width });
    }
  }

  // ---- 文字被裁切 ----
  if (on.has("clipped") || on.has("scrollbox")) for (const el of all) {
    if (/^(INPUT|TEXTAREA|SELECT|IMG|VIDEO)$/.test(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    // X、Y 兩軸分開看：只有「實際超出的方向」有對應的刻意處理才算刻意
    const dx = el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible";
    const dy = el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== "visible";
    if (!dx && !dy) continue;
    if (!visible(el) || srOnly(el.getBoundingClientRect()) || !el.textContent.trim()) continue;
    const norm = (t) => t.replace(/\s+/g, " ").trim();
    const tx = norm(el.textContent);
    let dup = false;
    for (let i = Math.floor(tx.length / 2) - 1; i <= Math.ceil(tx.length / 2) + 1 && !dup; i++) {
      if (i > 0 && i < tx.length && tx.slice(0, i).trim() === tx.slice(i).trim()) dup = true;
    }
    if (!dup && el.querySelector('[aria-hidden="true"]')) {
      const c = el.cloneNode(true);
      const hid = [...c.querySelectorAll('[aria-hidden="true"]')].map((x) => norm(x.textContent)).join(" ");
      c.querySelectorAll('[aria-hidden="true"]').forEach((x) => x.remove());
      dup = !!hid && norm(c.textContent) === norm(hid);
    }
    const dupNote = "重複文字（可能是 hover 動畫）";
    const clamp = (cs.webkitLineClamp || cs.getPropertyValue("-webkit-line-clamp")) !== "none" && !!cs.getPropertyValue("-webkit-line-clamp");
    const xWhy = [/(auto|scroll)/.test(cs.overflowX) ? "可捲動" : "", cs.textOverflow === "ellipsis" ? "省略號" : "", dup ? dupNote : ""].filter(Boolean);
    const yWhy = [/(auto|scroll)/.test(cs.overflowY) ? "可捲動" : "", clamp ? "line-clamp" : "", dup ? dupNote : ""].filter(Boolean);
    const extra = {};
    const bad = [dx && !xWhy.length ? "橫向" : "", dy && !yWhy.length ? "直向" : ""].filter(Boolean);
    if (!bad.length) {
      extra.note = [...new Set([...(dx ? xWhy : []), ...(dy ? yWhy : [])])].join("、");
    } else if ((dx && xWhy.length) || (dy && yWhy.length)) {
      extra.axisNote = `${dx && xWhy.length ? "橫向" + xWhy.join("、") : "直向" + yWhy.join("、")}是刻意的，但${bad.join("、")}沒有對應處理`;
    }
    const dims = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    // 內捲區：直向可捲動、內容比框高 10% 以上、不在彈窗裡 → 要確認看得出還有內容、最後一項到得了
    const inner = dy && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight * 1.1 && !el.closest('[role="dialog"], dialog');
    if (inner && on.has("scrollbox")) push("scrollbox", el, dims);
    if (!on.has("clipped")) continue;
    if (inner && on.has("scrollbox") && !bad.length) continue; // 已歸內捲區，不重複列成刻意
    push("clipped", el, dims, extra);
  }

  // ---- 捲完還透明 ----
  const seen = new Set();
  if (on.has("invisible")) for (const el of textEls) {
    if (el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (srOnly(r)) continue;
    let culprit = null;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (parseFloat(getComputedStyle(p).opacity) < 0.01) culprit = p;
    }
    const vis = getComputedStyle(el).visibility;
    if (!culprit && (vis === "hidden" || vis === "collapse")) culprit = el;
    if (!culprit || seen.has(culprit)) continue;
    seen.add(culprit);
    const cc = getComputedStyle(culprit);
    const extra = {};
    // 切換堆疊：同父層、同位置、同大小的兄弟有一個是完全顯示的（輪播、tab、淡入淡出切換）
    const cr = culprit.getBoundingClientRect();
    if (parseFloat(cc.opacity) < 0.01 && cr.width > 0 && cr.height > 0 && culprit.parentElement) {
      const near = (q) => Math.abs(q.left - cr.left) <= 2 && Math.abs(q.top - cr.top) <= 2 && Math.abs(q.width - cr.width) <= 2 && Math.abs(q.height - cr.height) <= 2;
      if ([...culprit.parentElement.children].some((sb) => sb !== culprit && near(sb.getBoundingClientRect()) && parseFloat(getComputedStyle(sb).opacity) >= 0.99)) extra.stackedToggle = true;
    }
    // 不接收點擊的透明層：自己或祖先 pointer-events: none 且 opacity 0
    if (!extra.stackedToggle && parseFloat(cc.opacity) < 0.01) {
      for (let q = culprit; q && q !== document.documentElement; q = q.parentElement) if (getComputedStyle(q).pointerEvents === "none") { extra.pointerNone = true; break; }
    }
    // 進場動畫時間差：元素的祖先（含自己，不含已經是 0 的那層）opacity 介於 0.05–0.99，表示淡入動畫正在進行，量到的是中間狀態
    if (!extra.stackedToggle && !extra.pointerNone) {
      for (let q = el; q && q !== document.documentElement; q = q.parentElement) {
        const o = parseFloat(getComputedStyle(q).opacity);
        if (o >= 0.05 && o <= 0.99) { extra.fadingIn = true; break; }
      }
    }
    add("invisible", el, { selector: sel(culprit), text: text40(el), rect: dr(r), value: { opacity: cc.opacity, visibility: cc.visibility }, ...extra });
  }

  // ---- 頂端固定列（捲到 600px 後量）----
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  window.scrollTo({ top: Math.min(600, maxScroll), behavior: "instant" });
  {
    const vh = innerHeight;
    const items = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.01) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.top > 8 || r.bottom <= 0 || r.left >= width || r.right <= 0) continue;
      items.push({ el, top: Math.max(0, r.top), bottom: Math.min(vh, r.bottom) });
    }
    items.sort((p, q) => p.top - q.top);
    let sum = 0, curT = null, curB = null;
    for (const i of items) {
      if (curB === null || i.top > curB) {
        if (curB !== null) sum += curB - curT;
        curT = i.top;
        curB = i.bottom;
      } else curB = Math.max(curB, i.bottom);
    }
    if (curB !== null) sum += curB - curT;
    const ratio = sum / vh;
    if (on.has("fixedCover") && ratio > 0.25) {
      out.fixedCover.push({
        selector: items.map((i) => sel(i.el)).slice(0, 3).join(" + "),
        text: "",
        rect: { x: 0, y: 0, width, height: Math.round(sum) },
        value: { ratio: Math.round(ratio * 100) / 100, height: Math.round(sum), viewportHeight: vh, elements: items.length },
      });
    }
  }

  // ---- 點擊範圍（逐一捲進畫面，5×5 取樣 + 十字掃描）；非觸控 profile 不量 ----
  if (doTap) {
    const CL = 'a[href], button, [role="button"], input:not([type="hidden"]), select, summary, [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(CL)].filter((el) => {
      if (el.disabled || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      return !srOnly(r) && r.right > 0 && r.left < width;
    });
    const half = minTap / 2;
    const hitOk = (el, t) => !!t && (t === el || el.contains(t));
    // 點在框內（往內縮 m px）：框的邊界不算，緊貼的 44px 列表不會互相誤判
    const inR = (x, y, q, m = 0.5) => x >= q.left + m && x <= q.right - m && y >= q.top + m && y <= q.bottom - m;
    // 同 href 外層覆蓋：命中的元素屬於另一個 a[href]，href（去 hash）、target、download 都相同，且同在一張卡（共同祖先 3 層內，或同在一個 article／li）
    const hrefOf = (a) => { try { const u = new URL(a.href, location.href); u.hash = ""; return u.href; } catch { return null; } };
    const coverOf = (el, t) => {
      if (!t || !el.matches('a[href]')) return false;
      const a = t.closest('a[href]');
      if (!a || a === el || a.contains(el) || el.contains(a)) return false;
      const h = hrefOf(el);
      if (!h || hrefOf(a) !== h) return false;
      if ((a.target || "") !== (el.target || "") || a.hasAttribute("download") !== el.hasAttribute("download")) return false;
      const card = el.closest("article, li");
      if (card && card.contains(a)) return true;
      let c = el;
      for (let n = 0; c && !c.contains(a); n++) {
        if (n >= 3) return false;
        c = c.parentElement;
      }
      return !!c;
    };
    // 量一個元素：len 為真時，同 href 的外層覆蓋算命中（others／stolen 也不把它當別人）
    const probe = (el, r, cx, cy, len) => {
      const ok = (t) => hitOk(el, t) || (len && coverOf(el, t));
      let hits = 0, used = false;
      const others = new Set(); // 別人蓋在自己框內的可點元素（真重疊）
      const stolen = new Set(); // 自己（例如 ::before 擴大）蓋到別人框內，搶走別人的點擊
      const checkExt = (x, y) => {
        if (inR(x, y, r, 0)) return; // 在自己框內不算擴大
        for (const o of els) {
          if (o === el || o.contains(el) || el.contains(o)) continue;
          if (len && coverOf(el, o)) continue;
          if (inR(x, y, o.getBoundingClientRect())) { stolen.add(o); return; }
        }
      };
      // 5×5 取樣：落在 minTap 方框內側 1px，不取到邊界上（瀏覽器的命中測試會把座標對齊到整數像素，只縮 0.5px 會取到鄰居）
      const step = (half - 1) / 2;
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const x = cx + (i - 2) * step, y = cy + (j - 2) * step;
          const t = document.elementFromPoint(x, y);
          if (ok(t)) {
            hits++;
            if (!hitOk(el, t)) used = true;
            checkExt(x, y);
          } else if (t && inR(x, y, r)) {
            const o = t.closest(CL);
            if (o && o !== el && !el.contains(o)) others.add(o);
          }
        }
      }
      // 十字掃描：從中心往四邊每 0.25px 一點，直到第一個沒打到；每邊最多 minTap/2 + 0.5
      const scan = (dx, dy) => {
        let n = 0;
        for (let k = 1; k <= (half + 0.5) * 4; k++) {
          const d = (k - 0.5) / 4;
          const x = cx + dx * d, y = cy + dy * d;
          const t = document.elementFromPoint(x, y);
          if (!ok(t)) break;
          if (!hitOk(el, t)) used = true;
          checkExt(x, y);
          n = k;
        }
        return n / 4;
      };
      const t0 = document.elementFromPoint(cx, cy);
      const centerOk = ok(t0);
      if (centerOk && !hitOk(el, t0)) used = true;
      const hitW = centerOk ? scan(-1, 0) + scan(1, 0) : 0;
      const hitH = centerOk ? scan(0, -1) + scan(0, 1) : 0;
      return { hits, others, stolen, hitW, hitH, centerOk, used };
    };
    const badTap = (p) => p.hitW < minTap - 0.5 || p.hitH < minTap - 0.5 || p.others.size || p.stolen.size;
    for (const el of els) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // 捲不進畫面的（例如捲動時收起的頁首、畫面外的選單）使用者點不到，不算
      if (cx < 0 || cx > width || cy < 0 || cy > innerHeight) continue;
      let p = probe(el, r, cx, cy, false);
      if (!badTap(p)) continue;
      let sameHrefCover = false;
      if (el.matches("a[href]")) {
        const q = probe(el, r, cx, cy, true);
        if (q.used) {
          if (!badTap(q)) sameHrefCover = true;
          else p = q;
        }
      }
      const { hits, others, stolen, hitW, hitH, centerOk } = p;
      const ovEls = sameHrefCover ? [] : [...others, ...stolen].slice(0, 2);
      const ov = ovEls.map(sel);
      add("tap", el, {
        selector: sel(el), text: text40(el), rect: dr(r),
        value: { hit: `${Math.floor(hitW)}×${Math.floor(hitH)}`, hitW, hitH, grid: `${hits}/25`, size: `${Math.round(r.width)}×${Math.round(r.height)}`, ...(ov.length ? { overlap: ov, overlapText: ovEls.map(text40) } : {}), ...(stolen.size && !others.size && !sameHrefCover ? { extended: true } : {}) },
        ...(sameHrefCover ? { sameHrefCover: true } : !centerOk ? { note: "中心點被其他元素蓋住" } : {}),
      });
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  // 子元素的框跟父元素一樣大（例如 button 和裡面的 img）只留父
  const same = (p, q) => Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1 && Math.abs(p.width - q.width) <= 1 && Math.abs(p.height - q.height) <= 1;
  for (const check of ["clipped", "scrollbox", "invisible", "tap", "shortLastLine"]) {
    const list = out[check];
    out[check] = list.filter((e) => {
      const el = refs.get(e);
      return !list.some((p) => {
        const pe = refs.get(p);
        return pe && pe !== el && pe.contains(el) && same(p.rect, e.rect);
      });
    });
  }
  return { out, lines: doJump ? lines : null, sizes: doJump ? sizes : null };
}

// 把頁面回傳的 findings 整理成 record 用的格式（原始資料不設上限）
function pack(res) {
  const findings = [];
  for (const [check, list] of Object.entries(res.out)) for (const f of list) findings.push({ check, ...f });
  return { findings };
}

async function describeIds(page, ids) {
  return page.evaluate((ids) => {
    const text40 = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const sel = (el) => {
      const parts = [];
      let n = el;
      for (let d = 0; n && n.nodeType === 1 && n !== document.documentElement && d < 4; d++, n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        const tid = n.getAttribute("data-testid");
        if (n.id && !/\d{3,}|:/.test(n.id)) { parts.unshift(`${s}#${CSS.escape(n.id)}`); break; }
        if (tid) { parts.unshift(`${s}[data-testid="${tid}"]`); break; }
        const cls = [...n.classList].filter((c) => !/[:\[\]\/()]/.test(c) && c.length < 30).slice(0, 2);
        if (cls.length) s += "." + cls.map((c) => CSS.escape(c)).join(".");
        const p = n.parentElement;
        if (p) {
          const sib = [...p.children].filter((c) => c.tagName === n.tagName);
          if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
        }
        parts.unshift(s);
      }
      return parts.join(" > ");
    };
    return Object.fromEntries(ids.map((id) => {
      const el = document.querySelector(`[data-tqa="${id}"]`);
      if (!el) return [id, null];
      const r = el.getBoundingClientRect();
      return [id, { selector: sel(el), text: text40(el), rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) } }];
    }));
  }, ids);
}

// 例外裡的 css 寫法：量測時用 element.matches 記下哪些符合
const cssList = [...new Set(cfg.acceptedExceptions.map((e) => e.match?.css).filter(Boolean))];

// ===== 任務 =====
const pool = new BrowserPool(pw, { browser: cfg.browser, playwrightPath: cfg.playwrightPath });
const nearest = (w) => [...allProfiles].sort((a, b) => Math.abs(a.width - w) - Math.abs(b.width - w))[0];

function baseRecord(pg, site, url, width, prof, kind, bp) {
  return {
    page: pg.id, site, path: pg.path, url, kind, ...(bp ? { breakpoint: bp } : {}),
    // 寬度低於 tabletMin 是手機版：照量，但線索只當參考
    reference: width < cfg.tabletMin,
    width, height: prof.height, profile: prof.name, httpStatus: null, finalUrl: null,
    env: null, status: "fail", warnings: [], notes: [], skipped: [], findings: [], error: null, time: nowIso(),
  };
}

async function measureAt(page, rec, prof, doJump) {
  rec.env = await checkEnv(page, prof);
  const touch = prof.touch !== false && !!prof.touch;
  if (!touch && enabledChecks.includes("tap")) rec.skipped.push("tap");
  const doTap = touch && enabledChecks.includes("tap");
  const res = await page.evaluate(measurePage, { width: rec.width, minTap: cfg.minTap, doJump: doJump && (enabledChecks.includes("lineJump") || enabledChecks.includes("sizeJump")), doTap, cssList, checks: enabledChecks });
  rec.findings = pack(res).findings;
  if (prof.touch && !rec.env.ok) {
    rec.findings.push({ check: "env", selector: "", text: "", rect: null, value: { pointerCoarse: rec.env.pointerCoarse, hoverNone: rec.env.hoverNone } });
  }
  rec.status = rec.warnings.length ? "incomplete" : "ok";
  return res;
}

async function runProfileTask({ pg, site, prof }) {
  const url = siteUrl(cfg.sites[site].url, pg.path);
  const rec = baseRecord(pg, site, url, prof.width, prof, "profile");
  let ctx;
  try {
    const op = await openWithRetry(pool, prof, "no-preference", url, { expectedStatus: pg.expectedStatus, networkIdleMs: cfg.sites[site].networkIdleMs });
    ctx = op.context;
    const prep = op.prep;
    rec.httpStatus = prep.status;
    rec.finalUrl = prep.finalUrl;
    rec.warnings.push(...prep.warnings);
    rec.notes.push(...prep.notes);
    if (prep.openError) throw new Error(prep.openError);
    await measureAt(op.page, rec, prof, false);
  } catch (e) {
    rec.status = "fail";
    rec.error = e.message.split("\n")[0];
  } finally {
    await ctx?.close().catch(() => {});
  }
  return [rec];
}

async function runBreakpointTask({ pg, site, b }) {
  const prof = nearest(b);
  const url = siteUrl(cfg.sites[site].url, pg.path);
  const widths = [b - 1, b, b + 1];
  const recs = widths.map((w) => baseRecord(pg, site, url, w, prof, "breakpoint", b));
  let ctx;
  try {
    const op = await openWithRetry(pool, { ...prof, width: widths[0] }, "no-preference", url, { expectedStatus: pg.expectedStatus, networkIdleMs: cfg.sites[site].networkIdleMs });
    ctx = op.context;
    const page = op.page;
    const prep = op.prep;
    for (const r of recs) {
      r.httpStatus = prep.status;
      r.finalUrl = prep.finalUrl;
      r.warnings.push(...prep.warnings);
      r.notes.push(...prep.notes);
    }
    if (prep.openError) throw new Error(prep.openError);
    const ms = [];
    for (const [i, w] of widths.entries()) {
      if (i > 0) {
        await page.setViewportSize({ width: w, height: prof.height });
        await sleep(400);
        // 換寬度後新顯示的內容要重新巡一次：捲到底再回頂、等字型、查圖片、等版面穩定
        recs[i].warnings.push(...(await prepareLayout(page)).map((x) => `調整寬度後：${x}`));
      }
      try {
        ms.push(await measureAt(page, recs[i], { ...prof, width: w }, true));
      } catch (e) {
        recs[i].status = "fail";
        recs[i].error = e.message.split("\n")[0];
        ms.push(null);
      }
    }
    if (ms[0] && ms[1] && ms[2]) await jumps(page, recs[1], ms, widths);
  } catch (e) {
    for (const r of recs) if (!r.error && r.status !== "ok" && r.status !== "incomplete") { r.status = "fail"; r.error = e.message.split("\n")[0]; }
  } finally {
    await ctx?.close().catch(() => {});
  }
  return recs;
}

// 行數突變（三個寬度行數差 ≥2）與尺寸突變（b−1 → b 變 1.5 倍以上或 2/3 以下）
async function jumps(page, rec, ms, widths) {
  const found = [];
  for (const id of enabledChecks.includes("lineJump") ? Object.keys(ms[1].lines) : []) {
    const v = ms.map((m) => m.lines[id]);
    if (v.some((x) => x === undefined)) continue;
    if (Math.max(...v) - Math.min(...v) >= 2) found.push({ id, check: "lineJump", value: Object.fromEntries(widths.map((w, i) => [w, v[i]])) });
  }
  for (const id of enabledChecks.includes("sizeJump") ? Object.keys(ms[1].sizes) : []) {
    const p = ms[0].sizes[id], q = ms[1].sizes[id];
    if (!p || !q) continue;
    const rw = q[0] / p[0], rh = q[1] / p[1];
    if (rw >= 1.5 || rw <= 2 / 3 || rh >= 1.5 || rh <= 2 / 3) {
      found.push({ id, check: "sizeJump", value: { [widths[0]]: `${Math.round(p[0])}×${Math.round(p[1])}`, [widths[1]]: `${Math.round(q[0])}×${Math.round(q[1])}` } });
    }
  }
  const meta = await describeIds(page, found.map((f) => f.id));
  for (const f of found) {
    const m = meta[f.id] || { selector: `[data-tqa=${f.id}]`, text: "", rect: null };
    rec.findings.push({ check: f.check, ...m, value: f.value });
  }
}

// ===== 起跑前檢查 =====
const t0 = Date.now();
if (!opt["no-smoke"]) {
  const firstTouch = profiles.find((p) => p.touch);
  const sm = await smokeCheck(pool, [profiles[0], ...(firstTouch ? [firstTouch] : [])], siteUrl(cfg.sites[sites[0]].url, pages[0].path), pages[0].expectedStatus);
  if (!sm.ok) {
    await pool.close();
    console.error("起跑前檢查沒過，停止：" + sm.message);
    process.exit(3);
  }
  console.log("起跑前檢查通過（瀏覽器、第一頁、觸控環境）");
}

// ===== 任務清單 =====
const tasks = [];
for (const site of sites)
  for (const pg of pages) {
    for (const prof of profiles) tasks.push({ kind: "p", pg, site, prof });
    if (doBreakpoints) for (const b of cfg.breakpoints) tasks.push({ kind: "b", pg, site, b });
  }
const expectedRecords = tasks.reduce((n, t) => n + (t.kind === "p" ? 1 : 3), 0);
let run;
try {
  run = makeRun(cfg, opt.run, sites, { tool: "sweep", args: process.argv.slice(3), expected: expectedRecords, notify: opt.notify });
} catch (e) {
  await pool.close();
  fail2(e.message);
}
const siteMeta = await siteInfo(cfg, sites);
console.log(`本次資料夾：${run.dir}`);

// ===== 執行 =====
const done = new Array(tasks.length);
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const i = next++;
    const t = tasks[i];
    const recs = t.kind === "p" ? await runProfileTask(t) : await runBreakpointTask(t);
    done[i] = recs;
    for (const r of recs) {
      logProgress(run, { page: r.page, site: r.site, width: r.width, kind: r.kind, status: r.status });
      const n = r.findings.length;
      const info = r.error ? `FAIL — ${r.error}` : `${r.status === "ok" ? "OK" : "INCOMPLETE"} 原始線索 ${n}${r.warnings.length ? `，warnings：${r.warnings[0]}` : ""}`;
      console.log(`${r.site} ${r.page} ${r.width}px (${r.kind === "profile" ? r.profile : "斷點 " + r.breakpoint}) ${info}`);
    }
  }
}
let tool;
try {
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));

  // ===== 分類 → 分組 =====
  var records = done.flat();
  if (records.length !== expectedRecords) {
    console.error(`紀錄數對不上：預計 ${expectedRecords} 筆，實際 ${records.length} 筆。結果不可信，不輸出報告。`);
    process.exitCode = 1;
    throw new Error("count-mismatch");
  }
  records.sort((x, y) => sites.indexOf(x.site) - sites.indexOf(y.site) || pages.findIndex((p) => p.id === x.page) - pages.findIndex((p) => p.id === y.page) || x.width - y.width || (x.kind === "profile" ? 0 : 1) - (y.kind === "profile" ? 0 : 1));
  records.forEach((r, i) => (r.idx = i)); // 原始紀錄索引（分組的 members 指回這裡）
  for (const r of records) for (const f of r.findings) Object.assign(f, classify(f, r.page, cfg.acceptedExceptions, r.reference));

  var result = {};
  for (const site of sites) {
    const rs = records.filter((r) => r.site === site);
    const counts = { raw: 0, review: 0, accepted: 0, intentional: 0, reference: 0, stack: 0, timing: 0, env: 0 };
    for (const r of rs) for (const f of r.findings) {
      counts.raw++;
      counts[f.cls]++;
    }
    const byReason = { accepted: tallyByReason(rs, "accepted"), intentional: tallyByReason(rs, "intentional") };
    const groups = groupReview(rs, cfg.minTap);
    const refGroups = groupReview(rs, cfg.minTap, { cls: "reference", prefix: "R" });
    const envs = rs.filter((r) => r.findings.some((f) => f.cls === "env")).map((r) => `${r.page} ${r.width}px`);
    result[site] = { rs, counts, byReason, groups, refGroups, envs, timingGroups: [] };
  }
  // ===== 新舊比對 =====
  var cmpInfo = null;
  if (cmpBase || cmpInRun) {
    let base = cmpBase;
    let conditions = [];
    if (!base) {
      const b = result.before;
      base = buildBaseline(b.rs, { against: "before", run: run.name, site: "before", label: siteMeta.before?.label || null, source: "in-run" });
    } else {
      // 跟舊 run 比：核對量測條件（tool 版本只警告；tabletMin、minTap、每頁 path 不同會讓比對失準）
      const paths = new Map();
      for (const r of result[cmpTarget].rs) if (!paths.has(r.page)) paths.set(r.page, r.path);
      conditions = compareConditions(base, { tool: toolInfo(cfg, run, pool), tabletMin: cfg.tabletMin, minTap: cfg.minTap, paths });
    }
    const cmp = compareGroups(result[cmpTarget].groups, base, result[cmpTarget].rs, { checks: enabledChecks });
    result[cmpTarget].cmp = cmp;
    result[cmpTarget].compare = summarize(cmp, base, conditions);
    cmpInfo = { ...result[cmpTarget].compare, site: cmpTarget, base, conditions };
  }

  // ===== 代表證據：evidence/<site>/；前 EVIDENCE_MAX 組，加上所有「固定列佔高」（不受上限擠掉）=====
  for (const site of sites) {
    const { groups, cmp } = result[site];
    // 有比對時，「這次新出現」的前 EVIDENCE_MAX 組也一定拍
    const newTop = new Set(cmp ? [...cmp.newGroups, ...cmp.worseGroups].slice(0, EVIDENCE_MAX) : []);
    const top = groups.filter((g, i) => i < EVIDENCE_MAX || g.check === "fixedCover" || newTop.has(g));
    for (const g of top) g.evTried = true;
    const buckets = new Map();
    for (const g of top) {
      const k = [g.worst.page, g.worst.width, g.worst.profile].join("|");
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(g);
    }
    const list = [...buckets.values()];
    let bi = 0;
    console.log(`\n拍代表證據（${site}）：${top.length} 組、${list.length} 次載入…`);
    await Promise.all(Array.from({ length: Math.min(jobs, list.length) }, async () => {
      while (bi < list.length) {
        const bucket = list[bi++];
        const m = await shootBucket(pool, cfg, allProfiles, site, bucket, run.dir);
        for (const g of bucket) {
          const e = m.get(g.id);
          g.evidence = e?.file || null;
          g.evidenceNote = e?.note || null;
          g.reappeared = !!e?.reappeared;
        }
      }
    }));
    // 取證重測時已看得見的「捲完還透明」：量測當下是進場動畫的中間狀態，移到「進場動畫時間差（參考）」，不進主清單。編號不重排
    const R = result[site];
    const dm = demoteReappeared(R.groups, R.rs);
    R.counts.review -= dm.moved;
    R.counts.timing += dm.moved;
    R.groups = dm.kept;
    if (R.cmp) {
      const keep = new Set(dm.kept);
      for (const k of ["newGroups", "worseGroups", "textChangedGroups", "sameGroups", "noBaselineGroups"]) R.cmp[k] = R.cmp[k].filter((g) => keep.has(g));
      R.compare = summarize(R.cmp, cmpInfo.base, cmpInfo.conditions);
      if (site === cmpTarget) cmpInfo = { ...R.compare, site: cmpTarget, base: cmpInfo.base, conditions: cmpInfo.conditions };
    }
    R.timingGroups = groupReview(R.rs, cfg.minTap, { cls: "timing", prefix: "T" });
    const evByKey = new Map();
    for (const g of dm.demoted) for (const m of g.members) evByKey.set(`${m.selector}\u0001${m.text}`, { evidence: g.evidence, evidenceNote: g.evidenceNote });
    for (const g of R.timingGroups) {
      const e = g.members.map((m) => evByKey.get(`${m.selector}\u0001${m.text}`)).find(Boolean);
      if (e) Object.assign(g, e);
    }
  }
  tool = toolInfo(cfg, run, pool);
} catch (e) {
  await pool.close();
  if (e.message !== "count-mismatch") console.error(e.stack || e.message);
  finishRun(run, "failed", "fail", e.message === "count-mismatch" ? "紀錄數對不上" : e.message.slice(0, 80));
  notify(run, { done: 0, incomplete: 0, fail: 0, failed: true });
  process.exit(process.exitCode || 1);
}
await pool.close();

// ===== 輸出 =====
const meta = { run: run.name, time: nowIso(), args: { checks: enabledChecks, site: sites, pages: pages.map((p) => p.id), profiles: profiles.map((p) => p.name), breakpoints: doBreakpoints }, minTap: cfg.minTap, tabletMin: cfg.tabletMin, sites: siteMeta, tool };
// 每頁一個檔（results/<頁面 id>.json，含所有網站與寬度的完整線索）＋總表，避免全站結果擠成一個超大檔
fs.mkdirSync(inside(run.dir, "results"), { recursive: true });
const files = {};
for (const pg of pages) {
  const rel = `results/${pg.id}.json`;
  fs.writeFileSync(inside(run.dir, rel), JSON.stringify({ page: pg.id, records: records.filter((r) => r.page === pg.id) }));
  files[pg.id] = rel;
}
const summary = records.map(({ findings, ...r }) => ({ ...r, findingCount: findings.length, file: files[r.page] }));
fs.writeFileSync(inside(run.dir, "sweep-results.json"), JSON.stringify({ ...meta, files, records: summary }));
const groupsOut = {};
const gOut = (g) => ({
  id: g.id, same: g.same || 1, row: !!g.row, check: g.check, kind: g.kind, severity: g.sev, selector: g.selector, text: g.text, count: g.count,
  pages: g.pages, worstPage: g.worst.page, worstWidth: g.worst.width, worst: worstPhrase(g.worst.f, g.worst, cfg.minTap), rect: g.worst.f.rect,
  evidence: g.evidence || null, evidenceNote: g.evidenceNote || null, members: g.members,
});
const gOutCmp = (g) => {
  const o = gOut(g);
  if (!g.pageStatus) return o;
  o.pages = o.pages.map((p) => {
    const ps = g.pageStatus.find((x) => x.page === p.page);
    return { ...p, status: ps?.status, statusByWidth: ps?.byWidth };
  });
  o.compareStatus = g.cmp;
  if (g.cmpDetail?.length) o.compareDetail = g.cmpDetail;
  return o;
};
for (const site of sites) {
  const { groups, refGroups, timingGroups, counts, byReason, envs, compare } = result[site];
  groupsOut[site] = { counts, byReason, envs, ...(compare ? { compare } : {}), review: groups.map(gOutCmp), reference: refGroups.map(gOut), timing: timingGroups.map(gOut) };
}
fs.writeFileSync(inside(run.dir, "sweep-groups.json"), JSON.stringify({ ...meta, ...groupsOut }, null, 1));
fs.writeFileSync(inside(run.dir, "sweep-report.md"), report());

const fails = records.filter((r) => r.status === "fail").length;
const inc = records.filter((r) => r.status === "incomplete").length;
for (const site of sites) {
  const { counts, groups, refGroups, compare } = result[site];
  const cmpTxt = compare ? `（新出現 ${compare.newCount} 組、變差 ${compare.worseCount} 組、只有文字變了 ${compare.textChangedCount} 組、原本就有 ${compare.sameCount} 組、沒有對照 ${compare.noBaselineCount} 組；對照 ${compare.against}）` : "";
  console.log(`\n[${site}] 原始線索 ${counts.raw} 條 → 需要看 ${groups.length} 組${cmpTxt}（${counts.review} 條）、已接受 ${counts.accepted}、刻意設計 ${counts.intentional}、手機版參考 ${counts.reference}（${refGroups.length} 組）、切換堆疊 ${counts.stack}、進場動畫時間差 ${counts.timing}、環境 ${counts.env}`);
}
console.log(`共 ${records.length} 筆量測：量完 ${records.length - fails - inc}、證據不完整 ${inc}、失敗 ${fails}；耗時 ${Math.round((Date.now() - t0) / 1000)} 秒 → ${path.join(run.dir, "sweep-report.md")}`);
if (fails) {
  const failPages = [...new Set(records.filter((r) => r.status === "fail").map((r) => r.page))];
  const keep = process.argv.slice(2).filter((a) => a.startsWith("--") && !/^--(run|pages)=/.test(a));
  console.log(`\n重跑失敗的頁面（複製即可）：\n${rerunCommand([process.argv[1], configFile, `--pages=${failPages.join(",")}`, ...keep, `--run=${run.name}-retry`])}`);
}
if (inc) console.log(`\n**證據不完整 ${inc} 筆（不能當通過；結束碼 ${fails ? 1 : 4}）**`);
finishRun(run, "done", fails ? "fail" : "done", `records=${records.length} incomplete=${inc} fail=${fails}`);
notify(run, { done: records.length - fails - inc, incomplete: inc, fail: fails });
process.exit(fails ? 1 : inc ? 4 : 0);

// ===== 報告 =====
function report() {
  const L = [];
  L.push("# 平板量測報告", "", ...previousRunLines(run), `執行：\`${run.name}\`　產生時間：${meta.time}　最小點擊範圍：${cfg.minTap}px　平板下限：${cfg.tabletMin ? cfg.tabletMin + "px（更窄的寬度是手機版，只當參考）" : "未設"}`);
  L.push(toolLine(tool));
  {
    const ran = enabledChecks.map((c) => CHECK_NAME[c]);
    const skipped = ALL_CHECKS.filter((c) => !enabledChecks.includes(c)).map((c) => CHECK_NAME[c]);
    L.push(`這次跑的檢查：${ran.join("、")}。${skipped.length ? `**沒跑：${skipped.join("、")}**（沒跑的檢查沒有線索，不代表沒問題）。` : "全部檢查都跑了。"}`, "");
  }
  for (const site of sites) {
    const { rs, counts, byReason, groups, refGroups, envs, cmp, compare } = result[site];
    const s = siteMeta[site];
    const fails = rs.filter((r) => r.status === "fail");
    const incs = rs.filter((r) => r.status === "incomplete");
    const okN = rs.length - fails.length - incs.length;
    L.push(`## 網站 ${site}：${s.label || s.url}`, "", `網址：${s.url}`);
    L.push(describeSite(s), "");
    L.push("### 摘要", "");
    L.push(`- 量了 ${rs.length} 筆（頁面 × 尺寸，profile 與斷點各算各的）：機器量完 ${okN}、證據不完整 ${incs.length}、打不開或失敗 ${fails.length}。`);
    L.push(`- 原始線索 ${counts.raw} 條，分類後：**需要看 ${groups.length} 組**（共 ${counts.review} 條）、已接受 ${counts.accepted} 條、刻意設計 ${counts.intentional} 條${counts.reference ? `、手機版參考 ${counts.reference} 條（${refGroups.length} 組）` : ""}${counts.env ? `、環境問題 ${counts.env} 條` : ""}。`);
    L.push("- **「機器量完」（也就是 ✓）只代表腳本量完這個尺寸，視覺尚未確認，不等於通過。** 下面「需要看」的每一組都要看圖確認，確認前不算問題也不算沒問題。");
    {
      const sh = rs.flatMap((r) => r.findings).filter((f) => f.sameHrefCover).length;
      const extra = [counts.stack ? `切換堆疊（參考）${counts.stack} 條，不進主清單` : "", counts.timing ? `進場動畫時間差（參考）${counts.timing} 條（${result[site].timingGroups.length} 組），不進主清單` : "", sh ? `同連結外層覆蓋（實際可點）${sh} 條，歸刻意設計` : ""].filter(Boolean);
      if (extra.length) L.push(`- 另外：${extra.join("；")}。`);
    }
    if (compare) L.push(`- 跟舊版本比對（${compare.against}）：**新出現 ${compare.newCount} 組、變差 ${compare.worseCount} 組**／只有文字變了 ${compare.textChangedCount} 組／原本就有 ${compare.sameCount} 組／沒有對照 ${compare.noBaselineCount} 組（${compare.noBaselineCellCount} 個頁×寬度舊版本沒有可比的量測）；舊版本有、這次沒有的 ${compare.betterCount} 條。`);
    if (envs.length) L.push(`- 注意：這些量測的觸控環境不成立（pointer: coarse／hover: none），點擊範圍不可信：${envs.slice(0, 6).join("、")}${envs.length > 6 ? "…" : ""}`);
    L.push("");

    L.push("### 覆蓋表", "");
    // 同寬度的 profile 紀錄和斷點紀錄分開成不同欄，欄數加總 = 量測筆數
    const colKey = (r) => `${r.width}|${r.kind === "profile" ? "p:" + r.profile : "b"}`;
    const colName = (r) => (r.kind === "profile" ? `${r.width}（${r.profile}）` : `${r.width}（斷點${r.reference ? "，手機版" : ""}）`);
    const cols = new Map();
    for (const r of rs) if (!cols.has(colKey(r))) cols.set(colKey(r), { name: colName(r), w: r.width, k: r.kind === "profile" ? 0 : 1 });
    const colList = [...cols.entries()].sort((a, b) => a[1].w - b[1].w || a[1].k - b[1].k || a[1].name.localeCompare(b[1].name));
    L.push(`| 頁面 | ${colList.map(([, c]) => c.name).join(" | ")} |`, `|---|${colList.map(() => "---").join("|")}|`);
    const cell = (list) => {
      if (!list.length) return "—";
      const bad = list.find((r) => r.status === "fail");
      if (bad) return bad.error?.startsWith("HTTP") ? `打不開（${bad.error}）` : `量測失敗（${bad.error}）`;
      if (list.some((r) => r.status === "incomplete")) return "證據不完整";
      return "機器量完";
    };
    for (const pg of pages) L.push(`| ${pg.id} | ${colList.map(([k]) => cell(rs.filter((r) => r.page === pg.id && colKey(r) === k))).join(" | ")} |`);
    if (incs.length) {
      L.push("", "證據不完整的原因：");
      for (const r of incs) L.push(`- ${r.page} ${r.width}px（${r.kind === "profile" ? r.profile : "斷點"}）：${r.warnings.join("；")}`);
    }
    L.push("");

    const line = (g, i, withEvidence) => {
      const pg = g.pages.length === 1 ? `${g.pages[0].page}　寬度 ${fmtWidths(g.pages[0].widths)}` : `${fmtPages(g.pages)}　寬度 ${fmtWidths([...new Set(g.pages.flatMap((p) => p.widths))].sort((a, b) => a - b))}`;
      const el = g.text ? `「${g.text}」` : "（無文字）";
      const sel = !g.text && g.selector && g.selector !== "html" ? ` \`${g.selector.length > 60 ? "…" + g.selector.slice(-58) : g.selector}\`` : "";
      const ev = g.evidence ? `[證據圖](${g.evidence})` : withEvidence && g.evTried ? "證據圖拍不到" : "";
      const evNote = g.evidenceNote ? `（${g.evidenceNote}）` : "";
      const worstWhere = g.pages.length > 1 ? `（最差在 ${g.worst.page} ${g.worst.width}px）` : g.pages[0].widths.length > 1 ? `（最差在 ${g.worst.width}px）` : "";
      const same = g.same > 1 ? (g.row ? `（同列 ${g.same} 個）` : g.cloneOf ? `（跑馬燈等複製的同一元素 ${g.same} 個）` : `（同類 ${g.same} 個一起算）`) : "";
      return `${i + 1}. ${g.id}｜**${CHECK_NAME[g.check]}**｜${pg}｜${el}${sel}｜${worstPhrase(g.worst.f, g.worst, cfg.minTap)}${worstWhere}${same}${ev ? "｜" + ev + evNote : ""}`;
    };
    if (compare) {
      const bs = cmpInfo.base;
      const baseDesc = `\`${bs.source === "in-run" ? "本次的 before" : bs.against}\`${bs.label ? `（${bs.label}）` : ""}${bs.runTime ? `，該 run 產生於 ${bs.runTime}` : ""}`;
      const wTxt = (g, st) => {
        const ps = g.pageStatus.filter((p) => p.byWidth?.[st]?.length);
        return ps.map((p) => `${p.page} ${fmtWidths(p.byWidth[st])}px`).join("；");
      };
      L.push(`### 這次新出現（${cmp.newGroups.length} 組）`, "");
      L.push(`比對基準：${baseDesc}。比對單位：頁＋寬度＋檢查＋元素鍵（選擇器去掉 :nth-*，加元素文字前 10 字）。舊版本同頁同寬度有量（狀態 ok）、卻沒有這一條，才算新出現；舊版本那格沒量、失敗或證據不完整的，歸「沒有對照」。選擇器或 class 改了會被當成新的；只有文字前 10 字不同的歸「只有文字變了」。`);
      if (cmpOverride) L.push(`同時指定了 --site=both 和 --compare，以 --compare 為準：${site} 對的是舊 run，不是本次的 before。`);
      if (cmpInfo.conditions?.length) L.push("", `**條件不同：**`, ...cmpInfo.conditions.map((c) => `- ${c.text}`));
      L.push("");
      if (!cmp.newGroups.length) L.push("（沒有。舊版本沒量的頁面和寬度不算在這裡，見「沒有對照」。）", "");
      else {
        L.push(`全部列出（不受 ${EVIDENCE_MAX} 組上限）；格式同「需要看」，依嚴重度排序，前 ${EVIDENCE_MAX} 組附代表截圖。`, "");
        cmp.newGroups.forEach((g, i) => {
          const where = wTxt(g, "new");
          L.push(line(g, i, true) + (where && (g.pageStatus.length > 1 || g.pageStatus.some((p) => Object.keys(p.byWidth || {}).length > 1)) ? `｜新出現在：${where}` : ""));
        });
        L.push("");
      }
      L.push(`### 變差（${cmp.worseGroups.length} 組）`, "");
      L.push("同一條線索舊版本就有，但數值明顯變差：點擊範圍變小 ≥ 4px、被裁切的超出量增加 ≥ 8px、固定列佔畫面增加 ≥ 5 個百分點。其他檢查不判惡化。", "");
      if (!cmp.worseGroups.length) L.push("（沒有）", "");
      else {
        cmp.worseGroups.forEach((g, i) => {
          const d = g.cmpDetail.slice().sort((x, y) => (y.to - y.from) - (x.to - x.from))[0];
          L.push(line(g, i, true) + `｜${d.page} ${d.width}px：${d.text}${g.cmpDetail.length > 1 ? `（共 ${g.cmpDetail.length} 個頁×寬度變差）` : ""}`);
        });
        L.push("");
      }
      L.push(`### 只有文字變了（${cmp.textChangedGroups.length} 組）`, "");
      L.push("同頁、同寬度、同檢查、同選擇器，只有元素文字前 10 字不同（文案改了）。不算新出現；但文案變長也可能是新問題的原因，需要時抽看。", "");
      if (!cmp.textChangedGroups.length) L.push("（沒有）", "");
      else {
        cmp.textChangedGroups.slice(0, 20).forEach((g, i) => L.push(line(g, i, false)));
        if (cmp.textChangedGroups.length > 20) L.push("", `另有 ${cmp.textChangedGroups.length - 20} 組沒有列出，在 sweep-groups.json 裡 compareStatus 為 "textChanged" 的組。`);
        L.push("");
      }
      L.push(`### 沒有對照（${cmp.noBaselineCells.length} 個頁×寬度；${cmp.noBaselineGroups.length} 組線索）`, "");
      if (!cmp.noBaselinePages.size) L.push("（沒有。本次量的每個頁×寬度，舊版本都有量完的紀錄。）", "");
      else {
        L.push("以下（頁、寬度）舊版本沒有 ok 的量測，不論有沒有線索都不能說「沒有新問題」，要直接看那頁：");
        for (const [pg, e] of cmp.noBaselinePages) L.push(`- ${pg}｜寬度 ${fmtWidths(e.widths, 20)}｜${[...e.reasons].join("；")}`);
        L.push("");
        if (cmp.noBaselineGroups.length) {
          L.push(`只列前 5 組線索（共 ${cmp.noBaselineGroups.length} 組），完整在 sweep-groups.json 裡 compareStatus 為 "noBaseline" 的組。`, "");
          cmp.noBaselineGroups.slice(0, 5).forEach((g, i) => L.push(line(g, i, false)));
          L.push("");
        }
      }
    }
    L.push(compare ? `### 需要看（含原本就有的，共 ${groups.length} 組；其中 ${compare.sameCount} 組舊版本也有，${compare.worseCount + compare.textChangedCount} 組變差或只有文字變了）` : "### 需要看", "");
    if (!groups.length) L.push("（沒有。注意：沒有線索不等於沒問題，見最後的「沒量的」。）", "");
    else {
      L.push(`依嚴重度排序（橫向溢出 → 文字被裁切 → 內捲區 → 點擊重疊 → 點擊太小 → 捲完還透明 → 行數／尺寸突變 → 固定列 → 最後一行太短）。同一個元件在不同寬度、不同頁面合併成一行；前 ${EVIDENCE_MAX} 組附代表截圖（最差寬度，紅框是被量到的元素），「固定列佔高」不受上限影響一定附圖。每組的所有成員（selector、位置、profile、原始紀錄索引）在 sweep-groups.json 的 members。`, "");
      groups.slice(0, LIST_MAX).forEach((g, i) => L.push(line(g, i, true)));
      if (groups.length > LIST_MAX) L.push("", `另有 ${groups.length - LIST_MAX} 組較輕的沒有列出，完整在 sweep-groups.json。`);
      L.push("");
    }

    if (refGroups.length) {
      L.push(`### 手機版（參考）`, "", `寬度低於平板下限 ${cfg.tabletMin}px 的量測（例如最低斷點的 b−1）是手機版，不是平板驗收範圍；線索只列出供參考，不排進「需要看」，沒有證據圖。`, "");
      refGroups.slice(0, 30).forEach((g, i) => L.push(line(g, i, false)));
      if (refGroups.length > 30) L.push("", `另有 ${refGroups.length - 30} 組沒有列出，完整在 sweep-groups.json 的 reference。`);
      L.push("");
    }

    const stackMem = rs.flatMap((r) => r.findings.filter((f) => f.cls === "stack").map((f) => ({ r, f })));
    if (stackMem.length) {
      L.push("### 切換堆疊（參考）", "", "同一格疊了好幾層，目前沒顯示的那幾層（opacity 0），同位置、同大小的兄弟有一個是完全顯示的。通常是輪播、tab、淡入淡出切換，不進「需要看」；要確認的話，看被顯示的那層切換後內容是否正常。", "");
      const seenEl = new Map();
      for (const { r, f } of stackMem) {
        const k = r.page + "|" + f.selector;
        if (!seenEl.has(k)) seenEl.set(k, { page: r.page, selector: f.selector, text: f.text, widths: new Set() });
        seenEl.get(k).widths.add(r.width);
      }
      for (const e of [...seenEl.values()].slice(0, 20)) L.push(`- ${e.page}｜${e.text ? `「${e.text}」` : ""}\`${e.selector.slice(-70)}\`｜寬度 ${fmtWidths([...e.widths].sort((a, b) => a - b))}`);
      if (seenEl.size > 20) L.push(`- …另有 ${seenEl.size - 20} 個，完整在 results/<頁面>.json（cls 為 stack）`);
      L.push("");
    }
    if (result[site].timingGroups.length) {
      const tg = result[site].timingGroups;
      L.push("### 進場動畫時間差（參考）", "", `「捲完還透明」的線索裡，符合下列任一條的歸這裡，不進「需要看」：量測時它的祖先 opacity 介於 0.05–0.99（淡入動畫進行中），或取證重測時已看得見（證據圖會註明）。共 ${counts.timing} 條、${tg.length} 組。通常是進場動畫還沒跑完就量到了；要確認的話，在實機捲過去看它最後有沒有出現（減少動態的情況下會不會直接顯示）。編號 T 開頭；從「需要看」移來的保留原本的證據圖。`, "");
      tg.slice(0, 8).forEach((g, i) => L.push(line(g, i, false)));
      if (tg.length > 8) L.push("", `另有 ${tg.length - 8} 組沒有列出，完整在 sweep-groups.json 的 timing。`);
      L.push("");
    }
    L.push("### 已接受／刻意設計", "");
    const rl = (title, obj) => {
      const ents = Object.entries(obj);
      if (!ents.length) return;
      L.push(`${title}：`);
      for (const [reason, n] of ents.sort((a, b) => b[1].count - a[1].count)) L.push(`- ${reason}：${n.elements} 個元素 × ${n.widths} 個寬度（共 ${n.count} 條）`);
    };
    rl("已接受（設定檔 acceptedExceptions，有尺寸下限；低於下限或跟鄰近目標重疊會回到「需要看」）", byReason.accepted);
    rl("刻意設計（每個有超出的方向都有可捲動、省略號、line-clamp 或重複文字處理，腳本判斷為故意）", byReason.intentional);
    if (!counts.accepted && !counts.intentional) L.push("（沒有）");
    L.push("");

    L.push("### 沒量的", "");
    const noteCount = {};
    for (const r of rs) for (const n of r.notes || []) noteCount[n] = (noteCount[n] || 0) + 1;
    const noTap = [...new Set(rs.filter((r) => r.skipped.includes("tap")).map((r) => r.width))].sort((a, b) => a - b);
    L.push(
      `- 這次範圍：${pages.length} 頁 × ${profiles.length} 個 profile${doBreakpoints ? " + 斷點三寬度" : "（沒量斷點）"}。設定檔 pages 沒列的頁面、沒指定的 profile 都沒量。`,
      "- 彈窗、tab、展開狀態量不到；要用 shots 的 steps 另外拍。",
      noTap.length ? `- 非觸控 profile（${noTap.join("、")}px）沒量點擊範圍。` : "- 觸控 profile 都有量點擊範圍。",
      "- 隱藏的（display:none）、螢幕閱讀器專用（寬或高 ≤1px）的文字不納入；tabindex=-1 的元素不納入點擊範圍。",
      `- 代表截圖只拍前 ${EVIDENCE_MAX} 組（固定列佔高另外一定拍）；全部原始線索（不設上限）在 results/<頁面>.json，總表在 sweep-results.json，分組結果在 sweep-groups.json。`,
      ...(Object.keys(noteCount).length ? ["- 載入備註（不影響狀態）：" + Object.entries(noteCount).map(([n, c]) => `${n} ×${c} 筆`).join("；")] : []),
      ""
    );
  }
  return L.join("\n");
}
