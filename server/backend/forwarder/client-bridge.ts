/**
 * 本地协议实现。
 *
 * 两条路径：
 * 1) Exec 桥：ExecServerMessage 下发 → BidiAppend exec_result / exec_client_message
 * 2) Interaction 桥：InteractionQuery 下发 → BidiAppend interaction_response
 *
 * pending 完成后继续工具循环。
 */
import {
  buildExecServerMessageJson,
  buildInteractionQueryJson,
  encodeAgentServerInteractionQuery,
  encodeAgentServerExec,
} from "./agent-proto";
import {
  EXECUTABLE_TOOLS,
  isInteractionTool,
  isClientBridgeTool,
} from "./tool-catalog";

export type PendingExec = {
  execId: string;
  messageId: number;
  toolCallId: string;
  name: string;
  argsJson: string;
  createdAt: number;
  modelCallId?: string;
  providerPass?: number;
  kind: "exec";
};

export type PendingInteraction = {
  interactionId: string;
  messageId: number;
  toolCallId: string;
  name: string;
  argsJson: string;
  createdAt: number;
  modelCallId?: string;
  providerPass?: number;
  kind: "interaction";
  /** ask_question | create_plan | switch_mode | web_search */
  interactionKind: string;
  /** CreatePlan ends at user confirmation; the other interactions resume. */
  autoResume: boolean;
};

export type ClientExecResult = {
  execId?: string;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
  messageId?: number;
};

export type ClientShellStreamChunk = {
  execId?: string;
  messageId?: number;
  event?:
    | "stdout"
    | "stderr"
    | "exit"
    | "start"
    | "rejected"
    | "permission_denied"
    | "backgrounded";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cwd?: string;
  aborted?: boolean;
  shellId?: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  error?: string;
};

export type ClientBackgroundShellResult = {
  kind: "spawn" | "force";
  status: "backgrounded" | "rejected" | "permission_denied" | "error" | "unknown";
  shellId?: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  error?: string;
};

export type ClientInteractionResult = {
  interactionId?: string;
  messageId?: number;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
  /** Decoded protobuf result; retained so service logic never reparses text. */
  structured?: Record<string, unknown>;
};

export type BridgeWaitOptions = {
  /** Zero keeps a Cursor-owned interaction pending until response or cancel. */
  timeoutMs?: number;
  /** Cancels the local waiter as soon as its Cursor request is cancelled. */
  signal?: AbortSignal;
};

export type PendingBridgeCancellation = {
  execs: PendingExec[];
  interactions: PendingInteraction[];
};

