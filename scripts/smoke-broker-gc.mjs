import assert from "node:assert/strict";
import {
  ensureStream,
  getStream,
  listActiveStreamIds,
  markStreamTerminalPending,
  publish,
} from "../server/backend/agent/broker.ts";

const activeIds = Array.from({ length: 205 }, (_, index) =>
  `broker-gc-active-${index}`,
);
for (const requestId of activeIds) {
  const stream = ensureStream(requestId);
  stream.started = true;
}

assert.equal(
  activeIds.every((requestId) => getStream(requestId) != null),
  true,
  "all live streams survive the 200-stream soft limit",
);
assert.equal(listActiveStreamIds().length, activeIds.length);

assert.equal(markStreamTerminalPending("broker-gc-missing"), false);
assert.equal(markStreamTerminalPending(activeIds[0]), true);
assert.equal(getStream(activeIds[0])?.terminalPending, true);

const terminalId = "broker-gc-terminal";
ensureStream(terminalId);
publish(terminalId, { type: "done" });
const firstPlaceholderId = "broker-gc-placeholder-1";
ensureStream(firstPlaceholderId);
assert.equal(
  getStream(terminalId),
  undefined,
  "a terminal stream is reclaimed before any live stream",
);

const secondPlaceholderId = "broker-gc-placeholder-2";
ensureStream(secondPlaceholderId);
assert.equal(
  getStream(firstPlaceholderId),
  undefined,
  "an unused placeholder is reclaimable under memory pressure",
);
assert.equal(
  activeIds.every((requestId) => getStream(requestId) != null),
  true,
  "placeholder cleanup never evicts a live stream",
);

console.log("broker gc smoke: ok");
