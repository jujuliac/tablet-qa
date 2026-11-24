// 瀏覽器、準備流程、找元素、操作、截圖（shots / sweep 共用）
import path from "node:path";
import { siteUrl, BROWSER_CHOICES } from "./config.mjs";

const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---------- 瀏覽器 ----------
// Playwright 找不到系統 Chrome 時的錯誤（1.64.1：distribution 'chrome' is not found at ...）。
// 只有這種錯誤才換成內建 Chromium；認不出來就原樣丟出（寧可停下來，不要亂換）
export const CHANNEL_NOT_FOUND = /distribution '[^']*' is not found/i;
// 內建瀏覽器還沒下載（Executable doesn't exist at ...）
export const NO_EXECUTABLE = /Executable doesn't exist/i;
const errText = (e) => String(e?.message || e).trim();
const CHANNELS = { chrome: "chrome", msedge: "msedge" };
const LABELS = { chrome: "chrome", msedge: "msedge", bundled: "bundled-chromium" };

export class BrowserPool {
  // browser：設定檔頂層的 browser（auto／chrome／bundled／msedge），只影響 chromium 引擎；省略等於 auto
  // playwrightPath：目前載入的 Playwright 套件資料夾，只用在錯誤訊息裡告訴使用者要在哪裡執行安裝指令
  constructor(pw, { browser = "auto", playwrightPath } = {}) {
    if (!BROWSER_CHOICES.includes(browser)) throw new Error(`browser 只能是 ${BROWSER_CHOICES.join("、")}，收到「${browser}」`);
    this.pw = pw;
    this.browserSetting = browser;
    this.playwrightPath = playwrightPath;
    this.browsers = {}; // engine → 啟動中或已啟動的 Promise（並行要求同一引擎只會啟動一次）
    this.versions = {}; // engine → 版本字串；chromium 會帶通道，例如 "chrome 131.0.x"、"bundled-chromium 131.0.x"
    this.fellBack = false; // auto 找不到 Chrome 而改用內建 Chromium
  }
  // 要在哪個資料夾執行 npx playwright install：Playwright 套件所在專案的資料夾
  installDir() {
    const p = this.playwrightPath;
    if (!p) return "有裝 Playwright 的網站專案資料夾";
    const parent = path.dirname(p);
    return path.basename(parent).startsWith("node_modules") ? path.dirname(parent) : parent;
  }
  async launchChromium() {
    const setting = this.browserSetting;
    const chromium = this.pw.chromium;
    if (setting === "bundled" || CHANNELS[setting]) {
      try {
        const browser = await (setting === "bundled" ? chromium.launch() : chromium.launch({ channel: CHANNELS[setting] }));
        return { browser, label: LABELS[setting] };
      } catch (e) {
        // 明確指定的瀏覽器失敗就報錯，不換別的
        const hint = NO_EXECUTABLE.test(errText(e)) || CHANNEL_NOT_FOUND.test(errText(e)) ? this.installHint(setting) : "";
        throw new Error(`設定檔指定 browser「${setting}」，但啟動失敗：${errText(e)}${hint}\n拿掉這個設定就會自動挑可用的瀏覽器。`);
      }
    }
    // auto：先試系統 Chrome
    let chromeErr;
    try {
      return { browser: await chromium.launch({ channel: "chrome" }), label: LABELS.chrome };
    } catch (e) {
      if (!CHANNEL_NOT_FOUND.test(errText(e))) {
        e.launchFailed = true; // Chrome 有裝但啟動失敗：原樣丟出，不換瀏覽器
        throw e;
      }
      chromeErr = e;
    }
    // 沒有 Chrome：改用 Playwright 內建的 Chromium
    try {
      const browser = await chromium.launch();
      if (!this.fellBack) console.log("找不到 Google Chrome，改用 Playwright 內建的 Chromium");
      this.fellBack = true;
      return { browser, label: LABELS.bundled };
    } catch (e) {
      if (!NO_EXECUTABLE.test(errText(e))) throw new Error(`找不到 Google Chrome，改用 Playwright 內建的 Chromium 時啟動失敗：${errText(e)}`);
      throw new Error(
        "找不到可以用的瀏覽器（Google Chrome 和 Playwright 內建的 Chromium 都沒有）。請擇一：\n" +
          "1. 安裝 Google Chrome（https://www.google.com/chrome/），裝好重跑即可。\n" +
          `2. 或在這個資料夾開終端機：${this.installDir()}\n   執行：npx playwright install chromium\n   這會下載測試用的瀏覽器（約幾百 MB），不會改你的網站。\n` +
          `細節：\n系統 Chrome：${errText(chromeErr)}\n內建 Chromium：${errText(e)}`
      );
    }
  }
  installHint(setting) {
    if (setting === "chrome") return "\n沒有 Google Chrome 的話，請安裝（https://www.google.com/chrome/）。";
    if (setting === "msedge") return "\n沒有 Microsoft Edge 的話，請安裝（https://www.microsoft.com/edge）。";
    return `\n內建 Chromium 還沒下載的話，請在這個資料夾開終端機：${this.installDir()}\n執行：npx playwright install chromium（會下載測試用的瀏覽器，不會改你的網站）。`;
  }
  async launchWebkit() {
    try {
      return { browser: await this.pw.webkit.launch(), label: null };
    } catch (e) {
      if (!NO_EXECUTABLE.test(errText(e))) throw e;
      throw new Error(`profile 用了 engine "webkit"，但 WebKit 還沒下載。請在這個資料夾開終端機：${this.installDir()}\n執行：npx playwright install webkit（會下載測試用的瀏覽器，不會改你的網站）。\n細節：${errText(e)}`);
    }
  }
  get(engine = "chromium") {
    if (!this.browsers[engine]) {
      const p = (engine === "webkit" ? this.launchWebkit() : this.launchChromium()).then(({ browser: b, label }) => {
        this.versions[engine] = label ? `${label} ${b.version()}` : b.version();
        return b;
      });
      this.browsers[engine] = p;
      p.catch(() => delete this.browsers[engine]); // 啟動失敗就清掉，下次重試
    }
    return this.browsers[engine];
  }
  async close() {
    const list = Object.values(this.browsers);
    this.browsers = {};
    for (const p of list) await p.then((b) => b.close()).catch(() => {});
  }
}

