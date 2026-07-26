/**
 * 会话历史：按 requestId 记忆消息（含 tool 轮次）。
 * 落盘 ~/.cursor-studio/history/turns/
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { studioHome } from "../../config/store";
import type {
  AssistantReasoningMetadata,
  ChatMessage,
  ToolCall,
} from "../agent/provider-chat";
import type { ChatContentPart } from "../agent/content-parts";
import { normalizeProviderReplay } from "./replay-normalizer";

export type HistoryMessageMetadata = {
  /** Cursor UserMessage.message_id, used to detect a branch/rewind action. */
  cursorMessageId?: string;
  /** Cursor turn sequence when available in the inbound state. */
  turnSequence?: number;
  /** Bidi request that created the entry, retained for replay diagnostics. */
  sourceRequestId?: string;
  /** Runtime prompt-context identity; tagged user messages are not user turns. */
  promptContextSource?: string;
  promptContextHash?: string;
};

export type HistoryMessage = ChatMessage &
  HistoryMessageMetadata & {
    at?: number;
  };

export type HistoryPromptContext = {
  source: string;
  message: {
    role: "system" | "user";
    content: string;
  };
};

export type ConversationRoute = {
  /** The Cursor model selection, including its thinking variant when present. */
  modelHint?: string;
  providerId?: string;
  modelID?: string;
  /** Provider-confirmed context window retained with the conversation route. */
  contextWindowTokens?: number;
};

export type HistoryReplacementOptions = {
  signal?: AbortSignal;
  /** Final summary committed by one successful compaction transaction. */
  compactionSummary?: string;
};

export type HistoryCompactionState = {
  /** Successful summary generations in oldest-to-newest order. */
  summaries: string[];
  /** Cursor's monotonic self_summary_count, which may exceed imported texts. */
  selfSummaryCount: number;
};

export type ConversationLoopStatus =
  | "idle"
  | "running"
  | "waiting_tool"
  | "completed"
  | "provider_error"
  | "failed"
  | "canceled";

export type HistoryLoopEventKind =
  | "run_request"
  | "tool_call"
  | "tool_result"
  | "turn_completed"
  | "provider_error"
  | "failed"
  | "canceled";

export type HistoryLoopEvent = {
  seq: number;
  requestId: string;
  turnSequence: number;
  kind: HistoryLoopEventKind;
  toolCallId?: string;
  at: number;
};

export type HistoryLoopSnapshot = {
  found: boolean;
  readable: boolean;
  currentLoopId?: string;
  currentLoopStatus: ConversationLoopStatus;
  currentRequestId?: string;
  currentTurnSequence?: number;
  nextTurnSequence: number;
};

type HistoryFile = ConversationRoute & {
  requestId: string;
  messages: HistoryMessage[];
  compactionSummaries?: string[];
  selfSummaryCount?: number;
  nextTurnSequence?: number;
  currentLoopId?: string;
  currentLoopStatus?: ConversationLoopStatus;
  currentRequestId?: string;
  currentTurnSequence?: number;
  nextLoopEventSequence?: number;
  loopEvents?: HistoryLoopEvent[];
  canceledTurns?: CanceledHistoryTurn[];
  updatedAt: number;
};

export type CanceledHistoryTurn = {
  sourceRequestId: string;
  reason: string;
  replayPolicy: "drop_unstarted_turn" | "keep_stable_input";
  turnSequence?: number;
  at: number;
};

export type CanceledHistoryTurnResult = {
  applied: boolean;
  replayPolicy?: CanceledHistoryTurn["replayPolicy"];
  removedMessages: number;
};

const memory = new Map<string, HistoryFile>();
const mutationQueues = new Map<string, Promise<void>>();
const MAX_FILES = 200;
const HISTORY_WRITE_LOCK = ".history-write.lock";
const HISTORY_LOCK_STALE_MS = 30_000;
const HISTORY_LOCK_TIMEOUT_MS = 20_000;
const HISTORY_LOCK_RETRY_MS = 15;
const RETAINED_SUMMARY_PREFIXES = [
  [
    "Earlier conversation context was summarized by the selected model.",
    "Treat the following as retained facts and continue consistently:",
  ].join("\n\n"),
  [
    "Earlier conversation context was summarized by Cursor.",
    "Treat the following as retained facts and continue consistently:",
  ].join("\n\n"),
] as const;

function promptContextContentHash(
  message: HistoryPromptContext["message"],
): string {
  return createHash("sha256")
    .update(`${message.role.trim()}\0${message.content.trim()}`)
    .digest("hex");
}

function promptContextKey(message: HistoryMessage): string {
  const source = String(message.promptContextSource || "").trim();
  if (!source) return "";
  const hash = String(message.promptContextHash || "").trim() ||
    promptContextContentHash({
      role: message.role === "system" ? "system" : "user",
      content: message.content,
    });
  return `${source}\0${hash}`;
}

export function isPromptContextHistoryMessage(
  message: Pick<HistoryMessage, "role" | "promptContextSource" | "promptContextHash">,
): boolean {
  return (
    (message.role === "user" || message.role === "system") &&
    Boolean(
      String(message.promptContextSource || "").trim() &&
      String(message.promptContextHash || "").trim(),
    )
  );
}

function isUserTurnStart(message: HistoryMessage): boolean {
  return message.role === "user" && !isPromptContextHistoryMessage(message);
}

const LOOP_STATUSES = new Set<ConversationLoopStatus>([
  "idle",
  "running",
  "waiting_tool",
  "completed",
  "provider_error",
  "failed",
  "canceled",
]);

const LOOP_EVENT_KINDS = new Set<HistoryLoopEventKind>([
  "run_request",
  "tool_call",
  "tool_result",
  "turn_completed",
  "provider_error",
  "failed",
  "canceled",
]);

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function normalizeLoopStatus(value: unknown): ConversationLoopStatus | undefined {
  const status = String(value || "").trim() as ConversationLoopStatus;
  return LOOP_STATUSES.has(status) ? status : undefined;
}

function normalizeLoopEvents(value: unknown): HistoryLoopEvent[] {
  if (!Array.isArray(value)) return [];
  const normalized: HistoryLoopEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<HistoryLoopEvent>;
    const requestId = String(raw.requestId || "").trim();
    const turnSequence = positiveInteger(raw.turnSequence);
    const kind = String(raw.kind || "").trim() as HistoryLoopEventKind;
    if (!requestId || !turnSequence || !LOOP_EVENT_KINDS.has(kind)) continue;
    const seq = positiveInteger(raw.seq) || normalized.length + 1;
    const toolCallId = String(raw.toolCallId || "").trim();
    const at = Number(raw.at);
    normalized.push({
      seq,
      requestId,
      turnSequence,
      kind,
      ...(toolCallId ? { toolCallId } : {}),
      at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    });
  }
  normalized.sort((left, right) => left.seq - right.seq || left.at - right.at);
  return normalized.map((event, index) => ({ ...event, seq: index + 1 }));
}

function terminalStatusForLoopEvent(
  kind: HistoryLoopEventKind,
): ConversationLoopStatus | undefined {
  switch (kind) {
    case "turn_completed":
      return "completed";
    case "provider_error":
      return "provider_error";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return undefined;
  }
}

