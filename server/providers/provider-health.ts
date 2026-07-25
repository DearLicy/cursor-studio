import type { ModelProvider } from "../config/store";
import {
  probeProviderEndpoint,
  type ProviderProbeResult,
} from "./fetch-models";
import { appendProbeHistory } from "./probe-history";

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

const states = new Map<string, ProviderHealth>();

function currentState(providerId: string): ProviderHealth {
  return (
    states.get(providerId) || {
      providerId,
      state: "unknown",
      consecutiveFailures: 0,
    }
  );
}

export function getProviderHealth(providerId: string): ProviderHealth {
  const health = currentState(providerId);
  if (
    health.state === "offline" &&
    health.openUntil &&
    Date.parse(health.openUntil) <= Date.now()
  ) {
    const recovered: ProviderHealth = {
      ...health,
      state: "degraded",
      openUntil: undefined,
    };
    states.set(providerId, recovered);
    return recovered;
  }
  return health;
}

export function listProviderHealth(providers: ModelProvider[]): ProviderHealth[] {
  return providers.map((provider) => getProviderHealth(provider.id));
}

export function isProviderCoolingDown(providerId: string): boolean {
  const health = getProviderHealth(providerId);
  return (
    health.state === "offline" &&
    Boolean(health.openUntil) &&
    Date.parse(health.openUntil as string) > Date.now()
  );
}

export function recordProviderSuccess(
  providerId: string,
  detail?: Partial<ProviderProbeResult>,
): ProviderHealth {
  const next: ProviderHealth = {
    providerId,
    state: "healthy",
    consecutiveFailures: 0,
    checkedAt: new Date().toISOString(),
    latencyMs: detail?.latencyMs,
    status: detail?.status,
    endpoint: detail?.endpoint,
    modelCount: detail?.modelCount,
  };
  states.set(providerId, next);
  return next;
}

export function recordProviderFailure(
  providerId: string,
  error: unknown,
  detail?: Partial<ProviderProbeResult>,
): ProviderHealth {
  const previous = currentState(providerId);
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const cooldownMs =
    consecutiveFailures >= 2
      ? Math.min(60_000, 15_000 * 2 ** Math.min(2, consecutiveFailures - 2))
      : 0;
  const message = error instanceof Error ? error.message : String(error);
  const next: ProviderHealth = {
    providerId,
    state: cooldownMs ? "offline" : "degraded",
    consecutiveFailures,
    checkedAt: new Date().toISOString(),
    latencyMs: detail?.latencyMs,
    status: detail?.status,
    endpoint: detail?.endpoint,
    modelCount: detail?.modelCount,
    error: detail?.error || message,
    openUntil: cooldownMs
      ? new Date(Date.now() + cooldownMs).toISOString()
      : undefined,
  };
  states.set(providerId, next);
  return next;
}

export async function probeProvider(
  provider: ModelProvider,
  opts?: { batchId?: string },
): Promise<ProviderProbeResult & { health: ProviderHealth }> {
  const result = await probeProviderEndpoint({
    type: provider.type,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
  });
  const health = result.ok
    ? recordProviderSuccess(provider.id, result)
    : recordProviderFailure(provider.id, result.error || "Probe failed", result);
  await appendProbeHistory({
    providerId: provider.id,
    displayName: provider.displayName,
    ok: result.ok,
    latencyMs: result.latencyMs,
    status: result.status,
    endpoint: result.endpoint,
    modelCount: result.modelCount,
    error: result.error,
    batchId: opts?.batchId,
  }).catch(() => undefined);
  return { ...result, health };
}

export function resetProviderHealth(providerId: string): void {
  states.delete(providerId);
}