export async function newPage(pool, profile, motion = "no-preference") {
  const browser = await pool.get(profile.engine || "chromium");
  const opts = {
    viewport: { width: profile.width, height: profile.height },
    reducedMotion: motion === "reduce" ? "reduce" : "no-preference",
    deviceScaleFactor: profile.touch ? 2 : 1,
  };
  if (profile.touch) Object.assign(opts, { isMobile: true, hasTouch: true, userAgent: IPAD_UA });
  if (profile.locale) opts.locale = profile.locale;
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  return { context, page };
}

export async function checkEnv(page, profile) {
  const env = await page.evaluate(() => ({
    pointerCoarse: matchMedia("(pointer: coarse)").matches,
    hoverNone: matchMedia("(hover: none)").matches,
  }));
  const ok = profile.touch ? env.pointerCoarse && env.hoverNone : true;
  return { ...env, ok };
}

// ---------- 起跑前的煙霧檢查 ----------
// 回傳 { ok, message }。profiles：要試的 profile（通常第一個，加上第一個觸控的）
export async function smokeCheck(pool, profiles, url, expectedStatus) {
  const seen = new Set();
  for (const prof of profiles) {
    if (seen.has(prof.name)) continue;
    seen.add(prof.name);
    try {
      await pool.get(prof.engine || "chromium");
    } catch (e) {
      return { ok: false, message: `${e.launchFailed ? "瀏覽器找得到，但啟動失敗：" : "瀏覽器沒有啟動："}${e.message}` };
    }
    let ctx;
    try {
      const np = await newPage(pool, prof);
      ctx = np.context;
      let resp;
      try {
        resp = await np.page.goto(url, { waitUntil: "load", timeout: 45000 });
      } catch (e) {
        return { ok: false, message: `第一頁打不開（${url}）：${e.message.split("\n")[0]}。請確認網址、網路，或網站是否在線。` };
      }
      const st = resp ? resp.status() : null;
      if (st && st >= 400 && !statusOk(st, expectedStatus)) return { ok: false, message: `第一頁回 HTTP ${st}（${url}）。網站可能壞了、網址不對，或需要登入／防火牆放行。` };
      const env = await checkEnv(np.page, prof);
      if (!env.ok) return { ok: false, message: `觸控模擬沒有生效（profile「${prof.name}」的 pointer: coarse 或 hover: none 不成立）。這樣量到的點擊範圍不可信，先修好環境再跑。` };
    } catch (e) {
      return { ok: false, message: `起跑檢查失敗：${e.message.split("\n")[0]}` };
    } finally {
      await ctx?.close().catch(() => {});
    }
  }
  return { ok: true, message: "" };
}

