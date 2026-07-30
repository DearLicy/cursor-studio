/** Balance probes for NewAPI and Sub2API provider connections. */
import { randomUUID } from "node:crypto";
import type { AppConfig, ModelProvider } from "../config/store";
import { loadConfig, saveConfig } from "../config/store";
import {
  joinProviderEndpoint,
  providerSiteRoot,
} from "./base-url";

export type BalanceKind = "newapi" | "sub2api";

export type BalanceAccount = {
  id: string;
  name: string;
  type: BalanceKind;
  apiKey: string;
  /** Legacy NewAPI dashboard access token. */
  accessToken?: string;
  /** Legacy NewAPI dashboard user id sent in New-Api-User. */
  userId?: string;
  /** Optional absolute URL or path for legacy account probes. */
  balanceEndpoint?: string;
  baseURL?: string;
  enabled?: boolean;
};

export type BalanceResult = {
  accountId: string;
  displayName: string;
  type: BalanceKind;
  ok: boolean;
  balanceText?: string;
  /** Contains normalized protocol fields only, never request credentials. */
  raw?: unknown;
  endpoint?: string;
  error?: string;
  checkedAt: string;
};

/** A balance result bound to a provider rather than a legacy account. */
export type ProviderBalanceResult = Omit<BalanceResult, "type"> & {
  providerId: string;
  type: BalanceKind | "none";
  configured: boolean;
};

type JsonObject = Record<string, unknown>;

type NewApiTokenUsage = {
  object: "token_usage";
  name?: string;
  totalGranted: number;
  totalUsed: number;
  totalAvailable: number;
  unlimitedQuota: boolean;
  expiresAt?: number;
};

type Sub2ApiBilling = {
  object: "sub2api.key_billing";
  schemaVersion: 1;
  billingScope: "token";
  effectiveRateMultiplier: number;
  resolvedRateMultiplier?: number;
};

type ParsedSub2ApiUsage = {
  balanceText: string;
  raw: JsonObject;
};

type JsonResponse = {
  ok: boolean;
  status?: number;
  json?: JsonObject;
  error?: "http" | "non-json" | "network";
};

export function newBalanceAccount(
  partial?: Partial<BalanceAccount>,
): BalanceAccount {
  return {
    id: partial?.id || randomUUID().slice(0, 8),
    name: partial?.name || (partial?.type === "sub2api" ? "Sub2API" : "NewAPI"),
    type: partial?.type || "newapi",
    apiKey: partial?.apiKey || "",
    accessToken: partial?.accessToken || "",
    userId: partial?.userId || "",
    balanceEndpoint: partial?.balanceEndpoint || "",
    baseURL: partial?.baseURL || "",
    enabled: partial?.enabled !== false,
  };
}

/** Backward-compatible export used by existing callers and smoke tests. */
export const siteRoot = providerSiteRoot;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : undefined;
}

function authHeaders(token: string, userId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(userId?.trim() ? { "New-Api-User": userId.trim() } : {}),
    "User-Agent": "cursor-studio/1",
  };
}

function adaptiveUsd(value: number): string {
  const digits = value >= 100 ? 2 : value >= 1 ? 3 : 4;
  return `$${value.toFixed(digits)}`;
}

function fixedUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatNewApiQuota(usage: NewApiTokenUsage): string {
  if (usage.unlimitedQuota) return "Unlimited quota";
  const remaining = Math.max(0, usage.totalAvailable) / 500_000;
  const used = Math.max(0, usage.totalUsed) / 500_000;
  const total = Math.max(0, usage.totalGranted) / 500_000;
  return `${adaptiveUsd(remaining)}（已用 ${fixedUsd(used)} / 总计 ${fixedUsd(total)}）`;
}

