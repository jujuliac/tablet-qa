// 新舊版本比對（逐寬度）：比對單位 = 頁＋寬度＋檢查＋元素鍵。純函式為主，只有 loadBaselineFromRun 讀檔。
// 元素鍵 = selector 去掉所有 :nth-*(...) ＋ text 前 10 字；tap 的檢查名再加種類（size／overlap）。
// 分類（每條線索）：
//   new          舊版本同頁同寬度有量（status ok）、沒有這條
//   worse        同鍵但數值明顯變差（tap 尺寸小 ≥ 4px、clipped 超出量多 ≥ 8px、fixedCover 佔比多 ≥ 5 個百分點；其他檢查不判惡化）
//   same         同鍵、沒有明顯變差
//   textChanged  同頁同寬度同檢查同 selector，只有 text 前 10 字不同（文案改了），不算新出現
//   noBaseline   舊版本那頁那寬度沒量、失敗或證據不完整（status 不是 ok）
//   better       舊有新無，只計數
import fs from "node:fs";
import path from "node:path";
import { assertRunDone } from "./config.mjs";
import { tapKind } from "./group.mjs";

const stripNth = (s) => (s || "").replace(/:nth-[a-z-]+\([^)]*\)/g, "");
export const WORSE_BY = { tap: 4, clipped: 8, fixedCover: 0.05 };

const chkOf = (f) => (f.check === "tap" ? `tap:${tapKind(f)}` : f.check);
export const elKey = (f) => stripNth(f.selector) + "\u0001" + (f.text || "").slice(0, 10);
const selKey = (f) => chkOf(f) + "\u0002" + stripNth(f.selector);
const fullKey = (f) => chkOf(f) + "\u0002" + elKey(f);
const splitCell = (k) => [k.slice(0, k.lastIndexOf("|")), Number(k.slice(k.lastIndexOf("|") + 1))];

// 數值越大越糟；沒有可比的數值回 null
export function badness(f) {
  const v = f.value || {};
  switch (f.check) {
    case "tap":
      if (tapKind(f) !== "size" || typeof v.hitW !== "number" || typeof v.hitH !== "number") return null;
      return -Math.min(v.hitW, v.hitH);
    case "clipped":
      return Math.max((v.scrollWidth || 0) - (v.clientWidth || 0), (v.scrollHeight || 0) - (v.clientHeight || 0));
    case "fixedCover":
      return typeof v.ratio === "number" ? v.ratio : null;
    default:
      return null;
  }
}
// 惡化量描述（給報告）
export function describeChange(f, from, to) {
  if (f.check === "tap") return `點擊範圍 ${-from}px → ${-to}px（變小 ${(to - from).toFixed(0)}px）`;
  if (f.check === "clipped") return `超出 ${from}px → ${to}px（多 ${to - from}px）`;
  return `佔畫面 ${Math.round(from * 100)}% → ${Math.round(to * 100)}%`;
}

// 一個「頁|寬度」格子裡的所有 review 線索：keys: fullKey → { bad, f }；sels: selKey → Map(textKey → 次數)
function indexCell(findings) {
  const keys = new Map();
  const sels = new Map();
  for (const f of findings) {
    const k = fullKey(f);
    const b = badness(f);
    const e = keys.get(k);
    if (!e) keys.set(k, { bad: b, f });
    else if (b !== null && (e.bad === null || b > e.bad)) { e.bad = b; e.f = f; }
    const sk = selKey(f);
    if (!sels.has(sk)) sels.set(sk, new Map());
    const tk = (f.text || "").slice(0, 10);
    sels.get(sk).set(tk, (sels.get(sk).get(tk) || 0) + 1);
  }
  return { keys, sels };
}

// records：舊版本的完整量測紀錄（page、width、status、error、path、findings[{cls,...}]）。只收 cls === "review" 的線索
export function buildBaseline(records, info = {}) {
  const cells = new Map(); // "page|width" -> { recs:[{status,error}], review:[f...], idx }
  const pagesMeasured = new Set();
  const paths = new Map();
  for (const r of records) {
    pagesMeasured.add(r.page);
    if (r.path !== undefined && !paths.has(r.page)) paths.set(r.page, r.path);
    const k = `${r.page}|${r.width}`;
    if (!cells.has(k)) cells.set(k, { recs: [], review: [] });
    const c = cells.get(k);
    c.recs.push({ status: r.status, error: r.error || null });
    for (const f of r.findings || []) if (f.cls === "review") c.review.push(f);
  }
  for (const c of cells.values()) c.idx = indexCell(c.review);
  return { cells, pagesMeasured, paths, ...info };
}

