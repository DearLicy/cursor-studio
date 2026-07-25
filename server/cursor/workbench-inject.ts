/**
 * Cursor 背景自注入 — 对齐 background-cover FileDom 路径：
 * 1. 写 css-cursor-studio-bg.css（背景层 + 区块透明）
 * 2. 在 workbench.desktop.main.js / glass.main.js 追加 bootstrap IIFE
 * 3. 备份 .cursor-studio.bak，清除时剥标记或还原
 *
 * 不依赖扩展；默认不写；仅手动 apply。
 */
import fs from "node:fs/promises";
import { existsSync, copyFileSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppearanceConfig, SizeModel, BlendModel } from "../config/store";
import { loadConfig, studioHome } from "../config/store";

const EXT = "cursorStudio";
const MARK_START = `/*ext-${EXT}-start*/`;
const MARK_END = `/*ext-${EXT}-end*/`;
const CSS_NAME = "css-cursor-studio-bg.css";
const BACKGROUND_COVER_CSS_NAME = "css-background-cover.css";
const BACKGROUND_COVER_JS_NAME = "js-background-cover.js";
const BACKGROUND_COVER_MARK_START = "/*ext-backgroundCover-start*/";
const ASSET_DIR = "cursor-studio-assets";
const STATE_FILE = "workbench-inject.json";
const VIDEO_CONFIG_START = "/*cursor-studio-video-start*/";
const VIDEO_CONFIG_END = "/*cursor-studio-video-end*/";
const MATERIAL_MARK_START = "/*cursor-studio-material-start*/";
const MATERIAL_MARK_END = "/*cursor-studio-material-end*/";
const WINDOW_RADIUS_PX = 12;
const BOOTSTRAP_VERSION = 5;
const DEFAULT_BACKGROUND_BLUR = 24;
const DEFAULT_WINDOW_OPACITY = 0.12;
const DEFAULT_SURFACE_OPACITY = 0.46;
const FLOATING_SURFACE_PERCENT = 94;
const MAX_REMOTE_MEDIA_BYTES = 64 * 1024 * 1024;
const REMOTE_MEDIA_TIMEOUT_MS = 20_000;
/** 旧版 HTML link 注入标记（清除时一并清理） */
const HTML_MARK_START = "<!-- cursor-studio-bg-start -->";
const HTML_MARK_END = "<!-- cursor-studio-bg-end -->";
const OLD_CSS_NAME = "cursor-studio-bg.css";

export type InjectState = {
  workbenchJs: string;
  cssPath: string;
  installRoot: string;
  appOut: string;
  patchedBundles: string[];
  cursorMainJs?: string;
  assetPath?: string;
  mediaType?: MediaType;
  sourcePath?: string;
  remoteCached?: boolean;
  appliedAt: string;
};

export type InjectResult = {
  workbenchHtml?: string;
  workbenchJs?: string;
  cssPath: string;
  assetPath?: string;
  mediaType?: MediaType;
  sourcePath?: string;
  remoteCached?: boolean;
  needsReload: boolean;
  message: string;
  patchedBundles?: string[];
};

type BundleTarget = {
  jsPath: string;
  bakPath: string;
};

export type BundleInjectStatus = {
  name: string;
  path: string;
  patched: boolean;
  bakExists: boolean;
};

export type InjectStatusResult = {
  installed: boolean;
  workbenchHtml?: string;
  workbenchJs?: string;
  htmlPatched: boolean;
  jsPatched: boolean;
  allBundlesPatched: boolean;
  bundleStatuses: BundleInjectStatus[];
  cssExists: boolean;
  writeOk: boolean;
  bakExists: boolean;
  assetExists: boolean;
  mediaType?: MediaType;
  sourcePath?: string;
  remoteCached?: boolean;
  backgroundCoverConflict: boolean;
  materialPatched: boolean;
  materialBakExists: boolean;
  state: InjectState | null;
};

export type MediaType = "image" | "video";

let autoRotationTimer: ReturnType<typeof setInterval> | null = null;
let autoRotationRunning = false;

function candidateInstallRoots(): string[] {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  return [
    path.join(local, "Programs", "cursor"),
    path.join(local, "Programs", "Cursor"),
    path.join(programFiles, "Cursor"),
    path.join(programFiles, "cursor"),
    "/Applications/Cursor.app/Contents/Resources",
  ];
}

/** 定位 Cursor appRoot（含 out/vs/workbench）与安装根 */
export function resolveCursorWorkbench(explicitRoot?: string): {
  installRoot: string;
  appRoot: string;
  workbenchDir: string;
  appOut: string;
  workbenchHtml?: string;
} | null {
  const roots = explicitRoot
    ? [explicitRoot, ...candidateInstallRoots()]
    : candidateInstallRoots();

  for (const root of roots) {
    const candidates = [
      // Windows 标准：…/cursor/resources/app
      path.join(root, "resources", "app"),
      // macOS Resources 直接当 root 时
      path.join(root, "app"),
      root,
    ];
    for (const appRoot of candidates) {
      const workbenchDir = path.join(appRoot, "out", "vs", "workbench");
      const mainJs = path.join(workbenchDir, "workbench.desktop.main.js");
      if (!existsSync(mainJs)) continue;

      let installRoot = root;
      if (appRoot.includes(`${path.sep}resources${path.sep}app`)) {
        installRoot = appRoot.split(`${path.sep}resources${path.sep}app`)[0];
      }

      const workbenchHtml = path.join(
        appRoot,
        "out",
        "vs",
        "code",
        "electron-sandbox",
        "workbench",
        "workbench.html",
      );

      return {
        installRoot,
        appRoot,
        workbenchDir,
        appOut: path.join(appRoot, "out"),
        workbenchHtml: existsSync(workbenchHtml) ? workbenchHtml : undefined,
      };
    }
  }
  return null;
}

/** 兼容旧 API 名 */
export function resolveWorkbenchHtml(explicitRoot?: string): {
  installRoot: string;
  workbenchHtml: string;
} | null {
  const r = resolveCursorWorkbench(explicitRoot);
  if (!r?.workbenchHtml) return null;
  return { installRoot: r.installRoot, workbenchHtml: r.workbenchHtml };
}

function listBundles(workbenchDir: string, appOut: string): BundleTarget[] {
  const names = ["workbench.desktop.main.js", "workbench.glass.main.js"];
  const out: BundleTarget[] = [];
  for (const name of names) {
    const jsPath = path.join(workbenchDir, name);
    if (existsSync(jsPath)) {
      out.push({ jsPath, bakPath: jsPath + ".cursor-studio.bak" });
    }
  }
  // sessions 辅助窗（若存在）
  const sessions = path.join(appOut, "vs", "sessions", "sessions.desktop.main.js");
  if (existsSync(sessions)) {
    out.push({ jsPath: sessions, bakPath: sessions + ".cursor-studio.bak" });
  }
  return out;
}

function bundleDisplayName(jsPath: string): string {
  const name = path.basename(jsPath).toLowerCase();
  if (name.includes("glass")) return "Agent";
  if (name.includes("sessions")) return "Sessions";
  return "IDE";
}

function injectStatePath(): string {
  return path.join(studioHome(), "inject", STATE_FILE);
}

export async function loadInjectState(): Promise<InjectState | null> {
  const p = injectStatePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as InjectState;
  } catch {
    return null;
  }
}

