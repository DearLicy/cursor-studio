import { encodeToolCallMessage, ToolCallField } from "./agent-proto";
import type { ChatMessage, ToolCall } from "../agent/provider-chat";
import {
  isPromptContextHistoryMessage,
  type HistoryMessage,
  type HistoryPromptContext,
} from "./history";
import {
  normalizeCheckpointReplay,
  shouldPersistCheckpointTool,
} from "./replay-normalizer";
import {
  concatMessages,
  decodeFields,
  encodeBool,
  encodeInt64,
  encodeKey,
  encodeMessage,
  encodeString,
  encodeUint32,
  encodeVarint,
  firstBytes,
  firstString,
  type PbField,
} from "./protobuf-wire";

const ALWAYS_REPLACED_STATE_FIELDS = new Set([1, 4, 5, 6, 8, 10, 11, 13, 17]);
const MAX_UINT32 = 0xffffffff;
const SUMMARY_PREFIXES = [
  [
    "Earlier conversation context was summarized by the selected model.",
    "Treat the following as retained facts and continue consistently:",
  ].join("\n\n"),
  [
    "Earlier conversation context was summarized by Cursor.",
    "Treat the following as retained facts and continue consistently:",
  ].join("\n\n"),
] as const;

export type ConversationCheckpointOptions = {
  messages: readonly HistoryMessage[];
  /** Active-stream pending tool payloads for ConversationStateStructure field 4. */
  pendingToolCalls?: readonly string[];
  /** Successful summary generations in oldest-to-newest order. */
  compactionSummaries?: readonly string[];
  /** Cursor's monotonic self_summary_count. */
  selfSummaryCount?: number;
  /** Canceled turns retained outside provider-visible history. */
  canceledTurns?: readonly {
    sourceRequestId: string;
    replayPolicy: "drop_unstarted_turn" | "keep_stable_input";
    turnSequence?: number;
  }[];
  usedTokens: number;
  maxTokens: number;
  /** AgentMode enum value. Defaults to AGENT_MODE_AGENT. */
  mode?: number;
  /** Last ConversationStateStructure received from Cursor, when available. */
  baseState?: Buffer | Uint8Array;
};

type TurnProjection = {
  user?: HistoryMessage;
  messages: readonly HistoryMessage[];
  turnSequence?: number;
  requestId?: string;
};

type EncodedStep = {
  body: Buffer;
  keys: string[];
  completed: boolean;
  kind: "tool" | "other";
  persistent: boolean;
};

export type StructuredTodoState = {
  id: string;
  content: string;
  status: number;
  createdAt: number;
  updatedAt: number;
  dependencies: string[];
};

type TodoState = StructuredTodoState;

export type StructuredPlanRegistryState = {
  id: string;
  path: string;
};

type PlanRegistryState = StructuredPlanRegistryState;

type StructuredRuntimeState = {
  plan: string;
  hasPlan: boolean;
  planChanged: boolean;
  todos: TodoState[];
  hasTodos: boolean;
  todosChanged: boolean;
  plans: Map<string, PlanRegistryState>;
  plansChanged: boolean;
};

export type ProjectedStructuredRuntimeState = {
  plan?: string;
  hasTodos: boolean;
  todos: TodoState[];
  plans: Record<string, PlanRegistryState>;
};

function normalizeUint32(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(MAX_UINT32, Math.floor(numeric));
}

function normalizeMode(value: number | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(MAX_UINT32, Math.floor(numeric));
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function replayContentParts(message: HistoryMessage | ChatMessage): unknown[] | undefined {
  const parts = "contentParts" in message ? message.contentParts : undefined;
  if (!parts?.length) return undefined;
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      image: {
        mime_type: part.mimeType,
        ...(part.path ? { path: part.path } : {}),
        data: part.dataBase64,
      },
    };
  });
}