// 這格能不能當對照：舊版本這頁這寬度有一筆 status ok 才行。不行就回傳原因（字串），可以就回傳 null
export function noBaselineReason(base, page, width) {
  if (!base.pagesMeasured.has(page)) return "舊版本沒量這一頁";
  const c = base.cells.get(`${page}|${width}`);
  if (!c) return "舊版本沒量這個寬度";
  if (c.recs.some((r) => r.status === "ok")) return null;
  const bad = c.recs.find((r) => r.status === "fail");
  if (bad) return `舊版本這格打不開或量測失敗${bad.error ? `（${bad.error}）` : ""}`;
  return "舊版本這格證據不完整";
}

const STATE_ORDER = ["new", "worse", "textChanged", "same", "noBaseline"];
const collapse = (list) => STATE_ORDER.find((s) => list.includes(s)) || "noBaseline";

// 比對。checks：本次有跑的檢查名單（null = 全部），沒跑的檢查不計 better。groups：本次「需要看」的組（要有 g.cells，groupReview 產生）；curRecords：本次這個網站的完整紀錄（含 findings）
// 回傳 { newGroups, worseGroups, textChangedGroups, sameGroups, noBaselineGroups, noBaselinePages: Map<page,{widths,reasons}>, noBaselineCells, betterCount, cellStats }
// 每組加：g.cmp、g.pageStatus（[{page,status,byWidth}]）、g.cmpDetail（worse 的前後數值）
export function compareGroups(groups, base, curRecords, { checks = null } = {}) {
  // 本次每格的索引（所有 review 線索，不只在 groups 裡的）
  const curCells = new Map();
  for (const r of curRecords) {
    const k = `${r.page}|${r.width}`;
    if (!curCells.has(k)) curCells.set(k, { measured: false, review: [] });
    const c = curCells.get(k);
    if (r.status !== "fail") c.measured = true;
    for (const f of r.findings || []) if (f.cls === "review") c.review.push(f);
  }
  for (const c of curCells.values()) c.idx = indexCell(c.review);

  // 每格：文案改了的鍵、舊有新無的數量
  let betterCount = 0;
  const cellInfo = new Map();
  const infoOf = (k) => {
    if (cellInfo.has(k)) return cellInfo.get(k);
    const [page, w] = splitCell(k);
    const b = base.cells.get(k);
    const cur = curCells.get(k);
    const reason = noBaselineReason(base, page, w);
    const info = { reason, textChanged: new Set() };
    if (!reason && b && cur) {
      // 同 selKey 下：本次有、舊版本沒有的 text（curOnly）和舊版本有、本次沒有的 text（baseOnly）一對一配成「文案改了」
      const sks = new Set([...b.idx.sels.keys(), ...cur.idx.sels.keys()]);
      for (const sk of sks) {
        // 本次沒跑的檢查（--checks 子集）不算「舊有新無」
        if (checks && !checks.includes(sk.split("\u0002")[0].split(":")[0])) continue;
        const bs = b.idx.sels.get(sk) || new Map(), cs = cur.idx.sels.get(sk) || new Map();
        const curOnly = [...cs.keys()].filter((t) => !bs.has(t)).sort();
        const baseOnly = [...bs.keys()].filter((t) => !cs.has(t)).sort();
        const n = Math.min(curOnly.length, baseOnly.length);
        for (let i = 0; i < n; i++) info.textChanged.add(sk + "\u0002" + curOnly[i]);
        betterCount += baseOnly.length - n;
      }
    }
    cellInfo.set(k, info);
    return info;
  };

  const buckets = { new: [], worse: [], textChanged: [], same: [], noBaseline: [] };
  for (const g of groups) {
    const byPage = new Map(); // page -> { states:[], byWidth:{state:[widths]} }
    const detail = [];
    for (const [k, fs_] of g.cells) {
      const [page, width] = splitCell(k);
      const info = infoOf(k);
      const cur = curCells.get(k);
      const states = [];
      if (info.reason) states.push("noBaseline");
      else {
        const b = base.cells.get(k);
        const seen = new Set();
        for (const f of fs_) {
          const key = fullKey(f);
          if (seen.has(key)) continue;
          seen.add(key);
          const be = b.idx.keys.get(key);
          if (be) {
            const ce = cur?.idx.keys.get(key);
            const lim = WORSE_BY[f.check];
            if (lim !== undefined && ce && ce.bad !== null && be.bad !== null && ce.bad - be.bad >= lim - 1e-9) {
              states.push("worse");
              detail.push({ page, width, from: be.bad, to: ce.bad, text: describeChange(f, be.bad, ce.bad) });
            } else states.push("same");
          } else if (info.textChanged.has(selKey(f) + "\u0002" + (f.text || "").slice(0, 10))) states.push("textChanged");
          else states.push("new");
        }
      }
      const st = collapse(states);
      if (!byPage.has(page)) byPage.set(page, { states: [], byWidth: {} });
      const e = byPage.get(page);
      e.states.push(st);
      (e.byWidth[st] ||= []).push(width);
    }
    g.pageStatus = g.pages.map((p) => {
      const e = byPage.get(p.page);
      if (!e) return { page: p.page, status: "noBaseline", byWidth: {} };
      for (const ws of Object.values(e.byWidth)) ws.sort((a, b) => a - b);
      return { page: p.page, status: collapse(e.states), byWidth: e.byWidth };
    });
    g.cmpDetail = detail;
    g.cmp = collapse(g.pageStatus.map((p) => p.status));
    buckets[g.cmp].push(g);
  }

  // 覆蓋缺口：從本次實際量了的（頁、寬度）算，不從線索清單推
  const noBaselineCells = [];
  const noBaselinePages = new Map();
  for (const [k, cur] of curCells) {
    const info = infoOf(k); // 也順便把 better 算完
    if (!cur.measured || !info.reason) continue; // 本次自己就失敗的格子，覆蓋表已經標了
    const [page, width] = splitCell(k);
    noBaselineCells.push({ page, width, reason: info.reason });
    if (!noBaselinePages.has(page)) noBaselinePages.set(page, { widths: [], reasons: new Set() });
    const e = noBaselinePages.get(page);
    e.widths.push(width);
    e.reasons.add(info.reason);
  }
  for (const e of noBaselinePages.values()) e.widths.sort((a, b) => a - b);

  return {
    newGroups: buckets.new, worseGroups: buckets.worse, textChangedGroups: buckets.textChanged, sameGroups: buckets.same, noBaselineGroups: buckets.noBaseline,
    noBaselinePages, noBaselineCells, betterCount,
    cellStats: { cells: curCells.size, noBaseline: noBaselineCells.length },
  };
}

