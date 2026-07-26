/**
 * 供应商聊天补全（OpenAI / Anthropic 兼容）
 * - 流式文本 / thinking
 * - tools + tool_calls 多轮
 */
import { createHash } from "node:crypto";
import type { ModelProvider } from "../../config/store";
import { DefaultCursorContextWindowTokens } from "../../runtime/defaults";
import { getActiveSystemPrompt } from "../../workspace/prompts-store";
import type { ToolDefinition } from "../forwarder/tool-catalog";
import { toAnthropicTools } from "../forwarder/tool-catalog";
import {
  isProviderCoolingDown,
  recordProviderFailure,
  recordProviderSuccess,
} from "../../providers/provider-health";
import {
  createRequestContext,
  markError,
  markRoute,
  type RequestContext,
  type RouteReason,
} from "../request-context";
import { shouldFailover } from "../error-map";
import {
  ESTIMATED_TOKENS_PER_IMAGE_PART,
  imageDataUrl,
  imagePartsFromContentParts,
  normalizeImageMimeType,
  textFromContentParts,
  type ChatContentPart,
} from "./content-parts";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Stateless OpenAI Responses replay metadata. */
  openAIResponsesId?: string;
  openAIResponsesCallId?: string;
  openAIResponsesStatus?: string;
};

export type AssistantReasoningMetadata = {
  reasoningContent?: string;
  reasoningSignature?: string;
  reasoningSignatureSource?: "anthropic" | "openai_responses" | string;
  openAIResponsesReasoningId?: string;
  openAIResponsesReasoningStatus?: string;
  openAIResponsesReasoningSummary?: unknown;
};

export type ChatMessage =
  | {
      role: "system" | "user";
      content: string;
      /** Structured content is used when Cursor attaches images to a turn. */
      contentParts?: ChatContentPart[];
    }
  | {
      role: "assistant";
      content: string;
      tool_calls?: ToolCall[];
    } & AssistantReasoningMetadata
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatResult = {
  text: string;
  usage: ChatUsage;
  toolCalls?: ToolCall[];
  finishReason?: string;
  routeReason?: RouteReason;
  requestId?: string;
} & AssistantReasoningMetadata;

export type StreamHandlers = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** Provider replay metadata can arrive before the stream terminates. */
  onReasoningMetadata?: (metadata: AssistantReasoningMetadata) => void;
  onUsage?: (usage: Partial<ChatUsage>) => void;
};

export type ChatOptions = {
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  /** Internal maintenance calls such as context compression must not inherit a user prompt. */
  includeManagedSystemPrompt?: boolean;
  /** Per-run output ceiling computed from the active context window. */
  maxCompletionTokens?: number;
  /** Studio-wide fallback used when the model and provider omit a context window. */
  globalContextWindowTokens?: number;
  /**
   * Keep the caller's transcript intact. The Cursor forwarding path uses this
   * so a smaller failover model triggers model-backed compaction instead of
   * silently dropping earlier turns before the upstream request.
   */
  strictContextBudget?: boolean;
  /**
   * Cursor Agent owns retries and error presentation. When enabled, execute
   * exactly one request on the selected route and surface its terminal error
   * without local retry or provider failover.
   */
  cursorNativeErrorBoundary?: boolean;
  /** Abort in-flight upstream fetch (client cancel / local timeout). */
  signal?: AbortSignal;
  /** Overall upstream timeout ms (default 180s). */
  timeoutMs?: number;
};

export class ProviderRequestError extends Error {
  readonly providerId: string;
  readonly modelID: string;
  readonly status?: number;

  constructor(
    cause: unknown,
    provider: Pick<ModelProvider, "id" | "modelID">,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "ProviderRequestError";
    this.providerId = provider.id;
    this.modelID = provider.modelID;
    this.status = providerErrorStatus(message);
  }
}

class ProviderStreamEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStreamEventError";
  }
}

export function isProviderRequestError(
  value: unknown,
): value is ProviderRequestError {
  return value instanceof ProviderRequestError;
}

/** Context-limit errors must reach the forwarder for model-backed recovery. */
function isContextLimitProviderMessage(message: string): boolean {
  const value = String(message || "");
  const status = providerErrorStatus(value);
  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status != null && status >= 500)
  ) {
    return false;
  }
  if (
    /(?:completion|output).{0,32}tokens?.{0,32}(?:limit|maximum|max|exceed)/i.test(value) ||
    /(?:limit|maximum|max|exceed).{0,32}(?:completion|output).{0,32}tokens?/i.test(value)
  ) {
    return false;
  }
  return [
    /context[_\s-]*(?:length|window|limit|size|exceed)/i,
    /(?:maximum|max)[_\s-]*(?:context|input|token)/i,
    /(?:prompt|input).{0,64}(?:too[_\s-]?long|too[_\s-]?large|exceed|limit|length)/i,
    /(?:too[_\s-]?many|exceeds?|exceeded).{0,64}tokens?/i,
    /tokens?.{0,64}(?:exceed|exceeded|limit|length|maximum|max)/i,
  ].some((pattern) => pattern.test(value));
}

