import assert from "node:assert/strict";
import {
  projectConversationCheckpoint,
  projectStructuredRuntimeState,
  sanitizeCreatePlanToolCallsForState,
  structuredRuntimePromptMessages,
} from "../server/backend/forwarder/conversation-checkpoint.ts";
import { projectConversationState } from "../server/backend/forwarder/conversation-state.ts";
import {
  decodeAgentServerMessage,
  encodeToolCallMessage,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  streamEventToMessage,
  streamEventToProto,
} from "../server/backend/forwarder/stream-writer.ts";
import {
  executeTool,
  synchronizeTodoState,
} from "../server/backend/forwarder/tool-exec.ts";
import {
  concatMessages,
  decodeFields,
  encodeKey,
  encodeMessage,
  encodeString,
  encodeUint32,
  encodeVarint,
  firstBytes,
  firstString,
  firstVarint,
} from "../server/backend/forwarder/protobuf-wire.ts";

function fixed64Field(field, hex) {
  return Buffer.concat([encodeKey(field, 1), Buffer.from(hex, "hex")]);
}

function fixed32Field(field, value) {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(value, 0);
  return Buffer.concat([encodeKey(field, 5), body]);
}

function encodeAssistantStep(text) {
  return encodeMessage(1, encodeString(1, text));
}

function checkpointAgentTurns(state) {
  return decodeFields(state)
    .filter((field) => field.field === 8 && field.bytes)
    .map((field) => decodeFields(firstBytes(decodeFields(field.bytes), 1)));
}

const preservedUserMessage = concatMessages(
  encodeString(1, "Inspect the workspace"),
  encodeString(2, "cursor-user-1"),
  encodeUint32(4, 3),
  encodeString(30, "preserved-selected-context-extension"),
);
const preservedInboundTurn = encodeMessage(
  1,
  concatMessages(
    encodeMessage(1, preservedUserMessage),
    encodeMessage(2, encodeAssistantStep("I will inspect it.")),
    encodeMessage(2, encodeMessage(2, encodeToolCallMessage({
      name: "Shell",
      args: {
        command: "dir",
        working_directory: "C:\\workspace",
        tool_call_id: "stale-inbound-shell",
      },
      resultText: "stale shell result",
      ok: true,
    }))),
    encodeString(3, "request-turn-1"),
    encodeString(4, "preserved-encrypted-model"),
  ),
);

const baseState = Buffer.concat([
  encodeString(1, "preserved-root-prompt"),
  encodeMessage(3, concatMessages(encodeString(1, "stale-todo"), encodeString(2, "stale"))),
  encodeString(4, JSON.stringify({ id: "stale", role: "assistant", content: [] })),
  encodeMessage(5, concatMessages(
    encodeUint32(1, 999),
    encodeUint32(2, 999_999),
    encodeMessage(3, encodeString(30, "preserved-token-breakdown")),
  )),
  encodeMessage(6, encodeString(1, "stale-summary")),
  encodeMessage(7, encodeString(1, "stale-plan")),
  encodeMessage(20, concatMessages(
    encodeString(1, "existing-plan"),
    encodeMessage(2, concatMessages(
      encodeString(1, "existing-plan"),
      encodeString(2, "file:///workspace/old.plan.md"),
    )),
  )),
  encodeMessage(8, preservedInboundTurn),
  encodeUint32(10, 2),
  Buffer.concat([encodeKey(30, 0), encodeVarint(987654)]),
  fixed64Field(31, "0102030405060708"),
  encodeMessage(32, Buffer.from("preserved-unknown-bytes")),
  fixed32Field(33, 0xa1b2c3d4),
]);

