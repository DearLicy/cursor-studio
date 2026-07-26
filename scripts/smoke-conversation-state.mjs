import assert from "node:assert/strict";
import {
  projectConversationState,
  projectConversationStateToChatMessages,
  projectConversationTurns,
} from "../server/backend/forwarder/conversation-state.ts";
import { ToolCallField } from "../server/backend/forwarder/agent-proto.ts";
import {
  concatMessages,
  encodeBool,
  encodeInt64,
  encodeMessage,
  encodeString,
  encodeUint32,
} from "../server/backend/forwarder/protobuf-wire.ts";

function encodeAssistantStep(text) {
  return encodeMessage(1, encodeString(1, text));
}

function encodeThinkingStep(text) {
  return encodeMessage(3, encodeString(1, text));
}

function encodeShellToolStep() {
  const args = concatMessages(
    encodeString(1, "dir"),
    encodeString(2, "C:\\workspace"),
    encodeString(4, "shell-call-1"),
  );
  const success = concatMessages(
    encodeString(1, "dir"),
    encodeString(5, "README.md\npackage.json"),
  );
  const result = encodeMessage(1, success);
  const shell = concatMessages(encodeMessage(1, args), encodeMessage(2, result));
  return encodeMessage(2, encodeMessage(ToolCallField.shell_tool_call, shell));
}

function encodeAgentTurn({ user, userMessageId, steps, requestId }) {
  const body = concatMessages(
    user
      ? encodeMessage(
          1,
          concatMessages(encodeString(1, user), encodeString(2, userMessageId || "")),
        )
      : Buffer.alloc(0),
    ...steps.map((step) => encodeMessage(2, step)),
    requestId ? encodeString(3, requestId) : Buffer.alloc(0),
  );
  return encodeMessage(1, body);
}

function encodeState(turns) {
  return concatMessages(...turns.map((turn) => encodeMessage(8, turn)));
}

const validTurn = encodeAgentTurn({
  user: "Inspect this workspace",
  userMessageId: "cursor-user-message-1",
  steps: [
    encodeAssistantStep("I will inspect the workspace."),
    encodeThinkingStep("I should list the files first."),
    encodeShellToolStep(),
  ],
  requestId: "request-state-1",
});

const state = encodeState([
  validTurn,
  Buffer.from([0x80]),
  encodeMessage(2, Buffer.alloc(0)),
]);

const projection = projectConversationState(state, { includeThinking: true });
assert.equal(projection.turnCount, 3);
assert.equal(projection.decodedTurns, 1);
assert.equal(projection.skippedTurns, 2);
assert.equal(projection.messages[0]?.role, "user");
assert.equal(projection.messages[0]?.content, "Inspect this workspace");
assert.equal(projection.messages[0]?.cursorMessageId, "cursor-user-message-1");
assert.equal(projection.messages[0]?.turnSequence, 1);
assert.equal(projection.messages[0]?.sourceRequestId, "request-state-1");
assert.equal(projection.messages[1]?.role, "assistant");
assert.equal(projection.messages[1]?.content, "I will inspect the workspace.");
assert.equal(projection.messages[2]?.role, "assistant");
assert.match(projection.messages[2]?.content || "", /<thinking>/);

const assistantTool = projection.messages.find(
  (message) => message.role === "assistant" && "tool_calls" in message,
);
assert.ok(assistantTool && "tool_calls" in assistantTool);
assert.equal(assistantTool.tool_calls?.[0]?.id, "shell-call-1");
assert.equal(assistantTool.tool_calls?.[0]?.function.name, "Shell");
assert.equal(assistantTool.turnSequence, 1);
assert.deepEqual(JSON.parse(assistantTool.tool_calls?.[0]?.function.arguments || "{}"), {
  command: "dir",
  working_directory: "C:\\workspace",
});

const toolResult = projection.messages.find((message) => message.role === "tool");
assert.equal(toolResult?.tool_call_id, "shell-call-1");
assert.equal(toolResult?.name, "Shell");
assert.equal(toolResult?.turnSequence, 1);
assert.equal(toolResult?.sourceRequestId, "request-state-1");
assert.match(toolResult?.content || "", /README\.md/);
assert.ok(projection.diagnostics.some((item) => item.code === "invalid_turn"));
assert.ok(projection.diagnostics.some((item) => item.code === "unsupported_turn"));