function legacyLoopStatus(
  history: HistoryFile,
  requestId: string,
  turnSequence: number,
): ConversationLoopStatus {
  const turnMessages = history.messages.filter((message) => {
    const source = String(message.sourceRequestId || "").trim();
    const turn = positiveInteger(message.turnSequence);
    if (turn) return turn === turnSequence;
    return !source || source === requestId;
  });
  const openTools = new Set<string>();
  let sawAssistant = false;
  for (const message of turnMessages) {
    if (message.role === "assistant") {
      sawAssistant = true;
      for (const call of message.tool_calls || []) {
        const id = String(call.id || "").trim();
        if (id) openTools.add(id);
      }
    } else if (message.role === "tool") {
      const id = String(message.tool_call_id || "").trim();
      if (id) openTools.delete(id);
    }
  }
  if (openTools.size > 0) return "waiting_tool";
  return sawAssistant ? "completed" : "running";
}

/**
 * Rebuild the durable loop projection from semantic events. The projection is
 * deliberately derived on every load and write to match the runtime file store:
 * current fields are a cache, while events are the recoverable source of truth.
 */
function deriveHistoryLoopState(history: HistoryFile): void {
  history.loopEvents = normalizeLoopEvents(history.loopEvents);
  history.nextLoopEventSequence = history.loopEvents.length + 1;
  history.nextTurnSequence = Math.max(
    positiveInteger(history.nextTurnSequence) || 1,
    nextTurnSequence(history.messages),
    history.loopEvents.reduce(
      (next, event) => Math.max(next, event.turnSequence + 1),
      1,
    ),
  );

  const requestedId = String(history.currentRequestId || "").trim();
  const requestedTurn = positiveInteger(history.currentTurnSequence);
  const hasRequestedRun = Boolean(
    requestedId &&
    requestedTurn &&
    history.loopEvents.some(
      (event) =>
        event.kind === "run_request" &&
        event.requestId === requestedId &&
        event.turnSequence === requestedTurn,
    ),
  );
  const latestRun = [...history.loopEvents]
    .reverse()
    .find((event) => event.kind === "run_request");
  let currentRequestId = hasRequestedRun ? requestedId : latestRun?.requestId;
  let currentTurnSequence = hasRequestedRun ? requestedTurn : latestRun?.turnSequence;

  // Older snapshots predate loop events. Derive a conservative in-memory
  // state so a completed legacy conversation is not restarted on reconnect;
  // the first later mutation will persist the normalized semantic event.
  if (!currentRequestId || !currentTurnSequence) {
    const legacyTurn = [...history.messages]
      .reverse()
      .find(isUserTurnStart);
    const legacyRequestId = String(legacyTurn?.sourceRequestId || "").trim();
    const legacyTurnSequence = positiveInteger(legacyTurn?.turnSequence);
    if (legacyRequestId && legacyTurnSequence) {
      currentRequestId = legacyRequestId;
      currentTurnSequence = legacyTurnSequence;
      history.loopEvents.push({
        seq: history.loopEvents.length + 1,
        requestId: legacyRequestId,
        turnSequence: legacyTurnSequence,
        kind: "run_request",
        at: Number(legacyTurn?.at) || history.updatedAt || Date.now(),
      });
      history.nextLoopEventSequence = history.loopEvents.length + 1;
    }
  }

  if (!currentRequestId || !currentTurnSequence) {
    delete history.currentLoopId;
    delete history.currentRequestId;
    delete history.currentTurnSequence;
    history.currentLoopStatus = normalizeLoopStatus(history.currentLoopStatus) || "idle";
    return;
  }

  const events = history.loopEvents.filter(
    (event) =>
      event.requestId === currentRequestId &&
      event.turnSequence === currentTurnSequence,
  );
  const openTools = new Set<string>();
  let terminalStatus: ConversationLoopStatus | undefined;
  let sawActivity = false;
  for (const event of events) {
    sawActivity = true;
    if (event.kind === "tool_call") {
      if (event.toolCallId) openTools.add(event.toolCallId);
      continue;
    }
    if (event.kind === "tool_result") {
      if (event.toolCallId) openTools.delete(event.toolCallId);
      continue;
    }
    terminalStatus = terminalStatusForLoopEvent(event.kind) || terminalStatus;
  }

  let status = terminalStatus;
  if (!status && openTools.size > 0) status = "waiting_tool";
  if (!status && sawActivity) {
    const onlyRunMarker =
      events.length === 1 &&
      events[0]?.kind === "run_request";
    const retainedStatus = normalizeLoopStatus(history.currentLoopStatus);
    status = onlyRunMarker
      ? retainedStatus || legacyLoopStatus(history, currentRequestId, currentTurnSequence)
      : "running";
  }
  status ||= normalizeLoopStatus(history.currentLoopStatus) || "idle";

  history.currentRequestId = currentRequestId;
  history.currentTurnSequence = currentTurnSequence;
  history.currentLoopId = `${currentTurnSequence}:${currentRequestId}`;
  history.currentLoopStatus = status;
}

function loopSnapshotFromHistory(
  history: HistoryFile,
  found = true,
  readable = true,
): HistoryLoopSnapshot {
  deriveHistoryLoopState(history);
  return {
    found,
    readable,
    currentLoopId: history.currentLoopId,
    currentLoopStatus: history.currentLoopStatus || "idle",
    currentRequestId: history.currentRequestId,
    currentTurnSequence: history.currentTurnSequence,
    nextTurnSequence: positiveInteger(history.nextTurnSequence) || 1,
  };
}

function appendLoopEvent(
  history: HistoryFile,
  event: Omit<HistoryLoopEvent, "seq" | "at">,
): void {
  const requestId = String(event.requestId || "").trim();
  const turnSequence = positiveInteger(event.turnSequence);
  if (!requestId || !turnSequence) return;
  const toolCallId = String(event.toolCallId || "").trim();
  const duplicate = [...(history.loopEvents || [])]
    .reverse()
    .find(
      (current) =>
        current.requestId === requestId &&
        current.turnSequence === turnSequence &&
        current.kind === event.kind &&
        String(current.toolCallId || "") === toolCallId,
    );
  if (duplicate) return;
  const seq = positiveInteger(history.nextLoopEventSequence) ||
    (history.loopEvents?.length || 0) + 1;
  history.loopEvents = [
    ...(history.loopEvents || []),
    {
      seq,
      requestId,
      turnSequence,
      kind: event.kind,
      ...(toolCallId ? { toolCallId } : {}),
      at: Date.now(),
    },
  ];
  history.nextLoopEventSequence = seq + 1;
  deriveHistoryLoopState(history);
}

function cleanSummaryText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function normalizeCompactionSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanSummaryText).filter(Boolean);
}

function normalizeSelfSummaryCount(value: unknown, knownSummaries: number): number {
  const count = Number(value);
  return Math.max(
    knownSummaries,
    Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  );
}

function retainedSummaryText(messages: readonly ChatMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== "system") return "";
  const content = cleanSummaryText(first.content);
  for (const prefix of RETAINED_SUMMARY_PREFIXES) {
    if (content.startsWith(`${prefix}\n\n`)) {
      return cleanSummaryText(content.slice(prefix.length));
    }
  }
  return "";
}

