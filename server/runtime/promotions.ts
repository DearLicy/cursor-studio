import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config/store";
import {
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_PROMOTIONS_URL,
} from "../../shared/release-source";

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

interface PromotionSourceItem extends Partial<HomePromotion> {
  active?: boolean;
  enabled?: boolean;
  priority?: number;
  startsAt?: string;
  endsAt?: string;
}

interface PromotionSourceFile {
  schemaVersion?: number;
  version?: number;
  updatedAt?: string;
  items?: PromotionSourceItem[];
  promotions?: PromotionSourceItem[];
}

interface CachedPromotions {
  version: 1;
  sourceUrl: string;
  checkedAt: string;
  fetchedAt: string;
  etag?: string;
  updatedAt?: string;
  promotions: HomePromotion[];
}

export interface HomePromotionsResult {
  promotions: HomePromotion[];
  source: "remote" | "cache" | "bundled";
  updatedAt?: string;
  refreshedAt?: string;
}

/**
 * Keep the published data location in one place. The release workflow can
 * replace OWNER once, while private builds can point at another feed through
 * CURSOR_STUDIO_PROMOTIONS_URL.
 */
export const DEFAULT_PROMOTIONS_REMOTE_URL =
  RELEASE_PROMOTIONS_URL;

export const PROMOTIONS_REFRESH_INTERVAL_MS = RELEASE_CHECK_INTERVAL_MS;

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_PROMOTIONS = 30;
const MAX_REMOTE_FILE_BYTES = 256 * 1_024;
const CACHE_FILE_NAME = "ads-cache.json";
const FALLBACK_FILE_NAME = "ads.json";

let fallbackPromise: Promise<HomePromotion[]> | undefined;
let refreshInFlight: Promise<HomePromotionsResult> | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

