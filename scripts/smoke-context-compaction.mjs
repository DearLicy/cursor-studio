import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-context-"));
process.env.CURSOR_STUDIO_HOME = tempHome;

const {
  compactConversationHistory,
} = await import("../server/backend/forwarder/context-compaction.ts");
const {
  historyAsChatMessages,
  historyCheckpointSnapshot,
  replaceHistoryMessages,
} = await import("../server/backend/forwarder/history.ts");
const {
  estimateChatMessagesTokens,
  isProviderRequestError,
  runProviderChatMessages,
} = await import("../server/backend/agent/provider-chat.ts");
const { streamEventToProto } = await import("../server/backend/forwarder/stream-writer.ts");

async function withUpstream(run) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "- Retained decision: keep the active model route.\n- Latest work remains pending." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 24 },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withScriptedUpstream(respond, run) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      await respond({
        request,
        response,
        body,
        pass: requests.length,
      });
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function compactionProvider(baseURL) {
  return {
    id: "transaction-route",
    displayName: "Transaction route",
    type: "openai",
    baseURL,
    apiKey: "fixture-key",
    modelID: "transaction-model",
    models: ["transaction-model"],
    modelSettings: {
      "transaction-model": { contextWindowTokens: 4096, maxCompletionTokens: 512 },
    },
    enabled: true,
  };
}

function longConversation() {
  const messages = [];
  for (let turn = 1; turn <= 9; turn += 1) {
    messages.push({ role: "user", content: `TX_${turn}_USER ${"u".repeat(2400)}` });
    messages.push({ role: "assistant", content: `TX_${turn}_ASSISTANT ${"a".repeat(2400)}` });
  }
  return messages;
}

function writeSummary(response, text = "- Retained transaction summary.") {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 24 },
  }));
}

async function assertStoredHistory(historyKey, expected, message) {
  assert.deepEqual(await historyAsChatMessages(historyKey), expected, message);
  assert.deepEqual(
    (await historyCheckpointSnapshot(historyKey)).compaction,
    { summaries: [], selfSummaryCount: 0 },
    `${message}: no summary generation may be committed`,
  );
}