function rootPromptMessagesJson(messages: readonly HistoryMessage[]): string[] {
  return normalizeCheckpointReplay(messages).map((message) => {
    const historyMessage = message as HistoryMessage;
    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (isPromptContextHistoryMessage(historyMessage)) {
      payload.prompt_context_source = historyMessage.promptContextSource;
      payload.prompt_context_hash = historyMessage.promptContextHash;
    }
    const contentParts = replayContentParts(message);
    if (contentParts) payload.content_parts = contentParts;
    if (message.role === "assistant") {
      if (message.reasoningContent?.trim() || message.tool_calls?.length) {
        payload.reasoning_content = message.reasoningContent || "";
      }
      if (message.reasoningSignature?.trim()) {
        payload.reasoning_signature = message.reasoningSignature;
      }
      if (message.reasoningSignatureSource?.trim()) {
        payload.reasoning_signature_source = message.reasoningSignatureSource.trim();
      }
      if (message.openAIResponsesReasoningId?.trim()) {
        payload.openai_responses_reasoning_id =
          message.openAIResponsesReasoningId.trim();
      }
      if (message.openAIResponsesReasoningStatus?.trim()) {
        payload.openai_responses_reasoning_status =
          message.openAIResponsesReasoningStatus.trim();
      }
      if (message.openAIResponsesReasoningSummary != null) {
        payload.openai_responses_reasoning_summary =
          message.openAIResponsesReasoningSummary;
      }
      if (message.tool_calls?.length) {
        payload.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: call.type,
          function: call.function,
          ...(call.openAIResponsesId?.trim()
            ? { openai_responses_id: call.openAIResponsesId.trim() }
            : {}),
          ...(call.openAIResponsesCallId?.trim()
            ? { openai_responses_call_id: call.openAIResponsesCallId.trim() }
            : {}),
          ...(call.openAIResponsesStatus?.trim()
            ? { openai_responses_status: call.openAIResponsesStatus.trim() }
            : {}),
        }));
      }
    }
    if (message.role === "tool") {
      payload.tool_call_id = message.tool_call_id;
      if (message.name) payload.name = message.name;
    }
    return JSON.stringify(payload);
  });
}

function safeFields(value: Buffer | Uint8Array | undefined): PbField[] {
  if (!value?.length) return [];
  try {
    return decodeFields(Buffer.from(value));
  } catch {
    return [];
  }
}

function encodePreservedField(field: PbField): Buffer {
  const key = encodeKey(field.field, field.wire);
  switch (field.wire) {
    case 0:
      return Buffer.concat([key, encodeVarint(field.varint ?? 0n)]);
    case 1: {
      const body = field.fixed64?.length === 8 ? field.fixed64 : Buffer.alloc(8);
      return Buffer.concat([key, body]);
    }
    case 2: {
      const body = field.bytes || Buffer.alloc(0);
      return Buffer.concat([key, encodeVarint(body.length), body]);
    }
    case 5: {
      const body = Buffer.alloc(4);
      body.writeUInt32LE(field.fixed32 ?? 0, 0);
      return Buffer.concat([key, body]);
    }
  }
}

function preservedBaseFields(baseFields: PbField[], replaced: ReadonlySet<number>): Buffer[] {
  return baseFields
    .filter((field) => !replaced.has(field.field))
    .map(encodePreservedField);
}

function encodeTokenDetails(baseFields: PbField[], usedTokens: number, maxTokens: number): Buffer {
  const previous = safeFields(firstBytes(baseFields, 5));
  return concatMessages(
    encodeUint32(1, normalizeUint32(usedTokens)),
    encodeUint32(2, normalizeUint32(maxTokens)),
    ...previous
      .filter((field) => field.field !== 1 && field.field !== 2)
      .map(encodePreservedField),
  );
}

function extractCompactionSummary(messages: readonly HistoryMessage[]): {
  summary: string;
  startIndex: number;
} {
  const first = messages[0];
  if (!first || first.role !== "system") return { summary: "", startIndex: 0 };
  const content = cleanText(first.content);
  for (const prefix of SUMMARY_PREFIXES) {
    if (content === prefix) return { summary: "", startIndex: 1 };
    if (content.startsWith(`${prefix}\n\n`)) {
      return {
        summary: cleanText(content.slice(prefix.length)),
        startIndex: 1,
      };
    }
  }
  return { summary: "", startIndex: 0 };
}

type CheckpointCompactionState = {
  summaries: string[];
  selfSummaryCount: number;
};

function normalizeSummaryTexts(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return value.map(cleanText).filter(Boolean);
}

function decodeSummaryText(
  raw: Buffer | undefined,
  fields: readonly number[],
): string {
  const decoded = safeFields(raw);
  for (const field of fields) {
    const text = cleanText(firstString(decoded, field));
    if (text) return text;
  }
  return "";
}