function configuredSourceUrl(): string {
  const raw = process.env.CURSOR_STUDIO_PROMOTIONS_URL?.trim() || DEFAULT_PROMOTIONS_REMOTE_URL;
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function cachePath(): string {
  return path.join(dataDir(), CACHE_FILE_NAME);
}

function fallbackCandidates(): string[] {
  const resourceRoot = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    process.env.CURSOR_STUDIO_PROMOTIONS_FALLBACK_FILE?.trim() || "",
    resourceRoot ? path.join(resourceRoot, "resources", FALLBACK_FILE_NAME) : "",
    path.resolve(process.cwd(), "resources", FALLBACK_FILE_NAME),
  ].filter(Boolean);
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeUrl(value: unknown): string {
  const raw = text(value, 2_048);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizePromotion(value: PromotionSourceItem, now = Date.now()): HomePromotion | null {
  if (!value || typeof value !== "object" || value.enabled === false || value.active === false) return null;

  const startsAt = validDate(value.startsAt);
  const endsAt = validDate(value.endsAt);
  if ((startsAt !== undefined && startsAt > now) || (endsAt !== undefined && endsAt <= now)) {
    return null;
  }

  const id = text(value.id, 64);
  const label = text(value.label, 48);
  const title = text(value.title, 96);
  const description = text(value.description, 220);
  const action = text(value.action, 36);
  const href = normalizeUrl(value.href);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return null;
  if (!label || !title || !description || !action || !href) return null;

  return {
    id,
    label,
    title,
    description,
    action,
    href,
    kind: value.kind === "vacancy" ? "vacancy" : "promotion",
  };
}

function normalizeSource(source: unknown): { updatedAt?: string; promotions: HomePromotion[] } | null {
  const raw: PromotionSourceFile | null = Array.isArray(source)
    ? { items: source as PromotionSourceItem[] }
    : source && typeof source === "object"
      ? (source as PromotionSourceFile)
      : null;
  const items = Array.isArray(raw?.items) ? raw.items : raw?.promotions;
  if (!raw || !Array.isArray(items)) return null;

  const seen = new Set<string>();
  const now = Date.now();
  const sorted = items
    .map((item, index) => ({ item, index, priority: Number(item?.priority) || 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  const promotions: HomePromotion[] = [];

  for (const entry of sorted) {
    const normalized = normalizePromotion(entry.item, now);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    promotions.push(normalized);
    if (promotions.length >= MAX_PROMOTIONS) break;
  }

  const updatedAt = typeof raw.updatedAt === "string" && validDate(raw.updatedAt) !== undefined
    ? raw.updatedAt
    : undefined;
  return { updatedAt, promotions };
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readCachedPromotions(): Promise<CachedPromotions | null> {
  const raw = await readJson(cachePath());
  if (!raw || typeof raw !== "object") return null;
  const cached = raw as Partial<CachedPromotions>;
  const normalized = normalizeSource({
    updatedAt: cached.updatedAt,
    promotions: cached.promotions,
  });
  if (!normalized || typeof cached.checkedAt !== "string" || typeof cached.fetchedAt !== "string") {
    return null;
  }

  return {
    version: 1,
    sourceUrl: typeof cached.sourceUrl === "string" ? cached.sourceUrl : "",
    checkedAt: cached.checkedAt,
    fetchedAt: cached.fetchedAt,
    etag: typeof cached.etag === "string" ? cached.etag : undefined,
    updatedAt: normalized.updatedAt,
    promotions: normalized.promotions,
  };
}

async function writeCachedPromotions(cache: CachedPromotions): Promise<void> {
  const file = cachePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

async function bundledPromotions(): Promise<HomePromotion[]> {
  fallbackPromise ??= (async () => {
    for (const candidate of fallbackCandidates()) {
      const normalized = normalizeSource(await readJson(candidate));
      if (normalized) return normalized.promotions;
    }
    return [];
  })();
  return fallbackPromise;
}

function resultFromCache(cache: CachedPromotions): HomePromotionsResult {
  return {
    promotions: cache.promotions,
    source: "cache",
    updatedAt: cache.updatedAt,
    refreshedAt: cache.fetchedAt,
  };
}

async function fallbackResult(cache?: CachedPromotions | null): Promise<HomePromotionsResult> {
  if (cache) return resultFromCache(cache);
  return {
    promotions: await bundledPromotions(),
    source: "bundled",
  };
}

function isCacheFresh(cache: CachedPromotions | null): boolean {
  if (!cache) return false;
  if (cache.sourceUrl !== configuredSourceUrl()) return false;
  const checkedAt = Date.parse(cache.checkedAt);
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < PROMOTIONS_REFRESH_INTERVAL_MS;
}

async function fetchAndCachePromotions(previous: CachedPromotions | null): Promise<HomePromotionsResult> {
  const sourceUrl = configuredSourceUrl();
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return fallbackResult(previous);
  }
  if (source.protocol !== "https:") return fallbackResult(previous);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(source, {
      headers:
        previous?.etag && previous.sourceUrl === source.toString()
          ? { "If-None-Match": previous.etag }
          : undefined,
      signal: controller.signal,
    });
    const checkedAt = new Date().toISOString();

    if (response.status === 304 && previous) {
      const cache = { ...previous, checkedAt };
      await writeCachedPromotions(cache);
      return resultFromCache(cache);
    }
    if (!response.ok) return fallbackResult(previous);

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_FILE_BYTES) {
      return fallbackResult(previous);
    }
    const body = await response.text();
    if (body.length > MAX_REMOTE_FILE_BYTES) return fallbackResult(previous);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return fallbackResult(previous);
    }
    const normalized = normalizeSource(parsed);
    if (!normalized) return fallbackResult(previous);

    const cache: CachedPromotions = {
      version: 1,
      sourceUrl: source.toString(),
      checkedAt,
      fetchedAt: checkedAt,
      etag: response.headers.get("etag") || undefined,
      updatedAt: normalized.updatedAt,
      promotions: normalized.promotions,
    };
    await writeCachedPromotions(cache);
    return {
      promotions: cache.promotions,
      source: "remote",
      updatedAt: cache.updatedAt,
      refreshedAt: cache.fetchedAt,
    };
  } catch {
    return fallbackResult(previous);
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch the catalogue now. A failed request never replaces a working cache. */
export async function refreshPromotions(): Promise<HomePromotionsResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => fetchAndCachePromotions(await readCachedPromotions()))();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

/** Return the current catalogue, refreshing only after its six-hour check window. */
export async function getPromotions(options?: { refresh?: boolean }): Promise<HomePromotionsResult> {
  const cache = await readCachedPromotions();
  if (options?.refresh || !isCacheFresh(cache)) return refreshPromotions();
  return fallbackResult(cache);
}

/** Start startup and six-hour refreshes. Repeated calls share one timer. */
export function startPromotionsRefresh(): void {
  if (refreshTimer) return;
  void refreshPromotions();
  refreshTimer = setInterval(() => {
    void refreshPromotions();
  }, PROMOTIONS_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}
