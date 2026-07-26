import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-normal-turn-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const { encodeAgentClientHeartbeat, encodeAgentClientRun } = await import(
  "../server/backend/forwarder/agent-proto.ts"
);
const {
  CONNECT_FLAG_COMPRESSED,
  decodeConnectFrames,
  encodeConnectFrame,
} = await import("../server/backend/forwarder/connect-frame.ts");
const { projectConversationState } = await import(
  "../server/backend/forwarder/conversation-state.ts"
);
const { streamEventToProto } = await import(
  "../server/backend/forwarder/stream-writer.ts"
);
const {
  concatMessages,
  decodeFields,
  encodeMessage,
  encodeString,
  encodeUint32,
  firstBytes,
  firstString,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { loadConfig, newProvider, saveConfig } = await import(
  "../server/config/store.ts"
);

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

function encodeRunWithState({ text, conversationId, modelHint, state, messageId }) {
  const user = concatMessages(
    encodeString(1, text),
    encodeString(2, messageId),
    encodeUint32(4, 1),
  );
  const action = encodeMessage(1, encodeMessage(1, user));
  const runRequest = concatMessages(
    encodeMessage(1, state),
    encodeMessage(2, action),
    encodeString(5, conversationId),
    encodeMessage(9, encodeString(1, modelHint)),
  );
  return encodeMessage(1, runRequest);
}

function encodeBidiAppend(requestId, clientMessage) {
  return concatMessages(
    encodeString(1, clientMessage.toString("hex")),
    encodeMessage(2, encodeString(1, requestId)),
  );
}

async function postConnectBidi(baseUrl, requestId, clientMessage, compressed = false) {
  const append = encodeBidiAppend(requestId, clientMessage);
  const body = compressed
    ? encodeConnectFrame(gzipSync(append), CONNECT_FLAG_COMPRESSED)
    : encodeConnectFrame(append);
  const response = await fetch(
    `${baseUrl}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        Accept: "application/connect+proto",
        ...(compressed ? { "Connect-Content-Encoding": "gzip" } : {}),
      },
      body,
    },
  );
  const responseBody = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, "client control BidiAppend must be acknowledged");
  const frames = decodeConnectFrames(responseBody);
  assert.equal(frames.rest.length, 0, "client control ACK must contain complete frames");
  assert.equal(frames.frames[0]?.payload.length, 0, "client control ACK payload must be empty");
  const trailer = JSON.parse(frames.frames.at(-1)?.payload.toString("utf8") || "{}");
  assert.equal(trailer.code, undefined, "client control ACK must not terminate RunSSE");
}

const providerRequests = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  providerRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        reasoning_content: "NORMAL_ASSISTANT_THOUGHT",
        content: "NORMAL_ASSISTANT_REPLY",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 32, completion_tokens: 4 },
  }));
});

let backend;
let unsubscribe = () => {};
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const providerId = "normal-turn-route";
  const modelID = "normal-turn-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.cursorIntegration.defaultContextWindowTokens = 200_000;
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "Normal turn fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      modelSettings: {
        [modelID]: {
          contextWindowTokens: 200_000,
          maxCompletionTokens: 65_536,
        },
      },
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const requestId = "normal-turn-request";
  const conversationId = "normal-turn-conversation";
  const events = [];
  ({ unsubscribe } = subscribe(requestId, (event) => events.push(event)));

  const payload = encodeAgentClientRun({
    text: "NORMAL_USER_MESSAGE",
    conversationId,
    modelName: modelHint,
  });
  const response = await fetch(
    `http://${backend.listenAddr}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        data: payload.toString("hex"),
      }),
    },
  );
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  await waitFor(
    () => events.some((event) => event.type === "done" || event.type === "error"),
    "normal turn completion",
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(providerRequests.length, 1, "a short turn must make one provider request");

  const heartbeat = encodeAgentClientHeartbeat();
  assert.equal(
    heartbeat.toString("hex"),
    "3a00",
    "the regression must exercise Cursor's four-character heartbeat payload",
  );
  await postConnectBidi(
    `http://${backend.listenAddr}`,
    requestId,
    heartbeat,
  );
  await postConnectBidi(
    `http://${backend.listenAddr}`,
    requestId,
    heartbeat,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    providerRequests.length,
    1,
    "heartbeat ACKs after completion must not reconnect or call the provider again",
  );
  assert.equal(
    events.filter((event) => event.type === "thinking").length,
    1,
    "a completed user turn must publish one assistant thinking group",
  );
  assert.equal(
    events.filter((event) => event.type === "text").length,
    1,
    "a completed user turn must publish one assistant text group",
  );
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("summary"))
      .map((event) => event.type),
    [],
    "a short turn inside a 200k window must not enter the summary lifecycle",
  );

  const checkpoint = events
    .filter((event) => event.type === "checkpoint" && event.conversationState?.length)
    .at(-1);
  assert.ok(checkpoint, "normal turn must publish a complete final checkpoint");
  const projection = projectConversationState(checkpoint.conversationState, {
    preferTurns: true,
  });
  assert.deepEqual(
    projection.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "NORMAL_USER_MESSAGE" },
      { role: "assistant", content: "NORMAL_ASSISTANT_REPLY" },
    ],
    "the final checkpoint must restore both visible sides of the completed turn",
  );

  const checkpointProto = streamEventToProto(checkpoint);
  assert.ok(checkpointProto, "checkpoint protobuf is missing");
  const checkpointState = firstBytes(decodeFields(checkpointProto), 3);
  assert.ok(checkpointState, "checkpoint protobuf does not contain ConversationState");
  assert.deepEqual(
    projectConversationState(checkpointState, { preferTurns: true }).messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "NORMAL_USER_MESSAGE" },
      { role: "assistant", content: "NORMAL_ASSISTANT_REPLY" },
    ],
    "the wire checkpoint must restore both visible sides of the completed turn",
  );

  const summaryCompletedProto = streamEventToProto({
    type: "summary_completed",
    hookMessage: requestId,
  });
  assert.ok(summaryCompletedProto, "summary_completed protobuf is missing");
  const interaction = firstBytes(decodeFields(summaryCompletedProto), 1);
  const summaryCompleted = firstBytes(decodeFields(interaction), 11);
  assert.equal(
    firstString(decodeFields(summaryCompleted), 1),
    requestId,
    "SummaryCompletedUpdate field 1 must carry requestId",
  );

  unsubscribe();
  const continuedRequestId = "normal-turn-continued-request";
  const continuedEvents = [];
  ({ unsubscribe } = subscribe(continuedRequestId, (event) => continuedEvents.push(event)));
  const staleRootState = concatMessages(
    encodeString(1, JSON.stringify({ role: "user", content: "STALE_ROOT_USER" })),
    encodeString(1, JSON.stringify({ role: "assistant", content: "STALE_ROOT_ASSISTANT" })),
  );
  const continuedPayload = encodeRunWithState({
    text: "SECOND_USER_MESSAGE",
    conversationId,
    modelHint,
    state: staleRootState,
    messageId: "normal-turn-user-2",
  });
  const continuedResponse = await fetch(
    `http://${backend.listenAddr}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: continuedRequestId,
        data: continuedPayload.toString("hex"),
      }),
    },
  );
  assert.equal(continuedResponse.status, 200);
  await continuedResponse.arrayBuffer();
  await waitFor(
    () => continuedEvents.some((event) => event.type === "done" || event.type === "error"),
    "continued normal turn completion",
  );
  assert.equal(continuedEvents.some((event) => event.type === "error"), false);
  assert.deepEqual(
    continuedEvents
      .filter((event) => event.type.startsWith("summary"))
      .map((event) => event.type),
    [],
    "stale field 1 replay must not trigger summary in an existing conversation",
  );
  assert.equal(providerRequests.length, 2);
  const continuedProviderText = providerRequests[1].messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(continuedProviderText, /NORMAL_USER_MESSAGE/);
  assert.match(continuedProviderText, /NORMAL_ASSISTANT_REPLY/);
  assert.match(continuedProviderText, /SECOND_USER_MESSAGE/);
  assert.doesNotMatch(
    continuedProviderText,
    /STALE_ROOT_(?:USER|ASSISTANT)/,
    "field 1 fallback must stay disabled after local history exists",
  );

  unsubscribe();
  const recoveryRequestId = "normal-turn-root-recovery-request";
  const recoveryConversationId = "normal-turn-root-recovery-conversation";
  const recoveryEvents = [];
  ({ unsubscribe } = subscribe(recoveryRequestId, (event) => recoveryEvents.push(event)));
  const recoveryState = concatMessages(
    encodeString(1, JSON.stringify({ role: "user", content: "RECOVERED_ROOT_USER" })),
    encodeString(1, JSON.stringify({ role: "assistant", content: "RECOVERED_ROOT_ASSISTANT" })),
  );
  const recoveryPayload = encodeRunWithState({
    text: "RECOVERY_CURRENT_USER",
    conversationId: recoveryConversationId,
    modelHint,
    state: recoveryState,
    messageId: "normal-turn-recovery-user",
  });
  const recoveryResponse = await fetch(
    `http://${backend.listenAddr}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: recoveryRequestId,
        data: recoveryPayload.toString("hex"),
      }),
    },
  );
  assert.equal(recoveryResponse.status, 200);
  await recoveryResponse.arrayBuffer();
  await waitFor(
    () => recoveryEvents.some((event) => event.type === "done" || event.type === "error"),
    "root replay first recovery completion",
  );
  assert.equal(recoveryEvents.some((event) => event.type === "error"), false);
  assert.equal(
    recoveryEvents.some((event) => event.type.startsWith("summary")),
    false,
    "a short first recovery inside a 200k window must not enter summary",
  );
  assert.equal(providerRequests.length, 3);
  const recoveryProviderText = providerRequests[2].messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(recoveryProviderText, /RECOVERED_ROOT_USER/);
  assert.match(recoveryProviderText, /RECOVERED_ROOT_ASSISTANT/);
  assert.match(recoveryProviderText, /RECOVERY_CURRENT_USER/);

  console.log("PASS smoke-normal-turn-regression");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
