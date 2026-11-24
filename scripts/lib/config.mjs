// 讀設定檔、解析 profile、載入 Playwright
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";

// ---------- 名稱驗證（案例 id、頁面 id、profile 名、--run 都會變成檔名）----------
// 拒絕空字串、.、..、斜線、Windows 不合法字元（: * ? " < > |）、控制字元；中文可以
export function badName(s) {
  const v = String(s ?? "");
  if (!v || v === "." || v === "..") return "不能是空字串、. 或 ..";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(v)) return '不能含 / \\ : * ? " < > | 或控制字元';
  if (/[. ]$/.test(v)) return "不能以句點或空白結尾";
  // Windows 不能用這些當檔名或資料夾名（含 CON.txt 這種帶副檔名的寫法）；不分大小寫
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(v)) return "是 Windows 的保留名稱（CON、PRN、AUX、NUL、COM1–9、LPT1–9），在 Windows 上建不出同名的檔案或資料夾，換一個名字";
  return null;
}
// 設定檔頂層 browser 的可用值（只影響 chromium 引擎）
export const BROWSER_CHOICES = ["auto", "chrome", "bundled", "msedge"];
// 印給使用者複製的指令：含空白、中文、特殊字元的參數要加引號（Windows 用雙引號，其他用單引號）
export function quoteArg(s, platform = process.platform) {
  const v = String(s);
  if (v && /^[\p{L}\p{N}_\-.\/:=@,+]+$/u.test(v)) return v;
  if (platform === "win32") return `"${v.replace(/"/g, '\\"')}"`;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
export const rerunCommand = (args, platform) => ["node", ...args].map((a) => quoteArg(a, platform)).join(" ");
// 輸出檔路徑解析後必須在 dir 內
export function inside(dir, file) {
  const p = path.resolve(dir, file);
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error(`輸出路徑跑出資料夾外：${file}`);
  return p;
}
// 旗標只收認得的；拼錯就報錯，不默默採預設範圍
export function checkFlags(opt, allowed) {
  const bad = Object.keys(opt).filter((k) => !allowed.includes(k));
  if (bad.length) throw new Error(`不認得的旗標：${bad.map((k) => "--" + k).join("、")}（可用：${allowed.map((k) => "--" + k).join("、")}）`);
}

export function loadConfig(file) {
  if (!file) throw new Error("用法：node <script> <設定檔.json> [id...]");
  const abs = path.resolve(file);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`讀不到或不是合法 JSON：${abs}（${e.message}）`);
  }
  const errs = [];
  // sites 底下 _ 開頭的鍵是備註，忽略
  const siteNames = Object.keys(cfg.sites || {}).filter((k) => !k.startsWith("_") && cfg.sites[k]?.url);
  if (!siteNames.length) errs.push("sites 至少要有一個網站（sites.after.url 或 sites.before.url）");
  for (const k of Object.keys(cfg.sites || {})) {
    if (k.startsWith("_")) continue;
    if (k !== "before" && k !== "after") errs.push(`sites 只能叫 before 或 after，不認得「${k}」`);
  }
  for (const k of Object.keys(cfg.sites || {})) {
    const v = cfg.sites[k]?.networkIdleMs;
    if (!k.startsWith("_") && v !== undefined && !(typeof v === "number" && v >= 0)) errs.push(`sites.${k}.networkIdleMs 要是 0 以上的毫秒數`);
  }
  if (!cfg.profiles || !Object.keys(cfg.profiles).length) errs.push("profiles 至少一個");
  for (const [n, p] of Object.entries(cfg.profiles || {})) {
    if (!(p.width > 0) || !(p.height > 0)) errs.push(`profile ${n} 缺 width/height`);
    if (badName(n)) errs.push(`profile 名「${n}」${badName(n)}（會用在檔名）`);
  }
  const uniq = (list, what) => {
    const seen = new Map();
    for (const x of list) {
      if (!x.id) continue;
      if (badName(x.id)) errs.push(`${what} id「${x.id}」${badName(x.id)}`);
      const k = String(x.id).toLowerCase(); // macOS／Windows 檔名不分大小寫
      if (seen.has(k)) errs.push(`${what} id 重複（不分大小寫）：${seen.get(k)} 與 ${x.id}`);
      else seen.set(k, x.id);
    }
  };
  uniq(cfg.cases || [], "案例");
  uniq(cfg.pages || [], "頁面");
  if (cfg.browser !== undefined && !BROWSER_CHOICES.includes(cfg.browser)) errs.push(`browser 只能是 ${BROWSER_CHOICES.map((x) => `"${x}"`).join("、")}（可以不寫，等於 "auto"），收到 ${JSON.stringify(cfg.browser)}`);
  if (cfg.compareLang !== undefined && !["zh-Hant", "en"].includes(cfg.compareLang)) errs.push(`compareLang 只能是 "zh-Hant"、"en"（可以不寫，等於 "zh-Hant"），收到 ${JSON.stringify(cfg.compareLang)}`);
  if (cfg.tabletMin !== undefined && !(typeof cfg.tabletMin === "number" && cfg.tabletMin > 0)) errs.push("tabletMin 要是正數");
  const okStatus = (v) => v === undefined || (Number.isInteger(v) && v >= 100 && v < 600) || (Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n >= 100 && n < 600));
  for (const c of cfg.cases || []) {
    if (!okStatus(c.expectedStatus)) errs.push(`案例 ${c.id} 的 expectedStatus 要是 HTTP 狀態碼或陣列`);
    if (c.require !== undefined && !Array.isArray(c.require)) errs.push(`案例 ${c.id} 的 require 要是 target 陣列`);
    if (!c.id || !c.path) errs.push(`案例缺 id 或 path：${JSON.stringify(c).slice(0, 60)}`);
    if (!c.profile && !c.profiles && !c.width) errs.push(`案例 ${c.id} 要有 profile、profiles 或 width`);
    if (c.profile && !cfg.profiles?.[c.profile]) errs.push(`案例 ${c.id} 的 profile「${c.profile}」不存在`);
    if (c.profiles && !(Array.isArray(c.profiles) && c.profiles.length)) errs.push(`案例 ${c.id} 的 profiles 要是非空陣列`);
    for (const pn of c.profiles || []) if (!cfg.profiles?.[pn]) errs.push(`案例 ${c.id} 的 profiles 裡「${pn}」不存在`);
    if (c.kind && !["visual", "interaction", "motion"].includes(c.kind)) errs.push(`案例 ${c.id} 的 kind 只能是 visual、interaction、motion`);
    if (!c.capture?.mode) errs.push(`案例 ${c.id} 缺 capture.mode`);
  }
  for (const e of cfg.acceptedExceptions || []) {
    const m = e.match;
    if (m !== undefined && typeof m !== "string" && !(m && typeof m === "object" && (typeof m.css === "string" || typeof m.text === "string"))) {
      errs.push(`acceptedExceptions 的 match 要是字串，或 { "css": "..." }、{ "text": "..." }：${JSON.stringify(e).slice(0, 80)}`);
    }
    if (e.min !== undefined && !(typeof e.min === "number" && e.min > 0)) errs.push(`acceptedExceptions 的 min 要是正數：${JSON.stringify(e).slice(0, 80)}`);
    if (e.min !== undefined && e.check !== "tap") errs.push(`acceptedExceptions 的 min 目前只支援 check:"tap"：${JSON.stringify(e).slice(0, 80)}`);
  }
  for (const p of cfg.pages || []) {
    if (!p.id || !p.path) errs.push(`pages 項目缺 id 或 path：${JSON.stringify(p)}`);
    if (!okStatus(p.expectedStatus)) errs.push(`頁面 ${p.id} 的 expectedStatus 要是 HTTP 狀態碼或陣列`);
  }
  if (errs.length) throw new Error("設定檔有問題：\n- " + errs.join("\n- "));
  cfg.baseDir = path.dirname(abs);
  cfg.file = abs;
  // 預設放在設定檔旁的 tablet-qa-runs/（記得加進 .gitignore；不要放在會部署的資料夾）
  cfg.outDir = path.resolve(cfg.baseDir, cfg.out || "tablet-qa-runs");
  cfg.tabletMin = cfg.tabletMin ?? (cfg.breakpoints?.[0] || 0);
  cfg.minTap = cfg.minTap || 44;
  cfg.browser = cfg.browser ?? "auto";
  cfg.breakpoints = cfg.breakpoints || [];
  cfg.acceptedExceptions = cfg.acceptedExceptions || [];
  cfg.siteNames = ["before", "after"].filter((k) => cfg.sites[k]?.url);
  return cfg;
}