const defaultProjection = projectConversationState(state);
assert.equal(defaultProjection.messages.some((message) => /<thinking>/.test(message.content)), false);
assert.equal(projectConversationTurns([validTurn]).messages.length, 4);
assert.equal(projectConversationStateToChatMessages(encodeState([validTurn])).length, 4);

const todo = concatMessages(
  encodeString(1, "todo-1"),
  encodeString(2, "Preserve checkpoint state"),
  encodeUint32(3, 2),
  encodeInt64(4, 1234),
  encodeInt64(5, 5678),
  encodeString(6, "dependency-1"),
);
const phaseTodo = concatMessages(
  encodeString(1, "todo-2"),
  encodeString(2, "Verify plan rendering"),
  encodeUint32(3, 1),
);
const createPlanArgs = concatMessages(
  encodeString(1, "# Checkpoint plan"),
  encodeMessage(2, todo),
  encodeString(3, "Structured checkpoint state"),
  encodeString(4, "Checkpoint plan"),
  encodeBool(5, true),
  encodeMessage(6, concatMessages(
    encodeString(1, "Verification"),
    encodeMessage(2, phaseTodo),
  )),
);
const createPlanResult = concatMessages(
  encodeMessage(1, Buffer.alloc(0)),
  encodeString(3, "file:///checkpoint.plan.md"),
);
const createPlanStep = encodeMessage(
  2,
  encodeMessage(
    ToolCallField.create_plan_tool_call,
    concatMessages(
      encodeMessage(1, createPlanArgs),
      encodeMessage(2, createPlanResult),
    ),
  ),
);
const planTurn = encodeAgentTurn({
  user: "Create a plan",
  userMessageId: "cursor-plan-user",
  requestId: "request-plan-1",
  steps: [createPlanStep],
});
const planProjection = projectConversationTurns([planTurn]);
const planCall = planProjection.messages.find(
  (message) => message.role === "assistant" && message.tool_calls?.[0]?.function.name === "CreatePlan",
);
assert(planCall?.tool_calls?.[0]);
const planArgs = JSON.parse(planCall.tool_calls[0].function.arguments);
assert.equal(planArgs.plan, "# Checkpoint plan");
assert.equal(planArgs.is_project, true);
assert.deepEqual(planArgs.todos[0], {
  id: "todo-1",
  content: "Preserve checkpoint state",
  status: 2,
  created_at: 1234,
  updated_at: 5678,
  dependencies: ["dependency-1"],
});
assert.equal(planArgs.phases[0].name, "Verification");
assert.equal(planArgs.phases[0].todos[0].id, "todo-2");
assert.equal(planCall.sourceRequestId, "request-plan-1");

const summarizedState = concatMessages(
  encodeMessage(6, encodeString(1, "Retained decision: keep the current route.")),
  encodeMessage(8, validTurn),
);
const summaryProjection = projectConversationState(summarizedState);
assert.equal(summaryProjection.messages[0]?.role, "system");
assert.match(summaryProjection.messages[0]?.content || "", /Retained decision/);
assert.equal(summaryProjection.messages[0]?.turnSequence, 0);

const rootReplayState = concatMessages(
  encodeString(1, JSON.stringify({ role: "user", content: "Inspect this workspace" })),
  encodeString(1, JSON.stringify({ role: "assistant", content: "ROOT_REPLAY_ASSISTANT" })),
  encodeMessage(8, validTurn),
);
const rootReplayProjection = projectConversationState(rootReplayState, { preferTurns: true });
assert.deepEqual(
  rootReplayProjection.messages.map((message) => message.content),
  [
    "Inspect this workspace",
    "I will inspect the workspace.",
    "",
    "dir\nREADME.md\npackage.json",
  ],
);
assert.equal(rootReplayProjection.turnCount, 1);
assert.equal(rootReplayProjection.skippedTurns, 0);
assert.equal(rootReplayProjection.messages[0]?.cursorMessageId, "cursor-user-message-1");
assert.equal(rootReplayProjection.messages[0]?.sourceRequestId, "request-state-1");
assert.equal(rootReplayProjection.messages[1]?.sourceRequestId, "request-state-1");
assert.equal(
  rootReplayProjection.messages.some((message) => message.content === "ROOT_REPLAY_ASSISTANT"),
  false,
  "committed field 8 turns must win over conflicting field 1 replay",
);

