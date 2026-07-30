import assert from "node:assert/strict";
import {
  probeBalanceAccount,
  probeProviderBalance,
  siteRoot,
} from "../server/providers/balance.ts";
import {
  joinProviderEndpoint,
  normalizeProviderBaseURL,
  providerEndpointCandidates,
} from "../server/providers/base-url.ts";

const originalFetch = globalThis.fetch;
const seen = [];

function newApiUsage(overrides = {}) {
  return {
    code: true,
    message: "ok",
    data: {
      object: "token_usage",
      name: "fixture key",
      total_granted: 3_000_000,
      total_used: 1_000_000,
      total_available: 2_000_000,
      unlimited_quota: false,
      expires_at: 0,
      ...overrides,
    },
  };
}

function sub2Billing(extra = {}) {
  return {
    object: "sub2api.key_billing",
    schema_version: 1,
    billing_scope: "token",
    group_rate_multiplier: 0.75,
    resolved_rate_multiplier: 0.5,
    effective_rate_multiplier: 0.5,
    peak_rate_enabled: false,
    observed_at: "2026-07-29T12:00:00Z",
    ...extra,
  };
}

function sub2Usage(extra = {}) {
  return {
    mode: "quota_limited",
    isValid: true,
    status: "active",
    quota: { limit: 16, used: 3.5, remaining: 12.5, unit: "USD" },
    ...extra,
  };
}

function json(value, init) {
  return Response.json(value, init);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  seen.push({ url: url.toString(), hostname: url.hostname, path: url.pathname, headers });

  if (
    ["newapi.example.test", "newapi-v1.example.test"].includes(url.hostname) &&
    url.pathname === "/api/usage/token/"
  ) {
    return json(newApiUsage({
      name: headers.get("authorization"),
      api_key: headers.get("authorization"),
    }));
  }
  if (
    url.hostname === "newapi-unlimited.example.test" &&
    url.pathname === "/api/usage/token/"
  ) {
    return json(newApiUsage({
      total_granted: 0,
      total_used: 0,
      total_available: 0,
      unlimited_quota: true,
    }));
  }
  if (url.hostname === "legacy-newapi.example.test") {
    if (url.pathname === "/api/user/self") {
      return json({
        success: true,
        data: { quota: 1_000_000, used_quota: 250_000, group: "pro" },
      });
    }
    return json({ message: "not found" }, { status: 404 });
  }

  const sub2Prefixes = new Map([
    ["sub2api.example.test", ""],
    ["sub2api-v1.example.test", ""],
    ["sub2api-custom.example.test", "/gateway/openai"],
    ["legacy-sub2.example.test", ""],
  ]);
  if (sub2Prefixes.has(url.hostname)) {
    const prefix = sub2Prefixes.get(url.hostname);
    if (url.pathname === `${prefix}/v1/sub2api/billing`) {
      if (url.hostname === "legacy-sub2.example.test") {
        return json({ message: "old deployment" }, { status: 404 });
      }
      return json(sub2Billing({ echoed_key: headers.get("authorization") }));
    }
    if (url.pathname === `${prefix}/v1/usage`) {
      return json(sub2Usage({ echoed_key: headers.get("authorization") }));
    }
  }

  if (url.hostname === "billing-only.example.test") {
    if (url.pathname === "/v1/sub2api/billing") return json(sub2Billing());
    if (url.pathname === "/v1/usage") return json({ object: "not_usage" });
  }

  if (url.hostname === "wrong-shape.example.test") {
    if (url.pathname === "/api/usage/token/") {
      return json({ code: true, data: { total_available: 2_000_000 } });
    }
    if (url.pathname === "/v1/sub2api/billing") {
      return json({ object: "sub2api.key_billing", effective_rate_multiplier: 1 });
    }
    if (url.pathname === "/v1/usage") {
      return json({ mode: "quota_limited", remaining: 50 });
    }
  }

  if (url.hostname === "malformed.example.test") {
    if (url.pathname === "/api/usage/token/") {
      return new Response("<html>not json</html>", { status: 200 });
    }
    return json(
      { message: `credential was ${headers.get("authorization")}` },
      { status: url.pathname.includes("billing") ? 401 : 404 },
    );
  }

  return json({ message: "not found" }, { status: 404 });
};

function provider(id, baseURL, apiKey = `${id}-secret`) {
  return {
    id,
    displayName: id,
    type: "openai",
    baseURL,
    apiKey,
    modelID: "fixture-model",
    enabled: true,
  };
}