const messages = [
  {
    role: "system",
    content: [
      "Earlier conversation context was summarized by the selected model.",
      "Treat the following as retained facts and continue consistently:",
      "Retain the selected provider and pending file edit.",
    ].join("\n\n"),
    at: 1,
  },
  {
    role: "user",
    content: "Inspect the workspace",
    cursorMessageId: "cursor-user-1",
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 2,
  },
  {
    role: "assistant",
    content: "I will inspect it.",
    tool_calls: [
      {
        id: "shell-call-1",
        type: "function",
        function: {
          name: "Shell",
          arguments: JSON.stringify({ command: "dir", working_directory: "C:\\workspace" }),
        },
      },
    ],
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 3,
  },
  {
    role: "tool",
    tool_call_id: "shell-call-1",
    name: "Shell",
    content: "README.md\npackage.json",
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 4,
  },
  {
    role: "assistant",
    content: "The workspace is ready.",
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 5,
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "create-plan-completed",
        type: "function",
        function: {
          name: "CreatePlan",
          arguments: JSON.stringify({
            plan: "# Release plan\nShip the checkpoint fix.",
            overview: "Checkpoint recovery",
            name: "Recovery plan",
            is_project: true,
            todos: [
              { id: "todo-direct", content: "Preserve turns", status: "in_progress" },
            ],
            phases: [
              {
                name: "Verification",
                todos: [{ id: "todo-phase", content: "Run protocol smoke tests" }],
              },
            ],
          }),
        },
      },
    ],
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 5.1,
  },
  {
    role: "tool",
    tool_call_id: "create-plan-completed",
    name: "CreatePlan",
    content: JSON.stringify({ plan_uri: "file:///workspace/recovery.plan.md" }),
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 5.2,
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "todo-write-completed",
        type: "function",
        function: {
          name: "TodoWrite",
          arguments: JSON.stringify({
            merge: true,
            todos: [
              { id: "todo-direct", status: "completed" },
              { id: "todo-extra", content: "Verify runtime projection", status: "in_progress" },
            ],
          }),
        },
      },
    ],
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 5.3,
  },
  {
    role: "tool",
    tool_call_id: "todo-write-completed",
    name: "TodoWrite",
    content: JSON.stringify({
      todos: [
        { id: "todo-direct", content: "Preserve turns", status: "completed" },
        { id: "todo-extra", content: "Verify runtime projection", status: "in_progress" },
      ],
    }),
    turnSequence: 11,
    sourceRequestId: "request-turn-1",
    at: 5.4,
  },
  {
    role: "user",
    content: "Open the README",
    contentParts: [
      { type: "text", text: "Open the README" },
      {
        type: "image",
        mimeType: "image/png",
        path: "C:\\workspace\\reference.png",
        dataBase64: "AQID",
      },
    ],
    cursorMessageId: "cursor-user-2",
    turnSequence: 12,
    sourceRequestId: "request-turn-2",
    at: 6,
  },
  {
    role: "assistant",
    content: "README opened.",
    turnSequence: 12,
    sourceRequestId: "request-turn-2",
    at: 7,
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "create-plan-pending",
        type: "function",
        function: {
          name: "CreatePlan",
          arguments: JSON.stringify({ plan: "# Pending plan", todos: [] }),
        },
      },
    ],
    turnSequence: 12,
    sourceRequestId: "request-turn-2",
    at: 8,
  },
];

const activePendingToolCall = JSON.stringify({
  id: "1",
  role: "assistant",
  content: [{
    type: "tool-call",
    toolCallId: "create-plan-pending",
    toolName: "CreatePlan",
    args: { plan: "# Pending plan", todos: [] },
  }],
});

const state = projectConversationCheckpoint({
  messages,
  pendingToolCalls: [activePendingToolCall],
  usedTokens: 12_345,
  maxTokens: 500_000,
  mode: 3,
  baseState,
});
const fields = decodeFields(state);

assert.equal(firstVarint(decodeFields(firstBytes(fields, 5)), 1), 12_345);
assert.equal(firstVarint(decodeFields(firstBytes(fields, 5)), 2), 500_000);
assert.equal(
  firstString(decodeFields(firstBytes(decodeFields(firstBytes(fields, 5)), 3)), 30),
  "preserved-token-breakdown",
);
assert.equal(firstVarint(fields, 10), 3);
assert.equal(fields.filter((field) => field.field === 8).length, 2);
const rootReplay = fields
  .filter((field) => field.field === 1)
  .map((field) => JSON.parse(field.bytes.toString("utf8")));
