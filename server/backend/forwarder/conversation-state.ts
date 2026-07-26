/**
 * Conservative projection of Cursor's persisted ConversationStateStructure.
 *
 * Cursor stores committed turns as raw protobuf bytes in state.turns (field 8):
 * ConversationTurnStructure -> AgentConversationTurnStructure -> UserMessage /
 * ConversationStep. This module deliberately has no storage side effects so a
 * caller can compare its output with local history before adopting it.
 */
import type { ChatMessage, ToolCall } from "../agent/provider-chat";
import type { ChatContentPart } from "../agent/content-parts";
import {
  ToolCallField,
  decodeMcpArgs,
  peekToolCall,
} from "./agent-proto";
import {
  collectStrings,
  decodeFields,
  firstBytes,
  firstString,
  firstVarint,
  type PbField,
} from "./protobuf-wire";

const DEFAULT_MAX_TEXT_CHARS = 512 * 1024;
const MAX_DIAGNOSTICS = 256;

export type ConversationStateProjectionDiagnostic = {
  code:
    | "invalid_state"
    | "invalid_root_replay"
    | "invalid_turn"
    | "unsupported_turn"
    | "empty_turn"
    | "invalid_step"
    | "unsupported_step"
    | "unsupported_tool";
  turn?: number;
  step?: number;
};

export type ConversationStateProjectionOptions = {
  /** Include stored reasoning as a tagged assistant message. Defaults to false. */
  includeThinking?: boolean;
  /** Bounded text projection prevents a corrupt state from consuming unbounded memory. */
  maxTextChars?: number;
  /** Prefer committed field 8 turns over field 1 prompt replay. */
  preferTurns?: boolean;
  /**
   * Permit field 1 root-prompt replay when field 8 has no usable turns.
   * Callers synchronizing an existing local conversation should disable this
   * so stale prompt replay cannot be merged as new visible history.
   */
  allowRootReplay?: boolean;
};

/** ChatMessage enriched with Cursor's persisted turn lineage metadata. */
export type ProjectedChatMessage = ChatMessage & {
  /** Present on the UserMessage that began this Cursor turn. */
  cursorMessageId?: string;
  /** Cursor turn order, normalized to one-based indexing. */
  turnSequence: number;
  /** Bidi request that produced the persisted Cursor turn. */
  sourceRequestId?: string;
  /** Runtime prompt-context identity; these messages do not start user turns. */
  promptContextSource?: string;
  promptContextHash?: string;
};

export type ConversationStateProjection = {
  messages: ProjectedChatMessage[];
  /** Successful summary generations in oldest-to-newest order. */
  compactionSummaries: string[];
  /** Raw Cursor self_summary_count, never lower than known summary generations. */
  selfSummaryCount: number;
  turnCount: number;
  decodedTurns: number;
  skippedTurns: number;
  skippedSteps: number;
  diagnostics: ConversationStateProjectionDiagnostic[];
};

type ToolArguments = {
  args: Record<string, unknown>;
  callId?: string;
};

type ProjectedTodo = {
  id?: string;
  content?: string;
  status?: number;
  created_at?: number;
  updated_at?: number;
  dependencies?: string[];
};

type ProjectionContext = {
  includeThinking: boolean;
  maxTextChars: number;
  messages: ProjectedChatMessage[];
  diagnostics: ConversationStateProjectionDiagnostic[];
  decodedTurns: number;
  skippedTurns: number;
  skippedSteps: number;
};

const TOOL_NAMES: Readonly<Record<number, string>> = {
  [ToolCallField.shell_tool_call]: "Shell",
  3: "Delete",
  4: "Glob",
  [ToolCallField.grep_tool_call]: "Grep",
  [ToolCallField.read_tool_call]: "Read",
  9: "TodoWrite",
  10: "ReadTodos",
  [ToolCallField.edit_tool_call]: "Edit",
  [ToolCallField.ls_tool_call]: "Ls",
  14: "ReadLints",
  [ToolCallField.mcp_tool_call]: "CallMcpTool",
  16: "SemanticSearch",
  [ToolCallField.create_plan_tool_call]: "CreatePlan",
  [ToolCallField.web_search_tool_call]: "WebSearch",
  [ToolCallField.task_tool_call]: "Task",
  20: "ListMcpResources",
  21: "FetchMcpResource",
  22: "ApplyAgentDiff",
  [ToolCallField.ask_question_tool_call]: "AskQuestion",
  24: "Fetch",
  [ToolCallField.switch_mode_tool_call]: "SwitchMode",
  28: "GenerateImage",
  29: "RecordScreen",
  30: "ComputerUse",
  31: "WriteShellStdin",
  32: "Reflect",
  33: "SetupVmEnvironment",
  34: "TruncatedToolCall",
  35: "StartGrindExecution",
  36: "StartGrindPlanning",
  [ToolCallField.web_fetch_tool_call]: "WebFetch",
  38: "ReportBugfixResults",
  39: "AiAttribution",
  40: "PrManagement",
  41: "McpAuth",
  [ToolCallField.await_tool_call]: "AwaitShell",
  43: "BlameByFilePath",
  44: "GetMcpTools",
  45: "ReportBug",
  46: "SetActiveBranch",
  48: "CommunicateUpdate",
  49: "SendFinalSummary",
  50: "UpdatePrCodeTour",
  51: "ReplaceEnv",
  52: "EditPrLabels",
  53: "RecordCiInvestigationFindings",
};

