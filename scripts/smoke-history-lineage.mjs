import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-lineage-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const { loadHistory } = await import("../server/backend/forwarder/history.ts");
const { decodeAgentClientMessage } = await import(
  "../server/backend/forwarder/agent-proto.ts"
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

async function waitFor(check, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const upstream = http.createServer((_, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: "lineage stored" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  }));
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
      id: "lineage-route",
      displayName: "Lineage route",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID: "lineage-model",
      models: ["lineage-model"],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const requestId = "lineage-request";
  const conversationId = "lineage-conversation";
  const userMessageId = "cursor-user-message-17";
  // Imported Cursor turns are provider replay with TurnSeq=0. The
  // first locally owned turn starts at sequence one regardless of replay size.
  const existingTurn = (turn, request) => encodeMessage(
    1,
    concatMessages(
      encodeMessage(1, concatMessages(
        encodeString(1, `existing user ${turn}`),
        encodeString(2, `existing-user-${turn}`),
        encodeUint32(4, 1),
      )),
      encodeMessage(2, encodeMessage(1, encodeString(1, `existing answer ${turn}`))),
      encodeString(3, request),
    ),
  );
  const conversationState = concatMessages(
    encodeMessage(8, existingTurn(1, "existing-request-1")),
    encodeMessage(8, existingTurn(2, "existing-request-2")),
  );
  const userMessage = concatMessages(
    encodeString(1, "persist this lineage metadata"),
    encodeString(2, userMessageId),
    encodeUint32(4, 1),
  );
  const action = encodeMessage(1, encodeMessage(1, userMessage));
  const runRequest = concatMessages(
    encodeMessage(1, conversationState),
    encodeMessage(2, action),
    encodeString(5, conversationId),
    encodeMessage(9, encodeString(1, "lineage-route:lineage-model")),
  );
  const clientMessage = encodeMessage(1, runRequest);
  assert.equal(
    decodeAgentClientMessage(clientMessage).conversationTurnCount,
    2,
    "the fixture must expose two valid existing Cursor turns",
  );

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
    "lineage request to complete",
  );
  assert.equal(events.some((event) => event.type === "error"), false);

  const history = await loadHistory(conversationId);
  const user = history.messages.find(
    (message) =>
      message.role === "user" &&
      message.sourceRequestId === requestId,
  );
  assert(user, "persisted user message missing");
  assert.equal(user.cursorMessageId, userMessageId);
  assert.equal(user.turnSequence, 1);
  assert.equal(user.sourceRequestId, requestId);
  console.log("PASS smoke-history-lineage");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