// 命令列：位置參數 + --key=value + --flag
export function parseArgs(argv) {
  const positional = [];
  const opt = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, ...v] = a.slice(2).split("=");
      opt[k] = v.length ? v.join("=") : true;
    } else positional.push(a);
  }
  return { positional, opt };
}

export const csv = (v) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

// 這次要跑哪些網站：--site 指定；沒指定時，sweepDefault 為 true 的程式偏好 after
export function pickSites(cfg, siteOpt, { prefer } = {}) {
  const names = cfg.siteNames;
  if (!siteOpt || siteOpt === true) return prefer && names.includes(prefer) ? [prefer] : names;
  if (siteOpt === "both") return names;
  if (!names.includes(siteOpt)) throw new Error(`--site 只能是 ${names.join("、")}${names.length > 1 ? " 或 both" : ""}（設定檔只定義了 ${names.join("、")}）`);
  return [siteOpt];
}

// ---------- 每次執行獨立的資料夾 ----------
// 資料夾裡的紀錄：
//   run-meta.json   每個工具一份（tools.shots／tools.sweep；同名 --run 讓兩個工具共用資料夾時各記各的）：args、開始時間、pid、預計筆數、sites、設定快照、status（running／done／interrupted／failed／abandoned）、結束時間
//   progress.jsonl  每完成一筆 append 一行（run-meta 沒有 done 時，用這個算「完成 M」）
//   <out>/runs.log  所有 run 的啟動與結束紀錄（取代舊的 latest.txt）
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function makeRun(cfg, runOpt, siteNames, info = {}) {
  let name = typeof runOpt === "string" ? runOpt : null;
  const explicit = !!name;
  if (!explicit) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    const labels = siteNames.map((k) => slug(cfg.sites[k].label) || k).join("-").slice(0, 40).replace(/-+$/, "");
    name = `${stamp}-${labels || siteNames.join("-")}`;
    let n = name, i = 1;
    while (fs.existsSync(path.join(cfg.outDir, n))) n = `${name}-${++i}`;
    name = n;
  }
  const bad = badName(name);
  if (bad) throw new Error(`--run 名稱「${name}」${bad}`);
  const dir = inside(cfg.outDir, name);
  // 建本次資料夾之前，先找上次沒跑完的 run（掃描出錯不影響本次）
  let previous = [];
  try {
    previous = scanAbandoned(cfg.outDir, name);
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const run = { name, dir, explicit, tool: info.tool || "tool", outDir: cfg.outDir, sites: {}, args: info.args || [], previous, notify: resolveNotify(cfg, info.notify) };
  for (const k of siteNames) run.sites[k] = { url: cfg.sites[k].url, label: cfg.sites[k].label || "" };
  const today = nowIso().slice(0, 10).replace(/-/g, "");
  if (explicit && /^\d{8}/.test(name) && name.slice(0, 8) !== today) console.warn(`注意：--run 名稱「${name}」以日期 ${name.slice(0, 8)} 開頭，不是今天（${today}）。日期寫錯會讓資料夾排序和人工查找出錯。`);
  // 設定快照
  try {
    fs.copyFileSync(cfg.file, inside(dir, "tablet-qa-config.json"));
  } catch {}
  run.startedAt = nowIso();
  writeMeta(run, { args: run.args, startedAt: run.startedAt, pid: process.pid, expected: info.expected ?? null, sites: run.sites, configSnapshot: "tablet-qa-config.json", status: "running", finishedAt: null });
  appendRunsLog(run, "start");
  // 被中斷（Ctrl-C、kill）時留下紀錄，之後 --baseline／--compare 讀到會報「沒有跑完」
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      try {
        finishRun(run, "interrupted");
      } catch {}
      try {
        notify(run, { interrupted: true, done: countProgress(run.dir, run.tool), expected: info.expected ?? "?" });
      } catch {}
      process.exit(130);
    });
  }
  return run;
}

