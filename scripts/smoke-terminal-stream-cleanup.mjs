import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-terminal-cleanup-"),
);
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { getStream } = await import("../server/backend/agent/broker.ts");
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let providerCalls = 0;
let holdNextProviderResponse = false;
let releaseHeldProviderResponse;
let heldProviderResponse = Promise.resolve();
const upstream = http.createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain the provider request.
  }
  providerCalls += 1;
  if (holdNextProviderResponse) {
    holdNextProviderResponse = false;
    heldProviderResponse = new Promise((resolve) => {
      releaseHeldProviderResponse = resolve;
    });
    await heldProviderResponse;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        reasoning_content: "TERMINAL_CLEANUP_THOUGHT",
        content: "TERMINAL_CLEANUP_REPLY",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 16, completion_tokens: 4 },
  }));
});

let backend;
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "terminal-cleanup-provider",
      displayName: "Terminal cleanup fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID: "terminal-cleanup-model",
      models: ["terminal-cleanup-model"],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const base = `http://${backend.listenAddr}`;
  const requestId = "terminal-stream-cleanup-request";

  const openRunSse = (id) => fetch(
    `${base}/agent.v1.AgentService/RunSSE?wire=json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: id }),
    },
  );

  const firstStream = await openRunSse(requestId);
  assert.equal(firstStream.status, 200);
  const run = await fetch(`${base}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      conversation_id: "terminal-stream-cleanup-conversation",
      text: "Complete one provider turn",
      model: "terminal-cleanup-provider:terminal-cleanup-model",
    }),
  });
  assert.equal(run.status, 200);
  await run.arrayBuffer();

  const firstBody = await firstStream.text();
  assert.match(firstBody, /TERMINAL_CLEANUP_THOUGHT/);
  assert.match(firstBody, /TERMINAL_CLEANUP_REPLY/);
  assert.equal(providerCalls, 1);
  await waitFor(
    () => getStream(requestId) === undefined,
    "consumed terminal stream cleanup",
  );

  const reconnect = await openRunSse(requestId);
  assert.equal(reconnect.status, 200);
  const replacement = getStream(requestId);
  assert(replacement, "RunSSE reconnect creates a fresh placeholder");
  assert.equal(replacement.backlog.length, 0);
  assert.equal(
    replacement.backlog.some(
      (event) => event.type === "thinking" || event.type === "text",
    ),
    false,
    "a reconnect must not replay consumed terminal output",
  );
  await reconnect.body.cancel();
  await waitFor(
    () => getStream(requestId) === undefined,
    "reconnect placeholder cleanup",
  );
  assert.equal(providerCalls, 1, "RunSSE reconnect must not call the provider");

  // Disconnect while the provider is still active, then let it commit its
  // terminal backlog without a subscriber. Reconnecting the same RunSSE must
  // replay that one completed turn instead of initiating another provider run.
  const raceRequestId = "terminal-stream-race-request";
  const raceStream = await openRunSse(raceRequestId);
  assert.equal(raceStream.status, 200);
  holdNextProviderResponse = true;
  const raceRun = await fetch(`${base}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: raceRequestId,
      conversation_id: "terminal-stream-race-conversation",
      text: "Complete while the first RunSSE transport is disconnected",
      model: "terminal-cleanup-provider:terminal-cleanup-model",
    }),
  });
  assert.equal(raceRun.status, 200);
  await raceRun.arrayBuffer();
  await waitFor(() => providerCalls === 2, "held provider request");
  await raceStream.body.cancel();
  await waitFor(
    () => getStream(raceRequestId)?.subscriberCount === 0,
    "terminal race disconnect",
  );
  releaseHeldProviderResponse();
  await waitFor(
    () => getStream(raceRequestId)?.done === true,
    "terminal race completion without subscriber",
  );

  const raceReconnect = await openRunSse(raceRequestId);
  assert.equal(raceReconnect.status, 200);
  const raceReplay = await raceReconnect.text();
  assert.match(raceReplay, /TERMINAL_CLEANUP_THOUGHT/);
  assert.match(raceReplay, /TERMINAL_CLEANUP_REPLY/);
  assert.equal(providerCalls, 2, "terminal replay keeps exactly one provider call");

  const placeholderId = "empty-runsse-placeholder";
  const placeholder = await openRunSse(placeholderId);
  assert.equal(placeholder.status, 200);
  assert(getStream(placeholderId));
  await placeholder.body.cancel();
  await waitFor(
    () => getStream(placeholderId) === undefined,
    "empty RunSSE placeholder cleanup",
  );

  console.log("PASS smoke-terminal-stream-cleanup");
} finally {
  releaseHeldProviderResponse?.();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 });
}
