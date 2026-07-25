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
  kind: "exec";
};

export type PendingInteraction = {
  interactionId: string;
  messageId: number;
  toolCallId: string;
  name: string;
  argsJson: string;
  createdAt: number;
  kind: "interaction";
  /** ask_question | create_plan | switch_mode | web_search */
  interactionKind: string;
};

export type ClientExecResult = {
  execId?: string;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
  messageId?: number;
};

export type ClientInteractionResult = {
  interactionId?: string;
  messageId?: number;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
};

type ExecWaiter = {
  pending: PendingExec;
  resolve: (r: ClientExecResult) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type InteractionWaiter = {
  pending: PendingInteraction;
  resolve: (r: ClientInteractionResult) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const execWaiters = new Map<string, Map<string, ExecWaiter>>();
const interactionWaiters = new Map<string, Map<string, InteractionWaiter>>();
let execSeq = 0;
let messageSeq = 0;

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

export function registerPending(
  requestId: string,
  pending: PendingExec,
  timeoutMs = 120_000,
): Promise<ClientExecResult> {
  const m = execMap(requestId);
  return new Promise<ClientExecResult>((resolve) => {
    const waiter: ExecWaiter = {
      pending,
      resolve: (r) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        m.delete(pending.execId);
        if (m.size === 0) execWaiters.delete(requestId);
        resolve(r);
      },
    };
    waiter.timer = setTimeout(() => {
      waiter.resolve({
        execId: pending.execId,
        toolCallId: pending.toolCallId,
        name: pending.name,
        messageId: pending.messageId,
        ok: false,
        result: `Error: client bridge timeout after ${timeoutMs}ms for ${pending.name} (${pending.execId})`,
      });
    }, timeoutMs);
    m.set(pending.execId, waiter);
  });
}

export function registerPendingInteraction(
  requestId: string,
  pending: PendingInteraction,
  timeoutMs = 300_000,
): Promise<ClientInteractionResult> {
  const m = interactionMap(requestId);
  return new Promise<ClientInteractionResult>((resolve) => {
    const waiter: InteractionWaiter = {
      pending,
      resolve: (r) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        m.delete(pending.interactionId);
        if (m.size === 0) interactionWaiters.delete(requestId);
        resolve(r);
      },
    };
    waiter.timer = setTimeout(() => {
      waiter.resolve({
        interactionId: pending.interactionId,
        toolCallId: pending.toolCallId,
        name: pending.name,
        messageId: pending.messageId,
        ok: false,
        result: `Error: interaction bridge timeout after ${timeoutMs}ms for ${pending.name} (${pending.interactionId})`,
      });
    }, timeoutMs);
    m.set(pending.interactionId, waiter);
  });
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

  if (result.toolCallId) {
    for (const w of m.values()) {
      if (w.pending.toolCallId === result.toolCallId) {
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

  // 仅一条 pending 时宽松匹配
  if (m.size === 1) {
    const only = m.values().next().value as ExecWaiter;
    only.resolve({
      ...result,
      execId: only.pending.execId,
      toolCallId: only.pending.toolCallId,
      name: result.name || only.pending.name,
      messageId: only.pending.messageId,
    });
    return true;
  }
  return false;
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

  if (result.toolCallId) {
    for (const w of m.values()) {
      if (w.pending.toolCallId === result.toolCallId) {
        w.resolve({
          ...result,
          interactionId: w.pending.interactionId,
          toolCallId: w.pending.toolCallId,
          name: result.name || w.pending.name,
          messageId: w.pending.messageId,
        });
        return true;
      }
    }
  }

  if (m.size === 1) {
    const only = m.values().next().value as InteractionWaiter;
    only.resolve({
      ...result,
      interactionId: only.pending.interactionId,
      toolCallId: only.pending.toolCallId,
      name: result.name || only.pending.name,
      messageId: only.pending.messageId,
    });
    return true;
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
  if (isInteractionTool(toolName)) return 300_000; // 用户答题可能较久
  if (toolName === "Task") return 600_000;
  return 120_000;
}