assert.equal(rootReplay.length, 6);
assert.deepEqual(
  rootReplay.map((message) => message.role),
  ["system", "user", "assistant", "assistant", "user", "assistant"],
);
assert.equal(rootReplay[0].content, messages[0].content);
assert.equal(rootReplay[1].content, "Inspect the workspace");
assert.equal(rootReplay[2].content, "I will inspect it.");
assert.equal(rootReplay[2].tool_calls, undefined);
assert.equal(
  rootReplay.some((message) => message.role === "tool"),
  false,
  "non-persistent tool results must stay out of root replay",
);
assert.deepEqual(rootReplay[4].content_parts, [
  { type: "text", text: "Open the README" },
  {
    type: "image",
    image: {
      mime_type: "image/png",
      path: "C:\\workspace\\reference.png",
      data: "AQID",
    },
  },
]);
assert.ok(!state.includes(Buffer.from("preserved-root-prompt")));
assert.equal(firstVarint(fields, 30), 987654);
assert.equal(fields.find((field) => field.field === 31)?.fixed64?.toString("hex"), "0102030405060708");
assert.equal(firstBytes(fields, 32)?.toString(), "preserved-unknown-bytes");
assert.equal(fields.find((field) => field.field === 33)?.fixed32, 0xa1b2c3d4);
assert.equal(fields.filter((field) => [5, 6, 10].includes(field.field)).length, 3);

const pending = fields.filter((field) => field.field === 4).map((field) => JSON.parse(field.bytes.toString()));
assert.equal(pending.length, 1, "stale pending state must be replaced");
assert.equal(pending[0].content[0].toolCallId, "create-plan-pending");
assert.equal(pending[0].content[0].toolName, "CreatePlan");

const todos = fields.filter((field) => field.field === 3).map((field) => decodeFields(field.bytes));
assert.equal(todos.length, 2);
assert.equal(firstString(todos[0], 1), "todo-direct");
assert.equal(firstString(todos[0], 2), "Preserve turns");
assert.equal(firstVarint(todos[0], 3), 3);
assert.equal(firstString(todos[1], 1), "todo-extra");
assert.equal(firstVarint(todos[1], 3), 2);
assert.equal(firstString(decodeFields(firstBytes(fields, 7)), 1), "# Release plan\nShip the checkpoint fix.");
const planMap = decodeFields(firstBytes(fields, 20));
assert.equal(firstString(planMap, 1), "existing-plan");
assert.equal(firstString(decodeFields(firstBytes(planMap, 2)), 2), "file:///workspace/recovery.plan.md");

const rawTurns = fields.filter((field) => field.field === 8).map((field) => field.bytes);
const firstAgentTurn = decodeFields(firstBytes(decodeFields(rawTurns[0]), 1));
const secondAgentTurn = decodeFields(firstBytes(decodeFields(rawTurns[1]), 1));
assert.equal(firstString(firstAgentTurn, 3), "request-turn-1");
assert.equal(firstString(secondAgentTurn, 3), "request-turn-2");
const projectedRawUser = firstBytes(firstAgentTurn, 1);
assert.equal(
  firstString(decodeFields(projectedRawUser), 30),
  undefined,
  "locally rebuilt turns must not inherit stale inbound user extensions",
);
assert.equal(
  firstString(firstAgentTurn, 4),
  undefined,
  "locally rebuilt turns must not inherit stale inbound turn metadata",
);
const firstTurnSteps = firstAgentTurn.filter(
  (field) => field.field === 2 && field.bytes,
);
assert.equal(firstTurnSteps.length, 2);
assert.equal(
  firstTurnSteps.some((field) => firstBytes(decodeFields(field.bytes), 2)),
  false,
  "raw inbound non-persistent tool steps must be removed from checkpoints",
);

const projection = projectConversationState(state);
assert.equal(projection.turnCount, 2);
assert.equal(projection.decodedTurns, 2);
assert.equal(projection.skippedTurns, 0);
assert.equal(projection.messages[0]?.role, "system");
assert.match(projection.messages[0]?.content || "", /Retain the selected provider/);