function historyCompactionState(history: HistoryFile): HistoryCompactionState {
  const summaries = normalizeCompactionSummaries(history.compactionSummaries);
  return {
    summaries,
    selfSummaryCount: normalizeSelfSummaryCount(history.selfSummaryCount, summaries.length),
  };
}

function normalizeContextWindowTokens(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return undefined;
  return Math.floor(numeric);
}

function applyConversationRoute(
  history: HistoryFile,
  route: ConversationRoute | undefined,
): void {
  if (!route) return;
  const providerId = String(route.providerId || "").trim();
  const modelID = String(route.modelID || "").trim();
  const routeChanged = Boolean(
    (providerId && history.providerId && providerId !== history.providerId) ||
    (modelID && history.modelID && modelID !== history.modelID),
  );
  if (route.modelHint?.trim()) history.modelHint = route.modelHint.trim();
  if (providerId) history.providerId = providerId;
  if (modelID) history.modelID = modelID;
  const contextWindowTokens = normalizeContextWindowTokens(
    route.contextWindowTokens,
  );
  if (contextWindowTokens) history.contextWindowTokens = contextWindowTokens;
  else if (routeChanged) delete history.contextWindowTokens;
}

function commitCompactionSummary(
  history: HistoryFile,
  summary: string,
  previousVisibleSummary: string,
): void {
  const committed = cleanSummaryText(summary);
  if (!committed) return;

  const state = historyCompactionState(history);
  if (!state.summaries.length) {
    const previous = cleanSummaryText(previousVisibleSummary);
    if (previous) state.summaries.push(previous);
  }
  const priorCount = Math.max(state.selfSummaryCount, state.summaries.length);
  state.summaries.push(committed);
  history.compactionSummaries = state.summaries;
  history.selfSummaryCount = priorCount + 1;
}

function mergeSummarySequences(
  current: readonly string[],
  incoming: readonly string[],
  generationCount: number,
): string[] {
  if (!current.length) return [...incoming];
  if (!incoming.length) return [...current];
  let overlap = Math.min(current.length, incoming.length);
  while (
    overlap > 0 &&
    !current.slice(-overlap).every((summary, index) => summary === incoming[index])
  ) {
    overlap -= 1;
  }
  const merged = [...current, ...incoming.slice(overlap)];
  if (merged.length <= generationCount) return merged;
  return incoming.length >= generationCount ? [...incoming] : merged.slice(-generationCount);
}

function mergeCompactionState(
  history: HistoryFile,
  incoming: HistoryCompactionState | undefined,
): boolean {
  if (!incoming) return false;
  const incomingSummaries = normalizeCompactionSummaries(incoming.summaries);
  const incomingCount = normalizeSelfSummaryCount(
    incoming.selfSummaryCount,
    incomingSummaries.length,
  );
  if (!incomingCount && !incomingSummaries.length) return false;

  const current = historyCompactionState(history);
  if (current.selfSummaryCount > incomingCount) return false;
  if (
    current.selfSummaryCount === incomingCount &&
    current.summaries.length > incomingSummaries.length
  ) {
    return false;
  }
  if (
    current.selfSummaryCount === incomingCount &&
    current.summaries.length === incomingSummaries.length &&
    current.summaries.every((summary, index) => summary === incomingSummaries[index])
  ) {
    return false;
  }

  history.compactionSummaries = incomingCount > current.selfSummaryCount
    ? mergeSummarySequences(current.summaries, incomingSummaries, incomingCount)
    : incomingSummaries;
  history.selfSummaryCount = incomingCount;
  return true;
}

function historyDir(): string {
  return path.join(studioHome(), "history", "turns");
}

function filePath(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(historyDir(), `${safe}.json`);
}

function backupPath(requestId: string): string {
  return `${filePath(requestId)}.bak`;
}

function historyWriteLockPath(): string {
  return path.join(historyDir(), HISTORY_WRITE_LOCK);
}

export async function loadHistory(requestId: string): Promise<HistoryFile> {
  // A Cursor window and the desktop application can both own a forwarding
  // process. Always prefer the on-disk snapshot over this process's cache so a
  // completed write in the other process is immediately visible.
  const stored = await readPersistedHistory(filePath(requestId), requestId);
  if (stored) {
    memory.set(requestId, stored);
    return stored;
  }

  // Atomic replacement prevents torn primary files. The sidecar is retained
  // specifically for abrupt machine/process termination and is only used when
  // the primary file is absent or malformed.
  const recovered = await readPersistedHistory(backupPath(requestId), requestId);
  if (recovered) {
    memory.set(requestId, recovered);
    return recovered;
  }

  const existing = memory.get(requestId);
  if (existing) return existing;
  const fresh: HistoryFile = {
    requestId,
    messages: [],
    currentLoopStatus: "idle",
    nextTurnSequence: 1,
    nextLoopEventSequence: 1,
    loopEvents: [],
    updatedAt: Date.now(),
  };
  memory.set(requestId, fresh);
  return fresh;
}

async function readPersistedHistory(
  target: string,
  requestId: string,
): Promise<HistoryFile | undefined> {
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as HistoryFile;
    if (
      parsed &&
      parsed.requestId === requestId &&
      Array.isArray(parsed.messages) &&
      Number.isFinite(Number(parsed.updatedAt))
    ) {
      const compactionState = historyCompactionState(parsed);
      parsed.compactionSummaries = compactionState.summaries.length
        ? compactionState.summaries
        : undefined;
      parsed.selfSummaryCount = compactionState.selfSummaryCount || undefined;
      parsed.contextWindowTokens = normalizeContextWindowTokens(
        parsed.contextWindowTokens,
      );
      deriveHistoryLoopState(parsed);
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      console.warn("[forwarder] ignored unreadable history snapshot", target);
    }
  }
  return undefined;
}

/**
 * Read the durable loop projection without manufacturing a fresh conversation.
 * The resume guard needs to distinguish a real idle file from a missing or
 * unreadable file; both latter cases are conservatively allowed to continue.
 */
export async function historyLoopSnapshot(
  requestId: string,
): Promise<HistoryLoopSnapshot> {
  const primary = filePath(requestId);
  const backup = backupPath(requestId);
  const found = existsSync(primary) || existsSync(backup);
  const stored = await readPersistedHistory(primary, requestId) ||
    await readPersistedHistory(backup, requestId);
  if (!stored) {
    return {
      found,
      readable: false,
      currentLoopStatus: "idle",
      nextTurnSequence: 1,
    };
  }
  return loopSnapshotFromHistory(stored, true, true);
}

