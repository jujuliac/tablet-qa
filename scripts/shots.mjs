#!/usr/bin/env node
// 對照截圖：node shots.mjs <設定檔> [案例 id ...] [--site=before|after|both] [--run=名稱] [--baseline=舊資料夾名] [--jobs=3] [--no-smoke]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, loadPlaywright, resolveProfiles, siteUrl, nowIso, parseArgs, csv, pickSites, makeRun, siteInfo, describeSite, toolInfo, toolLine, rerunCommand, checkFlags, inside, assertRunDone, logProgress, finishRun, notify, previousRunLines } from "./lib/config.mjs";
import {
  BrowserPool, checkEnv, openWithRetry, runSteps, capture, hideTargets, waitStable, rectReader, smokeCheck, findVisible, describeTarget, describeCandidates,
} from "./lib/browser.mjs";
import { browserDiffText } from "./lib/compare.mjs";
import { shootContext, composeCompare, blockName, urlLine, compareLabels, baselinePrefix, compareTitle, compareFooter, compareWarn } from "./lib/context.mjs";
import { compareImages, nearIdentical, sameUrlSites, sortDiffs } from "./lib/imgdiff.mjs";

const { positional, opt } = parseArgs(process.argv.slice(2));
const [configFile, ...posIds] = positional;
const ids = [...posIds, ...csv(opt.cases)];
const die = (m, code = 2) => {
  console.error(m);
  process.exit(code);
};
let cfg;
try {
  checkFlags(opt, ["site", "run", "baseline", "cases", "jobs", "no-smoke", "notify"]);
  cfg = loadConfig(configFile);
} catch (e) {
  die(e.message);
}
const pw = await loadPlaywright(cfg).catch((e) => die(e.message));

let cases = cfg.cases || [];
if (ids.length) {
  const missing = ids.filter((i) => !cases.some((c) => c.id === i));
  if (missing.length) die(`設定檔沒有這些案例：${missing.join(", ")}`);
  cases = cases.filter((c) => ids.includes(c.id));
}
if (!cases.length) die("沒有要跑的案例（設定檔 cases 是空的）");

// 沒指定 --site：設定檔有幾個網站就拍幾個（只有一個就只拍那個）
let sites;
try {
  sites = pickSites(cfg, opt.site);
} catch (e) {
  die(e.message);
}
let jobs = 3;
if (opt.jobs !== undefined) {
  jobs = Number(opt.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) die(`--jobs 要是 1–16 的整數，收到「${opt.jobs}」`);
}
const baselineName = typeof opt.baseline === "string" ? opt.baseline : null;
if (baselineName && typeof opt.run === "string" && opt.run === baselineName) die("--run 不能和 --baseline 同名，會把基準蓋掉");
if (baselineName && !fs.existsSync(path.join(cfg.outDir, baselineName))) die(`找不到基準資料夾：${path.join(cfg.outDir, baselineName)}`);
if (baselineName) {
  try {
    assertRunDone(path.join(cfg.outDir, baselineName), "shots");
  } catch (e) {
    die(e.message);
  }
}

// 輸出檔名：<案例 id>-<profile>-<site>.png（一律含 profile）。先檢查不撞名（不分大小寫）、不跑出資料夾
const fileOf = (c, profile, site) => `${c.id}-${profile.name}-${site}.png`;
{
  const seen = new Map();
  for (const c of cases)
    for (const p of resolveProfiles(cfg, c))
      for (const site of sites) {
        const f = fileOf(c, p, site);
        const k = f.toLowerCase();
        if (seen.has(k)) die(`輸出檔名重複：${f} 與 ${seen.get(k)}（案例 id 與 profile 名組合撞名）`);
        seen.set(k, f);
        try { inside(cfg.outDir, f); } catch (e) { die(e.message); }
      }
}
// 案例的拍攝條件雜湊：steps、capture、hide、motion、expectedStatus 任一改了就不同（condVersion 2）。
// require 另算（reqHash）：它只決定「證據齊不齊」，不影響截圖範圍，改了只寫「require 改過」，不算條件不同。
// 舊格式（沒有 condVersion）的雜湊把 require 也算進去，核對舊基準時用 legacyCondHash。
const sha = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 12);
const condBody = (c) => ({ steps: c.steps || [], capture: c.capture, hide: c.hide || [], motion: c.motion || "no-preference", expectedStatus: c.expectedStatus ?? null });
const condHash = (c) => sha(condBody(c));
const reqHash = (c) => sha(c.require || []);
const legacyCondHash = (c) => sha({ steps: c.steps || [], capture: c.capture, hide: c.hide || [], require: c.require || [], motion: c.motion || "no-preference", expectedStatus: c.expectedStatus ?? null });

