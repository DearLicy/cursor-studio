/**
 * Skills 仓库：对齐 桌面工作区
 * - 仓库列表持久化 ~/.cursor-studio/skill-repos.json
 * - 发现/安装：GitHub branch ZIP（不依赖 git）
 * - 安装目标：~/.cursor/skills/<name>/
 */
import fs from "node:fs/promises";
import {
  createWriteStream,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import {
  backupSkillDirectory,
  cursorSkillsRootPath,
  cursorStudioHomePath,
  listSkills,
  removeSkill,
  type SkillItem,
} from "./skills-store";

export type SkillRepo = {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
};

export type DiscoverableSkill = {
  key: string;
  name: string;
  description?: string;
  directory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  contentHash: string;
  installed: boolean;
  managed: boolean;
  updateAvailable: boolean;
};

type SkillSourceMeta = {
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  directory: string;
  contentHash: string;
  installedAt: string;
};

const DEFAULT_REPOS: SkillRepo[] = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "master", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: false },
  { owner: "JimLiu", name: "baoyu-skills", branch: "main", enabled: false },
];

function studioDir(): string {
  return cursorStudioHomePath();
}

function reposPath(): string {
  return path.join(studioDir(), "skill-repos.json");
}

function cursorSkillsRoot(): string {
  return cursorSkillsRootPath();
}

function cacheDir(): string {
  return path.join(studioDir(), "cache", "skill-zips");
}

async function ensureReposFile(): Promise<SkillRepo[]> {
  const p = reposPath();
  if (!existsSync(p)) {
    await fs.mkdir(studioDir(), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ repos: DEFAULT_REPOS }, null, 2) + "\n", "utf8");
    return DEFAULT_REPOS.map((r) => ({ ...r }));
  }
  try {
    const j = JSON.parse(await fs.readFile(p, "utf8")) as { repos?: SkillRepo[] };
    const list = Array.isArray(j.repos) ? j.repos : [];
    return list
      .map((r) => ({
        owner: String(r.owner || "").trim(),
        name: String(r.name || "").trim(),
        branch: String(r.branch || "main").trim() || "main",
        enabled: r.enabled !== false,
      }))
      .filter((r) => r.owner && r.name);
  } catch {
    return DEFAULT_REPOS.map((r) => ({ ...r }));
  }
}

async function saveRepos(repos: SkillRepo[]): Promise<void> {
  await fs.mkdir(studioDir(), { recursive: true });
  await fs.writeFile(reposPath(), JSON.stringify({ repos }, null, 2) + "\n", "utf8");
}

