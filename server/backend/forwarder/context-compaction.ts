/**
 * Provider-backed conversation compaction.
 *
 * Cursor receives the configured context limit from the local backend, but the
 * proxy owns the prompt transcript sent to external providers. Compacting here
 * keeps both views aligned and, importantly, asks the conversation's selected
 * model to create the summary instead of silently dropping earlier turns.
 */
import type { ModelProvider } from "../../config/store";
import {
  estimateChatMessagesTokens,
  estimateTextTokens,
  orderProviderCandidates,
  resolveProviderContextBudget,
  runProviderChatMessages,
  type ChatMessage,
  type ChatUsage,
} from "../agent/provider-chat";
import { imagePartsFromContentParts, textFromContentParts } from "../agent/content-parts";
import {
  isPromptContextHistoryMessage,
  replaceHistoryMessages,
  type ConversationRoute,
  type HistoryMessage,
} from "./history";

const COMPACTION_TAIL_TURNS = 4;
const COMPACTION_SUMMARY_OUTPUT_TOKENS = 4_096;
const COMPACTION_AUTO_RESERVE_TOKENS = 10_000;
const COMPACTION_MIN_RESERVE_TOKENS = 1_025;
const COMPACTION_MIN_SOURCE_TOKENS = 1_024;
const COMPACTION_MESSAGE_SNIPPET_TOKENS = 12_000;

const COMPACTION_INSTRUCTIONS = [
  "Summarize the earlier conversation for a later continuation.",
  "Preserve user goals, decisions, constraints, files, commands, tool results, unresolved errors, and next steps.",
  "Write concise Markdown only. Do not mention this instruction, do not call tools, and do not answer the original task.",
].join(" ");

export type ContextCompactionResult = {
  compacted: boolean;
  /** The current turn itself cannot fit and has no safe historical prefix to summarize. */
  blocked: boolean;
  messages: ChatMessage[];
  usage: ChatUsage;
  providerId?: string;
  modelID?: string;
  modelHint?: string;
  passes: number;
};

export class ContextCompactionError extends Error {
  constructor() {
    super("conversation input exceeds the active model context window");
    this.name = "ContextCompactionError";
  }
}

type CompactionSlice = {
  source: ChatMessage[];
  remainder: ChatMessage[];
};

function emptyUsage(): ChatUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function addUsage(left: ChatUsage, right: ChatUsage): ChatUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  };
}

function contextTriggerTokens(contextWindowTokens: number): number {
  const reserveTokens = Math.min(
    COMPACTION_AUTO_RESERVE_TOKENS,
    Math.max(COMPACTION_MIN_RESERVE_TOKENS, Math.floor(contextWindowTokens * 0.1)),
  );
  return Math.max(1, contextWindowTokens - reserveTokens);
}

function userTurnStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role === "user" &&
      !isPromptContextHistoryMessage(message as HistoryMessage)
    ) {
      starts.push(index);
    }
  }
  return starts;
}

function summarizableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) =>
      !isPromptContextHistoryMessage(message as HistoryMessage),
  );
}

/** Keep the newest complete turns together so tool call / result pairs survive. */
function selectCompactionSlice(
  messages: ChatMessage[],
  sourceTokenBudget: number,
  targetTokenBudget: number,
): CompactionSlice | undefined {
  const starts = userTurnStarts(messages);
  if (starts.length <= 1) return undefined;

  // Keep up to four newest turns, but always leave at least one compactable
  // older turn for short, yet very large conversations.
  let tailTurns = Math.min(
    COMPACTION_TAIL_TURNS,
    Math.max(1, starts.length - 1),
  );
  // Prefer four recent turns but reclaim more history down to one when needed.
  // tail turn when the provider's real window is smaller. A fixed four-turn
  // tail makes recovery impossible for legitimate 4k/8k models.
  while (tailTurns > 1) {
    const candidateTailStart = starts[starts.length - tailTurns];
    const candidateTailTokens = estimateChatMessagesTokens(
      messages.slice(candidateTailStart),
    );
    if (candidateTailTokens <= targetTokenBudget) break;
    tailTurns -= 1;
  }
  const tailStart = starts[starts.length - tailTurns];
  const older = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);
  if (!older.length) return undefined;

  const olderUserStarts = userTurnStarts(older);
  if (!olderUserStarts.length) return undefined;

  // Leading system context (including a previous compaction summary) travels
  // with the first compacted turn so summaries do not lose prior decisions.
  let end = olderUserStarts[0];
  let selectedTokens = estimateChatMessagesTokens(
    summarizableMessages(older.slice(0, end)),
  );
  let selectedTurns = 0;
  for (let turn = 0; turn < olderUserStarts.length; turn += 1) {
    const start = olderUserStarts[turn];
    const next = olderUserStarts[turn + 1] ?? older.length;
    const turnTokens = estimateChatMessagesTokens(
      summarizableMessages(older.slice(start, next)),
    );
    if (
      selectedTurns > 0 &&
      selectedTokens + turnTokens > sourceTokenBudget
    ) {
      break;
    }
    selectedTokens += turnTokens;
    end = next;
    selectedTurns += 1;
  }

  if (!selectedTurns) return undefined;
  return {
    source: older.slice(0, end),
    remainder: [...older.slice(end), ...tail],
  };
}

