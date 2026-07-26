import assert from "node:assert/strict";
import {
  ActiveStreamActor,
  StreamActorMailbox,
} from "../server/backend/forwarder/active-stream-actor.ts";
import {
  normalizeClientInteractionResult,
  shouldAutoResumeAfterInteraction,
} from "../server/backend/forwarder/client-bridge.ts";

async function createPlanStopsAtUserBoundary() {
  const actor = new ActiveStreamActor("create-plan");
  assert.equal((await actor.dispatch({ kind: "run" })).effect.kind, "start_provider");
  await actor.dispatch({ kind: "provider_started" });
  await actor.dispatch({
    kind: "external_opened",
    pending: {
      id: "7",
      kind: "interaction",
      name: "CreatePlan",
      autoResume: false,
    },
  });
  const finished = await actor.dispatch({
    kind: "provider_finished",
    finishReason: "tool_calls",
    hadToolInvocation: true,
  });
  assert.equal(finished.snapshot.phase, "awaiting_user");
  assert.equal(finished.effect.kind, "none");

  const answered = await actor.dispatch({
    kind: "external_completed",
    id: "7",
    externalKind: "interaction",
  });
  assert.equal(answered.effect.kind, "complete_turn");
  assert.equal(answered.snapshot.phase, "idle");
  await actor.dispatch({ kind: "complete" });
  assert.equal(actor.snapshot().phase, "completed");
}

async function switchModeResumesProvider() {
  const actor = new ActiveStreamActor("switch-mode");
  await actor.dispatch({ kind: "run" });
  await actor.dispatch({ kind: "provider_started" });
  await actor.dispatch({
    kind: "external_opened",
    pending: {
      id: "9",
      kind: "interaction",
      name: "SwitchMode",
      autoResume: true,
    },
  });
  const finished = await actor.dispatch({
    kind: "provider_finished",
    finishReason: "tool_calls",
    hadToolInvocation: true,
  });
  assert.equal(finished.snapshot.phase, "waiting_external");

  const approved = await actor.dispatch({
    kind: "external_completed",
    id: "9",
    externalKind: "interaction",
  });
  assert.equal(approved.effect.kind, "resume_provider");
  await actor.dispatch({ kind: "provider_started" });
  assert.equal(actor.snapshot().phase, "provider_running");
  assert.equal(actor.snapshot().providerPass, 2);
}

async function mixedPendingWaitsForAllResults() {
  const actor = new ActiveStreamActor("mixed-pending");
  await actor.dispatch({ kind: "run" });
  await actor.dispatch({ kind: "provider_started" });
  await Promise.all([
    actor.dispatch({
      kind: "external_opened",
      pending: {
        id: "exec-1",
        kind: "exec",
        name: "Task",
        autoResume: true,
      },
    }),
    actor.dispatch({
      kind: "external_opened",
      pending: {
        id: "11",
        kind: "interaction",
        name: "CreatePlan",
        autoResume: false,
      },
    }),
  ]);
  await actor.dispatch({
    kind: "provider_finished",
    finishReason: "tool_calls",
    hadToolInvocation: true,
    forceComplete: true,
  });
  const first = await actor.dispatch({
    kind: "external_completed",
    id: "exec-1",
    externalKind: "exec",
  });
  assert.equal(first.effect.kind, "none");
  assert.equal(first.snapshot.phase, "awaiting_user");
  const last = await actor.dispatch({
    kind: "external_completed",
    id: "11",
    externalKind: "interaction",
  });
  assert.equal(last.effect.kind, "complete_turn");
}

async function cancellationIsTerminal() {
  const actor = new ActiveStreamActor("cancel");
  await actor.dispatch({ kind: "run" });
  await actor.dispatch({ kind: "provider_started" });
  await actor.dispatch({ kind: "cancel" });
  const late = await actor.dispatch({
    kind: "provider_finished",
    finishReason: "stop",
    hadToolInvocation: false,
  });
  assert.equal(late.snapshot.phase, "canceled");
  assert.equal(late.effect.kind, "none");
}