function providerErrorStatus(message: string): number | undefined {
  const match = String(message || "").match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function attachProviderRoute(
  error: unknown,
  provider: Pick<ModelProvider, "id" | "modelID">,
): ProviderRequestError {
  if (isProviderRequestError(error)) return error;
  return new ProviderRequestError(error, provider);
}

function streamEventError(
  provider: string,
  event: Record<string, unknown>,
): ProviderStreamEventError {
  const response = event.response as Record<string, unknown> | undefined;
  const detail =
    (event.error as Record<string, unknown> | undefined) ||
    (response?.error as Record<string, unknown> | undefined) ||
    event;
  const values = [
    optionalString(detail.type),
    optionalString(detail.code),
    optionalString(detail.status),
    optionalString(event.request_id),
  ].filter(Boolean);
  const suffix = values.length ? ` (${values.join(", ")})` : "";
  return new ProviderStreamEventError(
    `${provider} stream error${suffix}: ${optionalString(detail.message) || "provider failed"}`,
  );
}


const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000;
const DEFAULT_CONTEXT_AWARE_OUTPUT_TOKENS = 65_536;

function mergeAbortSignals(
  user?: AbortSignal,
  timeoutMs?: number,
): { signal?: AbortSignal; cleanup: () => void } {
  const timeout = timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const parts: AbortSignal[] = [];
  if (user) parts.push(user);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutController: AbortController | undefined;
  if (timeout > 0) {
    timeoutController = new AbortController();
    timer = setTimeout(() => {
      timeoutController?.abort(`upstream_timeout_${timeout}ms`);
    }, timeout);
    parts.push(timeoutController.signal);
  }
  if (!parts.length) return { cleanup: () => undefined };
  // Node 20+: AbortSignal.any
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return {
      signal: anyFn(parts),
      cleanup: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }
  // Fallback: prefer user signal, still honor timeout controller alone if no user
  const controller = new AbortController();
  const onAbort = () => {
    try {
      controller.abort("merged_abort");
    } catch {
      /* ignore */
    }
  };
  for (const s of parts) {
    if (s.aborted) onAbort();
    else s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      for (const s of parts) {
        try {
          s.removeEventListener("abort", onAbort);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function fetchUpstream(
  url: string,
  init: RequestInit,
  opts?: ChatOptions,
): Promise<Response> {
  if (opts?.signal?.aborted) {
    throw new Error("AbortError: request cancelled before fetch");
  }
  const { signal, cleanup } = mergeAbortSignals(opts?.signal, opts?.timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      (e instanceof Error && e.name === "AbortError") ||
      /abort|cancelled|upstream_timeout/i.test(msg)
    ) {
      throw new Error(
        opts?.signal?.aborted
          ? "AbortError: client cancelled"
          : `AbortError: ${msg}`,
      );
    }
    throw e;
  } finally {
    cleanup();
  }
}

/** Merge Studio instructions without discarding a provider/client system prompt. */
export function mergeManagedSystemPrompt(
  inputMessages: ChatMessage[],
  managedPrompt: string,
): ChatMessage[] {
  const prompt = managedPrompt.trim();
  const messages = [...inputMessages];
  if (!prompt) return messages;

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    messages.unshift({ role: "system", content: prompt });
    return messages;
  }

  const existing = messages[systemIndex];
  if (existing.role !== "system" || existing.content.includes(prompt)) return messages;
  const base = existing.content.trim();
  const content = base ? `${base}\n\n---\n\n${prompt}` : prompt;
  messages[systemIndex] = {
    role: "system",
    content,
    ...(existing.contentParts
      ? {
          contentParts: [
            { type: "text" as const, text: content },
            ...imagePartsFromContentParts(existing.contentParts),
          ],
        }
      : {}),
  };
  return messages;
}

function joinBase(baseURL: string, path: string): string {
  const b = baseURL.replace(/\/+$/, "");
  if (b.endsWith("/v1") && path.startsWith("/v1/")) {
    return b.slice(0, -3) + path;
  }
  // base 已是 .../responses 或 .../chat/completions 时直接用 base
  if (
    path.includes("responses") &&
    /\/responses$/i.test(b)
  ) {
    return b;
  }
  if (
    path.includes("chat/completions") &&
    /\/chat\/completions$/i.test(b)
  ) {
    return b;
  }
  return b + path;
}

/** 从 Cursor model 引用解析：providerId:modelId 或 providerId:modelId:high */
function stripEffortSuffix(hint: string): string {
  const efforts = new Set([
    "disabled",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const parts = hint.split(":");
  if (parts.length >= 2 && efforts.has(parts[parts.length - 1].toLowerCase())) {
    return parts.slice(0, -1).join(":");
  }
  return hint;
}

function extractRuntimeEffort(hint?: string): string | undefined {
  if (!hint) return undefined;
  const efforts = new Set([
    "disabled",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const parts = hint.split(":");
  const last = parts[parts.length - 1]?.toLowerCase();
  if (parts.length >= 2 && efforts.has(last)) return last;
  return undefined;
}

function pickProvider(
  providers: ModelProvider[],
  modelHint?: string,
): ModelProvider | null {
  const enabled = providers.filter((p) => p.enabled !== false);
  if (!enabled.length) return null;
  if (modelHint) {
    const hint = stripEffortSuffix(modelHint.trim());
    const colon = hint.includes(":") ? hint.split(":") : null;
    if (colon && colon.length >= 2) {
      const pid = colon[0];
      const mid = colon.slice(1).join(":");
      const byPid = enabled.find((p) => p.id === pid);
      if (byPid) {
        return {
          ...byPid,
          modelID: mid || byPid.modelID,
        };
      }
    }
    const byId = enabled.find((p) => p.id === hint || p.modelID === hint);
    if (byId) return byId;
    const byList = enabled.find((p) => (p.models || []).includes(hint));
    if (byList) return { ...byList, modelID: hint };
    const byName = enabled.find(
      (p) =>
        p.displayName === hint ||
        p.modelID.includes(hint) ||
        hint.includes(p.modelID),
    );
    if (byName) return byName;
  }
  return enabled[0];
}

function failoverRank(provider: ModelProvider): number {
  const n = provider.failoverPriority;
  return typeof n === "number" && Number.isFinite(n) ? n : 1000;
}

/** Export for fixture/smoke: preferred first, then failoverPriority asc, skip cooling when possible. */
export function orderProviderCandidates(
  providers: ModelProvider[],
  modelHint?: string,
): ModelProvider[] {
  const enabled = providers.filter((p) => p.enabled !== false);
  const preferred = pickProvider(enabled, modelHint);
  if (!preferred) return [];
  const rest = enabled
    .filter((p) => p.id !== preferred.id)
    .sort((a, b) => {
      const d = failoverRank(a) - failoverRank(b);
      if (d !== 0) return d;
      return a.displayName.localeCompare(b.displayName);
    });
  const ordered = [preferred, ...rest];
  const available = ordered.filter((p) => !isProviderCoolingDown(p.id));
  return available.length ? available : ordered;
}

function providerCandidates(
  providers: ModelProvider[],
  modelHint?: string,
): ModelProvider[] {
  return orderProviderCandidates(providers, modelHint);
}

function resolveOpenAIEndpoint(p: ModelProvider): "/v1/chat/completions" | "/v1/responses" {
  const v = String(p.openAIEndpoint || "")
    .trim()
    .toLowerCase();
  if (v === "/v1/responses" || v === "responses" || v.endsWith("/responses")) {
    return "/v1/responses";
  }
  return "/v1/chat/completions";
}

function resolveReasoningEffort(
  p: ModelProvider,
  modelHint?: string,
): string | undefined {
  const runtime = extractRuntimeEffort(modelHint);
  if (runtime === "disabled") return undefined;
  if (runtime) return runtime;
  const cfg = String(p.reasoningEffort || "").trim().toLowerCase();
  if (!cfg || cfg === "disabled") return undefined;
  return cfg;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function resolveMaxCompletionTokens(
  p: ModelProvider,
  opts?: Pick<ChatOptions, "maxCompletionTokens">,
): number | undefined {
  const configured = positiveInteger(
    p.modelSettings?.[p.modelID]?.maxCompletionTokens || p.maxCompletionTokens,
  );
  const configuredOutputLimit = Math.min(
    configured || DEFAULT_CONTEXT_AWARE_OUTPUT_TOKENS,
    DEFAULT_CONTEXT_AWARE_OUTPUT_TOKENS,
  );
  const contextBudget = positiveInteger(opts?.maxCompletionTokens);
  if (contextBudget) {
    return Math.min(configuredOutputLimit, contextBudget);
  }
  return configuredOutputLimit;
}

const CONTEXT_SAFETY_MARGIN_TOKENS = 1_024;

export type ProviderContextBudget = {
  contextWindowTokens: number;
  maxCompletionTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
};

export type PreparedProviderMessages = {
  messages: ChatMessage[];
  budget: ProviderContextBudget;
  estimatedInputTokens: number;
};

/** Model override, provider default, then the Studio-wide default. */
export function resolveProviderContextWindowTokens(
  provider: ModelProvider,
  globalContextWindowTokens?: number,
): number {
  const candidates = [
    provider.modelSettings?.[provider.modelID]?.contextWindowTokens,
    provider.contextWindowTokens,
    globalContextWindowTokens,
    DefaultCursorContextWindowTokens,
  ];
  for (const candidate of candidates) {
    const normalized = positiveInteger(candidate);
    if (normalized) return normalized;
  }
  return DefaultCursorContextWindowTokens;
}

/**
 * Reserve completion tokens and a small transport/tokenizer margin before
 * choosing how much conversation history may be sent upstream.
 */
export function resolveProviderContextBudget(
  provider: ModelProvider,
  globalContextWindowTokens?: number,
  maxCompletionTokensOverride?: number,
): ProviderContextBudget {
  const contextWindowTokens = resolveProviderContextWindowTokens(
    provider,
    globalContextWindowTokens,
  );
  const safetyMarginTokens = CONTEXT_SAFETY_MARGIN_TOKENS;
  const minimumInputTokens = Math.min(
    512,
    Math.max(64, Math.floor(contextWindowTokens / 8)),
  );
  const configuredMaxCompletionTokens = positiveInteger(
    provider.modelSettings?.[provider.modelID]?.maxCompletionTokens ||
      provider.maxCompletionTokens,
  );
  const overrideMaxCompletionTokens = positiveInteger(maxCompletionTokensOverride);
  const configuredOutputLimit = Math.min(
    configuredMaxCompletionTokens || DEFAULT_CONTEXT_AWARE_OUTPUT_TOKENS,
    DEFAULT_CONTEXT_AWARE_OUTPUT_TOKENS,
  );
  const requestedMaxCompletionTokens = overrideMaxCompletionTokens
    ? Math.min(configuredOutputLimit, overrideMaxCompletionTokens)
    : configuredOutputLimit;
  const maxCompletionTokens = Math.min(
    requestedMaxCompletionTokens,
    Math.max(1, contextWindowTokens - safetyMarginTokens - minimumInputTokens),
  );
  const inputBudgetTokens = Math.max(
    1,
    contextWindowTokens - safetyMarginTokens - maxCompletionTokens,
  );

  return {
    contextWindowTokens,
    maxCompletionTokens,
    safetyMarginTokens,
    inputBudgetTokens,
  };
}

/** Lightweight deterministic estimate used only to protect provider windows. */
export function estimateTextTokens(content: string): number {
  if (!content) return 0;
  let cjkCharacters = 0;
  for (const character of content) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(character)) {
      cjkCharacters += 1;
    }
  }
  const remainingCharacters = Math.max(0, content.length - cjkCharacters);
  return cjkCharacters + Math.ceil(remainingCharacters / 4);
}

type ContentCarrier = {
  content: string;
  contentParts?: ChatContentPart[];
};

function messageTextContent(message: ContentCarrier): string {
  return message.content || textFromContentParts(message.contentParts);
}

function contentPartsForProvider(message: ContentCarrier): ChatContentPart[] {
  const parts = message.contentParts?.filter(Boolean) || [];
  if (!parts.length) {
    return [{ type: "text", text: message.content || "" }];
  }
  if (parts.some((part) => part.type === "text" && part.text)) return parts;
  const text = messageTextContent(message);
  return text ? [{ type: "text", text }, ...parts] : parts;
}

function replaceMessageText(message: ChatMessage, content: string): ChatMessage {
  if (!("contentParts" in message) || !message.contentParts) {
    return { ...message, content } as ChatMessage;
  }
  return {
    ...message,
    content,
    contentParts: [
      ...(content ? [{ type: "text" as const, text: content }] : []),
      ...imagePartsFromContentParts(message.contentParts),
    ],
  } as ChatMessage;
}

function openAIContentValue(message: ContentCarrier): string | Array<Record<string, unknown>> {
  const parts = contentPartsForProvider(message);
  if (!imagePartsFromContentParts(parts).length) return messageTextContent(message);

  const value: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) value.push({ type: "text", text: part.text });
      continue;
    }
    value.push({
      type: "image_url",
      image_url: { url: imageDataUrl(part) },
    });
  }
  return value.length ? value : messageTextContent(message);
}

function anthropicContentValue(message: ContentCarrier): string | Array<Record<string, unknown>> {
  const parts = contentPartsForProvider(message);
  if (!imagePartsFromContentParts(parts).length) return messageTextContent(message);

  const value: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) value.push({ type: "text", text: part.text });
      continue;
    }
    value.push({
      type: "image",
      source: {
        type: "base64",
        media_type: normalizeImageMimeType(part.mimeType),
        data: part.dataBase64,
      },
    });
  }
  return value.length ? value : messageTextContent(message);
}

