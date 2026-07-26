import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const fixtureHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-protocol-parity-"),
);
process.env.CURSOR_STUDIO_HOME = fixtureHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { getStream } = await import("../server/backend/agent/broker.ts");
const {
  decodeAgentServerMessage,
  encodeAgentClientInteractionResponse,
  encodeAgentClientPrewarm,
  encodeAgentClientRun,
} = await import("../server/backend/forwarder/agent-proto.ts");
const { getActiveStreamActorSnapshot } = await import(
  "../server/backend/forwarder/active-stream-actor.ts"
);
const {
  CONNECT_FLAG_END_STREAM,
  decodeConnectFrames,
  encodeConnectFrame,
} = await import("../server/backend/forwarder/connect-frame.ts");
const {
  appendHistory,
  historyAsChatMessages,
} = await import("../server/backend/forwarder/history.ts");
const { projectConversationState } = await import(
  "../server/backend/forwarder/conversation-state.ts"
);
const {
  concatMessages,
  decodeFields,
  encodeMessage,
  encodeString,
  firstBytes,
  firstString,
  firstVarint,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { loadConfig, newProvider, saveConfig } = await import(
  "../server/config/store.ts"
);

const RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
const BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
const INTERACTION_BRANCHES = {
  2: "WebSearch",
  3: "AskQuestion",
  4: "SwitchMode",
  7: "CreatePlan",
  9: "WebFetch",
};

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
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function bidiAppendRequest(requestId, clientMessage) {
  return concatMessages(
    encodeString(1, clientMessage.toString("hex")),
    encodeMessage(2, encodeString(1, requestId)),
  );
}

function decodeTrailer(frame) {
  assert.equal(frame.endStream, true, "expected a Connect end-stream frame");
  return JSON.parse(frame.payload.toString("utf8") || "{}");
}

function decodeInteractionQuery(payload) {
  const top = decodeFields(payload);
  const query = firstBytes(top, 7);
  if (!query) return undefined;
  const fields = decodeFields(query);
  const branch = fields.find(
    (field) =>
      field.wire === 2 &&
      field.bytes &&
      Object.hasOwn(INTERACTION_BRANCHES, field.field),
  );
  if (!branch?.bytes) return undefined;

  const toolName = INTERACTION_BRANCHES[branch.field];
  const branchFields = decodeFields(branch.bytes);
  let toolCallId = firstString(branchFields, 2);
  if (toolName === "SwitchMode") {
    const args = firstBytes(branchFields, 1);
    toolCallId = args ? firstString(decodeFields(args), 3) : undefined;
  }

  return {
    kind: "interaction_query",
    messageId: firstVarint(fields, 1),
    interactionField: branch.field,
    toolName,
    toolCallId,
  };
}

function decodeWireMessage(frame) {
  if (frame.endStream) return { kind: "end_stream", trailer: decodeTrailer(frame) };
  const decoded = decodeAgentServerMessage(frame.payload);
  const interactionQuery = decodeInteractionQuery(frame.payload);
  if (interactionQuery) {
    return {
      ...interactionQuery,
      projectDecoderKind: decoded.kind,
      projectDecoded: decoded,
    };
  }
  return decoded;
}

class ConnectRunStream {
  constructor(baseUrl, requestId) {
    this.requestId = requestId;
    this.controller = new AbortController();
    this.buffer = Buffer.alloc(0);
    this.queued = [];
    this.frames = [];
    this.response = undefined;
    this.reader = undefined;
    this.timeout = setTimeout(() => this.controller.abort(), 15_000);
    this.timeout.unref?.();
    this.responsePromise = fetch(`${baseUrl}${RUN_SSE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        Accept: "application/connect+proto",
      },
      body: encodeConnectFrame(encodeString(1, requestId)),
      signal: this.controller.signal,
    });
  }

  async waitUntilSubscribed() {
    await waitFor(() => getStream(this.requestId), `${this.requestId} RunSSE subscription`);
  }

  async ensureReader() {
    if (this.reader) return;
    this.response = await this.responsePromise;
    assert.equal(this.response.status, 200, "RunSSE status");
    assert.match(
      String(this.response.headers.get("content-type")),
      /^text\/event-stream/,
      "RunSSE keeps Cursor's SSE response content type",
    );
    assert.equal(
      this.response.headers.get("x-studio-stream-format"),
      "connect_proto",
      "RunSSE selected the Connect protobuf writer",
    );
    assert.ok(this.response.body, "RunSSE response body");
    this.reader = this.response.body.getReader();
  }

  drainFrames() {
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) return;
      const flags = this.buffer.readUInt8(0);
      const frame = {
        flags,
        payload: Buffer.from(this.buffer.subarray(5, 5 + length)),
        compressed: (flags & 0x01) !== 0,
        endStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
      };
      this.buffer = Buffer.from(this.buffer.subarray(5 + length));
      this.queued.push(frame);
      this.frames.push(frame);
    }
  }

  async nextFrame(label) {
    await this.ensureReader();
    while (!this.queued.length) {
      let chunk;
      try {
        chunk = await this.reader.read();
      } catch (error) {
        throw new Error(`RunSSE ended while waiting for ${label}: ${error}`);
      }
      if (chunk.done) {
        throw new Error(`RunSSE closed before ${label}`);
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk.value)]);
      this.drainFrames();
    }
    return this.queued.shift();
  }

  async readUntil(predicate, label) {
    for (;;) {
      const frame = await this.nextFrame(label);
      const message = decodeWireMessage(frame);
      if (predicate(message, frame)) return { message, frame };
      if (frame.endStream) {
        throw new Error(`RunSSE reached its trailer before ${label}`);
      }
    }
  }

  async readToEnd() {
    const terminal = await this.readUntil(
      (_message, frame) => frame.endStream,
      "Connect end-stream trailer",
    );
    clearTimeout(this.timeout);
    return terminal.message.trailer;
  }

  decodedMessages() {
    return this.frames.filter((frame) => !frame.endStream).map(decodeWireMessage);
  }

  async dispose() {
    clearTimeout(this.timeout);
    try {
      await this.reader?.cancel();
    } catch {
      // The server may already have closed after the terminal frame.
    }
    this.controller.abort();
  }
}

const providerCalls = new Map();
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = messages
    .filter((message) => message?.role === "user")
    .map((message) => String(message.content || ""))
    .join("\n");
  const fixture = [
    "CREATE_PLAN_ACCEPT",
    "CREATE_PLAN_REJECT",
    "CREATE_PLAN_CANCEL",
    "SWITCH_MODE_CASE",
  ].find((marker) => userText.includes(marker));
  assert.ok(fixture, `unexpected provider request: ${userText}`);
  const pass = (providerCalls.get(fixture) || 0) + 1;
  providerCalls.set(fixture, pass);
  const hasToolResult = messages.some((message) => message?.role === "tool");

  let message;
  if (fixture.startsWith("CREATE_PLAN")) {
    message = hasToolResult
      ? { content: "UNEXPECTED_CREATE_PLAN_SECOND_PASS" }
      : {
          content: "",
          tool_calls: [
            {
              id: `call-${fixture.toLowerCase()}`,
              type: "function",
              function: {
                name: "CreatePlan",
                arguments: JSON.stringify({
                  name: "Protocol parity plan",
                  overview: "Exercise the complete interaction lifecycle",
                  plan: "1. Decode query\n2. Resolve interaction\n3. Terminate turn",
                  todos: [
                    { id: "todo-protocol", content: "Verify RunSSE", status: "pending" },
                  ],
                }),
              },
            },
          ],
        };
  } else if (!hasToolResult) {
    message = {
      content: "",
      tool_calls: [
        {
          id: "call-switch-mode-protocol",
          type: "function",
          function: {
            name: "SwitchMode",
            arguments: JSON.stringify({
              target_mode_id: "agent",
              explanation: "Continue in agent mode",
            }),
          },
        },
      ],
    };
  } else {
    message = { content: "SWITCH_MODE_SECOND_PASS_OK" };
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 24, completion_tokens: 8 },
    }),
  );
});

let backend;
const openStreams = new Set();
const decoderKinds = [];

try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  const providerId = "protocol-parity-fixture";
  const modelID = "protocol-parity-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "Protocol parity fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      modelSettings: {
        [modelID]: { contextWindowTokens: 64_000, maxCompletionTokens: 2_048 },
      },
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const baseUrl = `http://${backend.listenAddr}`;

  async function append(requestId, clientMessage, expectedStatus = 200) {
    const response = await fetch(`${baseUrl}${BIDI_APPEND_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        Accept: "application/connect+proto",
      },
      body: encodeConnectFrame(bidiAppendRequest(requestId, clientMessage)),
    });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expectedStatus, `BidiAppend ${requestId} status`);
    assert.match(
      String(response.headers.get("content-type")),
      /^application\/connect\+proto/,
    );
    const decoded = decodeConnectFrames(body);
    assert.equal(decoded.rest.length, 0, "complete Connect unary response frames");
    if (expectedStatus === 200) {
      assert.equal(decoded.frames[0]?.endStream, false);
      assert.equal(decoded.frames[0]?.payload.length, 0);
      assert.equal(decoded.frames.at(-1)?.endStream, true);
    }
    return { response, frames: decoded.frames };
  }

  async function openStream(requestId) {
    const stream = new ConnectRunStream(baseUrl, requestId);
    openStreams.add(stream);
    await stream.waitUntilSubscribed();
    return stream;
  }

  async function runPlanCase({ suffix, marker, response }) {
    const requestId = `protocol-plan-${suffix}`;
    const stream = await openStream(requestId);
    await append(
      requestId,
      encodeAgentClientRun({
        text: marker,
        mode: 3,
        conversationId: `conversation-${requestId}`,
        modelName: modelHint,
      }),
    );

    const { message: query } = await stream.readUntil(
      (message) =>
        message.kind === "interaction_query" && message.toolName === "CreatePlan",
      `${suffix} CreatePlan InteractionQuery`,
    );
    decoderKinds.push(query.projectDecoderKind);
    assert.equal(query.projectDecoded.messageId, query.messageId);
    assert.equal(query.projectDecoded.toolName, query.toolName);
    assert.equal(query.projectDecoded.toolCallId, query.toolCallId);
    assert.equal(query.interactionField, 7, "CreatePlan query oneof field");
    assert.ok(query.messageId > 0, "CreatePlan query ID");
    assert.match(query.toolCallId || "", /^call-create_plan_/);
    assert.equal(
      getActiveStreamActorSnapshot(requestId)?.phase,
      "awaiting_user",
      "CreatePlan waits for Cursor",
    );

    if (response === "cancel") {
      const cancelAction = encodeMessage(4, encodeMessage(3, Buffer.alloc(0)));
      await append(requestId, cancelAction);
    } else {
      await append(
        requestId,
        encodeAgentClientInteractionResponse({
          messageId: query.messageId,
          toolName: "CreatePlan",
          ok: response === "accept",
          result:
            response === "accept"
              ? { plan_uri: `file:///fixture/${suffix}.plan.md` }
              : { error: "plan rejected by fixture" },
        }),
      );
    }

    const trailer = await stream.readToEnd();
    const messages = stream.decodedMessages();
    const started = messages.filter(
      (message) => message.kind === "tool_call_started",
    );
    const completed = messages.filter(
      (message) => message.kind === "tool_call_completed",
    );
    assert.equal(started.length, 1, `${suffix} emits one tool start`);
    assert.ok(started[0].modelCallId, `${suffix} start has model_call_id`);
    assert.equal(providerCalls.get(marker), 1, `${suffix} never calls provider twice`);

    if (response === "cancel") {
      assert.equal(completed.length, 0, "cancel does not fabricate tool completion");
      assert.equal(trailer.error?.code, "canceled");
      assert.equal(getActiveStreamActorSnapshot(requestId)?.phase, "canceled");
    } else {
      assert.equal(completed.length, 1, `${suffix} emits one tool completion`);
      assert.equal(completed[0].callId, started[0].callId);
      assert.equal(
        completed[0].modelCallId,
        started[0].modelCallId,
        `${suffix} keeps start/completion on one model call`,
      );
      assert.equal(
        completed[0].toolCall?.resultOk,
        response === "accept",
        `${suffix} preserves Cursor's interaction outcome`,
      );
      assert.deepEqual(trailer, {}, `${suffix} ends with an OK Connect trailer`);
      assert.equal(getActiveStreamActorSnapshot(requestId)?.phase, "completed");
    }
    await stream.dispose();
    openStreams.delete(stream);
  }

  await runPlanCase({
    suffix: "accepted",
    marker: "CREATE_PLAN_ACCEPT",
    response: "accept",
  });
  await runPlanCase({
    suffix: "rejected",
    marker: "CREATE_PLAN_REJECT",
    response: "reject",
  });
  await runPlanCase({
    suffix: "cancelled",
    marker: "CREATE_PLAN_CANCEL",
    response: "cancel",
  });

  const switchRequestId = "protocol-switch-mode";
  const switchStream = await openStream(switchRequestId);
  await append(
    switchRequestId,
    encodeAgentClientRun({
      text: "SWITCH_MODE_CASE",
      mode: 3,
      conversationId: "conversation-protocol-switch-mode",
      modelName: modelHint,
    }),
  );
  const { message: switchQuery } = await switchStream.readUntil(
    (message) =>
      message.kind === "interaction_query" && message.toolName === "SwitchMode",
    "SwitchMode InteractionQuery",
  );
  decoderKinds.push(switchQuery.projectDecoderKind);
  assert.equal(switchQuery.projectDecoded.messageId, switchQuery.messageId);
  assert.equal(switchQuery.projectDecoded.toolName, switchQuery.toolName);
  assert.equal(switchQuery.projectDecoded.toolCallId, switchQuery.toolCallId);
  assert.equal(switchQuery.interactionField, 4, "SwitchMode query oneof field");
  assert.ok(switchQuery.messageId > 0, "SwitchMode query ID");
  assert.equal(switchQuery.toolCallId, "call-switch-mode-protocol");
  await append(
    switchRequestId,
    encodeAgentClientInteractionResponse({
      messageId: switchQuery.messageId,
      toolName: "SwitchMode",
      ok: true,
      result: { approved: true },
    }),
  );
  const switchTrailer = await switchStream.readToEnd();
  const switchMessages = switchStream.decodedMessages();
  const switchStarted = switchMessages.find(
    (message) => message.kind === "tool_call_started",
  );
  const switchCompleted = switchMessages.find(
    (message) => message.kind === "tool_call_completed",
  );
  assert.ok(switchStarted?.modelCallId, "SwitchMode start model_call_id");
  assert.equal(switchCompleted?.callId, switchStarted.callId);
  assert.equal(switchCompleted?.modelCallId, switchStarted.modelCallId);
  assert.equal(
    providerCalls.get("SWITCH_MODE_CASE"),
    2,
    "SwitchMode performs exactly one resumed provider pass",
  );
  assert.equal(
    switchMessages.filter(
      (message) =>
        message.kind === "text_delta" &&
        message.text?.includes("SWITCH_MODE_SECOND_PASS_OK"),
    ).length,
    1,
  );
  assert.deepEqual(switchTrailer, {});
  assert.equal(getActiveStreamActorSnapshot(switchRequestId)?.phase, "completed");
  await switchStream.dispose();
  openStreams.delete(switchStream);

  const missingConversationCalls = [...providerCalls.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const missingConversation = await append(
    "prewarm-missing-conversation",
    encodeAgentClientPrewarm({
      conversationId: "",
      modelName: modelHint,
      mode: 2,
    }),
    400,
  );
  const missingTrailer = decodeTrailer(missingConversation.frames.at(-1));
  assert.equal(missingTrailer.error?.code, "invalid_argument");
  assert.match(missingTrailer.error?.message || "", /conversation_id is required/);
  assert.equal(
    [...providerCalls.values()].reduce((total, value) => total + value, 0),
    missingConversationCalls,
    "invalid Prewarm does not call provider",
  );

  const prewarmConversationId = "prewarm-history-conversation";
  const prewarmRequestId = "prewarm-request-id-collision";
  await appendHistory(prewarmConversationId, "user", "CONVERSATION_HISTORY_SENTINEL");
  await appendHistory(prewarmConversationId, "assistant", "CONVERSATION_REPLY_SENTINEL");
  await appendHistory(prewarmRequestId, "user", "REQUEST_ID_HISTORY_MUST_NOT_APPEAR");
  await appendHistory(prewarmRequestId, "assistant", "REQUEST_ID_REPLY_MUST_NOT_APPEAR");
  const beforePrewarmCalls = [...providerCalls.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const prewarmStream = await openStream(prewarmRequestId);
  await append(
    prewarmRequestId,
    encodeAgentClientPrewarm({
      conversationId: prewarmConversationId,
      modelName: modelHint,
      mode: 2,
    }),
  );
  const { message: checkpoint } = await prewarmStream.readUntil(
    (message) => message.kind === "conversation_checkpoint",
    "Prewarm full conversation checkpoint",
  );
  assert.ok(checkpoint.conversationState?.length, "Prewarm checkpoint has conversation state");
  const projection = projectConversationState(checkpoint.conversationState);
  const projectedText = projection.messages.map((message) => message.content).join("\n");
  assert.match(projectedText, /CONVERSATION_HISTORY_SENTINEL/);
  assert.match(projectedText, /CONVERSATION_REPLY_SENTINEL/);
  assert.doesNotMatch(projectedText, /REQUEST_ID_HISTORY_MUST_NOT_APPEAR/);
  assert.equal(projection.messages.length, 2, "Prewarm publishes the complete retained history");
  assert.equal(checkpoint.maxTokens, 64_000);
  assert.ok(checkpoint.usedTokens > 0, "existing Prewarm history has non-zero token usage");
  assert.deepEqual(
    (await historyAsChatMessages(prewarmConversationId)).map((message) => message.content),
    ["CONVERSATION_HISTORY_SENTINEL", "CONVERSATION_REPLY_SENTINEL"],
    "Prewarm leaves conversation history unchanged",
  );
  assert.deepEqual(
    (await historyAsChatMessages(prewarmRequestId)).map((message) => message.content),
    ["REQUEST_ID_HISTORY_MUST_NOT_APPEAR", "REQUEST_ID_REPLY_MUST_NOT_APPEAR"],
    "Prewarm never treats request_id as the conversation key",
  );
  assert.equal(
    [...providerCalls.values()].reduce((total, value) => total + value, 0),
    beforePrewarmCalls,
    "Prewarm never calls provider",
  );
  await prewarmStream.dispose();
  openStreams.delete(prewarmStream);

  assert.deepEqual(
    decoderKinds,
    ["interaction_query", "interaction_query", "interaction_query", "interaction_query"],
    "project AgentServerMessage decoder must recognize RunSSE InteractionQuery frames",
  );

  console.log("PASS smoke-protocol-parity", {
    createPlan: {
      accepted: providerCalls.get("CREATE_PLAN_ACCEPT"),
      rejected: providerCalls.get("CREATE_PLAN_REJECT"),
      cancelled: providerCalls.get("CREATE_PLAN_CANCEL"),
    },
    switchModeProviderPasses: providerCalls.get("SWITCH_MODE_CASE"),
    prewarmMessages: projection.messages.length,
  });
} finally {
  for (const stream of openStreams) await stream.dispose();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(fixtureHome, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 50,
  });
}
