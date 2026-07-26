import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-orphan-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";
process.env.CURSOR_STUDIO_ORPHAN_GRACE_MS = "120";

const { startBackend } = await import("../server/backend/local.ts");
const { getStream, isStreamCancelled } = await import(
  "../server/backend/agent/broker.ts"
);
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

async function waitFor(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let providerStarted = false;
const openResponses = new Set();
const upstream = http.createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain the provider request and keep its response open until cancellation.
  }
  providerStarted = true;
  openResponses.add(response);
  response.once("close", () => openResponses.delete(response));
});

let backend;
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "orphan-provider",
      displayName: "Orphan fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID: "orphan-model",
      models: ["orphan-model"],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const base = `http://${backend.listenAddr}`;
  const requestId = "orphan-stream-request";
  const conversationId = "orphan-stream-conversation";

  const run = await fetch(`${base}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      text: "Keep this provider request running",
      conversation_id: conversationId,
      model: "orphan-provider:orphan-model",
    }),
  });
  assert.equal(run.status, 200);
  await run.arrayBuffer();

  const openRunSse = () => fetch(
    `${base}/agent.v1.AgentService/RunSSE?wire=json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    },
  );

  const first = await openRunSse();
  assert.equal(first.status, 200);
  await waitFor(() => providerStarted, "provider request to start");
  await first.body.cancel();
  await waitFor(
    () => getStream(requestId)?.subscriberCount === 0,
    "first RunSSE disconnect",
  );

  const second = await openRunSse();
  assert.equal(second.status, 200);
  await waitFor(
    () => getStream(requestId)?.subscriberCount === 1,
    "RunSSE reconnect",
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(
    isStreamCancelled(requestId),
    false,
    "reconnect invalidates the stale orphan-cancel timer",
  );

  await second.body.cancel();
  await waitFor(
    () => isStreamCancelled(requestId),
    "orphan stream cancellation after grace period",
  );
  assert.equal(getStream(requestId)?.subscriberCount, 0);

  console.log("PASS smoke-orphan-stream");
} finally {
  for (const response of openResponses) response.destroy();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 });
}
