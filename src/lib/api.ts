/** 控制面地址：可用 VITE_STUDIO_CONTROL 覆盖 */
const CONTROL_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_STUDIO_CONTROL) ||
  "http://127.0.0.1:28191";

export type ProviderType = "openai" | "anthropic";
export type OpenAIEndpoint = "/v1/chat/completions" | "/v1/responses";

export interface ModelSettings {
  enabled?: boolean;
  favorite?: boolean;
  contextWindowTokens?: number;
  maxCompletionTokens?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
}

export type ProviderBalanceConfig =
  | {
      type: "newapi";
      userId: string;
      accessToken: string;
    }
  | {
      type: "sub2api";
    };

export interface ModelProvider {
  id: string;
  displayName: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string;
  modelID: string;
  models?: string[];
  modelSettings?: Record<string, ModelSettings>;
  enabled: boolean;
  contextWindowTokens?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: string;
  /** OpenAI 兼容出站：chat 或 responses（对该供应商全部模型生效） */
  openAIEndpoint?: OpenAIEndpoint;
  /** Smaller value = higher failover priority */
  failoverPriority?: number;
  /** Unset means that balance probing is disabled for this provider. */
  balance?: ProviderBalanceConfig;
}

export type BlendModel = "auto" | "multiply" | "lighten";
export type SizeModel =
  | "cover"
  | "repeat"
  | "contain"
  | "center"
  | "not_center"
  | "not_right_bottom"
  | "not_right_top"
  | "not_left"
  | "not_right"
  | "not_top"
  | "not_bottom";

export interface AppearanceConfig {
  enabled: boolean;
  imagePath: string;
  opacity: number;
  blur: number;
  windowOpacity: number;
  surfaceOpacity: number;
  sizeModel: SizeModel;
  blendModel: BlendModel;
  randomImageFolder: string;
  autoStatus: boolean;
  autoInterval: number;
  defaultOnlinePage: string;
  liveApply?: boolean;
}

export interface CursorIntegrationConfig {
  displayName: string;
  contactEmail: string;
  planName: string;
  defaultContextWindowTokens: number;
  /** Local file URL or remote HTTPS image URL. An empty value uses the app icon. */
  avatarUrl: string;
  /** Cursor public profile handle. */
  profileHandle: string;
  /** Cursor public profile website. */
  website: string;
}

export type BalanceKind = "newapi" | "sub2api";

export interface BalanceAccount {
  id: string;
  name: string;
  type: BalanceKind;
  apiKey: string;
  accessToken?: string;
  userId?: string;
  balanceEndpoint?: string;
  baseURL?: string;
  enabled?: boolean;
  linkedProviderId?: string;
}

