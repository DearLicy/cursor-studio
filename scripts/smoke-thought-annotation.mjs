import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-thought-"));
process.env.CURSOR_STUDIO_HOME = home;

const { startBackend } = await import("../server/backend/local.ts");
const { persistThoughtAnnotation } = await import(
  "../server/backend/forwarder/thought-annotation.ts"
);
const {
  decodeFields,
  encodeString,
  firstBytes,
  firstString,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { loadConfig } = await import("../server/config/store.ts");

const requestId = "completed-summary-request";
const thought = "Earlier work was condensed; continue from the retained decisions.";
let backend;
try {
  await persistThoughtAnnotation(requestId, thought);
  backend = await startBackend("127.0.0.1:0", loadConfig);
  const base = `http://${backend.listenAddr}`;

  const jsonResponse = await fetch(
    `${base}/aiserver.v1.AiService/GetThoughtAnnotation?format=json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    },
  );
  assert.equal(jsonResponse.status, 200);
  assert.deepEqual(await jsonResponse.json(), {
    thoughtAnnotation: { requestId, thought },
  });

  const protoResponse = await fetch(
    `${base}/aiserver.v1.AiService/GetThoughtAnnotation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/proto" },
      body: encodeString(1, requestId),
    },
  );
  assert.equal(protoResponse.status, 200);
  const fields = decodeFields(Buffer.from(await protoResponse.arrayBuffer()));
  const annotation = decodeFields(firstBytes(fields, 1) || Buffer.alloc(0));
  assert.equal(firstString(annotation, 1), requestId);
  assert.equal(firstString(annotation, 4), thought);

  const missing = await fetch(`${base}/aiserver.v1.AiService/GetThoughtAnnotation?format=json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: "missing-summary" }),
  });
  assert.deepEqual(await missing.json(), {});
  console.log("PASS smoke-thought-annotation");
} finally {
  await backend?.close();
  await fs.rm(home, { recursive: true, force: true });
}