// expectedStatus：數字或陣列；符合就當成正常頁面照常量測（例如專門測 404／500 頁）
export const statusOk = (st, expected) => expected !== undefined && [].concat(expected).includes(st);

// ---------- 準備流程 ----------
// 回傳 { status, finalUrl, warnings, notes, openError?, gotoError? }
// networkIdleMs：等 networkidle 的上限（預設 3 秒；設定檔 sites.<x>.networkIdleMs 可覆寫）。
// gotoError：true 表示 page.goto 本身逾時或網路錯誤（可以換新 context 重試）；HTTP ≥ 400 不算
export async function openAndPrepare(page, url, { rectFn, expectedStatus, networkIdleMs = 3000 } = {}) {
  const warnings = [];
  const notes = []; // 只記錄、不影響 status
  let status = null;
  let finalUrl = url;
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: 45000 });
    status = resp ? resp.status() : null;
    finalUrl = page.url();
  } catch (e) {
    return { status, finalUrl, warnings, notes, openError: `打不開：${e.message.split("\n")[0]}`, gotoError: true };
  }
  if (status && status >= 400 && !statusOk(status, expectedStatus)) return { status, finalUrl, warnings, notes, openError: `HTTP ${status}` };

  // 1. networkidle
  try {
    await page.waitForLoadState("networkidle", { timeout: networkIdleMs });
  } catch {
    notes.push(`networkidle ${networkIdleMs / 1000} 秒內沒達成`);
  }
  warnings.push(...(await prepareLayout(page, rectFn)));
  return { status, finalUrl, warnings, notes };
}

// 開新 context＋載入頁面；goto 逾時或網路錯誤時，換一個全新的 context 再試一次（只重試載入，不重播 steps）。
// 回傳 { context, page, prep }：呼叫端負責關 context（失敗時也要關）
export async function openWithRetry(pool, profile, motion, url, opts = {}) {
  let np = await newPage(pool, profile, motion);
  let prep = await openAndPrepare(np.page, url, opts);
  if (prep.openError && prep.gotoError) {
    const first = prep.openError;
    await np.context.close().catch(() => {});
    np = await newPage(pool, profile, motion);
    prep = await openAndPrepare(np.page, url, opts);
    if (prep.openError) prep.openError = `${prep.openError}（已重試 1 次，第一次：${first}）`;
    else prep.notes.push(`重試 1 次（第一次：${first}）`);
  }
  return { context: np.context, page: np.page, prep };
}

// 第 2–5 步：捲到底再回頂、等字型、檢查圖片、等版面穩定。
// 換視窗寬度之後也要重做（新顯示的內容要重新觸發進場動畫與 lazy 圖片）
export async function prepareLayout(page, rectFn) {
  const warnings = [];
  // 2. 從上捲到底再回頂端
  const capped = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(200, innerHeight * 0.7);
    let y = 0,
      i = 0;
    for (; i < 200; i++) {
      window.scrollTo({ top: y, behavior: "instant" });
      await wait(120);
      if (y + innerHeight >= document.documentElement.scrollHeight - 1) break;
      y += step;
    }
    await wait(300);
    window.scrollTo({ top: 0, behavior: "instant" });
    await wait(200);
    return i >= 200;
  });
  if (capped) warnings.push("捲動超過 200 步仍未到底（頁面過長或無限載入）");
  // 3. 字型
  const fonts = await Promise.race([
    page.evaluate(() => document.fonts.ready.then(() => true)),
    sleep(10000).then(() => false),
  ]);
  if (!fonts) warnings.push("document.fonts.ready 10 秒內沒完成");
  // 4. 畫面內圖片
  warnings.push(...(await checkImages(page, null)));
  // 5. 版面穩定
  const info = {};
  if (!(await waitStable(page, rectFn, info))) warnings.push("版面 5 秒內沒穩定（位置大小持續變動）" + (info.error ? `；讀取位置一直出錯：${info.error}` : ""));
  return warnings;
}

