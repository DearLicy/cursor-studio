import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousStudioHome = process.env.CURSOR_STUDIO_HOME;
const fixtureHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-prompt-context-"),
);
process.env.CURSOR_STUDIO_HOME = fixtureHome;

const {
  appendAssistantWithTools,
  appendHistory,
  appendHistoryPromptContexts,
  clearAllHistory,
  historyAsChatMessages,
  historyMessagesSnapshot,
  pruneCanceledHistoryTurn,
} = await import("../server/backend/forwarder/history.ts");
const { projectConversationCheckpoint } = await import(
  "../server/backend/forwarder/conversation-checkpoint.ts"
);
const { projectConversationState } = await import(
  "../server/backend/forwarder/conversation-state.ts"
);
const { decodeFields } = await import(
  "../server/backend/forwarder/protobuf-wire.ts"
);

try {
  const historyKey = "prompt-context-conversation";
  await appendHistory(
    historyKey,
    "user",
    "Plan the release",
    undefined,
    undefined,
    {
      cursorMessageId: "cursor-user-1",
      turnSequence: 1,
      sourceRequestId: "request-1",
    },
  );

  const initialContexts = [
    {
      source: "structured_state/current_plan",
      message: { role: "user", content: "<current_plan>\nRelease v1\n</current_plan>" },
    },
    {
      source: "structured_state/todo_list",
      message: { role: "user", content: "<todo_list>\n- [pending] ship\n</todo_list>" },
    },
  ];
  assert.equal(
    await appendHistoryPromptContexts(historyKey, "request-1", initialContexts),
    2,
  );
  assert.equal(
    await appendHistoryPromptContexts(historyKey, "request-1", initialContexts),
    0,
    "the same source/hash must be persisted once per turn",
  );
  assert.equal(
    await appendHistoryPromptContexts(historyKey, "request-1", [{
      source: "structured_state/current_plan",
      message: { role: "user", content: "<current_plan>\nRelease v2\n</current_plan>" },
    }]),
    1,
    "a changed context from the same source must remain as the latest projection",
  );

  let snapshot = await historyMessagesSnapshot(historyKey);
  const contexts = snapshot.filter((message) => message.promptContextSource);
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every((message) => message.turnSequence === 1));
  assert.ok(contexts.every((message) => message.sourceRequestId === "request-1"));

  const checkpoint = projectConversationCheckpoint({
    messages: snapshot,
    usedTokens: 100,
    maxTokens: 200_000,
  });
  assert.equal(
    decodeFields(checkpoint).filter((field) => field.field === 8).length,
    1,
    "prompt contexts must not create synthetic Cursor turns",
  );
  assert.equal(
    decodeFields(checkpoint).filter((field) => field.field === 1).length,
    4,
    "prompt contexts remain available in root provider replay",
  );
  const rootReplay = projectConversationState(checkpoint);
  assert.equal(
    rootReplay.turnCount,
    1,
    "root replay must not count prompt contexts as user turns",
  );
  assert.equal(
    rootReplay.messages.filter((message) => message.promptContextSource).length,
    3,
    "root replay must preserve prompt-context identity",
  );

  await appendAssistantWithTools(
    historyKey,
    "I started the release plan.",
    undefined,
    undefined,
    { sourceRequestId: "request-1" },
  );
  const canceled = await pruneCanceledHistoryTurn(
    historyKey,
    "request-1",
    "client_cancel",
  );
  assert.equal(canceled.replayPolicy, "keep_stable_input");
  snapshot = await historyMessagesSnapshot(historyKey);
  assert.deepEqual(
    snapshot.map((message) => message.role),
    ["user", "user", "user", "user"],
  );
  assert.equal(
    (await historyAsChatMessages(historyKey)).some(
      (message) => message.role === "assistant",
    ),
    false,
  );

  await appendHistory(
    historyKey,
    "user",
    "Superseded request",
    undefined,
    undefined,
    {
      cursorMessageId: "cursor-user-2",
      turnSequence: 2,
      sourceRequestId: "request-2",
    },
  );
  await appendHistoryPromptContexts(historyKey, "request-2", [{
    source: "active_mode_contract",
    message: { role: "user", content: "<system_reminder>agent</system_reminder>" },
  }]);
  const superseded = await pruneCanceledHistoryTurn(
    historyKey,
    "request-2",
    "superseded_by_newer_request",
  );
  assert.equal(superseded.replayPolicy, "drop_unstarted_turn");
  snapshot = await historyMessagesSnapshot(historyKey);
  assert.equal(
    snapshot.some((message) => message.sourceRequestId === "request-2"),
    false,
    "an unstarted superseded turn and its prompt contexts must be removed together",
  );

  console.log("PASS smoke-prompt-context");
} finally {
  await clearAllHistory().catch(() => undefined);
  process.env.CURSOR_STUDIO_HOME = previousStudioHome;
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
