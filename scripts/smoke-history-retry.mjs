import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-history-retry-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const {
  appendHistory,
  historyAsChatMessages,
  loadHistory,
  updateHistoryRoute,
} = await import("../server/backend/forwarder/history.ts");
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

function encodeRetryRun({ text, conversationId, userMessageId, priorTurnCount, modelHint }) {
  const conversationState = concatMessages(
    ...Array.from(
      { length: priorTurnCount },
      (_, index) => encodeMessage(8, Buffer.from(`existing-turn-${index + 1}`)),
    ),
  );
  const userMessage = concatMessages(
    encodeString(1, text),
    encodeString(2, userMessageId),
    encodeUint32(4, 1),
  );
  const action = encodeMessage(1, encodeMessage(1, userMessage));
  const runRequest = concatMessages(
    encodeMessage(1, conversationState),
    encodeMessage(2, action),
    encodeString(5, conversationId),
    encodeMessage(9, encodeString(1, modelHint)),
  );
  return encodeMessage(1, runRequest);
}

const upstreamRequests = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: "replacement completed" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 16, completion_tokens: 4 },
  }));
});

let backend;
let unsubscribe = () => {};
try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");

  const providerId = "history-retry-route";
  const modelID = "history-retry-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "History retry route",
      type: "openai",
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const conversationId = "history-retry-conversation";
  const retryMessageId = "cursor-user-message-retry";
  await appendHistory(
    conversationId,
    "user",
    "KEEP_USER",
    modelHint,
    undefined,
    { cursorMessageId: "cursor-user-message-keep", turnSequence: 1 },
  );
  await appendHistory(conversationId, "assistant", "KEEP_ANSWER", modelHint);
  await appendHistory(
    conversationId,
    "user",
    "OLD_BRANCH",
    modelHint,
    undefined,
    { cursorMessageId: retryMessageId, turnSequence: 2 },
  );
  await appendHistory(conversationId, "assistant", "OLD_ANSWER", modelHint);
  await appendHistory(
    conversationId,
    "user",
    "ABANDONED_FOLLOWUP",
    modelHint,
    undefined,
    { cursorMessageId: "cursor-user-message-abandoned", turnSequence: 3 },
  );
  await appendHistory(conversationId, "assistant", "ABANDONED_ANSWER", modelHint);
  await updateHistoryRoute(conversationId, {
    modelHint,
    providerId,
    modelID,
  });

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const requestId = "history-retry-request";
  const events = [];
  ({ unsubscribe } = subscribe(requestId, (event) => events.push(event)));

  const clientMessage = encodeRetryRun({
    text: "REPLACEMENT_USER",
    conversationId,
    userMessageId: retryMessageId,
    priorTurnCount: 1,
    modelHint,
  });
  const response = await fetch(
    `http://${backend.listenAddr}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, data: clientMessage.toString("hex") }),
    },
  );
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  await waitFor(
    () => events.some((event) => event.type === "done" || event.type === "error"),
    "replacement run to complete",
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(upstreamRequests.length, 1, "replacement must make one model request");

  const requestContents = upstreamRequests[0].messages.map((message) => String(message.content || ""));
  assert(requestContents.includes("KEEP_USER"));
  assert(requestContents.includes("KEEP_ANSWER"));
  assert(requestContents.includes("REPLACEMENT_USER"));
  for (const abandoned of ["OLD_BRANCH", "OLD_ANSWER", "ABANDONED_FOLLOWUP", "ABANDONED_ANSWER"]) {
    assert.equal(requestContents.includes(abandoned), false, `provider prompt retained ${abandoned}`);
  }

  const persisted = await loadHistory(conversationId);
  const replacement = persisted.messages.find(
    (message) => message.role === "user" && message.content === "REPLACEMENT_USER",
  );
  assert(replacement, "replacement user turn was not persisted");
  assert.equal(replacement.cursorMessageId, retryMessageId);
  assert.equal(replacement.turnSequence, 2);
  assert.equal(replacement.sourceRequestId, requestId);
  const persistedContents = (await historyAsChatMessages(conversationId))
    .map((message) => String(message.content || ""));
  for (const abandoned of ["OLD_BRANCH", "OLD_ANSWER", "ABANDONED_FOLLOWUP", "ABANDONED_ANSWER"]) {
    assert.equal(persistedContents.includes(abandoned), false, `persisted history retained ${abandoned}`);
  }

  console.log("PASS smoke-history-retry");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
