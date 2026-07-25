/**
 * 余额：仅 NewAPI / Sub2API。
 * NewAPI：API Key 必填；Base 为站点根（可省 /v1）；鉴权仅需 Key。
 * Sub2API：Base URL + API Key。
 */
import { randomUUID } from "node:crypto";
import type { AppConfig, ModelProvider } from "../config/store";
import { loadConfig, saveConfig } from "../config/store";

export type BalanceKind = "newapi" | "sub2api";

export type BalanceAccount = {
  id: string;
  name: string;
  type: BalanceKind;
  apiKey: string;
  /** NewAPI dashboard access token. */
  accessToken?: string;
  /** NewAPI dashboard user id sent in New-Api-User. */
  userId?: string;
  /** Optional absolute URL or path to override the provider's default endpoint. */
  balanceEndpoint?: string;
  /** 站点根或 API 根。NewAPI 示例 https://xxx.com；Sub2API 示例 https://xxx.com */
  baseURL?: string;
  enabled?: boolean;
};

export type BalanceResult = {
  accountId: string;
  displayName: string;
  type: BalanceKind;
  ok: boolean;
  balanceText?: string;
  raw?: unknown;
  error?: string;
  checkedAt: string;
};

/** A balance result bound to a provider rather than a legacy account. */
export type ProviderBalanceResult = Omit<BalanceResult, "type"> & {
  providerId: string;
  type: BalanceKind | "none";
  configured: boolean;
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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 去掉末尾 /v1 得到站点根 */
function siteRoot(base: string): string {
  let b = trimSlash(base.trim());
  b = b.replace(/\/v1$/i, "");
  return b;
}

function authHeaders(token: string, userId?: string): Record<string, string> {
  const key = token.trim();
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(userId?.trim() ? { "New-Api-User": userId.trim() } : {}),
    "User-Agent": "cursor-studio/0.3",
  };
}

function formatQuota(quota: number, used: number): string {
  // NewAPI 常见：500000 quota = $1
  // NewAPI's quota is the remaining amount; used_quota is consumed amount.
  const remain = Math.max(0, quota);
  const usd = remain / 500_000;
  const usedUsd = Math.max(0, used) / 500_000;
  const totalUsd = usd + usedUsd;
  const digits = usd >= 100 ? 2 : usd >= 1 ? 3 : 4;
  return `$${usd.toFixed(digits)}（已用 $${usedUsd.toFixed(2)} / 总计 $${totalUsd.toFixed(2)}）`;
}

export function pickNewApiBalance(data: Record<string, unknown>): string | undefined {
  const root = (data.data && typeof data.data === "object"
    ? (data.data as Record<string, unknown>)
    : data) as Record<string, unknown>;

  const quota = Number(root.quota ?? root.remain_quota ?? root.total_quota ?? root.totalQuota);
  const used = Number(root.used_quota ?? root.usedQuota ?? root.used ?? 0);
  if (Number.isFinite(quota)) {
    return formatQuota(quota, Number.isFinite(used) ? used : 0);
  }

  for (const k of ["balance", "remain_quota", "remaining", "credit", "amount"]) {
    const v = root[k];
    if (typeof v === "number" || typeof v === "string") return String(v);
  }
  return undefined;
}

export function pickSub2ApiBalance(data: Record<string, unknown>): string | undefined {
  const root = data.data && typeof data.data === "object"
    ? data.data as Record<string, unknown>
    : data;
  const value = Number(root.balance);
  if (!Number.isFinite(value)) return undefined;
  const frozen = Number(root.frozen_balance ?? 0);
  return frozen > 0
    ? `$${value.toFixed(2)}（冻结 $${frozen.toFixed(2)}）`
    : `$${value.toFixed(2)}`;
}

type BalanceCandidate = { url: string; headers: Record<string, string> };

function endpointURL(base: string, endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${trimSlash(base)}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
}