// region：文件座標 {x,y,width,height}；null = 目前畫面。回傳 warnings 陣列
export async function checkImages(page, region) {
  const probe = () =>
    page.evaluate((region) => {
      const vp = region
        ? { x: region.x - scrollX, y: region.y - scrollY, w: region.width, h: region.height }
        : { x: 0, y: 0, w: innerWidth, h: innerHeight };
      const bad = [];
      for (const img of document.images) {
        const r = img.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.right < vp.x || r.left > vp.x + vp.w || r.bottom < vp.y || r.top > vp.y + vp.h) continue;
        const cs = getComputedStyle(img);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (!(img.complete && img.naturalWidth > 0)) bad.push((img.currentSrc || img.src || "?").slice(-60));
      }
      return bad;
    }, region);
  let bad = await probe();
  for (let i = 0; i < 20 && bad.length; i++) {
    await sleep(250);
    bad = await probe();
  }
  return bad.length ? [`有 ${bad.length} 張畫面內圖片沒載好：${bad.slice(0, 3).join("、")}`] : [];
}

// rectFn：回傳 JSON 字串（位置大小）的函式，預設 body
// 讀取例外不算穩定（連續例外也不累積穩定時間），逾時回傳 false；info.error 記最後一個錯誤
export async function waitStable(page, rectFn, info = {}) {
  const read =
    rectFn ||
    (() =>
      page.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height, document.documentElement.scrollHeight].map(Math.round).join();
      }));
  const t0 = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - t0 < 5000) {
    let cur;
    try {
      cur = await read();
    } catch (e) {
      info.error = String(e.message || e).split("\n")[0];
      last = null;
      since = Date.now();
      await sleep(100);
      continue;
    }
    if (cur !== last) {
      last = cur;
      since = Date.now();
    } else if (Date.now() - since >= 300) {
      delete info.error;
      return true;
    }
    await sleep(100);
  }
  return false;
}

// ---------- 找元素 ----------
export function describeTarget(t) {
  if (!t) return "(無)";
  if (t.before || t.after) return `{before:${describeTarget(t.before)}, after:${describeTarget(t.after)}}`;
  let s = JSON.stringify({ ...t, within: undefined, pick: undefined });
  if (t.within) s += ` within ${describeTarget(t.within)}`;
  if (t.pick !== undefined) s += ` pick=${t.pick}`;
  return s;
}

// before/after 分開寫時，依網站取一份
export function pickSide(target, site) {
  if (target && (target.before || target.after) && !target.testId && !target.role && !target.css && !target.text) {
    const t = target[site];
    if (!t) throw new Error(`target 沒有 ${site} 版本`);
    return t;
  }
  return target;
}

function build(scope, t) {
  const base = t.within ? build(scope, t.within) : scope;
  if (t.testId) return base.getByTestId(t.testId);
  if (t.role) return base.getByRole(t.role, { name: t.name, exact: t.exact });
  if (t.css) return base.locator(t.css);
  if (t.text !== undefined) return base.getByText(t.text, { exact: t.exact ?? false });
  throw new Error(`target 要有 testId / role / css / text 其中之一：${JSON.stringify(t)}`);
}

