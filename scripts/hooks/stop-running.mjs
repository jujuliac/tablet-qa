// Stop hook（選用）：Claude 要結束回覆時，如果還有 tablet-qa 的背景量測在跑，提醒一次
// 讀 stdin JSON；任何錯誤都 exit 0，不擋
// 2.1.317 實測：background_tasks 每筆 {id, type:"shell", status:"running", description, command}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  const raw = fs.readFileSync(0, "utf8");
  const base = path.join(os.tmpdir(), "tablet-qa-hook");
  if (process.env.TABLET_QA_HOOK_DEBUG === "1") {
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(path.join(base, "last-stdin.json"), raw + "\n");
  }
  const input = JSON.parse(raw);
  if (input.stop_hook_active === true) process.exit(0);
  const RUNNING = ["running", "pending", "in_progress"];
  // 資料夾名以 tablet-qa 開頭即可（GitHub zip 解開的 tablet-qa-main 也算）
  const RE = /tablet-qa[^\\/]*[\\/]scripts[\\/](shots|sweep)\.mjs/;
  const tasks = (Array.isArray(input.background_tasks) ? input.background_tasks : []).filter(
    (t) => t && ["shell", "local_bash"].includes(t.type) && RUNNING.includes(t.status) && RE.test(String(t.command || ""))
  );
  const sid = String(input.session_id || "no-session").replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = path.join(base, sid);
  const fresh = [];
  for (const t of tasks) {
    const id = String(t.id ?? t.task_id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
    if (!id) continue;
    const mark = path.join(dir, id);
    if (fs.existsSync(mark)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mark, "");
    fresh.push(String(t.command).slice(0, 100));
  }
  if (fresh.length) {
    const reason = `背景量測還在跑：${fresh.join("\n")}。請在回覆裡告訴使用者：還在跑、大約還要幾分鐘（可看 <run>/progress.jsonl 的筆數和 run-meta.json 的 expected）、跑完會再回報；這個對話關掉，量測會被中止。說完就結束回覆，不要等。`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
} catch {}
process.exit(0);