function parseGithubInput(ownerIn: string, nameIn: string): { owner: string; name: string } {
  const joined = `${ownerIn}/${nameIn}`.trim();
  const urlM = joined.match(/github\.com[/:]([^/]+)\/([^/#?\s]+)/i);
  if (urlM) {
    return { owner: urlM[1], name: urlM[2].replace(/\.git$/i, "") };
  }
  if (ownerIn.includes("/") && !nameIn.trim()) {
    const [o, n = ""] = ownerIn.split("/");
    return { owner: o.trim(), name: n.replace(/\.git$/i, "").trim() };
  }
  return {
    owner: ownerIn.trim(),
    name: nameIn.trim().replace(/\.git$/i, ""),
  };
}

export async function listSkillRepos(): Promise<{ path: string; repos: SkillRepo[] }> {
  const repos = await ensureReposFile();
  return { path: reposPath(), repos };
}

export async function addSkillRepo(input: {
  owner: string;
  name?: string;
  branch?: string;
  enabled?: boolean;
}): Promise<{ path: string; repos: SkillRepo[] }> {
  const { owner, name } = parseGithubInput(input.owner, input.name || "");
  if (!owner || !name) throw new Error("仓库格式：owner/name 或完整 GitHub URL");
  const branch = (input.branch || "main").trim() || "main";
  const repos = await ensureReposFile();
  const idx = repos.findIndex(
    (r) =>
      r.owner.toLowerCase() === owner.toLowerCase() &&
      r.name.toLowerCase() === name.toLowerCase(),
  );
  const next: SkillRepo = {
    owner,
    name,
    branch,
    enabled: input.enabled !== false,
  };
  if (idx >= 0) repos[idx] = next;
  else repos.push(next);
  await saveRepos(repos);
  return { path: reposPath(), repos };
}

export async function removeSkillRepo(
  owner: string,
  name: string,
): Promise<{ path: string; repos: SkillRepo[] }> {
  const repos = (await ensureReposFile()).filter(
    (r) =>
      !(
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase()
      ),
  );
  await saveRepos(repos);
  return { path: reposPath(), repos };
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return {};
  const nameM = fm[1].match(/^name:\s*(.+)$/m);
  const descM = fm[1].match(/^description:\s*(.+)$/m);
  return {
    name: nameM?.[1]?.trim().replace(/^["']|["']$/g, ""),
    description: descM?.[1]?.trim().replace(/^["']|["']$/g, ""),
  };
}

async function downloadZip(owner: string, name: string, branch: string): Promise<string> {
  const branches = Array.from(new Set([branch, "main", "master"].filter(Boolean)));
  await fs.mkdir(cacheDir(), { recursive: true });
  let lastErr = "";
  for (const b of branches) {
    const url = `https://github.com/${owner}/${name}/archive/refs/heads/${encodeURIComponent(b)}.zip`;
    const dest = path.join(cacheDir(), `${owner}-${name}-${b}.zip`);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "cursor-studio" },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        lastErr = `${url} → ${res.status}`;
        continue;
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
      return dest;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`下载仓库失败 ${owner}/${name}: ${lastErr}`);
}

function extractZipRoot(zipPath: string): string {
  const zip = new AdmZip(zipPath);
  const tmp = path.join(
    cacheDir(),
    `extract-${path.basename(zipPath, ".zip")}-${Date.now()}`,
  );
  zip.extractAllTo(tmp, true);
  const entries = readdirSync(tmp);
  if (entries.length === 1) {
    const only = path.join(tmp, entries[0]);
    try {
      if (statSync(only).isDirectory()) return only;
    } catch {
      /* ignore */
    }
  }
  return tmp;
}

async function walkSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    if (names.includes("SKILL.md")) {
      found.push(dir);
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const full = path.join(dir, n);
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) await walk(full, depth + 1);
      } catch {
        /* skip */
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function hashSkillDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === ".cursor-studio-source.json") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(`file:${rel}\n`);
        hash.update(await fs.readFile(full));
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

function installDirectoryName(skill: Pick<DiscoverableSkill, "directory" | "name">): string {
  const installName = path.basename(skill.directory.replace(/\\/g, "/")) || skill.name;
  return installName.replace(/[\\/:*?"<>|]/g, "-").slice(0, 64);
}

async function readSkillSourceMeta(dest: string): Promise<SkillSourceMeta | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dest, ".cursor-studio-source.json"), "utf8"),
    ) as SkillSourceMeta;
  } catch {
    return null;
  }
}

async function fetchRepoSkills(repo: SkillRepo): Promise<DiscoverableSkill[]> {
  const zipPath = await downloadZip(repo.owner, repo.name, repo.branch);
  const root = extractZipRoot(zipPath);
  try {
    const dirs = await walkSkillDirs(root);
    const out: DiscoverableSkill[] = [];
    for (const dir of dirs) {
      const rel = path.relative(root, dir).replace(/\\/g, "/");
      const directory = rel || path.basename(dir);
      let name = path.basename(dir);
      let description: string | undefined;
      try {
        const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
        const meta = parseFrontmatter(text);
        if (meta.name) name = meta.name;
        if (meta.description) description = meta.description.slice(0, 200);
      } catch {
        /* ignore */
      }
      const contentHash = await hashSkillDirectory(dir);
      const safe = installDirectoryName({ directory, name });
      const dest = path.join(cursorSkillsRoot(), safe);
      const installed = existsSync(dest);
      const sourceMeta = installed ? await readSkillSourceMeta(dest) : null;
      const managed = Boolean(
        sourceMeta &&
          sourceMeta.repoOwner === repo.owner &&
          sourceMeta.repoName === repo.name &&
          sourceMeta.directory === directory,
      );
      out.push({
        key: `${repo.owner}/${repo.name}:${directory}`,
        name,
        description,
        directory,
        repoOwner: repo.owner,
        repoName: repo.name,
        repoBranch: repo.branch,
        contentHash,
        installed,
        managed,
        updateAvailable: Boolean(managed && sourceMeta?.contentHash !== contentHash),
      });
    }
    return out;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function discoverSkills(): Promise<{
  items: DiscoverableSkill[];
  errors: Array<{ repo: string; error: string }>;
}> {
  const repos = (await ensureReposFile()).filter((r) => r.enabled);
  const items: DiscoverableSkill[] = [];
  const errors: Array<{ repo: string; error: string }> = [];
  for (const repo of repos) {
    try {
      items.push(...(await fetchRepoSkills(repo)));
    } catch (e) {
      errors.push({
        repo: `${repo.owner}/${repo.name}`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, errors };
}

async function copyDir(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

export async function installSkillFromRepo(skill: DiscoverableSkill): Promise<{
  item: SkillItem;
  installed: Awaited<ReturnType<typeof listSkills>>;
}> {
  const safe = installDirectoryName(skill);
  if (!safe) throw new Error("无效 skill 目录名");
  const dest = path.join(cursorSkillsRoot(), safe);
  if (existsSync(dest)) {
    const sourceMeta = await readSkillSourceMeta(dest);
    const sameSource =
      sourceMeta?.repoOwner === skill.repoOwner &&
      sourceMeta?.repoName === skill.repoName &&
      sourceMeta?.directory === skill.directory;
    if (!sameSource) {
      throw new Error(`Skill directory conflict: ${safe}. Existing directory is not managed by this repository.`);
    }
    await backupSkillDirectory(dest, "before-update");
    await fs.rm(dest, { recursive: true, force: true });
  }
  const zipPath = await downloadZip(skill.repoOwner, skill.repoName, skill.repoBranch);
  const root = extractZipRoot(zipPath);
  try {
    const source = path.join(root, skill.directory);
    let from = source;
    if (!existsSync(source)) {
      const dirs = await walkSkillDirs(root);
      const hit =
        dirs.find((d) => path.relative(root, d).replace(/\\/g, "/") === skill.directory) ||
        dirs.find((d) => path.basename(d) === path.basename(skill.directory));
      if (!hit) throw new Error(`仓库中未找到目录 ${skill.directory}`);
      from = hit;
    }
    await copyDir(from, dest);
    if (!existsSync(path.join(dest, "SKILL.md"))) {
      throw new Error("安装后缺少 SKILL.md");
    }
    const sourceMeta: SkillSourceMeta = {
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch: skill.repoBranch,
      directory: skill.directory,
      contentHash: skill.contentHash || (await hashSkillDirectory(dest)),
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(dest, ".cursor-studio-source.json"),
      JSON.stringify(sourceMeta, null, 2) + "\n",
      "utf8",
    );
    const installed = await listSkills();
    const item =
      installed.items.find((i) => path.resolve(i.path) === path.resolve(dest)) ||
      ({
        id: `skills:${safe}`,
        name: skill.name,
        source: "skills",
        path: dest,
        description: skill.description,
        hasSkillMd: true,
      } as SkillItem);
    return { item, installed };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function uninstallInstalledSkill(skillPath: string) {
  await removeSkill(skillPath);
  return listSkills();
}
