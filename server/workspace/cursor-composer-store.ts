/**
 * Cursor's current conversation store lives in its user-data SQLite database.
 * Agent transcript JSONL files are only execution traces and may contain a
 * terminal marker without any visible conversation text.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type CursorComposerMessageRole = "user" | "assistant";

export type CursorComposerMessage = {
  id: string;
  index: number;
  role: CursorComposerMessageRole;
  text: string;
};

export type CursorComposerSession = {
  composerId: string;
  sourcePath: string;
  project: string;
  projectLabel: string;
  workspacePath?: string;
  title: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
};

type SqlRow = Record<string, unknown>;

type ComposerData = {
  fullConversationHeadersOnly?: unknown[];
};

const MAX_MESSAGE_CHARS = 24_000;
const DISPLAY_WRAPPER_TAGS = new Set([
  "user_query",
  "assistant_response",
  "assistant_reply",
  "user_message",
  "assistant_message",
]);

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

function parseJson(value: unknown): unknown {
  const text = valueText(value);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function validComposerId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function compactText(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").replace(/\0/g, "").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

export function unwrapCursorDisplayText(value: string): string {
  let next = String(value || "").replace(/\0/g, "").trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const match = next.match(/^<([a-z][a-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>$/i);
    if (!match || !DISPLAY_WRAPPER_TAGS.has(match[1].toLowerCase())) break;
    next = match[2].trim();
  }
  return next;
}

function isoFromCursorTime(value: unknown): string | undefined {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function localPathFromUri(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  if (!/^file:/i.test(raw)) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return undefined;
  }
}

function workspaceFromHeader(header: SqlRow): { project: string; label: string; path?: string } {
  const workspace = asRecord(header.workspaceIdentifier);
  const uri = asRecord(workspace?.uri);
  const workspacePath = localPathFromUri(uri?.fsPath ?? uri?.external ?? uri?.path);
  const workspaceId = typeof workspace?.id === "string" && workspace.id.trim()
    ? workspace.id.trim()
    : workspacePath || "local";

  const normalized = String(workspacePath || "").replace(/[\\/]+$/, "");
  const label = normalized
    ? path.win32.basename(normalized) || path.basename(normalized) || normalized
    : "本地项目";
  return {
    project: workspaceId,
    label: label.toLowerCase() === "desktop" ? "桌面" : label,
    path: workspacePath,
  };
}

function hasVisibleTextHeader(value: unknown): boolean {
  const header = asRecord(value);
  const grouping = asRecord(header?.grouping);
  return grouping?.hasText === true;
}

function readComposerData(db: DatabaseSync, composerId: string): ComposerData | undefined {
  try {
    const row = asRecord(
      db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`),
    );
    const value = parseJson(row?.value);
    return asRecord(value) as ComposerData | undefined;
  } catch {
    return undefined;
  }
}

function sessionFromHeader(
  header: SqlRow,
  sourcePath: string,
  messageCount: number,
): CursorComposerSession | undefined {
  const composerId = header.composerId;
  if (!validComposerId(composerId) || header.isDraft === true) return undefined;
  const workspace = workspaceFromHeader(header);
  const title = unwrapCursorDisplayText(String(header.name || header.subtitle || "").trim());
  const preview = unwrapCursorDisplayText(String(header.subtitle || "").trim());
  return {
    composerId,
    sourcePath,
    project: workspace.project,
    projectLabel: workspace.label,
    workspacePath: workspace.path,
    title: compactText(title || "未命名会话", 92),
    preview: preview ? compactText(preview, 180) : undefined,
    createdAt: isoFromCursorTime(header.createdAt),
    updatedAt: isoFromCursorTime(header.lastUpdatedAt || header.createdAt),
    messageCount,
  };
}

function cursorUserDataRoot(): string {
  const override = process.env.CURSOR_STUDIO_CURSOR_USER_DATA?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "User");
}

export async function cursorComposerStateDatabasePaths(): Promise<string[]> {
  const root = cursorUserDataRoot();
  const paths = [path.join(root, "globalStorage", "state.vscdb")];
  const workspacesRoot = path.join(root, "workspaceStorage");
  try {
    const entries = await fs.readdir(workspacesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(workspacesRoot, entry.name, "state.vscdb"));
    }
  } catch {
    // A missing workspace directory is normal on a new installation.
  }
  return paths.filter((candidate) => existsSync(candidate));
}

function readComposerHeaders(db: DatabaseSync): SqlRow[] {
  try {
    const row = asRecord(
      db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("composer.composerHeaders"),
    );
    const parsed = asRecord(parseJson(row?.value));
    return Array.isArray(parsed?.allComposers)
      ? parsed.allComposers.map(asRecord).filter((item): item is SqlRow => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function messageText(bubble: SqlRow): string {
  const direct = typeof bubble.text === "string" ? bubble.text : "";
  const rich = typeof bubble.richText === "string" ? bubble.richText : "";
  return unwrapCursorDisplayText(direct || rich);
}

function roleFromBubble(value: SqlRow): CursorComposerMessageRole | undefined {
  const type = Number(value.type);
  if (type === 1) return "user";
  if (type === 2) return "assistant";
  return undefined;
}

function readVisibleMessages(db: DatabaseSync, composerId: string): CursorComposerMessage[] {
  const data = readComposerData(db, composerId);
  const headers = Array.isArray(data?.fullConversationHeadersOnly)
    ? data.fullConversationHeadersOnly
    : [];
  if (!headers.length) return [];

  const bubbles = new Map<string, SqlRow>();
  try {
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
      .all(`bubbleId:${composerId}:%`);
    for (const rowValue of rows) {
      const row = asRecord(rowValue);
      const key = typeof row?.key === "string" ? row.key : "";
      const bubble = asRecord(parseJson(row?.value));
      const bubbleId = key.split(":").at(-1);
      if (bubble && bubbleId) bubbles.set(bubbleId, bubble);
    }
  } catch {
    return [];
  }

  const messages: CursorComposerMessage[] = [];
  for (const headerValue of headers) {
    const header = asRecord(headerValue);
    const bubbleId = typeof header?.bubbleId === "string" ? header.bubbleId : "";
    const bubble = bubbles.get(bubbleId);
    if (!bubble) continue;
    const role = roleFromBubble(bubble);
    if (!role || (role === "assistant" && !hasVisibleTextHeader(header))) continue;
    const text = messageText(bubble);
    if (!text) continue;
    const truncated = text.length > MAX_MESSAGE_CHARS;
    messages.push({
      id: bubbleId || `message-${messages.length + 1}`,
      index: messages.length,
      role,
      text: truncated
        ? `${text.slice(0, MAX_MESSAGE_CHARS).trimEnd()}\n\n内容过长，已折叠剩余部分。`
        : text,
    });
  }
  return messages;
}

/** Read every user-visible Cursor conversation from its authoritative store. */
export async function listCursorComposerSessions(
  options: { includeEmpty?: boolean } = {},
): Promise<CursorComposerSession[]> {
  const candidates = await cursorComposerStateDatabasePaths();
  const sessions = new Map<string, CursorComposerSession>();

  for (const sourcePath of candidates) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(sourcePath, { readOnly: true });
      for (const header of readComposerHeaders(db)) {
        const composerId = header.composerId;
        if (!validComposerId(composerId) || header.isDraft === true) continue;
        const data = readComposerData(db, composerId);
        const headers = Array.isArray(data?.fullConversationHeadersOnly)
          ? data.fullConversationHeadersOnly
          : [];
        const item = sessionFromHeader(
          header,
          sourcePath,
          headers.filter(hasVisibleTextHeader).length,
        );
        // Cursor can re-persist cached session headers after its message
        // records have been removed. A header alone is not a user session and
        // must never create an empty item in the Studio conversation list.
        if (!item || (!options.includeEmpty && item.messageCount === 0)) continue;
        const current = sessions.get(item.composerId);
        if (!current || (item.updatedAt || "") > (current.updatedAt || "")) {
          sessions.set(item.composerId, item);
        }
      }
    } catch {
      // Cursor can keep a database busy while committing a turn. Another scan
      // will pick it up after the next short cache interval.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore an already-closed database handle.
      }
    }
  }

  return [...sessions.values()].sort(
    (a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || "") ||
      a.composerId.localeCompare(b.composerId),
  );
}

export async function readCursorComposerMessages(
  composerId: string,
): Promise<CursorComposerMessage[] | undefined> {
  if (!validComposerId(composerId)) return undefined;
  const candidates = await cursorComposerStateDatabasePaths();
  for (const sourcePath of candidates) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(sourcePath, { readOnly: true });
      if (!readComposerHeaders(db).some((header) => header.composerId === composerId)) continue;
      return readVisibleMessages(db, composerId);
    } catch {
      // Try the next source database.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore an already-closed database handle.
      }
    }
  }
  return undefined;
}

/** Resolve an active Cursor conversation to its persisted local workspace. */
export async function resolveCursorComposerWorkspace(
  composerId: string,
): Promise<string | undefined> {
  if (!validComposerId(composerId)) return undefined;
  const sessions = await listCursorComposerSessions();
  const candidate = sessions.find((session) => session.composerId === composerId)?.workspacePath;
  if (!candidate) return undefined;
  try {
    const resolved = await fs.realpath(candidate);
    return (await fs.stat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}