async function saveInjectState(state: InjectState): Promise<void> {
  const dir = path.dirname(injectStatePath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(injectStatePath(), JSON.stringify(state, null, 2), "utf8");
}

async function clearInjectState(): Promise<void> {
  const p = injectStatePath();
  if (existsSync(p)) await fs.unlink(p);
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

type MaterialTokens = {
  blur: number;
  windowOpacity: number;
  surfaceOpacity: number;
  controlOpacity: number;
  windowPercent: number;
  controlPercent: number;
};

/** Keep bootstrap and the loaded stylesheet on the exact same material values. */
function materialTokens(appearance: AppearanceConfig): MaterialTokens {
  const blur = clamp(
    Number(appearance.blur ?? DEFAULT_BACKGROUND_BLUR),
    0,
    100,
  );
  const windowOpacity = clamp(
    Number(appearance.windowOpacity ?? DEFAULT_WINDOW_OPACITY),
    0,
    1,
  );
  const surfaceOpacity = clamp(
    Number(appearance.surfaceOpacity ?? DEFAULT_SURFACE_OPACITY),
    0,
    1,
  );
  // Cursor's welcome screen uses a very light control material. Never turn
  // nested Agent controls into a second opaque workspace layer.
  const controlOpacity = Math.min(surfaceOpacity, 0.18);

  return {
    blur,
    windowOpacity,
    surfaceOpacity,
    controlOpacity,
    windowPercent: Math.round(windowOpacity * 100),
    controlPercent: Math.round(controlOpacity * 100),
  };
}

function sizeCss(model: SizeModel): {
  size: string;
  repeat: string;
  position: string;
} {
  switch (model) {
    case "contain":
      return { size: "contain", repeat: "no-repeat", position: "center" };
    case "repeat":
      return { size: "auto", repeat: "repeat", position: "0 0" };
    case "center":
      return { size: "auto", repeat: "no-repeat", position: "center" };
    case "not_left":
      return { size: "cover", repeat: "no-repeat", position: "left center" };
    case "not_right":
      return { size: "cover", repeat: "no-repeat", position: "right center" };
    case "not_top":
      return { size: "cover", repeat: "no-repeat", position: "center top" };
    case "not_bottom":
      return { size: "cover", repeat: "no-repeat", position: "center bottom" };
    case "not_right_bottom":
      return { size: "cover", repeat: "no-repeat", position: "right bottom" };
    case "not_right_top":
      return { size: "cover", repeat: "no-repeat", position: "right top" };
    case "not_center":
      return { size: "cover", repeat: "no-repeat", position: "20% 20%" };
    case "cover":
    default:
      return { size: "cover", repeat: "no-repeat", position: "center" };
  }
}

function blendCss(model: BlendModel): string {
  switch (model) {
    case "multiply":
      return "multiply";
    case "lighten":
      return "lighten";
    default:
      return "normal";
  }
}

/** vscode-file://vscode-app/… 本地路径（与 FileDom.localImgToVsc 一致） */
export function toVscodeFileUrl(absPath: string): string {
  let p = absPath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(p)) {
    // Windows drive → vscode-file://vscode-app/c:/...
    return `vscode-file://vscode-app/${p}`;
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return `vscode-file://vscode-app${p}`;
}

function escapeCssUrl(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * 区块透明 + 背景层。
 * 仅 body::before 不够：侧栏/编辑器默认有实色底，必须把 part 背景清掉。
 */
export function buildBackgroundCss(
  appearance: AppearanceConfig,
  imageUrl: string | null,
  mediaType: MediaType = "image",
): string {
  // FileDom 上限 0.8；我们保留 0~1，但建议 UI 说明过高会挡文字
  const opacity = clamp(appearance.opacity, 0, 1);
  const { blur, windowPercent, controlPercent } = materialTokens(appearance);
  const { size, repeat, position } = sizeCss(appearance.sizeModel || "cover");
  const blend = blendCss(appearance.blendModel || "auto");
  const hasMediaBackground = Boolean(appearance.enabled && imageUrl);
  const surfaceBackdrop = hasMediaBackground
    ? `blur(${blur}px) saturate(0.94)`
    : "none";
  const windowBackdrop = hasMediaBackground
    ? `blur(${blur}px) saturate(0.94)`
    : "none";
  const bg =
    hasMediaBackground && imageUrl && mediaType === "image"
      ? `background-image: url('${escapeCssUrl(imageUrl)}') !important;`
      : "background-image: none !important;";
  const videoConfig =
    hasMediaBackground && imageUrl && mediaType === "video"
      ? `${VIDEO_CONFIG_START}\n${JSON.stringify({
          url: imageUrl,
          opacity,
          blur,
          blendMode: blend,
          objectFit: size === "contain" ? "contain" : "cover",
          objectPosition: position,
        })}\n${VIDEO_CONFIG_END}`
      : "";

  return `/* cursor-studio auto-generated ${new Date().toISOString()} */
${videoConfig}
html {
  --cursor-studio-window-radius: ${WINDOW_RADIUS_PX}px;
}

html[data-cursor-studio-maximized],
html[data-cursor-studio-fullscreen] {
  --cursor-studio-window-radius: 0px;
}

/* 根画布透明：IDE、Glass Agent 与 Sessions 都让出系统 Acrylic。 */
html,
body,
#workbench-container,
.monaco-workbench,
[data-component="root"],
[data-cursor-studio-ui-root],
[data-cursor-studio-glass-root],
[data-cursor-studio-glass-surface],
[data-cursor-studio-workspace] {
  background-color: transparent !important;
  border-radius: inherit !important;
}

html,
body {
  overflow: hidden !important;
  border-radius: var(--cursor-studio-window-radius) !important;
  clip-path: inset(0 round var(--cursor-studio-window-radius)) !important;
}

#workbench-container,
.monaco-workbench,
[data-component="root"],
[data-cursor-studio-ui-root],
[data-cursor-studio-workspace],
body::before,
body::after,
#cursor-studio-bg-video {
  border-radius: inherit !important;
}

#workbench-container,
.monaco-workbench,
[data-component="root"],
[data-cursor-studio-ui-root],
[data-cursor-studio-workspace] {
  position: relative !important;
  z-index: 1 !important;
}

/* 内容区块：保持文字清晰，同时让 Acrylic / 媒体从下方透出。 */
[data-component="root"],
[data-cursor-studio-ui-root] {
  --cursor-studio-pane-fill: transparent;
  --cursor-studio-control-fill: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${controlPercent}%, transparent);
  --cursor-studio-floating-fill: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${FLOATING_SURFACE_PERCENT}%, transparent);
  --glass-surface-background: var(--cursor-studio-pane-fill);
  --glass-sidebar-surface-background: var(--cursor-studio-pane-fill);
  --glass-chat-surface-background: var(--cursor-studio-pane-fill);
  --glass-editor-surface-background: var(--cursor-studio-pane-fill);
  --glass-onboard-surface-background: var(--cursor-studio-pane-fill);
  --glass-chat-bubble-background: var(--cursor-studio-control-fill);
  --prompt-input-container-bg: var(--cursor-studio-control-fill);
}

/* Large workbench regions stay transparent. Nested content must not add a
 * second white surface over the same native Acrylic window. */
.monaco-workbench > :is(.part.sidebar, .part.auxiliarybar, .part.panel, .part.editor),
.agent-panel,
.agent-panel-conversation-shell,
.composer-messages-container,
.virtualized-composer-messages-scroll-container,
.monaco-workbench .monaco-list-rows,
.monaco-workbench .monaco-list-row {
  background: transparent !important;
  backdrop-filter: none !important;
}

.monaco-workbench .part.editor,
.monaco-workbench .part.titlebar,
.monaco-workbench .part.statusbar,
.monaco-workbench .titlebar,
.monaco-workbench .statusbar,
.monaco-workbench .editor-group-container,
.monaco-workbench .editor-group-container.empty,
.monaco-workbench .split-view-view,
.monaco-workbench .content,
.monaco-workbench .composite,
.monaco-workbench .pane-body,
.monaco-workbench .part.editor > .content,
.monaco-editor,
.monaco-editor-background,
.monaco-editor .inputarea.ime-input,
.monaco-editor .margin,
.monaco-workbench .minimap,
.monaco-workbench .sticky-widget {
  background-color: transparent !important;
  backdrop-filter: none !important;
}

/* Cursor Glass / Agent 使用独立 React 根，不具备完整 monaco-workbench 结构。 */

/* Standalone Agent 的顶栏是独立结构，视觉强度与侧栏保持一致。 */
/* Glass Agent structural layers must never retain Cursor's opaque light fill. */
/* Cursor's IDE and Agent React class names change between releases. */
[data-cursor-studio-glass-root] {
  background: transparent !important;
  backdrop-filter: none !important;
}

[data-cursor-studio-glass-surface] {
  background: transparent !important;
  backdrop-filter: none !important;
}

/* Prompt controls remain a thin feedback layer rather than a second pane. */
:is([data-component="root"], [data-cursor-studio-ui-root]) :is(
  .agent-panel-followup-input .ui-prompt-input__container,
  .agent-panel-empty-state-prompt .ui-prompt-input__container,
  .composer-human-message.standalone-glass
) {
  background: var(--cursor-studio-control-fill) !important;
  backdrop-filter: ${surfaceBackdrop} !important;
}

/* Context usage is an information tray, not a workspace pane. Its content
 * needs a stable reading surface over the transparent conversation. */
.ui-context-usage-tray[aria-label="Context usage preview"],
.ui-context-usage-tray {
  background: var(--cursor-studio-floating-fill, color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${FLOATING_SURFACE_PERCENT}%, transparent)) !important;
  backdrop-filter: ${surfaceBackdrop} !important;
  border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #c8c8c8) 82%, transparent) !important;
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.16) !important;
}

/* Portalled popups are styled immediately so they do not flash their original fill. */
:is(
  [role="menu"],
  [role="listbox"],
  .monaco-menu-container,
  .monaco-select-box-dropdown-container,
  .suggest-widget
) {
  background: var(--vscode-editorWidget-background, #f4f4f4) !important;
  backdrop-filter: none !important;
  border-radius: min(8px, var(--cursor-studio-window-radius)) !important;
}

[role="tooltip"] {
  backdrop-filter: none !important;
}

[role="dialog"][aria-modal="true"] {
  background: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${controlPercent}%, transparent) !important;
  backdrop-filter: ${surfaceBackdrop} !important;
  border-radius: min(10px, var(--cursor-studio-window-radius)) !important;
}

/* 部分区域用 theme 变量，强制覆盖 */
.monaco-workbench {
  --vscode-editor-background: transparent !important;
  --vscode-sideBar-background: transparent !important;
  --vscode-sideBarSectionHeader-background: transparent !important;
  --vscode-panel-background: transparent !important;
  --vscode-activityBar-background: transparent !important;
  --vscode-titleBar-activeBackground: transparent !important;
  --vscode-titleBar-inactiveBackground: transparent !important;
  --vscode-statusBar-background: transparent !important;
  --vscode-statusBar-noFolderBackground: transparent !important;
  --vscode-statusBar-debuggingBackground: transparent !important;
  --vscode-commandCenter-background: transparent !important;
  --vscode-editorGroupHeader-tabsBackground: transparent !important;
  --vscode-tab-activeBackground: transparent !important;
  --vscode-tab-inactiveBackground: transparent !important;
  --vscode-breadcrumb-background: transparent !important;
  --vscode-terminal-background: transparent !important;
}

html, body {
  background-color: transparent !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 100% !important;
}

/* 程序底色位于 Acrylic 与内容之间；透明度可独立于区块调节。 */
body::after {
  content: ${hasMediaBackground ? '""' : "none"} !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 0 !important;
  pointer-events: none !important;
  background: ${hasMediaBackground ? `color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${windowPercent}%, transparent)` : "none"} !important;
  backdrop-filter: ${windowBackdrop} !important;
}

/* 与 background-cover 相同：媒体在实色 Agent 根层之上，且不拦截交互。 */
body::before {
  content: ${hasMediaBackground ? '""' : "none"} !important;
  position: fixed !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  z-index: 0 !important;
  pointer-events: none !important;
  ${bg}
  background-size: ${size} !important;
  background-repeat: ${repeat} !important;
  background-position: ${position} !important;
  opacity: ${opacity} !important;
  filter: blur(${blur}px) !important;
  mix-blend-mode: ${blend} !important;
}

#cursor-studio-bg-video {
  position: fixed !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  z-index: 0 !important;
  pointer-events: none !important;
}

`;
}

/** 注入到各 renderer bundle：同步 CSS/视频到 IDE、Glass 与辅助窗口。 */
function buildBootstrapJs(
  cssFileName: string,
  cssAbsForVscode: string,
  appearance: AppearanceConfig,
  hasMediaBackground: boolean,
): string {
  const desktopUrl = toVscodeFileUrl(cssAbsForVscode);
  const escapedDesktop = desktopUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const preflightCss = JSON.stringify(
    buildBootstrapPreflightCss(appearance, hasMediaBackground),
  );
  void cssFileName;

  return `
${MARK_START}
/*ext.${EXT}.bootstrap.${BOOTSTRAP_VERSION}*/
(function(){
  try {
    var STYLE_ID = "cursor-studio-bg-style";
    var VIDEO_ID = "cursor-studio-bg-video";
    var RUNTIME_KEY = "__cursorStudioBackgroundRuntime";
    var desktopUrl = "${escapedDesktop}";
    var PRESTYLE = ${preflightCss};
    var previous = window[RUNTIME_KEY];
    if (previous && typeof previous.dispose === "function") previous.dispose();

    var runtime = {
      timers: [],
      observers: [],
      windowListeners: [],
      auxWindows: window.__cursorStudioBackgroundWindows || new Set(),
      originalOpen: null,
      wrappedOpen: null,
      css: "",
      video: null,
      reapplyTimer: null,
      disposed: false,
      dispose: function() {
        runtime.disposed = true;
        if (runtime.reapplyTimer !== null) clearTimeout(runtime.reapplyTimer);
        runtime.timers.forEach(function(id) { clearTimeout(id); clearInterval(id); });
        runtime.observers.forEach(function(observer) {
          try { observer.disconnect(); } catch (e) {}
        });
        runtime.windowListeners.forEach(function(entry) {
          try { entry.target.removeEventListener(entry.type, entry.handler); } catch (e) {}
        });
        if (runtime.originalOpen && window.open === runtime.wrappedOpen) {
          window.open = runtime.originalOpen;
        }
      }
    };
    window.__cursorStudioBackgroundWindows = runtime.auxWindows;
    window[RUNTIME_KEY] = runtime;

    function isWindowAlive(target) {
      try { return !!(target && !target.closed && target.document); }
      catch (e) { return false; }
    }

    function applyStyle(doc, text) {
      if (!doc || !doc.head) return;
      var el = doc.getElementById(STYLE_ID);
      if (!el) {
        el = doc.createElement("style");
        el.id = STYLE_ID;
        doc.head.appendChild(el);
      }
      if (el.textContent !== text) el.textContent = text;
    }

    function applyVideo(doc, config) {
      if (!doc || !doc.body) return;
      var video = doc.getElementById(VIDEO_ID);
      if (!config) {
        if (video) video.remove();
        return;
      }
      if (!video) {
        video = doc.createElement("video");
        video.id = VIDEO_ID;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("aria-hidden", "true");
        doc.body.prepend(video);
      }
      if (video.src !== config.url) video.src = config.url;
      video.style.objectFit = config.objectFit || "cover";
      video.style.objectPosition = config.objectPosition || "center";
      video.style.opacity = String(config.opacity == null ? 1 : config.opacity);
      video.style.filter = "blur(" + (config.blur || 0) + "px)";
      video.style.mixBlendMode = config.blendMode || "normal";
      if (video.paused) video.play().catch(function(error) {
        if (error && error.name !== "AbortError") {
          console.error("[cursor-studio] background video play failed", error);
        }
      });
    }

    function parseVideo(text) {
      var match = text.match(/\\/\\*cursor-studio-video-start\\*\\/([\\s\\S]*?)\\/\\*cursor-studio-video-end\\*\\//);
      if (!match) return null;
      try { return JSON.parse(match[1]); }
      catch (error) {
        console.error("[cursor-studio] background video config invalid", error);
        return null;
      }
    }

    function syncWindowState(targetWindow) {
      if (!isWindowAlive(targetWindow)) return;
      try {
        var doc = targetWindow.document;
        var screenInfo = targetWindow.screen;
        var outerWidth = targetWindow.outerWidth || targetWindow.innerWidth || 0;
        var outerHeight = targetWindow.outerHeight || targetWindow.innerHeight || 0;
        var maximized = !!(screenInfo &&
          outerWidth >= (screenInfo.availWidth || 0) - 2 &&
          outerHeight >= (screenInfo.availHeight || 0) - 2);
        var fullscreen = !!(screenInfo &&
          (targetWindow.innerWidth || 0) >= (screenInfo.width || 0) - 2 &&
          (targetWindow.innerHeight || 0) >= (screenInfo.height || 0) - 2);
        doc.documentElement.toggleAttribute("data-cursor-studio-maximized", maximized);
        doc.documentElement.toggleAttribute("data-cursor-studio-fullscreen", fullscreen);
      } catch (e) {}
    }

    function findStableRoot(doc) {
      if (!doc || !doc.body || !doc.defaultView) return null;
      var known = doc.querySelector('[data-component="root"]') ||
        doc.querySelector("#workbench-container") ||
        doc.querySelector(".monaco-workbench");
      if (known) return known;

      var view = doc.defaultView;
      var width = Math.max(view.innerWidth || 0, doc.documentElement.clientWidth || 0);
      var height = Math.max(view.innerHeight || 0, doc.documentElement.clientHeight || 0);
      var best = null;
      var bestArea = 0;
      var children = doc.body.children;
      for (var i = 0; i < children.length; i++) {
        var element = children[i];
        if (!element || element.id === VIDEO_ID || /^(STYLE|SCRIPT|LINK|META)$/i.test(element.tagName)) continue;
        var rect;
        try { rect = element.getBoundingClientRect(); } catch (e) { continue; }
        if (!rect || rect.width < width * 0.7 || rect.height < height * 0.5) continue;
        var area = rect.width * rect.height;
        if (area > bestArea) {
          best = element;
          bestArea = area;
        }
      }
      return best;
    }

    function markGlassSurfaces(doc) {
      if (!doc || !doc.body) return;
      var rootAttr = "data-cursor-studio-ui-root";
      var workspaceAttr = "data-cursor-studio-workspace";
      var legacyRootAttr = "data-cursor-studio-glass-root";
      var legacySurfaceAttr = "data-cursor-studio-glass-surface";
      var root = findStableRoot(doc);
      var oldMarks = doc.querySelectorAll(
        "[" + rootAttr + "], [" + workspaceAttr + "], [" + legacyRootAttr + "], [" + legacySurfaceAttr + "]",
      );
      for (var i = 0; i < oldMarks.length; i++) {
        oldMarks[i].removeAttribute(rootAttr);
        oldMarks[i].removeAttribute(workspaceAttr);
        oldMarks[i].removeAttribute(legacyRootAttr);
        oldMarks[i].removeAttribute(legacySurfaceAttr);
      }
      if (root) {
        root.setAttribute(rootAttr, "");
        root.setAttribute(workspaceAttr, "");
      }
      doc.documentElement.setAttribute("data-cursor-studio-glass-ready", "");
      doc.documentElement.setAttribute("data-cursor-studio-glass-roots", root ? "1" : "0");
      doc.documentElement.setAttribute("data-cursor-studio-glass-surfaces", "0");
    }

    function applyDocumentTree(targetWindow) {
      if (!isWindowAlive(targetWindow)) return;
      var doc;
      try { doc = targetWindow.document; } catch (e) { return; }
      syncWindowState(targetWindow);
      applyStyle(doc, runtime.css || PRESTYLE);
      applyVideo(doc, runtime.video);
      markGlassSurfaces(doc);
      try {
        var frames = doc.querySelectorAll("iframe");
        for (var i = 0; i < frames.length; i++) {
          try {
            if (frames[i].contentWindow) applyDocumentTree(frames[i].contentWindow);
          } catch (e) {}
        }
      } catch (e) {}
    }

    function applyAll() {
      applyDocumentTree(window);
      runtime.auxWindows.forEach(function(target) {
        if (isWindowAlive(target)) applyDocumentTree(target);
        else runtime.auxWindows.delete(target);
      });
    }

    function queueApply() {
      if (runtime.disposed) return;
      if (runtime.reapplyTimer !== null) clearTimeout(runtime.reapplyTimer);
      runtime.reapplyTimer = setTimeout(function() {
        runtime.reapplyTimer = null;
        if (!runtime.disposed) applyAll();
      }, 220);
    }

    function registerAuxWindow(target) {
      if (!target || target === window || runtime.auxWindows.has(target)) return;
      runtime.auxWindows.add(target);
      var attempts = 0;
      function tick() {
        if (runtime.disposed || !isWindowAlive(target)) {
          runtime.auxWindows.delete(target);
          return;
        }
        applyDocumentTree(target);
        attempts++;
        if (attempts < 40) runtime.timers.push(setTimeout(tick, 500));
      }
      tick();
    }

    try {
      runtime.originalOpen = window.open;
      runtime.wrappedOpen = function() {
        var target = runtime.originalOpen.apply(window, arguments);
        try { registerAuxWindow(target); } catch (e) {}
        return target;
      };
      window.open = runtime.wrappedOpen;
    } catch (error) {
      console.error("[cursor-studio] window hook failed", error);
    }

    function load() {
      var bust = desktopUrl + (desktopUrl.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
      fetch(bust)
        .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
        .then(function(text) {
          if (runtime.css === text) return;
          runtime.css = text;
          runtime.video = parseVideo(text);
          applyAll();
        })
        .catch(function (error) {
          console.error("[cursor-studio] background CSS load failed", error);
        });
    }

    function start() {
      applyStyle(document, PRESTYLE);
      applyAll();
      load();
      runtime.timers.push(setInterval(load, 2000));
      [250, 900, 2200].forEach(function(delay) {
        runtime.timers.push(setTimeout(function() {
          if (!runtime.disposed) applyAll();
        }, delay));
      });
      if (document.body && typeof MutationObserver !== "undefined") {
        var observer = new MutationObserver(function() {
          queueApply();
        });
        observer.observe(document.body, { childList: true });
        runtime.observers.push(observer);
      }
      var windowStateHandler = function() { applyAll(); };
      window.addEventListener("resize", windowStateHandler);
      document.addEventListener("fullscreenchange", windowStateHandler);
      runtime.windowListeners.push({ target: window, type: "resize", handler: windowStateHandler });
      runtime.windowListeners.push({ target: document, type: "fullscreenchange", handler: windowStateHandler });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  } catch (e) {
    console.error("[cursor-studio] bootstrap failed", e);
  }
})();
${MARK_END}
`;
}

function stripMarker(content: string): string {
  const re = new RegExp(
    `/\\*ext-${EXT}-start\\*/[\\s\\S]*?/\\*ext-${EXT}-end\\*/\\s*`,
    "g",
  );
  return content.replace(re, "");
}

function hasMarker(content: string): boolean {
  return content.includes(MARK_START);
}

function hasCurrentBootstrap(content: string): boolean {
  return content.includes(`/*ext.${EXT}.bootstrap.${BOOTSTRAP_VERSION}*/`);
}

function hasBackgroundCoverMarker(content: string): boolean {
  return content.includes(BACKGROUND_COVER_MARK_START);
}

function stripBackgroundCoverMarker(content: string): string {
  return content.replace(
    /\/\*ext-backgroundCover-start\*\/[\s\S]*?\/\*ext-backgroundCover-end\*\/\s*/g,
    "",
  );
}

function stripMaterialMarker(content: string): string {
  return content.replace(
    /\/\*cursor-studio-material-start\*\/[\s\S]*?\/\*cursor-studio-material-end\*\/\s*/g,
    "",
  );
}

function hasMaterialMarker(content: string): boolean {
  return content.includes(MATERIAL_MARK_START);
}

function buildCursorMainMaterialPatch(content: string): string {
  const clean = stripMaterialMarker(content);
  const browserWindowCtor =
    /(this\._win=new [A-Za-z_$][\w$]*\.BrowserWindow)\(ce\),(?=this\._id=this\._win\.id)/;
  if (!browserWindowCtor.test(clean)) {
    throw new Error("Cursor main.js 结构已变化，未找到 BrowserWindow 构造点");
  }
  let next = clean.replace(
    browserWindowCtor,
    `$1(${MATERIAL_MARK_START}process.platform==="win32"?{...ce,transparent:true,backgroundMaterial:"acrylic",backgroundColor:"#00000000",titleBarOverlay:ce.titleBarOverlay&&typeof ce.titleBarOverlay==="object"?{...ce.titleBarOverlay,color:"#00000000"}:ce.titleBarOverlay}:${MATERIAL_MARK_END}ce),${MATERIAL_MARK_START}process.platform==="win32"&&(()=>{const w=this._win,setColor=w.setBackgroundColor.bind(w),setMaterial=w.setBackgroundMaterial.bind(w),setOverlay=typeof w.setTitleBarOverlay==="function"?w.setTitleBarOverlay.bind(w):null;w.setBackgroundColor=function(){setColor("#00000000");setMaterial("acrylic")};w.setBackgroundMaterial=function(){setMaterial("acrylic")};if(setOverlay)w.setTitleBarOverlay=function(options){setOverlay({...options,color:"#00000000"})};w.__cursorStudioAcrylicVersion=2;setMaterial("acrylic");setColor("#00000000")})(),${MATERIAL_MARK_END}`,
  );
  const browserViewBackground = /this\.browserView\.setBackgroundColor\("#00000000"\);/;
  if (browserViewBackground.test(next)) {
    next = next.replace(
      browserViewBackground,
      `${MATERIAL_MARK_START}process.platform==="win32"?(()=>{const v=this.browserView,setColor=v.setBackgroundColor.bind(v);v.setBackgroundColor=function(){setColor("#00000000")};v.__cursorStudioBrowserViewVersion=1;setColor("#00000000")})():this.browserView.setBackgroundColor("#00000000")${MATERIAL_MARK_END};`,
    );
  }
  return next;
}

async function patchCursorMainMaterial(appOut: string): Promise<{
  path?: string;
  patched: boolean;
  changed: boolean;
}> {
  const mainPath = path.join(appOut, "main.js");
  if (!existsSync(mainPath)) return { patched: false, changed: false };
  const current = await fs.readFile(mainPath, "utf8");
  if (
    hasMaterialMarker(current) &&
    current.includes("transparent:true") &&
    current.includes('backgroundMaterial:"acrylic"') &&
    current.includes("__cursorStudioAcrylicVersion=2") &&
    current.includes("__cursorStudioBrowserViewVersion=1")
  ) {
    return { path: mainPath, patched: true, changed: false };
  }
  const next = buildCursorMainMaterialPatch(current);
  const bakPath = `${mainPath}.cursor-studio.bak`;
  // 当前 clean main.js 始终作为本版本备份，避免 Cursor 升级后沿用旧版 bak。
  await writeFileSafe(bakPath, stripMaterialMarker(current));
  await writeFileSafe(mainPath, next);
  return { path: mainPath, patched: true, changed: true };
}

async function clearCursorMainMaterial(mainPath?: string): Promise<boolean> {
  if (!mainPath || !existsSync(mainPath)) return false;
  const current = await fs.readFile(mainPath, "utf8");
  const clean = stripMaterialMarker(current);
  if (clean === current) return false;
  await writeFileSafe(mainPath, clean);
  return true;
}

/** 去掉只读属性（Windows 安装目录偶发） */
async function clearReadonly(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, 0o666);
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("attrib", ["-R", filePath]);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 安全写入：清只读 → 直接写 → 失败则临时文件 + rename 重试。
 * 不自动 UAC 提权（避免弹窗），失败时给明确管理员提示。
 */
async function writeFileSafe(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  if (existsSync(filePath)) await clearReadonly(filePath);

  const tryWrite = async () => {
    await fs.writeFile(filePath, content);
  };

  try {
    await tryWrite();
    return;
  } catch (e1) {
    const msg1 = e1 instanceof Error ? e1.message : String(e1);
    // 原子替换：先写同目录临时文件再 rename
    const tmp = path.join(
      dir,
      `.cursor-studio-tmp-${process.pid}-${Date.now()}${path.extname(filePath)}`,
    );
    try {
      await fs.writeFile(tmp, content);
      await clearReadonly(filePath);
      await fs.rename(tmp, filePath);
      return;
    } catch (e2) {
      try {
        if (existsSync(tmp)) await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      // copyFile 兜底
      try {
        await fs.writeFile(tmp, content);
        await clearReadonly(filePath);
        await fs.copyFile(tmp, filePath);
        await fs.unlink(tmp).catch(() => undefined);
        return;
      } catch (e3) {
        try {
          if (existsSync(tmp)) await fs.unlink(tmp);
        } catch {
          /* ignore */
        }
        const msg3 = e3 instanceof Error ? e3.message : String(e3);
        if (/EPERM|EACCES|denied|readonly|EBUSY|locked/i.test(msg1 + msg3)) {
          throw new Error(
            `无权限写入 ${filePath}。请以管理员运行 Cursor Studio，或先完全退出 Cursor 后重试。原始错误: ${msg3 || msg1}`,
          );
        }
        throw e3 instanceof Error ? e3 : new Error(String(e3));
      }
    }
  }
}

async function ensureBak(jsPath: string, bakPath: string, cleanContent: string): Promise<void> {
  if (!existsSync(bakPath)) {
    await writeFileSafe(bakPath, cleanContent);
    return;
  }
  const existing = await fs.readFile(bakPath, "utf8");
  if (hasMarker(existing) || hasBackgroundCoverMarker(existing)) {
    await writeFileSafe(bakPath, cleanContent);
  }
}

function buildBootstrapPreflightCss(
  appearance: AppearanceConfig,
  hasMediaBackground: boolean,
): string {
  const { blur, controlPercent } = materialTokens(appearance);
  const surfaceBackdrop = hasMediaBackground
    ? `blur(${blur}px) saturate(0.94)`
    : "none";

  return `
html {
  --cursor-studio-window-radius: ${WINDOW_RADIUS_PX}px;
  background: transparent !important;
}
html[data-cursor-studio-maximized],
html[data-cursor-studio-fullscreen] {
  --cursor-studio-window-radius: 0px;
}
html,
body {
  width: 100% !important;
  height: 100% !important;
  overflow: hidden !important;
  border-radius: var(--cursor-studio-window-radius) !important;
  clip-path: inset(0 round var(--cursor-studio-window-radius)) !important;
  background: transparent !important;
}
#workbench-container,
.monaco-workbench,
[data-component="root"],
[data-cursor-studio-ui-root],
[data-cursor-studio-glass-root],
[data-cursor-studio-glass-surface],
[data-cursor-studio-workspace] {
  border-radius: inherit !important;
  background: transparent !important;
}
[data-component="root"],
[data-cursor-studio-ui-root] {
  position: relative !important;
  z-index: 1 !important;
  --cursor-studio-pane-fill: transparent;
  --cursor-studio-control-fill: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${controlPercent}%, transparent);
  --cursor-studio-floating-fill: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${FLOATING_SURFACE_PERCENT}%, transparent);
  --glass-surface-background: var(--cursor-studio-pane-fill);
  --glass-sidebar-surface-background: var(--cursor-studio-pane-fill);
  --glass-chat-surface-background: var(--cursor-studio-pane-fill);
  --glass-editor-surface-background: var(--cursor-studio-pane-fill);
  --glass-onboard-surface-background: var(--cursor-studio-pane-fill);
  --glass-chat-bubble-background: var(--cursor-studio-control-fill);
  --prompt-input-container-bg: var(--cursor-studio-control-fill);
}
.monaco-workbench > :is(.part.sidebar, .part.auxiliarybar, .part.panel, .part.editor),
.agent-panel,
.agent-panel-conversation-shell,
.composer-messages-container,
.virtualized-composer-messages-scroll-container,
.monaco-workbench .monaco-list-rows,
.monaco-workbench .monaco-list-row {
  background: transparent !important;
  backdrop-filter: none !important;
}
.ui-context-usage-tray[aria-label="Context usage preview"],
.ui-context-usage-tray {
  background: var(--cursor-studio-floating-fill, color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${FLOATING_SURFACE_PERCENT}%, transparent)) !important;
  backdrop-filter: ${surfaceBackdrop} !important;
  border: 1px solid color-mix(in srgb, var(--vscode-widget-border, #c8c8c8) 82%, transparent) !important;
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.16) !important;
}
[role="dialog"][aria-modal="true"] {
  background: color-mix(in srgb, var(--vscode-editorWidget-background, #f4f4f4) ${controlPercent}%, transparent) !important;
  backdrop-filter: ${surfaceBackdrop} !important;
}
:is([role="menu"], [role="listbox"], .monaco-menu-container, .monaco-select-box-dropdown-container, .suggest-widget) {
  background: var(--vscode-editorWidget-background, #f4f4f4) !important;
  backdrop-filter: none !important;
}
[role="tooltip"] {
  backdrop-filter: none !important;
}
`;
}

async function removeBackgroundCoverFiles(workbenchDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of [BACKGROUND_COVER_CSS_NAME, BACKGROUND_COVER_JS_NAME]) {
    const filePath = path.join(workbenchDir, name);
    if (!existsSync(filePath)) continue;
    await clearReadonly(filePath);
    await fs.unlink(filePath);
    removed.push(filePath);
  }
  return removed;
}

/** Remove stale background-cover patch code before Studio takes ownership. */
export async function removeBackgroundCoverInjection(
  cursorInstallRoot?: string,
): Promise<{ removedBundles: string[]; removedFiles: string[] }> {
  const resolved = resolveCursorWorkbench(cursorInstallRoot);
  if (!resolved) throw new Error("未找到 Cursor 安装目录");
  const removedBundles: string[] = [];
  for (const { jsPath, bakPath } of listBundles(resolved.workbenchDir, resolved.appOut)) {
    const current = await fs.readFile(jsPath, "utf8");
    const clean = stripBackgroundCoverMarker(current);
    if (clean !== current) {
      await writeFileSafe(jsPath, clean);
      removedBundles.push(jsPath);
    }
    if (existsSync(bakPath)) {
      const backup = await fs.readFile(bakPath, "utf8");
      const cleanBackup = stripMarker(stripBackgroundCoverMarker(backup));
      if (cleanBackup !== backup) await writeFileSafe(bakPath, cleanBackup);
    }
  }
  const removedFiles = await removeBackgroundCoverFiles(resolved.workbenchDir);
  return { removedBundles, removedFiles };
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".mp4",
  ".webm",
  ".mov",
  ".ogg",
]);

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".ogg"]);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogg",
  "video/quicktime": ".mov",
};

