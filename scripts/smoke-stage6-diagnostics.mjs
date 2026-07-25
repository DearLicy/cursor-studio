/**
 * Stage 6: diagnostics collect/export smoke.
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

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-s6-"));
process.env.CURSOR_STUDIO_HOME = tmpHome;
const port = await freePort();
process.env.STUDIO_CONTROL_PORT = String(port);
process.env.STUDIO_CONTROL_HOST = "127.0.0.1";

const {
  collectDiagnostics,
  writeDiagnosticsPackage,
} = await import("../server/diagnostics/collect.ts");
const { startControlPlane } = await import("../server/control-plane/index.ts");
const { loadConfig, saveConfig } = await import("../server/config/store.ts");

// ensure config exists
const cfg = await loadConfig();
await saveConfig(cfg);

const bundle = await collectDiagnostics();
assert.ok(bundle.createdAt);
assert.equal(bundle.app.name, "cursor-studio");
assert.ok(bundle.config.path);
assert.ok(Array.isArray(bundle.notes));
assert.ok(bundle.metrics);
assert.ok(bundle.prompts);
assert.ok(bundle.service);
assert.ok(bundle.ca);
assert.ok(bundle.cursor);
assert.ok(bundle.inject);

const written = await writeDiagnosticsPackage();
assert.ok(written.path.includes("diagnostics"));
const raw = await fs.readFile(written.path, "utf8");
const parsed = JSON.parse(raw);
assert.equal(parsed.app.name, "cursor-studio");
// no api keys leaked at top-level config providers dump - providers not fully embedded
assert.ok(!JSON.stringify(parsed).includes("sk-"));

const server = startControlPlane();
await new Promise((r) => setTimeout(r, 150));
const base = `http://127.0.0.1:${port}`;

const g = await fetch(`${base}/diagnostics`);
assert.equal(g.status, 200);
const gJson = await g.json();
assert.equal(gJson.app.name, "cursor-studio");

const p = await fetch(`${base}/diagnostics/export`, { method: "POST" });
assert.equal(p.status, 200);
const pJson = await p.json();
assert.ok(pJson.path);
assert.ok(pJson.bundle?.app?.version);

await new Promise((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve())),
);

console.log("PASS smoke-stage6-diagnostics", {
  path: written.path,
  notes: bundle.notes.length,
  providers: bundle.config.providerCount,
  version: bundle.app.version,
});
