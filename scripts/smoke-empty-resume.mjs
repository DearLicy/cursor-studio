import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-empty-resume-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const {
  ensureStream,
  getStream,
  markStreamTerminalPending,
  publish,
  setStreamConversationContext,
  subscribe,
} = await import("../server/backend/agent/broker.ts");
const { getActiveStreamActorSnapshot } = await import(
  "../server/backend/forwarder/active-stream-actor.ts"
);
const { encodeAgentClientRun } = await import("../server/backend/forwarder/agent-proto.ts");
const {
  beginHistoryLoop,
  finishHistoryLoop,
  historyLoopSnapshot,
  historyMessagesSnapshot,
} = await import(
  "../server/backend/forwarder/history.ts"
);
const { parseBidiAppendInbound } = await import("../server/backend/forwarder/protocol.ts");
const { decodeConnectFrames, encodeConnectFrame } = await import(
  "../server/backend/forwarder/connect-frame.ts"
);
const {
  concatMessages,
  encodeMessage,
  encodeString,
  encodeUint32,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
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

async function waitFor(check, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function eventDigest(events) {
  return events.map((event) => ({
    type: event.type,
    ...(event.code ? { code: event.code } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.text ? { text: String(event.text).slice(0, 80) } : {}),
  }));
}

function historyDigest(messages) {
  return messages.map((message) => ({
    role: message.role,
    turnSequence: message.turnSequence,
    sourceRequestId: message.sourceRequestId,
    promptContextSource: message.promptContextSource,
    content: String(message.content || "").slice(0, 80),
  }));
}

function bidiAppendRequest(requestId, clientMessage) {
  return concatMessages(
    encodeString(1, clientMessage.toString("hex")),
    encodeMessage(2, encodeString(1, requestId)),
  );
}

let providerCalls = 0;
let signalProviderStarted;
const providerStarted = new Promise((resolve) => {
  signalProviderStarted = resolve;
});
let releaseProviderResponse;
const providerResponseGate = new Promise((resolve) => {
  releaseProviderResponse = resolve;
});
let nextProviderFailureStatus = 0;
const upstream = http.createServer(async (_request, response) => {
  providerCalls += 1;
  signalProviderStarted();
  await providerResponseGate;
  if (nextProviderFailureStatus) {
    const status = nextProviderFailureStatus;
    nextProviderFailureStatus = 0;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture provider failure" } }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: "Initial provider response." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
});

let backend;
const unsubscribeAll = [];
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const providerId = "empty-resume-route";
  const modelID = "empty-resume-model";
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "Empty resume fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const conversationId = "empty-resume-conversation";
  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;

  async function appendConnect(requestId, clientMessage) {
    const wireBody = encodeConnectFrame(bidiAppendRequest(requestId, clientMessage));
    const decoded = parseBidiAppendInbound(wireBody);
    assert.equal(decoded.path, "bidi_proto", `${requestId} parser path`);
    const response = await fetch(
      `${backendBase}/aiserver.v1.BidiService/BidiAppend`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/connect+proto",
          Accept: "application/connect+proto",
        },
        body: wireBody,
      },
    );
    const responseBody = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${requestId} Connect status`);
    assert.match(
      String(response.headers.get("content-type")),
      /^application\/connect\+proto/,
      `${requestId} Connect content type`,
    );
    const frames = decodeConnectFrames(responseBody);
    assert.equal(frames.rest.length, 0, `${requestId} complete Connect frames`);
    assert.equal(frames.frames[0]?.endStream, false, `${requestId} response frame`);
    assert.equal(frames.frames[0]?.payload.length, 0, `${requestId} empty ACK`);
    const trailer = frames.frames.at(-1);
    assert.equal(trailer?.endStream, true, `${requestId} end-stream ACK`);
    const trailerBody = JSON.parse(trailer?.payload.toString("utf8") || "{}");
    assert.equal(trailerBody.code, undefined, `${requestId} must not return invalid_argument`);
    return { decoded, frames: frames.frames };
  }

  // Reproduce the narrow terminal commit window directly: the final
  // checkpoint is already visible, but the native End has not been emitted.
  // A new Request ID carrying an empty Resume must be acknowledged as a
  // reconnect and must not create an actor or call the provider.
  const commitWindowConversationId = "empty-resume-terminal-commit-window";
  const commitWindowOwnerId = "empty-resume-terminal-owner";
  await beginHistoryLoop(commitWindowConversationId, commitWindowOwnerId);
  await finishHistoryLoop(
    commitWindowConversationId,
    commitWindowOwnerId,
    "completed",
  );
  const commitWindowOwner = ensureStream(commitWindowOwnerId);
  setStreamConversationContext(
    commitWindowOwnerId,
    commitWindowConversationId,
  );
  commitWindowOwner.started = true;
  assert.equal(markStreamTerminalPending(commitWindowOwnerId), true);
  publish(commitWindowOwnerId, {
    type: "checkpoint",
    usedTokens: 1,
    maxTokens: 200_000,
  });
  assert.equal(commitWindowOwner.done, false, "terminal End is still pending");

  const commitWindowReconnectId = "empty-resume-terminal-reconnect";
  const commitWindowRunRequest = concatMessages(
    encodeMessage(2, encodeMessage(2, Buffer.alloc(0))),
    encodeString(5, commitWindowConversationId),
    encodeMessage(9, encodeString(1, `${providerId}:${modelID}`)),
  );
  await appendConnect(
    commitWindowReconnectId,
    encodeMessage(1, commitWindowRunRequest),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(providerCalls, 0, "terminal commit reconnect must not call provider");
  assert.equal(
    getActiveStreamActorSnapshot(commitWindowReconnectId),
    undefined,
    "terminal commit reconnect must not create an actor",
  );
  assert.equal(
    getStream(commitWindowReconnectId),
    undefined,
    "terminal commit reconnect must not create a broker stream",
  );
  publish(commitWindowOwnerId, { type: "done" });

  // Establish a real completed conversation first. The subsequent reconnects
  // reuse the final checkpoint state emitted by this run, matching Cursor's
  // Connect BidiAppend path instead of relying on a synthetic empty transcript.
  const initialRequestId = "empty-resume-initial-request";
  const initialEvents = [];
  const initialSubscription = subscribe(
    initialRequestId,
    (event) => initialEvents.push(event),
  );
  unsubscribeAll.push(initialSubscription.unsubscribe);
  const initialClientMessage = encodeAgentClientRun({
    text: "Create a completed conversation before reconnecting.",
    conversationId,
    modelName: `${providerId}:${modelID}`,
  });
  const initialAppend = await appendConnect(initialRequestId, initialClientMessage);
  assert.equal(initialAppend.decoded.kind, "user_run");
  await waitFor(() => providerCalls === 1, "initial provider request");
  await providerStarted;

  // Cursor can send KV results while the provider stream is still open. This
  // valid AgentClientMessage field 3 branch is transport metadata and must be
  // acknowledged without replacing or restarting the active model call.
  const kvClientMessage = encodeMessage(
    3,
    concatMessages(
      encodeUint32(1, 7),
      encodeMessage(2, encodeMessage(1, Buffer.from("kv-fixture"))),
    ),
  );
  const kvAppend = await appendConnect(initialRequestId, kvClientMessage);
  assert.equal(kvAppend.decoded.kind, "metadata");
  assert.equal(providerCalls, 1, "KV metadata must not start another provider call");
  releaseProviderResponse();
  await waitFor(
    () => initialEvents.some((event) => event.type === "done" || event.type === "error"),
    "initial user run to finish",
  );
  assert.equal(
    initialEvents.some((event) => event.type === "error"),
    false,
    JSON.stringify(eventDigest(initialEvents)),
  );
  assert(initialEvents.some((event) => event.type === "done"));
  assert.equal(providerCalls, 1, "the initial text turn calls the provider exactly once");

  const completedCheckpoint = initialEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(completedCheckpoint, "the completed turn must publish a reusable conversation state");
  const completedConversationState = Buffer.from(completedCheckpoint.conversationState);
  const historyBeforeReconnects = await historyMessagesSnapshot(conversationId);
  assert(historyBeforeReconnects.length >= 2, "the fixture must contain a completed user turn");
  const loopBeforeReconnects = await historyLoopSnapshot(conversationId);
  assert.equal(loopBeforeReconnects.readable, true);
  assert.equal(loopBeforeReconnects.currentLoopStatus, "completed");
  assert.equal(loopBeforeReconnects.currentRequestId, initialRequestId);
  const historyFile = path.join(
    tempHome,
    "history",
    "turns",
    `${conversationId}.json`,
  );
  const historyBytesBeforeReconnects = await fs.readFile(historyFile);

  const resumeRequestIds = [
    "empty-resume-reconnect-1",
    "empty-resume-reconnect-2",
    "empty-resume-reconnect-3",
  ];
  const resumeEvents = new Map();
  const resumeAction = encodeMessage(2, Buffer.alloc(0));

  for (const requestId of resumeRequestIds) {
    const runRequest = concatMessages(
      encodeMessage(1, completedConversationState),
      encodeMessage(2, resumeAction),
      encodeString(5, conversationId),
      encodeMessage(9, encodeString(1, `${providerId}:${modelID}`)),
    );
    const clientMessage = encodeMessage(1, runRequest);
    const events = [];
    resumeEvents.set(requestId, events);
    const subscription = subscribe(requestId, (event) => events.push(event));
    unsubscribeAll.push(subscription.unsubscribe);
    const { decoded } = await appendConnect(requestId, clientMessage);
    assert.equal(decoded.path, "bidi_proto", `${requestId} Connect parser path`);
    assert.equal(decoded.kind, "user_run", `${requestId} kind`);
    assert.equal(decoded.conversationAction, "resume", `${requestId} action`);
    assert.equal(
      decoded.hasRequestContextPayload,
      false,
      `${requestId} request context payload`,
    );
    assert.equal(decoded.hasPendingToolCalls, false, `${requestId} pending tools`);
    assert.equal(decoded.conversationId, conversationId, `${requestId} conversation`);

  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  const historyAfterReconnects = await historyMessagesSnapshot(conversationId);
  const loopAfterReconnects = await historyLoopSnapshot(conversationId);
  const historyBytesAfterReconnects = await fs.readFile(historyFile);
  const projectedResumeEvents = [...resumeEvents.entries()].flatMap(
    ([requestId, events]) => eventDigest(events).map((event) => ({ requestId, ...event })),
  );
  const unexpectedAssistantEvents = projectedResumeEvents.filter((event) =>
    ["text", "thinking", "thinking_done"].includes(event.type)
  );
  const reconnectDiagnostics = JSON.stringify({
    providerCalls,
    expectedProviderCalls: 1,
    unexpectedAssistantEvents,
    historyBefore: historyBeforeReconnects.length,
    historyAfter: historyAfterReconnects.length,
    historyBeforeDigest: historyDigest(historyBeforeReconnects),
    historyAfterDigest: historyDigest(historyAfterReconnects),
    resumeEvents: projectedResumeEvents,
  });

  assert.equal(
    providerCalls,
    1,
    `empty reconnects must not call the provider: ${reconnectDiagnostics}`,
  );
  assert.deepEqual(
    unexpectedAssistantEvents,
    [],
    `empty reconnects must not emit thinking or assistant content: ${reconnectDiagnostics}`,
  );
  assert.equal(
    isDeepStrictEqual(historyAfterReconnects, historyBeforeReconnects),
    true,
    `empty reconnects must not append or rewrite history: ${reconnectDiagnostics}`,
  );
  assert.deepEqual(
    loopAfterReconnects,
    loopBeforeReconnects,
    "empty reconnects must not change the durable loop projection",
  );
  assert.equal(
    historyBytesAfterReconnects.equals(historyBytesBeforeReconnects),
    true,
    "empty reconnects must leave the history file byte-for-byte unchanged",
  );
  for (const requestId of resumeRequestIds) {
    assert.equal(
      getActiveStreamActorSnapshot(requestId),
      undefined,
      `${requestId} must not create a lifecycle actor`,
    );
  }
  const usageRaw = await fs.readFile(
    path.join(tempHome, "history", "usage.json"),
    "utf8",
  );
  for (const requestId of resumeRequestIds) {
    assert.equal(
      usageRaw.includes(requestId),
      false,
      `${requestId} must not create usage accounting`,
    );
  }

  // A persisted provider_error is intentionally resumable. Cursor's first
  // retry may use a new request ID with an empty resume action; exactly that
  // one retry starts the selected provider, then completed becomes terminal.
  const errorConversationId = "provider-error-resume-conversation";
  const errorRequestId = "provider-error-initial-request";
  const errorEvents = [];
  const errorSubscription = subscribe(errorRequestId, (event) => errorEvents.push(event));
  unsubscribeAll.push(errorSubscription.unsubscribe);
  nextProviderFailureStatus = 502;
  await appendConnect(
    errorRequestId,
    encodeAgentClientRun({
      text: "Keep this prompt for a native provider retry.",
      conversationId: errorConversationId,
      modelName: `${providerId}:${modelID}`,
    }),
  );
  await waitFor(
    () => errorEvents.some((event) => event.type === "error"),
    "provider error turn to finish",
  );
  assert.equal(providerCalls, 2, "the failing user turn calls the provider once");
  const failedLoop = await historyLoopSnapshot(errorConversationId);
  assert.equal(failedLoop.currentLoopStatus, "provider_error");
  const failedCheckpoint = errorEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(failedCheckpoint, "provider error publishes a retryable checkpoint");

  const retryRequestId = "provider-error-resume-request";
  const retryEvents = [];
  const retrySubscription = subscribe(retryRequestId, (event) => retryEvents.push(event));
  unsubscribeAll.push(retrySubscription.unsubscribe);
  const retryRunRequest = concatMessages(
    encodeMessage(1, Buffer.from(failedCheckpoint.conversationState)),
    encodeMessage(2, resumeAction),
    encodeString(5, errorConversationId),
    encodeMessage(9, encodeString(1, `${providerId}:${modelID}`)),
  );
  await appendConnect(retryRequestId, encodeMessage(1, retryRunRequest));
  await waitFor(
    () => retryEvents.some((event) => event.type === "done" || event.type === "error"),
    "provider error resume to finish",
  );
  assert.equal(
    retryEvents.some((event) => event.type === "error"),
    false,
    JSON.stringify(eventDigest(retryEvents)),
  );
  assert.equal(providerCalls, 3, "provider_error resume starts exactly one provider retry");
  const recoveredLoop = await historyLoopSnapshot(errorConversationId);
  assert.equal(recoveredLoop.currentLoopStatus, "completed");
  assert.equal(recoveredLoop.currentRequestId, retryRequestId);

  const terminalRetryRequestId = "provider-error-terminal-reconnect";
  const recoveredCheckpoint = retryEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(recoveredCheckpoint, "successful retry publishes a completed checkpoint");
  const terminalRetryRun = concatMessages(
    encodeMessage(1, Buffer.from(recoveredCheckpoint.conversationState)),
    encodeMessage(2, resumeAction),
    encodeString(5, errorConversationId),
    encodeMessage(9, encodeString(1, `${providerId}:${modelID}`)),
  );
  await appendConnect(terminalRetryRequestId, encodeMessage(1, terminalRetryRun));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(providerCalls, 3, "completed retry ignores later empty reconnects");

  console.log("PASS smoke-empty-resume");
} finally {
  releaseProviderResponse?.();
  for (const unsubscribe of unsubscribeAll.splice(0)) unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
