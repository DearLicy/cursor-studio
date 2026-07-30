import { app, BrowserWindow, ipcMain, shell, dialog, Menu, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  saveConfig,
  newProvider,
  type AppConfig,
  type ModelProvider,
  type AppearanceConfig,
} from "../server/config/store";
import {
  clearConfigBackups,
  createConfigBackup,
  importConfig,
  listConfigBackups,
  removeConfigBackup,
  restoreConfigBackup,
} from "../server/config/backups";
import {
  startService,
  stopService,
  getServiceState,
  injectProxyToCursor,
  detachProxyFromCursor,
  getProxyCaInfo,
  installProxyCa,
} from "../server/proxy/service";
import { syncCursorUserInfoIfChanged } from "../server/cursor/state-db";
import {
  clearProxySettings,
  getCursorStatus,
  resolveCursorSettingsPath,
  clearLegacyBackgroundCoverKeys,
} from "../server/cursor/settings";
import {
  applyWorkbenchBackground,
  clearWorkbenchBackground,
  refreshWorkbenchCss,
  getInjectStatus,
  dryRunInject,
  forceRestoreWorkbench,
  configureBackgroundAutoRotation,
  pickRandomImage,
} from "../server/cursor/workbench-inject";
import { fetchProviderModels } from "../server/providers/fetch-models";
import { fetchAndSaveProviderModels } from "../server/providers/save-models";
import {
  listProviderHealth,
  probeProvider as probeModelProvider,
  resetProviderHealth,
} from "../server/providers/provider-health";
import { startControlPlane } from "../server/control-plane/index";
import {
  getPromotions,
  refreshPromotions,
  startPromotionsRefresh,
} from "../server/runtime/promotions";
import {
  startProviderMonitor,
  stopProviderMonitor,
} from "../server/runtime/provider-monitor";
import {
  getHomeMetricsSummary,
  setIncludeCacheWriteInHitRate,
  resetUsage,
  listRequestLogs,
  queryUsage,
  exportUsageCsv,
  refreshUsagePricing,
  type UsageQuery,
} from "../server/metrics/usage-store";
import {
  listMcpServers,
  upsertMcpServer,
  upsertMcpFromJson,
  removeMcpServer,
  probeMcp,
  type McpServerSpec,
} from "../server/workspace/mcp-store";
import {
  listSkills,
  createSkill,
  removeSkill,
  readSkillContent,
  resolveKnownSkillPath,
  updateSkillContent,
} from "../server/workspace/skills-store";
import {
  listSkillRepos,
  addSkillRepo,
  removeSkillRepo,
  discoverSkills,
  installSkillFromRepo,
  type DiscoverableSkill,
} from "../server/workspace/skills-repo";
import {
  clearEmptySessions,
  listSessions,
  readSessionDetail,
  removeSessions,
} from "../server/workspace/sessions-store";
import {
  listPrompts,
  setPromptEnabled,
  setInjectionMode,
  setMasterEnabled,
  upsertPrompt,
  removePrompt,
  openPromptsDir,
  syncCursorInjection,
  type PromptInjectionMode,
} from "../server/workspace/prompts-store";
import {
  probeConfiguredBalances,
  probeConfiguredProviderBalances,
  probeProviderBalance,
  listBalanceAccounts,
  upsertBalanceAccount,
  removeBalanceAccount,
  newBalanceAccount,
  type BalanceAccount,
} from "../server/providers/balance";
import { cursorMcpPath } from "../server/workspace/mcp-store";
import {
  createTray,
  destroyTray,
  getIsQuitting,
  setIsQuitting,
  hideToTray,
  showMainWindow,
  loadAppIcon,
  resolveAppIconPath,
  refreshTrayMenu,
} from "./tray";
import {
  checkForUpdates,
  getLastUpdateCheck,
  installAvailableUpdate,
  UPDATE_CHECK_INTERVAL_MS,
} from "./updater";
import { getNativeStrings } from "../server/runtime/native-locale";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST = path.join(__dirname, "../dist");

let win: BrowserWindow | null = null;
let controlStarted = false;
let quitCleanupStarted = false;
let quitCleanupFinished = false;
let updateCheckTimer: NodeJS.Timeout | undefined;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function stripMenus() {
  try {
    Menu.setApplicationMenu(null);
  } catch {
    /* ignore */
  }
}

