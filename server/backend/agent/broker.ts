import type { ChatContentPart } from "./content-parts";
import { cancelPendingForRequest } from "../forwarder/client-bridge";

/**
 * 本地协议实现。
 * 纯内存，不依赖外部进程。
 */

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_done"; durationMs: number }
  | { type: "summary_started" }
  | { type: "summary"; text: string }
  | { type: "summary_completed"; hookMessage?: string }
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
      /** Complete ConversationStateStructure bytes for the protobuf stream. */
      conversationState?: Buffer;
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
      /** One provider pass owns every tool event it emits. */
      modelCallId: string;
    }
  | {
      type: "tool_completed";
      callId: string;
      name: string;
      result: string;
      ok: boolean;
      /** Original arguments are required to reconstruct Cursor's typed ToolCall. */
      args?: Record<string, unknown>;
      modelCallId: string;
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
      /** Ask Cursor to stop a client-side exec bridge by its protocol message ID. */
      type: "exec_abort";
      messageId: number;
    }
  | {
      type: "interaction_query";
      interactionId: string;
      callId: string;
      name: string;
      args?: Record<string, unknown>;
      messageId: number;
    }
  | {
      type: "error";
      message: string;
      /** Connect terminal code so Cursor uses its native retry/error UI. */
      code?: string;
      /** Original upstream HTTP status used by Cursor's native error classifier. */
      status?: number;
    }
  | { type: "done" }
  | { type: "heartbeat" }
  | { type: "status"; status: string };

/** A pending user turn before it is persisted to the provider history. */
export type UserStreamMessage = {
  content: string;
  contentParts?: ChatContentPart[];
  /** Cursor UserMessage.message_id, retained with the persisted user turn. */
  userMessageId?: string;
  /** Number of Cursor turns that existed before this user message arrived. */
  conversationTurnCount?: number;
  /** Bidi request that supplied this turn. */
  sourceRequestId?: string;
};

export type ActiveStream = {
  requestId: string;
  createdAt: number;
  updatedAt: number;
  messages: UserStreamMessage[];
  modelHint?: string;
  conversationId?: string;
  workspaceRoot?: string;
  /** Last ConversationStateStructure received from Cursor for field preservation. */
  conversationState?: Buffer;
  /** agent | ask | plan | debug | multitask */
  mode?: string;
  /** The active turn carried an explicit mode in Cursor's inbound request. */
  explicitMode?: boolean;
  /** 已进入模型调用 */
  started: boolean;
  /** 已安排启动（防抖中） */
  scheduled: boolean;
  done: boolean;
  /** State/checkpoint is being committed before the native terminal event. */
  terminalPending: boolean;
  /** 用户/客户端取消 */
  cancelled: boolean;
  /** 上游 fetch / 本地 run 共用 */
  abortController: AbortController;
  /** RunSSE 订阅数 */
  subscriberCount: number;
  backlog: StreamEvent[];
  subscribers: Set<(ev: StreamEvent) => void>;
  scheduleTimer?: ReturnType<typeof setTimeout>;
  terminalCleanupTimer?: ReturnType<typeof setTimeout>;
};

const streams = new Map<string, ActiveStream>();
const MAX_STREAMS = 200;
const TERMINAL_STREAM_RETENTION_MS = 30_000;

function isUnusedPlaceholder(stream: ActiveStream): boolean {
  return (
    stream.subscriberCount === 0 &&
    !stream.started &&
    !stream.scheduled &&
    !stream.terminalPending &&
    !stream.conversationId &&
    stream.messages.length === 0 &&
    stream.backlog.length === 0
  );
}

function deleteStream(id: string, stream: ActiveStream): void {
  if (stream.scheduleTimer) {
    clearTimeout(stream.scheduleTimer);
    stream.scheduleTimer = undefined;
  }
  if (stream.terminalCleanupTimer) {
    clearTimeout(stream.terminalCleanupTimer);
    stream.terminalCleanupTimer = undefined;
  }
  streams.delete(id);
}

