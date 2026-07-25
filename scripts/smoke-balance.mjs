import assert from "node:assert/strict";
import {
  probeBalanceAccount,
  probeProviderBalance,
} from "../server/providers/balance.ts";

const originalFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  seen.push({ url, headers });
  if (url.endsWith("/api/user/self")) {
    return new Response(JSON.stringify({
      success: true,
      data: { quota: 1_000_000, used_quota: 250_000, group: "pro" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/v1/user/profile")) {
    return new Response(JSON.stringify({
      code: 0,
      message: "success",
      data: { balance: 12.5, frozen_balance: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: false, message: "not found" }), { status: 404 });
};

try {
  const newApi = await probeBalanceAccount({
    id: "newapi-smoke",
    name: "NewAPI smoke",
    type: "newapi",
    apiKey: "MODEL_KEY",
    accessToken: "DASHBOARD_TOKEN",
    userId: "42",
    baseURL: "https://newapi.example.test",
  });
  assert.equal(newApi.ok, true);
  assert.match(newApi.balanceText, /已用 \$0\.50/);
  assert.equal(seen[0].headers["authorization"], "Bearer DASHBOARD_TOKEN");
  assert.equal(seen[0].headers["new-api-user"], "42");

  const sub2 = await probeBalanceAccount({
    id: "sub2-smoke",
    name: "Sub2API smoke",
    type: "sub2api",
    apiKey: "SUB2_TOKEN",
    baseURL: "https://sub2api.example.test",
  });
  assert.equal(sub2.ok, true);
  assert.equal(sub2.balanceText, "$12.50");
  assert.equal(seen[1].url, "https://sub2api.example.test/api/v1/user/profile");

  const providerNewApi = await probeProviderBalance({
    id: "provider-newapi-smoke",
    displayName: "Provider NewAPI smoke",
    type: "openai",
    baseURL: "https://newapi.example.test/v1",
    apiKey: "MODEL_KEY_MUST_NOT_BE_USED",
    modelID: "fixture-model",
    enabled: true,
    balance: {
      type: "newapi",
      accessToken: "PROVIDER_DASHBOARD_TOKEN",
      userId: "7",
    },
  });
  assert.equal(providerNewApi.ok, true);
  assert.equal(providerNewApi.providerId, "provider-newapi-smoke");
  assert.equal(seen[2].url, "https://newapi.example.test/api/user/self");
  assert.equal(seen[2].headers["authorization"], "Bearer PROVIDER_DASHBOARD_TOKEN");
  assert.equal(seen[2].headers["new-api-user"], "7");

  const providerSub2 = await probeProviderBalance({
    id: "provider-sub2-smoke",
    displayName: "Provider Sub2API smoke",
    type: "openai",
    baseURL: "https://sub2api.example.test/v1",
    apiKey: "PROVIDER_SUB2_KEY",
    modelID: "fixture-model",
    enabled: true,
    balance: { type: "sub2api" },
  });
  assert.equal(providerSub2.ok, true);
  assert.equal(providerSub2.providerId, "provider-sub2-smoke");
  assert.equal(seen[3].url, "https://sub2api.example.test/api/v1/user/profile");
  assert.equal(seen[3].headers["authorization"], "Bearer PROVIDER_SUB2_KEY");

  console.log("PASS smoke-balance");
} finally {
  globalThis.fetch = originalFetch;
}
