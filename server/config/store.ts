import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { randomUUID } from "node:crypto";
import {
  DefaultCursorContextWindowTokens,
  InjectAccountEmail,
  InjectAccountFirstName,
  InjectAccountLastName,
  InjectPlanDisplayName,
} from "../runtime/defaults";

export type ProviderType = "openai" | "anthropic";

/** OpenAI 兼容出站接口形状（供应商级，对该供应商下全部模型生效） */
export type OpenAIEndpoint =
  | "/v1/chat/completions"
  | "/v1/responses";

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

/**
 * Balance probing belongs to the provider connection. Leaving this field unset
 * means that balance probing is disabled for the provider.
 */
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
  /** 当前选用的默认模型 */
  modelID: string;
  /** 一键拉取后保存的全部模型 ID（Cursor AvailableModels 全量展开） */
  models?: string[];
  /** Per-model catalog metadata, availability and pricing overrides. */
  modelSettings?: Record<string, ModelSettings>;
  enabled: boolean;
  contextWindowTokens?: number;
  maxCompletionTokens?: number;
  /** 默认推理强度（Cursor 侧 variants 可覆盖） */
  reasoningEffort?: string;
  /**
   * OpenAI 兼容接口：
   * - /v1/chat/completions
   * - /v1/responses
   * Anthropic 忽略此字段。
   */
  openAIEndpoint?: OpenAIEndpoint;
  /** Displayed usage cost multiplier. Does not change upstream billing. */
  costMultiplier?: number;
  /** Smaller value = higher failover priority (stage 1). */
  failoverPriority?: number;
  /** Optional provider-local balance probing configuration. */
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

/**
 * 背景自注入配置（workbench CSS，不依赖扩展）。
 * size/blend 语义保留，便于兼容旧配置。
 */
export interface AppearanceConfig {
  /** 是否显示可选媒体背景；玻璃、圆角与透明效果始终生效 */
  enabled: boolean;
  /** 本地路径 / https URL */
  imagePath: string;
  /** 0 ~ 1（自注入无 0.8 上限） */
  opacity: number;
  /** 模糊 px 0 ~ 100 */
  blur: number;
  /** 程序底色透明度 0 ~ 1；越低越能看到系统 Acrylic / 背景媒体 */
  windowOpacity: number;
  /** 卡片、侧栏、编辑器等内容区块透明度 0 ~ 1 */
  surfaceOpacity: number;
  sizeModel: SizeModel;
  blendModel: BlendModel;
  randomImageFolder: string;
  autoStatus: boolean;
  autoInterval: number;
  defaultOnlinePage: string;
  /**
   * 已完成首次注入后，滑块变更时自动重写 CSS（仍建议 Cursor Ctrl+R）。
   * 默认 false，避免误写。
   */
  liveApply?: boolean;
}

/**
 * Values presented inside Cursor by the local integration. These only control
 * local display/protocol metadata; provider credentials remain in providers.
 */
export interface CursorIntegrationConfig {
  displayName: string;
  contactEmail: string;
  planName: string;
  defaultContextWindowTokens: number;
  /**
   * A canonical local file URL or remote HTTPS image URL used by Cursor's
   * profile image renderer. Local picker values are normalized to file://
   * URLs so the UI never needs to expose a raw filesystem path.
  */
  avatarUrl: string;
  /** Cursor's native public profile handle. */
  profileHandle: string;
  /** Cursor's native public profile website link. */
  website: string;
}

