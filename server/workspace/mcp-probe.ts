/**
 * MCP 连通探测：stdio / HTTP(S) 握手 + tools/list
 * 只有探测成功才允许写入 Cursor mcp.json（由调用方强制）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export type McpServerSpec = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
};

export type McpToolInfo = {
  name: string;
  description?: string;
};

export type McpProbeResult = {
  ok: boolean;
  kind: "stdio" | "http" | "sse" | "unknown";
  latencyMs: number;
  toolCount: number;
  tools: McpToolInfo[];
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  error?: string;
};

const PROTOCOL = "2024-11-05";
const CLIENT_INFO = { name: "cursor-studio", version: "1.0.0" };

function classify(spec: McpServerSpec): McpProbeResult["kind"] {
  if (spec.command) return "stdio";
  if (spec.url) {
    const t = String(spec.type || "").toLowerCase();
    if (t === "sse") return "sse";
    return "http";
  }
  return "unknown";
}

function encodeFramed(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.from(header + body, "utf8");
}

/** 解析 Content-Length 分帧 或 NDJSON */
class FrameReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length > 0) {
      const text = this.buf.toString("utf8");
      // Content-Length framing
      const m = text.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (m) {
        const len = Number(m[1]);
        const headerLen = m[0].length;
        if (this.buf.length < headerLen + len) break;
        const json = this.buf.subarray(headerLen, headerLen + len).toString("utf8");
        this.buf = this.buf.subarray(headerLen + len);
        try {
          out.push(JSON.parse(json));
        } catch {
          /* skip bad frame */
        }
        continue;
      }
      // NDJSON fallback
      const nl = text.indexOf("\n");
      if (nl < 0) break;
      const line = text.slice(0, nl).trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* keep waiting if partial */
        if (!line.startsWith("{")) continue;
      }
    }
    return out;
  }
}

function normalizeStdio(
  spec: McpServerSpec,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const command = String(spec.command || "").trim();
  if (!command) throw new Error("stdio MCP 缺少 command");
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(spec.env || {}),
  };
  // Windows 下 npx/npm 走 cmd
  if (process.platform === "win32") {
    const base = path.basename(command).toLowerCase();
    if (
      base === "npx" ||
      base === "npx.cmd" ||
      base === "npm" ||
      base === "npm.cmd" ||
      base === "pnpm" ||
      base === "pnpm.cmd" ||
      base === "yarn" ||
      base === "yarn.cmd" ||
      base === "bun" ||
      base === "bun.exe"
    ) {
      return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args], env };
    }
  }
  return { command, args, env };
}

