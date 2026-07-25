import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-providers-"));
process.env.CURSOR_STUDIO_HOME = path.join(root, "studio-home");
process.env.CURSOR_STUDIO_CURSOR_RULES_DIR = path.join(root, "cursor-rules");

let primaryChatHits = 0;

function startFixture(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      });
    });
  });
}

const primary = await startFixture((req, res) => {
  if (req.url?.includes("chat/completions")) primaryChatHits += 1;
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "temporary upstream outage" } }));
});

const backup = await startFixture((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url?.includes("/models")) {
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }, { id: "fixture-model-2" }] }));
    return;
  }
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "fallback-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }),
  );
});

try {
  const chat = await import("../server/backend/agent/provider-chat.ts");
  const health = await import("../server/providers/provider-health.ts");

  const providers = [
    {
      id: "primary",
      displayName: "Primary",
      type: "openai",
      baseURL: primary.baseURL,
      apiKey: "fixture-key",
      modelID: "fixture-model",
      models: ["fixture-model"],
      enabled: true,
      openAIEndpoint: "/v1/chat/completions",
    },
    {
      id: "backup",
      displayName: "Backup",
      type: "openai",
      baseURL: backup.baseURL,
      apiKey: "fixture-key",
      modelID: "fixture-model",
      models: ["fixture-model"],
      enabled: true,
      openAIEndpoint: "/v1/chat/completions",
    },
  ];

  const first = await chat.runProviderChat(providers, ["hello"], "fixture-model");
  assert.equal(first.providerId, "backup");
  assert.equal(first.text, "fallback-ok");
  assert.equal(health.getProviderHealth("primary").state, "degraded");

  const second = await chat.runProviderChat(providers, ["hello again"], "fixture-model");
  assert.equal(second.providerId, "backup");
  assert.equal(health.getProviderHealth("primary").state, "offline");

  const hitsBeforeCooldownSkip = primaryChatHits;
  const third = await chat.runProviderChat(providers, ["skip cooldown"], "fixture-model");
  assert.equal(third.providerId, "backup");
  assert.equal(primaryChatHits, hitsBeforeCooldownSkip);

  const probe = await health.probeProvider(providers[1]);
  assert.equal(probe.ok, true);
  assert.equal(probe.modelCount, 2);
  assert.equal(probe.health.state, "healthy");

  console.log("Provider smoke passed: probe, latency, failover, circuit cooldown");
} finally {
  await Promise.all([
    new Promise((resolve) => primary.server.close(resolve)),
    new Promise((resolve) => backup.server.close(resolve)),
  ]);
  await fs.rm(root, { recursive: true, force: true });
}