function maxTextChars(value: number | undefined): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_TEXT_CHARS;
  return Math.max(1_024, Math.min(numeric, 2 * 1024 * 1024));
}

function cleanText(value: string | undefined, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text || text.includes("\0") || text.includes("\uFFFD")) return "";

  let controlCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10) controlCount += 1;
  }
  if (controlCount / Math.max(1, text.length) > 0.02) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

function replayContentParts(
  value: unknown,
  limit: number,
): ChatContentPart[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("root replay content_parts is not an array");
  const parts: ChatContentPart[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("root replay content part is invalid");
    }
    const part = raw as Record<string, unknown>;
    if (part.type === "text") {
      const text = cleanText(
        typeof part.text === "string" ? part.text : undefined,
        limit,
      );
      if (!text) throw new Error("root replay text part is empty");
      parts.push({ type: "text", text });
      continue;
    }
    if (part.type !== "image") throw new Error("unsupported root replay content part");
    const image = part.image;
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error("root replay image part is invalid");
    }
    const shape = image as Record<string, unknown>;
    const dataBase64 =
      typeof shape.data === "string" ? shape.data.trim() : "";
    if (!dataBase64) throw new Error("root replay image data is missing");
    parts.push({
      type: "image",
      mimeType:
        typeof shape.mime_type === "string" && shape.mime_type.trim()
          ? shape.mime_type.trim()
          : "image/png",
      dataBase64,
      ...(typeof shape.path === "string" && shape.path.trim()
        ? { path: shape.path.trim() }
        : {}),
    });
  }
  return parts.length ? parts : undefined;
}

function replayJsonValue(value: unknown, limit: number): unknown | undefined {
  if (value == null) return undefined;
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > limit) {
    throw new Error("root replay JSON metadata exceeds its limit");
  }
  return JSON.parse(encoded) as unknown;
}

function replayToolCalls(value: unknown, limit: number): ToolCall[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("root replay tool_calls is not an array");
  const calls: ToolCall[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("root replay tool call is invalid");
    }
    const call = raw as Record<string, unknown>;
    const fn = call.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
      throw new Error("root replay tool function is invalid");
    }
    const functionShape = fn as Record<string, unknown>;
    const id = cleanText(typeof call.id === "string" ? call.id : undefined, limit);
    const name = cleanText(
      typeof functionShape.name === "string" ? functionShape.name : undefined,
      limit,
    );
    const args =
      typeof functionShape.arguments === "string"
        ? functionShape.arguments.slice(0, limit)
        : "";
    if (!id || !name || typeof functionShape.arguments !== "string") {
      throw new Error("root replay tool call is incomplete");
    }
    const openAIResponsesId = cleanText(
      typeof call.openai_responses_id === "string"
        ? call.openai_responses_id
        : typeof call.openAIResponsesId === "string"
          ? call.openAIResponsesId
          : undefined,
      limit,
    );
    const openAIResponsesCallId = cleanText(
      typeof call.openai_responses_call_id === "string"
        ? call.openai_responses_call_id
        : typeof call.openAIResponsesCallId === "string"
          ? call.openAIResponsesCallId
          : undefined,
      limit,
    );
    const openAIResponsesStatus = cleanText(
      typeof call.openai_responses_status === "string"
        ? call.openai_responses_status
        : typeof call.openAIResponsesStatus === "string"
          ? call.openAIResponsesStatus
          : undefined,
      limit,
    );
    calls.push({
      id,
      type: "function",
      function: { name, arguments: args },
      ...(openAIResponsesId ? { openAIResponsesId } : {}),
      ...(openAIResponsesCallId ? { openAIResponsesCallId } : {}),
      ...(openAIResponsesStatus ? { openAIResponsesStatus } : {}),
    });
  }
  return calls.length ? calls : undefined;
}

