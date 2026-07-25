/**
 * Stage 5 live UI capture with control plane + vite preview + Playwright.
 * Writes screenshots into output/ui-baseline/.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = path.join(root, "output", "ui-baseline");
fs.mkdirSync(baselineDir, { recursive: true });

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

async function waitHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status >= 400) return res.status;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function spawnNode(args, env = {}) {
  return spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const controlPort = await freePort();
const uiPort = await freePort();
const controlBase = `http://127.0.0.1:${controlPort}`;
const uiBase = `http://127.0.0.1:${uiPort}`;

// start control plane via tsx
const control = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", "server/control-plane/index.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      STUDIO_CONTROL_PORT: String(controlPort),
      STUDIO_CONTROL_HOST: "127.0.0.1",
      CURSOR_STUDIO_HOME:
        process.env.CURSOR_STUDIO_HOME ||
        path.join(root, ".tmp-capture-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

let controlLog = "";
control.stdout.on("data", (d) => {
  controlLog += d.toString();
});
control.stderr.on("data", (d) => {
  controlLog += d.toString();
});

await waitHttp(`${controlBase}/health`, 30000);

// ensure dist exists for preview; if not, still try vite dev? Prefer preview.
const distIndex = path.join(root, "dist", "index.html");
assert.ok(fs.existsSync(distIndex), "dist/index.html missing; run npm run build first");

// Patch is not needed - Vite env at build time. For preview, CONTROL is baked.
// App defaults to 127.0.0.1:28191. We'll capture against default OR inject via localStorage? 
// Better: rewrite index to use our control by serving a tiny redirector, or start control on 28191 if free.
// Simplest robust path: if 28191 free, use it for control so built app hits default.

// Kill our free-port control and prefer 28191 if available.
control.kill();
await new Promise((r) => setTimeout(r, 300));

async function portFree(port) {
  return await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

const prefer28191 = await portFree(28191);
const finalControlPort = prefer28191 ? 28191 : controlPort;
const finalControlBase = `http://127.0.0.1:${finalControlPort}`;

const control2 = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", "server/control-plane/index.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      STUDIO_CONTROL_PORT: String(finalControlPort),
      STUDIO_CONTROL_HOST: "127.0.0.1",
      CURSOR_STUDIO_HOME:
        process.env.CURSOR_STUDIO_HOME ||
        path.join(root, ".tmp-capture-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

control2.stdout.on("data", (d) => {
  controlLog += d.toString();
});
control2.stderr.on("data", (d) => {
  controlLog += d.toString();
});

await waitHttp(`${finalControlBase}/health`, 30000);

const preview = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "preview", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

let previewLog = "";
preview.stdout.on("data", (d) => {
  previewLog += d.toString();
});
preview.stderr.on("data", (d) => {
  previewLog += d.toString();
});

await waitHttp(uiBase, 30000);

const browser = await chromium.launch({ headless: true });
const shots = [];

async function shot(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(uiBase, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(600);
    if (fn) await fn(page);
    await page.waitForTimeout(400);
    const file = path.join(baselineDir, name);
    await page.screenshot({ path: file, fullPage: false });
    assert.ok(fs.statSync(file).size > 2000, `${name} too small`);
    shots.push({ name, bytes: fs.statSync(file).size });
  } finally {
    await page.close();
  }
}

// navigate by clicking top nav labels when possible
async function clickNav(page, label) {
  const tab = page.getByRole("button", { name: label }).first();
  if (await tab.count()) {
    await tab.click({ timeout: 5000 }).catch(async () => {
      await page.locator(`text=${label}`).first().click({ timeout: 5000 });
    });
    return;
  }
  await page.locator(`text=${label}`).first().click({ timeout: 5000 });
}

await shot("desktop-live-shell.png", async () => {});
await shot("desktop-live-providers.png", async (page) => {
  await clickNav(page, "供应商").catch(() => clickNav(page, "Providers"));
});
await shot("desktop-live-usage.png", async (page) => {
  await clickNav(page, "用量").catch(() => clickNav(page, "Usage"));
});
await shot("desktop-live-config.png", async (page) => {
  await clickNav(page, "配置").catch(() => clickNav(page, "Config"));
});

// narrow viewport
const narrow = await browser.newPage({ viewport: { width: 900, height: 700 } });
await narrow.goto(uiBase, { waitUntil: "networkidle", timeout: 30000 });
await narrow.waitForTimeout(600);
const narrowPath = path.join(baselineDir, "narrow-live-shell.png");
await narrow.screenshot({ path: narrowPath, fullPage: false });
shots.push({ name: "narrow-live-shell.png", bytes: fs.statSync(narrowPath).size });
await narrow.close();

await browser.close();
control2.kill();
preview.kill();

// update manifest with live files
const manifestPath = path.join(baselineDir, "manifest.json");
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  : { version: 1, required: [], optional: [] };
const liveNames = shots.map((s) => s.name);
manifest.live = {
  capturedAt: new Date().toISOString(),
  controlPort: finalControlPort,
  uiPort,
  files: liveNames,
};
const optional = new Set([...(manifest.optional || []), ...liveNames]);
manifest.optional = [...optional];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("PASS smoke-ui-live-capture", {
  control: finalControlBase,
  ui: uiBase,
  shots,
});
