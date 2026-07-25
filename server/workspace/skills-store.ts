/**
 * Cursor-native Skills catalog.
 *
 * Cursor discovers SKILL.md files from several global and workspace roots.
 * This module mirrors those locations for file management only; it never
 * changes model instructions or the Cursor managed-skills protocol.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SCAN_DEPTH = 8;
const MAX_SKILLS_PER_ROOT = 400;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_SKILL_CONTENT_CHARS = 512 * 1024;
const MAX_SKILL_CONTENT_BYTES = MAX_SKILL_CONTENT_CHARS * 4 + 4;
const MAX_CONCURRENT_ROOT_SCANS = 12;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build"]);

export type SkillSource =
  | "skills"
  | "skills-cursor"
  | "cursor-plugin"
  | "cursor-cloud"
  | "claude-plugin"
  | "agents"
  | "codex"
  | "claude"
  | "other";

export type SkillScope = "global" | "workspace";
export type SkillEntryKind = "directory" | "file";

export type SkillItem = {
  id: string;
  name: string;
  source: SkillSource;
  path: string;
  description?: string;
  hasSkillMd: boolean;
  scope: SkillScope;
  workspacePath?: string;
  writable: boolean;
  relativePath: string;
  /** Directory bundles contain SKILL.md; cloud/root Skills can be one Markdown file. */
  entryKind?: SkillEntryKind;
  /** The file Cursor reads for this entry. Kept separate so directory bundles retain their path. */
  contentPath?: string;
};

export type ListSkillsOptions = {
  /** Limit project entries to this Cursor workspace while keeping global Skills. */
  workspaceRoot?: string;
  /** Include Skills from Cursor's known workspaceStorage inventory. */
  includeKnownWorkspaces?: boolean;
};

type RootSpec = {
  root: string;
  source: SkillSource;
  scope: SkillScope;
  workspacePath?: string;
};

type SkillMeta = {
  name: string;
  description?: string;
};

function cursorHome(): string {
  const override = process.env.CURSOR_STUDIO_CURSOR_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".cursor");
}

function studioHome(): string {
  const override = process.env.CURSOR_STUDIO_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".cursor-studio");
}

function cursorWorkspaceStorageRoot(): string {
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
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "Cursor",
    "User",
    "workspaceStorage",
  );
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

/**
 * Cursor 2.x recognizes these roots as Skills. Sources marked here are owned
 * by Cursor, a plugin, or Cursor's cloud sync layer and must not be mutated by
 * this manager even when the current OS account has write access.
 */
function isManagedCursorSource(source: SkillSource): boolean {
  return source === "skills-cursor" || source === "cursor-plugin" || source === "cursor-cloud" || source === "claude-plugin";
}

function pathId(source: SkillSource, skillPath: string): string {
  const digest = createHash("sha256")
    .update(`${source}:${normalizePath(skillPath)}`)
    .digest("hex")
    .slice(0, 20);
  return `skill:${digest}`;
}

function isNestedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeSkillName(name: string): string {
  const value = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 64)
    .replace(/[. ]+$/g, "");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)
  ) {
    throw new Error("Invalid skill name");
  }
  return value;
}

function globalRootSpecs(): RootSpec[] {
  const home = os.homedir();
  const cursor = cursorHome();
  return [
    { root: path.join(cursor, "skills"), source: "skills", scope: "global" },
    { root: path.join(cursor, "skills-cursor"), source: "skills-cursor", scope: "global" },
    { root: path.join(cursor, "plugins"), source: "cursor-plugin", scope: "global" },
    { root: path.join(cursor, "cloud-skills"), source: "cursor-cloud", scope: "global" },
    { root: path.join(home, ".agents", "skills"), source: "agents", scope: "global" },
    { root: path.join(home, ".codex", "skills"), source: "codex", scope: "global" },
    { root: path.join(home, ".claude", "skills"), source: "claude", scope: "global" },
    { root: path.join(home, ".claude", "plugins"), source: "claude-plugin", scope: "global" },
  ];
}

