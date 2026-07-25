import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousStudioHome = process.env.CURSOR_STUDIO_HOME;
const fixtureHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "cursor-studio-history-key-"),
);
process.env.CURSOR_STUDIO_HOME = fixtureHome;

const {
  appendHistory,
  clearAllHistory,
  historyAsChatMessages,
} = await import("../server/backend/forwarder/history.ts");
const { historyKeyForStream } = await import(
  "../server/backend/forwarder/service.ts"
);

try {
  const reusedRequestId = "reused-bidi-request";
  const conversationA = "conversation-a";
  const conversationB = "conversation-b";

  const historyA = historyKeyForStream(reusedRequestId, conversationA);
  const historyB = historyKeyForStream(reusedRequestId, conversationB);

  assert.equal(historyA, conversationA);
  assert.equal(historyB, conversationB);
  assert.equal(historyKeyForStream(reusedRequestId), reusedRequestId);

  await appendHistory(historyA, "user", "only conversation A");
  await appendHistory(historyB, "user", "only conversation B");

  const turnFiles = await fs.readdir(path.join(fixtureHome, "history", "turns"));
  assert.deepEqual(turnFiles.sort(), ["conversation-a.json", "conversation-b.json"]);

  assert.deepEqual(await historyAsChatMessages(historyA), [
    { role: "user", content: "only conversation A" },
  ]);
  assert.deepEqual(await historyAsChatMessages(historyB), [
    { role: "user", content: "only conversation B" },
  ]);

  // A later Bidi request for the same Cursor conversation keeps its context.
  const nextTurnForA = historyKeyForStream(
    "different-bidi-request",
    conversationA,
  );
  assert.equal(nextTurnForA, historyA);
  await appendHistory(nextTurnForA, "assistant", "continuation for A");
  assert.deepEqual(await historyAsChatMessages(historyA), [
    { role: "user", content: "only conversation A" },
    { role: "assistant", content: "continuation for A" },
  ]);

  const imageParts = [
    { type: "text", text: "describe this image" },
    {
      type: "image",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      path: "C:/Cursor/attachments/example.png",
    },
  ];
  await appendHistory(historyB, "user", "describe this image", undefined, imageParts);
  const persistedB = await historyAsChatMessages(historyB);
  assert.deepEqual(persistedB.at(-1), {
    role: "user",
    content: "describe this image",
    contentParts: imageParts,
  });
  const storedB = JSON.parse(
    await fs.readFile(path.join(fixtureHome, "history", "turns", "conversation-b.json"), "utf8"),
  );
  assert.deepEqual(storedB.messages.at(-1).contentParts, imageParts);

  console.log("PASS smoke-history-key");
} finally {
  await clearAllHistory();
  if (previousStudioHome == null) delete process.env.CURSOR_STUDIO_HOME;
  else process.env.CURSOR_STUDIO_HOME = previousStudioHome;
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
