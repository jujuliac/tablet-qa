// CI helper for the demo page (examples/demo-site).
//   node .github/demo-check.mjs config <variant>   writes examples/demo-site/ci-<variant>.json
//   node .github/demo-check.mjs check <variant>    compares the runs with .github/demo-expected.json
// variant: chrome | bundled | webkit
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, "examples", "demo-site");
const [cmd, variant] = process.argv.slice(2);
const VARIANTS = { chrome: "chromium", bundled: "chromium", webkit: "webkit" };
if (!["config", "check"].includes(cmd) || !VARIANTS[variant]) {
  console.error("usage: node .github/demo-check.mjs config|check chrome|bundled|webkit");
  process.exit(2);
}

if (cmd === "config") {
  const cfg = JSON.parse(fs.readFileSync(path.join(demo, "tablet-qa.json"), "utf8"));
  if (variant === "webkit") for (const p of Object.values(cfg.profiles)) p.engine = "webkit";
  else cfg.browser = variant;
  const out = path.join(demo, `ci-${variant}.json`);
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
  console.log(out);
  process.exit(0);
}

const expected = JSON.parse(fs.readFileSync(path.join(root, ".github", "demo-expected.json"), "utf8"));
const runs = path.join(demo, "tablet-qa-runs");
const errors = [];
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`cannot read ${path.relative(root, p)}: ${e.message}`);
    return null;
  }
};

// sweep: every width measured, touch emulation on, same findings as expected
const sweepDir = path.join(runs, `ci-${variant}-sweep`);
// the browser each tool actually used, from run-meta.json
const checkBrowser = (tool, dir) => {
  const env = readJson(path.join(dir, "run-meta.json"))?.tools?.[tool]?.env;
  if (!env?.browsers) return errors.push(`${tool}: no browser recorded in run-meta.json`);
  const b = env.browsers;
  if (Object.keys(b).join() !== VARIANTS[variant]) errors.push(`${tool} used ${JSON.stringify(b)}, expected only ${VARIANTS[variant]}`);
  if (variant === "chrome" && !String(b.chromium).startsWith("chrome ")) errors.push(`${tool} did not use Google Chrome: ${b.chromium}`);
  if (variant === "bundled" && !String(b.chromium).startsWith("bundled-chromium ")) errors.push(`${tool} did not use bundled Chromium: ${b.chromium}`);
  console.log(`${tool} browser: ${JSON.stringify(b)}  platform: ${env.platform} ${env.arch}`);
};
checkBrowser("sweep", sweepDir);
const cfg = readJson(path.join(demo, `ci-${variant}.json`));
const home = readJson(path.join(sweepDir, "results", "home.json"));
if (home) {
  const seen = new Set();
  for (const r of home.records) {
    const w = String(r.width);
    seen.add(w);
    if (r.status !== "ok") errors.push(`width ${w}: status ${r.status} ${r.error || ""}`);
    const touch = cfg?.profiles?.[r.profile]?.touch === true;
    if (!r.env?.ok || r.env?.pointerCoarse !== touch) errors.push(`width ${w}: touch emulation ${touch ? "not active" : "should be off"} ${JSON.stringify(r.env)}`);
    const got = new Set(r.findings.map((f) => `${f.check} ${f.selector}`));
    const want = new Set(expected.sweep[w] || []);
    for (const x of want) if (!got.has(x)) errors.push(`width ${w}: missing  ${x}`);
    for (const x of got) if (!want.has(x)) errors.push(`width ${w}: extra    ${x}`);
  }
  for (const w of Object.keys(expected.sweep)) if (!seen.has(w)) errors.push(`width ${w}: not measured`);
}

// shots: every case ok, comparison images built
const shotsDir = path.join(runs, `ci-${variant}-shots`);
checkBrowser("shots", shotsDir);
const shots = readJson(path.join(shotsDir, "shots-results.json"));
if (shots) {
  for (const r of shots.results) if ((r?.profile?.engine || "chromium") !== VARIANTS[variant]) errors.push(`shots ${r?.id} ${r?.site}: engine ${r?.profile?.engine}`);
  const ok = shots.results.filter((r) => r?.status === "ok").length;
  if (ok !== expected.shotsOk) errors.push(`shots: ${ok} ok, expected ${expected.shotsOk}`);
  const cmp = fs.existsSync(path.join(shotsDir, "compare")) ? fs.readdirSync(path.join(shotsDir, "compare")).filter((f) => f.endsWith(".png")) : [];
  if (cmp.length < 2) errors.push(`shots: ${cmp.length} comparison images, expected 2`);
}

if (errors.length) {
  console.error(`demo check (${variant}) FAILED:\n- ` + errors.join("\n- "));
  process.exit(1);
}
console.log(`demo check (${variant}) passed`);
