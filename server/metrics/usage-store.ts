/**
 * 本地协议实现。
 * 落盘：~/.cursor-studio/history/usage.json
 *
 * Stage 3: query filters, price snapshot, CSV export, cost uses model/provider price.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  studioHome,
  loadConfig,
  saveConfig,
  type ModelProvider,
  type ModelSettings,
} from "../config/store";
import {
  getModelsDevPricingStatus,
  refreshModelsDevPricing,
  resolveModelsDevPrice,
  type ModelsDevPricingStatus,
  type ModelsDevResolvedPrice,
} from "./model-pricing";

export type HomeMetricsSummary = {
  turnsTotal: number;
  validTurnsTotal: number;
  invalidTurnsTotal: number;
  requestTokensTotal: number;
  promptTokensTotal: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  includeCacheWriteInHitRate: boolean;
  estimatedCostUsd: number;
  updatedAt?: string;
  pricing: ModelsDevPricingStatus;
};

export type PriceSnapshot = {
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

export type RequestLogItem = {
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
  /** Cost is always estimated from snapshot unless future real billing is added. */
  costEstimated?: boolean;
  priceSnapshot?: PriceSnapshot;
  error?: string;
  requestId?: string;
};

export type UsageQuery = {
  from?: string;
  to?: string;
  providerId?: string;
  modelID?: string;
  source?: "ide" | "agent" | "unknown" | "all";
  valid?: "all" | "valid" | "invalid";
  q?: string;
  limit?: number;
};

export type UsageQueryResult = {
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
};

type UsageFile = {
  version: 1;
  totals: {
    turnsTotal: number;
    validTurnsTotal: number;
    invalidTurnsTotal: number;
    requestTokensTotal: number;
    promptTokensTotal: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd?: number;
  };
  logs: RequestLogItem[];
  updatedAt?: string;
};

export const DEFAULT_PRICE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function historyDir(): string {
  return path.join(studioHome(), "history");
}

export function usageFilePath(): string {
  return path.join(historyDir(), "usage.json");
}

function emptyTotals(): UsageFile["totals"] {
  return {
    turnsTotal: 0,
    validTurnsTotal: 0,
    invalidTurnsTotal: 0,
    requestTokensTotal: 0,
    promptTokensTotal: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: undefined,
  };
}

export type PriceTable = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function estimateCost(
  input: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  price: PriceTable = DEFAULT_PRICE,
): number {
  const nonCache = Math.max(
    0,
    input.promptTokens - input.cacheReadTokens - input.cacheWriteTokens,
  );
  return (
    (nonCache / 1e6) * price.input +
    (input.completionTokens / 1e6) * price.output +
    (input.cacheReadTokens / 1e6) * price.cacheRead +
    (input.cacheWriteTokens / 1e6) * price.cacheWrite
  );
}

export function resolvePriceSnapshot(
  provider: ModelProvider | undefined,
  modelID?: string,
): PriceSnapshot {
  const modelSettings: ModelSettings | undefined =
    provider && modelID ? provider.modelSettings?.[modelID] : undefined;
  const hasModel =
    modelSettings &&
    (modelSettings.inputCostPerMillion != null ||
      modelSettings.outputCostPerMillion != null ||
      modelSettings.cacheReadCostPerMillion != null ||
      modelSettings.cacheWriteCostPerMillion != null);

  // Provider-level overrides (optional fields stored on provider via modelSettings["*"] or future fields)
  const providerDefaults = provider?.modelSettings?.["*"];

  if (hasModel) {
    return {
      inputPerMillion:
        modelSettings?.inputCostPerMillion ??
        providerDefaults?.inputCostPerMillion ??
        DEFAULT_PRICE.input,
      outputPerMillion:
        modelSettings?.outputCostPerMillion ??
        providerDefaults?.outputCostPerMillion ??
        DEFAULT_PRICE.output,
      cacheReadPerMillion:
        modelSettings?.cacheReadCostPerMillion ??
        providerDefaults?.cacheReadCostPerMillion ??
        DEFAULT_PRICE.cacheRead,
      cacheWritePerMillion:
        modelSettings?.cacheWriteCostPerMillion ??
        providerDefaults?.cacheWriteCostPerMillion ??
        DEFAULT_PRICE.cacheWrite,
      source: "model",
    };
  }

  if (
    providerDefaults &&
    (providerDefaults.inputCostPerMillion != null ||
      providerDefaults.outputCostPerMillion != null ||
      providerDefaults.cacheReadCostPerMillion != null ||
      providerDefaults.cacheWriteCostPerMillion != null)
  ) {
    return {
      inputPerMillion:
        providerDefaults.inputCostPerMillion ?? DEFAULT_PRICE.input,
      outputPerMillion:
        providerDefaults.outputCostPerMillion ?? DEFAULT_PRICE.output,
      cacheReadPerMillion:
        providerDefaults.cacheReadCostPerMillion ?? DEFAULT_PRICE.cacheRead,
      cacheWritePerMillion:
        providerDefaults.cacheWriteCostPerMillion ?? DEFAULT_PRICE.cacheWrite,
      source: "provider",
    };
  }

  return {
    inputPerMillion: DEFAULT_PRICE.input,
    outputPerMillion: DEFAULT_PRICE.output,
    cacheReadPerMillion: DEFAULT_PRICE.cacheRead,
    cacheWritePerMillion: DEFAULT_PRICE.cacheWrite,
    source: "unavailable",
  };
}

