import assert from "node:assert/strict";
import { startBackend } from "../server/backend/local.ts";
import { encodeString, encodeMessage, decodeFields } from "../server/backend/forwarder/protobuf-wire.ts";
import { encodeConnectFrame, decodeConnectFrames } from "../server/backend/forwarder/connect-frame.ts";

const config = {
  routingMode: "local",
  providers: [],
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

  const unknownUnary = await post(
    "/aiserver.v1.MCPRegistryService/GetKnownServers",
    Buffer.alloc(0),
    "application/proto",
    "application/proto",
  );
  assert.equal(unknownUnary.res.status, 200);
  assert.match(String(unknownUnary.res.headers.get("content-type")), /^application\/proto/);
  assert.equal(unknownUnary.body.length, 0);

  const unknownStream = await post(
    "/aiserver.v1.BackgroundComposerService/StreamBackgroundComposer",
    encodeConnectFrame(Buffer.alloc(0)),
    "application/connect+proto",
    "application/connect+proto",
  );
  assert.equal(unknownStream.res.status, 200);
  assert.match(String(unknownStream.res.headers.get("content-type")), /^application\/connect\+proto/);
  assert.equal(decodeConnectFrames(unknownStream.body).frames.at(-1)?.endStream, true);

  console.log("PASS smoke-connect");
} finally {
  await backend.close();
}
