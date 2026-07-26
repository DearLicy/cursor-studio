import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const temporaryHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-provider-replay-"),
);
process.env.CURSOR_STUDIO_HOME = temporaryHome;
process.env.CURSOR_STUDIO_CURSOR_RULES_DIR = path.join(temporaryHome, "rules");

const chat = await import("../server/backend/agent/provider-chat.ts");
const history = await import("../server/backend/forwarder/history.ts");
const checkpoint = await import(
  "../server/backend/forwarder/conversation-checkpoint.ts"
);
const conversationState = await import(
  "../server/backend/forwarder/conversation-state.ts"
);

const reasoningSummary = [{ type: "summary_text", text: "Inspect the workspace." }];
const responsesAssistant = {
  role: "assistant",
  content: "I will inspect it.",
  reasoningContent: "Inspect the workspace.",
  reasoningSignature: "encrypted-reasoning-fixture",
  reasoningSignatureSource: "openai_responses",
  openAIResponsesReasoningId: "rs_fixture",
  openAIResponsesReasoningStatus: "completed",
  openAIResponsesReasoningSummary: reasoningSummary,
  tool_calls: [
    {
      id: "internal-call-fixture",
      type: "function",
      function: {
        name: "Write",
        arguments: '{"path":"README.md","contents":"# README"}',
      },
      openAIResponsesId: "fc_fixture",
      openAIResponsesCallId: "provider-call-fixture",
      openAIResponsesStatus: "completed",
    },
  ],
};

