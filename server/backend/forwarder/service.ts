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
 * 工具循环：
 * model(+tools) → tool_calls → 本地/客户端 bridge → 回灌 → 继续，最多 MAX_TOOL_ROUNDS
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
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
  markStarted,
  publish,
  scheduleRun,
  setStreamConversationContext,
  setStreamMode,
  subscribe,
  type StreamEvent,
} from "../agent/broker";
import {
  addUsage,
  emptyUsage,
  estimateChatMessagesTokens,
  orderProviderCandidates,
  runProviderChatMessages,
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
  appendToolResult,
  historyAsChatMessages,
} from "./history";
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
  type ToolExecResult,
} from "./tool-exec";
import {
  bridgeKindForTool,
  defaultBridgeTimeoutMs,
  interactionKindOf,
  newExecId,
  newInteractionId,
  nextMessageId,
  registerPending,
  registerPendingInteraction,
  resolveClientExec,
  resolveClientInteraction,
  shouldUseClientBridge,
  type PendingExec,
  type PendingInteraction,
} from "./client-bridge";

const MAX_TOOL_ROUNDS = 8;

const MAX_DECOMPRESSED_BODY_BYTES = 64 * 1024 * 1024;
const CONTEXT_OUTPUT_RESERVE_TOKENS = 1024;
const ATTACHMENT_LOOKBACK_MS = 5 * 60 * 1000;
const ATTACHMENT_READ_ATTEMPTS = 3;
const ATTACHMENT_RETRY_DELAY_MS = 35;
const MAX_CURSOR_IMAGE_BYTES = 25 * 1024 * 1024;

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

