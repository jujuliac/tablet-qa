// 設定檔與跨平台小修：Playwright 搜尋、Windows 保留名稱、重跑指令加引號
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { badName, quoteArg, rerunCommand, findPlaywright, notify } from "../lib/config.mjs";

// Windows 保留名稱
for (const n of ["CON", "con", "Nul", "AUX", "prn", "COM1", "com9", "LPT1", "lpt9", "con.txt", "NUL.tar.gz"]) assert.match(badName(n) || "", /Windows 的保留名稱/, n);
for (const n of ["console", "com0", "com10", "lpt", "ipad-con", "20261124-after", "首頁", "con 1"]) assert.equal(badName(n), null, n);
assert.match(badName("a/b"), /不能含/);

// 重跑指令：路徑有空白、中文時加引號，不壓縮空白
{
  const script = "/Users/x y/.claude/skills/tablet-qa/scripts/shots.mjs";
  const cfgFile = "/Users/x y/示範 專案/qa/tablet/tablet-qa.json";
  const cmd = rerunCommand([script, cfgFile, "--cases=a,b", "--site=after", "--run=r-retry"], "darwin");
  assert.equal(cmd, `node '${script}' '${cfgFile}' --cases=a,b --site=after --run=r-retry`);
  assert.ok(cmd.includes("x y/.claude"), "空白沒有被壓縮");
  assert.equal(rerunCommand(["C:\\Users\\a b\\shots.mjs", "c.json"], "win32"), 'node "C:\\Users\\a b\\shots.mjs" c.json');
  assert.equal(quoteArg("it's here", "darwin"), `'it'\\''s here'`);
  assert.equal(quoteArg("--cases=首頁,關於"), "--cases=首頁,關於");
  assert.equal(quoteArg("", "darwin"), "''");
  assert.equal(quoteArg("", "win32"), '""');
  // 單引號的結果交給真的 shell 還原
  if (process.platform !== "win32") {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("sh", ["-c", `printf '%s\\n' ${quoteArg(script)} ${quoteArg(cfgFile)} ${quoteArg("it's $HOME")}`], { encoding: "utf8" });
    assert.equal(r.stdout, `${script}\n${cfgFile}\nit's $HOME\n`);
  }
}

// findPlaywright：from → startDirs 往上，順序和去重
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tqa-find-"));
  try {
    const mkPw = (dir, tag) => {
      const d = path.join(dir, "node_modules", "playwright");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0", main: "index.js" }));
      fs.writeFileSync(path.join(d, "index.js"), `module.exports = { tag: ${JSON.stringify(tag)} };`);
      return d;
    };
    const a = path.join(root, "a", "deep"), b = path.join(root, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const pa = mkPw(path.join(root, "a"), "A");
    const pb = mkPw(b, "B");
    let r = findPlaywright({ startDirs: [a, b] });
    assert.equal(r.playwright.tag, "A");
    assert.equal(r.packagePath, pa);
    r = findPlaywright({ from: b, startDirs: [a] });
    assert.equal(r.packagePath, pb, "from 優先");
    r = findPlaywright({ startDirs: [path.join(root, "b", "x-missing")] });
    assert.equal(r.packagePath, pb, "往上找");
    assert.throws(() => findPlaywright({ startDirs: [os.tmpdir() + "/__none__"] }), (e) => /找不到 playwright/.test(e.message) && Array.isArray(e.tried));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// notify：非 0 結束碼也要印一行（用假 PATH 讓 osascript／notify-send 回 1）
if (process.platform === "darwin" || process.platform === "linux") {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tqa-notify-"));
  const oldPath = process.env.PATH;
  const warns = [];
  const warn = console.warn;
  try {
    for (const name of ["osascript", "notify-send"]) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    process.env.PATH = bin + path.delimiter + oldPath;
    console.warn = (m) => warns.push(m);
    notify({ notify: true, tool: "shots", name: "r" }, { done: 1, incomplete: 0, fail: 0 });
  } finally {
    console.warn = warn;
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /通知沒發出去：.*結束碼 1/);
}
console.log("config.test 通過");