function safeFields(value: Buffer | Uint8Array | undefined): PbField[] | undefined {
  if (!value?.length) return [];
  try {
    return decodeFields(Buffer.from(value));
  } catch {
    return undefined;
  }
}

function fieldStrings(fields: PbField[], field: number, limit: number): string[] {
  const strings: string[] = [];
  for (const item of fields) {
    if (item.field !== field || item.wire !== 2 || !item.bytes) continue;
    const text = cleanText(item.bytes.toString("utf8"), limit);
    if (text) strings.push(text);
  }
  return strings;
}

function putString(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
  limit: number,
): void {
  const text = cleanText(value, limit);
  if (text) target[key] = text;
}

function putNumber(
  target: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value != null && Number.isFinite(value)) target[key] = value;
}

function putBool(
  target: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value != null) target[key] = value !== 0;
}

function projectTodo(raw: Buffer | undefined, limit: number): ProjectedTodo | undefined {
  const fields = safeFields(raw);
  if (!fields) return undefined;
  const item: ProjectedTodo = {};
  const id = cleanText(firstString(fields, 1), limit);
  const content = cleanText(firstString(fields, 2), limit);
  const status = firstVarint(fields, 3);
  const createdAt = firstVarint(fields, 4);
  const updatedAt = firstVarint(fields, 5);
  const dependencies = fieldStrings(fields, 6, limit);
  if (id) item.id = id;
  if (content) item.content = content;
  if (status != null) item.status = status;
  if (createdAt != null) item.created_at = createdAt;
  if (updatedAt != null) item.updated_at = updatedAt;
  if (dependencies.length) item.dependencies = dependencies;
  return item;
}

function projectedTodos(fields: PbField[], field: number, limit: number): ProjectedTodo[] {
  return fields
    .filter((item) => item.field === field && item.wire === 2 && item.bytes !== undefined)
    .map((item) => projectTodo(item.bytes, limit))
    .filter((item): item is ProjectedTodo => Boolean(item));
}

