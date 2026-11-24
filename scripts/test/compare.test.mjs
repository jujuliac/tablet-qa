// 用法：node test/compare.test.mjs [<含 before、after 的 sweep run 資料夾> [target=after] [base=before]]
// 沒給資料夾只跑合成測試；給了再用真實資料跑一次逐寬度比對
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { buildBaseline, compareGroups, compareConditions, elKey, parseCompareSpec, pickCompareSite, noBaselineReason, summarize } from "../lib/compare.mjs";
import { groupReview } from "../lib/group.mjs";

// ---------- 小函式 ----------
assert.equal(elKey({ selector: "ul > li:nth-of-type(3) > a:nth-child(2)", text: "x".repeat(40) }), "ul > li > a\u0001" + "x".repeat(10));
assert.deepEqual(parseCompareSpec("a-b:before"), { run: "a-b", site: "before" });
assert.deepEqual(parseCompareSpec("a-b"), { run: "a-b", site: null });
assert.equal(pickCompareSite(["before", "after"], null, "after"), "after");
assert.equal(pickCompareSite(["before"], null, "after"), "before");

// ---------- 合成資料 ----------
let idx = 0;
const rec = (page, width, status, findings = [], extra = {}) => ({ page, site: "x", width, kind: "profile", profile: "p" + width, height: 1000, idx: idx++, status, error: status === "fail" ? "HTTP 500" : null, path: "/" + page, findings, ...extra });
const F = (check, selector, text, value = {}, cls = "review") => ({ check, selector, text, value, rect: { x: 0, y: 0, width: 1, height: 1 }, cls });
const tap = (sel, text, hit) => F("tap", sel, text, { hitW: hit, hitH: hit });
const clip = (sel, text, over, cls = "review") => F("clipped", sel, text, { scrollWidth: 100 + over, clientWidth: 100, scrollHeight: 50, clientHeight: 50 }, cls);
const fix = (ratio) => F("fixedCover", "header.fixed", "", { ratio, height: 100, viewportHeight: 1000 });
// 跑一次：舊紀錄 → 新紀錄
function run(oldRecs, newRecs) {
  const base = buildBaseline(oldRecs, { against: "old" });
  const groups = groupReview(newRecs, 44);
  const cmp = compareGroups(groups, base, newRecs);
  const st = (sel) => groups.find((g) => g.selector === sel)?.cmp;
  return { cmp, groups, base, st };
}