function snapshotFromModelsDev(price: ModelsDevResolvedPrice): PriceSnapshot {
  return {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    source: "models-dev",
    catalogProviderId: price.catalogProviderId,
    catalogModelId: price.catalogModelId,
    catalogUpdatedAt: price.catalogUpdatedAt,
    tierThreshold: price.tierThreshold,
    cacheReadDerived: price.cacheReadDerived,
    cacheWriteDerived: price.cacheWriteDerived,
  };
}

async function resolveRecordedPriceSnapshot(
  provider: ModelProvider | undefined,
  modelID: string | undefined,
  promptTokens: number,
): Promise<PriceSnapshot> {
  const catalogPrice = await resolveModelsDevPrice(provider, modelID, promptTokens);
  if (catalogPrice) return snapshotFromModelsDev(catalogPrice);
  return resolvePriceSnapshot(provider, modelID);
}

function priceTableFromSnapshot(snapshot: PriceSnapshot): PriceTable {
  return {
    input: snapshot.inputPerMillion,
    output: snapshot.outputPerMillion,
    cacheRead: snapshot.cacheReadPerMillion,
    cacheWrite: snapshot.cacheWritePerMillion,
  };
}

async function readUsageFile(): Promise<UsageFile> {
  const p = usageFilePath();
  if (!existsSync(p)) {
    return { version: 1, totals: emptyTotals(), logs: [] };
  }
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as Partial<UsageFile>;
    return {
      version: 1,
      totals: { ...emptyTotals(), ...(raw.totals || {}) },
      logs: Array.isArray(raw.logs) ? raw.logs : [],
      updatedAt: raw.updatedAt,
    };
  } catch {
    return { version: 1, totals: emptyTotals(), logs: [] };
  }
}

async function writeUsageFile(file: UsageFile): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });
  const next = {
    ...file,
    version: 1 as const,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(usageFilePath(), JSON.stringify(next, null, 2), "utf8");
}