function newApiCandidates(account: BalanceAccount): BalanceCandidate[] {
  const base = siteRoot(account.baseURL || "");
  const token = account.accessToken?.trim() || account.apiKey?.trim() || "";
  const candidates: BalanceCandidate[] = [];
  if (account.balanceEndpoint?.trim()) {
    candidates.push({
      url: endpointURL(base, account.balanceEndpoint),
      headers: authHeaders(token, account.userId),
    });
  }
  if (token && account.userId?.trim()) {
    candidates.push({
      url: `${base}/api/user/self`,
      headers: authHeaders(token, account.userId),
    });
  }
  if (account.apiKey?.trim()) {
    candidates.push({
      url: `${base}/v1/dashboard/billing/credit_grants`,
      headers: authHeaders(account.apiKey),
    });
  }
  return candidates;
}

function sub2ApiCandidates(account: BalanceAccount): BalanceCandidate[] {
  const base = siteRoot(account.baseURL || "").replace(/\/api$/i, "");
  const token = account.accessToken?.trim() || account.apiKey?.trim() || "";
  const headers = { ...authHeaders(token), "x-api-key": token };
  const candidates: BalanceCandidate[] = [];
  if (account.balanceEndpoint?.trim()) {
    candidates.push({ url: endpointURL(base, account.balanceEndpoint), headers });
  }
  candidates.push(
    { url: `${base}/api/v1/user/profile`, headers },
    { url: `${base}/api/v1/user/platform-quotas`, headers },
    { url: `${base}/api/user/self`, headers },
    { url: `${base}/v1/dashboard/billing/credit_grants`, headers },
    { url: `${base}/api/usage`, headers },
    { url: `${base}/v1/balance`, headers },
    { url: `${base}/balance`, headers },
  );
  return candidates;
}

async function requestBalance(
  account: BalanceAccount,
  type: BalanceKind,
  candidates: BalanceCandidate[],
): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  let lastErr = "无可用余额接口";
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, {
        method: "GET",
        headers: candidate.headers,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = `${new URL(candidate.url).pathname} -> ${res.status}`;
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        lastErr = `${new URL(candidate.url).pathname} -> 非 JSON`;
        continue;
      }
      if (json.success === false || (typeof json.code === "number" && json.code !== 0)) {
        lastErr = String(json.message || json.msg || "服务端拒绝查询");
        continue;
      }
      const balanceText =
        (type === "newapi" ? pickNewApiBalance(json) : undefined) ||
        (type === "sub2api" ? pickSub2ApiBalance(json) : undefined) ||
        pickGeneric(json) ||
        text.slice(0, 80);
      return {
        accountId: account.id,
        displayName: account.name,
        type,
        ok: true,
        balanceText,
        raw: json,
        checkedAt,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    accountId: account.id,
    displayName: account.name,
    type,
    ok: false,
    error: lastErr,
    checkedAt,
  };
}

async function probeNewApi(account: BalanceAccount): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  const base = siteRoot(account.baseURL || "");
  if (!base) {
    return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: "请填写站点地址", checkedAt };
  }
  if (!account.accessToken?.trim() && !account.apiKey?.trim()) {
    return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: "请填写访问令牌或 API Key", checkedAt };
  }
  const candidates = newApiCandidates(account);
  if (!candidates.length) {
    return { accountId: account.id, displayName: account.name, type: "newapi", ok: false, error: "NewAPI 后台查询需要访问令牌和用户 ID", checkedAt };
  }
  return requestBalance(account, "newapi", candidates);
}

async function probeSub2Api(account: BalanceAccount): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  if (!account.apiKey?.trim() && !account.accessToken?.trim()) {
    return { accountId: account.id, displayName: account.name, type: "sub2api", ok: false, error: "请填写 API Key 或访问令牌", checkedAt };
  }
  if (!account.baseURL?.trim()) {
    return { accountId: account.id, displayName: account.name, type: "sub2api", ok: false, error: "请填写 Base URL", checkedAt };
  }
  return requestBalance(account, "sub2api", sub2ApiCandidates(account));
}

export function pickGeneric(data: Record<string, unknown>): string | undefined {
  const root = data.data && typeof data.data === "object"
    ? data.data as Record<string, unknown>
    : data;
  const keys = [
    "balance",
    "total_available",
    "remain",
    "remaining",
    "credit",
    "credits",
    "quota",
    "amount",
  ];
  for (const k of keys) {
    const v = root[k];
    if (typeof v === "number" || typeof v === "string") return String(v);
  }
  if (root.hard_limit_usd != null && root.total_usage != null) {
    return `used ${root.total_usage} / hard ${root.hard_limit_usd}`;
  }
  return undefined;
}

