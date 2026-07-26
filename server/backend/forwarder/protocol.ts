/**
 * 本地协议实现。
 *
 * BidiAppend:
 *   Connect unwrap
 *   → aiserver.v1.BidiAppendRequest { data=hex, request_id, append_seqno }
 *   → hex.Decode(data)
 *   → agent.v1.AgentClientMessage
 *   → detect kind / extract user text / exec / interaction
 *
 * RunSSE:
 *   Connect unwrap
 *   → aiserver.v1.BidiRequestId { request_id }
 *   → 仅返回 request_id（禁止从 body 刮用户文本）
 *
 * 禁止：把 protobuf 原始字节当 UTF-8 用户文本；禁止伪造 request_id。
 */
import {
  decodeAgentClientMessage,
  modeNumberToName,
  type DecodedInteractionResponse,
} from "./agent-proto";
import {
  decodeFields,
  firstBytes,
  firstString,
  firstVarint,
} from "./protobuf-wire";
import { tryParseJson, unwrapRequestBody } from "./connect-frame";
import type { ChatContentPart } from "../agent/content-parts";

export type InboundKind =
  | "user_run"
  | "prewarm"
  | "exec_result"
  | "exec_control"
  | "interaction_response"
  | "heartbeat"
  | "summarize"
  | "cancel"
  | "metadata"
  | "empty"
  | "unknown";

export type ExecResultInbound = {
  execId?: string;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
  messageId?: number;
  /** ShellStream frames are partial output. stream_close settles the result. */
  shellStream?: {
    event?:
      | "stdout"
      | "stderr"
      | "exit"
      | "start"
      | "rejected"
      | "permission_denied"
      | "backgrounded";
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    cwd?: string;
    aborted?: boolean;
    shellId?: string;
    command?: string;
    workingDirectory?: string;
    pid?: number;
    error?: string;
  };
  backgroundShell?: {
    kind: "spawn" | "force";
    status: "backgrounded" | "rejected" | "permission_denied" | "error" | "unknown";
    shellId?: string;
    command?: string;
    workingDirectory?: string;
    pid?: number;
    error?: string;
  };
};

export type ExecControlInbound = {
  kind: "stream_close" | "throw" | "heartbeat" | "unknown";
  messageId?: number;
  error?: string;
};

export type InteractionResultInbound = {
  interactionId?: string;
  messageId?: number;
  toolCallId?: string;
  name?: string;
  result: string;
  ok: boolean;
  /** Protobuf oneof decoded without lossy recursive string scanning. */
  structured?: DecodedInteractionResponse;
};

export type ExtractedInbound = {
  requestId: string;
  texts: string[];
  /** Provider-neutral prompt payload, including inline Cursor images. */
  contentParts?: ChatContentPart[];
  /** Cursor selected an image even when the Bidi request held no image bytes. */
  hasImageAttachment?: boolean;
  conversationAction?: ReturnType<typeof decodeAgentClientMessage>["conversationAction"];
  hasRequestContextPayload?: boolean;
  hasPendingToolCalls?: boolean;
  modelHint?: string;
  /** agent | ask | plan | debug | multitask */
  mode?: string;
  kind: InboundKind;
  execResult?: ExecResultInbound;
  execControl?: ExecControlInbound;
  interactionResult?: InteractionResultInbound;
  conversationId?: string;
  /** Cursor UserMessage.message_id for future rewind / lineage decisions. */
  userMessageId?: string;
  /** Count of persisted Cursor turns included with this RunRequest. */
  conversationTurnCount?: number;
  /** Raw Cursor ConversationStateStructure for transcript reconciliation. */
  conversationState?: Buffer;
  /** Bidi 原始 data 字段是否出现 */
  hasDataField: boolean;
  /** protobuf 解码命中 */
  protobufDecoded?: boolean;
  /** Bidi append_seqno（若有） */
  appendSeqno?: number;
  /** Selected top-level AgentClientMessage oneof field. */
  agentMessageField?: number;
  path?: "bidi_proto" | "bidi_json" | "runsse" | "agent_client" | "debug_json";
};