function projectedPhases(fields: PbField[], limit: number): Array<Record<string, unknown>> {
  return fields
    .filter((item) => item.field === 6 && item.wire === 2 && item.bytes !== undefined)
    .map((item) => {
      const phaseFields = safeFields(item.bytes);
      if (!phaseFields) return undefined;
      const phase: Record<string, unknown> = {};
      const name = cleanText(firstString(phaseFields, 1), limit);
      const todos = projectedTodos(phaseFields, 2, limit);
      if (name) phase.name = name;
      if (todos.length) phase.todos = todos;
      return phase;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function recordDiagnostic(
  context: ProjectionContext,
  item: ConversationStateProjectionDiagnostic,
): void {
  if (context.diagnostics.length < MAX_DIAGNOSTICS) context.diagnostics.push(item);
}

function toolArgsFromFields(
  toolField: number,
  rawArgs: Buffer | undefined,
  limit: number,
): ToolArguments {
  if (!rawArgs?.length) return { args: {} };

  if (toolField === ToolCallField.mcp_tool_call) {
    const mcp = decodeMcpArgs(rawArgs);
    const args: Record<string, unknown> = { ...mcp.args };
    putString(args, "name", mcp.name, limit);
    putString(args, "server", mcp.providerIdentifier, limit);
    putString(args, "toolName", mcp.toolName, limit);
    return { args, callId: cleanText(mcp.toolCallId, limit) || undefined };
  }

  const fields = safeFields(rawArgs);
  if (!fields) return { args: {} };
  const args: Record<string, unknown> = {};
  const stringAt = (field: number) => cleanText(firstString(fields, field), limit);
  const numberAt = (field: number) => firstVarint(fields, field);

  switch (toolField) {
    case ToolCallField.shell_tool_call:
      putString(args, "command", stringAt(1), limit);
      putString(args, "working_directory", stringAt(2), limit);
      putNumber(args, "timeout", numberAt(3));
      putBool(args, "is_background", numberAt(11));
      putString(args, "description", stringAt(15), limit);
      return { args, callId: stringAt(4) || undefined };
    case 3:
      putString(args, "path", stringAt(1), limit);
      return { args, callId: stringAt(2) || undefined };
    case 4:
      putString(args, "target_directory", stringAt(1), limit);
      putString(args, "glob_pattern", stringAt(2), limit);
      return { args };
    case ToolCallField.grep_tool_call:
      putString(args, "pattern", stringAt(1), limit);
      putString(args, "path", stringAt(2), limit);
      putString(args, "glob", stringAt(3), limit);
      putString(args, "output_mode", stringAt(4), limit);
      putBool(args, "case_insensitive", numberAt(8));
      putNumber(args, "head_limit", numberAt(10));
      return { args, callId: stringAt(14) || undefined };
    case ToolCallField.read_tool_call:
      putString(args, "path", stringAt(1), limit);
      putNumber(args, "offset", numberAt(2));
      putNumber(args, "limit", numberAt(3));
      putBool(args, "include_line_numbers", numberAt(5));
      return { args };
    case ToolCallField.edit_tool_call:
      putString(args, "path", stringAt(1), limit);
      putString(args, "stream_content", stringAt(6), limit);
      return { args };
    case ToolCallField.ls_tool_call:
      putString(args, "path", stringAt(1), limit);
      const ignore = fieldStrings(fields, 2, limit);
      if (ignore.length) args.ignore = ignore;
      putNumber(args, "timeout_ms", numberAt(5));
      return { args, callId: stringAt(3) || undefined };
    case ToolCallField.web_search_tool_call:
      putString(args, "search_term", stringAt(1), limit);
      return { args, callId: stringAt(2) || undefined };
    case ToolCallField.task_tool_call:
      putString(args, "description", stringAt(1), limit);
      putString(args, "prompt", stringAt(2), limit);
      putString(args, "model", stringAt(4), limit);
      putString(args, "resume", stringAt(5), limit);
      return { args };
    case ToolCallField.web_fetch_tool_call:
      putString(args, "url", stringAt(1), limit);
      return { args, callId: stringAt(2) || undefined };
    case ToolCallField.switch_mode_tool_call:
      putString(args, "target_mode_id", stringAt(1), limit);
      putString(args, "explanation", stringAt(2), limit);
      return { args, callId: stringAt(3) || undefined };
    case 17:
      putString(args, "plan", stringAt(1), limit);
      {
        const todos = projectedTodos(fields, 2, limit);
        if (todos.length) args.todos = todos;
      }
      putString(args, "overview", stringAt(3), limit);
      putString(args, "name", stringAt(4), limit);
      putBool(args, "is_project", numberAt(5));
      {
        const phases = projectedPhases(fields, limit);
        if (phases.length) args.phases = phases;
      }
      return { args };
    case 31:
      putNumber(args, "shell_id", numberAt(1));
      putString(args, "chars", stringAt(2), limit);
      return { args };
    default:
      return { args: {} };
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function toolResultText(
  rawResult: Buffer | undefined,
  rawToolCall: Buffer,
  limit: number,
): string {
  if (!rawResult) return "";
  const resultFields = safeFields(rawResult);
  const preferred = resultFields?.find(
    (field) => field.field === 1 && field.wire === 2 && field.bytes,
  );
  const resultPayload = preferred?.bytes || rawResult;
  const parts = uniqueStrings(
    collectStrings(resultPayload, 24)
      .map((value) => cleanText(value, limit))
      .filter(Boolean),
  );
  if (parts.length) return cleanText(parts.join("\n"), limit);
  return cleanText(peekToolCall(rawToolCall).resultText, limit);
}

function projectToolCall(
  rawToolCall: Buffer,
  turn: number,
  step: number,
  turnSequence: number,
  context: ProjectionContext,
): void {
  const top = safeFields(rawToolCall);
  if (!top) {
    context.skippedSteps += 1;
    recordDiagnostic(context, { code: "invalid_step", turn, step });
    return;
  }

  const tool = top.find(
    (field) => field.wire === 2 && field.bytes && TOOL_NAMES[field.field],
  );
  if (!tool?.bytes) {
    context.skippedSteps += 1;
    recordDiagnostic(context, { code: "unsupported_tool", turn, step });
    return;
  }

  const toolName = TOOL_NAMES[tool.field];
  const body = safeFields(tool.bytes);
  if (!body) {
    context.skippedSteps += 1;
    recordDiagnostic(context, { code: "invalid_step", turn, step });
    return;
  }

  const decoded = toolArgsFromFields(
    tool.field,
    firstBytes(body, 1),
    context.maxTextChars,
  );
  const callId = decoded.callId || `cursor-turn-${turn + 1}-step-${step + 1}`;
  const toolCall: ToolCall = {
    id: callId,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(decoded.args),
    },
  };
  context.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [toolCall],
    turnSequence,
  });

  const result = body.find(
    (field) => field.field === 2 && field.wire === 2 && field.bytes !== undefined,
  )?.bytes;
  if (result === undefined) return;

  const resultHint = peekToolCall(rawToolCall);
  const content =
    toolResultText(result, rawToolCall, context.maxTextChars) ||
    (resultHint.resultOk === false ? "Tool call failed." : "Tool call completed.");
  context.messages.push({
    role: "tool",
    content,
    tool_call_id: callId,
    name: toolName,
    turnSequence,
  });
}

function projectStep(
  rawStep: Buffer,
  turn: number,
  step: number,
  turnSequence: number,
  context: ProjectionContext,
): void {
  const fields = safeFields(rawStep);
  if (!fields) {
    context.skippedSteps += 1;
    recordDiagnostic(context, { code: "invalid_step", turn, step });
    return;
  }

  const assistant = firstBytes(fields, 1);
  if (assistant) {
    const assistantFields = safeFields(assistant);
    const text = cleanText(
      assistantFields ? firstString(assistantFields, 1) : undefined,
      context.maxTextChars,
    );
    if (text) {
      context.messages.push({ role: "assistant", content: text, turnSequence });
    }
    else if (!assistantFields) {
      context.skippedSteps += 1;
      recordDiagnostic(context, { code: "invalid_step", turn, step });
    }
    return;
  }

  const toolCall = firstBytes(fields, 2);
  if (toolCall) {
    projectToolCall(toolCall, turn, step, turnSequence, context);
    return;
  }

  const thinking = firstBytes(fields, 3);
  if (thinking) {
    if (context.includeThinking) {
      const thinkingFields = safeFields(thinking);
      const text = cleanText(
        thinkingFields ? firstString(thinkingFields, 1) : undefined,
        context.maxTextChars,
      );
      if (text) {
        context.messages.push({
          role: "assistant",
          content: `<thinking>\n${text}\n</thinking>`,
          turnSequence,
        });
      }
    }
    return;
  }

  context.skippedSteps += 1;
  recordDiagnostic(context, { code: "unsupported_step", turn, step });
}

function projectTurn(rawTurn: Buffer, turn: number, context: ProjectionContext): void {
  const turnFields = safeFields(rawTurn);
  const agentTurn = turnFields ? firstBytes(turnFields, 1) : undefined;
  if (!agentTurn) {
    context.skippedTurns += 1;
    recordDiagnostic(context, {
      code: turnFields ? "unsupported_turn" : "invalid_turn",
      turn,
    });
    return;
  }

  const agentFields = safeFields(agentTurn);
  if (!agentFields) {
    context.skippedTurns += 1;
    recordDiagnostic(context, { code: "invalid_turn", turn });
    return;
  }

  const before = context.messages.length;
  const turnSequence = turn + 1;
  const sourceRequestId = cleanText(firstString(agentFields, 3), context.maxTextChars) || undefined;
  const rawUser = firstBytes(agentFields, 1);
  if (rawUser) {
    const userFields = safeFields(rawUser);
    const text = cleanText(
      userFields ? firstString(userFields, 1) : undefined,
      context.maxTextChars,
    );
    if (text) {
      context.messages.push({
        role: "user",
        content: text,
        cursorMessageId: cleanText(
          userFields ? firstString(userFields, 2) : undefined,
          context.maxTextChars,
        ) || undefined,
        turnSequence,
      });
    }
  }

  const steps = agentFields.filter(
    (field) => field.field === 2 && field.wire === 2 && field.bytes,
  );
  for (let index = 0; index < steps.length; index += 1) {
    projectStep(steps[index].bytes!, turn, index, turnSequence, context);
  }

  if (sourceRequestId) {
    for (let index = before; index < context.messages.length; index += 1) {
      context.messages[index].sourceRequestId = sourceRequestId;
    }
  }

  if (context.messages.length === before) {
    context.skippedTurns += 1;
    recordDiagnostic(context, { code: "empty_turn", turn });
    return;
  }
  context.decodedTurns += 1;
}

function createContext(options?: ConversationStateProjectionOptions): ProjectionContext {
  return {
    includeThinking: Boolean(options?.includeThinking),
    maxTextChars: maxTextChars(options?.maxTextChars),
    messages: [],
    diagnostics: [],
    decodedTurns: 0,
    skippedTurns: 0,
    skippedSteps: 0,
  };
}

function toProjection(
  context: ProjectionContext,
  turnCount: number,
  compaction?: { summaries: string[]; selfSummaryCount: number },
): ConversationStateProjection {
  return {
    messages: context.messages,
    compactionSummaries: [...(compaction?.summaries || [])],
    selfSummaryCount: Math.max(
      compaction?.summaries.length || 0,
      compaction?.selfSummaryCount || 0,
    ),
    turnCount,
    decodedTurns: context.decodedTurns,
    skippedTurns: context.skippedTurns,
    skippedSteps: context.skippedSteps,
    diagnostics: context.diagnostics,
  };
}

function summaryTextFromBytes(
  raw: Buffer | undefined,
  fields: readonly number[],
  limit: number,
): string {
  const decoded = safeFields(raw);
  if (!decoded) return "";
  for (const field of fields) {
    const summary = cleanText(firstString(decoded, field), limit);
    if (summary) return summary;
  }
  return "";
}

/** Decode Cursor's summary lineage while accepting the legacy archive shape. */
function projectCompactionSummaries(
  stateFields: PbField[],
  limit: number,
): { summaries: string[]; selfSummaryCount: number } {
  const summaries = stateFields
    .filter((field) => field.field === 13 && field.wire === 2 && field.bytes)
    .map((field) => summaryTextFromBytes(field.bytes, [2, 1], limit))
    .filter(Boolean);
  const latest = summaryTextFromBytes(firstBytes(stateFields, 6), [1], limit);
  const previous = summaryTextFromBytes(firstBytes(stateFields, 11), [2, 1], limit);
  const rawCount = firstVarint(stateFields, 17) || 0;

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

function projectRootReplay(
  stateFields: PbField[],
  context: ProjectionContext,
): { present: boolean; turnCount: number } {
  const items = stateFields.filter(
    (field) => field.field === 1 && field.wire === 2 && field.bytes,
  );
  if (!items.length) return { present: false, turnCount: 0 };

  const projected: ProjectedChatMessage[] = [];
  let turnSequence = 0;
  for (const item of items) {
    try {
      const decoded = JSON.parse(item.bytes!.toString("utf8")) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("root replay item is not an object");
      }
      const payload = decoded as Record<string, unknown>;
      const role = typeof payload.role === "string" ? payload.role.trim() : "";
      const content = cleanText(
        typeof payload.content === "string" ? payload.content : undefined,
        context.maxTextChars,
      );
      const contentParts = replayContentParts(
        payload.content_parts,
        context.maxTextChars,
      );
      const promptContextSource = rootReplayString(
        payload,
        "prompt_context_source",
        "promptContextSource",
      );
      const promptContextHash = rootReplayString(
        payload,
        "prompt_context_hash",
        "promptContextHash",
      );
      const isPromptContext = Boolean(
        (role === "user" || role === "system") &&
        promptContextSource &&
        promptContextHash,
      );

      if (
        !isPromptContext &&
        isInternalPromptContextReplay(payload, role, content, contentParts)
      ) {
        continue;
      }

      if (role === "user") {
        if (!content && !contentParts?.length) throw new Error("empty user replay");
        if (!isPromptContext) turnSequence += 1;
        projected.push({
          role,
          content,
          ...(contentParts ? { contentParts } : {}),
          ...(isPromptContext
            ? { promptContextSource, promptContextHash }
            : {}),
          turnSequence,
        });
        continue;
      }
      if (role === "system") {
        if (!content) throw new Error("empty system replay");
        projected.push({
          role,
          content,
          ...(isPromptContext
            ? { promptContextSource, promptContextHash }
            : {}),
          turnSequence,
        });
        continue;
      }
      if (role === "assistant") {
        const toolCalls = replayToolCalls(
          payload.tool_calls,
          context.maxTextChars,
        );
        const reasoningContent = cleanText(
          typeof payload.reasoning_content === "string"
            ? payload.reasoning_content
            : undefined,
          context.maxTextChars,
        );
        const reasoningSignature = cleanText(
          typeof payload.reasoning_signature === "string"
            ? payload.reasoning_signature
            : undefined,
          context.maxTextChars,
        );
        const reasoningSignatureSource = cleanText(
          typeof payload.reasoning_signature_source === "string"
            ? payload.reasoning_signature_source
            : undefined,
          context.maxTextChars,
        );
        const openAIResponsesReasoningId = cleanText(
          typeof payload.openai_responses_reasoning_id === "string"
            ? payload.openai_responses_reasoning_id
            : undefined,
          context.maxTextChars,
        );
        const openAIResponsesReasoningStatus = cleanText(
          typeof payload.openai_responses_reasoning_status === "string"
            ? payload.openai_responses_reasoning_status
            : undefined,
          context.maxTextChars,
        );
        const openAIResponsesReasoningSummary = replayJsonValue(
          payload.openai_responses_reasoning_summary,
          context.maxTextChars,
        );
        if (!content && !toolCalls?.length && !reasoningContent && !reasoningSignature) {
          throw new Error("empty assistant replay");
        }
        projected.push({
          role,
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
          ...(reasoningContent ? { reasoningContent } : {}),
          ...(reasoningSignature ? { reasoningSignature } : {}),
          ...(reasoningSignatureSource ? { reasoningSignatureSource } : {}),
          ...(openAIResponsesReasoningId
            ? { openAIResponsesReasoningId }
            : {}),
          ...(openAIResponsesReasoningStatus
            ? { openAIResponsesReasoningStatus }
            : {}),
          ...(openAIResponsesReasoningSummary != null
            ? { openAIResponsesReasoningSummary }
            : {}),
          turnSequence,
        });
        continue;
      }
      if (role === "tool") {
        const toolCallId = cleanText(
          typeof payload.tool_call_id === "string"
            ? payload.tool_call_id
            : undefined,
          context.maxTextChars,
        );
        if (!toolCallId) throw new Error("tool replay is missing its call id");
        const name = cleanText(
          typeof payload.name === "string" ? payload.name : undefined,
          context.maxTextChars,
        );
        projected.push({
          role,
          content,
          tool_call_id: toolCallId,
          ...(name ? { name } : {}),
          turnSequence,
        });
        continue;
      }
      throw new Error("unsupported root replay role");
    } catch {
      context.messages = [];
      context.decodedTurns = 0;
      context.skippedTurns = Math.max(1, items.length);
      recordDiagnostic(context, { code: "invalid_root_replay" });
      return { present: true, turnCount: items.length };
    }
  }

  context.messages = projected;
  context.decodedTurns = turnSequence;
  return { present: true, turnCount: turnSequence };
}

const TODO_SECTION_REMINDER = [
  "<system_reminder>",
  "You are currently under the todo section, be sure to track tasks and do not forget to update.",
  "</system_reminder>",
].join("\n");

function rootReplayString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof payload[key] === "string") return String(payload[key]).trim();
  }
  return "";
}

