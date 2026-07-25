import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCursorStateDbPath } from "../../cursor/state-db";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 8;
const COMPOSER_HEADERS_KEY = "composer.composerHeaders";
const WORKSPACE_PATH_KEYS = new Set([
  "cwd",
  "workingdirectory",
  "workspaceroot",
  "workspacepath",
  "folder",
  "folderuri",
]);

export type WorkspaceContextOptions = {
  stateDbPath?: string;
  workspaceStorageRoot?: string;
};

function cursorHome(): string {
  const override = process.env.CURSOR_STUDIO_CURSOR_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".cursor");
}

function cursorWorkspaceStorageRoot(opts?: WorkspaceContextOptions): string {
  if (opts?.workspaceStorageRoot) return path.resolve(opts.workspaceStorageRoot);

  const override = process.env.CURSOR_STUDIO_CURSOR_USER_DATA?.trim();
  if (override) return path.join(path.resolve(override), "workspaceStorage");

  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Cursor",
      "User",
      "workspaceStorage",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "workspaceStorage",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "Cursor",
    "User",
    "workspaceStorage",
  );
}

function normalizeConversationId(value: string): string | undefined {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(id) ? id : undefined;
}

function normalizedWorkspaceKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function collectWorkspaceValues(
  value: unknown,
  values: string[],
  depth = 0,
): void {
  if (depth > MAX_SCAN_DEPTH || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectWorkspaceValues(entry, values, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (WORKSPACE_PATH_KEYS.has(normalizedWorkspaceKey(key)) && typeof entry === "string") {
      values.push(entry);
    }
    collectWorkspaceValues(entry, values, depth + 1);
  }
}

function toLocalPath(value: string): string | undefined {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw || raw.length > 4096 || raw.includes("\0")) return undefined;
  if (!/^file:/i.test(raw)) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return undefined;
  }
}

async function existingDirectory(value: string): Promise<string | undefined> {
  const localPath = toLocalPath(value);
  if (!localPath) return undefined;
  try {
    const resolved = await fs.realpath(localPath);
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function sqliteValueAsText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value == null ? undefined : String(value);
}

function findComposerHeader(
  payload: unknown,
  conversationId: string,
): Record<string, unknown> | undefined {
  const headers = Array.isArray(payload)
    ? payload
    : Object.values(asRecord(payload) || {});
  const matches: Record<string, unknown>[] = [];

  for (const group of headers) {
    const entries = Array.isArray(group) ? group : [group];
    for (const entry of entries) {
      const header = asRecord(entry);
      if (header?.composerId === conversationId) matches.push(header);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function resolveComposerWorkspaceRoot(
  conversationId: string,
  stateDbPath: string,
): Promise<string | undefined> {
  if (!existsSync(stateDbPath)) return undefined;

  let db: { prepare: (sql: string) => { get: (...params: unknown[]) => unknown }; close: () => void } | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(COMPOSER_HEADERS_KEY) as { value?: unknown } | undefined;
    const raw = sqliteValueAsText(row?.value);
    if (!raw) return undefined;

    const header = findComposerHeader(JSON.parse(raw), conversationId);
    const workspaceIdentifier = header ? asRecord(header.workspaceIdentifier) : undefined;
    const uri = workspaceIdentifier ? asRecord(workspaceIdentifier.uri) : undefined;
    return typeof uri?.fsPath === "string" ? existingDirectory(uri.fsPath) : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Cursor can rotate this database while a read-only query is closing.
    }
  }
}

async function transcriptFilesForConversation(conversationId: string): Promise<string[]> {
  const projectsRoot = path.join(cursorHome(), "projects");
  let projects: import("node:fs").Dirent[];
  try {
    projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const sessionRoot = path.join(
      projectsRoot,
      project.name,
      "agent-transcripts",
      conversationId,
    );
    const primaryTranscript = path.join(sessionRoot, `${conversationId}.jsonl`);
    try {
      const stat = await fs.stat(primaryTranscript);
      if (stat.isFile()) matches.push(primaryTranscript);
    } catch {
      // The transcript can be created or rotated while Cursor is active.
    }
  }
  return matches;
}

function projectSlugFromTranscript(filePath: string): string | undefined {
  const conversationDir = path.dirname(filePath);
  const transcriptsDir = path.dirname(conversationDir);
  if (path.basename(transcriptsDir) !== "agent-transcripts") return undefined;
  const projectSlug = path.basename(path.dirname(transcriptsDir)).trim().toLowerCase();
  return projectSlug || undefined;
}

function cursorProjectSlugForWorkspace(workspace: string): string {
  return path.win32
    .resolve(workspace)
    .replace(/[:\\/]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function resolveTranscriptProjectWorkspaceRoot(
  transcriptFile: string,
  opts?: WorkspaceContextOptions,
): Promise<string | undefined> {
  const projectSlug = projectSlugFromTranscript(transcriptFile);
  if (!projectSlug) return undefined;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(cursorWorkspaceStorageRoot(opts), { withFileTypes: true });
  } catch {
    return undefined;
  }

  const roots = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceFile = path.join(
      cursorWorkspaceStorageRoot(opts),
      entry.name,
      "workspace.json",
    );
    let contents = "";
    try {
      const stat = await fs.stat(workspaceFile);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      contents = await fs.readFile(workspaceFile, "utf8");
    } catch {
      continue;
    }

    const candidates: string[] = [];
    try {
      collectWorkspaceValues(JSON.parse(contents), candidates);
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      const localCandidate = toLocalPath(candidate);
      const root = await existingDirectory(candidate);
      const matchesProject = Boolean(
        root && (
          cursorProjectSlugForWorkspace(root) === projectSlug ||
          (localCandidate && cursorProjectSlugForWorkspace(localCandidate) === projectSlug)
        ),
      );
      if (root && matchesProject) {
        roots.add(root);
      }
    }
  }

  return roots.size === 1 ? [...roots][0] : undefined;
}

async function readTranscriptPrefix(filePath: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Resolves a Cursor conversation from Cursor's composer header index first,
 * then falls back to a unique persisted transcript with a verified workspace.
 */
export async function resolveConversationWorkspaceRoot(
  rawConversationId: string,
  opts?: WorkspaceContextOptions,
): Promise<string | undefined> {
  const conversationId = normalizeConversationId(rawConversationId);
  if (!conversationId) return undefined;

  const composerRoot = await resolveComposerWorkspaceRoot(
    conversationId,
    opts?.stateDbPath || resolveCursorStateDbPath(),
  );
  if (composerRoot) return composerRoot;

  const transcripts = await transcriptFilesForConversation(conversationId);
  if (transcripts.length !== 1) return undefined;

  const transcriptProjectRoot = await resolveTranscriptProjectWorkspaceRoot(
    transcripts[0],
    opts,
  );
  if (transcriptProjectRoot) return transcriptProjectRoot;

  const prefix = await readTranscriptPrefix(transcripts[0]);
  if (!prefix) return undefined;

  const rawCandidates: string[] = [];
  for (const line of prefix.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectWorkspaceValues(JSON.parse(line), rawCandidates);
    } catch {
      // A partial final line is expected when the transcript is still open.
    }
  }

  const roots = new Set<string>();
  for (const candidate of rawCandidates) {
    const root = await existingDirectory(candidate);
    if (root) roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : undefined;
}