function parseNewApiTokenUsage(data: JsonObject): NewApiTokenUsage | undefined {
  if (data.code !== true || !isObject(data.data)) return undefined;
  const root = data.data;
  if (root.object !== "token_usage" || typeof root.unlimited_quota !== "boolean") {
    return undefined;
  }
  const totalGranted = nonNegativeNumber(root.total_granted);
  const totalUsed = nonNegativeNumber(root.total_used);
  const totalAvailable = nonNegativeNumber(root.total_available);
  if (totalGranted == null || totalUsed == null || totalAvailable == null) {
    return undefined;
  }
  const expiresAt = finiteNumber(root.expires_at);
  return {
    object: "token_usage",
    ...(typeof root.name === "string" ? { name: root.name } : {}),
    totalGranted,
    totalUsed,
    totalAvailable,
    unlimitedQuota: root.unlimited_quota,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function safeNewApiRaw(usage: NewApiTokenUsage): JsonObject {
  return {
    object: usage.object,
    total_granted: usage.totalGranted,
    total_used: usage.totalUsed,
    total_available: usage.totalAvailable,
    unlimited_quota: usage.unlimitedQuota,
    ...(usage.expiresAt != null ? { expires_at: usage.expiresAt } : {}),
  };
}

/** Parse a NewAPI token usage response, with legacy account shapes as fallback. */
export function pickNewApiBalance(
  data: JsonObject,
  quotaPerUnit = 500_000,
): string | undefined {
  const tokenUsage = parseNewApiTokenUsage(data);
  if (tokenUsage) return formatNewApiQuota(tokenUsage);

  const root = isObject(data.data) ? data.data : data;
  if (root.unlimited_quota === true) return "Unlimited quota";
  const available = finiteNumber(
    root.total_available ?? root.quota ?? root.remain_quota ?? root.total_quota,
  );
  if (available == null) return undefined;
  const used = finiteNumber(root.total_used ?? root.used_quota ?? root.used) || 0;
  const unit = Number.isFinite(quotaPerUnit) && quotaPerUnit > 0
    ? quotaPerUnit
    : 500_000;
  const granted = finiteNumber(root.total_granted) ?? Math.max(0, available) + Math.max(0, used);
  return formatNewApiQuota({
    object: "token_usage",
    totalGranted: granted * (500_000 / unit),
    totalUsed: used * (500_000 / unit),
    totalAvailable: available * (500_000 / unit),
    unlimitedQuota: false,
  });
}

function parseSub2ApiBilling(data: JsonObject): Sub2ApiBilling | undefined {
  if (
    data.object !== "sub2api.key_billing" ||
    data.schema_version !== 1 ||
    data.billing_scope !== "token"
  ) {
    return undefined;
  }
  const effectiveRateMultiplier = nonNegativeNumber(data.effective_rate_multiplier);
  const resolvedRateMultiplier = nonNegativeNumber(data.resolved_rate_multiplier);
  if (effectiveRateMultiplier == null) return undefined;
  return {
    object: "sub2api.key_billing",
    schemaVersion: 1,
    billingScope: "token",
    effectiveRateMultiplier,
    ...(resolvedRateMultiplier != null ? { resolvedRateMultiplier } : {}),
  };
}

function safeSub2ApiBillingRaw(billing: Sub2ApiBilling): JsonObject {
  return {
    object: billing.object,
    schema_version: billing.schemaVersion,
    billing_scope: billing.billingScope,
    effective_rate_multiplier: billing.effectiveRateMultiplier,
    ...(billing.resolvedRateMultiplier != null
      ? { resolved_rate_multiplier: billing.resolvedRateMultiplier }
      : {}),
  };
}

function parseSub2ApiUsage(data: JsonObject): ParsedSub2ApiUsage | undefined {
  const mode = data.mode;
  if (
    (mode !== "quota_limited" && mode !== "unrestricted") ||
    typeof data.isValid !== "boolean"
  ) {
    return undefined;
  }

  if (mode === "quota_limited") {
    if (isObject(data.quota)) {
      const limit = nonNegativeNumber(data.quota.limit);
      const used = nonNegativeNumber(data.quota.used);
      const remaining = nonNegativeNumber(data.quota.remaining);
      if (
        limit != null &&
        used != null &&
        remaining != null &&
        data.quota.unit === "USD"
      ) {
        return {
          balanceText: `${fixedUsd(remaining)} available · ${fixedUsd(used)} used`,
          raw: {
            mode,
            isValid: data.isValid,
            quota: { limit, used, remaining, unit: "USD" },
          },
        };
      }
    }
    if (Array.isArray(data.rate_limits)) {
      return {
        balanceText: "Unlimited spending · rate limited",
        raw: { mode, isValid: data.isValid, rate_limited: true },
      };
    }
    return undefined;
  }

  if (data.unit !== "USD") return undefined;
  const remaining = finiteNumber(data.remaining ?? data.balance);
  const planName = typeof data.planName === "string" ? data.planName : undefined;
  if (remaining == null) {
    if (!planName) return undefined;
    return {
      balanceText: "Unlimited quota",
      raw: { mode, isValid: data.isValid, unit: "USD", unlimited: true },
    };
  }
  return {
    balanceText: remaining < 0 ? "Unlimited quota" : fixedUsd(remaining),
    raw: {
      mode,
      isValid: data.isValid,
      unit: "USD",
      remaining,
    },
  };
}

export function pickSub2ApiBalance(data: JsonObject): string | undefined {
  return parseSub2ApiUsage(data)?.balanceText;
}

export function pickGeneric(data: JsonObject): string | undefined {
  const root = isObject(data.data) ? data.data : data;
  for (const key of ["balance", "total_available", "remain", "remaining", "credit", "amount"]) {
    const value = root[key];
    if (typeof value === "number" || typeof value === "string") return String(value);
  }
  return undefined;
}

async function fetchJson(url: string, token: string, userId?: string): Promise<JsonResponse> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: authHeaders(token, userId),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, status: response.status, error: "http" };
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isObject(parsed)) return { ok: false, status: response.status, error: "non-json" };
      return { ok: true, status: response.status, json: parsed };
    } catch {
      return { ok: false, status: response.status, error: "non-json" };
    }
  } catch {
    return { ok: false, error: "network" };
  }
}

