import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  configPath,
  loadConfig,
  saveConfig,
  studioHome,
  type AppConfig,
} from "./store";

/**
 * Configuration snapshots are intentionally short-lived. They protect the
 * current editing session without turning the local Studio directory into an
 * unbounded archive.
 */
export const MAX_CONFIG_BACKUPS = 3;

export interface ConfigBackupInfo {
  name: string;
  createdAt: string;
  size: number;
}

export interface ConfigBackupCleanupResult {
  /** Snapshot filenames removed by this operation. */
  removed: string[];
  /** Number of configuration snapshots still available afterwards. */
  remaining: number;
}

function backupDir(): string {
  return path.join(studioHome(), "backups");
}

function isSafeBackupName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+\.yaml$/.test(name) && path.basename(name) === name;
}

async function ensureBackupDir(): Promise<void> {
  await fs.mkdir(backupDir(), { recursive: true });
}

async function readConfigBackups(): Promise<ConfigBackupInfo[]> {
  const entries = await fs.readdir(backupDir(), { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && isSafeBackupName(entry.name))
    .map((entry) => entry.name);
  const items = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(path.join(backupDir(), name));
      return { name, createdAt: stat.mtime.toISOString(), size: stat.size };
    }),
  );
  return items.sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.name.localeCompare(a.name),
  );
}

async function pruneConfigBackups(
  keepName?: string,
): Promise<ConfigBackupCleanupResult> {
  const items = await readConfigBackups();
  const ordered = keepName
    ? [
        ...items.filter((item) => item.name === keepName),
        ...items.filter((item) => item.name !== keepName),
      ]
    : items;
  const retained = new Set(
    ordered.slice(0, MAX_CONFIG_BACKUPS).map((item) => item.name),
  );
  const removed = items
    .filter((item) => !retained.has(item.name))
    .map((item) => item.name);

  await Promise.all(
    removed.map((name) => fs.unlink(path.join(backupDir(), name))),
  );

  return { removed, remaining: items.length - removed.length };
}

export async function createConfigBackup(reason = "manual"): Promise<ConfigBackupInfo | null> {
  await ensureBackupDir();
  const source = configPath();
  if (!existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `config-${stamp}-${reason.replace(/[^a-z0-9_-]/gi, "-")}-${randomUUID().slice(0, 6)}.yaml`;
  const target = path.join(backupDir(), name);
  await fs.copyFile(source, target);
  // Always retain the snapshot just made, even when several writes happen in
  // the same filesystem timestamp tick.
  await pruneConfigBackups(name);
  const stat = await fs.stat(target);
  return { name, createdAt: stat.mtime.toISOString(), size: stat.size };
}

export async function listConfigBackups(): Promise<ConfigBackupInfo[]> {
  await ensureBackupDir();
  // Apply the retention rule when opening the list as well, so older versions
  // of Studio that left more snapshots behind are brought back to the same
  // three-item limit without requiring another save.
  await pruneConfigBackups();
  return readConfigBackups();
}

export async function removeConfigBackup(
  name: string,
): Promise<ConfigBackupCleanupResult> {
  if (!isSafeBackupName(name)) throw new Error("Invalid backup name");
  await ensureBackupDir();

  const target = path.join(backupDir(), name);
  let removed: string[] = [];
  try {
    await fs.unlink(target);
    removed = [name];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const backups = await listConfigBackups();
  return { removed, remaining: backups.length };
}

export async function clearConfigBackups(): Promise<ConfigBackupCleanupResult> {
  await ensureBackupDir();
  const items = await readConfigBackups();
  const removed = items.map((item) => item.name);
  await Promise.all(
    removed.map((name) => fs.unlink(path.join(backupDir(), name))),
  );
  return { removed, remaining: 0 };
}

function mergeImportedConfig(current: AppConfig, raw: unknown): AppConfig {
  const imported = raw && typeof raw === "object" ? (raw as Partial<AppConfig>) : {};
  return {
    ...current,
    ...imported,
    providers: Array.isArray(imported.providers) ? imported.providers : current.providers,
    appearance: {
      ...current.appearance,
      ...(imported.appearance || {}),
    },
    cursorIntegration: {
      ...current.cursorIntegration,
      ...(imported.cursorIntegration || {}),
    },
    balanceAccounts: Array.isArray(imported.balanceAccounts)
      ? imported.balanceAccounts
      : current.balanceAccounts,
  };
}

export async function importConfig(raw: unknown): Promise<AppConfig> {
  const current = await loadConfig();
  await createConfigBackup("before-import");
  return saveConfig(mergeImportedConfig(current, raw));
}

export async function restoreConfigBackup(name: string): Promise<AppConfig> {
  if (!isSafeBackupName(name)) throw new Error("Invalid backup name");
  const source = path.join(backupDir(), name);
  const text = await fs.readFile(source, "utf8");
  const parsed = YAML.parse(text);
  const current = await loadConfig();
  await createConfigBackup("before-restore");
  return saveConfig(mergeImportedConfig(current, parsed));
}