const users = projection.messages.filter((message) => message.role === "user");
assert.deepEqual(users.map((message) => message.content), [
  "Inspect the workspace",
  "Open the README",
]);
assert.deepEqual(users.map((message) => message.cursorMessageId), [
  "cursor-user-1",
  "cursor-user-2",
]);
assert.deepEqual(users.map((message) => message.turnSequence), [1, 2]);
assert.deepEqual(users.map((message) => message.sourceRequestId), [
  "request-turn-1",
  "request-turn-2",
]);
assert.deepEqual(
  users[1].contentParts,
  messages.find((message) => message.role === "user" && message.content === "Open the README")?.contentParts,
);

const assistantText = projection.messages
  .filter((message) => message.role === "assistant" && !message.tool_calls?.length)
  .map((message) => message.content);
assert.deepEqual(assistantText, [
  "I will inspect it.",
  "The workspace is ready.",
  "README opened.",
]);

const assistantTool = projection.messages.find(
  (message) => message.role === "assistant" && message.tool_calls?.length,
);
assert.equal(assistantTool, undefined);
const toolResult = projection.messages.find((message) => message.role === "tool");
assert.equal(toolResult, undefined);

const createPlanCalls = projection.messages
  .filter((message) => message.role === "assistant" && message.tool_calls?.[0]?.function.name === "CreatePlan")
  .map((message) => JSON.parse(message.tool_calls[0].function.arguments));
assert.equal(createPlanCalls.length, 0);

assert.ok(fields.some((field) => field.field === 6), "summary field is missing");
assert.ok(fields.some((field) => field.field === 8), "turn fields are missing");
assert.ok(state.length > firstBytes(fields, 5).length + 2, "checkpoint regressed to token-only");

const checkpointEvent = {
  type: "checkpoint",
  usedTokens: 12_345,
  maxTokens: 500_000,
  conversationState: state,
};
const checkpointEnvelope = streamEventToProto(checkpointEvent);
assert.ok(checkpointEnvelope, "checkpoint protobuf envelope is missing");
const emittedState = firstBytes(decodeFields(checkpointEnvelope), 3);
assert.deepEqual(emittedState, state, "connect checkpoint must carry the complete raw state");
const emittedProjection = projectConversationState(emittedState);
assert.equal(emittedProjection.turnCount, 2);
assert.match(
  emittedProjection.messages.map((message) => message.content).join("\n"),
  /README opened/,
);
const decodedEnvelope = decodeAgentServerMessage(checkpointEnvelope);
assert.equal(decodedEnvelope.kind, "conversation_checkpoint");
assert.deepEqual(decodedEnvelope.conversationState, state);

const debugMessage = streamEventToMessage(checkpointEvent);
assert.deepEqual(debugMessage, {
  conversationCheckpointUpdate: {
    tokenDetails: { usedTokens: 12_345, maxTokens: 500_000 },
  },
});

const readTodosHistory = [
  {
    role: "user",
    content: "Show the current tasks",
    turnSequence: 1,
    sourceRequestId: "read-todos-request",
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-todos-completed",
      type: "function",
      function: { name: "ReadTodos", arguments: "{}" },
    }],
    turnSequence: 1,
    sourceRequestId: "read-todos-request",
  },
  {
    role: "tool",
    tool_call_id: "read-todos-completed",
    name: "ReadTodos",
    content: JSON.stringify({
      todos: [{ id: "recovered-todo", content: "Recovered from Cursor", status: "pending" }],
    }),
    turnSequence: 1,
    sourceRequestId: "read-todos-request",
  },
];
const recoveredRuntime = projectStructuredRuntimeState(readTodosHistory);
assert.equal(recoveredRuntime.hasTodos, true);
assert.equal(recoveredRuntime.todos[0]?.id, "recovered-todo");
assert.match(
  structuredRuntimePromptMessages(recoveredRuntime)
    .map((message) => message.content)
    .join("\n"),
  /<todo_list>[\s\S]*recovered-todo/,
);
const recoveredStateFields = decodeFields(projectConversationCheckpoint({
  messages: readTodosHistory,
  usedTokens: 20,
  maxTokens: 200_000,
}));
assert.equal(
  firstString(decodeFields(firstBytes(recoveredStateFields, 3)), 1),
  "recovered-todo",
  "ReadTodos may recover an otherwise missing runtime todo projection",
);

