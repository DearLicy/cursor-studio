/**
 * RunSSE 下行双通道：
 * - json_sse：text/event-stream + `data: {json}\n\n`（冒烟/调试默认）
 * 本地协议实现。
 *
 * 本地协议实现。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamEvent } from "../agent/broker";
import {
  buildAgentServerExecAbortJson,
  encodeAgentServerExecAbort,
  encodeAgentServerExec,
  encodeAgentServerInteractionQuery,
  encodeConversationCheckpoint,
  encodeHeartbeatUpdate,
  encodeSummary,
  encodeSummaryCompleted,
  encodeSummaryStarted,
  encodeTextDelta,
  encodeThinkingCompleted,
  encodeThinkingDelta,
  encodeTokenDelta,
  encodeToolCallCompleted,
  encodeToolCallStarted,
  encodeTurnEnded,
  buildInteractionQueryJson,
} from "./agent-proto";
import {
  CONNECT_FLAG_END_STREAM,
  encodeConnectFrame,
} from "./connect-frame";
import {
  buildCursorConnectErrorTrailer,
  type ConnectTerminalErrorInput,
} from "./connect-error";
import {
  buildConversationCheckpointMessage,
  buildErrorMessage,
  buildExecRequestMessage,
  buildHeartbeatMessage,
  buildSummaryCompletedMessage,
  buildSummaryMessage,
  buildSummaryStartedMessage,
  buildStatusMessage,
  buildTextDeltaMessage,
  buildThinkingCompletedMessage,
  buildThinkingDeltaMessage,
  buildToolCallCompletedMessage,
  buildToolCallStartedMessage,
  buildTurnEndedMessage,
  type AgentServerMessage,
} from "./events";

export type StreamWireMode = "json_sse" | "connect_proto";

export type StreamWritePlan = {
  mode: StreamWireMode;
  /** 响应 Content-Type */
  contentType: string;
};

/**
 * 本地协议实现。
 * 本地协议实现。
 * - Cursor 真机：connect_proto（默认）
 * - 冒烟/调试：?wire=json 或 X-Studio-Stream-Format: json → json_sse
 */
export function detectStreamWireMode(req: IncomingMessage): StreamWritePlan {
  const url = String(req.url || "");
  const xFormat = String(
    req.headers["x-studio-stream-format"] || "",
  ).toLowerCase();

  const forceJson =
    xFormat === "json" ||
    xFormat === "json_sse" ||
    /[?&](wire|format)=json\b/i.test(url);

  if (forceJson) {
    return { mode: "json_sse", contentType: "text/event-stream" };
  }
  return { mode: "connect_proto", contentType: "text/event-stream" };
}

/** StreamEvent → JSON AgentServerMessage（null = 不写/仅结束） */
export function streamEventToMessage(ev: StreamEvent): AgentServerMessage | null {
  switch (ev.type) {
    case "text":
      return buildTextDeltaMessage(ev.text);
    case "thinking":
      return buildThinkingDeltaMessage(ev.text);
    case "thinking_done":
      return buildThinkingCompletedMessage(ev.durationMs);
    case "summary_started":
      return buildSummaryStartedMessage();
    case "summary":
      return buildSummaryMessage(ev.text);
    case "summary_completed":
      return buildSummaryCompletedMessage(ev.hookMessage);
    case "usage":
      return {
        usage: {
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          cacheReadTokens: ev.cacheRead,
          cacheWriteTokens: ev.cacheWrite,
        },
      };
    case "checkpoint":
      return buildConversationCheckpointMessage({
        usedTokens: ev.usedTokens,
        maxTokens: ev.maxTokens,
        conversationState: ev.conversationState,
      });
    case "tool_started":
      return buildToolCallStartedMessage({
        callId: ev.callId,
        name: ev.name,
        args: ev.args,
        modelCallId: ev.modelCallId,
      });
    case "tool_completed":
      return buildToolCallCompletedMessage({
        callId: ev.callId,
        name: ev.name,
        result: ev.result,
        ok: ev.ok,
        args: ev.args,
        modelCallId: ev.modelCallId,
      });
    case "exec_request":
      return buildExecRequestMessage({
        execId: ev.execId,
        toolCallId: ev.callId,
        name: ev.name,
        args: ev.args,
        messageId: ev.messageId,
      });
    case "exec_abort":
      return buildAgentServerExecAbortJson({
        messageId: ev.messageId,
      }) as AgentServerMessage;
    case "interaction_query":
      return buildInteractionQueryJson({
        messageId: ev.messageId,
        toolCallId: ev.callId,
        toolName: ev.name,
        args: ev.args || {},
      }) as AgentServerMessage;
    case "error":
      return buildErrorMessage(ev.message);
    case "done":
      return null;
    case "heartbeat":
      return buildHeartbeatMessage();
    case "status":
      return buildStatusMessage(ev.status);
    case "turn_ended":
      return buildTurnEndedMessage({
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheReadTokens: ev.cacheReadTokens,
        cacheWriteTokens: ev.cacheWriteTokens,
      });
    default:
      return null;
  }
}

