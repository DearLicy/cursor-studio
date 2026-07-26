import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-superseded-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const {
  isStreamCancelled,
  subscribe,
} = await import("../server/backend/agent/broker.ts");
const {
  encodeAgentClientRun,
  encodeToolCallMessage,
} = await import("../server/backend/forwarder/agent-proto.ts");
const {
  registerPending,
} = await import("../server/backend/forwarder/client-bridge.ts");
const {
  appendAssistantWithTools,
  appendHistory,
  appendToolResult,
  loadHistory,
  pruneCanceledHistoryTurn,
} = await import("../server/backend/forwarder/history.ts");
const {
  projectConversationCheckpoint,
} = await import("../server/backend/forwarder/conversation-checkpoint.ts");
const {
  concatMessages,
  decodeFields,
  encodeMessage,
  encodeString,
  firstBytes,
  firstString,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const {
  loadConfig,
  newProvider,
  saveConfig,
} = await import("../server/config/store.ts");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(check, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let oldProviderStarted = false;
const openResponses = new Set();
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const latestUser = [...(body.messages || [])]
    .reverse()
    .find((message) => message?.role === "user");
  const prompt = String(latestUser?.content || "");

  if (prompt.includes("NEW_USER")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "NEW_ASSISTANT" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 14, completion_tokens: 3 },
    }));
    return;
  }

  oldProviderStarted = true;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write('data: {"choices":[{"delta":{"content":"OLD_PARTIAL"}}]}\n\n');
  openResponses.add(response);
  response.once("close", () => openResponses.delete(response));
});

