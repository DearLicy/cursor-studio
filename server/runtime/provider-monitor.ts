import { randomUUID } from "node:crypto";
import { loadConfig, type ModelProvider } from "../config/store";
import {
  refreshUsagePricing,
  type UsagePricingRefreshResult,
} from "../metrics/usage-store";
import {
  probeProvider,
  type ProviderHealth,
} from "../providers/provider-health";

export const PROVIDER_MONITOR_INTERVAL_MS = 10 * 60 * 1_000;

export interface ProviderMonitorSnapshot {
  checkedAt: string;
  batchId: string;
  providerCount: number;
  health: ProviderHealth[];
  pricing: UsagePricingRefreshResult["pricing"];
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorStarted = false;
let cycleInFlight: Promise<ProviderMonitorSnapshot> | null = null;
let lastSnapshot: ProviderMonitorSnapshot | null = null;

export function providerMonitorTargets(providers: ModelProvider[]): ModelProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled !== false &&
      Boolean(provider.baseURL?.trim()) &&
      Boolean(provider.apiKey?.trim()),
  );
}

export async function runProviderMonitorCycle(): Promise<ProviderMonitorSnapshot> {
  if (cycleInFlight) return cycleInFlight;

  cycleInFlight = (async () => {
    const config = await loadConfig();
    const targets = providerMonitorTargets(config.providers);
    const batchId = randomUUID();
    const healthPromise = (async () => {
      const health: ProviderHealth[] = [];
      // Probe sequentially because probe history is persisted as a small JSON
      // journal and the provider list is normally short.
      for (const provider of targets) {
        try {
          const result = await probeProvider(provider, {
            batchId,
            affectCircuit: false,
          });
          health.push(result.health);
        } catch (error) {
          console.warn(
            `[provider-monitor] latency check failed for ${provider.displayName}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return health;
    })();
    const [health, usagePricing] = await Promise.all([
      healthPromise,
      refreshUsagePricing(),
    ]);
    const snapshot: ProviderMonitorSnapshot = {
      checkedAt: new Date().toISOString(),
      batchId,
      providerCount: targets.length,
      health,
      pricing: usagePricing.pricing,
    };
    lastSnapshot = snapshot;
    return snapshot;
  })().finally(() => {
    cycleInFlight = null;
  });

  return cycleInFlight;
}

function scheduleNextCycle(delayMs: number): void {
  if (!monitorStarted) return;
  monitorTimer = setTimeout(() => {
    monitorTimer = null;
    void runProviderMonitorCycle()
      .catch((error) => {
        console.warn(
          "[provider-monitor] refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => scheduleNextCycle(PROVIDER_MONITOR_INTERVAL_MS));
  }, delayMs);
  monitorTimer.unref?.();
}

export function startProviderMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  scheduleNextCycle(0);
}

export function stopProviderMonitor(): void {
  monitorStarted = false;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = null;
}

export function getProviderMonitorSnapshot(): ProviderMonitorSnapshot | null {
  return lastSnapshot
    ? {
        ...lastSnapshot,
        health: lastSnapshot.health.map((health) => ({ ...health })),
        pricing: { ...lastSnapshot.pricing },
      }
    : null;
}