try {
  const midWindowMessages = [
    { role: "user", content: `MID_WINDOW_USER_1 ${"word".repeat(37_000)}` },
    { role: "assistant", content: `MID_WINDOW_ASSISTANT_1 ${"word".repeat(37_000)}` },
    { role: "user", content: `MID_WINDOW_USER_2 ${"word".repeat(37_000)}` },
    { role: "assistant", content: `MID_WINDOW_ASSISTANT_2 ${"word".repeat(37_000)}` },
  ];
  const midWindowTokens = estimateChatMessagesTokens(midWindowMessages);
  assert(midWindowTokens > 140_000 && midWindowTokens < 190_000);
  const belowCompactionThreshold = await compactConversationHistory({
    historyKey: "below-compaction-threshold",
    messages: midWindowMessages,
    providers: [{
      id: "threshold-route",
      displayName: "Threshold route",
      type: "openai",
      baseURL: "http://127.0.0.1:1",
      apiKey: "fixture-key",
      modelID: "threshold-model",
      models: ["threshold-model"],
      modelSettings: {
        "threshold-model": {
          contextWindowTokens: 200_000,
          maxCompletionTokens: 65_536,
        },
      },
      enabled: true,
    }],
    modelHint: "threshold-route:threshold-model",
    globalContextWindowTokens: 200_000,
  });
  assert.equal(belowCompactionThreshold.compacted, false);
  assert.equal(belowCompactionThreshold.blocked, false);
  assert.equal(belowCompactionThreshold.passes, 0);
  console.log("200k context waits until the 190k compaction threshold");

  await withUpstream(async (baseURL, requests) => {
    const provider = {
      id: "active-route",
      displayName: "Active route",
      type: "openai",
      baseURL,
      apiKey: "fixture-key",
      modelID: "active-model",
      models: ["active-model"],
      modelSettings: {
        "active-model": { contextWindowTokens: 4096, maxCompletionTokens: 512 },
      },
      enabled: true,
    };
    const messages = [];
    for (let turn = 1; turn <= 9; turn += 1) {
      messages.push({ role: "user", content: `TURN_${turn}_USER ${"u".repeat(2400)}` });
      messages.push({ role: "assistant", content: `TURN_${turn}_ASSISTANT ${"a".repeat(2400)}` });
      if (turn === 1) {
        messages.push({
          role: "user",
          content: "INTERNAL_PROMPT_CONTEXT_MUST_NOT_BE_SUMMARIZED",
          promptContextSource: "current_user_request",
          promptContextHash: "fixture-prompt-context-hash",
        });
      }
    }
    const publishedSummaries = [];
    let historyVisibleToSummaryCallback = [];

    const result = await compactConversationHistory({
      historyKey: "compaction-fixture",
      messages,
      providers: [provider],
      modelHint: "active-route:active-model:high",
      globalContextWindowTokens: 4096,
      onSummary: async (summary) => {
        publishedSummaries.push(summary);
        historyVisibleToSummaryCallback = await historyAsChatMessages("compaction-fixture");
      },
    });

    assert.equal(result.compacted, true, "long history is compacted");
    assert.equal(result.providerId, "active-route");
    assert.equal(result.modelID, "active-model");
    assert(result.passes >= 1, "at least one summary call occurred");
    assert(result.passes > 3, "compaction continues beyond the former three-pass cap");
    assert.equal(publishedSummaries.length, 1, "multi-pass compaction publishes only its final summary");
    assert(requests.length >= 1, "summary provider was called");
    for (const request of requests) {
      assert.equal(request.model, "active-model", "summary stays on the selected model");
      assert.equal(request.tools, undefined, "summary does not expose tools");
      assert.doesNotMatch(
        request.messages.map((message) => String(message.content || "")).join("\n"),
        /INTERNAL_PROMPT_CONTEXT_MUST_NOT_BE_SUMMARIZED/,
        "transient prompt context must not enter the compaction summary source",
      );
    }
    const stored = await historyAsChatMessages("compaction-fixture");
    assert.deepEqual(
      historyVisibleToSummaryCallback,
      stored,
      "the final history is committed before the summary callback runs",
    );
    assert.equal(stored[0]?.role, "system");
    assert.match(stored[0]?.content || "", /Retained decision/);
    assert(stored.some((message) => message.content.includes("TURN_9_USER")), "latest turn remains");
    const compactionState = (await historyCheckpointSnapshot("compaction-fixture")).compaction;
    assert.equal(compactionState.summaries.length, 1, "multi-pass compaction commits one generation");
    assert.equal(compactionState.selfSummaryCount, 1);
    assert.match(compactionState.summaries[0], /Retained decision/);
    await assert.rejects(
      () => fs.access(path.join(
        tempHome,
        "history",
        "turns",
        "compaction-fixture.json.bak",
      )),
      (error) => error?.code === "ENOENT",
      "a fresh multi-pass compaction must persist only one generation",
    );
    console.log("provider-backed context compaction route and persistence ok");

    const oversizedProvider = {
      ...provider,
      modelSettings: {
        "active-model": { contextWindowTokens: 200_000, maxCompletionTokens: 512 },
      },
    };
    const forced = await compactConversationHistory({
      historyKey: "forced-compaction-fixture",
      messages,
      providers: [oversizedProvider],
      modelHint: "active-route:active-model",
      globalContextWindowTokens: 200_000,
      contextWindowTokensOverride: 4096,
      force: true,
    });
    assert.equal(forced.compacted, true, "forced recovery compacts below an oversized local window");
    assert.equal(forced.providerId, "active-route");
    assert.equal(forced.modelID, "active-model");
    assert(forced.passes > 3, "forced recovery respects the temporary provider window");
    console.log("forced provider-window recovery compaction ok");
  });

  await withScriptedUpstream(
    ({ response, pass }) => {
      if (pass === 1) {
        writeSummary(response);
        return;
      }
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "second compaction pass failed" } }));
    },
    async (baseURL, requests) => {
      const historyKey = "transaction-second-pass-502";
      const messages = longConversation();
      const summaries = [];
      await replaceHistoryMessages(historyKey, messages);

      await assert.rejects(
        () => compactConversationHistory({
          historyKey,
          messages,
          providers: [compactionProvider(baseURL)],
          modelHint: "transaction-route:transaction-model",
          globalContextWindowTokens: 4096,
          onSummary: (summary) => summaries.push(summary),
        }),
        (error) => {
          assert(isProviderRequestError(error));
          assert.equal(error.status, 502);
          return true;
        },
      );

      assert(
        requests.length >= 2,
        "the fixture must fail after one successful in-memory pass",
      );
      assert.deepEqual(summaries, [], "failed compaction must not publish a partial summary");
      await assertStoredHistory(
        historyKey,
        messages,
        "a later provider failure must preserve the pre-compaction history",
      );
      console.log("multi-pass provider failure leaves history unchanged ok");
    },
  );

  await withScriptedUpstream(
    ({ response, pass }) => {
      if (pass === 1) {
        writeSummary(response);
        return;
      }
      writeSummary(response, "");
    },
    async (baseURL, requests) => {
      const historyKey = "transaction-second-pass-empty";
      const messages = longConversation();
      const summaries = [];
      await replaceHistoryMessages(historyKey, messages);

      let failure;
      try {
        await compactConversationHistory({
          historyKey,
          messages,
          providers: [compactionProvider(baseURL)],
          modelHint: "transaction-route:transaction-model",
          globalContextWindowTokens: 4096,
          onSummary: (summary) => summaries.push(summary),
        });
      } catch (error) {
        failure = error;
      }

      assert.equal(requests.length, 2, "the fixture must return empty output after one successful pass");
      assert(isProviderRequestError(failure), "empty provider completion must stay a provider error");
      assert.match(failure.message, /empty completion/i);
      assert.deepEqual(summaries, [], "empty output must not publish a partial summary");
      await assertStoredHistory(
        historyKey,
        messages,
        "an empty later summary must preserve the pre-compaction history",
      );
      console.log("multi-pass empty summary leaves history unchanged ok");
    },
  );

  let releaseSecondPass;
  const secondPassStarted = new Promise((resolve) => {
    releaseSecondPass = resolve;
  });
  await withScriptedUpstream(
    ({ response, pass }) => {
      if (pass === 1) {
        writeSummary(response);
        return;
      }
      releaseSecondPass();
      // Leave the second response pending. Aborting the compaction closes it.
    },
    async (baseURL, requests) => {
      const historyKey = "transaction-second-pass-cancel";
      const messages = longConversation();
      const summaries = [];
      const controller = new AbortController();
      await replaceHistoryMessages(historyKey, messages);

      const pending = compactConversationHistory({
        historyKey,
        messages,
        providers: [compactionProvider(baseURL)],
        modelHint: "transaction-route:transaction-model",
        globalContextWindowTokens: 4096,
        signal: controller.signal,
        timeoutMs: 5_000,
        onSummary: (summary) => summaries.push(summary),
      });
      await secondPassStarted;
      controller.abort("fixture cancellation");
      await assert.rejects(pending);

      assert.equal(requests.length, 2, "the fixture must cancel after one successful pass");
      assert.deepEqual(summaries, [], "cancelled compaction must not publish a partial summary");
      await assertStoredHistory(
        historyKey,
        messages,
        "cancellation after an in-memory pass must preserve the original history",
      );
      console.log("multi-pass cancellation leaves history unchanged ok");
    },
  );

  await new Promise((resolve, reject) => {
    const server = http.createServer((_, response) => {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture upstream unavailable" } }));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const address = server.address();
        assert(address && typeof address !== "string");
        await assert.rejects(
          () => runProviderChatMessages(
            [{
              id: "error-route",
              displayName: "Error route",
              type: "openai",
              baseURL: `http://127.0.0.1:${address.port}`,
              apiKey: "fixture-key",
              modelID: "error-model",
              enabled: true,
            }],
            [{ role: "user", content: "fixture" }],
            "error-route:error-model",
          ),
          (error) => {
            assert(isProviderRequestError(error));
            assert.equal(error.providerId, "error-route");
            assert.equal(error.modelID, "error-model");
            assert.equal(error.status, 502);
            return true;
          },
        );
        console.log("failed provider calls retain route metadata ok");
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  assert.equal(
    streamEventToProto({ type: "error", message: "fixture", code: "unavailable" }),
    null,
    "provider failures are not encoded as assistant text deltas",
  );
  console.log("native Connect error transport ok");
  console.log("PASS smoke-context-compaction");
} finally {
  await fs.rm(tempHome, { recursive: true, force: true });
}
