// 起跑掃描：沒跑完的 run 只抓行程不在的，改成 abandoned，補 runs.log，不重報，assertRunDone 擋
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { scanAbandoned, assertRunDone } from "../lib/config.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "tqa-runmeta-"));
try {
  // 找一個一定不存在的 pid
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  const mk = (name, status, pid) => {
    const d = path.join(out, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "run-meta.json"), JSON.stringify({ run: name, tools: { shots: { status, pid, startedAt: "2026-11-05T10:00:00+08:00", expected: 10 } } }));
    fs.writeFileSync(path.join(d, "progress.jsonl"), JSON.stringify({ tool: "shots" }) + "\n" + JSON.stringify({ tool: "shots" }) + "\n");
  };
  mk("a-dead", "running", dead);
  mk("b-alive", "running", process.pid);
  mk("c-done", "done", dead);

  const meta = (n) => JSON.parse(fs.readFileSync(path.join(out, n, "run-meta.json"), "utf8")).tools.shots;
  const r1 = scanAbandoned(out, "self-run");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].run, "a-dead");
  assert.equal(r1[0].done, 2);
  assert.equal(r1[0].expected, 10);
  assert.equal(meta("a-dead").status, "abandoned");
  assert.ok(meta("a-dead").finishedAt);
  assert.equal(meta("b-alive").status, "running");
  assert.equal(meta("c-done").status, "done");
  const log = fs.readFileSync(path.join(out, "runs.log"), "utf8");
  assert.match(log, /a-dead .*abandoned \(detected by self-run\)/);
  assert.equal(log.trim().split("\n").length, 1);
  assert.equal(scanAbandoned(out, "self-run-2").length, 0);
  assert.equal(fs.readFileSync(path.join(out, "runs.log"), "utf8").trim().split("\n").length, 1);
  assert.throws(() => assertRunDone(path.join(out, "a-dead"), "shots"), /沒有跑完/);
  assert.doesNotThrow(() => assertRunDone(path.join(out, "c-done"), "shots"));
  console.log("runmeta.test 通過");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