// 基準和本次用的瀏覽器是否一樣：回傳 null（一樣）或一句警告文字。只警告，不阻擋，也不放進 condHash。
// 版本字串格式 "<通道> <版本>"（例如 "chrome 131.0.6778.86"）；通道或主版本不同就警告；舊 run 沒有通道資訊 → 無法核對
export function browserDiffText(baseTool, curTool) {
  const parse = (v) => {
    const m = String(v ?? "").match(/^(?:([a-z][\w-]*)\s+)?(\d+)/i);
    return m ? { channel: m[1] || null, major: Number(m[2]), raw: String(v) } : null;
  };
  const cur = curTool?.browsers || {};
  const base = baseTool?.browsers;
  const unknown = "基準沒有記瀏覽器（舊版腳本跑的），無法核對是不是同一個瀏覽器，差異可能來自瀏覽器";
  if (!base || !Object.keys(base).length) return unknown;
  const diffs = [];
  let unverifiable = false;
  for (const [engine, curV] of Object.entries(cur)) {
    const c = parse(curV);
    const b = parse(base[engine]);
    if (!c) continue;
    if (!b) {
      if (base[engine] === undefined) continue; // 基準沒有用到這個引擎
      unverifiable = true;
      continue;
    }
    if (engine === "chromium" && (!b.channel || !c.channel)) {
      unverifiable = true;
      continue;
    }
    if (b.channel !== c.channel || b.major !== c.major) diffs.push({ b: base[engine], c: curV });
  }
  if (diffs.length) return `執行環境不同（基準：${diffs.map((d) => d.b).join("、")}，本次：${diffs.map((d) => d.c).join("、")}），差異可能來自瀏覽器`;
  return unverifiable ? unknown : null;
}

