/**
 * Cursor 用户态账号缓存注入（state.vscdb）。
 * 本地协议实现。
 * - 写 cursorAuth/* 让 Settings 显示假账号
 * - 关闭部分 statsig gate，避免扩展宿主隔离干扰本地代理
 *
 * 不修改 Cursor 安装包；仅改用户 AppData 状态库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InjectAuthToken,
  LocalUltraMembershipType,
  LocalUltraSignUpType,
  LocalUltraSubscriptionStatus,
} from "../runtime/defaults";
import {
  loadConfig,
  normalizeCursorIntegration,
  type CursorIntegrationConfig,
} from "../config/store";
import { resolveCursorAvatarUrl } from "../runtime/app-icon";

const STATSIG_BOOTSTRAP_KEY = "workbench.experiments.statsigBootstrap";
const DISABLED_STATSIG_GATES = [
  "decompose_always_local_ext_host",
  "cursor_extensions_isolation_v2",
] as const;

type SqliteStmt = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => { value?: unknown } | undefined;
};

type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStmt;
  close: () => void;
};

export function resolveCursorStateDbPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

export function buildCursorAuthValues(
  cursorIntegration: CursorIntegrationConfig,
  token: string,
  backendListenAddr?: string,
): Record<string, string> {
  const avatarUrl = resolveCursorAvatarUrl(
    cursorIntegration.avatarUrl,
    backendListenAddr,
  );
  return {
    "cursorAuth/accessToken": token,
    "cursorAuth/cachedEmail": cursorIntegration.contactEmail,
    // Cursor reads this object before its GetMe request resolves, keeping the
    // sidebar identity and profile image in sync with the local protocol
    // response. An empty configured avatar resolves to the Studio app icon.
    "cursorAuth/cachedScopedProfile": JSON.stringify({
      displayName: cursorIntegration.displayName,
      ...(avatarUrl ? { pictureUrl: avatarUrl } : {}),
    }),
    "cursorAuth/cachedSignUpType": LocalUltraSignUpType,
    "cursorAuth/refreshToken": token,
    "cursorAuth/stripeMembershipType": LocalUltraMembershipType,
    "cursorAuth/stripeSubscriptionStatus": LocalUltraSubscriptionStatus,
  };
}

export type CursorUserInfoSyncResult = {
  changed: boolean;
  synced: boolean;
  error?: string;
};

async function hasLegacyCursorTeamCache(): Promise<boolean> {
  const stateDbPath = resolveCursorStateDbPath();
  if (!fs.existsSync(stateDbPath)) return false;

  let db: SqliteDb | undefined;
  try {
    db = await openStateDb(stateDbPath);
    return Boolean(
      db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/cachedTeam"),
    );
  } catch {
    // A locked database is handled by the normal injection path on the next
    // save/start, rather than making a configuration save fail.
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Cursor cannot load the file:// avatar URL previously written to its cache. */
async function hasLegacyCursorAvatarCache(): Promise<boolean> {
  const stateDbPath = resolveCursorStateDbPath();
  if (!fs.existsSync(stateDbPath)) return false;

  let db: SqliteDb | undefined;
  try {
    db = await openStateDb(stateDbPath);
    const value = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/cachedScopedProfile")?.value;
    const raw =
      typeof value === "string"
        ? value
        : Buffer.isBuffer(value)
          ? value.toString("utf8")
          : "";
    const profile = JSON.parse(raw) as { pictureUrl?: unknown };
    return typeof profile.pictureUrl === "string" && /^file:/i.test(profile.pictureUrl);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Keep Cursor's local account cache aligned with a saved integration profile.
 * The configuration file remains the source of truth: a temporary SQLite lock
 * must not make a successful settings save look like a failed save.
 */
export async function syncCursorUserInfoIfChanged(
  previous: CursorIntegrationConfig | undefined,
  next: CursorIntegrationConfig | undefined,
  previousBackendListenAddr?: string,
  nextBackendListenAddr?: string,
): Promise<CursorUserInfoSyncResult> {
  const before = normalizeCursorIntegration(previous);
  const after = normalizeCursorIntegration(next);
  const changed =
    before.displayName !== after.displayName ||
    before.contactEmail !== after.contactEmail ||
    before.planName !== after.planName ||
    before.defaultContextWindowTokens !== after.defaultContextWindowTokens ||
    before.avatarUrl !== after.avatarUrl ||
    before.profileHandle !== after.profileHandle ||
    before.website !== after.website ||
    String(previousBackendListenAddr || "").trim() !==
      String(nextBackendListenAddr || "").trim();

  const [hasLegacyTeamCache, hasLegacyAvatarCache] = await Promise.all([
    hasLegacyCursorTeamCache(),
    hasLegacyCursorAvatarCache(),
  ]);
  if (!changed && !hasLegacyTeamCache && !hasLegacyAvatarCache) {
    return { changed: false, synced: false };
  }

  try {
    await injectCursorUserInfo(after, InjectAuthToken, nextBackendListenAddr);
    return { changed, synced: true };
  } catch (error) {
    return {
      changed,
      synced: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function djb2Hash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return String(hash);
}

function disableStatsigGate(
  featureGates: Record<string, unknown>,
  key: string,
): void {
  const existing = featureGates[key];
  const gate =
    existing && typeof existing === "object"
      ? ({ ...(existing as Record<string, unknown>) } as Record<string, unknown>)
      : ({
          name: key,
          rule_id: "local_disabled",
          ruleID: "local_disabled",
          group_name: "local_disabled",
          groupName: "local_disabled",
          id_type: "userID",
          idType: "userID",
        } as Record<string, unknown>);
  gate.value = false;
  featureGates[key] = gate;
}

async function openStateDb(dbPath: string): Promise<SqliteDb> {
  // Electron/Node 22+ 实验性内置 sqlite；打包时 external，勿打进 bundle
  const sqlite = await import("node:sqlite");
  const DatabaseSync = (
    sqlite as unknown as {
      DatabaseSync: new (p: string) => SqliteDb;
    }
  ).DatabaseSync;
  return new DatabaseSync(dbPath);
}

function disableCursorStatsigGates(db: SqliteDb): void {
  const row = db
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get(STATSIG_BOOTSTRAP_KEY);
  if (!row || row.value == null) return;

  const raw =
    typeof row.value === "string"
      ? row.value
      : Buffer.isBuffer(row.value)
        ? row.value.toString("utf8")
        : String(row.value);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const featureGates =
    payload.feature_gates && typeof payload.feature_gates === "object"
      ? ({ ...(payload.feature_gates as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};
  payload.feature_gates = featureGates;

  const hashUsed = String(payload.hash_used ?? "");
  for (const gate of DISABLED_STATSIG_GATES) {
    disableStatsigGate(featureGates, gate);
    if (hashUsed.toLowerCase() === "djb2") {
      disableStatsigGate(featureGates, djb2Hash(gate));
    }
  }

  db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
    JSON.stringify(payload),
    STATSIG_BOOTSTRAP_KEY,
  );
}

/**
 * 同步 Cursor Settings 使用的用户态 auth 缓存。
 * 本地协议实现。
 */
export async function injectCursorUserInfo(
  cursorIntegration?: CursorIntegrationConfig,
  token: string = InjectAuthToken,
  backendListenAddr?: string,
): Promise<{
  path: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  membership: string;
}> {
  const config = cursorIntegration ? undefined : await loadConfig();
  const integration = cursorIntegration
    ? normalizeCursorIntegration(cursorIntegration)
    : config!.cursorIntegration;
  const resolvedBackendListenAddr = backendListenAddr || config?.backendListenAddr;
  const stateDbPath = resolveCursorStateDbPath();
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });

  const values = buildCursorAuthValues(
    integration,
    token.trim(),
    resolvedBackendListenAddr,
  );
  const db = await openStateDb(stateDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );

    const stmt = db.prepare(
      "INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)",
    );
    for (const key of Object.keys(values).sort()) {
      stmt.run(key, values[key]);
    }
    // Versions that exposed team metadata stored it here. Remove the stale
    // cache while syncing the new profile so Cursor cannot retain that UI.
    db.prepare("DELETE FROM ItemTable WHERE key = ?").run("cursorAuth/cachedTeam");
    disableCursorStatsigGates(db);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  console.log(
    `[state-db] injectCursorUserInfo path=${stateDbPath} email=${values["cursorAuth/cachedEmail"]} displayName=${integration.displayName} membership=${values["cursorAuth/stripeMembershipType"]}`,
  );

  return {
    path: stateDbPath,
    email: values["cursorAuth/cachedEmail"],
    displayName: integration.displayName,
    avatarUrl: resolveCursorAvatarUrl(
      integration.avatarUrl,
      resolvedBackendListenAddr,
    ),
    membership: values["cursorAuth/stripeMembershipType"],
  };
}
