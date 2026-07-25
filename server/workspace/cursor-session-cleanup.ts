/**
 * Deletes Cursor conversations from the same stores used by the Cursor UI.
 * The database is updated in a transaction; unrelated user settings are left
 * intact. Matching agent transcript directories are removed with the session.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cursorComposerStateDatabasePaths } from "./cursor-composer-store";

type SqlRow = Record<string, unknown>;

export type CursorSessionCleanupResult = {
  removed: string[];
  databaseEntries: number;
  transcriptDirectories: number;
  failed: Array<{ target: string; error: string }>;
};

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_KEY_PREFIXES = [
  "bubbleId",
  "composerData",
  "checkpointId",
  "composerVirtualRowHeights",
];

function asRecord(value: unknown): SqlRow | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SqlRow)
    : undefined;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(
    ids
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.replace(/^cursor:/, "").trim())
      .filter((value) => COMPOSER_ID.test(value)),
  )];
}

function cursorHome(): string {
  const override = process.env.CURSOR_STUDIO_CURSOR_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".cursor");
}

function underRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name));
  } catch {
    return false;
  }
}

function composerIdsFromHeaders(db: DatabaseSync): string[] {
  if (!tableExists(db, "ItemTable")) return [];
  try {
    const row = asRecord(
      db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("composer.composerHeaders"),
    );
    const text = valueText(row?.value);
    const parsed = text ? asRecord(JSON.parse(text)) : undefined;
    const items = Array.isArray(parsed?.allComposers) ? parsed.allComposers : [];
    return items
      .map(asRecord)
      .map((header) => (typeof header?.composerId === "string" ? header.composerId : ""))
      .filter((id) => COMPOSER_ID.test(id));
  } catch {
    return [];
  }
}

function countRows(db: DatabaseSync, pattern: string): number {
  try {
    const row = asRecord(db.prepare("SELECT COUNT(*) AS count FROM cursorDiskKV WHERE key LIKE ?").get(pattern));
    return Number(row?.count || 0) || 0;
  } catch {
    return 0;
  }
}

function deleteRows(db: DatabaseSync, pattern: string): number {
  const count = countRows(db, pattern);
  if (count > 0) db.prepare("DELETE FROM cursorDiskKV WHERE key LIKE ?").run(pattern);
  return count;
}

function rewriteHeaders(db: DatabaseSync, removedIds: Set<string>, clearAll: boolean): void {
  if (!tableExists(db, "ItemTable")) return;
  const row = asRecord(
    db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("composer.composerHeaders"),
  );
  const text = valueText(row?.value);
  if (!text) return;

  let parsed: SqlRow;
  try {
    parsed = asRecord(JSON.parse(text)) || {};
  } catch {
    return;
  }
  const all = Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
  parsed.allComposers = clearAll
    ? []
    : all.filter((item) => {
        const header = asRecord(item);
        return !removedIds.has(String(header?.composerId || ""));
      });
  db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
    .run(JSON.stringify(parsed), "composer.composerHeaders");
}

function removeTableHeaders(db: DatabaseSync, ids: string[], clearAll: boolean): number {
  if (!tableExists(db, "composerHeaders")) return 0;
  const row = asRecord(db.prepare("SELECT COUNT(*) AS count FROM composerHeaders").get());
  const count = Number(row?.count || 0) || 0;
  if (!count) return 0;
  if (clearAll) {
    db.exec("DELETE FROM composerHeaders");
    return count;
  }
  let removed = 0;
  for (const id of ids) {
    const current = asRecord(
      db.prepare("SELECT COUNT(*) AS count FROM composerHeaders WHERE composerId = ?").get(id),
    );
    const amount = Number(current?.count || 0) || 0;
    if (amount) {
      db.prepare("DELETE FROM composerHeaders WHERE composerId = ?").run(id);
      removed += amount;
    }
  }
  return removed;
}

async function removeFromDatabase(
  databasePath: string,
  requestedIds: string[] | undefined,
): Promise<{ removed: string[]; entries: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath);
      db.exec("PRAGMA busy_timeout = 3000");
      const headerIds = composerIdsFromHeaders(db);
      const clearAll = requestedIds == null;
      const targetIds = clearAll ? headerIds : requestedIds;
      const removedIds = clearAll ? headerIds : targetIds.filter((id) => headerIds.includes(id));
      const removedSet = new Set(targetIds);

      db.exec("BEGIN IMMEDIATE");
      let entries = 0;
      try {
        if (tableExists(db, "cursorDiskKV")) {
          if (clearAll) {
            for (const prefix of CONVERSATION_KEY_PREFIXES) {
              entries += deleteRows(db, `${prefix}:%`);
            }
          } else {
            for (const id of targetIds) {
              entries += deleteRows(db, `bubbleId:${id}:%`);
              entries += deleteRows(db, `composerData:${id}`);
              entries += deleteRows(db, `checkpointId:${id}:%`);
              entries += deleteRows(db, `composerVirtualRowHeights:${id}`);
            }
          }
        }
        rewriteHeaders(db, removedSet, clearAll);
        entries += removeTableHeaders(db, targetIds, clearAll);
        if (clearAll && tableExists(db, "ItemTable")) {
          db.prepare("DELETE FROM ItemTable WHERE key IN (?, ?)")
            .run("composer.planRegistry", "composer.planRedirects");
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
        throw error;
      }
      return { removed: removedIds, entries };
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(120 * (attempt + 1));
        continue;
      }
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore a failed close after an open error.
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function transcriptDirectoriesFor(ids?: string[]): Promise<string[]> {
  const root = cursorHome();
  const projectsRoot = path.join(root, "projects");
  let projects: import("node:fs").Dirent[];
  try {
    projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const requested = ids ? new Set(ids) : undefined;
  const targets: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcriptRoot = path.join(projectsRoot, project.name, "agent-transcripts");
    if (!existsSync(transcriptRoot) || !underRoot(root, transcriptRoot)) continue;
    if (!requested) {
      targets.push(transcriptRoot);
      continue;
    }
    for (const id of requested) {
      const sessionRoot = path.join(transcriptRoot, id);
      if (existsSync(sessionRoot) && underRoot(root, sessionRoot)) targets.push(sessionRoot);
    }
  }
  return targets;
}

async function removeTranscriptDirectories(
  ids: string[] | undefined,
): Promise<{ count: number; failed: Array<{ target: string; error: string }> }> {
  const targets = await transcriptDirectoriesFor(ids);
  let count = 0;
  const failed: Array<{ target: string; error: string }> = [];
  for (const target of targets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      count += 1;
    } catch (error) {
      failed.push({
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { count, failed };
}

async function cleanup(ids?: string[]): Promise<CursorSessionCleanupResult> {
  const targets = ids ? normalizeIds(ids) : undefined;
  const removed = new Set<string>();
  let databaseEntries = 0;
  const failed: Array<{ target: string; error: string }> = [];

  for (const databasePath of await cursorComposerStateDatabasePaths()) {
    try {
      const result = await removeFromDatabase(databasePath, targets);
      result.removed.forEach((id) => removed.add(id));
      databaseEntries += result.entries;
    } catch (error) {
      failed.push({
        target: databasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const transcripts = await removeTranscriptDirectories(targets);
  failed.push(...transcripts.failed);
  return {
    removed: [...removed],
    databaseEntries,
    transcriptDirectories: transcripts.count,
    failed,
  };
}

export async function removeCursorComposerSessions(
  composerIds: string[],
): Promise<CursorSessionCleanupResult> {
  return cleanup(composerIds);
}

export async function clearAllCursorComposerSessions(): Promise<CursorSessionCleanupResult> {
  return cleanup();
}
