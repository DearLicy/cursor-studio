/**
 * 本地协议实现。
 * 当前在 backend 进程内执行，结果回灌模型；同时经 SSE 发出工具事件供 UI。
 */
import fs from "node:fs/promises";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EXECUTABLE_TOOLS } from "./tool-catalog";
import { callMcpTool } from "../../workspace/mcp-probe";
import { getMcpServerSpec } from "../../workspace/mcp-store";

export type ToolInvocation = {
  id: string;
  name: string;
  arguments: string; // JSON string
};

export type ToolExecResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
};

export type RuntimeTodoItem = {
  id: string;
  content: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  created_at?: number;
  updated_at?: number;
  dependencies?: string[];
};

type BgShell = {
  shellId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  startedAt: number;
  done: boolean;
  forcedBackground: boolean;
  forcedBackgroundAt?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  child?: ChildProcessWithoutNullStreams;
};

const todosByStateKey = new Map<string, RuntimeTodoItem[]>();
/** requestId → shellId → job */
const shellsByRequest = new Map<string, Map<string, BgShell>>();
let shellSeq = 0;

const MAX_RESULT = 80_000;
const MAX_SHELL_BUF = 256_000;
const MAX_GREP_HITS = 80;
const MAX_GLOB = 200;
const AWAIT_OUTPUT_LIMIT = 16 * 1024;