// 1. 基本：same／new；選擇器的 nth 不影響
{
  const r = run(
    [rec("p1", 800, "ok", [clip("a:nth-of-type(1)", "標題文字很長很長", 20)])],
    [rec("p1", 800, "ok", [clip("a:nth-of-type(2)", "標題文字很長很長", 20), clip("b", "另一個", 30)])]
  );
  assert.equal(r.st("a:nth-of-type(2)"), "same");
  assert.equal(r.st("b"), "new");
  assert.equal(r.cmp.noBaselineCells.length, 0);
}
// 2. 新寬度才出現：舊版本沒量 1024 → 這格 noBaseline；沒有線索也要列在缺口裡（覆蓋缺口不從線索推）
{
  const r = run([rec("p1", 800, "ok", [])], [rec("p1", 800, "ok", []), rec("p1", 1024, "ok", [])]);
  assert.deepEqual(r.cmp.noBaselineCells, [{ page: "p1", width: 1024, reason: "舊版本沒量這個寬度" }]);
  assert.deepEqual(r.cmp.noBaselinePages.get("p1").widths, [1024]);
}
// 3. 新寬度才出現的線索 → noBaseline，不是 new
{
  const r = run([rec("p1", 800, "ok", [])], [rec("p1", 800, "ok", []), rec("p1", 1024, "ok", [clip("c", "x", 50)])]);
  assert.equal(r.st("c"), "noBaseline");
  assert.equal(r.cmp.noBaselineGroups.length, 1);
}
// 4. 同鍵變差：tap 小 ≥4px 才算；clipped 多 ≥8px；fixedCover 多 ≥5 個百分點；其他檢查不判惡化
{
  const r = run(
    [rec("p1", 800, "ok", [tap("t1", "a", 40), tap("t2", "b", 40), clip("c1", "x", 10), clip("c2", "y", 10), fix(0.2)])],
    [rec("p1", 800, "ok", [tap("t1", "a", 36), tap("t2", "b", 37), clip("c1", "x", 18), clip("c2", "y", 17), fix(0.26)])]
  );
  assert.equal(r.st("t1"), "worse"); // 40 → 36，小 4
  assert.equal(r.st("t2"), "same"); // 40 → 37，小 3
  assert.equal(r.st("c1"), "worse"); // 10 → 18，多 8
  assert.equal(r.st("c2"), "same"); // 多 7
  assert.equal(r.st("header.fixed"), "worse"); // 0.2 → 0.26
  assert.equal(r.cmp.worseGroups.length, 3);
  const w = r.groups.find((g) => g.selector === "t1").cmpDetail[0];
  assert.deepEqual([w.page, w.width, w.from, w.to], ["p1", 800, -40, -36]);
  const ov = (n) => F("overflow", "html", "", { scrollWidth: n, viewport: 800, right: n });
  const o = run([rec("p1", 800, "ok", [ov(900)])], [rec("p1", 800, "ok", [ov(1200)])]);
  assert.equal(o.st("html"), "same"); // overflow 不判惡化
}
// 5. 混合覆蓋：一組跨兩個寬度，一個舊版本有量且原本就有、一個舊版本沒量 → same；一個新一個沒對照 → new
{
  const r = run(
    [rec("p1", 800, "ok", [clip("m", "x", 20)])],
    [rec("p1", 800, "ok", [clip("m", "x", 20), clip("n", "y", 20)]), rec("p1", 1024, "ok", [clip("m", "x", 20), clip("n", "y", 20)])]
  );
  assert.equal(r.st("m"), "same");
  assert.equal(r.st("n"), "new");
  assert.deepEqual(r.groups.find((g) => g.selector === "n").pageStatus[0].byWidth, { new: [800], noBaseline: [1024] });
}
// 6. 文案改了：同 selector、同檢查、同寬度，text 前 10 字不同 → textChanged，不算新出現
{
  const r = run(
    [rec("p1", 800, "ok", [clip("h2.title", "舊的標題文字在這裡", 20)])],
    [rec("p1", 800, "ok", [clip("h2.title", "新的標題文字在這裡", 20)])]
  );
  assert.equal(r.st("h2.title"), "textChanged");
  assert.equal(r.cmp.newGroups.length, 0);
  assert.equal(r.cmp.textChangedGroups.length, 1);
  assert.equal(r.cmp.betterCount, 0);
}
// 6b. 文案改了但數量變多：配不上的那條仍是 new；舊有新無的算 better
{
  const r = run(
    [rec("p1", 800, "ok", [clip("li.item", "AAAAAAAAAA1", 20), clip("li.gone", "ZZZZZZZZZZ", 20)])],
    [rec("p1", 800, "ok", [clip("li.item", "BBBBBBBBBB1", 20), clip("li.item", "CCCCCCCCCC1", 20)])]
  );
  const items = r.groups.filter((g) => g.selector === "li.item").map((g) => g.cmp).sort();
  assert.deepEqual(items, ["new", "textChanged"]);
  assert.equal(r.cmp.betterCount, 1); // li.gone 舊有新無
}
// 7. 舊 run 那格失敗：noBaseline（不論有沒有線索），列在缺口；證據不完整也算（只有 ok 才能當對照）
{
  const r = run(
    [rec("p1", 800, "fail", []), rec("p1", 1024, "incomplete", [clip("k", "x", 20)]), rec("p1", 1180, "ok", [])],
    [rec("p1", 800, "ok", []), rec("p1", 1024, "ok", [clip("k", "x", 20)]), rec("p1", 1180, "ok", [])]
  );
  assert.deepEqual(r.cmp.noBaselineCells.map((c) => `${c.width}:${c.reason}`).sort(), ["1024:舊版本這格證據不完整", "800:舊版本這格打不開或量測失敗（HTTP 500）"]);
  assert.equal(r.st("k"), "noBaseline");
  assert.equal(noBaselineReason(r.base, "zz", 800), "舊版本沒量這一頁");
}
// 8. 本次自己失敗的格子不重複列進缺口
{
  const r = run([rec("p1", 800, "ok", [])], [rec("p1", 800, "ok", []), rec("p1", 1024, "fail", [])]);
  assert.equal(r.cmp.noBaselineCells.length, 0);
}
// 9. 只算 review：舊版本把同一條歸成 intentional → 本次 review 時算新出現
{
  const r = run([rec("p1", 800, "ok", [clip("q", "x", 20, "intentional")])], [rec("p1", 800, "ok", [clip("q", "x", 20)])]);
  assert.equal(r.st("q"), "new");
}
// 10. 條件相容性
{
  const base = { tool: { playwright: "1.6", browsers: { chromium: "1" }, scriptHash: "aaa" }, tabletMin: 744, minTap: 44, paths: new Map([["p1", "/a"]]) };
  assert.deepEqual(compareConditions(base, { tool: base.tool, tabletMin: 744, minTap: 44, paths: new Map([["p1", "/a"]]) }), []);
  const c = compareConditions(base, { tool: { playwright: "1.7", browsers: { chromium: "1" }, scriptHash: "aaa" }, tabletMin: 768, minTap: 40, paths: new Map([["p1", "/b"]]) });
  assert.deepEqual(c.map((x) => x.kind), ["tool", "tabletMin", "minTap", "path"]);
}
// 11. summarize
{
  const r = run([rec("p1", 800, "ok", [])], [rec("p1", 800, "ok", [clip("a", "x", 20)])]);
  const s = summarize(r.cmp, r.base);
  assert.equal(s.newCount, 1);
  assert.equal(s.worseCount, 0);
}
// 12. 本次沒跑的檢查不算「舊有新無」
{
  const oldRecs = [rec("p1", 800, "ok", [clip("a", "x", 20), tap("t", "y", 30)])];
  const newRecs = [rec("p1", 800, "ok", [])];
  const base = buildBaseline(oldRecs);
  assert.equal(compareGroups([], base, newRecs).betterCount, 2);
  assert.equal(compareGroups([], base, newRecs, { checks: ["clipped"] }).betterCount, 1);
}
console.log("單元測試通過（合成 13 組情境）");