const responsesReplay = chat.toResponsesInput([
  { role: "user", content: "Inspect the workspace" },
  responsesAssistant,
  {
    role: "tool",
    tool_call_id: "internal-call-fixture",
    name: "Write",
    content: "# README",
  },
]);
assert.deepEqual(responsesReplay.input[1], {
  type: "reasoning",
  encrypted_content: "encrypted-reasoning-fixture",
  id: "rs_fixture",
  status: "completed",
  summary: reasoningSummary,
});
assert.deepEqual(responsesReplay.input[2], {
  role: "assistant",
  content: [{ type: "output_text", text: "I will inspect it." }],
});
assert.deepEqual(responsesReplay.input[3], {
  type: "function_call",
  call_id: "provider-call-fixture",
  name: "Write",
  arguments: '{"path":"README.md","contents":"# README"}',
  id: "fc_fixture",
  status: "completed",
});
assert.equal(responsesReplay.input[4].call_id, "provider-call-fixture");
assert.deepEqual(
  chat.toResponsesInput([
    {
      ...responsesAssistant,
      content: "",
      tool_calls: undefined,
    },
  ]).input,
  [responsesReplay.input[1]],
  "A reasoning-only replay must not synthesize an empty assistant message",
);
const legacyIdReplay = chat.toResponsesInput([
  {
    role: "assistant",
    content: "",
    reasoningSignature: "encrypted-without-status",
    reasoningSignatureSource: "openai_responses",
    tool_calls: [
      {
        id: "model-call-fixture::raw-provider-call",
        type: "function",
        function: { name: "Read", arguments: "{}" },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "model-call-fixture::raw-provider-call",
    content: "ok",
  },
]);
assert.equal(legacyIdReplay.input[0].status, undefined);
assert.equal(legacyIdReplay.input[1].call_id, "raw-provider-call");
assert.equal(legacyIdReplay.input[2].call_id, "raw-provider-call");

const anthropicReplay = chat.toAnthropicPayload([
  {
    role: "assistant",
    content: "I will inspect it.",
    reasoningContent: "Choose the smallest relevant file set.",
    reasoningSignature: "anthropic-signature-fixture",
    reasoningSignatureSource: "anthropic",
    tool_calls: responsesAssistant.tool_calls,
  },
]);
assert.deepEqual(anthropicReplay.messages[0].content[0], {
  type: "thinking",
  thinking: "Choose the smallest relevant file set.",
  signature: "anthropic-signature-fixture",
});
assert.equal(anthropicReplay.messages[0].content[1].type, "text");
assert.equal(anthropicReplay.messages[0].content[2].type, "tool_use");
const anthropicSplitReplay = chat.toAnthropicPayload([
  {
    role: "assistant",
    content: "I will inspect it.",
    reasoningContent: "Choose the smallest relevant file set.",
    reasoningSignature: "anthropic-signature-fixture",
    reasoningSignatureSource: "anthropic",
  },
  {
    role: "assistant",
    content: "",
    reasoningContent: "Choose the smallest relevant file set.",
    reasoningSignature: "anthropic-signature-fixture",
    reasoningSignatureSource: "anthropic",
    tool_calls: responsesAssistant.tool_calls,
  },
]);
assert.equal(anthropicSplitReplay.messages.length, 1);
assert.deepEqual(
  anthropicSplitReplay.messages[0].content.map((block) => block.type),
  ["thinking", "text", "tool_use"],
);

const openAIReplay = chat.toOpenAIMessages([responsesAssistant], true);
assert.equal(openAIReplay[0].reasoning_content, "Inspect the workspace.");

const checkpointMessages = [
  {
    role: "user",
    content: "Inspect the workspace",
    cursorMessageId: "cursor-message-fixture",
    turnSequence: 1,
    sourceRequestId: "request-fixture",
  },
  { ...responsesAssistant, sourceRequestId: "request-fixture" },
  {
    role: "tool",
    tool_call_id: "internal-call-fixture",
    name: "Write",
    content: "# README",
    sourceRequestId: "request-fixture",
  },
];
const projectedState = checkpoint.projectConversationCheckpoint({
  messages: checkpointMessages,
  usedTokens: 123,
  maxTokens: 500_000,
});
const roundTrip = conversationState.projectConversationState(projectedState);
const roundTripAssistant = roundTrip.messages.find(
  (message) => message.role === "assistant",
);
assert.equal(roundTripAssistant.reasoningContent, "Inspect the workspace.");
assert.equal(
  roundTripAssistant.reasoningSignature,
  "encrypted-reasoning-fixture",
);
assert.equal(roundTripAssistant.reasoningSignatureSource, "openai_responses");
assert.equal(roundTripAssistant.openAIResponsesReasoningId, "rs_fixture");
assert.deepEqual(
  roundTripAssistant.openAIResponsesReasoningSummary,
  reasoningSummary,
);
assert.equal(
  roundTripAssistant.tool_calls[0].openAIResponsesId,
  "fc_fixture",
);
assert.equal(
  roundTripAssistant.tool_calls[0].openAIResponsesCallId,
  "provider-call-fixture",
);
assert.equal(
  roundTripAssistant.tool_calls[0].openAIResponsesStatus,
  "completed",
);

const historyKey = `provider-replay-${Date.now()}`;
await history.appendAssistantWithTools(
  historyKey,
  responsesAssistant.content,
  responsesAssistant.tool_calls,
  "responses-fixture",
  undefined,
  responsesAssistant,
);
await history.appendToolResult(
  historyKey,
  "internal-call-fixture",
  "Write",
  "# README",
);
const restoredHistory = await history.historyAsChatMessages(historyKey);
assert.equal(restoredHistory[0].reasoningSignatureSource, "openai_responses");
assert.deepEqual(
  restoredHistory[0].openAIResponsesReasoningSummary,
  reasoningSummary,
);
assert.equal(
  restoredHistory[0].tool_calls[0].openAIResponsesCallId,
  "provider-call-fixture",
);

let responsesErrorHits = 0;
let responsesImmediateErrorHits = 0;

function startFixture() {
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : {};

    if (request.url?.endsWith("/responses")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (payload.model === "responses-immediate-error") {
        responsesImmediateErrorHits += 1;
        response.end(
          `data: ${JSON.stringify({
            type: "response.failed",
            error: { code: "502", message: "fixture stream failed before output" },
          })}\n\n`,
        );
        return;
      }
      if (payload.model === "responses-error") {
        responsesErrorHits += 1;
        const events = [
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Retain this partial reasoning.",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_partial",
              status: "incomplete",
              encrypted_content: "encrypted-partial",
              summary: [
                { type: "summary_text", text: "Retain this partial reasoning." },
              ],
            },
          },
          {
            type: "response.failed",
            error: { message: "fixture stream failed" },
          },
        ];
        response.end(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        );
        return;
      }
      const events = [
        {
          type: "response.reasoning_summary_text.delta",
          delta: "Inspect the workspace.",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_runtime",
            status: "completed",
            encrypted_content: "encrypted-runtime",
            summary: reasoningSummary,
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_runtime",
            call_id: "provider-call-runtime",
            status: "in_progress",
    name: "Write",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_runtime",
          delta: '{"path":"README.md"}',
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_runtime",
            call_id: "provider-call-runtime",
            status: "completed",
            name: "Read",
            arguments: '{"path":"README.md"}',
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 20, output_tokens: 5 },
          },
        },
      ];
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }

    if (request.url?.endsWith("/messages")) {
      if (payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const events = [
          {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Check the request." },
          },
          {
            type: "content_block_delta",
            delta: { type: "signature_delta", signature: "anthropic-runtime" },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Done." },
          },
          {
            type: "message_delta",
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        ];
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          content: [
            {
              type: "thinking",
              thinking: "Read the requested file.",
              signature: "anthropic-json-runtime",
            },
            {
              type: "tool_use",
              id: "anthropic-tool-runtime",
              name: "Read",
              input: { path: "README.md" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
      );
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Chat done.",
              reasoning_content: "Use the direct answer.",
              reasoning_signature: "chat-signature-runtime",
              reasoning_signature_source: "openai_chat_fixture",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      }),
    );
  });
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

