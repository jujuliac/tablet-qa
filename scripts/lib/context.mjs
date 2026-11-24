// 情境截圖與前後對比圖
// shootContext：拍完元素截圖後，把元素捲到距視窗頂約 160px（fixed 頁首下方），拍整個視窗，記下元素在視窗中的 rect。
// composeCompare：用 Playwright 開一頁 HTML 版型（左舊右新、標題列、網址列、框、底部說明）再截圖，不需要處理字型。
import fs from "node:fs";
import { resolveOne, sleep } from "./browser.mjs";
import { inside } from "./config.mjs";

export const CTX_TOP = 160;
export const FONT = `"PingFang TC","PingFang SC","Hiragino Sans GB","Microsoft JhengHei","Noto Sans CJK TC","Noto Sans TC",system-ui,sans-serif`;

export const FONT_EN = `-apple-system,"Helvetica Neue",Arial,"Segoe UI",${FONT}`;
export const COMPARE_LANGS = ["zh-Hant", "en"];
export const fontFor = (lang) => (lang === "en" ? FONT_EN : FONT);

// 要框的區塊叫什麼：capture.label > target 的 name／text／testId／css／role
export function blockName(cap, lang = "zh-Hant") {
  const en = lang === "en";
  if (!cap) return en ? "block" : "區塊";
  if (cap.label) return cap.label;
  const t = cap.target || {};
  const x = t.before || t.after ? t.after || t.before : t;
  const n = x.name ?? x.text ?? x.testId ?? x.css ?? x.role;
  return n ? (en ? `${n}` : `${n}區塊`) : en ? "block" : "區塊";
}

// ===== 對比圖上腳本自己寫的固定字（純函式；使用者自己寫的 label／note／capture.label 原樣保留）=====
// lang：zh-Hant（預設）｜en。compareLabels 有寫（非空）就逐鍵優先。
export function compareLabels(lang, custom) {
  const en = lang === "en";
  return { before: custom?.before || (en ? "Before" : "修改前"), after: custom?.after || (en ? "After" : "修改後") };
}
// 基準 run 的前綴（接在標題 label 前面）
export const baselinePrefix = (lang, runName) => (lang === "en" ? `Baseline ${runName}: ` : `基準 ${runName} 的 `);
// 標題列：label 空就只寫標籤（不留懸空冒號）
export function compareTitle(lang, labelText, prefix, label) {
  const body = `${prefix || ""}${label || ""}`;
  if (!body) return labelText;
  const en = lang === "en";
  if (!label) return `${labelText}${en ? ": " : "："}${body.trimEnd().replace(/[:：]$/, "")}`;
  return `${labelText}${en ? ": " : "："}${body}`;
}
// 頁尾：{ id, note, profile, vw, vh, block（blockName 的結果）, hOld, hNew, taller, labels }
export function compareFooter(lang, f) {
  const note = (f.note || "").replace(new RegExp("^" + f.id + "\\s*"), "").slice(0, 20);
  const head = note ? `${f.id} ${note}` : `${f.id}`;
  const h = (v) => (v === undefined || v === null || Number.isNaN(v) ? "?" : v);
  if (lang === "en") {
    return `${head} | ${f.profile} ${f.vw}×${f.vh} | Frame: ${f.block} (${f.labels.before} height ${h(f.hOld)} px → ${f.labels.after} height ${h(f.hNew)} px)${f.taller ? "; block extends below the viewport, only the visible part is shown" : ""}`;
  }
  return `${head}｜${f.profile} ${f.vw}×${f.vh}｜框：${f.block}（${f.labels.before}高 ${h(f.hOld)} px → ${f.labels.after}高 ${h(f.hNew)} px）${f.taller ? "；區塊比一屏高，只拍到開頭那屏" : ""}`;
}
// 警告（橘字）：{ diffs（陣列）, envWarn（字串，有值代表環境不同）, incomplete（布林）}；zh-Hant 沿用原句，en 用固定短句
export function compareWarn(lang, w) {
  const hasDiffs = !!w.diffs?.length;
  if (lang === "en") {
    const parts = [hasDiffs ? "Baseline conditions differ" : "", w.envWarn ? "Test environment differs" : "", w.incomplete ? "Incomplete evidence: do not use for judgment" : ""].filter(Boolean);
    return parts.length ? `${parts.join("; ")} (details in shots-report.md)` : "";
  }
  return [hasDiffs ? `基準條件不同：${w.diffs.join("；")}` : "", w.envWarn || "", w.incomplete ? "證據不完整的圖不能拿來判斷" : ""].filter(Boolean).join("；");
}

