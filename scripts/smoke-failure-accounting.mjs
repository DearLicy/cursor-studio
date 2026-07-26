import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-failure-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { encodeAgentClientRun } = await import("../server/backend/forwarder/agent-proto.ts");
const { registerPending } = await import("../server/backend/forwarder/client-bridge.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const { loadConfig, newProvider, saveConfig } = await import("../server/config/store.ts");
const { queryUsage } = await import("../server/metrics/usage-store.ts");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(check, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let mode = "failure";
let slowRequests = 0;
const slowResponses = new Set();
const upstream = http.createServer((request, response) => {
  if (mode === "failure") {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture upstream unavailable" } }));
    return;
  }

  slowRequests += 1;
  slowResponses.add(response);
  response.once("close", () => slowResponses.delete(response));
  void request.resume();
});

let backend;
try {
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const baseURL = `http://127.0.0.1:${upstreamAddress.port}`;

  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "failure-provider",
      displayName: "Failure fixture",
      type: "openai",
      baseURL,
      apiKey: "fixture-key",
      modelID: "failure-model",
      models: ["failure-model"],
      enabled: true,
    }),
  ];
  await saveConfig(config);

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;
  const postChat = async (requestId, stream) =>
    fetch(`${backendBase}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        model: "failure-provider:failure-model",
        messages: [{ role: "user", content: "fixture" }],
        stream,
      }),
    });

  const nonStreamId = "failure-accounting-nonstream";
  const nonStream = await postChat(nonStreamId, false);
  assert.equal(nonStream.status, 500);

  const streamId = "failure-accounting-stream";
  const stream = await postChat(streamId, true);
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /\[DONE\]/);

  await waitFor(async () => {
    const usage = await queryUsage({ limit: 20 });
    return [nonStreamId, streamId].every((requestId) =>
      usage.logs.some((row) => row.requestId === requestId),
    );
  }, "failed OpenAI compatibility usage records");
  const afterFailures = await queryUsage({ limit: 20 });
  for (const requestId of [nonStreamId, streamId]) {
    const rows = afterFailures.logs.filter((row) => row.requestId === requestId);
    assert.equal(rows.length, 1, `${requestId} has one failed usage record`);
    assert.equal(rows[0].valid, false);
    assert.equal(rows[0].providerId, "failure-provider");
    assert.equal(rows[0].modelID, "failure-model");
  }

  mode = "slow";
  const cancelId = "failure-accounting-cancel";
  const runPayload = encodeAgentClientRun({
    text: "wait for cancellation",
    conversationId: "failure-accounting-cancel-conversation",
    modelName: "failure-provider:failure-model",
  });
  const run = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: cancelId, data: runPayload.toString("hex") }),
  });
  assert.equal(run.status, 200);
  await waitFor(() => slowRequests > 0, "the provider request to start");

  // Cancellation must first send Cursor's ExecServerControl.abort and release
  // the local bridge waiter, instead of leaving the old turn blocked until its
  // normal two-minute timeout.
  const cancellationEvents = [];
  const cancellationSubscription = subscribe(cancelId, (event) => {
    cancellationEvents.push(event);
  });
  const pendingExec = {
    kind: "exec",
    execId: "failure-cancel-exec",
    messageId: 88,
    toolCallId: "failure-cancel-tool",
    name: "CallMcpTool",
    argsJson: "{}",
    createdAt: Date.now(),
  };
  const pendingExecResult = registerPending(cancelId, pendingExec, 5_000);

  const cancel = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: cancelId, type: "cancel" }),
  });
  assert.equal(cancel.status, 200);
  const cancelledExec = await pendingExecResult;
  cancellationSubscription.unsubscribe();
  assert.equal(cancelledExec.ok, false, "cancel resolves pending exec as failed");
  assert.match(cancelledExec.result, /cancelled/i);
  assert.ok(
    cancellationEvents.some(
      (event) => event.type === "exec_abort" && event.messageId === pendingExec.messageId,
    ),
    "Bidi cancel publishes Cursor ExecServerControl.abort before terminal close",
  );
  await new Promise((resolve) => setTimeout(resolve, 125));

  const afterCancel = await queryUsage({ limit: 20 });
  const cancelled = afterCancel.logs.filter((row) => row.requestId === cancelId);
  assert.equal(cancelled.length, 1, "cancelled request has one terminal usage record");
  assert.equal(cancelled[0].valid, false);
  assert.equal(cancelled[0].providerId, "failure-provider");
  assert.equal(cancelled[0].modelID, "failure-model");
  assert.equal(cancelled[0].error, "client_cancel");

  console.log("OpenAI failure route accounting and Bidi cancellation accounting ok");
  console.log("PASS smoke-failure-accounting");
} finally {
  for (const response of slowResponses) response.destroy();
  if (backend) await backend.close();
  await close(upstream);
  // Provider-health and usage writes are intentionally fire-and-forget in the
  // runtime; give their final file handle a moment to close before cleanup.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(tempHome, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
