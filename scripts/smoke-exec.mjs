/**
 * 确定性 tool-exec 冒烟：不依赖供应商模型。
 * 覆盖 Read / Shell 前台 / Shell 后台 + AwaitShell。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool } from "../server/backend/forwarder/tool-exec.ts";
import { toolsForMode } from "../server/backend/forwarder/tool-catalog.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requestId = `exec-smoke-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const planTools = toolsForMode("plan").map((t) => t.function.name);
  assert(planTools.includes("Read"), "plan should allow Read");
  assert(!planTools.includes("Write"), "plan should not allow Write");
  assert(planTools.includes("AwaitShell"), "plan should allow AwaitShell");

  const agentTools = toolsForMode("agent").map((t) => t.function.name);
  assert(agentTools.includes("Write"), "agent should allow Write");
  assert(agentTools.includes("AwaitShell"), "agent should allow AwaitShell");

  const read = await executeTool(
    {
      id: "c1",
      name: "Read",
      arguments: JSON.stringify({
        path: path.join(root, "package.json"),
        limit: 5,
      }),
    },
    { workspaceRoot: root, requestId },
  );
  assert(read.ok, `Read failed: ${read.content}`);
  assert(/cursor-studio/.test(read.content), "Read should see package name");
  console.log("Read ok");

  const shellFg = await executeTool(
    {
      id: "c2",
      name: "Shell",
      arguments: JSON.stringify({
        command: "echo studio-exec-ok",
        block_until_ms: 10000,
      }),
    },
    { workspaceRoot: root, requestId },
  );
  assert(shellFg.ok, `Shell fg failed: ${shellFg.content}`);
  assert(/studio-exec-ok/i.test(shellFg.content), "Shell fg missing marker");
  console.log("Shell foreground ok");

  const shellBg = await executeTool(
    {
      id: "c3",
      name: "Shell",
      arguments: JSON.stringify({
        command:
          process.platform === "win32"
            ? "ping -n 2 127.0.0.1 >nul & echo bg-done"
            : "sleep 1; echo bg-done",
        block_until_ms: 0,
      }),
    },
    { workspaceRoot: root, requestId },
  );
  assert(shellBg.ok, `Shell bg failed: ${shellBg.content}`);
  const bg = JSON.parse(shellBg.content);
  assert(bg.shell_id, "background shell_id missing");
  console.log("Shell background ok", bg.shell_id);

  const awaitRes = await executeTool(
    {
      id: "c4",
      name: "AwaitShell",
      arguments: JSON.stringify({
        shell_id: bg.shell_id,
        block_until_ms: 15000,
        pattern: "bg-done",
      }),
    },
    { workspaceRoot: root, requestId },
  );
  assert(awaitRes.ok, `AwaitShell failed: ${awaitRes.content}`);
  const snap = JSON.parse(awaitRes.content);
  assert(
    snap.matched ||
      /bg-done/i.test(String(snap.stdout || "") + String(snap.stderr || "")),
    `AwaitShell did not see bg-done: ${awaitRes.content}`,
  );
  console.log("AwaitShell ok", { status: snap.status, matched: snap.matched });

  console.log("PASS smoke-exec");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});