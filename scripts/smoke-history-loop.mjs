import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-history-loop-"));
process.env.CURSOR_STUDIO_HOME = tempHome;

const {
  appendAssistantWithTools,
  appendHistory,
  appendToolResult,
  beginHistoryLoop,
  finishHistoryLoop,
  historyLoopSnapshot,
  historyMessagesSnapshot,
} = await import("../server/backend/forwarder/history.ts");

const historyFile = (key) => path.join(tempHome, "history", "turns", `${key}.json`);
const toolCall = (id) => ({
  id,
  type: "function",
  function: { name: "fixture_tool", arguments: "{}" },
});

try {
  const key = "loop-state-conversation";
  const requestId = "loop-state-request";
  let loop = await beginHistoryLoop(key, requestId);
  assert.equal(loop.currentLoopStatus, "running");
  assert.equal(loop.currentTurnSequence, 1);
  assert.equal(loop.currentLoopId, `1:${requestId}`);

  const metadata = { sourceRequestId: requestId, turnSequence: 1 };
  await appendHistory(key, "user", "run two tools", undefined, undefined, metadata);
  await appendAssistantWithTools(
    key,
    "",
    [toolCall("tool-a"), toolCall("tool-b")],
    undefined,
    metadata,
  );
  loop = await historyLoopSnapshot(key);
  assert.equal(loop.currentLoopStatus, "waiting_tool");

  await appendToolResult(key, "tool-a", "fixture_tool", "first", metadata);
  loop = await historyLoopSnapshot(key);
  assert.equal(loop.currentLoopStatus, "waiting_tool");

  await appendToolResult(key, "tool-b", "fixture_tool", "second", metadata);
  loop = await historyLoopSnapshot(key);
  assert.equal(loop.currentLoopStatus, "running");

  assert.equal(await finishHistoryLoop(key, requestId, "completed"), true);
  loop = await historyLoopSnapshot(key);
  assert.equal(loop.currentLoopStatus, "completed");

  const persisted = JSON.parse(await fs.readFile(historyFile(key), "utf8"));
  assert.equal(persisted.currentLoopStatus, "completed");
  assert.equal(persisted.currentRequestId, requestId);
  assert.equal(persisted.currentTurnSequence, 1);
  assert.equal(persisted.currentLoopId, `1:${requestId}`);
  assert.deepEqual(
    persisted.loopEvents.map((event) => event.kind),
    [
      "run_request",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "turn_completed",
    ],
  );

  const errorKey = "provider-error-conversation";
  const errorRequestId = "provider-error-request";
  const errorLoop = await beginHistoryLoop(errorKey, errorRequestId);
  const errorMetadata = {
    sourceRequestId: errorRequestId,
    turnSequence: errorLoop.currentTurnSequence,
  };
  await appendHistory(errorKey, "user", "retry me", undefined, undefined, errorMetadata);
  await appendAssistantWithTools(
    errorKey,
    "partial output remains visible",
    undefined,
    undefined,
    errorMetadata,
  );
  assert.equal(
    await finishHistoryLoop(errorKey, errorRequestId, "provider_error"),
    true,
  );
  const providerErrorLoop = await historyLoopSnapshot(errorKey);
  assert.equal(providerErrorLoop.currentLoopStatus, "provider_error");
  assert.equal(
    (await historyMessagesSnapshot(errorKey)).at(-1)?.content,
    "partial output remains visible",
  );

  const missing = await historyLoopSnapshot("missing-conversation");
  assert.equal(missing.found, false);
  assert.equal(missing.readable, false);

  const corruptKey = "corrupt-conversation";
  await fs.mkdir(path.dirname(historyFile(corruptKey)), { recursive: true });
  await fs.writeFile(historyFile(corruptKey), "{broken", "utf8");
  const corrupt = await historyLoopSnapshot(corruptKey);
  assert.equal(corrupt.found, true);
  assert.equal(corrupt.readable, false);

  console.log("PASS smoke-history-loop");
} finally {
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