async function runModelForStream(
  requestId: string,
  getConfig: () => Promise<AppConfig>,
) {
  if (!markStarted(requestId)) return;
  const s = ensureStream(requestId);
  const historyKey = historyKeyForStream(requestId, s.conversationId);
  publish(requestId, { type: "status", status: "running" });

  const thinkingStartedAt = Date.now();
  let sawThinking = false;
  let totalUsage: ChatUsage = emptyUsage();
  let lastProviderId = "";
  let lastModelId = "";
  let finalText = "";

  try {
    const cfg = await getConfig();
    if (cfg.routingMode === "upstream") {
      publish(requestId, {
        type: "error",
        message: "当前为直连模式，本地引擎不处理请求",
      });
      await recordTurnUsage({ valid: false, error: "upstream mode" }).catch(
        () => undefined,
      );
      return;
    }

    for (const message of s.messages) {
      await appendHistory(
        historyKey,
        "user",
        message.content,
        s.modelHint,
        message.contentParts,
      );
    }

    let chatMessages: ChatMessage[] = await historyAsChatMessages(historyKey);
    if (!chatMessages.length) {
      chatMessages = [{ role: "user", content: "Hello" }];
    }

    // This checkpoint is the runtime source Cursor persists for its context
    // indicator. It must use the same resolver as AvailableModels and the
    // GetEffectiveTokenLimit RPC so saved settings apply to active sessions.
    const initialProvider = orderProviderCandidates(cfg.providers, s.modelHint)[0];
    const initialContextHint = initialProvider
      ? `${initialProvider.id}:${initialProvider.modelID}`
      : s.modelHint;
    let activeContextWindowTokens = resolveContextWindowTokensForModel(
      cfg.providers,
      initialContextHint,
      cfg.cursorIntegration,
    );
    let checkpointUsedTokens = estimateChatContextTokens(chatMessages);
    const publishContextCheckpoint = (usedTokens: number) => {
      checkpointUsedTokens = normalizeCheckpointTokens(
        usedTokens,
        activeContextWindowTokens,
      );
      publish(requestId, {
        type: "checkpoint",
        usedTokens: checkpointUsedTokens,
        maxTokens: activeContextWindowTokens,
      });
    };
    publishContextCheckpoint(checkpointUsedTokens);

    const mappedWorkspace = s.workspaceRoot ||
      (s.conversationId
        ? await resolveConversationWorkspaceRoot(s.conversationId)
        : undefined);
    if (mappedWorkspace && s.conversationId) {
      setStreamConversationContext(requestId, s.conversationId, mappedWorkspace);
    }
    // A Cursor transport request is not tied to this process' cwd. If its
    // conversation cannot be mapped, do not let local tools act on Studio.
    const workspace = mappedWorkspace
      ? resolveWorkspaceRoot(mappedWorkspace)
      : undefined;
    const tools = workspace
      ? toolsForMode(s.mode)
      : toolsForMode(s.mode).filter(
        (tool) => !EXECUTABLE_TOOLS.has(tool.function.name),
      );

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (isStreamCancelled(requestId)) {
        throw new Error("AbortError: client cancelled");
      }
      const requestContext = createRequestContext({
        requestId,
        source: "agent",
        modelHint: s.modelHint,
      });
      const estimatedPromptTokens = Math.max(
        checkpointUsedTokens,
        estimateChatContextTokens(chatMessages),
      );
      const maxCompletionTokens = remainingContextOutputBudget(
        activeContextWindowTokens,
        estimatedPromptTokens,
      );
      publishContextCheckpoint(estimatedPromptTokens);
      const result = await runProviderChatMessages(
        cfg.providers,
        chatMessages,
        s.modelHint,
        {
          onText: (delta) => {
            if (isStreamCancelled(requestId)) return;
            if (delta) {
              finalText += delta;
              publish(requestId, { type: "text", text: delta });
            }
          },
          onThinking: (delta) => {
            if (isStreamCancelled(requestId)) return;
            if (delta) {
              sawThinking = true;
              publish(requestId, { type: "thinking", text: delta });
            }
          },
        },
        {
          tools,
          toolChoice: "auto",
          requestContext,
          signal: getStreamSignal(requestId),
          timeoutMs: 180_000,
          maxCompletionTokens,
          globalContextWindowTokens: cfg.cursorIntegration.defaultContextWindowTokens,
        },
      );

      lastProviderId = result.providerId;
      lastModelId = result.modelID;
      activeContextWindowTokens = resolveContextWindowTokensForModel(
        cfg.providers,
        `${result.providerId}:${result.modelID}`,
        cfg.cursorIntegration,
      );
      if (result.routeReason) {
        console.log("[forwarder] route", {
          requestId,
          providerId: result.providerId,
          modelID: result.modelID,
          routeReason: result.routeReason,
        });
      }
      totalUsage = addUsage(totalUsage, result.usage);
      publishContextCheckpoint(
        Math.max(
          estimatedPromptTokens,
          result.usage.promptTokens + result.usage.completionTokens,
        ),
      );

      // 非流补推文本
      if (result.text) {
        const already = s.backlog
          .filter((e) => e.type === "text")
          .map((e) => (e as { text: string }).text)
          .join("");
        if (!already.includes(result.text) && result.text.length > already.length) {
          // 若 stream 已推过前缀，只补差量
          if (already && result.text.startsWith(already)) {
            const rest = result.text.slice(already.length);
            if (rest) {
              finalText += rest;
              publish(requestId, { type: "text", text: rest });
            }
          } else if (!already) {
            finalText = result.text;
            const chunkSize = 64;
            for (let i = 0; i < result.text.length; i += chunkSize) {
              publish(requestId, {
                type: "text",
                text: result.text.slice(i, i + chunkSize),
              });
            }
          }
        }
      }

      const toolCalls = result.toolCalls || [];
      await appendAssistantWithTools(
        historyKey,
        result.text || "",
        toolCalls.length ? toolCalls : undefined,
        result.modelID,
      );

      if (!toolCalls.length) {
        break;
      }

      // 执行工具：本地 exec 或客户端 bridge
      const invocations = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      for (const inv of invocations) {
        publish(requestId, {
          type: "tool_started",
          callId: inv.id,
          name: inv.name,
          args: parseToolArgs(inv.arguments),
        });
      }

      const results: ToolExecResult[] = [];
      for (const inv of invocations) {
        const kind = bridgeKindForTool(inv.name);

        if (!workspace && EXECUTABLE_TOOLS.has(inv.name)) {
          results.push({
            callId: inv.id,
            name: inv.name,
            ok: false,
            content: "请重新打开要分析的项目后再试。",
          });
          continue;
        }

        // 交互桥：AskQuestion / CreatePlan / SwitchMode / WebSearch
        if (kind === "interaction" || isInteractionTool(inv.name)) {
          const messageId = nextMessageId();
          const interactionId = newInteractionId(messageId);
          const pending: PendingInteraction = {
            kind: "interaction",
            interactionId,
            messageId,
            toolCallId: inv.id,
            name: inv.name,
            argsJson: inv.arguments,
            createdAt: Date.now(),
            interactionKind: interactionKindOf(inv.name),
          };
          publish(requestId, {
            type: "interaction_query",
            interactionId,
            callId: inv.id,
            name: inv.name,
            args: parseToolArgs(inv.arguments),
            messageId,
          });
          publish(requestId, {
            type: "status",
            status: `await_interaction:${interactionId}`,
          });
          const clientRes = await registerPendingInteraction(
            requestId,
            pending,
            defaultBridgeTimeoutMs(inv.name),
          );
          results.push({
            callId: inv.id,
            name: inv.name,
            ok: clientRes.ok,
            content: clientRes.result,
          });
          continue;
        }

        // 执行桥-only（CallMcpTool / Task / …）
        if (kind === "exec" && !EXECUTABLE_TOOLS.has(inv.name)) {
          const execId = newExecId(inv.id);
          const messageId = nextMessageId();
          const pending: PendingExec = {
            kind: "exec",
            execId,
            messageId,
            toolCallId: inv.id,
            name: inv.name,
            argsJson: inv.arguments,
            createdAt: Date.now(),
          };
          publish(requestId, {
            type: "exec_request",
            execId,
            callId: inv.id,
            name: inv.name,
            args: parseToolArgs(inv.arguments),
            messageId,
          });
          publish(requestId, {
            type: "status",
            status: `await_client_exec:${execId}`,
          });
          const clientRes = await registerPending(
            requestId,
            pending,
            defaultBridgeTimeoutMs(inv.name),
          );
          const timedOut = String(clientRes.result).includes("client bridge timeout");
          // CallMcpTool：客户端超时后回落本地 mcp.json tools/call
          if (timedOut && inv.name === "CallMcpTool") {
            publish(requestId, {
              type: "status",
              status: `local_mcp_fallback:${inv.id}`,
            });
            const local = await executeCallMcpLocal(inv);
            results.push(local);
            continue;
          }
          results.push({
            callId: inv.id,
            name: inv.name,
            ok: clientRes.ok,
            content: clientRes.result,
          });
          continue;
        }

        // 默认可本地执行；若强制 CLIENT_BRIDGE=1 则先发 bridge，超时回落本地
        if (shouldUseClientBridge(inv.name) && EXECUTABLE_TOOLS.has(inv.name)) {
          const execId = newExecId(inv.id);
          const messageId = nextMessageId();
          const pending: PendingExec = {
            kind: "exec",
            execId,
            messageId,
            toolCallId: inv.id,
            name: inv.name,
            argsJson: inv.arguments,
            createdAt: Date.now(),
          };
          publish(requestId, {
            type: "exec_request",
            execId,
            callId: inv.id,
            name: inv.name,
            args: parseToolArgs(inv.arguments),
            messageId,
          });
          const clientRes = await registerPending(requestId, pending, 3_000);
          if (!String(clientRes.result).includes("client bridge timeout")) {
            results.push({
              callId: inv.id,
              name: inv.name,
              ok: clientRes.ok,
              content: clientRes.result,
            });
            continue;
          }
          // 超时回落本地
        }

        const local = await executeTool(inv, {
          workspaceRoot: workspace,
          requestId,
        });
        results.push(local);
      }

      for (const r of results) {
        publish(requestId, {
          type: "tool_completed",
          callId: r.callId,
          name: r.name,
          result: r.content,
          ok: r.ok,
        });
        await appendToolResult(historyKey, r.callId, r.name, r.content);
      }

      // 下一轮从 history 拉全量（含 tool 结果）
      chatMessages = await historyAsChatMessages(historyKey);
      publishContextCheckpoint(
        Math.max(checkpointUsedTokens, estimateChatContextTokens(chatMessages)),
      );
      // 新一轮文本另起，避免重复拼接
      finalText = "";
    }

    if (sawThinking) {
      publish(requestId, {
        type: "thinking_done",
        durationMs: Date.now() - thinkingStartedAt,
      });
    }

    const cacheRead = totalUsage.cacheReadTokens;
    const cacheWrite = totalUsage.cacheWriteTokens;
    const rawPrompt = totalUsage.promptTokens;
    const completion = totalUsage.completionTokens;
    const promptTotal = Math.max(rawPrompt, cacheRead + cacheWrite);
    const inputTokens = Math.max(0, promptTotal - cacheRead - cacheWrite);
    const requestTotal = promptTotal + completion;

    const completedMessages = await historyAsChatMessages(historyKey);
    publishContextCheckpoint(
      Math.max(
        checkpointUsedTokens,
        estimateChatContextTokens(completedMessages),
        rawPrompt + completion,
      ),
    );

    publish(requestId, {
      type: "usage",
      promptTokens: promptTotal,
      completionTokens: completion,
      cacheRead,
      cacheWrite,
    });

    publish(requestId, {
      type: "turn_ended",
      inputTokens,
      outputTokens: completion,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    await recordTurnUsage({
      valid: true,
      requestTokens: requestTotal,
      promptTokens: promptTotal,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      providerId: lastProviderId,
      modelID: lastModelId,
      source: "agent",
      requestId,
    });

    publish(requestId, { type: "done" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cancelled =
      isStreamCancelled(requestId) || /abort|cancel/i.test(msg);
    if (cancelled) {
      // cancelStream may already have published error/done
      const st = getStream(requestId);
      if (st && !st.done) {
        publish(requestId, { type: "error", message: msg });
        publish(requestId, { type: "done" });
      }
      await recordTurnUsage({ valid: false, error: "client_cancel", source: "agent", requestId }).catch(
        () => undefined,
      );
      return;
    }
    publish(requestId, { type: "error", message: msg });
    await recordTurnUsage({ valid: false, error: msg, source: "agent", requestId }).catch(() => undefined);
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
  const extracted = parseBidiAppendInbound(buf);
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

  // 客户端工具结果：只完成 pending，不启动新一轮模型
  if (extracted.kind === "exec_result" && extracted.execResult) {
    ensureStream(requestId);
    resolveClientExec(requestId, {
      execId: extracted.execResult.execId,
      toolCallId: extracted.execResult.toolCallId,
      name: extracted.execResult.name,
      result: extracted.execResult.result,
      ok: extracted.execResult.ok,
      messageId: extracted.execResult.messageId,
    });
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "interaction_response" && extracted.interactionResult) {
    ensureStream(requestId);
    resolveClientInteraction(requestId, {
      interactionId: extracted.interactionResult.interactionId,
      messageId: extracted.interactionResult.messageId,
      toolCallId: extracted.interactionResult.toolCallId,
      name: extracted.interactionResult.name,
      result: extracted.interactionResult.result,
      ok: extracted.interactionResult.ok,
    });
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "heartbeat") {
    ensureStream(requestId);
    writeConnectEmpty(req, res);
    return;
  }

  if (extracted.kind === "cancel") {
    console.log("[forwarder] cancel", { requestId });
    cancelStream(requestId, "client_cancel");
    await recordTurnUsage({
      valid: false,
      error: "client_cancel",
      providerId: undefined,
      modelID: undefined,
    }).catch(() => undefined);
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

  if (contentParts?.length) {
    const structuredParts = contentParts.some((part) => part.type === "text")
      ? contentParts
      : [{ type: "text" as const, text: content || "Please analyze the attached image." }, ...contentParts];
    appendUserMessage(
      requestId,
      {
        content: content || textFromContentParts(structuredParts),
        contentParts: structuredParts,
      },
      extracted.modelHint,
      extracted.mode,
    );
  } else {
    for (const t of extracted.texts) {
      appendUserText(requestId, t, extracted.modelHint, extracted.mode);
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

  if (!shouldStart) return;

  scheduleRun(requestId, () => {
    void runModelForStream(requestId, getConfig);
  });
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
  const extracted = parseRunSSEInbound(buf);
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
  const writeEv = (ev: StreamEvent) => {
    if (res.writableEnded) return;
    writer.writeEvent(ev);
  };

  const sub = subscribe(requestId, writeEv);
  for (const ev of sub.replay) writeEv(ev);

  // 注意：不在此 scheduleRun。若 Bidi 已写入消息且尚未 started，
  // 由 Bidi 侧 schedule 负责；此处只消费 broker。

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    writeEv({ type: "heartbeat" });
  }, 5000);

  let checkDone: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    clearInterval(heartbeat);
    if (checkDone) clearInterval(checkDone);
    sub.unsubscribe();
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  checkDone = setInterval(() => {
    const st = getStream(requestId);
    if (st?.done) {
      cleanup();
      if (!res.writableEnded) {
        try {
          if (plan.mode === "connect_proto") {
            writer.endOk();
          }
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  }, 200);
}

export { writeJson };
