import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-summary-"));
process.env.CURSOR_STUDIO_HOME = tempHome;

const {
  historyCheckpointSnapshot,
  reconcileHistoryFromCursorState,
  replaceHistoryMessages,
} = await import("../server/backend/forwarder/history.ts");
const {
  projectConversationCheckpoint,
} = await import("../server/backend/forwarder/conversation-checkpoint.ts");
const {
  projectConversationState,
} = await import("../server/backend/forwarder/conversation-state.ts");
const {
  concatMessages,
  decodeFields,
  encodeMessage,
  encodeString,
  encodeUint32,
  firstBytes,
  firstString,
  firstVarint,
} = await import("../server/backend/forwarder/protobuf-wire.ts");

function retainedSummary(summary) {
  return {
    role: "system",
    content: [
      "Earlier conversation context was summarized by the selected model.",
      "Treat the following as retained facts and continue consistently:",
      summary,
    ].join("\n\n"),
  };
}

function tail(label) {
  return [
    { role: "user", content: `${label} user` },
    { role: "assistant", content: `${label} assistant` },
  ];
}

const historyKey = "summary-generations";
await replaceHistoryMessages(historyKey, [retainedSummary("SUMMARY_1"), ...tail("one")]);
await replaceHistoryMessages(
  historyKey,
  [retainedSummary("SUMMARY_2"), ...tail("two")],
  undefined,
  { compactionSummary: "SUMMARY_2" },
);
await replaceHistoryMessages(
  historyKey,
  [retainedSummary("SUMMARY_3"), ...tail("three")],
  undefined,
  { compactionSummary: "SUMMARY_3" },
);

const snapshot = await historyCheckpointSnapshot(historyKey);
assert.deepEqual(snapshot.compaction, {
  summaries: ["SUMMARY_1", "SUMMARY_2", "SUMMARY_3"],
  selfSummaryCount: 3,
});

const persisted = JSON.parse(await fs.readFile(path.join(
  tempHome,
  "history",
  "turns",
  `${historyKey}.json`,
), "utf8"));
assert.deepEqual(persisted.compactionSummaries, snapshot.compaction.summaries);
assert.equal(persisted.selfSummaryCount, 3);

const checkpoint = projectConversationCheckpoint({
  messages: snapshot.messages,
  compactionSummaries: snapshot.compaction.summaries,
  selfSummaryCount: snapshot.compaction.selfSummaryCount,
  usedTokens: 1234,
  maxTokens: 200_000,
});
const fields = decodeFields(checkpoint);
assert.equal(firstString(decodeFields(firstBytes(fields, 6)), 1), "SUMMARY_3");
assert.equal(firstString(decodeFields(firstBytes(fields, 11)), 1), "SUMMARY_2");
assert.deepEqual(
  fields
    .filter((field) => field.field === 13)
    .map((field) => firstString(decodeFields(field.bytes), 1)),
  ["SUMMARY_1", "SUMMARY_2", "SUMMARY_3"],
);
assert.equal(firstVarint(fields, 17), 3);

const roundTrip = projectConversationState(checkpoint);
assert.deepEqual(roundTrip.compactionSummaries, snapshot.compaction.summaries);
assert.equal(roundTrip.selfSummaryCount, 3);

const advancedCheckpoint = projectConversationCheckpoint({
  messages: [retainedSummary("SUMMARY_4"), ...tail("four")],
  compactionSummaries: ["SUMMARY_4"],
  selfSummaryCount: 4,
  usedTokens: 100,
  maxTokens: 200_000,
  baseState: checkpoint,
});
const advancedProjection = projectConversationState(advancedCheckpoint);
assert.deepEqual(advancedProjection.compactionSummaries, [
  "SUMMARY_1",
  "SUMMARY_2",
  "SUMMARY_3",
  "SUMMARY_4",
]);
assert.equal(advancedProjection.selfSummaryCount, 4);

// Cursor's current proto declares ConversationSummaryArchive.summary as field 2.
// The decoder accepts that shape as well as the legacy field-1 payload.
const nativeCheckpoint = concatMessages(
  encodeMessage(6, encodeString(1, "NATIVE_3")),
  encodeMessage(11, encodeString(2, "NATIVE_2")),
  encodeMessage(13, encodeString(2, "NATIVE_1")),
  encodeMessage(13, encodeString(2, "NATIVE_2")),
  encodeMessage(13, encodeString(2, "NATIVE_3")),
  encodeUint32(17, 3),
);
const nativeProjection = projectConversationState(nativeCheckpoint);
assert.deepEqual(nativeProjection.compactionSummaries, [
  "NATIVE_1",
  "NATIVE_2",
  "NATIVE_3",
]);
assert.equal(nativeProjection.selfSummaryCount, 3);

await reconcileHistoryFromCursorState(
  "imported-summary-generations",
  [],
  undefined,
  {
    summaries: nativeProjection.compactionSummaries,
    selfSummaryCount: nativeProjection.selfSummaryCount,
  },
);
const imported = await historyCheckpointSnapshot("imported-summary-generations");
assert.deepEqual(imported.compaction, {
  summaries: ["NATIVE_1", "NATIVE_2", "NATIVE_3"],
  selfSummaryCount: 3,
});

const nativeLatestOnly = projectConversationState(concatMessages(
  encodeMessage(6, encodeString(1, "NATIVE_4")),
  encodeUint32(17, 4),
));
await reconcileHistoryFromCursorState(
  "imported-summary-generations",
  [],
  undefined,
  {
    summaries: nativeLatestOnly.compactionSummaries,
    selfSummaryCount: nativeLatestOnly.selfSummaryCount,
  },
);
assert.deepEqual(
  (await historyCheckpointSnapshot("imported-summary-generations")).compaction,
  {
    summaries: ["NATIVE_1", "NATIVE_2", "NATIVE_3", "NATIVE_4"],
    selfSummaryCount: 4,
  },
);

console.log("PASS smoke-summary-checkpoint", {
  summaries: snapshot.compaction.summaries.length,
  bytes: checkpoint.length,
});