export function resolveWorkspaceRoot(hint?: string): string {
  if (hint && existsSync(hint)) return path.resolve(hint);
  const env =
    process.env.CURSOR_STUDIO_WORKSPACE ||
    process.env.STUDIO_WORKSPACE ||
    process.env.CURSOR_WORKSPACE;
  if (env && existsSync(env)) return path.resolve(env);
  return process.cwd();
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function realpathOrResolved(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolvePath(workspace: string, p: string): string {
  const root = path.resolve(workspace);
  const raw = String(p || "").trim();
  const candidate = path.resolve(root, raw || ".");
  if (!isPathInside(root, candidate)) {
    throw new Error(`path escapes workspace: ${raw || candidate}`);
  }

  // A lexical prefix check is insufficient when an in-workspace symlink targets
  // a location outside the selected project. Validate the closest real ancestor,
  // and the final target when it already exists.
  const realRoot = realpathOrResolved(root);
  const ancestor = nearestExistingPath(candidate);
  const realAncestor = realpathOrResolved(ancestor);
  if (!isPathInside(realRoot, realAncestor)) {
    throw new Error(`path resolves outside workspace: ${raw || candidate}`);
  }
  if (existsSync(candidate)) {
    const realTarget = realpathOrResolved(candidate);
    if (!isPathInside(realRoot, realTarget)) {
      throw new Error(`path resolves outside workspace: ${raw || candidate}`);
    }
    return realTarget;
  }
  return candidate;
}

function truncate(s: string, max = MAX_RESULT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n… truncated ${s.length - max} chars`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function toolContentIndicatesFailure(content: string): boolean {
  if (content.startsWith("Error:")) return true;
  try {
    const parsed = JSON.parse(content);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).ok === false,
    );
  } catch {
    return false;
  }
}

async function execRead(workspace: string, args: Record<string, unknown>): Promise<string> {
  const file = resolvePath(workspace, String(args.path || ""));
  if (!existsSync(file)) return `Error: file not found: ${file}`;
  const st = statSync(file);
  if (st.isDirectory()) return `Error: path is a directory: ${file}`;
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset || 1));
  const limit = args.limit != null ? Math.max(1, Number(args.limit)) : lines.length;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, i) => {
    const n = String(offset + i).padStart(6, " ");
    return `${n}|${line}`;
  });
  return truncate(numbered.join("\n") || "(empty file)");
}

async function execWrite(workspace: string, args: Record<string, unknown>): Promise<string> {
  const file = resolvePath(workspace, String(args.path || ""));
  const contents = String(args.contents ?? "");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return `Wrote ${contents.length} bytes to ${file}`;
}

function readStringArg(
  args: Record<string, unknown>,
  ...names: string[]
): { found: boolean; valid: boolean; value: string } {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      return {
        found: true,
        valid: typeof args[name] === "string",
        value: typeof args[name] === "string" ? args[name] : "",
      };
    }
  }
  return { found: false, valid: true, value: "" };
}

async function atomicWriteText(file: string, contents: string): Promise<void> {
  const stat = await fs.stat(file);
  const directory = path.dirname(file);
  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temp, contents, { encoding: "utf8", mode: stat.mode });
    await fs.chmod(temp, stat.mode);
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function execPatchEdit(
  workspace: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pathArg = readStringArg(args, "path", "file_path", "filePath");
  const oldArg = readStringArg(args, "old_string", "oldString");
  const newArg = readStringArg(args, "new_string", "newString");
  const replaceAllRaw = args.replace_all ?? args.replaceAll;

  const fail = (error: string, extra?: Record<string, unknown>) =>
    JSON.stringify({ ok: false, error, ...extra });

  if (!pathArg.found || !pathArg.valid || !pathArg.value.trim()) {
    return fail("PatchEdit path must be a non-empty string");
  }
  if (!oldArg.found || !oldArg.valid || !oldArg.value) {
    return fail("PatchEdit old_string must be a non-empty string");
  }
  if (!newArg.found || !newArg.valid) {
    return fail("PatchEdit new_string must be a string; an empty string is valid");
  }
  if (replaceAllRaw !== undefined && typeof replaceAllRaw !== "boolean") {
    return fail("PatchEdit replace_all must be a boolean");
  }

  let file: string;
  try {
    file = resolvePath(workspace, pathArg.value);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!existsSync(file)) return fail("PatchEdit file not found", { path: file });
  const stat = statSync(file);
  if (stat.isDirectory()) return fail("PatchEdit path is a directory", { path: file });

  let before: string;
  try {
    before = await fs.readFile(file, "utf8");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), { path: file });
  }
  let matches = 0;
  let from = 0;
  while (true) {
    const next = before.indexOf(oldArg.value, from);
    if (next < 0) break;
    matches += 1;
    from = next + oldArg.value.length;
  }
  if (matches === 0) {
    return fail("PatchEdit old_string was not found", { path: file });
  }
  const replaceAll = replaceAllRaw === true;
  if (matches > 1 && !replaceAll) {
    return fail("PatchEdit old_string is not unique", {
      path: file,
      occurrences: matches,
      hint: "Set replace_all to true only when every occurrence should change.",
    });
  }

  const after = replaceAll
    ? before.split(oldArg.value).join(newArg.value)
    : before.replace(oldArg.value, newArg.value);
  try {
    await atomicWriteText(file, after);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), { path: file });
  }
  return JSON.stringify({
    ok: true,
    path: file,
    replacements: replaceAll ? matches : 1,
    bytes_before: Buffer.byteLength(before, "utf8"),
    bytes_after: Buffer.byteLength(after, "utf8"),
    message: "PatchEdit applied",
  });
}

async function execDelete(workspace: string, args: Record<string, unknown>): Promise<string> {
  const file = resolvePath(workspace, String(args.path || ""));
  if (!existsSync(file)) return `File already absent: ${file}`;
  await fs.unlink(file);
  return `Deleted ${file}`;
}

function walkGlob(
  workspace: string,
  root: string,
  pattern: string,
  acc: string[],
  depth: number,
  visited = new Set<string>(),
): void {
  if (depth < 0 || acc.length >= MAX_GLOB) return;
  const realRoot = realpathOrResolved(root);
  if (visited.has(realRoot)) return;
  visited.add(realRoot);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  // 简易 glob：支持 **/* 与 *.ext 与 子串
  const pat = pattern.replace(/^\*\*\//, "");
  const isStarExt = /^\*\.[A-Za-z0-9]+$/.test(pat);
  const ext = isStarExt ? pat.slice(1).toLowerCase() : "";
  const needle = !isStarExt && !pat.includes("*") ? pat.toLowerCase() : "";

  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    let full: string;
    try {
      full = resolvePath(workspace, path.join(root, name));
    } catch {
      // Do not follow a symlink that leaves the selected workspace.
      continue;
    }
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkGlob(workspace, full, pattern, acc, depth - 1, visited);
      continue;
    }
    const base = name.toLowerCase();
    let hit = false;
    if (isStarExt) hit = base.endsWith(ext);
    else if (needle) hit = base.includes(needle) || full.toLowerCase().includes(needle);
    else if (pat === "*" || pat === "**/*") hit = true;
    else {
      // 粗匹配：把 * 当 .*
      try {
        const re = new RegExp(
          "^" +
            pat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, ".*")
              .replace(/\*/g, "[^/\\\\]*") +
            "$",
          "i",
        );
        hit = re.test(name) || re.test(full);
      } catch {
        hit = base.includes(pat.toLowerCase());
      }
    }
    if (hit) acc.push(full);
    if (acc.length >= MAX_GLOB) return;
  }
}

async function execGlob(workspace: string, args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.glob_pattern || args.pattern || "*");
  const root = resolvePath(
    workspace,
    String(args.target_directory || args.path || workspace),
  );
  const acc: string[] = [];
  if (existsSync(root) && statSync(root).isFile()) {
    const base = path.basename(root);
    const simplePattern = pattern.replace(/^\*\*\//, "");
    const hit =
      simplePattern === "*" ||
      simplePattern === "**/*" ||
      (simplePattern.startsWith("*.") && base.toLowerCase().endsWith(simplePattern.slice(1).toLowerCase())) ||
      base.toLowerCase().includes(simplePattern.replaceAll("*", "").toLowerCase());
    if (hit) acc.push(root);
  } else {
    walkGlob(workspace, root, pattern, acc, 12);
  }
  if (!acc.length) return `No files matched ${pattern} under ${root}`;
  return truncate(acc.join("\n"));
}

async function execGrep(workspace: string, args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern || "");
  if (!pattern) return "Error: pattern required";
  const root = resolvePath(workspace, String(args.path || workspace));
  const headLimit = Math.min(MAX_GREP_HITS, Number(args.head_limit || 40));
  const flags = args.case_insensitive ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    return `Error: invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
  const globFilter = args.glob ? String(args.glob).toLowerCase() : "";
  const hits: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth < 0 || hits.length >= headLimit) return;
    const realDir = realpathOrResolved(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= headLimit) return;
      if (name === "node_modules" || name === ".git" || name === "dist") continue;
      let full: string;
      try {
        full = resolvePath(workspace, path.join(dir, name));
      } catch {
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth - 1);
        continue;
      }
      if (globFilter) {
        if (globFilter.startsWith("*.") && !name.toLowerCase().endsWith(globFilter.slice(1))) {
          continue;
        }
      }
      // 跳过过大 / 二进制倾向
      if (st.size > 1_500_000) continue;
      try {
        // sync read for speed in walk
        const text = readFileSync(full, "utf8");
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${full}:${i + 1}:${lines[i].slice(0, 240)}`);
            if (hits.length >= headLimit) return;
          }
        }
      } catch {
        /* skip binary/unreadable */
      }
    }
  };

  if (existsSync(root) && statSync(root).isFile()) {
    try {
      const text = await fs.readFile(root, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${root}:${i + 1}:${lines[i].slice(0, 240)}`);
          if (hits.length >= headLimit) break;
        }
      }
    } catch (e) {
      return `Error reading ${root}: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    walk(root, 10);
  }

  if (!hits.length) return `No matches for /${pattern}/ under ${root}`;
  return truncate(hits.join("\n"));
}

async function execLs(workspace: string, args: Record<string, unknown>): Promise<string> {
  const dir = resolvePath(workspace, String(args.path || "."));
  if (!existsSync(dir)) return `Error: path not found: ${dir}`;
  const ignore = new Set(
    Array.isArray(args.ignore)
      ? args.ignore.map((x) => String(x))
      : ["node_modules", ".git"],
  );
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines = entries
    .filter((e) => !ignore.has(e.name))
    .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
    .sort();
  return truncate(lines.join("\n") || "(empty)");
}

type LintDiagnostic = {
  path?: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
};

function relativeWorkspacePath(workspace: string, candidate: string): string | undefined {
  const resolved = path.resolve(workspace, candidate);
  if (!isPathInside(path.resolve(workspace), resolved)) return undefined;
  return path.relative(workspace, resolved) || ".";
}

function findWorkspaceTool(workspace: string, relativePath: string): string | undefined {
  try {
    const candidate = resolvePath(workspace, relativePath);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function workspaceHasEslintConfig(workspace: string): boolean {
  const configNames = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ];
  if (configNames.some((name) => existsSync(path.join(workspace, name)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
    return Boolean(pkg?.eslintConfig);
  } catch {
    return false;
  }
}

async function runNodeTool(
  workspace: string,
  script: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: workspace,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBuf(stdout, chunk.toString("utf8"), MAX_RESULT);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBuf(stderr, chunk.toString("utf8"), MAX_RESULT);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut: false });
    });
  });
}

function lintSummary(diagnostics: LintDiagnostic[]) {
  return {
    errors: diagnostics.filter((item) => item.severity === "error").length,
    warnings: diagnostics.filter((item) => item.severity === "warning").length,
  };
}

function parseEslintDiagnostics(workspace: string, output: string): LintDiagnostic[] {
  let records: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    records = parsed.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
    );
  } catch {
    return [];
  }

  const diagnostics: LintDiagnostic[] = [];
  for (const record of records) {
    const absolutePath = String(record.filePath || "");
    const relativePath = absolutePath ? relativeWorkspacePath(workspace, absolutePath) : undefined;
    if (absolutePath && !relativePath) continue;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      const message = item as Record<string, unknown>;
      diagnostics.push({
        path: relativePath,
        line: Number(message.line || 0) || undefined,
        column: Number(message.column || 0) || undefined,
        end_line: Number(message.endLine || 0) || undefined,
        end_column: Number(message.endColumn || 0) || undefined,
        severity: Number(message.severity || 2) === 1 ? "warning" : "error",
        code: typeof message.ruleId === "string" ? message.ruleId : undefined,
        message: String(message.message || "ESLint diagnostic"),
      });
    }
  }
  return diagnostics;
}

function parseTypeScriptDiagnostics(workspace: string, output: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  const filePattern = /^(.*)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/i;
  const globalPattern = /^(error|warning)\s+(TS\d+):\s*(.*)$/i;
  for (const line of lines) {
    const fileMatch = line.match(filePattern);
    if (fileMatch) {
      const relativePath = relativeWorkspacePath(workspace, fileMatch[1]);
      if (!relativePath) continue;
      diagnostics.push({
        path: relativePath,
        line: Number(fileMatch[2]),
        column: Number(fileMatch[3]),
        severity: fileMatch[4].toLowerCase() === "warning" ? "warning" : "error",
        code: fileMatch[5],
        message: fileMatch[6],
      });
      continue;
    }
    const globalMatch = line.match(globalPattern);
    if (globalMatch) {
      diagnostics.push({
        severity: globalMatch[1].toLowerCase() === "warning" ? "warning" : "error",
        code: globalMatch[2],
        message: globalMatch[3],
      });
    }
  }
  return diagnostics;
}

async function execReadLints(
  workspace: string,
  args: Record<string, unknown>,
): Promise<string> {
  const fail = (error: string, extra?: Record<string, unknown>) =>
    JSON.stringify({ ok: false, error, ...extra });
  if (args.paths !== undefined && !Array.isArray(args.paths)) {
    return fail("ReadLints paths must be an array of workspace paths");
  }

  let paths: string[];
  try {
    paths = (Array.isArray(args.paths) ? args.paths : []).map((item) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error("ReadLints paths must contain non-empty strings");
      }
      const resolved = resolvePath(workspace, item);
      if (!existsSync(resolved)) throw new Error(`path not found: ${item}`);
      return resolved;
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const eslint = findWorkspaceTool(workspace, "node_modules/eslint/bin/eslint.js");
  const tsc = findWorkspaceTool(workspace, "node_modules/typescript/bin/tsc");
  const tsconfig = findWorkspaceTool(workspace, "tsconfig.json");
  let engine: "eslint" | "typescript" | "none" = "none";
  let result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
  let diagnostics: LintDiagnostic[];

  try {
    if (eslint && workspaceHasEslintConfig(workspace)) {
      engine = "eslint";
      result = await runNodeTool(workspace, eslint, ["--format", "json", ...(paths.length ? paths : ["."])]);
      diagnostics = parseEslintDiagnostics(workspace, result.stdout);
    } else if (tsc && (tsconfig || paths.length)) {
      engine = "typescript";
      const tscArgs = tsconfig
        ? ["--noEmit", "--pretty", "false", "--project", tsconfig]
        : ["--noEmit", "--pretty", "false", ...paths];
      result = await runNodeTool(workspace, tsc, tscArgs);
      diagnostics = parseTypeScriptDiagnostics(workspace, `${result.stdout}\n${result.stderr}`);
      if (paths.length) {
        const wantedRelative = paths.map((item) => path.relative(workspace, item));
        diagnostics = diagnostics.filter((diagnostic) => {
          const diagnosticPath = diagnostic.path;
          if (!diagnosticPath) return true;
          return wantedRelative.some((wanted) => {
            if (!wanted || wanted === ".") return true;
            const normalizedWanted = wanted.replace(/[\\/]+/g, path.sep);
            const normalizedPath = diagnosticPath.replace(/[\\/]+/g, path.sep);
            return (
              normalizedPath === normalizedWanted ||
              normalizedPath.startsWith(`${normalizedWanted}${path.sep}`)
            );
          });
        });
      }
    } else {
      return JSON.stringify({
        ok: true,
        engine,
        diagnostics: [],
        summary: { errors: 0, warnings: 0 },
        message: "No installed workspace ESLint configuration or TypeScript project was found.",
      });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), { engine });
  }

  if (result.timedOut) {
    return fail("ReadLints timed out", { engine, timeout_ms: 60_000 });
  }
  return JSON.stringify({
    ok: true,
    engine,
    diagnostics: diagnostics.slice(0, 500),
    summary: lintSummary(diagnostics),
    exit_code: result.exitCode,
    output: truncate(`${result.stdout}\n${result.stderr}`.trim(), 16_000),
  });
}

function getShellMap(requestId: string): Map<string, BgShell> {
  let m = shellsByRequest.get(requestId);
  if (!m) {
    m = new Map();
    shellsByRequest.set(requestId, m);
  }
  return m;
}

function findShellByToolCallId(requestId: string, toolCallId: string): BgShell | undefined {
  for (const job of getShellMap(requestId).values()) {
    if (job.toolCallId === toolCallId) return job;
  }
  return undefined;
}

function appendBuf(prev: string, chunk: string, max = MAX_SHELL_BUF): string {
  const next = prev + chunk;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

function spawnShell(
  requestId: string,
  toolCallId: string,
  command: string,
  cwd: string,
): BgShell {
  shellSeq += 1;
  const shellId = String(shellSeq);
  const shellBin = process.platform === "win32" ? "cmd.exe" : "bash";
  const shellArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

  const job: BgShell = {
    shellId,
    toolCallId,
    command,
    cwd,
    startedAt: Date.now(),
    done: false,
    forcedBackground: false,
    exitCode: null,
    stdout: "",
    stderr: "",
  };

  const child = spawn(shellBin, shellArgs, {
    cwd,
    env: process.env,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  job.child = child;
  child.stdout.on("data", (d: Buffer) => {
    job.stdout = appendBuf(job.stdout, d.toString("utf8"));
  });
  child.stderr.on("data", (d: Buffer) => {
    job.stderr = appendBuf(job.stderr, d.toString("utf8"));
  });
  child.on("error", (err) => {
    job.error = err.message;
    job.done = true;
    job.exitCode = job.exitCode ?? 1;
  });
  child.on("close", (code) => {
    job.done = true;
    job.exitCode = code;
  });

  getShellMap(requestId).set(shellId, job);
  return job;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitJob(
  job: BgShell,
  blockUntilMs: number,
  pattern?: string,
): Promise<{ timedOut: boolean; matched: boolean; forcedBackground: boolean; match?: string }> {
  const deadline = Date.now() + Math.max(0, blockUntilMs);
  let re: RegExp | null = null;
  if (pattern) {
    try {
      re = new RegExp(pattern);
    } catch {
      return { timedOut: false, matched: false, forcedBackground: false };
    }
  }

  while (true) {
    const combined = job.stdout + job.stderr;
    if (re) {
      const m = combined.match(re);
      if (m) return { timedOut: false, matched: true, forcedBackground: false, match: m[0] };
    }
    if (job.done) return { timedOut: false, matched: false, forcedBackground: false };
    if (job.forcedBackground) {
      return { timedOut: false, matched: false, forcedBackground: true };
    }
    if (Date.now() >= deadline) return { timedOut: true, matched: false, forcedBackground: false };
    await sleep(Math.min(200, Math.max(20, deadline - Date.now())));
  }
}

function snapshotAwait(
  job: BgShell | undefined,
  shellId: string,
  opts: { timedOut: boolean; matched: boolean; match?: string; message?: string },
): string {
  if (!job) {
    return JSON.stringify({
      shell_id: shellId,
      status: "unknown",
      matched: false,
      timed_out: false,
      message: opts.message || `unknown shell_id=${shellId}`,
    });
  }
  const runtimeMs = Date.now() - job.startedAt;
  const stdout = job.stdout.slice(-AWAIT_OUTPUT_LIMIT);
  const stderr = job.stderr.slice(-AWAIT_OUTPUT_LIMIT);
  const status = job.done
    ? "completed"
    : opts.timedOut
      ? "running"
      : "running";
  return JSON.stringify({
    shell_id: job.shellId,
    status,
    matched: opts.matched,
    timed_out: opts.timedOut,
    exit_code: job.exitCode,
    stdout,
    stderr,
    runtime_ms: runtimeMs,
    output_length: job.stdout.length + job.stderr.length,
    regex_requested: Boolean(opts.match || opts.matched),
    regex_match: opts.match,
    message: opts.message,
    command: job.command,
    tool_call_id: job.toolCallId,
    forced_background: job.forcedBackground,
  });
}

async function execShell(
  workspace: string,
  requestId: string,
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const command = String(args.command || "").trim();
  if (!command) return "Error: command required";
  const cwd = resolvePath(workspace, String(args.working_directory || workspace));
  const blockRaw = args.block_until_ms;
  const blockUntil =
    blockRaw === undefined || blockRaw === null
      ? 30_000
      : Math.max(0, Number(blockRaw));

  const job = spawnShell(requestId, toolCallId, command, cwd);

  // block_until_ms=0 → 立即后台
  if (blockUntil === 0) {
    return JSON.stringify({
      shell_id: job.shellId,
      status: "backgrounded",
      command,
      cwd,
      message: "shell backgrounded; use AwaitShell with shell_id",
    });
  }

  const timeout = Math.min(120_000, Math.max(1000, blockUntil));
  const waited = await waitJob(job, timeout);
  if (waited.forcedBackground || !job.done || waited.timedOut) {
    return JSON.stringify({
      shell_id: job.shellId,
      status: job.done ? "completed" : "backgrounded",
      timed_out: waited.timedOut && !job.done,
      forced_background: waited.forcedBackground,
      exit_code: job.exitCode,
      stdout: job.stdout.slice(-AWAIT_OUTPUT_LIMIT),
      stderr: job.stderr.slice(-AWAIT_OUTPUT_LIMIT),
      message: job.done
        ? undefined
        : `blocked ${timeout}ms; still running shell_id=${job.shellId}`,
    });
  }

  const out = [job.stdout, job.stderr].filter(Boolean).join("\n").trim();
  if (job.exitCode && job.exitCode !== 0) {
    return JSON.stringify({
      ok: false,
      shell_id: job.shellId,
      exit_code: job.exitCode,
      stdout: job.stdout.slice(-AWAIT_OUTPUT_LIMIT),
      stderr: job.stderr.slice(-AWAIT_OUTPUT_LIMIT),
      error: job.error || out || `shell exited with code ${job.exitCode}`,
    });
  }
  return truncate(out || "(no output)");
}

async function execWriteShellStdin(
  requestId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const shellId = String(args.shell_id || args.shellId || "").trim();
  const chars = args.chars;
  const fail = (error: string, extra?: Record<string, unknown>) =>
    JSON.stringify({ ok: false, error, ...extra });
  if (!shellId) return fail("WriteShellStdin shell_id is required");
  if (typeof chars !== "string") return fail("WriteShellStdin chars must be a string");

  const job = getShellMap(requestId).get(shellId);
  if (!job) return fail("unknown shell_id", { shell_id: shellId });
  if (job.done) {
    return fail("shell has already completed", {
      shell_id: shellId,
      exit_code: job.exitCode,
    });
  }
  const stdin = job.child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return fail("shell standard input is not writable", { shell_id: shellId });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      stdin.write(chars, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), { shell_id: shellId });
  }

  return JSON.stringify({
    ok: true,
    shell_id: shellId,
    chars_written: Buffer.byteLength(chars, "utf8"),
    status: "running",
  });
}

function execForceBackgroundShell(
  requestId: string,
  args: Record<string, unknown>,
): string {
  const toolCallId = String(args.tool_call_id || args.toolCallId || "").trim();
  const fail = (error: string, extra?: Record<string, unknown>) =>
    JSON.stringify({ ok: false, error, ...extra });
  if (!toolCallId) return fail("ForceBackgroundShell tool_call_id is required");

  const job = findShellByToolCallId(requestId, toolCallId);
  if (!job) return fail("no shell found for tool_call_id", { tool_call_id: toolCallId });
  if (job.done) {
    return fail("shell has already completed", {
      tool_call_id: toolCallId,
      shell_id: job.shellId,
      exit_code: job.exitCode,
    });
  }

  job.forcedBackground = true;
  job.forcedBackgroundAt = Date.now();
  return JSON.stringify({
    ok: true,
    shell_id: job.shellId,
    tool_call_id: toolCallId,
    status: "backgrounded",
    message: "shell moved to the background",
  });
}

async function execAwaitShell(
  requestId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const shellId = String(args.shell_id || args.task_id || "").trim();
  const blockRaw = args.block_until_ms;
  const blockUntil =
    blockRaw === undefined || blockRaw === null
      ? 30_000
      : Math.max(0, Number(blockRaw));
  const pattern = String(args.pattern || "").trim() || undefined;

  if (!shellId) {
    if (blockUntil === 0) {
      return "Error: AwaitShell shell_id is required when block_until_ms is 0";
    }
    await sleep(Math.min(blockUntil, 5_000));
    return JSON.stringify({
      status: "waited",
      timed_out: false,
      message: `waited ${Math.min(blockUntil, 5_000)}ms (no shell_id)`,
    });
  }

  const job = getShellMap(requestId).get(shellId);
  if (!job) {
    return snapshotAwait(undefined, shellId, {
      timedOut: false,
      matched: false,
    });
  }

  if (blockUntil === 0) {
    return snapshotAwait(job, shellId, { timedOut: false, matched: false });
  }

  const waited = await waitJob(job, blockUntil, pattern);
  return snapshotAwait(job, shellId, {
    timedOut: waited.timedOut,
    matched: waited.matched,
    match: waited.match,
  });
}

async function execWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url || "").trim();
  if (!url) return "Error: url required";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Error: invalid url";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Error: only http/https supported";
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "cursor-studio-local/0.3" },
    });
    clearTimeout(t);
    const text = await res.text();
    return truncate(
      `status=${res.status}\ncontent-type=${res.headers.get("content-type") || ""}\n\n${text}`,
    );
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function runtimeTodoStatus(value: unknown): RuntimeTodoItem["status"] {
  if (typeof value === "number") {
    if (value === 2) return "in_progress";
    if (value === 3) return "completed";
    if (value === 4) return "cancelled";
    return "pending";
  }
  switch (String(value || "").trim().toLowerCase().replaceAll("-", "_")) {
    case "in_progress":
    case "inprogress":
    case "todo_status_in_progress":
      return "in_progress";
    case "completed":
    case "complete":
    case "todo_status_completed":
      return "completed";
    case "cancelled":
    case "canceled":
    case "todo_status_cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function cloneRuntimeTodo(item: RuntimeTodoItem): RuntimeTodoItem {
  return {
    ...item,
    dependencies: item.dependencies ? [...item.dependencies] : undefined,
  };
}

function runtimeTodoFromUnknown(
  value: unknown,
  fallbackTime: number,
): RuntimeTodoItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  const content = String(raw.content || "").trim();
  if (!id) return undefined;
  const createdAt = Number(raw.created_at ?? raw.createdAt);
  const updatedAt = Number(raw.updated_at ?? raw.updatedAt);
  return {
    id,
    content,
    status: runtimeTodoStatus(raw.status),
    created_at: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : fallbackTime,
    updated_at: Number.isFinite(updatedAt) && updatedAt > 0
      ? Math.floor(updatedAt)
      : Number.isFinite(createdAt) && createdAt > 0
        ? Math.floor(createdAt)
        : fallbackTime,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
  };
}

export function synchronizeTodoState(
  stateKey: string,
  todos: readonly unknown[],
): void {
  const key = String(stateKey || "default").trim() || "default";
  const now = Date.now();
  todosByStateKey.set(
    key,
    todos
      .map((todo) => runtimeTodoFromUnknown(todo, now))
      .filter((todo): todo is RuntimeTodoItem => Boolean(todo?.content))
      .map(cloneRuntimeTodo),
  );
}

function isTerminalRuntimeTodo(todo: RuntimeTodoItem): boolean {
  return todo.status === "completed" || todo.status === "cancelled";
}

function execTodoWrite(
  stateKey: string,
  args: Record<string, unknown>,
): string {
  const now = Date.now();
  const rawIncoming = Array.isArray(args.todos) ? args.todos : [];
  const incoming = rawIncoming
    .map((todo) => runtimeTodoFromUnknown(todo, now))
    .filter((todo): todo is RuntimeTodoItem => Boolean(todo));
  if (incoming.length !== rawIncoming.length) {
    return "Error: every todo requires a non-empty id";
  }

  const key = String(stateKey || "default").trim() || "default";
  const existing = (todosByStateKey.get(key) || []).map(cloneRuntimeTodo);
  const mergeSet = Object.prototype.hasOwnProperty.call(args, "merge");
  const incomingIds = new Set(incoming.map((todo) => todo.id));
  const missingActive = existing
    .filter((todo) => !isTerminalRuntimeTodo(todo) && !incomingIds.has(todo.id))
    .map((todo) => todo.id)
    .sort();
  const omittedContent = incoming.some((todo) => !todo.content);
  const merge = args.merge === true || (
    !mergeSet && existing.length > 0 && (missingActive.length > 0 || omittedContent)
  );

  let list: RuntimeTodoItem[];
  if (merge) {
    list = existing;
    const indexById = new Map(list.map((todo, index) => [todo.id, index]));
    for (let index = 0; index < rawIncoming.length; index += 1) {
      const raw = rawIncoming[index] as Record<string, unknown>;
      const update = incoming[index];
      const currentIndex = indexById.get(update.id);
      if (currentIndex == null) {
        if (!update.content) {
          return `Error: todo content is required for new todo ${update.id}`;
        }
        indexById.set(update.id, list.length);
        list.push(update);
        continue;
      }
      const current = list[currentIndex];
      const content = String(raw.content || "").trim();
      list[currentIndex] = {
        ...current,
        ...(content ? { content } : {}),
        ...(raw.status != null ? { status: runtimeTodoStatus(raw.status) } : {}),
        ...(Array.isArray(raw.dependencies) && raw.dependencies.length
          ? { dependencies: raw.dependencies.map(String).map((item) => item.trim()).filter(Boolean) }
          : {}),
        updated_at: now,
      };
    }
  } else {
    if (incoming.some((todo) => !todo.content)) {
      return "Error: todo content is required";
    }
    if (missingActive.length > 0) {
      return `Error: replacement omitted active todo ids: ${missingActive.join(", ")}`;
    }
    list = incoming;
  }

  todosByStateKey.set(key, list.map(cloneRuntimeTodo));
  return truncate(JSON.stringify({
    todos: list,
    total_count: list.length,
    was_merge: merge,
  }, null, 2));
}

/**
 * CallMcpTool 本地回落：读 ~/.cursor/mcp.json → tools/call。
 * 参数兼容 server / providerIdentifier / toolName / arguments|args / name。
 */
export async function executeCallMcpLocal(
  invocation: ToolInvocation,
  timeoutMs = 30_000,
): Promise<ToolExecResult> {
  const args = parseArgs(invocation.arguments);
  let serverId = String(
    args.server || args.providerIdentifier || args.provider_identifier || "",
  ).trim();
  let toolName = String(args.toolName || args.tool_name || "").trim();
  const lookup = String(args.name || "").trim();

  if (lookup && (!serverId || !toolName)) {
    if (lookup.includes("/")) {
      const slash = lookup.indexOf("/");
      if (!serverId) serverId = lookup.slice(0, slash);
      if (!toolName) toolName = lookup.slice(slash + 1);
    } else if (lookup.includes("-") && !serverId) {
      const dash = lookup.indexOf("-");
      serverId = lookup.slice(0, dash);
      if (!toolName) toolName = lookup.slice(dash + 1);
    } else if (!toolName) {
      toolName = lookup;
    }
  }

  const argObj =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};

  if (!serverId) {
    return {
      callId: invocation.id,
      name: "CallMcpTool",
      ok: false,
      content: "Error: CallMcpTool 本地回落失败：缺少 server（mcp.json 服务 id）",
    };
  }
  if (!toolName) {
    return {
      callId: invocation.id,
      name: "CallMcpTool",
      ok: false,
      content: "Error: CallMcpTool 本地回落失败：缺少 toolName",
    };
  }

  const spec = await getMcpServerSpec(serverId);
  if (!spec) {
    return {
      callId: invocation.id,
      name: "CallMcpTool",
      ok: false,
      content: `Error: CallMcpTool 本地回落失败：mcp.json 中未找到服务 "${serverId}"`,
    };
  }

  const res = await callMcpTool(spec, toolName, argObj, timeoutMs);
  return {
    callId: invocation.id,
    name: "CallMcpTool",
    ok: res.ok,
    content: truncate(
      res.ok
        ? res.content
        : res.content.startsWith("Error:")
          ? res.content
          : `Error: ${res.content}`,
    ),
  };
}

export async function executeTool(
  invocation: ToolInvocation,
  opts?: { workspaceRoot?: string; requestId?: string; stateKey?: string },
): Promise<ToolExecResult> {
  const workspace = resolveWorkspaceRoot(opts?.workspaceRoot);
  const requestId = opts?.requestId || "default";
  const name = invocation.name.trim();
  const args = parseArgs(invocation.arguments);

  // CallMcpTool 不在 EXECUTABLE_TOOLS（默认走客户端桥），但允许显式本地回落
  if (name === "CallMcpTool") {
    return executeCallMcpLocal(invocation);
  }

  if (!EXECUTABLE_TOOLS.has(name)) {
    return {
      callId: invocation.id,
      name,
      ok: false,
      content: `Tool ${name} is not executable in embedded engine yet (needs client bridge).`,
    };
  }

  try {
    let content: string;
    switch (name) {
      case "Read":
        content = await execRead(workspace, args);
        break;
      case "PatchEdit":
        content = await execPatchEdit(workspace, args);
        break;
      case "ReadLints":
        content = await execReadLints(workspace, args);
        break;
      case "Write":
        content = await execWrite(workspace, args);
        break;
      case "Delete":
        content = await execDelete(workspace, args);
        break;
      case "Glob":
        content = await execGlob(workspace, args);
        break;
      case "Grep":
        content = await execGrep(workspace, args);
        break;
      case "Ls":
        content = await execLs(workspace, args);
        break;
      case "Shell":
        content = await execShell(workspace, requestId, invocation.id, args);
        break;
      case "AwaitShell":
        content = await execAwaitShell(requestId, args);
        break;
      case "WriteShellStdin":
        content = await execWriteShellStdin(requestId, args);
        break;
      case "ForceBackgroundShell":
        content = execForceBackgroundShell(requestId, args);
        break;
      case "WebFetch":
        content = await execWebFetch(args);
        break;
      case "TodoWrite":
        content = execTodoWrite(opts?.stateKey || requestId, args);
        break;
      default:
        content = `Error: Unsupported tool: ${name}`;
    }
    const ok = !toolContentIndicatesFailure(content);
    return { callId: invocation.id, name, ok, content };
  } catch (e) {
    return {
      callId: invocation.id,
      name,
      ok: false,
      content: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function executeTools(
  invocations: ToolInvocation[],
  opts?: { workspaceRoot?: string; requestId?: string; stateKey?: string },
): Promise<ToolExecResult[]> {
  const results: ToolExecResult[] = [];
  for (const inv of invocations) {
    results.push(await executeTool(inv, opts));
  }
  return results;
}