const fixture = await startFixture();
const provider = (overrides) => ({
  id: `fixture-${overrides.modelID}`,
  displayName: "Replay fixture",
  type: "openai",
  baseURL: fixture.baseURL,
  apiKey: "fixture-key",
  models: [overrides.modelID],
  enabled: true,
  reasoningEffort: "high",
  ...overrides,
});

try {
  const chatResult = await chat.runProviderChatMessages(
    [provider({ modelID: "chat-fixture", openAIEndpoint: "/v1/chat/completions" })],
    [{ role: "user", content: "Hello" }],
    "chat-fixture",
    undefined,
    { includeManagedSystemPrompt: false },
  );
  assert.equal(chatResult.reasoningContent, "Use the direct answer.");
  assert.equal(chatResult.reasoningSignature, "chat-signature-runtime");
  assert.equal(chatResult.reasoningSignatureSource, "openai_chat_fixture");

  const responsesResult = await chat.runProviderChatMessages(
    [provider({ modelID: "responses-fixture", openAIEndpoint: "/v1/responses" })],
    [{ role: "user", content: "Inspect" }],
    "responses-fixture",
    undefined,
    { includeManagedSystemPrompt: false },
  );
  assert.equal(responsesResult.reasoningSignature, "encrypted-runtime");
  assert.equal(responsesResult.reasoningSignatureSource, "openai_responses");
  assert.equal(responsesResult.openAIResponsesReasoningId, "rs_runtime");
  assert.deepEqual(
    responsesResult.openAIResponsesReasoningSummary,
    reasoningSummary,
  );
  assert.equal(responsesResult.toolCalls[0].openAIResponsesId, "fc_runtime");
  assert.equal(
    responsesResult.toolCalls[0].openAIResponsesCallId,
    "provider-call-runtime",
  );
  assert.equal(responsesResult.toolCalls[0].openAIResponsesStatus, "completed");

  let partialThinking = "";
  let partialMetadata = {};
  await assert.rejects(
    chat.runProviderChatMessages(
      [provider({ modelID: "responses-error", openAIEndpoint: "/v1/responses" })],
      [{ role: "user", content: "Inspect" }],
      "responses-error",
      {
        onThinking: (delta) => {
          partialThinking += delta;
        },
        onReasoningMetadata: (metadata) => {
          partialMetadata = { ...partialMetadata, ...metadata };
        },
      },
      { includeManagedSystemPrompt: false },
    ),
    /fixture stream failed/,
  );
  assert.equal(responsesErrorHits, 1, "partial provider output must not be retried");
  assert.equal(partialThinking, "Retain this partial reasoning.");
  assert.equal(partialMetadata.reasoningSignature, "encrypted-partial");
  assert.equal(partialMetadata.reasoningSignatureSource, "openai_responses");
  assert.equal(partialMetadata.openAIResponsesReasoningId, "rs_partial");
  assert.equal(partialMetadata.openAIResponsesReasoningStatus, "incomplete");

  await assert.rejects(
    chat.runProviderChatMessages(
      [
        provider({
          modelID: "responses-immediate-error",
          openAIEndpoint: "/v1/responses",
        }),
      ],
      [{ role: "user", content: "Inspect" }],
      "responses-immediate-error",
      undefined,
      { includeManagedSystemPrompt: false },
    ),
    /fixture stream failed before output/,
  );
  assert.equal(
    responsesImmediateErrorHits,
    1,
    "A parsed stream error must not be retried as a transport failure",
  );

  const anthropicStream = await chat.runProviderChatMessages(
    [provider({ type: "anthropic", modelID: "anthropic-stream" })],
    [{ role: "user", content: "Hello" }],
    "anthropic-stream",
    undefined,
    { includeManagedSystemPrompt: false },
  );
  assert.equal(anthropicStream.reasoningContent, "Check the request.");
  assert.equal(anthropicStream.reasoningSignature, "anthropic-runtime");
  assert.equal(anthropicStream.reasoningSignatureSource, "anthropic");

  const anthropicJson = await chat.runProviderChatMessages(
    [provider({ type: "anthropic", modelID: "anthropic-json" })],
    [{ role: "user", content: "Read" }],
    "anthropic-json",
    undefined,
    {
      includeManagedSystemPrompt: false,
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
  );
  assert.equal(anthropicJson.reasoningContent, "Read the requested file.");
  assert.equal(anthropicJson.reasoningSignature, "anthropic-json-runtime");
  assert.equal(anthropicJson.reasoningSignatureSource, "anthropic");
  assert.equal(anthropicJson.toolCalls[0].id, "anthropic-tool-runtime");

  console.log(
    "PASS provider reasoning capture, replay metadata, history, and checkpoint round-trip",
  );
} finally {
  await new Promise((resolve) => fixture.server.close(resolve));
  await fs.rm(temporaryHome, { recursive: true, force: true });
}