// 基準：讀舊的 shots-results.json，後面逐項核對條件
let baseIdx = null;
let baseSites = null, baseTime = null, baseTool = null;
if (baselineName) {
  const bf = path.join(cfg.outDir, baselineName, "shots-results.json");
  if (fs.existsSync(bf)) {
    baseIdx = new Map();
    const bj = JSON.parse(fs.readFileSync(bf, "utf8"));
    baseSites = bj.sites || null;
    baseTime = bj.time || null;
    baseTool = bj.tool || null;
    for (const r of bj.results || []) baseIdx.set(`${r.id}|${r.profile?.name}|${r.site}`, r);
  } else console.warn(`基準資料夾沒有 shots-results.json，無法核對條件：${baselineName}`);
}
const pathOf = (r) => r.path ?? (() => { try { const u = new URL(r.url); return u.pathname + u.search; } catch { return ""; } })();
// 回傳 { rec, diffs: [...] }；找不到 rec 為 null
function baselineFor(c, rec, sn) {
  const b = baseIdx?.get(`${c.id}|${rec.profile.name}|${sn}`) || null;
  if (!b) return { rec: null, diffs: [], notes: [] };
  const diffs = [];
  if (pathOf(b) !== c.path) diffs.push(`路徑 ${pathOf(b)} → ${c.path}`);
  if (b.profile.width !== rec.profile.width || b.profile.height !== rec.profile.height) diffs.push(`尺寸 ${b.profile.width}×${b.profile.height} → ${rec.profile.width}×${rec.profile.height}`);
  if ((b.profile.engine || "chromium") !== rec.profile.engine) diffs.push(`引擎 ${b.profile.engine} → ${rec.profile.engine}`);
  if (!!b.profile.touch !== rec.profile.touch) diffs.push("touch 不同");
  if ((b.motion || "no-preference") !== rec.motion) diffs.push(`動態 ${b.motion} → ${rec.motion}`);
  const notes = [];
  if (!b.condHash) diffs.push("基準沒有設定雜湊，steps／capture 無法核對");
  else if (b.condVersion === 2) {
    if (b.condHash !== rec.condHash) diffs.push("steps／capture／hide／motion 改過");
    if (b.reqHash !== undefined && b.reqHash !== rec.reqHash) notes.push("require 改過（不影響截圖範圍）");
  } else if (b.condHash !== legacyCondHash(c)) diffs.push("steps／capture／hide／require 改過（基準是舊格式雜湊，require 也算在內，無法分開）");
  return { rec: b, diffs, notes };
}

const pool = new BrowserPool(pw, { browser: cfg.browser, playwrightPath: cfg.playwrightPath });
const t0 = Date.now();

if (!opt["no-smoke"]) {
  const first = cases[0];
  const profs = resolveProfiles(cfg, first);
  const firstTouch = profs.find((p) => p.touch);
  const sm = await smokeCheck(pool, [profs[0], ...(firstTouch && firstTouch !== profs[0] ? [firstTouch] : [])], siteUrl(cfg.sites[sites[0]].url, first.path), first.expectedStatus);
  if (!sm.ok) {
    await pool.close();
    die("起跑前檢查沒過，停止：" + sm.message, 3);
  }
  console.log("起跑前檢查通過（瀏覽器、第一個案例的頁面、觸控環境）");
}