/** StreamEvent → AgentServerMessage protobuf bytes */
export function streamEventToProto(ev: StreamEvent): Buffer | null {
  switch (ev.type) {
    case "text":
      return encodeTextDelta(ev.text);
    case "thinking":
      return encodeThinkingDelta(ev.text);
    case "thinking_done":
      return encodeThinkingCompleted(ev.durationMs);
    case "summary_started":
      return encodeSummaryStarted();
    case "summary":
      return encodeSummary(ev.text);
    case "summary_completed":
      return encodeSummaryCompleted(ev.hookMessage);
    case "usage":
      // TokenDelta 仅有单字段；用 completion 近似，完整统计在 turn_ended
      return encodeTokenDelta(ev.completionTokens || ev.promptTokens || 0);
    case "checkpoint":
      return encodeConversationCheckpoint({
        usedTokens: ev.usedTokens,
        maxTokens: ev.maxTokens,
        conversationState: ev.conversationState,
      });
    case "tool_started":
      return encodeToolCallStarted({
        callId: ev.callId,
        name: ev.name,
        args: ev.args,
        modelCallId: ev.modelCallId,
      });
    case "tool_completed":
      return encodeToolCallCompleted({
        callId: ev.callId,
        name: ev.name,
        result: ev.result,
        ok: ev.ok,
        args: ev.args,
        modelCallId: ev.modelCallId,
      });
    case "exec_request":
      return encodeAgentServerExec({
        messageId: ev.messageId || 1,
        execId: ev.execId,
        toolName: ev.name,
        args: { ...(ev.args || {}), toolCallId: ev.callId },
      });
    case "exec_abort":
      return encodeAgentServerExecAbort({
        messageId: ev.messageId,
      });
    case "interaction_query":
      return encodeAgentServerInteractionQuery({
        messageId: ev.messageId,
        toolCallId: ev.callId,
        toolName: ev.name,
        args: ev.args || {},
      });
    case "error":
      // Errors are represented by the Connect end-stream trailer. Encoding a
      // text delta here made Cursor treat the provider failure as assistant
      // content, which could discard the in-progress conversation bubble.
      return null;
    case "done":
      return null;
    case "heartbeat":
      return encodeHeartbeatUpdate();
    case "status":
      // InteractionUpdate 无 status；跳过二进制（JSON 通道仍发）
      return null;
    case "turn_ended":
      return encodeTurnEnded({
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheReadTokens: ev.cacheReadTokens,
        cacheWriteTokens: ev.cacheWriteTokens,
      });
    default:
      return null;
  }
}

function legacyTypeOf(ev: StreamEvent): string | undefined {
  switch (ev.type) {
    case "text":
      return "text";
    case "error":
      return "error";
    case "heartbeat":
      return "heartbeat";
    case "usage":
      return "usage";
    case "checkpoint":
      return "checkpoint";
    case "turn_ended":
      return "turn_ended";
    case "thinking":
      return "thinking";
    case "summary_started":
      return "summary_started";
    case "summary":
      return "summary";
    case "summary_completed":
      return "summary_completed";
    case "tool_started":
      return "tool_started";
    case "tool_completed":
      return "tool_completed";
    case "exec_request":
      return "exec_request";
    case "exec_abort":
      return "exec_abort";
    case "interaction_query":
      return "interaction_query";
    default:
      return undefined;
  }
}

function messageToSseLine(msg: AgentServerMessage, legacyType?: string): string {
  const payload = legacyType != null ? { type: legacyType, ...msg } : msg;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Connect end-stream 帧（flags=0x02，JSON trailer） */
export function encodeConnectEndStream(error?: ConnectTerminalErrorInput): Buffer {
  const body =
    error
      ? JSON.stringify(buildCursorConnectErrorTrailer(error))
      : "{}";
  return encodeConnectFrame(body, CONNECT_FLAG_END_STREAM);
}

export type RunSseWriter = {
  mode: StreamWireMode;
  writeEvent: (ev: StreamEvent) => void;
  endOk: () => void;
  /** Accept a raw message for existing callers or rich status metadata for new ones. */
  endError: (error: string | ConnectTerminalErrorInput) => void;
};

export function createRunSseWriter(
  res: ServerResponse,
  plan: StreamWritePlan,
): RunSseWriter {
  const writeRaw = (chunk: Buffer | string) => {
    if (res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      /* ignore broken pipe */
    }
  };

  if (plan.mode === "json_sse") {
    return {
      mode: "json_sse",
      writeEvent: (ev) => {
        if (ev.type === "done") {
          writeRaw(messageToSseLine({ end: true }, "done"));
          return;
        }
        const msg = streamEventToMessage(ev);
        if (!msg) return;
        writeRaw(messageToSseLine(msg, legacyTypeOf(ev)));
      },
      endOk: () => {
        /* json 通道无独立 end-stream */
      },
      endError: () => {
        /* 错误已作为 event 写出 */
      },
    };
  }

  // connect_proto：二进制 Connect 帧；end-stream 只写一次
  let streamEnded = false;
  const writeEnd = (error?: ConnectTerminalErrorInput) => {
    if (streamEnded || res.writableEnded) return;
    streamEnded = true;
    writeRaw(encodeConnectEndStream(error));
  };

  return {
    mode: "connect_proto",
    writeEvent: (ev) => {
      if (ev.type === "done") {
        writeEnd();
        return;
      }
      if (ev.type === "error") {
        writeEnd({
          code: ev.code || "unavailable",
          message: ev.message,
          status: ev.status,
        });
        return;
      }
      const bin = streamEventToProto(ev);
      if (!bin) return;
      writeRaw(encodeConnectFrame(bin, 0));
    },
    endOk: () => {
      writeEnd();
    },
    endError: (error) => {
      writeEnd(
        typeof error === "string"
          ? { code: "unknown", message: error }
          : error,
      );
    },
  };
}
