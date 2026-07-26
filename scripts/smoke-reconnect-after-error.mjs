import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-error-resume-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { getStream, subscribe } = await import("../server/backend/agent/broker.ts");
const { encodeAgentClientRun } = await import("../server/backend/forwarder/agent-proto.ts");
const { decodeConnectFrames, encodeConnectFrame } = await import(
  "../server/backend/forwarder/connect-frame.ts"
);
const { historyMessagesSnapshot } = await import("../server/backend/forwarder/history.ts");
const { parseBidiAppendInbound } = await import("../server/backend/forwarder/protocol.ts");
const {
  concatMessages,
  encodeMessage,
  encodeString,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { loadConfig, newProvider, saveConfig } = await import("../server/config/store.ts");

const BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
const RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";

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

function bidiAppendRequest(requestId, clientMessage) {
  return concatMessages(
    encodeString(1, clientMessage.toString("hex")),
    encodeMessage(2, encodeString(1, requestId)),
  );
}

function resumeClientMessage(conversationId, modelHint, conversationState) {
  return encodeMessage(
    1,
    concatMessages(
      encodeMessage(1, conversationState),
      encodeMessage(2, encodeMessage(2, Buffer.alloc(0))),
      encodeString(5, conversationId),
      encodeMessage(9, encodeString(1, modelHint)),
    ),
  );
}

let providerCalls = 0;
const providerBodies = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  providerBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  providerCalls += 1;
  if (providerCalls === 1) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture upstream 502" } }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        reasoning_content: "Recovered reasoning.",
        content: "Recovered on the same provider route.",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  }));
});