// 找不到元素時給的線索：同 role 看得見的前 5 個名稱、含部分字的前 5 個文字；css／testId 只說找不到。
// 名稱是近似值（aria-label → aria-labelledby → 文字 → alt／title／value），不一定跟 Playwright 的 accessible name 完全一樣
export async function describeCandidates(page, rawTarget, site) {
  try {
    const t = pickSide(rawTarget, site);
    const base = t.within ? build(page, t.within) : page;
    const vis = `(els) => els.filter((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && r.width > 0 && r.height > 0; })`;
    const hiddenNote = async () => {
      const n = await build(page, t).count();
      return n ? `；有 ${n} 個符合但目前看不見（display／visibility／大小為 0）` : "";
    };
    const list = (a) => (a.length ? a.map((x) => `「${x}」`).join("、") : "（沒有）");
    if (t.role) {
      const names = await base.getByRole(t.role).evaluateAll(
        new Function("els", `const vis = ${vis};
          const nm = (e) => { let n = e.getAttribute("aria-label");
            if (!n && e.getAttribute("aria-labelledby")) n = e.getAttribute("aria-labelledby").split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ");
            return (n || e.innerText || e.textContent || e.getAttribute("alt") || e.getAttribute("title") || e.value || "").trim().replace(/\s+/g, " ").slice(0, 30); };
          return [...new Set(vis(els).map(nm).filter(Boolean))].slice(0, 5);`)
      );
      return `候選（同 role=${t.role} 看得見的前 5 個名稱）：${list(names)}${await hiddenNote()}`;
    }
    if (t.text !== undefined) {
      const full = String(t.text);
      for (const len of [Math.ceil(full.length * 0.6), Math.ceil(full.length / 2), 2]) {
        const part = full.slice(0, Math.max(1, len));
        if (!part) continue;
        const texts = await base.getByText(part, { exact: false }).evaluateAll(
          new Function("els", `const vis = ${vis};
            return [...new Set(vis(els).map((e) => (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)).filter(Boolean))].slice(0, 5);`)
        );
        if (texts.length) return `候選（含「${part}」的前 5 個文字）：${list(texts)}${await hiddenNote()}`;
      }
      return `候選：找不到含部分字的文字${await hiddenNote()}`;
    }
    if (t.css) return `css 找不到看得見的元素${await hiddenNote()}`;
    if (t.testId) return `testId 找不到看得見的元素${await hiddenNote()}`;
  } catch (e) {
    return `（列候選時出錯：${String(e.message).split("\n")[0]}）`;
  }
  return "";
}

// 找到恰好 1 個才回傳；0 個或多個丟錯。回傳 { loc, picked }
export async function resolveOne(page, rawTarget, site, { wait = 2000 } = {}) {
  const t = pickSide(rawTarget, site);
  const all = build(page, t);
  // 只算看得見的（display/visibility、大小不為 0）
  const visIdx = async () =>
    (await all.evaluateAll((els) =>
      els.map((e, i) => {
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && r.width > 0 && r.height > 0 ? i : -1;
      })
    )).filter((i) => i >= 0);
  let idx = await visIdx();
  const t0 = Date.now();
  while (idx.length === 0 && Date.now() - t0 < wait) {
    await sleep(200);
    idx = await visIdx();
  }
  const n = idx.length;
  if (n === 0) throw new Error(`找不到看得見的元素：${describeTarget(t)}；${await describeCandidates(page, rawTarget, site)}`);
  if (t.pick !== undefined) {
    const k = t.pick === "first" ? 0 : t.pick === "last" ? n - 1 : Number(t.pick) - 1; // 數字從 1 起算
    if (!(k >= 0 && k < n)) throw new Error(`pick=${t.pick} 超出範圍（共 ${n} 個）：${describeTarget(t)}`);
    return { loc: all.nth(idx[k]), picked: String(t.pick), count: n };
  }
  if (n > 1) {
    const samples = await all.evaluateAll((els, idx) =>
      idx.slice(0, 4).map((i) => `<${els[i].tagName.toLowerCase()}> ${(els[i].innerText || els[i].textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}`), idx);
    throw new Error(`符合 ${n} 個看得見的元素，不自動挑第一個（要挑請加 pick）：${describeTarget(t)}；例如 ${samples.join(" | ")}`);
  }
  return { loc: all.nth(idx[0]), picked: null, count: 1 };
}