function responsesContentValue(message: ContentCarrier): Array<Record<string, unknown>> {
  const parts = contentPartsForProvider(message);
  const value: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) value.push({ type: "input_text", text: part.text });
      continue;
    }
    value.push({ type: "input_image", image_url: imageDataUrl(part) });
  }
  return value.length ? value : [{ type: "input_text", text: messageTextContent(message) }];
}

export function estimateChatMessageTokens(message: ChatMessage): number {
  let total = 4 + estimateTextTokens(messageTextContent(message));
  total += imagePartsFromContentParts(
    "contentParts" in message ? message.contentParts : undefined,
  ).length * ESTIMATED_TOKENS_PER_IMAGE_PART;
  if (message.role === "tool") {
    total += estimateTextTokens(message.tool_call_id) + estimateTextTokens(message.name || "");
  }
  if (message.role === "assistant") {
    for (const toolCall of message.tool_calls || []) {
      total +=
        8 +
        estimateTextTokens(toolCall.id) +
        estimateTextTokens(toolCall.function.name) +
        estimateTextTokens(toolCall.function.arguments);
    }
  }
  return total;
}

export function estimateChatMessagesTokens(messages: ChatMessage[]): number {
  return 2 + messages.reduce((total, message) => total + estimateChatMessageTokens(message), 0);
}

function splitHistoryIntoTurns(messages: ChatMessage[]): number[][] {
  const turns: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role === "user" && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length) turns.push(current);
  return turns;
}

function keepLatestTextWithinTokens(content: string, tokenLimit: number): string {
  if (estimateTextTokens(content) <= tokenLimit) return content;
  if (tokenLimit <= 0) return "";
  const marker = "[Earlier content trimmed]\n";
  if (estimateTextTokens(marker) >= tokenLimit) return "…";

  let low = 0;
  let high = content.length;
  let best = marker;
  while (low <= high) {
    const start = Math.floor((low + high) / 2);
    const candidate = marker + content.slice(start);
    if (estimateTextTokens(candidate) <= tokenLimit) {
      best = candidate;
      high = start - 1;
    } else {
      low = start + 1;
    }
  }
  return best;
}

function shrinkMessagesToBudget(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const compacted = messages.map((message) => ({ ...message })) as ChatMessage[];
  let estimated = estimateChatMessagesTokens(compacted);
  if (estimated <= budgetTokens) return compacted;

  // Old history loses text first. System prompts and the latest turn are only
  // shortened if their preserved structure itself would otherwise overflow.
  const candidates = compacted
    .map((message, index) => ({ index, priority: message.role === "system" ? 1 : 0 }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);

  for (const candidate of candidates) {
    if (estimated <= budgetTokens) break;
    const message = compacted[candidate.index];
    if (!message.content) continue;
    const currentTokens = estimateChatMessageTokens(message);
    const overflow = estimated - budgetTokens;
    const nextTarget = Math.max(0, currentTokens - overflow);
    const contentOverhead = currentTokens - estimateTextTokens(message.content);
    const nextContent = keepLatestTextWithinTokens(
      message.content,
      Math.max(0, nextTarget - contentOverhead),
    );
    if (nextContent === message.content) continue;
    compacted[candidate.index] = replaceMessageText(message, nextContent);
    estimated = estimateChatMessagesTokens(compacted);
  }
  return compacted;
}

/**
 * Preserve every system instruction and a complete suffix of recent turns.
 * Entire oldest turns are removed first so trailing tool-call pairs stay valid.
 */
export function trimChatMessagesToBudget(
  messages: ChatMessage[],
  inputBudgetTokens: number,
): ChatMessage[] {
  const budgetTokens = Math.max(1, Math.floor(inputBudgetTokens));
  if (estimateChatMessagesTokens(messages) <= budgetTokens) return [...messages];

  const selected = new Set<number>();
  let selectedTokens = 2;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "system") {
      selected.add(index);
      selectedTokens += estimateChatMessageTokens(messages[index]);
    }
  }

  const turns = splitHistoryIntoTurns(messages);
  let keptLatestTurn = false;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const turnTokens = turn.reduce(
      (total, messageIndex) => total + estimateChatMessageTokens(messages[messageIndex]),
      0,
    );
    if (!keptLatestTurn || selectedTokens + turnTokens <= budgetTokens) {
      for (const messageIndex of turn) selected.add(messageIndex);
      selectedTokens += turnTokens;
      keptLatestTurn = true;
    }
  }

  return shrinkMessagesToBudget(
    messages.filter((_, index) => selected.has(index)),
    budgetTokens,
  );
}

export function prepareProviderMessages(
  provider: ModelProvider,
  messages: ChatMessage[],
  globalContextWindowTokens?: number,
  maxCompletionTokensOverride?: number,
): PreparedProviderMessages {
  const budget = resolveProviderContextBudget(
    provider,
    globalContextWindowTokens,
    maxCompletionTokensOverride,
  );
  const compacted = trimChatMessagesToBudget(messages, budget.inputBudgetTokens);
  return {
    messages: compacted,
    budget,
    estimatedInputTokens: estimateChatMessagesTokens(compacted),
  };
}

function emptyUsage(): ChatUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function parseOpenAIUsage(usage: Record<string, unknown> | undefined): ChatUsage {
  if (!usage) return emptyUsage();
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const details = (usage.prompt_tokens_details ||
    usage.input_tokens_details ||
    {}) as Record<string, unknown>;
  const cacheRead = Number(
    details.cached_tokens ||
      usage.cache_read_input_tokens ||
      usage.cached_tokens ||
      0,
  );
  const cacheWrite = Number(
    details.cache_write_tokens ||
      usage.cache_creation_input_tokens ||
      usage.cache_write_tokens ||
      0,
  );
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function estimateUsage(messages: ChatMessage[], text: string): ChatUsage {
  return {
    promptTokens: Math.max(1, estimateChatMessagesTokens(messages)),
    completionTokens: Math.max(0, Math.round(text.length / 4)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function toOpenAIMessages(
  messages: ChatMessage[],
  thinkingEnabled = false,
): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: providerToolCallId(m.tool_call_id),
        ...(m.name ? { name: m.name } : {}),
      };
    }
    if (m.role === "assistant") {
      const item: Record<string, unknown> = {
        role: "assistant",
        content: m.content || (m.tool_calls?.length ? null : ""),
      };
      if (m.reasoningContent || (thinkingEnabled && m.tool_calls?.length)) {
        item.reasoning_content = m.reasoningContent || "";
      }
      if (m.tool_calls?.length) {
        item.tool_calls = m.tool_calls.map((call) => ({
          id: providerToolCallId(call.id),
          type: call.type,
          function: call.function,
        }));
      }
      return item;
    }
    return { role: m.role, content: openAIContentValue(m) };
  });
}

