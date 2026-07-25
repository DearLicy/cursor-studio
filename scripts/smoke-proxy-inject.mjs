/**
 * Stage 1: proxy inject dry-run / fingerprint / backup (no real Cursor write if plan empty path missing ok).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dryRunProxyInject,
  fingerprintSettings,
  proxyUrlFromListenAddr,
  backupCursorSettings,
} from "../server/cursor/settings.ts";
import { mapUpstreamStatus, shouldFailover } from "../server/backend/error-map.ts";

const plan = await dryRunProxyInject("127.0.0.1:18080");
assert.ok(plan.settingsPath, "settingsPath");
assert.equal(plan.proxyURL, "http:
assert.ok(typeof plan.beforeFingerprint === "string");
assert.ok(typeof plan.afterFingerprint === "string");
assert.ok(Array.isArray(plan.changes));
// fingerprint stable for same subset
const fp1 = fingerprintSettings({ "http.proxy": "http://x" });
const fp2 = fingerprintSettings({ "http.proxy": "http://x" });
const fp3 = fingerprintSettings({ "http.proxy": "http://y" });
assert.equal(fp1, fp2);
assert.notEqual(fp1, fp3);
assert.equal(proxyUrlFromListenAddr("127.0.0.1:1"), "http:

// backup writes under CURSOR_STUDIO_HOME if set
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-backup-"));
process.env.CURSOR_STUDIO_HOME = tmpHome;
const backup = await backupCursorSettings("smoke");
assert.ok(backup.backupPath.includes("backups"));
const raw = await fs.readFile(backup.backupPath, "utf8");
const parsed = JSON.parse(raw);
assert.equal(parsed.reason, "smoke");
assert.ok(parsed.settings);

// error map still consistent
assert.equal(mapUpstreamStatus(429).code, "UPSTREAM_RATE_LIMIT");
assert.equal(shouldFailover(new Error("AbortError: client cancelled")), false);

console.log("PASS smoke-proxy-inject", {
  wouldWrite: plan.wouldWrite,
  changeKeys: plan.changes.map((c) => c.key),
  backupPath: backup.backupPath,
});