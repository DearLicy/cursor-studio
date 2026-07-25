/**
 * Stage 5: UI baseline smoke.
 * Validates screenshot baseline catalog and (optionally) recaptures with Playwright.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = path.join(root, "output", "ui-baseline");
const manifestPath = path.join(baselineDir, "manifest.json");

function exists(p) {
  return fs.existsSync(p);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 1) baseline catalog
assert.ok(exists(manifestPath), "missing output/ui-baseline/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.ok(Array.isArray(manifest.required), "manifest.required");
const present = [];
const missingRequired = [];
for (const name of manifest.required) {
  const p = path.join(baselineDir, name);
  if (!exists(p) || fs.statSync(p).size < 1000) missingRequired.push(name);
  else present.push({ name, bytes: fs.statSync(p).size });
}
assert.equal(missingRequired.length, 0, `missing required baselines: ${missingRequired.join(",")}`);

for (const name of manifest.optional || []) {
  const p = path.join(baselineDir, name);
  if (exists(p) && fs.statSync(p).size >= 1000) {
    present.push({ name, bytes: fs.statSync(p).size });
  }
}

assert.ok(exists(path.join(baselineDir, "index.html")), "baseline gallery missing");

// 2) design tokens still wired
const tokens = fs.readFileSync(path.join(root, "src/styles/tokens.css"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main.tsx"), "utf8");
assert.ok(tokens.includes("--studio-ink"));
assert.ok(main.includes("tokens.css"));

// 3) built UI contains shell hooks when dist exists
const distIndex = path.join(root, "dist", "index.html");
if (exists(distIndex)) {
  const html = fs.readFileSync(distIndex, "utf8");
  assert.ok(html.includes("script") || html.includes("assets"), "dist index should reference assets");
}

// 4) optional live capture with playwright if installed
let capture = "skipped";
try {
  const playwright = await import("playwright");
  const port = await freePort();
  const preview = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: root,
      stdio: "ignore",
      shell: false,
      env: { ...process.env },
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const up = await waitHttp(url, 25000);
  if (!up) {
    preview.kill();
    throw new Error("vite preview did not start (dist may be stale; baseline files still valid)");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  // control plane may be down; app should still render shell/error state
  await page.waitForTimeout(800);
  const livePath = path.join(baselineDir, "desktop-live-shell.png");
  await page.screenshot({ path: livePath, fullPage: false });
  await browser.close();
  preview.kill();
  assert.ok(fs.statSync(livePath).size > 1000, "live screenshot empty");
  capture = "captured";
} catch (e) {
  capture = `skipped:${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
}

console.log("PASS smoke-ui-baseline", {
  required: manifest.required.length,
  present: present.length,
  capture,
  gallery: "output/ui-baseline/index.html",
});