/** Anthropic：system 分离；tool_result 合并进 user content blocks */
export function toAnthropicPayload(messages: ChatMessage[]): {
  system: string;
  messages: Record<string, unknown>[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => messageTextContent(m))
    .join("\n");

  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: anthropicContentValue(m) });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (m.reasoningContent?.trim()) {
        const thinking: Record<string, unknown> = {
          type: "thinking",
          thinking: m.reasoningContent,
        };
        if (
          m.reasoningSignature?.trim() &&
          (!m.reasoningSignatureSource ||
            m.reasoningSignatureSource === "anthropic")
        ) {
          thinking.signature = m.reasoningSignature.trim();
        }
        blocks.push(thinking);
      }
      if (m.content?.trim()) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls || []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = { raw: tc.function.arguments };
        }
        blocks.push({
          type: "tool_use",
          id: providerToolCallId(tc.id),
          name: tc.function.name,
          input,
        });
      }
      if (
        !m.content?.trim() &&
        m.tool_calls?.length &&
        m.reasoningContent?.trim()
      ) {
        const previous = out[out.length - 1];
        const previousBlocks = Array.isArray(previous?.content)
          ? (previous.content as Array<Record<string, unknown>>)
          : [];
        const previousThinking = previousBlocks[0];
        const currentThinking = blocks[0];
        if (
          previous?.role === "assistant" &&
          previousThinking?.type === "thinking" &&
          currentThinking?.type === "thinking" &&
          previousThinking.thinking === currentThinking.thinking &&
          String(previousThinking.signature || "") ===
            String(currentThinking.signature || "")
        ) {
          previousBlocks.push(
            ...blocks.filter((block) => block.type !== "thinking"),
          );
          continue;
        }
      }
      out.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: m.content || "" }],
      });
      continue;
    }
    if (m.role === "tool") {
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: providerToolCallId(m.tool_call_id),
        content: m.content,
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  return {
    system,
    messages: out.length ? out : [{ role: "user", content: " " }],
  };
}

async function readSseStream(
  res: Response,
  onEvent: (obj: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.body) throw new Error("流式响应无 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || "";
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        /* ignore partial */
        continue;
      }
      onEvent(event);
    }
  }
}

type ToolAcc = {
  id: string;
  name: string;
  arguments: string;
  providerItemId?: string;
  providerCallId?: string;
  providerStatus?: string;
};

function finalizeToolAcc(map: Map<number, ToolAcc>): ToolCall[] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function" as const,
      function: {
        name: t.name || "unknown",
        arguments: t.arguments || "{}",
      },
      ...(t.providerItemId ? { openAIResponsesId: t.providerItemId } : {}),
      ...(t.providerCallId ? { openAIResponsesCallId: t.providerCallId } : {}),
      ...(t.providerStatus ? { openAIResponsesStatus: t.providerStatus } : {}),
    }))
    .filter((t) => t.function.name && t.function.name !== "unknown");
}

async function chatOpenAI(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
  modelHint?: string,
): Promise<ChatResult> {
  const endpoint = resolveOpenAIEndpoint(p);
  if (endpoint === "/v1/responses") {
    return chatOpenAIResponses(p, messages, handlers, opts, modelHint);
  }
  return chatOpenAICompletions(p, messages, handlers, opts, modelHint);
}

