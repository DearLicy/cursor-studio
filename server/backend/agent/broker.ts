import type { ChatContentPart } from "./content-parts";

/**
 * 本地协议实现。
 * 纯内存，不依赖外部进程。
 */

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_done"; durationMs: number }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | {
      /** Persisted Cursor conversation checkpoint used for context management. */
      type: "checkpoint";
      usedTokens: number;
      maxTokens: number;
    }
  | {
      type: "turn_ended";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | {
      type: "tool_started";
      callId: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_completed";
      callId: string;
      name: string;
      result: string;
      ok: boolean;
    }
  | {
      type: "exec_request";
      execId: string;
      callId: string;
      name: string;
      args?: Record<string, unknown>;
      messageId?: number;
    }
  | {
      type: "interaction_query";
      interactionId: string;
      callId: string;
      name: string;
      args?: Record<string, unknown>;
      messageId: number;
    }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "heartbeat" }
  | { type: "status"; status: string };

/** A pending user turn before it is persisted to the provider history. */
export type UserStreamMessage = {
  content: string;
  contentParts?: ChatContentPart[];
};

export type ActiveStream = {
  requestId: string;
  createdAt: number;
  updatedAt: number;
  messages: UserStreamMessage[];
  modelHint?: string;
  conversationId?: string;
  workspaceRoot?: string;
  /** agent | ask | plan | debug | multitask */
  mode?: string;
  /** 已进入模型调用 */
  started: boolean;
  /** 已安排启动（防抖中） */
  scheduled: boolean;
  done: boolean;
  /** 用户/客户端取消 */
  cancelled: boolean;
  /** 上游 fetch / 本地 run 共用 */
  abortController: AbortController;
  /** RunSSE 订阅数 */
  subscriberCount: number;
  backlog: StreamEvent[];
  subscribers: Set<(ev: StreamEvent) => void>;
  scheduleTimer?: ReturnType<typeof setTimeout>;
};

const streams = new Map<string, ActiveStream>();
const MAX_STREAMS = 200;
const STREAM_TTL_MS = 30 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, s] of streams) {
    if (s.done && now - s.updatedAt > STREAM_TTL_MS) streams.delete(id);
  }
  if (streams.size <= MAX_STREAMS) return;
  const ordered = [...streams.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (streams.size > MAX_STREAMS && ordered.length) {
    const [id] = ordered.shift()!;
    streams.delete(id);
  }
}

export function ensureStream(requestId: string): ActiveStream {
  gc();
  let s = streams.get(requestId);
  if (!s) {
    s = {
      requestId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      started: false,
      scheduled: false,
      done: false,
      cancelled: false,
      abortController: new AbortController(),
      subscriberCount: 0,
      backlog: [],
      subscribers: new Set(),
    };
    streams.set(requestId, s);
  }
  return s;
}

export function getStream(requestId: string): ActiveStream | undefined {
  return streams.get(requestId);
}

/** Cancel an in-flight or scheduled turn. Safe to call multiple times. */
export function cancelStream(
  requestId: string,
  reason = "client_cancel",
): ActiveStream | undefined {
  const s = streams.get(requestId);
  if (!s) return undefined;
  if (s.cancelled && s.done) return s;
  s.cancelled = true;
  s.updatedAt = Date.now();
  if (s.scheduleTimer) {
    clearTimeout(s.scheduleTimer);
    s.scheduleTimer = undefined;
  }
  s.scheduled = false;
  try {
    if (!s.abortController.signal.aborted) {
      s.abortController.abort(reason);
    }
  } catch {
    /* ignore */
  }
  if (!s.done) {
    publish(requestId, { type: "error", message: `cancelled: ${reason}` });
    publish(requestId, { type: "done" });
  }
  return s;
}

export function getStreamSignal(requestId: string): AbortSignal {
  return ensureStream(requestId).abortController.signal;
}

export function isStreamCancelled(requestId: string): boolean {
  const s = streams.get(requestId);
  return Boolean(s?.cancelled || s?.abortController.signal.aborted);
}

export function publish(requestId: string, event: StreamEvent) {
  const s = ensureStream(requestId);
  s.updatedAt = Date.now();
  s.backlog.push(event);
  if (s.backlog.length > 500) s.backlog.splice(0, s.backlog.length - 500);
  for (const sub of s.subscribers) {
    try {
      sub(event);
    } catch {
      /* ignore */
    }
  }
  if (event.type === "done" || event.type === "error") {
    s.done = true;
    s.scheduled = false;
    if (s.scheduleTimer) {
      clearTimeout(s.scheduleTimer);
      s.scheduleTimer = undefined;
    }
  }
}

