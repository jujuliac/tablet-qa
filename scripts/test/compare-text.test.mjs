// 對比圖固定字：zh-Hant 逐字等於舊格式；en 不含 CJK 與全形標點
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.mjs";
import { blockName, compareLabels, baselinePrefix, compareTitle, compareFooter, compareWarn, fontFor, FONT } from "../lib/context.mjs";

const CJK = /[　-〿＀-￯一-鿿]/;
const base = { id: "card-grid", note: "card-grid product cards stack", profile: "ipad102-portrait", vw: 810, vh: 1080, block: "product cards", hOld: 2172, hNew: 340, taller: false };

// ---- zh-Hant：與改動前逐字相同 ----
{
  const L = compareLabels("zh-Hant");
  assert.deepEqual(L, { before: "修改前", after: "修改後" });
  assert.equal(compareTitle("zh-Hant", L.before, "", "PR #12 預覽"), "修改前：PR #12 預覽");
  assert.equal(compareTitle("zh-Hant", L.before, "基準 r1 的 ", "舊站"), "修改前：基準 r1 的 舊站");
  assert.equal(baselinePrefix("zh-Hant", "r1"), "基準 r1 的 ");
  assert.equal(compareFooter("zh-Hant", { ...base, labels: L }), "card-grid product cards stack｜ipad102-portrait 810×1080｜框：product cards（修改前高 2172 px → 修改後高 340 px）");
  assert.equal(compareFooter("zh-Hant", { ...base, taller: true, labels: L }), "card-grid product cards stack｜ipad102-portrait 810×1080｜框：product cards（修改前高 2172 px → 修改後高 340 px）；區塊比一屏高，只拍到開頭那屏");
  assert.equal(compareWarn("zh-Hant", { diffs: ["路徑 a → b", "touch 不同"], envWarn: "執行環境不同（基準：A，本次：B），差異可能來自瀏覽器", incomplete: true }),
    "基準條件不同：路徑 a → b；touch 不同；執行環境不同（基準：A，本次：B），差異可能來自瀏覽器；證據不完整的圖不能拿來判斷");
  assert.equal(compareWarn("zh-Hant", {}), "");
  assert.equal(blockName(undefined), "區塊");
  assert.equal(blockName({ target: { css: "section.x" } }), "section.x區塊");
  assert.equal(blockName({ label: "卡片" }), "卡片");
  assert.equal(fontFor("zh-Hant"), FONT);
}

// ---- en：不含 CJK 與全形標點 ----
{
  const L = compareLabels("en");
  assert.deepEqual(L, { before: "Before", after: "After" });
  const foot = compareFooter("en", { ...base, labels: L });
  assert.equal(foot, "card-grid product cards stack | ipad102-portrait 810×1080 | Frame: product cards (Before height 2172 px → After height 340 px)");
  const footT = compareFooter("en", { ...base, taller: true, labels: L });
  assert.ok(footT.endsWith("; block extends below the viewport, only the visible part is shown"));
  assert.equal(compareTitle("en", L.before, "", "PR 12 preview"), "Before: PR 12 preview");
  assert.equal(compareTitle("en", L.before, "Baseline r1: ", "main"), "Before: Baseline r1: main");
  // label 空：不留懸空冒號
  assert.equal(compareTitle("en", L.before, "", ""), "Before");
  assert.equal(compareTitle("en", L.before, "", undefined), "Before");
  assert.equal(compareTitle("en", L.before, baselinePrefix("en", "r1"), ""), "Before: Baseline r1");
  assert.equal(compareTitle("zh-Hant", "修改前", "", ""), "修改前");
  // 高度缺值
  const nf = compareFooter("en", { ...base, hOld: undefined, hNew: undefined, labels: L });
  assert.ok(nf.includes("Before height ? px → After height ? px") && !nf.includes("undefined"));
  assert.ok(!compareFooter("zh-Hant", { ...base, hOld: undefined, labels: compareLabels("zh-Hant") }).includes("undefined"));
  // note 空：不多空白
  assert.ok(compareFooter("en", { ...base, note: "", labels: L }).startsWith("card-grid | ipad102"));
  assert.ok(compareFooter("en", { ...base, note: "card-grid", labels: L }).startsWith("card-grid | ipad102"));
  // block fallback
  assert.equal(blockName(undefined, "en"), "block");
  assert.equal(blockName({ target: {} }, "en"), "block");
  assert.equal(blockName({ target: { css: "section.x" } }, "en"), "section.x");
  assert.equal(blockName({ target: { name: "Cards" } }, "en"), "Cards");
  assert.equal(blockName({ label: "Product cards" }, "en"), "Product cards");
  // 警告三種與組合
  const det = " (details in shots-report.md)";
  assert.equal(compareWarn("en", { diffs: ["路徑 a → b"] }), "Baseline conditions differ" + det);
  assert.equal(compareWarn("en", { envWarn: "執行環境不同" }), "Test environment differs" + det);
  assert.equal(compareWarn("en", { incomplete: true }), "Incomplete evidence: do not use for judgment" + det);
  assert.equal(compareWarn("en", { diffs: ["x"], envWarn: "y", incomplete: true }), "Baseline conditions differ; Test environment differs; Incomplete evidence: do not use for judgment" + det);
  assert.equal(compareWarn("en", { diffs: [] }), "");
  // 全部輸出（輸入皆英文）不含 CJK／全形標點
  for (const t of [foot, footT, nf, compareWarn("en", { diffs: ["中文原句"], envWarn: "中文", incomplete: true }), compareTitle("en", L.before, "Baseline r1: ", ""), baselinePrefix("en", "r1")]) assert.ok(!CJK.test(t), t);
  assert.ok(fontFor("en").startsWith("-apple-system") && fontFor("en").includes("PingFang TC"));
}

// ---- compareLabels 單側覆寫（逐鍵優先、空字串回退預設）----
assert.deepEqual(compareLabels("en", { before: "Old" }), { before: "Old", after: "After" });
assert.deepEqual(compareLabels("en", { after: "PR 12" }), { before: "Before", after: "PR 12" });
assert.deepEqual(compareLabels("zh-Hant", { before: "舊" }), { before: "舊", after: "修改後" });
assert.deepEqual(compareLabels("en", { before: "", after: "" }), { before: "Before", after: "After" });
{
  const L = compareLabels("en", { before: "Old" });
  assert.ok(compareFooter("en", { ...base, labels: L }).includes("Old height 2172 px → After height 340 px"));
}
// ---- loadConfig 驗證 compareLang ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tqa-clang-"));
  try {
    const base = { sites: { after: { url: "https://a.example" } }, profiles: { p: { width: 800, height: 600 } }, cases: [] };
    const write = (extra) => {
      const f = path.join(dir, "c.json");
      fs.writeFileSync(f, JSON.stringify({ ...base, ...extra }));
      return f;
    };
    assert.equal(loadConfig(write({})).compareLang, undefined);
    for (const v of ["zh-Hant", "en"]) assert.equal(loadConfig(write({ compareLang: v })).compareLang, v);
    for (const v of ["zh", "zh-TW", "EN", "", null, 1]) assert.throws(() => loadConfig(write({ compareLang: v })), (e) => /設定檔有問題/.test(e.message) && /"zh-Hant"、"en"/.test(e.message), String(v));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log("compare-text ok");