// 量測條件相容性：回傳 [{ kind, text }]；空陣列 = 條件相同。tool 版本只警告
export function compareConditions(base, cur) {
  const out = [];
  const bt = base.tool || {}, ct = cur.tool || {};
  const tdiff = [];
  const br = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join("、");
  if (bt.playwright && ct.playwright && bt.playwright !== ct.playwright) tdiff.push(`Playwright ${bt.playwright} → ${ct.playwright}`);
  if (bt.browsers && ct.browsers && JSON.stringify(bt.browsers) !== JSON.stringify(ct.browsers)) tdiff.push(`瀏覽器 ${br(bt.browsers)} → ${br(ct.browsers)}`);
  if (bt.scriptHash && ct.scriptHash && bt.scriptHash !== ct.scriptHash) tdiff.push(`腳本版本 ${bt.scriptHash} → ${ct.scriptHash}`);
  if (tdiff.length) out.push({ kind: "tool", text: `工具版本不同（只警告）：${tdiff.join("；")}` });
  if (base.tabletMin !== undefined && cur.tabletMin !== undefined && base.tabletMin !== cur.tabletMin) out.push({ kind: "tabletMin", text: `tabletMin ${base.tabletMin} → ${cur.tabletMin}（手機版與平板的分界不同，分類會跟著變）` });
  if (base.minTap !== undefined && cur.minTap !== undefined && base.minTap !== cur.minTap) out.push({ kind: "minTap", text: `minTap ${base.minTap} → ${cur.minTap}（點擊範圍的門檻不同）` });
  const pd = [];
  for (const [page, p] of cur.paths || []) {
    const bp = base.paths?.get(page);
    if (bp !== undefined && bp !== p) pd.push(`${page}：${bp} → ${p}`);
  }
  if (pd.length) out.push({ kind: "path", text: `頁面路徑不同：${pd.join("；")}` });
  return out;
}

// --compare=<run>[:<site>]。run 名稱不能含冒號（makeRun 也禁），所以從最後一個冒號切
export function parseCompareSpec(spec) {
  if (typeof spec !== "string" || !spec) throw new Error("--compare 要寫舊 run 的資料夾名，例如 --compare=20261104-regression-sweep:before");
  const i = spec.lastIndexOf(":");
  const run = i < 0 ? spec : spec.slice(0, i);
  const site = i < 0 ? null : spec.slice(i + 1);
  if (!run || (i >= 0 && !site)) throw new Error(`--compare 格式是 <run 資料夾名>[:<site 名>]，收到「${spec}」`);
  return { run, site };
}

// 沒寫 site：有同名用同名，否則用 after，再否則用唯一的那個
export function pickCompareSite(available, wanted, target) {
  if (wanted) {
    if (!available.includes(wanted)) throw new Error(`舊 run 沒有 ${wanted} 這個網站的結果（有：${available.join("、") || "無"}）`);
    return wanted;
  }
  if (available.includes(target)) return target;
  if (available.includes("after")) return "after";
  if (available.length === 1) return available[0];
  throw new Error(`舊 run 有 ${available.join("、")}，分不出該比哪個，請寫 --compare=<run>:<site>`);
}

// 讀舊 run：sweep-results.json（總表）＋ results/<頁>.json（完整紀錄與線索）。找不到就丟錯
export function loadBaselineFromRun(outDir, spec, target) {
  const { run, site: wanted } = parseCompareSpec(spec);
  const dir = path.resolve(outDir, run);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--compare 找不到資料夾：${dir}`);
  assertRunDone(dir, "sweep");
  const read = (f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error(`--compare 的資料夾裡沒有 ${f}：${p}（要用 sweep.mjs 跑出來的 run）`);
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`讀不懂 ${p}：${e.message}`);
    }
  };
  const rj = read("sweep-results.json");
  const available = [...new Set((rj.records || []).map((r) => r.site))];
  const site = pickCompareSite(available, wanted, target);
  const records = [];
  for (const rel of Object.values(rj.files || {})) {
    const pj = read(rel);
    for (const r of pj.records || []) if (r.site === site) records.push(r);
  }
  if (!records.length) throw new Error(`--compare 的 ${run} 讀不到 ${site} 的完整紀錄（results/ 裡沒有）`);
  const label = rj.sites?.[site]?.label || null;
  return buildBaseline(records, { against: `${run}:${site}`, run, site, label, runTime: rj.time || null, source: "run", tool: rj.tool || null, tabletMin: rj.tabletMin, minTap: rj.minTap });
}

// 給 sweep.mjs 用的摘要物件（寫進 sweep-groups.json 的 compare 欄位）
export function summarize(cmp, base, conditions = []) {
  return {
    against: base.against,
    ...(base.label ? { label: base.label } : {}),
    newCount: cmp.newGroups.length,
    worseCount: cmp.worseGroups.length,
    textChangedCount: cmp.textChangedGroups.length,
    sameCount: cmp.sameGroups.length,
    noBaselineCount: cmp.noBaselineGroups.length,
    betterCount: cmp.betterCount,
    noBaselineCellCount: cmp.noBaselineCells.length,
    noBaselinePages: Object.fromEntries([...cmp.noBaselinePages].map(([p, e]) => [p, { widths: e.widths, reasons: [...e.reasons] }])),
    conditions: conditions.map((c) => c.text),
  };
}
