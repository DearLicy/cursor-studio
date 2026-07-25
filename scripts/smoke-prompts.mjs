import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-prompts-"));
process.env.CURSOR_STUDIO_HOME = path.join(root, "studio-home");
process.env.CURSOR_STUDIO_CURSOR_RULES_DIR = path.join(root, "cursor-rules");

try {
  const prompts = await import("../server/workspace/prompts-store.ts");
  const provider = await import("../server/backend/agent/provider-chat.ts");

  const initial = await prompts.listPrompts();
  assert.equal(initial.state.masterEnabled, false);
  assert.equal(initial.state.items.length, 5);
  assert.ok(initial.state.items.every((item) => item.content.trim().length > 100));

  const firstId = initial.state.items[0].id;
  const firstEnabled = await prompts.setPromptEnabled(firstId, true);
  assert.equal(firstEnabled.state.masterEnabled, true);
  assert.equal(firstEnabled.inject.written, true);
  assert.equal(firstEnabled.activeCount, 1);

  const rulePath = firstEnabled.cursorRulePath;
  const rule = await fs.readFile(rulePath, "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, new RegExp(`template: ${firstId}`));

  const activePrompt = await prompts.getActiveSystemPrompt();
  assert.match(activePrompt, /### gpt5\.5-unrestricted/);

  const merged = provider.mergeManagedSystemPrompt(
    [
      { role: "system", content: "BASE_SYSTEM" },
      { role: "user", content: "hello" },
    ],
    activePrompt,
  );
  assert.equal(merged[0].role, "system");
  assert.match(merged[0].content, /^BASE_SYSTEM/);
  assert.match(merged[0].content, /### gpt5\.5-unrestricted/);
  const mergedAgain = provider.mergeManagedSystemPrompt(merged, activePrompt);
  assert.equal(mergedAgain[0].content, merged[0].content);

  // Exercise the same Responses API shape used by the configured provider.
  // The capture proves the persisted active prompt reaches the actual
  // upstream request body, rather than stopping at the merge helper.
  let capturedRequest;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    capturedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    response.end(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":2}}}\n\n',
    );
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = upstream.address();
    assert(address && typeof address !== "string");
    const result = await provider.runProviderChatMessages(
      [
        {
          id: "prompt-fixture",
          displayName: "Prompt fixture",
          type: "openai",
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture-key",
          modelID: "fixture-model",
          enabled: true,
          openAIEndpoint: "/v1/responses",
        },
      ],
      [{ role: "user", content: "prompt delivery fixture" }],
      "prompt-fixture",
      undefined,
      { timeoutMs: 10_000 },
    );
    assert.equal(result.text, "ok");
    assert.ok(capturedRequest, "Responses request was captured");
    assert.match(capturedRequest.instructions, /### gpt5\.5-unrestricted/);
    assert.match(capturedRequest.instructions, /You are Codex, based on GPT-5\.5/);
    assert.equal(capturedRequest.input[0].role, "user");
    assert.equal(capturedRequest.input[0].content[0].text, "prompt delivery fixture");
  } finally {
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await prompts.setPromptEnabled(initial.state.items[1].id, true);
  const replaced = await prompts.setInjectionMode("replace");
  assert.equal(replaced.state.items.filter((item) => item.enabled).length, 1);
  assert.equal(replaced.activeCount, 1);

  const secondId = initial.state.items[2].id;
  const secondEnabled = await prompts.setPromptEnabled(secondId, true);
  assert.deepEqual(
    secondEnabled.state.items.filter((item) => item.enabled).map((item) => item.id),
    [secondId],
  );

  const disabled = await prompts.setMasterEnabled(false);
  assert.equal(disabled.activeCount, 0);
  await assert.rejects(fs.access(rulePath));
  assert.equal(await prompts.getActiveSystemPrompt(), "");

  console.log("Prompt smoke passed: builtins, append, replace, Cursor rule, system merge, cleanup");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