const rootOnlyProjection = projectConversationState(
  concatMessages(
    encodeString(1, JSON.stringify({ role: "user", content: "ROOT_ONLY_USER" })),
    encodeString(1, JSON.stringify({ role: "assistant", content: "ROOT_ONLY_ASSISTANT" })),
  ),
);
assert.deepEqual(
  rootOnlyProjection.messages.map((message) => message.content),
  ["ROOT_ONLY_USER", "ROOT_ONLY_ASSISTANT"],
  "field 1 remains available for first recovery when no turns exist",
);
assert.equal(
  projectConversationState(
    concatMessages(
      encodeString(1, JSON.stringify({ role: "user", content: "STALE_ROOT_USER" })),
      encodeString(1, JSON.stringify({ role: "assistant", content: "STALE_ROOT_ASSISTANT" })),
    ),
    { allowRootReplay: false },
  ).messages.length,
  0,
  "existing local history must disable field 1 fallback",
);

const invalidRootReplay = projectConversationState(
  concatMessages(encodeString(1, "not-json"), encodeMessage(8, validTurn)),
  { preferTurns: true },
);
assert.equal(invalidRootReplay.messages.length, 4);
assert.equal(invalidRootReplay.skippedTurns, 0);
assert.equal(
  invalidRootReplay.diagnostics.some((item) => item.code === "invalid_root_replay"),
  false,
  "an invalid root replay must not hide a valid committed turn",
);

const partialRootReplay = projectConversationState(
  concatMessages(
    encodeString(1, JSON.stringify({ role: "user", content: "Inspect this workspace" })),
    encodeString(1, JSON.stringify({
      role: "assistant",
      content: "This text must not hide a malformed tool call.",
      tool_calls: [{ id: "broken", type: "function", function: { name: "Read" } }],
    })),
    encodeMessage(8, validTurn),
  ),
  { preferTurns: true },
);
assert.equal(partialRootReplay.messages.length, 4);
assert.equal(partialRootReplay.skippedTurns, 0);
assert.equal(
  partialRootReplay.diagnostics.some((item) => item.code === "invalid_root_replay"),
  false,
  "a partial root replay must not hide a valid committed turn",
);

const invalidRootOnly = projectConversationState(encodeString(1, "not-json"));
assert.equal(invalidRootOnly.messages.length, 0);
assert.ok(invalidRootOnly.skippedTurns > 0);
assert.ok(
  invalidRootOnly.diagnostics.some((item) => item.code === "invalid_root_replay"),
);

const todoReminder = [
  "<system_reminder>",
  "You are currently under the todo section, be sure to track tasks and do not forget to update.",
  "</system_reminder>",
].join("\n");
const editReminder = [
  "<system_reminder>",
  "You recently successfully edited README.md.",
  "The latest source of truth is the most recent successful edit.",
  "</system_reminder>",
].join("\n");
const filteredRootReplay = projectConversationState(
  concatMessages(
    encodeString(1, JSON.stringify({ role: "user", content: todoReminder })),
    encodeString(1, JSON.stringify({ role: "user", content: editReminder })),
    encodeString(1, JSON.stringify({ role: "user", content: "VISIBLE_ROOT_USER" })),
    encodeString(1, JSON.stringify({ role: "assistant", content: "VISIBLE_ROOT_ASSISTANT" })),
  ),
);
assert.deepEqual(
  filteredRootReplay.messages.map((message) => message.content),
  ["VISIBLE_ROOT_USER", "VISIBLE_ROOT_ASSISTANT"],
  "internal prompt reminders must not become visible conversation turns",
);

console.log("PASS smoke-conversation-state", {
  messages: projection.messages.length,
  diagnostics: projection.diagnostics.length,
});