export interface AppConfig {
  version: 1;
  proxyListenAddr: string;
  backendListenAddr: string;
  routingMode: "local" | "upstream";
  providers: ModelProvider[];
  appearance: AppearanceConfig;
  cursorIntegration: CursorIntegrationConfig;
  /** 服务运行期间是否已向 Cursor settings 注入本地代理。 */
  injectCursorProxy: boolean;
  /** 首页缓存命中率是否把 cache write 计入分母 */
  includeCacheWriteInHitRate?: boolean;
  /** 余额账户：仅 NewAPI / Sub2API */
  balanceAccounts?: BalanceAccount[];
  /** Cursor Workspace Profiles (stage 2) */
  profiles?: WorkspaceProfile[];
  activeProfileId?: string;
  /** Renderer language. System follows the current OS locale. */
  locale?: "system" | "en" | "zh-CN";
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

export type BalanceKind = "newapi" | "sub2api";

export type BalanceAccount = {
  id: string;
  name: string;
  type: BalanceKind;
  apiKey: string;
  /** NewAPI dashboard access token (Bearer token for /api/user/self). */
  accessToken?: string;
  /** NewAPI dashboard user id sent as New-Api-User. */
  userId?: string;
  /** Optional explicit balance endpoint for compatible deployments. */
  balanceEndpoint?: string;
  /** 站点根，如 https://api.example.com（不要带 /v1 也可） */
  baseURL?: string;
  enabled?: boolean;
  /** Optional link to a Studio provider card (stage 3). */
  linkedProviderId?: string;
};

/** Normalize imported/provider form data without persisting unsupported modes. */
export function normalizeProviderBalance(
  value: unknown,
): ProviderBalanceConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type === "newapi") {
    return {
      type: "newapi",
      userId: typeof raw.userId === "string" ? raw.userId.trim() : "",
      accessToken:
        typeof raw.accessToken === "string" ? raw.accessToken.trim() : "",
    };
  }
  if (raw.type === "sub2api") return { type: "sub2api" };
  return undefined;
}

export const DEFAULT_PROXY = "127.0.0.1:18080";
export const DEFAULT_BACKEND = "127.0.0.1:18090";
export const MAX_CURSOR_CONTEXT_WINDOW_TOKENS = 2_147_483_647;

export function defaultCursorIntegration(): CursorIntegrationConfig {
  return {
    displayName: [InjectAccountFirstName, InjectAccountLastName]
      .filter(Boolean)
      .join(" "),
    contactEmail: InjectAccountEmail,
    planName: InjectPlanDisplayName,
    defaultContextWindowTokens: DefaultCursorContextWindowTokens,
    avatarUrl: "",
    profileHandle: "",
    website: "https://www.akucb.com",
  };
}

const CURSOR_AVATAR_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
]);

function normalizedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * Cursor's account menu consumes an image URL. Accept a local picker path for
 * convenience, but persist only its canonical file URL. Remote HTTPS image
 * URLs are retained so Cursor can load them directly from the source.
 */
export function normalizeCursorAvatarUrl(value: unknown): string {
  const raw = normalizedText(value, 2048);
  if (!raw) return "";

  try {
    const remote = new URL(raw);
    if (
      remote.protocol === "https:" &&
      remote.hostname &&
      !remote.username &&
      !remote.password
    ) {
      return remote.href;
    }
  } catch {
    // Continue with a local file URL or absolute file path.
  }

  let localPath = "";
  try {
    if (/^file:/i.test(raw)) {
      localPath = fileURLToPath(raw);
    } else if (path.isAbsolute(raw)) {
      localPath = raw;
    } else {
      return "";
    }
  } catch {
    return "";
  }

  if (!CURSOR_AVATAR_EXTENSIONS.has(path.extname(localPath).toLowerCase())) {
    return "";
  }

  try {
    return pathToFileURL(path.resolve(localPath)).href;
  } catch {
    return "";
  }
}

export function normalizeCursorProfileHandle(value: unknown): string {
  const handle = normalizedText(value, 64).replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(handle) ? handle : "";
}

export function normalizeCursorWebsite(value: unknown): string {
  const raw = normalizedText(value, 2048);
  if (!raw) return "";

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.pathname === "/" && !url.search && !url.hash) {
      return `${url.protocol}//${url.host}`;
    }
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeContextWindowTokens(
  value: unknown,
  fallback = DefaultCursorContextWindowTokens,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(MAX_CURSOR_CONTEXT_WINDOW_TOKENS, Math.max(1, Math.floor(numeric)));
}

function repairLegacyQuestionMarkEncoding(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const candidate = value.trim();
  const lossyFallback = Array.from(fallback, (character) =>
    character.codePointAt(0)! > 0x7f ? "?" : character,
  ).join("");
  return lossyFallback !== fallback && candidate === lossyFallback
    ? fallback
    : candidate;
}

