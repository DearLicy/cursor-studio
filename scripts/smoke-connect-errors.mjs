/** Verify Cursor-compatible structured Connect end-stream errors. */
import {
  ERROR_DETAILS_TYPE,
  classifyCursorTerminalError,
} from "../server/backend/forwarder/connect-error.ts";
import {
  createRunSseWriter,
  encodeConnectEndStream,
  streamEventToProto,
} from "../server/backend/forwarder/stream-writer.ts";
import { decodeConnectFrames } from "../server/backend/forwarder/connect-frame.ts";
import {
  decodeFields,
  firstBytes,
  firstString,
  firstVarint,
} from "../server/backend/forwarder/protobuf-wire.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeStructuredDetail(base64) {
  const details = decodeFields(Buffer.from(base64, "base64"));
  const custom = decodeFields(firstBytes(details, 2) || Buffer.alloc(0));
  return {
    kind: firstVarint(details, 1),
    expected: firstVarint(details, 3),
    title: firstString(custom, 1),
    detail: firstString(custom, 2),
    retryable: firstVarint(custom, 4),
  };
}

function verifyCase(name, input, expected) {
  const classified = classifyCursorTerminalError(input);
  assert(classified.connectCode === expected.connectCode, `${name} code=${classified.connectCode}`);
  assert(classified.errorDetailCode === expected.errorDetailCode, `${name} detail=${classified.errorDetailCode}`);
  assert(classified.retryable === expected.retryable, `${name} retryable=${classified.retryable}`);

  const frames = decodeConnectFrames(encodeConnectEndStream(input)).frames;
  assert(frames.length === 1 && frames[0].endStream, `${name} terminal frame`);
  const trailer = JSON.parse(frames[0].payload.toString("utf8"));
  assert(trailer.error?.code === expected.connectCode, `${name} trailer code`);
  assert(trailer.error?.details?.length === 1, `${name} detail count`);
  assert(trailer.error.details[0].type === ERROR_DETAILS_TYPE, `${name} detail type`);

  const detail = decodeStructuredDetail(trailer.error.details[0].value);
  assert(detail.kind === expected.errorDetailCode, `${name} decoded kind=${detail.kind}`);
  assert(detail.retryable === (expected.retryable ? 1 : 0), `${name} decoded retryable=${detail.retryable}`);
  assert(detail.title, `${name} title`);
  assert(detail.detail, `${name} detail text`);
  console.log("structured connect error", name, {
    connectCode: trailer.error.code,
    errorDetailCode: detail.kind,
    retryable: Boolean(detail.retryable),
  });
}

function main() {
  verifyCase(
    "rate-limit-429",
    { status: 429, message: "HTTP 429 Too Many Requests" },
    { connectCode: "resource_exhausted", errorDetailCode: 50, retryable: true },
  );
  verifyCase(
    "provider-502",
    { status: 502, message: "HTTP 502 Bad Gateway" },
    { connectCode: "unavailable", errorDetailCode: 57, retryable: true },
  );
  verifyCase(
    "provider-524",
    { status: 524, message: "HTTP 524 upstream timeout" },
    { connectCode: "unavailable", errorDetailCode: 57, retryable: true },
  );
  verifyCase(
    "context-overflow",
    { code: "resource_exhausted", message: "context window exceeded" },
    { connectCode: "invalid_argument", errorDetailCode: 43, retryable: false },
  );
  verifyCase(
    "cancel",
    { message: "cancelled: client_cancel" },
    { connectCode: "canceled", errorDetailCode: 21, retryable: false },
  );

  const noMessageFrame = decodeConnectFrames(
    encodeConnectEndStream({ code: "unavailable" }),
  ).frames[0];
  const noMessageTrailer = JSON.parse(noMessageFrame.payload.toString("utf8"));
  assert(noMessageTrailer.error?.code === "unavailable", "missing-message error must not become success");

  assert(
    streamEventToProto({
      type: "error",
      code: "resource_exhausted",
      message: "HTTP 429 Too Many Requests",
    }) === null,
    "provider errors must not be encoded as assistant text deltas",
  );

  for (const [status, expectedCode, expectedKind] of [
    [429, "resource_exhausted", 50],
    [502, "unavailable", 57],
  ]) {
    const chunks = [];
    const response = {
      writableEnded: false,
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
    };
    const writer = createRunSseWriter(response, {
      mode: "connect_proto",
      contentType: "text/event-stream",
    });
    writer.writeEvent({
      type: "error",
      code: "unavailable",
      message: "The provider request failed",
      status,
    });
    const frame = decodeConnectFrames(Buffer.concat(chunks)).frames[0];
    const trailer = JSON.parse(frame.payload.toString("utf8"));
    const detail = decodeStructuredDetail(trailer.error.details[0].value);
    assert(trailer.error.code === expectedCode, `event status ${status} code`);
    assert(detail.kind === expectedKind, `event status ${status} detail kind`);
  }

  console.log("PASS smoke-connect-errors");
}

main();