export function normalizeRequestId(id: string): string {
  return String(id || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function tryDecodeHex(s: string): Buffer | null {
  const t = s.replace(/\s+/g, "");
  if (t.length < 2 || t.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  try {
    return Buffer.from(t, "hex");
  } catch {
    return null;
  }
}

function isLikelyHexString(s: string): boolean {
  const t = s.replace(/\s+/g, "");
  return t.length >= 8 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t);
}

function isAgentClientMessageHex(s: string): boolean {
  const t = s.replace(/\s+/g, "");
  // BidiAppendRequest.data is always hex(AgentClientMessage). Empty protobuf
  // oneof payloads are only two bytes on the wire (for example, a client
  // heartbeat is `3a00`), so four hex characters are a complete valid frame.
  // Requiring a longer string makes those transport messages look like raw
  // protobuf and terminates RunSSE with an unsupported-message error.
  return t.length >= 2 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t);
}

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s.trim(),
  );
}

function isPrintableUserText(s: string): boolean {
  const t = String(s || "").trim();
  if (t.length < 1 || t.length > 20000) return false;
  if (isLikelyHexString(t)) return false;
  if (t.startsWith("aiserver") || t.startsWith("agent.v1")) return false;
  if (/^[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) return false;
  // 过滤 protobuf 误刮短噪声
  if (t.length <= 12 && !/[\u4e00-\u9fffA-Za-z]{3,}/.test(t)) return false;
  return true;
}

/** aiserver.v1.BidiRequestId { string request_id = 1 } */
export function decodeBidiRequestIdProto(buf: Buffer): string {
  if (!buf?.length) return "";
  try {
    const fields = decodeFields(buf);
    const requestId = fields
      .filter(
        (field) =>
          field.field === 1 &&
          field.wire === 2 &&
          field.bytes !== undefined,
      )
      .at(-1)?.bytes;
    return String(requestId?.toString("utf8") || "").trim();
  } catch {
    return "";
  }
}

/**
 * aiserver.v1.BidiAppendRequest
 *   string data = 1;              // hex(AgentClientMessage)
 *   BidiRequestId request_id = 2;
 *   int64 append_seqno = 3;
 */
export function decodeBidiAppendRequestProto(buf: Buffer): {
  ok: boolean;
  dataHex?: string;
  requestId?: string;
  appendSeqno?: number;
} {
  if (!buf?.length) return { ok: false };
  try {
    const fields = decodeFields(buf);
    const dataBytes = fields
      .filter(
        (field) =>
          field.field === 1 &&
          field.wire === 2 &&
          field.bytes !== undefined,
      )
      .at(-1)?.bytes;
    const requestIdParts = fields
      .filter(
        (field) =>
          field.field === 2 &&
          field.wire === 2 &&
          field.bytes !== undefined,
      )
      .map((field) => field.bytes as Buffer);
    const ridMsg = requestIdParts.length
      ? Buffer.concat(requestIdParts)
      : undefined;
    const seq = fields
      .filter(
        (field) =>
          field.field === 3 &&
          field.wire === 0 &&
          field.varint !== undefined,
      )
      .at(-1)?.varint;

    let dataHex: string | undefined;
    if (dataBytes?.length) {
      dataHex = dataBytes.toString("utf8").trim();
    }

    const requestId = ridMsg ? decodeBidiRequestIdProto(ridMsg) : "";
    // 判别：有 request_id 嵌套 / data / seq 才算 BidiAppendRequest
    // 裸 AgentClientMessage 的 field1 是 RunRequest message，不是长 hex 字符串
    if (dataHex && !isAgentClientMessageHex(dataHex) && !requestId && seq == null) {
      return { ok: false };
    }
    const ok = Boolean(dataHex || requestId || seq != null);
    if (!ok) return { ok: false };

    return {
      ok: true,
      dataHex,
      requestId: requestId || undefined,
      appendSeqno: seq != null ? Number(seq) : undefined,
    };
  } catch {
    return { ok: false };
  }
}

export function decodeAgentClientMessageFromHex(hexData: string): {
  ok: boolean;
  client?: ReturnType<typeof decodeAgentClientMessage>;
  raw?: Buffer;
  error?: string;
} {
  const trimmed = String(hexData || "").trim();
  if (!trimmed) return { ok: true };
  const payload = tryDecodeHex(trimmed);
  if (!payload) {
    return { ok: false, error: "bidi append data is not valid hex" };
  }
  const client = decodeAgentClientMessage(payload);
  return { ok: true, client, raw: payload };
}

function clientKindToInbound(
  client: ReturnType<typeof decodeAgentClientMessage>,
): Pick<
  ExtractedInbound,
  | "kind"
  | "texts"
  | "mode"
  | "modelHint"
  | "conversationId"
  | "userMessageId"
  | "conversationTurnCount"
  | "conversationState"
  | "execResult"
  | "execControl"
  | "interactionResult"
  | "contentParts"
  | "hasImageAttachment"
  | "conversationAction"
  | "hasRequestContextPayload"
  | "hasPendingToolCalls"
  | "agentMessageField"
  | "protobufDecoded"
> {
  const texts: string[] = [];
  let kind: InboundKind = "unknown";
  let mode: string | undefined;
  let modelHint: string | undefined;
  let conversationId: string | undefined;
  let userMessageId: string | undefined;
  let conversationTurnCount: number | undefined;
  let conversationState: Buffer | undefined;
  let execResult: ExecResultInbound | undefined;
  let execControl: ExecControlInbound | undefined;
  let interactionResult: InteractionResultInbound | undefined;
  const agentMessageField = client.agentMessageField;

  if (client.modelHint) modelHint = client.modelHint;
  if (client.mode != null) mode = modeNumberToName(client.mode);
  if (client.conversationId) conversationId = client.conversationId;
  if (client.userMessageId) userMessageId = client.userMessageId;
  if (client.conversationTurnCount != null) {
    conversationTurnCount = client.conversationTurnCount;
  }
  if (client.conversationState?.length) {
    conversationState = Buffer.from(client.conversationState);
  }

  switch (client.kind) {
    case "run_request":
      kind = "user_run";
      for (const t of client.texts) {
        if (isPrintableUserText(t)) texts.push(String(t).trim());
      }
      break;
    case "prewarm_request":
      // Prewarm initializes an existing conversation route. It is not a user
      // turn and must not promote nested tool/MCP metadata into prompt text.
      kind = "prewarm";
      break;
    case "conversation_action":
      switch (client.conversationAction) {
        case "cancel":
          kind = "cancel";
          break;
        case "user_message":
        case "resume":
        case "start_plan":
        case "execute_plan":
          kind = "user_run";
          for (const t of client.texts) {
            if (isPrintableUserText(t)) texts.push(String(t).trim());
          }
          break;
        default:
          // Record non-cancel maintenance actions without advancing the
          // provider state machine. In particular, summarize must not rewrite
          // local history merely because Cursor emitted this action.
          kind = "metadata";
      }
      break;
    case "summarize_action":
      // This kind is emitted only for RunRequest.action.summarize_action. A
      // standalone ConversationAction uses the metadata path above.
      kind = "summarize";
      break;
    case "exec_client_message":
      kind = "exec_result";
      execResult = {
        execId: client.execId,
        messageId: client.messageId,
        result: client.resultText || "(empty)",
        ok: !String(client.resultText || "").startsWith("Error:"),
        shellStream: client.shellStream,
        backgroundShell: client.backgroundShell,
      };
      break;
    case "exec_client_control_message":
      kind = "exec_control";
      execControl = client.execControl;
      break;
    case "interaction_response":
      kind = "interaction_response";
      interactionResult = {
        messageId: client.messageId,
        result: client.resultText || "(empty)",
        ok: client.interactionResponse?.ok ?? false,
        structured: client.interactionResponse,
      };
      break;
    case "kv_client_message":
      // Cursor sends KV updates as transport metadata while a provider turn is
      // still running. Acknowledge them idempotently; treating this
      // valid oneof as unsupported terminates RunSSE and makes Cursor replay
      // the completed user turn under a new request ID.
      kind = "metadata";
      break;
    case "client_heartbeat":
      kind = "heartbeat";
      break;
    default:
      kind = "unknown";
  }

  return {
    kind,
    texts,
    mode,
    modelHint,
    conversationId,
    userMessageId,
    conversationTurnCount,
    conversationState,
    execResult,
    execControl,
    interactionResult,
    contentParts:
      kind === "user_run"
        ? client.contentParts?.length
          ? client.contentParts
          : texts.length
            ? texts.map((text) => ({ type: "text", text }))
            : undefined
        : undefined,
    hasImageAttachment: kind === "user_run" && client.hasImageAttachment,
    conversationAction: client.conversationAction,
    hasRequestContextPayload: client.hasRequestContextPayload,
    hasPendingToolCalls: client.hasPendingToolCalls,
    agentMessageField,
    protobufDecoded: true,
  };
}

// ─── JSON 兼容（冒烟 / 调试，非 Cursor 真机主路径）───

function detectKindFromJson(j: Record<string, unknown>): InboundKind {
  const topKind = String(j.kind || j.type || j.clientKind || "").toLowerCase();
  if (topKind === "metadata") return "metadata";
  if (topKind === "prewarm" || topKind === "prewarm_request") return "prewarm";
  if (
    topKind === "exec_result" ||
    topKind === "execclientmessage" ||
    topKind === "exec_client_message" ||
    topKind === "tool_result"
  ) {
    return "exec_result";
  }
  if (
    topKind === "exec_control" ||
    topKind === "exec_client_control_message" ||
    topKind === "execclientcontrolmessage"
  ) {
    return "exec_control";
  }
  if (topKind === "heartbeat" || topKind === "client_heartbeat") {
    return "heartbeat";
  }
  if (
    topKind === "interaction_response" ||
    topKind === "interactionresponse" ||
    topKind === "ask_question_response"
  ) {
    return "interaction_response";
  }
  if (topKind === "cancel" || topKind === "cancel_action") return "cancel";
  if (topKind === "summarize" || topKind === "summarize_action") {
    return "metadata";
  }

  if (j.execClientMessage || j.exec_client_message || j.execResult || j.exec_result) {
    return "exec_result";
  }
  if (j.execClientControlMessage || j.exec_client_control_message) {
    return "exec_control";
  }
  if (
    j.interactionResponse ||
    j.interaction_response ||
    j.askQuestionInteractionResponse ||
    j.ask_question_interaction_response
  ) {
    return "interaction_response";
  }
  if (j.clientHeartbeat || j.client_heartbeat || j.heartbeat === true) {
    return "heartbeat";
  }
  if (j.prewarmRequest || j.prewarm_request || j.prewarm === true) {
    return "prewarm";
  }
  if (j.cancel || j.cancelAction || j.cancel_action) return "cancel";
  if (j.summarize || j.summarizeAction || j.summarize_action) {
    return "metadata";
  }

  if (
    (j.tool_call_id || j.toolCallId || j.exec_id || j.execId) &&
    (j.result != null || j.payload != null || j.content != null || j.toolResult != null)
  ) {
    return "exec_result";
  }

  return "unknown";
}

function extractExecResult(j: Record<string, unknown>): ExecResultInbound | undefined {
  const nested =
    (j.execClientMessage as Record<string, unknown> | undefined) ||
    (j.exec_client_message as Record<string, unknown> | undefined) ||
    (j.execResult as Record<string, unknown> | undefined) ||
    (j.exec_result as Record<string, unknown> | undefined) ||
    j;

  const execId = String(
    nested.execId || nested.exec_id || nested.id || j.execId || j.exec_id || "",
  ).trim();
  const toolCallId = String(
    nested.toolCallId ||
      nested.tool_call_id ||
      nested.callId ||
      nested.call_id ||
      j.toolCallId ||
      j.tool_call_id ||
      "",
  ).trim();
  const name = String(
    nested.toolName || nested.tool_name || nested.name || j.name || "",
  ).trim();

  let result = "";
  const candidates = [
    nested.result,
    nested.payload,
    nested.content,
    nested.toolResult,
    nested.tool_result,
    nested.toolResultPayload,
    j.result,
    j.payload,
    j.content,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "string") {
      result = c;
      break;
    }
    try {
      result = JSON.stringify(c);
      break;
    } catch {
      result = String(c);
      break;
    }
  }

  if (!result && !execId && !toolCallId) return undefined;

  const okRaw = nested.ok ?? nested.success ?? j.ok ?? j.success;
  const ok =
    okRaw === false || okRaw === 0 || okRaw === "false"
      ? false
      : !String(result).startsWith("Error:");

  return {
    execId: execId || undefined,
    toolCallId: toolCallId || undefined,
    name: name || undefined,
    result: result || "(empty)",
    ok,
    messageId:
      nested.id != null && Number.isFinite(Number(nested.id))
        ? Number(nested.id)
        : j.messageId != null
          ? Number(j.messageId)
          : undefined,
  };
}