// ---------- 真實資料（可選）----------
const dir = process.argv[2];
if (dir) {
  const target = process.argv[3] || "after", from = process.argv[4] || "before";
  const rj = JSON.parse(fs.readFileSync(path.join(dir, "sweep-results.json")));
  const all = [];
  for (const rel of Object.values(rj.files)) all.push(...JSON.parse(fs.readFileSync(path.join(dir, rel))).records);
  const oldRecs = all.filter((r) => r.site === from), newRecs = all.filter((r) => r.site === target);
  const base = buildBaseline(oldRecs, { against: `${path.basename(dir)}:${from}`, tool: rj.tool, tabletMin: rj.tabletMin, minTap: rj.minTap });
  const groups = groupReview(newRecs, rj.minTap);
  const r = compareGroups(groups, base, newRecs);
  console.log(`${target} 對 ${from}：需要看 ${groups.length} 組 → 新出現 ${r.newGroups.length}、變差 ${r.worseGroups.length}、只有文字變了 ${r.textChangedGroups.length}、原本就有 ${r.sameGroups.length}、沒有對照 ${r.noBaselineGroups.length}；舊有新無 ${r.betterCount} 條`);
  console.log(`沒有對照的（頁、寬度）格子：${r.noBaselineCells.length}／${r.cellStats.cells}`);
  console.log("沒有對照的頁：", [...r.noBaselinePages].map(([p, e]) => `${p}（${e.widths.join("、")}：${[...e.reasons].join("／")}）`).join("；") || "無");
  const by = {};
  for (const x of r.newGroups) for (const p of x.pageStatus) if (p.status === "new") by[p.page] = (by[p.page] || 0) + 1;
  console.log("新出現（組×頁）按頁：", JSON.stringify(by));
  for (const g of r.worseGroups.slice(0, 5)) console.log("變差：", g.id ?? g.selector, g.cmpDetail.map((d) => `${d.page} ${d.width}px ${d.text}`).join("；"));
}
