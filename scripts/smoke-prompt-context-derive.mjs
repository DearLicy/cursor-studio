import assert from "node:assert/strict";

const { derivePromptContexts } = await import(
  "../server/backend/forwarder/prompt-context.ts"
);

const structuredContexts = [{
  source: "structured_state/current_plan",
  message: { role: "user", content: "<current_plan>\nShip it\n</current_plan>" },
}];

const plan = derivePromptContexts({
  mode: "plan",
  latestUserText: "Plan a code review",
  structuredContexts,
  modeChanged: true,
});
assert.deepEqual(plan.map((item) => item.source), [
  "structured_state/current_plan",
  "mode_change",
  "plan_turn_contract",
  "active_mode_contract",
  "latest_user_intent",
  "current_user_request",
]);
assert.match(plan.at(-1).message.content, /<current_user_request>/);
assert.match(plan[2].message.content, /Do not make edits/);

const localEdit = derivePromptContexts({
  mode: "agent",
  latestUserText: "Review this patch",
  historyMessages: [{
    role: "tool",
    name: "PatchEdit",
    content: JSON.stringify({ ok: true, path: "src/app.ts" }),
  }],
});
assert.deepEqual(localEdit.map((item) => item.source), [
  "active_mode_contract",
  "latest_edit_reminder",
  "latest_user_intent",
  "current_user_request",
]);
assert.match(localEdit[1].message.content, /src\/app\.ts/);

const nestedEdit = derivePromptContexts({
  mode: "agent",
  historyMessages: [{
    role: "tool",
    name: "Edit",
    content: JSON.stringify({ success: { path: "src/sample.ts", beforeFullFileContent: "old" } }),
  }],
});
assert.equal(nestedEdit[1]?.source, "latest_edit_reminder");
assert.match(nestedEdit[1].message.content, /src\/sample\.ts/);

const failedEdit = derivePromptContexts({
  mode: "agent",
  historyMessages: [{
    role: "tool",
    name: "PatchEdit",
    content: JSON.stringify({ ok: false, path: "src/nope.ts" }),
  }],
});
assert.deepEqual(failedEdit.map((item) => item.source), ["active_mode_contract"]);

console.log("PASS smoke-prompt-context-derive");