/** OpenAI Chat Completions */
async function chatOpenAICompletions(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
  modelHint?: string,
): Promise<ChatResult> {
  const url = joinBase(p.baseURL, "/v1/chat/completions");
  const effort = resolveReasoningEffort(p, modelHint);
  const body: Record<string, unknown> = {
    model: p.modelID,
    messages: toOpenAIMessages(messages, Boolean(effort)),
    stream: true,
    stream_options: { include_usage: true },
  };
  const maxTokens = resolveMaxCompletionTokens(p, opts);
  if (maxTokens) body.max_tokens = maxTokens;
  if (effort) body.reasoning_effort = effort;
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice || "auto";
  }

  const res = await fetchUpstream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify(body),
  }, opts);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 422) {
      if (isContextLimitProviderMessage(errText)) {
        throw new Error(`OpenAI chat ${res.status}: ${errText.slice(0, 400)}`);
      }
      return chatOpenAINonStream(p, messages, handlers, opts, modelHint);
    }
    throw new Error(`OpenAI chat ${res.status}: ${errText.slice(0, 400)}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && !ct.includes("event-stream")) {
    const data = (await res.json()) as Record<string, unknown>;
    return finalizeOpenAIJson(data, handlers);
  }

  let text = "";
  let reasoningContent = "";
  let reasoningSignature = "";
  let reasoningSignatureSource = "";
  let usage = emptyUsage();
  let finishReason = "";
  const toolMap = new Map<number, ToolAcc>();

  try {
    await readSseStream(res, (obj) => {
      if (obj.type === "error" || (obj.error && typeof obj.error === "object")) {
        throw streamEventError("OpenAI chat", obj);
      }
      const choices = obj.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      const content = delta?.content;
      if (typeof content === "string" && content) {
        text += content;
        handlers?.onText?.(content);
      }
      const reasoning =
        (typeof delta?.reasoning_content === "string" &&
          delta.reasoning_content) ||
        (typeof delta?.reasoning === "string" && delta.reasoning) ||
        "";
      if (reasoning) {
        reasoningContent += reasoning;
        handlers?.onThinking?.(reasoning);
      }
      const deltaMetadata = chatReasoningMetadata(delta);
      if (deltaMetadata.reasoningSignature) {
        reasoningSignature = deltaMetadata.reasoningSignature;
        reasoningSignatureSource =
          deltaMetadata.reasoningSignatureSource || "openai_chat";
        notifyReasoningMetadata(handlers, {
          reasoningSignature,
          reasoningSignatureSource,
        });
      }

      const tcs = delta?.tool_calls as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = Number(tc.index ?? 0);
          const acc = toolMap.get(idx) || { id: "", name: "", arguments: "" };
          if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === "string" && fn.name) acc.name = fn.name;
            if (typeof fn.arguments === "string") acc.arguments += fn.arguments;
          }
          toolMap.set(idx, acc);
        }
      }

      const fr = choices?.[0]?.finish_reason;
      if (typeof fr === "string" && fr) finishReason = fr;

      if (obj.usage && typeof obj.usage === "object") {
        usage = parseOpenAIUsage(obj.usage as Record<string, unknown>);
        handlers?.onUsage?.(usage);
      }
    });
  } catch (error) {
    if (
      error instanceof ProviderStreamEventError ||
      text ||
      toolMap.size ||
      reasoningContent ||
      reasoningSignature
    ) {
      throw error;
    }
    return chatOpenAINonStream(p, messages, handlers, opts, modelHint);
  }

  const toolCalls = finalizeToolAcc(toolMap);
  if (
    !text &&
    !toolCalls.length &&
    !reasoningContent &&
    !reasoningSignature &&
    !usage.promptTokens
  ) {
    return chatOpenAINonStream(p, messages, handlers, opts, modelHint);
  }
  if (!usage.promptTokens && !usage.completionTokens) {
    usage = estimateUsage(messages, text);
  }
  const reasoningMetadata: AssistantReasoningMetadata = {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature ? { reasoningSignature } : {}),
    ...(reasoningSignatureSource ? { reasoningSignatureSource } : {}),
  };
  notifyReasoningMetadata(handlers, reasoningMetadata);
  return {
    text,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
    ...reasoningMetadata,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function jsonClone(value: unknown): unknown | undefined {
  if (value == null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function reasoningTextFromSummary(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      return optionalString(record.text) || optionalString(record.content) || "";
    })
    .filter(Boolean)
    .join("\n");
}

function chatReasoningMetadata(
  message: Record<string, unknown> | undefined,
): AssistantReasoningMetadata {
  if (!message) return {};
  const reasoningContent =
    optionalString(message.reasoning_content) || optionalString(message.reasoning);
  const reasoningSignature =
    optionalString(message.reasoning_signature) || optionalString(message.signature);
  const explicitSource = optionalString(message.reasoning_signature_source);
  // Chat Completions has no standard signed-reasoning replay contract. Keep an
  // explicit upstream source when present; otherwise identify the actual wire
  // shape instead of incorrectly treating a generic signature as Anthropic.
  const reasoningSignatureSource = reasoningSignature
    ? explicitSource || "openai_chat"
    : undefined;
  return {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature ? { reasoningSignature } : {}),
    ...(reasoningSignatureSource ? { reasoningSignatureSource } : {}),
  };
}

function notifyReasoningMetadata(
  handlers: StreamHandlers | undefined,
  metadata: AssistantReasoningMetadata,
): void {
  if (
    metadata.reasoningContent ||
    metadata.reasoningSignature ||
    metadata.openAIResponsesReasoningId ||
    metadata.openAIResponsesReasoningStatus ||
    metadata.openAIResponsesReasoningSummary != null
  ) {
    handlers?.onReasoningMetadata?.(metadata);
  }
}

const MAX_PROVIDER_TOOL_CALL_ID_LENGTH = 64;

function shortToolCallHash(value: string, length: number): string {
  return createHash("sha256")
    .update(value.trim())
    .digest("hex")
    .slice(0, length);
}

function buildProviderToolCallId(namespace: string, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (!namespace && value.length <= MAX_PROVIDER_TOOL_CALL_ID_LENGTH) {
    return value;
  }
  const prefix = namespace ? `tc_${namespace}` : "tc";
  const candidate = `${prefix}_${value}`;
  if (candidate.length <= MAX_PROVIDER_TOOL_CALL_ID_LENGTH) return candidate;
  const hash = shortToolCallHash(value, 12);
  const remaining = MAX_PROVIDER_TOOL_CALL_ID_LENGTH - prefix.length - hash.length - 2;
  return remaining > 0
    ? `${prefix}_${hash}_${value.slice(-remaining)}`
    : `${prefix}_${hash}`;
}

function providerToolCallId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const separator = trimmed.indexOf("::");
  if (separator > 0 && separator < trimmed.length - 2) {
    const namespace = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 2).trim();
    if (namespace && raw) {
      return buildProviderToolCallId(shortToolCallHash(namespace, 12), raw);
    }
  }
  return buildProviderToolCallId("", trimmed);
}

function openAIResponsesProviderCallId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const separator = trimmed.indexOf("::");
  if (separator > 0 && separator < trimmed.length - 2) {
    const raw = trimmed.slice(separator + 2).trim();
    if (raw) return raw;
  }
  if (trimmed.startsWith("tc_")) {
    const parts = trimmed.split("_", 3);
    if (parts.length === 3 && parts[2]?.trim()) return parts[2].trim();
  }
  return providerToolCallId(trimmed);
}

/** 将 chat messages 转成 Responses API input */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: Array<Record<string, unknown>>;
} {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => messageTextContent(m))
    .join("\n");
  const input: Array<Record<string, unknown>> = [];
  const responseCallIds = new Map<string, string>();
  let activeReasoningReplayKey = "";
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      activeReasoningReplayKey = "";
      input.push({
        role: "user",
        content: responsesContentValue(m),
      });
      continue;
    }
    if (m.role === "assistant") {
      if (
        m.reasoningSignature &&
        m.reasoningSignatureSource === "openai_responses"
      ) {
        const replayKey = JSON.stringify([
          m.reasoningSignature,
          m.openAIResponsesReasoningId || "",
          m.openAIResponsesReasoningStatus || "",
          m.openAIResponsesReasoningSummary ?? null,
        ]);
        if (replayKey !== activeReasoningReplayKey) {
          input.push({
            type: "reasoning",
            encrypted_content: m.reasoningSignature,
            ...(m.openAIResponsesReasoningId
              ? { id: m.openAIResponsesReasoningId }
              : {}),
            ...(m.openAIResponsesReasoningStatus
              ? { status: m.openAIResponsesReasoningStatus }
              : {}),
            summary: m.openAIResponsesReasoningSummary ?? [],
          });
          activeReasoningReplayKey = replayKey;
        }
      }
      const content: Array<Record<string, unknown>> = [];
      if (m.content?.trim()) {
        content.push({ type: "output_text", text: m.content });
      }
      if (content.length) {
        input.push({ role: "assistant", content });
      }
      // tool_calls → function_call items
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const callId =
            tc.openAIResponsesCallId ||
            openAIResponsesProviderCallId(tc.id) ||
            openAIResponsesProviderCallId(tc.function.name);
          responseCallIds.set(tc.id, callId);
          input.push({
            type: "function_call",
            call_id: callId,
            name: tc.function.name,
            arguments: tc.function.arguments || "{}",
            ...(tc.openAIResponsesId ? { id: tc.openAIResponsesId } : {}),
            status: tc.openAIResponsesStatus || "completed",
          });
        }
      }
      continue;
    }
    if (m.role === "tool") {
      activeReasoningReplayKey = "";
      input.push({
        type: "function_call_output",
        call_id:
          responseCallIds.get(m.tool_call_id) ||
          openAIResponsesProviderCallId(m.tool_call_id),
        output: m.content,
      });
    }
  }
  return { instructions, input };
}

function toResponsesTools(
  tools: ToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = t.function || (t as unknown as { name?: string; parameters?: unknown });
    return {
      type: "function",
      name: t.function?.name || (fn as { name?: string }).name,
      description: t.function?.description,
      parameters: t.function?.parameters || { type: "object", properties: {} },
    };
  });
}

/** OpenAI Responses API（/v1/responses） */
function openAIResponsesToolCall(item: Record<string, unknown>): ToolCall | undefined {
  const name = optionalString(item.name);
  if (!name) return undefined;
  const providerItemId = optionalString(item.id);
  const providerCallId = optionalString(item.call_id);
  const id =
    providerCallId ||
    providerItemId ||
    `call_${Math.random().toString(36).slice(2, 10)}`;
  const providerStatus = optionalString(item.status);
  return {
    id,
    type: "function",
    function: {
      name,
      arguments:
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments || {}),
    },
    ...(providerItemId ? { openAIResponsesId: providerItemId } : {}),
    ...(providerCallId ? { openAIResponsesCallId: providerCallId } : {}),
    ...(providerStatus ? { openAIResponsesStatus: providerStatus } : {}),
  };
}

function openAIResponsesJsonResult(
  data: Record<string, unknown>,
  handlers?: StreamHandlers,
): ChatResult {
  const output = Array.isArray(data.output)
    ? (data.output as Array<Record<string, unknown>>)
    : [];
  let text = optionalString(data.output_text) || "";
  let reasoningContent = "";
  let reasoningSignature = "";
  let openAIResponsesReasoningId = "";
  let openAIResponsesReasoningStatus = "";
  let openAIResponsesReasoningSummary: unknown;
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    const type = String(item.type || "");
    if (type === "reasoning") {
      reasoningSignature =
        optionalString(item.encrypted_content) || reasoningSignature;
      openAIResponsesReasoningId =
        optionalString(item.id) || openAIResponsesReasoningId;
      openAIResponsesReasoningStatus =
        optionalString(item.status) || openAIResponsesReasoningStatus;
      const summary = jsonClone(item.summary);
      if (summary != null) openAIResponsesReasoningSummary = summary;
      reasoningContent ||= reasoningTextFromSummary(item.summary);
      continue;
    }
    if (type === "function_call") {
      const call = openAIResponsesToolCall(item);
      if (call) toolCalls.push(call);
      continue;
    }
    if (type === "message" && !text) {
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      text = content
        .filter((part) => part.type === "output_text" || part.type === "text")
        .map((part) => optionalString(part.text) || "")
        .join("");
    }
  }

  if (text) handlers?.onText?.(text);
  if (reasoningContent) handlers?.onThinking?.(reasoningContent);
  const reasoningMetadata: AssistantReasoningMetadata = {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature
      ? {
          reasoningSignature,
          reasoningSignatureSource: "openai_responses",
        }
      : {}),
    ...(openAIResponsesReasoningId ? { openAIResponsesReasoningId } : {}),
    ...(openAIResponsesReasoningStatus ? { openAIResponsesReasoningStatus } : {}),
    ...(openAIResponsesReasoningSummary != null
      ? { openAIResponsesReasoningSummary }
      : {}),
  };
  notifyReasoningMetadata(handlers, reasoningMetadata);

  const usage = parseOpenAIUsage(
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : undefined,
  );
  handlers?.onUsage?.(usage);
  const status = optionalString(data.status) || "";
  const incomplete = data.incomplete_details as Record<string, unknown> | undefined;
  const finishReason = optionalString(incomplete?.reason) || status;
  return {
    text,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
    ...reasoningMetadata,
  };
}

async function chatOpenAIResponses(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
  modelHint?: string,
): Promise<ChatResult> {
  const url = joinBase(p.baseURL, "/v1/responses");
  const effort = resolveReasoningEffort(p, modelHint);
  const { instructions, input } = toResponsesInput(messages);
  const body: Record<string, unknown> = {
    model: p.modelID,
    input,
    stream: true,
    store: false,
  };
  if (instructions.trim()) body.instructions = instructions;
  const maxTokens = resolveMaxCompletionTokens(p, opts);
  if (maxTokens) body.max_output_tokens = maxTokens;
  if (effort) {
    body.reasoning = { effort };
    body.include = ["reasoning.encrypted_content"];
  }
  if (opts?.tools?.length) {
    body.tools = toResponsesTools(opts.tools);
  }

  const res = await fetchUpstream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify(body),
  }, opts);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // 部分中转站 responses 不稳时回退 chat
    if (res.status === 404 || res.status === 405) {
      console.warn(
        "[provider-chat] responses 不可用，回退 chat/completions:",
        errText.slice(0, 120),
      );
      return chatOpenAICompletions(p, messages, handlers, opts, modelHint);
    }
    throw new Error(`OpenAI responses ${res.status}: ${errText.slice(0, 400)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (
    contentType.includes("application/json") &&
    !contentType.includes("event-stream")
  ) {
    const data = (await res.json()) as Record<string, unknown>;
    return openAIResponsesJsonResult(data, handlers);
  }

  let text = "";
  let reasoningContent = "";
  let reasoningSignature = "";
  let openAIResponsesReasoningId = "";
  let openAIResponsesReasoningStatus = "";
  let openAIResponsesReasoningSummary: unknown;
  let usage = emptyUsage();
  let finishReason = "";
  const toolMap = new Map<string, ToolAcc>();

  const responseTool = (
    itemId: unknown,
    outputIndex: unknown,
    item?: Record<string, unknown>,
  ): ToolAcc => {
    const providerItemId = optionalString(item?.id) || optionalString(itemId);
    const providerCallId = optionalString(item?.call_id);
    const outputKey = Number.isFinite(Number(outputIndex))
      ? `index:${Number(outputIndex)}`
      : "";
    const keys = [
      providerItemId ? `item:${providerItemId}` : "",
      providerCallId ? `call:${providerCallId}` : "",
      outputKey,
    ].filter(Boolean);
    let acc = keys.map((key) => toolMap.get(key)).find(Boolean);
    if (!acc) acc = { id: "", name: "", arguments: "" };
    if (providerItemId) acc.providerItemId = providerItemId;
    if (providerCallId) {
      acc.providerCallId = providerCallId;
      acc.id = providerCallId;
    } else if (!acc.id && providerItemId) {
      acc.id = providerItemId;
    }
    const providerStatus = optionalString(item?.status);
    if (providerStatus) acc.providerStatus = providerStatus;
    const name = optionalString(item?.name);
    if (name) acc.name = name;
    if (typeof item?.arguments === "string" && item.arguments) {
      acc.arguments = item.arguments;
    }
    for (const key of keys) toolMap.set(key, acc);
    return acc;
  };

  const applyReasoningItem = (
    item: Record<string, unknown>,
    allowSummaryFallback: boolean,
  ): void => {
    if (String(item.type || "") !== "reasoning") return;
    reasoningSignature =
      optionalString(item.encrypted_content) || reasoningSignature;
    openAIResponsesReasoningId =
      optionalString(item.id) || openAIResponsesReasoningId;
    openAIResponsesReasoningStatus =
      optionalString(item.status) || openAIResponsesReasoningStatus;
    const summary = jsonClone(item.summary);
    if (summary != null) openAIResponsesReasoningSummary = summary;
    if (allowSummaryFallback && !reasoningContent) {
      const fallback = reasoningTextFromSummary(item.summary);
      if (fallback) {
        reasoningContent = fallback;
        handlers?.onThinking?.(fallback);
      }
    }
    notifyReasoningMetadata(handlers, {
      ...(reasoningSignature
        ? {
            reasoningSignature,
            reasoningSignatureSource: "openai_responses",
          }
        : {}),
      ...(openAIResponsesReasoningId ? { openAIResponsesReasoningId } : {}),
      ...(openAIResponsesReasoningStatus ? { openAIResponsesReasoningStatus } : {}),
      ...(openAIResponsesReasoningSummary != null
        ? { openAIResponsesReasoningSummary }
        : {}),
    });
  };

  const applyOutputItem = (
    item: Record<string, unknown>,
    outputIndex: unknown,
    complete: boolean,
  ): void => {
    const itemType = String(item.type || "");
    if (itemType === "reasoning") {
      applyReasoningItem(item, complete);
      return;
    }
    if (itemType === "function_call") {
      responseTool(item.id, outputIndex, item);
      return;
    }
    if (itemType === "message" && !text) {
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      const fallback = content
        .filter((part) => part.type === "output_text" || part.type === "text")
        .map((part) => optionalString(part.text) || "")
        .join("");
      if (fallback) {
        text = fallback;
        handlers?.onText?.(fallback);
      }
    }
  };

  try {
    await readSseStream(res, (obj) => {
      const type = String(obj.type || "");
      // text deltas
      if (
        type === "response.output_text.delta" ||
        type === "response.text.delta"
      ) {
        const delta = obj.delta;
        if (typeof delta === "string" && delta) {
          text += delta;
          handlers?.onText?.(delta);
        }
      }
      // reasoning
      if (
        (type === "response.reasoning_summary_text.delta" ||
          type === "response.reasoning_text.delta") &&
        typeof obj.delta === "string" &&
        obj.delta
      ) {
        reasoningContent += obj.delta;
        handlers?.onThinking?.(obj.delta);
      }
      // function call args
      if (
        type === "response.function_call_arguments.delta" &&
        typeof obj.delta === "string"
      ) {
        const acc = responseTool(obj.item_id, obj.output_index);
        acc.arguments += obj.delta;
      }
      if (
        type === "response.function_call_arguments.done" &&
        typeof obj.arguments === "string"
      ) {
        const acc = responseTool(obj.item_id, obj.output_index);
        if (obj.arguments) acc.arguments = obj.arguments;
      }
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = obj.item as Record<string, unknown> | undefined;
        if (item) {
          applyOutputItem(item, obj.output_index, type.endsWith(".done"));
        }
      }
      if (type === "response.completed" || type === "response.done") {
        const response = obj.response as Record<string, unknown> | undefined;
        const output = Array.isArray(response?.output)
          ? (response.output as Array<Record<string, unknown>>)
          : [];
        output.forEach((item, index) => applyOutputItem(item, index, true));
        if (response?.usage && typeof response.usage === "object") {
          usage = parseOpenAIUsage(response.usage as Record<string, unknown>);
          handlers?.onUsage?.(usage);
        }
        finishReason = optionalString(response?.status) || "stop";
      }
      if (type === "response.incomplete") {
        const response = obj.response as Record<string, unknown> | undefined;
        const details = response?.incomplete_details as
          | Record<string, unknown>
          | undefined;
        finishReason = optionalString(details?.reason) || "incomplete";
      }
      if (type === "response.failed" || type === "error") {
        throw streamEventError("OpenAI responses", obj);
      }
      if (obj.usage && typeof obj.usage === "object") {
        usage = parseOpenAIUsage(obj.usage as Record<string, unknown>);
        handlers?.onUsage?.(usage);
      }
    });
  } catch (e) {
    if (
      e instanceof ProviderStreamEventError ||
      text ||
      toolMap.size ||
      reasoningContent ||
      reasoningSignature
    ) {
      throw e;
    }
    console.warn("[provider-chat] responses stream fail, fallback chat", e);
    return chatOpenAICompletions(p, messages, handlers, opts, modelHint);
  }

  const toolCalls = [...new Set(toolMap.values())]
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function" as const,
      function: { name: t.name, arguments: t.arguments || "{}" },
      ...(t.providerItemId ? { openAIResponsesId: t.providerItemId } : {}),
      ...(t.providerCallId ? { openAIResponsesCallId: t.providerCallId } : {}),
      ...(t.providerStatus ? { openAIResponsesStatus: t.providerStatus } : {}),
    }));

  if (!text && !toolCalls.length && !reasoningContent && !reasoningSignature) {
    return chatOpenAICompletions(p, messages, handlers, opts, modelHint);
  }
  if (!usage.promptTokens && !usage.completionTokens) {
    usage = estimateUsage(messages, text);
  }
  const reasoningMetadata: AssistantReasoningMetadata = {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature
      ? {
          reasoningSignature,
          reasoningSignatureSource: "openai_responses",
        }
      : {}),
    ...(openAIResponsesReasoningId ? { openAIResponsesReasoningId } : {}),
    ...(openAIResponsesReasoningStatus ? { openAIResponsesReasoningStatus } : {}),
    ...(openAIResponsesReasoningSummary != null
      ? { openAIResponsesReasoningSummary }
      : {}),
  };
  notifyReasoningMetadata(handlers, reasoningMetadata);
  return {
    text,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
    ...reasoningMetadata,
  };
}

