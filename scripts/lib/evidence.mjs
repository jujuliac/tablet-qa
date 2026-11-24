// 代表證據：在最差寬度重開頁面，找到元素、畫紅框、裁出附近的圖
import fs from "node:fs";
import path from "node:path";
import { openWithRetry, sleep } from "./browser.mjs";
import { siteUrl, inside } from "./config.mjs";

// 在頁面內找元素並捲進畫面（會被序列化進瀏覽器）
function locateInPage(a) {
  const t40 = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  window.__tqaEvEl = null;
  window.__tqaEvRect = null;
  window.__tqaEvStill = null;
  if (a.check === "fixedCover") {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    window.scrollTo({ top: Math.min(600, max), behavior: "instant" });
    window.__tqaEvRect = { fixedTop: true, height: a.rect?.height || 120 };
    return "fixed";
  }
  if (a.selector === "html") {
    window.scrollTo({ top: 0, behavior: "instant" });
    window.__tqaEvRect = { fixedTop: true, height: Math.min(innerHeight, 900), overflowLine: true };
    return "html";
  }
  // invisible 也重新找元素（不沿用舊座標），找到後才能重測是否真的還是透明
  let cands = [];
  try {
    cands = [...document.querySelectorAll(a.selector.split(" + ")[0])];
  } catch {
    cands = [];
  }
  if (a.text && a.check !== "invisible") cands = cands.filter((c) => t40(c) === a.text);
  cands = cands.filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0 || a.check === "invisible";
  });
  let el = null;
  if (cands.length) {
    el = cands[0];
    if (a.rect && cands.length > 1) {
      let best = Infinity;
      for (const c of cands) {
        const r = c.getBoundingClientRect();
        const d = Math.abs(r.left + scrollX - a.rect.x) + Math.abs(r.top + scrollY - a.rect.y);
        if (d < best) { best = d; el = c; }
      }
    }
  }
  if (el) {
    const r = el.getBoundingClientRect();
    el.scrollIntoView({ block: r.height > innerHeight * 0.8 ? "start" : "center", inline: "center", behavior: "instant" });
    window.__tqaEvEl = el;
    if (a.check === "invisible") {
      const cs = getComputedStyle(el);
      window.__tqaEvStill = parseFloat(cs.opacity) < 0.01 || cs.visibility === "hidden";
    }
    return "element";
  }
  if (a.rect && a.rect.width > 0 && a.rect.height > 0) {
    window.scrollTo({ top: Math.max(0, a.rect.y - Math.max(40, (innerHeight - a.rect.height) / 2)), behavior: "instant" });
    window.__tqaEvRect = { ...a.rect };
    return "rect";
  }
  return null;
}

// 畫紅框並回傳要裁的範圍（畫面座標）
function outlineInPage(a) {
  document.getElementById("__tqa_ev")?.remove();
  let box;
  if (window.__tqaEvEl) {
    const r = window.__tqaEvEl.getBoundingClientRect();
    box = { left: r.left, top: r.top, width: r.width, height: r.height };
  } else if (window.__tqaEvRect?.fixedTop) {
    const h = window.__tqaEvRect.height;
    box = window.__tqaEvRect.overflowLine
      ? { left: innerWidth - 3, top: 0, width: 3, height: h }
      : { left: 0, top: 0, width: innerWidth, height: h };
  } else if (window.__tqaEvRect) {
    const r = window.__tqaEvRect;
    box = { left: r.x - scrollX, top: r.y - scrollY, width: r.width, height: r.height };
  } else return null;
  const d = document.createElement("div");
  d.id = "__tqa_ev";
  d.setAttribute("aria-hidden", "true");
  d.style.cssText = `position:fixed;left:${box.left - 2}px;top:${box.top - 2}px;width:${box.width + 4}px;height:${box.height + 4}px;` +
    "border:3px solid #ff1744;border-radius:2px;box-shadow:0 0 0 2px rgba(255,255,255,.85);pointer-events:none;z-index:2147483647;box-sizing:border-box;";
  document.documentElement.appendChild(d);
  // 裁切範圍：元素外加 pad，至少 360×220，夾在畫面內
  const pad = 48, minW = 360, minH = 220;
  let x = box.left - pad, y = box.top - pad, w = box.width + pad * 2, h = box.height + pad * 2;
  if (w < minW) { x -= (minW - w) / 2; w = minW; }
  if (h < minH) { y -= (minH - h) / 2; h = minH; }
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(innerWidth, x + w), y1 = Math.min(innerHeight, y + h);
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.max(1, Math.ceil(x1 - x0)), height: Math.max(1, Math.ceil(y1 - y0)) };
}

// 一次載入處理同頁同寬度的多組：回傳 Map(groupId → 檔名 | null)
export async function shootBucket(pool, cfg, profiles, site, bucket, dir) {
  const out = new Map();
  const first = bucket[0];
  const subdir = `evidence/${site}`; // 雙站各一個資料夾，不會互蓋
  const base = profiles.find((p) => p.name === first.worst.profile) || profiles[0];
  const prof = { ...base, width: first.worst.width, height: first.worst.height };
  let ctx;
  try {
    const pg = cfg.pages.find((p) => p.id === first.worst.page);
    const op = await openWithRetry(pool, prof, "no-preference", siteUrl(cfg.sites[site].url, pg.path), { expectedStatus: pg.expectedStatus, networkIdleMs: cfg.sites[site].networkIdleMs });
    ctx = op.context;
    const page = op.page;
    const prep = op.prep;
    if (prep.openError) throw new Error(prep.openError);
    for (const g of bucket) {
      const f = g.worst.f;
      try {
        const mode = await page.evaluate(locateInPage, { check: g.check, selector: g.selector, text: g.text, rect: f.rect });
        if (!mode) { out.set(g.id, null); continue; }
        await sleep(350);
        const clip = await page.evaluate(outlineInPage, {});
        if (!clip) { out.set(g.id, null); continue; }
        // 檔名保留中文，只換掉檔名不能用的字元
        const file = `${g.id}-${g.check}-${g.worst.page}-${g.worst.width}.png`.replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, "_");
        const buf = await page.screenshot({ clip, timeout: 15000 });
        fs.mkdirSync(inside(dir, subdir), { recursive: true });
        fs.writeFileSync(inside(dir, `${subdir}/${file}`), buf);
        let note = null, reappeared = false;
        if (g.check === "invisible") {
          const still = await page.evaluate(() => window.__tqaEvStill);
          if (mode !== "element") note = "取證時找不到元素，紅框用原量測位置";
          else if (still === false) {
            note = "原量測出現，取證重測時已看得見，未重現";
            reappeared = true;
          }
        }
        out.set(g.id, { file: `${subdir}/${file}`, note, reappeared });
        await page.evaluate(() => document.getElementById("__tqa_ev")?.remove());
      } catch {
        out.set(g.id, null);
      }
    }
  } catch {
    for (const g of bucket) if (!out.has(g.id)) out.set(g.id, null);
  } finally {
    await ctx?.close().catch(() => {});
  }
  return out;
}
