/**
 * Provider probe / batch-test history (stage 2).
 * File: ~/.cursor-studio/history/probe-history.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

export type ProbeHistoryItem = {
  id: string;
  at: string;
  providerId: string;
  displayName?: string;
  ok: boolean;
  latencyMs?: number;
  status?: number;
  endpoint?: string;
  modelCount?: number;
  error?: string;
  batchId?: string;
};

type ProbeHistoryFile = {
  version: 1;
  items: ProbeHistoryItem[];
};

const MAX_ITEMS = 200;
let mutationQueue: Promise<void> = Promise.resolve();

function mutateHistory<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function historyPath(): string {
  const home =
    process.env.CURSOR_STUDIO_HOME ||
    path.join(os.homedir(), ".cursor-studio");
  return path.join(home, "history", "probe-history.json");
}

async function readFile(): Promise<ProbeHistoryFile> {
  const p = historyPath();
  if (!existsSync(p)) return { version: 1, items: [] };
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as ProbeHistoryFile;
    return {
      version: 1,
      items: Array.isArray(raw.items) ? raw.items : [],
    };
  } catch {
    return { version: 1, items: [] };
  }
}

async function writeFile(file: ProbeHistoryFile): Promise<void> {
  const p = historyPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(file, null, 2), "utf8");
}

export async function appendProbeHistory(
  item: Omit<ProbeHistoryItem, "id" | "at"> & { at?: string },
): Promise<ProbeHistoryItem> {
  return mutateHistory(async () => {
    const file = await readFile();
    const next: ProbeHistoryItem = {
      id: randomUUID(),
      at: item.at || new Date().toISOString(),
      providerId: item.providerId,
      displayName: item.displayName,
      ok: item.ok,
      latencyMs: item.latencyMs,
      status: item.status,
      endpoint: item.endpoint,
      modelCount: item.modelCount,
      error: item.error,
      batchId: item.batchId,
    };
    file.items.unshift(next);
    if (file.items.length > MAX_ITEMS) file.items = file.items.slice(0, MAX_ITEMS);
    await writeFile(file);
    return next;
  });
}

export async function listProbeHistory(opts?: {
  limit?: number;
  providerId?: string;
}): Promise<ProbeHistoryItem[]> {
  await mutationQueue;
  const file = await readFile();
  let items = file.items;
  if (opts?.providerId) {
    items = items.filter((i) => i.providerId === opts.providerId);
  }
  const limit = opts?.limit ?? 50;
  return items.slice(0, limit);
}

export async function clearProbeHistory(): Promise<void> {
  await mutateHistory(() => writeFile({ version: 1, items: [] }));
}
