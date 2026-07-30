/**
 * 系统托盘：
 * - 关闭窗口 = 隐藏到托盘
 * - 单击托盘 = 显示/隐藏切换
 * - 右键：启动中/未启动、启停服务、今日用量、退出
 */
import {
  Tray,
  Menu,
  nativeImage,
  app,
  type BrowserWindow,
  type NativeImage,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getServiceState, startService, stopService } from "../server/proxy/service";
import {
  formatTokenCount,
  getTodayTokenUsage,
} from "../server/metrics/usage-store";
import { getNativeStrings } from "../server/runtime/native-locale";

let tray: Tray | null = null;
let isQuitting = false;
let menuRefreshing = false;
let getWinRef: (() => BrowserWindow | null) | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function candidateIconPaths(): string[] {
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    // Packaged by extraResources for the tray and native windows.
    resourcesPath ? path.join(resourcesPath, "resources", "icon-runtime.png") : "",
    resourcesPath ? path.join(resourcesPath, "resources", "icon-round.png") : "",
    resourcesPath ? path.join(resourcesPath, "resources", "icon.png") : "",
    resourcesPath ? path.join(resourcesPath, "resources", "icon.ico") : "",
    resourcesPath ? path.join(resourcesPath, "icon-round.png") : "",
    resourcesPath ? path.join(resourcesPath, "icon.png") : "",
    path.join(process.cwd(), "resources", "icon-round.png"),
    path.join(process.cwd(), "resources", "icon-runtime.png"),
    path.join(process.cwd(), "resources", "icon.png"),
    path.join(process.cwd(), "resources", "icon.ico"),
    path.join(__dirname, "../resources/icon-round.png"),
    path.join(__dirname, "../resources/icon-runtime.png"),
    path.join(__dirname, "../resources/icon.png"),
    path.join(__dirname, "../../resources/icon-round.png"),
    path.join(__dirname, "../../resources/icon.png"),
    path.join(app.getAppPath(), "resources", "icon-round.png"),
    path.join(app.getAppPath(), "resources", "icon.png"),
    path.join(app.getPath("userData"), "icon.png"),
  ].filter(Boolean);
}

export function resolveAppIconPath(): string | null {
  for (const p of candidateIconPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadAppIcon(): NativeImage {
  const p = resolveAppIconPath();
  if (p) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGD4z0ABYBzVMKoBBgP+/v37H8YcNWoA3GD8//8/hI0LRjcA3YBhbwAAn1QJ/6aV7mQAAAAASUVORK5CYII=",
  );
}

export function loadTrayIcon(): NativeImage {
  const img = loadAppIcon();
  if (img.isEmpty()) return img;
  // Windows 托盘 16/32；稍大更清晰
  const size = process.platform === "win32" ? 32 : 22;
  return img.resize({ width: size, height: size, quality: "best" });
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function setIsQuitting(v: boolean) {
  isQuitting = v;
}

export function showMainWindow(win: BrowserWindow | null) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function hideToTray(win: BrowserWindow | null) {
  if (!win) return;
  win.hide();
}

/** 可见则隐藏，隐藏/最小化则显示 */
export function toggleMainWindow(win: BrowserWindow | null) {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    hideToTray(win);
  } else {
    showMainWindow(win);
  }
}

async function buildContextMenu(
  getWin: () => BrowserWindow | null,
): Promise<Menu> {
  const strings = await getNativeStrings(app.getLocale());
  let running = false;
  let todayTokens = 0;
  try {
    const st = await getServiceState();
    running = Boolean(st.running);
  } catch {
    running = false;
  }
  try {
    const today = await getTodayTokenUsage();
    todayTokens = today.tokens;
  } catch {
    todayTokens = 0;
  }

  const statusLabel = running ? strings.tray.running : strings.tray.notRunning;
  const usageLabel = strings.tray.todayUsage(formatTokenCount(todayTokens));

  const template: MenuItemConstructorOptions[] = [
    {
      label: statusLabel,
      enabled: false,
    },
    { type: "separator" },
    {
      label: strings.tray.startService,
      enabled: !running,
      click: () => {
        void (async () => {
          try {
            await startService();
          } catch (e) {
            console.error("[tray] startService", e);
          }
          await refreshTrayMenu(getWin);
        })();
      },
    },
    {
      label: strings.tray.stopService,
      enabled: running,
      click: () => {
        void (async () => {
          try {
            await stopService({ clearCursor: true });
          } catch (e) {
            console.error("[tray] stopService", e);
          }
          await refreshTrayMenu(getWin);
        })();
      },
    },
    {
      label: usageLabel,
      enabled: false,
    },
    { type: "separator" },
    {
      label: strings.tray.showWindow,
      click: () => showMainWindow(getWin()),
    },
    {
      label: strings.tray.hideWindow,
      click: () => hideToTray(getWin()),
    },
    { type: "separator" },
    {
      label: strings.tray.quit,
      click: () => {
        isQuitting = true;
        // Close the hidden BrowserWindow before starting cleanup. This avoids a
        // tray-triggered quit leaving an invisible application window behind.
        const win = getWin();
        if (win && !win.isDestroyed()) win.close();
        app.quit();
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** Builds and shows the current tray menu. */
export async function showTrayContextMenu(): Promise<boolean> {
  const getWin = getWinRef;
  if (!getWin) return false;

  const menu = await buildContextMenu(getWin);
  if (tray) {
    tray.popUpContextMenu(menu);
  } else {
    return false;
  }

  void refreshTrayMenu(getWin);
  return true;
}

export async function refreshTrayMenu(getWin?: () => BrowserWindow | null) {
  const gw = getWin || getWinRef;
  if (!tray || !gw || menuRefreshing) return;
  menuRefreshing = true;
  try {
    // 不 setContextMenu 常驻，避免与 right-click 双弹；仅更新 tooltip
    const [strings, st, today] = await Promise.all([
      getNativeStrings(app.getLocale()),
      getServiceState().catch(() => ({ running: false as boolean })),
      getTodayTokenUsage().catch(() => ({ tokens: 0 })),
    ]);
    const running = Boolean(st.running);
    const status = running ? strings.tray.running : strings.tray.notRunning;
    tray.setToolTip(strings.tray.tooltip(status, formatTokenCount(today.tokens)));
  } finally {
    menuRefreshing = false;
  }
}

export function createTray(getWin: () => BrowserWindow | null): Tray {
  if (tray) return tray;
  getWinRef = getWin;
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("Cursor Studio");

  // 右键：每次重建菜单（状态/用量最新），再弹出
  tray.on("right-click", () => {
    void showTrayContextMenu().catch((e) => {
      console.error("[tray] menu", e);
    });
  });

  // 左键单击：显示 ↔ 隐藏
  tray.on("click", () => {
    toggleMainWindow(getWin());
  });

  tray.on("double-click", () => {
    showMainWindow(getWin());
  });

  void refreshTrayMenu(getWin);
  trayRefreshTimer = setInterval(() => {
    void refreshTrayMenu(getWin);
  }, 15_000);

  return tray;
}

export function destroyTray() {
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = null;
  }
  try {
    tray?.destroy();
  } catch {
    /* ignore */
  }
  tray = null;
  getWinRef = null;
}