async function chatOpenAINonStream(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
  modelHint?: string,
): Promise<ChatResult> {
  const url = joinBase(p.baseURL, "/v1/chat/completions");
  const effort = resolveReasoningEffort(p, modelHint);
  const body: Record<string, unknown> = {
    model: p.modelID,
    messages: toOpenAIMessages(messages, Boolean(effort)),
    stream: false,
  };
  const maxTokens = resolveMaxCompletionTokens(p, opts);
  if (maxTokens) body.max_tokens = maxTokens;
  if (effort) body.reasoning_effort = effort;
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice || "auto";
  }

  let res = await fetchUpstream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify(body),
  }, opts);

  if (!res.ok && effort) {
    const errBody = await res.text().catch(() => "");
    if (/reasoning/i.test(errBody)) {
      delete body.reasoning_effort;
      res = await fetchUpstream(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.apiKey}`,
        },
        body: JSON.stringify(body),
      }, opts);
    } else {
      throw new Error(`OpenAI 兼容接口 ${res.status}: ${errBody.slice(0, 400)}`);
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (opts?.tools?.length && /tool/i.test(errText)) {
      return chatOpenAINonStream(
        p,
        messages,
        handlers,
        opts ? { ...opts, tools: undefined } : undefined,
        modelHint,
      );
    }
    throw new Error(`OpenAI 兼容接口 ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return finalizeOpenAIJson(data, handlers);
}

function finalizeOpenAIJson(
  data: Record<string, unknown>,
  handlers?: StreamHandlers,
): ChatResult {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const text = String(message?.content || "");
  if (text) handlers?.onText?.(text);
  const reasoningMetadata = chatReasoningMetadata(message);
  if (reasoningMetadata.reasoningContent) {
    handlers?.onThinking?.(reasoningMetadata.reasoningContent);
  }
  notifyReasoningMetadata(handlers, reasoningMetadata);

  const rawTools = (message?.tool_calls as Array<Record<string, unknown>>) || [];
  const toolCalls: ToolCall[] = rawTools
    .map((tc) => {
      const fn = (tc.function || {}) as Record<string, unknown>;
      return {
        id: String(tc.id || `call_${Math.random().toString(36).slice(2, 8)}`),
        type: "function" as const,
        function: {
          name: String(fn.name || ""),
          arguments:
            typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments || {}),
        },
      };
    })
    .filter((t) => t.function.name);

  let usage = parseOpenAIUsage(data.usage as Record<string, unknown> | undefined);
  if (!usage.promptTokens && !usage.completionTokens) {
    usage = estimateUsage([], text);
  }
  handlers?.onUsage?.(usage);
  const finishReason = String(choices?.[0]?.finish_reason || "");
  return {
    text,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
    ...reasoningMetadata,
  };
}

