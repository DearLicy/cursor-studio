/**
 * models.dev pricing catalog.
 *
 * The catalog is refreshed at most once per day and persisted locally so usage
 * collection stays useful when the machine is temporarily offline.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { studioHome, type ModelProvider } from "../config/store";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

type RawCost = {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tiers?: unknown;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  cost?: RawCost;
};

type RawProvider = {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  models?: Record<string, RawModel>;
};

export type ModelsDevPricingTier = {
  contextThreshold?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type ModelsDevPricingEntry = {
  providerId: string;
  providerName: string;
  providerApiHost?: string;
  modelId: string;
  normalizedModelId: string;
  normalizedFullModelId: string;
  /** Canonical `provider/model` identifier used for strict routed-model matching. */
  normalizedProviderModelId: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  tiers?: ModelsDevPricingTier[];
};

export type ModelsDevPricingCatalog = {
  version: typeof CACHE_VERSION;
  source: "models.dev";
  fetchedAt: string;
  entries: ModelsDevPricingEntry[];
};

export type ModelsDevPricingStatus = {
  source: "models.dev";
  state: "ready" | "stale" | "empty";
  updatedAt?: string;
  catalogEntries: number;
  lastError?: string;
};

export type ModelsDevResolvedPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  catalogProviderId: string;
  catalogModelId: string;
  catalogUpdatedAt: string;
  tierThreshold?: number;
  cacheReadDerived: boolean;
  cacheWriteDerived: boolean;
};

let memoryCatalog: ModelsDevPricingCatalog | null = null;
let readPromise: Promise<ModelsDevPricingCatalog | null> | null = null;
let refreshPromise: Promise<ModelsDevPricingCatalog | null> | null = null;
let lastRefreshError: string | undefined;

function cacheDir(): string {
  return path.join(studioHome(), "cache");
}

export function modelsDevPricingCachePath(): string {
  return path.join(cacheDir(), "models-dev-pricing.json");
}