/** Filter prompt context before root replay enters history. */
function isInternalPromptContextReplay(
  payload: Record<string, unknown>,
  role: string,
  content: string,
  contentParts: ChatContentPart[] | undefined,
): boolean {
  if (role !== "user" || !content || contentParts?.length) return false;
  if (
    rootReplayString(payload, "name") ||
    rootReplayString(payload, "tool_call_id", "toolCallId") ||
    rootReplayString(payload, "reasoning_content", "reasoningContent") ||
    rootReplayString(payload, "reasoning_signature", "reasoningSignature")
  ) {
    return false;
  }
  const toolCalls = payload.tool_calls ?? payload.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length) return false;

  const trimmed = content.trim();
  if (trimmed === TODO_SECTION_REMINDER) return true;
  return trimmed.startsWith("<system_reminder>") &&
    trimmed.endsWith("</system_reminder>") &&
    trimmed.includes("You recently successfully edited ") &&
    trimmed.includes("latest source of truth is the most recent successful");
}

/** Root replay owns the canonical content; raw turns supply Cursor lineage. */
function enrichRootReplayLineage(
  rootMessages: ProjectedChatMessage[],
  turnMessages: readonly ProjectedChatMessage[],
): void {
  const turnUsers = turnMessages
    .map((message, index) => ({ message, index }))
    .filter(
      (item) =>
        item.message.role === "user" &&
        !item.message.promptContextSource,
    );
  let rootSearchFrom = 0;

  for (let turnIndex = 0; turnIndex < turnUsers.length; turnIndex += 1) {
    const lineage = turnUsers[turnIndex];
    const userText = lineage.message.content;
    const rootUserIndex = rootMessages.findIndex(
      (message, index) =>
        index >= rootSearchFrom &&
        message.role === "user" &&
        !message.promptContextSource &&
        message.content === userText,
    );
    if (rootUserIndex < 0) continue;

    const nextRootUserIndex = rootMessages.findIndex(
      (message, index) =>
        index > rootUserIndex &&
        message.role === "user" &&
        !message.promptContextSource,
    );
    const rootTurnEnd = nextRootUserIndex < 0 ? rootMessages.length : nextRootUserIndex;
    const turnEnd = turnUsers[turnIndex + 1]?.index ?? turnMessages.length;
    const sourceRequestId = turnMessages
      .slice(lineage.index, turnEnd)
      .map((message) => message.sourceRequestId)
      .find(Boolean);

    for (let index = rootUserIndex; index < rootTurnEnd; index += 1) {
      rootMessages[index].turnSequence = lineage.message.turnSequence;
      if (sourceRequestId) rootMessages[index].sourceRequestId = sourceRequestId;
    }
    rootMessages[rootUserIndex].cursorMessageId = lineage.message.cursorMessageId;
    rootSearchFrom = rootUserIndex + 1;
  }
}

