import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultCursorIntegration,
  normalizeCursorIntegration,
} from "../server/config/store.ts";
import {
  buildAvailableModels,
  buildCursorUserProfile,
  buildDashboardUsage,
  buildGetMe,
  buildPlanInfo,
} from "../server/backend/forwarder/models.ts";
import {
  encodeBootstrapStatsigProto,
  encodeCurrentPeriodUsageProto,
  encodeGetMeProto,
  encodeGetUserProfileProto,
  encodePlanInfoProto,
} from "../server/backend/forwarder/mock-proto.ts";
import { buildCursorAuthValues } from "../server/cursor/state-db.ts";
import { resolveCursorAvatarUrl } from "../server/runtime/app-icon.ts";
import {
  decodeFields,
  firstBytes,
  firstString,
} from "../server/backend/forwarder/protobuf-wire.ts";
import { startBackend } from "../server/backend/local.ts";

const avatarPath = path.join(os.tmpdir(), "cursor-studio-profile-smoke.png");
const integration = normalizeCursorIntegration({
  displayName: "Example Studio",
  contactEmail: "hello@example.test",
  planName: "Example Relay",
  defaultContextWindowTokens: 333_333,
  avatarUrl: avatarPath,
  profileHandle: "@Example_Studio",
  website: "example.test/profile",
});
assert.equal(normalizeCursorIntegration({ contactEmail: "" }).contactEmail, "");
assert.equal(normalizeCursorIntegration({ displayName: "???" }).displayName, "李初一");
assert.equal(normalizeCursorIntegration({ planName: "??Pro" }).planName, "豆包Pro");
assert.equal(integration.avatarUrl, pathToFileURL(avatarPath).href);
assert.equal(integration.profileHandle, "example_studio");
assert.equal(integration.website, "https://example.test/profile");
const remoteAvatarUrl = "https://q.qlogo.cn/headimg_dl?dst_uin=82719519&spec=640&img_type=jpg";
assert.equal(normalizeCursorIntegration({ avatarUrl: remoteAvatarUrl }).avatarUrl, remoteAvatarUrl);
assert.equal(normalizeCursorIntegration({ profileHandle: "invalid handle" }).profileHandle, "");

const providers = [
  {
    id: "provider-priority",
    displayName: "Priority provider",
    type: "openai",
    baseURL: "https://example.test/v1",
    apiKey: "fixture-key",
    modelID: "model-specific",
    models: ["model-specific", "provider-default"],
    modelSettings: {
      "model-specific": { contextWindowTokens: 111_111 },
    },
    contextWindowTokens: 222_222,
    enabled: true,
  },
  {
    id: "provider-global",
    displayName: "Global provider",
    type: "openai",
    baseURL: "https://example.test/v1",
    apiKey: "fixture-key",
    modelID: "global-default",
    models: ["global-default"],
    enabled: true,
  },
];

const available = buildAvailableModels(providers, integration);
const byId = new Map(available.models.map((model) => [model.serverModelName, model]));
assert.equal(byId.get("provider-priority:model-specific")?.contextTokenLimit, 111_111);
assert.equal(byId.get("provider-priority:provider-default")?.contextTokenLimit, 222_222);
assert.equal(byId.get("provider-global")?.contextTokenLimit, 333_333);

const dashboard = buildDashboardUsage(integration);
assert.equal(dashboard.displayMessage, "Example Studio Example Relay");
assert.equal(dashboard.planUsage.bonusTooltip, "Example Studio Example Relay");

const me = buildGetMe(integration);
const advertisedAvatarUrl = resolveCursorAvatarUrl(integration.avatarUrl);
assert.match(
  advertisedAvatarUrl,
  /^http:\/\/127\.0\.0\.1:18090\/cursor-studio\/avatar\.png\?v=/,
);
assert.equal(me.email, integration.contactEmail);
assert.equal(me.firstName, "Example");
assert.equal(me.lastName, "Studio");
assert.equal(me.profilePictureUrl, advertisedAvatarUrl);
assert.equal(buildPlanInfo(integration).planInfo.planName, integration.planName);