async function reconcileMatchesRuntimePriority() {
  const actor = new ActiveStreamActor("reconcile-priority");
  await actor.dispatch({ kind: "run" });
  await actor.dispatch({ kind: "provider_started" });
  const providerOwnsPhase = await actor.dispatch({
    kind: "external_opened",
    pending: {
      id: "exec-priority",
      kind: "exec",
      name: "Shell",
      autoResume: true,
    },
  });
  assert.equal(providerOwnsPhase.snapshot.phase, "provider_running");

  await actor.dispatch({
    kind: "external_opened",
    pending: {
      id: "interaction-priority",
      kind: "interaction",
      name: "CreatePlan",
      autoResume: false,
    },
  });
  await actor.dispatch({
    kind: "provider_finished",
    finishReason: "tool_calls",
    hadToolInvocation: true,
    forceComplete: true,
  });
  const compactingWithExternal = await actor.dispatch({
    kind: "compaction_started",
  });
  assert.equal(
    compactingWithExternal.snapshot.phase,
    "awaiting_user",
    "an awaiting-user interaction has priority over compaction",
  );

  const interactionCompleted = await actor.dispatch({
    kind: "external_completed",
    id: "interaction-priority",
    externalKind: "interaction",
  });
  assert.equal(
    interactionCompleted.snapshot.phase,
    "compacting",
    "compaction has priority over an auto-resume external wait",
  );
  assert.equal(interactionCompleted.effect.kind, "none");

  const execCompleted = await actor.dispatch({
    kind: "external_completed",
    id: "exec-priority",
    externalKind: "exec",
  });
  assert.equal(execCompleted.snapshot.phase, "compacting");
  assert.equal(execCompleted.effect.kind, "none");

  const compacted = await actor.dispatch({
    kind: "compaction_finished",
  });
  assert.equal(
    compacted.effect.kind,
    "complete_turn",
    "pending completion is reconciled after compaction",
  );
}

async function providerStopAndMailboxOwnership() {
  const actor = new ActiveStreamActor("provider-stop");
  await actor.dispatch({ kind: "run" });
  await actor.dispatch({ kind: "provider_started" });
  const stopped = await actor.dispatch({
    kind: "provider_stopped",
    providerPass: 1,
  });
  assert.equal(stopped.snapshot.providerActive, false);
  assert.equal(stopped.snapshot.phase, "idle");
  await actor.dispatch({ kind: "request_provider", action: "resume" });
  await actor.dispatch({ kind: "provider_started" });
  const stale = await actor.dispatch({
    kind: "provider_finished",
    providerPass: 1,
    finishReason: "stop",
    hadToolInvocation: false,
  });
  assert.equal(stale.snapshot.providerPass, 2);
  assert.equal(stale.snapshot.phase, "provider_running");

  const order = [];
  const mailbox = new StreamActorMailbox(async (value) => {
    order.push(`start:${value}`);
    await new Promise((resolve) => setTimeout(resolve, value === 1 ? 20 : 1));
    order.push(`end:${value}`);
  });
  await Promise.all([mailbox.post(1), mailbox.post(2)]);
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
  mailbox.close();
}

function structuredInteractionResultsStayStructured() {
  const pending = {
    kind: "interaction",
    interactionId: "12",
    messageId: 12,
    toolCallId: "call-plan",
    name: "CreatePlan",
    argsJson: "{}",
    createdAt: Date.now(),
    interactionKind: "create_plan",
    autoResume: false,
  };
  const plan = normalizeClientInteractionResult(pending, {
    interactionId: "12",
    result: "lossy text",
    ok: true,
    structured: {
      kind: "create_plan",
      ok: true,
      planUri: "file:///plan.md",
    },
  });
  assert.deepEqual(JSON.parse(plan.result), { plan_uri: "file:///plan.md" });
  assert.equal(shouldAutoResumeAfterInteraction("CreatePlan"), false);
  assert.equal(shouldAutoResumeAfterInteraction("SwitchMode"), true);

  const rejected = normalizeClientInteractionResult(
    { ...pending, name: "SwitchMode", interactionKind: "switch_mode", autoResume: true },
    {
      result: "",
      ok: false,
      structured: {
        kind: "switch_mode",
        ok: false,
        rejected: true,
        reason: "stay in plan mode",
      },
    },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.result, "stay in plan mode");
}

await createPlanStopsAtUserBoundary();
await switchModeResumesProvider();
await mixedPendingWaitsForAllResults();
await cancellationIsTerminal();
await reconcileMatchesRuntimePriority();
await providerStopAndMailboxOwnership();
structuredInteractionResultsStayStructured();

console.log("active stream actor smoke: ok");
