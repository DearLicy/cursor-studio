import type { ChatMessage, ToolCall } from "../agent/provider-chat";

const PROVIDER_SUPPRESSED_TOOLS = new Set(["GenerateImage"]);
const CHECKPOINT_PERSISTENT_TOOLS = new Set([
  "PatchEdit",
  "PatchEditLines",
  "PatchEditSpan",
  "Edit",
  "Write",
  "GenerateImage",
]);

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cloneToolCall(call: ToolCall): ToolCall {
  return {
    ...call,
    function: { ...call.function },
  };
}

function cloneMessage<T extends ChatMessage>(message: T): T {
  if (message.role === "assistant") {
    return {
      ...message,
      ...(message.tool_calls
        ? { tool_calls: message.tool_calls.map(cloneToolCall) }
        : {}),
      ...(message.openAIResponsesReasoningSummary != null
        ? {
          openAIResponsesReasoningSummary: structuredClone(
            message.openAIResponsesReasoningSummary,
          ),
        }
        : {}),
    } as T;
  }
  if ("contentParts" in message && message.contentParts) {
    return {
      ...message,
      contentParts: structuredClone(message.contentParts),
    } as T;
  }
  return { ...message };
}

function hasReasoning(message: Extract<ChatMessage, { role: "assistant" }>): boolean {
  return Boolean(
    clean(message.reasoningContent) ||
      clean(message.reasoningSignature) ||
      clean(message.reasoningSignatureSource),
  );
}

function mergeReasoning(
  target: Extract<ChatMessage, { role: "assistant" }>,
  incoming: Extract<ChatMessage, { role: "assistant" }>,
): void {
  const leftReasoning = clean(target.reasoningContent);
  const rightReasoning = clean(incoming.reasoningContent);
  if (!leftReasoning) target.reasoningContent = rightReasoning || undefined;
  else if (rightReasoning && rightReasoning !== leftReasoning) {
    target.reasoningContent = `${leftReasoning}\n\n${rightReasoning}`;
  }

  const leftSignature = clean(target.reasoningSignature);
  const rightSignature = clean(incoming.reasoningSignature);
  if (!leftSignature && rightSignature) {
    target.reasoningSignature = rightSignature;
    target.reasoningSignatureSource = incoming.reasoningSignatureSource;
    target.openAIResponsesReasoningId = incoming.openAIResponsesReasoningId;
    target.openAIResponsesReasoningStatus = incoming.openAIResponsesReasoningStatus;
    target.openAIResponsesReasoningSummary =
      incoming.openAIResponsesReasoningSummary == null
        ? undefined
        : structuredClone(incoming.openAIResponsesReasoningSummary);
    return;
  }
  if (leftSignature && rightSignature && leftSignature !== rightSignature) {
    target.reasoningSignature = undefined;
    target.reasoningSignatureSource = undefined;
    target.openAIResponsesReasoningId = undefined;
    target.openAIResponsesReasoningStatus = undefined;
    target.openAIResponsesReasoningSummary = undefined;
    return;
  }
  if (!leftSignature || leftSignature !== rightSignature) return;
  target.reasoningSignatureSource =
    clean(target.reasoningSignatureSource) === clean(incoming.reasoningSignatureSource)
      ? target.reasoningSignatureSource
      : target.reasoningSignatureSource || incoming.reasoningSignatureSource;
  target.openAIResponsesReasoningId ||= incoming.openAIResponsesReasoningId;
  target.openAIResponsesReasoningStatus ||= incoming.openAIResponsesReasoningStatus;
  target.openAIResponsesReasoningSummary ??=
    incoming.openAIResponsesReasoningSummary == null
      ? undefined
      : structuredClone(incoming.openAIResponsesReasoningSummary);
}

function canMergeAssistantToolCalls(
  previous: ChatMessage | undefined,
  current: Extract<ChatMessage, { role: "assistant" }>,
): previous is Extract<ChatMessage, { role: "assistant" }> {
  return Boolean(
    previous?.role === "assistant" &&
      previous.tool_calls?.length &&
      current.tool_calls?.length &&
      !clean(current.content),
  );
}

function mergeAdjacentAssistantToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const source of messages) {
    const message = cloneMessage(source);
    const previous = merged.at(-1);
    if (
      message.role === "assistant" &&
      canMergeAssistantToolCalls(previous, message)
    ) {
      const assistant = previous as Extract<ChatMessage, { role: "assistant" }>;
      assistant.tool_calls = [
        ...(assistant.tool_calls || []),
        ...message.tool_calls!.map(cloneToolCall),
      ];
      mergeReasoning(assistant, message);
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function toolCallGroupId(toolCallId: string): string {
  const id = clean(toolCallId);
  if (!id) return "";
  const separator = id.indexOf("::");
  if (separator > 0) return id.slice(0, separator).trim();
  if (id.startsWith("tc_")) {
    const parts = id.split("_", 3);
    if (parts[1]) return `tc_${parts[1]}`;
  }
  return "";
}

function assistantToolGroupId(message: ChatMessage): string {
  if (message.role !== "assistant" || !message.tool_calls?.length) return "";
  let group = "";
  for (const call of message.tool_calls) {
    const next = toolCallGroupId(call.id);
    if (!next || (group && group !== next)) return "";
    group = next;
  }
  return group;
}

function coalesceInterleavedToolBatches(messages: readonly ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const first = cloneMessage(messages[index]);
    const group = assistantToolGroupId(first);
    if (!group || first.role !== "assistant") {
      normalized.push(first);
      continue;
    }

    const batch = first;
    const results = new Map<string, Extract<ChatMessage, { role: "tool" }>>();
    const resultOrder: string[] = [];
    let cursor = index + 1;
    let changed = false;
    while (cursor < messages.length) {
      const next = cloneMessage(messages[cursor]);
      if (next.role === "tool" && toolCallGroupId(next.tool_call_id) === group) {
        if (!results.has(next.tool_call_id)) resultOrder.push(next.tool_call_id);
        results.set(next.tool_call_id, next);
        changed = true;
        cursor += 1;
        continue;
      }
      if (
        next.role === "assistant" &&
        assistantToolGroupId(next) === group &&
        canMergeAssistantToolCalls(batch, next)
      ) {
        batch.tool_calls = [
          ...(batch.tool_calls || []),
          ...next.tool_calls!.map(cloneToolCall),
        ];
        mergeReasoning(batch, next);
        changed = true;
        cursor += 1;
        continue;
      }
      break;
    }
    if (!changed) {
      normalized.push(first);
      continue;
    }

    normalized.push(batch);
    const emitted = new Set<string>();
    for (const call of batch.tool_calls || []) {
      const result = results.get(call.id);
      if (!result) continue;
      normalized.push(result);
      emitted.add(call.id);
    }
    for (const id of resultOrder) {
      if (!emitted.has(id)) normalized.push(results.get(id)!);
    }
    index = cursor - 1;
  }
  return normalized;
}

function filterTools(
  messages: readonly ChatMessage[],
  include: (name: string) => boolean,
): ChatMessage[] {
  const filtered: ChatMessage[] = [];
  const skippedIds = new Set<string>();
  for (const source of messages) {
    const message = cloneMessage(source);
    if (message.role === "assistant" && message.tool_calls?.length) {
      message.tool_calls = message.tool_calls.filter((call) => {
        const keep = include(clean(call.function.name));
        if (!keep && clean(call.id)) skippedIds.add(clean(call.id));
        return keep;
      });
      if (
        !message.tool_calls.length &&
        !clean(message.content) &&
        !hasReasoning(message)
      ) {
        continue;
      }
    }
    if (
      message.role === "tool" &&
      (skippedIds.has(clean(message.tool_call_id)) || !include(clean(message.name)))
    ) {
      continue;
    }
    filtered.push(message);
  }
  return filtered;
}

function trimDanglingAssistantToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  const trimmed: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = cloneMessage(messages[index]);
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      trimmed.push(message);
      continue;
    }

    let end = index + 1;
    const results = new Map<string, Extract<ChatMessage, { role: "tool" }>>();
    while (end < messages.length && messages[end].role === "tool") {
      const result = cloneMessage(
        messages[end] as Extract<ChatMessage, { role: "tool" }>,
      );
      results.set(clean(result.tool_call_id), result);
      end += 1;
    }
    message.tool_calls = message.tool_calls.filter((call) => results.has(clean(call.id)));
    if (message.tool_calls.length) {
      trimmed.push(message);
      for (const call of message.tool_calls) {
        const result = results.get(clean(call.id));
        if (result) trimmed.push(result);
      }
    } else if (clean(message.content) || hasReasoning(message)) {
      delete message.tool_calls;
      trimmed.push(message);
    }
    index = end - 1;
  }
  return trimmed;
}

function isLegacyPlainWrite(call: ToolCall): boolean {
  if (clean(call.function.name) !== "Write") return false;
  const args = clean(call.function.arguments);
  return !args || args === "{}" || args === "null";
}

function filterLegacyPlainWrite(messages: readonly ChatMessage[]): ChatMessage[] {
  const removed = new Set<string>();
  return messages.reduce<ChatMessage[]>((result, source) => {
      const message = cloneMessage(source);
      if (message.role === "assistant" && message.tool_calls?.length) {
        message.tool_calls = message.tool_calls.filter((call) => {
          if (!isLegacyPlainWrite(call)) return true;
          removed.add(clean(call.id));
          return false;
        });
        if (!message.tool_calls.length && !clean(message.content) && !hasReasoning(message)) {
          return result;
        }
      }
      if (message.role === "tool" && removed.has(clean(message.tool_call_id))) {
        return result;
      }
      result.push(message);
      return result;
    }, []);
}

/** Normalize provider replay batches and drop incomplete calls. */
export function normalizeProviderReplay(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  let replay = mergeAdjacentAssistantToolCalls(messages);
  replay = filterTools(replay, (name) => !PROVIDER_SUPPRESSED_TOOLS.has(name));
  replay = coalesceInterleavedToolBatches(replay);
  replay = trimDanglingAssistantToolCalls(replay);
  return replay;
}

/** Cursor checkpoints retain only tools whose results have durable UI state. */
export function normalizeCheckpointReplay(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  let replay = normalizeProviderReplay(messages);
  replay = filterTools(replay, (name) => CHECKPOINT_PERSISTENT_TOOLS.has(name));
  replay = filterLegacyPlainWrite(replay);
  return replay;
}

export function shouldPersistCheckpointTool(name: string): boolean {
  return CHECKPOINT_PERSISTENT_TOOLS.has(clean(name));
}