function responseError(endpoint: string, response: JsonResponse): string {
  if (response.error === "http") return `${endpoint} -> HTTP ${response.status}`;
  if (response.error === "non-json") return `${endpoint} -> invalid JSON`;
  return `${endpoint} -> request failed`;
}

function unsupportedError(endpoint: string): string {
  return `${endpoint} -> unsupported response`;
}

async function requestAutomaticProviderBalance(
  provider: ModelProvider,
): Promise<ProviderBalanceResult> {
  const checkedAt = new Date().toISOString();
  const providerId = provider.id || "unsaved-provider";
  const displayName = provider.displayName || "Provider";
  const root = providerSiteRoot(provider.baseURL);
  const key = provider.apiKey.trim();
  const errors: string[] = [];

  const newApiPath = "/api/usage/token/";
  const newApiResponse = await fetchJson(joinProviderEndpoint(root, newApiPath), key);
  if (newApiResponse.ok && newApiResponse.json) {
    const usage = parseNewApiTokenUsage(newApiResponse.json);
    if (usage) {
      return {
        accountId: providerId,
        providerId,
        displayName,
        type: "newapi",
        configured: true,
        ok: true,
        balanceText: formatNewApiQuota(usage),
        raw: safeNewApiRaw(usage),
        endpoint: newApiPath,
        checkedAt,
      };
    }
    errors.push(unsupportedError(newApiPath));
  } else {
    errors.push(responseError(newApiPath, newApiResponse));
  }

  // This route is a strict, API-key-authenticated Sub2API discriminator. The
  // balance itself is returned by the adjacent /v1/usage route.
  const billingPath = "/v1/sub2api/billing";
  const billingResponse = await fetchJson(joinProviderEndpoint(root, billingPath), key);
  const billing = billingResponse.ok && billingResponse.json
    ? parseSub2ApiBilling(billingResponse.json)
    : undefined;
  if (!billing) {
    errors.push(
      billingResponse.ok
        ? unsupportedError(billingPath)
        : responseError(billingPath, billingResponse),
    );
  }

  const usagePath = "/v1/usage";
  const usageResponse = await fetchJson(joinProviderEndpoint(root, usagePath), key);
  const usage = usageResponse.ok && usageResponse.json
    ? parseSub2ApiUsage(usageResponse.json)
    : undefined;
  if (usage && (billing || usageResponse.ok)) {
    return {
      accountId: providerId,
      providerId,
      displayName,
      type: "sub2api",
      configured: true,
      ok: true,
      balanceText: usage.balanceText,
      raw: {
        ...(billing ? { billing: safeSub2ApiBillingRaw(billing) } : {}),
        usage: usage.raw,
      },
      endpoint: usagePath,
      checkedAt,
    };
  }
  errors.push(
    usageResponse.ok
      ? unsupportedError(usagePath)
      : responseError(usagePath, usageResponse),
  );

  return {
    accountId: providerId,
    providerId,
    displayName,
    type: billing ? "sub2api" : "none",
    configured: true,
    ok: false,
    error: errors.join(" | "),
    endpoint: billing ? usagePath : undefined,
    checkedAt,
  };
}

function endpointURL(baseURL: string, endpoint: string): string {
  return /^https?:\/\//i.test(endpoint.trim())
    ? endpoint.trim()
    : joinProviderEndpoint(baseURL, endpoint);
}

