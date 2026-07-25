/**
 * 会话历史：按 requestId 记忆消息（含 tool 轮次）。
 * 落盘 ~/.cursor-studio/history/turns/
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { studioHome } from "../../config/store";
import type { ChatMessage, ToolCall } from "../agent/provider-chat";
import type { ChatContentPart } from "../agent/content-parts";

export type HistoryMessage = ChatMessage & { at?: number };

type HistoryFile = {
  requestId: string;
  messages: HistoryMessage[];
  modelHint?: string;
  updatedAt: number;
};

const memory = new Map<string, HistoryFile>();
const MAX_MESSAGES = 80;
const MAX_FILES = 200;

function historyDir(): string {
  return path.join(studioHome(), "history", "turns");
}

function filePath(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(historyDir(), `${safe}.json`);
}

export async function loadHistory(requestId: string): Promise<HistoryFile> {
  const existing = memory.get(requestId);
  if (existing) return existing;

  const fp = filePath(requestId);
  if (existsSync(fp)) {
    try {
      const raw = await fs.readFile(fp, "utf8");
      const parsed = JSON.parse(raw) as HistoryFile;
      if (parsed?.requestId) {
        memory.set(requestId, parsed);
        return parsed;
      }
    } catch {
      /* ignore corrupt */
    }
  }

  const fresh: HistoryFile = {
    requestId,
    messages: [],
    updatedAt: Date.now(),
  };
  memory.set(requestId, fresh);
  return fresh;
}

export async function appendHistoryMessage(
  requestId: string,
  message: ChatMessage,
  modelHint?: string,
): Promise<void> {
  const h = await loadHistory(requestId);
  // 简单去重：连续完全相同 JSON 不重复
  const serialized = JSON.stringify(message);
  const last = h.messages[h.messages.length - 1];
  if (last && JSON.stringify(stripAt(last)) === serialized) return;

  h.messages.push({ ...message, at: Date.now() });
  if (h.messages.length > MAX_MESSAGES) {
    h.messages = h.messages.slice(-MAX_MESSAGES);
  }
  if (modelHint) h.modelHint = modelHint;
  h.updatedAt = Date.now();
  memory.set(requestId, h);
  await persist(h).catch(() => undefined);
}

/** 兼容旧接口：纯文本 user/assistant */
export async function appendHistory(
  requestId: string,
  role: "user" | "assistant" | "system",
  content: string,
  modelHint?: string,
  contentParts?: ChatContentPart[],
): Promise<void> {
  const t = content.trim();
  const parts = contentParts?.length ? contentParts : undefined;
  if (!t && !parts?.length && role !== "assistant") return;
  if (role === "assistant") {
    await appendHistoryMessage(requestId, { role, content: t }, modelHint);
    return;
  }
  await appendHistoryMessage(
    requestId,
    { role, content: t, ...(parts ? { contentParts: parts } : {}) },
    modelHint,
  );
}

export async function appendAssistantWithTools(
  requestId: string,
  text: string,
  toolCalls?: ToolCall[],
  modelHint?: string,
): Promise<void> {
  await appendHistoryMessage(
    requestId,
    {
      role: "assistant",
      content: text || "",
      tool_calls: toolCalls,
    },
    modelHint,
  );
}

export async function appendToolResult(
  requestId: string,
  toolCallId: string,
  name: string,
  content: string,
): Promise<void> {
  await appendHistoryMessage(requestId, {
    role: "tool",
    tool_call_id: toolCallId,
    name,
    content,
  });
}

function stripAt(m: HistoryMessage): ChatMessage {
  const { at: _a, ...rest } = m as HistoryMessage & { at?: number };
  void _a;
  return rest as ChatMessage;
}

async function persist(h: HistoryFile): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });
  await fs.writeFile(filePath(h.requestId), JSON.stringify(h, null, 2), "utf8");
  if (memory.size > MAX_FILES) {
    const ordered = [...memory.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    while (memory.size > MAX_FILES && ordered.length) {
      const [id] = ordered.shift()!;
      memory.delete(id);
    }
  }
}

export async function historyAsChatMessages(
  requestId: string,
): Promise<ChatMessage[]> {
  const h = await loadHistory(requestId);
  return h.messages.map((m) => stripAt(m));
}

/**
 * Remove every persisted Studio forwarding turn and its in-memory counterpart.
 * Cursor owns the visible conversation store; this only clears the proxy-side
 * prompt history so a new Cursor conversation can never inherit an old turn.
 */
export async function clearAllHistory(): Promise<{
  removed: number;
  failed: Array<{ file: string; error: string }>;
}> {
  memory.clear();

  const dir = historyDir();
  if (!existsSync(dir)) return { removed: 0, failed: [] };

  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    return {
      removed: 0,
      failed: [{ file: dir, error: error instanceof Error ? error.message : String(error) }],
    };
  }

  let removed = 0;
  const failed: Array<{ file: string; error: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    const target = path.join(dir, entry.name);
    try {
      await fs.rm(target, { force: true });
      removed += 1;
    } catch (error) {
      failed.push({
        file: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, failed };
}