export function normalizeCursorIntegration(value: unknown): CursorIntegrationConfig {
  const fallback = defaultCursorIntegration();
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (key: string, fallbackValue: string) => {
    return repairLegacyQuestionMarkEncoding(raw[key], fallbackValue);
  };
  return {
    displayName: text("displayName", fallback.displayName),
    contactEmail:
      typeof raw.contactEmail === "string"
        ? raw.contactEmail.trim()
        : fallback.contactEmail,
    planName: text("planName", fallback.planName),
    defaultContextWindowTokens: normalizeContextWindowTokens(
      raw.defaultContextWindowTokens,
      fallback.defaultContextWindowTokens,
    ),
    avatarUrl: normalizeCursorAvatarUrl(raw.avatarUrl),
    profileHandle: normalizeCursorProfileHandle(raw.profileHandle),
    website: normalizeCursorWebsite(raw.website) || fallback.website,
  };
}

export function cursorIntegrationLabel(value: unknown): string {
  const integration = normalizeCursorIntegration(value);
  return [integration.displayName, integration.planName].filter(Boolean).join(" ");
}

export function cursorDisplayNameParts(value: unknown): {
  firstName: string;
  lastName: string;
} {
  const displayName = normalizeCursorIntegration(value).displayName;
  const parts = displayName.split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || displayName,
    lastName: parts.join(" "),
  };
}

export function defaultAppearance(): AppearanceConfig {
  return {
    // enabled controls optional media; the native acrylic surface remains available.
    enabled: true,
    imagePath: "",
    opacity: 0.2,
    blur: 24,
    windowOpacity: 0.12,
    surfaceOpacity: 0.46,
    sizeModel: "cover",
    blendModel: "auto",
    randomImageFolder: "",
    autoStatus: false,
    autoInterval: 10,
    defaultOnlinePage: "",
    liveApply: true,
  };
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    proxyListenAddr: DEFAULT_PROXY,
    backendListenAddr: DEFAULT_BACKEND,
    routingMode: "local",
    providers: [],
    appearance: defaultAppearance(),
    cursorIntegration: defaultCursorIntegration(),
    injectCursorProxy: false,
    includeCacheWriteInHitRate: false,
    balanceAccounts: [],
    profiles: [],
    activeProfileId: undefined,
    locale: "system",
  };
}

export function normalizeCostMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 1;
  }
  return value;
}

export function normalizeAppLocale(value: unknown): "system" | "en" | "zh-CN" {
  return value === "en" || value === "zh-CN" ? value : "system";
}

export function studioHome(): string {
  const override = process.env.CURSOR_STUDIO_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".cursor-studio");
}

export function configPath(): string {
  return path.join(studioHome(), "config.yaml");
}

export function dataDir(): string {
  return path.join(studioHome(), "data");
}

export function certsDir(): string {
  return path.join(dataDir(), "certs");
}