function clipTextToTokens(text: string, tokenBudget: number): string {
  const value = String(text || "").trim();
  if (!value || estimateTextTokens(value) <= tokenBudget) return value;
  if (tokenBudget <= 0) return "";

  const marker = "[content shortened for context summary]";
  const markerTokens = estimateTextTokens(marker);
  if (markerTokens >= tokenBudget) return marker.slice(0, Math.max(1, tokenBudget));

  let low = 0;
  let high = value.length;
  let best = marker;
  while (low <= high) {
    const prefixLength = Math.floor((low + high) / 2);
    const suffixLength = Math.max(0, prefixLength - Math.floor(prefixLength / 2));
    const candidate = `${value.slice(0, Math.floor(prefixLength / 2))}\n${marker}\n${
      suffixLength ? value.slice(-suffixLength) : ""
    }`;
    if (estimateTextTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = prefixLength + 1;
    } else {
      high = prefixLength - 1;
    }
  }
  return best;
}

function summaryMessageText(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  let text = message.content;
  if ((message.role === "system" || message.role === "user") && message.contentParts?.length) {
    text = text || textFromContentParts(message.contentParts);
    const images = imagePartsFromContentParts(message.contentParts);
    if (images.length) {
      const labels = images
        .map((image, index) => image.path || `image-${index + 1}`)
        .join(", ");
      text = `${text}\n[Attached images: ${labels}]`;
    }
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    const calls = message.tool_calls
      .map((call) => `${call.function.name}(${clipTextToTokens(call.function.arguments, 240)})`)
      .join(", ");
    text = `${text}\n[Tool calls: ${calls}]`;
  }
  if (message.role === "tool") {
    text = `${message.name || "tool"}: ${text}`;
  }
  return `${role}: ${clipTextToTokens(text, COMPACTION_MESSAGE_SNIPPET_TOKENS)}`;
}

function summarySourceText(messages: ChatMessage[], tokenBudget: number): string {
  const lines: string[] = [];
  let used = 0;
  // Prompt contexts remain in the original slice so the compaction commit
  // removes the exact selected range, but they are transient model guidance
  // and must not consume summary budget or enter the retained summary.
  for (const message of summarizableMessages(messages)) {
    const line = summaryMessageText(message);
    const tokens = estimateTextTokens(line);
    if (used + tokens <= tokenBudget) {
      lines.push(line);
      used += tokens;
      continue;
    }
    const remaining = Math.max(0, tokenBudget - used);
    if (remaining > 32) lines.push(clipTextToTokens(line, remaining));
    break;
  }
  return lines.join("\n\n").trim();
}

function retainedSummary(summary: string): ChatMessage {
  return {
    role: "system",
    content: [
      "Earlier conversation context was summarized by the selected model.",
      "Treat the following as retained facts and continue consistently:",
      summary.trim(),
    ].join("\n\n"),
  };
}

function selectedModelHint(
  requested: string | undefined,
  provider: Pick<ModelProvider, "id" | "modelID">,
): string {
  const base = `${provider.id}:${provider.modelID}`;
  const raw = String(requested || "").trim();
  if (!raw) return base;
  const prefix = `${provider.id}:${provider.modelID}:`;
  return raw.startsWith(prefix) || raw === base ? raw : base;
}

/**
 * Generate summaries until the preserved transcript has headroom, then commit
 * the complete candidate once. Provider failures, empty summaries, blocked
 * candidates, and cancellation leave the original history untouched.
 */
