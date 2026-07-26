import assert from "node:assert/strict";
import http from "node:http";
import { startBackend } from "../server/backend/local.ts";
import {
  encodeAvailableModelsProto,
} from "../server/backend/forwarder/mock-proto.ts";
import {
  buildAvailableModels,
  resolveContextWindowTokensForModel,
} from "../server/backend/forwarder/models.ts";
import {
  decodeFields,
  encodeMessage,
  encodeString,
  firstString,
  firstVarint,
} from "../server/backend/forwarder/protobuf-wire.ts";
import { encodeConnectFrame } from "../server/backend/forwarder/connect-frame.ts";
import {
  estimateChatMessagesTokens,
  isProviderRequestError,
  prepareProviderMessages,
  runProviderChatMessages,
} from "../server/backend/agent/provider-chat.ts";

const integration = {
  displayName: "Fixture User",
  contactEmail: "fixture@example.test",
  planName: "Fixture Plan",
  defaultContextWindowTokens: 500_000,
};

const providers = [
  {
    id: "priority",
    displayName: "Priority",
    type: "openai",
    baseURL: "https://example.test/v1",
    apiKey: "fixture-key",
    modelID: "model-specific",
    models: ["model-specific", "provider-default"],
    modelSettings: {
      "model-specific": { contextWindowTokens: 111_111 },
    },
    contextWindowTokens: 222_222,
    enabled: true,
  },
  {
    id: "global",
    displayName: "Global",
    type: "openai",
    baseURL: "https://example.test/v1",
    apiKey: "fixture-key",
    modelID: "global-default",
    models: ["global-default"],
    enabled: true,
  },
];

function modelLimitRequest(modelName) {
  return encodeMessage(1, encodeString(1, modelName));
}

function findAvailableModelFields(payload, name) {
  for (const field of decodeFields(payload)) {
    if (field.field !== 2 || !field.bytes) continue;
    const modelFields = decodeFields(field.bytes);
    if (firstString(modelFields, 1) === name) return modelFields;
  }
  return undefined;
}