function baseCompactionState(baseFields: PbField[]): CheckpointCompactionState {
  const summaries = baseFields
    .filter((field) => field.field === 13 && field.wire === 2 && field.bytes)
    .map((field) => decodeSummaryText(field.bytes, [2, 1]))
    .filter(Boolean);
  const latest = decodeSummaryText(firstBytes(baseFields, 6), [1]);
  const previous = decodeSummaryText(firstBytes(baseFields, 11), [2, 1]);
  const rawCount = Number(
    baseFields.find((field) => field.field === 17 && field.wire === 0)?.varint || 0n,
  );

  if (!summaries.length) {
    if (previous && (rawCount >= 2 || previous !== latest)) summaries.push(previous);
    if (latest) summaries.push(latest);
  } else if (latest && summaries[summaries.length - 1] !== latest) {
    summaries.push(latest);
  }
  return {
    summaries,
    selfSummaryCount: Math.max(rawCount, summaries.length),
  };
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

function mergeCompactionStates(
  current: CheckpointCompactionState,
  incoming: CheckpointCompactionState,
): CheckpointCompactionState {
  if (incoming.selfSummaryCount < current.selfSummaryCount) return current;
  if (incoming.selfSummaryCount === current.selfSummaryCount) {
    return incoming.summaries.length >= current.summaries.length ? incoming : current;
  }
  return {
    summaries: mergeSummarySequences(
      current.summaries,
      incoming.summaries,
      incoming.selfSummaryCount,
    ),
    selfSummaryCount: incoming.selfSummaryCount,
  };
}

function checkpointCompactionState(
  options: ConversationCheckpointOptions,
  baseFields: PbField[],
  visibleSummary: string,
): CheckpointCompactionState {
  const base = baseCompactionState(baseFields);
  const persistedSummaries = normalizeSummaryTexts(options.compactionSummaries);
  const persistedCount = Math.max(
    persistedSummaries.length,
    normalizeUint32(options.selfSummaryCount || 0),
  );
  const persisted: CheckpointCompactionState = {
    summaries: persistedSummaries,
    selfSummaryCount: persistedCount,
  };
  const state = mergeCompactionStates(base, persisted);
  const summary = cleanText(visibleSummary);
  if (summary && state.summaries[state.summaries.length - 1] !== summary) {
    const priorCount = Math.max(state.selfSummaryCount, state.summaries.length);
    state.summaries.push(summary);
    state.selfSummaryCount = priorCount + 1;
  }
  state.selfSummaryCount = Math.max(state.selfSummaryCount, state.summaries.length);
  return state;
}

function encodeCompactionState(state: CheckpointCompactionState): Buffer {
  const latest = state.summaries[state.summaries.length - 1] || "";
  const previous = state.summaries[state.summaries.length - 2] || "";
  return concatMessages(
    latest ? encodeMessage(6, encodeString(1, latest)) : Buffer.alloc(0),
    // The legacy projector stores archive texts using the compact
    // ConversationSummary payload shape for both field 11 and field 13.
    previous ? encodeMessage(11, encodeString(1, previous)) : Buffer.alloc(0),
    ...state.summaries.map((summary) =>
      encodeMessage(13, encodeString(1, summary)),
    ),
    encodeUint32(17, state.selfSummaryCount),
  );
}

function groupTurns(
  messages: readonly HistoryMessage[],
  startIndex: number,
): TurnProjection[] {
  type IndexedMessage = { index: number; message: HistoryMessage };
  type MutableTurn = {
    entries: IndexedMessage[];
    firstIndex: number;
    turnSequence?: number;
  };

  const turnsBySequence = new Map<number, MutableTurn>();
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role === "system" ||
      isPromptContextHistoryMessage(message)
    ) {
      continue;
    }
    const turnSequence = finiteInteger(message.turnSequence);
    // Match the historical checkpoint projector: imported Cursor replay
    // is stored with TurnSeq=0 and remains provider context only. It must never
    // be promoted back into a locally owned visible turn.
    if (turnSequence <= 0) continue;
    const entry = { index, message };
    let turn = turnsBySequence.get(turnSequence);
    if (!turn) {
      turn = { entries: [], firstIndex: index, turnSequence };
      turnsBySequence.set(turnSequence, turn);
    }
    turn.entries.push(entry);
    turn.firstIndex = Math.min(turn.firstIndex, index);
  }

  return [...turnsBySequence.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((turn) => {
      const entries = [...turn.entries].sort((left, right) => left.index - right.index);
      let user: HistoryMessage | undefined;
      let requestId = "";
      const turnMessages: HistoryMessage[] = [];
      for (const entry of entries) {
        requestId ||= cleanText(entry.message.sourceRequestId);
        if (entry.message.role === "user") user = entry.message;
        else turnMessages.push(entry.message);
      }
      return {
        ...(user ? { user } : {}),
        messages: turnMessages,
        ...(turn.turnSequence ? { turnSequence: turn.turnSequence } : {}),
        ...(requestId ? { requestId } : {}),
      };
    });
}