export async function compactConversationHistory(opts: {
  historyKey: string;
  messages: ChatMessage[];
  providers: ModelProvider[];
  modelHint?: string;
  globalContextWindowTokens?: number;
  /**
   * A provider can report a smaller real window than its configured catalog
   * entry. This override is scoped to one compaction attempt and is never
   * persisted back into provider settings.
   */
  contextWindowTokensOverride?: number;
  /**
   * Run at least one compaction pass even when the local token estimate is
   * below its configured threshold. Used after a provider rejects the request
   * for its actual context/token limit.
   */
  force?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStarted?: () => void | Promise<void>;
  onSummary?: (summary: string) => void | Promise<void>;
}): Promise<ContextCompactionResult> {
  const originalMessages = [...opts.messages];
  let messages = [...originalMessages];
  const selectedProvider = orderProviderCandidates(opts.providers, opts.modelHint)[0];
  if (!selectedProvider) {
    return {
      compacted: false,
      blocked: false,
      messages,
      usage: emptyUsage(),
      passes: 0,
    };
  }

  const overrideWindow = Number(opts.contextWindowTokensOverride);
  const contextWindowTokensOverride =
    Number.isFinite(overrideWindow) && overrideWindow > 0
      ? Math.floor(overrideWindow)
      : undefined;
  // Resolve budgets and send the summary through the same temporary cap. A
  // cloned route keeps the correction local to this recovery attempt.
  const routeProvider: ModelProvider = contextWindowTokensOverride
    ? {
      ...selectedProvider,
      contextWindowTokens: contextWindowTokensOverride,
      modelSettings: {
        ...selectedProvider.modelSettings,
        [selectedProvider.modelID]: {
          ...selectedProvider.modelSettings?.[selectedProvider.modelID],
          contextWindowTokens: contextWindowTokensOverride,
        },
      },
    }
    : selectedProvider;

  const modelHint = selectedModelHint(opts.modelHint, routeProvider);
  const normalBudget = resolveProviderContextBudget(
    routeProvider,
    opts.globalContextWindowTokens,
  );
  // Match the automatic compaction policy. The 65,536-token output
  // ceiling is a maximum, not permanently reserved input space; the normal
  // request shrinks its output budget against the remaining context instead.
  const trigger = contextTriggerTokens(normalBudget.contextWindowTokens);
  if (!opts.force && estimateChatMessagesTokens(messages) <= trigger) {
    return {
      compacted: false,
      blocked: false,
      messages,
      usage: emptyUsage(),
      providerId: routeProvider.id,
      modelID: routeProvider.modelID,
      modelHint,
      passes: 0,
    };
  }

  const summaryBudget = resolveProviderContextBudget(
    routeProvider,
    opts.globalContextWindowTokens,
    COMPACTION_SUMMARY_OUTPUT_TOKENS,
  );
  const sourceTokenBudget = Math.max(
    COMPACTION_MIN_SOURCE_TOKENS,
    Math.floor(summaryBudget.inputBudgetTokens * 0.82),
  );
  let usage = emptyUsage();
  let passes = 0;
  let previousTokens = estimateChatMessagesTokens(messages);
  let forceFirstPass = Boolean(opts.force);
  let finalSummary = "";
  let finalRoute: ConversationRoute | undefined;

  const blockedResult = (): ContextCompactionResult => ({
    compacted: false,
    blocked: true,
    messages: originalMessages,
    usage,
    providerId: routeProvider.id,
    modelID: routeProvider.modelID,
    modelHint,
    passes,
  });

  while (forceFirstPass || previousTokens > trigger) {
    forceFirstPass = false;
    const slice = selectCompactionSlice(messages, sourceTokenBudget, trigger);
    if (!slice) {
      return blockedResult();
    }
    const source = summarySourceText(slice.source, sourceTokenBudget);
    if (!source) {
      return blockedResult();
    }
    if (passes === 0) await opts.onStarted?.();

    const result = await runProviderChatMessages(
      [routeProvider],
      [
        { role: "system", content: COMPACTION_INSTRUCTIONS },
        { role: "user", content: `Conversation to compact:\n\n${source}` },
      ],
      modelHint,
      undefined,
      {
        tools: [],
        toolChoice: "none",
        includeManagedSystemPrompt: false,
        cursorNativeErrorBoundary: true,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 180_000,
        maxCompletionTokens: COMPACTION_SUMMARY_OUTPUT_TOKENS,
        globalContextWindowTokens: opts.globalContextWindowTokens,
      },
    );
    throwIfCompactionAborted(opts.signal);
    const summary = result.text.trim();
    if (!summary) {
      return blockedResult();
    }

    const nextMessages = [retainedSummary(summary), ...slice.remainder];
    const nextTokens = estimateChatMessagesTokens(nextMessages);
    // Do not replace retained history with a summary that is no smaller. It
    // would make a failed recovery look successful and can otherwise loop.
    if (nextTokens >= previousTokens) {
      return blockedResult();
    }

    finalRoute = {
      modelHint,
      providerId: result.providerId,
      modelID: result.modelID,
    };
    messages = nextMessages;
    finalSummary = summary;
    usage = addUsage(usage, result.usage);
    passes += 1;
    previousTokens = nextTokens;
  }

  if (!passes || estimateChatMessagesTokens(messages) > trigger) {
    return blockedResult();
  }

  throwIfCompactionAborted(opts.signal);
  await replaceHistoryMessages(
    opts.historyKey,
    messages,
    finalRoute,
    {
      signal: opts.signal,
      compactionSummary: finalSummary,
    },
  );
  await opts.onSummary?.(finalSummary);

  return {
    compacted: true,
    blocked: false,
    messages,
    usage,
    providerId: routeProvider.id,
    modelID: routeProvider.modelID,
    modelHint,
    passes,
  };
}

function throwIfCompactionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : String(reason || "conversation compaction cancelled"),
  );
  error.name = "AbortError";
  throw error;
}
