/**
 * Cursor MCP 统一管理：读写 ~/.cursor/mcp.json
 * 添加/更新前强制连通探测，列表附带 tools 信息。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseMcpUserJson,
  probeMcpServer,
  type McpProbeResult,
  type McpServerSpec,
} from "./mcp-probe";
import {
  appendMcpProbeHistory,
  latestMcpProbeByServer,
  listMcpProbeHistory,
} from "./mcp-diagnostics";

export type { McpServerSpec, McpProbeResult };

export type McpFile = {
  mcpServers: Record<string, McpServerSpec>;
};

export type McpServerRow = {
  id: string;
  spec: McpServerSpec;
  kind: "stdio" | "http" | "sse" | "unknown";
  probe?: McpProbeResult;
};

export function cursorMcpPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

async function readRaw(): Promise<McpFile> {
  const p = cursorMcpPath();
  if (!existsSync(p)) return { mcpServers: {} };
  try {
    const j = JSON.parse(await fs.readFile(p, "utf8")) as Partial<McpFile>;
    return {
      mcpServers:
        j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {},
    };
  } catch {
    return { mcpServers: {} };
  }
}

async function writeRaw(file: McpFile): Promise<void> {
  const p = cursorMcpPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (existsSync(p)) {
    await fs.copyFile(p, `${p}.studio.bak`).catch(() => undefined);
  }
  await fs.writeFile(
    p,
    JSON.stringify({ mcpServers: file.mcpServers }, null, 2) + "\n",
    "utf8",
  );
}

function kindOf(spec: McpServerSpec): McpServerRow["kind"] {
  if (spec?.command) return "stdio";
  if (spec?.url) {
    const t = String(spec.type || "").toLowerCase();
    return t === "sse" ? "sse" : "http";
  }
  return "unknown";
}

export async function listMcpServers(options?: {
  probe?: boolean;
}): Promise<{ path: string; servers: McpServerRow[] }> {
  const file = await readRaw();
  const servers: McpServerRow[] = [];
  for (const [id, spec] of Object.entries(file.mcpServers)) {
    const row: McpServerRow = {
      id,
      spec: spec || {},
      kind: kindOf(spec || {}),
    };
    if (options?.probe) {
      row.probe = await probeMcpServer(spec || {});
    }
    servers.push(row);
  }
  return { path: cursorMcpPath(), servers };
}

/** 仅探测，不写入 */
export async function probeMcp(
  id: string | undefined,
  spec: McpServerSpec,
): Promise<McpProbeResult & { id?: string }> {
  const probe = await probeMcpServer(spec);
  const serverId = id || spec.url || spec.command || "unknown";
  await appendMcpProbeHistory(serverId, probe).catch(() => undefined);
  return { ...probe, id };
}

export async function getMcpProbeHistory(opts?: {
  serverId?: string;
  limit?: number;
}) {
  return { items: await listMcpProbeHistory(opts) };
}

export async function getMcpLatestProbes() {
  return { latest: await latestMcpProbeByServer() };
}

/**
 * 探测成功后才写入 mcp.json。
 * requireProbe=true（默认）失败则抛错。
 */
export async function upsertMcpServer(
  id: string,
  spec: McpServerSpec,
  options?: { requireProbe?: boolean },
): Promise<{
  path: string;
  servers: McpServerRow[];
  probe: McpProbeResult;
}> {
  const key = id.trim();
  if (!key) throw new Error("MCP id 不能为空");
  const requireProbe = options?.requireProbe !== false;
  const probe = await probeMcpServer(spec);
  if (requireProbe && !probe.ok) {
    throw new Error(`MCP 连通失败，未写入配置：${probe.error || "unknown"}`);
  }
  const file = await readRaw();
  file.mcpServers[key] = spec;
  await writeRaw(file);
  const listed = await listMcpServers();
  const servers = listed.servers.map((s) =>
    s.id === key ? { ...s, probe } : s,
  );
  return { path: listed.path, servers, probe };
}

/** 用户粘贴 JSON → 解析 → 探测 → 写入 */
export async function upsertMcpFromJson(
  rawJson: string,
  options?: { id?: string; requireProbe?: boolean },
): Promise<{
  path: string;
  servers: McpServerRow[];
  probe: McpProbeResult;
  id: string;
}> {
  let id: string;
  let spec: McpServerSpec;
  try {
    const parsed = parseMcpUserJson(rawJson);
    id = options?.id?.trim() || parsed.id;
    spec = parsed.spec;
  } catch (e) {
    // 允许「单独配置对象 + 外部 id」
    if (options?.id?.trim()) {
      try {
        const obj = JSON.parse(rawJson) as McpServerSpec;
        if (!obj || typeof obj !== "object") throw new Error("invalid");
        id = options.id.trim();
        const { id: _drop, ...rest } = obj as McpServerSpec & { id?: string };
        spec = rest;
      } catch {
        throw e;
      }
    } else {
      throw e;
    }
  }
  const res = await upsertMcpServer(id, spec, options);
  return { ...res, id };
}

export async function removeMcpServer(
  id: string,
): Promise<{ path: string; servers: McpServerRow[] }> {
  const file = await readRaw();
  delete file.mcpServers[id];
  await writeRaw(file);
  return listMcpServers();
}

export async function openMcpPath(): Promise<string> {
  return cursorMcpPath();
}

/** 按 id 读取 mcp.json 中的服务配置 */
export async function getMcpServerSpec(
  id: string,
): Promise<McpServerSpec | undefined> {
  const key = id.trim();
  if (!key) return undefined;
  const file = await readRaw();
  const spec = file.mcpServers[key];
  return spec && typeof spec === "object" ? spec : undefined;
}