async function post(base, body) {
  const response = await fetch(
    `${base}/aiserver.v1.AiService/GetEffectiveTokenLimit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        Accept: "application/proto",
      },
      body,
    },
  );
  assert.equal(response.status, 200);
  const responseBody = Buffer.from(await response.arrayBuffer());
  return firstVarint(decodeFields(responseBody), 1);
}

async function withFixtureUpstream(run) {
  let captured;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: 8 },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
    return captured;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const available = buildAvailableModels(providers, integration);
assert.equal(resolveContextWindowTokensForModel(providers, "priority:model-specific", integration), 111_111);
assert.equal(resolveContextWindowTokensForModel(providers, "priority:provider-default:high", integration), 222_222);
assert.equal(resolveContextWindowTokensForModel(providers, "global", integration), 500_000);
assert.equal(resolveContextWindowTokensForModel(providers, undefined, integration), 500_000);

const encodedModels = encodeAvailableModelsProto(available);
const specificFields = findAvailableModelFields(encodedModels, "priority:model-specific");
assert(specificFields, "specific model present");
assert.equal(firstVarint(specificFields, 15), 111_111);
assert.equal(firstVarint(specificFields, 16), 111_111);
const globalFields = findAvailableModelFields(encodedModels, "global");
assert(globalFields, "global model present");
assert.equal(firstVarint(globalFields, 15), 500_000);
assert.equal(firstVarint(globalFields, 16), 500_000);
console.log("available-model context fields ok");

const backend = await startBackend("127.0.0.1:19095", async () => ({
  routingMode: "local",
  providers,
  cursorIntegration: integration,
}));
try {
  const base = `http://${backend.listenAddr}`;
  assert.equal(await post(base, modelLimitRequest("priority:model-specific")), 111_111);
  assert.equal(await post(base, modelLimitRequest("priority:provider-default")), 222_222);
  assert.equal(await post(base, modelLimitRequest("global")), 500_000);
  assert.equal(
    await post(base, encodeConnectFrame(modelLimitRequest("global"))),
    500_000,
  );
  console.log("GetEffectiveTokenLimit proto and Connect requests ok");
} finally {
  await backend.close();
}

const requestBody = await withFixtureUpstream(async (baseURL) => {
  await runProviderChatMessages(
    [
      {
        id: "limit-provider",
        displayName: "Limit provider",
        type: "openai",
        baseURL,
        apiKey: "fixture-key",
        modelID: "fixture-model",
        models: ["fixture-model"],
        maxCompletionTokens: 4096,
        enabled: true,
      },
    ],
    [{ role: "user", content: "budget fixture" }],
    "limit-provider",
    undefined,
    { maxCompletionTokens: 1234, timeoutMs: 10_000 },
  );
});
assert.equal(requestBody.max_tokens, 1234);
console.log("provider output context budget ok");

const defaultOutputBudget = prepareProviderMessages(
  {
    id: "default-output-budget",
    displayName: "Default output budget",
    type: "openai",
    baseURL: "https://example.test/v1",
    apiKey: "fixture-key",
    modelID: "fixture-model",
    models: ["fixture-model"],
    contextWindowTokens: 200_000,
    maxCompletionTokens: 500_000,
    enabled: true,
  },
  [{ role: "user", content: "short normal conversation" }],
  200_000,
  198_000,
);
assert.equal(defaultOutputBudget.budget.maxCompletionTokens, 65_536);
assert.equal(defaultOutputBudget.budget.safetyMarginTokens, 1_024);
assert.ok(defaultOutputBudget.budget.inputBudgetTokens > 100_000);
console.log("default output cap and safety margin ok");

const constrainedProvider = {
  id: "history-budget",
  displayName: "History budget",
  type: "openai",
  baseURL: "https://example.test/v1",
  apiKey: "fixture-key",
  modelID: "history-model",
  models: ["history-model"],
  modelSettings: {
    "history-model": {
      contextWindowTokens: 2048,
      maxCompletionTokens: 512,
    },
  },
  contextWindowTokens: 4096,
  enabled: true,
};

const historyFixture = [
  { role: "system", content: "SYSTEM_MARKER" },
  { role: "user", content: `OLD_TURN_MARKER ${"old ".repeat(2600)}` },
  {
    role: "assistant",
    content: "old tool request",
    tool_calls: [
      {
        id: "old-call",
        type: "function",
        function: { name: "Read", arguments: '{"path":"old.txt"}' },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "old-call",
    name: "Read",
    content: `OLD_TOOL_MARKER ${"result ".repeat(900)}`,
  },
  { role: "user", content: `LATEST_TURN_MARKER ${"latest ".repeat(220)}` },
];

const preparedHistory = prepareProviderMessages(
  constrainedProvider,
  historyFixture,
  10_000,
);
assert.equal(preparedHistory.budget.contextWindowTokens, 2048);
assert.equal(preparedHistory.budget.maxCompletionTokens, 512);
assert(
  estimateChatMessagesTokens(preparedHistory.messages) <= preparedHistory.budget.inputBudgetTokens,
  "prepared history stays within the provider input budget",
);
assert(
  preparedHistory.messages.some(
    (message) => message.role === "user" && message.content.includes("LATEST_TURN_MARKER"),
  ),
  "latest turn is retained",
);
assert(
  !JSON.stringify(preparedHistory.messages).includes("OLD_TURN_MARKER"),
  "old complete turn is removed before truncating the latest turn",
);
assert(
  !preparedHistory.messages.some(
    (message) => message.role === "tool" && message.tool_call_id === "old-call",
  ),
  "removed history does not leave an orphaned tool result",
);

await assert.rejects(
  () => runProviderChatMessages(
    [constrainedProvider],
    historyFixture,
    "history-budget",
    undefined,
    {
      globalContextWindowTokens: 10_000,
      maxCompletionTokens: 512,
      strictContextBudget: true,
    },
  ),
  (error) => {
    assert(isProviderRequestError(error), "strict budget keeps the provider route");
    assert.match(String(error.message), /context input exceeds/i);
    return true;
  },
);
console.log("strict forwarding budget rejects before history is trimmed");

const compactedRequestBody = await withFixtureUpstream(async (baseURL) => {
  await runProviderChatMessages(
    [{ ...constrainedProvider, baseURL }],
    historyFixture,
    "history-budget",
    undefined,
    {
      globalContextWindowTokens: 10_000,
      maxCompletionTokens: 512,
      timeoutMs: 10_000,
    },
  );
});
assert.equal(compactedRequestBody.max_tokens, 512);
assert(
  JSON.stringify(compactedRequestBody.messages).includes("LATEST_TURN_MARKER"),
  "upstream request keeps the newest turn",
);
assert(
  !JSON.stringify(compactedRequestBody.messages).includes("OLD_TURN_MARKER"),
  "upstream request receives the compacted history rather than the full transcript",
);
console.log("provider history compaction budget ok");
console.log("PASS smoke-context-limit");
