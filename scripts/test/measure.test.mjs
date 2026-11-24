// 用法：node test/measure.test.mjs [設定檔]   （用合成頁面測 sweep 的量測與分類，不連網）
// 有傳設定檔：照設定檔的 playwrightFrom 和 browser 找 Playwright、選瀏覽器（設定檔有問題就報錯）。
// 沒傳：從目前資料夾往上、skill 根目錄往上找 Playwright（只有這支測試會往 skill 根目錄找），瀏覽器用 auto。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { loadConfig, loadPlaywright, findPlaywright } from "../lib/config.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { classify, parseChecks, ALL_CHECKS, demoteReappeared } from "../lib/group.mjs";
import { describeCandidates } from "../lib/browser.mjs";

// parseChecks
assert.deepEqual(parseChecks(undefined), ALL_CHECKS);
assert.deepEqual(parseChecks("regression"), ["overflow", "clipped", "scrollbox", "tap", "invisible", "fixedCover"]);
assert.deepEqual(parseChecks("tap,lineJump"), ["tap", "lineJump"]);
assert.deepEqual(parseChecks("regression,sizeJump").slice(-1), ["sizeJump"]);
assert.throws(() => parseChecks("tap,foo"), /沒有「foo」/);
assert.throws(() => parseChecks(true));

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../sweep.mjs"), "utf8");
const a = src.indexOf("function measurePage(a)");
const b = src.indexOf("// 把頁面回傳的 findings");
const fnSrc = src.slice(a, b);

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
let pool;
if (process.argv[2]) {
  // 有傳設定檔就照舊：設定檔錯、找不到 Playwright 都要報錯，不能當成沒傳
  let cfg, pw;
  try {
    cfg = loadConfig(process.argv[2]);
    pw = await loadPlaywright(cfg);
  } catch (e) {
    fail(e.message);
  }
  pool = new BrowserPool(pw, { browser: cfg.browser, playwrightPath: cfg.playwrightPath });
} else {
  let found;
  try {
    found = findPlaywright({ startDirs: [process.cwd(), path.resolve(here, "../..")] });
  } catch (e) {
    fail(
      "這支測試需要 Playwright，但找不到。\n" +
        `請在有裝 Playwright 的網站專案資料夾執行：node "${path.resolve(here, "measure.test.mjs")}"\n` +
        "或傳設定檔：node <這支測試的路徑> <設定檔.json>（會用設定檔的 playwrightFrom）。" +
        (e.tried?.length ? `\n試過：${e.tried.join(", ")}` : "")
    );
  }
  pool = new BrowserPool(found.playwright, { playwrightPath: found.packagePath });
}
let browser;
try {
  browser = await pool.get("chromium");
} catch (e) {
  fail(e.message);
}
const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
const page = await ctx.newPage();
const HTML = `<!doctype html><base href="http://example.test/"><body style="margin:0">
<div id="sb" style="height:100px;width:300px;overflow-y:auto"><div style="height:300px">內捲區文字</div></div>
<div id="sb2" style="height:100px;width:300px;overflow-y:auto"><div style="height:105px">差不多高</div></div>
<div role="dialog" style="height:100px;width:300px;overflow-y:auto"><div style="height:300px">彈窗內捲</div></div>
<div style="position:relative;width:200px;height:50px"><div style="position:absolute;inset:0;opacity:1">Alpha</div><div style="position:absolute;inset:0;opacity:0">Beta</div></div>
<div style="opacity:0;width:100px;height:20px">Gamma</div>
<div style="opacity:0;pointer-events:none;width:100px;height:20px">Delta</div>
<div style="opacity:0.5;width:200px"><div style="opacity:0;width:100px;height:20px">Epsilon</div></div>
<div style="opacity:0.04;width:100px;height:20px">Zeta</div>
<div id="card" style="position:relative;width:300px;height:200px;margin-top:20px"><a href="/x" style="position:absolute;inset:0;z-index:1;display:block" aria-label="cover"></a><a href="/x#h" style="position:absolute;top:90px;left:100px;font-size:12px;display:inline-block;width:60px;height:16px">了解更多</a></div>
<div id="card2" style="position:relative;width:300px;height:200px;margin-top:20px"><a href="/y" style="position:absolute;inset:0;z-index:1;display:block" aria-label="cover2"></a><a href="/z" style="position:absolute;top:90px;left:100px;font-size:12px;display:inline-block;width:60px;height:16px">不同連結</a></div>
<div id="card3" style="position:relative;width:300px;height:200px;margin-top:20px"><a href="/x" target="_blank" style="position:absolute;inset:0;z-index:1;display:block" aria-label="cover3"></a><a href="/x" style="position:absolute;top:90px;left:100px;font-size:12px;display:inline-block;width:60px;height:16px">不同 target</a></div>
</body>`;
await page.setContent(HTML);
await page.evaluate(() => { window.__fn = null; });
const run = (checks) => page.evaluate(`(${fnSrc})`.replace(/^\(/, "(") + "", {}).catch(() => null);
const measure = async (checks) => page.evaluate(new Function("a", `return (${fnSrc})(a);`), { width: 800, minTap: 44, doJump: false, doTap: checks.includes("tap"), cssList: [], checks });
const all = await measure(ALL_CHECKS);
const f = (list, pred) => list.filter(pred);

// 內捲區
const sbs = all.out.scrollbox;
assert.equal(sbs.length, 1, "內捲區只抓一個（#sb）：" + JSON.stringify(sbs.map((x) => x.selector)));
assert.equal(sbs[0].value.scrollHeight, 300);
assert.equal(classify({ check: "scrollbox", ...sbs[0] }, "p", [], false).cls, "review");
assert.ok(!all.out.clipped.some((x) => x.selector.includes("sb") && x.text.includes("內捲區文字")), "內捲區不重複列成刻意");
const sb2 = all.out.clipped.find((x) => x.text.includes("差不多高"));
assert.ok(sb2 && sb2.note, "只高 5% 的捲動框仍是刻意");
assert.ok(!all.out.scrollbox.some((x) => x.text.includes("彈窗內捲")) && all.out.clipped.some((x) => x.text.includes("彈窗內捲") && x.note), "彈窗內的歸刻意");

// 切換堆疊／pointer-events
const inv = Object.fromEntries(all.out.invisible.map((x) => [x.text, x]));
assert.equal(inv.Beta?.stackedToggle, true);
assert.equal(classify({ check: "invisible", ...inv.Beta }, "p", [], false).cls, "stack");
assert.ok(!inv.Gamma.stackedToggle && !inv.Gamma.pointerNone);
assert.equal(classify({ check: "invisible", ...inv.Gamma }, "p", [], false).cls, "review");
assert.equal(inv.Delta?.pointerNone, true);
assert.equal(classify({ check: "invisible", ...inv.Delta }, "p", [], false).cls, "intentional");

// 進場動畫時間差：祖先 opacity 0.05–0.99（淡入進行中）→ timing；沒有這種祖先的純 opacity 0 仍是 review
assert.equal(inv.Epsilon?.fadingIn, true, "祖先 opacity 0.5 要標 fadingIn：" + JSON.stringify(inv.Epsilon));
assert.equal(classify({ check: "invisible", ...inv.Epsilon }, "p", [], false).cls, "timing");
assert.ok(!inv.Gamma.fadingIn && !inv.Beta.fadingIn && !inv.Delta.fadingIn, "沒有淡入中祖先的不標");
assert.ok(!inv.Zeta, "opacity 0.04 的元素本身不是 <0.01 也不是祖先淡入範圍，不列");
assert.equal(classify({ check: "invisible", ...inv.Epsilon }, "p", [], true).cls, "reference", "手機版仍優先歸參考");
// 取證重測時已看得見 → 同元素所有寬度的 review 線索改 timing，主清單拿掉
{
  const mk = (sel, w) => ({ check: "invisible", selector: sel, text: "T", cls: "review", width: w });
  const recs = [{ findings: [mk("a", 800), mk("b", 800)] }, { findings: [mk("a", 1024)] }];
  const groups = [
    { check: "invisible", reappeared: true, members: [{ selector: "a", text: "T" }] },
    { check: "invisible", reappeared: false, members: [{ selector: "b", text: "T" }] },
    { check: "tap", reappeared: true, members: [{ selector: "a", text: "T" }] },
  ];
  const d = demoteReappeared(groups, recs);
  assert.equal(d.moved, 2);
  assert.equal(d.demoted.length, 1);
  assert.equal(d.kept.length, 2);
  assert.deepEqual(recs.flatMap((r) => r.findings).map((f) => f.cls), ["timing", "review", "timing"]);
}

// 同 href 覆蓋
const taps = Object.fromEntries(all.out.tap.map((x) => [x.text || x.selector, x]));
const t1 = taps["了解更多"];
assert.ok(t1 && t1.sameHrefCover === true, "同 href 覆蓋要標 sameHrefCover：" + JSON.stringify(t1));
assert.equal(classify({ check: "tap", ...t1 }, "p", [], false).cls, "intentional");
const t2 = taps["不同連結"];
assert.ok(t2 && !t2.sameHrefCover && t2.note, "不同 href 不算：" + JSON.stringify(t2));
assert.equal(classify({ check: "tap", ...t2 }, "p", [], false).cls, "review");
const t3 = taps["不同 target"];
assert.ok(t3 && !t3.sameHrefCover, "target 不同不算");

// --checks 子集
const sub = await measure(parseChecks("tap"));
assert.equal(sub.out.scrollbox.length + sub.out.clipped.length + sub.out.invisible.length + sub.out.overflow.length, 0);
assert.ok(sub.out.tap.length > 0);
const sub2 = await measure(parseChecks("scrollbox"));
assert.equal(sub2.out.scrollbox.length, 1);
assert.equal(sub2.out.clipped.length, 0);
assert.equal(sub2.out.tap.length, 0);

// 找不到元素時列候選
await page.setContent(`<body><button>送出表單</button><button aria-label="取消訂單">x</button><button style="display:none">隱藏的</button><p>活動日曆焦點</p></body>`);
{
  const c1 = await describeCandidates(page, { role: "button", name: "送出表單x" }, "after");
  assert.ok(c1.includes("「送出表單」") && c1.includes("「取消訂單」") && !c1.includes("隱藏的"), c1);
  const c2 = await describeCandidates(page, { text: "活動日曆月曆" }, "after");
  assert.ok(c2.includes("活動日曆焦點"), c2);
  const c3 = await describeCandidates(page, { css: ".nope" }, "after");
  assert.ok(c3.includes("css 找不到"), c3);
  const c4 = await describeCandidates(page, { css: "button[style]" }, "after");
  assert.ok(c4.includes("有 1 個符合但目前看不見"), c4);
}

await ctx.close();
await pool.close();
console.log("量測與分類測試通過");
