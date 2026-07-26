import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-append-seq-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { encodeAgentClientPrewarm } = await import("../server/backend/forwarder/agent-proto.ts");
const { historyAsChatMessages, historyRoute } = await import("../server/backend/forwarder/history.ts");
const { loadConfig, newProvider, saveConfig } = await import("../server/config/store.ts");

let backend;
try {
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "seq-one",
      displayName: "Sequence one",
      type: "openai",
      baseURL: "http://127.0.0.1:9",
      apiKey: "fixture-key",
      modelID: "model-one",
      models: ["model-one"],
      enabled: true,
    }),
    newProvider({
      id: "seq-two",
      displayName: "Sequence two",
      type: "openai",
      baseURL: "http://127.0.0.1:9",
      apiKey: "fixture-key",
      modelID: "model-two",
      models: ["model-two"],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;
  const requestId = "append-sequence-request";
  const conversationId = "append-sequence-conversation";
  const modelOne = "seq-one:model-one";
  const modelTwo = "seq-two:model-two";

  async function append(sequence, modelHint) {
    const payload = encodeAgentClientPrewarm({
      conversationId,
      modelName: modelHint,
    });
    const response = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        append_seqno: sequence,
        data: payload.toString("hex"),
      }),
    });
    assert.equal(response.status, 200, `append ${sequence} acknowledgement`);
    await response.arrayBuffer();
  }

  // Send seq=2 first. It must wait until seq=1 has initialized the request,
  // then apply after it rather than being discarded as an out-of-order frame.
  const second = append(2, modelTwo);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await append(1, modelOne);
  await second;

  let route = await historyRoute(conversationId);
  assert.equal(route.providerId, "seq-two", "ordered seq=2 wins after seq=1");
  assert.equal(route.modelID, "model-two");
  assert.deepEqual(await historyAsChatMessages(conversationId), []);

  // A replay of seq=1 is stale and must ACK without overwriting seq=2's route.
  await append(1, modelOne);
  route = await historyRoute(conversationId);
  assert.equal(route.providerId, "seq-two", "stale append does not replay side effects");
  assert.equal(route.modelID, "model-two");

  console.log("PASS smoke-append-seq");
} finally {
  if (backend) await backend.close();
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