async function probeLegacyNewApi(account: BalanceAccount): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  const root = providerSiteRoot(account.baseURL || "");
  if (!root) {
    return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: "Please provide a Base URL", checkedAt };
  }
  const candidates: Array<{ path: string; token: string; userId?: string }> = [];
  if (account.balanceEndpoint?.trim()) {
    candidates.push({
      path: account.balanceEndpoint.trim(),
      token: account.accessToken?.trim() || account.apiKey.trim(),
      userId: account.userId,
    });
  }
  if (account.apiKey.trim()) {
    candidates.push({ path: "/api/usage/token/", token: account.apiKey.trim() });
  }
  if (account.accessToken?.trim() && account.userId?.trim()) {
    candidates.push({
      path: "/api/user/self",
      token: account.accessToken.trim(),
      userId: account.userId.trim(),
    });
  }
  if (!candidates.length) {
    return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: "Please provide an API Key", checkedAt };
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    const response = await fetchJson(
      endpointURL(root, candidate.path),
      candidate.token,
      candidate.userId,
    );
    const balanceText = response.ok && response.json
      ? pickNewApiBalance(response.json) || pickGeneric(response.json)
      : undefined;
    if (balanceText) {
      return {
        accountId: account.id,
        displayName: account.name,
        type: "newapi",
        ok: true,
        balanceText,
        endpoint: candidate.path,
        checkedAt,
      };
    }
    errors.push(response.ok ? unsupportedError(candidate.path) : responseError(candidate.path, response));
  }
  return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: errors.join(" | "), checkedAt };
}

async function probeLegacySub2Api(account: BalanceAccount): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  const root = providerSiteRoot(account.baseURL || "");
  const key = account.apiKey.trim() || account.accessToken?.trim() || "";
  if (!root) {
    return { accountId: account.id, displayName: account.name, type: "sub2api", ok: false, error: "Please provide a Base URL", checkedAt };
  }
  if (!key) {
    return { accountId: account.id, displayName: account.name, type: "sub2api", ok: false, error: "Please provide an API Key", checkedAt };
  }
  const path = account.balanceEndpoint?.trim() || "/v1/usage";
  const response = await fetchJson(endpointURL(root, path), key);
  const balanceText = response.ok && response.json
    ? pickSub2ApiBalance(response.json) || pickGeneric(response.json)
    : undefined;
  if (balanceText) {
    return { accountId: account.id, displayName: account.name, type: "sub2api", ok: true, balanceText, endpoint: path, checkedAt };
  }
  return {
    accountId: account.id,
    displayName: account.name,
    type: "sub2api",
    ok: false,
    error: response.ok ? unsupportedError(path) : responseError(path, response),
    checkedAt,
  };
}

export async function probeBalanceAccount(
  account: BalanceAccount,
): Promise<BalanceResult> {
  return account.type === "sub2api"
    ? probeLegacySub2Api(account)
    : probeLegacyNewApi(account);
}

/** Probe NewAPI and Sub2API directly with the provider's model API key. */
export async function probeProviderBalance(
  provider: ModelProvider,
): Promise<ProviderBalanceResult> {
  const checkedAt = new Date().toISOString();
  const providerId = provider.id || "unsaved-provider";
  if (!provider.baseURL?.trim() || !provider.apiKey?.trim()) {
    return {
      accountId: providerId,
      providerId,
      displayName: provider.displayName || "Provider",
      type: "none",
      configured: false,
      ok: false,
      error: "Please provide a Base URL and API Key",
      checkedAt,
    };
  }
  return requestAutomaticProviderBalance(provider);
}

export async function probeConfiguredProviderBalances(
  providerId?: string,
): Promise<ProviderBalanceResult[]> {
  const config = await loadConfig();
  const providers = config.providers.filter(
    (provider) =>
      provider.baseURL?.trim() &&
      provider.apiKey?.trim() &&
      (!providerId || provider.id === providerId),
  );
  return Promise.all(providers.map((provider) => probeProviderBalance(provider)));
}

export async function probeConfiguredBalances(): Promise<BalanceResult[]> {
  const config = await loadConfig();
  const accounts = (config.balanceAccounts || []).filter((account) => account.enabled !== false);
  const results: BalanceResult[] = [];
  for (const account of accounts) results.push(await probeBalanceAccount(account));
  return results;
}

export async function listBalanceAccounts(): Promise<BalanceAccount[]> {
  const config = await loadConfig();
  return config.balanceAccounts || [];
}

export async function upsertBalanceAccount(
  account: BalanceAccount,
): Promise<BalanceAccount[]> {
  const config = await loadConfig();
  const list = config.balanceAccounts || [];
  const next = {
    ...account,
    id: account.id || randomUUID().slice(0, 8),
    enabled: account.enabled !== false,
  };
  const index = list.findIndex((item) => item.id === next.id);
  if (index >= 0) list[index] = next;
  else list.push(next);
  config.balanceAccounts = list;
  await saveConfig(config);
  return list;
}

export async function removeBalanceAccount(id: string): Promise<BalanceAccount[]> {
  const config = await loadConfig();
  config.balanceAccounts = (config.balanceAccounts || []).filter((item) => item.id !== id);
  await saveConfig(config);
  return config.balanceAccounts;
}

/** Legacy standalone-account alias. */
export async function probeProviderBalances(): Promise<BalanceResult[]> {
  return probeConfiguredBalances();
}

export type { AppConfig };