let backend;
let unsubscribeOld = () => {};
let unsubscribeNew = () => {};
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const providerId = "superseded-route";
  const modelID = "superseded-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "Superseded conversation fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;
  const conversationId = "superseded-conversation";
  const oldRequestId = "superseded-old-request";
  const newRequestId = "superseded-new-request";
  const oldEvents = [];
  const newEvents = [];
  ({ unsubscribe: unsubscribeOld } = subscribe(oldRequestId, (event) => oldEvents.push(event)));
  ({ unsubscribe: unsubscribeNew } = subscribe(newRequestId, (event) => newEvents.push(event)));

  const postRun = (requestId, text) => fetch(
    `${backendBase}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        data: encodeAgentClientRun({
          text,
          conversationId,
          modelName: modelHint,
        }).toString("hex"),
      }),
    },
  );

  const oldRun = await postRun(oldRequestId, "OLD_USER");
  assert.equal(oldRun.status, 200);
  await oldRun.arrayBuffer();
  await waitFor(() => oldProviderStarted, "old provider call to start");
  await waitFor(
    () => oldEvents.some((event) => event.type === "text" && event.text.includes("OLD_PARTIAL")),
    "old partial output",
  );

  // The bridge waiter stands in for a client-side tool that Cursor is still
  // executing. A superseding user request must publish ExecServerControl.abort
  // before it terminally closes this stream.
  const pending = {
    kind: "exec",
    execId: "superseded-old-exec",
    messageId: 411,
    toolCallId: "superseded-old-tool",
    name: "CallMcpTool",
    argsJson: "{}",
    createdAt: Date.now(),
  };
  const pendingResult = registerPending(oldRequestId, pending, 5_000);

  const replacementRun = await postRun(newRequestId, "NEW_USER");
  assert.equal(replacementRun.status, 200);
  await replacementRun.arrayBuffer();

  const cancelledExec = await pendingResult;
  assert.equal(cancelledExec.ok, false, "superseding request releases old bridge waiters");
  assert.match(cancelledExec.result, /cancelled/i);
  await waitFor(() => isStreamCancelled(oldRequestId), "old stream cancellation");
  await waitFor(
    () => newEvents.some((event) => event.type === "done" || event.type === "error"),
    "replacement run to finish",
  );
  assert.equal(newEvents.some((event) => event.type === "error"), false);

  const abortIndex = oldEvents.findIndex(
    (event) => event.type === "exec_abort" && event.messageId === pending.messageId,
  );
  const terminalIndex = oldEvents.findIndex((event) => event.type === "error");
  assert.ok(abortIndex >= 0, "old stream emits Cursor exec abort");
  assert.ok(terminalIndex > abortIndex, "exec abort is published before old stream closes");

  const history = await loadHistory(conversationId);
  const contents = history.messages.map((message) => String(message.content || ""));
  assert.ok(contents.includes("NEW_USER"), "replacement user message persisted");
  assert.ok(contents.includes("NEW_ASSISTANT"), "replacement assistant response persisted");
  assert.equal(
    contents.some((content) => content.includes("OLD_PARTIAL")),
    false,
    "a cancelled old provider fragment must never be committed to history",
  );
  assert.equal(
    contents.includes("OLD_USER"),
    false,
    "a superseded turn with no committed provider activity is removed entirely",
  );

  const cancelCheckpoint = oldEvents
    .filter((event) => event.type === "checkpoint")
    .at(-1);
  assert(cancelCheckpoint?.conversationState, "superseded turn publishes a final checkpoint");
  const cancelFields = decodeFields(cancelCheckpoint.conversationState);
  assert.equal(
    cancelFields.some((field) => field.field === 4),
    false,
    "cancellation checkpoint contains no pending tool call",
  );

  const staleOldRawTurn = encodeMessage(1, concatMessages(
    encodeMessage(1, concatMessages(
      encodeString(1, "OLD_USER"),
      encodeString(2, "stale-old-user"),
    )),
    encodeString(3, oldRequestId),
  ));
  const supersededProjection = projectConversationCheckpoint({
    messages: history.messages,
    canceledTurns: history.canceledTurns,
    usedTokens: 20,
    maxTokens: 200_000,
    baseState: encodeMessage(8, staleOldRawTurn),
  });
  const projectedUsers = decodeFields(supersededProjection)
    .filter((field) => field.field === 8 && field.bytes)
    .map((field) => {
      const agent = firstBytes(decodeFields(field.bytes), 1);
      const user = firstBytes(decodeFields(agent), 1);
      return firstString(decodeFields(user), 1);
    });
  assert.equal(projectedUsers.includes("OLD_USER"), false);
  assert.equal(projectedUsers.includes("NEW_USER"), true);

  const ordinaryConversation = "ordinary-cancel-conversation";
  const ordinaryRequest = "ordinary-cancel-request";
  await appendHistory(
    ordinaryConversation,
    "user",
    "KEEP_USER_AFTER_CANCEL",
    undefined,
    undefined,
    {
      sourceRequestId: ordinaryRequest,
      cursorMessageId: "ordinary-cancel-user",
      turnSequence: 1,
    },
  );
  await appendAssistantWithTools(
    ordinaryConversation,
    "PARTIAL_ASSISTANT",
    [{
      id: "ordinary-cancel-tool",
      type: "function",
      function: { name: "Read", arguments: JSON.stringify({ path: "README.md" }) },
    }],
    undefined,
    { sourceRequestId: ordinaryRequest },
  );
  await appendToolResult(
    ordinaryConversation,
    "ordinary-cancel-tool",
    "Read",
    "PARTIAL_TOOL_RESULT",
    { sourceRequestId: ordinaryRequest },
  );
  const ordinaryPrune = await pruneCanceledHistoryTurn(
    ordinaryConversation,
    ordinaryRequest,
    "client_cancel",
  );
  assert.equal(ordinaryPrune.replayPolicy, "keep_stable_input");
  const ordinaryHistory = await loadHistory(ordinaryConversation);
  assert.deepEqual(
    ordinaryHistory.messages.map((message) => [message.role, message.content]),
    [["user", "KEEP_USER_AFTER_CANCEL"]],
    "ordinary cancel keeps stable user input and removes assistant/tool output",
  );
  const ordinaryCheckpoint = projectConversationCheckpoint({
    messages: ordinaryHistory.messages,
    canceledTurns: ordinaryHistory.canceledTurns,
    usedTokens: 10,
    maxTokens: 200_000,
    baseState: encodeMessage(8, encodeMessage(1, concatMessages(
      encodeMessage(1, concatMessages(
        encodeString(1, "KEEP_USER_AFTER_CANCEL"),
        encodeString(2, "ordinary-cancel-user"),
      )),
      encodeMessage(2, encodeMessage(2, encodeToolCallMessage({
        name: "Write",
        args: {
          path: "README.md",
          contents: "unfinished",
          tool_call_id: "ordinary-cancel-pending-write",
        },
      }))),
      encodeString(3, ordinaryRequest),
    ))),
  });
  const ordinaryCheckpointFields = decodeFields(ordinaryCheckpoint);
  assert.equal(
    ordinaryCheckpointFields.some((field) => field.field === 4),
    false,
    "ordinary cancel checkpoint contains no pending tool call",
  );
  const ordinaryRawTurn = firstBytes(ordinaryCheckpointFields, 8);
  const ordinaryAgentTurn = decodeFields(firstBytes(decodeFields(ordinaryRawTurn), 1));
  assert.equal(
    ordinaryAgentTurn.some((field) => field.field === 2),
    false,
    "canceled persistent tools are not resurrected from baseState raw turns",
  );

  console.log("PASS smoke-superseded-conversation");
} finally {
  unsubscribeOld();
  unsubscribeNew();
  for (const response of openResponses) response.destroy();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
