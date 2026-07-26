/**
 * 本地协议实现。
 *
 * 本地协议实现。
 *   Cursor
 *     → MITM(:28180)
 *     → Backend(:28190)
 *         POST /aiserver.v1.BidiService/BidiAppend
 *           Connect unary → BidiAppendRequest → hex → AgentClientMessage
 *           → dispatch intent（写 history / 开 stream / 拉起 provider）
 *         POST /agent.v1.AgentService/RunSSE
 *           Connect stream → BidiRequestId → broker 订阅
 *           → Content-Type: text/event-stream + Connect protobuf 帧
 *           → 心跳 5s；不解析用户文本、不在此启动模型
 *
 * 每个 Cursor turn 由 mailbox actor 独占状态；provider、bridge、压缩、
 * 取消和终止事件都回投 actor，再由 reconcile 决定继续或结束。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";
import type { AppConfig } from "../../config/store";
import { recordTurnUsage } from "../../metrics/usage-store";
import { createRequestContext } from "../request-context";
import {
  appendUserMessage,
  appendUserText,
  cancelStream,
  ensureStream,
  getStream,
  getStreamSignal,
  isStreamCancelled,
  markStreamTerminalPending,
  markStarted,
  otherActiveConversationRequestIds,
  publish,
  removeIfIdle,
  scheduleRun,
  setStreamConversationContext,
  setStreamMode,
  subscribe,
  type ActiveStream,
  type StreamEvent,
} from "../agent/broker";
import {
  addUsage,
  emptyUsage,
  estimateChatMessagesTokens,
  isProviderRequestError,
  orderProviderCandidates,
  runProviderChatMessages,
  type AssistantReasoningMetadata,
  type ChatMessage,
  type ChatUsage,
} from "../agent/provider-chat";
import {
  textFromContentParts,
  type ChatContentPart,
} from "../agent/content-parts";
import {
  appendAssistantWithTools,
  appendHistory,
  appendHistoryPromptContexts,
  appendToolResult,
  beginHistoryLoop,
  finishHistoryLoop,
  historyRoute,
  historyAsChatMessages,
  historyAsPromptReplayMessages,
  historyCheckpointSnapshot,
  historyLoopSnapshot,
  historyMessagesSnapshot,
  pruneCanceledHistoryTurn,
  reconcileHistoryFromCursorState,
  rewindHistoryToUserMessage,
  updateHistoryRoute,
} from "./history";
import {
  compactConversationHistory,
  ContextCompactionError,
} from "./context-compaction";
import { derivePromptContexts } from "./prompt-context";
import { persistThoughtAnnotation } from "./thought-annotation";
import {
  runInConversationLane,
  supersedeConversationLane,
} from "./conversation-lane";
import { projectConversationState } from "./conversation-state";
import {
  projectConversationCheckpoint,
  projectStructuredRuntimeState,
  sanitizeCreatePlanToolCallsForState,
  structuredRuntimePromptContexts,
  type ProjectedStructuredRuntimeState,
} from "./conversation-checkpoint";
import {
  normalizeRequestId,
  parseBidiAppendInbound,
  parseRunSSEInbound,
} from "./protocol";
import {
  createRunSseWriter,
  detectStreamWireMode,
  encodeConnectEndStream,
  streamEventToMessage,
} from "./stream-writer";
import { encodeConnectFrame } from "./connect-frame";
import { resolveContextWindowTokensForModel } from "./models";
import { resolveConversationWorkspaceRoot } from "./workspace-context";
import { cursorComposerStateDatabasePaths } from "../../workspace/cursor-composer-store";
import { toolsForMode, EXECUTABLE_TOOLS, isInteractionTool } from "./tool-catalog";
import {
  executeTool,
  executeCallMcpLocal,
  resolveWorkspaceRoot,
  synchronizeTodoState,
  type ToolExecResult,
} from "./tool-exec";
import {
  bridgeKindForTool,
  appendClientShellStream,
  cancelPendingForRequest,
  closeClientShellStream,
  defaultBridgeTimeoutMs,
  heartbeatClientExec,
  interactionKindOf,
  listPending,
  newExecId,
  newInteractionId,
  nextMessageId,
  normalizeClientInteractionResult,
  observeClientBackgroundShell,
  registerPending,
  registerPendingInteraction,
  recentlyCompletedClientExec,
  resetClientBridgeRequestState,
  resolveClientExec,
  resolveClientInteraction,
  shouldAutoResumeAfterInteraction,
  shouldUseClientBridge,
  type PendingExec,
  type PendingInteraction,
  type ClientExecResult,
  type ClientInteractionResult,
} from "./client-bridge";
import {
  ensureActiveStreamActor,
  StreamActorMailbox,
  type ExternalWait,
  type StreamActorCommand,
  type StreamActorDispatchResult,
  type StreamActorEffect,
} from "./active-stream-actor";

const MAX_DECOMPRESSED_BODY_BYTES = 64 * 1024 * 1024;
const CONTEXT_OUTPUT_RESERVE_TOKENS = 1024;
const ATTACHMENT_LOOKBACK_MS = 5 * 60 * 1000;
const ATTACHMENT_READ_ATTEMPTS = 3;
const ATTACHMENT_RETRY_DELAY_MS = 35;
const MAX_CURSOR_IMAGE_BYTES = 25 * 1024 * 1024;
const TERMINAL_USAGE_TTL_MS = 30 * 60 * 1000;
const MAX_TERMINAL_USAGE_RECORDS = 512;
const APPEND_SEQUENCE_RETENTION_MS = 10 * 60 * 1000;
const MAX_APPEND_SEQUENCE_STATES = 512;
const PROVIDER_RESUME_DEBOUNCE_MS = 200;
const ORPHAN_SUBSCRIBER_GRACE_MS = Math.max(
  1,
  Number(process.env.CURSOR_STUDIO_ORPHAN_GRACE_MS) || 30_000,
);

type OrphanCancelState = {
  token: number;
  timer: ReturnType<typeof setTimeout>;
};

const orphanCancelStates = new Map<string, OrphanCancelState>();

class EmptyConversationRunError extends Error {
  constructor() {
    super("conversation has no replayable input");
    this.name = "EmptyConversationRunError";
  }
}

async function dispatchStreamLifecycle(
  requestId: string,
  command: StreamActorCommand,
): Promise<StreamActorDispatchResult> {
  const result = await ensureActiveStreamActor(requestId).dispatch(command);
  if (result.previousPhase !== result.snapshot.phase) {
    publish(requestId, {
      type: "status",
      status: result.snapshot.phase,
    });
  }
  return result;
}

type TerminalUsageRecord = {
  recordedAt: number;
  pending: Promise<void>;
};

const terminalUsageRecords = new Map<string, TerminalUsageRecord>();

type AppendSequenceState = {
  next: number;
  processing: boolean;
  ready: Promise<void>;
  releaseReady: () => void;
  updatedAt: number;
};

type AppendSequenceTicket = {
  stale: boolean;
  release: () => void;
};

const appendSequenceStates = new Map<string, AppendSequenceState>();

function newAppendSequenceState(): AppendSequenceState {
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  return {
    next: 1,
    processing: false,
    ready,
    releaseReady,
    updatedAt: Date.now(),
  };
}

function resetAppendSequenceReady(state: AppendSequenceState) {
  let releaseReady!: () => void;
  state.ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  state.releaseReady = releaseReady;
}

function pruneAppendSequenceStates(now = Date.now()) {
  const cutoff = now - APPEND_SEQUENCE_RETENTION_MS;
  for (const [requestId, state] of appendSequenceStates) {
    if (!state.processing && state.updatedAt < cutoff) {
      appendSequenceStates.delete(requestId);
    }
  }
  if (appendSequenceStates.size <= MAX_APPEND_SEQUENCE_STATES) return;
  const inactive = [...appendSequenceStates.entries()]
    .filter(([, state]) => !state.processing)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (appendSequenceStates.size > MAX_APPEND_SEQUENCE_STATES && inactive.length) {
    const [requestId] = inactive.shift()!;
    appendSequenceStates.delete(requestId);
  }
}

/**
 * Cursor can retry or reorder BidiAppend frames. Serialize positive sequence
 * numbers per request ID and acknowledge old frames without replaying their
 * side effects (history writes, cancellation, or provider scheduling).
 */
async function acquireAppendSequence(
  requestId: string,
  appendSeqno: number | undefined,
): Promise<AppendSequenceTicket> {
  const sequence = Number(appendSeqno);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    return { stale: false, release: () => undefined };
  }

  pruneAppendSequenceStates();
  const key = String(requestId || "").trim();
  let state = appendSequenceStates.get(key);
  if (!state) {
    state = newAppendSequenceState();
    appendSequenceStates.set(key, state);
  }

  for (;;) {
    state.updatedAt = Date.now();
    if (sequence < state.next) {
      return { stale: true, release: () => undefined };
    }
    if (sequence === state.next && !state.processing) {
      state.processing = true;
      return {
        stale: false,
        release: () => {
          if (!state || !state.processing || state.next !== sequence) return;
          state.processing = false;
          state.next += 1;
          state.updatedAt = Date.now();
          state.releaseReady();
          resetAppendSequenceReady(state);
        },
      };
    }
    const ready = state.ready;
    await ready;
  }
}

function pruneTerminalUsageRecords(now = Date.now()) {
  for (const [requestId, record] of terminalUsageRecords) {
    if (now - record.recordedAt > TERMINAL_USAGE_TTL_MS) {
      terminalUsageRecords.delete(requestId);
    }
  }
  while (terminalUsageRecords.size > MAX_TERMINAL_USAGE_RECORDS) {
    const oldest = terminalUsageRecords.keys().next().value;
    if (!oldest) break;
    terminalUsageRecords.delete(oldest);
  }
}

/** A request has one terminal outcome, even when cancellation races its run loop. */
async function recordTerminalUsage(
  requestId: string,
  input: Omit<Parameters<typeof recordTurnUsage>[0], "requestId">,
): Promise<void> {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) {
    await recordTurnUsage(input).catch(() => undefined);
    return;
  }

  pruneTerminalUsageRecords();
  const existing = terminalUsageRecords.get(normalizedRequestId);
  if (existing) {
    await existing.pending;
    return;
  }

  const pending = recordTurnUsage({
    ...input,
    requestId: normalizedRequestId,
  })
    .then(() => undefined)
    .catch(() => undefined);
  terminalUsageRecords.set(normalizedRequestId, {
    recordedAt: Date.now(),
    pending,
  });
  await pending;
}

type SqlRow = Record<string, unknown>;

type CursorImageBubble = {
  text: string;
  createdAt: number;
  requestId: string;
  paths: string[];
};

export type CursorAttachmentContent = {
  content: string;
  contentParts: ChatContentPart[];
};

function asRecord(value: unknown): SqlRow | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SqlRow
    : undefined;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function parseStoredJson(value: unknown): SqlRow | undefined {
  const raw = valueText(value);
  if (!raw) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function normalizePromptText(value: string): string {
  return String(value || "").replace(/\0/g, "").replace(/\s+/g, " ").trim();
}

function bubbleCreatedAt(value: unknown): number {
  const fromIso = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(fromIso)) return fromIso;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function imagePathsFromBubble(bubble: SqlRow): string[] {
  const context = asRecord(bubble.context);
  const selections = [
    ...(Array.isArray(context?.selectedImages) ? context.selectedImages : []),
    ...(Array.isArray(bubble.images) ? bubble.images : []),
  ];
  const paths = new Set<string>();
  for (const selection of selections) {
    const item = asRecord(selection);
    const imagePath = typeof item?.path === "string" ? item.path.trim() : "";
    if (imagePath) paths.add(imagePath);
  }
  return [...paths];
}

async function findCursorImageBubble(
  conversationId: string,
  requestId: string,
  fallbackText: string,
): Promise<CursorImageBubble | undefined> {
  const candidates = await cursorComposerStateDatabasePaths();
  const normalizedText = normalizePromptText(fallbackText);
  const fallbackCutoff = Date.now() - ATTACHMENT_LOOKBACK_MS;
  let best: { score: number; bubble: CursorImageBubble } | undefined;

  for (const databasePath of candidates) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      const rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?")
        .all(`bubbleId:${conversationId}:%`);
      for (const rowValue of rows) {
        const row = asRecord(rowValue);
        const bubble = parseStoredJson(row?.value);
        if (!bubble || Number(bubble.type) !== 1) continue;

        const paths = imagePathsFromBubble(bubble);
        if (!paths.length) continue;

        const text = typeof bubble.text === "string" ? bubble.text : "";
        const createdAt = bubbleCreatedAt(bubble.createdAt);
        const bubbleRequestId = typeof bubble.requestId === "string"
          ? bubble.requestId.trim()
          : "";
        const requestMatches = Boolean(requestId && bubbleRequestId === requestId);
        const textMatches = Boolean(
          normalizedText && normalizePromptText(text) === normalizedText,
        );
        // A request id is the authoritative correlation. Text fallback is
        // deliberately time-bounded, so an older identical prompt cannot
        // attach a stale image to a later turn.
        if (!requestMatches && !(textMatches && createdAt >= fallbackCutoff)) {
          continue;
        }

        const score = requestMatches ? 2 : 1;
        const candidate = { text, createdAt, requestId: bubbleRequestId, paths };
        if (
          !best ||
          score > best.score ||
          (score === best.score && candidate.createdAt > best.bubble.createdAt)
        ) {
          best = { score, bubble: candidate };
        }
      }
    } catch {
      // Cursor can hold a state database briefly while writing a new bubble.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore a database that was rotated while being read.
      }
    }
  }

  return best?.bubble;
}

function detectedImageMimeType(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

async function readImageContentPart(filePath: string): Promise<ChatContentPart | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CURSOR_IMAGE_BYTES) {
      return undefined;
    }
    const data = await fs.readFile(filePath);
    if (!data.length || data.length > MAX_CURSOR_IMAGE_BYTES) return undefined;
    const mimeType = detectedImageMimeType(data);
    if (!mimeType) return undefined;
    return {
      type: "image",
      mimeType,
      dataBase64: data.toString("base64"),
      path: filePath,
    };
  } catch {
    return undefined;
  }
}

function attachmentRetryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ATTACHMENT_RETRY_DELAY_MS));
}

/**
 * Resolve the current Cursor user's selected images from the persisted bubble.
 * The returned parts retain base64 data, so later tool rounds and future turns
 * do not depend on Cursor's temporary workspaceStorage attachment directory.
 */
