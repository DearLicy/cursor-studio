/**
 * Stage 2: provider duplicate, probe history, workspace profiles.
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

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-s2-"));
process.env.CURSOR_STUDIO_HOME = tmpHome;
const port = await freePort();
process.env.STUDIO_CONTROL_PORT = String(port);
process.env.STUDIO_CONTROL_HOST = "127.0.0.1";

const { startControlPlane } = await import("../server/control-plane/index.ts");
const {
  loadConfig,
  saveConfig,
  newProvider,
} = await import("../server/config/store.ts");
const {
  upsertProfile,
  applyProfile,
  removeProfile,
} = await import("../server/workspace/profiles-store.ts");
const {
  appendProbeHistory,
  listProbeHistory,
  clearProbeHistory,
} = await import("../server/providers/probe-history.ts");
const { orderProviderCandidates } = await import(
  "../server/backend/agent/provider-chat.ts"
);

const cfg = await loadConfig();
cfg.providers = [
  {
    ...newProvider({
      displayName: "Primary",
      baseURL: "https://a.example/v1",
      apiKey: "k1",
      modelID: "m1",
      models: ["m1", "m2"],
      failoverPriority: 5,
      enabled: true,
    }),
    id: "prov-a",
  },
  {
    ...newProvider({
      displayName: "Secondary",
      baseURL: "https://b.example/v1",
      apiKey: "k2",
      modelID: "m9",
      models: ["m9"],
      failoverPriority: 1,
      enabled: true,
    }),
    id: "prov-b",
  },
];
cfg.profiles = [];
cfg.activeProfileId = undefined;
await saveConfig(cfg);

await clearProbeHistory();
await appendProbeHistory({
  providerId: "prov-a",
  displayName: "Primary",
  ok: true,
  latencyMs: 42,
  endpoint: "https://a.example/v1/models",
  modelCount: 2,
});
await appendProbeHistory({
  providerId: "prov-b",
  displayName: "Secondary",
  ok: false,
  error: "timeout",
  latencyMs: 900,
});
const hist = await listProbeHistory({ limit: 10 });
assert.equal(hist.length, 2);
assert.equal(hist[0].providerId, "prov-b");
const filtered = await listProbeHistory({ providerId: "prov-a" });
assert.equal(filtered.length, 1);

const created = await upsertProfile({
  name: "Work",
  providerIds: ["prov-a"],
  defaultProviderId: "prov-a",
  defaultModelID: "m2",
});
assert.equal(created.profiles.length, 1);
const profileId = created.profiles[0].id;
const applied = await applyProfile(profileId);
assert.equal(applied.activeProfileId, profileId);
const a = applied.providers.find((p) => p.id === "prov-a");
const b = applied.providers.find((p) => p.id === "prov-b");
assert.equal(a?.enabled, true);
assert.equal(a?.modelID, "m2");
assert.equal(b?.enabled, false);

const ordered = orderProviderCandidates(
  applied.providers.filter((p) => p.enabled),
);
assert.equal(ordered[0].id, "prov-a");

const server = startControlPlane();
await new Promise((r) => setTimeout(r, 120));
const base = `http://127.0.0.1:${port}`;

async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}
async function get(pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, json: await res.json() };
}

const dup = await post("/providers/duplicate", { id: "prov-a" });
assert.equal(dup.status, 200, JSON.stringify(dup.json));
assert.ok(dup.json.provider?.id);
assert.ok(String(dup.json.provider.displayName).includes("Copy"));
assert.ok(dup.json.providers.length >= 3);

const histApi = await get("/providers/probeHistory?limit=5");
assert.equal(histApi.status, 200);
assert.ok(Array.isArray(histApi.json.items));

const profApi = await get("/profiles");
assert.equal(profApi.status, 200);
assert.ok(profApi.json.profiles.length >= 1);

await removeProfile(profileId);
await new Promise((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve())),
);

console.log("PASS smoke-stage2-providers", {
  hist: hist.length,
  duplicated: dup.json.provider.id,
  profile: profileId,
  port,
});