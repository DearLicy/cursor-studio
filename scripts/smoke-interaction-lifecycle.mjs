import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-interaction-lifecycle-"),
);
process.env.CURSOR_STUDIO_HOME = tempHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

const { startBackend } = await import("../server/backend/local.ts");
const { subscribe } = await import("../server/backend/agent/broker.ts");
const {
  encodeAgentClientInteractionResponse,
  encodeAgentClientRun,
} = await import("../server/backend/forwarder/agent-proto.ts");
const { getActiveStreamActorSnapshot } = await import(
  "../server/backend/forwarder/active-stream-actor.ts"
);
const { decodeFields } = await import(
  "../server/backend/forwarder/protobuf-wire.ts"
);
const { loadConfig, newProvider, saveConfig } = await import(
  "../server/config/store.ts"
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
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const calls = new Map();
const callTimes = new Map();
const interactionResponseTimes = new Map();
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const messages = body.messages || [];
  const userText = messages
    .filter((message) => message?.role === "user")
    .map((message) => String(message.content || ""))
    .join("\n");
  const fixture = userText.includes("CREATE_PLAN_CASE") ? "plan" : "switch";
  calls.set(fixture, (calls.get(fixture) || 0) + 1);
  callTimes.set(fixture, [...(callTimes.get(fixture) || []), Date.now()]);
  const hasToolResult = messages.some((message) => message?.role === "tool");

  let message;
  if (fixture === "plan") {
    assert.equal(hasToolResult, false, "CreatePlan must not resume the provider");
    message = {
      content: "",
      tool_calls: [
        {
          id: "call-create-plan",
          type: "function",
          function: {
            name: "CreatePlan",
            arguments: JSON.stringify({
              plan: "1. Inspect\n2. Implement\n3. Verify",
              is_project: true,
              todos: [
                {
                  id: "todo-1",
                  content: "Inspect",
                  status: "pending",
                },
              ],
              phases: [
                {
                  name: "Implementation",
                  todos: [
                    {
                      id: "todo-2",
                      content: "Implement",
                      status: "pending",
                    },
                  ],
                },
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
          id: "call-switch-mode",
          type: "function",
          function: {
            name: "SwitchMode",
            arguments: JSON.stringify({ target_mode_id: "agent" }),
          },
        },
      ],
    };
  } else {
    message = { content: "SWITCH_RESUMED_OK" };
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
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }),
  );
});

let backend;
const unsubscribers = [];
try {
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const providerId = "interaction-fixture";
  const modelID = "interaction-model";
  const modelHint = `${providerId}:${modelID}`;
  const config = await loadConfig();
  config.providers = [
    newProvider({
      id: providerId,
      displayName: "Interaction fixture",
      type: "openai",
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "fixture-key",
      modelID,
      models: [modelID],
      enabled: true,
    }),
  ];
  await saveConfig(config);
  backend = await startBackend("127.0.0.1:0", loadConfig);
  const base = `http://${backend.listenAddr}`;

  async function append(requestId, payload) {
    const response = await fetch(
      `${base}/aiserver.v1.BidiService/BidiAppend`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, data: payload.toString("hex") }),
      },
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  async function runCase({
    requestId,
    conversationId,
    prompt,
    toolName,
    result,
    beforeResponse,
  }) {
    const events = [];
    const subscription = subscribe(requestId, (event) => events.push(event));
    unsubscribers.push(subscription.unsubscribe);
    await append(
      requestId,
      encodeAgentClientRun({
        text: prompt,
        mode: 3,
        conversationId,
        modelName: modelHint,
      }),
    );
    const query = await waitFor(
      () => events.find((event) => event.type === "interaction_query"),
      `${toolName} query`,
    );
    await beforeResponse?.({ events, query });
    interactionResponseTimes.set(toolName, Date.now());
    await append(
      requestId,
      encodeAgentClientInteractionResponse({
        messageId: query.messageId,
        toolName,
        result,
        ok: true,
      }),
    );
    await waitFor(
      () => events.find((event) => event.type === "done" || event.type === "error"),
      `${toolName} terminal event`,
    );
    assert.equal(events.some((event) => event.type === "error"), false);
    return events;
  }

  const planRequestId = "interaction-create-plan";
  const planEventsPromise = runCase({
    requestId: planRequestId,
    conversationId: "interaction-plan-conversation",
    prompt: "CREATE_PLAN_CASE",
    toolName: "CreatePlan",
    result: { plan_uri: "file:///fixture-plan.md" },
  });
  await waitFor(
    () => getActiveStreamActorSnapshot(planRequestId)?.phase === "awaiting_user",
    "CreatePlan awaiting_user phase",
  );
  const planEvents = await planEventsPromise;
  assert.equal(calls.get("plan"), 1, "CreatePlan stops without a second provider pass");
  assert.equal(getActiveStreamActorSnapshot(planRequestId)?.phase, "completed");
  const planQueryIndex = planEvents.findIndex(
    (event) => event.type === "interaction_query",
  );
  const checkpointBeforeQuery = planEvents
    .slice(0, planQueryIndex)
    .filter((event) => event.type === "checkpoint")
    .at(-1);
  assert.ok(checkpointBeforeQuery, "pending checkpoint precedes CreatePlan query");
  assert.ok(
    decodeFields(checkpointBeforeQuery.conversationState).some(
      (field) => field.field === 4,
    ),
    "CreatePlan checkpoint carries pending_tool_calls",
  );
  const planStarted = planEvents.find(
    (event) => event.type === "tool_started" && event.name === "CreatePlan",
  );
  const planCompleted = planEvents.find(
    (event) => event.type === "tool_completed" && event.name === "CreatePlan",
  );
  assert.ok(planStarted?.modelCallId, "CreatePlan start carries model_call_id");
  assert.equal(
    planCompleted?.modelCallId,
    planStarted.modelCallId,
    "CreatePlan completion stays on its provider pass",
  );
  assert.equal(planCompleted?.args?.plan?.startsWith("1. Inspect"), true);

  const switchRequestId = "interaction-switch-mode";
  const switchEvents = await runCase({
    requestId: switchRequestId,
    conversationId: "interaction-switch-conversation",
    prompt: "SWITCH_MODE_CASE",
    toolName: "SwitchMode",
    result: { approved: true },
    beforeResponse: async () => {
      assert.equal(
        getActiveStreamActorSnapshot(switchRequestId)?.phase,
        "waiting_external",
        "provider pass returned control to the actor while Cursor owns the interaction",
      );
      assert.equal(
        calls.get("switch"),
        1,
        "a second provider pass must not start before the inbound interaction result",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(
        calls.get("switch"),
        1,
        "waiting does not implicitly resume the provider",
      );
    },
  });
  assert.equal(calls.get("switch"), 2, "SwitchMode resumes the provider once");
  assert.ok(
    callTimes.get("switch")[1] - interactionResponseTimes.get("SwitchMode") >= 150,
    "SwitchMode resume applies the 200ms provider debounce",
  );
  assert.ok(
    switchEvents.some(
      (event) => event.type === "text" && event.text.includes("SWITCH_RESUMED_OK"),
    ),
  );
  assert.equal(getActiveStreamActorSnapshot(switchRequestId)?.phase, "completed");
  const switchModelCalls = switchEvents
    .filter((event) => event.type === "tool_started")
    .map((event) => event.modelCallId);
  assert.equal(new Set(switchModelCalls).size, switchModelCalls.length);

  console.log("PASS smoke-interaction-lifecycle");
} finally {
  for (const unsubscribe of unsubscribers) unsubscribe();
  if (backend) await backend.close();
  await close(upstream);
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 });
}
