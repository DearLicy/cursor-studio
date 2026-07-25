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

// managed prompt helper still works (sanity)
const msgs = mergeManagedSystemPrompt(
  [{ role: "user", content: "hi" }],
  "sys",
);
assert.equal(msgs[0].role, "system");

console.log("PASS smoke-cancel");