function extractInteractionResult(
  j: Record<string, unknown>,
): InteractionResultInbound | undefined {
  const nested =
    (j.interactionResponse as Record<string, unknown> | undefined) ||
    (j.interaction_response as Record<string, unknown> | undefined) ||
    j;

  const messageIdRaw =
    nested.id ?? nested.messageId ?? nested.message_id ?? j.id ?? j.messageId;
  const messageId =
    messageIdRaw != null && Number.isFinite(Number(messageIdRaw))
      ? Number(messageIdRaw)
      : undefined;
  const interactionId = String(
    nested.interactionId ||
      nested.interaction_id ||
      j.interactionId ||
      j.interaction_id ||
      (messageId != null ? String(messageId) : "") ||
      "",
  ).trim();
  const toolCallId = String(
    nested.toolCallId ||
      nested.tool_call_id ||
      j.toolCallId ||
      j.tool_call_id ||
      "",
  ).trim();
  const name = String(
    nested.toolName || nested.tool_name || nested.name || j.name || "",
  ).trim();

  let result = "";
  const candidates = [
    nested.result,
    nested.payload,
    nested.content,
    nested.answers,
    nested.toolResultPayload,
    (nested.askQuestionInteractionResponse as Record<string, unknown> | undefined)
      ?.result,
    j.result,
    j.payload,
    j.content,
    j.answers,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "string") {
      result = c;
      break;
    }
    try {
      result = JSON.stringify(c);
      break;
    } catch {
      result = String(c);
      break;
    }
  }

  if (!result && !interactionId && messageId == null && !toolCallId) {
    return undefined;
  }

  const okRaw = nested.ok ?? nested.success ?? j.ok ?? j.success;
  const ok =
    okRaw === false || okRaw === 0 || okRaw === "false"
      ? false
      : !String(result).startsWith("Error:");

  return {
    interactionId: interactionId || undefined,
    messageId,
    toolCallId: toolCallId || undefined,
    name: name || undefined,
    result: result || "(empty)",
    ok,
  };
}

