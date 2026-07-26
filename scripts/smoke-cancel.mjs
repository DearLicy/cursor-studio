/**
 * Stage 1: cancel / abort stream state machine.
 */
import assert from "node:assert/strict";
import {
  ensureStream,
  scheduleRun,
  markStarted,
  cancelStream,
  isStreamCancelled,
  getStreamSignal,
  getStream,
  publish,
} from "../server/backend/agent/broker.ts";
import {
  listPending,
  registerPending,
  registerPendingInteraction,
} from "../server/backend/forwarder/client-bridge.ts";
import {
  decodeAgentServerMessage,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  streamEventToMessage,
  streamEventToProto,
} from "../server/backend/forwarder/stream-writer.ts";
import {
  mergeManagedSystemPrompt,
} from "../server/backend/agent/provider-chat.ts";
import { createRequestContext } from "../server/backend/request-context.ts";

const rid = "cancel-smoke-1";
ensureStream(rid);
let ran = false;
scheduleRun(rid, () => {
  ran = true;
}, { delayMs: 200, requireMessage: false });
cancelStream(rid, "test_cancel");
await new Promise((r) => setTimeout(r, 300));
assert.equal(ran, false, "scheduled run should not start after cancel");
assert.equal(isStreamCancelled(rid), true);
assert.equal(getStreamSignal(rid).aborted, true);
const s = getStream(rid);
assert.ok(s?.done, "stream marked done");
assert.ok(
  s?.backlog.some((e) => e.type === "error"),
  "error event present",
);

// markStarted refuses cancelled stream
const rid2 = "cancel-smoke-2";
ensureStream(rid2);
cancelStream(rid2, "prestart");
assert.equal(markStarted(rid2), false);

// signal aborts mid-flight simulation
const rid3 = "cancel-smoke-3";
const s3 = ensureStream(rid3);
assert.equal(markStarted(rid3), true);
const signal = getStreamSignal(rid3);
assert.equal(signal.aborted, false);
cancelStream(rid3, "mid_flight");
assert.equal(signal.aborted, true);

// request context still usable
const ctx = createRequestContext({ requestId: rid3, source: "agent" });
assert.equal(ctx.requestId, rid3);

// A cancelled Cursor turn must immediately release both kinds of client
// bridge waiter. Otherwise an old tool round can survive for minutes and
// append stale output after the user has stopped it.
const rid4 = "cancel-smoke-pending-bridge";
ensureStream(rid4);
const bridgeSignal = getStreamSignal(rid4);
const execPending = {
  kind: "exec",
  execId: "cancel-exec-1",
  messageId: 41,
  toolCallId: "cancel-tool-1",
  name: "CallMcpTool",
  argsJson: "{}",
  createdAt: Date.now(),
};
const interactionPending = {
  kind: "interaction",
  interactionId: "42",
  messageId: 42,
  toolCallId: "cancel-tool-2",
  name: "AskQuestion",
  argsJson: "{}",
  createdAt: Date.now(),
  interactionKind: "ask_question",
};
const execWait = registerPending(rid4, execPending, 5_000, bridgeSignal);
const interactionWait = registerPendingInteraction(
  rid4,
  interactionPending,
  5_000,
  bridgeSignal,
);
assert.equal(listPending(rid4).length, 2, "both bridge waiters registered");
cancelStream(rid4, "pending_cancel");
const [execCancelled, interactionCancelled] = await Promise.all([
  execWait,
  interactionWait,
]);
assert.equal(execCancelled.ok, false);
assert.equal(interactionCancelled.ok, false);
assert.match(execCancelled.result, /cancelled/i);
assert.match(interactionCancelled.result, /cancelled/i);
assert.equal(listPending(rid4).length, 0, "cancel clears bridge waiters");

// AgentServerMessage.exec_server_control_message = field 5, with abort.id
// matching the original client exec message ID.
const abortEvent = { type: "exec_abort", messageId: execPending.messageId };
const abortJson = streamEventToMessage(abortEvent);
assert.equal(
  abortJson?.execServerControlMessage?.abort?.id,
  execPending.messageId,
  "exec abort JSON shape",
);
const abortProto = streamEventToProto(abortEvent);
assert.ok(abortProto?.length, "exec abort protobuf emitted");
const abortDecoded = decodeAgentServerMessage(abortProto);
assert.equal(abortDecoded.kind, "exec_server_control_message");
assert.equal(abortDecoded.messageId, execPending.messageId);

// managed prompt helper still works (sanity)
const msgs = mergeManagedSystemPrompt(
  [{ role: "user", content: "hi" }],
  "sys",
);
assert.equal(msgs[0].role, "system");

console.log("PASS smoke-cancel");
