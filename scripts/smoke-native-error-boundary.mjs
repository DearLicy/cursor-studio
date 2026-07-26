import assert from "node:assert/strict";
import http from "node:http";

import {
  isProviderRequestError,
  runProviderChatMessages,
} from "../server/backend/agent/provider-chat.ts";

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

let failingStatus = 502;
const calls = { selected: 0, fallback: 0 };
const upstream = http.createServer((request, response) => {
  const authorization = String(request.headers.authorization || "");
  if (authorization === "Bearer selected-key") {
    calls.selected += 1;
    response.writeHead(failingStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: `fixture ${failingStatus}` } }));
    return;
  }

  calls.fallback += 1;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: "FALLBACK_MUST_NOT_RUN" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
});

try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const providers = [
    {
      id: "selected",
      displayName: "Selected route",
      type: "openai",
      baseURL,
      apiKey: "selected-key",
      modelID: "selected-model",
      models: ["selected-model"],
      enabled: true,
    },
    {
      id: "fallback",
      displayName: "Fallback route",
      type: "openai",
      baseURL,
      apiKey: "fallback-key",
      modelID: "fallback-model",
      models: ["fallback-model"],
      enabled: true,
      failoverPriority: 1,
    },
  ];

  for (const status of [429, 502]) {
    failingStatus = status;
    calls.selected = 0;
    calls.fallback = 0;
    await assert.rejects(
      runProviderChatMessages(
        providers,
        [{ role: "user", content: `native error ${status}` }],
        "selected:selected-model",
        undefined,
        {
          cursorNativeErrorBoundary: true,
          timeoutMs: 5_000,
        },
      ),
      (error) => {
        assert.equal(isProviderRequestError(error), true);
        assert.equal(error.providerId, "selected");
        assert.equal(error.modelID, "selected-model");
        assert.equal(error.status, status);
        return true;
      },
    );
    assert.equal(calls.selected, 1, `${status} must execute one selected-route request`);
    assert.equal(calls.fallback, 0, `${status} must not switch provider routes`);
  }

  console.log("PASS smoke-native-error-boundary");
} finally {
  await close(upstream);
}