function parseJsonRequestId(j: Record<string, unknown>): string {
  const ridRaw =
    j.request_id ??
    j.requestId ??
    (j.request as { request_id?: string } | undefined)?.request_id;
  if (typeof ridRaw === "string" && ridRaw.trim()) return ridRaw.trim();
  if (ridRaw && typeof ridRaw === "object") {
    const nested = ridRaw as { request_id?: string; requestId?: string };
    return String(nested.request_id || nested.requestId || "").trim();
  }
  return "";
}

/**
 * 本地协议实现。
 */
export function parseRunSSEInbound(
  buf: Buffer,
  connectContentEncoding?: string | string[],
): ExtractedInbound {
  const unwrapped = unwrapRequestBody(buf, connectContentEncoding);
  const empty: ExtractedInbound = {
    requestId: "",
    texts: [],
    kind: "empty",
    hasDataField: false,
    path: "runsse",
  };

  // JSON 冒烟
  const j = tryParseJson(unwrapped);
  if (j) {
    const rid = parseJsonRequestId(j);
    return { ...empty, requestId: rid };
  }

  // protobuf BidiRequestId
  const rid = decodeBidiRequestIdProto(unwrapped);
  if (rid) return { ...empty, requestId: rid };

  // 偶发：整包就是 request_id 字符串
  const asText = unwrapped.toString("utf8").trim();
  if (looksLikeUuid(asText) || (asText.length >= 8 && asText.length < 128 && !asText.includes("{"))) {
    return { ...empty, requestId: asText };
  }

  return empty;
}

