import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-provider-monitor-"));
process.env.CURSOR_STUDIO_HOME = testHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";

try {
  const monitor = await import("../server/runtime/provider-monitor.ts");
  const health = await import("../server/providers/provider-health.ts");
  const history = await import("../server/providers/probe-history.ts");
  const store = await import("../server/config/store.ts");
  const usage = await import("../server/metrics/usage-store.ts");

  assert.equal(monitor.PROVIDER_MONITOR_INTERVAL_MS, 600_000);
  const providers = [
    { id: "ready", enabled: true, baseURL: "https://example.com", apiKey: "key" },
    { id: "disabled", enabled: false, baseURL: "https://example.com", apiKey: "key" },
    { id: "missing-key", enabled: true, baseURL: "https://example.com", apiKey: "" },
    { id: "missing-url", enabled: true, baseURL: "", apiKey: "key" },
  ];
  assert.deepEqual(
    monitor.providerMonitorTargets(providers).map((provider) => provider.id),
    ["ready"],
  );

  health.resetProviderHealth("circuit");
  health.recordProviderFailure("circuit", "first");
  health.recordProviderFailure("circuit", "second");
  const beforeObservation = health.getProviderHealth("circuit");
  assert.equal(beforeObservation.state, "offline");
  const observed = health.recordProviderObservation("circuit", {
    ok: true,
    latencyMs: 42,
  });
  assert.equal(observed.state, "offline", "scheduled observations do not clear routing cooldown");
  assert.equal(observed.consecutiveFailures, beforeObservation.consecutiveFailures);
  assert.equal(observed.latencyMs, 42);

  health.resetProviderHealth("observation");
  const degraded = health.recordProviderObservation("observation", {
    ok: false,
    latencyMs: 120,
    error: "temporary",
  });
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.consecutiveFailures, 0, "scheduled observations do not increment failures");

  await history.clearProbeHistory();
  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      history.appendProbeHistory({
        providerId: `provider-${index}`,
        ok: true,
        latencyMs: index,
        batchId: "concurrent-smoke",
      }),
    ),
  );
  const items = await history.listProbeHistory({ limit: 50 });
  assert.equal(items.length, 24, "concurrent probe history writes are serialized");
  assert.equal(new Set(items.map((item) => item.id)).size, 24);

  const config = await store.loadConfig();
  config.providers = [
    {
      ...store.newProvider({
        displayName: "Monitor pricing fixture",
        baseURL: "https://pricing.example/v1",
        apiKey: "key",
        modelID: "priced-model",
        models: ["priced-model"],
        enabled: false,
        costMultiplier: 1,
        modelSettings: {
          "priced-model": {
            inputCostPerMillion: 1,
            outputCostPerMillion: 2,
          },
        },
      }),
      id: "monitor-price",
    },
  ];
  await store.saveConfig(config);
  await usage.resetUsage();
  await usage.recordTurnUsage({
    valid: true,
    providerId: "monitor-price",
    modelID: "priced-model",
    promptTokens: 1_000_000,
    requestTokens: 2_000_000,
    requestId: "monitor-price-request",
  });

  const multiplierConfig = await store.loadConfig();
  multiplierConfig.providers[0].costMultiplier = 3;
  await store.saveConfig(multiplierConfig);
  const currentHome = await usage.getHomeMetricsSummary();
  assert.equal(currentHome.estimatedCostUsd, 9, "home summary uses the current multiplier");

  const snapshot = await monitor.runProviderMonitorCycle();
  assert.equal(snapshot.providerCount, 0, "disabled pricing fixture is not health-probed");
  const usageFile = JSON.parse(await fs.readFile(usage.usageFilePath(), "utf8"));
  const repriced = usageFile.logs.find((item) => item.requestId === "monitor-price-request");
  assert.equal(repriced.costUsd, 9, "scheduled monitor persists complete usage repricing");
  assert.equal(repriced.priceSnapshot.multiplier, 3);
  assert.equal(usageFile.totals.estimatedCostUsd, 9);

  console.log("PASS smoke-provider-monitor", {
    intervalMs: monitor.PROVIDER_MONITOR_INTERVAL_MS,
    historyItems: items.length,
  });
} finally {
  await fs.rm(testHome, { recursive: true, force: true });
}