function finitePrice(value: unknown): number | undefined {
  const price = typeof value === "number" ? value : Number(value);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function normalizeProviderKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Mirrors models.dev / 桌面工作区 normalization for routed model IDs. */
export function normalizeModelIdForPricing(modelID: string | undefined): string {
  const input = (modelID || "").trim();
  const afterSlash = input.slice(input.lastIndexOf("/") + 1);
  const beforeColon = afterSlash.split(":", 1)[0] || "";
  let normalized = beforeColon.replace(/@/g, "-").toLowerCase().trim();
  if (normalized.endsWith("[1m]")) {
    normalized = normalized.slice(0, -"[1m]".length).trim();
  }
  return normalized;
}

function normalizeFullModelId(modelID: string | undefined): string {
  const input = (modelID || "").trim();
  const beforeColon = input.split(":", 1)[0] || "";
  let normalized = beforeColon.replace(/@/g, "-").toLowerCase().trim();
  if (normalized.endsWith("[1m]")) {
    normalized = normalized.slice(0, -"[1m]".length).trim();
  }
  return normalized;
}

function normalizeProviderModelId(providerId: string, modelId: string): string {
  const provider = normalizeFullModelId(providerId).replace(/^\/+|\/+$/g, "");
  const model = normalizeFullModelId(modelId).replace(/^\/+/, "");
  if (!model) return "";
  if (!provider || model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

function hostFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isCatalog(value: unknown): value is ModelsDevPricingCatalog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelsDevPricingCatalog>;
  return (
    candidate.version === CACHE_VERSION &&
    candidate.source === "models.dev" &&
    typeof candidate.fetchedAt === "string" &&
    Array.isArray(candidate.entries)
  );
}

function isStale(catalog: ModelsDevPricingCatalog | null): boolean {
  const time = catalog ? Date.parse(catalog.fetchedAt) : Number.NaN;
  return !Number.isFinite(time) || Date.now() - time >= CACHE_TTL_MS;
}

function parseTier(value: unknown): ModelsDevPricingTier | null {
  if (!value || typeof value !== "object") return null;
  const tier = value as {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
    tier?: { type?: unknown; size?: unknown };
  };
  const contextThreshold =
    tier.tier?.type === "context" ? finitePrice(tier.tier.size) : undefined;
  const inputPerMillion = finitePrice(tier.input);
  const outputPerMillion = finitePrice(tier.output);
  const cacheReadPerMillion = finitePrice(tier.cache_read);
  const cacheWritePerMillion = finitePrice(tier.cache_write);
  if (
    contextThreshold === undefined &&
    inputPerMillion === undefined &&
    outputPerMillion === undefined &&
    cacheReadPerMillion === undefined &&
    cacheWritePerMillion === undefined
  ) {
    return null;
  }
  return {
    contextThreshold,
    inputPerMillion,
    outputPerMillion,
    cacheReadPerMillion,
    cacheWritePerMillion,
  };
}

/** Converts the public API into a compact, local lookup catalog. */
export function buildModelsDevPricingCatalog(
  value: unknown,
  fetchedAt = new Date().toISOString(),
): ModelsDevPricingCatalog {
  const raw = value && typeof value === "object" ? (value as Record<string, RawProvider>) : {};
  const entries: ModelsDevPricingEntry[] = [];

  for (const [providerKey, provider] of Object.entries(raw)) {
    if (!provider || typeof provider !== "object") continue;
    const providerId =
      typeof provider.id === "string" && provider.id.trim() ? provider.id.trim() : providerKey;
    const providerName =
      typeof provider.name === "string" && provider.name.trim()
        ? provider.name.trim()
        : providerId;
    const providerApiHost = hostFromUrl(provider.api);

    for (const [modelKey, model] of Object.entries(provider.models || {})) {
      if (!model || typeof model !== "object") continue;
      const modelId =
        typeof model.id === "string" && model.id.trim() ? model.id.trim() : modelKey;
      const cost = model.cost || {};
      const inputPerMillion = finitePrice(cost.input);
      const outputPerMillion = finitePrice(cost.output);
      const cacheReadPerMillion = finitePrice(cost.cache_read);
      const cacheWritePerMillion = finitePrice(cost.cache_write);
      const tiers = Array.isArray(cost.tiers)
        ? cost.tiers.map(parseTier).filter((tier): tier is ModelsDevPricingTier => Boolean(tier))
        : [];

      if (
        inputPerMillion === undefined &&
        outputPerMillion === undefined &&
        cacheReadPerMillion === undefined &&
        cacheWritePerMillion === undefined &&
        tiers.length === 0
      ) {
        continue;
      }

      const normalizedModelId = normalizeModelIdForPricing(modelId);
      if (!normalizedModelId) continue;
      entries.push({
        providerId,
        providerName,
        providerApiHost,
        modelId,
        normalizedModelId,
        normalizedFullModelId: normalizeFullModelId(modelId),
        normalizedProviderModelId: normalizeProviderModelId(providerId, modelId),
        inputPerMillion,
        outputPerMillion,
        cacheReadPerMillion,
        cacheWritePerMillion,
        ...(tiers.length ? { tiers } : {}),
      });
    }
  }

  entries.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId),
  );
  return { version: CACHE_VERSION, source: "models.dev", fetchedAt, entries };
}

async function readCatalog(): Promise<ModelsDevPricingCatalog | null> {
  if (memoryCatalog) return memoryCatalog;
  if (readPromise) return readPromise;
  readPromise = (async () => {
    const cachePath = modelsDevPricingCachePath();
    if (!existsSync(cachePath)) return null;
    try {
      const text = await fs.readFile(cachePath, "utf8");
      const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const parsed = JSON.parse(withoutBom) as unknown;
      if (!isCatalog(parsed)) return null;
      memoryCatalog = parsed;
      return parsed;
    } catch {
      return null;
    }
  })().finally(() => {
    readPromise = null;
  });
  return readPromise;
}

async function writeCatalog(catalog: ModelsDevPricingCatalog): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(modelsDevPricingCachePath(), JSON.stringify(catalog), "utf8");
}

function statusFromCatalog(catalog: ModelsDevPricingCatalog | null): ModelsDevPricingStatus {
  if (!catalog) {
    return {
      source: "models.dev",
      state: "empty",
      catalogEntries: 0,
      ...(lastRefreshError ? { lastError: lastRefreshError } : {}),
    };
  }
  return {
    source: "models.dev",
    state: isStale(catalog) ? "stale" : "ready",
    updatedAt: catalog.fetchedAt,
    catalogEntries: catalog.entries.length,
    ...(lastRefreshError ? { lastError: lastRefreshError } : {}),
  };
}