const expectedCount = cases.reduce((n, c) => n + resolveProfiles(cfg, c).length * sites.length, 0);
let run;
try {
  run = makeRun(cfg, opt.run, sites, { tool: "shots", args: process.argv.slice(3), expected: expectedCount, notify: opt.notify });
} catch (e) {
  await pool.close();
  die(e.message);
}
const siteMeta = await siteInfo(cfg, sites);
fs.mkdirSync(path.join(run.dir, "ctx"), { recursive: true });
console.log(`本次資料夾：${run.dir}`);

const counts = { ok: 0, incomplete: 0, fail: 0 };

// 任務清單：案例 × profile × 網站，順序固定（依設定檔 case 順序）；並行只影響完成順序，不影響結果順序
const tasks = [];
for (const c of cases) for (const profile of resolveProfiles(cfg, c)) for (const site of sites) tasks.push({ c, profile, site });
const results = new Array(tasks.length);

async function runTask({ c, profile, site }) {
  const s = cfg.sites[site];
  const url = siteUrl(s.url, c.path);
  const file = fileOf(c, profile, site);
  const rec = {
    id: c.id, site, label: s.label || "", url, path: c.path, condVersion: 2, condHash: condHash(c), reqHash: reqHash(c), finalUrl: null, httpStatus: null,
    expectedStatus: c.expectedStatus ?? null, require: [],
    kind: c.kind || "visual", expect: c.expect || "", note: c.note || "",
    profile: { name: profile.name, width: profile.width, height: profile.height, touch: !!profile.touch,
      pointerCoarse: null, hoverNone: null, engine: profile.engine || "chromium" },
    motion: c.motion || "no-preference", status: "fail", file: null, rect: null,
    hidden: [], picked: null, notes: [], truncated: false, fallback: null, waits: [], warnings: [], error: null, time: nowIso(),
  };
  let ctx;
  try {
    const op = await openWithRetry(pool, profile, rec.motion, url, { expectedStatus: c.expectedStatus, networkIdleMs: s.networkIdleMs });
    ctx = op.context;
    const page = op.page;
    const prep = op.prep;
    rec.httpStatus = prep.status;
    rec.finalUrl = prep.finalUrl;
    rec.warnings.push(...prep.warnings);
    rec.notes.push(...prep.notes);
    if (prep.openError) throw new Error(prep.openError);

    const env = await checkEnv(page, profile);
    rec.profile.pointerCoarse = env.pointerCoarse;
    rec.profile.hoverNone = env.hoverNone;
    if (!env.ok) rec.warnings.push("觸控環境不成立（pointer: coarse / hover: none）");

    const st = await runSteps(page, c.steps, { site, touch: !!profile.touch });
    rec.waits = st.waits;

    // 操作後再等一次版面穩定（彈窗、展開）
    const cap = c.capture;
    const rf = cap.mode === "element" ? rectReader(page, cap.target, site) : null;
    if (!(await waitStable(page, rf))) rec.warnings.push("操作後版面 5 秒內沒穩定");

    // 要驗的東西有沒有出現：每個 require 都要看得見，否則這張圖證明不了任何事
    const missing = [];
    for (const t of c.require || []) {
      let rects = [];
      try {
        rects = await findVisible(page, t, site, 5000);
      } catch (e) {
        missing.push(`${describeTarget(t)}（${e.message.split("\n")[0]}）`);
        continue;
      }
      if (!rects.length) missing.push(`${describeTarget(t)}；${await describeCandidates(page, t, site)}`);
    }
    rec.require = (c.require || []).map(describeTarget);
    if (missing.length) rec.warnings.push(`要驗的東西沒出現：${missing.join("；")}`);

    rec.hidden = await hideTargets(page, c.hide || [], site, rec.warnings);
    const r = await capture(page, cap, { site, engine: rec.profile.engine });
    rec.warnings.push(...r.warnings);
    // require 的東西要真的在截圖範圍內（不只是頁面上有）
    for (const t of c.require || []) {
      try {
        const rects = await findVisible(page, t, site, 0);
        const R = r.rect;
        const hit = rects.some((q) => q.x < R.x + R.width && q.x + q.width > R.x && q.y < R.y + R.height && q.y + q.height > R.y);
        if (rects.length && !hit) rec.warnings.push(`要驗的東西在頁面上，但不在截圖範圍內：${describeTarget(t)}`);
      } catch {}
    }
    rec.rect = r.rect;
    rec.truncated = r.truncated;
    rec.fallback = r.fallback;
    rec.picked = [st.picked, r.picked].filter(Boolean).join(",") || null;
    if (r.truncated) rec.warnings.push("超過 4000px 已截斷");
    if (r.fallback) rec.warnings.push("page.screenshot 逾時，改用 CDP");
    rec.file = file;
    fs.writeFileSync(inside(run.dir, rec.file), r.buffer);
    // 情境截圖：元素捲到距視窗頂約 160px，拍整個視窗（只給前後對比圖用，不參與像素比對）
    try {
      const cx = await shootContext(page, cap, { site, dir: run.dir, file: `ctx/${c.id}-${profile.name}-${site}.png` });
      if (cx) rec.context = { ...cx, file: cx.sameAsMain ? rec.file : cx.file };
    } catch (e) {
      rec.notes.push(`情境截圖失敗（不影響狀態）：${e.message.split("\n")[0]}`);
    }
    rec.status = rec.warnings.length ? "incomplete" : "ok";
  } catch (e) {
    rec.status = "fail";
    rec.error = e.message.split("\n")[0];
  } finally {
    await ctx?.close().catch(() => {});
  }
  return rec;
}