export function logsDir(): string {
  return path.join(studioHome(), "logs");
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(studioHome(), { recursive: true });
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.mkdir(certsDir(), { recursive: true });
  await fs.mkdir(logsDir(), { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureDirs();
  const file = configPath();
  if (!existsSync(file)) {
    const cfg = defaultConfig();
    await saveConfig(cfg);
    return cfg;
  }
  const text = await fs.readFile(file, "utf8");
  const parsed = YAML.parse(text) as Partial<AppConfig> | null;
  const base = defaultConfig();
  const cursorIntegration = normalizeCursorIntegration(parsed?.cursorIntegration);
  const rawCursorIntegration =
    parsed?.cursorIntegration && typeof parsed.cursorIntegration === "object"
      ? (parsed.cursorIntegration as unknown as Record<string, unknown>)
      : undefined;
  // Migrate older profiles eagerly so the renderer always receives a stable
  // string-shaped profile object, including a canonical file:// avatar URL.
  const cursorProfileMigrationRequired =
    !rawCursorIntegration ||
    rawCursorIntegration.displayName !== cursorIntegration.displayName ||
    rawCursorIntegration.planName !== cursorIntegration.planName ||
    rawCursorIntegration.avatarUrl !== cursorIntegration.avatarUrl ||
    rawCursorIntegration.profileHandle !== cursorIntegration.profileHandle ||
    rawCursorIntegration.website !== cursorIntegration.website ||
    Object.prototype.hasOwnProperty.call(rawCursorIntegration, "organization") ||
    Object.prototype.hasOwnProperty.call(rawCursorIntegration, "teamId");
  const legacy = parsed as Partial<AppConfig> & {
    allowCursorProxyInject?: boolean;
  };
  // 兼容旧配置：丢掉 preset / colorCustomizations 等已废弃字段，并校正枚举
  const rawAppearance = (parsed?.appearance ?? {}) as Record<string, unknown>;
  const {
    preset: _p,
    colorCustomizations: _c,
    customCss: _css,
    editorFontSize: _fs,
    ...appearanceRest
  } = rawAppearance;
  void _p;
  void _c;
  void _css;
  void _fs;

  const mergedAppearance: AppearanceConfig = {
    ...defaultAppearance(),
    ...(appearanceRest as Partial<AppearanceConfig>),
  };
  // 旧 blendModel 值（overlay 等）映射到扩展支持的枚举
  if (!["auto", "multiply", "lighten"].includes(mergedAppearance.blendModel)) {
    mergedAppearance.blendModel = "auto";
  }
  if (typeof mergedAppearance.opacity === "number" && mergedAppearance.opacity > 1) {
    mergedAppearance.opacity = 1;
  }
  mergedAppearance.windowOpacity = Math.min(
    1,
    Math.max(0, Number(mergedAppearance.windowOpacity) || 0),
  );
  mergedAppearance.surfaceOpacity = Math.min(
    1,
    Math.max(0, Number(mergedAppearance.surfaceOpacity) || 0),
  );
  if (mergedAppearance.liveApply !== true) {
    mergedAppearance.liveApply = false;
  }
  // providers 兼容 models 数组 + openAIEndpoint 默认
  const providers = (Array.isArray(parsed?.providers) ? parsed!.providers! : []).map(
    (p) => {
      const ep = normalizeOpenAIEndpoint(p.openAIEndpoint, p.type);
      return {
        ...p,
        models: Array.isArray(p.models) ? p.models : p.modelID ? [p.modelID] : [],
        modelSettings:
          p.modelSettings && typeof p.modelSettings === "object"
            ? p.modelSettings
            : {},
        openAIEndpoint: p.type === "openai" ? ep : undefined,
        costMultiplier: normalizeCostMultiplier(p.costMultiplier),
        reasoningEffort: p.reasoningEffort || "high",
        balance: normalizeProviderBalance(p.balance),
      };
    },
  );

  // 剥离已废弃的 external engine 字段
  const {
    useExternalEngine: _ue,
    externalEnginePath: _ep,
    ...parsedRest
  } = (parsed || {}) as Partial<AppConfig> & {
    useExternalEngine?: boolean;
    externalEnginePath?: string;
  };
  void _ue;
  void _ep;

  let proxyListenAddr =
    String(parsedRest.proxyListenAddr || base.proxyListenAddr).trim() ||
    DEFAULT_PROXY;
  let backendListenAddr =
    String(parsedRest.backendListenAddr || base.backendListenAddr).trim() ||
    DEFAULT_BACKEND;
  const mapLegacyPort = (addr: string): string => {
    const a = addr.replace(/^https?:\/\//, "").trim();
    if (a === "127.0.0.1:28180" || a === "localhost:28180") return DEFAULT_PROXY;
    if (a === "127.0.0.1:28190" || a === "localhost:28190") return DEFAULT_BACKEND;
    return addr;
  };
  proxyListenAddr = mapLegacyPort(proxyListenAddr);
  backendListenAddr = mapLegacyPort(backendListenAddr);

  const cfg: AppConfig = {
    ...base,
    ...parsedRest,
    version: 1,
    proxyListenAddr,
    backendListenAddr,
    providers,
    appearance: mergedAppearance,
    cursorIntegration,
    injectCursorProxy:
      legacy?.injectCursorProxy === true || legacy?.allowCursorProxyInject === true,
    includeCacheWriteInHitRate: parsed?.includeCacheWriteInHitRate === true,
    balanceAccounts: Array.isArray(parsed?.balanceAccounts)
      ? parsed!.balanceAccounts!
      : [],
    profiles: Array.isArray(parsed?.profiles) ? parsed!.profiles! : [],
    activeProfileId:
      typeof parsed?.activeProfileId === "string"
        ? parsed.activeProfileId
        : undefined,
    locale: normalizeAppLocale(parsed?.locale),
  };

  if (
    String(parsed?.proxyListenAddr || "") !== cfg.proxyListenAddr ||
    String(parsed?.backendListenAddr || "") !== cfg.backendListenAddr ||
    !parsed?.cursorIntegration ||
    cursorProfileMigrationRequired
  ) {
    await saveConfig(cfg);
  }

  return cfg;
}

export async function saveConfig(cfg: AppConfig): Promise<AppConfig> {
  await ensureDirs();
  const normalized: AppConfig = {
    ...cfg,
    version: 1,
    cursorIntegration: normalizeCursorIntegration(cfg.cursorIntegration),
    providers: (cfg.providers ?? []).map((p) => ({
      ...p,
      // Provider IDs identify saved records, not their connection settings.
      // A generated ID prevents two newly-created providers from replacing one
      // another when they initially share the same default fields.
      id: p.id?.trim() || genId(),
      enabled: p.enabled !== false,
      models: Array.isArray(p.models)
        ? p.models
        : p.modelID
          ? [p.modelID]
          : [],
      modelSettings:
        p.modelSettings && typeof p.modelSettings === "object"
          ? p.modelSettings
          : {},
      openAIEndpoint:
        p.type === "openai"
          ? normalizeOpenAIEndpoint(p.openAIEndpoint, p.type)
          : undefined,
      costMultiplier: normalizeCostMultiplier(p.costMultiplier),
      reasoningEffort: p.reasoningEffort || "high",
      balance: normalizeProviderBalance(p.balance),
    })),
    balanceAccounts: (cfg.balanceAccounts ?? []).map((a) => ({
      ...a,
      id: a.id || genId().slice(0, 8),
      enabled: a.enabled !== false,
      type: a.type === "sub2api" ? "sub2api" : "newapi",
      accessToken: a.accessToken?.trim() || undefined,
      userId: a.userId?.trim() || undefined,
      balanceEndpoint: a.balanceEndpoint?.trim() || undefined,
    })),
    profiles: Array.isArray(cfg.profiles) ? cfg.profiles : [],
    activeProfileId: cfg.activeProfileId,
    locale: normalizeAppLocale(cfg.locale),
  };
  await fs.writeFile(configPath(), YAML.stringify(normalized), "utf8");
  return normalized;
}

export function normalizeOpenAIEndpoint(
  value: string | undefined,
  type: ProviderType = "openai",
): OpenAIEndpoint {
  if (type !== "openai") return "/v1/chat/completions";
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "/v1/responses" || v === "responses" || v.endsWith("/responses")) {
    return "/v1/responses";
  }
  return "/v1/chat/completions";
}

export function newProvider(partial?: Partial<ModelProvider>): ModelProvider {
  const type = partial?.type ?? "openai";
  const p: ModelProvider = {
    id: partial?.id?.trim() || genId(),
    displayName: partial?.displayName ?? "My Provider",
    type,
    baseURL: partial?.baseURL ?? "https://api.openai.com/v1",
    apiKey: partial?.apiKey ?? "",
    modelID: partial?.modelID ?? "",
    models: partial?.models ?? [],
    modelSettings: partial?.modelSettings ?? {},
    enabled: partial?.enabled ?? true,
    contextWindowTokens: partial?.contextWindowTokens,
    maxCompletionTokens: partial?.maxCompletionTokens,
    reasoningEffort: partial?.reasoningEffort ?? "high",
    openAIEndpoint:
      type === "openai"
        ? normalizeOpenAIEndpoint(partial?.openAIEndpoint, type)
        : undefined,
    costMultiplier: normalizeCostMultiplier(partial?.costMultiplier),
    failoverPriority: partial?.failoverPriority,
    balance: normalizeProviderBalance(partial?.balance),
  };
  return p;
}

export function genId(): string {
  return randomUUID();
}