function countProgress(dir, tool) {
  try {
    return fs.readFileSync(path.join(dir, "progress.jsonl"), "utf8").split("\n").filter((l) => {
      try {
        return l && JSON.parse(l).tool === tool;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}
function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return e.code === "EPERM" ? "alive" : "gone";
  }
}
// 掃 outDir 下一層每個 run-meta.json，找 status 還是 running 的。
// 行程已不在的：印警告、meta 改成 abandoned、runs.log 補一行（下次不再報）；行程還在的：只印一行。
// 回傳 [{ run, tool, startedAt, done, expected }]（只含已不在的），給呼叫端寫進報告。
export function scanAbandoned(outDir, selfName = "?") {
  const found = [];
  const alive = [];
  let entries = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const dir = path.join(outDir, e.name);
      const f = path.join(dir, "run-meta.json");
      if (!fs.existsSync(f)) continue;
      const m = JSON.parse(fs.readFileSync(f, "utf8"));
      let changed = false;
      for (const [tool, t] of Object.entries(m.tools || {})) {
        if (t?.status !== "running") continue;
        if (pidState(t.pid) === "alive") {
          alive.push(`注意：${e.name} ${tool} 還在跑（pid ${t.pid}）`);
          continue;
        }
        const when = nowIso();
        found.push({ run: e.name, tool, startedAt: t.startedAt, done: countProgress(dir, tool), expected: t.expected ?? "?" });
        t.status = "abandoned";
        t.finishedAt = when;
        changed = true;
        fs.appendFileSync(path.join(outDir, "runs.log"), [when, tool, e.name, "", "", `pid=${t.pid ?? "?"}`, `abandoned (detected by ${selfName})`].join(" | ") + "\n");
      }
      if (changed) fs.writeFileSync(f, JSON.stringify(m, null, 1));
    } catch {}
  }
  for (const a of alive) console.warn(a);
  if (found.length) {
    console.warn(`注意：${outDir} 有 ${found.length} 個沒跑完的 run（行程已不在，多半是對話關掉或被中止）：`);
    for (const x of found) console.warn(`- ${x.run} ${x.tool} 開始 ${x.startedAt} 完成 ${x.done}／預計 ${x.expected}`);
  }
  return found;
}
// 報告開頭要加的行（沒有就回空陣列）
export function previousRunLines(run) {
  if (!run.previous?.length) return [];
  return ["## 上次沒跑完的量測", "", ...run.previous.map((x) => `- \`${x.run}\` ${x.tool}：開始 ${x.startedAt}，完成 ${x.done}／預計 ${x.expected}（行程已不在，已標成 abandoned，不能當基準）`), ""];
}