export async function probeBalanceAccount(
  account: BalanceAccount,
): Promise<BalanceResult> {
  if (account.type === "sub2api") return probeSub2Api(account);
  return probeNewApi(account);
}

function providerBalanceAccount(provider: ModelProvider): BalanceAccount | undefined {
  const balance = provider.balance;
  if (!balance) return undefined;

  const id = provider.id || "unsaved-provider";
  if (balance.type === "newapi") {
    return {
      id,
      name: provider.displayName || "Provider",
      type: "newapi",
      // NewAPI balance checks use the dashboard access token, not the model key.
      apiKey: "",
      accessToken: typeof balance.accessToken === "string" ? balance.accessToken : "",
      userId: typeof balance.userId === "string" ? balance.userId : "",
      baseURL: provider.baseURL,
      enabled: true,
    };
  }

  return {
    id,
    name: provider.displayName || "Provider",
    type: "sub2api",
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    enabled: true,
  };
}

/**
 * Probe a provider before it is persisted. Its connection address is always
 * reused; NewAPI reads only its dashboard credentials and Sub2API reuses the
 * provider key.
 */
export async function probeProviderBalance(
  provider: ModelProvider,
): Promise<ProviderBalanceResult> {
  const checkedAt = new Date().toISOString();
  const providerId = provider.id || "unsaved-provider";
  const account = providerBalanceAccount(provider);
  if (!account || !provider.balance) {
    return {
      accountId: providerId,
      providerId,
      displayName: provider.displayName || "Provider",
      type: "none",
      configured: false,
      ok: false,
      error: "未设置余额查询",
      checkedAt,
    };
  }

  if (
    provider.balance.type === "newapi" &&
    (!String(provider.balance.userId || "").trim() ||
      !String(provider.balance.accessToken || "").trim())
  ) {
    return {
      accountId: providerId,
      providerId,
      displayName: provider.displayName || "Provider",
      type: "newapi",
      configured: true,
      ok: false,
      error: "请填写用户 ID 和访问令牌",
      checkedAt,
    };
  }

  const result = await probeBalanceAccount(account);
  return {
    ...result,
    providerId,
    configured: true,
  };
}

/** Probe the configured provider balances, optionally for one provider. */
export async function probeConfiguredProviderBalances(
  providerId?: string,
): Promise<ProviderBalanceResult[]> {
  const cfg = await loadConfig();
  const providers = cfg.providers.filter(
    (provider) => provider.balance && (!providerId || provider.id === providerId),
  );
  const results: ProviderBalanceResult[] = [];
  for (const provider of providers) {
    results.push(await probeProviderBalance(provider));
  }
  return results;
}

export async function probeConfiguredBalances(): Promise<BalanceResult[]> {
  const cfg = await loadConfig();
  const accounts = (cfg.balanceAccounts || []).filter((a) => a.enabled !== false);
  const results: BalanceResult[] = [];
  for (const a of accounts) {
    results.push(await probeBalanceAccount(a));
  }
  return results;
}

export async function listBalanceAccounts(): Promise<BalanceAccount[]> {
  const cfg = await loadConfig();
  return cfg.balanceAccounts || [];
}

export async function upsertBalanceAccount(
  account: BalanceAccount,
): Promise<BalanceAccount[]> {
  const cfg = await loadConfig();
  const list = cfg.balanceAccounts || [];
  const next = {
    ...account,
    id: account.id || randomUUID().slice(0, 8),
    enabled: account.enabled !== false,
  };
  const idx = list.findIndex((x) => x.id === next.id);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  cfg.balanceAccounts = list;
  await saveConfig(cfg);
  return list;
}

export async function removeBalanceAccount(id: string): Promise<BalanceAccount[]> {
  const cfg = await loadConfig();
  cfg.balanceAccounts = (cfg.balanceAccounts || []).filter((x) => x.id !== id);
  await saveConfig(cfg);
  return cfg.balanceAccounts;
}

/** 兼容旧调用名 */
export async function probeProviderBalances(): Promise<BalanceResult[]> {
  return probeConfiguredBalances();
}

export type { AppConfig };