/** Begin one durable provider loop before the Bidi request is acknowledged. */
export async function beginHistoryLoop(
  historyKey: string,
  sourceRequestId: string,
  preferredTurnSequence?: number,
): Promise<HistoryLoopSnapshot> {
  const requestId = String(sourceRequestId || "").trim();
  if (!requestId) {
    throw new Error("source request id is required to begin a history loop");
  }
  let snapshot: HistoryLoopSnapshot | undefined;
  await queueHistoryMutation(historyKey, async () => {
    const history = await loadHistory(historyKey);
    deriveHistoryLoopState(history);
    if (
      history.currentRequestId === requestId &&
      positiveInteger(history.currentTurnSequence)
    ) {
      snapshot = loopSnapshotFromHistory(history);
      return;
    }

    const turnSequence = Math.max(
      positiveInteger(history.nextTurnSequence) || 1,
      positiveInteger(preferredTurnSequence) || 1,
    );
    history.currentRequestId = requestId;
    history.currentTurnSequence = turnSequence;
    history.currentLoopId = `${turnSequence}:${requestId}`;
    history.currentLoopStatus = "running";
    history.nextTurnSequence = turnSequence + 1;
    appendLoopEvent(history, {
      requestId,
      turnSequence,
      kind: "run_request",
    });
    history.updatedAt = Date.now();
    memory.set(historyKey, history);
    await persist(history);
    snapshot = loopSnapshotFromHistory(history);
  });
  return snapshot || {
    found: false,
    readable: false,
    currentLoopStatus: "idle",
    nextTurnSequence: 1,
  };
}

export type HistoryLoopTerminalStatus = Extract<
  ConversationLoopStatus,
  "completed" | "provider_error" | "failed" | "canceled"
>;

/** Persist a terminal marker before publishing Cursor's terminal stream event. */
export async function finishHistoryLoop(
  historyKey: string,
  sourceRequestId: string,
  status: HistoryLoopTerminalStatus,
): Promise<boolean> {
  const requestId = String(sourceRequestId || "").trim();
  if (!requestId) return false;
  let applied = false;
  await queueHistoryMutation(historyKey, async () => {
    const history = await loadHistory(historyKey);
    deriveHistoryLoopState(history);
    const run = [...(history.loopEvents || [])]
      .reverse()
      .find(
        (event) =>
          event.kind === "run_request" && event.requestId === requestId,
      );
    if (!run) return;
    const kind: HistoryLoopEventKind = status === "completed"
      ? "turn_completed"
      : status;
    appendLoopEvent(history, {
      requestId,
      turnSequence: run.turnSequence,
      kind,
    });
    history.updatedAt = Date.now();
    memory.set(historyKey, history);
    await persist(history);
    applied = true;
  });
  return applied;
}

export async function appendHistoryMessage(
  requestId: string,
  message: ChatMessage,
  modelHint?: string,
  metadata?: HistoryMessageMetadata,
): Promise<void> {
  await queueHistoryMutation(requestId, async () => {
    const h = await loadHistory(requestId);
    deriveHistoryLoopState(h);
    if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
      console.error(`[history ${process.pid}] append base=${h.messages.length} ${message.content}`);
    }
    // 简单去重：连续完全相同 JSON 不重复
    const last = h.messages[h.messages.length - 1];
    let normalizedMetadata = normalizeMetadata(metadata);
    if (
      normalizedMetadata.cursorMessageId &&
      last?.cursorMessageId === normalizedMetadata.cursorMessageId
    ) {
      return;
    }
    if (
      !normalizedMetadata.cursorMessageId &&
      last &&
      JSON.stringify(stripHistoryMetadata(last)) === JSON.stringify(message)
    ) {
      return;
    }

    const isTurnStart =
      message.role === "user" &&
      !String(normalizedMetadata.promptContextSource || "").trim();
    let sourceRequestId = String(
      normalizedMetadata.sourceRequestId || h.currentRequestId || "",
    ).trim();
    let turnSequence = positiveInteger(normalizedMetadata.turnSequence);
    if (isTurnStart && !sourceRequestId) sourceRequestId = requestId;
    if (
      sourceRequestId &&
      h.currentRequestId === sourceRequestId &&
      positiveInteger(h.currentTurnSequence)
    ) {
      turnSequence ||= positiveInteger(h.currentTurnSequence);
    }
    if (isTurnStart && sourceRequestId && !turnSequence) {
      turnSequence = positiveInteger(h.nextTurnSequence) || 1;
    }
    if (isTurnStart && sourceRequestId && turnSequence) {
      const hasRun = (h.loopEvents || []).some(
        (event) =>
          event.kind === "run_request" &&
          event.requestId === sourceRequestId &&
          event.turnSequence === turnSequence,
      );
      if (!hasRun) {
        h.currentRequestId = sourceRequestId;
        h.currentTurnSequence = turnSequence;
        h.currentLoopId = `${turnSequence}:${sourceRequestId}`;
        h.currentLoopStatus = "running";
        appendLoopEvent(h, {
          requestId: sourceRequestId,
          turnSequence,
          kind: "run_request",
        });
      }
    }
    if (sourceRequestId && turnSequence) {
      normalizedMetadata = {
        ...normalizedMetadata,
        sourceRequestId,
        turnSequence,
      };
    }

    const next: HistoryMessage = {
      ...message,
      ...normalizedMetadata,
      at: Date.now(),
    };
    if (isUserTurnStart(next)) {
      const nextTurn = Math.max(1, Math.floor(Number(h.nextTurnSequence) || 1));
      const requestedTurn = positiveInteger(normalizedMetadata.turnSequence);
      const assignedTurn = requestedTurn
        ? requestedTurn
        : nextTurn;
      next.turnSequence = assignedTurn;
      h.nextTurnSequence = Math.max(nextTurn, assignedTurn + 1);
    }

    h.messages.push(next);
    const eventRequestId = String(
      next.sourceRequestId || h.currentRequestId || "",
    ).trim();
    const eventTurnSequence = positiveInteger(
      next.turnSequence || h.currentTurnSequence,
    );
    if (eventRequestId && eventTurnSequence && next.role === "assistant") {
      for (const toolCall of next.tool_calls || []) {
        const toolCallId = String(toolCall.id || "").trim();
        if (!toolCallId) continue;
        appendLoopEvent(h, {
          requestId: eventRequestId,
          turnSequence: eventTurnSequence,
          kind: "tool_call",
          toolCallId,
        });
      }
    } else if (eventRequestId && eventTurnSequence && next.role === "tool") {
      const toolCallId = String(next.tool_call_id || "").trim();
      if (toolCallId) {
        appendLoopEvent(h, {
          requestId: eventRequestId,
          turnSequence: eventTurnSequence,
          kind: "tool_result",
          toolCallId,
        });
      }
    }
    if (modelHint) h.modelHint = modelHint;
    h.updatedAt = Date.now();
    memory.set(requestId, h);
    await persist(h);
    if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
      console.error(`[history ${process.pid}] append saved=${h.messages.length} ${message.content}`);
    }
  });
}

/**
 * Persist runtime prompt contexts inside the active turn. Context messages are
 * provider-visible replay, but never create Cursor conversation turns.
 */
