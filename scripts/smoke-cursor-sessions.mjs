import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-sessions-"));
const cursorUserData = path.join(fixtureRoot, "cursor-user-data");
const cursorHome = path.join(fixtureRoot, "cursor-home");
const previousUserData = process.env.CURSOR_STUDIO_CURSOR_USER_DATA;
const previousCursorHome = process.env.CURSOR_STUDIO_CURSOR_HOME;
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const emptyId = "33333333-3333-4333-8333-333333333333";

function header(composerId, workspace, title) {
  return {
    composerId,
    createdAt: 1_780_000_000_000,
    lastUpdatedAt: 1_780_000_100_000,
    isDraft: false,
    name: title,
    subtitle: `${title} preview`,
    workspaceIdentifier: {
      id: `workspace-${composerId.slice(0, 4)}`,
      uri: { fsPath: workspace },
    },
  };
}

function composerData(composerId, bubbleIds) {
  return {
    composerId,
    fullConversationHeadersOnly: bubbleIds.map((bubbleId, index) => ({
      bubbleId,
      type: index === 0 ? 1 : 2,
      grouping: { hasText: true, isRenderable: true },
    })),
  };
}

async function writeTranscript(composerId) {
  const directory = path.join(
    cursorHome,
    "projects",
    "project",
    "agent-transcripts",
    composerId,
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${composerId}.jsonl`), "{\"type\":\"turn_ended\"}\n");
}

try {
  const workspace = path.join(fixtureRoot, "workspace");
  const databasePath = path.join(cursorUserData, "globalStorage", "state.vscdb");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await writeTranscript(firstId);
  await writeTranscript(secondId);
  await writeTranscript(emptyId);

  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "composer.composerHeaders",
    JSON.stringify({ allComposers: [
      header(firstId, workspace, "First"),
      header(secondId, workspace, "Second"),
      header(emptyId, workspace, "Empty"),
    ] }),
  );
  for (const [composerId, bubbles] of [
    [firstId, ["first-user", "first-assistant"]],
    [secondId, ["second-user", "second-assistant"]],
  ]) {
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `composerData:${composerId}`,
      JSON.stringify(composerData(composerId, bubbles)),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `bubbleId:${composerId}:${bubbles[0]}`,
      JSON.stringify({ type: 1, bubbleId: bubbles[0], text: "<user_query>Hello</user_query>" }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `bubbleId:${composerId}:${bubbles[1]}`,
      JSON.stringify({ type: 2, bubbleId: bubbles[1], text: "<assistant_response>World</assistant_response>" }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `checkpointId:${composerId}:checkpoint`,
      "checkpoint",
    );
  }
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `composerData:${emptyId}`,
    JSON.stringify(composerData(emptyId, [])),
  );
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `checkpointId:${emptyId}:checkpoint`,
    "checkpoint",
  );
  db.close();

  process.env.CURSOR_STUDIO_CURSOR_USER_DATA = cursorUserData;
  process.env.CURSOR_STUDIO_CURSOR_HOME = cursorHome;
  const sessions = await import("../server/workspace/sessions-store.ts");

  const listed = await sessions.listSessions({ refresh: true, limit: 10 });
  assert.equal(listed.totalSessions, 2);
  const detail = await sessions.readSessionDetail(`cursor:${firstId}`);
  assert.deepEqual(detail.messages.map((message) => message.text), ["Hello", "World"]);

  const clearedEmpty = await sessions.clearEmptySessions();
  assert.equal(clearedEmpty.emptyFound, 1);
  assert.deepEqual(clearedEmpty.removed, [`cursor:${emptyId}`]);
  assert.deepEqual(clearedEmpty.failed, []);
  await assert.rejects(fs.stat(path.join(
    cursorHome,
    "projects",
    "project",
    "agent-transcripts",
    emptyId,
  )));

  const removed = await sessions.removeSessions([`cursor:${firstId}`]);
  assert.deepEqual(removed.removed, [`cursor:${firstId}`]);
  assert.equal((await sessions.listSessions({ refresh: true })).totalSessions, 1);
  await assert.rejects(fs.stat(path.join(
    cursorHome,
    "projects",
    "project",
    "agent-transcripts",
    firstId,
  )));

  const cleared = await sessions.clearAllSessions();
  assert.deepEqual(cleared.failed, []);
  assert.deepEqual(cleared.removed, [`cursor:${secondId}`]);
  assert.equal((await sessions.listSessions({ refresh: true })).totalSessions, 0);
  console.log("PASS smoke-cursor-sessions");
} finally {
  if (previousUserData == null) delete process.env.CURSOR_STUDIO_CURSOR_USER_DATA;
  else process.env.CURSOR_STUDIO_CURSOR_USER_DATA = previousUserData;
  if (previousCursorHome == null) delete process.env.CURSOR_STUDIO_CURSOR_HOME;
  else process.env.CURSOR_STUDIO_CURSOR_HOME = previousCursorHome;
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
