// 瀏覽器選擇與備援（用假的 playwright 物件，不開瀏覽器）、設定值驗證、shots 比對基準時的瀏覽器核對
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BrowserPool } from "../lib/browser.mjs";
import { loadConfig, toolLine } from "../lib/config.mjs";
import { browserDiffText } from "../lib/compare.mjs";

const CHROME_MISSING = "browserType.launch: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nRun \"npx playwright install chrome\"";
const BUNDLED_MISSING = "browserType.launch: Executable doesn't exist at /x/ms-playwright/chromium-1200/chrome\nLooks like Playwright was just installed or updated.";

// behaviors：{ chrome, msedge, bundled }，值為 "ok" 或錯誤訊息；記錄每次 launch 的參數
function fakePw(behaviors) {
  const calls = [];
  const launch = async (opts = {}) => {
    const key = opts.channel || "bundled";
    calls.push(key);
    const b = behaviors[key];
    if (b === "ok") return { version: () => "131.0.6778.86", close: async () => {} };
    throw new Error(b);
  };
  return { calls, chromium: { launch }, webkit: { launch: async () => { throw new Error(BUNDLED_MISSING); } } };
}
const quiet = async (fn) => {
  const log = console.log, out = [];
  console.log = (...a) => out.push(a.join(" "));
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
  }
};