function workspaceRootSpecs(workspacePath: string): RootSpec[] {
  return [
    { root: path.join(workspacePath, ".cursor", "skills"), source: "skills", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".cursor", "skills-cursor"), source: "skills-cursor", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".cursor", "plugins"), source: "cursor-plugin", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".cursor", "cloud-skills"), source: "cursor-cloud", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".agents", "skills"), source: "agents", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".codex", "skills"), source: "codex", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".claude", "skills"), source: "claude", scope: "workspace", workspacePath },
    { root: path.join(workspacePath, ".claude", "plugins"), source: "claude-plugin", scope: "workspace", workspacePath },
  ];
}

function appendWorkspaceCandidates(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendWorkspaceCandidates(entry, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const pathKeys = new Set([
    "folder",
    "workspace",
    "uri",
    "fspath",
    "workspacepath",
    "workingdirectory",
    "cwd",
  ]);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (pathKeys.has(key.replace(/[_.-]/g, "").toLowerCase()) && typeof entry === "string") {
      out.push(entry);
    }
    appendWorkspaceCandidates(entry, out, depth + 1);
  }
}

function localPathFromWorkspaceValue(value: string): string | undefined {
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  if (!raw || raw.length > 4096 || raw.includes("\0")) return undefined;
  if (!/^file:/i.test(raw)) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return undefined;
  }
}

async function canonicalDirectory(value: string): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(value);
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalSkillEntry(
  value: string,
): Promise<{ path: string; entryKind: SkillEntryKind } | undefined> {
  try {
    const resolved = await fs.realpath(value);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) return { path: resolved, entryKind: "directory" };
    if (stat.isFile()) return { path: resolved, entryKind: "file" };
    return undefined;
  } catch {
    return undefined;
  }
}

async function knownWorkspaceRoots(): Promise<string[]> {
  const storage = cursorWorkspaceStorageRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(storage, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots = new Map<string, string>();
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isDirectory()) continue;
    const file = path.join(storage, entry.name, "workspace.json");
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const candidates: string[] = [];
      appendWorkspaceCandidates(parsed, candidates);
      for (const candidate of candidates) {
        const local = localPathFromWorkspaceValue(candidate);
        if (!local) continue;
        const root = await canonicalDirectory(local);
        if (root) roots.set(normalizePath(root), root);
      }
    } catch {
      // Cursor may update workspaceStorage while it is being read.
    }
  }
  return [...roots.values()];
}