export async function resolveCursorAttachmentContent(
  conversationId: string,
  requestId: string,
  fallbackText: string,
): Promise<CursorAttachmentContent | undefined> {
  for (let attempt = 0; attempt < ATTACHMENT_READ_ATTEMPTS; attempt += 1) {
    const bubble = await findCursorImageBubble(
      conversationId,
      requestId,
      fallbackText,
    );
    if (bubble) {
      const images = (await Promise.all(bubble.paths.map(readImageContentPart)))
        .filter((part): part is ChatContentPart => Boolean(part));
      if (images.length) {
        const content = normalizePromptText(fallbackText || bubble.text) ||
          "Please analyze the attached image.";
        return {
          content,
          contentParts: [{ type: "text", text: content }, ...images],
        };
      }
      return undefined;
    }
    if (attempt + 1 < ATTACHMENT_READ_ATTEMPTS) {
      await attachmentRetryDelay();
    }
  }
  return undefined;
}

/** Estimate before upstream usage is available, then replace it with provider usage. */
function estimateChatContextTokens(messages: ChatMessage[]): number {
  return estimateChatMessagesTokens(messages);
}

function normalizeCheckpointTokens(usedTokens: number, maxTokens: number): number {
  const max = Math.max(1, Math.floor(maxTokens));
  return Math.min(max, Math.max(0, Math.floor(usedTokens)));
}

function checkpointModeNumber(mode: string | undefined): number {
  switch (String(mode || "").trim().toLowerCase()) {
    case "ask":
      return 2;
    case "plan":
      return 3;
    case "debug":
      return 4;
    case "multitask":
      return 7;
    default:
      return 1;
  }
}

function activePendingToolCalls(requestId: string): string[] {
  return listPending(requestId)
    .filter((pending) => pending.toolCallId.trim() && pending.name.trim())
    .sort((left, right) => {
      const opened = left.createdAt - right.createdAt;
      if (opened !== 0) return opened;
      return left.kind === "exec" && right.kind === "exec"
        ? left.messageId - right.messageId
        : `${left.kind}:${left.toolCallId}`.localeCompare(
          `${right.kind}:${right.toolCallId}`,
        );
    })
    .map((pending) => {
      let args: unknown = {};
      try {
        args = pending.argsJson.trim()
          ? JSON.parse(pending.argsJson)
          : {};
      } catch {
        args = { raw_arguments: pending.argsJson };
      }
      return JSON.stringify({
        id: "1",
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: pending.toolCallId,
          toolName: pending.name,
          args,
        }],
      });
    });
}

async function publishConversationCheckpoint(
  requestId: string,
  historyKey: string,
  usedTokens: number,
  maxTokens: number,
): Promise<number> {
  const normalizedUsedTokens = normalizeCheckpointTokens(usedTokens, maxTokens);
  const stream = ensureStream(requestId);
  const checkpoint = await historyCheckpointSnapshot(historyKey);
  const conversationState = projectConversationCheckpoint({
    messages: checkpoint.messages,
    pendingToolCalls: activePendingToolCalls(requestId),
    compactionSummaries: checkpoint.compaction.summaries,
    selfSummaryCount: checkpoint.compaction.selfSummaryCount,
    canceledTurns: checkpoint.canceledTurns,
    usedTokens: normalizedUsedTokens,
    maxTokens,
    mode: checkpointModeNumber(stream.mode),
    baseState: stream.conversationState,
  });
  publish(requestId, {
    type: "checkpoint",
    usedTokens: normalizedUsedTokens,
    maxTokens,
    conversationState,
  });
  return normalizedUsedTokens;
}

async function publishLatestConversationCheckpoint(
  requestId: string,
  historyKey: string,
  getConfig: () => Promise<AppConfig>,
  modelHint?: string,
  minimumUsedTokens = 0,
  contextWindowTokensOverride?: number,
): Promise<void> {
  const [cfg, messages, savedRoute] = await Promise.all([
    getConfig(),
    historyMessagesSnapshot(historyKey),
    historyRoute(historyKey),
  ]);
  const effectiveModelHint = modelHint ||
    savedRoute.modelHint ||
    (savedRoute.providerId && savedRoute.modelID
      ? `${savedRoute.providerId}:${savedRoute.modelID}`
      : undefined);
  const explicitWindow = Number(contextWindowTokensOverride);
  const persistedWindow = Number(savedRoute.contextWindowTokens);
  const maxTokens = Number.isFinite(explicitWindow) && explicitWindow > 0
    ? Math.floor(explicitWindow)
    : Number.isFinite(persistedWindow) && persistedWindow > 0
      ? Math.floor(persistedWindow)
      : resolveContextWindowTokensForModel(
        cfg.providers,
        effectiveModelHint,
        cfg.cursorIntegration,
      );
  await publishConversationCheckpoint(
    requestId,
    historyKey,
    Math.max(minimumUsedTokens, estimateChatContextTokens(messages)),
    maxTokens,
  );
}

function remainingContextOutputBudget(
  contextWindowTokens: number,
  usedTokens: number,
): number | undefined {
  const remaining = Math.floor(contextWindowTokens) - Math.floor(usedTokens);
  const budget = remaining - CONTEXT_OUTPUT_RESERVE_TOKENS;
  // If the retained transcript already exceeds its target, provider-chat will
  // remove oldest complete turns before requesting the model. Returning no
  // override here lets that final budget reserve the normal response space.
  return budget >= 1 ? budget : undefined;
}

function decodeHttpContentEncoding(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): Buffer {
  const encodings = (Array.isArray(contentEncoding)
    ? contentEncoding.join(",")
    : String(contentEncoding || ""))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity");

  let decoded = body;
  for (const encoding of encodings.reverse()) {
    const options = { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES };
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = gunzipSync(decoded, options);
    } else if (encoding === "deflate") {
      decoded = inflateSync(decoded, options);
    } else if (encoding === "br") {
      decoded = brotliDecompressSync(decoded, options);
    } else {
      throw new Error(`unsupported content-encoding: ${encoding}`);
    }
  }
  return decoded;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        resolve(
          decodeHttpContentEncoding(
            Buffer.concat(chunks),
            req.headers["content-encoding"],
          ),
        );
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeConnectEmpty(req: IncomingMessage, res: ServerResponse) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const accept = String(req.headers.accept || "").toLowerCase();
  const wantsConnectProto = ct.includes("connect+proto") || accept.includes("connect+proto");
  const wantsProto = ct.includes("application/proto") || accept.includes("application/proto");
  const wantsConnectJson = ct.includes("connect+json") || accept.includes("connect+json");

  if (wantsConnectProto) {
    // Connect unary：空 BidiAppendResponse + end-stream trailer
    res.writeHead(200, {
      "Content-Type": "application/connect+proto",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      Buffer.concat([
        encodeConnectFrame(Buffer.alloc(0), 0),
        encodeConnectEndStream(),
      ]),
    );
    return;
  }

  if (wantsProto) {
    // Unary application/proto is a bare protobuf message, with no envelope.
    res.writeHead(200, {
      "Content-Type": "application/proto",
      "Content-Length": 0,
      "Access-Control-Allow-Origin": "*",
    });
    res.end();
    return;
  }

  if (wantsConnectJson) {
    res.writeHead(200, {
      "Content-Type": "application/connect+json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      Buffer.concat([
        encodeConnectFrame("{}", 0),
        encodeConnectEndStream(),
      ]),
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end("{}");
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

/** StreamEvent → Cursor 兼容 AgentServerMessage（实现见 stream-writer） */
export { streamEventToMessage } from "./stream-writer";

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { raw };
}

/**
 * Stream transport is keyed by a short-lived Bidi request ID, while persisted
 * model context belongs to the longer-lived Cursor conversation when present.
 */
export function historyKeyForStream(
  requestId: string,
  conversationId?: string,
): string {
  const stableConversationId = String(conversationId || "").trim();
  return stableConversationId || requestId;
}

/**
 * A newer user turn supersedes outstanding work for the same Cursor
 * conversation. Cursor does not always send a separate cancel first, so
 * actively stop provider/tool actors here before they can append stale output
 * after the newer turn has been accepted.
 */
async function cancelSupersededConversationRequests(
  conversationId: string | undefined,
  requestId: string,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  const id = String(conversationId || "").trim();
  if (!id) return;

  const supersededRequestIds = otherActiveConversationRequestIds(id, requestId);
  if (!supersededRequestIds.length) return;

  supersedeConversationLane(historyKeyForStream(requestId, id), requestId);
  for (const supersededRequestId of supersededRequestIds) {
    const supersededStream = getStream(supersededRequestId);
    if (
      await cancelRuntimeIfActive(
        supersededRequestId,
        "superseded_by_newer_request",
      )
    ) {
      continue;
    }
    // Cursor keeps a client-side exec alive until an explicit control frame.
    // Send it before cancelStream emits the terminal RunSSE error.
    for (const pending of listPending(supersededRequestId)) {
      if (pending.kind !== "exec") continue;
      publish(supersededRequestId, {
        type: "exec_abort",
        messageId: pending.messageId,
      });
    }
    await dispatchStreamLifecycle(supersededRequestId, { kind: "cancel" }).catch(
      (actorError) => {
        console.warn("[forwarder] failed to cancel superseded actor", actorError);
      },
    );
    cancelStream(supersededRequestId, "superseded_by_newer_request", {
      deferTerminal: true,
    });
    const supersededHistoryKey = historyKeyForStream(
      supersededRequestId,
      supersededStream?.conversationId,
    );
    await pruneCanceledHistoryTurn(
      supersededHistoryKey,
      supersededRequestId,
      "superseded_by_newer_request",
    ).catch((historyError) => {
      console.warn("[forwarder] failed to prune superseded history turn", historyError);
    });
    await finishHistoryLoop(
      supersededHistoryKey,
      supersededRequestId,
      "canceled",
    ).catch((historyError) => {
      console.warn(
        "[forwarder] failed to persist superseded loop state",
        historyError,
      );
    });
    await publishLatestConversationCheckpoint(
      supersededRequestId,
      supersededHistoryKey,
      getConfig,
      supersededStream?.modelHint,
    ).catch((checkpointError) => {
      console.warn(
        "[forwarder] failed to publish superseded checkpoint",
        checkpointError,
      );
    });
    publish(supersededRequestId, {
      type: "error",
      message: "cancelled: superseded_by_newer_request",
      code: "canceled",
    });
  }
}

async function reconcileCursorConversationState(
  requestId: string,
  conversationId: string | undefined,
  rawState: Buffer | undefined,
): Promise<void> {
  if (!rawState?.length) return;
  const historyKey = historyKeyForStream(requestId, conversationId);
  const localMessages = await historyMessagesSnapshot(historyKey);
  // Import Cursor's checkpoint only while bootstrapping an empty local
  // conversation. Once Studio owns a transcript, later reconnect checkpoints
  // can be stale or partial and must not be merged back into canonical history.
  if (localMessages.length > 0) return;
  const localLoop = await historyLoopSnapshot(historyKey);
  if (localLoop.readable && localLoop.currentRequestId) return;
  const projection = projectConversationState(rawState, {
    // Import root_prompt_messages_json first because it is the canonical
    // provider replay; legacy turn bytes are used to restore lineage/fallback.
    preferTurns: false,
    allowRootReplay: true,
  });
  if (
    projection.skippedTurns > 0 ||
    projection.skippedSteps > 0 ||
    projection.decodedTurns !== projection.turnCount
  ) {
    console.warn("[forwarder] ignored partial Cursor conversation state", {
      requestId,
      conversationId,
      turns: projection.turnCount,
      decodedTurns: projection.decodedTurns,
      skippedTurns: projection.skippedTurns,
      skippedSteps: projection.skippedSteps,
    });
    return;
  }
  // Do not replace a known-good transcript with an empty projection when a
  // newer Cursor build adds a turn type we have not decoded yet.
  if (
    !projection.messages.length &&
    !projection.compactionSummaries.length &&
    !projection.selfSummaryCount
  ) return;

  const result = await reconcileHistoryFromCursorState(
    historyKey,
    projection.messages.map((message) => {
      // Match the runtime import boundary: Cursor's visible checkpoint is replay
      // context (TurnSeq=0, RequestID=""), not locally owned active lineage.
      // The inbound action below creates the new semantic turn and request ID.
      const {
        cursorMessageId: _cursorMessageId,
        turnSequence: _turnSequence,
        sourceRequestId: _sourceRequestId,
        ...replay
      } = message;
      void _cursorMessageId;
      void _turnSequence;
      void _sourceRequestId;
      return replay;
    }),
    undefined,
    {
      summaries: projection.compactionSummaries,
      selfSummaryCount: projection.selfSummaryCount,
    },
  );
  if (result.applied) {
    console.log("[forwarder] reconciled Cursor conversation state", {
      requestId,
      conversationId,
      priorMessages: result.previousMessages,
      messages: result.currentMessages,
      turns: projection.turnCount,
      decodedTurns: projection.decodedTurns,
      skippedTurns: projection.skippedTurns,
      skippedSteps: projection.skippedSteps,
    });
  }
}

async function shouldIgnoreEmptyResumeRunRequest(
  requestId: string,
  extracted: ReturnType<typeof parseBidiAppendInbound>,
  historyKey: string,
): Promise<boolean> {
  if (
    extracted.kind !== "user_run" ||
    extracted.conversationAction !== "resume" ||
    extracted.texts.length > 0 ||
    extracted.contentParts?.length ||
    extracted.hasRequestContextPayload ||
    extracted.hasPendingToolCalls
  ) {
    return false;
  }

  const conversationId = String(extracted.conversationId || "").trim();
  const sameRequestStream = getStream(requestId);
  if (
    conversationId &&
    sameRequestStream &&
    sameRequestStream.conversationId === conversationId &&
    !sameRequestStream.done &&
    !sameRequestStream.cancelled
  ) {
    // Successful completion persists usage/history/checkpoint before emitting
    // the native terminal frame. During that commit window an empty Resume is
    // a transport reconnect, not a new provider turn.
    if (sameRequestStream.terminalPending) return true;
    return false;
  }
  if (conversationId) {
    const otherRequestIds = otherActiveConversationRequestIds(
      conversationId,
      requestId,
    );
    if (otherRequestIds.length > 0) {
      const otherStreams = otherRequestIds
        .map((id) => getStream(id))
        .filter((stream): stream is ActiveStream => Boolean(stream));
      if (otherStreams.some((stream) => !stream.terminalPending)) return false;
      if (otherStreams.some((stream) => stream.terminalPending)) return true;
    }
  }

  const loop = await historyLoopSnapshot(historyKey);
  if (!loop.found || !loop.readable) return false;
  return loop.currentLoopStatus === "completed" ||
    loop.currentLoopStatus === "idle";
}

/**
 * Provider turns and explicit Cursor compaction actions share the same
 * persisted transcript. Serialize them by conversation rather than the
 * short-lived Bidi request ID so one request cannot read stale history while
 * another is replacing it with a summary.
 */
function runStreamWorkInConversationLane(
  requestId: string,
  getConfig: () => Promise<AppConfig>,
  work: (requestId: string, getConfig: () => Promise<AppConfig>) => Promise<void>,
) {
  const stream = ensureStream(requestId);
  const key = historyKeyForStream(requestId, stream.conversationId);
  void runInConversationLane(
    key,
    requestId,
    () => work(requestId, getConfig),
    getStreamSignal(requestId),
  ).catch(async (error) => {
    // Cancellation already emitted Cursor's terminal events. The remaining
    // path only protects a queued lane task from becoming an unhandled error.
    if (isStreamCancelled(requestId)) return;
    const active = getStream(requestId);
    if (!active || active.done) return;
    await dispatchStreamLifecycle(requestId, { kind: "fail" }).catch(
      (actorError) => {
        console.warn("[forwarder] failed to transition queued stream actor", actorError);
      },
    );
    await finishHistoryLoop(
      key,
      requestId,
      isProviderRequestError(error) ? "provider_error" : "failed",
    ).catch((historyError) => {
      console.warn("[forwarder] failed to persist queued loop state", historyError);
    });
    await publishLatestConversationCheckpoint(
      requestId,
      key,
      getConfig,
      active.modelHint,
    ).catch((checkpointError) => {
      console.warn("[forwarder] failed to publish terminal checkpoint", checkpointError);
    });
    const cursorError = cursorProviderError(error);
    publish(requestId, {
      type: "error",
      message: cursorError.message,
      code: cursorError.code,
      status: cursorError.status,
    });
  });
}

function cursorProviderError(error: unknown): {
  message: string;
  code: string;
  status?: number;
} {
  if (error instanceof EmptyConversationRunError) {
    return {
      message: "没有可继续的会话内容，请重新发送消息。",
      code: "invalid_argument",
    };
  }
  if (error instanceof ContextCompactionError) {
    return {
      message: "当前对话上下文过长，请缩短输入后重试。",
      code: "invalid_argument",
    };
  }
  const status = isProviderRequestError(error) ? error.status : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) {
    return {
      message: "服务授权已失效，请检查供应商设置后重试。",
      code: status === 401 ? "unauthenticated" : "permission_denied",
      status,
    };
  }
  if (status === 429) {
    return {
      message: "服务请求较多，请稍后重试。",
      code: "resource_exhausted",
      status,
    };
  }
  if (status != null && status >= 500) {
    return {
      message: "服务暂时不可用，请稍后重试。",
      code: "unavailable",
      status,
    };
  }
  if (/context|token.{0,16}(limit|length|long|exceed)/i.test(raw)) {
    return {
      message: "当前对话上下文过长，请缩短输入后重试。",
      code: "invalid_argument",
      status,
    };
  }
  if (/timeout|network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(raw)) {
    return {
      message: "连接服务失败，请检查网络后重试。",
      code: "unavailable",
    };
  }
  return { message: "本次请求未完成，请重试。", code: "unavailable" };
}

