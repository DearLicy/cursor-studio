/**
 * Stage 3: usage query, price snapshot, CSV export, cost uses model price.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "studio-s3-"));
process.env.CURSOR_STUDIO_HOME = tmpHome;
process.env.CURSOR_STUDIO_PRICING_OFFLINE = "1";
const port = await freePort();
process.env.STUDIO_CONTROL_PORT = String(port);
process.env.STUDIO_CONTROL_HOST = "127.0.0.1";

const {
  loadConfig,
  saveConfig,
  newProvider,
} = await import("../server/config/store.ts");
const {
  recordTurnUsage,
  queryUsage,
  exportUsageCsv,
  estimateCost,
  resolvePriceSnapshot,
  resetUsage,
} = await import("../server/metrics/usage-store.ts");
const { startControlPlane } = await import("../server/control-plane/index.ts");
const {
  buildModelsDevPricingCatalog,
  resolveModelsDevCatalogPrice,
} = await import("../server/metrics/model-pricing.ts");

// models.dev resolver: provider hint, routed model ID, and context tier.
const pricingCatalog = buildModelsDevPricingCatalog(
  {
    openai: {
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-4.1": {
          cost: { input: 2, output: 8, cache_read: 0.5, cache_write: 2.5 },
        },
        "gpt-5.5": {
          cost: { input: 3, output: 12 },
        },
      },
    },
    xai: {
      name: "xAI",
      api: "https://api.x.ai/v1",
      models: {
        "grok-tier": {
          cost: {
            input: 1,
            output: 2,
            cache_read: 0.2,
            tiers: [
              {
                input: 4,
                output: 8,
                cache_read: 1,
                tier: { type: "context", size: 200000 },
              },
            ],
          },
        },
        "grok-4.5": {
          cost: { input: 2, output: 6, cache_read: 0.3 },
        },
      },
    },
    relay: {
      name: "Relay mirror",
      models: {
        "grok-4.5": {
          cost: { input: 99, output: 99 },
        },
        "gpt-5.5": {
          cost: { input: 88, output: 88 },
        },
      },
    },
  },
  "2026-07-24T00:00:00.000Z",
);
const openAiPrice = resolveModelsDevCatalogPrice(
  pricingCatalog,
  {
    id: "local-openai",
    displayName: "OpenAI",
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    modelID: "gpt-4.1",
    enabled: true,
  },
  "openai/gpt-4.1:latest",
  10_000,
);
assert.equal(openAiPrice?.inputPerMillion, 2);
assert.equal(openAiPrice?.cacheWritePerMillion, 2.5);
const strictOpenAiPrice = resolveModelsDevCatalogPrice(
  pricingCatalog,
  undefined,
  "openai/gpt-5.5",
  10_000,
);
assert.equal(strictOpenAiPrice?.inputPerMillion, 3);
assert.equal(strictOpenAiPrice?.catalogProviderId, "openai");
const tierPrice = resolveModelsDevCatalogPrice(
  pricingCatalog,
  {
    id: "local-xai",
    displayName: "xAI",
    type: "openai",
    baseURL: "https://api.x.ai/v1",
    apiKey: "",
    modelID: "grok-tier",
    enabled: true,
  },
  "grok-tier",
  200_001,
);
assert.equal(tierPrice?.inputPerMillion, 4);
assert.equal(tierPrice?.tierThreshold, 200000);
const suffixGrokPrice = resolveModelsDevCatalogPrice(
  pricingCatalog,
  undefined,
  "grok-4.5",
  10_000,
);
assert.equal(suffixGrokPrice?.inputPerMillion, 2);
assert.equal(suffixGrokPrice?.catalogProviderId, "xai");
const strictGrokPrice = resolveModelsDevCatalogPrice(
  pricingCatalog,
  undefined,
  "xai/grok-4.5",
  10_000,
);
assert.equal(strictGrokPrice?.inputPerMillion, 2);
assert.equal(strictGrokPrice?.catalogProviderId, "xai");

await resetUsage();
const cfg = await loadConfig();
cfg.providers = [
  {
    ...newProvider({
      displayName: "Priced",
      baseURL: "https://price.example/v1",
      apiKey: "k",
      modelID: "cheap-model",
      models: ["cheap-model", "default-model"],
      enabled: true,
      modelSettings: {
        "*": {
          inputCostPerMillion: 1,
          outputCostPerMillion: 2,
          cacheReadCostPerMillion: 0.1,
          cacheWriteCostPerMillion: 0.2,
        },
        "cheap-model": {
          inputCostPerMillion: 0.5,
          outputCostPerMillion: 1.5,
          cacheReadCostPerMillion: 0.05,
          cacheWriteCostPerMillion: 0.1,
        },
      },
    }),
    id: "prov-price",
  },
];
await saveConfig(cfg);

// unit: estimateCost uses provided price
const unit = estimateCost(
  {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
);
assert.equal(unit, 3);

const snapModel = resolvePriceSnapshot(cfg.providers[0], "cheap-model");
assert.equal(snapModel.source, "model");
assert.equal(snapModel.inputPerMillion, 0.5);
const snapProv = resolvePriceSnapshot(cfg.providers[0], "unknown-model");
assert.equal(snapProv.source, "provider");
assert.equal(snapProv.inputPerMillion, 1);

// record with model price: 1M prompt + 1M completion non-cache
await recordTurnUsage({
  valid: true,
  providerId: "prov-price",
  modelID: "cheap-model",
  promptTokens: 1_000_000,
  requestTokens: 2_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  source: "agent",
  requestId: "rid-1",
});
// invalid cancel style
await recordTurnUsage({
  valid: false,
  error: "client_cancel",
  source: "agent",
  requestId: "rid-2",
});

const all = await queryUsage({ limit: 50 });
assert.ok(all.totalMatched >= 2);
assert.equal(all.summary.invalid >= 1, true);
const priced = all.logs.find((l) => l.requestId === "rid-1");
assert.ok(priced);
assert.equal(priced.priceSnapshot?.source, "model");
// cost = 0.5 + 1.5 = 2
assert.ok(Math.abs(priced.costUsd - 2) < 1e-9, `cost=${priced.costUsd}`);

const onlyAgent = await queryUsage({ source: "agent", valid: "valid" });
assert.ok(onlyAgent.logs.every((l) => l.valid && (l.source || "unknown") === "agent"));

const csv = await exportUsageCsv({ valid: "valid" });
assert.ok(csv.includes("price_source"));
assert.ok(csv.includes("cheap-model"));
assert.ok(csv.includes("model"));

// HTTP endpoints
const server = startControlPlane();
await new Promise((r) => setTimeout(r, 120));
const base = `http://127.0.0.1:${port}`;
const qRes = await fetch(`${base}/metrics/query?providerId=prov-price&limit=10`);
assert.equal(qRes.status, 200);
const qJson = await qRes.json();
assert.ok(qJson.totalMatched >= 1);
assert.ok(qJson.summary);

const cRes = await fetch(`${base}/metrics/export.csv?providerId=prov-price`);
assert.equal(cRes.status, 200);
const cText = await cRes.text();
assert.ok(cText.includes("cost_usd"));

const pricingRes = await fetch(`${base}/metrics/pricing/refresh`, { method: "POST" });
assert.equal(pricingRes.status, 200);
const pricingJson = await pricingRes.json();
assert.ok(typeof pricingJson.updatedRequests === "number");

await new Promise((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve())),
);

console.log("PASS smoke-stage3-usage", {
  cost: priced.costUsd,
  matched: all.totalMatched,
  cacheHitRate: all.summary.cacheHitRate,
});