async function downloadCatalog(): Promise<ModelsDevPricingCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`models.dev returned HTTP ${response.status}`);
    }
    return buildModelsDevPricingCatalog(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

/** Explicit refresh used by the desktop action. A stale local cache remains usable on failure. */
export async function refreshModelsDevPricing(): Promise<ModelsDevPricingStatus> {
  if (process.env.CURSOR_STUDIO_PRICING_OFFLINE === "1") {
    return statusFromCatalog(await readCatalog());
  }
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const catalog = await downloadCatalog();
        memoryCatalog = catalog;
        lastRefreshError = undefined;
        await writeCatalog(catalog);
        return catalog;
      } catch (error) {
        lastRefreshError = error instanceof Error ? error.message : String(error);
        return readCatalog();
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return statusFromCatalog(await refreshPromise);
}

export async function getModelsDevPricingStatus(): Promise<ModelsDevPricingStatus> {
  return statusFromCatalog(await readCatalog());
}

async function catalogForLookup(): Promise<ModelsDevPricingCatalog | null> {
  const cached = await readCatalog();
  if (cached && !isStale(cached)) return cached;
  if (process.env.CURSOR_STUDIO_PRICING_OFFLINE === "1") return cached;
  await refreshModelsDevPricing();
  return readCatalog();
}

const KNOWN_BASE_URL_PROVIDER_IDS: Record<string, string[]> = {
  "api.openai.com": ["openai"],
  "api.anthropic.com": ["anthropic"],
  "generativelanguage.googleapis.com": ["google"],
  "aiplatform.googleapis.com": ["google-vertex"],
  "api.x.ai": ["xai"],
  "api.deepseek.com": ["deepseek"],
  "api.z.ai": ["zai"],
  "open.bigmodel.cn": ["zai"],
  "api.groq.com": ["groq"],
  "api.mistral.ai": ["mistral"],
  "api.together.xyz": ["togetherai"],
  "api.fireworks.ai": ["fireworks-ai"],
  "openrouter.ai": ["openrouter"],
  "api.perplexity.ai": ["perplexity"],
  "api.cerebras.ai": ["cerebras"],
  "api.cohere.ai": ["cohere"],
};

/**
 * A bare model ID can appear under several relay providers in models.dev.
 * These are the direct model owners used only after explicit provider hints
 * and before giving up on an otherwise ambiguous suffix match.
 */
const CANONICAL_PROVIDER_BY_MODEL_PREFIX: Array<{
  pattern: RegExp;
  providerIds: string[];
}> = [
  { pattern: /^grok(?:[-.]|$)/, providerIds: ["xai"] },
  { pattern: /^(?:gpt|o[1-9])(?:[-.]|$)/, providerIds: ["openai"] },
  { pattern: /^claude(?:[-.]|$)/, providerIds: ["anthropic"] },
  { pattern: /^gemini(?:[-.]|$)/, providerIds: ["google", "google-vertex"] },
  { pattern: /^deepseek(?:[-.]|$)/, providerIds: ["deepseek"] },
  { pattern: /^(?:mistral|codestral|ministral)(?:[-.]|$)/, providerIds: ["mistral"] },
  { pattern: /^command(?:[-.]|$)/, providerIds: ["cohere"] },
];

function catalogProviderModelId(entry: ModelsDevPricingEntry): string {
  return entry.normalizedProviderModelId || normalizeProviderModelId(entry.providerId, entry.modelId);
}

function uniqueEntry(entries: ModelsDevPricingEntry[]): ModelsDevPricingEntry | undefined {
  return entries.length === 1 ? entries[0] : undefined;
}

function canonicalOwnerCandidates(
  entries: ModelsDevPricingEntry[],
  normalizedModelId: string,
): ModelsDevPricingEntry[] {
  const owner = CANONICAL_PROVIDER_BY_MODEL_PREFIX.find(({ pattern }) => pattern.test(normalizedModelId));
  if (!owner) return [];
  return entries.filter((entry) => owner.providerIds.includes(entry.providerId));
}

function providerHints(
  catalog: ModelsDevPricingCatalog,
  provider: ModelProvider | undefined,
  modelID: string,
): Set<string> {
  const hints = new Set<string>();
  const providers = new Map<string, { id: string; name: string; apiHost?: string }>();
  for (const entry of catalog.entries) {
    if (!providers.has(entry.providerId)) {
      providers.set(entry.providerId, {
        id: entry.providerId,
        name: entry.providerName,
        apiHost: entry.providerApiHost,
      });
    }
  }

  const addByKey = (value: string | undefined) => {
    const normalized = normalizeProviderKey(value);
    if (!normalized) return;
    for (const item of providers.values()) {
      if (
        normalizeProviderKey(item.id) === normalized ||
        normalizeProviderKey(item.name) === normalized
      ) {
        hints.add(item.id);
      }
    }
  };

  const prefix = modelID.split("/", 1)[0];
  if (modelID.includes("/")) addByKey(prefix);
  addByKey(provider?.displayName);
  addByKey(provider?.id);

  const configuredHost = hostFromUrl(provider?.baseURL);
  if (configuredHost) {
    for (const item of providers.values()) {
      if (item.apiHost === configuredHost) hints.add(item.id);
    }
    for (const providerId of KNOWN_BASE_URL_PROVIDER_IDS[configuredHost] || []) {
      if (providers.has(providerId)) hints.add(providerId);
    }
  }
  return hints;
}

function chooseTier(entry: ModelsDevPricingEntry, promptTokens: number): ModelsDevPricingTier | undefined {
  const eligible = (entry.tiers || [])
    .filter(
      (tier) =>
        tier.contextThreshold !== undefined && promptTokens > Math.max(0, tier.contextThreshold),
    )
    .sort((a, b) => (b.contextThreshold || 0) - (a.contextThreshold || 0));
  return eligible[0];
}

/** Pure resolver, exported for fixture-based tests. */
export function resolveModelsDevCatalogPrice(
  catalog: ModelsDevPricingCatalog,
  provider: ModelProvider | undefined,
  modelID: string | undefined,
  promptTokens = 0,
): ModelsDevResolvedPrice | undefined {
  if (!modelID?.trim()) return undefined;
  const normalizedModelId = normalizeModelIdForPricing(modelID);
  const normalizedFullModelId = normalizeFullModelId(modelID);
  if (!normalizedModelId) return undefined;

  const suffixCandidates = catalog.entries.filter(
    (entry) => entry.normalizedModelId === normalizedModelId,
  );
  if (!suffixCandidates.length) return undefined;

  const hints = providerHints(catalog, provider, modelID);
  const hasProviderPrefix = normalizedFullModelId.includes("/");
  const routedCandidates = hasProviderPrefix
    ? catalog.entries.filter((entry) => catalogProviderModelId(entry) === normalizedFullModelId)
    : [];
  // Some old cache entries predate normalizedProviderModelId. The raw full ID
  // remains a useful strict fallback when it is unambiguous.
  const rawFullCandidates = hasProviderPrefix && routedCandidates.length === 0
    ? catalog.entries.filter((entry) => entry.normalizedFullModelId === normalizedFullModelId)
    : [];
  const exactCandidates = routedCandidates.length ? routedCandidates : rawFullCandidates;
  const hintedExact = exactCandidates.filter((entry) => hints.has(entry.providerId));
  const hintedSuffix = suffixCandidates.filter((entry) => hints.has(entry.providerId));
  const preferredSuffix = canonicalOwnerCandidates(suffixCandidates, normalizedModelId);

  // Strict `provider/model` IDs always win. A bare model ID falls through to
  // provider hints, then known direct model owners, then a unique suffix match.
  const selected =
    uniqueEntry(hintedExact) ??
    uniqueEntry(exactCandidates) ??
    uniqueEntry(hintedSuffix) ??
    uniqueEntry(preferredSuffix) ??
    uniqueEntry(suffixCandidates);
  if (!selected) return undefined;

  const tier = chooseTier(selected, Math.max(0, promptTokens));
  const inputPerMillion = tier?.inputPerMillion ?? selected.inputPerMillion ?? 0;
  const outputPerMillion = tier?.outputPerMillion ?? selected.outputPerMillion ?? 0;
  const explicitCacheRead = tier?.cacheReadPerMillion ?? selected.cacheReadPerMillion;
  const explicitCacheWrite = tier?.cacheWritePerMillion ?? selected.cacheWritePerMillion;
  return {
    inputPerMillion,
    outputPerMillion,
    cacheReadPerMillion: explicitCacheRead ?? inputPerMillion,
    cacheWritePerMillion: explicitCacheWrite ?? inputPerMillion,
    catalogProviderId: selected.providerId,
    catalogModelId: selected.modelId,
    catalogUpdatedAt: catalog.fetchedAt,
    ...(tier?.contextThreshold !== undefined
      ? { tierThreshold: tier.contextThreshold }
      : {}),
    cacheReadDerived: explicitCacheRead === undefined,
    cacheWriteDerived: explicitCacheWrite === undefined,
  };
}

/** Resolves a live request against the cached catalog, refreshing it when needed. */
export async function resolveModelsDevPrice(
  provider: ModelProvider | undefined,
  modelID: string | undefined,
  promptTokens = 0,
): Promise<ModelsDevResolvedPrice | undefined> {
  const catalog = await catalogForLookup();
  return catalog
    ? resolveModelsDevCatalogPrice(catalog, provider, modelID, promptTokens)
    : undefined;
}