export interface AppConfig {
  version: 1;
  proxyListenAddr: string;
  backendListenAddr: string;
  routingMode: "local" | "upstream";
  providers: ModelProvider[];
  appearance: AppearanceConfig;
  cursorIntegration: CursorIntegrationConfig;
  injectCursorProxy: boolean;
  includeCacheWriteInHitRate?: boolean;
  balanceAccounts?: BalanceAccount[];
  profiles?: WorkspaceProfile[];
  activeProfileId?: string;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  description?: string;
  providerIds: string[];
  defaultProviderId?: string;
  defaultModelID?: string;
  promptIds?: string[];
  mcpServerIds?: string[];
  skillIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProbeHistoryItem {
  id: string;
  at: string;
  providerId: string;
  displayName?: string;
  ok: boolean;
  latencyMs?: number;
  status?: number;
  endpoint?: string;
  modelCount?: number;
  error?: string;
  batchId?: string;
}


export interface ServiceState {
  running: boolean;
  proxyListenAddr: string;
  backendListenAddr: string;
  caCertPath?: string;
  cursorSettingsApplied: boolean;
  injectCursorProxy: boolean;
  lastError?: string;
  cursorProxy?: string | null;
  proxyStats?: {
    startedAt: string;
    httpRelay: number;
    mitmRelay: number;
    tunnelPass: number;
    errors: number;
    lastHost?: string;
    lastPath?: string;
    lastError?: string;
  };
}

export interface ProxyCaInfo {
  certPath: string;
  keyPath?: string;
  exists: boolean;
  stats: ServiceState["proxyStats"] | null;
  running: boolean;
}

export interface PricingCatalogStatus {
  source: "models.dev";
  state: "ready" | "stale" | "empty";
  updatedAt?: string;
  catalogEntries: number;
  lastError?: string;
}

export interface UsagePricingRefreshResult {
  pricing: PricingCatalogStatus;
  updatedRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
  catalogMatchedModels: number;
  unmatchedModels: number;
}

export interface HomeMetrics {
  turnsTotal: number;
  validTurnsTotal: number;
  invalidTurnsTotal: number;
  requestTokensTotal: number;
  promptTokensTotal: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  includeCacheWriteInHitRate: boolean;
  estimatedCostUsd?: number;
  updatedAt?: string;
  pricing: PricingCatalogStatus;
}

export type HomePromotionKind = "promotion" | "vacancy";

export interface HomePromotion {
  id: string;
  label: string;
  title: string;
  description: string;
  action: string;
  href: string;
  kind?: HomePromotionKind;
}

export interface HomePromotionsResult {
  promotions: HomePromotion[];
  source: "remote" | "cache" | "bundled";
  updatedAt?: string;
  refreshedAt?: string;
}

export interface RequestLogItem {
  id: string;
  at: string;
  valid: boolean;
  source?: "ide" | "agent" | "unknown";
  providerId?: string;
  modelID?: string;
  requestTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costEstimated?: boolean;
  priceSnapshot?: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheWritePerMillion: number;
    source: "models-dev" | "model" | "provider" | "unavailable";
    catalogProviderId?: string;
    catalogModelId?: string;
    catalogUpdatedAt?: string;
    tierThreshold?: number;
    cacheReadDerived?: boolean;
    cacheWriteDerived?: boolean;
  };
  error?: string;
  requestId?: string;
}

export interface UsageQueryResult {
  logs: RequestLogItem[];
  totalMatched: number;
  summary: {
    requests: number;
    valid: number;
    invalid: number;
    requestTokens: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    cacheHitRate: number;
  };
  byProvider: Array<{
    name: string;
    requests: number;
    tokens: number;
    costUsd: number;
    errors: number;
  }>;
  byModel: Array<{
    name: string;
    requests: number;
    tokens: number;
    costUsd: number;
  }>;
}

export interface BalanceResult {
  accountId: string;
  displayName: string;
  type: BalanceKind;
  ok: boolean;
  balanceText?: string;
  error?: string;
  checkedAt: string;
  /** 兼容旧字段 */
  providerId?: string;
}

export type ProviderBalanceResult = Omit<BalanceResult, "type" | "providerId"> & {
  providerId: string;
  type: BalanceKind | "none";
  configured: boolean;
};

export interface McpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
}

export interface McpProbeResult {
  ok: boolean;
  kind: string;
  latencyMs: number;
  toolCount: number;
  tools: Array<{ name: string; description?: string }>;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  error?: string;
  id?: string;
}

export interface McpListResult {
  path: string;
  servers: Array<{
    id: string;
    spec: McpServerSpec;
    kind: string;
    probe?: McpProbeResult;
  }>;
  probe?: McpProbeResult;
  id?: string;
}

export interface SkillItem {
  id: string;
  name: string;
  source: string;
  path: string;
  description?: string;
  hasSkillMd: boolean;
  /** Whether the underlying skill file is user-managed. */
  writable?: boolean;
  /** Display scope supplied by the workspace skill catalog. */
  scope?: string;
  /** Present for project-only skills. The renderer never displays the raw path. */
  workspacePath?: string;
}

export interface SkillListResult {
  roots: string[];
  items: SkillItem[];
}

export interface SkillMutationResult extends SkillListResult {
  item?: SkillItem;
}