type ExecWaiter = {
  pending: PendingExec;
  resolve: (r: ClientExecResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  transportCloseTimer?: ReturnType<typeof setTimeout>;
  lastHeartbeatAt?: number;
  settled: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
  shellStream?: {
    stdout: string;
    stderr: string;
    exitCode?: number;
    cwd?: string;
    aborted: boolean;
    event?: ClientShellStreamChunk["event"];
    shellId?: string;
    command?: string;
    workingDirectory?: string;
    pid?: number;
    error?: string;
  };
};

type InteractionWaiter = {
  pending: PendingInteraction;
  resolve: (r: ClientInteractionResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
};

const execWaiters = new Map<string, Map<string, ExecWaiter>>();
const interactionWaiters = new Map<string, Map<string, InteractionWaiter>>();
const recentCompletedExecs = new Map<string, Map<number, number>>();
type BackgroundShellState = {
  shellId: string;
  execId?: string;
  messageId?: number;
  toolCallId?: string;
  status: "running" | ClientBackgroundShellResult["status"] | "exited";
  stdout: string;
  stderr: string;
  exitCode?: number;
  cwd?: string;
  aborted: boolean;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  error?: string;
  updatedAt: number;
};
type BackgroundShellRequestState = {
  byShellId: Map<string, BackgroundShellState>;
  byMessageId: Map<number, string>;
  byExecId: Map<string, string>;
};
const backgroundShells = new Map<string, BackgroundShellRequestState>();
const COMPLETED_EXEC_RETENTION_MS = 15_000;
const EXEC_TRANSPORT_CLOSE_GRACE_MS = 1_500;
let execSeq = 0;
let messageSeq = 0;

function pruneCompletedExecs(requestId: string, now = Date.now()): Map<number, number> {
  const completed = recentCompletedExecs.get(requestId) || new Map<number, number>();
  for (const [messageId, completedAt] of completed) {
    if (now - completedAt >= COMPLETED_EXEC_RETENTION_MS) {
      completed.delete(messageId);
    }
  }
  if (completed.size === 0) recentCompletedExecs.delete(requestId);
  return completed;
}

function markExecCompleted(requestId: string, messageId: number): void {
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  const completed = pruneCompletedExecs(requestId);
  completed.set(Math.trunc(messageId), Date.now());
  recentCompletedExecs.set(requestId, completed);
}

export function recentlyCompletedClientExec(
  requestId: string,
  messageId: number | undefined,
): boolean {
  if (messageId == null || !Number.isFinite(messageId) || messageId <= 0) return false;
  return pruneCompletedExecs(requestId).has(Math.trunc(messageId));
}

function execMap(requestId: string): Map<string, ExecWaiter> {
  let m = execWaiters.get(requestId);
  if (!m) {
    m = new Map();
    execWaiters.set(requestId, m);
  }
  return m;
}

function interactionMap(requestId: string): Map<string, InteractionWaiter> {
  let m = interactionWaiters.get(requestId);
  if (!m) {
    m = new Map();
    interactionWaiters.set(requestId, m);
  }
  return m;
}

export function nextMessageId(): number {
  messageSeq = (messageSeq + 1) >>> 0;
  if (messageSeq === 0) messageSeq = 1;
  return messageSeq;
}

export function newExecId(toolCallId: string): string {
  execSeq += 1;
  return `exec-${execSeq}-${toolCallId.slice(0, 12)}`;
}

export function newInteractionId(messageId: number): string {
  return String(messageId);
}

/** 是否优先走客户端桥（不可本地执行，或显式 force） */
export function shouldUseClientBridge(toolName: string): boolean {
  const force = process.env.CURSOR_STUDIO_CLIENT_BRIDGE === "1";
  if (force) return true;
  if (isClientBridgeTool(toolName)) return true;
  return !EXECUTABLE_TOOLS.has(toolName);
}

export function bridgeKindForTool(
  toolName: string,
): "interaction" | "exec" | "local" {
  if (isInteractionTool(toolName)) return "interaction";
  if (shouldUseClientBridge(toolName) && !EXECUTABLE_TOOLS.has(toolName)) {
    return "exec";
  }
  if (process.env.CURSOR_STUDIO_CLIENT_BRIDGE === "1") return "exec";
  return "local";
}

export function interactionKindOf(toolName: string): string {
  switch (toolName) {
    case "AskQuestion":
      return "ask_question";
    case "CreatePlan":
      return "create_plan";
    case "SwitchMode":
      return "switch_mode";
    case "WebSearch":
      return "web_search";
    default:
      return "unknown";
  }
}

export function shouldAutoResumeAfterInteraction(toolName: string): boolean {
  return interactionKindOf(toolName) !== "create_plan";
}

function firstStructuredString(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  for (const key of keys) {
    const item = value?.[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

/** Convert a decoded Cursor interaction response into provider tool-result text. */
export function normalizeClientInteractionResult(
  pending: PendingInteraction,
  input: ClientInteractionResult,
): ClientInteractionResult {
  const structured = input.structured;
  if (!structured) return input;

  const rejected = structured.rejected === true || structured.approved === false;
  const reason = firstStructuredString(
    structured,
    "reason",
    "error",
    "errorMessage",
  );
  let result = String(input.result || "").trim();

  switch (pending.interactionKind) {
    case "ask_question": {
      const answers = Array.isArray(structured.answers)
        ? structured.answers
        : undefined;
      if (answers) result = JSON.stringify({ answers });
      else if (rejected) result = reason || "Question rejected";
      break;
    }
    case "create_plan": {
      const planUri = firstStructuredString(structured, "planUri", "plan_uri");
      if (planUri) result = JSON.stringify({ plan_uri: planUri });
      else if (reason) result = reason;
      else if (structured.approved === true || structured.success === true) {
        result = "Plan created";
      }
      break;
    }
    case "switch_mode":
      result = rejected
        ? reason || "Mode switch rejected"
        : reason || "Mode switch approved";
      break;
    case "web_search":
      if (rejected) result = reason || "Search rejected";
      break;
  }

  return {
    ...input,
    result: result || "(empty)",
    ok: input.ok && !rejected && structured.success !== false,
  };
}

function waitOptions(
  fallbackTimeoutMs: number,
  timeoutOrOptions?: number | BridgeWaitOptions,
  signal?: AbortSignal,
): Required<Pick<BridgeWaitOptions, "timeoutMs">> & Pick<BridgeWaitOptions, "signal"> {
  if (typeof timeoutOrOptions === "number") {
    return {
      timeoutMs: Math.max(0, Math.floor(timeoutOrOptions)),
      signal,
    };
  }
  return {
    timeoutMs:
      timeoutOrOptions?.timeoutMs == null
        ? Math.max(0, Math.floor(fallbackTimeoutMs))
        : Math.max(0, Math.floor(timeoutOrOptions.timeoutMs)),
    signal: timeoutOrOptions?.signal || signal,
  };
}

function cancelledResult(reason: string): string {
  const detail = String(reason || "client_cancel").trim() || "client_cancel";
  return `Error: client bridge cancelled: ${detail}`;
}

function clearExecWaiterTimers(waiter: ExecWaiter): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  if (waiter.transportCloseTimer) {
    clearTimeout(waiter.transportCloseTimer);
    waiter.transportCloseTimer = undefined;
  }
}

function armExecWaiterTimeout(waiter: ExecWaiter): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.timer = undefined;
  if (waiter.settled || waiter.timeoutMs <= 0) return;
  waiter.timer = setTimeout(() => {
    waiter.resolve({
      execId: waiter.pending.execId,
      toolCallId: waiter.pending.toolCallId,
      name: waiter.pending.name,
      messageId: waiter.pending.messageId,
      ok: false,
      result: `Error: client bridge timeout after ${waiter.timeoutMs}ms for ${waiter.pending.name} (${waiter.pending.execId})`,
    });
  }, waiter.timeoutMs);
}

function disposeExecWaiter(waiter: ExecWaiter): void {
  if (waiter.settled) return;
  waiter.settled = true;
  clearExecWaiterTimers(waiter);
  if (waiter.signal && waiter.abortListener) {
    waiter.signal.removeEventListener("abort", waiter.abortListener);
  }
}

function disposeInteractionWaiter(waiter: InteractionWaiter): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortListener) {
    waiter.signal.removeEventListener("abort", waiter.abortListener);
  }
}

/** A new Cursor Run owns fresh bridge state even when it reuses a request ID. */
export function resetClientBridgeRequestState(requestId: string): void {
  const key = String(requestId || "").trim();
  if (!key) return;
  for (const waiter of execWaiters.get(key)?.values() || []) {
    disposeExecWaiter(waiter);
  }
  for (const waiter of interactionWaiters.get(key)?.values() || []) {
    disposeInteractionWaiter(waiter);
  }
  execWaiters.delete(key);
  interactionWaiters.delete(key);
  recentCompletedExecs.delete(key);
  backgroundShells.delete(key);
}

export function registerPending(
  requestId: string,
  pending: PendingExec,
  timeoutOrOptions: number | BridgeWaitOptions = 120_000,
  signal?: AbortSignal,
): Promise<ClientExecResult> {
  const options = waitOptions(120_000, timeoutOrOptions, signal);
  const m = execMap(requestId);
  return new Promise<ClientExecResult>((resolve) => {
    const waiter: ExecWaiter = {
      pending,
      settled: false,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      resolve: (r) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearExecWaiterTimers(waiter);
        if (waiter.signal && waiter.abortListener) {
          waiter.signal.removeEventListener("abort", waiter.abortListener);
        }
        if (m.get(pending.execId) === waiter) m.delete(pending.execId);
        if (m.size === 0) execWaiters.delete(requestId);
        markExecCompleted(requestId, pending.messageId);
        resolve(r);
      },
    };
    m.set(pending.execId, waiter);
    armExecWaiterTimeout(waiter);
    if (options.signal) {
      const onAbort = () => {
        waiter.resolve({
          execId: pending.execId,
          toolCallId: pending.toolCallId,
          name: pending.name,
          messageId: pending.messageId,
          ok: false,
          result: cancelledResult(String(options.signal?.reason || "client_cancel")),
        });
      };
      waiter.abortListener = onAbort;
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function registerPendingInteraction(
  requestId: string,
  pending: PendingInteraction,
  timeoutOrOptions: number | BridgeWaitOptions = 300_000,
  signal?: AbortSignal,
): Promise<ClientInteractionResult> {
  const options = waitOptions(300_000, timeoutOrOptions, signal);
  const m = interactionMap(requestId);
  return new Promise<ClientInteractionResult>((resolve) => {
    const waiter: InteractionWaiter = {
      pending,
      settled: false,
      signal: options.signal,
      resolve: (r) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.abortListener) {
          waiter.signal.removeEventListener("abort", waiter.abortListener);
        }
        if (m.get(pending.interactionId) === waiter) m.delete(pending.interactionId);
        if (m.size === 0) interactionWaiters.delete(requestId);
        resolve(r);
      },
    };
    if (options.timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        waiter.resolve({
          interactionId: pending.interactionId,
          toolCallId: pending.toolCallId,
          name: pending.name,
          messageId: pending.messageId,
          ok: false,
          result: `Error: interaction bridge timeout after ${options.timeoutMs}ms for ${pending.name} (${pending.interactionId})`,
        });
      }, options.timeoutMs);
    }
    m.set(pending.interactionId, waiter);
    if (options.signal) {
      const onAbort = () => {
        waiter.resolve({
          interactionId: pending.interactionId,
          toolCallId: pending.toolCallId,
          name: pending.name,
          messageId: pending.messageId,
          ok: false,
          result: cancelledResult(String(options.signal?.reason || "client_cancel")),
        });
      };
      waiter.abortListener = onAbort;
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Resolve every pending bridge wait immediately when its Cursor turn ends. */
export function cancelPendingForRequest(
  requestId: string,
  reason = "client_cancel",
): PendingBridgeCancellation {
  const execs = [...(execWaiters.get(requestId)?.values() || [])].map(
    (waiter) => waiter.pending,
  );
  const interactions = [...(interactionWaiters.get(requestId)?.values() || [])].map(
    (waiter) => waiter.pending,
  );

  for (const waiter of [...(execWaiters.get(requestId)?.values() || [])]) {
    waiter.resolve({
      execId: waiter.pending.execId,
      toolCallId: waiter.pending.toolCallId,
      name: waiter.pending.name,
      messageId: waiter.pending.messageId,
      ok: false,
      result: cancelledResult(reason),
    });
  }
  for (const waiter of [...(interactionWaiters.get(requestId)?.values() || [])]) {
    waiter.resolve({
      interactionId: waiter.pending.interactionId,
      toolCallId: waiter.pending.toolCallId,
      name: waiter.pending.name,
      messageId: waiter.pending.messageId,
      ok: false,
      result: cancelledResult(reason),
    });
  }

  return { execs, interactions };
}

/** BidiAppend 回传时调用；命中任意 pending 返回 true */
export function resolveClientExec(
  requestId: string,
  result: ClientExecResult,
): boolean {
  const m = execWaiters.get(requestId);
  if (!m || m.size === 0) return false;

  const byExec = result.execId ? m.get(result.execId) : undefined;
  if (byExec) {
    byExec.resolve({
      ...result,
      execId: byExec.pending.execId,
      toolCallId: byExec.pending.toolCallId,
      name: result.name || byExec.pending.name,
      messageId: byExec.pending.messageId,
    });
    return true;
  }

  if (result.messageId != null) {
    for (const w of m.values()) {
      if (w.pending.messageId === result.messageId) {
        w.resolve({
          ...result,
          execId: w.pending.execId,
          toolCallId: w.pending.toolCallId,
          name: result.name || w.pending.name,
          messageId: w.pending.messageId,
        });
        return true;
      }
    }
  }

  // Cursor may replay a terminal exec frame after reconnecting. Completed IDs
  // are retained briefly so those frames stay idempotent and never bind to a
  // newer waiter. Pending execs are selected only by exec_id or message_id.
  if (recentlyCompletedClientExec(requestId, result.messageId)) return false;
  return false;
}

const MAX_CLIENT_SHELL_OUTPUT = 256_000;

function appendOutput(previous: string, next: string | undefined): string {
  if (!next) return previous;
  const combined = previous + next;
  return combined.length > MAX_CLIENT_SHELL_OUTPUT
    ? combined.slice(-MAX_CLIENT_SHELL_OUTPUT)
    : combined;
}

function findExecWaiter(
  requestId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId">,
): ExecWaiter | undefined {
  const waiters = execWaiters.get(requestId);
  if (!waiters?.size) return undefined;
  if (match.execId) {
    const direct = waiters.get(match.execId);
    if (direct) return direct;
  }
  if (match.messageId != null) {
    for (const waiter of waiters.values()) {
      if (waiter.pending.messageId === match.messageId) return waiter;
    }
  }
  return undefined;
}

function backgroundRequestState(
  requestId: string,
  create = false,
): BackgroundShellRequestState | undefined {
  const key = String(requestId || "").trim();
  let state = backgroundShells.get(key);
  if (!state && create) {
    state = {
      byShellId: new Map(),
      byMessageId: new Map(),
      byExecId: new Map(),
    };
    backgroundShells.set(key, state);
  }
  return state;
}

function findBackgroundShell(
  requestId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId" | "shellId">,
): BackgroundShellState | undefined {
  const state = backgroundRequestState(requestId);
  if (!state) return undefined;
  const directShellId = String(match.shellId || "").trim();
  if (directShellId && state.byShellId.has(directShellId)) {
    return state.byShellId.get(directShellId);
  }
  const execId = String(match.execId || "").trim();
  const byExec = execId ? state.byExecId.get(execId) : undefined;
  if (byExec) return state.byShellId.get(byExec);
  const messageId = Number(match.messageId);
  const byMessage = Number.isFinite(messageId)
    ? state.byMessageId.get(Math.trunc(messageId))
    : undefined;
  return byMessage ? state.byShellId.get(byMessage) : undefined;
}

function rememberBackgroundShell(
  requestId: string,
  shellId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId"> & {
    toolCallId?: string;
  },
): BackgroundShellState {
  const normalizedShellId = String(shellId || "").trim();
  const state = backgroundRequestState(requestId, true)!;
  const existing = state.byShellId.get(normalizedShellId);
  const item: BackgroundShellState = existing || {
    shellId: normalizedShellId,
    status: "running",
    stdout: "",
    stderr: "",
    aborted: false,
    updatedAt: Date.now(),
  };
  const execId = String(match.execId || "").trim();
  const messageId = Number(match.messageId);
  const toolCallId = String(match.toolCallId || "").trim();
  if (execId) {
    item.execId = execId;
    state.byExecId.set(execId, normalizedShellId);
  }
  if (Number.isFinite(messageId) && messageId > 0) {
    item.messageId = Math.trunc(messageId);
    state.byMessageId.set(item.messageId, normalizedShellId);
  }
  if (toolCallId) item.toolCallId = toolCallId;
  item.updatedAt = Date.now();
  state.byShellId.set(normalizedShellId, item);
  return item;
}

function applyShellChunkToBackground(
  state: BackgroundShellState,
  chunk: ClientShellStreamChunk,
): void {
  state.stdout = appendOutput(state.stdout, chunk.stdout);
  state.stderr = appendOutput(state.stderr, chunk.stderr);
  if (chunk.exitCode != null && Number.isFinite(chunk.exitCode)) {
    state.exitCode = Math.trunc(chunk.exitCode);
  }
  if (chunk.cwd) state.cwd = chunk.cwd;
  state.aborted ||= Boolean(chunk.aborted);
  if (chunk.command) state.command = chunk.command;
  if (chunk.workingDirectory) state.workingDirectory = chunk.workingDirectory;
  if (chunk.pid != null && Number.isFinite(chunk.pid)) state.pid = Math.trunc(chunk.pid);
  if (chunk.error) state.error = chunk.error;
  if (chunk.event === "exit") state.status = "exited";
  else if (
    chunk.event === "backgrounded" ||
    chunk.event === "rejected" ||
    chunk.event === "permission_denied"
  ) {
    state.status = chunk.event;
  }
  state.updatedAt = Date.now();
}

function shellResult(
  waiter: ExecWaiter,
  event: NonNullable<ClientShellStreamChunk["event"]>,
): ClientExecResult {
  const stream = waiter.shellStream!;
  const output = [stream.stdout, stream.stderr].filter(Boolean).join("\n").trim();
  let prefix = "";
  let ok = true;
  if (event === "exit") {
    ok = !stream.aborted && (stream.exitCode == null || stream.exitCode === 0);
    prefix = stream.aborted
      ? "Error: client shell was aborted"
      : stream.exitCode != null && stream.exitCode !== 0
        ? `Error: client shell exited with code ${stream.exitCode}`
        : "";
  } else if (event === "backgrounded") {
    prefix = `shell backgrounded${stream.shellId ? `: ${stream.shellId}` : ""}`;
  } else if (event === "rejected") {
    ok = false;
    prefix = `Error: shell rejected${stream.error ? `: ${stream.error}` : ""}`;
  } else if (event === "permission_denied") {
    ok = false;
    prefix = `Error: shell permission denied${stream.error ? `: ${stream.error}` : ""}`;
  }
  return {
    execId: waiter.pending.execId,
    toolCallId: waiter.pending.toolCallId,
    name: waiter.pending.name,
    messageId: waiter.pending.messageId,
    result: [prefix, output].filter(Boolean).join("\n") || "(empty)",
    ok,
  };
}

/**
 * Record one Cursor ShellStream event. Cursor's exit/rejected/
 * permission_denied/backgrounded branches are terminal; stream_close is only
 * a transport signal and never substitutes for a real terminal event.
 */
export function appendClientShellStream(
  requestId: string,
  chunk: ClientShellStreamChunk,
): boolean {
  const waiter = findExecWaiter(requestId, chunk);
  if (!waiter || waiter.settled) {
    const background = findBackgroundShell(requestId, chunk);
    if (!background) return false;
    applyShellChunkToBackground(background, chunk);
    return true;
  }
  if (waiter.transportCloseTimer) {
    clearTimeout(waiter.transportCloseTimer);
    waiter.transportCloseTimer = undefined;
  }
  armExecWaiterTimeout(waiter);
  const stream = waiter.shellStream || {
    stdout: "",
    stderr: "",
    aborted: false,
  };
  stream.stdout = appendOutput(stream.stdout, chunk.stdout);
  stream.stderr = appendOutput(stream.stderr, chunk.stderr);
  if (chunk.exitCode != null && Number.isFinite(chunk.exitCode)) {
    stream.exitCode = Math.trunc(chunk.exitCode);
  }
  if (chunk.cwd) stream.cwd = chunk.cwd;
  stream.aborted ||= Boolean(chunk.aborted);
  stream.event = chunk.event;
  if (chunk.shellId) stream.shellId = String(chunk.shellId).trim();
  if (chunk.command) stream.command = chunk.command;
  if (chunk.workingDirectory) stream.workingDirectory = chunk.workingDirectory;
  if (chunk.pid != null && Number.isFinite(chunk.pid)) stream.pid = Math.trunc(chunk.pid);
  if (chunk.error) stream.error = chunk.error;
  waiter.shellStream = stream;
  const event = chunk.event || (chunk.exitCode != null ? "exit" : undefined);
  if (event === "backgrounded" && stream.shellId) {
    const background = rememberBackgroundShell(requestId, stream.shellId, {
      execId: waiter.pending.execId,
      messageId: waiter.pending.messageId,
      toolCallId: waiter.pending.toolCallId,
    });
    applyShellChunkToBackground(background, chunk);
  }
  if (
    event === "exit" ||
    event === "rejected" ||
    event === "permission_denied" ||
    event === "backgrounded"
  ) {
    waiter.resolve(shellResult(waiter, event));
  }
  return true;
}

function incompleteShellResult(waiter: ExecWaiter): ClientExecResult {
  const stream = waiter.shellStream;
  const output = stream
    ? [stream.stdout, stream.stderr].filter(Boolean).join("\n").trim()
    : "";
  const note = [
    "<shell-incomplete>",
    "Missing terminal shell stream event (expected exit or backgrounded).",
    "The shell transport closed before a terminal event arrived.",
    "The command may still be running in the Cursor app client.",
    "</shell-incomplete>",
  ].join("\n");
  return {
    execId: waiter.pending.execId,
    toolCallId: waiter.pending.toolCallId,
    name: waiter.pending.name,
    messageId: waiter.pending.messageId,
    result: [output, note].filter(Boolean).join("\n\n"),
    ok: false,
  };
}

/** Recover a missing terminal result after the 1.5s transport grace period. */
export function closeClientShellStream(
  requestId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId">,
): boolean {
  const waiter = findExecWaiter(requestId, match);
  if (!waiter || waiter.settled) return false;
  if (waiter.transportCloseTimer) return true;
  waiter.transportCloseTimer = setTimeout(() => {
    waiter.transportCloseTimer = undefined;
    if (waiter.settled) return;
    if (waiter.pending.name.toLowerCase() === "shell") {
      waiter.resolve(incompleteShellResult(waiter));
      return;
    }
    waiter.resolve({
      execId: waiter.pending.execId,
      toolCallId: waiter.pending.toolCallId,
      name: waiter.pending.name,
      messageId: waiter.pending.messageId,
      result: `Error: ${waiter.pending.name} transport closed before terminal result arrived`,
      ok: false,
    });
  }, EXEC_TRANSPORT_CLOSE_GRACE_MS);
  return true;
}

/** Heartbeats keep the matching client bridge alive and cancel close recovery. */
export function heartbeatClientExec(
  requestId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId">,
): boolean {
  const waiter = findExecWaiter(requestId, match);
  if (!waiter || waiter.settled) return false;
  waiter.lastHeartbeatAt = Date.now();
  if (waiter.transportCloseTimer) {
    clearTimeout(waiter.transportCloseTimer);
    waiter.transportCloseTimer = undefined;
  }
  armExecWaiterTimeout(waiter);
  return true;
}

/** Observe spawn/force-background results even after the foreground waiter closes. */
export function observeClientBackgroundShell(
  requestId: string,
  match: Pick<ClientShellStreamChunk, "execId" | "messageId">,
  result: ClientBackgroundShellResult,
): boolean {
  const waiter = findExecWaiter(requestId, match);
  const shellId = String(result.shellId || "").trim();
  let state = findBackgroundShell(requestId, { ...match, shellId });
  if (!state && shellId) {
    state = rememberBackgroundShell(requestId, shellId, {
      ...match,
      toolCallId: waiter?.pending.toolCallId,
    });
  }
  if (state) {
    state.status = result.status;
    if (result.command) state.command = result.command;
    if (result.workingDirectory) state.workingDirectory = result.workingDirectory;
    if (result.pid != null && Number.isFinite(result.pid)) state.pid = Math.trunc(result.pid);
    if (result.error) state.error = result.error;
    state.updatedAt = Date.now();
  }
  if (!waiter || waiter.settled) return Boolean(state);
  const ok = result.status === "backgrounded";
  waiter.resolve({
    execId: waiter.pending.execId,
    toolCallId: waiter.pending.toolCallId,
    name: waiter.pending.name,
    messageId: waiter.pending.messageId,
    result: ok
      ? `${result.kind === "force" ? "force background shell accepted" : "background shell started"}${shellId ? ` id=${shellId}` : ""}`
      : `Error: ${result.error || "background shell failed"}`,
    ok,
  });
  return true;
}

export function resolveClientInteraction(
  requestId: string,
  result: ClientInteractionResult,
): boolean {
  const m = interactionWaiters.get(requestId);
  if (!m || m.size === 0) return false;

  const byId = result.interactionId
    ? m.get(result.interactionId)
    : undefined;
  if (byId) {
    byId.resolve({
      ...result,
      interactionId: byId.pending.interactionId,
      toolCallId: byId.pending.toolCallId,
      name: result.name || byId.pending.name,
      messageId: byId.pending.messageId,
    });
    return true;
  }

  if (result.messageId != null) {
    const key = String(result.messageId);
    const w = m.get(key);
    if (w) {
      w.resolve({
        ...result,
        interactionId: w.pending.interactionId,
        toolCallId: w.pending.toolCallId,
        name: result.name || w.pending.name,
        messageId: w.pending.messageId,
      });
      return true;
    }
    for (const x of m.values()) {
      if (x.pending.messageId === result.messageId) {
        x.resolve({
          ...result,
          interactionId: x.pending.interactionId,
          toolCallId: x.pending.toolCallId,
          name: result.name || x.pending.name,
          messageId: x.pending.messageId,
        });
        return true;
      }
    }
  }

  return false;
}

export function hasPending(requestId: string): boolean {
  return (
    (execWaiters.get(requestId)?.size || 0) +
      (interactionWaiters.get(requestId)?.size || 0) >
    0
  );
}

export function listPending(requestId: string): Array<PendingExec | PendingInteraction> {
  const out: Array<PendingExec | PendingInteraction> = [];
  for (const w of execWaiters.get(requestId)?.values() || []) {
    out.push(w.pending);
  }
  for (const w of interactionWaiters.get(requestId)?.values() || []) {
    out.push(w.pending);
  }
  return out;
}

/** SSE / AgentServerMessage：请求客户端执行（protojson 字段） */
export function buildExecServerMessage(pending: PendingExec): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = { raw: pending.argsJson };
  }
  return buildExecServerMessageJson({
    messageId: pending.messageId,
    execId: pending.execId,
    toolName: pending.name,
    toolCallId: pending.toolCallId,
    args,
  });
}

/** SSE / AgentServerMessage：交互查询（protojson） */
export function buildInteractionQueryMessage(
  pending: PendingInteraction,
): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = { raw: pending.argsJson };
  }
  return buildInteractionQueryJson({
    messageId: pending.messageId,
    toolCallId: pending.toolCallId,
    toolName: pending.name,
    args,
  });
}

/** 二进制 InteractionQuery */
export function encodeInteractionQueryProto(
  pending: PendingInteraction,
): Buffer {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = { raw: pending.argsJson };
  }
  return encodeAgentServerInteractionQuery({
    messageId: pending.messageId,
    toolCallId: pending.toolCallId,
    toolName: pending.name,
    args,
  });
}

/** 二进制 ExecServerMessage */
export function encodeExecRequestProto(pending: PendingExec): Buffer {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = { raw: pending.argsJson };
  }
  return encodeAgentServerExec({
    messageId: pending.messageId,
    execId: pending.execId,
    toolName: pending.name,
    args: { ...args, toolCallId: pending.toolCallId },
  });
}

export function defaultBridgeTimeoutMs(toolName: string): number {
  if (isInteractionTool(toolName)) return 0;
  if (toolName === "Task") return 600_000;
  return 120_000;
}