// ---------- 跑完通知（選用）----------
// 旗標 --notify 優先（--notify=false 關掉），沒有旗標看設定檔頂層 notify；預設關
export function resolveNotify(cfg, flag) {
  if (flag === undefined) return !!cfg.notify;
  return !(flag === "false" || flag === "0" || flag === false);
}
// best-effort：任何錯誤只印一行，不改結束碼；逾時 5 秒。內文不寫「通過」。
export function notify(run, summary) {
  if (!run?.notify) return;
  try {
    const text = summary.failed
      ? `${run.tool} ${run.name} 失敗：沒有產出報告`
      : summary.interrupted
      ? `${run.tool} ${run.name} 被中斷：完成 ${summary.done}／預計 ${summary.expected}`
      : `${run.tool} ${run.name} 量完，待判讀：完成 ${summary.done}、證據不完整 ${summary.incomplete}、失敗 ${summary.fail}`;
    if (process.platform === "darwin") {
      const esc = (x) => String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const r = spawnSync("osascript", ["-e", `display notification "${esc(text)}" with title "tablet-qa" sound name "Glass"`], { timeout: 5000, stdio: "ignore" });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`osascript 結束碼 ${r.status}`);
    } else if (process.platform === "linux") {
      const r = spawnSync("notify-send", ["tablet-qa", text], { timeout: 5000, stdio: "ignore" });
      if (r.error && r.error.code !== "ENOENT") throw r.error;
      if (!r.error && r.status !== 0) throw new Error(`notify-send 結束碼 ${r.status}`);
    }
  } catch (e) {
    try {
      console.warn(`通知沒發出去：${String(e.message || e).slice(0, 80)}`);
    } catch {}
  }
}

