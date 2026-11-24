// 用法：node test/imgdiff.test.mjs [<outDir> <基準 run> <對照 run>]
//  沒給參數：只跑合成測試。
//  給了：真實資料測試。<對照 run> 的 after 對 <基準 run> 的 after 算尺寸差；<基準 run> 的 before 對 after 算「前後幾乎相同」。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { encodePng, decodePng, compareImages, nearIdentical, sameUrlSites, regionsOf, readHeader } from "../lib/imgdiff.mjs";

const mk = (w, h, ch, fn) => {
  const data = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y);
    for (let c = 0; c < ch; c++) data[(y * w + x) * ch + c] = c === 3 ? 255 : v;
  }
  return encodePng({ w, h, ch, data });
};
for (const ch of [3, 4]) {
  const a = mk(100, 200, ch, () => 255);
  assert.deepEqual([readHeader(a).w, readHeader(a).h], [100, 200]);
  assert.equal(decodePng(a).data[0], 255);
  // 相同
  let d = compareImages(a, mk(100, 200, ch, () => 255));
  assert.equal(d.md5Same, true);
  assert.equal(d.ratio, 0);
  // 兩個方塊不同：10×10 在 (10,20)、20×5 在 (50,150) → 100+100 = 200 像素 / 20000 = 1%
  const b = mk(100, 200, ch, (x, y) => (x >= 10 && x < 20 && y >= 20 && y < 30) || (x >= 50 && x < 70 && y >= 150 && y < 155) ? 0 : 255);
  d = compareImages(a, b, { makeDiffImage: true });
  assert.equal(d.sizeChanged, false);
  assert.ok(Math.abs(d.ratio - 0.01) < 1e-9, "ratio " + d.ratio);
  assert.equal(d.regions.length, 2);
  assert.deepEqual(d.regions[0], { x: 10, y: 20, w: 10, h: 10 });
  assert.deepEqual(d.regions[1], { x: 50, y: 150, w: 20, h: 5 });
  assert.ok(decodePng(d.diffImage).w === 100, "差異圖可解碼");
  // 亮度差 ≤ 16 不算
  d = compareImages(a, mk(100, 200, ch, () => 245));
  assert.equal(d.ratio, 0);
  // 尺寸不同
  d = compareImages(a, mk(100, 260, ch, () => 255));
  assert.equal(d.sizeChanged, true);
  assert.deepEqual([d.from, d.to], [[100, 200], [100, 260]]);
}
// 超過 3 塊要併成 3 塊
{
  const rows = new Array(1000).fill(0), cols = new Array(1000).fill(null);
  for (const y of [10, 100, 200, 400, 800]) { rows[y] = 1; cols[y] = [y % 50, y % 50 + 5]; }
  const r = regionsOf(rows, cols);
  assert.equal(r.length, 3);
}
// 不支援的格式（調色盤 PNG）不當掉
{
  const bad = Buffer.from(mk(10, 10, 3, () => 0));
  const bad2 = Buffer.from(mk(10, 10, 3, (x) => (x === 3 ? 100 : 0)));
  bad[25] = 3; bad2[25] = 3; // 改色彩類型成 3
  const d = compareImages(bad, bad2);
  assert.equal(d.status, "unsupported");
  assert.equal(compareImages(Buffer.from("xx"), bad).status, "unsupported");
}
// 前後幾乎相同
{
  const same = { status: "ok", md5Same: true, sizeChanged: false, ratio: 0 };
  const near = { status: "ok", md5Same: false, sizeChanged: false, ratio: 0.0005 };
  const diff = { status: "ok", md5Same: false, sizeChanged: false, ratio: 0.2 };
  const sz = { status: "ok", md5Same: false, sizeChanged: true, ratio: null };
  assert.equal(nearIdentical([same, near, diff, sz]).warn, true); // 2/4 = 50%
  assert.equal(nearIdentical([same, diff, diff, sz]).warn, false);
  assert.equal(nearIdentical([]).warn, false);
}
// 基準網址相同
{
  const r = sameUrlSites({ before: { url: "https://a.vercel.app/", label: "x" }, after: { url: "https://b.vercel.app" } }, { after: { url: "https://a.vercel.app" } });
  assert.deepEqual(r.map((x) => x.baselineSite), ["before"]);
  assert.equal(sameUrlSites({ after: { url: "https://b" } }, { after: { url: "https://a" } }).length, 0);
}
console.log("合成測試通過");

const [outDir, baseRun, cmpRun] = process.argv.slice(2);
if (outDir) {
  const load = (run) => JSON.parse(fs.readFileSync(path.join(outDir, run, "shots-results.json"), "utf8")).results;
  const rd = (run, f) => fs.readFileSync(path.join(outDir, run, f));
  const baseR = load(baseRun), cmpR = load(cmpRun);
  const key = (r) => `${r.id}|${r.profile.name}`;
  const res = [];
  for (const r of cmpR.filter((x) => x.site === "after" && x.file)) {
    const b = baseR.find((x) => x.site === "after" && key(x) === key(r) && x.file);
    if (!b) continue;
    res.push({ id: key(r), d: compareImages(rd(baseRun, b.file), rd(cmpRun, r.file)) });
  }
  const sz = res.filter((x) => x.d.sizeChanged);
  console.log(`[${cmpRun} after 對 ${baseRun} after] 共 ${res.length} 對，尺寸不同 ${sz.length} 對：`);
  for (const x of sz) console.log(`  ${x.id}：${x.d.from.join("×")} → ${x.d.to.join("×")}`);
  console.log(`  無法比對 ${res.filter((x) => x.d.status !== "ok").length} 對`);
  const pairs = [];
  for (const r of baseR.filter((x) => x.site === "after" && x.file)) {
    const b = baseR.find((x) => x.site === "before" && key(x) === key(r) && x.file);
    if (b) pairs.push(compareImages(rd(baseRun, b.file), rd(baseRun, r.file)));
  }
  const ni = nearIdentical(pairs);
  console.log(`[${baseRun} before 對 after] 共 ${pairs.length} 對：md5 相同 ${ni.md5Same}、差異 <0.1% 或 md5 相同 ${ni.same}／${ni.total}，警告=${ni.warn}`);
}