export async function appendHistoryPromptContexts(
  requestId: string,
  sourceRequestId: string,
  contexts: readonly HistoryPromptContext[],
): Promise<number> {
  if (!contexts.length) return 0;
  const requestSource = String(sourceRequestId || "").trim();
  let appended = 0;
  await queueHistoryMutation(requestId, async () => {
    const history = await loadHistory(requestId);
    let currentTurn: HistoryMessage | undefined;
    for (let index = history.messages.length - 1; index >= 0; index -= 1) {
      const candidate = history.messages[index];
      if (!isUserTurnStart(candidate)) continue;
      currentTurn ||= candidate;
      if (
        requestSource &&
        String(candidate.sourceRequestId || "").trim() === requestSource
      ) {
        currentTurn = candidate;
        break;
      }
    }
    const turnSequence = Math.floor(Number(currentTurn?.turnSequence) || 0);
    if (turnSequence <= 0) return;

    const seen = new Set(
      history.messages
        .filter(
          (message) =>
            Math.floor(Number(message.turnSequence) || 0) === turnSequence &&
            isPromptContextHistoryMessage(message),
        )
        .map(promptContextKey)
        .filter(Boolean),
    );
    for (const context of contexts) {
      const source = String(context.source || "").trim();
      const role = context.message.role;
      const content = String(context.message.content || "").trim();
      if (!source || !content || (role !== "user" && role !== "system")) continue;
      const hash = promptContextContentHash({ role, content });
      const key = `${source}\0${hash}`;
      if (seen.has(key)) continue;
      history.messages.push({
        role,
        content,
        sourceRequestId: requestSource || currentTurn?.sourceRequestId,
        turnSequence,
        promptContextSource: source,
        promptContextHash: hash,
        at: Date.now(),
      });
      seen.add(key);
      appended += 1;
    }
    if (!appended) return;
    history.updatedAt = Date.now();
    memory.set(requestId, history);
    await persist(history);
  });
  return appended;
}

export async function historyRoute(
  requestId: string,
): Promise<ConversationRoute> {
  const h = await loadHistory(requestId);
  return {
    modelHint: h.modelHint,
    providerId: h.providerId,
    modelID: h.modelID,
    contextWindowTokens: normalizeContextWindowTokens(h.contextWindowTokens),
  };
}

export async function updateHistoryRoute(
  requestId: string,
  route: ConversationRoute,
): Promise<void> {
  await queueHistoryMutation(requestId, async () => {
    const h = await loadHistory(requestId);
    applyConversationRoute(h, route);
    h.updatedAt = Date.now();
    memory.set(requestId, h);
    await persist(h);
  });
}

/**
 * Apply the canceled-turn replay policy before the next checkpoint is
 * projected. The JSON transcript keeps a compact lifecycle record, while the
 * provider-visible message list retains only stable input from an interrupted
 * turn.
 */
export async function pruneCanceledHistoryTurn(
  requestId: string,
  sourceRequestId: string,
  reason: string,
): Promise<CanceledHistoryTurnResult> {
  const source = String(sourceRequestId || "").trim();
  if (!source) return { applied: false, removedMessages: 0 };

  let result: CanceledHistoryTurnResult = {
    applied: false,
    removedMessages: 0,
  };
  await queueHistoryMutation(requestId, async () => {
    const history = await loadHistory(requestId);
    let start = -1;
    for (let index = history.messages.length - 1; index >= 0; index -= 1) {
      const message = history.messages[index];
      if (
        isUserTurnStart(message) &&
        String(message.sourceRequestId || "").trim() === source
      ) {
        start = index;
        break;
      }
    }
    if (start < 0) return;

    let end = start + 1;
    while (end < history.messages.length && !isUserTurnStart(history.messages[end])) {
      end += 1;
    }
    const activity = history.messages
      .slice(start + 1, end)
      .some((message) => message.role === "assistant" || message.role === "tool");
    const superseded = /superseded[_ ]by[_ ]newer[_ ]request/i.test(reason);
    const replayPolicy: CanceledHistoryTurn["replayPolicy"] =
      superseded && !activity ? "drop_unstarted_turn" : "keep_stable_input";
    const canceledUser = history.messages[start];
    const rawTurnSequence = Number(canceledUser?.turnSequence);
    const turnSequence =
      Number.isFinite(rawTurnSequence) && rawTurnSequence > 0
        ? Math.floor(rawTurnSequence)
        : undefined;
    let removedMessages = 0;
    if (replayPolicy === "drop_unstarted_turn") {
      removedMessages = Math.max(0, end - start);
      if (removedMessages > 0) history.messages.splice(start, removedMessages);
    } else {
      const unstable = history.messages.slice(start + 1, end);
      const stablePromptContexts = unstable.filter(isPromptContextHistoryMessage);
      removedMessages = unstable.length - stablePromptContexts.length;
      if (unstable.length > 0) {
        history.messages.splice(start + 1, unstable.length, ...stablePromptContexts);
      }
    }

    const record: CanceledHistoryTurn = {
      sourceRequestId: source,
      reason: String(reason || "client_cancel").trim() || "client_cancel",
      replayPolicy,
      ...(turnSequence && turnSequence > 0 ? { turnSequence } : {}),
      at: Date.now(),
    };
    history.canceledTurns = [
      ...(history.canceledTurns || []).filter(
        (item) => item.sourceRequestId !== source,
      ),
      record,
    ].slice(-64);
    history.nextTurnSequence = nextTurnSequence(history.messages);
    history.updatedAt = Date.now();
    memory.set(requestId, history);
    await persist(history);
    result = { applied: true, replayPolicy, removedMessages };
  });
  return result;
}

/**
 * Atomically replace a conversation's proxy-side context after a successful
 * compaction. The original history is left untouched when summary generation
 * fails, which makes upstream failures retryable from Cursor.
 */
export async function replaceHistoryMessages(
  requestId: string,
  messages: ChatMessage[],
  route?: ConversationRoute,
  options?: HistoryReplacementOptions,
): Promise<void> {
  throwIfHistoryReplacementAborted(options?.signal);
  await queueHistoryMutation(requestId, async () => {
    const h = await loadHistory(requestId);
    // The mutation may have waited behind another writer. Re-check immediately
    // before changing the in-memory snapshot so a cancelled compaction cannot
    // commit merely because it was already queued.
    throwIfHistoryReplacementAborted(options?.signal);
    const previousVisibleSummary = retainedSummaryText(h.messages);
    replaceMessagesInHistory(h, messages, route);
    commitCompactionSummary(
      h,
      options?.compactionSummary || "",
      previousVisibleSummary,
    );
    memory.set(requestId, h);
    await persist(h);
  });
}

function throwIfHistoryReplacementAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : String(reason || "history replacement cancelled"),
  );
  error.name = "AbortError";
  throw error;
}

export type CursorStateReconciliationResult = {
  applied: boolean;
  previousMessages: number;
  currentMessages: number;
};

type ReconciliationTurn = {
  user: HistoryMessage;
  messages: HistoryMessage[];
};

function splitReconciliationTurns(messages: HistoryMessage[]): {
  prefix: HistoryMessage[];
  turns: ReconciliationTurn[];
} {
  const firstUser = messages.findIndex(isUserTurnStart);
  if (firstUser < 0) return { prefix: [...messages], turns: [] };
  const prefix = messages.slice(0, firstUser);
  const turns: ReconciliationTurn[] = [];
  for (let index = firstUser; index < messages.length; index += 1) {
    const user = messages[index];
    if (!isUserTurnStart(user)) continue;
    let end = index + 1;
    while (end < messages.length && !isUserTurnStart(messages[end])) end += 1;
    turns.push({ user, messages: messages.slice(index + 1, end) });
    index = end - 1;
  }
  return { prefix, turns };
}