const remoteIntegration = normalizeCursorIntegration({
  ...integration,
  avatarUrl: remoteAvatarUrl,
});
assert.equal(resolveCursorAvatarUrl(remoteIntegration.avatarUrl), remoteAvatarUrl);
assert.equal(buildGetMe(remoteIntegration).profilePictureUrl, remoteAvatarUrl);
assert.equal(buildCursorUserProfile(remoteIntegration).profile.avatarUrl, remoteAvatarUrl);

const profile = buildCursorUserProfile(integration).profile;
assert.equal(profile.handle, integration.profileHandle);
assert.deepEqual(profile.links, { website: integration.website });
assert.equal(profile.avatarUrl, advertisedAvatarUrl);

const protoText = Buffer.concat([
  encodeGetMeProto(integration),
  encodeGetUserProfileProto(integration),
  encodePlanInfoProto(integration),
  encodeCurrentPeriodUsageProto(integration),
  encodeBootstrapStatsigProto(integration),
]).toString("utf8");
assert.match(protoText, /hello@example\.test/);
assert.match(protoText, /Example Studio/);
assert.match(protoText, /Example Relay/);
assert.match(protoText, /example_studio/);
assert.match(protoText, /https:\/\/example\.test\/profile/);

const getMeFields = decodeFields(encodeGetMeProto(integration));
assert.equal(getMeFields.some((field) => field.field === 7), false);
assert.equal(firstString(getMeFields, 10), undefined);
assert.equal(firstString(getMeFields, 13), advertisedAvatarUrl);
const profileResponse = firstBytes(decodeFields(encodeGetUserProfileProto(integration)), 1);
assert.ok(profileResponse);
const profileFields = decodeFields(profileResponse);
assert.equal(firstString(profileFields, 1), integration.profileHandle);
assert.equal(firstString(profileFields, 6), integration.displayName);
assert.equal(firstString(profileFields, 7), advertisedAvatarUrl);

const authValues = buildCursorAuthValues(integration, "fixture-token");
assert.equal(authValues["cursorAuth/cachedEmail"], integration.contactEmail);
assert.deepEqual(JSON.parse(authValues["cursorAuth/cachedScopedProfile"]), {
  displayName: integration.displayName,
  pictureUrl: advertisedAvatarUrl,
});
assert.equal(Object.hasOwn(authValues, "cursorAuth/cachedTeam"), false);

const defaults = defaultCursorIntegration();
assert.equal(defaults.displayName, "李初一");
assert.equal(defaults.contactEmail, "82719519@qq.com");
assert.equal(defaults.planName, "豆包Pro");
assert.equal(defaults.defaultContextWindowTokens, 200_000);
assert.equal(defaults.avatarUrl, "");
assert.equal(defaults.profileHandle, "");
assert.equal(defaults.website, "https://www.akucb.com");
const fallbackAvatar = resolveCursorAvatarUrl(defaults.avatarUrl);
assert.match(
  fallbackAvatar,
  /^http:\/\/127\.0\.0\.1:18090\/cursor-studio\/avatar\.png\?v=/,
);
assert.equal(
  JSON.parse(buildCursorAuthValues(defaults, "fixture-token")["cursorAuth/cachedScopedProfile"])
    .pictureUrl,
  fallbackAvatar,
);

// The endpoint is the actual URL Cursor receives. It must return an image, not
// a local file path, and GetMe must use the running backend port rather than a
// hard-coded default.
const backend = await startBackend("127.0.0.1:0", async () => ({
  providers: [],
  cursorIntegration: integration,
}));
try {
  const liveAvatarUrl = resolveCursorAvatarUrl(integration.avatarUrl, backend.listenAddr);
  const avatarResponse = await fetch(liveAvatarUrl);
  assert.equal(avatarResponse.status, 200);
  assert.match(avatarResponse.headers.get("content-type") || "", /^image\//);
  assert.ok((await avatarResponse.arrayBuffer()).byteLength > 0);

  const liveMe = await fetch(
    `http://${backend.listenAddr}/aiserver.v1.DashboardService/GetMe?format=json`,
  );
  assert.equal(liveMe.status, 200);
  assert.equal((await liveMe.json()).profilePictureUrl, liveAvatarUrl);
} finally {
  await backend.close();
}

console.log("Cursor integration smoke passed: config, protocol display, avatar endpoint, state cache");
