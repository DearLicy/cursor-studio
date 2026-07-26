/**
 * Local agent-tool compatibility smoke tests. No provider or Cursor client is required.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool } from "../server/backend/forwarder/tool-exec.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestId = `local-tools-smoke-${Date.now()}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function invocation(id, name, args) {
  return { id, name, arguments: JSON.stringify(args) };
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(root, ".local-tools-smoke-"));
  const relative = (file) => path.relative(root, file);

  try {
    const editable = path.join(fixture, "editable.txt");
    await fs.writeFile(editable, "first\nsecond\n", "utf8");
    const patched = await executeTool(
      invocation("patch-success", "PatchEdit", {
        path: relative(editable),
        old_string: "second",
        new_string: "third",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(patched.ok, `PatchEdit success failed: ${patched.content}`);
    assert(JSON.parse(patched.content).replacements === 1, "PatchEdit replacement count missing");
    assert((await fs.readFile(editable, "utf8")).includes("third"), "PatchEdit did not write replacement");

    const duplicate = path.join(fixture, "duplicate.txt");
    await fs.writeFile(duplicate, "repeat\nrepeat\n", "utf8");
    const duplicateResult = await executeTool(
      invocation("patch-duplicate", "PatchEdit", {
        path: relative(duplicate),
        old_string: "repeat",
        new_string: "updated",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(!duplicateResult.ok, "PatchEdit duplicate match should fail");
    assert(JSON.parse(duplicateResult.content).ok === false, "PatchEdit duplicate should be structured");

    const patchEscape = await executeTool(
      invocation("patch-escape", "PatchEdit", {
        path: "..\\outside-of-workspace.txt",
        old_string: "before",
        new_string: "after",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(!patchEscape.ok, "PatchEdit workspace escape should fail");
    assert(JSON.parse(patchEscape.content).ok === false, "PatchEdit escape should be structured");

    const escaped = await executeTool(
      invocation("escape", "Read", { path: "..\\outside-of-workspace.txt" }),
      { workspaceRoot: root, requestId },
    );
    assert(!escaped.ok && /workspace/i.test(escaped.content), "workspace escape was not rejected");

    const lints = await executeTool(
      invocation("lints", "ReadLints", { paths: [relative(editable)] }),
      { workspaceRoot: root, requestId },
    );
    assert(lints.ok, `ReadLints failed: ${lints.content}`);
    const lintPayload = JSON.parse(lints.content);
    assert(Array.isArray(lintPayload.diagnostics), "ReadLints should return a diagnostics array");

    const stdinShell = await executeTool(
      invocation("stdin-shell", "Shell", {
        command:
          process.platform === "win32"
            ? "powershell -NoProfile -EncodedCommand JAB2AGEAbAB1AGUAIAA9ACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AEkAbgAuAFIAZQBhAGQATABpAG4AZQAoACkAOwAgAFcAcgBpAHQAZQAtAE8AdQB0AHAAdQB0ACAAKAAiAHIAZQBjAGUAaQB2AGUAZAA6ACIAIAArACAAJAB2AGEAbAB1AGUAKQA="
            : "read value; echo received:$value",
        block_until_ms: 0,
      }),
      { workspaceRoot: root, requestId },
    );
    assert(stdinShell.ok, `stdin Shell failed: ${stdinShell.content}`);
    const stdinShellPayload = JSON.parse(stdinShell.content);
    const wroteStdin = await executeTool(
      invocation("stdin-write", "WriteShellStdin", {
        shell_id: stdinShellPayload.shell_id,
        chars: process.platform === "win32" ? "studio\r\n" : "studio\n",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(wroteStdin.ok, `WriteShellStdin failed: ${wroteStdin.content}`);
    const stdinAwait = await executeTool(
      invocation("stdin-await", "AwaitShell", {
        shell_id: stdinShellPayload.shell_id,
        block_until_ms: 15_000,
        pattern: "received:studio",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(stdinAwait.ok, `AwaitShell after stdin failed: ${stdinAwait.content}`);
    assert(/received:studio/i.test(stdinAwait.content), "stdin was not received by the background shell");

    const forcePromise = executeTool(
      invocation("force-shell", "Shell", {
        command:
          process.platform === "win32"
            ? "ping -n 3 127.0.0.1 >nul & echo force-complete"
            : "sleep 2; echo force-complete",
        block_until_ms: 30_000,
      }),
      { workspaceRoot: root, requestId },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const forced = await executeTool(
      invocation("force-request", "ForceBackgroundShell", { tool_call_id: "force-shell" }),
      { workspaceRoot: root, requestId },
    );
    assert(forced.ok, `ForceBackgroundShell failed: ${forced.content}`);
    const forcedShell = await forcePromise;
    assert(forcedShell.ok, `forced Shell failed: ${forcedShell.content}`);
    const forcedPayload = JSON.parse(forcedShell.content);
    assert(forcedPayload.forced_background, "Shell did not return after ForceBackgroundShell");

    const forcedDone = await executeTool(
      invocation("force-await", "AwaitShell", {
        shell_id: forcedPayload.shell_id,
        block_until_ms: 15_000,
        pattern: "force-complete",
      }),
      { workspaceRoot: root, requestId },
    );
    assert(forcedDone.ok && /force-complete/i.test(forcedDone.content), "forced shell did not complete");

    const failedShell = await executeTool(
      invocation("shell-failure", "Shell", {
        command: process.platform === "win32" ? "exit /b 7" : "exit 7",
        block_until_ms: 10_000,
      }),
      { workspaceRoot: root, requestId },
    );
    assert(!failedShell.ok, "non-zero Shell result should fail");
    assert(JSON.parse(failedShell.content).ok === false, "Shell failure should be structured");

    console.log("PASS smoke-local-tools");
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
