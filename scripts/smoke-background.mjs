import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  applyWorkbenchBackground,
  clearWorkbenchBackground,
  getInjectStatus,
} from "../server/cursor/workbench-inject.ts";

const fixture = await mkdtemp(join(tmpdir(), "cursor-studio-background-"));
const localApp = join(fixture, "local");
const installRoot = join(localApp, "Programs", "cursor");
const appRoot = join(installRoot, "resources", "app");
const workbenchDir = join(appRoot, "out", "vs", "workbench");
const sessionsDir = join(appRoot, "out", "vs", "sessions");
const cursorMainJs = join(appRoot, "out", "main.js");
const studioHome = join(fixture, "studio-home");

process.env.LOCALAPPDATA = localApp;
process.env.CURSOR_STUDIO_HOME = studioHome;

await mkdir(workbenchDir, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(join(workbenchDir, "workbench.desktop.main.js"), "desktop fixture\n");
await writeFile(join(workbenchDir, "workbench.glass.main.js"), "glass fixture\n");
await writeFile(join(sessionsDir, "sessions.desktop.main.js"), "sessions fixture\n");
await writeFile(
  cursorMainJs,
  'class Fixture { boot(){if(this.host)this._win=new vi.BrowserWindow(ce),this._id=this._win.id;else{this.browserView=new vi.WebContentsView(ce),this.browserView.setBackgroundColor("#00000000");}} }\n',
);

const server = createServer((req, res) => {
  if (req.url === "/background.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from("png fixture"));
    return;
  }
  if (req.url === "/background.mp4") {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(Buffer.from("video fixture"));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

const baseAppearance = {
  enabled: true,
  imagePath: `http://127.0.0.1:${port}/background.png`,
  opacity: 0.42,
  blur: 5,
  windowOpacity: 0.28,
  surfaceOpacity: 0.72,
  sizeModel: "cover",
  blendModel: "auto",
  randomImageFolder: "",
  autoStatus: false,
  autoInterval: 10,
  defaultOnlinePage: "",
  liveApply: false,
};

try {
  const first = await applyWorkbenchBackground(baseAppearance);
  assert.equal(first.mediaType, "image");
  assert.equal(first.patchedBundles?.length, 3);
  const firstCss = await readFile(first.cssPath, "utf8");
  assert.match(firstCss, /background-image: url\('vscode-file:/);
  assert.match(firstCss, /body::before[\s\S]*?z-index: 0 !important/);
  assert.match(firstCss, /data-cursor-studio-glass-root/);
  assert.match(firstCss, /data-cursor-studio-glass-surface/);
  assert.match(firstCss, /data-cursor-studio-ui-root/);
  assert.match(firstCss, /data-component="root"/);
  assert.match(firstCss, /--glass-chat-bubble-background/);
  assert.match(firstCss, /agent-panel-conversation-shell/);
  assert.match(firstCss, /\.ui-context-usage-tray/);
  assert.match(firstCss, /--cursor-studio-floating-fill/);
  assert.match(firstCss, /--cursor-studio-window-radius: 12px/);
  assert.match(firstCss, /\[data-cursor-studio-glass-root\][\s\S]*?background: transparent !important/);
  assert.match(firstCss, /data-cursor-studio-workspace/);
  assert.doesNotMatch(firstCss, /html\[data-cursor-studio-agent\]/);
  assert.doesNotMatch(firstCss, /#workbench-container > div/);
  assert.doesNotMatch(firstCss, /\[class\*="agent" i\]\[class\*="container" i\]/);
  assert.doesNotMatch(firstCss, /\[class\*="composer" i\]\[class\*="container" i\]/);
  assert.doesNotMatch(firstCss, /body > div:not\(#cursor-studio-bg-video\)/);
  assert.doesNotMatch(firstCss, /body > div:not\(:empty\):not\(#cursor-studio-bg-video\)/);
  assert.doesNotMatch(firstCss, /data-floating-ui-portal/);
  assert.match(firstCss, /\.monaco-workbench \.part\.titlebar/);
  assert.match(firstCss, /\.monaco-workbench \.part\.statusbar/);
  assert.match(firstCss, /--vscode-statusBar-background: transparent/);
  assert.match(firstCss, /role="menu"/);
  assert.match(firstCss, /\[role="menu"\][\s\S]*?backdrop-filter: none !important/);
  assert.match(firstCss, /\[role="dialog"\]\[aria-modal="true"\]/);
  assert.match(firstCss, /#f4f4f4\) 18%/);
  assert.match(firstCss, /#f4f4f4\) 94%/);
  assert.match(firstCss, /#f4f4f4\) 28%/);
  assert.match(await readFile(cursorMainJs, "utf8"), /cursor-studio-material-start/);
  assert.match(await readFile(cursorMainJs, "utf8"), /transparent:true/);
  assert.match(await readFile(cursorMainJs, "utf8"), /backgroundMaterial:"acrylic"/);
  assert.match(await readFile(cursorMainJs, "utf8"), /__cursorStudioAcrylicVersion=2/);
  assert.match(await readFile(cursorMainJs, "utf8"), /__cursorStudioBrowserViewVersion=1/);
  assert.match(await readFile(cursorMainJs, "utf8"), /setTitleBarOverlay/);
  assert.equal(existsSync(`${cursorMainJs}.cursor-studio.bak`), true);

  const firstStatus = await getInjectStatus();
  assert.equal(firstStatus.bundleStatuses.length, 3);
  assert.equal(firstStatus.allBundlesPatched, true);
  assert.equal(firstStatus.bundleStatuses.every((bundle) => bundle.bakExists), true);
  assert.equal(firstStatus.mediaType, "image");
  assert.equal(firstStatus.materialPatched, true);
  const injectedDesktop = await readFile(
    join(workbenchDir, "workbench.desktop.main.js"),
    "utf8",
  );
  const bootstrapMatch = injectedDesktop.match(
    /\/\*ext-cursorStudio-start\*\/[\s\S]*?\/\*ext-cursorStudio-end\*\//,
  );
  assert.ok(bootstrapMatch);
  new Function(bootstrapMatch[0]);
  assert.match(bootstrapMatch[0], /bootstrap\.5/);
  assert.match(bootstrapMatch[0], /var PRESTYLE =/);
  assert.match(bootstrapMatch[0], /function syncWindowState\(targetWindow\)/);
  assert.match(bootstrapMatch[0], /function markGlassSurfaces\(doc\)/);
  assert.match(bootstrapMatch[0], /function findStableRoot\(doc\)/);
  assert.match(bootstrapMatch[0], /data-cursor-studio-ui-root/);
  assert.match(bootstrapMatch[0], /ui-context-usage-tray/);
  assert.match(bootstrapMatch[0], /data-cursor-studio-glass-ready/);
  assert.doesNotMatch(bootstrapMatch[0], /candidate\.areaRatio/);
  assert.doesNotMatch(bootstrapMatch[0], /chromeBottom/);
  assert.doesNotMatch(bootstrapMatch[0], /querySelectorAll\("\*"\)/);
  assert.match(bootstrapMatch[0], /function queueApply\(\)/);
  assert.match(bootstrapMatch[0], /clearTimeout\(runtime\.reapplyTimer\)/);
  assert.match(bootstrapMatch[0], /if \(runtime\.css === text\) return;/);
  assert.match(bootstrapMatch[0], /var observer = new MutationObserver\(function\(\) \{/);
  assert.match(bootstrapMatch[0], /observer\.observe\(document\.body, \{ childList: true \}\)/);
  for (const bundlePath of first.patchedBundles ?? []) {
    assert.match(await readFile(bundlePath, "utf8"), /function markGlassSurfaces\(doc\)/);
  }

  // A CSS-only refresh must still replace an older bootstrap so live settings
  // cannot leave the previous full-DOM scanner active in a running install.
  const staleBundle = first.patchedBundles?.[0];
  assert.ok(staleBundle);
  await writeFile(
    staleBundle,
    (await readFile(staleBundle, "utf8")).replace("bootstrap.5", "bootstrap.4"),
  );
  const upgraded = await applyWorkbenchBackground(baseAppearance, {
    realtimeOnly: true,
  });
  assert.equal(upgraded.needsReload, true);
  assert.match(await readFile(staleBundle, "utf8"), /bootstrap\.5/);

  // The status endpoint reconstructs state from markers when its JSON state is missing.
  await rm(join(studioHome, "inject", "workbench-inject.json"));
  const rebuilt = await getInjectStatus();
  assert.equal(rebuilt.allBundlesPatched, true);
  assert.ok(rebuilt.state);

  const second = await applyWorkbenchBackground({
    ...baseAppearance,
    imagePath: `http://127.0.0.1:${port}/background.mp4`,
  });
  assert.equal(second.mediaType, "video");
  const videoCss = await readFile(second.cssPath, "utf8");
  assert.match(videoCss, /cursor-studio-video-start/);
  const videoStatus = await getInjectStatus();
  assert.equal(videoStatus.mediaType, "video");
  assert.equal(videoStatus.remoteCached, true);

  await clearWorkbenchBackground();
  const cleared = await getInjectStatus();
  assert.equal(cleared.allBundlesPatched, false);
  assert.equal(cleared.cssExists, false);
  assert.equal(cleared.materialPatched, false);
  assert.equal((await readFile(cursorMainJs, "utf8")).includes("cursor-studio-material-start"), false);

  // Without media, Cursor keeps native acrylic but never adds a full-window blur veil.
  const glassOnly = await applyWorkbenchBackground({
    ...baseAppearance,
    enabled: false,
  });
  assert.equal(glassOnly.mediaType, undefined);
  assert.equal(glassOnly.assetPath, undefined);
  const glassCss = await readFile(glassOnly.cssPath, "utf8");
  assert.match(glassCss, /background-image: none !important/);
  assert.match(glassCss, /--cursor-studio-window-radius: 12px/);
  assert.match(glassCss, /body::after\s*\{\s*content: none !important/);
  assert.match(glassCss, /body::before\s*\{\s*content: none !important/);
  assert.match(glassCss, /body::after[\s\S]*?backdrop-filter: none !important/);
  assert.match(glassCss, /\[data-cursor-studio-glass-surface\][\s\S]*?backdrop-filter: none !important/);
  const glassStatus = await getInjectStatus();
  assert.equal(glassStatus.materialPatched, true);
  assert.equal(glassStatus.mediaType, undefined);

  const emptyMedia = await applyWorkbenchBackground({
    ...baseAppearance,
    imagePath: "",
    randomImageFolder: "",
    autoStatus: false,
  });
  const emptyCss = await readFile(emptyMedia.cssPath, "utf8");
  assert.match(emptyCss, /body::after\s*\{\s*content: none !important/);
  assert.match(emptyCss, /body::before\s*\{\s*content: none !important/);
  assert.equal((await getInjectStatus()).materialPatched, true);
  await clearWorkbenchBackground();

  // An old background-cover patch is removed and replaced by Studio in one pass.
  const staleBackgroundCover =
    "/*ext-backgroundCover-start*/\nold loader\n/*ext-backgroundCover-end*/\n";
  for (const name of ["workbench.desktop.main.js", "workbench.glass.main.js"]) {
    const filePath = join(workbenchDir, name);
    await writeFile(filePath, (await readFile(filePath, "utf8")) + staleBackgroundCover);
  }
  await writeFile(join(workbenchDir, "css-background-cover.css"), "old css");
  await writeFile(join(workbenchDir, "js-background-cover.js"), "old js");
  const conflict = await getInjectStatus();
  assert.equal(conflict.backgroundCoverConflict, true);
  await applyWorkbenchBackground(baseAppearance);
  const overriddenDesktop = await readFile(
    join(workbenchDir, "workbench.desktop.main.js"),
    "utf8",
  );
  assert.equal(overriddenDesktop.includes("/*ext-backgroundCover-start*/"), false);
  assert.equal(overriddenDesktop.includes("/*ext-cursorStudio-start*/"), true);
  assert.equal(await readFile(join(workbenchDir, "workbench.desktop.main.js.cursor-studio.bak"), "utf8").then((text) => text.includes("backgroundCover-start")), false);
  assert.equal(existsSync(join(workbenchDir, "css-background-cover.css")), false);
  assert.equal(existsSync(join(workbenchDir, "js-background-cover.js")), false);
  await clearWorkbenchBackground();
  console.log("Background injection smoke passed: 3 bundles, Agent workspace, native acrylic, media/no-media, image/video cache, state rebuild, restore");
} finally {
  server.close();
  await once(server, "close").catch(() => undefined);
  await rm(fixture, { recursive: true, force: true });
}
