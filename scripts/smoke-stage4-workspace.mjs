/**
 * Stage 4: prompt, MCP diagnostics, profile scope, and control-plane routes.
 * Cursor session storage has its own SQLite-backed smoke fixture.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-s4-"));
process.env.CURSOR_STUDIO_HOME = fixtureHome;
process.env.CURSOR_STUDIO_CURSOR_HOME = path.join(fixtureHome, "cursor-home");
process.env.CURSOR_STUDIO_CURSOR_RULES_DIR = path.join(fixtureHome, "cursor-rules");
process.env.CURSOR_STUDIO_CURSOR_USER_DATA = path.join(fixtureHome, "cursor-user-data");
process.env.STUDIO_CONTROL_PORT = String(await freePort());

const {
  detectPromptConflict,
  listPrompts,
  setMasterEnabled,
  syncCursorInjection,
  upsertPrompt,
} = await import("../server/workspace/prompts-store.ts");
const {
  appendMcpProbeHistory,
  latestMcpProbeByServer,
  listMcpProbeHistory,
} = await import("../server/workspace/mcp-diagnostics.ts");
const {
  applyProfile,
  removeProfile,
  upsertProfile,
} = await import("../server/workspace/profiles-store.ts");
const { loadConfig, newProvider, saveConfig } = await import(
  "../server/config/store.ts"
);
const { startControlPlane } = await import("../server/control-plane/index.ts");

let server;
try {
  const listed = await listPrompts();
  assert.equal(typeof listed.conflict?.conflict, "boolean");

  await setMasterEnabled(true);
  const created = await upsertPrompt({
    title: "Stage4 Prompt",
    content: "You are the isolated stage4 fixture prompt.",
    enabled: true,
    profileIds: ["profile-s4"],
  });
  assert(created.state.items.some((item) => item.title === "Stage4 Prompt"));

  const sync = await syncCursorInjection();
  assert.equal(sync.written, true);
  await fs.writeFile(sync.path, "# externally modified\n", "utf8");
  assert.equal((await detectPromptConflict()).conflict, true);
  assert.equal((await syncCursorInjection()).written, true);
  const conflictAfterSync = await detectPromptConflict();
  assert.equal(conflictAfterSync.conflict, false);

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
  const history = await listMcpProbeHistory({ serverId: "mcp-1", limit: 10 });
  assert.equal(history.length, 2);
  assert.equal(history[0].ok, false);
  assert.equal((await latestMcpProbeByServer())["mcp-1"].ok, false);

  const config = await loadConfig();
  config.providers = [
    {
      ...newProvider({
        displayName: "S4",
        baseURL: "https://s4.example/v1",
        apiKey: "fixture-key",
        modelID: "fixture-model",
        enabled: true,
      }),
      id: "prov-s4",
    },
  ];
  await saveConfig(config);
  const profiles = await upsertProfile({
    id: "profile-s4",
    name: "S4 Profile",
    providerIds: ["prov-s4"],
    promptIds: [],
  });
  assert(profiles.profiles.some((profile) => profile.id === "profile-s4"));
  await applyProfile("profile-s4");
  const tagged = (await listPrompts()).state.items.find(
    (item) => item.title === "Stage4 Prompt",
  );
  assert.equal(tagged?.enabled, true);

  server = startControlPlane();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const base = `http://127.0.0.1:${process.env.STUDIO_CONTROL_PORT}`;
  const promptResponse = await fetch(`${base}/prompts/conflict`);
  assert.equal(promptResponse.status, 200);
  assert.equal(typeof (await promptResponse.json()).conflict, "boolean");
  const mcpResponse = await fetch(`${base}/mcp/probeHistory?limit=5`);
  assert.equal(mcpResponse.status, 200);
  assert(Array.isArray((await mcpResponse.json()).items));

  console.log("PASS smoke-stage4-workspace", {
    conflictAfterSync: conflictAfterSync.conflict,
    mcpHistory: history.length,
    promptEnabled: tagged?.enabled,
  });
} finally {
  await removeProfile("profile-s4").catch(() => undefined);
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  await fs.rm(fixtureHome, { recursive: true, force: true });
}
