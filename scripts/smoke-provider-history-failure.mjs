import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-provider-history-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const { encodeAgentClientRun } = await import("../server/backend/forwarder/agent-proto.ts");
const { projectConversationState } = await import("../server/backend/forwarder/conversation-state.ts");
const {
  historyMessagesSnapshot,
  isPromptContextHistoryMessage,
} = await import("../server/backend/forwarder/history.ts");
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

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let responseMode = "429";
let requestCount = 0;
const upstream = http.createServer(async (request, response) => {
  requestCount += 1;
  for await (const _chunk of request) {
    // Drain the request before responding so retry behavior matches a real provider.
  }
  if (responseMode === "empty") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 0 },
    }));
    return;
  }
  const status = Number(responseMode);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    error: { message: status === 429 ? "fixture rate limited" : "fixture bad gateway" },
  }));
});

let backend;
try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;

  for (const mode of ["429", "502", "empty"]) {
    responseMode = mode;
    requestCount = 0;
    const providerId = `failure-${mode}`;
    const modelID = `failure-model-${mode}`;
    const config = await loadConfig();
    config.providers = [
      newProvider({
        id: providerId,
        displayName: `Failure ${mode}`,
        type: "openai",
        baseURL,
        apiKey: "fixture-key",
        modelID,
        models: [modelID],
        enabled: true,
      }),
    ];
    await saveConfig(config);

    const requestId = `provider-history-${mode}-request`;
    const conversationId = `provider-history-${mode}-conversation`;
    const prompt = `keep this user message after ${mode}`;
    const events = [];
    const subscription = subscribe(requestId, (event) => events.push(event));
    try {
      const payload = encodeAgentClientRun({
        text: prompt,
        conversationId,
        modelName: `${providerId}:${modelID}`,
      });
      const response = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, data: payload.toString("hex") }),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();

      await waitFor(
        () => events.some((event) => event.type === "error"),
        `${mode} terminal provider error`,
      );
      assert.equal(
        events.some((event) => event.type === "text"),
        false,
        `${mode} must not create assistant text`,
      );
      assert.equal(
        events.some((event) => event.type === "summary_started"),
        false,
        `${mode} must not enter context compaction`,
      );
      assert.equal(
        requestCount,
        1,
        `${mode} must use one fixed-route provider request before Cursor handles the error`,
      );

      const terminalIndex = events.findIndex((event) => event.type === "error");
      const checkpointIndex = events.findLastIndex((event) => event.type === "checkpoint");
      assert(checkpointIndex >= 0 && checkpointIndex < terminalIndex, `${mode} checkpoint precedes error`);
      const checkpoint = events[checkpointIndex];
      assert(checkpoint.conversationState?.length, `${mode} checkpoint must contain full state`);
      const projected = projectConversationState(checkpoint.conversationState, {
        preferTurns: true,
      });
      assert.deepEqual(
        projected.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
        [prompt],
        `${mode} terminal checkpoint preserves the user turn`,
      );

      const history = (await historyMessagesSnapshot(conversationId)).filter(
        (message) => !isPromptContextHistoryMessage(message),
      );
      assert.deepEqual(
        history.map((message) => ({ role: message.role, content: message.content })),
        [{ role: "user", content: prompt }],
        `${mode} must preserve the user turn without an empty assistant`,
      );
    } finally {
      subscription.unsubscribe();
    }
  }

  console.log("PASS smoke-provider-history-failure");
} finally {
  if (backend) await backend.close();
  await close(upstream);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