function readMetaFile(dir) {
  const f = path.join(dir, "run-meta.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return { tools: {}, broken: true };
  }
}
function writeMeta(run, patch) {
  const m = readMetaFile(run.dir) || { run: run.name, tools: {} };
  m.run = run.name;
  m.tools = m.tools || {};
  m.tools[run.tool] = { ...(m.tools[run.tool] || {}), ...patch };
  fs.writeFileSync(path.join(run.dir, "run-meta.json"), JSON.stringify(m, null, 1));
}
// 每完成一筆呼叫一次（單一執行緒的事件迴圈，appendFileSync 不會交錯）
export function logProgress(run, entry) {
  fs.appendFileSync(path.join(run.dir, "progress.jsonl"), JSON.stringify({ t: nowIso(), tool: run.tool, ...entry }) + "\n");
}
export function appendRunsLog(run, status, extra = "") {
  const urls = Object.entries(run.sites).map(([k, s]) => `${k}=${s.url}`).join(",");
  const args = run.args.join(" ");
  fs.appendFileSync(path.join(run.outDir, "runs.log"), [nowIso(), run.tool, run.name, urls, args, `pid=${process.pid}`, status + (extra ? ` ${extra}` : "")].join(" | ") + "\n");
}
// status：done（跑完，含有失敗項目）／interrupted。runs.log 的狀態另外用 logStatus（done／fail／interrupted）
export function finishRun(run, status, logStatus = status, extra = "") {
  if (run.finished) return;
  run.finished = true;
  writeMeta(run, { status, finishedAt: nowIso() });
  appendRunsLog(run, logStatus, extra);
}
// 讀別人跑出來的 run（--baseline、--compare）前先確認它跑完了。
// 沒有 run-meta.json 的是舊格式，放行（無從核對）；有但沒 done → 丟錯（呼叫端以結束碼 2 停下）
export function assertRunDone(dir, tool) {
  const m = readMetaFile(dir);
  if (!m) return;
  const t = m.tools?.[tool];
  if (!t) {
    if (m.broken) throw new Error(`這個 run 的 run-meta.json 讀不懂，無法確認有沒有跑完：${dir}`);
    return;
  }
  if (t.status === "done") return;
  let n = 0;
  try {
    n = fs.readFileSync(path.join(dir, "progress.jsonl"), "utf8").split("\n").filter((l) => l && JSON.parse(l).tool === tool).length;
  } catch {}
  throw new Error(`這個 run 沒有跑完（預計 ${t.expected ?? "?"}、完成 ${n}；狀態 ${t.status}，開始於 ${t.startedAt}）：${dir}。不能拿來當基準。請重跑，或換一個跑完的 run。`);
}

