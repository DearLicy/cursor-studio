import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const studioWindow = {
  minimize: () => {
    ipcRenderer.send("window:minimize");
  },
  maximize: () => {
    ipcRenderer.send("window:maximize");
  },
  close: () => {
    ipcRenderer.send("window:close");
  },
  isMaximized: () => ipcRenderer.invoke("window:isMaximized") as Promise<boolean>,
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: IpcRendererEvent, maximized: boolean) => cb(Boolean(maximized));
    ipcRenderer.on("window:maximized", handler);
    return () => {
      ipcRenderer.removeListener("window:maximized", handler);
    };
  },
};

const api = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("config:save", cfg),
  importConfig: (cfg: unknown) => ipcRenderer.invoke("config:import", cfg),
  createConfigBackup: () => ipcRenderer.invoke("config:backup"),
  listConfigBackups: () => ipcRenderer.invoke("config:backups"),
  removeConfigBackup: (name: string) => ipcRenderer.invoke("config:removeBackup", name),
  clearConfigBackups: () => ipcRenderer.invoke("config:clearBackups"),
  restoreConfigBackup: (name: string) => ipcRenderer.invoke("config:restore", name),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  upsertProvider: (p: unknown) => ipcRenderer.invoke("providers:upsert", p),
  removeProvider: (id: string) => ipcRenderer.invoke("providers:remove", id),
  newProviderTemplate: () => ipcRenderer.invoke("providers:newTemplate"),
  fetchModels: (input: {
    type: "openai" | "anthropic";
    baseURL: string;
    apiKey: string;
  }) => ipcRenderer.invoke("providers:fetchModels", input),
  probeProvider: (provider: unknown) =>
    ipcRenderer.invoke("providers:probe", provider),
  probeProviderBalance: (provider: unknown) =>
    ipcRenderer.invoke("providers:probeBalance", provider),
  listProviderBalances: (providerId?: string) =>
    ipcRenderer.invoke("providers:listBalances", providerId),
  providerHealth: () => ipcRenderer.invoke("providers:health"),
  fetchModelsAndSave: (input: unknown) =>
    ipcRenderer.invoke("providers:fetchModelsAndSave", input),
  startService: () => ipcRenderer.invoke("service:start"),
  stopService: () => ipcRenderer.invoke("service:stop"),
  serviceState: () => ipcRenderer.invoke("service:state"),
  injectCursorProxy: () => ipcRenderer.invoke("service:injectCursor"),
  detachCursorProxy: () => ipcRenderer.invoke("service:detachCursor"),
  clearCursorProxy: () => ipcRenderer.invoke("cursor:clearProxy"),
  getProxyCa: () => ipcRenderer.invoke("proxy:ca"),
  installProxyCa: () => ipcRenderer.invoke("proxy:installCa"),
  openProxyCa: () => ipcRenderer.invoke("proxy:openCa"),
  getHomeMetrics: () => ipcRenderer.invoke("metrics:home"),
  getHomePromotions: (refresh = false) =>
    ipcRenderer.invoke("promotions:get", { refresh }),
  setIncludeCacheWrite: (value: boolean) =>
    ipcRenderer.invoke("metrics:includeCacheWrite", value),
  refreshUsagePricing: () => ipcRenderer.invoke("metrics:pricingRefresh"),
  resetMetrics: () => ipcRenderer.invoke("metrics:reset"),
  getRequestLogs: () => ipcRenderer.invoke("metrics:logs"),
  queryUsage: (query?: unknown) => ipcRenderer.invoke("metrics:query", query),
  exportUsageCsv: (query?: unknown) => ipcRenderer.invoke("metrics:exportCsv", query),
  probeBalances: () => ipcRenderer.invoke("balance:probe"),
  listBalanceAccounts: () => ipcRenderer.invoke("balance:accounts"),
  upsertBalanceAccount: (a: unknown) => ipcRenderer.invoke("balance:upsert", a),
  removeBalanceAccount: (id: string) => ipcRenderer.invoke("balance:remove", id),
  newBalanceTemplate: (partial?: unknown) =>
    ipcRenderer.invoke("balance:newTemplate", partial),
  listMcp: (opts?: { probe?: boolean }) =>
    ipcRenderer.invoke("mcp:list", opts),
  upsertMcp: (id: string, spec: unknown, requireProbe = true) =>
    ipcRenderer.invoke("mcp:upsert", { id, spec, requireProbe }),
  upsertMcpJson: (json: string, id?: string, requireProbe = true) =>
    ipcRenderer.invoke("mcp:upsertJson", { json, id, requireProbe }),
  probeMcp: (spec: unknown, id?: string) =>
    ipcRenderer.invoke("mcp:probe", { id, spec }),
  removeMcp: (id: string) => ipcRenderer.invoke("mcp:remove", id),
  openMcpFile: () => ipcRenderer.invoke("mcp:open"),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  createSkill: (input: unknown) => ipcRenderer.invoke("skills:create", input),
  updateSkillContent: (path: string, content: string) =>
    ipcRenderer.invoke("skills:update", { path, content }),
  removeSkill: (path: string) => ipcRenderer.invoke("skills:remove", path),
  readSkill: (path: string, maxChars?: number) =>
    ipcRenderer.invoke("skills:read", { path, maxChars }),
  openSkill: (path: string) => ipcRenderer.invoke("skills:open", path),
  listSkillRepos: () => ipcRenderer.invoke("skills:repos"),
  addSkillRepo: (input: unknown) => ipcRenderer.invoke("skills:addRepo", input),
  removeSkillRepo: (owner: string, name: string) =>
    ipcRenderer.invoke("skills:removeRepo", { owner, name }),
  discoverSkills: () => ipcRenderer.invoke("skills:discover"),
  installSkill: (skill: unknown) => ipcRenderer.invoke("skills:install", skill),
  listSessions: (
    opts?: {
      limit?: number;
      offset?: number;
      view?: "recent" | "project";
      q?: string;
      project?: string;
      refresh?: boolean;
    },
  ) =>
    ipcRenderer.invoke("sessions:list", opts),
  readSession: (id: string) => ipcRenderer.invoke("sessions:read", { id }),
  removeSessions: (ids: string[]) => ipcRenderer.invoke("sessions:remove", { ids }),
  clearEmptySessions: () => ipcRenderer.invoke("sessions:clearEmpty"),
  listPrompts: () => ipcRenderer.invoke("prompts:list"),
  setPromptEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("prompts:setEnabled", { id, enabled }),
  setPromptMode: (mode: "append" | "replace") =>
    ipcRenderer.invoke("prompts:setMode", { mode }),
  setPromptMaster: (enabled: boolean) =>
    ipcRenderer.invoke("prompts:setMaster", { enabled }),
  upsertPrompt: (input: unknown) => ipcRenderer.invoke("prompts:upsert", input),
  removePrompt: (id: string) => ipcRenderer.invoke("prompts:remove", id),
  syncPrompts: () => ipcRenderer.invoke("prompts:sync"),
  openPromptsDir: () => ipcRenderer.invoke("prompts:openDir"),
  saveAppearance: (a: unknown) => ipcRenderer.invoke("appearance:save", a),
  applyAppearance: (a: unknown) => ipcRenderer.invoke("appearance:apply", a),
  clearAppearance: () => ipcRenderer.invoke("appearance:clear"),
  dryRunAppearance: (a: unknown) => ipcRenderer.invoke("appearance:dryRun", a),
  forceRestoreAppearance: () => ipcRenderer.invoke("appearance:forceRestore"),
  injectStatus: () => ipcRenderer.invoke("appearance:injectStatus"),
  pickRandomAppearance: (folder: string, excludePath?: string) =>
    ipcRenderer.invoke("appearance:random", { folder, excludePath }),
  cursorStatus: () => ipcRenderer.invoke("cursor:status"),
  openCursorSettings: () => ipcRenderer.invoke("cursor:openSettings"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),
  pickAvatar: () => ipcRenderer.invoke("dialog:pickAvatar"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  getUpdateStatus: () => ipcRenderer.invoke("updates:status"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateStatus: (callback: (result: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
  onUpdateProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("updates:progress", handler);
    return () => ipcRenderer.removeListener("updates:progress", handler);
  },
};

contextBridge.exposeInMainWorld("studio", api);
contextBridge.exposeInMainWorld("studioWindow", studioWindow);
