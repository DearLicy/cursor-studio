import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-state-replay-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const {
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
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { projectConversationState } = await import(
  "../server/backend/forwarder/conversation-state.ts"
);
const { streamEventToProto } = await import(
  "../server/backend/forwarder/stream-writer.ts"
);
const { loadConfig, newProvider, saveConfig } = await import("../server/config/store.ts");

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

function encodeAssistantStep(text) {
  return encodeMessage(1, encodeString(1, text));
}

function encodeAgentTurn(user, userMessageId, steps) {
  const body = concatMessages(
    encodeMessage(1, concatMessages(
      encodeString(1, user),
      encodeString(2, userMessageId),
      encodeString(30, "CURSOR_RAW_USER_EXTENSION"),
    )),
    ...steps.map((step) => encodeMessage(2, step)),
    encodeString(3, "cursor-prior-request"),
    encodeString(4, "CURSOR_ENCRYPTED_MODEL_EXTENSION"),
  );
  return encodeMessage(1, body);
}

let providerRequest;
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  providerRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: "STATE_REPLAY_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 21, completion_tokens: 3 },
  }));
});

let backend;
let unsubscribe = () => {};
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const providerId = "state-replay-route";
  const modelID = "state-replay-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "State replay fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const conversationId = "state-replay-conversation";
  const requestId = "state-replay-request";
  const priorTurn = encodeAgentTurn(
    "CURSOR_PRIOR_USER",
    "cursor-prior-user-id",
    [encodeAssistantStep("CURSOR_PRIOR_ASSISTANT")],
  );
  const conversationState = concatMessages(
    encodeMessage(6, encodeString(1, "CURSOR_COMPACTED_SUMMARY")),
    encodeMessage(8, priorTurn),
    Buffer.concat([encodeKey(30, 0), encodeVarint(77)]),
  );
  const currentUser = concatMessages(
    encodeString(1, "CURSOR_CURRENT_USER"),
    encodeString(2, "cursor-current-user-id"),
    encodeUint32(4, 1),
  );
  const action = encodeMessage(1, encodeMessage(1, currentUser));
  const runRequest = concatMessages(
    encodeMessage(1, conversationState),
    encodeMessage(2, action),
    encodeString(5, conversationId),
    encodeMessage(9, encodeString(1, modelHint)),
  );
  const clientMessage = encodeMessage(1, runRequest);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const events = [];
  ({ unsubscribe } = subscribe(requestId, (event) => events.push(event)));
  const response = await fetch(`http://${backend.listenAddr}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, data: clientMessage.toString("hex") }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await waitFor(
    () => events.some((event) => event.type === "done" || event.type === "error"),
    "state replay run to complete",
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.ok(providerRequest, "provider did not receive a request");

  const messages = providerRequest.messages || [];
  const combined = messages.map((message) => String(message.content || "")).join("\n");
  assert.match(combined, /CURSOR_COMPACTED_SUMMARY/);
  assert.match(combined, /CURSOR_PRIOR_USER/);
  assert.match(combined, /CURSOR_PRIOR_ASSISTANT/);
  assert.match(combined, /CURSOR_CURRENT_USER/);
  const currentUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      String(message.content || "").trim() === "CURSOR_CURRENT_USER",
  ).length;
  assert.equal(currentUserCount, 1, "current user turn must not be duplicated after state reconciliation");

  const checkpoint = events
    .filter((event) => event.type === "checkpoint" && event.conversationState?.length)
    .at(-1);
  assert.ok(checkpoint, "service must publish a complete conversation checkpoint");
  const checkpointProjection = projectConversationState(checkpoint.conversationState, {
    preferTurns: true,
  });
  const checkpointText = checkpointProjection.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.equal(
    checkpointProjection.turnCount,
    1,
    "imported TurnSeq=0 replay must not become a locally owned checkpoint turn",
  );
  assert.match(checkpointText, /CURSOR_CURRENT_USER/);
  assert.match(checkpointText, /STATE_REPLAY_OK/);

  const checkpointProto = streamEventToProto(checkpoint);
  assert.ok(checkpointProto, "checkpoint event did not encode to protobuf");
  const emittedState = firstBytes(decodeFields(checkpointProto), 3);
  assert.deepEqual(emittedState, checkpoint.conversationState);
  const emittedStateFields = decodeFields(emittedState);
  assert.ok(
    emittedStateFields.some((field) => field.field === 8),
    "emitted checkpoint regressed to token-only",
  );
  const rootReplay = emittedStateFields
    .filter((field) => field.field === 1 && field.bytes)
    .map((field) => JSON.parse(field.bytes.toString("utf8")));
  const rootReplayText = rootReplay
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(rootReplayText, /CURSOR_PRIOR_USER/);
  assert.match(rootReplayText, /CURSOR_PRIOR_ASSISTANT/);
  assert.match(rootReplayText, /CURSOR_CURRENT_USER/);
  assert.match(rootReplayText, /STATE_REPLAY_OK/);
  assert.equal(
    firstVarint(emittedStateFields, 30),
    77,
    "checkpoint must preserve unknown fields from the inbound base state",
  );
  const emittedTurns = emittedStateFields
    .filter((field) => field.field === 8)
    .map((field) => field.bytes);
  const emittedAgentTurn = decodeFields(firstBytes(decodeFields(emittedTurns[0]), 1));
  const emittedUser = decodeFields(firstBytes(emittedAgentTurn, 1));
  assert.equal(
    firstString(emittedUser, 1),
    "CURSOR_CURRENT_USER",
    "only the locally owned turn may be emitted in ConversationState.turns",
  );

  console.log("PASS smoke-conversation-state-replay");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