function call(hostname, path) {
  return seen.find((item) => item.hostname === hostname && item.path === path);
}

try {
  // Shared URL behavior: site root, /v1 root, complete endpoint and prefixes.
  assert.equal(normalizeProviderBaseURL(" https://www.akucb.com/// "), "https://www.akucb.com");
  assert.equal(siteRoot("https://www.akucb.com"), "https://www.akucb.com");
  assert.equal(siteRoot("https://www.akucb.com/v1/"), "https://www.akucb.com");
  assert.equal(
    siteRoot("https://proxy.example.test/gateway/openai/v1/"),
    "https://proxy.example.test/gateway/openai",
  );
  assert.equal(
    joinProviderEndpoint("https://www.akucb.com/v1/", "/v1/responses"),
    "https://www.akucb.com/v1/responses",
  );
  assert.equal(
    joinProviderEndpoint("https://proxy.example.test/gateway/openai/v1", "/v1/chat/completions"),
    "https://proxy.example.test/gateway/openai/v1/chat/completions",
  );
  assert.equal(
    joinProviderEndpoint("https://proxy.example.test/custom/responses", "/v1/responses"),
    "https://proxy.example.test/custom/responses",
  );
  assert.deepEqual(
    providerEndpointCandidates("https://www.akucb.com", "/models"),
    ["https://www.akucb.com/v1/models", "https://www.akucb.com/models"],
  );
  assert.deepEqual(
    providerEndpointCandidates("https://proxy.example.test/gateway/openai/v1/", "/models"),
    ["https://proxy.example.test/gateway/openai/v1/models"],
  );

  const newApiRoot = await probeProviderBalance(
    provider("newapi-root", "https://newapi.example.test", "NEWAPI_ROOT_KEY"),
  );
  assert.equal(newApiRoot.ok, true);
  assert.equal(newApiRoot.type, "newapi");
  assert.equal(newApiRoot.endpoint, "/api/usage/token/");
  assert.match(newApiRoot.balanceText, /^\$4\.000/);
  assert.deepEqual(newApiRoot.raw, {
    object: "token_usage",
    total_granted: 3_000_000,
    total_used: 1_000_000,
    total_available: 2_000_000,
    unlimited_quota: false,
    expires_at: 0,
  });
  assert.equal(JSON.stringify(newApiRoot).includes("NEWAPI_ROOT_KEY"), false);
  assert.equal(
    call("newapi.example.test", "/api/usage/token/").headers.get("authorization"),
    "Bearer NEWAPI_ROOT_KEY",
  );
  assert.equal(
    call("newapi.example.test", "/api/usage/token/").headers.get("x-api-key"),
    null,
  );

  const newApiV1 = await probeProviderBalance(
    provider("newapi-v1", "https://newapi-v1.example.test/v1/", "NEWAPI_V1_KEY"),
  );
  assert.equal(newApiV1.ok, true);
  assert.equal(call("newapi-v1.example.test", "/v1/api/usage/token/"), undefined);
  assert.equal(
    call("newapi-v1.example.test", "/api/usage/token/").headers.get("authorization"),
    "Bearer NEWAPI_V1_KEY",
  );

  const unlimited = await probeProviderBalance(
    provider("newapi-unlimited", "https://newapi-unlimited.example.test/v1"),
  );
  assert.equal(unlimited.ok, true);
  assert.equal(unlimited.balanceText, "Unlimited quota");

  const sub2Root = await probeProviderBalance(
    provider("sub2-root", "https://sub2api.example.test", "SUB2_ROOT_KEY"),
  );
  assert.equal(sub2Root.ok, true);
  assert.equal(sub2Root.type, "sub2api");
  assert.equal(sub2Root.balanceText, "$12.50 available · $3.50 used");
  assert.equal(sub2Root.endpoint, "/v1/usage");
  assert.equal(JSON.stringify(sub2Root).includes("SUB2_ROOT_KEY"), false);
  assert.equal(sub2Root.raw.billing.object, "sub2api.key_billing");
  assert.equal(sub2Root.raw.billing.effective_rate_multiplier, 0.5);
  assert.equal(sub2Root.raw.usage.quota.remaining, 12.5);
  assert.equal(
    call("sub2api.example.test", "/v1/sub2api/billing").headers.get("authorization"),
    "Bearer SUB2_ROOT_KEY",
  );
  assert.equal(
    call("sub2api.example.test", "/v1/sub2api/billing").headers.get("x-api-key"),
    null,
  );
  assert.equal(
    call("sub2api.example.test", "/v1/usage").headers.get("authorization"),
    "Bearer SUB2_ROOT_KEY",
  );
  assert.deepEqual(
    seen
      .filter((item) => item.hostname === "sub2api.example.test")
      .map((item) => item.path),
    ["/api/usage/token/", "/v1/sub2api/billing", "/v1/usage"],
  );

  const sub2V1 = await probeProviderBalance(
    provider("sub2-v1", "https://sub2api-v1.example.test/v1/", "SUB2_V1_KEY"),
  );
  assert.equal(sub2V1.ok, true);
  assert.equal(call("sub2api-v1.example.test", "/v1/v1/sub2api/billing"), undefined);

  const sub2Custom = await probeProviderBalance(
    provider(
      "sub2-custom",
      "https://sub2api-custom.example.test/gateway/openai/v1/",
      "SUB2_CUSTOM_KEY",
    ),
  );
  assert.equal(sub2Custom.ok, true);
  assert.equal(
    call("sub2api-custom.example.test", "/gateway/openai/v1/sub2api/billing")
      .headers.get("authorization"),
    "Bearer SUB2_CUSTOM_KEY",
  );
  assert(call("sub2api-custom.example.test", "/gateway/openai/v1/usage"));

  // Older Sub2API versions are accepted only when /v1/usage has its strict shape.
  const legacySub2Provider = await probeProviderBalance(
    provider("legacy-sub2-provider", "https://legacy-sub2.example.test", "OLD_SUB2_KEY"),
  );
  assert.equal(legacySub2Provider.ok, true);
  assert.equal(legacySub2Provider.type, "sub2api");

  const billingOnly = await probeProviderBalance(
    provider("billing-only", "https://billing-only.example.test"),
  );
  assert.equal(billingOnly.ok, false);
  assert.equal(billingOnly.type, "sub2api");
  assert.match(billingOnly.error, /\/v1\/usage -> unsupported response/);

  const wrongShape = await probeProviderBalance(
    provider("wrong-shape", "https://wrong-shape.example.test"),
  );
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.type, "none");
  assert.match(wrongShape.error, /\/api\/usage\/token\/ -> unsupported response/);
  assert.match(wrongShape.error, /\/v1\/sub2api\/billing -> unsupported response/);
  assert.match(wrongShape.error, /\/v1\/usage -> unsupported response/);

  const failedKey = "FAILURE_SECRET_SHOULD_NOT_LEAK";
  const malformed = await probeProviderBalance(
    provider("malformed", "https://malformed.example.test/v1", failedKey),
  );
  assert.equal(malformed.ok, false);
  assert.equal(
    malformed.error,
    "/api/usage/token/ -> invalid JSON | /v1/sub2api/billing -> HTTP 401 | /v1/usage -> HTTP 404",
  );
  assert.equal(JSON.stringify(malformed).includes(failedKey), false);

  const legacyNewApi = await probeBalanceAccount({
    id: "legacy-newapi",
    name: "Legacy NewAPI",
    type: "newapi",
    apiKey: "LEGACY_MODEL_KEY",
    accessToken: "LEGACY_DASHBOARD_TOKEN",
    userId: "42",
    baseURL: "https://legacy-newapi.example.test/v1",
  });
  assert.equal(legacyNewApi.ok, true);
  assert.match(legacyNewApi.balanceText, /已用 \$0\.50/);
  assert.equal(
    call("legacy-newapi.example.test", "/api/user/self").headers.get("authorization"),
    "Bearer LEGACY_DASHBOARD_TOKEN",
  );
  assert.equal(
    call("legacy-newapi.example.test", "/api/user/self").headers.get("new-api-user"),
    "42",
  );

  const legacySub2Account = await probeBalanceAccount({
    id: "legacy-sub2",
    name: "Legacy Sub2API",
    type: "sub2api",
    apiKey: "LEGACY_SUB2_KEY",
    baseURL: "https://legacy-sub2.example.test/v1",
  });
  assert.equal(legacySub2Account.ok, true);
  assert.equal(legacySub2Account.balanceText, "$12.50 available · $3.50 used");

  const missing = await probeProviderBalance(
    provider("missing", "", ""),
  );
  assert.equal(missing.configured, false);
  assert.equal(missing.ok, false);

  console.log("PASS smoke-balance");
} finally {
  globalThis.fetch = originalFetch;
}