const retryOnlyMessages = [
  {
    role: "user",
    content: "retry me",
    cursorMessageId: "retry-user",
    turnSequence: 1,
    sourceRequestId: "req-original",
    at: 1,
  },
  {
    role: "assistant",
    content: "recovered once",
    turnSequence: 2,
    sourceRequestId: "req-retry",
    at: 2,
  },
];
const retryOnlyState = projectConversationCheckpoint({
  messages: retryOnlyMessages,
  usedTokens: 30,
  maxTokens: 200_000,
});
const retryOnlyTurns = checkpointAgentTurns(retryOnlyState);
assert.equal(retryOnlyTurns.length, 2, "a retry TurnSeq must remain a separate turn");
assert.equal(firstBytes(retryOnlyTurns[1], 1), undefined, "retry turn must not clone the prior user");
assert.equal(firstString(retryOnlyTurns[1], 3), "req-retry");
assert.equal(
  retryOnlyTurns[1].filter((field) => field.field === 2 && field.bytes).length,
  1,
);
assert.equal(
  projectConversationState(retryOnlyState).messages.filter(
    (message) => message.role === "assistant" && message.content === "recovered once",
  ).length,
  1,
  "retry output must be projected exactly once",
);

const importedReplayState = projectConversationCheckpoint({
  messages: [
    {
      role: "user",
      content: "imported Cursor user",
      cursorMessageId: "imported-cursor-user",
    },
    {
      role: "assistant",
      content: "imported Cursor answer",
    },
    {
      role: "user",
      content: "locally owned user",
      cursorMessageId: "local-user",
      turnSequence: 1,
      sourceRequestId: "local-request",
    },
    {
      role: "assistant",
      content: "locally owned answer",
      turnSequence: 1,
      sourceRequestId: "local-request",
    },
  ],
  usedTokens: 35,
  maxTokens: 200_000,
});
const importedReplayTurns = checkpointAgentTurns(importedReplayState);
assert.equal(
  importedReplayTurns.length,
  1,
  "TurnSeq=0 Cursor replay must not be promoted into a visible turn",
);
assert.equal(
  firstString(decodeFields(firstBytes(importedReplayTurns[0], 1)), 1),
  "locally owned user",
);
assert.equal(
  decodeFields(importedReplayState)
    .filter((field) => field.field === 1)
    .map((field) => JSON.parse(field.bytes.toString("utf8")).content)
    .includes("imported Cursor answer"),
  true,
  "TurnSeq=0 Cursor replay must remain available as provider context",
);

const canonicalThirdTurnMessages = [
  { ...retryOnlyMessages[0] },
  {
    ...retryOnlyMessages[1],
    content: "canonical third turn",
    turnSequence: 3,
    sourceRequestId: "req-canonical-3",
  },
];
const canonicalThirdTurnBase = projectConversationCheckpoint({
  messages: canonicalThirdTurnMessages,
  usedTokens: 40,
  maxTokens: 200_000,
});
const canonicalThirdTurnState = projectConversationCheckpoint({
  messages: canonicalThirdTurnMessages,
  usedTokens: 40,
  maxTokens: 200_000,
  baseState: canonicalThirdTurnBase,
});
assert.equal(
  checkpointAgentTurns(canonicalThirdTurnState).length,
  2,
  "raw visible ordinal 2 must match canonical TurnSeq 3 by RequestId",
);
assert.equal(
  projectConversationState(canonicalThirdTurnState).messages.filter(
    (message) => message.role === "assistant" && message.content === "canonical third turn",
  ).length,
  1,
  "base/local retry merging must be idempotent",
);

