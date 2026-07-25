/**
 * Stage 1: provider candidate ordering + error map + request context.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orderProviderCandidates } from "../server/backend/agent/provider-chat.ts";
import {
  createRequestContext,
  markRoute,
  elapsedMs,
} from "../server/backend/request-context.ts";
import {
  mapUpstreamStatus,
  mapLocalError,
  shouldFailover,
  ERROR_MAP,
} from "../server/backend/error-map.ts";
import {
  recordProviderFailure,
  resetProviderHealth,
  isProviderCoolingDown,
} from "../server/providers/provider-health.ts";

const base = {
  type: "openai",
  baseURL: "https://example.com",
  apiKey: "k",
  modelID: "m",
  enabled: true,
};

const providers = [
  { ...base, id: "p-high", displayName: "High", failoverPriority: 50, modelID: "m1" },
  { ...base, id: "p-low", displayName: "Low", failoverPriority: 1, modelID: "m2" },
  { ...base, id: "p-mid", displayName: "Mid", failoverPriority: 10, modelID: "m3" },
  { ...base, id: "p-off", displayName: "Off", enabled: false, failoverPriority: 0, modelID: "m4" },
];

const ordered = orderProviderCandidates(providers);
assert.equal(ordered[0].id, "p-high");
assert.deepEqual(
  ordered.slice(1).map((p) => p.id),
  ["p-low", "p-mid"],
);
assert.ok(!ordered.some((p) => p.id === "p-off"));

const hinted = orderProviderCandidates(providers, "p-mid:m3");
assert.equal(hinted[0].id, "p-mid");
assert.equal(hinted[1].id, "p-low");

resetProviderHealth("p-high");
recordProviderFailure("p-high", new Error("500"));
recordProviderFailure("p-high", new Error("500"));
assert.equal(isProviderCoolingDown("p-high"), true);
const cooled = orderProviderCandidates(providers);
assert.notEqual(cooled[0].id, "p-high");
assert.ok(!cooled.some((p) => p.id === "p-high"));

const ctx = createRequestContext({
  requestId: "rid-1",
  source: "agent",
  modelHint: "p-low:m2",
});
markRoute(ctx, {
  providerId: "p-low",
  modelID: "m2",
  routeReason: "hint",
  attempt: 0,
});
assert.equal(ctx.requestId, "rid-1");
assert.equal(ctx.routeReason, "hint");
assert.ok(elapsedMs(ctx) >= 0);

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/protocol/error-mapping.json",
    ),
    "utf8",
  ),
);
assert.equal(ERROR_MAP.length, fixture.map.length);
assert.equal(mapUpstreamStatus(401).code, "UPSTREAM_UNAUTHORIZED");
assert.equal(mapUpstreamStatus(429).cooldown, true);
assert.equal(mapLocalError("provider_cooldown").code, "PROVIDER_COOLDOWN");
assert.equal(shouldFailover(new Error("502 bad gateway")), true);
assert.equal(shouldFailover(new Error("401 unauthorized")), false);

console.log("PASS smoke-routing", {
  ordered: ordered.map((p) => p.id),
  hinted: hinted.map((p) => p.id),
  cooled: cooled.map((p) => p.id),
});