export interface SkillRepo {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface DiscoverableSkill {
  key: string;
  name: string;
  description?: string;
  directory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  contentHash: string;
  installed: boolean;
  managed: boolean;
  updateAvailable: boolean;
}

export interface SessionItem {
  id: string;
  sessionId: string;
  title: string;
  project: string;
  projectLabel: string;
  updatedAt?: string;
  createdAt?: string;
  preview?: string;
  messageCount: number;
}

export type SessionListView = "recent" | "project";

export type SessionMessageRole = "user" | "assistant";

export interface SessionMessage {
  id: string;
  index: number;
  line: number;
  role: SessionMessageRole;
  text: string;
  truncated?: boolean;
}

export interface SessionDetail {
  session: SessionItem;
  messages: SessionMessage[];
  totalMessages: number;
}

export interface SessionProjectGroup {
  project: string;
  label: string;
  count: number;
  latestAt?: string;
}


export type PromptInjectionMode = "append" | "replace";
export type PromptSource = "builtin" | "custom";

export interface PromptItem {
  id: string;
  title: string;
  filename: string;
  description: string;
  content: string;
  enabled: boolean;
  source: PromptSource;
  scene?: string;
  updatedAt: string;
  profileIds?: string[];
}

export interface PromptsState {
  version: 1;
  injectionMode: PromptInjectionMode;
  masterEnabled: boolean;
  items: PromptItem[];
}

export interface PromptsListResult {
  state: PromptsState;
  cursorRulePath: string;
  cursorRuleExists: boolean;
  activeCount: number;
  conflict?: {
    path: string;
    conflict: boolean;
    reason?: string;
    expectedFingerprint?: string;
    actualFingerprint?: string;
    managedMarkersPresent: boolean;
  };
  inject?: {
    path: string;
    written: boolean;
    removed: boolean;
    activeCount: number;
  };
}

export interface InjectStatus {
  installed: boolean;
  workbenchHtml?: string;
  workbenchJs?: string;
  htmlPatched: boolean;
  jsPatched?: boolean;
  allBundlesPatched: boolean;
  bundleStatuses: BundleInjectStatus[];
  cssExists: boolean;
  writeOk?: boolean;
  bakExists?: boolean;
  assetExists?: boolean;
  mediaType?: BackgroundMediaType;
  sourcePath?: string;
  remoteCached?: boolean;
  backgroundCoverConflict: boolean;
  materialPatched: boolean;
  materialBakExists: boolean;
  state?: InjectStateInfo | null;
}

export type BackgroundMediaType = "image" | "video";

export interface BundleInjectStatus {
  name: string;
  path: string;
  patched: boolean;
  bakExists: boolean;
}

export interface InjectStateInfo {
  workbenchJs: string;
  cssPath: string;
  installRoot: string;
  appOut: string;
  patchedBundles: string[];
  cursorMainJs?: string;
  assetPath?: string;
  mediaType?: BackgroundMediaType;
  sourcePath?: string;
  remoteCached?: boolean;
  appliedAt: string;
}

export interface DryRunResult {
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
}

export interface CursorStatus {
  settingsPath: string;
  proxy?: string;
  backgroundImage?: string;
  backgroundOpacity?: number;
  exists: boolean;
  inject?: InjectStatus;
}

export interface FetchedModel {
  id: string;
  ownedBy?: string;
  created?: number;
}

export type ProviderHealthState = "unknown" | "healthy" | "degraded" | "offline";

export interface ProviderHealth {
  providerId: string;
  state: ProviderHealthState;
  consecutiveFailures: number;
  checkedAt?: string;
  latencyMs?: number;
  status?: number;
  endpoint?: string;
  modelCount?: number;
  error?: string;
  openUntil?: string;
}

export interface ProviderProbeResult {
  ok: boolean;
  endpoint: string;
  status?: number;
  latencyMs: number;
  modelCount: number;
  error?: string;
  health: ProviderHealth;
}

export interface ConfigBackupInfo {
  name: string;
  createdAt: string;
  size: number;
}

export interface ConfigBackupCleanupResult {
  removed: string[];
  remaining: number;
}

export type UpdateCheckState =
  | "idle"
  | "unsupported"
  | "not-configured"
  | "up-to-date"
  | "available"
  | "error";

export interface AppUpdateInfo {
  version: string;
  title?: string;
  notes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  downloadUrl: string;
  sha256: string;
  size?: number;
  source: "manifest" | "github";
}

export interface UpdateCheckResult {
  state: UpdateCheckState;
  currentVersion: string;
  checkedAt: string;
  message?: string;
  update?: AppUpdateInfo;
  promotions?: HomePromotion[];
}

export interface UpdateProgress {
  phase: "downloading" | "verifying";
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface UpdateInstallResult {
  state: "unsupported" | "not-configured" | "no-update" | "restarting" | "error";
  currentVersion: string;
  message: string;
  update?: AppUpdateInfo;
}

export type StudioApi = {
  getConfig: () => Promise<AppConfig>;
  getDiagnostics: () => Promise<Record<string, unknown>>;
  exportDiagnostics: () => Promise<{ path: string; bundle: Record<string, unknown> }>;
  saveConfig: (cfg: AppConfig) => Promise<AppConfig>;
  importConfig: (cfg: unknown) => Promise<AppConfig>;
  createConfigBackup: () => Promise<{ backup: ConfigBackupInfo | null }>;
  listConfigBackups: () => Promise<{ backups: ConfigBackupInfo[] }>;
  removeConfigBackup: (name: string) => Promise<ConfigBackupCleanupResult>;
  clearConfigBackups: () => Promise<ConfigBackupCleanupResult>;
  restoreConfigBackup: (name: string) => Promise<AppConfig>;
  listProviders: () => Promise<ModelProvider[]>;
  upsertProvider: (p: ModelProvider) => Promise<ModelProvider[]>;
  removeProvider: (id: string) => Promise<ModelProvider[]>;
  newProviderTemplate: () => Promise<ModelProvider>;
  fetchModels: (input: {
    type: ProviderType;
    baseURL: string;
    apiKey: string;
  }) => Promise<{ models: FetchedModel[]; endpoint: string }>;
  probeProvider: (provider: ModelProvider) => Promise<ProviderProbeResult>;
  probeProviderBalance: (
    provider: ModelProvider,
  ) => Promise<{ balance: ProviderBalanceResult }>;
  listProviderBalances: (
    providerId?: string,
  ) => Promise<{ balances: ProviderBalanceResult[] }>;
  providerHealth: () => Promise<{ health: ProviderHealth[] }>;
  duplicateProvider: (
    id: string,
  ) => Promise<{ providers: ModelProvider[]; provider: ModelProvider }>;
  listProbeHistory: (opts?: {
    limit?: number;
    providerId?: string;
  }) => Promise<{ items: ProbeHistoryItem[] }>;
  clearProbeHistory: () => Promise<{ ok: boolean }>;
  listProfiles: () => Promise<{
    profiles: WorkspaceProfile[];
    activeProfileId?: string;
  }>;
  upsertProfile: (
    p: Partial<WorkspaceProfile> & { name?: string },
  ) => Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }>;
  removeProfile: (
    id: string,
  ) => Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }>;
  setActiveProfile: (
    id: string | null,
  ) => Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }>;
  applyProfile: (
    id: string,
  ) => Promise<{
    config: AppConfig;
    profiles: WorkspaceProfile[];
    activeProfileId?: string;
  }>;
  newProfileTemplate: () => Promise<WorkspaceProfile>;
  fetchModelsAndSave: (input: {
    id?: string;
    displayName?: string;
    type: ProviderType;
    baseURL: string;
    apiKey: string;
    enabled?: boolean;
    modelID?: string;
    openAIEndpoint?: OpenAIEndpoint;
    reasoningEffort?: string;
    balance?: ProviderBalanceConfig;
  }) => Promise<{
    provider: ModelProvider;
    providers: ModelProvider[];
    models: FetchedModel[];
    endpoint: string;
    count: number;
  }>;
  startService: () => Promise<ServiceState>;
  stopService: () => Promise<ServiceState>;
  serviceState: () => Promise<ServiceState>;
  injectCursorProxy: () => Promise<ServiceState>;
  detachCursorProxy: () => Promise<ServiceState>;
  clearCursorProxy: () => Promise<{ path: string; cleared: boolean; skippedReason?: string }>;
  getProxyCa: () => Promise<ProxyCaInfo>;
  installProxyCa: () => Promise<{ ok: boolean; message: string; certPath: string }>;
  openProxyCa: () => Promise<{ path: string }>;
  getHomeMetrics: () => Promise<HomeMetrics>;
  getHomePromotions: (refresh?: boolean) => Promise<HomePromotionsResult>;
  setIncludeCacheWrite: (value: boolean) => Promise<HomeMetrics>;
  refreshUsagePricing: () => Promise<UsagePricingRefreshResult>;
  resetMetrics: () => Promise<HomeMetrics>;
  queryUsage: (params?: {
    from?: string;
    to?: string;
    providerId?: string;
    modelID?: string;
    source?: string;
    valid?: string;
    q?: string;
    limit?: number;
  }) => Promise<UsageQueryResult>;
  exportUsageCsv: (params?: {
    from?: string;
    to?: string;
    providerId?: string;
    modelID?: string;
    source?: string;
    valid?: string;
    q?: string;
  }) => Promise<string>;
  getRequestLogs: () => Promise<{
    logs: RequestLogItem[];
    totals: Record<string, number>;
    estimatedCostUsd: number;
  }>;
  probeBalances: () => Promise<{ balances: BalanceResult[] }>;
  listBalanceAccounts: () => Promise<{ accounts: BalanceAccount[] }>;
  upsertBalanceAccount: (a: BalanceAccount) => Promise<{ accounts: BalanceAccount[] }>;
  removeBalanceAccount: (id: string) => Promise<{ accounts: BalanceAccount[] }>;
  newBalanceTemplate: (partial?: Partial<BalanceAccount>) => Promise<BalanceAccount>;
  listMcp: (opts?: { probe?: boolean }) => Promise<McpListResult>;
  upsertMcp: (
    id: string,
    spec: McpServerSpec,
    requireProbe?: boolean,
  ) => Promise<McpListResult>;
  upsertMcpJson: (
    json: string,
    id?: string,
    requireProbe?: boolean,
  ) => Promise<McpListResult>;
  probeMcp: (spec: McpServerSpec, id?: string) => Promise<McpProbeResult>;
  removeMcp: (id: string) => Promise<McpListResult>;
  openMcpFile: () => Promise<{ path: string } | string>;
  listSkills: () => Promise<SkillListResult>;
  createSkill: (input: {
    name: string;
    description?: string;
  }) => Promise<SkillMutationResult>;
  updateSkillContent: (path: string, content: string) => Promise<SkillMutationResult>;
  removeSkill: (path: string) => Promise<SkillListResult>;
  readSkill: (path: string, maxChars?: number) => Promise<{ path: string; text: string; truncated?: boolean }>;
  openSkill: (path: string) => Promise<{ path: string }>;
  listSkillRepos: () => Promise<{ path: string; repos: SkillRepo[] }>;
  addSkillRepo: (input: {
    owner: string;
    name?: string;
    branch?: string;
    enabled?: boolean;
  }) => Promise<{ path: string; repos: SkillRepo[] }>;
  removeSkillRepo: (
    owner: string,
    name: string,
  ) => Promise<{ path: string; repos: SkillRepo[] }>;
  discoverSkills: () => Promise<{
    items: DiscoverableSkill[];
    errors: Array<{ repo: string; error: string }>;
  }>;
  installSkill: (
    skill: DiscoverableSkill,
  ) => Promise<{ item: SkillItem; installed: { roots: string[]; items: SkillItem[] } }>;
  listSessions: (opts?: {
    limit?: number;
    offset?: number;
    view?: SessionListView;
    q?: string;
    project?: string;
    refresh?: boolean;
  }) => Promise<{
    items: SessionItem[];
    totalMatched?: number;
    totalSessions?: number;
    offset?: number;
    limit?: number;
    view?: SessionListView;
    projects?: SessionProjectGroup[];
  }>;
  removeSessions: (ids: string[]) => Promise<{
    ok: true;
    removed: string[];
    failed: Array<{ id: string; error: string }>;
  }>;
  clearEmptySessions: () => Promise<{
    ok: true;
    emptyFound: number;
    removed: string[];
    failed: Array<{ id: string; error: string }>;
  }>;
  readSession: (id: string) => Promise<SessionDetail>;
  getPromptConflict: () => Promise<{
    path: string;
    conflict: boolean;
    reason?: string;
    expectedFingerprint?: string;
    actualFingerprint?: string;
    managedMarkersPresent: boolean;
  }>;
  listPrompts: () => Promise<PromptsListResult>;
  setPromptEnabled: (id: string, enabled: boolean) => Promise<PromptsListResult>;
  setPromptMode: (mode: PromptInjectionMode) => Promise<PromptsListResult>;
  setPromptMaster: (enabled: boolean) => Promise<PromptsListResult>;
  upsertPrompt: (input: {
    id?: string;
    title: string;
    filename?: string;
    description?: string;
    content: string;
    enabled?: boolean;
    profileIds?: string[];
  }) => Promise<PromptsListResult>;
  removePrompt: (id: string) => Promise<PromptsListResult>;
  syncPrompts: () => Promise<{
    path: string;
    written: boolean;
    removed: boolean;
    activeCount: number;
  }>;
  openPromptsDir: () => Promise<{ path: string }>;
  saveAppearance: (a: AppearanceConfig) => Promise<{ appearance: AppearanceConfig }>;
  applyAppearance: (
    a: AppearanceConfig & { realtimeOnly?: boolean },
  ) => Promise<{
    appearance: AppearanceConfig;
    workbenchHtml?: string;
    workbenchJs?: string;
    cssPath?: string;
    assetPath?: string;
    mediaType?: BackgroundMediaType;
    sourcePath?: string;
    remoteCached?: boolean;
    needsReload?: boolean;
    message?: string;
  }>;
  clearAppearance: () => Promise<{
    message?: string;
    workbenchHtml?: string;
    workbenchJs?: string;
  }>;
  dryRunAppearance: (a: AppearanceConfig) => Promise<DryRunResult>;
  forceRestoreAppearance: () => Promise<{ message?: string; patchedBundles?: string[] }>;
  injectStatus: () => Promise<InjectStatus>;
  pickRandomAppearance: (
    folder: string,
    excludePath?: string,
  ) => Promise<{ path: string | null }>;
  cursorStatus: () => Promise<CursorStatus>;
  openCursorSettings: () => Promise<string>;
  openExternal: (url: string) => Promise<boolean>;
  pickImage: () => Promise<string | null>;
  pickAvatar: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  getUpdateStatus: () => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<UpdateInstallResult>;
  onUpdateStatus: (callback: (result: UpdateCheckResult) => void) => () => void;
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => () => void;
};

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data?.error || `${method} ${path} → ${res.status}`);
  }
  return data;
}

