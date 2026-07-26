import assert from "node:assert/strict";

const {
  normalizeCheckpointReplay,
  normalizeProviderReplay,
  shouldPersistCheckpointTool,
} = await import("../server/backend/forwarder/replay-normalizer.ts");

const call = (id, name, args = {}) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const merged = normalizeProviderReplay([
  {
    role: "assistant",
    content: "",
    reasoningContent: "inspect",
    reasoningSignature: "sig",
    reasoningSignatureSource: "anthropic",
    tool_calls: [call("batch::1", "Read", { path: "a.ts" })],
  },
  { role: "tool", tool_call_id: "batch::1", name: "Read", content: "a" },
  {
    role: "assistant",
    content: "",
    reasoningContent: "verify",
    reasoningSignature: "sig",
    reasoningSignatureSource: "anthropic",
    tool_calls: [call("batch::2", "Read", { path: "b.ts" })],
  },
  { role: "tool", tool_call_id: "batch::2", name: "Read", content: "b" },
]);
assert.equal(merged.length, 3, "one provider batch plus two ordered results");
assert.equal(merged[0].role, "assistant");
assert.equal(merged[0].tool_calls?.length, 2);
assert.equal(merged[0].reasoningContent, "inspect\n\nverify");
assert.equal(merged[0].reasoningSignature, "sig");
assert.deepEqual(
  merged.slice(1).map((message) => message.tool_call_id),
  ["batch::1", "batch::2"],
);

const dangling = normalizeProviderReplay([
  {
    role: "assistant",
    content: "visible before a failed tool",
    tool_calls: [call("dangling", "Read", { path: "missing.ts" })],
  },
  { role: "user", content: "continue" },
]);
assert.equal(dangling.length, 2);
assert.equal(dangling[0].role, "assistant");
assert.equal(dangling[0].content, "visible before a failed tool");
assert.equal(dangling[0].tool_calls, undefined);

const imageMessages = [
  {
    role: "assistant",
    content: "",
    tool_calls: [call("image-call", "GenerateImage", { prompt: "diagram" })],
  },
  {
    role: "tool",
    tool_call_id: "image-call",
    name: "GenerateImage",
    content: "image.png",
  },
];
assert.deepEqual(
  normalizeProviderReplay(imageMessages),
  [],
  "GenerateImage is not replayed to providers",
);
assert.equal(
  normalizeCheckpointReplay(imageMessages).length,
  0,
  "GenerateImage is omitted from root replay to avoid provider re-execution",
);

const checkpoint = normalizeCheckpointReplay([
  {
    role: "assistant",
    content: "",
    tool_calls: [
      call("read", "Read", { path: "a.ts" }),
      call("edit", "Edit", { path: "a.ts", old_string: "a", new_string: "b" }),
      call("legacy-write", "Write"),
    ],
  },
  { role: "tool", tool_call_id: "read", name: "Read", content: "a" },
  { role: "tool", tool_call_id: "edit", name: "Edit", content: "ok" },
  { role: "tool", tool_call_id: "legacy-write", name: "Write", content: "ok" },
]);
assert.equal(checkpoint.length, 2);
assert.equal(checkpoint[0].role, "assistant");
assert.deepEqual(
  checkpoint[0].tool_calls?.map((item) => item.id),
  ["edit"],
);
assert.equal(checkpoint[1].tool_call_id, "edit");

assert.equal(shouldPersistCheckpointTool("Edit"), true);
assert.equal(shouldPersistCheckpointTool("GenerateImage"), true);
assert.equal(shouldPersistCheckpointTool("CreatePlan"), false);

console.log("PASS smoke-replay-normalizer");