/**
 * 本地协议实现。
 * 本地协议实现。
 */
export function parseBidiAppendInbound(
  buf: Buffer,
  connectContentEncoding?: string | string[],
): ExtractedInbound {
  const unwrapped = unwrapRequestBody(buf, connectContentEncoding);
  let requestId = "";
  let texts: string[] = [];
  let modelHint: string | undefined;
  let mode: string | undefined;
  let kind: InboundKind = "empty" as InboundKind;
  let execResult: ExecResultInbound | undefined;
  let execControl: ExecControlInbound | undefined;
  let interactionResult: InteractionResultInbound | undefined;
  let contentParts: ChatContentPart[] | undefined;
  let hasImageAttachment = false;
  let conversationAction: ExtractedInbound["conversationAction"];
  let hasRequestContextPayload = false;
  let hasPendingToolCalls = false;
  let conversationId: string | undefined;
  let userMessageId: string | undefined;
  let conversationTurnCount: number | undefined;
  let conversationState: Buffer | undefined;
  let hasDataField = false;
  let protobufDecoded = false;
  let appendSeqno: number | undefined;
  let agentMessageField: number | undefined;
  let path: ExtractedInbound["path"] = "bidi_proto";

  const absorbClient = (clientBuf: Buffer) => {
    const dec = decodeAgentClientMessage(clientBuf);
    // Preserve an unsupported but syntactically valid AgentClientMessage so
    // the handler can return Connect invalid_argument instead of a blank ACK.
    protobufDecoded = true;
    if (dec.kind === "unknown" && !dec.texts.length) return;
    const mapped = clientKindToInbound(dec);
    kind = mapped.kind;
    if (mapped.mode) mode = mapped.mode;
    if (mapped.modelHint) modelHint = mapped.modelHint;
    if (mapped.conversationId) conversationId = mapped.conversationId;
    if (mapped.userMessageId) userMessageId = mapped.userMessageId;
    if (mapped.conversationTurnCount != null) {
      conversationTurnCount = mapped.conversationTurnCount;
    }
    if (mapped.conversationState?.length) {
      conversationState = Buffer.from(mapped.conversationState);
    }
    if (mapped.agentMessageField != null) {
      agentMessageField = mapped.agentMessageField;
    }
    if (mapped.execResult) execResult = mapped.execResult;
    if (mapped.execControl) execControl = mapped.execControl;
    if (mapped.interactionResult) interactionResult = mapped.interactionResult;
    if (mapped.contentParts?.length) contentParts = mapped.contentParts;
    hasImageAttachment ||= Boolean(mapped.hasImageAttachment);
    if (mapped.conversationAction) conversationAction = mapped.conversationAction;
    hasRequestContextPayload ||= Boolean(mapped.hasRequestContextPayload);
    hasPendingToolCalls ||= Boolean(mapped.hasPendingToolCalls);
    for (const t of mapped.texts) {
      if (!texts.includes(t)) texts.push(t);
    }
  };

  // ── 1) JSON（冒烟 / 兼容）──
  const jTop = tryParseJson(unwrapped);
  if (jTop) {
    path = "bidi_json";
    requestId = parseJsonRequestId(jTop);
    const jsonAppendSeqno = jTop.append_seqno ?? jTop.appendSeqno;
    if (jsonAppendSeqno != null && Number.isFinite(Number(jsonAppendSeqno))) {
      appendSeqno = Number(jsonAppendSeqno);
    }
    kind = detectKindFromJson(jTop);
    if (kind === "exec_result") execResult = extractExecResult(jTop);
    if (kind === "interaction_response") {
      interactionResult = extractInteractionResult(jTop);
    }

    const dataVal = jTop.data;
    if (typeof dataVal === "string" && dataVal.trim()) {
      hasDataField = true;
      const decoded = decodeAgentClientMessageFromHex(dataVal);
      if (decoded.ok && decoded.raw) {
        absorbClient(decoded.raw);
        path = "bidi_json";
      }
    }

    // 调试快捷：{ request_id, text }（非 Cursor 真机）
    if (typeof jTop.text === "string" && isPrintableUserText(jTop.text)) {
      path = "debug_json";
      texts.push(jTop.text.trim());
      contentParts = [...(contentParts || []), { type: "text", text: jTop.text.trim() }];
      if (kind === "unknown" || kind === "empty") kind = "user_run";
    }
    if (typeof jTop.content === "string" && isPrintableUserText(jTop.content)) {
      path = "debug_json";
      texts.push(jTop.content.trim());
      contentParts = [...(contentParts || []), { type: "text", text: jTop.content.trim() }];
      if (kind === "unknown" || kind === "empty") kind = "user_run";
    }
    if (typeof jTop.model === "string" && jTop.model.trim()) {
      modelHint = modelHint || jTop.model.trim();
    }
    if (typeof jTop.modelHint === "string" && jTop.modelHint.trim()) {
      modelHint = modelHint || jTop.modelHint.trim();
    }
    if (typeof jTop.mode === "string" && jTop.mode.trim()) {
      mode = mode || jTop.mode.trim();
    } else if (typeof jTop.mode === "number") {
      mode = mode || modeNumberToName(jTop.mode);
    }

    if (kind === "unknown" || kind === "empty") {
      if (execResult) kind = "exec_result";
      else if (interactionResult) kind = "interaction_response";
      else if (texts.length || contentParts?.length) kind = "user_run";
      else if (!hasDataField) kind = "empty";
    }

    return {
      requestId,
      texts: [...new Set(texts)],
      contentParts,
      hasImageAttachment,
      conversationAction,
      hasRequestContextPayload,
      hasPendingToolCalls,
      modelHint,
      mode,
      kind,
      execResult,
      execControl,
      interactionResult,
      conversationId,
      userMessageId,
      conversationTurnCount,
      conversationState,
      hasDataField,
      protobufDecoded,
      appendSeqno,
      agentMessageField,
      path,
    };
  }

  // ── 2) Cursor 真机主路径：protobuf BidiAppendRequest ──
  const append = decodeBidiAppendRequestProto(unwrapped);
  if (append.ok && (append.dataHex || append.requestId)) {
    path = "bidi_proto";
    if (append.requestId) requestId = append.requestId;
    if (append.appendSeqno != null) appendSeqno = append.appendSeqno;
    hasDataField = Boolean(append.dataHex);

    if (append.dataHex) {
      const decoded = decodeAgentClientMessageFromHex(append.dataHex);
      if (decoded.ok && decoded.raw) {
        absorbClient(decoded.raw);
      } else if (!decoded.ok) {
        kind = "unknown";
      }
    }

    if (kind === "unknown" || kind === "empty") {
      if (execResult) kind = "exec_result";
      else if (interactionResult) kind = "interaction_response";
      else if (texts.length || contentParts?.length) kind = "user_run";
      else if (!hasDataField) kind = "empty";
      else if (protobufDecoded) kind = "unknown";
      else kind = "empty";
    }

    return {
      requestId,
      texts: [...new Set(texts)],
      contentParts,
      hasImageAttachment,
      conversationAction,
      hasRequestContextPayload,
      hasPendingToolCalls,
      modelHint,
      mode,
      kind,
      execResult,
      execControl,
      interactionResult,
      conversationId,
      userMessageId,
      conversationTurnCount,
      conversationState,
      hasDataField,
      protobufDecoded,
      appendSeqno,
      agentMessageField,
      path,
    };
  }

  // ── 3) 裸 AgentClientMessage（调试）──
  path = "agent_client";
  const asText = unwrapped.toString("utf8").trim();
  const wholeHex = tryDecodeHex(asText);
  if (wholeHex && wholeHex.length > 4) {
    absorbClient(wholeHex);
  } else {
    // 尝试当 AgentClientMessage；不 UTF-8 刮字
    absorbClient(unwrapped);
  }

  if (
    !texts.length &&
    !contentParts?.length &&
    !execResult &&
    !execControl &&
    !interactionResult &&
    kind !== "summarize" &&
    kind !== "metadata" &&
    kind !== "prewarm"
  ) {
    kind = "empty";
  }

  return {
    requestId,
    texts: [...new Set(texts)],
    contentParts,
    hasImageAttachment,
    conversationAction,
    hasRequestContextPayload,
    hasPendingToolCalls,
    modelHint,
    mode,
    kind,
    execResult,
    execControl,
    interactionResult,
    conversationId,
    userMessageId,
    conversationTurnCount,
    conversationState,
    hasDataField,
    protobufDecoded,
    appendSeqno,
    agentMessageField,
    path,
  };
}

