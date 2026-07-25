/**
 * Stage 4: sessions query/batch, prompt conflict, mcp probe history, profile prompt scope.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-s4-"));
process.env.CURSOR_STUDIO_HOME = tmpHome;
process.env.CURSOR_STUDIO_CURSOR_HOME = path.join(tmpHome, "cursor-home");
process.env.CURSOR_STUDIO_CURSOR_RULES_DIR = path.join(tmpHome, "cursor-rules");

const port = await freePort();
process.env.STUDIO_CONTROL_PORT = String(port);

const {
  detectPromptConflict,
  listPrompts,
  upsertPrompt,
  setPromptEnabled,
  setMasterEnabled,
  syncCursorInjection,
} = await import("../server/workspace/prompts-store.ts");
const {
  appendMcpProbeHistory,
  listMcpProbeHistory,
  latestMcpProbeByServer,
} = await import("../server/workspace/mcp-diagnostics.ts");
const {
  upsertProfile,
  applyProfile,
  removeProfile,
} = await import("../server/workspace/profiles-store.ts");
const { loadConfig, saveConfig, newProvider } = await import(
  "../server/config/store.ts"
);
const { startControlPlane } = await import("../server/control-plane/index.ts");
const {
  clearEmptySessions,
  listSessions,
  readSessionDetail,
  removeSessions,
} = await import("../server/workspace/sessions-store.ts");

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`,
    "utf8",
  );
}

const sessionsRoot = path.join(
  process.env.CURSOR_STUDIO_CURSOR_HOME,
  "projects",
  "project-alpha",
  "agent-transcripts",
);
const alphaRoot = path.join(sessionsRoot, "session-alpha");
const alphaPrimary = path.join(alphaRoot, "session-alpha.jsonl");
const alphaSubagent = path.join(alphaRoot, "subagents", "worker-a.jsonl");
const alphaArtifact = path.join(alphaRoot, "tool-results", "result.txt");
await writeJsonl(alphaPrimary, [
  {
    role: "user",
    message: {
      content: [{ type: "text", text: "<user_query>\nPlan the release checklist.\n</user_query>" }],
    },
  },
  "{ malformed jsonl row",
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "I will prepare the checklist." },
        { type: "tool_use", name: "internal-tool" },
      ],
    },
  },
  {
    message: {
      role: "user",
      content: [{ type: "input_text", text: "Include the rollback steps." }],
    },
  },
  {
    type: "assistant_message",
    content: [{ type: "text", text: "The rollback plan is ready." }],
  },
  {
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", value: "The nested response is visible." }],
      },
    },
  },
  { type: "turn_ended", status: "completed" },
]);
await writeJsonl(alphaSubagent, [
  {
    role: "assistant",
    message: { content: [{ type: "text", text: "Internal worker-only note." }] },
  },
]);
await fs.mkdir(path.dirname(alphaArtifact), { recursive: true });
await fs.writeFile(alphaArtifact, "auxiliary artifact", "utf8");

const desktopProjectId = "c-Users-Administrator-Desktop-stage4-project";
const betaRoot = path.join(
  process.env.CURSOR_STUDIO_CURSOR_HOME,
  "projects",
  desktopProjectId,
  "agent-transcripts",
  "session-beta",
);
const betaPrimary = path.join(betaRoot, "session-beta.jsonl");
const betaArtifact = path.join(betaRoot, "tool-results", "result.txt");
await writeJsonl(betaPrimary, [
  { type: "user_message", content: [{ type: "text", text: "Beta conversation." }] },
]);
await fs.mkdir(path.dirname(betaArtifact), { recursive: true });
await fs.writeFile(betaArtifact, "beta auxiliary artifact", "utf8");

const desktopRootProjectId = "c-Users-Administrator-Desktop";
const desktopRootSessionRoot = path.join(
  process.env.CURSOR_STUDIO_CURSOR_HOME,
  "projects",
  desktopRootProjectId,
  "agent-transcripts",
  "session-desktop-root",
);
const desktopRootPrimary = path.join(desktopRootSessionRoot, "session-desktop-root.jsonl");
await writeJsonl(desktopRootPrimary, [
  { type: "user_message", content: [{ type: "text", text: "Desktop root conversation." }] },
]);

const emptyDirectRoot = path.join(sessionsRoot, "session-empty-direct");
const emptyDirectPrimary = path.join(emptyDirectRoot, "session-empty-direct.jsonl");
const emptyDirectSubagent = path.join(emptyDirectRoot, "subagents", "worker.jsonl");
const emptyDirectArtifact = path.join(emptyDirectRoot, "tool-results", "result.txt");
await writeJsonl(emptyDirectPrimary, [{ type: "turn_ended", status: "completed" }]);
await writeJsonl(emptyDirectSubagent, [
  { role: "assistant", message: { content: "Subagent-only content stays hidden." } },
]);
await fs.mkdir(path.dirname(emptyDirectArtifact), { recursive: true });
await fs.writeFile(emptyDirectArtifact, "empty session artifact", "utf8");

// Neither top-level JSONL nor a subagent-only directory is a user-visible session.
await writeJsonl(path.join(sessionsRoot, "stray.jsonl"), [
  { role: "user", message: { content: "Top-level transcript must stay hidden." } },
]);
await writeJsonl(path.join(sessionsRoot, "orphan-subagents", "subagents", "worker.jsonl"), [
  { role: "user", message: { content: "Orphan transcript must stay hidden." } },
]);

// --- prompts conflict ---
const listed = await listPrompts();
assert.ok(listed.conflict);
assert.equal(typeof listed.conflict.conflict, "boolean");

// enable master + create custom prompt tagged to profile
await setMasterEnabled(true);
const created = await upsertPrompt({
  title: "Stage4 Prompt",
  content: "You are stage4 fixture prompt.",
  enabled: true,
  profileIds: ["profile-s4"],
});
assert.ok(created.state.items.some((i) => i.title === "Stage4 Prompt"));

// sync writes mdc
const sync = await syncCursorInjection();
assert.ok(sync.path);
assert.equal(sync.written, true);

// external edit -> conflict
await fs.mkdir(path.dirname(sync.path), { recursive: true });
await fs.writeFile(sync.path, "# externally modified\n", "utf8");
const conflict = await detectPromptConflict();
assert.equal(conflict.conflict, true);

// force sync clears conflict content path
const sync2 = await syncCursorInjection();
assert.equal(sync2.written, true);
const conflict2 = await detectPromptConflict();
// after sync expected matches file
assert.equal(conflict2.conflict, false);

// --- mcp diagnostics ---
await appendMcpProbeHistory("mcp-1", {
  ok: true,
  kind: "stdio",
  latencyMs: 12,
  toolCount: 2,
  tools: [{ name: "a" }, { name: "b" }],
});
await appendMcpProbeHistory("mcp-1", {
  ok: false,
  kind: "stdio",
  latencyMs: 30,
  toolCount: 0,
  error: "timeout",
  tools: [],
});
const hist = await listMcpProbeHistory({ serverId: "mcp-1", limit: 10 });
assert.ok(hist.length >= 2);
assert.equal(hist[0].ok, false);
const latest = await latestMcpProbeByServer();
assert.equal(latest["mcp-1"].ok, false);

// --- profile prompt apply ---
const cfg = await loadConfig();
cfg.providers = [
  {
    ...newProvider({
      displayName: "S4",
      baseURL: "https://s4.example/v1",
      apiKey: "k",
      modelID: "m",
      enabled: true,
    }),
    id: "prov-s4",
  },
];
await saveConfig(cfg);
const prof = await upsertProfile({
  id: "profile-s4",
  name: "S4 Profile",
  providerIds: ["prov-s4"],
  promptIds: [],
});
assert.ok(prof.profiles.some((p) => p.id === "profile-s4"));
await applyProfile("profile-s4");
const after = await listPrompts();
const tagged = after.state.items.find((i) => i.title === "Stage4 Prompt");
assert.ok(tagged);
// tagged with profile-s4 should be enabled after apply
assert.equal(tagged.enabled, true);

// --- sessions: one visible row per primary session directory ---
const sessions = await listSessions({ limit: 20, refresh: true });
assert.equal(sessions.totalMatched, 4);
assert.equal(sessions.items.length, 4);
assert.equal(sessions.projects.length, 3);
assert.equal(sessions.items.filter((item) => item.sessionId === "session-alpha").length, 1);
assert.equal(sessions.items.some((item) => item.sessionId === "orphan-subagents"), false);
assert.equal(sessions.items.some((item) => item.sessionId === "stray"), false);

const alpha = sessions.items.find((item) => item.sessionId === "session-alpha");
assert.ok(alpha);
assert.equal(alpha.title, "Plan the release checklist.");
assert.equal(alpha.messageCount, 5);
assert.equal("subagentCount" in alpha, false);
assert.equal("transcriptCount" in alpha, false);
assert.equal("hasPrimaryTranscript" in alpha, false);

const beta = sessions.items.find((item) => item.sessionId === "session-beta");
assert.ok(beta);
assert.equal(beta.project, desktopProjectId);
assert.equal(beta.projectLabel, "stage4-project");
assert.equal(
  sessions.projects.find((item) => item.project === desktopProjectId)?.label,
  "stage4-project",
);
const desktopRootSession = sessions.items.find((item) => item.sessionId === "session-desktop-root");
assert.ok(desktopRootSession);
assert.equal(desktopRootSession.project, desktopRootProjectId);
assert.equal(desktopRootSession.projectLabel, "桌面");
const emptyDirect = sessions.items.find((item) => item.sessionId === "session-empty-direct");
assert.ok(emptyDirect);
assert.equal(emptyDirect.messageCount, 0);

const defaultSessionPage = await listSessions({ refresh: true });
assert.equal(defaultSessionPage.limit, 10);
assert.equal(defaultSessionPage.offset, 0);
assert.equal(defaultSessionPage.items.length, 4);

const firstSessionPage = await listSessions({ limit: 1, offset: 0 });
const secondSessionPage = await listSessions({ limit: 1, offset: 1 });
assert.equal(firstSessionPage.items[0]?.id, sessions.items[0]?.id);
assert.equal(secondSessionPage.items[0]?.id, sessions.items[1]?.id);
assert.equal(secondSessionPage.totalMatched, 4);
assert.equal(secondSessionPage.limit, 1);
assert.equal(secondSessionPage.offset, 1);

const clampedSessionPage = await listSessions({ limit: 999, offset: -4 });
assert.equal(clampedSessionPage.limit, 100);
assert.equal(clampedSessionPage.offset, 0);

const filteredSessions = await listSessions({ project: "project-alpha", q: "release" });
assert.equal(filteredSessions.totalMatched, 1);
assert.equal(filteredSessions.items[0].id, alpha.id);

const detail = await readSessionDetail(alpha.id);
assert.equal(detail.totalMessages, 5);
assert.deepEqual(
  detail.messages.map((message) => message.role),
  ["user", "assistant", "user", "assistant", "assistant"],
);
assert.deepEqual(
  detail.messages.map((message) => message.text),
  [
    "Plan the release checklist.",
    "I will prepare the checklist.",
    "Include the rollback steps.",
    "The rollback plan is ready.",
    "The nested response is visible.",
  ],
);
assert.equal(detail.messages.some((message) => message.text.includes("Internal worker-only")), false);

const clearedDirectEmptySessions = await clearEmptySessions();
assert.equal(clearedDirectEmptySessions.emptyFound, 1);
assert.deepEqual(clearedDirectEmptySessions.removed, [emptyDirect.id]);
assert.equal(clearedDirectEmptySessions.failed.length, 0);
assert.equal(await pathExists(emptyDirectRoot), false);
assert.equal(await pathExists(emptyDirectPrimary), false);
assert.equal(await pathExists(emptyDirectSubagent), false);
assert.equal(await pathExists(emptyDirectArtifact), false);

const afterEmptyCleanup = await listSessions({ limit: 20, refresh: true });
assert.equal(afterEmptyCleanup.totalMatched, 3);

// Project view pages project groups, while returning every session in each
// selected group so the client can expand the groups without another request.
const projectViewFixtures = [
  { project: "project-view-one", sessionIds: ["session-view-one-a", "session-view-one-b"] },
  { project: "project-view-two", sessionIds: ["session-view-two"] },
  { project: "project-view-three", sessionIds: ["session-view-three"] },
  { project: "project-view-four", sessionIds: ["session-view-four"] },
];
const projectViewFixtureIds = [];
for (const fixture of projectViewFixtures) {
  for (const sessionId of fixture.sessionIds) {
    const root = path.join(
      process.env.CURSOR_STUDIO_CURSOR_HOME,
      "projects",
      fixture.project,
      "agent-transcripts",
      sessionId,
    );
    await writeJsonl(path.join(root, `${sessionId}.jsonl`), [
      {
        type: "user_message",
        content: [{ type: "text", text: `Project view ${fixture.project} ${sessionId}.` }],
      },
    ]);
    projectViewFixtureIds.push(`${fixture.project}/${sessionId}`);
  }
}

const projectView = await listSessions({ view: "project", limit: 10, refresh: true });
assert.equal(projectView.view, "project");
assert.equal(projectView.totalMatched, 7);
assert.equal(projectView.totalSessions, 8);
assert.equal(projectView.items.length, 8);
assert.equal(projectView.projects.length, 7);
assert.equal(new Set(projectView.items.map((item) => item.project)).size, 7);
assert.equal(
  projectView.items.filter((item) => item.project === "project-view-one").length,
  2,
);

const projectPage = await listSessions({ view: "project", limit: 2, offset: 0 });
assert.equal(projectPage.totalMatched, 7);
assert.equal(projectPage.totalSessions, 8);
assert.equal(new Set(projectPage.items.map((item) => item.project)).size, 2);
const pageProjectIds = new Set(projectPage.items.map((item) => item.project));
assert.deepEqual(
  [...projectPage.items.map((item) => item.id)].sort(),
  [...projectView.items.filter((item) => pageProjectIds.has(item.project)).map((item) => item.id)].sort(),
);

const projectFilteredByProject = await listSessions({
  view: "project",
  project: "project-view-one",
  limit: 10,
});
assert.equal(projectFilteredByProject.totalMatched, 1);
assert.equal(projectFilteredByProject.totalSessions, 2);
assert.equal(projectFilteredByProject.items.length, 2);
const projectFilteredByQuery = await listSessions({
  view: "project",
  q: "session-view-two",
  limit: 10,
});
assert.equal(projectFilteredByQuery.totalMatched, 1);
assert.equal(projectFilteredByQuery.totalSessions, 1);
assert.equal(projectFilteredByQuery.items[0]?.project, "project-view-two");

const removedProjectViewFixtures = await removeSessions(projectViewFixtureIds);
assert.equal(removedProjectViewFixtures.removed.length, projectViewFixtureIds.length);
assert.equal(removedProjectViewFixtures.failed.length, 0);
const afterProjectViewFixtureCleanup = await listSessions({ limit: 20, refresh: true });
assert.equal(afterProjectViewFixtureCleanup.totalMatched, 3);

// --- HTTP ---
const server = startControlPlane();
await new Promise((r) => setTimeout(r, 120));
const base = `http://127.0.0.1:${port}`;
const sRes = await fetch(`${base}/sessions/list?limit=1&offset=1`);
assert.equal(sRes.status, 200);
const sJson = await sRes.json();
assert.ok(Array.isArray(sJson.items));
assert.equal(sJson.totalMatched, 3);
assert.equal(sJson.limit, 1);
assert.equal(sJson.offset, 1);
assert.equal(sJson.items[0]?.id, afterEmptyCleanup.items[1]?.id);

const projectViewRes = await fetch(`${base}/sessions/list?view=project&limit=10`);
assert.equal(projectViewRes.status, 200);
const projectViewJson = await projectViewRes.json();
assert.equal(projectViewJson.view, "project");
assert.equal(projectViewJson.totalMatched, 3);
assert.equal(projectViewJson.totalSessions, 3);
assert.equal(projectViewJson.items.length, 3);

const invalidPageRes = await fetch(`${base}/sessions/list?limit=0&offset=-4`);
assert.equal(invalidPageRes.status, 200);
const invalidPageJson = await invalidPageRes.json();
assert.equal(invalidPageJson.limit, 1);
assert.equal(invalidPageJson.offset, 0);

const dRes = await fetch(`${base}/sessions/read`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: alpha.id }),
});
assert.equal(dRes.status, 200);
const dJson = await dRes.json();
assert.equal(dJson.totalMessages, 5);
assert.equal(dJson.messages.some((message) => message.text.includes("Internal worker-only")), false);

const pRes = await fetch(`${base}/prompts/conflict`);
assert.equal(pRes.status, 200);
const pJson = await pRes.json();
assert.equal(typeof pJson.conflict, "boolean");

const mRes = await fetch(`${base}/mcp/probeHistory?limit=5`);
assert.equal(mRes.status, 200);
const mJson = await mRes.json();
assert.ok(Array.isArray(mJson.items));

const emptyHttpRoot = path.join(sessionsRoot, "session-empty-http");
const emptyHttpPrimary = path.join(emptyHttpRoot, "session-empty-http.jsonl");
const emptyHttpArtifact = path.join(emptyHttpRoot, "tool-results", "result.txt");
await writeJsonl(emptyHttpPrimary, [{ type: "turn_ended", status: "completed" }]);
await fs.mkdir(path.dirname(emptyHttpArtifact), { recursive: true });
await fs.writeFile(emptyHttpArtifact, "empty HTTP session artifact", "utf8");

const clearEmptyRes = await fetch(`${base}/sessions/clearEmpty`, { method: "POST" });
assert.equal(clearEmptyRes.status, 200);
const clearEmptyJson = await clearEmptyRes.json();
assert.equal(clearEmptyJson.emptyFound, 1);
assert.equal(clearEmptyJson.removed.length, 1);
assert.equal(await pathExists(emptyHttpRoot), false);
assert.equal(await pathExists(emptyHttpPrimary), false);
assert.equal(await pathExists(emptyHttpArtifact), false);

const removedSessions = await removeSessions([alpha.id]);
assert.deepEqual(removedSessions.removed, [alpha.id]);
assert.equal(removedSessions.failed.length, 0);
assert.equal(await pathExists(alphaRoot), false);
assert.equal(await pathExists(alphaPrimary), false);
assert.equal(await pathExists(alphaSubagent), false);
assert.equal(await pathExists(alphaArtifact), false);
assert.equal(await pathExists(betaRoot), true);

const afterRemoval = await listSessions({ refresh: true });
assert.equal(afterRemoval.totalMatched, 2);
assert.equal(afterRemoval.items.some((item) => item.sessionId === "session-beta"), true);
const missingRemoval = await removeSessions([alpha.id]);
assert.equal(missingRemoval.removed.length, 0);
assert.equal(missingRemoval.failed.length, 1);

const gammaRoot = path.join(
  process.env.CURSOR_STUDIO_CURSOR_HOME,
  "projects",
  desktopProjectId,
  "agent-transcripts",
  "session-gamma",
);
const gammaPrimary = path.join(gammaRoot, "session-gamma.jsonl");
const gammaArtifact = path.join(gammaRoot, "tool-results", "result.txt");
await writeJsonl(gammaPrimary, [
  { role: "user", message: { content: "Gamma conversation." } },
]);
await fs.mkdir(path.dirname(gammaArtifact), { recursive: true });
await fs.writeFile(gammaArtifact, "gamma auxiliary artifact", "utf8");

const beforeBatchRemoval = await listSessions({ limit: 20, refresh: true });
const gamma = beforeBatchRemoval.items.find((item) => item.sessionId === "session-gamma");
assert.ok(gamma);
const batchRemoval = await removeSessions([beta.id, gamma.id, desktopRootSession.id]);
assert.deepEqual(batchRemoval.removed, [beta.id, gamma.id, desktopRootSession.id]);
assert.equal(batchRemoval.failed.length, 0);
assert.equal(await pathExists(betaRoot), false);
assert.equal(await pathExists(betaPrimary), false);
assert.equal(await pathExists(betaArtifact), false);
assert.equal(await pathExists(gammaRoot), false);
assert.equal(await pathExists(gammaPrimary), false);
assert.equal(await pathExists(gammaArtifact), false);
assert.equal(await pathExists(desktopRootSessionRoot), false);
assert.equal(await pathExists(desktopRootPrimary), false);

const afterBatchRemoval = await listSessions({ refresh: true });
assert.equal(afterBatchRemoval.totalMatched, 0);

await removeProfile("profile-s4");
await new Promise((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve())),
);

console.log("PASS smoke-stage4-workspace", {
  sessionsBeforeRemoval: sessions.totalMatched,
  sessionsAfterRemoval: afterRemoval.totalMatched,
  conflictAfterSync: conflict2.conflict,
  mcpHist: hist.length,
  promptEnabled: tagged.enabled,
});