/** HTTP 控制面（浏览器调试 / Electron 回退） */
export const httpApi: StudioApi = {
  getConfig: () => req("GET", "/config"),
  getDiagnostics: () => req("GET", "/diagnostics"),
  exportDiagnostics: () => req("POST", "/diagnostics/export"),
  saveConfig: (cfg) => req("POST", "/config", cfg),
  importConfig: (cfg) => req("POST", "/config/import", { config: cfg }),
  createConfigBackup: () => req("POST", "/config/backup"),
  listConfigBackups: () => req("GET", "/config/backups"),
  removeConfigBackup: (name) => req("POST", "/config/backups/remove", { name }),
  clearConfigBackups: () => req("POST", "/config/backups/clear"),
  restoreConfigBackup: (name) => req("POST", "/config/restore", { name }),
  listProviders: () => req("GET", "/providers"),
  upsertProvider: (p) => req("POST", "/providers/upsert", p),
  removeProvider: (id) => req("POST", "/providers/remove", { id }),
  newProviderTemplate: () => req("POST", "/providers/newTemplate"),
  fetchModels: (input) => req("POST", "/providers/fetchModels", input),
  probeProvider: (provider) => req("POST", "/providers/probe", provider),
  probeProviderBalance: (provider) =>
    req("POST", "/providers/probeBalance", provider),
  listProviderBalances: (providerId) => {
    const query = providerId?.trim()
      ? `?providerId=${encodeURIComponent(providerId.trim())}`
      : "";
    return req("GET", `/providers/balance${query}`);
  },
  providerHealth: () => req("GET", "/providers/health"),
  duplicateProvider: (id) => req("POST", "/providers/duplicate", { id }),
  listProbeHistory: (opts) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.providerId) q.set("providerId", opts.providerId);
    const qs = q.toString();
    return req("GET", `/providers/probeHistory${qs ? `?${qs}` : ""}`);
  },
  clearProbeHistory: () => req("POST", "/providers/probeHistory/clear"),
  listProfiles: () => req("GET", "/profiles"),
  upsertProfile: (p) => req("POST", "/profiles/upsert", p),
  removeProfile: (id) => req("POST", "/profiles/remove", { id }),
  setActiveProfile: (id) => req("POST", "/profiles/setActive", { id }),
  applyProfile: (id) => req("POST", "/profiles/apply", { id }),
  newProfileTemplate: () => req("POST", "/profiles/newTemplate"),
  fetchModelsAndSave: (input) => req("POST", "/providers/fetchModelsAndSave", input),
  startService: () => req("POST", "/service/start"),
  stopService: () => req("POST", "/service/stop"),
  serviceState: () => req("GET", "/service/state"),
  injectCursorProxy: () => req("POST", "/service/injectCursor"),
  detachCursorProxy: () => req("POST", "/service/detachCursor"),
  clearCursorProxy: () => req("POST", "/cursor/clearProxy"),
  getProxyCa: () => req("GET", "/proxy/ca"),
  installProxyCa: () => req("POST", "/proxy/installCa"),
  openProxyCa: () => req("POST", "/proxy/openCa"),
  getHomeMetrics: () => req("GET", "/metrics/home"),
  getHomePromotions: (refresh = false) =>
    req("GET", `/promotions${refresh ? "?refresh=1" : ""}`),
  setIncludeCacheWrite: (value) => req("POST", "/metrics/includeCacheWrite", { value }),
  refreshUsagePricing: () => req("POST", "/metrics/pricing/refresh"),
  resetMetrics: () => req("POST", "/metrics/reset"),
  queryUsage: (params) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    if (params?.providerId) q.set("providerId", params.providerId);
    if (params?.modelID) q.set("modelID", params.modelID);
    if (params?.source) q.set("source", params.source);
    if (params?.valid) q.set("valid", params.valid);
    if (params?.q) q.set("q", params.q);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req("GET", `/metrics/query${qs ? `?${qs}` : ""}`);
  },
  exportUsageCsv: async (params) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    if (params?.providerId) q.set("providerId", params.providerId);
    if (params?.modelID) q.set("modelID", params.modelID);
    if (params?.source) q.set("source", params.source);
    if (params?.valid) q.set("valid", params.valid);
    if (params?.q) q.set("q", params.q);
    const qs = q.toString();
    const path = `/metrics/export.csv${qs ? `?${qs}` : ""}`;
    const res = await fetch(`${CONTROL_BASE}${path}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || `GET ${path} → ${res.status}`);
    }
    return res.text();
  },
  getRequestLogs: () => req("GET", "/metrics/logs"),
  probeBalances: () => req("POST", "/balance/probe"),
  listBalanceAccounts: () => req("GET", "/balance/accounts"),
  upsertBalanceAccount: (a) => req("POST", "/balance/upsert", a),
  removeBalanceAccount: (id) => req("POST", "/balance/remove", { id }),
  newBalanceTemplate: (partial) => req("POST", "/balance/newTemplate", partial || {}),
  listMcp: (opts) =>
    req("GET", `/mcp/list${opts?.probe ? "?probe=1" : ""}`),
  upsertMcp: (id, spec, requireProbe = true) =>
    req("POST", "/mcp/upsert", { id, spec, requireProbe }),
  upsertMcpJson: (json, id, requireProbe = true) =>
    req("POST", "/mcp/upsertJson", { json, id, requireProbe }),
  probeMcp: (spec, id) => req("POST", "/mcp/probe", { id, spec }),
  removeMcp: (id) => req("POST", "/mcp/remove", { id }),
  openMcpFile: () => req("POST", "/mcp/open"),
  listSkills: () => req("GET", "/skills/list"),
  createSkill: (input) => req("POST", "/skills/create", input),
  updateSkillContent: (path, content) => req("POST", "/skills/update", { path, content }),
  removeSkill: (path) => req("POST", "/skills/remove", { path }),
  readSkill: (path, maxChars) => req("POST", "/skills/read", { path, maxChars }),
  openSkill: (path) => req("POST", "/skills/open", { path }),
  listSkillRepos: () => req("GET", "/skills/repos"),
  addSkillRepo: (input) => req("POST", "/skills/addRepo", input),
  removeSkillRepo: (owner, name) => req("POST", "/skills/removeRepo", { owner, name }),
  discoverSkills: () => req("POST", "/skills/discover"),
  installSkill: (skill) => req("POST", "/skills/install", skill),
  listSessions: (opts) => {
    const q = new URLSearchParams();
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    if (opts?.offset != null) q.set("offset", String(opts.offset));
    if (opts?.view) q.set("view", opts.view);
    if (opts?.q) q.set("q", opts.q);
    if (opts?.project) q.set("project", opts.project);
    if (opts?.refresh) q.set("refresh", "1");
    const qs = q.toString();
    return req("GET", `/sessions/list${qs ? `?${qs}` : ""}`);
  },
  removeSessions: (ids) => req("POST", "/sessions/remove", { ids }),
  clearEmptySessions: () => req("POST", "/sessions/clearEmpty"),
  readSession: (id) => req("POST", "/sessions/read", { id }),
  listPrompts: () => req("GET", "/prompts/list"),
  getPromptConflict: () => req("GET", "/prompts/conflict"),
  setPromptEnabled: (id, enabled) => req("POST", "/prompts/setEnabled", { id, enabled }),
  setPromptMode: (mode) => req("POST", "/prompts/setMode", { mode }),
  setPromptMaster: (enabled) => req("POST", "/prompts/setMaster", { enabled }),
  upsertPrompt: (input) => req("POST", "/prompts/upsert", input),
  removePrompt: (id) => req("POST", "/prompts/remove", { id }),
  syncPrompts: () => req("POST", "/prompts/sync"),
  openPromptsDir: () => req("POST", "/prompts/openDir"),
  saveAppearance: (a) => req("POST", "/appearance/save", a),
  applyAppearance: (a) => req("POST", "/appearance/apply", a),
  clearAppearance: () => req("POST", "/appearance/clear"),
  dryRunAppearance: (a) => req("POST", "/appearance/dryRun", a),
  forceRestoreAppearance: () => req("POST", "/appearance/forceRestore"),
  injectStatus: () => req("GET", "/appearance/injectStatus"),
  pickRandomAppearance: (folder, excludePath) =>
    req("POST", "/appearance/random", { folder, excludePath }),
  cursorStatus: () => req("GET", "/cursor/status"),
  openCursorSettings: async () => {
    const r = await req<{ path: string }>("POST", "/cursor/openSettings");
    return r.path;
  },
  openExternal: async (url) => {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("只支持 HTTPS 链接");
    window.open(target.toString(), "_blank", "noopener,noreferrer");
    return true;
  },
  pickImage: async () => {
    const r = await req<{ path: string | null }>("POST", "/dialog/pickImage");
    return r.path;
  },
  pickAvatar: async () => {
    const r = await req<{ path: string | null }>("POST", "/dialog/pickAvatar");
    return r.path;
  },
  pickFolder: async () => {
    const r = await req<{ path: string | null }>("POST", "/dialog/pickFolder");
    return r.path;
  },
  checkForUpdates: async () => ({
    state: "unsupported",
    currentVersion: "1.0.0",
    checkedAt: new Date().toISOString(),
    message: "Please use the installed desktop app to check for updates.",
  }),
  getUpdateStatus: async () => ({
    state: "unsupported",
    currentVersion: "1.0.0",
    checkedAt: new Date().toISOString(),
    message: "Please use the installed desktop app to check for updates.",
  }),
  installUpdate: async () => ({
    state: "unsupported",
    currentVersion: "1.0.0",
    message: "Please use the installed desktop app to install updates.",
  }),
  onUpdateStatus: () => () => undefined,
  onUpdateProgress: () => () => undefined,
};

export function appearanceMediaUrl(source: string): string {
  const value = source.trim();
  if (!value) return "";
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return `${CONTROL_BASE}/appearance/media?source=${encodeURIComponent(value)}`;
}

export function appearanceMediaType(source: string): BackgroundMediaType {
  const value = source.split(/[?#]/, 1)[0].toLowerCase();
  if (value.startsWith("data:video/")) return "video";
  return /\.(mp4|webm|mov|ogg)$/i.test(value) ? "video" : "image";
}

export function getApi(): StudioApi {
  if (typeof window !== "undefined" && window.studio) return window.studio;
  return httpApi;
}

export async function waitForApi(timeoutMs = 8000): Promise<StudioApi> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    // IPC 优先，但要真实探活（preload 挂了时别假成功）
    if (typeof window !== "undefined" && window.studio) {
      try {
        await window.studio.getConfig();
        return window.studio;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    try {
      const h = await fetch(`${CONTROL_BASE}/health`);
      if (h.ok) {
        await httpApi.getConfig();
        return httpApi;
      }
      lastErr = `health ${h.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(
    `无法连接控制面 ${CONTROL_BASE}（${lastErr}）。请启动 Cursor Studio 桌面应用或 npm run dev。`,
  );
}

declare global {
  interface Window {
    studio?: StudioApi;
  }
}
