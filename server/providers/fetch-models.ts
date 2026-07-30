/**
 * 从供应商 API 一键拉取模型列表。
 * - OpenAI 兼容：GET {base}/models 或 {base}/v1/models
 * - Anthropic 兼容：GET {base}/v1/models
 */

import { providerEndpointCandidates } from "./base-url";

export type ProviderType = "openai" | "anthropic";

export interface FetchModelsInput {
  type: ProviderType;
  baseURL: string;
  apiKey: string;
}

export interface FetchedModel {
  id: string;
  ownedBy?: string;
  created?: number;
}

export interface FetchModelsResult {
  models: FetchedModel[];
  endpoint: string;
}

export interface ProviderProbeResult {
  ok: boolean;
  endpoint: string;
  status?: number;
  latencyMs: number;
  modelCount: number;
  error?: string;
}

function candidateUrls(type: ProviderType, baseURL: string): string[] {
  // Both supported protocols expose model discovery at the same versioned
  // path. The shared helper also keeps the unversioned compatibility fallback.
  void type;
  return providerEndpointCandidates(baseURL, "/models");
}

function authHeaders(type: ProviderType, apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (type === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function parseModelList(json: unknown): FetchedModel[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;

  // OpenAI: { data: [{ id, owned_by, created }] }
  if (Array.isArray(obj.data)) {
    const out: FetchedModel[] = [];
    for (const item of obj.data) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
      if (!id) continue;
      out.push({
        id,
        ownedBy: typeof m.owned_by === "string" ? m.owned_by : undefined,
        created: typeof m.created === "number" ? m.created : undefined,
      });
    }
    return out;
  }

  // 部分网关直接返回数组
  if (Array.isArray(json)) {
    return (json as unknown[])
      .map((item) => {
        if (typeof item === "string") return { id: item };
        if (item && typeof item === "object") {
          const m = item as Record<string, unknown>;
          const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
          if (!id) return null;
          return { id } satisfies FetchedModel;
        }
        return null;
      })
      .filter((x): x is FetchedModel => Boolean(x));
  }

  // Anthropic 风格：{ models: [...] } 或 { data: [...] } 已覆盖
  if (Array.isArray(obj.models)) {
    return obj.models
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const m = item as Record<string, unknown>;
        const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
        if (!id) return null;
        return { id } satisfies FetchedModel;
      })
      .filter((x): x is FetchedModel => Boolean(x));
  }

  return [];
}

/**
 * 依次尝试候选 endpoint，返回第一个成功的列表。
 * 网络请求在 Electron 主进程执行，避免渲染进程 CORS。
 * OpenAI 风格分页：has_more + after / last_id
 */
export async function fetchProviderModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const baseURL = input.baseURL?.trim();
  const apiKey = input.apiKey?.trim();
  if (!baseURL) throw new Error("请先填写 Base URL");
  if (!apiKey) throw new Error("请先填写 API Key");

  const urls = candidateUrls(input.type, baseURL);
  if (urls.length === 0) throw new Error("Base URL 无效");

  const headers = authHeaders(input.type, apiKey);
  const errors: string[] = [];

  for (const endpoint of urls) {
    try {
      const all = await fetchAllPages(endpoint, headers);
      if (all.models.length === 0) {
        errors.push(`${endpoint} → 解析到 0 个模型`);
        continue;
      }
      // 去重 + 稳定排序
      const seen = new Set<string>();
      const unique = all.models.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      unique.sort((a, b) => a.id.localeCompare(b.id));
      return { models: unique, endpoint: all.endpoint };
    } catch (err) {
      errors.push(`${endpoint} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`拉取模型失败：\n${errors.slice(0, 4).join("\n")}`);
}

async function fetchAllPages(
  endpoint: string,
  headers: Record<string, string>,
): Promise<{ models: FetchedModel[]; endpoint: string }> {
  const collected: FetchedModel[] = [];
  let url = endpoint.includes("?") ? endpoint : `${endpoint}?limit=100`;
  // 若已有 query，补 limit
  if (endpoint.includes("?") && !/[?&]limit=/.test(endpoint)) {
    url = `${endpoint}&limit=100`;
  }

  let pages = 0;
  const maxPages = 20; // 保护上限：最多约 2000 模型

  while (pages < maxPages) {
    pages += 1;
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("非 JSON 响应");
    }

    const pageModels = parseModelList(json);
    if (pageModels.length === 0 && pages === 1) {
      return { models: [], endpoint };
    }
    collected.push(...pageModels);

    const next = nextPageUrl(endpoint, json, pageModels);
    if (!next) break;
    url = next;
  }

  return { models: collected, endpoint };
}

function nextPageUrl(
  baseEndpoint: string,
  json: unknown,
  pageModels: FetchedModel[],
): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  // 显式 next URL
  if (typeof obj.next === "string" && obj.next.startsWith("http")) return obj.next;

  if (obj.has_more === true || obj.has_more === "true") {
    const lastId =
      (typeof obj.last_id === "string" && obj.last_id) ||
      pageModels[pageModels.length - 1]?.id;
    if (!lastId) return null;
    try {
      const abs = new URL(baseEndpoint);
      abs.searchParams.set("limit", abs.searchParams.get("limit") || "100");
      abs.searchParams.set("after", lastId);
      return abs.toString();
    } catch {
      const q = baseEndpoint.includes("?") ? "&" : "?";
      return `${baseEndpoint}${q}limit=100&after=${encodeURIComponent(lastId)}`;
    }
  }
  return null;
}

export async function probeProviderEndpoint(
  input: FetchModelsInput,
): Promise<ProviderProbeResult> {
  const baseURL = input.baseURL?.trim();
  const apiKey = input.apiKey?.trim();
  if (!baseURL) throw new Error("Please provide a Base URL first");
  if (!apiKey) throw new Error("Please provide an API Key first");

  const urls = candidateUrls(input.type, baseURL);
  if (!urls.length) throw new Error("Invalid Base URL");

  const headers = authHeaders(input.type, apiKey);
  const errors: string[] = [];
  let last: ProviderProbeResult = {
    ok: false,
    endpoint: urls[0],
    latencyMs: 0,
    modelCount: 0,
    error: "No endpoint responded",
  };

  for (const endpoint of urls) {
    const startedAt = performance.now();
    try {
      const url = endpoint.includes("?") ? endpoint : `${endpoint}?limit=100`;
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      let modelCount = 0;
      if (text) {
        try {
          modelCount = parseModelList(JSON.parse(text)).length;
        } catch {
          if (res.ok) {
            last = {
              ok: false,
              endpoint,
              status: res.status,
              latencyMs,
              modelCount: 0,
              error: "The endpoint returned a non-JSON response",
            };
            errors.push(`${endpoint}: non-JSON response`);
            continue;
          }
        }
      }

      if (res.ok) {
        return {
          ok: true,
          endpoint,
          status: res.status,
          latencyMs,
          modelCount,
        };
      }

      const detail = text.replace(/\s+/g, " ").trim().slice(0, 180);
      last = {
        ok: false,
        endpoint,
        status: res.status,
        latencyMs,
        modelCount,
        error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      };
      errors.push(`${endpoint}: HTTP ${res.status}`);
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const message = error instanceof Error ? error.message : String(error);
      last = {
        ok: false,
        endpoint,
        latencyMs,
        modelCount: 0,
        error: message,
      };
      errors.push(`${endpoint}: ${message}`);
    }
  }

  return {
    ...last,
    error: errors.slice(0, 3).join(" | ") || last.error,
  };
}