function gc() {
  const now = Date.now();
  for (const [id, s] of streams) {
    if (
      s.done &&
      s.subscriberCount === 0 &&
      now - s.updatedAt > TERMINAL_STREAM_RETENTION_MS
    ) {
      deleteStream(id, s);
    }
  }
  if (streams.size <= MAX_STREAMS) return;

  // MAX_STREAMS is a memory-pressure hint, not a concurrency limit. Reclaim
  // only terminal streams and RunSSE-first placeholders; live turns may exceed
  // the soft limit and must remain addressable by their request ID.
  const reclaimable = [...streams.entries()]
    .filter(
      ([, stream]) =>
        stream.subscriberCount === 0 &&
        (stream.done || isUnusedPlaceholder(stream)),
    )
    .sort((left, right) => {
      if (left[1].done !== right[1].done) return left[1].done ? -1 : 1;
      return left[1].updatedAt - right[1].updatedAt;
    });
  while (streams.size > MAX_STREAMS && reclaimable.length) {
    const [id, stream] = reclaimable.shift()!;
    if (streams.get(id) === stream) deleteStream(id, stream);
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
      terminalPending: false,
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
  options?: { deferTerminal?: boolean },
): ActiveStream | undefined {
  const s = streams.get(requestId);
  if (!s) return undefined;
  if (s.cancelled && s.done) return s;
  s.cancelled = true;
  s.terminalPending = options?.deferTerminal === true;
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
  // A provider turn can be blocked on a Cursor-executed tool or interaction.
  // Do not wait for its long bridge timeout after the owning stream is gone.
  cancelPendingForRequest(requestId, reason);
  if (!s.done && !options?.deferTerminal) {
    publish(requestId, { type: "error", message: `cancelled: ${reason}` });
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

/** Reserve the final checkpoint-to-terminal commit window for an active turn. */
export function markStreamTerminalPending(requestId: string): boolean {
  const key = String(requestId || "").trim();
  const stream = streams.get(key);
  if (!key || !stream || stream.done || stream.cancelled) return false;
  stream.terminalPending = true;
  stream.updatedAt = Date.now();
  return true;
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
    s.terminalPending = false;
    s.scheduled = false;
    if (s.scheduleTimer) {
      clearTimeout(s.scheduleTimer);
      s.scheduleTimer = undefined;
    }
    if (s.subscriberCount === 0) scheduleTerminalCleanup(s);
  }
}

function cancelTerminalCleanup(stream: ActiveStream): void {
  if (!stream.terminalCleanupTimer) return;
  clearTimeout(stream.terminalCleanupTimer);
  stream.terminalCleanupTimer = undefined;
}

function scheduleTerminalCleanup(stream: ActiveStream): void {
  cancelTerminalCleanup(stream);
  if (!stream.done || stream.subscriberCount > 0) return;
  stream.terminalCleanupTimer = setTimeout(() => {
    stream.terminalCleanupTimer = undefined;
    if (
      streams.get(stream.requestId) === stream &&
      stream.done &&
      stream.subscriberCount === 0
    ) {
      streams.delete(stream.requestId);
    }
  }, TERMINAL_STREAM_RETENTION_MS);
  stream.terminalCleanupTimer.unref?.();
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
  const userMessageId = String(message.userMessageId || "").trim();
  const rawTurnCount = Number(message.conversationTurnCount);
  const conversationTurnCount =
    Number.isFinite(rawTurnCount) && rawTurnCount >= 0
      ? Math.floor(rawTurnCount)
      : undefined;
  const sourceRequestId = String(message.sourceRequestId || requestId).trim();
  if (content || contentParts?.length) {
    const next: UserStreamMessage = {
      content,
      ...(contentParts ? { contentParts } : {}),
      ...(userMessageId ? { userMessageId } : {}),
      ...(conversationTurnCount != null ? { conversationTurnCount } : {}),
      ...(sourceRequestId ? { sourceRequestId } : {}),
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
  metadata?: Omit<UserStreamMessage, "content" | "contentParts">,
) {
  const s = ensureStream(requestId);
  const userMessageId = String(metadata?.userMessageId || "").trim();
  const rawTurnCount = Number(metadata?.conversationTurnCount);
  const conversationTurnCount =
    Number.isFinite(rawTurnCount) && rawTurnCount >= 0
      ? Math.floor(rawTurnCount)
      : undefined;
  const sourceRequestId = String(metadata?.sourceRequestId || requestId).trim();
  const t: UserStreamMessage = {
    content: text.trim(),
    ...(userMessageId ? { userMessageId } : {}),
    ...(conversationTurnCount != null ? { conversationTurnCount } : {}),
    ...(sourceRequestId ? { sourceRequestId } : {}),
  };
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
): { unsubscribe: () => number; replay: StreamEvent[] } {
  const s = ensureStream(requestId);
  cancelTerminalCleanup(s);
  const replay = [...s.backlog];
  s.subscribers.add(onEvent);
  s.subscriberCount = s.subscribers.size;
  s.updatedAt = Date.now();
  return {
    replay,
    unsubscribe: () => {
      s.subscribers.delete(onEvent);
      s.subscriberCount = s.subscribers.size;
      return s.subscriberCount;
    },
  };
}

/** Remove a terminal stream or an unused RunSSE-first placeholder. */
export function removeIfIdle(requestId: string): boolean {
  const key = String(requestId || "").trim();
  const stream = streams.get(key);
  if (!key || !stream || stream.subscriberCount > 0) return false;

  const placeholder = isUnusedPlaceholder(stream);
  if (!stream.done && !placeholder) return false;

  if (stream.scheduleTimer) {
    clearTimeout(stream.scheduleTimer);
    stream.scheduleTimer = undefined;
  }
  cancelTerminalCleanup(stream);
  streams.delete(key);
  return true;
}

export function listActiveStreamIds(): string[] {
  return [...streams.keys()];
}

/**
 * Find live transport requests for one Cursor conversation, excluding the
 * request that is about to replace them. Service code uses this list to send
 * client-exec abort controls before it terminally cancels each old stream.
 */
export function otherActiveConversationRequestIds(
  conversationId: string,
  keepRequestId: string,
): string[] {
  const conversation = String(conversationId || "").trim();
  const keep = String(keepRequestId || "").trim();
  if (!conversation) return [];

  return [...streams.values()]
    .filter(
      (stream) =>
        stream.requestId !== keep &&
        stream.conversationId === conversation &&
        !stream.done &&
        !stream.cancelled,
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((stream) => stream.requestId);
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