/**
 * Preserve structured parts until the turn is persisted. Cursor can resend a
 * Bidi append, so only collapse exact consecutive copies of the full payload.
 */
export function appendUserMessage(
  requestId: string,
  message: UserStreamMessage,
  modelHint?: string,
  mode?: string,
) {
  const s = ensureStream(requestId);
  const content = String(message.content || "").trim();
  const contentParts = message.contentParts?.length
    ? message.contentParts
    : undefined;
  if (content || contentParts?.length) {
    const next: UserStreamMessage = {
      content,
      ...(contentParts ? { contentParts } : {}),
    };
    const last = s.messages[s.messages.length - 1];
    if (!last || JSON.stringify(last) !== JSON.stringify(next)) {
      s.messages.push(next);
    }
  }
  if (modelHint) s.modelHint = modelHint;
  if (mode) s.mode = mode;
  s.updatedAt = Date.now();
}

/** Backward-compatible text-only entry point. */
export function appendUserText(
  requestId: string,
  text: string,
  modelHint?: string,
  mode?: string,
) {
  const s = ensureStream(requestId);
  const t: UserStreamMessage = { content: text.trim() };
  if (t.content) {
    // 去重：连续相同文本不重复堆
    if (JSON.stringify(s.messages[s.messages.length - 1] ?? {}) !== JSON.stringify(t)) {
      s.messages.push(t);
    }
  }
  if (modelHint) s.modelHint = modelHint;
  if (mode) s.mode = mode;
  s.updatedAt = Date.now();
}

export function setStreamMode(requestId: string, mode?: string) {
  if (!mode) return;
  const s = ensureStream(requestId);
  s.mode = mode;
  s.updatedAt = Date.now();
}

/**
 * 防抖启动模型：等 Bidi 文本与 RunSSE 订阅就绪，避免空跑。
 * delayMs 默认 280ms；有订阅且有消息时可更短。
 */
export function scheduleRun(
  requestId: string,
  run: () => void,
  opts?: { delayMs?: number; requireMessage?: boolean },
): void {
  const s = ensureStream(requestId);
  if (s.started || s.done) return;

  const delay =
    opts?.delayMs ??
    (s.subscriberCount > 0 && s.messages.length > 0 ? 80 : 280);

  if (s.scheduleTimer) clearTimeout(s.scheduleTimer);
  s.scheduled = true;
  s.scheduleTimer = setTimeout(() => {
    s.scheduleTimer = undefined;
    if (s.started || s.done || s.cancelled || s.abortController.signal.aborted) return;
    if (opts?.requireMessage !== false && s.messages.length === 0 && s.subscriberCount === 0) {
      // 既无消息也无订阅：再等一轮
      s.scheduled = false;
      return;
    }
    run();
  }, delay);
}

export function markStarted(requestId: string): boolean {
  const s = ensureStream(requestId);
  if (s.started || s.done || s.cancelled || s.abortController.signal.aborted) return false;
  s.started = true;
  s.scheduled = false;
  if (s.scheduleTimer) {
    clearTimeout(s.scheduleTimer);
    s.scheduleTimer = undefined;
  }
  s.updatedAt = Date.now();
  return true;
}

export function subscribe(
  requestId: string,
  onEvent: (ev: StreamEvent) => void,
): { unsubscribe: () => void; replay: StreamEvent[] } {
  const s = ensureStream(requestId);
  const replay = [...s.backlog];
  s.subscribers.add(onEvent);
  s.subscriberCount = s.subscribers.size;
  s.updatedAt = Date.now();
  return {
    replay,
    unsubscribe: () => {
      s.subscribers.delete(onEvent);
      s.subscriberCount = s.subscribers.size;
    },
  };
}

export function listActiveStreamIds(): string[] {
  return [...streams.keys()];
}

export function setStreamConversationContext(
  requestId: string,
  conversationId: string,
  workspaceRoot?: string,
) {
  const id = String(conversationId || "").trim();
  if (!id) return;
  const s = ensureStream(requestId);
  if (s.conversationId !== id) {
    s.conversationId = id;
    s.workspaceRoot = undefined;
  }
  if (workspaceRoot) s.workspaceRoot = workspaceRoot;
  s.updatedAt = Date.now();
}