let nextTask = 0;
async function worker() {
  while (nextTask < tasks.length) {
    const i = nextTask++;
    const { c, profile, site } = tasks[i];
    const rec = await runTask(tasks[i]);
    results[i] = rec;
    counts[rec.status]++;
    logProgress(run, { id: c.id, profile: profile.name, site, status: rec.status });
    const mark = { ok: "OK        ", incomplete: "INCOMPLETE", fail: "FAIL      " }[rec.status];
    const extra = rec.error ? ` — ${rec.error}` : rec.warnings.length ? ` — ${rec.warnings.length} 項 warnings：${rec.warnings[0]}` : ` ${rec.file}`;
    console.log(`${mark} ${c.id} ${site} (${profile.name} ${profile.width}×${profile.height})${extra}`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
const tool = toolInfo(cfg, run, pool);
const envWarn = baselineName && baseIdx ? browserDiffText(baseTool, tool) || "" : "";
if (envWarn) console.log(`\n**${envWarn}**`);
await composeAll();
await pool.close();

if (results.filter(Boolean).length !== expectedCount) {
  console.error(`紀錄數對不上：預計 ${expectedCount} 筆，實際 ${results.filter(Boolean).length} 筆。`);
  finishRun(run, "done", "fail", "紀錄數對不上");
  notify(run, { done: results.filter((r) => r?.status === "ok").length, incomplete: results.filter((r) => r?.status === "incomplete").length, fail: results.filter((r) => r?.status === "fail").length });
  process.exit(1);
}
const diffInfo = computeDiffs();
fs.writeFileSync(path.join(run.dir, "shots-results.json"), JSON.stringify({ run: run.name, time: nowIso(), baseline: baselineName, sites: siteMeta, tool, results }, null, 1));
fs.writeFileSync(path.join(run.dir, "shots-report.md"), report());
for (const w of diffInfo.warnings) console.log(`\n**${w}**`);
console.log(`\n共 ${results.length} 項：OK ${counts.ok}、證據不完整 ${counts.incomplete}、失敗 ${counts.fail}；並行 ${Math.min(jobs, tasks.length)}；耗時 ${Math.round((Date.now() - t0) / 1000)} 秒 → ${path.join(run.dir, "shots-report.md")}`);
if (counts.fail) {
  const failIds = [...new Set(results.filter((r) => r.status === "fail").map((r) => r.id))];
  const keep = process.argv.slice(2).filter((a) => a.startsWith("--") && !/^--(run|cases)=/.test(a));
  console.log(`\n重跑失敗的案例（複製即可）：\n${rerunCommand([process.argv[1], configFile, `--cases=${failIds.join(",")}`, ...keep, `--run=${run.name}-retry`])}`);
}
if (counts.incomplete) console.log(`\n**證據不完整 ${counts.incomplete} 項（不能當通過；結束碼 ${counts.fail ? 1 : 4}）**`);
finishRun(run, "done", counts.fail ? "fail" : "done", `ok=${counts.ok} incomplete=${counts.incomplete} fail=${counts.fail}`);
notify(run, { done: counts.ok, incomplete: counts.incomplete, fail: counts.fail });
process.exit(counts.fail ? 1 : counts.incomplete ? 4 : 0);

// ===== 情境對比圖：compare/<案例>-<profile>.png，左舊右新 =====
// --site=both：本次 before 對 after；有 --baseline：基準的 before（沒有就同 site）對本次的 site。兩種都有時，基準那張加 -baseline
async function composeAll() {
  const lang = cfg.compareLang || "zh-Hant";
  const L = compareLabels(lang, cfg.compareLabels);
  const byKey = new Map(results.map((r) => [`${r.id}|${r.profile.name}|${r.site}`, r]));
  fs.mkdirSync(path.join(run.dir, "compare"), { recursive: true });
  const jobs = [];
  for (const r of results) {
    r.compares = [];
    if (r.status === "fail" || !r.context || r.site !== (sites.includes("after") ? "after" : r.site)) continue;
    if (sites.includes("before") && sites.includes("after") && r.site === "after") {
      const bef = byKey.get(`${r.id}|${r.profile.name}|before`);
      if (bef) jobs.push({ r, old: { rec: bef, dir: run.dir, name: "本次", from: "before" }, suffix: "" });
    }
    if (baselineName && baseIdx) {
      const c = cases.find((x) => x.id === r.id);
      const b = baselineFor(c, r, "before").rec ? baselineFor(c, r, "before") : baselineFor(c, r, r.site);
      if (b.rec) jobs.push({ r, old: { rec: b.rec, dir: path.join(cfg.outDir, baselineName), name: `基準 ${baselineName}`, from: b.rec.site }, suffix: jobs.some((j) => j.r === r) ? "-baseline" : "", diffs: b.diffs });
    }
  }
  for (const j of jobs) {
    const { r, old } = j;
    const o = old.rec;
    const rel = `compare/${r.id}-${r.profile.name}${j.suffix}.png`;
    try {
      if (!o.context) { r.compares.push({ against: old.name, file: null, reason: "舊的那邊沒有情境截圖（舊版腳本產生的 run）" }); continue; }
      const oldBuf = fs.readFileSync(path.join(old.dir, o.context.file));
      const newBuf = fs.readFileSync(path.join(run.dir, r.context.file));
      const c = cases.find((x) => x.id === r.id);
      const side = (rec, ctxInfo, buf, kind, prefix) => ({
        buf, rect: ctxInfo.rect, vw: rec.profile.width, vh: rec.profile.height, taller: ctxInfo.taller,
        color: kind === "before" ? "#2e7d32" : "#c62828",
        title: compareTitle(lang, L[kind], prefix, rec.label),
        sub: urlLine(rec.url),
      });
      const hOld = o.rect?.height, hNew = r.rect?.height;
      const taller = r.context.taller || o.context.taller;
      const footer = compareFooter(lang, { id: r.id, note: c.note, profile: r.profile.name, vw: r.profile.width, vh: r.profile.height, block: blockName(c.capture, lang), hOld, hNew, taller, labels: L });
      const warn = compareWarn(lang, { diffs: j.diffs, envWarn: old.dir !== run.dir ? envWarn : "", incomplete: o.status !== "ok" || r.status !== "ok" });
      const png = await composeCompare(pool, {
        left: side(o, o.context, oldBuf, "before", old.dir === run.dir ? "" : baselinePrefix(lang, baselineName)),
        right: side(r, r.context, newBuf, "after", ""),
        footer, footerWarn: warn, lang,
      });
      fs.writeFileSync(path.join(run.dir, rel), png);
      r.compares.push({ against: old.dir === run.dir ? "before" : `baseline:${baselineName}`, file: rel });
    } catch (e) {
      r.compares.push({ against: old.name, file: null, reason: `對比圖產生失敗：${e.message.split("\n")[0]}` });
    }
  }
  const made = results.reduce((n, r) => n + r.compares.filter((x) => x.file).length, 0);
  if (made) console.log(`\n情境對比圖 ${made} 張 → ${path.join(run.dir, "compare")}`);
}

// ===== 截圖差異（只用來排序，不判通過）=====
function computeDiffs() {
  const warnings = [];
  const readOk = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
  const byKey = new Map(results.map((r) => [`${r.id}|${r.profile.name}|${r.site}`, r]));
  const beforeAfter = [];
  fs.mkdirSync(path.join(run.dir, "diff"), { recursive: true });
  for (const r of results) {
    r.diffs = [];
    r.diff = null;
    if (!r.file || r.status === "fail") continue;
    const cur = readOk(path.join(run.dir, r.file));
    if (!cur) continue;
    const add = (against, label, oldBuf, oldRef, diffName) => {
      const d = compareImages(oldBuf, cur, { makeDiffImage: true });
      const { diffImage, ...rest } = d;
      const entry = { against, ...rest, oldImage: oldRef };
      if (diffImage) {
        fs.writeFileSync(path.join(run.dir, "diff", diffName), diffImage);
        entry.diffFile = `diff/${diffName}`;
      }
      r.diffs.push(entry);
      return d;
    };
    if (baselineName && baseIdx) {
      const c = cases.find((x) => x.id === r.id);
      const b = baselineFor(c, r, r.site).rec;
      const buf = b?.file ? readOk(path.join(cfg.outDir, baselineName, b.file)) : null;
      if (buf) add(`baseline:${baselineName}`, baselineName, buf, `../${baselineName}/${b.file}`, r.file);
    }
    if (r.site === "after" && sites.includes("before") && sites.includes("after")) {
      const bef = byKey.get(`${r.id}|${r.profile.name}|before`);
      const buf = bef?.file && bef.status !== "fail" ? readOk(path.join(run.dir, bef.file)) : null;
      if (buf) {
        const d = add("before", "before", buf, bef.file, r.diffs.length ? `vs-before-${r.file}` : r.file);
        beforeAfter.push(d);
      }
    }
    r.diff = r.diffs[0] || null;
  }
  if (beforeAfter.length) {
    const ni = nearIdentical(beforeAfter);
    if (ni.warn) warnings.push(`修改前後幾乎相同（${ni.same}／${ni.total} 對，其中 md5 完全相同 ${ni.md5Same} 對），請先確認兩個網址是否真的是不同版本`);
  }
  if (baseSites) {
    for (const s of sameUrlSites(baseSites, siteMeta))
      warnings.push(`基準和本次用了同一個網址（基準的 ${s.baselineSite}：${s.url}），網址可能已經指到新版本，前後對照可能失效`);
  }
  return { warnings };
}

function diffSection(L) {
  const all = [];
  for (const r of results) for (const d of r.diffs || []) all.push({ r, d });
  if (!all.length) return;
  L.push("", "## 截圖差異（依差異排序）", "");
  L.push("> 這一節**只用來排序要先看哪張，不判通過**。差異比例 = 亮度差 > 16 的像素佔整張的比例；外框是差異像素的範圍（x,y,寬×高，最多 3 塊）。差異小不代表沒問題，小元素消失可能佔不到 0.5%，要抽看。", "");
  const small = [], big = [];
  for (const x of all) {
    if (x.d.status !== "ok") big.push(x);
    else if (!x.d.sizeChanged && x.d.ratio < 0.005) small.push(x);
    else big.push(x);
  }
  const link = (x) => {
    const old = x.d.oldImage;
    const parts = [`[舊](${old})`, `[新](${x.r.file})`];
    if (x.d.diffFile) parts.push(`[差異圖](${x.d.diffFile})`);
    const cp = (x.r.compares || []).find((q) => q.file && q.against === (x.d.against === "before" ? "before" : x.d.against));
    const cpAny = (x.r.compares || []).find((q) => q.file);
    if (cp || (cpAny && x.d.against.startsWith("baseline:"))) parts.push(`[對比圖](${(cp || cpAny).file})`);
    return parts.join("　");
  };
  const tag = (x) => `${x.r.id}｜${x.r.profile.name}｜${x.r.site}｜對 ${x.d.against.startsWith("baseline:") ? "基準 " + x.d.against.slice(9) : x.d.against}`;
  const sized = sortDiffs(big.filter((x) => x.d.status === "ok"));
  const nosz = big.filter((x) => x.d.status !== "ok");
  const sizeCh = sized.filter((x) => x.d.sizeChanged);
  L.push(`### 尺寸不同（${sizeCh.length} 張）`, "");
  if (!sizeCh.length) L.push("（沒有）");
  for (const x of sizeCh) L.push(`- ${tag(x)}：尺寸（寬×高）${x.d.from[0]}×${x.d.from[1]} → ${x.d.to[0]}×${x.d.to[1]}　${link(x)}`);
  const px = sized.filter((x) => !x.d.sizeChanged);
  L.push("", `### 差異 ≥ 0.5%（${px.length} 張，由大到小）`, "");
  if (!px.length) L.push("（沒有）");
  for (const x of px) {
    const rg = x.d.regions.map((q) => `(${q.x},${q.y}) ${q.w}×${q.h}`).join("；");
    L.push(`- ${tag(x)}：${(x.d.ratio * 100).toFixed(2)}%　差異區域 ${rg || "—"}　${link(x)}`);
  }
  if (nosz.length) {
    L.push("", `### 無法比對（${nosz.length} 張）`, "");
    for (const x of nosz) L.push(`- ${tag(x)}：${x.d.reason}`);
  }
  L.push("", `### 差異 < 0.5%（${small.length} 張，只列編號）`, "");
  if (!small.length) L.push("（沒有）");
  else {
    const same = small.filter((x) => x.d.md5Same).length;
    L.push(small.map((x) => `${x.r.id}-${x.r.profile.name}-${x.r.site}(${x.d.against.startsWith("baseline:") ? "基準" : "前後"})`).join("、"));
    L.push("", `其中 ${same} 張檔案完全相同。**差異小不代表沒問題，小元素消失可能佔不到 0.5%，要抽看。**`);
  }
}

// ===== 報告 =====
function report() {
  const KIND = { visual: "看畫面", interaction: "要操作才出現（截圖是操作後的畫面）", motion: "動態效果" };
  const STATUS = { ok: "取證完成（尚未人工確認）", incomplete: "證據不完整，不能當作通過", fail: "失敗，沒有截圖" };
  const L = ["# 對照截圖報告", "", ...previousRunLines(run)];
  L.push(`執行：\`${run.name}\`　產生時間：${nowIso()}`);
  L.push(toolLine(tool));
  for (const site of sites) {
    const m = siteMeta[site];
    L.push(`- ${site}：${m.label || ""} ${m.url}　${describeSite(m)}`);
  }
  if (baselineName) {
    L.push(`- 比對基準：資料夾 \`${baselineName}\`（圖片直接連過去，像素差見下方「截圖差異」；每一項已核對路徑、尺寸、引擎、動態、拍攝設定，不同會標「條件不同」）`);
    if (envWarn) L.push(`- **${envWarn}**`);
    const problems = [];
    const reqChanged = new Set();
    for (const r of results) for (const sn of ["before", "after"]) {
      const c = cases.find((x) => x.id === r.id);
      const b = baselineFor(c, r, sn);
      if (!b.rec) problems.push(`${r.id}｜${r.profile.name}｜基準沒有 ${sn}`);
      else if (b.diffs.length) problems.push(`${r.id}｜${r.profile.name}｜基準 ${sn}：${b.diffs.join("；")}`);
      if (b.notes?.length) reqChanged.add(r.id);
    }
    const uniq = [...new Set(problems)];
    if (!baseIdx) L.push("- **基準沒有 shots-results.json，所有項目的條件都沒核對。**");
    else if (uniq.length) L.push(`- **基準與本次條件不一致或找不到的項目（共 ${uniq.length} 項）：**`, ...uniq.map((x) => `  - ${x}`));
    else L.push("- 基準條件核對：全部一致。");
    if (reqChanged.size) L.push(`- require 改過（不影響截圖範圍，不算條件不同）：${[...reqChanged].join("、")}。要驗的東西變了，這幾項對照時多留意。`);
  }
  for (const w of diffInfo.warnings) L.push("", `> **${w}**`);
  if (baselineName && baseSites) {
    L.push("", `基準 \`${baselineName}\`（產生於 ${baseTime || "?"}）的網站：`);
    for (const [k, m] of Object.entries(baseSites)) L.push(`- ${k}：${m.label || ""} ${m.url}`);
  }
  diffSection(L);
  L.push("", "> 「取證完成」只代表截圖流程順利，不代表修好。每一項要對照「怎樣算修好」用眼睛確認。", "");
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.id)) byCase.set(r.id, []);
    byCase.get(r.id).push(r);
  }
  for (const [id, rs] of byCase) {
    const c = cases.find((x) => x.id === id);
    L.push(`## ${id}　${c.note || ""}`, "");
    L.push(`- 怎樣算修好：${c.expect || "（設定檔沒寫 expect，請對照專案清單的描述）"}`);
    L.push(`- 類型：${KIND[c.kind || "visual"]}`);
    if (c.kind === "motion") L.push("- **需要動態觀察／錄影**：靜態截圖證明不了這項，下面的圖只是捲動後的某一格，請在實機或錄影下確認。");
    if (c.kind === "interaction") L.push("- 操作步驟：" + (c.steps || []).map((s) => s.action).join(" → ") + "。動畫是否順、手感如何，截圖看不出。");
    const profNames = [...new Set(rs.map((r) => r.profile.name))];
    for (const pn of profNames) {
      const prs = rs.filter((r) => r.profile.name === pn);
      const p = prs[0].profile;
      L.push("", `### ${id}｜${pn}（${p.width}×${p.height}，${prs[0].motion === "reduce" ? "減少動態" : "一般動態"}）`, "");
      const cols = [];
      if (baselineName) {
        for (const sn of ["before", "after"]) {
          const b = baselineFor(c, prs[0], sn);
          if (!b.rec?.file) { cols.push({ head: `基準 ${baselineName} 的 ${sn}（找不到這一項）`, img: null }); continue; }
          if (!fs.existsSync(path.join(cfg.outDir, baselineName, b.rec.file))) { cols.push({ head: `基準 ${baselineName} 的 ${sn}（圖檔不見了）`, img: null }); continue; }
          cols.push({ head: `基準 ${baselineName} 的 ${sn}${b.diffs.length ? `（**條件不同**：${b.diffs.join("；")}）` : ""}`, img: `../${baselineName}/${b.rec.file}` });
        }
      }
      for (const r of prs) cols.push({ head: `${r.site}（${r.label || r.url}）`, img: r.file });
      L.push(`| ${cols.map((x) => x.head).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
      L.push(`| ${cols.map((x) => (x.img ? `![${id}](${x.img})` : "（沒有截圖）")).join(" | ")} |`, "");
      for (const q of prs.flatMap((r) => r.compares || [])) L.push(q.file ? `- 前後對比圖（${q.against === "before" ? "本次 before → after" : q.against.replace("baseline:", "基準 ") + " → 本次"}）：[${q.file}](${q.file})` : `- 前後對比圖沒有產生（${q.against}）：${q.reason}`);
      for (const r of prs) {
        L.push(`- ${r.site}：${STATUS[r.status]}${r.httpStatus ? `，HTTP ${r.httpStatus}` : ""}`);
        if (r.error) L.push(`  - 失敗原因：${r.error}`);
        for (const w of r.warnings) L.push(`  - 注意：${w}`);
        if (r.notes.length) L.push(`  - 備註：${r.notes.join("；")}`);
        if (r.picked) L.push(`  - 找到多個元素，依設定挑了 ${r.picked}`);
        if (r.hidden.length) L.push(`  - 為了拍照藏起來：${r.hidden.join("、")}`);
        if (r.waits.length) L.push(`  - 用了固定等待 ${r.waits.join("、")}ms`);
        if (r.finalUrl && r.finalUrl !== r.url) L.push(`  - 網址被轉到 ${r.finalUrl}`);
      }
    }
    L.push("");
  }
  return L.join("\n");
}
