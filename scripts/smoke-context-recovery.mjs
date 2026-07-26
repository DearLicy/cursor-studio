import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-summary-"));
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const {
  appendHistory,
  historyAsChatMessages,
  historyRoute,
  updateHistoryRoute,
} = await import("../server/backend/forwarder/history.ts");
const { setStreamConversationContext, subscribe } = await import("../server/backend/agent/broker.ts");
const { encodeAgentClientRun } = await import("../server/backend/forwarder/agent-proto.ts");
const {
  concatMessages,
  encodeMessage,
  encodeString,
} = await import("../server/backend/forwarder/protobuf-wire.ts");
const { loadConfig, newProvider, saveConfig } = await import("../server/config/store.ts");
const { queryUsage } = await import("../server/metrics/usage-store.ts");
const { classifyCursorTerminalError } = await import(
  "../server/backend/forwarder/connect-error.ts"
);

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

function eventDigest(events) {
  return JSON.stringify(
    events.map((event) => ({
      type: event.type,
      ...(event.code ? { code: event.code } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.message ? { message: String(event.message).slice(0, 160) } : {}),
      ...(Number.isFinite(event.usedTokens) ? { usedTokens: event.usedTokens } : {}),
      ...(Number.isFinite(event.maxTokens) ? { maxTokens: event.maxTokens } : {}),
      ...(event.text ? { text: String(event.text).slice(0, 120) } : {}),
    })),
  );
}

function assertNoStreamError(events, label) {
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
    `${label}: ${eventDigest(events)}`,
  );
}

function assertCheckpointWindowAfterSummary(events, maxTokens, label) {
  const summaryStartedIndex = events.findIndex((event) => event.type === "summary_started");
  assert(summaryStartedIndex >= 0, `${label}: summary_started missing: ${eventDigest(events)}`);
  const checkpoints = events
    .slice(summaryStartedIndex)
    .filter((event) => event.type === "checkpoint");
  assert(checkpoints.length > 0, `${label}: checkpoint missing: ${eventDigest(events)}`);
  assert.deepEqual(
    [...new Set(checkpoints.map((event) => event.maxTokens))],
    [maxTokens],
    `${label}: corrected context window was not retained: ${eventDigest(events)}`,
  );
}

const upstreamRequests = [];
const upstreamCalls = [];
let upstreamScenario = "setup";
let normalProviderBehavior = "success";
let scenarioNormalAttempts = 0;

function beginUpstreamScenario(name, behavior = "success") {
  upstreamScenario = name;
  normalProviderBehavior = behavior;
  scenarioNormalAttempts = 0;
}

function callsForScenario(name) {
  return upstreamCalls.filter((call) => call.scenario === name);
}

const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  upstreamRequests.push(body);
  const isCompaction = Array.isArray(body.messages) && body.messages.some(
    (message) => String(message?.content || "").includes("Conversation to compact:"),
  );
  const normalAttempt = isCompaction ? 0 : ++scenarioNormalAttempts;
  upstreamCalls.push({
    scenario: upstreamScenario,
    isCompaction,
    normalAttempt,
    body,
  });
  if (!isCompaction) {
    const shouldReject =
      normalProviderBehavior === "always-context-limit" ||
      (normalProviderBehavior === "recover-once" && normalAttempt === 1);
    if (shouldReject) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "This model's maximum context length is 4096 tokens, but the request is longer.",
        },
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "Recovered after context compaction." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 220, completion_tokens: 18 },
    }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        content: "- Retained decision: keep the active provider route.\n- Continue from the newest unresolved task.",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 120, completion_tokens: 24 },
  }));
});