function mediaTypeForPath(value: string, contentType = ""): MediaType {
  if (contentType.toLowerCase().startsWith("video/")) return "video";
  let ext = "";
  try {
    ext = path.extname(new URL(value).pathname).toLowerCase();
  } catch {
    ext = path.extname(value).toLowerCase();
  }
  return VIDEO_EXTS.has(ext) ? "video" : "image";
}

function cachedRemoteAsset(assetDir: string, prefix: string): string | null {
  if (!existsSync(assetDir)) return null;
  try {
    const name = readdirSync(assetDir).find((item) => item.startsWith(prefix));
    return name ? path.join(assetDir, name) : null;
  } catch {
    return null;
  }
}

async function removeOtherAssets(assetDir: string, keepPath: string): Promise<void> {
  if (!existsSync(assetDir)) return;
  for (const name of readdirSync(assetDir)) {
    const candidate = path.join(assetDir, name);
    if (path.resolve(candidate) === path.resolve(keepPath)) continue;
    try {
      await fs.unlink(candidate);
    } catch {
      /* ignore stale/locked assets */
    }
  }
}

async function downloadRemoteMedia(
  sourceUrl: string,
  assetDir: string,
): Promise<{ path: string; mediaType: MediaType }> {
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 20);
  const prefix = `remote-${hash}`;
  const cached = cachedRemoteAsset(assetDir, prefix);
  if (cached) {
    return { path: cached, mediaType: mediaTypeForPath(cached) };
  }

  await fs.mkdir(assetDir, { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_MEDIA_TIMEOUT_MS);
  let response: Response;
  try {
    const parsed = new URL(sourceUrl);
    response = await fetch(sourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
        Referer: `${parsed.protocol}//${parsed.host}/`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });
  } catch (error) {
    const fallback = cachedRemoteAsset(assetDir, prefix);
    if (fallback) return { path: fallback, mediaType: mediaTypeForPath(fallback) };
    throw new Error(
      `网络背景下载失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`网络背景下载失败: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error("网络背景超过 64 MB 限制");
  }

  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const urlExt = path.extname(new URL(response.url || sourceUrl).pathname).toLowerCase();
  const recognizedUrlExt = IMAGE_EXTS.has(urlExt) || urlExt === ".svg";
  if (
    contentType &&
    !contentType.startsWith("image/") &&
    !contentType.startsWith("video/") &&
    !recognizedUrlExt
  ) {
    throw new Error(`网络背景响应不是图片或视频: ${contentType}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("网络背景响应为空");
  if (bytes.length > MAX_REMOTE_MEDIA_BYTES) throw new Error("网络背景超过 64 MB 限制");

  const ext =
    CONTENT_TYPE_EXTENSIONS[contentType] ||
    (recognizedUrlExt ? urlExt : "") ||
    ".img";
  const destination = path.join(assetDir, `${prefix}${ext}`);
  await writeFileSafe(destination, bytes);
  await removeOtherAssets(assetDir, destination);
  return {
    path: destination,
    mediaType: mediaTypeForPath(destination, contentType),
  };
}

/** 从随机图库挑一张图（有 imagePath 时不调用） */
export async function pickRandomImage(
  folder: string,
  excludePath?: string,
): Promise<string | null> {
  if (!folder || !existsSync(folder)) return null;
  let names: string[] = [];
  try {
    names = await fs.readdir(folder);
  } catch {
    return null;
  }
  const images = names
    .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
    .map((n) => path.join(folder, n));
  if (images.length === 0) return null;
  const candidates =
    images.length > 1 && excludePath
      ? images.filter((item) => path.resolve(item) !== path.resolve(excludePath))
      : images;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function materializeImageUrl(
  workbenchDir: string,
  imagePath: string,
): Promise<{ url: string; assetAbs?: string; mediaType: MediaType }> {
  const src = imagePath.trim();
  if (!src) return { url: "", mediaType: "image" };

  if (src.startsWith("data:")) {
    return {
      url: src,
      mediaType: src.toLowerCase().startsWith("data:video/") ? "video" : "image",
    };
  }

  const assetDir = path.join(workbenchDir, ASSET_DIR);
  if (/^https?:\/\//i.test(src)) {
    const downloaded = await downloadRemoteMedia(src, assetDir);
    return {
      url: toVscodeFileUrl(downloaded.path),
      assetAbs: downloaded.path,
      mediaType: downloaded.mediaType,
    };
  }

  let localPath = src;
  if (/^file:\/\//i.test(localPath)) {
    try {
      localPath = fileURLToPath(localPath);
    } catch {
      throw new Error(`背景文件 URL 无效: ${src}`);
    }
  }
  if (!existsSync(localPath)) throw new Error(`背景文件不存在: ${localPath}`);

  // 复制到 workbench 目录（CSP self + vscode-file 绝对路径可靠）
  const ext = path.extname(localPath).toLowerCase() || ".jpg";
  const stat = await fs.stat(localPath);
  const localHash = createHash("sha256")
    .update(`${path.resolve(localPath)}|${stat.size}|${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 20);
  if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
  const destName = `local-${localHash}${ext}`;
  const dest = path.join(assetDir, destName);
  copyFileSync(localPath, dest);
  await removeOtherAssets(assetDir, dest);

  const vscodeUrl = toVscodeFileUrl(dest);
  return {
    url: vscodeUrl,
    assetAbs: dest,
    mediaType: mediaTypeForPath(localPath),
  };
}

function stripOldHtmlInject(html: string): string {
  return html.replace(
    new RegExp(
      `${escapeReg(HTML_MARK_START)}[\\s\\S]*?${escapeReg(HTML_MARK_END)}\\s*`,
      "g",
    ),
    "",
  );
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function cleanupLegacyHtml(workbenchHtml?: string): Promise<void> {
  if (!workbenchHtml || !existsSync(workbenchHtml)) return;
  try {
    const raw = await fs.readFile(workbenchHtml, "utf8");
    if (!raw.includes(HTML_MARK_START) && !raw.includes("cursor-studio-bg.css")) return;
    let next = stripOldHtmlInject(raw);
    // 若无干净备份标记，至少剥掉我们的 link
    next = next.replace(
      /<link[^>]*cursor-studio-bg\.css[^>]*>\s*/gi,
      "",
    );
    if (next !== raw) await writeFileSafe(workbenchHtml, next);

    const bak = workbenchHtml + ".cursor-studio.bak";
    if (existsSync(bak)) {
      // 保留 bak，不强制还原（可能含用户其它改动）；已剥标记即可
    }
    const oldCss = path.join(path.dirname(workbenchHtml), OLD_CSS_NAME);
    if (existsSync(oldCss)) {
      try {
        await fs.unlink(oldCss);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 写入 CSS + 修补 workbench JS。
 * realtimeOnly：仅写 CSS（bootstrap 轮询会捡到）。
 */
export async function applyWorkbenchBackground(
  appearance: AppearanceConfig,
  opts?: { realtimeOnly?: boolean; cursorInstallRoot?: string },
): Promise<InjectResult> {
  const resolved = resolveCursorWorkbench(opts?.cursorInstallRoot);
  if (!resolved) {
    throw new Error(
      "未找到 Cursor 安装目录（workbench.desktop.main.js）。请确认已安装 Cursor。",
    );
  }

  // 随机图库：未指定 imagePath 时挑一张
  let effective: AppearanceConfig = { ...appearance };
  if (
    effective.enabled &&
    effective.randomImageFolder?.trim() &&
    (effective.autoStatus || !effective.imagePath?.trim())
  ) {
    const previousSource = (await loadInjectState())?.sourcePath;
    const picked = await pickRandomImage(effective.randomImageFolder, previousSource);
    if (!picked) {
      throw new Error(`随机图库中没有可用图片: ${effective.randomImageFolder}`);
    }
    effective = { ...effective, imagePath: picked };
  }

  const { workbenchDir, appOut, installRoot, workbenchHtml } = resolved;
  const cssPath = path.join(workbenchDir, CSS_NAME);
  const bundles = listBundles(workbenchDir, appOut);
  if (bundles.length === 0) {
    throw new Error("未找到可修补的 workbench JS bundle");
  }
  const bundleSources = await Promise.all(
    bundles.map(async (bundle) => ({
      ...bundle,
      content: await fs.readFile(bundle.jsPath, "utf8"),
    })),
  );
  const backgroundCoverConflict = bundleSources.some((bundle) =>
    hasBackgroundCoverMarker(bundle.content),
  );
  const allStudioPatched = bundleSources.every((bundle) =>
    hasMarker(bundle.content) && hasCurrentBootstrap(bundle.content),
  );
  const shouldPatchJs =
    !opts?.realtimeOnly || backgroundCoverConflict || !allStudioPatched;

  // 清理旧 HTML link 方案，避免双轨
  await cleanupLegacyHtml(workbenchHtml);
  const removedBackgroundCoverFiles = await removeBackgroundCoverFiles(workbenchDir);

  const mediaSource = effective.enabled ? effective.imagePath : "";
  const asset = await materializeImageUrl(workbenchDir, mediaSource);
  const css = buildBackgroundCss(effective, asset.url || null, asset.mediaType);
  await writeFileSafe(cssPath, css);

  // 镜像到 studio home 便于排查
  const mirror = path.join(studioHome(), "inject", CSS_NAME);
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  await fs.writeFile(mirror, css, "utf8");

  const bootstrap = buildBootstrapJs(
    CSS_NAME,
    cssPath,
    effective,
    Boolean(effective.enabled && asset.url),
  ).trim();
  // Parse before touching Cursor's bundles so a generated syntax error cannot white-screen it.
  void new Function(bootstrap);
  const patchedBundles: string[] = [];
  let anyJsPatched = false;

  if (shouldPatchJs) {
    for (const { jsPath, bakPath } of bundles) {
      const current = await fs.readFile(jsPath, "utf8");
      const stripped = stripMarker(stripBackgroundCoverMarker(current));
      await ensureBak(jsPath, bakPath, stripped);

      // 已注入且内容相同则跳过写
      if (hasMarker(current)) {
        const re = new RegExp(
          `/\\*ext-${EXT}-start\\*/[\\s\\S]*?/\\*ext-${EXT}-end\\*/`,
        );
        const m = current.match(re);
        if (m && m[0].trim() === bootstrap.trim()) {
          patchedBundles.push(jsPath);
          continue;
        }
      }

      const next = stripped + "\n" + bootstrap + "\n";
      await writeFileSafe(jsPath, next);
      patchedBundles.push(jsPath);
      anyJsPatched = true;
    }
  } else {
    // 实时只刷 CSS；状态里记录已有 bundle
    const st = await loadInjectState();
    if (st?.patchedBundles) patchedBundles.push(...st.patchedBundles);
    else patchedBundles.push(...bundles.map((b) => b.jsPath));
  }

  const material = await patchCursorMainMaterial(appOut);

  const mainJs = bundles[0].jsPath;
  const state: InjectState = {
    workbenchJs: mainJs,
    cssPath,
    installRoot,
    appOut,
    patchedBundles,
    cursorMainJs: material.path,
    assetPath: asset.assetAbs,
    mediaType: mediaSource.trim() ? asset.mediaType : undefined,
    sourcePath: mediaSource.trim() || undefined,
    remoteCached: mediaSource.trim()
      ? /^https?:\/\//i.test(mediaSource)
      : false,
    appliedAt: new Date().toISOString(),
  };
  await saveInjectState(state);

  return {
    workbenchHtml,
    workbenchJs: mainJs,
    cssPath,
    assetPath: asset.assetAbs,
    mediaType: mediaSource.trim() ? asset.mediaType : undefined,
    sourcePath: mediaSource.trim() || undefined,
    remoteCached: mediaSource.trim()
      ? /^https?:\/\//i.test(mediaSource)
      : false,
    patchedBundles,
    needsReload: anyJsPatched || material.changed,
    message: !shouldPatchJs
      ? "已更新背景 CSS（约 2 秒内自动生效；若无变化请 Ctrl+R）。"
      : anyJsPatched
        ? `已注入 Studio 外观与 Acrylic，并清理 background-cover${backgroundCoverConflict || removedBackgroundCoverFiles.length ? " 残留" : ""}。请完全重启 Cursor。`
        : material.changed
          ? "已启用 Cursor Acrylic 材质。请完全重启 Cursor。"
          : "已更新外观 CSS。若未见效果请 Ctrl+R 或重启 Cursor。",
  };
}

export async function refreshWorkbenchCss(
  appearance: AppearanceConfig,
): Promise<InjectResult> {
  return applyWorkbenchBackground(appearance, { realtimeOnly: true });
}

async function rotateAutoBackground(): Promise<void> {
  if (autoRotationRunning) return;
  autoRotationRunning = true;
  try {
    const cfg = await loadConfig();
    const appearance = cfg.appearance;
    if (
      !appearance.enabled ||
      !appearance.autoStatus ||
      !appearance.randomImageFolder?.trim()
    ) {
      return;
    }
    const state = await loadInjectState();
    if (!state?.patchedBundles?.length) return;
    const picked = await pickRandomImage(
      appearance.randomImageFolder,
      state.sourcePath,
    );
    if (!picked) return;
    await refreshWorkbenchCss({
      ...appearance,
      imagePath: picked,
      // The path is already selected; skip the random-selection branch in apply.
      autoStatus: false,
    });
  } catch (error) {
    console.error(
      "[cursor-studio] automatic background rotation failed",
      error,
    );
  } finally {
    autoRotationRunning = false;
  }
}

/** Keep random backgrounds rotating while Cursor Studio remains in the tray. */
export async function configureBackgroundAutoRotation(options?: {
  rotateNow?: boolean;
}): Promise<void> {
  if (autoRotationTimer) {
    clearInterval(autoRotationTimer);
    autoRotationTimer = null;
  }
  const cfg = await loadConfig();
  const appearance = cfg.appearance;
  if (
    !appearance.enabled ||
    !appearance.autoStatus ||
    !appearance.randomImageFolder?.trim()
  ) {
    return;
  }
  const intervalMs = Math.max(1, Number(appearance.autoInterval) || 10) * 1000;
  autoRotationTimer = setInterval(() => {
    void rotateAutoBackground();
  }, intervalMs);
  autoRotationTimer.unref?.();
  if (options?.rotateNow) await rotateAutoBackground();
}

export async function clearWorkbenchBackground(opts?: {
  cursorInstallRoot?: string;
}): Promise<InjectResult> {
  const state = await loadInjectState();
  const resolved = resolveCursorWorkbench(opts?.cursorInstallRoot || state?.installRoot);
  const workbenchDir = resolved?.workbenchDir;
  const appOut = resolved?.appOut || state?.appOut;

  const bundlePaths = new Set<string>();
  if (state?.patchedBundles) {
    for (const p of state.patchedBundles) bundlePaths.add(p);
  }
  if (workbenchDir && appOut) {
    for (const b of listBundles(workbenchDir, appOut)) bundlePaths.add(b.jsPath);
  }
  // 也尝试 main js 路径
  if (state?.workbenchJs) bundlePaths.add(state.workbenchJs);

  for (const jsPath of bundlePaths) {
    if (!existsSync(jsPath)) continue;
    try {
      const bak = jsPath + ".cursor-studio.bak";
      if (existsSync(bak)) {
        // 优先从 bak 还原（bak 是 strip 后的干净内容）
        const clean = await fs.readFile(bak, "utf8");
        await writeFileSafe(jsPath, clean);
      } else {
        const raw = await fs.readFile(jsPath, "utf8");
        if (hasMarker(raw)) {
          await writeFileSafe(jsPath, stripMarker(raw));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`清除 JS 补丁失败 ${jsPath}: ${msg}`);
    }
  }

  const cursorMainJs =
    state?.cursorMainJs || (appOut ? path.join(appOut, "main.js") : undefined);
  await clearCursorMainMaterial(cursorMainJs);

  // 删 CSS / assets
  if (workbenchDir) {
    const cssPath = path.join(workbenchDir, CSS_NAME);
    if (existsSync(cssPath)) {
      try {
        await fs.unlink(cssPath);
      } catch {
        /* ignore */
      }
    }
    const assetDir = path.join(workbenchDir, ASSET_DIR);
    if (existsSync(assetDir)) {
      try {
        for (const n of readdirSync(assetDir)) {
          await fs.unlink(path.join(assetDir, n));
        }
        await fs.rmdir(assetDir);
      } catch {
        /* ignore */
      }
    }
  }

  await cleanupLegacyHtml(resolved?.workbenchHtml);
  await clearInjectState();

  return {
    workbenchHtml: resolved?.workbenchHtml,
    workbenchJs: state?.workbenchJs,
    cssPath: workbenchDir ? path.join(workbenchDir, CSS_NAME) : "",
    needsReload: true,
    message: "已清除外观注入（renderer、Acrylic 标记与 CSS）。请完全重启 Cursor。",
  };
}

export async function getInjectStatus(): Promise<InjectStatusResult> {
  const resolved = resolveCursorWorkbench();
  let state = await loadInjectState();
  if (!resolved) {
    return {
      installed: false,
      htmlPatched: false,
      jsPatched: false,
      allBundlesPatched: false,
      bundleStatuses: [],
      cssExists: false,
      writeOk: false,
      bakExists: false,
      assetExists: false,
      backgroundCoverConflict: false,
      materialPatched: false,
      materialBakExists: false,
      state,
    };
  }

  const bundles = listBundles(resolved.workbenchDir, resolved.appOut);
  const inspectedBundles = await Promise.all(
    bundles.map(async ({ jsPath, bakPath }) => {
      const content = await fs.readFile(jsPath, "utf8");
      return {
        status: {
          name: bundleDisplayName(jsPath),
          path: jsPath,
          patched: hasMarker(content),
          bakExists: existsSync(bakPath),
        } satisfies BundleInjectStatus,
        backgroundCoverConflict: hasBackgroundCoverMarker(content),
      };
    }),
  );
  const bundleStatuses = inspectedBundles.map((item) => item.status);
  const backgroundCoverConflict = inspectedBundles.some(
    (item) => item.backgroundCoverConflict,
  );
  const patchedBundles = bundleStatuses
    .filter((item) => item.patched)
    .map((item) => item.path);
  const allBundlesPatched =
    bundleStatuses.length > 0 && bundleStatuses.every((item) => item.patched);
  const mainJs = bundles[0]?.jsPath;
  const cursorMainJs = path.join(resolved.appOut, "main.js");
  const cursorMainContent = existsSync(cursorMainJs)
    ? await fs.readFile(cursorMainJs, "utf8")
    : "";
  const materialPatched = hasMaterialMarker(cursorMainContent);
  const materialBakExists = existsSync(`${cursorMainJs}.cursor-studio.bak`);

  let htmlPatched = false;
  if (resolved.workbenchHtml && existsSync(resolved.workbenchHtml)) {
    const raw = await fs.readFile(resolved.workbenchHtml, "utf8");
    htmlPatched = raw.includes(HTML_MARK_START);
  }

  const cssPath = path.join(resolved.workbenchDir, CSS_NAME);
  const assetDir = path.join(resolved.workbenchDir, ASSET_DIR);
  let detectedAssetPath: string | undefined;
  let assetExists = false;
  if (existsSync(assetDir)) {
    try {
      const firstAsset = readdirSync(assetDir)[0];
      assetExists = Boolean(firstAsset);
      detectedAssetPath = firstAsset ? path.join(assetDir, firstAsset) : undefined;
    } catch {
      assetExists = false;
    }
  }

  if (!state && patchedBundles.length > 0) {
    const cssStat = existsSync(cssPath) ? await fs.stat(cssPath) : null;
    state = {
      workbenchJs: mainJs || patchedBundles[0],
      cssPath,
      installRoot: resolved.installRoot,
      appOut: resolved.appOut,
      patchedBundles,
      cursorMainJs: existsSync(cursorMainJs) ? cursorMainJs : undefined,
      assetPath: detectedAssetPath,
      mediaType: detectedAssetPath
        ? mediaTypeForPath(detectedAssetPath)
        : undefined,
      sourcePath: detectedAssetPath,
      remoteCached: false,
      appliedAt: cssStat?.mtime.toISOString() || new Date().toISOString(),
    };
    await saveInjectState(state);
  }

  return {
    installed: true,
    workbenchHtml: resolved.workbenchHtml,
    workbenchJs: mainJs,
    htmlPatched,
    jsPatched: allBundlesPatched,
    allBundlesPatched,
    bundleStatuses,
    cssExists: existsSync(cssPath),
    writeOk: probeWriteAccess(resolved.workbenchDir),
    bakExists:
      bundleStatuses.length > 0 && bundleStatuses.every((item) => item.bakExists),
    assetExists,
    mediaType: state?.mediaType,
    sourcePath: state?.sourcePath,
    remoteCached: state?.remoteCached,
    backgroundCoverConflict,
    materialPatched,
    materialBakExists,
    state,
  };
}

/** 预检：不写盘，返回将要操作的路径 */
export async function dryRunInject(appearance?: AppearanceConfig): Promise<{
  ok: boolean;
  installRoot?: string;
  workbenchDir?: string;
  bundles: string[];
  bundleStatuses: BundleInjectStatus[];
  allBundlesPatched: boolean;
  cssPath?: string;
  writeOk: boolean;
  jsPatched: boolean;
  cssExists: boolean;
  bakExists: boolean;
  imageOk: boolean;
  imagePath?: string;
  message: string;
}> {
  const resolved = resolveCursorWorkbench();
  if (!resolved) {
    return {
      ok: false,
      bundles: [],
      bundleStatuses: [],
      allBundlesPatched: false,
      writeOk: false,
      jsPatched: false,
      cssExists: false,
      bakExists: false,
      imageOk: false,
      message: "未找到 Cursor 安装目录",
    };
  }
  const bundles = listBundles(resolved.workbenchDir, resolved.appOut);
  const bundleStatuses = await Promise.all(
    bundles.map(async ({ jsPath, bakPath }): Promise<BundleInjectStatus> => ({
      name: bundleDisplayName(jsPath),
      path: jsPath,
      patched: hasMarker(await fs.readFile(jsPath, "utf8")),
      bakExists: existsSync(bakPath),
    })),
  );
  const allBundlesPatched =
    bundleStatuses.length > 0 && bundleStatuses.every((item) => item.patched);
  const cssPath = path.join(resolved.workbenchDir, CSS_NAME);
  const bakExists =
    bundleStatuses.length > 0 && bundleStatuses.every((item) => item.bakExists);
  const writeOk = probeWriteAccess(resolved.workbenchDir);

  let imagePath = appearance?.imagePath?.trim() || "";
  if (!imagePath && appearance?.randomImageFolder) {
    imagePath = (await pickRandomImage(appearance.randomImageFolder)) || "";
  }
  const imageOk =
    !appearance?.enabled ||
    !imagePath ||
    Boolean(
      imagePath &&
        (/^https?:\/\//i.test(imagePath) ||
          imagePath.startsWith("data:") ||
          /^file:\/\//i.test(imagePath) ||
          existsSync(imagePath)),
    );

  const ok = writeOk && imageOk && bundles.length > 0;
  return {
    ok,
    installRoot: resolved.installRoot,
    workbenchDir: resolved.workbenchDir,
    bundles: bundles.map((b) => b.jsPath),
    bundleStatuses,
    allBundlesPatched,
    cssPath,
    writeOk,
    jsPatched: allBundlesPatched,
    cssExists: existsSync(cssPath),
    bakExists,
    imageOk,
    imagePath: imagePath || undefined,
    message: ok
      ? `可注入：${bundles.length} 个 bundle · 写权限 OK`
      : !writeOk
        ? "安装目录无写权限，请管理员运行或退出 Cursor"
        : !imageOk
          ? "背景媒体路径无效"
          : "无法注入",
  };
}

/**
 * 强制从 *.cursor-studio.bak 还原 workbench JS（即使 strip 失败）。
 * 比 clear 更激进：只认 bak 文件内容。
 */
export async function forceRestoreWorkbench(): Promise<InjectResult> {
  const state = await loadInjectState();
  const resolved = resolveCursorWorkbench(state?.installRoot);
  if (!resolved) throw new Error("未找到 Cursor 安装目录");

  const bundles = listBundles(resolved.workbenchDir, resolved.appOut);
  const restored: string[] = [];
  const missing: string[] = [];

  for (const { jsPath, bakPath } of bundles) {
    if (!existsSync(bakPath)) {
      missing.push(jsPath);
      // 尝试 strip
      if (existsSync(jsPath)) {
        const raw = await fs.readFile(jsPath, "utf8");
        if (hasMarker(raw)) {
          await writeFileSafe(jsPath, stripMarker(raw));
          restored.push(jsPath + " (strip)");
        }
      }
      continue;
    }
    const clean = await fs.readFile(bakPath, "utf8");
    await writeFileSafe(jsPath, clean);
    restored.push(jsPath);
  }

  const cursorMainJs =
    state?.cursorMainJs || path.join(resolved.appOut, "main.js");
  if (existsSync(cursorMainJs)) {
    const mainBak = `${cursorMainJs}.cursor-studio.bak`;
    if (existsSync(mainBak)) {
      await writeFileSafe(cursorMainJs, await fs.readFile(mainBak, "utf8"));
      restored.push(cursorMainJs);
    } else {
      const raw = await fs.readFile(cursorMainJs, "utf8");
      if (hasMaterialMarker(raw)) {
        await writeFileSafe(cursorMainJs, stripMaterialMarker(raw));
        restored.push(`${cursorMainJs} (strip)`);
      }
    }
  }

  // 删 CSS / assets（同 clear）
  const cssPath = path.join(resolved.workbenchDir, CSS_NAME);
  if (existsSync(cssPath)) {
    try {
      await fs.unlink(cssPath);
    } catch {
      /* ignore */
    }
  }
  const assetDir = path.join(resolved.workbenchDir, ASSET_DIR);
  if (existsSync(assetDir)) {
    try {
      for (const n of readdirSync(assetDir)) {
        await fs.unlink(path.join(assetDir, n));
      }
      await fs.rmdir(assetDir);
    } catch {
      /* ignore */
    }
  }

  await cleanupLegacyHtml(resolved.workbenchHtml);
  await clearInjectState();

  return {
    workbenchHtml: resolved.workbenchHtml,
    workbenchJs: bundles[0]?.jsPath,
    cssPath,
    patchedBundles: restored,
    needsReload: true,
    message:
      restored.length > 0
        ? `已从备份还原 ${restored.length} 个文件。${missing.length ? `无 bak: ${missing.length}` : ""} 请重启 Cursor。`
        : "未找到可还原的 .cursor-studio.bak",
  };
}

// 供测试/调试：同步写小文件探测权限
export function probeWriteAccess(dir: string): boolean {
  try {
    const p = path.join(dir, `.cursor-studio-write-probe-${process.pid}`);
    writeFileSync(p, "ok");
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}