let backend;
const unsubscribeAll = [];
const controllers = [];
try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const providerId = "error-reconnect-route";
  const modelID = "error-reconnect-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [newProvider({
    id: providerId,
    displayName: "Error reconnect fixture",
    type: "openai",
    baseURL: `http://127.0.0.1:${address.port}`,
    apiKey: "fixture-key",
    modelID,
    models: [modelID],
    enabled: true,
  })];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const baseUrl = `http://${backend.listenAddr}`;

  async function append(requestId, clientMessage) {
    const framed = encodeConnectFrame(bidiAppendRequest(requestId, clientMessage));
    const decoded = parseBidiAppendInbound(framed);
    assert.equal(decoded.path, "bidi_proto", `${requestId} parser path`);
    const response = await fetch(`${baseUrl}${BIDI_APPEND_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        Accept: "application/connect+proto",
      },
      body: framed,
    });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${requestId} append status`);
    assert.match(String(response.headers.get("content-type")), /^application\/connect\+proto/);
    const frames = decodeConnectFrames(body);
    assert.equal(frames.rest.length, 0);
    assert.equal(frames.frames[0]?.payload.length, 0, `${requestId} empty ACK`);
    assert.equal(frames.frames.at(-1)?.endStream, true, `${requestId} ACK trailer`);
    const trailer = JSON.parse(frames.frames.at(-1)?.payload.toString("utf8") || "{}");
    assert.equal(trailer.error, undefined, `${requestId} append must not be unsupported`);
    return decoded;
  }

  async function openRunStream(requestId) {
    const controller = new AbortController();
    controllers.push(controller);
    const responsePromise = fetch(`${baseUrl}${RUN_SSE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        Accept: "application/connect+proto",
      },
      body: encodeConnectFrame(encodeString(1, requestId)),
      signal: controller.signal,
    });
    await waitFor(() => getStream(requestId), `${requestId} RunSSE subscription`);
    return async () => {
      const response = await responsePromise;
      assert.equal(response.status, 200);
      return decodeConnectFrames(Buffer.from(await response.arrayBuffer())).frames;
    };
  }

  const conversationId = "reconnect-after-502-conversation";
  const firstRequestId = "reconnect-after-502-first";
  const firstEvents = [];
  unsubscribeAll.push(subscribe(firstRequestId, (event) => firstEvents.push(event)).unsubscribe);
  const readFirstRun = await openRunStream(firstRequestId);
  const firstDecoded = await append(
    firstRequestId,
    encodeAgentClientRun({
      text: "Preserve this user input across a provider failure.",
      conversationId,
      modelName: modelHint,
    }),
  );
  assert.equal(firstDecoded.kind, "user_run");
  const firstFrames = await readFirstRun();
  const firstTrailer = firstFrames.findLast((frame) => frame.endStream);
  assert(firstTrailer, "failed run native trailer missing");
  const firstError = JSON.parse(firstTrailer.payload.toString("utf8") || "{}").error;
  assert.equal(firstError?.code, "unavailable", JSON.stringify(firstError));
  assert(Array.isArray(firstError?.details) && firstError.details.length > 0);
  assert.equal(firstEvents.some((event) => event.type === "text"), false);
  const failedCheckpoint = firstEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(failedCheckpoint, "failed run checkpoint missing");
  const failedHistory = await historyMessagesSnapshot(conversationId);
  assert(
    failedHistory.some(
      (message) =>
        message.role === "user" &&
        message.content === "Preserve this user input across a provider failure.",
    ),
    "502 must retain the user input",
  );

  const retryRequestId = "reconnect-after-502-retry";
  const retryEvents = [];
  unsubscribeAll.push(subscribe(retryRequestId, (event) => retryEvents.push(event)).unsubscribe);
  const retryDecoded = await append(
    retryRequestId,
    resumeClientMessage(
      conversationId,
      modelHint,
      Buffer.from(failedCheckpoint.conversationState),
    ),
  );
  assert.equal(retryDecoded.conversationAction, "resume");
  assert.equal(retryDecoded.hasRequestContextPayload, false);
  assert.equal(retryDecoded.hasPendingToolCalls, false);
  await waitFor(
    () => retryEvents.some((event) => event.type === "done" || event.type === "error"),
    "failed-state resume",
  );
  assert.equal(retryEvents.some((event) => event.type === "error"), false);
  assert.equal(retryEvents.filter((event) => event.type === "thinking").length, 1);
  assert.equal(retryEvents.filter((event) => event.type === "text").length, 1);
  const completedCheckpoint = retryEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(completedCheckpoint, "completed retry checkpoint missing");

  const providerCallsAfterRetry = providerCalls;
  const historyAfterRetry = await historyMessagesSnapshot(conversationId);
  const completedRequestId = "reconnect-after-502-completed";
  const completedEvents = [];
  unsubscribeAll.push(
    subscribe(completedRequestId, (event) => completedEvents.push(event)).unsubscribe,
  );
  const completedDecoded = await append(
    completedRequestId,
    resumeClientMessage(
      conversationId,
      modelHint,
      Buffer.from(completedCheckpoint.conversationState),
    ),
  );
  assert.equal(completedDecoded.conversationAction, "resume");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(providerCalls, providerCallsAfterRetry, "completed resume must not call provider");
  assert.equal(completedEvents.some((event) => ["thinking", "text"].includes(event.type)), false);
  assert.deepEqual(await historyMessagesSnapshot(conversationId), historyAfterRetry);

  assert.equal(providerCalls, 2, "502 retry uses exactly two calls on the fixed route");
  assert(providerBodies.every((body) => body.model === modelID));
  const finalHistory = await historyMessagesSnapshot(conversationId);
  const assistants = finalHistory.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1, "only the successful retry commits an assistant message");
  assert.equal(assistants[0].content, "Recovered on the same provider route.");
  assert.equal(
    [...firstEvents, ...retryEvents, ...completedEvents].some(
      (event) => String(event.message || "").includes("unsupported AgentClientMessage"),
    ),
    false,
  );

  console.log("PASS smoke-reconnect-after-error");
} finally {
  for (const unsubscribe of unsubscribeAll.splice(0)) unsubscribe();
  for (const controller of controllers) controller.abort();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