function isContextLimitProviderError(error: unknown): boolean {
  if (!isProviderRequestError(error)) return false;
  const status = error.status;
  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status != null && status >= 500)
  ) {
    return false;
  }
  const message = String(error.message || "");
  if (
    /(?:completion|output).{0,32}tokens?.{0,32}(?:limit|maximum|max|exceed)/i.test(message) ||
    /(?:limit|maximum|max|exceed).{0,32}(?:completion|output).{0,32}tokens?/i.test(message)
  ) {
    return false;
  }
  return [
    /context[_\s-]*(?:length|window|limit|size|exceed)/i,
    /(?:maximum|max)[_\s-]*(?:context|input|token)/i,
    /(?:prompt|input).{0,64}(?:too[_\s-]?long|too[_\s-]?large|exceed|limit|length)/i,
    /(?:too[_\s-]?many|exceeds?|exceeded).{0,64}tokens?/i,
    /tokens?.{0,64}(?:exceed|exceeded|limit|length|maximum|max)/i,
  ].some((pattern) => pattern.test(message));
}

function throwIfStreamCancelled(requestId: string): void {
  if (!isStreamCancelled(requestId)) return;
  const error = new Error("AbortError: client cancelled");
  error.name = "AbortError";
  throw error;
}

function parseContextTokenValue(value: string): number | undefined {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return undefined;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.floor(numeric * multiplier);
  return tokens >= 512 && tokens <= 16_000_000 ? tokens : undefined;
}