// 讀網站的版本證據與請求資訊。
// version：真的能對應到某個版本的欄位（部署網址、commit、<meta name="version">、設定檔的 versionUrl）；沒有就是 null
// requestInfo：x-vercel-id 這類只是「這次請求」的識別碼，不能拿來確認是哪一版
async function getText(url, ctl) {
  const res = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": "tablet-qa" } });
  return { res, text: await res.text().catch(() => "") };
}
export async function fetchDeployment(url, versionUrl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const version = {};
  const requestInfo = {};
  const issues = []; // 版本證據讀不到的原因（HTTP ≥ 400 多半是密碼保護），報告要寫出來，不能默默變 null
  try {
    const { res, text: html } = await getText(url, ctl);
    for (const h of ["x-vercel-deployment-url", "x-deployment-id", "x-github-sha", "x-version"]) {
      const v = res.headers.get(h);
      if (v) version[h] = v;
    }
    for (const h of ["x-vercel-id", "server"]) {
      const v = res.headers.get(h);
      if (v) requestInfo[h] = v;
    }
    const m = html.match(/<meta[^>]+name=["']version["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']version["']/i);
    if (m) version.metaVersion = m[1];
    requestInfo.httpStatus = res.status;
    if (res.status >= 400) issues.push(`網址本身回 HTTP ${res.status}（可能有密碼保護），版本證據讀不到`);
    if (versionUrl) {
      const r2 = await getText(new URL(versionUrl, url).href, ctl);
      if (r2.res.ok) version.versionUrl = r2.text.trim().slice(0, 200);
      else issues.push(`版本端點回 HTTP ${r2.res.status}（可能有密碼保護）：${versionUrl}`);
    }
  } catch (e) {
    // 讀不到不算失敗，但要留下原因
    issues.push(`版本證據讀取失敗：${(e.cause?.code || e.name || e.message || "").toString().slice(0, 60)}`);
  } finally {
    clearTimeout(t);
  }
  return { version: Object.keys(version).length ? version : null, requestInfo: Object.keys(requestInfo).length ? requestInfo : null, ...(issues.length ? { issues } : {}) };
}

export async function siteInfo(cfg, names) {
  const out = {};
  for (const k of names) {
    const s = cfg.sites[k];
    out[k] = { url: s.url, label: s.label || "", ...(await fetchDeployment(s.url, s.versionUrl)) };
  }
  return out;
}

// 報告用的一行：版本與請求資訊分開寫
export function describeSite(m) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("；");
  const ver = m.version ? `版本證據：${kv(m.version)}` : "版本證據：讀不到（網站沒有提供版本標頭或 meta，label 無法被第二個證據核對）";
  const req = m.requestInfo ? `；請求資訊（不能當版本）：${kv(Object.fromEntries(Object.entries(m.requestInfo).filter(([k]) => k !== "httpStatus")))}` : "";
  const iss = m.issues?.length ? `；**${m.issues.join("；")}**` : "";
  return ver + req + iss;
}

// 這次執行的工具環境：腳本雜湊、Playwright／瀏覽器版本；設定檔另存一份快照
export function toolInfo(cfg, run, pool) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(path.dirname(dir));
  const h = crypto.createHash("sha1");
  for (const f of files.sort()) h.update(path.relative(path.dirname(dir), f)).update(fs.readFileSync(f));
  let pwVersion = null;
  try {
    pwVersion = JSON.parse(fs.readFileSync(path.join(cfg.playwrightPath, "package.json"), "utf8")).version;
  } catch {}
  const info = {
    scriptHash: h.digest("hex").slice(0, 12),
    playwright: pwVersion,
    browsers: pool.versions, // chromium 的值帶通道，例如 "chrome 131.0.x"、"bundled-chromium 131.0.x"
    browserSetting: pool.browserSetting || "auto",
    browserFellBack: !!pool.fellBack, // auto 找不到 Chrome，改用內建 Chromium
    platform: process.platform,
    arch: process.arch,
    configSnapshot: "tablet-qa-config.json",
  };
  if (run) {
    try {
      writeMeta(run, { env: { playwright: info.playwright, browsers: info.browsers, browserSetting: info.browserSetting, browserFellBack: info.browserFellBack, platform: info.platform, arch: info.arch } });
    } catch {}
  }
  return info;
}

// 報告開頭的「工具」行（shots、sweep 共用）
export function toolLine(tool) {
  const bs = Object.entries(tool.browsers || {}).map(([k, v]) => (k === "chromium" ? v : `${k} ${v}`)).join("、") || "?";
  const sys = tool.platform ? `；系統 ${tool.platform} ${tool.arch || ""}`.trimEnd() : "";
  const fb = tool.browserFellBack ? "（找不到 Google Chrome，改用 Playwright 內建的 Chromium）" : "";
  return `工具：腳本 ${tool.scriptHash}；Playwright ${tool.playwright || "?"}；瀏覽器 ${bs}${fb}${sys}；設定檔快照 \`${tool.configSnapshot}\``;
}