// 回傳 { file, rect, viewport, taller, sameAsMain }；capture 已是 viewport 的 case 直接用原圖（file 為 null，sameAsMain 為 true）
export async function shootContext(page, cap, { site, dir, file }) {
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  if (cap.mode === "viewport") return { file: null, sameAsMain: true, rect: null, viewport: vp, taller: false };
  if (cap.mode !== "element") return null; // fullPage、clip 沒有「要框的元素」
  const r = await resolveOne(page, cap.target, site, { wait: 0 });
  let loc = r.loc;
  if (cap.grow === "section") {
    const sec = loc.locator("xpath=ancestor-or-self::section[1]");
    if ((await sec.count()) === 1) loc = sec;
  }
  const pad = cap.padding ?? 0;
  const docTop = await loc.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  const top = Math.max(0, Math.round(docTop - pad - CTX_TOP));
  // 先多捲 60px 再往上回到目標位置：「往下捲就收起、往上捲才出現」的頁首會因此顯示出來（跟使用者往回捲一小段看到的一樣）
  await page.evaluate((y) => scrollTo(0, y), top + 60);
  await sleep(250);
  await page.evaluate((y) => scrollTo(0, y), top);
  await sleep(900); // 捲動後的淡入、延遲載入圖片
  const box = await loc.boundingBox();
  if (!box) throw new Error("捲動後找不到元素的位置");
  const buf = await page.screenshot({ timeout: 15000 });
  fs.writeFileSync(inside(dir, file), buf);
  const rect = { x: Math.round(box.x - pad), y: Math.round(box.y - pad), width: Math.round(box.width + 2 * pad), height: Math.round(box.height + 2 * pad) };
  return { file, sameAsMain: false, rect, viewport: vp, taller: rect.y + rect.height > vp.h + 1 };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const urlLine = (url) => {
  try {
    const u = new URL(url);
    return `${u.host} / ${(u.pathname + u.search).replace(/^\//, "")}`;
  } catch {
    return url;
  }
};

// side：{ buf, rect, vw, vh, title, sub, color, taller }；回傳 PNG Buffer
export async function composeCompare(pool, { left, right, footer, footerWarn, lang }) {
  const W = 2400, PAD = 28, GAP = 24;
  const PW = (W - 2 * PAD - GAP) / 2;
  const panel = (s) => {
    const k = PW / s.vw;
    const ph = s.vh * k;
    const frame = s.rect
      ? `<div style="position:absolute;left:${s.rect.x * k - 3}px;top:${s.rect.y * k - 3}px;width:${s.rect.width * k + 6}px;height:${s.rect.height * k + 6}px;border:6px solid ${s.color};box-sizing:border-box;pointer-events:none"></div>`
      : "";
    return `<div class="col"><div class="t" style="color:${s.color}">${esc(s.title)}</div><div class="u">${esc(s.sub)}</div>
<div class="p" style="width:${PW}px;height:${ph}px"><img src="data:image/png;base64,${s.buf.toString("base64")}" style="width:${PW}px;height:${ph}px;display:block">${frame}</div></div>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#f4f1ea;font-family:${fontFor(lang)}}
.wrap{width:${W}px;padding:20px ${PAD}px 18px;box-sizing:border-box}
.row{display:flex;gap:${GAP}px;align-items:flex-start}
.col{width:${PW}px}
.t{font-size:32px;line-height:44px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.u{font-size:20px;line-height:30px;color:#555;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.p{position:relative;overflow:hidden;border:2px solid #aaa;box-sizing:content-box;margin:-2px}
.f{margin-top:14px;font-size:20px;line-height:28px;color:#444}
.w{color:#b45309}
</style><div class="wrap"><div class="row">${panel(left)}${panel(right)}</div>
<div class="f">${esc(footer)}${footerWarn ? ` <span class="w">${esc(footerWarn)}</span>` : ""}</div></div>`;
  const browser = await pool.get("chromium");
  const ctx = await browser.newContext({ viewport: { width: W, height: 1000 }, deviceScaleFactor: 1 });
  try {
    const pg = await ctx.newPage();
    await pg.setContent(html, { waitUntil: "load" });
    await pg.evaluate(() => document.fonts?.ready);
    return await pg.screenshot({ fullPage: true });
  } finally {
    await ctx.close().catch(() => {});
  }
}