/**
 * 统一入口（冒烟兼容）：
 * - 优先按 BidiAppend 解析
 * - 若无 data 且仅有 request_id 形态，回落 RunSSE 解析
 *
 * 真实 handler 应分别调用 parseBidiAppendInbound / parseRunSSEInbound。
 */
export function extractInbound(buf: Buffer): ExtractedInbound {
  const bidi = parseBidiAppendInbound(buf);
  // BidiAppend 命中（有 data / 有 kind / 有文本 / json debug）
  if (
    bidi.hasDataField ||
    bidi.protobufDecoded ||
    bidi.texts.length ||
    bidi.contentParts?.length ||
    bidi.execResult ||
    bidi.execControl ||
    bidi.interactionResult ||
    bidi.kind === "user_run" ||
    bidi.kind === "prewarm" ||
    bidi.kind === "exec_result" ||
    bidi.kind === "exec_control" ||
    bidi.kind === "interaction_response" ||
    bidi.kind === "heartbeat" ||
    bidi.kind === "summarize" ||
    bidi.kind === "cancel" ||
    bidi.kind === "metadata" ||
    bidi.path === "debug_json" ||
    bidi.path === "bidi_json"
  ) {
    // 即使 requestId 空也返回 bidi 结果（handler 决定是否 400）
    if (
      bidi.requestId ||
      bidi.hasDataField ||
      bidi.texts.length ||
      bidi.contentParts?.length ||
      bidi.path === "debug_json"
    ) {
      return bidi;
    }
  }

  // RunSSE 仅 request_id
  const runsse = parseRunSSEInbound(buf);
  if (runsse.requestId) return runsse;

  return bidi.requestId || bidi.kind !== "empty"
    ? bidi
    : {
        requestId: "",
        texts: [],
        kind: "empty",
        hasDataField: false,
        path: "runsse",
      };
}