// 案例 → profile：用 profile 名，或只給 width（高度取同寬 profile，沒有就 width×1.4）
// 案例的所有 profile：profiles 陣列、單一 profile、或 width
export function resolveProfiles(cfg, c) {
  if (c.profiles) return c.profiles.map((n) => ({ name: n, ...cfg.profiles[n] }));
  return [resolveProfile(cfg, c)];
}

export function resolveProfile(cfg, c) {
  if (c.profile) return { name: c.profile, ...cfg.profiles[c.profile] };
  const same = Object.entries(cfg.profiles).find(([, p]) => p.width === c.width);
  if (same) return { name: same[0], ...same[1] };
  const nearest = Object.entries(cfg.profiles).sort(
    (a, b) => Math.abs(a[1].width - c.width) - Math.abs(b[1].width - c.width)
  )[0];
  return {
    name: `w${c.width}`,
    width: c.width,
    height: Math.round(c.width * 1.4),
    touch: c.touch ?? nearest[1].touch,
    engine: nearest[1].engine,
    locale: nearest[1].locale,
  };
}

// 找 Playwright：from（資料夾，已是絕對路徑）→ startDirs 各自往上。回傳 { playwright, packagePath }；找不到丟錯（error.tried 是試過的路徑）
export function findPlaywright({ from, startDirs = [] } = {}) {
  const tried = [];
  const dirs = [];
  if (from) dirs.push(from);
  for (const start of startDirs) {
    for (let d = start; ; d = path.dirname(d)) {
      if (!dirs.includes(d)) dirs.push(d);
      if (path.dirname(d) === d) break;
    }
  }
  for (const dir of dirs) {
    // dir 本身就是放套件的資料夾（例如改名過的套件資料夾），或 dir/node_modules 底下有
    const candidates = [path.join(dir, "playwright"), path.join(dir, "node_modules", "playwright")].filter((c) => fs.existsSync(path.join(c, "package.json")));
    for (const c of candidates) {
      tried.push(c);
      try {
        // 套件在名字不是 node_modules 的資料夾時，它依賴的 playwright-core 不在一般解析路徑上。
        // 正規做法（createRequire 指向該套件）找不到時，才補 NODE_PATH；Module._initPaths 是 Node 內部 API，
        // 只在這個情況使用，之後 Node 若移除會走下面的 catch 並報「找不到」。
        const req = createRequire(path.join(c, "package.json"));
        let mod;
        try {
          mod = req(c);
        } catch {
          process.env.NODE_PATH = [path.dirname(c), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
          Module._initPaths();
          mod = req(c);
        }
        return { playwright: mod, packagePath: c };
      } catch (e) {
        tried.push(`(${e.message.split("\n")[0]})`);
      }
    }
  }
  const err = new Error(
    "找不到 playwright。請在設定檔寫 playwrightFrom（有裝 playwright 的資料夾，建議用相對於設定檔的路徑），或在專案執行 npm i -D playwright。" +
      (tried.length ? `\n試過：${tried.join(", ")}` : "")
  );
  err.tried = tried;
  throw err;
}

// shots／sweep 用：順序是設定檔 playwrightFrom（相對於設定檔）→ 設定檔所在資料夾往上 → 目前資料夾往上；找到的路徑記在 cfg.playwrightPath
export async function loadPlaywright(cfg) {
  const { playwright, packagePath } = findPlaywright({
    from: cfg.playwrightFrom ? path.resolve(cfg.baseDir, cfg.playwrightFrom) : undefined,
    startDirs: [cfg.baseDir, process.cwd()],
  });
  cfg.playwrightPath = packagePath;
  return playwright;
}
export function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}

// 路徑以 / 開頭時接在網站網址的子路徑後面（https://x.com/app + /zh → https://x.com/app/zh）
export function siteUrl(base, p) {
  if (/^https?:\/\//i.test(p)) return p;
  const u = new URL(base);
  if (p.startsWith("/")) return new URL(u.origin + u.pathname.replace(/\/+$/, "") + p).href;
  return new URL(p, base.endsWith("/") ? base : base + "/").href;
}