// 目前看得見的符合元素（文件座標的 rect 陣列）；最多等 wait 毫秒。require 用
export async function findVisible(page, rawTarget, site, wait = 0) {
  const t = pickSide(rawTarget, site);
  const all = build(page, t);
  const t0 = Date.now();
  for (;;) {
    const rects = await all.evaluateAll((els) =>
      els.map((e) => {
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const ok = cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && r.width > 0 && r.height > 0 && parseFloat(cs.opacity) > 0.01;
        return ok ? { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } : null;
      }).filter(Boolean)
    );
    if (rects.length || Date.now() - t0 >= wait) return rects;
    await sleep(200);
  }
}

// ---------- 操作 ----------
export async function runSteps(page, steps = [], { site, touch }) {
  const waits = [];
  let picked = null;
  for (const [i, s] of steps.entries()) {
    const tag = `step ${i + 1} ${s.action}`;
    try {
      if (s.action === "click") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        await r.loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        if (touch) await r.loc.tap({ timeout: 10000 });
        else await r.loc.click({ timeout: 10000 });
      } else if (s.action === "scrollTo") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        const off = s.offset ?? 120;
        await r.loc.evaluate((el, off) => {
          const y = el.getBoundingClientRect().top + scrollY - off;
          window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
        }, off);
        await sleep(300);
      } else if (s.action === "scrollBy") {
        await page.evaluate((y) => window.scrollBy({ top: y, behavior: "instant" }), s.y || 0);
        await sleep(300);
      } else if (s.action === "scrollLeft") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        await r.loc.evaluate((el, v) => {
          el.scrollTo({ left: v === "end" ? el.scrollWidth : Number(v), behavior: "instant" });
        }, s.value ?? 0);
        await sleep(300);
      } else if (s.action === "waitVisible") {
        const timeout = s.timeout ?? 10000;
        const r = await resolveOne(page, s.target, site, { wait: timeout });
        picked = r.picked || picked;
        await r.loc.waitFor({ state: "visible", timeout });
      } else if (s.action === "fill") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        await r.loc.fill(String(s.value ?? ""), { timeout: 10000 });
        await sleep(200);
      } else if (s.action === "selectOption") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        if (s.value === undefined && s.label === undefined) throw new Error("selectOption 要有 value 或 label");
        await r.loc.selectOption(s.value !== undefined ? { value: String(s.value) } : { label: String(s.label) }, { timeout: 10000 });
        await sleep(200);
      } else if (s.action === "check" || s.action === "uncheck") {
        const r = await resolveOne(page, s.target, site);
        picked = r.picked || picked;
        await r.loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        if (s.action === "check") await r.loc.check({ timeout: 10000 });
        else await r.loc.uncheck({ timeout: 10000 });
        await sleep(200);
      } else if (s.action === "waitHidden") {
        const timeout = s.timeout ?? 10000;
        const t0 = Date.now();
        const t = pickSide(s.target, site);
        const all = build(page, t);
        for (;;) {
          const n = await all.evaluateAll((els) => els.filter((e) => {
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
          }).length);
          if (n === 0) break;
          if (Date.now() - t0 > timeout) throw new Error(`${timeout}ms 內元素沒有消失：${describeTarget(t)}`);
          await sleep(200);
        }
      } else if (s.action === "press") {
        await page.keyboard.press(s.key);
        await sleep(200);
      } else if (s.action === "wait") {
        waits.push(s.ms);
        await sleep(s.ms);
      } else {
        throw new Error(`不認得的 action：${s.action}`);
      }
    } catch (e) {
      throw new Error(`${tag} 失敗：${e.message.split("\n")[0]}`);
    }
  }
  return { waits, picked };
}

// ---------- 截圖 ----------
const MAX_H = 4000;

// 回傳文件座標的 rect（element / viewport 用）
async function docRect(loc) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  });
}

export async function hideTargets(page, hide = [], site, warnings) {
  const done = [];
  for (const raw of hide) {
    try {
      const t = pickSide(raw, site);
      const n = await build(page, t).evaluateAll((els) => {
        els.forEach((e) => e.style.setProperty("visibility", "hidden", "important"));
        return els.length;
      });
      if (n === 0) warnings.push(`hide 沒找到：${describeTarget(t)}`);
      else done.push(`${describeTarget(t)} ×${n}`);
    } catch (e) {
      warnings.push(`hide 失敗：${e.message.split("\n")[0]}`);
    }
  }
  return done;
}

