import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-config-"));
process.env.CURSOR_STUDIO_HOME = path.join(root, "studio-home");

try {
  const store = await import("../server/config/store.ts");
  const backups = await import("../server/config/backups.ts");

  const initial = await store.loadConfig();
  assert.equal(initial.cursorIntegration.defaultContextWindowTokens, 200000);
  assert.equal(initial.cursorIntegration.avatarUrl, "");
  assert.equal(initial.cursorIntegration.profileHandle, "");
  assert.equal(initial.cursorIntegration.website, "https://www.akucb.com");
  assert.equal(
    store.normalizeCursorIntegration({ displayName: "???", planName: "??Pro" }).displayName,
    "李初一",
  );
  assert.equal(
    store.normalizeCursorIntegration({ displayName: "???", planName: "??Pro" }).planName,
    "豆包Pro",
  );
  assert.equal(
    store.normalizeCursorIntegration({ displayName: "Custom ???", planName: "Team ??Pro" })
      .displayName,
    "Custom ???",
  );
  const firstProviderDraft = store.newProvider();
  const secondProviderDraft = store.newProvider();
  assert.equal(firstProviderDraft.costMultiplier, 1);
  assert.equal(store.normalizeCostMultiplier(undefined), 1);
  assert.equal(store.normalizeCostMultiplier("0.5"), 1);
  assert.equal(store.normalizeCostMultiplier(Number.NaN), 1);
  assert.equal(store.normalizeCostMultiplier(-0.5), 1);
  assert.equal(store.normalizeCostMultiplier(0), 0);
  assert.equal(store.normalizeCostMultiplier(0.25), 0.25);
  assert.equal(store.normalizeCostMultiplier(Number.MAX_VALUE), Number.MAX_VALUE);
  assert.notEqual(firstProviderDraft.id, secondProviderDraft.id);
  const normalizedDrafts = await store.saveConfig({
    ...initial,
    providers: [
      { ...firstProviderDraft, id: "", costMultiplier: undefined },
      { ...secondProviderDraft, id: "", costMultiplier: 0 },
      { ...store.newProvider(), id: "", costMultiplier: 0.25 },
      { ...store.newProvider(), id: "", costMultiplier: 1_000_000 },
    ],
  });
  assert.notEqual(normalizedDrafts.providers[0]?.id, normalizedDrafts.providers[1]?.id);
  assert.equal(normalizedDrafts.providers[0]?.costMultiplier, 1);
  assert.equal(normalizedDrafts.providers[1]?.costMultiplier, 0);
  assert.equal(normalizedDrafts.providers[2]?.costMultiplier, 0.25);
  assert.equal(normalizedDrafts.providers[3]?.costMultiplier, 1_000_000);
  const reloadedDrafts = await store.loadConfig();
  assert.equal(reloadedDrafts.providers[0]?.costMultiplier, 1);
  assert.equal(reloadedDrafts.providers[1]?.costMultiplier, 0);
  assert.equal(reloadedDrafts.providers[2]?.costMultiplier, 0.25);
  assert.equal(reloadedDrafts.providers[3]?.costMultiplier, 1_000_000);
  initial.providers = [
    store.newProvider({
      displayName: "Fixture",
      baseURL: "https://fixture.example/v1",
      apiKey: "fixture-key",
      modelID: "fixture-model",
      models: ["fixture-model"],
    }),
  ];
  await store.saveConfig(initial);

  const manual = await backups.createConfigBackup("manual");
  assert.ok(manual?.name.endsWith(".yaml"));

  const imported = await backups.importConfig({
    proxyListenAddr: "127.0.0.1:29999",
    appearance: { blur: 42 },
    cursorIntegration: {
      displayName: "Fixture Relay",
      planName: "Fixture Plus",
      defaultContextWindowTokens: 500000,
      avatarUrl: path.join(root, "fixture-profile.png"),
      profileHandle: "@fixture_profile",
      website: "fixture.example/profile",
    },
  });
  assert.equal(imported.proxyListenAddr, "127.0.0.1:29999");
  assert.equal(imported.appearance.blur, 42);
  assert.equal(imported.providers.length, 1);
  assert.equal(imported.cursorIntegration.displayName, "Fixture Relay");
  assert.equal(imported.cursorIntegration.planName, "Fixture Plus");
  assert.equal(imported.cursorIntegration.defaultContextWindowTokens, 500000);
  assert.equal(
    imported.cursorIntegration.avatarUrl,
    pathToFileURL(path.join(root, "fixture-profile.png")).href,
  );
  assert.equal(imported.cursorIntegration.profileHandle, "fixture_profile");
  assert.equal(imported.cursorIntegration.website, "https://fixture.example/profile");

  const models = await import("../server/backend/forwarder/models.ts");
  assert.equal(
    models.buildAvailableModels(imported.providers, imported.cursorIntegration).models[0]
      ?.contextTokenLimit,
    500000,
  );
  const providerOverride = {
    ...imported.providers[0],
    contextWindowTokens: 300000,
  };
  assert.equal(
    models.buildAvailableModels([providerOverride], imported.cursorIntegration).models[0]
      ?.contextTokenLimit,
    300000,
  );
  const modelOverride = {
    ...providerOverride,
    modelSettings: {
      "fixture-model": { contextWindowTokens: 500000 },
    },
  };
  assert.equal(
    models.buildAvailableModels([modelOverride], imported.cursorIntegration).models[0]
      ?.contextTokenLimit,
    500000,
  );

  const snapshots = await backups.listConfigBackups();
  assert.ok(snapshots.length >= 2);
  assert.ok(snapshots.some((item) => item.name.includes("before-import")));

  const restored = await backups.restoreConfigBackup(manual.name);
  assert.equal(restored.proxyListenAddr, store.DEFAULT_PROXY);
  assert.equal(restored.providers[0].displayName, "Fixture");
  assert.equal(restored.cursorIntegration.defaultContextWindowTokens, 200000);
  assert.equal((await backups.listConfigBackups()).length, snapshots.length + 1);

  const retentionBackups = [];
  for (let index = 0; index < 4; index += 1) {
    const backup = await backups.createConfigBackup(`retention-${index}`);
    assert.ok(backup);
    retentionBackups.push(backup);
  }
  const retained = await backups.listConfigBackups();
  assert.equal(retained.length, backups.MAX_CONFIG_BACKUPS);
  assert.ok(retained.some((item) => item.name === retentionBackups.at(-1).name));

  const removedOne = await backups.removeConfigBackup(retained[1].name);
  assert.deepEqual(removedOne.removed, [retained[1].name]);
  assert.equal(removedOne.remaining, backups.MAX_CONFIG_BACKUPS - 1);
  assert.equal((await backups.listConfigBackups()).length, backups.MAX_CONFIG_BACKUPS - 1);
  await assert.rejects(() => backups.removeConfigBackup("../config.yaml"), /Invalid backup name/);

  const cleared = await backups.clearConfigBackups();
  assert.equal(cleared.removed.length, backups.MAX_CONFIG_BACKUPS - 1);
  assert.equal(cleared.remaining, 0);
  assert.deepEqual(await backups.listConfigBackups(), []);

  // Older files can contain now-removed team fields. Loading once strips them
  // while retaining the profile fields that Cursor still displays.
  await fs.writeFile(
    store.configPath(),
    [
      "version: 1",
      "cursorIntegration:",
      "  displayName: Legacy Profile",
      "  contactEmail: legacy@example.test",
      "  planName: Legacy Plan",
      "  defaultContextWindowTokens: 200000",
      "  organization: Legacy Team",
      "  teamId: 42",
      "  website: ''",
      "providers:",
      "  - id: legacy-provider",
      "    displayName: Legacy Provider",
      "    type: openai",
      "    baseURL: https://legacy.example/v1",
      "    apiKey: legacy-key",
      "    modelID: legacy-model",
      "    enabled: true",
    ].join("\n"),
    "utf8",
  );
  const migrated = await store.loadConfig();
  assert.equal(migrated.cursorIntegration.displayName, "Legacy Profile");
  assert.equal(migrated.cursorIntegration.avatarUrl, "");
  assert.equal(migrated.cursorIntegration.profileHandle, "");
  assert.equal(migrated.cursorIntegration.website, "https://www.akucb.com");
  assert.equal(migrated.providers[0]?.costMultiplier, 1);
  assert.equal(Object.hasOwn(migrated.cursorIntegration, "organization"), false);
  assert.equal(Object.hasOwn(migrated.cursorIntegration, "teamId"), false);
  const migratedText = await fs.readFile(store.configPath(), "utf8");
  assert.match(migratedText, /avatarUrl: ""/);
  assert.doesNotMatch(migratedText, /organization:/);
  assert.doesNotMatch(migratedText, /teamId:/);
  assert.match(migratedText, /website: https:\/\/www\.akucb\.com/);
  assert.match(migratedText, /costMultiplier: 1/);

  // A Windows code-page write in older builds replaced each default CJK
  // character with '?'. Loading repairs only those exact lossy defaults and
  // persists valid UTF-8 values for subsequent starts.
  await fs.writeFile(
    store.configPath(),
    [
      "version: 1",
      "cursorIntegration:",
      "  displayName: ???",
      "  contactEmail: 82719519@qq.com",
      "  planName: ??Pro",
      "  defaultContextWindowTokens: 200000",
      "providers: []",
    ].join("\n"),
    "utf8",
  );
  const repaired = await store.loadConfig();
  assert.equal(repaired.cursorIntegration.displayName, "李初一");
  assert.equal(repaired.cursorIntegration.planName, "豆包Pro");
  const repairedText = await fs.readFile(store.configPath(), "utf8");
  assert.match(repairedText, /displayName: 李初一/);
  assert.match(repairedText, /planName: 豆包Pro/);
  assert.doesNotMatch(repairedText, /displayName: \?\?\?/);

  console.log("Config smoke passed: import merge, profile migration, three-backup retention, cleanup, and context window precedence");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