function encodeUserMessage(message: HistoryMessage, mode: number): Buffer {
  return concatMessages(
    encodeString(1, cleanText(message.content)),
    encodeString(2, cleanText(message.cursorMessageId)),
    encodeUint32(4, mode),
  );
}

function encodeAssistantStep(text: string): Buffer {
  return encodeMessage(1, encodeString(1, text));
}

function parseToolArguments(raw: string, toolCallId: string): Record<string, unknown> {
  let decoded: unknown = {};
  try {
    decoded = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    decoded = { raw_arguments: raw };
  }
  const args: Record<string, unknown> =
    decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? { ...(decoded as Record<string, unknown>) }
      : { value: decoded };
  if (toolCallId && !args.tool_call_id && !args.toolCallId) {
    args.tool_call_id = toolCallId;
  }
  return args;
}

function finiteInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : 0;
}

function todoStatus(value: unknown): number {
  if (Number.isFinite(Number(value))) {
    return Math.max(0, Math.min(4, Math.floor(Number(value))));
  }
  switch (String(value || "").trim().toLowerCase()) {
    case "pending":
    case "todo_status_pending":
      return 1;
    case "in_progress":
    case "in-progress":
    case "inprogress":
    case "todo_status_in_progress":
      return 2;
    case "completed":
    case "complete":
    case "todo_status_completed":
      return 3;
    case "cancelled":
    case "canceled":
    case "todo_status_cancelled":
      return 4;
    default:
      return 1;
  }
}

function normalizeTodo(value: unknown, fallbackTime: number): TodoState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const createdAt = finiteInteger(item.created_at ?? item.createdAt) || fallbackTime;
  const dependencies = Array.isArray(item.dependencies)
    ? item.dependencies.map(cleanText).filter(Boolean)
    : [];
  return {
    id: cleanText(item.id),
    content: cleanText(item.content),
    status: todoStatus(item.status),
    createdAt,
    updatedAt: finiteInteger(item.updated_at ?? item.updatedAt) || createdAt,
    dependencies,
  };
}

function normalizedTodos(value: unknown, fallbackTime: number): TodoState[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeTodo(item, fallbackTime))
    .filter((item): item is TodoState => Boolean(item));
}

function encodeTodo(item: TodoState): Buffer {
  return concatMessages(
    encodeString(1, item.id),
    encodeString(2, item.content),
    encodeUint32(3, item.status),
    encodeInt64(4, item.createdAt),
    encodeInt64(5, item.updatedAt),
    ...item.dependencies.map((dependency) => encodeString(6, dependency)),
  );
}

function encodeCreatePlanArgs(args: Record<string, unknown>, fallbackTime: number): Buffer {
  const directTodos = normalizedTodos(args.todos, fallbackTime);
  const phases = Array.isArray(args.phases)
    ? args.phases.filter(
      (phase): phase is Record<string, unknown> =>
        Boolean(phase) && typeof phase === "object" && !Array.isArray(phase),
    )
    : [];
  return concatMessages(
    encodeString(1, String(args.plan || "")),
    ...directTodos.map((todo) => encodeMessage(2, encodeTodo(todo))),
    encodeString(3, String(args.overview || "")),
    encodeString(4, String(args.name || "")),
    encodeBool(5, Boolean(args.is_project ?? args.isProject)),
    ...phases.map((phase) => {
      const phaseTodos = normalizedTodos(phase.todos, fallbackTime);
      return encodeMessage(
        6,
        concatMessages(
          encodeString(1, String(phase.name || "")),
          ...phaseTodos.map((todo) => encodeMessage(2, encodeTodo(todo))),
        ),
      );
    }),
  );
}

function resultFailed(content: string): boolean {
  return /^\s*(?:error\s*:|failed\b|rejected\b)/i.test(content);
}

function planUriFromResult(content: string): string {
  const text = cleanText(content);
  if (!text || resultFailed(text)) return "";
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const item = value as Record<string, unknown>;
      const nested = item.result && typeof item.result === "object"
        ? item.result as Record<string, unknown>
        : undefined;
      return cleanText(
        item.plan_uri ?? item.planUri ?? item.uri ?? item.path ??
        nested?.plan_uri ?? nested?.planUri ?? nested?.uri ?? nested?.path,
      );
    }
  } catch {
    // Some bridges return the URI as plain text.
  }
  return /^(?:file:|[a-z]:[\\/]|\/|\.\/|\.\.\/)/i.test(text) ? text : "";
}