let backend;
let unsubscribe = () => {};
try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");

  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: "active-summary-route",
      displayName: "Active summary route",
      type: "openai",
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "fixture-key",
      modelID: "active-summary-model",
      models: ["active-summary-model"],
      modelSettings: {
        // Deliberately larger than the fixture's real 4096-token provider
        // window so the recovery path must honor the upstream error.
        "active-summary-model": { contextWindowTokens: 200_000, maxCompletionTokens: 512 },
      },
      enabled: true,
    }),
  ];
  await saveConfig(config);

  const conversationId = "summary-conversation";
  const routeHint = "active-summary-route:active-summary-model";
  for (let turn = 1; turn <= 9; turn += 1) {
    await appendHistory(
      conversationId,
      "user",
      `USER_${turn} ${"u".repeat(2400)}`,
      routeHint,
    );
    await appendHistory(
      conversationId,
      "assistant",
      `ASSISTANT_${turn} ${"a".repeat(2400)}`,
      routeHint,
    );
  }
  await updateHistoryRoute(conversationId, {
    modelHint: routeHint,
    providerId: "active-summary-route",
    modelID: "active-summary-model",
  });

  backend = await startBackend("127.0.0.1:0", loadConfig);
  const backendBase = `http://${backend.listenAddr}`;

  const noopConversationId = "summary-noop-conversation";
  await appendHistory(noopConversationId, "user", "Only one turn", routeHint);
  await appendHistory(noopConversationId, "assistant", "Nothing older to compact", routeHint);
  const noopRequestId = "summary-noop-request";
  const noopEvents = [];
  ({ unsubscribe } = subscribe(noopRequestId, (event) => noopEvents.push(event)));
  const noopProviderCallsBefore = upstreamRequests.length;
  const noopSummaryClient = encodeMessage(
    1,
    concatMessages(
      encodeMessage(2, encodeMessage(4, Buffer.alloc(0))),
      encodeString(5, noopConversationId),
    ),
  );
  const noopResponse = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: noopRequestId,
      data: noopSummaryClient.toString("hex"),
    }),
  });
  assert.equal(noopResponse.status, 200);
  await noopResponse.arrayBuffer();
  await waitFor(
    () => noopEvents.some((event) => event.type === "done" || event.type === "error"),
    "summary no-op lifecycle",
  );
  assert.equal(noopEvents.some((event) => event.type === "error"), false);
  assert.equal(upstreamRequests.length, noopProviderCallsBefore);
  assert.deepEqual(
    noopEvents
      .filter((event) =>
        ["summary_started", "checkpoint", "summary_completed", "turn_ended", "done"].includes(
          event.type,
        ),
      )
      .map((event) => event.type),
    ["summary_started", "checkpoint", "summary_completed", "turn_ended", "done"],
  );
  assert.equal(
    noopEvents.find((event) => event.type === "summary_completed")?.hookMessage,
    noopRequestId,
  );
  unsubscribe();

  // Standalone ConversationAction.summarize_action is protocol metadata. It
  // must not launch provider work or mutate the conversation at any token use.
  const metadataRequestId = "standalone-summary-metadata-request";
  setStreamConversationContext(metadataRequestId, conversationId);
  const metadataHistoryBefore = await historyAsChatMessages(conversationId);
  const metadataProviderCallsBefore = upstreamRequests.length;
  const standaloneSummarize = encodeMessage(4, encodeMessage(4, Buffer.alloc(0)));
  const metadataResponse = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: metadataRequestId,
      data: standaloneSummarize.toString("hex"),
    }),
  });
  assert.equal(metadataResponse.status, 200);
  await metadataResponse.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(upstreamRequests.length, metadataProviderCallsBefore);
  assert.deepEqual(await historyAsChatMessages(conversationId), metadataHistoryBefore);

  const requestId = "summary-action-request";
  const events = [];
  ({ unsubscribe } = subscribe(requestId, (event) => events.push(event)));

  // AgentClientMessage.run_request { action = ConversationAction { summarize_action = {} } }
  const summarizeClient = encodeMessage(
    1,
    concatMessages(
      encodeMessage(2, encodeMessage(4, Buffer.alloc(0))),
      encodeString(5, conversationId),
    ),
  );
  const response = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      data: summarizeClient.toString("hex"),
    }),
  });
  assert.equal(response.status, 200, "summarize action receives an empty Connect response");
  await response.arrayBuffer();

  await waitFor(
    () => events.some((event) => event.type === "done" || event.type === "error"),
    "summary lifecycle to finish",
  );
  assert.equal(events.some((event) => event.type === "error"), false, "summarize action must not cancel");
  assert(events.some((event) => event.type === "summary_started"), "summary_started event missing");
  assert(events.some((event) => event.type === "summary"), "summary event missing");
  assert(events.some((event) => event.type === "summary_completed"), "summary_completed event missing");
  assert(events.some((event) => event.type === "checkpoint"), "checkpoint event missing");
  const summaryStartedIndex = events.findIndex((event) => event.type === "summary_started");
  const summaryIndex = events.findIndex((event) => event.type === "summary");
  const summaryCompletedIndex = events.findIndex((event) => event.type === "summary_completed");
  const preSummaryCheckpointIndex = events.findIndex(
    (event, index) => index > summaryStartedIndex && event.type === "checkpoint",
  );
  const postSummaryCheckpointIndex = events.findLastIndex(
    (event, index) => index < summaryCompletedIndex && event.type === "checkpoint",
  );
  const turnEndedIndex = events.findIndex((event) => event.type === "turn_ended");
  const doneIndex = events.findIndex((event) => event.type === "done");
  assert(summaryStartedIndex < preSummaryCheckpointIndex);
  assert(preSummaryCheckpointIndex < summaryIndex);
  assert(summaryIndex < postSummaryCheckpointIndex);
  assert(postSummaryCheckpointIndex < summaryCompletedIndex);
  assert(summaryCompletedIndex < turnEndedIndex);
  assert(turnEndedIndex < doneIndex);
  assert.equal(events[summaryCompletedIndex].hookMessage, requestId);
  assert(upstreamRequests.length > 0, "summary must call the configured provider");
  for (const request of upstreamRequests) {
    assert.equal(request.model, "active-summary-model", "summary keeps the conversation model");
  }

  const history = await historyAsChatMessages(conversationId);
  assert.equal(history[0]?.role, "system", "summary replaces old history with retained context");
  assert.match(history[0]?.content || "", /Retained decision/);

  const annotationResponse = await fetch(
    `${backendBase}/aiserver.v1.AiService/GetThoughtAnnotation?format=json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    },
  );
  assert.equal(annotationResponse.status, 200, "completed summary annotation response");
  const annotation = await annotationResponse.json();
  assert.equal(annotation.thoughtAnnotation?.requestId, requestId);
  assert.match(annotation.thoughtAnnotation?.thought || "", /Retained decision/);

  await waitFor(async () => {
    const usage = await queryUsage({ limit: 20 });
    return usage.logs.some((row) => row.requestId === requestId);
  }, "summary usage record");
  const usage = await queryUsage({ limit: 20 });
  const rows = usage.logs.filter((row) => row.requestId === requestId);
  assert.equal(rows.length, 1, "summary has one usage record");
  assert.equal(rows[0].valid, true);
  assert.equal(rows[0].providerId, "active-summary-route");
  assert.equal(rows[0].modelID, "active-summary-model");

  // The configured catalog advertises 200k, while this fixture reports a real
  // 4096-token window. The first request must end through Cursor's native error
  // boundary. Only a later Cursor Resume may compact and invoke the model again.
  unsubscribe();
  const recoveryConversationId = "provider-limit-recovery-conversation";
  for (let turn = 1; turn <= 9; turn += 1) {
    await appendHistory(
      recoveryConversationId,
      "user",
      `RECOVERY_USER_${turn} ${"u".repeat(2400)}`,
      routeHint,
    );
    await appendHistory(
      recoveryConversationId,
      "assistant",
      `RECOVERY_ASSISTANT_${turn} ${"a".repeat(2400)}`,
      routeHint,
    );
  }
  await updateHistoryRoute(recoveryConversationId, {
    modelHint: routeHint,
    providerId: "active-summary-route",
    modelID: "active-summary-model",
  });

  beginUpstreamScenario("context-limit-native-error", "recover-once");
  const recoveryRequestId = "provider-limit-recovery-request";
  const recoveryEvents = [];
  ({ unsubscribe } = subscribe(recoveryRequestId, (event) => recoveryEvents.push(event)));
  const recoveryClient = encodeAgentClientRun({
    text: "Continue from the retained context.",
    conversationId: recoveryConversationId,
    modelName: routeHint,
  });
  const recoveryResponse = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: recoveryRequestId,
      data: recoveryClient.toString("hex"),
    }),
  });
  assert.equal(recoveryResponse.status, 200);
  await recoveryResponse.arrayBuffer();

  await waitFor(
    () => recoveryEvents.some((event) => event.type === "done" || event.type === "error"),
    "provider-limit native error",
  );
  const contextError = recoveryEvents.find((event) => event.type === "error");
  assert(contextError, `provider-limit error missing: ${eventDigest(recoveryEvents)}`);
  assert.equal(contextError.code, "invalid_argument");
  assert.equal(
    recoveryEvents.some((event) => event.type === "summary_started"),
    false,
    "a provider error must not trigger an in-request compaction retry",
  );
  const failedCalls = callsForScenario("context-limit-native-error");
  assert.equal(failedCalls.length, 1, "the failed request invokes the provider once");
  assert.equal(failedCalls[0]?.isCompaction, false);
  const failedCheckpoint = recoveryEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(failedCheckpoint, `provider-limit checkpoint missing: ${eventDigest(recoveryEvents)}`);

  const recoveredRouteAfterError = await historyRoute(recoveryConversationId);
  assert.equal(
    recoveredRouteAfterError.contextWindowTokens,
    4_096,
    "the provider-reported window must be durable before Cursor resumes",
  );

  unsubscribe();
  beginUpstreamScenario("successful-context-resume", "success");
  const resumeRequestId = "provider-limit-resume-request";
  const resumeEvents = [];
  ({ unsubscribe } = subscribe(resumeRequestId, (event) => resumeEvents.push(event)));
  const resumeClient = encodeMessage(
    1,
    concatMessages(
      encodeMessage(1, Buffer.from(failedCheckpoint.conversationState)),
      encodeMessage(2, encodeMessage(2, Buffer.alloc(0))),
      encodeString(5, recoveryConversationId),
      encodeMessage(9, encodeString(1, routeHint)),
    ),
  );
  const resumeResponse = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: resumeRequestId,
      data: resumeClient.toString("hex"),
    }),
  });
  assert.equal(resumeResponse.status, 200);
  await resumeResponse.arrayBuffer();
  await waitFor(
    () => resumeEvents.some((event) => event.type === "done" || event.type === "error"),
    "provider-limit Resume recovery",
  );
  assertNoStreamError(resumeEvents, "provider-limit Resume recovery");

  const successfulRecoveryCalls = callsForScenario("successful-context-resume");
  const successfulRecoveryProviderCalls = successfulRecoveryCalls.filter(
    (call) => !call.isCompaction,
  );
  assert.equal(
    successfulRecoveryProviderCalls.length,
    1,
    "the new Resume makes one post-compaction provider request",
  );
  assert(
    successfulRecoveryCalls.some((call) => call.isCompaction),
    "context-limit recovery must summarize on the active provider before retrying",
  );
  assert(resumeEvents.some((event) => event.type === "summary_started"));
  assert(resumeEvents.some((event) => event.type === "summary_completed"));
  const recoverySummaryStarted = resumeEvents.findIndex(
    (event) => event.type === "summary_started",
  );
  const recoverySummary = resumeEvents.findIndex((event) => event.type === "summary");
  const recoverySummaryCompleted = resumeEvents.findIndex(
    (event) => event.type === "summary_completed",
  );
  const recoveryPreCheckpoint = resumeEvents.findIndex(
    (event, index) => index > recoverySummaryStarted && event.type === "checkpoint",
  );
  const recoveryPostCheckpoint = resumeEvents.findLastIndex(
    (event, index) => index < recoverySummaryCompleted && event.type === "checkpoint",
  );
  assert(recoverySummaryStarted < recoveryPreCheckpoint);
  assert(recoveryPreCheckpoint < recoverySummary);
  assert(recoverySummary < recoveryPostCheckpoint);
  assert(recoveryPostCheckpoint < recoverySummaryCompleted);
  assert.equal(resumeEvents[recoverySummaryCompleted].hookMessage, resumeRequestId);
  assertCheckpointWindowAfterSummary(
    resumeEvents,
    4_096,
    "successful provider-limit recovery",
  );
  const retryCheckpoint = resumeEvents.find(
    (event, index) => index > recoverySummaryCompleted && event.type === "checkpoint",
  );
  assert(retryCheckpoint, `retry checkpoint missing: ${eventDigest(resumeEvents)}`);
  const retryMaxTokens = Number(successfulRecoveryProviderCalls[0]?.body?.max_tokens);
  const expectedRetryMaxTokens = Math.min(
    512,
    4_096 - retryCheckpoint.usedTokens - 1_024,
  );
  assert(
    expectedRetryMaxTokens > 0,
    `compaction did not leave response headroom: ${eventDigest(resumeEvents)}`,
  );
  assert.equal(
    retryMaxTokens,
    expectedRetryMaxTokens,
    "the replacement provider request uses the 4096-token remaining budget",
  );
  assert(
    resumeEvents.some((event) => event.type === "text" && event.text.includes("Recovered after context compaction")),
    "recovered response text missing",
  );

  await waitFor(async () => {
    const usage = await queryUsage({ limit: 50 });
    return usage.logs.some((row) => row.requestId === recoveryRequestId) &&
      usage.logs.filter((row) => row.requestId === resumeRequestId).length >= 2;
  }, "provider-limit error, compaction, and terminal usage records");
  const allRecoveryUsage = (await queryUsage({ limit: 50 })).logs;
  const failedUsage = allRecoveryUsage
    .filter((row) => row.requestId === recoveryRequestId);
  const resumeUsage = allRecoveryUsage
    .filter((row) => row.requestId === resumeRequestId);
  assert.equal(failedUsage.length, 1, "the native provider error has one usage row");
  assert.equal(failedUsage[0].valid, false);
  assert.equal(resumeUsage.length, 2, "Resume compaction and completion are recorded separately");
  assert(resumeUsage.every((row) => row.providerId === "active-summary-route"));
  assert(resumeUsage.every((row) => row.modelID === "active-summary-model"));
  assert(resumeUsage.every((row) => row.valid));

  const recoveredRoute = await historyRoute(recoveryConversationId);
  assert.equal(
    recoveredRoute.contextWindowTokens,
    4_096,
    "the provider-reported context window is persisted on the conversation route",
  );

  // A later explicit summary must reuse the provider-reported 4096 window,
  // rather than reverting to the configured 200k catalog value.
  await appendHistory(
    recoveryConversationId,
    "user",
    "Follow-up turn before a manual summary.",
    routeHint,
  );
  await appendHistory(
    recoveryConversationId,
    "assistant",
    "The recovered route remains active.",
    routeHint,
  );
  unsubscribe();
  beginUpstreamScenario("manual-summary-after-recovery");
  const persistedSummaryRequestId = "persisted-window-summary-request";
  const persistedSummaryEvents = [];
  ({ unsubscribe } = subscribe(
    persistedSummaryRequestId,
    (event) => persistedSummaryEvents.push(event),
  ));
  const persistedSummaryClient = encodeMessage(
    1,
    concatMessages(
      encodeMessage(2, encodeMessage(4, Buffer.alloc(0))),
      encodeString(5, recoveryConversationId),
    ),
  );
  const persistedSummaryResponse = await fetch(
    `${backendBase}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: persistedSummaryRequestId,
        data: persistedSummaryClient.toString("hex"),
      }),
    },
  );
  assert.equal(persistedSummaryResponse.status, 200);
  await persistedSummaryResponse.arrayBuffer();
  await waitFor(
    () => persistedSummaryEvents.some(
      (event) => event.type === "done" || event.type === "error",
    ),
    "persisted-window manual summary to finish",
  );
  assertNoStreamError(persistedSummaryEvents, "persisted-window manual summary");
  assertCheckpointWindowAfterSummary(
    persistedSummaryEvents,
    4_096,
    "persisted-window manual summary",
  );
  const persistedSummaryCalls = callsForScenario("manual-summary-after-recovery");
  assert(
    persistedSummaryCalls.length > 0 && persistedSummaryCalls.every((call) => call.isCompaction),
    "manual summary must use only the active route's compaction request",
  );
  assert.equal(
    (await historyRoute(recoveryConversationId)).contextWindowTokens,
    4_096,
    "manual summary preserves the provider-reported route window",
  );

  // Repeated context-limit handling spans two Cursor-owned runs. The initial
  // run learns the real window and terminates natively; only a new Resume may
  // compact and make the second normal provider call.
  unsubscribe();
  const terminalConversationId = "provider-limit-terminal-conversation";
  for (let turn = 1; turn <= 9; turn += 1) {
    await appendHistory(
      terminalConversationId,
      "user",
      `TERMINAL_USER_${turn} ${"u".repeat(2_400)}`,
      routeHint,
    );
    await appendHistory(
      terminalConversationId,
      "assistant",
      `TERMINAL_ASSISTANT_${turn} ${"a".repeat(2_400)}`,
      routeHint,
    );
  }
  await updateHistoryRoute(terminalConversationId, {
    modelHint: routeHint,
    providerId: "active-summary-route",
    modelID: "active-summary-model",
  });
  beginUpstreamScenario("terminal-context-limit", "always-context-limit");
  const terminalRequestId = "provider-limit-terminal-request";
  const terminalEvents = [];
  ({ unsubscribe } = subscribe(terminalRequestId, (event) => terminalEvents.push(event)));
  const terminalClient = encodeAgentClientRun({
    text: "Continue and preserve this turn.",
    conversationId: terminalConversationId,
    modelName: routeHint,
  });
  const terminalResponse = await fetch(`${backendBase}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: terminalRequestId,
      data: terminalClient.toString("hex"),
    }),
  });
  assert.equal(terminalResponse.status, 200);
  await terminalResponse.arrayBuffer();
  await waitFor(
    () => terminalEvents.some((event) => event.type === "error"),
    "initial terminal provider context-limit error",
  );
  const initialTerminalCalls = callsForScenario("terminal-context-limit");
  assert.equal(
    initialTerminalCalls.filter((call) => !call.isCompaction).length,
    1,
    "the initial context-limit run invokes the provider exactly once",
  );
  assert.equal(
    initialTerminalCalls.some((call) => call.isCompaction),
    false,
    "the initial failed run must not hide a compaction retry",
  );
  const initialTerminalCheckpoint = terminalEvents.findLast(
    (event) => event.type === "checkpoint" && Buffer.isBuffer(event.conversationState),
  );
  assert(
    initialTerminalCheckpoint,
    `initial terminal checkpoint missing: ${eventDigest(terminalEvents)}`,
  );
  assert.equal(initialTerminalCheckpoint.maxTokens, 4_096);

  unsubscribe();
  const terminalResumeRequestId = "provider-limit-terminal-resume-request";
  const terminalResumeEvents = [];
  ({ unsubscribe } = subscribe(
    terminalResumeRequestId,
    (event) => terminalResumeEvents.push(event),
  ));
  const terminalResumeClient = encodeMessage(
    1,
    concatMessages(
      encodeMessage(1, Buffer.from(initialTerminalCheckpoint.conversationState)),
      encodeMessage(2, encodeMessage(2, Buffer.alloc(0))),
      encodeString(5, terminalConversationId),
      encodeMessage(9, encodeString(1, routeHint)),
    ),
  );
  const terminalResumeResponse = await fetch(
    `${backendBase}/aiserver.v1.BidiService/BidiAppend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: terminalResumeRequestId,
        data: terminalResumeClient.toString("hex"),
      }),
    },
  );
  assert.equal(terminalResumeResponse.status, 200);
  await terminalResumeResponse.arrayBuffer();
  await waitFor(
    () => terminalResumeEvents.some((event) => event.type === "error"),
    "resumed terminal provider context-limit error",
  );

  const terminalCalls = callsForScenario("terminal-context-limit");
  const terminalProviderCalls = terminalCalls.filter((call) => !call.isCompaction);
  assert.equal(
    terminalProviderCalls.length,
    2,
    "a repeated provider context-limit failure must not start a third normal provider call",
  );
  assert(
    terminalCalls.some((call) => call.isCompaction),
    "the terminal scenario must exercise the recovery compaction pass",
  );
  assertCheckpointWindowAfterSummary(
    terminalResumeEvents,
    4_096,
    "terminal provider-limit recovery",
  );
  const terminalErrorIndex = terminalResumeEvents.findLastIndex(
    (event) => event.type === "error",
  );
  const terminalError = terminalResumeEvents[terminalErrorIndex];
  assert(
    terminalError,
    `native terminal error missing: ${eventDigest(terminalResumeEvents)}`,
  );
  assert.equal(
    terminalResumeEvents.some((event) => event.type === "done"),
    false,
    "failed streams terminate with an error trailer, not a successful done event",
  );
  assert.equal(
    terminalResumeEvents.some((event) => event.type === "text"),
    false,
    "a repeated context-limit error must not be projected as assistant content",
  );
  const terminalCheckpointIndex = terminalResumeEvents.findLastIndex(
    (event, index) => index < terminalErrorIndex && event.type === "checkpoint",
  );
  assert(
    terminalCheckpointIndex >= 0,
    `terminal checkpoint missing: ${eventDigest(terminalResumeEvents)}`,
  );
  assert.equal(terminalResumeEvents[terminalCheckpointIndex].maxTokens, 4_096);
  const nativeTerminal = classifyCursorTerminalError({
    code: terminalError.code,
    message: terminalError.message,
    status: terminalError.status,
  });
  assert.equal(
    nativeTerminal.connectCode,
    "invalid_argument",
    `repeated context-limit error did not reach the native Cursor classification: ${eventDigest(terminalResumeEvents)}`,
  );
  assert.equal(nativeTerminal.errorDetailCode, 43);

  console.log("Bidi summarize action keeps the active route, checkpoints, and usage");
  console.log("provider context-limit recovery keeps maxTokens=4096 and limits retry output");
  console.log("manual summary reuses the persisted 4096-token provider window");
  console.log("a repeated context-limit error stops after one retry with a native terminal error");
  console.log("PASS smoke-context-recovery");
} finally {
  unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