function reconciliationTurnMatches(left: ReconciliationTurn, right: ReconciliationTurn): boolean {
  const leftId = String(left.user.cursorMessageId || "").trim();
  const rightId = String(right.user.cursorMessageId || "").trim();
  if (leftId && rightId) return leftId === rightId;
  const leftTurn = Math.floor(Number(left.user.turnSequence) || 0);
  const rightTurn = Math.floor(Number(right.user.turnSequence) || 0);
  return leftTurn > 0 && leftTurn === rightTurn &&
    String(left.user.content || "").trim() === String(right.user.content || "").trim();
}

function reconciliationMessageKey(message: HistoryMessage): string {
  if (message.role === "tool") {
    const id = String(message.tool_call_id || "").trim();
    return id ? `tool-result:${id}` : historyMessageKey(message);
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    const ids = message.tool_calls.map((call) => String(call.id || "").trim()).filter(Boolean);
    if (ids.length) return `tool-calls:${ids.join("|")}`;
  }
  return historyMessageKey(message);
}

function mergeReconciliationTurn(
  local: ReconciliationTurn,
  inbound: ReconciliationTurn,
): ReconciliationTurn {
  const inboundMetadata = normalizeMetadata(inbound.user);
  const localMetadata = normalizeMetadata(local.user);
  const user: HistoryMessage = {
    ...inbound.user,
    ...local.user,
    ...inboundMetadata,
    ...localMetadata,
    cursorMessageId: inboundMetadata.cursorMessageId || localMetadata.cursorMessageId,
    turnSequence: inboundMetadata.turnSequence || localMetadata.turnSequence,
    sourceRequestId: localMetadata.sourceRequestId || inboundMetadata.sourceRequestId,
    at: local.user.at || inbound.user.at || Date.now(),
  };

  const merged = inbound.messages.map((message) => ({ ...message }));
  for (const localMessage of local.messages) {
    const key = reconciliationMessageKey(localMessage);
    const existing = merged.findIndex(
      (message) => reconciliationMessageKey(message) === key,
    );
    if (existing < 0) {
      merged.push({ ...localMessage });
      continue;
    }
    merged[existing] = {
      ...merged[existing],
      ...localMessage,
      ...normalizeMetadata(merged[existing]),
      ...normalizeMetadata(localMessage),
      at: localMessage.at || merged[existing].at || Date.now(),
    };
  }
  return { user, messages: merged };
}

function mergeCursorProjection(
  current: HistoryMessage[],
  projection: HistoryMessage[],
): HistoryMessage[] {
  const inbound = splitReconciliationTurns(projection);
  // A summary-only or unsupported partial state carries no branch lineage. It
  // must never replace or prepend content to a known-good transcript.
  if (!inbound.turns.length) return [...current];

  const local = splitReconciliationTurns(current);
  const prefix = [...local.prefix];
  for (let index = inbound.prefix.length - 1; index >= 0; index -= 1) {
    const message = inbound.prefix[index];
    if (prefix.some((item) => historyMessageKey(item) === historyMessageKey(message))) continue;
    prefix.unshift({ ...message });
  }

  const turns = local.turns.map((turn) => ({
    user: { ...turn.user },
    messages: turn.messages.map((message) => ({ ...message })),
  }));
  for (const inboundTurn of inbound.turns) {
    const existing = turns.findIndex((turn) => reconciliationTurnMatches(turn, inboundTurn));
    if (existing >= 0) {
      turns[existing] = mergeReconciliationTurn(turns[existing], inboundTurn);
      continue;
    }

    const inboundSequence = Math.floor(Number(inboundTurn.user.turnSequence) || 0);
    const insertion = inboundSequence > 0
      ? turns.findIndex(
        (turn) => Math.floor(Number(turn.user.turnSequence) || 0) > inboundSequence,
      )
      : -1;
    const copied = {
      user: { ...inboundTurn.user },
      messages: inboundTurn.messages.map((message) => ({ ...message })),
    };
    if (insertion >= 0) turns.splice(insertion, 0, copied);
    else turns.push(copied);
  }

  turns.sort((left, right) => {
    const leftSequence = Math.floor(Number(left.user.turnSequence) || 0);
    const rightSequence = Math.floor(Number(right.user.turnSequence) || 0);
    if (!leftSequence || !rightSequence || leftSequence === rightSequence) return 0;
    return leftSequence - rightSequence;
  });

  return [
    ...prefix,
    ...turns.flatMap((turn) => [turn.user, ...turn.messages]),
  ];
}

function historySnapshotKey(messages: HistoryMessage[]): string {
  return JSON.stringify(messages.map((message) => {
    const { at: _at, ...rest } = message;
    void _at;
    return rest;
  }));
}

/**
 * Merge Cursor's visible state into the canonical proxy history by user
 * message_id and turn lineage. This imports missing inbound turns without
 * dropping locally committed output when Cursor sends a partial checkpoint.
 */
export async function reconcileHistoryFromCursorState(
  requestId: string,
  messages: ChatMessage[],
  route?: ConversationRoute,
  compactionState?: HistoryCompactionState,
): Promise<CursorStateReconciliationResult> {
  let result: CursorStateReconciliationResult = {
    applied: false,
    previousMessages: 0,
    currentMessages: messages.length,
  };
  await queueHistoryMutation(requestId, async () => {
    const h = await loadHistory(requestId);
    result.previousMessages = h.messages.length;
    const projection = messages.map((message) => ({
      ...message,
      ...normalizeMetadata(message as HistoryMessageMetadata),
      at: Number((message as HistoryMessage).at) || Date.now(),
    })) as HistoryMessage[];
    const merged = mergeCursorProjection(h.messages, projection);
    const messagesChanged =
      historySnapshotKey(merged) !== historySnapshotKey(h.messages);
    const compactionChanged = mergeCompactionState(h, compactionState);
    if (!messagesChanged && !compactionChanged) {
      result.currentMessages = h.messages.length;
      return;
    }
    if (messagesChanged) replaceMessagesInHistory(h, merged, route);
    else {
      applyConversationRoute(h, route);
      h.updatedAt = Date.now();
    }
    memory.set(requestId, h);
    await persist(h);
    result = {
      applied: true,
      previousMessages: result.previousMessages,
      currentMessages: h.messages.length,
    };
  });
  return result;
}

function replaceMessagesInHistory(
  h: HistoryFile,
  messages: ChatMessage[],
  route?: ConversationRoute,
): void {
  const metadataByMessage = new Map<string, HistoryMessageMetadata[]>();
  for (const previous of h.messages) {
    const key = historyMessageKey(previous);
    const list = metadataByMessage.get(key) || [];
    list.push({
      cursorMessageId: previous.cursorMessageId,
      turnSequence: previous.turnSequence,
      sourceRequestId: previous.sourceRequestId,
      promptContextSource: previous.promptContextSource,
      promptContextHash: previous.promptContextHash,
    });
    metadataByMessage.set(key, list);
  }
  h.messages = messages.map((message) => {
    const retained = metadataByMessage.get(historyMessageKey(message))?.shift();
    // Cursor's current ConversationState is authoritative when it carries
    // lineage fields. Preserve a matching local entry only as a fallback
    // for older state payloads that omit message IDs or turn numbers.
    const suppliedMetadata = normalizeMetadata(
      message as HistoryMessageMetadata,
    );
    return {
      ...message,
      ...normalizeMetadata(retained),
      ...suppliedMetadata,
      at: Date.now(),
    };
  });
  h.nextTurnSequence = nextTurnSequence(h.messages);
  applyConversationRoute(h, route);
  deriveHistoryLoopState(h);
  h.updatedAt = Date.now();
}