function encodeCreatePlanResult(content: string): Buffer {
  if (resultFailed(content)) {
    return encodeMessage(2, encodeString(1, cleanText(content)));
  }
  const uri = planUriFromResult(content);
  return concatMessages(
    encodeMessage(1, Buffer.alloc(0)),
    uri ? encodeString(3, uri) : Buffer.alloc(0),
  );
}

function encodeToolStep(
  call: NonNullable<Extract<HistoryMessage, { role: "assistant" }>["tool_calls"]>[number],
  result: Extract<HistoryMessage, { role: "tool" }> | undefined,
  fallbackTime: number,
): Buffer {
  const args = parseToolArguments(call.function.arguments || "", call.id);
  const name = cleanText(call.function.name) || result?.name || "Tool";
  const toolCall = name === "CreatePlan"
    ? encodeMessage(
      ToolCallField.create_plan_tool_call,
      concatMessages(
        encodeMessage(1, encodeCreatePlanArgs(args, fallbackTime)),
        result ? encodeMessage(2, encodeCreatePlanResult(result.content)) : Buffer.alloc(0),
      ),
    )
    : encodeToolCallMessage({
      name,
      args,
      ...(result
        ? { resultText: result.content, ok: !resultFailed(result.content) }
        : {}),
    });
  return encodeMessage(2, toolCall);
}

function comparableArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    const copy = { ...(parsed as Record<string, unknown>) };
    delete copy.tool_call_id;
    delete copy.toolCallId;
    return stableJson(copy);
  } catch {
    return cleanText(raw);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolKeys(call: { id?: string; function: { name: string; arguments: string } }): string[] {
  const keys = [
    `tool-shape:${cleanText(call.function.name)}:${comparableArguments(call.function.arguments || "")}`,
  ];
  const id = cleanText(call.id);
  if (id && !/^cursor-turn-\d+-step-\d+$/.test(id)) keys.unshift(`tool-id:${id}`);
  return keys;
}

function localTurnSteps(turn: TurnProjection): EncodedStep[] {
  const results = new Map<string, Extract<HistoryMessage, { role: "tool" }>>();
  for (const message of turn.messages) {
    if (message.role === "tool" && message.tool_call_id && !results.has(message.tool_call_id)) {
      results.set(message.tool_call_id, message);
    }
  }

  const fallbackTime = Math.max(
    0,
    finiteInteger(turn.user?.at || turn.messages[0]?.at),
  ) || Date.now();
  const steps: EncodedStep[] = [];
  for (const message of turn.messages) {
    if (message.role !== "assistant") continue;
    const text = cleanText(message.content);
    if (text) {
      steps.push({
        body: encodeAssistantStep(text),
        keys: [`assistant:${text}`],
        completed: true,
        kind: "other",
        persistent: true,
      });
    }
    for (const call of message.tool_calls || []) {
      if (!shouldPersistCheckpointTool(call.function.name)) continue;
      const result = results.get(call.id);
      steps.push({
        body: encodeToolStep(call, result, fallbackTime),
        keys: toolKeys(call),
        completed: Boolean(result),
        kind: "tool",
        persistent: true,
      });
    }
  }
  return steps;
}

function turnRequestId(turn: TurnProjection): string {
  const canonical = cleanText(turn.requestId);
  if (canonical) return canonical;
  const candidates = [turn.user, ...turn.messages].filter(
    (message): message is HistoryMessage => Boolean(message),
  );
  for (const message of candidates) {
    const requestId = cleanText(message.sourceRequestId);
    if (requestId) return requestId;
  }
  return "";
}

function encodeTurn(turn: TurnProjection, mode: number): Buffer | undefined {
  const steps = localTurnSteps(turn);
  if (!turn.user && !steps.length) return undefined;
  const agentTurn = concatMessages(
    turn.user
      ? encodeMessage(1, encodeUserMessage(turn.user, mode))
      : Buffer.alloc(0),
    ...steps.map((step) => encodeMessage(2, step.body)),
    encodeString(3, turnRequestId(turn)),
  );
  return encodeMessage(1, agentTurn);
}

function mergedTurnBytes(
  turns: TurnProjection[],
  mode: number,
): Buffer[] {
  return turns
    .map((turn) => encodeTurn(turn, mode))
    .filter((turn): turn is Buffer => Boolean(turn));
}

function normalizePendingToolCalls(values: readonly string[] | undefined): string[] {
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    const item = cleanText(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    pending.push(item);
  }
  return pending;
}

function decodeTodoState(raw: Buffer | undefined): TodoState | undefined {
  if (!raw?.length) return undefined;
  const fields = safeFields(raw);
  const id = cleanText(firstString(fields, 1));
  const content = cleanText(firstString(fields, 2));
  if (!id || !content) return undefined;
  return {
    id,
    content,
    status: todoStatus(Number(fields.find((field) => field.field === 3)?.varint || 0n)),
    createdAt: Number(fields.find((field) => field.field === 4)?.varint || 0n),
    updatedAt: Number(fields.find((field) => field.field === 5)?.varint || 0n),
    dependencies: fields
      .filter((field) => field.field === 6 && field.wire === 2 && field.bytes)
      .map((field) => cleanText(field.bytes?.toString("utf8")))
      .filter(Boolean),
  };
}

function decodePlanRegistry(baseFields: PbField[]): Map<string, PlanRegistryState> {
  const plans = new Map<string, PlanRegistryState>();
  for (const field of baseFields) {
    if (field.field !== 20 || field.wire !== 2 || !field.bytes) continue;
    const mapFields = safeFields(field.bytes);
    const key = cleanText(firstString(mapFields, 1));
    const entryFields = safeFields(firstBytes(mapFields, 2));
    const id = cleanText(firstString(entryFields, 1)) || key;
    const path = cleanText(firstString(entryFields, 2));
    if (!key || !path) continue;
    plans.set(key, { id, path });
  }
  return plans;
}

function baseStructuredRuntimeState(baseFields: PbField[]): StructuredRuntimeState {
  const todos = baseFields
    .filter((field) => field.field === 3 && field.wire === 2 && field.bytes)
    .map((field) => decodeTodoState(field.bytes))
    .filter((todo): todo is TodoState => Boolean(todo));
  const rawPlan = firstBytes(baseFields, 7);
  const plan = cleanText(firstString(safeFields(rawPlan), 1));
  return {
    plan,
    hasPlan: Boolean(plan),
    planChanged: false,
    todos,
    hasTodos: todos.length > 0,
    todosChanged: false,
    plans: decodePlanRegistry(baseFields),
    plansChanged: false,
  };
}

function parsedResultObject(content: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(cleanText(content)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function resultTodos(
  content: string,
  fallbackTime: number,
): { present: boolean; todos: TodoState[] } {
  const result = parsedResultObject(content);
  if (!result) return { present: false, todos: [] };
  const nested = result.result && typeof result.result === "object" && !Array.isArray(result.result)
    ? result.result as Record<string, unknown>
    : undefined;
  const value = Object.prototype.hasOwnProperty.call(result, "todos")
    ? result.todos
    : nested && Object.prototype.hasOwnProperty.call(nested, "todos")
      ? nested.todos
      : undefined;
  return {
    present: Array.isArray(value),
    todos: normalizedTodos(value, fallbackTime),
  };
}

function todoIsTerminal(todo: TodoState): boolean {
  return todo.status === 3 || todo.status === 4;
}

function mergedTodoUpdate(
  existing: readonly TodoState[],
  args: Record<string, unknown>,
  fallbackTime: number,
): TodoState[] {
  const rawUpdates = Array.isArray(args.todos) ? args.todos : [];
  const updates = normalizedTodos(rawUpdates, fallbackTime);
  const mergeWasSet = Object.prototype.hasOwnProperty.call(args, "merge");
  const incomingIds = new Set(updates.map((todo) => todo.id).filter(Boolean));
  const missesActive = existing.some(
    (todo) => !todoIsTerminal(todo) && todo.id && !incomingIds.has(todo.id),
  );
  const omitsContent = rawUpdates.some(
    (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
      !cleanText((item as Record<string, unknown>).content),
  );
  const merge = args.merge === true || (!mergeWasSet && existing.length > 0 && (missesActive || omitsContent));
  if (!merge) return updates;

  const next = existing.map((todo) => ({ ...todo, dependencies: [...todo.dependencies] }));
  const indexById = new Map(next.map((todo, index) => [todo.id, index]));
  for (const raw of rawUpdates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const id = cleanText(value.id);
    if (!id) continue;
    const index = indexById.get(id);
    if (index == null) {
      const added = normalizeTodo(value, fallbackTime);
      if (!added?.content) continue;
      indexById.set(id, next.length);
      next.push(added);
      continue;
    }
    const current = next[index];
    const content = cleanText(value.content);
    const statusSpecified = value.status != null && cleanText(String(value.status)) !== "";
    next[index] = {
      ...current,
      ...(content ? { content } : {}),
      ...(statusSpecified ? { status: todoStatus(value.status) } : {}),
      ...(Array.isArray(value.dependencies) && value.dependencies.length
        ? { dependencies: value.dependencies.map(cleanText).filter(Boolean) }
        : {}),
      updatedAt: fallbackTime,
    };
  }
  return next;
}

function upsertCurrentPlan(
  plans: Map<string, PlanRegistryState>,
  planUri: string,
): Map<string, PlanRegistryState> {
  const next = new Map(plans);
  let key = "current";
  if (!next.has(key) && next.size === 1) key = next.keys().next().value || key;
  next.set(key, { id: key, path: planUri });
  return next;
}

function completedStructuredState(
  messages: readonly HistoryMessage[],
  baseFields: PbField[],
): StructuredRuntimeState {
  const results = new Map<string, Extract<HistoryMessage, { role: "tool" }>>();
  for (const message of messages) {
    if (message.role === "tool" && cleanText(message.tool_call_id)) {
      results.set(cleanText(message.tool_call_id), message);
    }
  }

  let state = baseStructuredRuntimeState(baseFields);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls || []) {
      const name = cleanText(call.function.name);
      const result = results.get(cleanText(call.id));
      if (!result || resultFailed(result.content)) continue;
      const args = parseToolArguments(call.function.arguments || "", "");
      const fallbackTime = Math.max(0, finiteInteger(message.at)) || Date.now();
      if (name === "CreatePlan") {
        const planUri = planUriFromResult(result.content);
        if (!planUri) continue;
        const phases = Array.isArray(args.phases)
          ? args.phases.filter(
            (phase): phase is Record<string, unknown> =>
              Boolean(phase) && typeof phase === "object" && !Array.isArray(phase),
          )
          : [];
        const directTodos = normalizedTodos(args.todos, fallbackTime);
        const phaseTodos = phases.flatMap((phase) => normalizedTodos(phase.todos, fallbackTime));
        state = {
          ...state,
          plan: cleanText(args.plan),
          hasPlan: true,
          planChanged: true,
          todos: directTodos.length ? directTodos : phaseTodos,
          hasTodos: true,
          todosChanged: true,
          plans: upsertCurrentPlan(state.plans, planUri),
          plansChanged: true,
        };
        continue;
      }
      if (name === "TodoWrite") {
        const projected = resultTodos(result.content, fallbackTime);
        state.todos = projected.present
          ? projected.todos
          : mergedTodoUpdate(state.todos, args, fallbackTime);
        state.hasTodos = true;
        state.todosChanged = true;
        continue;
      }
      if (name === "ReadTodos" && !state.hasTodos) {
        const hasFilters =
          (Array.isArray(args.status_filter) && args.status_filter.length > 0) ||
          (Array.isArray(args.statusFilter) && args.statusFilter.length > 0) ||
          (Array.isArray(args.id_filter) && args.id_filter.length > 0) ||
          (Array.isArray(args.idFilter) && args.idFilter.length > 0);
        const projected = resultTodos(result.content, fallbackTime);
        if (!hasFilters && projected.present) {
          state.todos = projected.todos;
          state.hasTodos = true;
          state.todosChanged = true;
        }
      }
    }
  }
  return state;
}

export function projectStructuredRuntimeState(
  messages: readonly HistoryMessage[],
  baseState?: Buffer | Uint8Array,
): ProjectedStructuredRuntimeState {
  const state = completedStructuredState(messages, safeFields(baseState));
  return {
    ...(state.hasPlan && state.plan ? { plan: state.plan } : {}),
    hasTodos: state.hasTodos,
    todos: state.todos.map((todo) => ({
      ...todo,
      dependencies: [...todo.dependencies],
    })),
    plans: Object.fromEntries(
      [...state.plans].map(([key, plan]) => [key, { ...plan }]),
    ),
  };
}

function todoStatusLabel(status: number): string {
  switch (status) {
    case 2:
      return "in_progress";
    case 3:
      return "completed";
    case 4:
      return "cancelled";
    default:
      return "pending";
  }
}

/** Structured-state contexts persisted once per source/hash in a turn. */
export function structuredRuntimePromptContexts(
  state: ProjectedStructuredRuntimeState,
): HistoryPromptContext[] {
  const contexts: HistoryPromptContext[] = [];
  if (state.plan) {
    contexts.push({
      source: "structured_state/current_plan",
      message: {
        role: "user",
        content: `<current_plan>\n${state.plan}\n</current_plan>`,
      },
    });
  }
  if (state.hasTodos) {
    const todoText = state.todos
      .map((todo) => `- [${todoStatusLabel(todo.status)}] ${todo.id}: ${todo.content}`)
      .join("\n");
    if (todoText) {
      contexts.push({
        source: "structured_state/todo_list",
        message: {
          role: "user",
          content: `<todo_list>\n${todoText}\n</todo_list>`,
        },
      });
      contexts.push({
        source: "structured_state/todo_reminder",
        message: {
          role: "user",
          content: [
            "<system_reminder>",
            "You are currently under the todo section, be sure to track tasks and do not forget to update.",
            "</system_reminder>",
          ].join("\n"),
        },
      });
    }
  }
  return contexts;
}

export function structuredRuntimePromptMessages(
  state: ProjectedStructuredRuntimeState,
): ChatMessage[] {
  return structuredRuntimePromptContexts(state).map((context) => context.message);
}

/** Treat a later CreatePlan as an update to the current registry entry. */
export function sanitizeCreatePlanToolCallsForState(
  toolCalls: readonly ToolCall[],
  state: ProjectedStructuredRuntimeState,
): ToolCall[] {
  if (!state.plan && Object.keys(state.plans).length === 0) {
    return toolCalls.map((call) => ({ ...call, function: { ...call.function } }));
  }
  return toolCalls.map((call) => {
    if (cleanText(call.function.name) !== "CreatePlan") {
      return { ...call, function: { ...call.function } };
    }
    const args = parseToolArguments(call.function.arguments || "", "");
    if (!cleanText(args.name)) {
      return { ...call, function: { ...call.function } };
    }
    args.name = "";
    return {
      ...call,
      function: {
        ...call.function,
        arguments: JSON.stringify(args),
      },
    };
  });
}

function encodePlanRegistryEntry(key: string, plan: PlanRegistryState): Buffer {
  return concatMessages(
    encodeString(1, key),
    encodeMessage(
      2,
      concatMessages(
        encodeString(1, cleanText(plan.id) || key),
        encodeString(2, plan.path),
      ),
    ),
  );
}

/**
 * Projects durable provider history into Cursor's ConversationStateStructure.
 * Positive TurnSeq history is the canonical visible-turn source. Imported
 * Cursor replay remains TurnSeq=0 provider context and is never re-emitted as
 * a locally owned turn.
 */
export function projectConversationCheckpoint(
  options: ConversationCheckpointOptions,
): Buffer {
  const mode = normalizeMode(options.mode);
  const baseFields = safeFields(options.baseState);
  const { summary, startIndex } = extractCompactionSummary(options.messages);
  const compaction = checkpointCompactionState(options, baseFields, summary);
  const turns = groupTurns(options.messages, startIndex);
  const mergedTurns = mergedTurnBytes(
    turns,
    mode,
  );
  const pending = normalizePendingToolCalls(options.pendingToolCalls);
  const runtimeState = completedStructuredState(options.messages, baseFields);
  const replaced = new Set(ALWAYS_REPLACED_STATE_FIELDS);
  if (runtimeState.todosChanged) replaced.add(3);
  if (runtimeState.planChanged) replaced.add(7);
  if (runtimeState.plansChanged) replaced.add(20);

  return concatMessages(
    ...preservedBaseFields(baseFields, replaced),
    ...rootPromptMessagesJson(options.messages).map((message) =>
      encodeString(1, message),
    ),
    ...pending.map((item) => encodeString(4, item)),
    encodeMessage(5, encodeTokenDetails(baseFields, options.usedTokens, options.maxTokens)),
    encodeCompactionState(compaction),
    runtimeState.todosChanged
      ? concatMessages(
        ...runtimeState.todos.map((todo) => encodeMessage(3, encodeTodo(todo))),
      )
      : Buffer.alloc(0),
    runtimeState.planChanged && runtimeState.hasPlan
      ? encodeMessage(7, encodeString(1, runtimeState.plan))
      : Buffer.alloc(0),
    runtimeState.plansChanged
      ? concatMessages(
        ...[...runtimeState.plans].map(([key, plan]) =>
          encodeMessage(20, encodePlanRegistryEntry(key, plan)),
        ),
      )
      : Buffer.alloc(0),
    ...mergedTurns.map((turn) => encodeMessage(8, turn)),
    encodeUint32(10, mode),
  );
}

export const encodeConversationCheckpointState = projectConversationCheckpoint;