// 回傳 { buffer, rect, truncated, fallback, picked, warnings }
export async function capture(page, cap, { site, engine }) {
  const warnings = [];
  const mode = cap.mode;
  let rect, picked = null, truncated = false, viewportRelative = false, fullPage = false;

  if (mode === "viewport") {
    rect = await page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
    viewportRelative = true;
  } else if (mode === "fullPage") {
    rect = await page.evaluate(() => ({
      x: 0,
      y: 0,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    fullPage = true;
  } else if (mode === "clip") {
    const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY }));
    const v = (n, size) => (n <= 1 ? n * size : n);
    const rel = { x: v(cap.x ?? 0, vp.w), y: v(cap.y ?? 0, vp.h), width: v(cap.width ?? 1, vp.w), height: v(cap.height ?? 1, vp.h) };
    rect = { x: rel.x + vp.sx, y: rel.y + vp.sy, width: rel.width, height: rel.height };
    viewportRelative = true;
  } else if (mode === "element") {
    const r = await resolveOne(page, cap.target, site);
    picked = r.picked;
    let loc = r.loc;
    if (cap.grow === "section") {
      const sec = loc.locator("xpath=ancestor-or-self::section[1]");
      if ((await sec.count()) === 1) loc = sec;
      else warnings.push("grow: section 找不到上層 section，改拍元素本身");
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await sleep(200);
    rect = await docRect(loc);
    const pad = cap.padding ?? 0;
    rect = { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad };
    if (rect.width <= 0 || rect.height <= 0) throw new Error("元素大小為 0，沒有東西可拍");
  } else {
    throw new Error(`不認得的 capture.mode：${mode}`);
  }

  // 位置、圖片再確認一次（針對實際要拍的範圍）
  if (mode === "element" || mode === "viewport" || mode === "clip") {
    warnings.push(...(await checkImages(page, rect)));
  }

  // 截斷
  if (rect.height > MAX_H) {
    rect = { ...rect, height: MAX_H };
    truncated = true;
  }
  // 夾在文件範圍內
  const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, vw: innerWidth }));
  const maxW = Math.max(doc.w, doc.vw);
  rect.x = Math.max(0, rect.x);
  rect.y = Math.max(0, rect.y);
  rect.width = Math.min(rect.width, maxW - rect.x);
  rect.height = Math.min(rect.height, Math.max(doc.h, 1) - rect.y);

  // 能在目前畫面內拍的，用畫面座標（fixed 元素、彈窗才不會錯位）
  const sc = await page.evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }));
  const fitsViewport =
    rect.x - sc.x >= -1 && rect.y - sc.y >= -1 && rect.x + rect.width - sc.x <= sc.w + 1 && rect.y + rect.height - sc.y <= sc.h + 1;

  let buffer, fallback = null;
  const timeout = 15000;
  const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
  try {
    if (viewportRelative || fitsViewport) {
      const clip = round({ ...rect, x: rect.x - sc.x, y: rect.y - sc.y });
      clip.x = Math.max(0, clip.x);
      clip.y = Math.max(0, clip.y);
      buffer = await page.screenshot({ clip, timeout });
    } else {
      buffer = await page.screenshot({ fullPage: true, clip: round(rect), timeout });
    }
  } catch (e) {
    if (engine === "webkit") throw new Error(`截圖失敗（webkit 沒有 CDP 備援）：${e.message.split("\n")[0]}`);
    const cdp = await page.context().newCDPSession(page);
    const c = round(rect);
    const params = { format: "png", captureBeyondViewport: true, fromSurface: true };
    params.clip = { ...c, scale: 1 };
    const res = await cdp.send("Page.captureScreenshot", params);
    buffer = Buffer.from(res.data, "base64");
    fallback = "cdp";
    await cdp.detach().catch(() => {});
  }
  return { buffer, rect: round(rect), truncated, fallback, picked, warnings };
}

// 目前頁面某 target 的位置大小字串（waitStable 用）
export function rectReader(page, target, site) {
  return async () => {
    const { loc } = await resolveOne(page, target, site, { wait: 0 });
    return loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round).join();
    });
  };
}

export { siteUrl };
