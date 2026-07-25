/**
 * 本地协议实现。
 * 当前在 backend 进程内执行，结果回灌模型；同时经 SSE 发出工具事件供 UI。
 */
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

type TodoItem = {
  id: string;
  content?: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
};

type BgShell = {
  shellId: string;
  command: string;
  cwd: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  child?: ChildProcessWithoutNullStreams;
};

const todosByRequest = new Map<string, TodoItem[]>();
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

function resolvePath(workspace: string, p: string): string {
  const raw = String(p || "").trim();
  if (!raw) return workspace;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.normalize(path.join(workspace, raw));
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

async function execDelete(workspace: string, args: Record<string, unknown>): Promise<string> {
  const file = resolvePath(workspace, String(args.path || ""));
  if (!existsSync(file)) return `File already absent: ${file}`;
  await fs.unlink(file);
  return `Deleted ${file}`;
}

function walkGlob(
  root: string,
  pattern: string,
  acc: string[],
  depth: number,
): void {
  if (depth < 0 || acc.length >= MAX_GLOB) return;
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
    const full = path.join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkGlob(full, pattern, acc, depth - 1);
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
  walkGlob(root, pattern, acc, 12);
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

  const walk = (dir: string, depth: number) => {
    if (depth < 0 || hits.length >= headLimit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= headLimit) return;
      if (name === "node_modules" || name === ".git" || name === "dist") continue;
      const full = path.join(dir, name);
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

function getShellMap(requestId: string): Map<string, BgShell> {
  let m = shellsByRequest.get(requestId);
  if (!m) {
    m = new Map();
    shellsByRequest.set(requestId, m);
  }
  return m;
}

function appendBuf(prev: string, chunk: string, max = MAX_SHELL_BUF): string {
  const next = prev + chunk;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

function spawnShell(
  requestId: string,
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
    command,
    cwd,
    startedAt: Date.now(),
    done: false,
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
): Promise<{ timedOut: boolean; matched: boolean; match?: string }> {
  const deadline = Date.now() + Math.max(0, blockUntilMs);
  let re: RegExp | null = null;
  if (pattern) {
    try {
      re = new RegExp(pattern);
    } catch {
      return { timedOut: false, matched: false };
    }
  }

  while (true) {
    const combined = job.stdout + job.stderr;
    if (re) {
      const m = combined.match(re);
      if (m) return { timedOut: false, matched: true, match: m[0] };
    }
    if (job.done) return { timedOut: false, matched: false };
    if (Date.now() >= deadline) return { timedOut: true, matched: false };
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
  });
}

async function execShell(
  workspace: string,
  requestId: string,
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

  const job = spawnShell(requestId, command, cwd);

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
  if (!job.done || waited.timedOut) {
    return JSON.stringify({
      shell_id: job.shellId,
      status: job.done ? "completed" : "backgrounded",
      timed_out: waited.timedOut && !job.done,
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
    return truncate(
      [out, job.error, `exit=${job.exitCode}`].filter(Boolean).join("\n") ||
        "shell failed",
    );
  }
  return truncate(out || "(no output)");
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

function execTodoWrite(
  requestId: string,
  args: Record<string, unknown>,
): string {
  const merge = args.merge !== false;
  const incoming = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [];
  let list = todosByRequest.get(requestId) || [];
  if (!merge) list = [];
  for (const item of incoming) {
    if (!item?.id) continue;
    const idx = list.findIndex((t) => t.id === item.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...item };
    else list.push({ ...item });
  }
  todosByRequest.set(requestId, list);
  return truncate(JSON.stringify({ todos: list }, null, 2));
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
  opts?: { workspaceRoot?: string; requestId?: string },
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
        content = await execShell(workspace, requestId, args);
        break;
      case "AwaitShell":
        content = await execAwaitShell(requestId, args);
        break;
      case "WebFetch":
        content = await execWebFetch(args);
        break;
      case "TodoWrite":
        content = execTodoWrite(requestId, args);
        break;
      default:
        content = `Unsupported tool: ${name}`;
    }
    const ok = !content.startsWith("Error:");
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
  opts?: { workspaceRoot?: string; requestId?: string },
): Promise<ToolExecResult[]> {
  const results: ToolExecResult[] = [];
  for (const inv of invocations) {
    results.push(await executeTool(inv, opts));
  }
  return results;
}