/** Best-effort extraction from common provider context-limit responses. */
function reportedContextWindowTokens(error: unknown): number | undefined {
  if (!isProviderRequestError(error)) return undefined;
  const message = String(error.message || "");
  const token = "([0-9][0-9,._]*(?:\\s*[kKmM])?)";
  const patterns = [
    new RegExp(
      `(?:maximum|max)\\s+(?:context(?:\\s+(?:window|length))?|input(?:\\s+tokens?)?|tokens?)\\s*(?:is|:|=|of|to)?\\s*${token}`,
      "i",
    ),
    new RegExp(
      `(?:context(?:\\s+(?:window|length))?|token(?:\\s+limit)?|input(?:\\s+limit)?)\\s*(?:is|:|=|of|to)\\s*${token}`,
      "i",
    ),
    new RegExp(`${token}\\s*tokens?\\s*(?:maximum|max|limit)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseContextTokenValue(match[1].replace(/[,_\s]/g, ""));
    if (parsed) return parsed;
  }
  return undefined;
}

function routeHint(
  requested: string | undefined,
  providerId: string,
  modelID: string,
): string {
  const fallback = `${providerId}:${modelID}`;
  const hint = String(requested || "").trim();
  const prefix = `${fallback}:`;
  return hint === fallback || hint.startsWith(prefix) ? hint : fallback;
}

type ProviderChatResult = Awaited<ReturnType<typeof runProviderChatMessages>>;
type ProviderLaunchEffect = Extract<
  StreamActorEffect,
  { kind: "start_provider" | "resume_provider" }
>;

type RuntimeInvocation = {
  id: string;
  name: string;
  arguments: string;
  args: Record<string, unknown>;
};

type RuntimePendingTool = {
  id: string;
  modelCallId: string;
  external: ExternalWait;
  invocation: RuntimeInvocation;
  kind: "interaction" | "exec" | "local";
  pending?: PendingInteraction | PendingExec;
  localFallback: boolean;
  fallbackStarted: boolean;
};

type StreamRuntimeEvent =
  | { kind: "initialize" }
  | {
      kind: "inbound";
      action:
        | "metadata"
        | "prewarm"
        | "exec_result"
        | "exec_control"
        | "interaction_result"
        | "heartbeat";
    }
  | {
      kind: "provider_resume_ready";
      resumeToken: number;
      launch: ProviderLaunchEffect;
    }
  | {
      kind: "compaction_started";
      preparationToken: number;
    }
  | {
      kind: "compaction_summary";
      preparationToken: number;
      summary: string;
    }
  | {
      kind: "provider_prepared";
      preparationToken: number;
      launch: ProviderLaunchEffect;
      compaction: Awaited<ReturnType<typeof compactConversationHistory>>;
      structuredState: ProjectedStructuredRuntimeState;
    }
  | {
      kind: "provider_preparation_failed";
      preparationToken: number;
      error: unknown;
    }
  | {
      kind: "provider_text";
      providerToken: number;
      providerPass: number;
      text: string;
    }
  | {
      kind: "provider_thinking";
      providerToken: number;
      providerPass: number;
      text: string;
    }
  | {
      kind: "provider_completed";
      providerToken: number;
      providerPass: number;
      modelCallId: string;
      estimatedPromptTokens: number;
      streamedText: string;
      result: ProviderChatResult;
    }
  | {
      kind: "provider_failed";
      providerToken: number;
      providerPass: number;
      modelCallId: string;
      streamedText: string;
      reasoning: AssistantReasoningMetadata;
      hadOutput: boolean;
      error: unknown;
    }
  | {
      kind: "external_result";
      pendingId: string;
      result: ClientExecResult | ClientInteractionResult | ToolExecResult;
    }
  | { kind: "cancel"; reason: string };

type StreamTurnRuntime = {
  requestId: string;
  turnSequence: number;
  getConfig: () => Promise<AppConfig>;
  stream: ActiveStream;
  historyKey: string;
  mailbox: StreamActorMailbox<StreamRuntimeEvent>;
  done: Promise<void>;
  resolveDone: () => void;
  terminal: boolean;
  initialized: boolean;
  cfg?: AppConfig;
  chatMessages: ChatMessage[];
  activeModelHint?: string;
  activeContextWindowTokens: number;
  contextWindowProviderId?: string;
  contextWindowModelID?: string;
  checkpointUsedTokens: number;
  workspace?: string;
  totalUsage: ChatUsage;
  lastProviderId: string;
  lastModelId: string;
  thinkingStartedAt: number;
  sawThinking: boolean;
  currentProviderToken: number;
  currentProviderPass: number;
  preparationToken: number;
  activePreparationToken: number;
  summaryPreparationTokens: Set<number>;
  providerPreparing: boolean;
  resumeTimerToken: number;
  pendingTools: Map<string, RuntimePendingTool>;
  structuredState?: ProjectedStructuredRuntimeState;
};

const activeStreamRuntimes = new Map<string, StreamTurnRuntime>();

function isRuntimeCurrent(
  runtime: StreamTurnRuntime,
  providerToken?: number,
  providerPass?: number,
): boolean {
  if (runtime.terminal || isStreamCancelled(runtime.requestId)) return false;
  if (
    providerToken != null &&
    providerToken !== runtime.currentProviderToken
  ) {
    return false;
  }
  return providerPass == null || providerPass === runtime.currentProviderPass;
}

function settleStreamRuntime(runtime: StreamTurnRuntime): void {
  if (runtime.terminal) return;
  runtime.terminal = true;
  runtime.resumeTimerToken += 1;
  runtime.pendingTools.clear();
  activeStreamRuntimes.delete(runtime.requestId);
  runtime.resolveDone();
  runtime.mailbox.close();
}

function postStreamRuntimeEvent(
  runtime: StreamTurnRuntime,
  event: StreamRuntimeEvent,
): Promise<void> {
  return runtime.mailbox.post(event);
}

function liveStreamRuntime(requestId: string): StreamTurnRuntime | undefined {
  const runtime = activeStreamRuntimes.get(String(requestId || "").trim());
  if (!runtime || runtime.terminal || isStreamCancelled(runtime.requestId)) {
    return undefined;
  }
  return runtime;
}

async function dispatchRuntimeInbound(
  requestId: string,
  action: Extract<StreamRuntimeEvent, { kind: "inbound" }>['action'],
): Promise<void> {
  const runtime = liveStreamRuntime(requestId);
  if (runtime) {
    await postStreamRuntimeEvent(runtime, { kind: "inbound", action });
    return;
  }
  if (action === "metadata" || action === "heartbeat") return;
  await dispatchStreamLifecycle(requestId, { kind: "inbound", action });
}

async function publishRuntimeCheckpoint(
  runtime: StreamTurnRuntime,
  usedTokens = estimateChatContextTokens(runtime.chatMessages),
  resetGeneration = false,
): Promise<void> {
  runtime.checkpointUsedTokens = await publishConversationCheckpoint(
    runtime.requestId,
    runtime.historyKey,
    resetGeneration
      ? usedTokens
      : Math.max(runtime.checkpointUsedTokens, usedTokens),
    runtime.activeContextWindowTokens,
  );
}

async function applyRuntimeActorEffect(
  runtime: StreamTurnRuntime,
  effect: StreamActorEffect,
): Promise<void> {
  if (runtime.terminal || effect.kind === "none") return;
  if (effect.kind === "start_provider") {
    runtime.resumeTimerToken += 1;
    launchProviderPreparation(runtime, effect);
    return;
  }
  if (effect.kind === "resume_provider") {
    runtime.resumeTimerToken += 1;
    const resumeToken = runtime.resumeTimerToken;
    setTimeout(() => {
      void postStreamRuntimeEvent(runtime, {
        kind: "provider_resume_ready",
        resumeToken,
        launch: effect,
      });
    }, PROVIDER_RESUME_DEBOUNCE_MS);
    return;
  }
  if (effect.kind === "complete_turn") {
    await completeStreamRuntime(runtime);
  }
}

async function transitionStreamRuntime(
  runtime: StreamTurnRuntime,
  command: StreamActorCommand,
): Promise<StreamActorDispatchResult> {
  const result = await dispatchStreamLifecycle(runtime.requestId, command);
  await applyRuntimeActorEffect(runtime, result.effect);
  return result;
}

async function completeStreamRuntime(runtime: StreamTurnRuntime): Promise<void> {
  if (runtime.terminal) return;
  const {
    promptTokens: rawPrompt,
    completionTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  } = runtime.totalUsage;
  const promptTotal = Math.max(rawPrompt, cacheRead + cacheWrite);
  const inputTokens = Math.max(0, promptTotal - cacheRead - cacheWrite);

  // The actor has decided this turn is terminal. Expose that decision to the
  // broker before the first asynchronous persistence step so a reconnect with
  // a new request ID cannot supersede this turn and invoke the provider again.
  markStreamTerminalPending(runtime.requestId);

  if (runtime.sawThinking) {
    publish(runtime.requestId, {
      type: "thinking_done",
      durationMs: Date.now() - runtime.thinkingStartedAt,
    });
  }
  // Persist the usage snapshot before the durable turn-completed marker
  // and final checkpoint. Keeping all storage work ahead of the checkpoint
  // leaves no long asynchronous gap between checkpoint and native End.
  await recordTerminalUsage(runtime.requestId, {
    valid: true,
    requestTokens: promptTotal + completionTokens,
    promptTokens: promptTotal,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    providerId: runtime.lastProviderId || undefined,
    modelID: runtime.lastModelId || undefined,
    source: "agent",
  });
  await finishHistoryLoop(
    runtime.historyKey,
    runtime.requestId,
    "completed",
  );
  runtime.chatMessages = await historyAsChatMessages(runtime.historyKey);
  await publishRuntimeCheckpoint(
    runtime,
    Math.max(
      estimateChatContextTokens(runtime.chatMessages),
      rawPrompt + completionTokens,
    ),
  );
  publish(runtime.requestId, {
    type: "usage",
    promptTokens: promptTotal,
    completionTokens,
    cacheRead,
    cacheWrite,
  });
  publish(runtime.requestId, {
    type: "turn_ended",
    inputTokens,
    outputTokens: completionTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
  await transitionStreamRuntime(runtime, { kind: "complete" });
  publish(runtime.requestId, { type: "done" });
  settleStreamRuntime(runtime);
}

async function failStreamRuntime(
  runtime: StreamTurnRuntime,
  error: unknown,
  partial?: {
    text?: string;
    reasoning?: AssistantReasoningMetadata;
    modelHint?: string;
  },
): Promise<void> {
  if (runtime.terminal) return;
  const message = error instanceof Error ? error.message : String(error);
  const providerId = isProviderRequestError(error)
    ? error.providerId
    : runtime.lastProviderId || undefined;
  const modelID = isProviderRequestError(error)
    ? error.modelID
    : runtime.lastModelId || undefined;
  const cursorError = cursorProviderError(error);
  const terminalModelHint = providerId && modelID
    ? routeHint(partial?.modelHint || runtime.activeModelHint, providerId, modelID)
    : partial?.modelHint || runtime.activeModelHint;
  const reportedWindow = reportedContextWindowTokens(error);
  const terminalContextWindow = reportedWindow ||
    (runtime.activeContextWindowTokens > 1
      ? runtime.activeContextWindowTokens
      : undefined);

  try {
    await transitionStreamRuntime(runtime, { kind: "fail" }).catch((actorError) => {
      console.warn("[forwarder] failed to transition stream actor to failed", actorError);
    });
    for (const pending of listPending(runtime.requestId)) {
      if (pending.kind === "exec") {
        publish(runtime.requestId, {
          type: "exec_abort",
          messageId: pending.messageId,
        });
      }
    }
    cancelPendingForRequest(runtime.requestId, "stream_failed");

    const partialText = String(partial?.text || "");
    const reasoning = partial?.reasoning || {};
    if (
      partialText.trim() ||
      reasoning.reasoningContent?.trim() ||
      reasoning.reasoningSignature?.trim()
    ) {
      await appendAssistantWithTools(
        runtime.historyKey,
        partialText,
        undefined,
        terminalModelHint,
        {
          sourceRequestId: runtime.requestId,
          turnSequence: runtime.turnSequence,
        },
        reasoning,
      ).catch((historyError) => {
        console.warn("[forwarder] failed to persist partial provider output", historyError);
      });
    }
    if (providerId && modelID) {
      await updateHistoryRoute(runtime.historyKey, {
        modelHint: terminalModelHint,
        providerId,
        modelID,
        contextWindowTokens: terminalContextWindow,
      }).catch((routeError) => {
        console.warn("[forwarder] failed to persist terminal provider route", routeError);
      });
    }
    await recordTerminalUsage(runtime.requestId, {
      valid: false,
      error: message,
      providerId,
      modelID,
      source: "agent",
    }).catch((usageError) => {
      console.warn("[forwarder] failed to persist terminal usage", usageError);
    });
    await finishHistoryLoop(
      runtime.historyKey,
      runtime.requestId,
      isProviderRequestError(error) ? "provider_error" : "failed",
    ).catch((historyError) => {
      console.warn("[forwarder] failed to persist terminal loop state", historyError);
    });
    await publishLatestConversationCheckpoint(
      runtime.requestId,
      runtime.historyKey,
      runtime.getConfig,
      terminalModelHint,
      runtime.totalUsage.promptTokens + runtime.totalUsage.completionTokens,
      terminalContextWindow,
    ).catch((checkpointError) => {
      console.warn("[forwarder] failed to publish provider-error checkpoint", checkpointError);
    });
  } finally {
    try {
      publish(runtime.requestId, {
        type: "error",
        message: cursorError.message,
        code: cursorError.code,
        status: cursorError.status,
      });
    } finally {
      settleStreamRuntime(runtime);
    }
  }
}

async function cancelStreamRuntime(
  runtime: StreamTurnRuntime,
  reason: string,
): Promise<void> {
  if (runtime.terminal) return;
  const cancellationReason = String(reason || "client_cancel").trim() || "client_cancel";
  try {
    await transitionStreamRuntime(runtime, { kind: "cancel" }).catch((actorError) => {
      console.warn("[forwarder] failed to transition stream actor to canceled", actorError);
    });
    for (const pending of listPending(runtime.requestId)) {
      if (pending.kind === "exec") {
        publish(runtime.requestId, {
          type: "exec_abort",
          messageId: pending.messageId,
        });
      }
    }
    cancelStream(runtime.requestId, cancellationReason, { deferTerminal: true });
    await pruneCanceledHistoryTurn(
      runtime.historyKey,
      runtime.requestId,
      cancellationReason,
    ).catch((historyError) => {
      console.warn("[forwarder] failed to prune canceled history turn", historyError);
    });
    await finishHistoryLoop(
      runtime.historyKey,
      runtime.requestId,
      "canceled",
    ).catch((historyError) => {
      console.warn("[forwarder] failed to persist canceled loop state", historyError);
    });
    await recordTerminalUsage(runtime.requestId, {
      valid: false,
      error: cancellationReason,
      providerId: runtime.lastProviderId || undefined,
      modelID: runtime.lastModelId || undefined,
      source: "agent",
    }).catch((usageError) => {
      console.warn("[forwarder] failed to persist canceled usage", usageError);
    });
    await publishLatestConversationCheckpoint(
      runtime.requestId,
      runtime.historyKey,
      runtime.getConfig,
      runtime.activeModelHint || runtime.stream.modelHint,
      0,
      runtime.activeContextWindowTokens > 1
        ? runtime.activeContextWindowTokens
        : undefined,
    ).catch((checkpointError) => {
      console.warn("[forwarder] failed to publish cancel checkpoint", checkpointError);
    });
  } finally {
    try {
      publish(runtime.requestId, {
        type: "error",
        message: `cancelled: ${cancellationReason}`,
        code: "canceled",
      });
    } finally {
      settleStreamRuntime(runtime);
    }
  }
}

async function cancelRuntimeIfActive(
  requestId: string,
  reason: string,
): Promise<boolean> {
  const runtime = activeStreamRuntimes.get(String(requestId || "").trim());
  if (!runtime || runtime.terminal) return false;
  await postStreamRuntimeEvent(runtime, { kind: "cancel", reason });
  return true;
}

function cancelOrphanStreamTimer(requestId: string): void {
  const key = String(requestId || "").trim();
  const current = orphanCancelStates.get(key);
  if (!current) return;
  clearTimeout(current.timer);
  orphanCancelStates.delete(key);
}

function scheduleOrphanStreamCancellation(requestId: string): void {
  const key = String(requestId || "").trim();
  const stream = getStream(key);
  if (!key || !stream || stream.done || stream.subscriberCount > 0) return;

  const previous = orphanCancelStates.get(key);
  if (previous) clearTimeout(previous.timer);
  const token = (previous?.token || 0) + 1;
  const timer = setTimeout(() => {
    void (async () => {
      const current = orphanCancelStates.get(key);
      if (!current || current.token !== token) return;
      orphanCancelStates.delete(key);
      const latest = getStream(key);
      if (!latest || latest.done || latest.subscriberCount > 0) return;
      if (await cancelRuntimeIfActive(key, "runsse_client_disconnected")) return;
      const pending = getStream(key);
      if (pending && !pending.done && pending.subscriberCount === 0) {
        cancelStream(key, "runsse_client_disconnected");
      }
    })().catch((error) => {
      console.warn("[forwarder] orphan stream cancellation failed", {
        requestId: key,
        error,
      });
    });
  }, ORPHAN_SUBSCRIBER_GRACE_MS);
  orphanCancelStates.set(key, { token, timer });
}

async function initializeStreamRuntime(runtime: StreamTurnRuntime): Promise<void> {
  if (runtime.initialized || runtime.terminal) return;
  const cfg = await runtime.getConfig();
  runtime.cfg = cfg;
  throwIfStreamCancelled(runtime.requestId);
  if (cfg.routingMode === "upstream") {
    const preferred = orderProviderCandidates(
      cfg.providers,
      runtime.stream.modelHint,
    )[0];
    runtime.lastProviderId = preferred?.id || "";
    runtime.lastModelId = preferred?.modelID || "";
    throw new Error("upstream mode");
  }

  let loop = await historyLoopSnapshot(runtime.historyKey);
  if (
    !loop.readable ||
    loop.currentRequestId !== runtime.requestId ||
    !loop.currentTurnSequence
  ) {
    loop = await beginHistoryLoop(runtime.historyKey, runtime.requestId);
  }
  runtime.turnSequence = loop.currentTurnSequence || 0;

  const savedRoute = await historyRoute(runtime.historyKey);
  runtime.activeModelHint =
    runtime.stream.modelHint ||
    savedRoute.modelHint ||
    (savedRoute.providerId && savedRoute.modelID
      ? `${savedRoute.providerId}:${savedRoute.modelID}`
      : undefined);
  const initialProvider = orderProviderCandidates(
    cfg.providers,
    runtime.activeModelHint,
  )[0];
  if (initialProvider) {
    runtime.activeModelHint = routeHint(
      runtime.activeModelHint,
      initialProvider.id,
      initialProvider.modelID,
    );
    runtime.lastProviderId = initialProvider.id;
    runtime.lastModelId = initialProvider.modelID;
  }

  runtime.chatMessages = await historyAsChatMessages(runtime.historyKey);
  if (!runtime.chatMessages.length) throw new EmptyConversationRunError();
  runtime.activeContextWindowTokens = resolveContextWindowTokensForModel(
    cfg.providers,
    runtime.activeModelHint,
    cfg.cursorIntegration,
  );
  if (
    savedRoute.contextWindowTokens &&
    (!savedRoute.providerId || savedRoute.providerId === runtime.lastProviderId) &&
    (!savedRoute.modelID || savedRoute.modelID === runtime.lastModelId)
  ) {
    runtime.activeContextWindowTokens = savedRoute.contextWindowTokens;
  }
  runtime.contextWindowProviderId = initialProvider?.id || savedRoute.providerId;
  runtime.contextWindowModelID = initialProvider?.modelID || savedRoute.modelID;
  runtime.checkpointUsedTokens = estimateChatContextTokens(runtime.chatMessages);
  await publishRuntimeCheckpoint(runtime, runtime.checkpointUsedTokens);

  const mappedWorkspace = runtime.stream.workspaceRoot ||
    (runtime.stream.conversationId
      ? await resolveConversationWorkspaceRoot(runtime.stream.conversationId)
      : undefined);
  throwIfStreamCancelled(runtime.requestId);
  if (mappedWorkspace && runtime.stream.conversationId) {
    setStreamConversationContext(
      runtime.requestId,
      runtime.stream.conversationId,
      mappedWorkspace,
    );
  }
  runtime.workspace = mappedWorkspace
    ? resolveWorkspaceRoot(mappedWorkspace)
    : undefined;
  runtime.initialized = true;
  await transitionStreamRuntime(runtime, { kind: "run" });
}

function launchProviderPreparation(
  runtime: StreamTurnRuntime,
  launch: ProviderLaunchEffect,
): void {
  if (runtime.terminal || runtime.providerPreparing) return;
  const cfg = runtime.cfg;
  if (!cfg) {
    void postStreamRuntimeEvent(runtime, {
      kind: "provider_preparation_failed",
      preparationToken: runtime.activePreparationToken,
      error: new Error("stream runtime is not initialized"),
    });
    return;
  }

  runtime.providerPreparing = true;
  runtime.preparationToken += 1;
  const preparationToken = runtime.preparationToken;
  runtime.activePreparationToken = preparationToken;
  const modelHint = runtime.activeModelHint;

  void (async () => {
    try {
      const persistedMessages = await historyMessagesSnapshot(runtime.historyKey);
      const structuredState = projectStructuredRuntimeState(
        persistedMessages,
        runtime.stream.conversationState,
      );
      const latestUserText = runtime.stream.messages
        .map((message) => String(message.content || "").trim())
        .filter(Boolean)
        .join("\n\n");
      await appendHistoryPromptContexts(
        runtime.historyKey,
        runtime.requestId,
        derivePromptContexts({
          mode: runtime.stream.mode,
          latestUserText,
          historyMessages: persistedMessages,
          structuredContexts: structuredRuntimePromptContexts(structuredState),
        }),
      );
      const messages = await historyAsPromptReplayMessages(runtime.historyKey);
      const compaction = await compactConversationHistory({
        historyKey: runtime.historyKey,
        messages,
        providers: cfg.providers,
        modelHint,
        globalContextWindowTokens:
          cfg.cursorIntegration.defaultContextWindowTokens,
        contextWindowTokensOverride: runtime.activeContextWindowTokens,
        signal: getStreamSignal(runtime.requestId),
        onStarted: () =>
          postStreamRuntimeEvent(runtime, {
            kind: "compaction_started",
            preparationToken,
          }),
        onSummary: (summary) =>
          postStreamRuntimeEvent(runtime, {
            kind: "compaction_summary",
            preparationToken,
            summary,
          }),
      });
      await postStreamRuntimeEvent(runtime, {
        kind: "provider_prepared",
        preparationToken,
        launch,
        compaction,
        structuredState,
      });
    } catch (error) {
      await postStreamRuntimeEvent(runtime, {
        kind: "provider_preparation_failed",
        preparationToken,
        error,
      });
    }
  })();
}

async function startProviderPass(
  runtime: StreamTurnRuntime,
  launch: ProviderLaunchEffect,
): Promise<void> {
  if (runtime.terminal) return;
  await transitionStreamRuntime(runtime, { kind: "provider_started" });
  const actorSnapshot = ensureActiveStreamActor(runtime.requestId).snapshot();
  if (actorSnapshot.providerPass !== launch.providerPass) {
    throw new Error(
      `provider pass ownership mismatch: expected ${launch.providerPass}, got ${actorSnapshot.providerPass}`,
    );
  }
  runtime.currentProviderPass = actorSnapshot.providerPass;
  runtime.currentProviderToken += 1;
  const providerToken = runtime.currentProviderToken;
  const providerPass = runtime.currentProviderPass;
  const modelCallId = randomUUID();
  const cfg = runtime.cfg!;
  const modeTools = toolsForMode(runtime.stream.mode);
  const tools = runtime.workspace
    ? modeTools
    : modeTools.filter(
      (tool) => !EXECUTABLE_TOOLS.has(tool.function.name),
    );
  const messages = [...runtime.chatMessages];
  const estimatedPromptTokens = Math.max(
    runtime.checkpointUsedTokens,
    estimateChatContextTokens(messages),
  );
  const maxCompletionTokens = remainingContextOutputBudget(
    runtime.activeContextWindowTokens,
    estimatedPromptTokens,
  );
  await publishRuntimeCheckpoint(runtime, estimatedPromptTokens);
  const modelHint = runtime.activeModelHint;
  const requestContext = createRequestContext({
    requestId: runtime.requestId,
    source: "agent",
    modelHint,
  });

  void (async () => {
    let streamedText = "";
    let reasoning: AssistantReasoningMetadata = {};
    let hadOutput = false;
    try {
      const result = await runProviderChatMessages(
        cfg.providers,
        messages,
        modelHint,
        {
          onText: (text) => {
            if (!text || isStreamCancelled(runtime.requestId)) return;
            hadOutput = true;
            streamedText += text;
            void postStreamRuntimeEvent(runtime, {
              kind: "provider_text",
              providerToken,
              providerPass,
              text,
            });
          },
          onThinking: (text) => {
            if (!text || isStreamCancelled(runtime.requestId)) return;
            hadOutput = true;
            reasoning = {
              ...reasoning,
              reasoningContent: (reasoning.reasoningContent || "") + text,
            };
            void postStreamRuntimeEvent(runtime, {
              kind: "provider_thinking",
              providerToken,
              providerPass,
              text,
            });
          },
          onReasoningMetadata: (metadata) => {
            if (isStreamCancelled(runtime.requestId)) return;
            reasoning = {
              ...reasoning,
              ...metadata,
              ...(metadata.reasoningContent
                ? { reasoningContent: metadata.reasoningContent }
                : {}),
            };
          },
        },
        {
          tools,
          toolChoice: "auto",
          requestContext,
          signal: getStreamSignal(runtime.requestId),
          timeoutMs: 180_000,
          maxCompletionTokens,
          globalContextWindowTokens:
            cfg.cursorIntegration.defaultContextWindowTokens,
          strictContextBudget: true,
          cursorNativeErrorBoundary: true,
        },
      );
      await postStreamRuntimeEvent(runtime, {
        kind: "provider_completed",
        providerToken,
        providerPass,
        modelCallId,
        estimatedPromptTokens,
        streamedText,
        result,
      });
    } catch (error) {
      await postStreamRuntimeEvent(runtime, {
        kind: "provider_failed",
        providerToken,
        providerPass,
        modelCallId,
        streamedText,
        reasoning,
        hadOutput,
        error,
      });
    }
  })();
}

function localToolFailure(invocation: RuntimeInvocation): ToolExecResult {
  return {
    callId: invocation.id,
    name: invocation.name,
    ok: false,
    content: "请重新打开需要处理的项目后再试。",
  };
}

function launchLocalTool(
  runtime: StreamTurnRuntime,
  pending: RuntimePendingTool,
): void {
  void (async () => {
    try {
      const result = !runtime.workspace && EXECUTABLE_TOOLS.has(pending.invocation.name)
        ? localToolFailure(pending.invocation)
        : pending.invocation.name === "CallMcpTool"
          ? await executeCallMcpLocal(pending.invocation)
          : await executeTool(pending.invocation, {
            workspaceRoot: runtime.workspace,
            requestId: runtime.requestId,
            stateKey: runtime.historyKey,
          });
      await postStreamRuntimeEvent(runtime, {
        kind: "external_result",
        pendingId: pending.id,
        result,
      });
    } catch (error) {
      await postStreamRuntimeEvent(runtime, {
        kind: "external_result",
        pendingId: pending.id,
        result: {
          callId: pending.invocation.id,
          name: pending.invocation.name,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
}

function reasoningMetadataFromProviderResult(
  result: ProviderChatResult,
): AssistantReasoningMetadata {
  return {
    ...(result.reasoningContent
      ? { reasoningContent: result.reasoningContent }
      : {}),
    ...(result.reasoningSignature
      ? { reasoningSignature: result.reasoningSignature }
      : {}),
    ...(result.reasoningSignatureSource
      ? { reasoningSignatureSource: result.reasoningSignatureSource }
      : {}),
    ...(result.openAIResponsesReasoningId
      ? { openAIResponsesReasoningId: result.openAIResponsesReasoningId }
      : {}),
    ...(result.openAIResponsesReasoningStatus
      ? { openAIResponsesReasoningStatus: result.openAIResponsesReasoningStatus }
      : {}),
    ...(result.openAIResponsesReasoningSummary != null
      ? {
        openAIResponsesReasoningSummary:
          result.openAIResponsesReasoningSummary,
      }
      : {}),
  };
}

async function openRuntimeTool(
  runtime: StreamTurnRuntime,
  invocation: RuntimeInvocation,
  modelCallId: string,
): Promise<RuntimePendingTool> {
  const bridgeKind = bridgeKindForTool(invocation.name);
  let pendingTool: RuntimePendingTool;

  if (bridgeKind === "interaction" || isInteractionTool(invocation.name)) {
    const messageId = nextMessageId();
    const interactionId = newInteractionId(messageId);
    const pending: PendingInteraction = {
      kind: "interaction",
      interactionId,
      messageId,
      toolCallId: invocation.id,
      name: invocation.name,
      argsJson: invocation.arguments,
      createdAt: Date.now(),
      modelCallId,
      providerPass: runtime.currentProviderPass,
      interactionKind: interactionKindOf(invocation.name),
      autoResume: shouldAutoResumeAfterInteraction(invocation.name),
    };
    pendingTool = {
      id: interactionId,
      modelCallId,
      external: {
        id: interactionId,
        kind: "interaction",
        name: invocation.name,
        autoResume: pending.autoResume,
      },
      invocation,
      kind: "interaction",
      pending,
      localFallback: false,
      fallbackStarted: false,
    };
    const response = registerPendingInteraction(
      runtime.requestId,
      pending,
      defaultBridgeTimeoutMs(invocation.name),
      getStreamSignal(runtime.requestId),
    );
    void response.then((result) =>
      postStreamRuntimeEvent(runtime, {
        kind: "external_result",
        pendingId: interactionId,
        result,
      }),
    );
  } else {
    const clientOnly = bridgeKind === "exec" &&
      !EXECUTABLE_TOOLS.has(invocation.name);
    const optionalClient = shouldUseClientBridge(invocation.name) &&
      EXECUTABLE_TOOLS.has(invocation.name);
    if (clientOnly || optionalClient) {
      const execId = newExecId(invocation.id);
      const messageId = nextMessageId();
      const pending: PendingExec = {
        kind: "exec",
        execId,
        messageId,
        toolCallId: invocation.id,
        name: invocation.name,
        argsJson: invocation.arguments,
        createdAt: Date.now(),
        modelCallId,
        providerPass: runtime.currentProviderPass,
      };
      pendingTool = {
        id: execId,
        modelCallId,
        external: {
          id: execId,
          kind: "exec",
          name: invocation.name,
          autoResume: true,
        },
        invocation,
        kind: "exec",
        pending,
        localFallback: optionalClient || invocation.name === "CallMcpTool",
        fallbackStarted: false,
      };
      const response = registerPending(
        runtime.requestId,
        pending,
        optionalClient ? 3_000 : defaultBridgeTimeoutMs(invocation.name),
        getStreamSignal(runtime.requestId),
      );
      void response.then((result) =>
        postStreamRuntimeEvent(runtime, {
          kind: "external_result",
          pendingId: execId,
          result,
        }),
      );
    } else {
      const localId = `local:${runtime.currentProviderPass}:${invocation.id}`;
      pendingTool = {
        id: localId,
        modelCallId,
        external: {
          id: localId,
          kind: "exec",
          name: invocation.name,
          autoResume: true,
        },
        invocation,
        kind: "local",
        localFallback: false,
        fallbackStarted: false,
      };
    }
  }

  runtime.pendingTools.set(pendingTool.id, pendingTool);
  await transitionStreamRuntime(runtime, {
    kind: "external_opened",
    pending: pendingTool.external,
  });
  return pendingTool;
}

function publishRuntimeToolRequest(
  runtime: StreamTurnRuntime,
  pending: RuntimePendingTool,
): void {
  if (pending.kind === "interaction") {
    const interaction = pending.pending as PendingInteraction;
    publish(runtime.requestId, {
      type: "interaction_query",
      interactionId: interaction.interactionId,
      callId: pending.invocation.id,
      name: pending.invocation.name,
      args: pending.invocation.args,
      messageId: interaction.messageId,
    });
    return;
  }
  if (pending.kind === "exec") {
    const exec = pending.pending as PendingExec;
    publish(runtime.requestId, {
      type: "exec_request",
      execId: exec.execId,
      callId: pending.invocation.id,
      name: pending.invocation.name,
      args: pending.invocation.args,
      messageId: exec.messageId,
    });
    return;
  }
  launchLocalTool(runtime, pending);
}

async function handleProviderCompleted(
  runtime: StreamTurnRuntime,
  event: Extract<StreamRuntimeEvent, { kind: "provider_completed" }>,
): Promise<void> {
  if (!isRuntimeCurrent(runtime, event.providerToken, event.providerPass)) return;
  const result = event.result;
  runtime.lastProviderId = result.providerId;
  runtime.lastModelId = result.modelID;
  runtime.activeModelHint = routeHint(
    runtime.activeModelHint,
    result.providerId,
    result.modelID,
  );
  const resolvedContextWindow = resolveContextWindowTokensForModel(
    runtime.cfg!.providers,
    `${result.providerId}:${result.modelID}`,
    runtime.cfg!.cursorIntegration,
  );
  const sameContextRoute =
    runtime.contextWindowProviderId === result.providerId &&
    runtime.contextWindowModelID === result.modelID;
  runtime.activeContextWindowTokens =
    sameContextRoute && runtime.activeContextWindowTokens > 1
      ? Math.min(runtime.activeContextWindowTokens, resolvedContextWindow)
      : resolvedContextWindow;
  runtime.contextWindowProviderId = result.providerId;
  runtime.contextWindowModelID = result.modelID;
  await updateHistoryRoute(runtime.historyKey, {
    modelHint: runtime.activeModelHint,
    providerId: result.providerId,
    modelID: result.modelID,
    contextWindowTokens: runtime.activeContextWindowTokens,
  });
  runtime.totalUsage = addUsage(runtime.totalUsage, result.usage);

  if (result.text && result.text !== event.streamedText) {
    const remainder = event.streamedText && result.text.startsWith(event.streamedText)
      ? result.text.slice(event.streamedText.length)
      : event.streamedText
        ? ""
        : result.text;
    for (let offset = 0; offset < remainder.length; offset += 64) {
      publish(runtime.requestId, {
        type: "text",
        text: remainder.slice(offset, offset + 64),
      });
    }
  }

  const toolCalls = sanitizeCreatePlanToolCallsForState(
    result.toolCalls || [],
    runtime.structuredState || {
      hasTodos: false,
      todos: [],
      plans: {},
    },
  );
  await appendAssistantWithTools(
    runtime.historyKey,
    result.text || "",
    toolCalls.length ? toolCalls : undefined,
    runtime.activeModelHint,
    {
      sourceRequestId: runtime.requestId,
      turnSequence: runtime.turnSequence,
    },
    reasoningMetadataFromProviderResult(result),
  );
  runtime.chatMessages = await historyAsChatMessages(runtime.historyKey);

  if (!toolCalls.length) {
    // Publish the ordinary text-only checkpoint only after the turn is
    // durably finalized. Emitting a running checkpoint here exposes completed
    // assistant output without a terminal loop marker, allowing Cursor to
    // submit a second resume before completeStreamRuntime closes the turn.
    await transitionStreamRuntime(runtime, {
      kind: "provider_finished",
      providerPass: event.providerPass,
      finishReason: result.finishReason,
      hadToolInvocation: false,
    });
    return;
  }

  // Tool turns must expose their pending calls before Cursor executes them.
  await publishRuntimeCheckpoint(
    runtime,
    Math.max(
      event.estimatedPromptTokens,
      result.usage.promptTokens + result.usage.completionTokens,
      estimateChatContextTokens(runtime.chatMessages),
    ),
  );

  const invocations: RuntimeInvocation[] = toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    args: parseToolArgs(toolCall.function.arguments),
  }));
  for (const invocation of invocations) {
    publish(runtime.requestId, {
      type: "tool_started",
      callId: invocation.id,
      name: invocation.name,
      args: invocation.args,
      modelCallId: event.modelCallId,
    });
    await openRuntimeTool(runtime, invocation, event.modelCallId);
  }
  await publishRuntimeCheckpoint(runtime);
  for (const invocation of invocations) {
    const pending = [...runtime.pendingTools.values()].find(
      (item) => item.invocation.id === invocation.id,
    );
    if (pending) publishRuntimeToolRequest(runtime, pending);
  }
  await transitionStreamRuntime(runtime, {
    kind: "provider_finished",
    providerPass: event.providerPass,
    finishReason: result.finishReason,
    hadToolInvocation: true,
    forceComplete: invocations.some(
      (invocation) => invocation.name === "CreatePlan",
    ),
  });
}

function isToolExecutionResult(
  result: ClientExecResult | ClientInteractionResult | ToolExecResult,
): result is ToolExecResult {
  return "content" in result;
}

async function handleExternalRuntimeResult(
  runtime: StreamTurnRuntime,
  event: Extract<StreamRuntimeEvent, { kind: "external_result" }>,
): Promise<void> {
  if (runtime.terminal) return;
  const pending = runtime.pendingTools.get(event.pendingId);
  if (!pending) return;

  if (
    pending.localFallback &&
    !pending.fallbackStarted &&
    !isToolExecutionResult(event.result) &&
    String(event.result.result || "").includes("client bridge timeout")
  ) {
    pending.fallbackStarted = true;
    launchLocalTool(runtime, pending);
    return;
  }

  let resultText: string;
  let ok: boolean;
  if (pending.kind === "interaction" && !isToolExecutionResult(event.result)) {
    const normalized = normalizeClientInteractionResult(
      pending.pending as PendingInteraction,
      event.result as ClientInteractionResult,
    );
    resultText = normalized.result;
    ok = normalized.ok;
  } else if (isToolExecutionResult(event.result)) {
    resultText = event.result.content;
    ok = event.result.ok;
  } else {
    resultText = event.result.result;
    ok = event.result.ok;
  }

  if (pending.invocation.name === "SwitchMode" && ok) {
    const targetMode = String(
      pending.invocation.args.target_mode_id ||
      pending.invocation.args.targetModeId ||
      "",
    ).trim();
    if (targetMode) {
      setStreamMode(runtime.requestId, targetMode);
      const modeChangeContext = derivePromptContexts({
        mode: targetMode,
        modeChanged: targetMode,
      }).filter((item) => item.source === "mode_change");
      await appendHistoryPromptContexts(
        runtime.historyKey,
        runtime.requestId,
        modeChangeContext,
      );
    }
  }

  await appendToolResult(
    runtime.historyKey,
    pending.invocation.id,
    pending.invocation.name,
    resultText,
    {
      sourceRequestId: runtime.requestId,
      turnSequence: runtime.turnSequence,
    },
  );
  publish(runtime.requestId, {
    type: "tool_completed",
    callId: pending.invocation.id,
    name: pending.invocation.name,
    result: resultText,
    ok,
    args: pending.invocation.args,
    modelCallId: pending.modelCallId,
  });
  runtime.chatMessages = await historyAsChatMessages(runtime.historyKey);
  await publishRuntimeCheckpoint(runtime);
  runtime.pendingTools.delete(pending.id);
  await transitionStreamRuntime(runtime, {
    kind: "external_completed",
    id: pending.external.id,
    externalKind: pending.external.kind,
  });
}

async function handleProviderFailure(
  runtime: StreamTurnRuntime,
  event: Extract<StreamRuntimeEvent, { kind: "provider_failed" }>,
): Promise<void> {
  if (!isRuntimeCurrent(runtime, event.providerToken, event.providerPass)) return;
  await transitionStreamRuntime(runtime, {
    kind: "provider_stopped",
    providerPass: event.providerPass,
  });
  await failStreamRuntime(runtime, event.error, {
    text: event.streamedText,
    reasoning: event.reasoning,
    modelHint: runtime.activeModelHint,
  });
}

async function handleProviderPrepared(
  runtime: StreamTurnRuntime,
  event: Extract<StreamRuntimeEvent, { kind: "provider_prepared" }>,
): Promise<void> {
  if (
    runtime.terminal ||
    !runtime.providerPreparing ||
    event.preparationToken !== runtime.activePreparationToken
  ) {
    return;
  }
  // Preparation completion is a generation-token event. Invalidate it before
  // any await so an identical mailbox event can never start a second pass.
  runtime.providerPreparing = false;
  runtime.activePreparationToken = 0;
  runtime.structuredState = event.structuredState;
  synchronizeTodoState(runtime.historyKey, event.structuredState.todos);
  runtime.chatMessages = await historyAsChatMessages(runtime.historyKey);
  const summaryStarted = runtime.summaryPreparationTokens.delete(
    event.preparationToken,
  );
  const compaction = event.compaction;
  if (compaction.compacted) {
    runtime.activeModelHint =
      compaction.modelHint || runtime.activeModelHint;
    if (compaction.providerId && compaction.modelID) {
      const resolvedContextWindow = resolveContextWindowTokensForModel(
        runtime.cfg!.providers,
        `${compaction.providerId}:${compaction.modelID}`,
        runtime.cfg!.cursorIntegration,
      );
      const sameContextRoute =
        runtime.contextWindowProviderId === compaction.providerId &&
        runtime.contextWindowModelID === compaction.modelID;
      runtime.activeContextWindowTokens =
        sameContextRoute && runtime.activeContextWindowTokens > 1
          ? Math.min(runtime.activeContextWindowTokens, resolvedContextWindow)
          : resolvedContextWindow;
      runtime.contextWindowProviderId = compaction.providerId;
      runtime.contextWindowModelID = compaction.modelID;
      const promptTokens = Math.max(
        compaction.usage.promptTokens,
        compaction.usage.cacheReadTokens + compaction.usage.cacheWriteTokens,
      );
      await recordTurnUsage({
        valid: true,
        requestTokens: promptTokens + compaction.usage.completionTokens,
        promptTokens,
        cacheReadTokens: compaction.usage.cacheReadTokens,
        cacheWriteTokens: compaction.usage.cacheWriteTokens,
        providerId: compaction.providerId,
        modelID: compaction.modelID,
        source: "agent",
        requestId: runtime.requestId,
      }).catch(() => undefined);
    }
    await publishRuntimeCheckpoint(
      runtime,
      estimateChatContextTokens(runtime.chatMessages),
      true,
    );
  }
  if (summaryStarted) {
    publish(runtime.requestId, {
      type: "summary_completed",
      hookMessage: runtime.requestId,
    });
    await transitionStreamRuntime(runtime, {
      kind: "compaction_finished",
      resumeProvider: false,
    });
  }
  if (compaction.blocked) {
    await failStreamRuntime(runtime, new ContextCompactionError());
    return;
  }
  await startProviderPass(runtime, event.launch);
}

async function handleProviderPreparationFailure(
  runtime: StreamTurnRuntime,
  event: Extract<StreamRuntimeEvent, { kind: "provider_preparation_failed" }>,
): Promise<void> {
  const bootstrapFailure =
    event.preparationToken === 0 &&
    runtime.activePreparationToken === 0 &&
    !runtime.providerPreparing;
  if (
    runtime.terminal ||
    (!bootstrapFailure &&
      (!runtime.providerPreparing ||
        event.preparationToken !== runtime.activePreparationToken))
  ) {
    return;
  }
  runtime.providerPreparing = false;
  runtime.activePreparationToken = 0;
  if (runtime.summaryPreparationTokens.delete(event.preparationToken)) {
    publish(runtime.requestId, {
      type: "summary_completed",
      hookMessage: runtime.requestId,
    });
    await transitionStreamRuntime(runtime, {
      kind: "compaction_finished",
      resumeProvider: false,
    });
  }
  await failStreamRuntime(runtime, event.error);
}

async function handleStreamRuntimeEvent(
  runtime: StreamTurnRuntime,
  event: StreamRuntimeEvent,
): Promise<void> {
  if (runtime.terminal) return;
  switch (event.kind) {
    case "initialize":
      await initializeStreamRuntime(runtime);
      return;
    case "inbound":
      await transitionStreamRuntime(runtime, {
        kind: "inbound",
        action: event.action,
      });
      return;
    case "provider_resume_ready":
      if (event.resumeToken !== runtime.resumeTimerToken) return;
      launchProviderPreparation(runtime, event.launch);
      return;
    case "compaction_started":
      if (event.preparationToken !== runtime.activePreparationToken) return;
      runtime.summaryPreparationTokens.add(event.preparationToken);
      await transitionStreamRuntime(runtime, { kind: "compaction_started" });
      publish(runtime.requestId, { type: "summary_started" });
      await publishRuntimeCheckpoint(runtime, runtime.checkpointUsedTokens);
      return;
    case "compaction_summary":
      if (event.preparationToken !== runtime.activePreparationToken) return;
      await persistThoughtAnnotation(runtime.requestId, event.summary);
      publish(runtime.requestId, { type: "summary", text: event.summary });
      return;
    case "provider_prepared":
      await handleProviderPrepared(runtime, event);
      return;
    case "provider_preparation_failed":
      await handleProviderPreparationFailure(runtime, event);
      return;
    case "provider_text":
      if (!isRuntimeCurrent(runtime, event.providerToken, event.providerPass)) return;
      publish(runtime.requestId, { type: "text", text: event.text });
      return;
    case "provider_thinking":
      if (!isRuntimeCurrent(runtime, event.providerToken, event.providerPass)) return;
      runtime.sawThinking = true;
      publish(runtime.requestId, { type: "thinking", text: event.text });
      return;
    case "provider_completed":
      await handleProviderCompleted(runtime, event);
      return;
    case "provider_failed":
      await handleProviderFailure(runtime, event);
      return;
    case "external_result":
      await handleExternalRuntimeResult(runtime, event);
      return;
    case "cancel":
      await cancelStreamRuntime(runtime, event.reason);
      return;
  }
}

function createStreamTurnRuntime(
  requestId: string,
  getConfig: () => Promise<AppConfig>,
): StreamTurnRuntime {
  const stream = ensureStream(requestId);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const runtime = {
    requestId,
    turnSequence: 0,
    getConfig,
    stream,
    historyKey: historyKeyForStream(requestId, stream.conversationId),
    mailbox: undefined as unknown as StreamActorMailbox<StreamRuntimeEvent>,
    done,
    resolveDone,
    terminal: false,
    initialized: false,
    chatMessages: [],
    activeContextWindowTokens: 1,
    contextWindowProviderId: undefined,
    contextWindowModelID: undefined,
    checkpointUsedTokens: 0,
    totalUsage: emptyUsage(),
    lastProviderId: "",
    lastModelId: "",
    thinkingStartedAt: Date.now(),
    sawThinking: false,
    currentProviderToken: 0,
    currentProviderPass: 0,
    preparationToken: 0,
    activePreparationToken: 0,
    summaryPreparationTokens: new Set<number>(),
    providerPreparing: false,
    resumeTimerToken: 0,
    pendingTools: new Map<string, RuntimePendingTool>(),
  } satisfies StreamTurnRuntime;
  runtime.mailbox = new StreamActorMailbox<StreamRuntimeEvent>(async (event) => {
    try {
      await handleStreamRuntimeEvent(runtime, event);
    } catch (error) {
      await failStreamRuntime(runtime, error);
    }
  });
  activeStreamRuntimes.set(requestId, runtime);
  return runtime;
}

async function runModelForStream(
  requestId: string,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  if (!markStarted(requestId)) return;
  const existing = activeStreamRuntimes.get(requestId);
  if (existing && !existing.terminal) {
    await existing.done;
    return;
  }
  const runtime = createStreamTurnRuntime(requestId, getConfig);
  publish(requestId, { type: "status", status: "running" });
  await postStreamRuntimeEvent(runtime, { kind: "initialize" });
  await runtime.done;
}

/**
 * Cursor's explicit RunRequest.action.summarize_action is a manual compaction
 * command with its own route, usage, and checkpoint lifecycle. A standalone
 * ConversationAction.summarize_action is metadata-only and never reaches here.
 */
async function runExplicitSummarizeForStream(
  requestId: string,
  getConfig: () => Promise<AppConfig>,
) {
  if (!markStarted(requestId)) return;
  const stream = ensureStream(requestId);
  const historyKey = historyKeyForStream(requestId, stream.conversationId);
  let providerId: string | undefined;
  let modelID: string | undefined;
  let effectiveContextWindowTokens: number | undefined;
  let summaryStarted = false;

  const closeSummaryLifecycle = async () => {
    if (!summaryStarted) return;
    publish(requestId, {
      type: "summary_completed",
      hookMessage: requestId,
    });
    await dispatchStreamLifecycle(requestId, {
      kind: "compaction_finished",
      resumeProvider: false,
    });
    summaryStarted = false;
  };

  const completeManualSummaryTurn = async () => {
    publish(requestId, {
      type: "turn_ended",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await dispatchStreamLifecycle(requestId, { kind: "complete" });
    publish(requestId, { type: "done" });
  };

  try {
    const cfg = await getConfig();
    if (cfg.routingMode === "upstream") {
      throw new Error("upstream mode");
    }

    const savedRoute = await historyRoute(historyKey);
    // Compression must stay on the model that produced this transcript. The
    // incoming action is only a fallback for legacy histories without a route.
    const savedModelHint = savedRoute.modelHint ||
      (savedRoute.providerId && savedRoute.modelID
        ? `${savedRoute.providerId}:${savedRoute.modelID}`
        : undefined);
    const routeModelHint = savedModelHint || stream.modelHint;
    const preferred = orderProviderCandidates(cfg.providers, routeModelHint)[0];
    if (!preferred) {
      throw new Error("No usable provider for conversation summary");
    }

    providerId = preferred.id;
    modelID = preferred.modelID;
    let modelHint = routeHint(routeModelHint, providerId, modelID);
    const messages = await historyAsPromptReplayMessages(historyKey);
    const savedWindowMatches =
      (!savedRoute.providerId || savedRoute.providerId === providerId) &&
      (!savedRoute.modelID || savedRoute.modelID === modelID);
    let maxTokens = savedWindowMatches && savedRoute.contextWindowTokens
      ? savedRoute.contextWindowTokens
      : resolveContextWindowTokensForModel(
        cfg.providers,
        `${providerId}:${modelID}`,
        cfg.cursorIntegration,
      );
    effectiveContextWindowTokens = maxTokens;
    if (!messages.length) {
      await dispatchStreamLifecycle(requestId, { kind: "compaction_started" });
      publish(requestId, { type: "summary_started" });
      summaryStarted = true;
      await publishConversationCheckpoint(requestId, historyKey, 0, maxTokens);
      await closeSummaryLifecycle();
      await completeManualSummaryTurn();
      return;
    }

    let compaction: Awaited<ReturnType<typeof compactConversationHistory>>;
    let recoveredContextLimit = false;
    while (true) {
      try {
        compaction = await compactConversationHistory({
          historyKey,
          messages,
          providers: cfg.providers,
          modelHint,
          globalContextWindowTokens: cfg.cursorIntegration.defaultContextWindowTokens,
          contextWindowTokensOverride: maxTokens,
          force: true,
          signal: getStreamSignal(requestId),
          onStarted: async () => {
            if (!summaryStarted) {
              await dispatchStreamLifecycle(requestId, { kind: "compaction_started" });
              publish(requestId, { type: "summary_started" });
              summaryStarted = true;
            }
            await publishConversationCheckpoint(
              requestId,
              historyKey,
              estimateChatContextTokens(messages),
              maxTokens,
            );
          },
          onSummary: async (summary) => {
            await persistThoughtAnnotation(requestId, summary);
            publish(requestId, { type: "summary", text: summary });
          },
        });
        break;
      } catch (error) {
        const reportedWindow = reportedContextWindowTokens(error);
        if (
          recoveredContextLimit ||
          !reportedWindow ||
          !isContextLimitProviderError(error) ||
          !isProviderRequestError(error)
        ) {
          throw error;
        }
        recoveredContextLimit = true;
        providerId = error.providerId;
        modelID = error.modelID;
        maxTokens = reportedWindow;
        effectiveContextWindowTokens = reportedWindow;
        modelHint = routeHint(modelHint, providerId, modelID);
        await updateHistoryRoute(historyKey, {
          modelHint,
          providerId,
          modelID,
          contextWindowTokens: reportedWindow,
        }).catch((routeError) => {
          console.warn("[forwarder] failed to persist summary context window", routeError);
        });
        if (summaryStarted) {
          await publishConversationCheckpoint(
            requestId,
            historyKey,
            estimateChatContextTokens(messages),
            maxTokens,
          ).catch((checkpointError) => {
            console.warn(
              "[forwarder] failed to publish corrected summary checkpoint",
              checkpointError,
            );
          });
        }
      }
    }
    providerId = compaction.providerId || providerId;
    modelID = compaction.modelID || modelID;
    if (!compaction.compacted && !summaryStarted) {
      await dispatchStreamLifecycle(requestId, { kind: "compaction_started" });
      publish(requestId, { type: "summary_started" });
      summaryStarted = true;
      await publishConversationCheckpoint(
        requestId,
        historyKey,
        estimateChatContextTokens(messages),
        maxTokens,
      );
      await closeSummaryLifecycle();
      await completeManualSummaryTurn();
      return;
    }
    if (compaction.blocked || !compaction.compacted) {
      throw new ContextCompactionError();
    }

    const promptTokens = Math.max(
      compaction.usage.promptTokens,
      compaction.usage.cacheReadTokens + compaction.usage.cacheWriteTokens,
    );
    if (providerId && modelID) {
      await updateHistoryRoute(historyKey, {
        modelHint: compaction.modelHint || modelHint,
        providerId,
        modelID,
        contextWindowTokens: maxTokens,
      });
      await recordTurnUsage({
        valid: true,
        requestTokens: promptTokens + compaction.usage.completionTokens,
        promptTokens,
        cacheReadTokens: compaction.usage.cacheReadTokens,
        cacheWriteTokens: compaction.usage.cacheWriteTokens,
        providerId,
        modelID,
        source: "agent",
        requestId,
      }).catch(() => undefined);
    }

    await publishConversationCheckpoint(
      requestId,
      historyKey,
      estimateChatContextTokens(compaction.messages),
      maxTokens,
    );
    await closeSummaryLifecycle();
    await completeManualSummaryTurn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isProviderRequestError(error)) {
      providerId = error.providerId;
      modelID = error.modelID;
    }
    if (providerId && modelID) {
      await recordTurnUsage({
        valid: false,
        error: message,
        providerId,
        modelID,
        source: "agent",
        requestId,
      }).catch(() => undefined);
    }
    await publishLatestConversationCheckpoint(
      requestId,
      historyKey,
      getConfig,
      providerId && modelID
        ? routeHint(stream.modelHint, providerId, modelID)
        : stream.modelHint,
      0,
      effectiveContextWindowTokens,
    ).catch((checkpointError) => {
      console.warn("[forwarder] failed to publish summary-error checkpoint", checkpointError);
    });
    await closeSummaryLifecycle().catch((lifecycleError) => {
      console.warn("[forwarder] failed to close summary lifecycle", lifecycleError);
    });
    const cursorError = cursorProviderError(error);
    publish(requestId, {
      type: "error",
      message: cursorError.message,
      code: cursorError.code,
      status: cursorError.status,
    });
  }
}

function writeConnectError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const accept = String(req.headers.accept || "").toLowerCase();
  const wantsConnectProto = ct.includes("connect+proto") || accept.includes("connect+proto");
  const wantsProto = ct.includes("application/proto") || accept.includes("application/proto");
  const wantsConnectJson = ct.includes("connect+json") || accept.includes("connect+json");

  if (wantsConnectProto || wantsConnectJson) {
    res.writeHead(status, {
      "Content-Type": wantsConnectProto
        ? "application/connect+proto"
        : "application/connect+json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    // Connect error trailer
    res.end(
      encodeConnectEndStream({
        code: status === 400 ? "invalid_argument" : "unknown",
        message,
      }),
    );
    return;
  }

  if (wantsProto) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ code: status === 400 ? "invalid_argument" : "unknown", message }));
    return;
  }

  writeJson(res, status, { error: message });
}

/**
 * 本地协议实现。
 * 1) 解析 BidiAppendRequest
 * 2) hex → AgentClientMessage → intent
 * 3) dispatch：exec/interaction 回填；run 写消息并拉起 provider
 * 4) 返回空 BidiAppendResponse
 *
 * 本地协议实现。
 */
export async function handleBidiAppend(
  req: IncomingMessage,
  res: ServerResponse,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  const buf = await readBody(req);
  const extracted = parseBidiAppendInbound(
    buf,
    req.headers["connect-content-encoding"],
  );
  const requestId = normalizeRequestId(extracted.requestId);

  if (!requestId) {
    const frameFlags = buf.length >= 1 ? buf.readUInt8(0) : undefined;
    const frameLength = buf.length >= 5 ? buf.readUInt32BE(1) : undefined;
    console.warn("[forwarder] bidi_append missing request_id", {
      path: extracted.path,
      kind: extracted.kind,
      hasData: extracted.hasDataField,
      bodyLen: buf.length,
      contentType: req.headers["content-type"],
      contentEncoding: req.headers["content-encoding"],
      connectContentEncoding: req.headers["connect-content-encoding"],
      connectAcceptEncoding: req.headers["connect-accept-encoding"],
      frameFlags,
      frameLength,
      firstBytes: buf.subarray(0, 32).toString("hex"),
    });
    writeConnectError(req, res, 400, "request_id is required");
    return;
  }

  if (extracted.kind === "prewarm" && !String(extracted.conversationId || "").trim()) {
    writeConnectError(req, res, 400, "conversation_id is required in prewarm_request");
    return;
  }

  if (
    extracted.kind === "user_run" &&
    extracted.agentMessageField === 1 &&
    !String(extracted.conversationId || "").trim()
  ) {
    writeConnectError(req, res, 400, "conversation_id is required in run_request");
    return;
  }

  const appendTicket = await acquireAppendSequence(
    requestId,
    extracted.appendSeqno,
  );
  if (appendTicket.stale) {
    console.log("[forwarder] ignored stale bidi_append", {
      requestId,
      appendSeqno: extracted.appendSeqno,
    });
    writeConnectEmpty(req, res);
    return;
  }

  try {
  console.log("[forwarder] bidi_append", {
    requestId,
    path: extracted.path,
    kind: extracted.kind,
    texts: extracted.texts.map((t) => t.slice(0, 80)),
    mode: extracted.mode,
    model: extracted.modelHint,
    seq: extracted.appendSeqno,
    pb: extracted.protobufDecoded,
  });

  if (extracted.kind === "unknown" && extracted.hasDataField) {
    writeConnectError(req, res, 400, "unsupported AgentClientMessage");
    return;
  }

  // Match the decode-before-dispatch boundary: an empty terminal Resume is
  // classified before this request is attached to the conversation broker.
  // Attaching it first leaves an ignored placeholder looking like an active
  // continuation, so the next reconnect can cancel/reconcile it and start a
  // second provider turn.
  const resumeGuardHistoryKey = historyKeyForStream(
    requestId,
    extracted.conversationId,
  );
  if (
    await shouldIgnoreEmptyResumeRunRequest(
      requestId,
      extracted,
      resumeGuardHistoryKey,
    )
  ) {
    console.log("[forwarder] ignored empty resume without pending continuation", {
      requestId,
      conversationId: extracted.conversationId,
    });
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "heartbeat") {
    // ClientHeartbeat is transport metadata. Acknowledge it without
    // opening a broker stream or advancing the provider state machine.
    writeConnectEmpty(req, res);
    return;
  }

  if (
    extracted.kind === "exec_control" &&
    extracted.execControl?.kind === "unknown"
  ) {
    writeConnectError(req, res, 400, "unsupported exec client control message");
    return;
  }

  const existingInboundStream = getStream(requestId);
  const terminalInboundStream = Boolean(existingInboundStream?.done);
  if (
    extracted.kind === "metadata" &&
    (!existingInboundStream?.conversationId || existingInboundStream.done)
  ) {
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "user_run" && extracted.agentMessageField === 4) {
    const activeConversationId = String(
      existingInboundStream?.conversationId || "",
    ).trim();
    if (!activeConversationId || existingInboundStream?.done) {
      writeConnectError(
        req,
        res,
        400,
        "conversation_action requires active request context",
      );
      return;
    }
    extracted.conversationId = activeConversationId;
  }

  // Keep a terminal broker briefly so late data/control/interaction
  // frames remain idempotent. It acknowledges every such frame without
  // recreating a runtime or advancing the provider state machine.
  if (
    terminalInboundStream &&
    (extracted.kind === "exec_result" ||
      extracted.kind === "exec_control" ||
      extracted.kind === "interaction_response")
  ) {
    writeConnectEmpty(req, res);
    return;
  }

  // Validate client-side results before touching the broker. Creating a
  // placeholder stream for an orphan result makes a later reconnect look like
  // an active continuation and can replay the current user turn.
  const activeInboundRuntime = liveStreamRuntime(requestId);
  if (extracted.kind === "exec_result" && extracted.execResult && !activeInboundRuntime) {
    writeConnectError(req, res, 400, `request is not active: ${requestId}`);
    return;
  }
  if (extracted.kind === "interaction_response" && !activeInboundRuntime) {
    writeConnectError(req, res, 400, `request is not active: ${requestId}`);
    return;
  }
  if (extracted.kind === "exec_control" && !activeInboundRuntime) {
    writeConnectError(req, res, 400, `request is not active: ${requestId}`);
    return;
  }

  if (extracted.conversationId) {
    setStreamConversationContext(requestId, extracted.conversationId);
    const workspaceRoot = await resolveConversationWorkspaceRoot(
      extracted.conversationId,
    );
    if (workspaceRoot) {
      setStreamConversationContext(
        requestId,
        extracted.conversationId,
        workspaceRoot,
      );
    }
  }

  if (extracted.kind === "user_run" || extracted.kind === "prewarm") {
    resetClientBridgeRequestState(requestId);
  }
  const inboundStream = ensureStream(requestId);
  if (extracted.conversationState?.length) {
    inboundStream.conversationState = Buffer.from(extracted.conversationState);
  }
  const inboundHistoryKey = historyKeyForStream(
    requestId,
    inboundStream.conversationId,
  );
  if (extracted.kind === "user_run") {
    if (extracted.mode) inboundStream.explicitMode = true;
    await cancelSupersededConversationRequests(
      inboundStream.conversationId,
      requestId,
      getConfig,
    );
  }
  if (extracted.kind === "user_run" || extracted.kind === "prewarm") {
    await reconcileCursorConversationState(
      requestId,
      inboundStream.conversationId,
      extracted.conversationState,
    );
  }

  // 客户端工具结果：只完成 pending，不启动新一轮模型
  if (extracted.kind === "exec_result" && extracted.execResult) {
    const recentlyCompleted = recentlyCompletedClientExec(
      requestId,
      extracted.execResult.messageId,
    );
    if (!liveStreamRuntime(requestId) && !recentlyCompleted) {
      writeConnectError(req, res, 400, `request is not active: ${requestId}`);
      return;
    }
    if (!liveStreamRuntime(requestId)) {
      writeConnectEmpty(req, res);
      return;
    }
    if (extracted.execResult.shellStream) {
      const appended = appendClientShellStream(requestId, {
        execId: extracted.execResult.execId,
        messageId: extracted.execResult.messageId,
        ...extracted.execResult.shellStream,
      });
      if (!appended && !recentlyCompleted) {
        writeConnectError(req, res, 400, "pending exec not found");
        return;
      }
      if (appended) await dispatchRuntimeInbound(requestId, "exec_result");
      writeConnectEmpty(req, res);
      return;
    }
    if (extracted.execResult.backgroundShell) {
      const observed = observeClientBackgroundShell(
        requestId,
        {
          execId: extracted.execResult.execId,
          messageId: extracted.execResult.messageId,
        },
        extracted.execResult.backgroundShell,
      );
      if (!observed && !recentlyCompleted) {
        writeConnectError(req, res, 400, "pending exec not found");
        return;
      }
      if (observed) await dispatchRuntimeInbound(requestId, "exec_result");
      writeConnectEmpty(req, res);
      return;
    }
    const resolved = resolveClientExec(requestId, {
      execId: extracted.execResult.execId,
      toolCallId: extracted.execResult.toolCallId,
      name: extracted.execResult.name,
      result: extracted.execResult.result,
      ok: extracted.execResult.ok,
      messageId: extracted.execResult.messageId,
    });
    if (!resolved && !recentlyCompleted) {
      writeConnectError(req, res, 400, "pending exec not found");
      return;
    }
    if (resolved) await dispatchRuntimeInbound(requestId, "exec_result");
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "interaction_response" && extracted.interactionResult) {
    if (!liveStreamRuntime(requestId)) {
      writeConnectError(req, res, 400, `request is not active: ${requestId}`);
      return;
    }
    const resolved = resolveClientInteraction(requestId, {
      interactionId: extracted.interactionResult.interactionId,
      messageId: extracted.interactionResult.messageId,
      toolCallId: extracted.interactionResult.toolCallId,
      name: extracted.interactionResult.name,
      result: extracted.interactionResult.result,
      ok: extracted.interactionResult.ok,
      structured: extracted.interactionResult.structured,
    });
    if (!resolved) {
      writeConnectError(req, res, 400, "pending interaction not found");
      return;
    }
    await dispatchRuntimeInbound(requestId, "interaction_result");
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "exec_control") {
    const control = extracted.execControl;
    const recentlyCompleted = recentlyCompletedClientExec(
      requestId,
      control?.messageId,
    );
    if (!liveStreamRuntime(requestId) && !recentlyCompleted) {
      writeConnectError(req, res, 400, `request is not active: ${requestId}`);
      return;
    }
    if (!liveStreamRuntime(requestId)) {
      writeConnectEmpty(req, res);
      return;
    }
    // Control frames are transport state, not new conversation turns. A throw
    // closes the matching client-bridge waiter; heartbeat and stream-close are
    // idempotent acknowledgements that Cursor may resend after reconnecting.
    if (control?.kind === "throw") {
      const resolved = resolveClientExec(requestId, {
        messageId: control.messageId,
        result: `Error: ${control.error || "client execution failed"}`,
        ok: false,
      });
      if (!resolved && !recentlyCompleted) {
        writeConnectError(req, res, 400, "pending exec not found for control message");
        return;
      }
      if (resolved) await dispatchRuntimeInbound(requestId, "exec_control");
    } else if (control?.kind === "stream_close") {
      const closed = closeClientShellStream(requestId, {
        messageId: control.messageId,
      });
      if (closed) await dispatchRuntimeInbound(requestId, "exec_control");
    } else if (control?.kind === "heartbeat") {
      heartbeatClientExec(requestId, { messageId: control.messageId });
      await dispatchRuntimeInbound(requestId, "exec_control");
    }
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "prewarm") {
    const stream = ensureStream(requestId);
    await dispatchRuntimeInbound(requestId, "prewarm");
    if (extracted.modelHint) stream.modelHint = extracted.modelHint;
    if (extracted.mode) setStreamMode(requestId, extracted.mode);

    const prewarmHistoryKey = historyKeyForStream(
      requestId,
      stream.conversationId,
    );
    await beginHistoryLoop(prewarmHistoryKey, requestId);
    const [cfg, savedRoute] = await Promise.all([
      getConfig(),
      historyRoute(prewarmHistoryKey),
    ]);
    const requestedModelHint =
      extracted.modelHint ||
      savedRoute.modelHint ||
      (savedRoute.providerId && savedRoute.modelID
        ? `${savedRoute.providerId}:${savedRoute.modelID}`
        : undefined);
    const preferred = orderProviderCandidates(
      cfg.providers,
      requestedModelHint,
    )[0];
    const resolvedModelHint = preferred
      ? routeHint(requestedModelHint, preferred.id, preferred.modelID)
      : requestedModelHint;

    // Prewarm is Cursor's route/checkpoint bootstrap. It must leave user
    // history untouched and must not start a provider call, but it does need
    // durable route metadata for the following real turn and summary action.
    await updateHistoryRoute(prewarmHistoryKey, {
      modelHint: resolvedModelHint,
      providerId: preferred?.id || savedRoute.providerId,
      modelID: preferred?.modelID || savedRoute.modelID,
    });
    if (resolvedModelHint) stream.modelHint = resolvedModelHint;

    const savedWindowMatches = Boolean(
      savedRoute.contextWindowTokens &&
      (!preferred?.id || !savedRoute.providerId || savedRoute.providerId === preferred.id) &&
      (!preferred?.modelID || !savedRoute.modelID || savedRoute.modelID === preferred.modelID),
    );
    const maxTokens = savedWindowMatches
      ? savedRoute.contextWindowTokens!
      : resolveContextWindowTokensForModel(
        cfg.providers,
        resolvedModelHint || requestedModelHint,
        cfg.cursorIntegration,
      );
    const messages = await historyAsChatMessages(prewarmHistoryKey);
    await publishConversationCheckpoint(
      requestId,
      prewarmHistoryKey,
      messages.length ? estimateChatContextTokens(messages) : 0,
      maxTokens,
    );
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "summarize") {
    const stream = ensureStream(requestId);
    if (extracted.modelHint) stream.modelHint = extracted.modelHint;
    if (extracted.mode) setStreamMode(requestId, extracted.mode);
    writeConnectEmpty(req, res);
    scheduleRun(
      requestId,
      () => {
        runStreamWorkInConversationLane(
          requestId,
          getConfig,
          runExplicitSummarizeForStream,
        );
      },
      { requireMessage: false },
    );
    return;
  }

  if (extracted.kind === "cancel") {
    console.log("[forwarder] cancel", { requestId });
    const stream = getStream(requestId);
    if (!stream || stream.done) {
      writeConnectEmpty(req, res);
      return;
    }
    if (await cancelRuntimeIfActive(requestId, "client_cancel")) {
      writeConnectEmpty(req, res);
      return;
    }
    const cancelHistoryKey = historyKeyForStream(
      requestId,
      stream?.conversationId,
    );
    // Cursor keeps client-side execs alive until it receives an explicit
    // ExecServerControl.abort. Publish those controls before the terminal
    // stream error closes RunSSE, then cancel all local bridge waiters.
    for (const pending of listPending(requestId)) {
      if (pending.kind !== "exec") continue;
      publish(requestId, {
        type: "exec_abort",
        messageId: pending.messageId,
      });
    }
    await dispatchStreamLifecycle(requestId, { kind: "cancel" }).catch(
      (actorError) => {
        console.warn("[forwarder] failed to transition direct cancel actor", actorError);
      },
    );
    // Abort before resolving route metadata so an in-flight completion cannot
    // win the race and later be overwritten by a cancellation record.
    cancelStream(requestId, "client_cancel", { deferTerminal: true });
    try {
      await pruneCanceledHistoryTurn(
        cancelHistoryKey,
        requestId,
        "client_cancel",
      ).catch((historyError) => {
        console.warn("[forwarder] failed to prune direct cancel history", historyError);
      });
      await finishHistoryLoop(
        cancelHistoryKey,
        requestId,
        "canceled",
      ).catch((historyError) => {
        console.warn("[forwarder] failed to persist direct cancel state", historyError);
      });
      const savedRoute = await historyRoute(cancelHistoryKey).catch(
        (routeError) => {
          console.warn("[forwarder] failed to load direct cancel route", routeError);
          return {} as Awaited<ReturnType<typeof historyRoute>>;
        },
      );
      const cfg = await getConfig().catch((configError) => {
        console.warn("[forwarder] failed to load direct cancel config", configError);
        return undefined;
      });
      const preferred = cfg
        ? orderProviderCandidates(
          cfg.providers,
          stream?.modelHint || savedRoute.modelHint,
        )[0]
        : undefined;
      await recordTerminalUsage(requestId, {
        valid: false,
        error: "client_cancel",
        providerId: savedRoute.providerId || preferred?.id,
        modelID: savedRoute.modelID || preferred?.modelID,
        source: "agent",
      }).catch((usageError) => {
        console.warn("[forwarder] failed to persist direct cancel usage", usageError);
      });
      await publishLatestConversationCheckpoint(
        requestId,
        cancelHistoryKey,
        getConfig,
        stream.modelHint || savedRoute.modelHint,
        0,
        savedRoute.contextWindowTokens,
      ).catch((checkpointError) => {
        console.warn("[forwarder] failed to publish cancel checkpoint", checkpointError);
      });
    } finally {
      publish(requestId, {
        type: "error",
        message: "cancelled: client_cancel",
        code: "canceled",
      });
    }
    writeConnectEmpty(req, res);
    return;
  }

  // run / metadata：写入用户文本与 mode
  const directContentParts = extracted.contentParts?.length
    ? extracted.contentParts
    : undefined;
  const hasDirectImage = Boolean(
    directContentParts?.some((part) => part.type === "image"),
  );
  // Prefer inline content decoded from the active Bidi request. Cursor's
  // SQLite bubble is only a fallback when that request did not include image
  // bytes, such as image paths persisted by older Cursor builds.
  const attachmentContent = !hasDirectImage && extracted.hasImageAttachment && extracted.conversationId &&
    (extracted.kind === "user_run" ||
      extracted.texts.length > 0 ||
      directContentParts?.length)
    ? await resolveCursorAttachmentContent(
      extracted.conversationId,
      requestId,
      extracted.texts.join("\n") || textFromContentParts(directContentParts),
    )
    : undefined;

  const directText = normalizePromptText(
    extracted.texts.join("\n") || textFromContentParts(directContentParts),
  );
  const fallbackImages = attachmentContent?.contentParts.filter(
    (part) => part.type === "image",
  ) || [];
  const content = directText || attachmentContent?.content || "";
  const contentParts = directContentParts
    ? [...directContentParts, ...fallbackImages]
    : attachmentContent?.contentParts;
  const structuredParts = contentParts?.length
    ? contentParts.some((part) => part.type === "text")
      ? contentParts
      : [
          {
            type: "text" as const,
            text: content || "Please analyze the attached image.",
          },
          ...contentParts,
        ]
    : undefined;
  const userMessageMetadata = {
    userMessageId: extracted.userMessageId,
    conversationTurnCount: extracted.conversationTurnCount,
    sourceRequestId: requestId,
  };

  // Cursor reuses a UserMessage ID when the user retries or edits a prior
  // turn. Remove that turn and its abandoned tail before the replacement is
  // queued, otherwise the provider sees both branches in its next prompt.
  // A missing persisted match is intentionally a no-op: this is the first
  // delivery of the message, not a rewind.
  if (
    extracted.kind === "user_run" &&
    extracted.conversationAction === "user_message" &&
    extracted.userMessageId
  ) {
    await rewindHistoryToUserMessage(
      inboundHistoryKey,
      extracted.userMessageId,
      extracted.conversationTurnCount,
    );
  }

  if (extracted.kind === "user_run") {
    // Cursor replay is imported at TurnSeq=0. Locally owned turns therefore
    // advance only from the durable history sequence, independent of how many
    // visible turns arrived inside the imported client checkpoint.
    const loop = await beginHistoryLoop(inboundHistoryKey, requestId);
    const turnSequence = loop.currentTurnSequence;
    const persistedContent = structuredParts?.length
      ? content || textFromContentParts(structuredParts)
      : content;
    if (persistedContent || structuredParts?.length) {
      await appendHistory(
        inboundHistoryKey,
        "user",
        persistedContent,
        extracted.modelHint,
        structuredParts,
        {
          cursorMessageId: extracted.userMessageId,
          sourceRequestId: requestId,
          ...(turnSequence ? { turnSequence } : {}),
        },
      );
      if (extracted.mode) {
        await appendHistoryPromptContexts(
          inboundHistoryKey,
          requestId,
          derivePromptContexts({
            mode: extracted.mode,
            modeChanged: extracted.mode,
          }).filter((item) => item.source === "mode_change"),
        );
      }
    }
  }

  if (structuredParts?.length) {
    appendUserMessage(
      requestId,
      {
        content: content || textFromContentParts(structuredParts),
        contentParts: structuredParts,
        ...userMessageMetadata,
      },
      extracted.modelHint,
      extracted.mode,
    );
  } else {
    for (const [index, text] of extracted.texts.entries()) {
      appendUserText(
        requestId,
        text,
        extracted.modelHint,
        extracted.mode,
        index === 0
          ? userMessageMetadata
          : { sourceRequestId: requestId },
      );
    }
    if (!extracted.texts.length) ensureStream(requestId);
  }
  if (extracted.modelHint) {
    ensureStream(requestId).modelHint = extracted.modelHint;
  }
  if (extracted.mode) setStreamMode(requestId, extracted.mode);

  writeConnectEmpty(req, res);

  const hasUserInput = extracted.texts.length > 0 ||
    Boolean(extracted.contentParts?.length);
  const shouldStart =
    extracted.kind === "user_run" ||
    (hasUserInput &&
      extracted.kind !== "empty" &&
      extracted.kind !== "unknown");

  if (!shouldStart) {
    if (extracted.kind === "metadata") {
      await dispatchRuntimeInbound(requestId, "metadata");
    }
    return;
  }

  scheduleRun(requestId, () => {
    runStreamWorkInConversationLane(
      requestId,
      getConfig,
      runModelForStream,
    );
  });
  } finally {
    appendTicket.release();
  }
}

/**
 * 本地协议实现。
 * 1) 仅解析 BidiRequestId
 * 2) 订阅 broker（可先于 Bidi 到达 → 占位 stream）
 * 3) 回放 backlog + 5s 心跳
 * 4) Content-Type 强制 text/event-stream（body 仍是 Connect protobuf 帧）
 *
 * 禁止：从 body 刮用户文本；禁止在此启动模型（模型只由 BidiAppend run 启动）
 */
export async function handleRunSSE(
  req: IncomingMessage,
  res: ServerResponse,
  _getConfig: () => Promise<AppConfig>,
): Promise<void> {
  const buf = await readBody(req);
  const extracted = parseRunSSEInbound(
    buf,
    req.headers["connect-content-encoding"],
  );
  const requestId = normalizeRequestId(extracted.requestId);

  if (!requestId) {
    console.warn("[forwarder] runsse missing request_id", { bodyLen: buf.length });
    writeConnectError(req, res, 400, "request_id is required");
    return;
  }

  console.log("[forwarder] runsse_subscribe", { requestId });

  ensureStream(requestId);

  const plan = detectStreamWireMode(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
    "X-Studio-Stream-Format": plan.mode,
  });

  const writer = createRunSseWriter(res, plan);
  const deliveredEvents = new Set<StreamEvent>();
  let terminalObserved = false;
  let finishTransport = () => undefined;
  const writeEv = (ev: StreamEvent) => {
    if (res.writableEnded || deliveredEvents.has(ev)) return;
    deliveredEvents.add(ev);
    writer.writeEvent(ev);
    if (ev.type === "done" || ev.type === "error") {
      terminalObserved = true;
      // publish() marks the broker terminal immediately after notifying live
      // subscribers. Close on the next microtask so that state transition is
      // visible before disconnect cleanup runs.
      queueMicrotask(() => finishTransport());
    }
  };

  const sub = subscribe(requestId, writeEv);
  cancelOrphanStreamTimer(requestId);
  for (const ev of sub.replay) writeEv(ev);

  // 注意：不在此 scheduleRun。若 Bidi 已写入消息且尚未 started，
  // 由 Bidi 侧 schedule 负责；此处只消费 broker。

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    writeEv({ type: "heartbeat" });
  }, 5000);

  let cleaned = false;
  const drainFinalBacklog = () => {
    if (res.writableEnded || res.destroyed) return;
    const stream = getStream(requestId);
    if (!stream) return;
    for (const event of stream.backlog) writeEv(event);
  };
  const cleanup = (terminalConsumed = false) => {
    if (cleaned) return;
    // Perform the final cursor read on connection shutdown. An event that
    // raced the close signal is consumed once before the subscriber detaches.
    drainFinalBacklog();
    cleaned = true;
    clearInterval(heartbeat);
    const remainingSubscribers = sub.unsubscribe();
    if (remainingSubscribers === 0) {
      const stream = getStream(requestId);
      if (terminalConsumed || !stream?.done) {
        if (!removeIfIdle(requestId)) {
          scheduleOrphanStreamCancellation(requestId);
        }
      }
      // If the peer disconnected while End was racing the socket close, keep
      // the terminal broker for reconnect replay instead of deleting it here.
    }
  };

  finishTransport = () => {
    if (cleaned) return;
    drainFinalBacklog();
    cleanup(true);
    if (!res.writableEnded) {
      try {
        if (plan.mode === "connect_proto" && !terminalObserved) {
          writer.endOk();
        }
        res.end();
      } catch {
        /* ignore */
      }
    }
  };

  req.on("aborted", () => cleanup(false));
  res.on("close", () => cleanup(false));

  // A terminal event may have been part of the initial replay before
  // finishTransport was assigned.
  if (terminalObserved || getStream(requestId)?.done) {
    queueMicrotask(() => finishTransport());
  }
}

export { writeJson };