function historyMatchesProjection(
  current: HistoryMessage[],
  projection: ChatMessage[],
): boolean {
  if (current.length !== projection.length) return false;
  return current.every((message, index) => {
    const projected = projection[index];
    if (!projected) return false;
    if (historyMessageKey(message) !== historyMessageKey(projected)) return false;
    const metadata = normalizeMetadata(projected as HistoryMessageMetadata);
    if (
      metadata.cursorMessageId &&
      metadata.cursorMessageId !== message.cursorMessageId
    ) {
      return false;
    }
    if (
      metadata.turnSequence != null &&
      metadata.turnSequence !== message.turnSequence
    ) {
      return false;
    }
    return true;
  });
}

/** 兼容旧接口：纯文本 user/assistant */
export async function appendHistory(
  requestId: string,
  role: "user" | "assistant" | "system",
  content: string,
  modelHint?: string,
  contentParts?: ChatContentPart[],
  metadata?: HistoryMessageMetadata,
): Promise<void> {
  const t = content.trim();
  const parts = contentParts?.length ? contentParts : undefined;
  if (!t && !parts?.length && role !== "assistant") return;
  if (role === "assistant") {
    await appendHistoryMessage(requestId, { role, content: t }, modelHint, metadata);
    return;
  }
  await appendHistoryMessage(
    requestId,
    { role, content: t, ...(parts ? { contentParts: parts } : {}) },
    modelHint,
    metadata,
  );
}

export async function appendAssistantWithTools(
  requestId: string,
  text: string,
  toolCalls?: ToolCall[],
  modelHint?: string,
  metadata?: HistoryMessageMetadata,
  reasoningMetadata?: AssistantReasoningMetadata,
): Promise<void> {
  await appendHistoryMessage(
    requestId,
    {
      ...reasoningMetadata,
      role: "assistant",
      content: text || "",
      tool_calls: toolCalls,
    },
    modelHint,
    metadata,
  );
}

export async function appendToolResult(
  requestId: string,
  toolCallId: string,
  name: string,
  content: string,
  metadata?: HistoryMessageMetadata,
): Promise<void> {
  await appendHistoryMessage(requestId, {
    role: "tool",
    tool_call_id: toolCallId,
    name,
    content,
  }, undefined, metadata);
}

function normalizeMetadata(
  metadata?: HistoryMessageMetadata,
): HistoryMessageMetadata {
  const cursorMessageId = String(metadata?.cursorMessageId || "").trim();
  const sourceRequestId = String(metadata?.sourceRequestId || "").trim();
  const promptContextSource = String(metadata?.promptContextSource || "").trim();
  const promptContextHash = String(metadata?.promptContextHash || "").trim();
  const rawTurn = Number(metadata?.turnSequence);
  return {
    ...(cursorMessageId ? { cursorMessageId } : {}),
    ...(sourceRequestId ? { sourceRequestId } : {}),
    ...(promptContextSource ? { promptContextSource } : {}),
    ...(promptContextHash ? { promptContextHash } : {}),
    ...(Number.isFinite(rawTurn) && rawTurn > 0
      ? { turnSequence: Math.floor(rawTurn) }
      : {}),
  };
}

function stripHistoryMetadata(m: HistoryMessage): ChatMessage {
  const {
    at: _at,
    cursorMessageId: _cursorMessageId,
    turnSequence: _turnSequence,
    sourceRequestId: _sourceRequestId,
    promptContextSource: _promptContextSource,
    promptContextHash: _promptContextHash,
    ...rest
  } = m;
  void _at;
  void _cursorMessageId;
  void _turnSequence;
  void _sourceRequestId;
  void _promptContextSource;
  void _promptContextHash;
  return rest as ChatMessage;
}

function historyMessageKey(message: ChatMessage | HistoryMessage): string {
  return JSON.stringify(stripHistoryMetadata(message as HistoryMessage));
}

function nextTurnSequence(messages: HistoryMessage[]): number {
  const latest = messages.reduce(
    (max, message) => isUserTurnStart(message)
      ? Math.max(max, Math.floor(Number(message.turnSequence) || 0))
      : max,
    0,
  );
  return Math.max(1, latest + 1);
}