const staleRequestUser = concatMessages(
  encodeString(1, "replace stale request id"),
  encodeString(2, "stale-request-user"),
  encodeUint32(4, 1),
);
const staleRequestBase = encodeMessage(
  8,
  encodeMessage(
    1,
    concatMessages(
      encodeMessage(1, staleRequestUser),
      encodeMessage(2, encodeAssistantStep("request id replaced")),
      encodeString(3, "stale-request-id"),
    ),
  ),
);
const replacedRequestState = projectConversationCheckpoint({
  messages: [
    {
      role: "user",
      content: "replace stale request id",
      cursorMessageId: "stale-request-user",
      turnSequence: 1,
      sourceRequestId: "canonical-request-id",
    },
    {
      role: "assistant",
      content: "request id replaced",
      turnSequence: 1,
      sourceRequestId: "canonical-request-id",
    },
  ],
  usedTokens: 50,
  maxTokens: 200_000,
  baseState: staleRequestBase,
});
assert.equal(
  firstString(checkpointAgentTurns(replacedRequestState)[0], 3),
  "canonical-request-id",
  "local canonical RequestId must replace stale inbound metadata",
);

const historicalPendingMessages = [
  {
    role: "user",
    content: "create a plan",
    cursorMessageId: "pending-user",
    turnSequence: 1,
    sourceRequestId: "pending-request",
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "historical-pending-call",
      type: "function",
      function: { name: "CreatePlan", arguments: JSON.stringify({ plan: "# Historical" }) },
    }],
    turnSequence: 1,
    sourceRequestId: "pending-request",
  },
];
const stalePendingBase = encodeString(4, JSON.stringify({ stale: true }));
const withoutActivePending = decodeFields(projectConversationCheckpoint({
  messages: historicalPendingMessages,
  usedTokens: 60,
  maxTokens: 200_000,
  baseState: stalePendingBase,
}));
assert.equal(
  withoutActivePending.filter((field) => field.field === 4).length,
  0,
  "historical unfinished tools and stale base pending state are not active-stream pending",
);
const activePendingPayload = JSON.stringify({ active: "pending-call" });
const withActivePending = decodeFields(projectConversationCheckpoint({
  messages: historicalPendingMessages,
  pendingToolCalls: [activePendingPayload],
  usedTokens: 60,
  maxTokens: 200_000,
  baseState: stalePendingBase,
}));
assert.deepEqual(
  withActivePending
    .filter((field) => field.field === 4)
    .map((field) => field.bytes.toString("utf8")),
  [activePendingPayload],
  "only the explicit active-stream pending snapshot may populate field 4",
);

const currentPlanState = projectStructuredRuntimeState(messages, baseState);
const [revisedPlanCall] = sanitizeCreatePlanToolCallsForState([{
  id: "revise-current-plan",
  type: "function",
  function: {
    name: "CreatePlan",
    arguments: JSON.stringify({ name: "Do not create another entry", plan: "# Revised plan" }),
  },
}], currentPlanState);
assert.equal(JSON.parse(revisedPlanCall.function.arguments).name, "");
assert.equal(JSON.parse(revisedPlanCall.function.arguments).plan, "# Revised plan");

const todoStateKey = "checkpoint-runtime-todos";
synchronizeTodoState(todoStateKey, [{
  id: "persisted-active",
  content: "Keep this description",
  status: 1,
}]);
const todoUpdate = await executeTool({
  id: "todo-write-cross-request",
  name: "TodoWrite",
  arguments: JSON.stringify({
    todos: [{ id: "persisted-active", status: "completed" }],
  }),
}, {
  requestId: "new-transport-request",
  stateKey: todoStateKey,
});
assert.equal(todoUpdate.ok, true);
const todoUpdatePayload = JSON.parse(todoUpdate.content);
assert.equal(todoUpdatePayload.was_merge, true);
assert.deepEqual(
  todoUpdatePayload.todos.map((todo) => [todo.id, todo.content, todo.status]),
  [["persisted-active", "Keep this description", "completed"]],
  "TodoWrite uses conversation-scoped structured state across transport requests",
);

console.log("PASS smoke-conversation-checkpoint", {
  bytes: state.length,
  turns: projection.turnCount,
  messages: projection.messages.length,
});
