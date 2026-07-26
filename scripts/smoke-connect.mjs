import assert from "node:assert/strict";
import { startBackend } from "../server/backend/local.ts";
import { ensureStream, getStream, publish } from "../server/backend/agent/broker.ts";
import {
  encodeAgentClientHeartbeat,
  encodeAgentClientInteractionResponse,
  encodeAgentClientRun,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  concatMessages,
  decodeFields,
  encodeMessage,
  encodeString,
  encodeUint32,
} from "../server/backend/forwarder/protobuf-wire.ts";
import { encodeConnectFrame, decodeConnectFrames } from "../server/backend/forwarder/connect-frame.ts";
import { encodeTokenUsageProto } from "../server/backend/forwarder/mock-proto.ts";

const config = {
  routingMode: "local",
  providers: [
    {
      id: "smoke-provider",
      displayName: "Smoke Provider",
      type: "openai",
      modelID: "smoke-model",
      models: ["smoke-model"],
      enabled: true,
    },
  ],
  balanceAccounts: [],
};

const backend = await startBackend("127.0.0.1:19091", async () => config);
const base = `http://${backend.listenAddr}`;

async function post(path, body, contentType, accept) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...(accept ? { Accept: accept } : {}),
    },
    body,
  });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

try {
  const serverTime = await post(
    "/aiserver.v1.AiService/ServerTime",
    Buffer.alloc(0),
    "application/proto",
    "application/proto",
  );
  assert.equal(serverTime.res.status, 200);
  assert.match(String(serverTime.res.headers.get("content-type")), /^application\/proto/);
  const fields = decodeFields(serverTime.body);
  assert.equal(fields.filter((f) => f.field === 1 && f.wire === 1).length, 1);
  assert.equal(fields.filter((f) => f.field === 2 && f.wire === 1).length, 1);

  const bidiBody = encodeMessage(2, encodeString(1, "smoke-connect"));
  const bidi = await post(
    "/aiserver.v1.BidiService/BidiAppend",
    bidiBody,
    "application/proto",
    "application/proto",
  );
  assert.equal(bidi.res.status, 200);
  assert.match(String(bidi.res.headers.get("content-type")), /^application\/proto/);
  assert.equal(bidi.body.length, 0);

  for (const [requestId, clientMessage] of [
    ["smoke-short-heartbeat", encodeAgentClientHeartbeat()],
    ["smoke-short-kv", encodeMessage(3, Buffer.alloc(0))],
  ]) {
    const controlBidi = concatMessages(
      encodeString(1, clientMessage.toString("hex")),
      encodeMessage(2, encodeString(1, requestId)),
    );
    const control = await post(
      "/aiserver.v1.BidiService/BidiAppend",
      encodeConnectFrame(controlBidi),
      "application/connect+proto",
      "application/connect+proto",
    );
    assert.equal(control.res.status, 200, `${requestId} must be acknowledged`);
    assert.equal(getStream(requestId), undefined, `${requestId} must not create a stream`);
  }

  const missingConversationRun = encodeAgentClientRun({ text: "missing conversation" });
  const missingConversationBidi = concatMessages(
    encodeString(1, missingConversationRun.toString("hex")),
    encodeMessage(2, encodeString(1, "smoke-missing-conversation")),
  );
  const missingConversation = await post(
    "/aiserver.v1.BidiService/BidiAppend",
    encodeConnectFrame(missingConversationBidi),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(missingConversation.res.status, 400);

  const standaloneUserAction = encodeMessage(
    4,
    encodeMessage(1, encodeMessage(1, encodeString(1, "standalone user action"))),
  );
  const standaloneBidi = concatMessages(
    encodeString(1, standaloneUserAction.toString("hex")),
    encodeMessage(2, encodeString(1, "smoke-standalone-action")),
  );
  const standalone = await post(
    "/aiserver.v1.BidiService/BidiAppend",
    encodeConnectFrame(standaloneBidi),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(standalone.res.status, 400);
  console.log("short metadata and missing run context follow dispatch rules");

  const inactiveClientMessages = [
    [
      "smoke-inactive-exec-result",
      encodeMessage(
        2,
        concatMessages(
          encodeUint32(1, 101),
          encodeMessage(2, Buffer.alloc(0)),
        ),
      ),
    ],
    [
      "smoke-inactive-interaction",
      encodeAgentClientInteractionResponse({
        messageId: 102,
        toolName: "SwitchMode",
        ok: true,
        result: { approved: true },
      }),
    ],
    [
      "smoke-inactive-exec-throw",
      encodeMessage(
        5,
        encodeMessage(
          2,
          concatMessages(
            encodeUint32(1, 103),
            encodeString(2, "fixture client failure"),
          ),
        ),
      ),
    ],
  ];
  for (const [requestId, clientMessage] of inactiveClientMessages) {
    const inactive = await post(
      "/aiserver.v1.BidiService/BidiAppend",
      encodeConnectFrame(
        concatMessages(
          encodeString(1, clientMessage.toString("hex")),
          encodeMessage(2, encodeString(1, requestId)),
        ),
      ),
      "application/connect+proto",
      "application/connect+proto",
    );
    assert.equal(inactive.res.status, 400, `${requestId} must be rejected`);
    const frames = decodeConnectFrames(inactive.body).frames;
    assert.equal(
      JSON.parse(String(frames.at(-1)?.payload)).error.code,
      "invalid_argument",
    );
    assert.equal(getStream(requestId), undefined, `${requestId} must not create a stream`);
  }

  for (const [requestId, controlField] of [
    ["smoke-stale-exec-heartbeat", 3],
    ["smoke-stale-exec-stream-close", 1],
  ]) {
    const clientMessage = encodeMessage(
      5,
      encodeMessage(controlField, encodeUint32(1, 104)),
    );
    const stale = await post(
      "/aiserver.v1.BidiService/BidiAppend",
      encodeConnectFrame(
        concatMessages(
          encodeString(1, clientMessage.toString("hex")),
          encodeMessage(2, encodeString(1, requestId)),
        ),
      ),
      "application/connect+proto",
      "application/connect+proto",
    );
    assert.equal(stale.res.status, 400, `${requestId} requires an active broker stream`);
    assert.equal(getStream(requestId), undefined, `${requestId} must not create a stream`);
  }
  console.log("inactive client results and controls follow broker boundaries");

  for (const [suffix, clientMessage] of inactiveClientMessages) {
    const requestId = `terminal-${suffix}`;
    ensureStream(requestId);
    publish(requestId, { type: "done" });
    const terminal = await post(
      "/aiserver.v1.BidiService/BidiAppend",
      encodeConnectFrame(
        concatMessages(
          encodeString(1, clientMessage.toString("hex")),
          encodeMessage(2, encodeString(1, requestId)),
        ),
      ),
      "application/connect+proto",
      "application/connect+proto",
    );
    assert.equal(terminal.res.status, 200, `${requestId} terminal frame must be acknowledged`);
  }
  for (const [suffix, controlField] of [["heartbeat", 3], ["stream-close", 1]]) {
    const requestId = `terminal-exec-${suffix}`;
    ensureStream(requestId);
    publish(requestId, { type: "done" });
    const clientMessage = encodeMessage(
      5,
      encodeMessage(controlField, encodeUint32(1, 105)),
    );
    const terminal = await post(
      "/aiserver.v1.BidiService/BidiAppend",
      encodeConnectFrame(
        concatMessages(
          encodeString(1, clientMessage.toString("hex")),
          encodeMessage(2, encodeString(1, requestId)),
        ),
      ),
      "application/connect+proto",
      "application/connect+proto",
    );
    assert.equal(terminal.res.status, 200, `${requestId} terminal control must be acknowledged`);
  }
  console.log("terminal streams acknowledge late exec, interaction, and control frames");

  const unsupportedClient = encodeMessage(99, Buffer.alloc(0));
  const unsupportedBidi = concatMessages(
    encodeString(1, unsupportedClient.toString("hex")),
    encodeMessage(2, encodeString(1, "smoke-unsupported-agent")),
  );
  const unsupported = await post(
    "/aiserver.v1.BidiService/BidiAppend",
    encodeConnectFrame(unsupportedBidi),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(unsupported.res.status, 400);
  const unsupportedFrames = decodeConnectFrames(unsupported.body).frames;
  assert.equal(unsupportedFrames.at(-1)?.endStream, true);
  assert.equal(
    JSON.parse(String(unsupportedFrames.at(-1)?.payload)).error.code,
    "invalid_argument",
  );
  console.log("unsupported AgentClientMessage returns invalid_argument");

  const nudge = await post(
    "/aiserver.v1.AiService/GetDefaultModelNudgeData",
    Buffer.alloc(0),
    "application/proto",
    "application/proto",
  );
  assert.equal(nudge.res.status, 200);
  const nudgeFields = decodeFields(nudge.body);
  assert.equal(
    nudgeFields.find((field) => field.field === 1 && field.wire === 2)?.bytes?.toString("utf8"),
    "0",
  );
  assert.deepEqual(
    nudgeFields
      .filter((field) => field.field === 3 && field.wire === 2)
      .map((field) => field.bytes?.toString("utf8")),
    ["smoke-provider"],
  );
  assert.equal(nudgeFields.some((field) => field.field === 1 && field.bytes?.toString("utf8") === "smoke-provider"), false);

  const countTokens = await post(
    "/aiserver.v1.AiService/CountTokens",
    encodeMessage(1, encodeString(1, "A real context item should produce a non-zero token estimate.")),
    "application/proto",
    "application/proto",
  );
  assert.equal(countTokens.res.status, 200);
  const countField = decodeFields(countTokens.body).find(
    (field) => field.field === 1 && field.wire === 0,
  );
  assert.ok(Number(countField?.varint || 0) > 0);

  const usageFields = decodeFields(encodeTokenUsageProto(123, 45));
  assert.equal(usageFields.find((field) => field.field === 1)?.varint, 123n);
  assert.equal(usageFields.find((field) => field.field === 2)?.varint, 45n);

  const unknownUnary = await post(
    "/aiserver.v1.MCPRegistryService/GetKnownServers",
    encodeConnectFrame(Buffer.alloc(0)),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(unknownUnary.res.status, 501);
  assert.match(String(unknownUnary.res.headers.get("content-type")), /^application\/connect\+proto/);
  const unaryFrames = decodeConnectFrames(unknownUnary.body).frames;
  assert.equal(unaryFrames.at(-1)?.endStream, true);
  assert.equal(JSON.parse(String(unaryFrames.at(-1)?.payload)).error.code, "unimplemented");

  const unknownStream = await post(
    "/aiserver.v1.UnknownService/StreamUnknown",
    encodeConnectFrame(Buffer.alloc(0)),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(unknownStream.res.status, 501);
  assert.match(String(unknownStream.res.headers.get("content-type")), /^application\/connect\+proto/);
  const streamFrames = decodeConnectFrames(unknownStream.body).frames;
  assert.equal(streamFrames.at(-1)?.endStream, true);
  assert.equal(JSON.parse(String(streamFrames.at(-1)?.payload)).error.code, "unimplemented");

  console.log("PASS smoke-connect");
} finally {
  await backend.close();
}