function sumCostFromTotals(t: UsageFile["totals"]): number {
  if (Number.isFinite(t.estimatedCostUsd))
    return Math.max(0, t.estimatedCostUsd || 0);
  const prompt = t.promptTokensTotal || 0;
  const request = t.requestTokensTotal || 0;
  const cacheRead = t.cacheReadTokens || 0;
  const cacheWrite = t.cacheWriteTokens || 0;
  const completion = Math.max(0, request - prompt);
  return estimateCost({
    promptTokens: prompt,
    completionTokens: completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
}

export async function getHomeMetricsSummary(): Promise<HomeMetricsSummary> {
  const [file, cfg, pricing] = await Promise.all([
    readUsageFile(),
    loadConfig(),
    getModelsDevPricingStatus(),
  ]);
  const t = file.totals;
  return {
    turnsTotal: t.turnsTotal || 0,
    validTurnsTotal: t.validTurnsTotal || 0,
    invalidTurnsTotal: t.invalidTurnsTotal || 0,
    requestTokensTotal: t.requestTokensTotal || 0,
    promptTokensTotal: t.promptTokensTotal || 0,
    cacheReadTokens: t.cacheReadTokens || 0,
    cacheWriteTokens: t.cacheWriteTokens || 0,
    includeCacheWriteInHitRate: cfg.includeCacheWriteInHitRate === true,
    estimatedCostUsd: sumCostFromTotals(t),
    updatedAt: file.updatedAt,
    pricing,
  };
}

/** 本地日历「今日」token 合计（requestTokens） */
export async function getTodayTokenUsage(): Promise<{
  tokens: number;
  date: string;
}> {
  const file = await readUsageFile();
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const start = new Date(y, m, d).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  let tokens = 0;
  for (const log of file.logs || []) {
    const t = Date.parse(log.at);
    if (!Number.isFinite(t)) continue;
    if (t >= start && t < end) tokens += Math.max(0, log.requestTokens || 0);
  }
  const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { tokens, date };
}

/**
 * 用量单位：
 * <1k 原样 · ≥1k k · ≥1w(万) w · ≥1m m · ≥1亿 亿
 */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  const fmt = (num: number, unit: string) => {
    const s =
      num >= 100 ? num.toFixed(0) : num >= 10 ? num.toFixed(1) : num.toFixed(2);
    return `${s.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")}${unit}`;
  };
  if (v < 10_000) return fmt(v / 1000, "k");
  if (v < 1_000_000) return fmt(v / 10_000, "w");
  if (v < 100_000_000) return fmt(v / 1_000_000, "m");
  return fmt(v / 100_000_000, "亿");
}

export async function listRequestLogs(limit = 100): Promise<{
  logs: RequestLogItem[];
  totals: UsageFile["totals"];
  estimatedCostUsd: number;
}> {
  const file = await readUsageFile();
  return {
    logs: file.logs.slice(0, limit),
    totals: file.totals,
    estimatedCostUsd: sumCostFromTotals(file.totals),
  };
}

function matchLog(item: RequestLogItem, query: UsageQuery): boolean {
  if (query.from) {
    const from = Date.parse(query.from);
    const at = Date.parse(item.at);
    if (Number.isFinite(from) && Number.isFinite(at) && at < from) return false;
  }
  if (query.to) {
    const to = Date.parse(query.to);
    const at = Date.parse(item.at);
    if (Number.isFinite(to) && Number.isFinite(at) && at > to) return false;
  }
  if (query.providerId && query.providerId !== "all") {
    if (item.providerId !== query.providerId) return false;
  }
  if (query.modelID && query.modelID !== "all") {
    if (item.modelID !== query.modelID) return false;
  }
  if (query.source && query.source !== "all") {
    const src = item.source || "unknown";
    if (src !== query.source) return false;
  }
  if (query.valid === "valid" && !item.valid) return false;
  if (query.valid === "invalid" && item.valid) return false;
  if (query.q?.trim()) {
    const needle = query.q.trim().toLowerCase();
    const hay = `${item.providerId || ""} ${item.modelID || ""} ${item.error || ""} ${item.requestId || ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export async function queryUsage(query: UsageQuery = {}): Promise<UsageQueryResult> {
  const [file, cfg] = await Promise.all([readUsageFile(), loadConfig()]);
  const includeCacheWrite = cfg.includeCacheWriteInHitRate === true;
  const matched = (file.logs || []).filter((item) => matchLog(item, query));
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const logs = matched.slice(0, limit);

  let requestTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let valid = 0;
  let invalid = 0;

  const byProvider = new Map<
    string,
    { name: string; requests: number; tokens: number; costUsd: number; errors: number }
  >();
  const byModel = new Map<
    string,
    { name: string; requests: number; tokens: number; costUsd: number }
  >();

  for (const item of matched) {
    requestTokens += item.requestTokens || 0;
    promptTokens += item.promptTokens || 0;
    completionTokens += item.completionTokens || 0;
    cacheReadTokens += item.cacheReadTokens || 0;
    cacheWriteTokens += item.cacheWriteTokens || 0;
    costUsd += item.costUsd || 0;
    if (item.valid) valid += 1;
    else invalid += 1;

    const pName = item.providerId || "未标记供应商";
    const pRow = byProvider.get(pName) || {
      name: pName,
      requests: 0,
      tokens: 0,
      costUsd: 0,
      errors: 0,
    };
    pRow.requests += 1;
    pRow.tokens += item.requestTokens || 0;
    pRow.costUsd += item.costUsd || 0;
    if (!item.valid) pRow.errors += 1;
    byProvider.set(pName, pRow);

    const mName = item.modelID || "未标记模型";
    const mRow = byModel.get(mName) || {
      name: mName,
      requests: 0,
      tokens: 0,
      costUsd: 0,
    };
    mRow.requests += 1;
    mRow.tokens += item.requestTokens || 0;
    mRow.costUsd += item.costUsd || 0;
    byModel.set(mName, mRow);
  }

  // cache hit rate: cacheRead / prompt (or cacheRead+cacheWrite when includeCacheWrite)
  const hitDenom = includeCacheWrite
    ? Math.max(1, cacheReadTokens + cacheWriteTokens)
    : Math.max(1, promptTokens || requestTokens);
  const cacheHitRate = Math.min(1, cacheReadTokens / hitDenom);

  return {
    logs,
    totalMatched: matched.length,
    summary: {
      requests: matched.length,
      valid,
      invalid,
      requestTokens,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      cacheHitRate,
    },
    byProvider: [...byProvider.values()].sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

export async function exportUsageCsv(query: UsageQuery = {}): Promise<string> {
  const result = await queryUsage({ ...query, limit: 1000 });
  const header = [
    "time",
    "valid",
    "source",
    "provider",
    "model",
    "request_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cache_read",
    "cache_write",
    "cost_usd",
    "cost_estimated",
    "price_source",
    "catalog_provider",
    "catalog_model",
    "input_per_m",
    "output_per_m",
    "error",
    "request_id",
  ];
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = result.logs.map((row) =>
    [
      row.at,
      row.valid ? "1" : "0",
      row.source || "",
      row.providerId || "",
      row.modelID || "",
      row.requestTokens,
      row.promptTokens,
      row.completionTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.costUsd,
      row.costEstimated === false ? "0" : "1",
      row.priceSnapshot?.source || "",
      row.priceSnapshot?.catalogProviderId || "",
      row.priceSnapshot?.catalogModelId || "",
      row.priceSnapshot?.inputPerMillion ?? "",
      row.priceSnapshot?.outputPerMillion ?? "",
      row.error || "",
      row.requestId || "",
    ]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export async function setIncludeCacheWriteInHitRate(
  value: boolean,
): Promise<HomeMetricsSummary> {
  const cfg = await loadConfig();
  cfg.includeCacheWriteInHitRate = Boolean(value);
  await saveConfig(cfg);
  return getHomeMetricsSummary();
}

/** 引擎在完成一轮请求后调用 */
export async function recordTurnUsage(input: {
  valid: boolean;
  requestTokens?: number;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  providerId?: string;
  modelID?: string;
  error?: string;
  source?: "ide" | "agent" | "unknown";
  requestId?: string;
}): Promise<HomeMetricsSummary> {
  const [file, cfg] = await Promise.all([readUsageFile(), loadConfig()]);
  const t = file.totals;
  t.turnsTotal += 1;
  if (input.valid) t.validTurnsTotal += 1;
  else t.invalidTurnsTotal += 1;

  const requestTokens = Math.max(0, Math.round(input.requestTokens || 0));
  const promptTokens = Math.max(0, Math.round(input.promptTokens || 0));
  const cacheReadTokens = Math.max(0, Math.round(input.cacheReadTokens || 0));
  const cacheWriteTokens = Math.max(0, Math.round(input.cacheWriteTokens || 0));
  const completionTokens = Math.max(0, requestTokens - promptTokens);

  t.requestTokensTotal += requestTokens;
  t.promptTokensTotal += promptTokens;
  t.cacheReadTokens += cacheReadTokens;
  t.cacheWriteTokens += cacheWriteTokens;

  const provider = cfg.providers.find((item) => item.id === input.providerId);
  const snapshot = await resolveRecordedPriceSnapshot(
    provider,
    input.modelID,
    promptTokens,
  );
  const costUsd =
    snapshot.source === "unavailable"
      ? 0
      : estimateCost(
          {
            promptTokens,
            completionTokens,
            cacheReadTokens,
            cacheWriteTokens,
          },
          priceTableFromSnapshot(snapshot),
        );
  const previousCost = Number.isFinite(t.estimatedCostUsd)
    ? Math.max(0, t.estimatedCostUsd || 0)
    : sumCostFromTotals(t);
  t.estimatedCostUsd = previousCost + costUsd;

  const log: RequestLogItem = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    valid: input.valid,
    source: input.source || "unknown",
    providerId: input.providerId,
    modelID: input.modelID,
    requestTokens,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    costEstimated: snapshot.source !== "unavailable",
    priceSnapshot: snapshot,
    error: input.error,
    requestId: input.requestId,
  };
  file.logs = [log, ...(file.logs || [])].slice(0, 500);

  await writeUsageFile(file);
  return getHomeMetricsSummary();
}

export type UsagePricingRefreshResult = {
  pricing: ModelsDevPricingStatus;
  updatedRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
  catalogMatchedModels: number;
  unmatchedModels: number;
};

/** Refreshes models.dev once, then recalculates every retained request log. */
export async function refreshUsagePricing(): Promise<UsagePricingRefreshResult> {
  const pricing = await refreshModelsDevPricing();
  const [file, cfg] = await Promise.all([readUsageFile(), loadConfig()]);
  const catalogMatchedModels = new Set<string>();
  const unmatchedModels = new Set<string>();
  let pricedRequests = 0;
  let unpricedRequests = 0;

  for (const log of file.logs) {
    const provider = cfg.providers.find((item) => item.id === log.providerId);
    const snapshot = await resolveRecordedPriceSnapshot(
      provider,
      log.modelID,
      log.promptTokens,
    );
    const costUsd =
      snapshot.source === "unavailable"
        ? 0
        : estimateCost(
            {
              promptTokens: log.promptTokens,
              completionTokens: log.completionTokens,
              cacheReadTokens: log.cacheReadTokens,
              cacheWriteTokens: log.cacheWriteTokens,
            },
            priceTableFromSnapshot(snapshot),
          );

    log.priceSnapshot = snapshot;
    log.costUsd = costUsd;
    log.costEstimated = snapshot.source !== "unavailable";
    if (snapshot.source === "unavailable") {
      unpricedRequests += 1;
      if (log.modelID) unmatchedModels.add(log.modelID);
    } else {
      pricedRequests += 1;
      if (snapshot.source === "models-dev" && log.modelID) {
        catalogMatchedModels.add(log.modelID);
      }
    }
  }

  // The local request log is capped at 500 rows, so the recalculated total is
  // deliberately scoped to retained detail rather than preserving stale prices.
  file.totals.estimatedCostUsd = file.logs.reduce(
    (sum, log) => sum + Math.max(0, log.costUsd || 0),
    0,
  );
  await writeUsageFile(file);
  return {
    pricing,
    updatedRequests: file.logs.length,
    pricedRequests,
    unpricedRequests,
    catalogMatchedModels: catalogMatchedModels.size,
    unmatchedModels: unmatchedModels.size,
  };
}

export async function resetUsage(): Promise<HomeMetricsSummary> {
  await writeUsageFile({ version: 1, totals: emptyTotals(), logs: [] });
  return getHomeMetricsSummary();
}

/** Test helper: inject sample rows without going through provider chat. */
export async function appendUsageFixture(
  items: Array<Partial<RequestLogItem> & { valid: boolean }>,
): Promise<number> {
  const file = await readUsageFile();
  for (const item of items) {
    const requestTokens = Math.max(0, Math.round(item.requestTokens || 0));
    const promptTokens = Math.max(0, Math.round(item.promptTokens || 0));
    const completionTokens = Math.max(
      0,
      Math.round(item.completionTokens ?? Math.max(0, requestTokens - promptTokens)),
    );
    const cacheReadTokens = Math.max(0, Math.round(item.cacheReadTokens || 0));
    const cacheWriteTokens = Math.max(0, Math.round(item.cacheWriteTokens || 0));
    const costUsd = Number(item.costUsd || 0);
    const log: RequestLogItem = {
      id: item.id || `fx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: item.at || new Date().toISOString(),
      valid: item.valid,
      source: item.source || "agent",
      providerId: item.providerId,
      modelID: item.modelID,
      requestTokens,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      costEstimated: item.costEstimated !== false,
      priceSnapshot: item.priceSnapshot,
      error: item.error,
      requestId: item.requestId,
    };
    file.logs.unshift(log);
    file.totals.turnsTotal += 1;
    if (log.valid) file.totals.validTurnsTotal += 1;
    else file.totals.invalidTurnsTotal += 1;
    file.totals.requestTokensTotal += requestTokens;
    file.totals.promptTokensTotal += promptTokens;
    file.totals.cacheReadTokens += cacheReadTokens;
    file.totals.cacheWriteTokens += cacheWriteTokens;
    const prev = Number.isFinite(file.totals.estimatedCostUsd)
      ? Math.max(0, file.totals.estimatedCostUsd || 0)
      : 0;
    file.totals.estimatedCostUsd = prev + costUsd;
  }
  file.logs = file.logs.slice(0, 500);
  await writeUsageFile(file);
  return items.length;
}
