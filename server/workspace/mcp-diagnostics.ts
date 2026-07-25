/**
 * MCP probe diagnostics history (stage 4).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { McpProbeResult } from "./mcp-probe";

export type McpProbeHistoryItem = {
  id: string;
  at: string;
  serverId: string;
  ok: boolean;
  kind?: string;
  latencyMs?: number;
  toolCount?: number;
  error?: string;
  tools?: Array<{ name: string; description?: string }>;
};

type FileShape = { version: 1; items: McpProbeHistoryItem[] };

function historyPath(): string {
  const home =
    process.env.CURSOR_STUDIO_HOME ||
    path.join(os.homedir(), ".cursor-studio");
  return path.join(home, "history", "mcp-probe-history.json");
}

async function readFile(): Promise<FileShape> {
  const p = historyPath();
  if (!existsSync(p)) return { version: 1, items: [] };
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as FileShape;
    return { version: 1, items: Array.isArray(raw.items) ? raw.items : [] };
  } catch {
    return { version: 1, items: [] };
  }
}

async function writeFile(file: FileShape): Promise<void> {
  await fs.mkdir(path.dirname(historyPath()), { recursive: true });
  await fs.writeFile(historyPath(), JSON.stringify(file, null, 2), "utf8");
}

export async function appendMcpProbeHistory(
  serverId: string,
  probe: McpProbeResult,
): Promise<McpProbeHistoryItem> {
  const file = await readFile();
  const item: McpProbeHistoryItem = {
    id: randomUUID(),
    at: new Date().toISOString(),
    serverId,
    ok: probe.ok,
    kind: probe.kind,
    latencyMs: probe.latencyMs,
    toolCount: probe.toolCount,
    error: probe.error,
    tools: (probe.tools || []).slice(0, 20),
  };
  file.items.unshift(item);
  file.items = file.items.slice(0, 200);
  await writeFile(file);
  return item;
}

export async function listMcpProbeHistory(opts?: {
  serverId?: string;
  limit?: number;
}): Promise<McpProbeHistoryItem[]> {
  const file = await readFile();
  let items = file.items;
  if (opts?.serverId) items = items.filter((i) => i.serverId === opts.serverId);
  return items.slice(0, opts?.limit ?? 50);
}

export async function latestMcpProbeByServer(): Promise<
  Record<string, McpProbeHistoryItem>
> {
  const file = await readFile();
  const map: Record<string, McpProbeHistoryItem> = {};
  for (const item of file.items) {
    if (!map[item.serverId]) map[item.serverId] = item;
  }
  return map;
}