async function persist(h: HistoryFile): Promise<void> {
  deriveHistoryLoopState(h);
  await fs.mkdir(historyDir(), { recursive: true });
  const target = filePath(h.requestId);
  const backup = backupPath(h.requestId);
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;

  // Keep one known-good generation. Do not replace it with a malformed primary
  // file: that is the only recoverable copy after an interrupted external write.
  if (await readPersistedHistory(target, h.requestId)) {
    await fs.copyFile(target, backup);
  }

  let handle: fs.FileHandle | undefined;
  let committed = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(h, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceHistoryFile(temporary, target);
    committed = true;
    await syncHistoryDirectory();
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }

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

async function replaceHistoryFile(temporary: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !/^(EPERM|EACCES|EBUSY)$/.test(code) || attempt === 4) break;
      await sleep(HISTORY_LOCK_RETRY_MS * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function syncHistoryDirectory(): Promise<void> {
  // Directory fsync is available on POSIX. Windows rejects opening a directory;
  // the file has already been flushed, so that platform-specific error is safe
  // to ignore.
  let directory: fs.FileHandle | undefined;
  try {
    directory = await fs.open(historyDir(), "r");
    await directory.sync();
  } catch {
    /* best-effort durability on platforms without directory handles */
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

export async function historyAsChatMessages(
  requestId: string,
): Promise<ChatMessage[]> {
  const h = await loadHistory(requestId);
  return normalizeProviderReplay(
    h.messages.map((message) => stripHistoryMetadata(message)),
  );
}

/** Provider replay with turn/prompt-context metadata retained for compaction. */
export async function historyAsPromptReplayMessages(
  requestId: string,
): Promise<HistoryMessage[]> {
  const history = await loadHistory(requestId);
  return normalizeProviderReplay(history.messages) as HistoryMessage[];
}

/** Immutable snapshot used when projecting Cursor's persisted checkpoint. */
export async function historyMessagesSnapshot(
  requestId: string,
): Promise<HistoryMessage[]> {
  const h = await loadHistory(requestId);
  return structuredClone(h.messages);
}

/** Atomic transcript and summary-generation snapshot for checkpoint projection. */
export async function historyCheckpointSnapshot(
  requestId: string,
): Promise<{
  messages: HistoryMessage[];
  compaction: HistoryCompactionState;
  canceledTurns: CanceledHistoryTurn[];
}> {
  const h = await loadHistory(requestId);
  return {
    messages: structuredClone(h.messages),
    compaction: structuredClone(historyCompactionState(h)),
    canceledTurns: structuredClone(h.canceledTurns || []),
  };
}

export type HistoryRewindResult = {
  applied: boolean;
  targetIndex?: number;
  targetTurnSequence?: number;
  droppedMessages: number;
};

/**
 * Drop the selected user turn and every later entry before Cursor resubmits
 * that message. This keeps the provider-side prompt aligned with Cursor's
 * visible conversation branch.
 */
export async function rewindHistoryToUserMessage(
  requestId: string,
  cursorMessageId: string,
  clientTurnCount?: number,
): Promise<HistoryRewindResult> {
  const messageId = String(cursorMessageId || "").trim();
  if (!messageId) return { applied: false, droppedMessages: 0 };

  let result: HistoryRewindResult = { applied: false, droppedMessages: 0 };
  await queueHistoryMutation(requestId, async () => {
    const h = await loadHistory(requestId);
    const candidates = h.messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          isUserTurnStart(message) && message.cursorMessageId === messageId,
      );
    if (!candidates.length) return;

    const rawClientTurnCount = Number(clientTurnCount);
    const expectedTurn = Number.isFinite(rawClientTurnCount) && rawClientTurnCount >= 0
      ? Math.floor(rawClientTurnCount) + 1
      : undefined;
    // Cursor provides the count of turns that existed before the incoming
    // replacement. When present, require the exact turn to match as well as
    // the message ID. A stale client state must never trim an unrelated
    // branch that happens to reuse a message ID.
    const selected = expectedTurn != null
      ? candidates.find(({ message }) => message.turnSequence === expectedTurn)
      : candidates[0];
    if (!selected) return;
    const droppedMessages = h.messages.length - selected.index;
    // The selected user message is already the active tail. Replaying it is
    // a transport duplicate, not a branch retry, so retain the current
    // history and let the normal duplicate handling take care of it.
    if (droppedMessages <= 1) return;

    h.messages = h.messages.slice(0, selected.index);
    const targetTurnSequence = positiveInteger(selected.message.turnSequence);
    if (targetTurnSequence) {
      h.loopEvents = (h.loopEvents || []).filter(
        (event) => event.turnSequence < targetTurnSequence,
      );
      h.canceledTurns = (h.canceledTurns || []).filter(
        (turn) =>
          !positiveInteger(turn.turnSequence) ||
          Number(turn.turnSequence) < targetTurnSequence,
      );
      delete h.currentLoopId;
      delete h.currentRequestId;
      delete h.currentTurnSequence;
      h.currentLoopStatus = "idle";
    }
    h.nextTurnSequence = nextTurnSequence(h.messages);
    deriveHistoryLoopState(h);
    h.updatedAt = Date.now();
    memory.set(requestId, h);
    await persist(h);
    result = {
      applied: true,
      targetIndex: selected.index,
      targetTurnSequence: selected.message.turnSequence,
      droppedMessages,
    };
  });
  return result;
}

/**
 * Serialize mutations locally and across forwarding processes. A global file
 * lock is intentional: clear-all history is a store-wide operation, and this
 * keeps it from racing an append in a separate Cursor window.
 */
function queueHistoryMutation(
  requestId: string,
  mutation: () => Promise<void>,
): Promise<void> {
  const key = String(requestId || "").trim();
  const previous = mutationQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const release = await acquireHistoryWriteLock();
    try {
      // Discard a potentially stale process-local copy before the mutation
      // loads its base snapshot under the cross-process lock.
      memory.delete(key);
      await mutation();
    } finally {
      await release();
    }
  });
  const tracked = next.catch(() => undefined);
  mutationQueues.set(key, tracked);
  void tracked.finally(() => {
    if (mutationQueues.get(key) === tracked) mutationQueues.delete(key);
  });
  return next;
}

async function acquireHistoryWriteLock(): Promise<() => Promise<void>> {
  await fs.mkdir(historyDir(), { recursive: true });
  const target = historyWriteLockPath();
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + HISTORY_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      // mkdir is an atomic cross-process primitive on Windows and POSIX. A
      // lock file opened with O_EXCL can still be observed as absent during
      // replacement by a competing Windows process.
      await fs.mkdir(target, { mode: 0o700 });
      const ownerFile = path.join(target, "owner.json");
      const handle = await fs.open(ownerFile, "wx", 0o600);
      try {
        await handle.writeFile(
        `${JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() })}\n`,
        "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
        console.error(`[history ${process.pid}] lock acquired ${owner}`);
      }
      return async () => {
        const released = `${target}.${owner}.released`;
        try {
          const raw = await fs.readFile(path.join(target, "owner.json"), "utf8");
          const current = JSON.parse(raw) as { owner?: unknown };
          if (current.owner !== owner) return;
          // Rename is atomic. Once this succeeds, another process may create a
          // fresh lock at `target`, while this writer only removes its renamed
          // ownership record. A read-then-unlink sequence can delete that new
          // lock and allows concurrent history writes.
          await fs.rename(target, released);
          await fs.rm(released, { recursive: true, force: true });
          if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
            console.error(`[history ${process.pid}] lock released ${owner}`);
          }
        } catch {
          // A stale-lock recovery may already have replaced this file. Never
          // remove a lock whose owner token does not match this writer.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw error;

      if (await historyLockIsStale(target)) {
        if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
          console.error(`[history ${process.pid}] reclaiming stale lock`);
        }
        await quarantineHistoryLock(target);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the history write lock");
      }
      await sleep(HISTORY_LOCK_RETRY_MS);
    }
  }
}

/**
 * Move an expired lease away before deleting it. This keeps a releaser from
 * ever deleting a replacement lock that another process created meanwhile.
 */
async function quarantineHistoryLock(target: string): Promise<void> {
  const staleTarget = `${target}.stale.${process.pid}.${Date.now()}.${randomUUID()}`;
  try {
    await fs.rename(target, staleTarget);
  } catch (error) {
    // A normal releaser can rename the directory between our stat and move.
    // Treat that as a retry, never as permission to remove the new pathname.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  await fs.rm(staleTarget, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: HISTORY_LOCK_RETRY_MS,
  }).catch(() => undefined);
}

async function historyLockIsStale(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    const age = Date.now() - stat.mtimeMs;
    if (process.env.CURSOR_STUDIO_HISTORY_LOCK_DEBUG === "1") {
      console.error(`[history ${process.pid}] lock age=${age}ms`);
    }
    return age > HISTORY_LOCK_STALE_MS;
  } catch (error) {
    // The owner may have just renamed its directory during release. The next
    // loop iteration can acquire a new lease; treating ENOENT as stale and
    // removing the pathname races that new owner.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  await Promise.allSettled([...mutationQueues.values()]);
  const release = await acquireHistoryWriteLock();
  try {
    mutationQueues.clear();
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
      if (!entry.isFile() || !/\.json(?:\.bak)?$|\.tmp$/i.test(entry.name)) continue;
      const target = path.join(dir, entry.name);
      try {
        await fs.rm(target, { force: true });
        if (/\.json$/i.test(entry.name)) removed += 1;
      } catch (error) {
        failed.push({
          file: target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { removed, failed };
  } finally {
    await release();
  }
}