function ensureControlPlane() {
  if (controlStarted) return;
  try {
    startControlPlane();
    controlStarted = true;
  } catch (e) {
    console.error("[studio] control plane failed", e);
  }
}

function clampWindowDimension(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function getInitialWindowGeometry() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const maxWidth = Math.max(480, area.width - 32);
  const maxHeight = Math.max(420, area.height - 32);
  const minWidth = Math.min(
    maxWidth,
    Math.min(940, Math.max(760, Math.round(area.width * 0.58))),
  );
  const minHeight = Math.min(
    maxHeight,
    Math.min(580, Math.max(500, Math.round(area.height * 0.56))),
  );
  const width = clampWindowDimension(
    Math.round(area.width * 0.7),
    minWidth,
    Math.min(1220, maxWidth),
  );
  const height = clampWindowDimension(
    Math.round(area.height * 0.7),
    minHeight,
    Math.min(760, maxHeight),
  );

  return {
    width,
    height,
    minWidth,
    minHeight,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

function createWindow() {
  stripMenus();

  // vite-plugin-electron simple 输出 dist-electron/preload.cjs
  const preloadPath = path.join(__dirname, "preload.cjs");
  console.log("[studio] preload =", preloadPath);
  console.log("[studio] VITE_DEV_SERVER_URL =", VITE_DEV_SERVER_URL);

  const iconPath = resolveAppIconPath();
  const appIcon = loadAppIcon();
  const geometry = getInitialWindowGeometry();

  win = new BrowserWindow({
    ...geometry,
    // The initial size follows the active display, then remains fixed so the
    // rounded frameless chrome never exposes edge-resize affordances.
    resizable: false,
    // The product name is rendered by our custom titlebar; keep native chrome blank.
    title: " ",
    // Transparent + CSS radius: disable OS rectangular shadow (looks like right-angle halo).
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    // Acrylic/material forces a hard rectangular window edge on Windows.
    backgroundMaterial: undefined,
    vibrancy: process.platform === "darwin" ? "under-window" : undefined,
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    maximizable: false,
    roundedCorners: true,
    thickFrame: false,
    icon: iconPath || appIcon,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  if (!appIcon.isEmpty()) {
    win.setIcon(appIcon);
  }

  if (process.platform === "win32") {
    // Keep fully transparent so CSS can own rounded corners + soft shadow.
    win.setBackgroundColor("#00000000");
    try {
      // Electron may no-op; safe to attempt.
      (win as unknown as { setHasShadow?: (v: boolean) => void }).setHasShadow?.(false);
    } catch {
      /* ignore */
    }
  }

  win.setMenu(null);
  win.setMenuBarVisibility(false);

  win.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer:${level}]`, message);
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[studio] did-fail-load", code, desc, url);
  });

  win.once("ready-to-show", () => {
    win?.show();
    win?.focus();
  });

  // 点关闭 = 托盘后台运行，不退出
  win.on("close", (e) => {
    if (!getIsQuitting()) {
      e.preventDefault();
      hideToTray(win);
    }
  });

  if (VITE_DEV_SERVER_URL && process.env.STUDIO_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  if (VITE_DEV_SERVER_URL) {
    const url = VITE_DEV_SERVER_URL.replace("localhost", "127.0.0.1");
    void win.loadURL(url).catch((err) => {
      console.error("[studio] loadURL failed", err);
    });
  } else {
    void win.loadFile(path.join(process.env.DIST!, "index.html"));
  }
}

async function collectReleaseStatus(options?: { refreshPromotions?: boolean }) {
  const update = await checkForUpdates();
  const promotions = options?.refreshPromotions
    ? await refreshPromotions()
    : await getPromotions();
  return { ...update, promotions: promotions.promotions };
}

type BroadcastUpdateStatus = Awaited<ReturnType<typeof checkForUpdates>> & {
  promotions?: Awaited<ReturnType<typeof getPromotions>>["promotions"];
};

function broadcastUpdateStatus(status: BroadcastUpdateStatus) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("updates:status", status);
  }
}

function startNativeReleaseChecks() {
  if (updateCheckTimer) return;
  const run = async () => {
    const status = await collectReleaseStatus({ refreshPromotions: true });
    broadcastUpdateStatus(status);
  };
  void run();
  updateCheckTimer = setInterval(() => void run(), UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
}

function registerIpc() {
  ipcMain.on("window:minimize", () => {
    win?.minimize();
  });
  ipcMain.on("window:maximize", () => {
    /* 禁用最大化 */
  });
  ipcMain.on("window:close", () => {
    // 关闭 → 托盘
    hideToTray(win);
  });
  ipcMain.handle("window:isMaximized", () => false);
  ipcMain.on("window:show", () => showMainWindow(win));
  ipcMain.on("window:quit", () => {
    setIsQuitting(true);
    app.quit();
  });
  ipcMain.handle("shell:openExternal", async (_event, rawUrl: unknown) => {
    const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
    const target = new URL(value);
    if (target.protocol !== "https:") {
      throw new Error("只支持 HTTPS 链接");
    }
    await shell.openExternal(target.toString());
    return true;
  });

  ipcMain.handle("config:get", async () => loadConfig());
  ipcMain.handle("config:save", async (_e, cfg: AppConfig) => {
    const previous = await loadConfig();
    await createConfigBackup("before-save");
    const saved = await saveConfig(cfg);
    const sync = await syncCursorUserInfoIfChanged(
      previous.cursorIntegration,
      saved.cursorIntegration,
      previous.backendListenAddr,
      saved.backendListenAddr,
    );
    if (sync.error) {
      console.warn("[electron] Cursor account cache sync deferred:", sync.error);
    }
    await configureBackgroundAutoRotation();
    await refreshTrayMenu(() => win);
    return saved;
  });
  ipcMain.handle("config:import", async (_e, cfg: unknown) => {
    const previous = await loadConfig();
    const saved = await importConfig(cfg);
    const sync = await syncCursorUserInfoIfChanged(
      previous.cursorIntegration,
      saved.cursorIntegration,
      previous.backendListenAddr,
      saved.backendListenAddr,
    );
    if (sync.error) {
      console.warn("[electron] Cursor account cache sync deferred:", sync.error);
    }
    await configureBackgroundAutoRotation();
    await refreshTrayMenu(() => win);
    return saved;
  });
  ipcMain.handle("config:backup", async () => ({
    backup: await createConfigBackup("manual"),
  }));
  ipcMain.handle("config:backups", async () => ({
    backups: await listConfigBackups(),
  }));
  ipcMain.handle("config:removeBackup", async (_e, name: string) =>
    removeConfigBackup(name),
  );
  ipcMain.handle("config:clearBackups", async () => clearConfigBackups());
  ipcMain.handle("config:restore", async (_e, name: string) => {
    const previous = await loadConfig();
    const saved = await restoreConfigBackup(name);
    const sync = await syncCursorUserInfoIfChanged(
      previous.cursorIntegration,
      saved.cursorIntegration,
      previous.backendListenAddr,
      saved.backendListenAddr,
    );
    if (sync.error) {
      console.warn("[electron] Cursor account cache sync deferred:", sync.error);
    }
    await configureBackgroundAutoRotation();
    await refreshTrayMenu(() => win);
    return saved;
  });

  ipcMain.handle("providers:list", async () => (await loadConfig()).providers);
  ipcMain.handle("providers:upsert", async (_e, provider: ModelProvider) => {
    const cfg = await loadConfig();
    const next = { ...provider, id: provider.id || newProvider(provider).id };
    const idx = cfg.providers.findIndex((p) => p.id === next.id);
    if (idx >= 0) cfg.providers[idx] = next;
    else cfg.providers.push(next);
    await saveConfig(cfg);
    return cfg.providers;
  });
  ipcMain.handle("providers:remove", async (_e, id: string) => {
    const cfg = await loadConfig();
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    resetProviderHealth(id);
    await saveConfig(cfg);
    return cfg.providers;
  });
  ipcMain.handle("providers:newTemplate", async () => newProvider());
  ipcMain.handle("providers:probe", async (_e, provider: ModelProvider) =>
    probeModelProvider(provider),
  );
  ipcMain.handle("providers:probeBalance", async (_e, provider: ModelProvider) => ({
    balance: await probeProviderBalance(provider),
  }));
  ipcMain.handle("providers:listBalances", async (_e, providerId?: string) => ({
    balances: await probeConfiguredProviderBalances(
      typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined,
    ),
  }));
  ipcMain.handle("providers:health", async () => ({
    health: listProviderHealth((await loadConfig()).providers),
  }));
  ipcMain.handle(
    "providers:fetchModels",
    async (
      _e,
      input: { type: "openai" | "anthropic"; baseURL: string; apiKey: string },
    ) => fetchProviderModels(input),
  );
  ipcMain.handle(
    "providers:fetchModelsAndSave",
    async (
      _e,
      input: {
        id?: string;
        displayName?: string;
        type: "openai" | "anthropic";
        baseURL: string;
        apiKey: string;
        enabled?: boolean;
        modelID?: string;
        openAIEndpoint?: ModelProvider["openAIEndpoint"];
        costMultiplier?: number;
        reasoningEffort?: string;
        balance?: ModelProvider["balance"];
      },
    ) => fetchAndSaveProviderModels(input),
  );

  ipcMain.handle("service:start", async () => startService());
  ipcMain.handle("service:stop", async () => stopService({ clearCursor: true }));
  ipcMain.handle("service:state", async () => getServiceState(await loadConfig()));
  ipcMain.handle("service:injectCursor", async () => injectProxyToCursor());
  ipcMain.handle("service:detachCursor", async () => detachProxyFromCursor());
  ipcMain.handle("cursor:clearProxy", async () => {
    const cfg = await loadConfig();
    return clearProxySettings({ onlyIfProxyContains: cfg.proxyListenAddr });
  });
  ipcMain.handle("proxy:ca", async () => getProxyCaInfo());
  ipcMain.handle("proxy:installCa", async () => installProxyCa());
  ipcMain.handle("proxy:openCa", async () => {
    const info = await getProxyCaInfo();
    await shell.showItemInFolder(info.certPath);
    return { path: info.certPath };
  });

  ipcMain.handle("metrics:home", async () => getHomeMetricsSummary());
  ipcMain.handle("promotions:get", async (_e, options?: { refresh?: boolean }) =>
    getPromotions({ refresh: options?.refresh === true }),
  );
  ipcMain.handle("updates:check", async () => {
    const status = await checkForUpdates();
    broadcastUpdateStatus(status);
    void refreshPromotions()
      .then((promotions) => {
        broadcastUpdateStatus({ ...getLastUpdateCheck(), promotions: promotions.promotions });
      })
      .catch(() => undefined);
    return status;
  });
  ipcMain.handle("updates:status", async () => {
    const [update, promotions] = await Promise.all([getLastUpdateCheck(), getPromotions()]);
    return { ...update, promotions: promotions.promotions };
  });
  ipcMain.handle("updates:install", async () =>
    installAvailableUpdate((progress) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("updates:progress", progress);
      }
    }),
  );
  ipcMain.handle("metrics:includeCacheWrite", async (_e, value: boolean) =>
    setIncludeCacheWriteInHitRate(Boolean(value)),
  );
  ipcMain.handle("metrics:pricingRefresh", async () => refreshUsagePricing());
  ipcMain.handle("metrics:reset", async () => resetUsage());
  ipcMain.handle("metrics:logs", async () => listRequestLogs(200));
  ipcMain.handle("metrics:query", async (_e, query?: UsageQuery) =>
    queryUsage(query),
  );
  ipcMain.handle("metrics:exportCsv", async (_e, query?: UsageQuery) =>
    exportUsageCsv(query),
  );
  ipcMain.handle("providers:balances", async () => ({
    balances: await probeConfiguredBalances(),
  }));
  ipcMain.handle("balance:accounts", async () => ({
    accounts: await listBalanceAccounts(),
  }));
  ipcMain.handle("balance:upsert", async (_e, account: BalanceAccount) => ({
    accounts: await upsertBalanceAccount(account),
  }));
  ipcMain.handle("balance:remove", async (_e, id: string) => ({
    accounts: await removeBalanceAccount(id),
  }));
  ipcMain.handle("balance:newTemplate", async (_e, partial?: Partial<BalanceAccount>) =>
    newBalanceAccount(partial),
  );
  ipcMain.handle("balance:probe", async () => ({
    balances: await probeConfiguredBalances(),
  }));

  ipcMain.handle("mcp:list", async (_e, opts?: { probe?: boolean }) =>
    listMcpServers({ probe: Boolean(opts?.probe) }),
  );
  ipcMain.handle(
    "mcp:upsert",
    async (_e, body: { id: string; spec: McpServerSpec; requireProbe?: boolean }) =>
      upsertMcpServer(body.id, body.spec || {}, {
        requireProbe: body.requireProbe !== false,
      }),
  );
  ipcMain.handle(
    "mcp:upsertJson",
    async (_e, body: { json: string; id?: string; requireProbe?: boolean }) =>
      upsertMcpFromJson(body.json, {
        id: body.id,
        requireProbe: body.requireProbe !== false,
      }),
  );
  ipcMain.handle(
    "mcp:probe",
    async (_e, body: { id?: string; spec: McpServerSpec }) =>
      probeMcp(body.id, body.spec || {}),
  );
  ipcMain.handle("mcp:remove", async (_e, id: string) => removeMcpServer(id));
  ipcMain.handle("mcp:open", async () => {
    const p = cursorMcpPath();
    await shell.showItemInFolder(p);
    return { path: p };
  });
  ipcMain.handle("skills:list", async () => listSkills());
  ipcMain.handle(
    "skills:create",
    async (_e, body: { name: string; description?: string }) => {
      const item = await createSkill(body);
      return { item, ...(await listSkills()) };
    },
  );
  ipcMain.handle(
    "skills:update",
    async (_e, body: { path: string; content: string }) => {
      const item = await updateSkillContent(body.path, body.content);
      return { item, ...(await listSkills()) };
    },
  );
  ipcMain.handle("skills:remove", async (_e, skillPath: string) => {
    await removeSkill(skillPath);
    return listSkills();
  });
  ipcMain.handle(
    "skills:read",
    async (_e, body: { path: string; maxChars?: number }) =>
      readSkillContent(body.path, body.maxChars),
  );
  ipcMain.handle("skills:open", async (_e, skillPath: string) => {
    const knownSkillPath = await resolveKnownSkillPath(skillPath);
    await shell.showItemInFolder(knownSkillPath);
    return { path: knownSkillPath };
  });
  ipcMain.handle("skills:repos", async () => listSkillRepos());
  ipcMain.handle(
    "skills:addRepo",
    async (_e, body: { owner: string; name?: string; branch?: string; enabled?: boolean }) =>
      addSkillRepo(body),
  );
  ipcMain.handle(
    "skills:removeRepo",
    async (_e, body: { owner: string; name: string }) =>
      removeSkillRepo(body.owner, body.name),
  );
  ipcMain.handle("skills:discover", async () => discoverSkills());
  ipcMain.handle("skills:install", async (_e, skill: DiscoverableSkill) =>
    installSkillFromRepo(skill),
  );
  ipcMain.handle(
    "sessions:list",
    async (
      _e,
      query?: {
        limit?: number;
        offset?: number;
        view?: "recent" | "project";
        q?: string;
        project?: string;
        refresh?: boolean;
      },
    ) =>
      listSessions(query),
  );
  ipcMain.handle(
    "sessions:read",
    async (_e, body: { id: string }) => readSessionDetail(body.id),
  );
  ipcMain.handle("sessions:remove", async (_e, body: { ids: string[] }) =>
    removeSessions(body.ids || []),
  );
  ipcMain.handle("sessions:clearEmpty", async () => clearEmptySessions());

  ipcMain.handle("prompts:list", async () => listPrompts());
  ipcMain.handle(
    "prompts:setEnabled",
    async (_e, body: { id: string; enabled: boolean }) =>
      setPromptEnabled(body.id, Boolean(body.enabled)),
  );
  ipcMain.handle(
    "prompts:setMode",
    async (_e, body: { mode: PromptInjectionMode }) => setInjectionMode(body.mode),
  );
  ipcMain.handle("prompts:setMaster", async (_e, body: { enabled: boolean }) =>
    setMasterEnabled(Boolean(body.enabled)),
  );
  ipcMain.handle(
    "prompts:upsert",
    async (
      _e,
      body: {
        id?: string;
        title: string;
        filename?: string;
        description?: string;
        content: string;
        enabled?: boolean;
      },
    ) => upsertPrompt(body),
  );
  ipcMain.handle("prompts:remove", async (_e, id: string) => removePrompt(id));
  ipcMain.handle("prompts:sync", async () => syncCursorInjection());
  ipcMain.handle("prompts:openDir", async () => {
    const p = await openPromptsDir();
    await shell.showItemInFolder(p);
    return { path: p };
  });

  ipcMain.handle("appearance:save", async (_e, appearance: AppearanceConfig) => {
    const cfg = await loadConfig();
    cfg.appearance = appearance;
    await saveConfig(cfg);
    await configureBackgroundAutoRotation();
    return { appearance };
  });
  ipcMain.handle("appearance:apply", async (_e, body: AppearanceConfig & { realtimeOnly?: boolean }) => {
    const { realtimeOnly, ...appearance } = body;
    const cfg = await loadConfig();
    cfg.appearance = appearance;
    await saveConfig(cfg);
    await clearLegacyBackgroundCoverKeys();
    const result = realtimeOnly
      ? await refreshWorkbenchCss(appearance)
      : await applyWorkbenchBackground(appearance);
    await configureBackgroundAutoRotation();
    return { appearance, ...result };
  });
  ipcMain.handle("appearance:clear", async () => {
    const result = await clearWorkbenchBackground();
    await clearLegacyBackgroundCoverKeys();
    const cfg = await loadConfig();
    cfg.appearance = { ...cfg.appearance, enabled: false, liveApply: false };
    await saveConfig(cfg);
    await configureBackgroundAutoRotation();
    return { ...result, appearance: cfg.appearance };
  });
  ipcMain.handle("appearance:dryRun", async (_e, appearance: AppearanceConfig) =>
    dryRunInject(appearance),
  );
  ipcMain.handle("appearance:forceRestore", async () => forceRestoreWorkbench());
  ipcMain.handle("appearance:injectStatus", async () => getInjectStatus());
  ipcMain.handle(
    "appearance:random",
    async (_e, input: { folder: string; excludePath?: string }) => ({
      path: await pickRandomImage(input.folder, input.excludePath),
    }),
  );

  ipcMain.handle("cursor:status", async () => {
    const st = await getCursorStatus();
    const inj = await getInjectStatus();
    return { ...st, inject: inj };
  });
  ipcMain.handle("cursor:openSettings", async () => {
    const p = resolveCursorSettingsPath();
    await shell.showItemInFolder(p);
    return p;
  });
  ipcMain.handle("dialog:pickImage", async () => {
    const strings = await getNativeStrings(app.getLocale());
    const res = await dialog.showOpenDialog(win!, {
      title: strings.dialog.pickBackground,
      filters: [
        {
          name: "Media",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"],
        },
      ],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle("dialog:pickAvatar", async () => {
    const strings = await getNativeStrings(app.getLocale());
    const res = await dialog.showOpenDialog(win!, {
      title: strings.dialog.pickAvatar,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"],
        },
      ],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle("dialog:pickFolder", async () => {
    const strings = await getNativeStrings(app.getLocale());
    const res = await dialog.showOpenDialog(win!, {
      title: strings.dialog.pickRandomImageFolder,
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
}

// Windows 任务栏/通知分组标识（托盘与窗口图标一致）
if (process.platform === "win32") {
  app.setAppUserModelId("com.cursor-studio.app");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow(win);
  });

  app.whenReady().then(() => {
    stripMenus();
    ensureControlPlane();
    startPromotionsRefresh();
    registerIpc();
    createWindow();
    createTray(() => win);
    startNativeReleaseChecks();
    startProviderMonitor();

    // in the background as soon as the application is ready.
    void startService()
      .then((state) => {
        console.log(
          `[studio] service auto-started proxy=${state.proxyListenAddr} backend=${state.backendListenAddr}`,
        );
        return refreshTrayMenu(() => win);
      })
      .catch((error) => {
        console.error("[studio] service auto-start failed", error);
      });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow(win);
    });
  });
}

// 有托盘时关闭窗口不退出
app.on("window-all-closed", () => {
  if (getIsQuitting() && process.platform !== "darwin") {
    /* quit handled below */
  }
});

app.on("before-quit", (event) => {
  setIsQuitting(true);
  destroyTray();
  stopProviderMonitor();
  if (quitCleanupFinished) return;

  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;

  void stopService({ clearCursor: true })
    .catch((error) => {
      console.error("[studio] quit cleanup failed", error);
    })
    .finally(() => {
      quitCleanupFinished = true;
      // The initial quit is intentionally prevented while the proxy is being
      // stopped. Exit explicitly once cleanup has completed so a hidden tray
      // window cannot keep the Electron process alive.
      app.exit(0);
    });
});
