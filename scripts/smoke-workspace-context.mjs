import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getStream, setStreamConversationContext } from "../server/backend/agent/broker.ts";
import { resolveConversationWorkspaceRoot } from "../server/backend/forwarder/workspace-context.ts";

const previousCursorHome = process.env.CURSOR_STUDIO_CURSOR_HOME;
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-workspace-context-"));
const cursorHome = path.join(fixtureRoot, "cursor-home");
const transcriptWorkspace = path.join(fixtureRoot, "workspace-from-transcript");
const composerWorkspace = path.join(fixtureRoot, "workspace-from-composer");
const storageWorkspace = path.join(fixtureRoot, "workspace-from-storage");
const workspaceStorageRoot = path.join(fixtureRoot, "workspaceStorage");
const stateDbPath = path.join(fixtureRoot, "state.vscdb");
const conversationId = "6f677c97-1d0b-4e6d-bb1b-c871aa58ac69";
const transcriptOnlyConversationId = "302ff5b2-d8e3-49de-9d1c-4827b4b8245a";

function cursorProjectSlug(workspace) {
  return path.win32
    .resolve(workspace)
    .replace(/[:\\/]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function writeTranscript(project, record, id = conversationId) {
  const sessionRoot = path.join(
    cursorHome,
    "projects",
    project,
    "agent-transcripts",
    id,
  );
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(
    path.join(sessionRoot, `${id}.jsonl`),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

async function writeWorkspaceStorage(workspace) {
  const storage = path.join(workspaceStorageRoot, "workspace-hash");
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(workspace).href }),
    "utf8",
  );
}

function writeComposerHeaders(fsPath) {
  const db = new DatabaseSync(stateDbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    db.prepare("INSERT INTO ItemTable(key, value) VALUES(?, ?)").run(
      "composer.composerHeaders",
      JSON.stringify({
        "workspace-bucket": [
          {
            composerId: conversationId,
            workspaceIdentifier: { uri: { fsPath } },
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
}

try {
  await fs.mkdir(transcriptWorkspace, { recursive: true });
  await fs.mkdir(composerWorkspace, { recursive: true });
  await fs.mkdir(storageWorkspace, { recursive: true });
  process.env.CURSOR_STUDIO_CURSOR_HOME = cursorHome;
  await writeTranscript("project-a", { metadata: { cwd: transcriptWorkspace } });
  writeComposerHeaders(composerWorkspace);

  const resolved = await resolveConversationWorkspaceRoot(conversationId, { stateDbPath });
  assert.equal(resolved, await fs.realpath(composerWorkspace));

  const requestId = "workspace-context-smoke";
  setStreamConversationContext(requestId, conversationId, resolved);
  const stream = getStream(requestId);
  assert.equal(stream?.conversationId, conversationId);
  assert.equal(stream?.workspaceRoot, resolved);

  await fs.rm(composerWorkspace, { recursive: true, force: true });
  assert.equal(
    await resolveConversationWorkspaceRoot(conversationId, { stateDbPath }),
    await fs.realpath(transcriptWorkspace),
  );

  await writeTranscript("project-b", { metadata: { cwd: transcriptWorkspace } });
  assert.equal(await resolveConversationWorkspaceRoot(conversationId, { stateDbPath }), undefined);

  await writeTranscript(
    cursorProjectSlug(storageWorkspace),
    { type: "turn_ended", status: "success" },
    transcriptOnlyConversationId,
  );
  await writeWorkspaceStorage(storageWorkspace);
  assert.equal(
    await resolveConversationWorkspaceRoot(transcriptOnlyConversationId, {
      stateDbPath,
      workspaceStorageRoot,
    }),
    await fs.realpath(storageWorkspace),
  );
  console.log("PASS smoke-workspace-context");
} finally {
  if (previousCursorHome == null) delete process.env.CURSOR_STUDIO_CURSOR_HOME;
  else process.env.CURSOR_STUDIO_CURSOR_HOME = previousCursorHome;
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