async function chatAnthropic(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
): Promise<ChatResult> {
  // 工具场景优先非流（tool_use 块更稳）
  if (opts?.tools?.length) {
    return chatAnthropicNonStream(p, messages, handlers, opts);
  }

  const url = joinBase(p.baseURL, "/v1/messages");
  const { system, messages: rest } = toAnthropicPayload(messages);
  const streamBody: Record<string, unknown> = {
    model: p.modelID,
    max_tokens: resolveMaxCompletionTokens(p, opts) || 8192,
    system: system || undefined,
    messages: rest,
    stream: true,
  };

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": p.apiKey,
    Authorization: `Bearer ${p.apiKey}`,
    "anthropic-version": "2023-06-01",
  };

  const res = await fetchUpstream(url, {
    method: "POST",
    headers,
    body: JSON.stringify(streamBody),
  }, opts);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic chat ${res.status}: ${errText.slice(0, 400)}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && !ct.includes("event-stream")) {
    const data = (await res.json()) as Record<string, unknown>;
    return finalizeAnthropicJson(data, handlers);
  }

  let text = "";
  let reasoningContent = "";
  let reasoningSignature = "";
  let usage = emptyUsage();
  try {
    await readSseStream(res, (obj) => {
      const type = String(obj.type || "");
      if (type === "error" || (obj.error && typeof obj.error === "object")) {
        throw streamEventError("Anthropic", obj);
      }
      if (type === "content_block_start") {
        const block = obj.content_block as Record<string, unknown> | undefined;
        if (block?.type === "thinking") {
          const thinking = optionalString(block.thinking);
          if (thinking) {
            reasoningContent += thinking;
            handlers?.onThinking?.(thinking);
          }
          const signature = optionalString(block.signature);
          if (signature) {
            reasoningSignature = signature;
            notifyReasoningMetadata(handlers, {
              reasoningSignature,
              reasoningSignatureSource: "anthropic",
            });
          }
        }
      }
      if (type === "content_block_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          handlers?.onText?.(delta.text);
        }
        if (
          (delta?.type === "thinking_delta" || delta?.type === "reasoning_delta") &&
          (typeof delta.thinking === "string" || typeof delta.text === "string")
        ) {
          const thinking = String(delta.thinking || delta.text || "");
          reasoningContent += thinking;
          handlers?.onThinking?.(thinking);
        }
        const signature = optionalString(delta?.signature);
        if (signature) {
          reasoningSignature = signature;
          notifyReasoningMetadata(handlers, {
            reasoningSignature,
            reasoningSignatureSource: "anthropic",
          });
        }
      }
      if (type === "message_delta" || type === "message_start") {
        const u =
          (obj.usage as Record<string, unknown>) ||
          ((obj.message as Record<string, unknown>)?.usage as Record<
            string,
            unknown
          >);
        if (u) {
          usage = {
            promptTokens: Number(u.input_tokens || usage.promptTokens || 0),
            completionTokens: Number(u.output_tokens || usage.completionTokens || 0),
            cacheReadTokens: Number(
              u.cache_read_input_tokens || usage.cacheReadTokens || 0,
            ),
            cacheWriteTokens: Number(
              u.cache_creation_input_tokens || usage.cacheWriteTokens || 0,
            ),
          };
          handlers?.onUsage?.(usage);
        }
      }
    });
  } catch (error) {
    if (
      error instanceof ProviderStreamEventError ||
      text ||
      reasoningContent ||
      reasoningSignature
    ) {
      throw error;
    }
    return chatAnthropicNonStream(p, messages, handlers, opts);
  }

  if (!text && !reasoningContent && !reasoningSignature) {
    return chatAnthropicNonStream(p, messages, handlers, opts);
  }
  if (!usage.promptTokens && !usage.completionTokens) {
    usage = estimateUsage(messages, text);
  }
  const reasoningMetadata: AssistantReasoningMetadata = {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature
      ? {
          reasoningSignature,
          reasoningSignatureSource: "anthropic",
        }
      : {}),
  };
  notifyReasoningMetadata(handlers, reasoningMetadata);
  return { text, usage, finishReason: "stop", ...reasoningMetadata };
}

async function chatAnthropicNonStream(
  p: ModelProvider,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
  opts?: ChatOptions,
): Promise<ChatResult> {
  const url = joinBase(p.baseURL, "/v1/messages");
  const { system, messages: rest } = toAnthropicPayload(messages);
  const body: Record<string, unknown> = {
    model: p.modelID,
    max_tokens: resolveMaxCompletionTokens(p, opts) || 8192,
    system: system || undefined,
    messages: rest,
  };
  if (opts?.tools?.length) {
    body.tools = toAnthropicTools(opts.tools);
    body.tool_choice = { type: opts.toolChoice === "none" ? "none" : "auto" };
  }

  const res = await fetchUpstream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.apiKey,
      Authorization: `Bearer ${p.apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  }, opts);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (opts?.tools?.length && /tool/i.test(errBody)) {
      return chatAnthropicNonStream(p, messages, handlers, undefined);
    }
    throw new Error(`Anthropic 兼容接口 ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return finalizeAnthropicJson(data, handlers);
}