// 1. auto：有 Chrome 就用 Chrome，不備援
{
  const pw = fakePw({ chrome: "ok", bundled: "ok" });
  const pool = new BrowserPool(pw);
  await pool.get();
  assert.deepEqual(pw.calls, ["chrome"]);
  assert.equal(pool.versions.chromium, "chrome 131.0.6778.86");
  assert.equal(pool.fellBack, false);
}
// 2. auto：Chrome「找不到」→ 改用內建 Chromium，印一行，版本字串帶通道
{
  const pw = fakePw({ chrome: CHROME_MISSING, bundled: "ok" });
  const pool = new BrowserPool(pw, { browser: "auto" });
  const { out } = await quiet(() => pool.get());
  assert.deepEqual(pw.calls, ["chrome", "bundled"]);
  assert.equal(pool.versions.chromium, "bundled-chromium 131.0.6778.86");
  assert.equal(pool.fellBack, true);
  assert.deepEqual(out, ["找不到 Google Chrome，改用 Playwright 內建的 Chromium"]);
  await pool.get(); // 第二次拿同一個，不再啟動、不再印
  assert.equal(pw.calls.length, 2);
}
// 3. auto：Chrome 有但其他錯誤（權限、缺函式庫、逾時、崩潰）→ 原樣丟出，不備援
for (const msg of ["browserType.launch: Timeout 180000ms exceeded.", "spawn EACCES", "error while loading shared libraries: libnss3.so", "Target page, context or browser has been closed"]) {
  const pw = fakePw({ chrome: msg, bundled: "ok" });
  const pool = new BrowserPool(pw);
  await assert.rejects(() => pool.get(), (e) => e.message === msg && e.launchFailed === true);
  assert.deepEqual(pw.calls, ["chrome"], "不能備援：" + msg);
}
// 4. auto：兩個都沒有 → 合併訊息（資料夾、指令、不改網站、完整細節；不提 --no-smoke）
{
  const pw = fakePw({ chrome: CHROME_MISSING, bundled: BUNDLED_MISSING });
  const pool = new BrowserPool(pw, { playwrightPath: "/proj/site/node_modules/playwright" });
  await assert.rejects(() => pool.get(), (e) => {
    assert.match(e.message, /找不到可以用的瀏覽器/);
    assert.match(e.message, /\/proj\/site\n/);
    assert.match(e.message, /npx playwright install chromium/);
    assert.match(e.message, /不會改你的網站/);
    assert.match(e.message, /Run "npx playwright install chrome"/, "保留完整原始訊息，不只第一行");
    assert.match(e.message, /Looks like Playwright was just installed/);
    assert.doesNotMatch(e.message, /no-smoke/);
    return true;
  });
  // 失敗後會清掉快取，可以重試
  assert.deepEqual(pw.calls, ["chrome", "bundled"]);
  await assert.rejects(() => pool.get());
  assert.equal(pw.calls.length, 4);
}
// 4b. 套件放在 node_modules-shared 這種資料夾時，指令資料夾是它的上一層
assert.equal(new BrowserPool(fakePw({}), { playwrightPath: "/proj/site/node_modules-shared/playwright" }).installDir(), "/proj/site");
// 5. 內建 Chromium 找得到但啟動失敗 → 不當成「沒裝」
{
  const pw = fakePw({ chrome: CHROME_MISSING, bundled: "browserType.launch: Timeout 180000ms exceeded." });
  const pool = new BrowserPool(pw);
  await assert.rejects(() => pool.get(), /改用 Playwright 內建的 Chromium 時啟動失敗：.*Timeout/s);
}
// 6. 明確指定：失敗就報錯，不換
for (const [setting, key, err] of [["chrome", "chrome", CHROME_MISSING], ["msedge", "msedge", CHROME_MISSING.replace("chrome", "msedge")], ["bundled", "bundled", BUNDLED_MISSING], ["chrome", "chrome", "Timeout"]]) {
  const pw = fakePw({ chrome: "ok", msedge: "ok", bundled: "ok", [key]: err });
  const pool = new BrowserPool(pw, { browser: setting });
  await assert.rejects(() => pool.get(), (e) => {
    assert.match(e.message, new RegExp(`設定檔指定 browser「${setting}」，但啟動失敗`));
    assert.match(e.message, /拿掉這個設定就會自動挑可用的瀏覽器/);
    return true;
  });
  assert.deepEqual(pw.calls, [key], `${setting} 不能備援`);
}
// 6b. 明確指定成功：通道對、版本字串帶通道
for (const [setting, key, label] of [["chrome", "chrome", "chrome"], ["msedge", "msedge", "msedge"], ["bundled", "bundled", "bundled-chromium"]]) {
  const pw = fakePw({ [key]: "ok" });
  const pool = new BrowserPool(pw, { browser: setting });
  await pool.get();
  assert.deepEqual(pw.calls, [key]);
  assert.equal(pool.versions.chromium, `${label} 131.0.6778.86`);
}
// 6c. bundled 不帶 channel
{
  let seen;
  const pw = { chromium: { launch: async (o) => ((seen = o), { version: () => "1", close: async () => {} }) } };
  await new BrowserPool(pw, { browser: "bundled" }).get();
  assert.equal(seen, undefined);
}
// 7. webkit 不受 browser 設定影響；沒裝時訊息說明怎麼裝
{
  const pw = fakePw({ chrome: "ok" });
  const pool = new BrowserPool(pw, { browser: "bundled", playwrightPath: "/p/node_modules/playwright" });
  await assert.rejects(() => pool.get("webkit"), /npx playwright install webkit/);
  assert.deepEqual(pw.calls, []);
}
// 8. 設定值驗證
assert.throws(() => new BrowserPool(fakePw({}), { browser: "Chrome" }), /browser 只能是 auto、chrome、bundled、msedge/);
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tqa-browser-"));
  try {
    const base = { sites: { after: { url: "https://a.example" } }, profiles: { p: { width: 800, height: 600 } }, cases: [] };
    const write = (extra) => {
      const f = path.join(dir, "c.json");
      fs.writeFileSync(f, JSON.stringify({ ...base, ...extra }));
      return f;
    };
    assert.equal(loadConfig(write({})).browser, "auto");
    for (const v of ["auto", "chrome", "bundled", "msedge"]) assert.equal(loadConfig(write({ browser: v })).browser, v);
    for (const v of ["chromium", "Chrome", "", 1, null]) {
      assert.throws(() => loadConfig(write({ browser: v })), (e) => /設定檔有問題/.test(e.message) && /"auto"、"chrome"、"bundled"、"msedge"/.test(e.message), String(v));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// 9. 報告的工具行
{
  const t = { scriptHash: "abc", playwright: "1.64.1", browsers: { chromium: "bundled-chromium 131.0" }, browserFellBack: true, platform: "linux", arch: "x64", configSnapshot: "c.json" };
  const line = toolLine(t);
  assert.match(line, /Playwright 1\.64\.1/);
  assert.match(line, /bundled-chromium 131\.0（找不到 Google Chrome，改用 Playwright 內建的 Chromium）/);
  assert.match(line, /系統 linux x64/);
}
// 10. shots 比對基準時核對瀏覽器（只警告）
{
  const T = (v, extra = {}) => ({ browsers: { chromium: v, ...extra } });
  assert.equal(browserDiffText(T("chrome 131.0.1"), T("chrome 131.0.9")), null, "同通道同主版本");
  assert.match(browserDiffText(T("chrome 131.0.1"), T("bundled-chromium 131.0.1")), /^執行環境不同（基準：chrome 131\.0\.1，本次：bundled-chromium 131\.0\.1），差異可能來自瀏覽器$/);
  assert.match(browserDiffText(T("chrome 130.0.1"), T("chrome 131.0.1")), /執行環境不同/);
  assert.match(browserDiffText(undefined, T("chrome 131.0.1")), /無法核對/);
  assert.match(browserDiffText({}, T("chrome 131.0.1")), /無法核對/);
  assert.match(browserDiffText({ browsers: {} }, T("chrome 131.0.1")), /無法核對/);
  assert.match(browserDiffText(T("131.0.6778.86"), T("chrome 131.0.1")), /無法核對/, "舊格式沒有通道");
  assert.equal(browserDiffText(T("chrome 131.0.1"), { browsers: { webkit: "18.0" } }), null, "基準沒用到的引擎不比");
  assert.match(browserDiffText(T("chrome 131.0.1", { webkit: "17.4" }), T("chrome 131.0.1", { webkit: "18.0" })), /執行環境不同/);
}
console.log("browser-pool.test 通過");
