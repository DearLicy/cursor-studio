/**
 * 本地协议实现。
 * 官方客户端用 protobuf；JSON 形态字段名保持 camelCase（protojson 风格）。
 */
import { buildExecServerMessageJson } from "./agent-proto";

export type AgentServerMessage = Record<string, unknown>;

export function buildHeartbeatMessage(): AgentServerMessage {
  return {
    interactionUpdate: {
      heartbeat: {},
    },
  };
}

export function buildTextDeltaMessage(text: string): AgentServerMessage {
  return {
    interactionUpdate: {
      textDelta: { text },
    },
  };
}

export function buildThinkingDeltaMessage(text: string): AgentServerMessage {
  return {
    interactionUpdate: {
      thinkingDelta: {
        text,
        thinkingStyle: "THINKING_STYLE_DEFAULT",
      },
    },
  };
}

export function buildThinkingCompletedMessage(durationMs: number): AgentServerMessage {
  return {
    interactionUpdate: {
      thinkingCompleted: {
        thinkingDurationMs: Math.max(0, Math.round(durationMs)),
      },
    },
  };
}

function normalizeCheckpointTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffffffff, Math.floor(value));
}

/** Cursor persists this checkpoint and uses tokenDetails.maxTokens for context management. */
export function buildConversationCheckpointMessage(opts: {
  usedTokens: number;
  maxTokens: number;
}): AgentServerMessage {
  return {
    conversationCheckpointUpdate: {
      tokenDetails: {
        usedTokens: normalizeCheckpointTokenCount(opts.usedTokens),
        maxTokens: normalizeCheckpointTokenCount(opts.maxTokens),
      },
    },
  };
}

export function buildTurnEndedMessage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): AgentServerMessage {
  return {
    interactionUpdate: {
      turnEnded: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
    },
  };
}

/** 错误收口：客户端部分路径读 message / error */
export function buildErrorMessage(message: string): AgentServerMessage {
  return {
    error: {
      message,
      details: message,
    },
    interactionUpdate: {
      turnEnded: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
}

export function buildStatusMessage(status: string): AgentServerMessage {
  return {
    interactionUpdate: {
      status: { status },
    },
  };
}

/** 工具调用开始（简化 JSON 形态，便于 Cursor/调试客户端消费） */
export function buildToolCallStartedMessage(opts: {
  callId: string;
  name: string;
  args?: Record<string, unknown>;
  modelCallId?: string;
}): AgentServerMessage {
  return {
    interactionUpdate: {
      toolCallStarted: {
        callId: opts.callId,
        modelCallId: opts.modelCallId || opts.callId,
        toolCall: {
          name: opts.name,
          args: opts.args || {},
        },
      },
    },
  };
}

export function buildToolCallCompletedMessage(opts: {
  callId: string;
  name: string;
  result: string;
  ok: boolean;
  modelCallId?: string;
}): AgentServerMessage {
  return {
    interactionUpdate: {
      toolCallCompleted: {
        callId: opts.callId,
        modelCallId: opts.modelCallId || opts.callId,
        toolCall: {
          name: opts.name,
          result: opts.result,
          ok: opts.ok,
        },
      },
    },
  };
}

/** 请求 Cursor 客户端执行工具（对齐 agent.v1.ExecServerMessage protojson） */
export function buildExecRequestMessage(opts: {
  execId: string;
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  messageId?: number;
}): AgentServerMessage {
  return buildExecServerMessageJson({
    messageId: opts.messageId || 1,
    execId: opts.execId,
    toolName: opts.name,
    toolCallId: opts.toolCallId,
    args: opts.args || {},
  }) as AgentServerMessage;
}