async function readSkillMeta(file: string, fallbackName: string): Promise<SkillMeta | undefined> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_METADATA_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const field = (key: string) => frontmatter?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "");
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const name = field("name") || heading || fallbackName;
      const description = field("description") || text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#") && !line.startsWith("---") && !/^[A-Za-z_-]+:\s*/.test(line));
      return { name: name.slice(0, 160), description: description?.slice(0, 240) };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function isSkillWritable(
  source: SkillSource,
  entryPath: string,
  contentPath: string,
): Promise<boolean> {
  if (isManagedCursorSource(source)) return false;
  try {
    await fs.access(contentPath, constants.W_OK);
    await fs.access(entryPath === contentPath ? path.dirname(contentPath) : entryPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function buildSkillItem(
  spec: RootSpec,
  root: string,
  entryPath: string,
  contentPath: string,
  entryKind: SkillEntryKind,
): Promise<SkillItem | undefined> {
  const fallbackName = entryKind === "directory"
    ? path.basename(entryPath)
    : path.basename(contentPath, path.extname(contentPath));
  const meta = await readSkillMeta(contentPath, fallbackName);
  if (!meta) return undefined;
  return {
    id: pathId(spec.source, entryPath),
    name: meta.name,
    source: spec.source,
    path: entryPath,
    description: meta.description,
    // Backward-compatible flag used by the renderer to identify a usable entry.
    hasSkillMd: true,
    scope: spec.scope,
    workspacePath: spec.workspacePath,
    writable: await isSkillWritable(spec.source, entryPath, contentPath),
    relativePath: path.relative(root, entryPath).replace(/\\/g, "/"),
    entryKind,
    contentPath,
  };
}

async function scanRoot(spec: RootSpec): Promise<SkillItem[]> {
  const root = await canonicalDirectory(spec.root);
  if (!root) return [];

  const found: SkillItem[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_SKILLS_PER_ROOT) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    if (spec.source === "cursor-cloud") {
      for (const entry of entries) {
        if (
          found.length >= MAX_SKILLS_PER_ROOT ||
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !entry.name.toLowerCase().endsWith(".md")
        ) {
          continue;
        }
        const file = path.join(directory, entry.name);
        const item = await buildSkillItem(spec, root, file, file, "file");
        if (item) found.push(item);
      }
    } else {
      const skillFile = entries.find(
        (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name === "SKILL.md",
      );
      if (skillFile && isNestedPath(root, directory)) {
        const item = await buildSkillItem(
          spec,
          root,
          directory,
          path.join(directory, skillFile.name),
          "directory",
        );
        if (item) found.push(item);
        return;
      }
      // Cursor also recognizes a direct SKILL.md in the root. Represent it as
      // a file so a delete can never remove the entire configured root.
      if (skillFile && directory === root) {
        const file = path.join(directory, skillFile.name);
        const item = await buildSkillItem(spec, root, file, file, "file");
        if (item) found.push(item);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const real = await canonicalDirectory(child);
      if (!real || (real !== root && !isNestedPath(root, real))) continue;
      await visit(real, depth + 1);
    }
  };

  await visit(root, 0);
  return found;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      result[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return result;
}

function sortSkills(a: SkillItem, b: SkillItem): number {
  if (a.scope !== b.scope) return a.scope === "workspace" ? -1 : 1;
  const byName = a.name.localeCompare(b.name);
  if (byName) return byName;
  return a.path.localeCompare(b.path);
}

export async function listSkills(
  options: ListSkillsOptions = {},
): Promise<{ roots: string[]; items: SkillItem[] }> {
  const requestedWorkspace = options.workspaceRoot
    ? await canonicalDirectory(options.workspaceRoot)
    : undefined;
  const includeKnownWorkspaces = options.includeKnownWorkspaces ?? !requestedWorkspace;
  const workspaceRoots = new Map<string, string>();
  if (requestedWorkspace) workspaceRoots.set(normalizePath(requestedWorkspace), requestedWorkspace);
  if (includeKnownWorkspaces) {
    for (const root of await knownWorkspaceRoots()) workspaceRoots.set(normalizePath(root), root);
  }

  const specs = [
    ...globalRootSpecs(),
    ...[...workspaceRoots.values()].flatMap((workspacePath) => workspaceRootSpecs(workspacePath)),
  ];
  const batches = await mapWithConcurrency(specs, MAX_CONCURRENT_ROOT_SCANS, scanRoot);
  const byPath = new Map<string, SkillItem>();
  for (const item of batches.flat()) {
    const key = normalizePath(item.path);
    const previous = byPath.get(key);
    if (!previous || (previous.scope === "global" && item.scope === "workspace")) {
      byPath.set(key, item);
    }
  }
  return { roots: specs.map((spec) => spec.root), items: [...byPath.values()].sort(sortSkills) };
}

async function findKnownSkill(skillPath: string): Promise<SkillItem> {
  const resolved = await canonicalSkillEntry(skillPath);
  if (!resolved) throw new Error("Skill directory does not exist");
  const { items } = await listSkills();
  const item = items.find((candidate) => normalizePath(candidate.path) === normalizePath(resolved.path));
  if (!item) throw new Error("Skill path is outside Cursor skill locations");
  return item;
}

/** Resolves an API-supplied path only when it is one of Cursor's discovered Skills. */
export async function resolveKnownSkillPath(skillPath: string): Promise<string> {
  return (await findKnownSkill(skillPath)).path;
}

/** Shared Cursor location for repository installs and isolated test overrides. */
export function cursorSkillsRootPath(): string {
  return path.join(cursorHome(), "skills");
}

/** Shared Studio data location for backups, repository state, and test overrides. */
export function cursorStudioHomePath(): string {
  return studioHome();
}

function defaultSkillDocument(name: string, description: string): string {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
  ].join("\n");
}

async function writableGlobalSkillsRoot(): Promise<string> {
  const root = cursorSkillsRootPath();
  await fs.mkdir(root, { recursive: true });
  const resolved = await canonicalDirectory(root);
  if (!resolved) throw new Error("Unable to create Cursor skills directory");
  return resolved;
}

export async function createSkill(input: {
  name: string;
  description?: string;
  content?: string;
}): Promise<SkillItem> {
  const folder = safeSkillName(input.name);
  const root = await writableGlobalSkillsRoot();
  const directory = path.join(root, folder);
  if (existsSync(directory)) throw new Error("A skill with this name already exists");
  const description = String(input.description || "").trim().slice(0, 240) || "Cursor skill";
  const content = String(input.content || "").trim() || defaultSkillDocument(folder, description);
  if (content.length > MAX_SKILL_CONTENT_CHARS) throw new Error("Skill content is too large");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return findKnownSkill(directory);
}

export async function backupSkillDirectory(skillPath: string, reason = "manual"): Promise<string | null> {
  const item = await findKnownSkill(skillPath);
  const root = path.join(studioHome(), "backups", "skills");
  await fs.mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = reason.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64) || "manual";
  const target = path.join(root, `${path.basename(item.path)}-${stamp}-${suffix}-${randomUUID().slice(0, 8)}`);
  if (item.entryKind === "file") {
    await fs.mkdir(target, { recursive: false });
    const contentPath = item.contentPath || item.path;
    await fs.copyFile(contentPath, path.join(target, path.basename(contentPath)));
  } else {
    await fs.cp(item.path, target, { recursive: true, errorOnExist: false });
  }
  return target;
}

export async function updateSkillContent(
  skillPath: string,
  content: string,
): Promise<SkillItem> {
  const item = await findKnownSkill(skillPath);
  if (!item.writable) throw new Error("This skill is read-only");
  const next = String(content ?? "");
  if (!next.trim()) throw new Error("Skill content cannot be empty");
  if (next.length > MAX_SKILL_CONTENT_CHARS) throw new Error("Skill content is too large");
  await backupSkillDirectory(item.path, "before-edit");
  const file = item.contentPath || path.join(item.path, "SKILL.md");
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return findKnownSkill(item.path);
}

export async function removeSkill(skillPath: string): Promise<{ ok: true }> {
  const item = await findKnownSkill(skillPath);
  if (!item.writable) throw new Error("This skill is read-only");
  await backupSkillDirectory(item.path, "before-remove");
  await fs.rm(item.path, { recursive: item.entryKind !== "file", force: true });
  return { ok: true };
}

export async function readSkillContent(
  skillPath: string,
  maxChars = MAX_SKILL_CONTENT_CHARS,
): Promise<{ path: string; text: string; truncated: boolean }> {
  const item = await findKnownSkill(skillPath);
  const file = item.contentPath || path.join(item.path, "SKILL.md");
  const limit = Math.max(1, Math.min(MAX_SKILL_CONTENT_CHARS, Math.floor(Number(maxChars) || MAX_SKILL_CONTENT_CHARS)));
  const byteLimit = Math.min(MAX_SKILL_CONTENT_BYTES, Math.max(4, limit * 4 + 4));
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, byteLimit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      path: file,
      text: text.slice(0, limit),
      truncated: stat.size > bytesRead || text.length > limit,
    };
  } finally {
    await handle.close();
  }
}
