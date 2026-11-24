// Stop hook：餵假 stdin 檢查輸出
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "../hooks/stop-running.mjs");
const sid = "test-" + crypto.randomBytes(6).toString("hex");
const run = (input) => spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
const shots = { id: "b1", type: "shell", status: "running", command: "node /Users/x/.claude/skills/tablet-qa/scripts/shots.mjs qa/tablet-qa.json --notify" };
try {
  let r = run({ session_id: sid, background_tasks: [] });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  r = run({ session_id: sid, stop_hook_active: true, background_tasks: [shots] });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  r = run({ session_id: sid, background_tasks: [{ ...shots, id: "other", command: "npm run dev" }] });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  r = run({ session_id: sid, background_tasks: [{ ...shots, id: "fin", status: "completed" }] });
  assert.equal(r.stdout, "");
  r = run({ session_id: sid, background_tasks: [shots] });
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.decision, "block");
  assert.match(o.reason, /背景量測還在跑/);
  assert.match(o.reason, /shots\.mjs/);
  r = run({ session_id: sid, background_tasks: [shots] }); // 同一 id 第二次
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  // 資料夾改名（GitHub zip 解開的 tablet-qa-main）、Windows 路徑也要認得
  for (const [i, cmd] of ["node /Users/x/Downloads/tablet-qa-main/scripts/sweep.mjs qa/t.json", "node C:\\Users\\x\\tablet-qa-main\\scripts\\shots.mjs qa\\t.json"].entries()) {
    r = run({ session_id: sid, background_tasks: [{ ...shots, id: "renamed" + i, command: cmd }] });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, "block", cmd);
  }
  r = run({ session_id: sid, background_tasks: [{ ...shots, id: "other-script", command: "node /x/tablet-qa-main/scripts/other.mjs" }] });
  assert.equal(r.stdout, "");
  r = run("{壞掉");
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  console.log("stop-hook.test 通過");
} finally {
  fs.rmSync(path.join(os.tmpdir(), "tablet-qa-hook", sid), { recursive: true, force: true });
}
