import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousStudioHome = process.env.CURSOR_STUDIO_HOME;
const fixtureHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-history-rewind-"),
);
process.env.CURSOR_STUDIO_HOME = fixtureHome;

const {
  appendHistory,
  clearAllHistory,
  historyAsChatMessages,
  loadHistory,
  reconcileHistoryFromCursorState,
  replaceHistoryMessages,
  rewindHistoryToUserMessage,
} = await import("../server/backend/forwarder/history.ts");

const historyKey = "conversation-rewind";

try {
  await appendHistory(
    historyKey,
    "user",
    "first request",
    undefined,
    undefined,
    { cursorMessageId: "message-first", sourceRequestId: "request-a" },
  );
  await appendHistory(historyKey, "assistant", "first answer");
  await appendHistory(
    historyKey,
    "user",
    "discarded branch",
    undefined,
    undefined,
    { cursorMessageId: "message-branch", sourceRequestId: "request-b" },
  );
  await appendHistory(historyKey, "assistant", "discarded answer");

  const rewind = await rewindHistoryToUserMessage(historyKey, "message-branch", 1);
  assert.equal(rewind.applied, true);
  assert.equal(rewind.droppedMessages, 2);
  assert.deepEqual(await historyAsChatMessages(historyKey), [
    { role: "user", content: "first request" },
    { role: "assistant", content: "first answer" },
  ]);

  await appendHistory(
    historyKey,
    "user",
    "replacement branch",
    undefined,
    undefined,
    { cursorMessageId: "message-branch", sourceRequestId: "request-c" },
  );
  await appendHistory(historyKey, "assistant", "replacement answer");
  assert.deepEqual(await historyAsChatMessages(historyKey), [
    { role: "user", content: "first request" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "replacement branch" },
    { role: "assistant", content: "replacement answer" },
  ]);

  await replaceHistoryMessages(historyKey, [
    { role: "system", content: "summary" },
    { role: "user", content: "replacement branch" },
    { role: "assistant", content: "replacement answer" },
  ]);
  const persisted = await loadHistory(historyKey);
  assert.equal(persisted.messages[1].cursorMessageId, "message-branch");
  assert.deepEqual(await historyAsChatMessages(historyKey), [
    { role: "system", content: "summary" },
    { role: "user", content: "replacement branch" },
    { role: "assistant", content: "replacement answer" },
  ]);

  const beforeNoop = await historyAsChatMessages(historyKey);
  const missing = await rewindHistoryToUserMessage(historyKey, "missing-message", 1);
  assert.equal(missing.applied, false);
  assert.equal(missing.droppedMessages, 0);
  const mismatchedTurn = await rewindHistoryToUserMessage(historyKey, "message-branch", 99);
  assert.equal(mismatchedTurn.applied, false);
  assert.equal(mismatchedTurn.droppedMessages, 0);
  assert.deepEqual(await historyAsChatMessages(historyKey), beforeNoop);

  await appendHistory(
    historyKey,
    "user",
    "active tail",
    undefined,
    undefined,
    { cursorMessageId: "active-tail-message", sourceRequestId: "request-d" },
  );
  const activeTail = await rewindHistoryToUserMessage(historyKey, "active-tail-message", 2);
  assert.equal(activeTail.applied, false);
  assert.equal(activeTail.droppedMessages, 0);

  const cursorStateKey = "cursor-state-reconcile";
  const projectedState = [
    {
      role: "user",
      content: "Cursor persisted request",
      cursorMessageId: "cursor-state-user",
      turnSequence: 1,
    },
    { role: "assistant", content: "Cursor persisted answer", turnSequence: 1 },
  ];
  const reconciled = await reconcileHistoryFromCursorState(cursorStateKey, projectedState);
  assert.equal(reconciled.applied, true);
  const reconciledHistory = await loadHistory(cursorStateKey);
  assert.equal(reconciledHistory.messages[0]?.cursorMessageId, "cursor-state-user");
  assert.equal(reconciledHistory.messages[0]?.turnSequence, 1);
  assert.deepEqual(await historyAsChatMessages(cursorStateKey), [
    { role: "user", content: "Cursor persisted request" },
    { role: "assistant", content: "Cursor persisted answer" },
  ]);
  const repeatedReconciliation = await reconcileHistoryFromCursorState(
    cursorStateKey,
    [
      {
        role: "system",
        content: "Partial summary that must not replace canonical history",
        turnSequence: 0,
      },
    ],
  );
  assert.equal(repeatedReconciliation.applied, false);
  assert.deepEqual(await historyAsChatMessages(cursorStateKey), [
    { role: "user", content: "Cursor persisted request" },
    { role: "assistant", content: "Cursor persisted answer" },
  ]);

  const mergedReconciliation = await reconcileHistoryFromCursorState(
    cursorStateKey,
    [
      {
        role: "user",
        content: "Earlier Cursor request",
        cursorMessageId: "cursor-state-earlier",
        turnSequence: 1,
        sourceRequestId: "cursor-request-earlier",
      },
      {
        role: "assistant",
        content: "Earlier Cursor answer",
        turnSequence: 1,
        sourceRequestId: "cursor-request-earlier",
      },
      {
        role: "user",
        content: "Cursor persisted request",
        cursorMessageId: "cursor-state-user",
        turnSequence: 2,
        sourceRequestId: "cursor-request-current",
      },
    ],
  );
  assert.equal(mergedReconciliation.applied, true);
  const mergedHistory = await loadHistory(cursorStateKey);
  assert.deepEqual(
    mergedHistory.messages.filter((message) => message.role === "user").map((message) => ({
      id: message.cursorMessageId,
      turn: message.turnSequence,
    })),
    [
      { id: "cursor-state-earlier", turn: 1 },
      { id: "cursor-state-user", turn: 2 },
    ],
  );
  assert.deepEqual(await historyAsChatMessages(cursorStateKey), [
    { role: "user", content: "Earlier Cursor request" },
    { role: "assistant", content: "Earlier Cursor answer" },
    { role: "user", content: "Cursor persisted request" },
    { role: "assistant", content: "Cursor persisted answer" },
  ]);

  console.log("history rewind smoke passed");
} finally {
  await clearAllHistory();
  if (previousStudioHome == null) delete process.env.CURSOR_STUDIO_HOME;
  else process.env.CURSOR_STUDIO_HOME = previousStudioHome;
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