async function probeStdio(spec: McpServerSpec, timeoutMs: number): Promise<McpProbeResult> {
  const started = Date.now();
  const { command, args, env } = normalizeStdio(spec);
  let child: ChildProcessWithoutNullStreams | null = null;
  const reader = new FrameReader();
  const pending = new Map<number | string, (v: unknown) => void>();
  let stderr = "";

  const fail = (error: string): McpProbeResult => ({
    ok: false,
    kind: "stdio",
    latencyMs: Date.now() - started,
    toolCount: 0,
    tools: [],
    error,
  });

  try {
    child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  child.stdout.on("data", (d: Buffer) => {
    for (const msg of reader.push(d) as Array<Record<string, unknown>>) {
      if (msg && typeof msg === "object" && "id" in msg && pending.has(msg.id as number)) {
        pending.get(msg.id as number)?.(msg);
        pending.delete(msg.id as number);
      }
    }
  });

  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`等待 ${method} 超时`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      });
      try {
        child!.stdin.write(encodeFramed({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });

  const kill = () => {
    try {
      child?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  };

  try {
    const init = await request(1, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (init.error) {
      kill();
      return fail(JSON.stringify(init.error));
    }
    const result = (init.result || {}) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    // initialized notification
    child.stdin.write(
      encodeFramed({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    let tools: McpToolInfo[] = [];
    try {
      const toolsRes = await request(2, "tools/list", {});
      const list = (toolsRes.result as { tools?: Array<{ name?: string; description?: string }> })
        ?.tools;
      if (Array.isArray(list)) {
        tools = list
          .filter((t) => t?.name)
          .map((t) => ({
            name: String(t.name),
            description: t.description ? String(t.description).slice(0, 200) : undefined,
          }));
      }
    } catch {
      // 部分服务无 tools 也算连通
    }
    kill();
    return {
      ok: true,
      kind: "stdio",
      latencyMs: Date.now() - started,
      toolCount: tools.length,
      tools,
      serverName: result.serverInfo?.name,
      serverVersion: result.serverInfo?.version,
      protocolVersion: result.protocolVersion,
    };
  } catch (e) {
    kill();
    const msg = e instanceof Error ? e.message : String(e);
    const tail = stderr.trim() ? ` · stderr: ${stderr.trim().slice(-300)}` : "";
    return fail(msg + tail);
  }
}

async function probeHttp(spec: McpServerSpec, timeoutMs: number): Promise<McpProbeResult> {
  const started = Date.now();
  const url = String(spec.url || "").trim();
  if (!url) {
    return {
      ok: false,
      kind: "http",
      latencyMs: 0,
      toolCount: 0,
      tools: [],
      error: "缺少 url",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(spec.headers || {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(initBody),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        kind: "http",
        latencyMs: Date.now() - started,
        toolCount: 0,
        tools: [],
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // SSE 风格：取 data: 行
      const dataLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (dataLine) {
        json = JSON.parse(dataLine.replace(/^data:\s*/, "")) as Record<string, unknown>;
      }
    }
    if (!json) {
      return {
        ok: false,
        kind: "http",
        latencyMs: Date.now() - started,
        toolCount: 0,
        tools: [],
        error: "响应不是 JSON-RPC",
      };
    }
    if (json.error) {
      return {
        ok: false,
        kind: "http",
        latencyMs: Date.now() - started,
        toolCount: 0,
        tools: [],
        error: JSON.stringify(json.error),
      };
    }
    const result = (json.result || {}) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    // tools/list
    let tools: McpToolInfo[] = [];
    try {
      const toolsRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: controller.signal,
      });
      const toolsText = await toolsRes.text();
      let toolsJson: Record<string, unknown> | null = null;
      try {
        toolsJson = JSON.parse(toolsText) as Record<string, unknown>;
      } catch {
        const dataLine = toolsText
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("data:"));
        if (dataLine) {
          toolsJson = JSON.parse(dataLine.replace(/^data:\s*/, "")) as Record<string, unknown>;
        }
      }
      const list = (toolsJson?.result as { tools?: Array<{ name?: string; description?: string }> })
        ?.tools;
      if (Array.isArray(list)) {
        tools = list
          .filter((t) => t?.name)
          .map((t) => ({
            name: String(t.name),
            description: t.description ? String(t.description).slice(0, 200) : undefined,
          }));
      }
    } catch {
      /* optional */
    }
    return {
      ok: true,
      kind: String(spec.type || "").toLowerCase() === "sse" ? "sse" : "http",
      latencyMs: Date.now() - started,
      toolCount: tools.length,
      tools,
      serverName: result.serverInfo?.name,
      serverVersion: result.serverInfo?.version,
      protocolVersion: result.protocolVersion,
    };
  } catch (e) {
    return {
      ok: false,
      kind: "http",
      latencyMs: Date.now() - started,
      toolCount: 0,
      tools: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeMcpServer(
  spec: McpServerSpec,
  timeoutMs = 12_000,
): Promise<McpProbeResult> {
  const kind = classify(spec);
  if (kind === "stdio") return probeStdio(spec, timeoutMs);
  if (kind === "http" || kind === "sse") return probeHttp(spec, timeoutMs);
  return {
    ok: false,
    kind: "unknown",
    latencyMs: 0,
    toolCount: 0,
    tools: [],
    error: "无效配置：需要 command（stdio）或 url（http/sse）",
  };
}

export type McpCallResult = {
  ok: boolean;
  kind: McpProbeResult["kind"];
  latencyMs: number;
  content: string;
  error?: string;
};

/**
 * 对已配置 MCP 发起 tools/call（stdio / http）。
 * 供 CallMcpTool 客户端超时后本地回落。
 */
export async function callMcpTool(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<McpCallResult> {
  const kind = classify(spec);
  const name = String(toolName || "").trim();
  if (!name) {
    return {
      ok: false,
      kind,
      latencyMs: 0,
      content: "Error: CallMcpTool 缺少 toolName",
      error: "missing toolName",
    };
  }
  if (kind === "stdio") return callStdio(spec, name, args, timeoutMs);
  if (kind === "http" || kind === "sse") return callHttp(spec, name, args, timeoutMs);
  return {
    ok: false,
    kind: "unknown",
    latencyMs: 0,
    content: "Error: 无效 MCP 配置：需要 command 或 url",
    error: "invalid spec",
  };
}

function summarizeMcpToolResult(result: unknown): string {
  if (result == null) return "(empty mcp result)";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const r = result as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (!c) continue;
      if (c.type === "text" && c.text != null) parts.push(String(c.text));
      else if (c.text != null) parts.push(String(c.text));
      else parts.push(JSON.stringify(c));
    }
  }
  if (!parts.length && r.structuredContent != null) {
    try {
      parts.push(JSON.stringify(r.structuredContent, null, 2));
    } catch {
      parts.push(String(r.structuredContent));
    }
  }
  if (!parts.length) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const body = parts.join("\n");
  return r.isError ? `Error: ${body}` : body;
}

async function callStdio(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<McpCallResult> {
  const started = Date.now();
  const { command, args: cmdArgs, env } = normalizeStdio(spec);
  let child: ChildProcessWithoutNullStreams | null = null;
  const reader = new FrameReader();
  const pending = new Map<number | string, (v: unknown) => void>();
  let stderr = "";

  const fail = (error: string): McpCallResult => ({
    ok: false,
    kind: "stdio",
    latencyMs: Date.now() - started,
    content: `Error: ${error}`,
    error,
  });

  try {
    child = spawn(command, cmdArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  child.stdout.on("data", (d: Buffer) => {
    for (const msg of reader.push(d) as Array<Record<string, unknown>>) {
      if (msg && typeof msg === "object" && "id" in msg && pending.has(msg.id as number)) {
        pending.get(msg.id as number)?.(msg);
        pending.delete(msg.id as number);
      }
    }
  });

  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`等待 ${method} 超时`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      });
      try {
        child!.stdin.write(encodeFramed({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });

  const kill = () => {
    try {
      child?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  };

  try {
    const init = await request(1, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (init.error) {
      kill();
      return fail(JSON.stringify(init.error));
    }
    child.stdin.write(
      encodeFramed({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    const call = await request(2, "tools/call", {
      name: toolName,
      arguments: args || {},
    });
    kill();
    if (call.error) {
      return fail(JSON.stringify(call.error));
    }
    const content = summarizeMcpToolResult(call.result);
    return {
      ok: !content.startsWith("Error:"),
      kind: "stdio",
      latencyMs: Date.now() - started,
      content: content.slice(0, 80_000),
    };
  } catch (e) {
    kill();
    const msg = e instanceof Error ? e.message : String(e);
    const tail = stderr.trim() ? ` · stderr: ${stderr.trim().slice(-300)}` : "";
    return fail(msg + tail);
  }
}

async function callHttp(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<McpCallResult> {
  const started = Date.now();
  const url = String(spec.url || "").trim();
  const kind: McpProbeResult["kind"] =
    String(spec.type || "").toLowerCase() === "sse" ? "sse" : "http";
  if (!url) {
    return {
      ok: false,
      kind,
      latencyMs: 0,
      content: "Error: 缺少 url",
      error: "missing url",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(spec.headers || {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const parseRpc = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const dataLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (dataLine) {
        try {
          return JSON.parse(dataLine.replace(/^data:\s*/, "")) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  try {
    // 部分 HTTP MCP 要求先 initialize；失败不阻断 call（兼容无状态服务）
    try {
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
        }),
        signal: controller.signal,
      });
    } catch {
      /* optional */
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args || {} },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        kind,
        latencyMs: Date.now() - started,
        content: `Error: HTTP ${res.status}: ${text.slice(0, 400)}`,
        error: `HTTP ${res.status}`,
      };
    }
    const json = parseRpc(text);
    if (!json) {
      return {
        ok: false,
        kind,
        latencyMs: Date.now() - started,
        content: `Error: 响应不是 JSON-RPC: ${text.slice(0, 400)}`,
        error: "bad response",
      };
    }
    if (json.error) {
      return {
        ok: false,
        kind,
        latencyMs: Date.now() - started,
        content: `Error: ${JSON.stringify(json.error)}`,
        error: JSON.stringify(json.error),
      };
    }
    const content = summarizeMcpToolResult(json.result).slice(0, 80_000);
    return {
      ok: !content.startsWith("Error:"),
      kind,
      latencyMs: Date.now() - started,
      content,
    };
  } catch (e) {
    return {
      ok: false,
      kind,
      latencyMs: Date.now() - started,
      content: `Error: ${e instanceof Error ? e.message : String(e)}`,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析用户粘贴的 JSON：支持整段 mcpServers 或单服务对象 */
export function parseMcpUserJson(raw: string): { id: string; spec: McpServerSpec } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JSON 解析失败");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("JSON 必须是对象");
  const obj = parsed as Record<string, unknown>;

  // { "mcpServers": { "id": { ... } } }
  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    const servers = obj.mcpServers as Record<string, McpServerSpec>;
    const entries = Object.entries(servers);
    if (entries.length !== 1) {
      throw new Error("mcpServers 中请只放 1 个服务（或改用 id + 配置对象）");
    }
    const [id, spec] = entries[0];
    if (!id.trim()) throw new Error("服务 id 不能为空");
    return { id: id.trim(), spec: (spec || {}) as McpServerSpec };
  }

  // { "id": "x", "server": { ... } } 或 { "id": "x", ...spec }
  if (typeof obj.id === "string" && obj.id.trim()) {
    const id = obj.id.trim();
    if (obj.server && typeof obj.server === "object") {
      return { id, spec: obj.server as McpServerSpec };
    }
    const { id: _id, ...rest } = obj;
    return { id, spec: rest as McpServerSpec };
  }

  // 单服务对象但无 id：调用方需另给 id
  if (obj.command || obj.url) {
    throw new Error('请使用 {"mcpServers":{"名称":{...}}} 或 {"id":"名称", ...}');
  }
  throw new Error("无法识别的 MCP JSON 结构");
}
