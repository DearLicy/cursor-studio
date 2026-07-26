import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-prewarm-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const {
  decodeAgentClientMessage,
  encodeAgentClientPrewarm,
} = await import("../server/backend/forwarder/agent-proto.ts");
const { historyAsChatMessages, historyRoute } = await import("../server/backend/forwarder/history.ts");
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

async function waitFor(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let providerCalls = 0;
const upstream = http.createServer((_, response) => {
  providerCalls += 1;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }));
});

let backend;
let unsubscribe = () => {};
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "prewarm-route",
      displayName: "Prewarm route",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID: "prewarm-model",
      models: ["prewarm-model"],
      modelSettings: {
        "prewarm-model": { contextWindowTokens: 32_768, maxCompletionTokens: 1_024 },
      },
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const conversationId = "prewarm-conversation";
  const requestId = "prewarm-request";
  const modelHint = "prewarm-route:prewarm-model:high";
  const payload = encodeAgentClientPrewarm({
    conversationId,
    modelName: modelHint,
    mode: 2,
  });
  const decoded = decodeAgentClientMessage(payload);
  assert.equal(decoded.kind, "prewarm_request");
  assert.equal(decoded.conversationId, conversationId);
  assert.equal(decoded.modelHint, modelHint);
  assert.equal(decoded.mode, 2);
  assert.deepEqual(decoded.texts, [], "prewarm must not decode metadata as a prompt");

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const events = [];
  ({ unsubscribe } = subscribe(requestId, (event) => events.push(event)));
  const response = await fetch(`${`http://${backend.listenAddr}`}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      data: payload.toString("hex"),
    }),
  });
  assert.equal(response.status, 200, "prewarm receives an empty Bidi acknowledgement");
  await response.arrayBuffer();

  await waitFor(async () => {
    const route = await historyRoute(conversationId);
    return route.providerId === "prewarm-route";
  }, "prewarm route persistence");
  const route = await historyRoute(conversationId);
  assert.equal(route.modelHint, modelHint);
  assert.equal(route.providerId, "prewarm-route");
  assert.equal(route.modelID, "prewarm-model");
  assert.deepEqual(
    await historyAsChatMessages(conversationId),
    [],
    "prewarm must not write user history",
  );
  assert.equal(providerCalls, 0, "prewarm must not call the provider");
  const checkpoint = events.find((event) => event.type === "checkpoint");
  assert(checkpoint, "prewarm publishes a context checkpoint");
  assert.equal(checkpoint.maxTokens, 32_768);
  assert.equal(checkpoint.usedTokens, 0);

  console.log("PASS smoke-prewarm");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