function finalizeAnthropicJson(
  data: Record<string, unknown>,
  handlers?: StreamHandlers,
): ChatResult {
  const content =
    (data.content as Array<Record<string, unknown>>) || [];
  let text = "";
  let reasoningContent = "";
  let reasoningSignature = "";
  const toolCalls: ToolCall[] = [];
  for (const c of content) {
    if (c.type === "thinking") {
      const thinking =
        optionalString(c.thinking) || optionalString(c.text) || "";
      reasoningContent += thinking;
      reasoningSignature = optionalString(c.signature) || reasoningSignature;
      continue;
    }
    if (c.type === "text" || (!c.type && typeof c.text === "string")) {
      const t = String(c.text || "");
      text += t;
    }
    if (c.type === "tool_use") {
      toolCalls.push({
        id: String(c.id || `toolu_${Math.random().toString(36).slice(2, 8)}`),
        type: "function",
        function: {
          name: String(c.name || ""),
          arguments: JSON.stringify(c.input ?? {}),
        },
      });
    }
  }
  if (text) handlers?.onText?.(text);
  if (reasoningContent) handlers?.onThinking?.(reasoningContent);
  const reasoningMetadata: AssistantReasoningMetadata = {
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningSignature
      ? {
          reasoningSignature,
          reasoningSignatureSource: "anthropic",
        }
      : {}),
  };
  notifyReasoningMetadata(handlers, reasoningMetadata);
  const u = (data.usage || {}) as Record<string, unknown>;
  const usage: ChatUsage = {
    promptTokens: Number(u.input_tokens || 0),
    completionTokens: Number(u.output_tokens || 0),
    cacheReadTokens: Number(u.cache_read_input_tokens || 0),
    cacheWriteTokens: Number(u.cache_creation_input_tokens || 0),
  };
  handlers?.onUsage?.(usage);
  const stop = String(data.stop_reason || "");
  return {
    text,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason:
      stop === "tool_use" || toolCalls.length
        ? "tool_calls"
        : stop || "stop",
    ...reasoningMetadata,
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  times = 2,
  canRetry: () => boolean = () => true,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof ProviderStreamEventError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !canRetry() ||
        !/fetch failed|ECONNRESET|ETIMEDOUT|AbortError|429|502|503|504|network/i.test(msg)
      ) {
        throw e;
      }
      if (i === times) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|AbortError|timeout|network|\b408\b|\b425\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b/i.test(
    message,
  );
}

/** 完整 messages 路径（多轮 / tools） */
export async function runProviderChatMessages(
  providers: ModelProvider[],
  inputMessages: ChatMessage[],
  modelHint?: string,
  handlers?: StreamHandlers,
  opts?: ChatOptions & { requestContext?: RequestContext },
): Promise<ChatResult & { providerId: string; modelID: string; routeReason?: RouteReason; requestId?: string }> {
  const ctx =
    opts?.requestContext ||
    createRequestContext({ modelHint, source: "unknown" });
  if (modelHint && !ctx.modelHint) ctx.modelHint = modelHint;
  const fixedCursorRoute = opts?.cursorNativeErrorBoundary
    ? pickProvider(
      providers.filter((provider) => provider.enabled !== false),
      modelHint,
    )
    : undefined;
  const candidates = opts?.cursorNativeErrorBoundary
    ? fixedCursorRoute
      ? [fixedCursorRoute]
      : []
    : providerCandidates(providers, modelHint);
  if (!candidates.length) {
    throw new Error("没有已启用的供应商，请先在「供应商」页添加并启用");
  }
  const attemptCandidates = candidates;
  const p = attemptCandidates[0];
  if (!p.apiKey?.trim() && attemptCandidates.length === 1) {
    throw new Error(`供应商 ${p.displayName} 缺少 API Key`);
  }
  if (!p.modelID?.trim() && attemptCandidates.length === 1) {
    throw new Error(`供应商 ${p.displayName} 缺少 Model ID`);
  }

  let messages: ChatMessage[] = [...inputMessages];
  if (!messages.length) {
    throw new Error("provider request requires replayable conversation input");
  }

  if (opts?.includeManagedSystemPrompt !== false) {
    try {
      messages = mergeManagedSystemPrompt(messages, await getActiveSystemPrompt());
    } catch (e) {
      console.warn("[agent] prompt inject skipped", e);
    }
  }

  let lastError: unknown;
  let attemptIndex = 0;
  for (const candidate of attemptCandidates) {
    if (!candidate.apiKey?.trim() || !candidate.modelID?.trim()) continue;

    // Recalculate for every candidate so failover respects that provider's
    // model-specific context window and output limit.
    const prepared = prepareProviderMessages(
      candidate,
      messages,
      opts?.globalContextWindowTokens,
      opts?.maxCompletionTokens,
    );
    const originalInputTokens = estimateChatMessagesTokens(messages);
    if (
      opts?.strictContextBudget &&
      originalInputTokens > prepared.budget.inputBudgetTokens
    ) {
      const providerError = attachProviderRoute(
        new Error(
          `context input exceeds ${candidate.modelID} budget: ${originalInputTokens} > ${prepared.budget.inputBudgetTokens}`,
        ),
        candidate,
      );
      lastError = providerError;
      markError(ctx, providerError);
      throw providerError;
    }
    const attemptOptions: ChatOptions = {
      ...opts,
      maxCompletionTokens: prepared.budget.maxCompletionTokens,
    };

    let emitted = false;
    const attemptHandlers: StreamHandlers = {
      onText: (delta) => {
        if (delta) emitted = true;
        handlers?.onText?.(delta);
      },
      onThinking: (delta) => {
        if (delta) emitted = true;
        handlers?.onThinking?.(delta);
      },
      onReasoningMetadata: (metadata) => {
        if (
          metadata.reasoningContent ||
          metadata.reasoningSignature ||
          metadata.openAIResponsesReasoningId
        ) {
          emitted = true;
        }
        handlers?.onReasoningMetadata?.(metadata);
      },
      onUsage: (usage) => handlers?.onUsage?.(usage),
    };

    try {
      const result = await withRetry(
        () =>
          candidate.type === "anthropic"
            ? chatAnthropic(candidate, prepared.messages, attemptHandlers, attemptOptions)
            : chatOpenAI(
                candidate,
                prepared.messages,
                attemptHandlers,
                attemptOptions,
                modelHint,
              ),
        opts?.cursorNativeErrorBoundary ? 0 : 2,
        () => !emitted,
      );
      if (!result.text.trim() && !(result.toolCalls?.length)) {
        throw new Error("provider returned an empty completion");
      }
      recordProviderSuccess(candidate.id);
      const routeReason: RouteReason =
        attemptIndex === 0
          ? candidates.length === 1
            ? "only"
            : modelHint
              ? "hint"
              : "default"
          : "failover";
      markRoute(ctx, {
        providerId: candidate.id,
        modelID: candidate.modelID,
        routeReason,
        attempt: attemptIndex,
      });
      return {
        ...result,
        providerId: candidate.id,
        modelID: candidate.modelID,
        routeReason,
        requestId: ctx.requestId,
      };
    } catch (error) {
      const providerError = attachProviderRoute(error, candidate);
      lastError = providerError;
      markError(ctx, providerError);
      const msg = providerError.message;
      const aborted =
        (error instanceof Error && error.name === "AbortError") ||
        /abort|cancel/i.test(msg) ||
        Boolean(opts?.signal?.aborted);
      if (opts?.cursorNativeErrorBoundary) {
        throw providerError;
      }
      // Client cancel / timeout must not failover to another provider.
      if (aborted || (!isTransientProviderError(providerError) && !shouldFailover(providerError)) || emitted) {
        throw providerError;
      }
      recordProviderFailure(candidate.id, providerError);
      console.warn(
        `[provider-chat] ${candidate.displayName} failed, trying next provider`,
        providerError,
      );
      attemptIndex += 1;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No usable provider candidate");
}

/** 仅用户文本列表 */
export async function runProviderChat(
  providers: ModelProvider[],
  userTexts: string[],
  modelHint?: string,
  handlers?: StreamHandlers,
  opts?: ChatOptions,
): Promise<ChatResult & { providerId: string; modelID: string }> {
  const messages: ChatMessage[] = userTexts.map((content) => ({
    role: "user" as const,
    content,
  }));
  return runProviderChatMessages(providers, messages, modelHint, handlers, opts);
}

export { addUsage, emptyUsage };
