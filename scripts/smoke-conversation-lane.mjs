import assert from "node:assert/strict";
import {
  clearConversationLanesForTests,
  runInConversationLane,
  supersedeConversationLane,
} from "../server/backend/forwarder/conversation-lane.ts";
import {
  cancelStream,
  ensureStream,
  otherActiveConversationRequestIds,
  publish,
  setStreamConversationContext,
} from "../server/backend/agent/broker.ts";

clearConversationLanesForTests();

const events = [];
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});

const first = runInConversationLane("conversation-a", "request-1", async (turn) => {
  events.push(`start:${turn.requestId}`);
  assert.equal(turn.isCurrent(), true);
  await firstGate;
  events.push(`end:${turn.requestId}`);
  return "first";
});

const second = runInConversationLane("conversation-a", "request-2", async (turn) => {
  events.push(`start:${turn.requestId}`);
  events.push(`end:${turn.requestId}`);
  return "second";
});

await new Promise((resolve) => setTimeout(resolve, 5));
assert.deepEqual(events, ["start:request-1"]);
releaseFirst();
assert.equal(await first, "first");
assert.equal(await second, "second");
assert.deepEqual(events, [
  "start:request-1",
  "end:request-1",
  "start:request-2",
  "end:request-2",
]);

clearConversationLanesForTests();
const abort = new AbortController();
let releaseBlocking;
const blocking = new Promise((resolve) => {
  releaseBlocking = resolve;
});
const active = runInConversationLane("conversation-b", "request-3", async () => {
  await blocking;
});
const canceled = runInConversationLane(
  "conversation-b",
  "request-4",
  async () => {
    throw new Error("queued turn should not run");
  },
  abort.signal,
);
abort.abort();
releaseBlocking();
await active;
await assert.rejects(canceled, (error) => error?.name === "AbortError");

// A replacement turn invalidates an already-running lane immediately, while
// the new work remains serialized until the old provider cleanup completes.
clearConversationLanesForTests();
let releaseSuperseded;
const supersededGate = new Promise((resolve) => {
  releaseSuperseded = resolve;
});
let oldTurn;
const old = runInConversationLane("conversation-c", "request-old", async (turn) => {
  oldTurn = turn;
  await supersededGate;
  return "old";
});
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(oldTurn.isCurrent(), true);

const replacement = runInConversationLane(
  "conversation-c",
  "request-new",
  async (turn) => {
    assert.equal(turn.isCurrent(), true, "replacement must become the active lane turn");
    return "new";
  },
);
assert.equal(
  supersedeConversationLane("conversation-c", "request-new"),
  true,
  "an active old turn is invalidated before the replacement starts",
);
assert.equal(oldTurn.isCurrent(), false, "old callbacks are stale immediately");
releaseSuperseded();
assert.equal(await old, "old");
assert.equal(await replacement, "new");

// The broker deliberately returns only non-terminal streams in a conversation
// and never returns the request that should be kept alive.
const brokerConversation = "conversation-broker-smoke";
const brokerOld = "broker-old";
const brokerKeep = "broker-keep";
const brokerDone = "broker-done";
for (const requestId of [brokerOld, brokerKeep, brokerDone]) {
  ensureStream(requestId);
  setStreamConversationContext(requestId, brokerConversation);
}
publish(brokerDone, { type: "done" });
assert.deepEqual(
  otherActiveConversationRequestIds(brokerConversation, brokerKeep),
  [brokerOld],
);
cancelStream(brokerOld, "test_cleanup");
assert.deepEqual(
  otherActiveConversationRequestIds(brokerConversation, brokerKeep),
  [],
);

console.log("conversation lane smoke passed");
