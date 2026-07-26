import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerMode = process.argv.includes("--history-persistence-worker");
const scriptPath = fileURLToPath(import.meta.url);

if (workerMode) {
  const { appendHistory } = await import("../server/backend/forwarder/history.ts");
  await appendHistory(
    process.env.HISTORY_PERSISTENCE_REQUEST,
    "user",
    process.env.HISTORY_PERSISTENCE_CONTENT,
  );
  process.exit(0);
}

const previousStudioHome = process.env.CURSOR_STUDIO_HOME;
const fixtureHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-history-persistence-"),
);
process.env.CURSOR_STUDIO_HOME = fixtureHome;

const { appendHistory, clearAllHistory, historyAsChatMessages } = await import(
  "../server/backend/forwarder/history.ts"
);

function runWorker(requestId, content) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, "--history-persistence-worker"],
      {
        env: {
          ...process.env,
          CURSOR_STUDIO_HOME: fixtureHome,
          HISTORY_PERSISTENCE_REQUEST: requestId,
          HISTORY_PERSISTENCE_CONTENT: content,
        },
        stdio: process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1" ? "inherit" : "ignore",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`history worker exited with ${code}`));
    });
  });
}

try {
  const turnDir = path.join(fixtureHome, "history", "turns");
  await fs.mkdir(turnDir, { recursive: true });

  // A previous process can die while holding the file lock. The next writer
  // must reclaim it rather than leave the conversation permanently blocked.
  const staleLock = path.join(turnDir, ".history-write.lock");
  await fs.writeFile(staleLock, '{"owner":"dead-process"}\n', "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(staleLock, old, old);
  await appendHistory("stale-lock", "user", "recovered after crash");
  assert.equal(await fs.stat(staleLock).then(() => true, () => false), false);

  const requestId = "shared-conversation";
  const contents = Array.from({ length: 20 }, (_, index) => `worker message ${index}`);
  await Promise.all(contents.map((content) => runWorker(requestId, content)));
  const concurrent = await historyAsChatMessages(requestId);
  assert.equal(
    concurrent.length,
    contents.length,
    `missing messages: ${JSON.stringify(concurrent.map((message) => message.content).sort())}`,
  );
  assert.deepEqual(
    concurrent.map((message) => message.content).sort(),
    [...contents].sort(),
  );

  // Atomic writes plus a sidecar recover the last valid generation when a
  // primary snapshot is unreadable after an abrupt interruption.
  const recoveryId = "interrupted-primary";
  const primary = path.join(turnDir, `${recoveryId}.json`);
  const backup = `${primary}.bak`;
  await fs.writeFile(primary, "{truncated", "utf8");
  await fs.writeFile(
    backup,
    JSON.stringify({
      requestId: recoveryId,
      messages: [{ role: "user", content: "preserved turn" }],
      updatedAt: Date.now() - 1,
    }),
    "utf8",
  );
  await appendHistory(recoveryId, "assistant", "recovered continuation");
  assert.deepEqual(await historyAsChatMessages(recoveryId), [
    { role: "user", content: "preserved turn" },
    { role: "assistant", content: "recovered continuation" },
  ]);
  const repaired = JSON.parse(await fs.readFile(primary, "utf8"));
  assert.equal(repaired.messages.length, 2);

  console.log("PASS smoke-history-persistence");
} finally {
  await clearAllHistory();
  if (previousStudioHome == null) delete process.env.CURSOR_STUDIO_HOME;
  else process.env.CURSOR_STUDIO_HOME = previousStudioHome;
  await fs.rm(fixtureHome, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 50,
  });
}