/**
 * Cursor retains older compacted turns in ConversationStateStructure.summary
 * (field 6). It is provider context, not a visible assistant reply, so model
 * it as a leading system message before replaying the unsummarized tail.
 */
function projectStateSummary(
  stateFields: PbField[],
  context: ProjectionContext,
): void {
  const rawSummary = firstBytes(stateFields, 6);
  if (!rawSummary) return;
  const summaryFields = safeFields(rawSummary);
  const summary = cleanText(
    summaryFields ? firstString(summaryFields, 1) : undefined,
    context.maxTextChars,
  );
  if (!summary) return;
  context.messages.push({
    role: "system",
    content: [
      "Earlier conversation context was summarized by Cursor.",
      "Treat the following as retained facts and continue consistently:",
      summary,
    ].join("\n\n"),
    turnSequence: 0,
  });
}

/** Project raw ConversationStateStructure bytes into provider-neutral messages. */
export function projectConversationState(
  rawState: Buffer | Uint8Array | undefined,
  options?: ConversationStateProjectionOptions,
): ConversationStateProjection {
  const stateFields = safeFields(rawState);
  if (!stateFields) {
    const context = createContext(options);
    recordDiagnostic(context, { code: "invalid_state" });
    return toProjection(context, 0);
  }

  const compaction = projectCompactionSummaries(
    stateFields,
    maxTextChars(options?.maxTextChars),
  );

  const turns = stateFields
    .filter((field) => field.field === 8 && field.wire === 2 && field.bytes)
    .map((field) => field.bytes!);
  const allowRootReplay = options?.allowRootReplay !== false;

  // Checkpoint inspection keeps the lossless root replay default because it
  // carries content parts that legacy turn bytes cannot represent. Runtime
  // synchronization opts into turns-first behavior below.
  if (!options?.preferTurns && allowRootReplay) {
    const rootContext = createContext(options);
    const rootReplay = projectRootReplay(stateFields, rootContext);
    if (rootReplay.present && (rootContext.messages.length || rootContext.skippedTurns > 0)) {
      if (rootContext.messages.length && turns.length) {
        const lineage = createContext(options);
        for (let index = 0; index < turns.length; index += 1) {
          projectTurn(turns[index], index, lineage);
        }
        enrichRootReplayLineage(rootContext.messages, lineage.messages);
      }
      return toProjection(rootContext, rootReplay.turnCount, compaction);
    }
  }

  const turnContext = createContext(options);
  projectStateSummary(stateFields, turnContext);
  for (let index = 0; index < turns.length; index += 1) {
    projectTurn(turns[index], index, turnContext);
  }

  // Cursor's committed turns are the visible conversation source of truth.
  // Root prompt replay can contain managed reminders and stale branch input,
  // so it is only an initial-recovery fallback when no turn was recoverable.
  if (turnContext.decodedTurns > 0 || !allowRootReplay) {
    return toProjection(turnContext, turns.length, compaction);
  }

  const rootContext = createContext(options);
  const rootReplay = projectRootReplay(stateFields, rootContext);
  if (rootReplay.present) {
    return toProjection(rootContext, rootReplay.turnCount, compaction);
  }
  return toProjection(turnContext, turns.length, compaction);
}

/** Project already-extracted ConversationStateStructure.turns values. */
export function projectConversationTurns(
  turns: readonly (Buffer | Uint8Array)[] | undefined,
  options?: ConversationStateProjectionOptions,
): ConversationStateProjection {
  const context = createContext(options);
  const source = turns || [];
  for (let index = 0; index < source.length; index += 1) {
    projectTurn(Buffer.from(source[index]), index, context);
  }
  return toProjection(context, source.length);
}

/** Convenience form for callers that only need the reconstructed transcript. */
export function projectConversationStateToChatMessages(
  rawState: Buffer | Uint8Array | undefined,
  options?: ConversationStateProjectionOptions,
): ProjectedChatMessage[] {
  return projectConversationState(rawState, options).messages;
}
