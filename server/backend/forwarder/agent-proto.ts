import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本地协议实现。
 * 仅覆盖 forwarder 主链路字段，非完整 codegen。
 */
import {
  collectStrings,
  concatMessages,
  decodeFields,
  decodeStringValueMap,
  encodeInt32,
  encodeInt64Force,
  encodeMessage,
  encodeString,
  encodeStringValueMap,
  encodeUint32,
  encodeVarintFieldForce,
  firstBytes,
  firstString,
  firstVarint,
} from "./protobuf-wire";
import {
  normalizeImageMimeType,
  type ChatContentPart,
} from "../agent/content-parts";

export type DecodedAgentClient = {
  kind:
    | "run_request"
    | "exec_client_message"
    | "exec_client_control_message"
    | "conversation_action"
    | "client_heartbeat"
    | "prewarm_request"
    | "kv_client_message"
    | "interaction_response"
  | "unknown";
  texts: string[];
  /** User prompt text and inline image attachments in their original order. */
  contentParts?: ChatContentPart[];
  /** True when Cursor selected an image, even if its bytes need a later fallback. */
  hasImageAttachment?: boolean;
  mode?: number;
  modelHint?: string;
  conversationId?: string;
  execId?: string;
  messageId?: number;
  /** 从结果 message 收集的文本摘要 */
  resultText?: string;
  rawKindField?: number;
};

const MODE_NAMES: Record<number, string> = {
  0: "agent",
  1: "agent",
  2: "ask",
  3: "plan",
  4: "debug",
  5: "agent", // triage → agent 近似
  6: "agent", // project
  7: "multitask",
};

export function modeNumberToName(n?: number): string | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  return MODE_NAMES[n] || "agent";
}

type BlobLookup = ReadonlyMap<string, Buffer>;

const EMPTY_BLOB_LOOKUP: BlobLookup = new Map();
const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function blobKey(value: Buffer | undefined): string | undefined {
  return value?.length ? value.toString("base64") : undefined;
}

function textContentParts(texts: string[]): ChatContentPart[] {
  return texts
    .filter((text) => Boolean(text))
    .map((text) => ({ type: "text", text }));
}

function supportedImageMimeType(value: string | undefined): string | undefined {
  const mimeType = String(value || "").trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  return /^(image\/(?:jpeg|png|gif|webp))$/.test(mimeType)
    ? mimeType
    : undefined;
}

function imageMimeTypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function readSelectedImagePath(
  filePath: string | undefined,
  mimeType: string | undefined,
): Buffer | undefined {
  if (!filePath || filePath.includes("\0")) return undefined;
  let localPath = filePath;
  if (/^file:/i.test(localPath)) {
    try {
      localPath = fileURLToPath(localPath);
    } catch {
      return undefined;
    }
  }
  if (!supportedImageMimeType(mimeType) && !imageMimeTypeFromPath(localPath)) {
    return undefined;
  }
  try {
    const stat = statSync(localPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_IMAGE_BYTES) {
      return undefined;
    }
    const data = readFileSync(localPath);
    return data.length <= MAX_INLINE_IMAGE_BYTES ? data : undefined;
  } catch {
    return undefined;
  }
}

function decodePreFetchedBlobs(fields: ReturnType<typeof decodeFields>): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  for (const field of fields) {
    if (field.field !== 17 || field.wire !== 2 || !field.bytes) continue;
    try {
      const blobFields = decodeFields(field.bytes);
      const key = blobKey(firstBytes(blobFields, 1));
      const value = firstBytes(blobFields, 2);
      if (key && value?.length) blobs.set(key, value);
    } catch {
      // Ignore a malformed prefetched blob and keep parsing the prompt itself.
    }
  }
  return blobs;
}

function resolveSelectedImageData(
  fields: ReturnType<typeof decodeFields>,
  blobs: BlobLookup,
  filePath: string | undefined,
  mimeType: string | undefined,
): Buffer | undefined {
  // SelectedImage.data = 8 (the normal inline path).
  const direct = firstBytes(fields, 8);
  if (direct?.length) return direct;

  // SelectedImage.blob_id_with_data = 9 { blob_id = 1, data = 2 }.
  const withData = firstBytes(fields, 9);
  if (withData) {
    try {
      const nested = decodeFields(withData);
      const nestedData = firstBytes(nested, 2);
      if (nestedData?.length) return nestedData;
      const nestedId = blobKey(firstBytes(nested, 1));
      const nestedBlobData = nestedId ? blobs.get(nestedId) : undefined;
      if (nestedBlobData?.length) return nestedBlobData;
    } catch {
      return undefined;
    }
  }

  // SelectedImage.blob_id = 1 references AgentRunRequest.pre_fetched_blobs.
  const id = blobKey(firstBytes(fields, 1));
  const blobData = id ? blobs.get(id) : undefined;
  return blobData || readSelectedImagePath(filePath, mimeType);
}

function decodeSelectedImages(
  selectedContext: Buffer,
  blobs: BlobLookup,
): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  try {
    const contextFields = decodeFields(selectedContext);
    for (const field of contextFields) {
      // SelectedContext.selected_images = 1 (repeated SelectedImage).
      if (field.field !== 1 || field.wire !== 2 || !field.bytes) continue;
      const imageFields = decodeFields(field.bytes);
      const path = firstString(imageFields, 3)?.trim() || undefined;
      const declaredMimeType = supportedImageMimeType(firstString(imageFields, 7));
      const sourceMimeType = declaredMimeType || imageMimeTypeFromPath(path);
      const data = resolveSelectedImageData(imageFields, blobs, path, sourceMimeType);
      if (!data?.length || data.length > MAX_INLINE_IMAGE_BYTES) continue;

      parts.push({
        type: "image",
        mimeType: normalizeImageMimeType(sourceMimeType),
        dataBase64: data.toString("base64"),
        path,
      });
    }
  } catch {
    // A bad selected-context entry must not prevent the text prompt from running.
  }
  return parts;
}

function selectedContextHasImages(selectedContext: Buffer): boolean {
  try {
    return decodeFields(selectedContext).some(
      (field) => field.field === 1 && field.wire === 2 && Boolean(field.bytes),
    );
  } catch {
    return false;
  }
}

function decodeUserMessage(
  buf: Buffer,
  blobs: BlobLookup = EMPTY_BLOB_LOOKUP,
): {
  text?: string;
  mode?: number;
  contentParts?: ChatContentPart[];
  hasImageAttachment?: boolean;
} {
  const fields = decodeFields(buf);
  const text = firstString(fields, 1);
  const contentParts = text ? textContentParts([text]) : [];
  const selectedContext = firstBytes(fields, 3);
  const hasImageAttachment = selectedContext
    ? selectedContextHasImages(selectedContext)
    : false;
  if (selectedContext) {
    contentParts.push(...decodeSelectedImages(selectedContext, blobs));
  }
  return {
    text,
    mode: firstVarint(fields, 4),
    contentParts: contentParts.length ? contentParts : undefined,
    hasImageAttachment,
  };
}

function decodeUserMessageAction(
  buf: Buffer,
  blobs: BlobLookup = EMPTY_BLOB_LOOKUP,
): {
  text?: string;
  mode?: number;
  contentParts?: ChatContentPart[];
  hasImageAttachment?: boolean;
} {
  const fields = decodeFields(buf);
  const um = firstBytes(fields, 1);
  if (!um) return {};
  return decodeUserMessage(um, blobs);
}

function decodeConversationAction(
  buf: Buffer,
  blobs: BlobLookup = EMPTY_BLOB_LOOKUP,
): {
  texts: string[];
  contentParts?: ChatContentPart[];
  hasImageAttachment?: boolean;
  mode?: number;
  cancel?: boolean;
} {
  const fields = decodeFields(buf);
  const texts: string[] = [];
  const contentParts: ChatContentPart[] = [];
  let hasImageAttachment = false;
  let mode: number | undefined;
  // user_message_action = 1
  const uma = firstBytes(fields, 1);
  if (uma) {
    const u = decodeUserMessageAction(uma, blobs);
    if (u.text) texts.push(u.text);
    if (u.contentParts?.length) contentParts.push(...u.contentParts);
    hasImageAttachment ||= Boolean(u.hasImageAttachment);
    if (u.mode != null) mode = u.mode;
  }
  // cancel_action = 3
  const cancel = firstBytes(fields, 3) != null || firstVarint(fields, 3) != null;
  // shell_command_action = 5 → 取字符串
  const shellAct = firstBytes(fields, 5);
  if (shellAct) {
    const shellTexts = collectStrings(shellAct, 4);
    texts.push(...shellTexts);
    contentParts.push(...textContentParts(shellTexts));
  }
  return {
    texts,
    contentParts: contentParts.length ? contentParts : undefined,
    hasImageAttachment,
    mode,
    cancel,
  };
}

function decodeModelDetails(buf: Buffer): string | undefined {
  // ModelDetails: model_id = 1, display_model_id = 3
  const fields = decodeFields(buf);
  const modelId = firstString(fields, 1)?.trim();
  if (modelId) return modelId;
  const display = firstString(fields, 3)?.trim();
  if (display) return display;
  const strs = collectStrings(buf, 8);
  return (
    strs.find((s) =>
      /^(gpt|claude|o\d|gemini|deepseek|qwen|glm|grok|moonshot)/i.test(s),
    ) || strs[0]
  );
}

const EFFORT_IDS = new Set([
  "thinking_effort",
  "reasoning",
  "reasoning_effort",
  "thinking_intensity",
  "anthropic_thinking_effort",
  "openai_reasoning_effort",
]);

function normalizeEffortValue(raw: string | undefined): string | undefined {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (["disabled", "low", "medium", "high", "xhigh", "max"].includes(v)) {
    return v;
  }
  if (["disable", "off", "none", "false", "no", "0"].includes(v)) return "disabled";
  if (
    ["very_high", "very-high", "veryhigh", "x-high", "extra_high", "extrahigh"].includes(
      v,
    )
  ) {
    return "xhigh";
  }
  if (v === "maximum") return "max";
  return undefined;
}

function decodeRequestedModel(buf: Buffer): string | undefined {
  const fields = decodeFields(buf);
  const modelId = firstString(fields, 1)?.trim() || "";
  const isVariant = firstVarint(fields, 8) === 1;

  let effort: string | undefined;
  for (const f of fields) {
    if (f.field !== 3 || f.wire !== 2 || !f.bytes) continue;
    const pf = decodeFields(f.bytes);
    const id = firstString(pf, 1)?.trim().toLowerCase() || "";
    const value = firstString(pf, 2)?.trim() || "";
    if (EFFORT_IDS.has(id)) {
      effort = normalizeEffortValue(value);
      if (effort) break;
    }
  }

  if (!modelId) return undefined;
  if (isVariant) {
    // model_id 已是 channel:effort 形态
    return modelId;
  }
  if (effort && effort !== "disabled") {
    return `${modelId}:${effort}`;
  }
  return modelId;
}

function decodeRunRequest(buf: Buffer): DecodedAgentClient {
  const fields = decodeFields(buf);
  const texts: string[] = [];
  const contentParts: ChatContentPart[] = [];
  let hasImageAttachment = false;
  let mode: number | undefined;
  let modelHint: string | undefined;
  const conversationId = firstString(fields, 5);
  const preFetchedBlobs = decodePreFetchedBlobs(fields);

  // action = 2
  const action = firstBytes(fields, 2);
  if (action) {
    const ca = decodeConversationAction(action, preFetchedBlobs);
    texts.push(...ca.texts);
    if (ca.contentParts?.length) contentParts.push(...ca.contentParts);
    hasImageAttachment ||= Boolean(ca.hasImageAttachment);
    if (ca.mode != null) mode = ca.mode;
  }

  // requested_model = 9（优先：含 channel + thinking_effort）
  const rm = firstBytes(fields, 9);
  if (rm) {
    modelHint = decodeRequestedModel(rm);
  }

  // model_details = 3
  const md = firstBytes(fields, 3);
  if (md) modelHint = modelHint || decodeModelDetails(md);

  // conversation_state = 1 里可能有 mode
  const cs = firstBytes(fields, 1);
  if (cs) {
    const csFields = decodeFields(cs);
    const m = firstVarint(csFields, 1) ?? firstVarint(csFields, 2);
    // 宽松：扫描 mode enum
    for (const f of csFields) {
      if (f.wire === 0 && f.varint != null) {
        const n = Number(f.varint);
        if (n >= 1 && n <= 7 && mode == null) mode = n;
      }
    }
    void m;
  }

  return {
    kind: "run_request",
    texts,
    contentParts: contentParts.length ? contentParts : undefined,
    hasImageAttachment,
    mode,
    modelHint,
    conversationId,
  };
}

function decodeExecClientMessage(buf: Buffer): DecodedAgentClient {
  const fields = decodeFields(buf);
  const messageId = firstVarint(fields, 1);
  const execId = firstString(fields, 15);
  // 结果 oneof：取所有嵌套字符串拼摘要
  const parts: string[] = [];
  for (const f of fields) {
    if (f.wire === 2 && f.bytes && f.field !== 15) {
      parts.push(...collectStrings(f.bytes, 12));
    }
  }
  const resultText = parts
    .filter((s) => s.length < 8000 && !/^[0-9a-f-]{20,}$/i.test(s))
    .slice(0, 8)
    .join("\n");

  return {
    kind: "exec_client_message",
    texts: [],
    execId,
    messageId,
    resultText: resultText || undefined,
    rawKindField: fields.find((f) => f.wire === 2 && f.field !== 15)?.field,
  };
}

function decodeExecControl(buf: Buffer): DecodedAgentClient {
  const fields = decodeFields(buf);
  return {
    kind: "exec_client_control_message",
    texts: [],
    messageId: firstVarint(fields, 1) ?? firstVarint(decodeFields(firstBytes(fields, 1) || Buffer.alloc(0)), 1),
  };
}

/** 解码 AgentClientMessage 二进制 */
export function decodeAgentClientMessage(buf: Buffer): DecodedAgentClient {
  if (!buf?.length) {
    return { kind: "unknown", texts: [] };
  }
  try {
    const fields = decodeFields(buf);
    // oneof message
    const run = firstBytes(fields, 1);
    if (run) return decodeRunRequest(run);

    const exec = firstBytes(fields, 2);
    if (exec) return decodeExecClientMessage(exec);

    const kv = firstBytes(fields, 3);
    if (kv) return { kind: "kv_client_message", texts: [] };

    const conv = firstBytes(fields, 4);
    if (conv) {
      const ca = decodeConversationAction(conv);
      if (ca.cancel) {
        return {
          kind: "conversation_action",
          texts: [],
          contentParts: ca.contentParts,
          hasImageAttachment: ca.hasImageAttachment,
          mode: ca.mode,
        };
      }
      return {
        kind: "conversation_action",
        texts: ca.texts,
        contentParts: ca.contentParts,
        hasImageAttachment: ca.hasImageAttachment,
        mode: ca.mode,
      };
    }

    const execCtrl = firstBytes(fields, 5);
    if (execCtrl) return decodeExecControl(execCtrl);

    const interaction = firstBytes(fields, 6);
    if (interaction) {
      const ifs = decodeFields(interaction);
      const messageId = firstVarint(ifs, 1);
      const parts = collectStrings(interaction, 12);
      const resultText = parts
        .filter((s) => s.length < 8000)
        .slice(0, 12)
        .join("\n");
      return {
        kind: "interaction_response",
        texts: parts.slice(0, 4),
        messageId,
        resultText: resultText || undefined,
      };
    }

    const hb = firstBytes(fields, 7);
    if (hb || firstVarint(fields, 7) != null) {
      return { kind: "client_heartbeat", texts: [] };
    }

    const prewarm = firstBytes(fields, 8);
    if (prewarm) return { kind: "prewarm_request", texts: collectStrings(prewarm, 4) };

    return { kind: "unknown", texts: collectStrings(buf, 8) };
  } catch {
    return { kind: "unknown", texts: [] };
  }
}

// ─── 编码：用于冒烟 / 可选二进制下行 ───

export function encodeUserMessage(text: string, mode = 1): Buffer {
  return concatMessages(encodeString(1, text), encodeUint32(4, mode));
}

export function encodeUserMessageAction(text: string, mode = 1): Buffer {
  return encodeMessage(1, encodeUserMessage(text, mode));
}

export function encodeConversationActionUser(text: string, mode = 1): Buffer {
  // user_message_action = 1
  return encodeMessage(1, encodeUserMessageAction(text, mode));
}

export function encodeRunRequest(opts: {
  text: string;
  mode?: number;
  conversationId?: string;
  modelName?: string;
}): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodeMessage(2, encodeConversationActionUser(opts.text, opts.mode ?? 1)));
  if (opts.conversationId) parts.push(encodeString(5, opts.conversationId));
  if (opts.modelName) {
    // requested_model = 9，内放字符串 field 1
    parts.push(encodeMessage(9, encodeString(1, opts.modelName)));
  }
  return concatMessages(...parts);
}

export function encodeAgentClientRun(opts: {
  text: string;
  mode?: number;
  conversationId?: string;
  modelName?: string;
}): Buffer {
  return encodeMessage(1, encodeRunRequest(opts));
}

export function encodeAgentClientExecResult(opts: {
  messageId: number;
  execId: string;
  resultText: string;
  /** 按工具选 ExecClientMessage oneof；默认 Shell */
  toolName?: string;
  ok?: boolean;
  args?: Record<string, unknown>;
}): Buffer {
  const a = opts.args || {};
  const ok = opts.ok !== false;
  const text = opts.resultText ?? "";
  const tool = opts.toolName || "Shell";

  // ExecClientMessage result oneof 字段号
  let resultField = 2; // shell_result
  let resultBody: Buffer;

  switch (tool) {
    case "Read":
      resultField = 7; // read_result
      resultBody = encodeReadResult(text, ok, String(a.path || ""));
      break;
    case "Write":
      resultField = 3; // write_result
      resultBody = encodeWriteResult(text, ok, String(a.path || ""));
      break;
    case "Delete":
      resultField = 4;
      resultBody = encodeDeleteResult(text, ok, String(a.path || ""));
      break;
    case "Grep":
    case "Glob":
      resultField = 5;
      resultBody = encodeGrepResult(text, ok, a);
      break;
    case "Ls":
      resultField = 8;
      resultBody = encodeLsResult(text, ok, String(a.path || "."));
      break;
    case "CallMcpTool":
      resultField = 11; // mcp_result（与 McpToolResult 同构 success/error）
      resultBody = encodeMcpExecResult(text, ok);
      break;
    case "WebFetch":
      resultField = 20; // fetch_result — 用字符串摘要近似
      resultBody = encodeFetchResultApprox(text, ok, String(a.url || ""));
      break;
    case "Task":
      resultField = 28; // subagent_result
      resultBody = encodeTaskResult(text, ok);
      break;
    case "Shell":
    case "AwaitShell":
    default:
      resultField = 2;
      resultBody = encodeShellResult(text, ok, a);
      break;
  }

  const execMsg = concatMessages(
    encodeVarintFieldForce(1, opts.messageId),
    encodeMessage(resultField, resultBody),
    encodeString(15, opts.execId),
  );
  return encodeMessage(2, execMsg);
}

/** ReadResult / ReadToolResult 共用 success|error 骨架 */
function encodeReadResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (ok) {
    // ReadSuccess { path=1, content=2 }
    const success = concatMessages(
      encodeString(1, pathStr),
      encodeString(2, text),
    );
    return encodeMessage(1, success);
  }
  // ReadError { error=1 } — 工具态用 ReadToolError.error_message=1
  return encodeMessage(2, encodeString(1, text));
}

/** ReadToolResult（ToolCall 内）success 的 content 在 output oneof field 1 */
function encodeReadToolResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (ok) {
    const success = concatMessages(
      encodeString(1, text), // content
      pathStr ? encodeString(7, pathStr) : Buffer.alloc(0),
    );
    return encodeMessage(1, success);
  }
  return encodeMessage(2, encodeString(1, text)); // ReadToolError.error_message
}

function encodeWriteResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (ok) {
    // WriteSuccess { path=1, file_content_after_write=4 } / EditSuccess 近似
    return encodeMessage(
      1,
      concatMessages(
        encodeString(1, pathStr),
        encodeString(4, text),
      ),
    );
  }
  // WriteError = 5 { path?, error }
  return encodeMessage(
    5,
    concatMessages(encodeString(1, pathStr), encodeString(2, text)),
  );
}

function encodeEditToolResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (ok) {
    // EditSuccess { path=1, message=8, after_full_file_content=7 }
    return encodeMessage(
      1,
      concatMessages(
        encodeString(1, pathStr),
        encodeString(7, text),
        encodeString(8, text.slice(0, 200)),
      ),
    );
  }
  // EditError = 7
  return encodeMessage(
    7,
    concatMessages(encodeString(1, pathStr), encodeString(2, text)),
  );
}

function encodeDeleteResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (ok) {
    // DeleteSuccess { path=1, deleted_file=2, prev_content=4 }
    return encodeMessage(
      1,
      concatMessages(
        encodeString(1, pathStr),
        encodeString(2, pathStr),
        // 无真实旧内容时，用 result 文本占位，便于摘要/回灌
        text ? encodeString(4, text) : Buffer.alloc(0),
      ),
    );
  }
  // DeleteError = 7
  return encodeMessage(
    7,
    concatMessages(encodeString(1, pathStr), encodeString(2, text)),
  );
}

function encodeGrepResult(
  text: string,
  ok: boolean,
  args: Record<string, unknown>,
): Buffer {
  if (!ok) {
    return encodeMessage(2, encodeString(1, text)); // GrepError
  }
  // GrepSuccess + workspace_results map → content 单文件摘要
  const pattern = String(args.pattern || "");
  const pathStr = String(args.path || ".");
  // GrepContentMatch { line_number=1, content=2 }
  const lineMatch = concatMessages(
    encodeInt32(1, 1),
    encodeString(2, text.slice(0, 50_000)),
  );
  // GrepFileMatch { file=1, matches=2 }
  const fileMatch = concatMessages(
    encodeString(1, pathStr),
    encodeMessage(2, lineMatch),
  );
  // GrepContentResult { matches=1 }
  const contentResult = encodeMessage(1, fileMatch);
  // GrepUnionResult { content=3 }
  const union = encodeMessage(3, contentResult);
  // map entry { key=1, value=2 }
  const mapEntry = concatMessages(encodeString(1, pathStr || "."), encodeMessage(2, union));
  const success = concatMessages(
    encodeString(1, pattern),
    encodeString(2, pathStr),
    encodeString(3, "content"),
    encodeMessage(4, mapEntry),
  );
  return encodeMessage(1, success);
}

function encodeLsResult(text: string, ok: boolean, pathStr: string): Buffer {
  if (!ok) {
    return encodeMessage(
      2,
      concatMessages(encodeString(1, pathStr), encodeString(2, text)),
    );
  }
  // 把输出行拆成 children_files 名称
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 200);
  const files = lines.map((line) => {
    // "dir name" / "file name" 或纯名称
    const name = line.replace(/^(dir|file)\s+/i, "").trim() || line;
    return encodeMessage(3, encodeString(1, name)); // children_files = 3 File{name=1}
  });
  const tree = concatMessages(
    encodeString(1, pathStr),
    ...files,
    encodeVarintFieldForce(4, 1), // children_were_processed
    encodeInt32(6, lines.length),
  );
  return encodeMessage(1, encodeMessage(1, tree)); // success.directory_tree_root
}

function encodeShellResult(
  text: string,
  ok: boolean,
  args: Record<string, unknown>,
): Buffer {
  const cmd = String(args.command || "");
  const cwd = String(args.working_directory || args.workingDirectory || "");
  if (ok) {
    // ShellSuccess
    return encodeMessage(
      1,
      concatMessages(
        encodeString(1, cmd),
        encodeString(2, cwd),
        encodeInt32(3, 0),
        encodeString(5, text),
      ),
    );
  }
  // ShellFailure = 2
  return encodeMessage(
    2,
    concatMessages(
      encodeString(1, cmd),
      encodeString(2, cwd),
      encodeInt32(3, 1),
      encodeString(5, text),
      encodeString(6, text),
    ),
  );
}

function encodeMcpToolResult(text: string, ok: boolean): Buffer {
  if (ok) {
    // McpSuccess { content=1 [ { text=1 { text=1 } } ], is_error=2 }
    const textItem = encodeMessage(1, encodeString(1, text)); // McpToolResultContentItem.text
    const success = concatMessages(encodeMessage(1, textItem));
    return encodeMessage(1, success);
  }
  // McpToolError = 2 { error=1 }
  return encodeMessage(2, encodeString(1, text));
}

/** ExecClientMessage.mcp_result 与 McpToolResult 同构 */
function encodeMcpExecResult(text: string, ok: boolean): Buffer {
  return encodeMcpToolResult(text, ok);
}

function encodeTaskResult(text: string, ok: boolean): Buffer {
  if (ok) {
    // TaskSuccess { result_suffix=5 }
    return encodeMessage(1, encodeString(5, text));
  }
  return encodeMessage(2, encodeString(1, text)); // TaskError
}

function encodeWebFetchToolResult(
  text: string,
  ok: boolean,
  url: string,
): Buffer {
  if (ok) {
    // WebFetchSuccess { url=1, markdown=2 }
    return encodeMessage(
      1,
      concatMessages(encodeString(1, url), encodeString(2, text)),
    );
  }
  return encodeMessage(
    2,
    concatMessages(encodeString(1, url), encodeString(2, text)),
  );
}

function encodeFetchResultApprox(text: string, ok: boolean, url: string): Buffer {
  // FetchResult 结构未全量对齐；用 success-ish 字符串字段保证可解码摘要
  if (ok) {
    return concatMessages(encodeString(1, url), encodeString(2, text));
  }
  return encodeMessage(2, encodeString(1, text));
}

function encodeAwaitToolResult(
  text: string,
  ok: boolean,
  args: Record<string, unknown>,
): Buffer {
  const taskId = String(args.shell_id || args.task_id || args.taskId || "");
  if (!ok) {
    return encodeMessage(3, encodeString(1, text)); // AwaitError
  }
  // still_running if text hints, else complete
  const still = /still running|blocked|running/i.test(text);
  const body = concatMessages(
    encodeString(1, taskId),
    encodeString(3, text.slice(0, 500)), // output_file_path 近似塞摘要
  );
  if (still) {
    return encodeMessage(2, body); // AwaitTaskStillRunning
  }
  return encodeMessage(1, body); // AwaitTaskComplete
}

function encodeWebSearchToolResult(text: string, ok: boolean): Buffer {
  if (ok) {
    // WebSearchSuccess { references=1 } — 用单条 reference.chunk 塞文本
    const ref = concatMessages(
      encodeString(1, "result"),
      encodeString(2, ""),
      encodeString(3, text.slice(0, 50_000)),
    );
    return encodeMessage(1, encodeMessage(1, ref));
  }
  return encodeMessage(2, encodeString(1, text)); // WebSearchError
}

function encodeAskQuestionToolResult(text: string, ok: boolean): Buffer {
  if (ok) {
    // AskQuestionResult.success = 1 { answers=1 }
    let answers: unknown[] = [];
    try {
      const j = JSON.parse(text) as { answers?: unknown[] };
      if (Array.isArray(j.answers)) answers = j.answers;
    } catch {
      /* plain text */
    }
    if (!answers.length) {
      answers = [{ id: "q", freeformText: text }];
    }
    const msgs = answers
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => {
        const qid = String(a.questionId || a.question_id || a.id || "q");
        const selected = Array.isArray(a.selectedOptionIds)
          ? a.selectedOptionIds
          : Array.isArray(a.selected)
            ? a.selected
            : [];
        const free =
          a.freeformText != null
            ? String(a.freeformText)
            : a.freeform_text != null
              ? String(a.freeform_text)
              : !selected.length
                ? text
                : "";
        return concatMessages(
          encodeString(1, qid),
          ...selected.map((s) => encodeString(2, String(s))),
          free ? encodeString(3, free) : Buffer.alloc(0),
        );
      });
    const success = concatMessages(...msgs.map((m) => encodeMessage(1, m)));
    return encodeMessage(1, success);
  }
  return encodeMessage(2, encodeString(1, text)); // AskQuestionError
}

function encodeSwitchModeToolResult(text: string, ok: boolean, args: Record<string, unknown>): Buffer {
  if (ok) {
    return encodeMessage(
      1,
      concatMessages(
        encodeString(1, "agent"),
        encodeString(2, String(args.target_mode_id || args.targetModeId || "plan")),
      ),
    );
  }
  return encodeMessage(2, encodeString(1, text)); // SwitchModeError-ish
}

function encodeCreatePlanToolResult(text: string, ok: boolean): Buffer {
  // CreatePlanResult { success=1 | error=2; plan_uri=3 }
  if (ok) {
    return concatMessages(
      encodeMessage(1, Buffer.alloc(0)),
      encodeString(3, text.slice(0, 500) || "plan"),
    );
  }
  return encodeMessage(2, encodeString(1, text));
}

export function encodeAgentClientHeartbeat(): Buffer {
  return encodeMessage(7, Buffer.alloc(0));
}

/**
 * AgentClientMessage.interaction_response = 6
 * 覆盖 AskQuestion / SwitchMode / CreatePlan / WebSearch 主路径（冒烟 + 可选二进制上行）。
 */
export function encodeAgentClientInteractionResponse(opts: {
  messageId: number;
  toolName: string;
  /** AskQuestion: { answers: [{ questionId, selectedOptionIds?, freeformText? }] } */
  result?: Record<string, unknown> | string;
  ok?: boolean;
}): Buffer {
  const id = opts.messageId >>> 0;
  const ok = opts.ok !== false;
  const payload =
    typeof opts.result === "string"
      ? safeJsonObject(opts.result)
      : (opts.result && typeof opts.result === "object" ? opts.result : {});

  let resultField = 0;
  let resultBody: Buffer = Buffer.alloc(0);
  const tool = opts.toolName;

  switch (tool) {
    case "AskQuestion": {
      // ask_question_interaction_response = 3
      // → result=1 → success=1 → answers=1 repeated Answer
      const answers = Array.isArray(payload.answers)
        ? payload.answers
        : Array.isArray((payload as { result?: { answers?: unknown } }).result?.answers)
          ? ((payload as { result: { answers: unknown[] } }).result.answers)
          : [];
      const answerMsgs = answers
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => {
          const qid = String(a.questionId || a.question_id || a.id || "");
          const selected = Array.isArray(a.selectedOptionIds)
            ? a.selectedOptionIds
            : Array.isArray(a.selected_option_ids)
              ? a.selected_option_ids
              : Array.isArray(a.selected)
                ? a.selected
                : [];
          const free =
            a.freeformText != null
              ? String(a.freeformText)
              : a.freeform_text != null
                ? String(a.freeform_text)
                : "";
          return concatMessages(
            encodeString(1, qid),
            ...selected.map((s) => encodeString(2, String(s))),
            free ? encodeString(3, free) : Buffer.alloc(0),
          );
        });
      const success = concatMessages(
        ...answerMsgs.map((m) => encodeMessage(1, m)),
      );
      // AskQuestionResult: success=1 | error=2 | rejected=3
      const askResult = ok
        ? encodeMessage(1, success)
        : encodeMessage(
            2,
            encodeString(
              1,
              String(payload.error || payload.error_message || "rejected"),
            ),
          );
      resultField = 3;
      resultBody = Buffer.from(encodeMessage(1, askResult));
      break;
    }
    case "SwitchMode": {
      // switch_mode_request_response = 4 → approved=1 | rejected=2
      resultField = 4;
      resultBody = Buffer.from(
        ok
          ? encodeMessage(1, Buffer.alloc(0))
          : encodeMessage(
              2,
              encodeString(1, String(payload.reason || payload.error || "rejected")),
            ),
      );
      break;
    }
    case "CreatePlan": {
      // create_plan_request_response = 7 → result=1 → success=1 | error=2; plan_uri=3
      const planUri = String(payload.plan_uri || payload.planUri || "");
      const createResult = concatMessages(
        ok
          ? encodeMessage(1, Buffer.alloc(0))
          : encodeMessage(
              2,
              encodeString(1, String(payload.error || "create plan failed")),
            ),
        planUri ? encodeString(3, planUri) : Buffer.alloc(0),
      );
      resultField = 7;
      resultBody = Buffer.from(encodeMessage(1, createResult));
      break;
    }
    case "WebSearch": {
      // web_search_request_response = 2 → approved=1 | rejected=2
      resultField = 2;
      resultBody = Buffer.from(
        ok
          ? encodeMessage(1, Buffer.alloc(0))
          : encodeMessage(
              2,
              encodeString(1, String(payload.reason || payload.error || "rejected")),
            ),
      );
      break;
    }
    default: {
      // 未知交互：塞 AskQuestion error 文本，保证 decode 能收到字符串
      resultField = 3;
      resultBody = Buffer.from(
        encodeMessage(
          1,
          encodeMessage(
            2,
            encodeString(1, `${tool}:${JSON.stringify(payload).slice(0, 400)}`),
          ),
        ),
      );
    }
  }

  const interaction = concatMessages(
    encodeVarintFieldForce(1, id),
    encodeMessage(resultField, resultBody),
  );
  return encodeMessage(6, interaction);
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      return j as Record<string, unknown>;
    }
    return { value: j };
  } catch {
    return { text: raw };
  }
}

/** 解码 McpArgs（含 map<string, Value> args = 2） */
export function decodeMcpArgs(buf: Buffer): {
  name?: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  providerIdentifier?: string;
  toolName?: string;
} {
  if (!buf?.length) return { args: {} };
  try {
    const fields = decodeFields(buf);
    return {
      name: firstString(fields, 1),
      args: decodeStringValueMap(fields, 2),
      toolCallId: firstString(fields, 3),
      providerIdentifier: firstString(fields, 4),
      toolName: firstString(fields, 5),
    };
  } catch {
    return { args: {} };
  }
}

/**
 * 窥探 ToolCall oneof：字段号 + result oneof 是否 success(1) 及文本摘要。
 * ToolCall 结构：每个 *ToolCall 内 args=1, result=2{ oneof success=1|error=2|... }
 */
export function peekToolCall(buf?: Buffer): {
  toolField?: number;
  hasResult?: boolean;
  resultOk?: boolean;
  resultText?: string;
} {
  if (!buf?.length) return {};
  try {
    const top = decodeFields(buf);
    // ToolCall 本身是 oneof：唯一 length-delimited 大字段
    const tool = top.find((f) => f.wire === 2 && f.bytes && f.field !== 0);
    if (!tool?.bytes) return {};
    const body = decodeFields(tool.bytes);
    const resultBuf = firstBytes(body, 2);
    if (!resultBuf) {
      return { toolField: tool.field, hasResult: false };
    }
    const rf = decodeFields(resultBuf);
    // success 通常 field 1；error 常见 2/5/7
    const success = rf.find((f) => f.field === 1 && f.wire === 2 && f.bytes);
    const error =
      rf.find((f) => f.field !== 1 && f.wire === 2 && f.bytes) ||
      rf.find((f) => f.wire === 2 && f.bytes && f.field > 1);
    const resultOk = !!success && !error || (!!success && rf.every((f) => f.field === 1 || f.field === 3));
    // 更准：优先看是否有 field=1 且无典型 error 字段
    const hasErrorOnly = !success && !!error;
    const ok = hasErrorOnly ? false : success ? true : undefined;
    const pick = success?.bytes || error?.bytes || resultBuf;
    const texts = collectStrings(pick, 12);
    return {
      toolField: tool.field,
      hasResult: true,
      resultOk: ok,
      // 拼接全部可见字符串，避免 path/url 盖住真正结果体
      resultText: texts.join("\n").slice(0, 800),
    };
  } catch {
    return {};
  }
}

/** ExecServerMessage 参数 oneof 字段号 */
export const ExecArgsField = {
  shell_args: 2,
  write_args: 3,
  delete_args: 4,
  grep_args: 5,
  read_args: 7,
  ls_args: 8,
  mcp_args: 11,
  shell_stream_args: 14,
  list_mcp_resources_exec_args: 17,
  read_mcp_resource_exec_args: 18,
  fetch_args: 20,
  subagent_args: 28,
} as const;

export function encodeReadArgs(opts: {
  path: string;
  toolCallId: string;
  offset?: number;
  limit?: number;
}): Buffer {
  return concatMessages(
    encodeString(1, opts.path),
    encodeString(2, opts.toolCallId),
    opts.offset != null ? encodeInt32(4, opts.offset) : Buffer.alloc(0),
    opts.limit != null ? encodeUint32(5, opts.limit) : Buffer.alloc(0),
  );
}

export function encodeWriteArgs(opts: {
  path: string;
  fileText: string;
  toolCallId: string;
}): Buffer {
  return concatMessages(
    encodeString(1, opts.path),
    encodeString(2, opts.fileText),
    encodeString(3, opts.toolCallId),
  );
}

export function encodeShellArgs(opts: {
  command: string;
  workingDirectory?: string;
  timeout?: number;
  toolCallId: string;
  description?: string;
  isBackground?: boolean;
}): Buffer {
  return concatMessages(
    encodeString(1, opts.command),
    encodeString(2, opts.workingDirectory || ""),
    encodeInt32(3, opts.timeout ?? 30000),
    encodeString(4, opts.toolCallId),
    opts.isBackground ? encodeUint32(11, 1) : Buffer.alloc(0),
    encodeString(15, opts.description || ""),
  );
}

export function encodeDeleteArgs(opts: { path: string; toolCallId: string }): Buffer {
  return concatMessages(encodeString(1, opts.path), encodeString(2, opts.toolCallId));
}

export function encodeLsArgs(opts: { path: string; toolCallId: string }): Buffer {
  return concatMessages(encodeString(1, opts.path), encodeString(2, opts.toolCallId));
}

export function encodeExecServerMessage(opts: {
  messageId: number;
  execId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Buffer {
  const tool = opts.toolName;
  const args = opts.args || {};
  const toolCallId = String(
    args.tool_call_id || args.toolCallId || opts.execId,
  );
  let argsField = 0;
  let argsMsg: Buffer = Buffer.alloc(0);
  const setArgs = (field: number, msg: Buffer) => {
    argsField = field;
    argsMsg = Buffer.from(msg);
  };

  switch (tool) {
    case "Read":
      setArgs(
        ExecArgsField.read_args,
        encodeReadArgs({
          path: String(args.path || ""),
          toolCallId,
          offset: args.offset != null ? Number(args.offset) : undefined,
          limit: args.limit != null ? Number(args.limit) : undefined,
        }),
      );
      break;
    case "Write":
      setArgs(
        ExecArgsField.write_args,
        encodeWriteArgs({
          path: String(args.path || ""),
          fileText: String(args.contents ?? args.file_text ?? args.fileText ?? ""),
          toolCallId,
        }),
      );
      break;
    case "Delete":
      setArgs(
        ExecArgsField.delete_args,
        encodeDeleteArgs({
          path: String(args.path || ""),
          toolCallId,
        }),
      );
      break;
    case "Ls":
      setArgs(
        ExecArgsField.ls_args,
        encodeLsArgs({
          path: String(args.path || "."),
          toolCallId,
        }),
      );
      break;
    case "Shell":
      setArgs(
        ExecArgsField.shell_stream_args,
        encodeShellArgs({
          command: String(args.command || ""),
          workingDirectory: String(
            args.working_directory || args.workingDirectory || "",
          ),
          timeout: Number(args.block_until_ms || args.timeout || 30000),
          toolCallId,
          description: String(args.description || ""),
          isBackground: Number(args.block_until_ms) === 0,
        }),
      );
      break;
    case "WebFetch":
      setArgs(
        ExecArgsField.fetch_args,
        concatMessages(
          encodeString(1, String(args.url || "")),
          encodeString(2, toolCallId),
        ),
      );
      break;
    case "CallMcpTool": {
      const server = String(args.server || args.providerIdentifier || "");
      const toolName = String(args.toolName || args.tool_name || "");
      const lookup = server && toolName ? `${server}/${toolName}` : toolName || server;
      const argObj =
        args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
          ? (args.arguments as Record<string, unknown>)
          : args.args && typeof args.args === "object" && !Array.isArray(args.args)
            ? (args.args as Record<string, unknown>)
            : {};
      setArgs(
        ExecArgsField.mcp_args,
        concatMessages(
          encodeString(1, lookup),
          encodeStringValueMap(2, argObj),
          encodeString(3, toolCallId),
          encodeString(4, server),
          encodeString(5, toolName),
        ),
      );
      break;
    }
    case "Task":
      setArgs(
        ExecArgsField.subagent_args,
        concatMessages(
          encodeString(1, String(args.description || "")),
          encodeString(2, String(args.prompt || "")),
          encodeString(3, String(args.subagent_type || args.subagentType || "explore")),
          args.model != null ? encodeString(4, String(args.model)) : Buffer.alloc(0),
          encodeString(10, toolCallId),
        ),
      );
      break;
    case "ListMcpResources":
      setArgs(
        ExecArgsField.list_mcp_resources_exec_args,
        concatMessages(encodeString(1, String(args.server || ""))),
      );
      break;
    case "FetchMcpResource":
      setArgs(
        ExecArgsField.read_mcp_resource_exec_args,
        concatMessages(
          encodeString(1, String(args.server || "")),
          encodeString(2, String(args.uri || "")),
          encodeString(3, toolCallId),
        ),
      );
      break;
    default:
      setArgs(
        ExecArgsField.shell_args,
        encodeShellArgs({
          command: `echo unsupported:${tool}`,
          toolCallId,
          description: tool,
        }),
      );
  }

  return concatMessages(
    encodeVarintFieldForce(1, opts.messageId),
    encodeMessage(argsField, argsMsg),
    encodeString(15, opts.execId),
  );
}

export function encodeAgentServerExec(opts: {
  messageId: number;
  execId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Buffer {
  return encodeMessage(2, encodeExecServerMessage(opts));
}

/** InteractionUpdate oneof 字段号（agent.v1.InteractionUpdate） */
export const InteractionField = {
  text_delta: 1,
  tool_call_started: 2,
  tool_call_completed: 3,
  thinking_delta: 4,
  thinking_completed: 5,
  partial_tool_call: 7,
  token_delta: 8,
  heartbeat: 13,
  turn_ended: 14,
  tool_call_delta: 15,
} as const;

/** ToolCall oneof 字段号（常用子集） */
export const ToolCallField = {
  shell_tool_call: 1,
  delete_tool_call: 3,
  grep_tool_call: 5,
  read_tool_call: 8,
  edit_tool_call: 12,
  ls_tool_call: 13,
  mcp_tool_call: 15,
  create_plan_tool_call: 17,
  web_search_tool_call: 18,
  task_tool_call: 19,
  ask_question_tool_call: 23,
  switch_mode_tool_call: 25,
  web_fetch_tool_call: 37,
  await_tool_call: 42,
} as const;

function wrapInteraction(field: number, body: Buffer): Buffer {
  // AgentServerMessage { interaction_update = 1 { oneof field = body } }
  return encodeMessage(1, encodeMessage(field, body));
}

function normalizeCheckpointTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffffffff, Math.floor(value));
}

/**
 * AgentServerMessage.conversation_checkpoint_update = 3
 * ConversationStateStructure.token_details = 5
 * ConversationTokenDetails.{used_tokens,max_tokens} = {1,2}
 */
export function encodeConversationCheckpoint(opts: {
  usedTokens: number;
  maxTokens: number;
}): Buffer {
  const tokenDetails = concatMessages(
    encodeUint32(1, normalizeCheckpointTokenCount(opts.usedTokens)),
    encodeUint32(2, normalizeCheckpointTokenCount(opts.maxTokens)),
  );
  return encodeMessage(3, encodeMessage(5, tokenDetails));
}

export function encodeTextDelta(text: string): Buffer {
  return wrapInteraction(InteractionField.text_delta, encodeString(1, text));
}

export function encodeHeartbeatUpdate(): Buffer {
  return wrapInteraction(InteractionField.heartbeat, Buffer.alloc(0));
}

export function encodeThinkingDelta(
  text: string,
  style: number = 1 /* THINKING_STYLE_DEFAULT */,
): Buffer {
  return wrapInteraction(
    InteractionField.thinking_delta,
    concatMessages(encodeString(1, text), encodeUint32(2, style)),
  );
}

export function encodeThinkingCompleted(durationMs: number): Buffer {
  return wrapInteraction(
    InteractionField.thinking_completed,
    encodeInt32(1, Math.max(0, Math.round(durationMs))),
  );
}

export function encodeTokenDelta(tokens: number): Buffer {
  return wrapInteraction(
    InteractionField.token_delta,
    encodeInt32(1, Math.max(0, Math.round(tokens))),
  );
}

export function encodeTurnEnded(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Buffer {
  const body = concatMessages(
    encodeInt64Force(1, usage.inputTokens || 0),
    encodeInt64Force(2, usage.outputTokens || 0),
    encodeInt64Force(3, usage.cacheReadTokens || 0),
    encodeInt64Force(4, usage.cacheWriteTokens || 0),
  );
  return wrapInteraction(InteractionField.turn_ended, body);
}

/** 把工具名/参数编码成 ToolCall message（args 为主；result 走正式 oneof） */
export function encodeToolCallMessage(opts: {
  name: string;
  args?: Record<string, unknown>;
  resultText?: string;
  ok?: boolean;
}): Buffer {
  const a = opts.args || {};
  const toolCallId = String(a.tool_call_id || a.toolCallId || "");
  const name = opts.name;
  const hasResult = opts.resultText != null;
  const ok = opts.ok !== false;
  const text = opts.resultText ?? "";

  const withResultShell = (argsMsg: Buffer): Buffer => {
    const parts = [encodeMessage(1, argsMsg)];
    if (hasResult) {
      parts.push(encodeMessage(2, encodeShellResult(text, ok, a)));
    }
    return encodeMessage(ToolCallField.shell_tool_call, concatMessages(...parts));
  };

  switch (name) {
    case "Shell":
      return withResultShell(
        encodeShellArgs({
          command: String(a.command || ""),
          workingDirectory: String(a.working_directory || a.workingDirectory || ""),
          timeout: Number(a.block_until_ms || a.timeout || 30000),
          toolCallId,
          description: String(a.description || ""),
          isBackground: Number(a.block_until_ms) === 0,
        }),
      );
    case "Read": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.path || "")),
        a.offset != null ? encodeInt32(2, Number(a.offset)) : Buffer.alloc(0),
        a.limit != null ? encodeInt32(3, Number(a.limit)) : Buffer.alloc(0),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(
          encodeMessage(2, encodeReadToolResult(text, ok, String(a.path || ""))),
        );
      }
      return encodeMessage(ToolCallField.read_tool_call, concatMessages(...parts));
    }
    case "Write": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.path || "")),
        encodeString(
          6,
          String(a.contents ?? a.file_text ?? a.fileText ?? a.stream_content ?? ""),
        ),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(
          encodeMessage(2, encodeEditToolResult(text, ok, String(a.path || ""))),
        );
      }
      return encodeMessage(ToolCallField.edit_tool_call, concatMessages(...parts));
    }
    case "Delete": {
      const argsMsg = encodeDeleteArgs({
        path: String(a.path || ""),
        toolCallId,
      });
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(
          encodeMessage(2, encodeDeleteResult(text, ok, String(a.path || ""))),
        );
      }
      return encodeMessage(ToolCallField.delete_tool_call, concatMessages(...parts));
    }
    case "Ls": {
      const argsMsg = encodeLsArgs({
        path: String(a.path || "."),
        toolCallId,
      });
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(
          encodeMessage(2, encodeLsResult(text, ok, String(a.path || "."))),
        );
      }
      return encodeMessage(ToolCallField.ls_tool_call, concatMessages(...parts));
    }
    case "Grep":
    case "Glob": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.pattern || a.glob_pattern || "")),
        encodeString(2, String(a.path || a.target_directory || "")),
        encodeString(3, toolCallId),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeGrepResult(text, ok, a)));
      }
      return encodeMessage(ToolCallField.grep_tool_call, concatMessages(...parts));
    }
    case "WebFetch": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.url || "")),
        encodeString(2, toolCallId),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(
          encodeMessage(
            2,
            encodeWebFetchToolResult(text, ok, String(a.url || "")),
          ),
        );
      }
      return encodeMessage(ToolCallField.web_fetch_tool_call, concatMessages(...parts));
    }
    case "AwaitShell": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.shell_id || a.task_id || a.taskId || "")),
        a.block_until_ms != null
          ? encodeUint32(2, Number(a.block_until_ms))
          : Buffer.alloc(0),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeAwaitToolResult(text, ok, a)));
      }
      return encodeMessage(ToolCallField.await_tool_call, concatMessages(...parts));
    }
    case "AskQuestion": {
      const questions = Array.isArray(a.questions) ? a.questions : [];
      const qParts: Buffer[] = [];
      for (const q of questions) {
        if (!q || typeof q !== "object") continue;
        const qq = q as Record<string, unknown>;
        const optsArr = Array.isArray(qq.options) ? qq.options : [];
        const optMsgs = optsArr.map((o) => {
          const oo = (o || {}) as Record<string, unknown>;
          return concatMessages(
            encodeString(1, String(oo.id || "")),
            encodeString(2, String(oo.label || "")),
          );
        });
        const qMsg = concatMessages(
          encodeString(1, String(qq.id || "")),
          encodeString(2, String(qq.prompt || "")),
          ...optMsgs.map((m) => encodeMessage(3, m)),
          qq.allow_multiple || qq.allowMultiple
            ? encodeUint32(4, 1)
            : Buffer.alloc(0),
        );
        qParts.push(encodeMessage(2, qMsg));
      }
      const argsMsg = concatMessages(
        encodeString(1, String(a.title || "")),
        ...qParts,
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeAskQuestionToolResult(text, ok)));
      }
      return encodeMessage(
        ToolCallField.ask_question_tool_call,
        concatMessages(...parts),
      );
    }
    case "CallMcpTool": {
      const server = String(a.server || "");
      const toolName = String(a.toolName || a.tool_name || "");
      const lookup = server && toolName ? `${server}/${toolName}` : toolName || server;
      const argObj =
        a.arguments && typeof a.arguments === "object" && !Array.isArray(a.arguments)
          ? (a.arguments as Record<string, unknown>)
          : a.args && typeof a.args === "object" && !Array.isArray(a.args)
            ? (a.args as Record<string, unknown>)
            : {};
      const argsMsg = concatMessages(
        encodeString(1, lookup),
        encodeStringValueMap(2, argObj),
        encodeString(3, toolCallId),
        encodeString(4, server),
        encodeString(5, toolName),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeMcpToolResult(text, ok)));
      }
      return encodeMessage(ToolCallField.mcp_tool_call, concatMessages(...parts));
    }
    case "Task": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.description || "")),
        encodeString(2, String(a.prompt || "")),
        encodeString(3, String(a.subagent_type || a.subagentType || "")),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeTaskResult(text, ok)));
      }
      return encodeMessage(ToolCallField.task_tool_call, concatMessages(...parts));
    }
    case "SwitchMode": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.target_mode_id || a.targetModeId || "")),
        encodeString(2, String(a.explanation || "")),
        encodeString(3, toolCallId),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeSwitchModeToolResult(text, ok, a)));
      }
      return encodeMessage(
        ToolCallField.switch_mode_tool_call,
        concatMessages(...parts),
      );
    }
    case "CreatePlan": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.plan || "")),
        encodeString(3, String(a.overview || "")),
        encodeString(4, String(a.name || "")),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeCreatePlanToolResult(text, ok)));
      }
      return encodeMessage(
        ToolCallField.create_plan_tool_call,
        concatMessages(...parts),
      );
    }
    case "WebSearch": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.search_term || a.searchTerm || a.query || "")),
        encodeString(2, toolCallId),
      );
      const parts = [encodeMessage(1, argsMsg)];
      if (hasResult) {
        parts.push(encodeMessage(2, encodeWebSearchToolResult(text, ok)));
      }
      return encodeMessage(ToolCallField.web_search_tool_call, concatMessages(...parts));
    }
    default: {
      const summary = `${name} ${JSON.stringify(a).slice(0, 400)}`;
      return withResultShell(
        encodeShellArgs({
          command: summary,
          toolCallId,
          description: name,
        }),
      );
    }
  }
}

export function encodeToolCallStarted(opts: {
  callId: string;
  name: string;
  args?: Record<string, unknown>;
  modelCallId?: string;
}): Buffer {
  const toolCall = encodeToolCallMessage({
    name: opts.name,
    args: opts.args,
  });
  const body = concatMessages(
    encodeString(1, opts.callId),
    encodeMessage(2, toolCall),
    encodeString(3, opts.modelCallId || opts.callId),
  );
  return wrapInteraction(InteractionField.tool_call_started, body);
}

export function encodeToolCallCompleted(opts: {
  callId: string;
  name: string;
  result: string;
  ok: boolean;
  args?: Record<string, unknown>;
  modelCallId?: string;
}): Buffer {
  const toolCall = encodeToolCallMessage({
    name: opts.name,
    args: opts.args,
    resultText: opts.result,
    ok: opts.ok,
  });
  const body = concatMessages(
    encodeString(1, opts.callId),
    encodeMessage(2, toolCall),
    encodeString(3, opts.modelCallId || opts.callId),
  );
  return wrapInteraction(InteractionField.tool_call_completed, body);
}

export type DecodedAgentServer = {
  kind:
    | "text_delta"
    | "thinking_delta"
    | "thinking_completed"
    | "tool_call_started"
    | "tool_call_completed"
    | "token_delta"
    | "heartbeat"
    | "turn_ended"
    | "conversation_checkpoint"
    | "exec_server_message"
    | "unknown";
  text?: string;
  callId?: string;
  modelCallId?: string;
  durationMs?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usedTokens?: number;
  maxTokens?: number;
  execId?: string;
  messageId?: number;
  interactionField?: number;
  /** ToolCall oneof 字段 + result oneof 摘要 */
  toolCall?: {
    toolField?: number;
    hasResult?: boolean;
    resultOk?: boolean;
    resultText?: string;
  };
  /** ExecServerMessage.mcp_args 解码结果（含 map args） */
  mcpArgs?: {
    name?: string;
    args: Record<string, unknown>;
    toolCallId?: string;
    providerIdentifier?: string;
    toolName?: string;
  };
};

/** 解码 AgentServerMessage（下行冒烟/调试） */
export function decodeAgentServerMessage(buf: Buffer): DecodedAgentServer {
  if (!buf?.length) return { kind: "unknown" };
  try {
    const top = decodeFields(buf);
    const interaction = firstBytes(top, 1);
    if (interaction) {
      const fields = decodeFields(interaction);
      // 找第一个 length-delimited oneof
      for (const f of fields) {
        if (f.wire !== 2 || !f.bytes) continue;
        const body = f.bytes;
        const bf = decodeFields(body);
        switch (f.field) {
          case InteractionField.text_delta:
            return { kind: "text_delta", text: firstString(bf, 1), interactionField: f.field };
          case InteractionField.thinking_delta:
            return {
              kind: "thinking_delta",
              text: firstString(bf, 1),
              interactionField: f.field,
            };
          case InteractionField.thinking_completed:
            return {
              kind: "thinking_completed",
              durationMs: firstVarint(bf, 1),
              interactionField: f.field,
            };
          case InteractionField.tool_call_started:
            return {
              kind: "tool_call_started",
              callId: firstString(bf, 1),
              modelCallId: firstString(bf, 3),
              interactionField: f.field,
              toolCall: peekToolCall(firstBytes(bf, 2)),
            };
          case InteractionField.tool_call_completed:
            return {
              kind: "tool_call_completed",
              callId: firstString(bf, 1),
              modelCallId: firstString(bf, 3),
              text: collectStrings(body, 8).join("\n").slice(0, 500),
              interactionField: f.field,
              toolCall: peekToolCall(firstBytes(bf, 2)),
            };
          case InteractionField.token_delta:
            return {
              kind: "token_delta",
              tokens: firstVarint(bf, 1),
              interactionField: f.field,
            };
          case InteractionField.heartbeat:
            return { kind: "heartbeat", interactionField: f.field };
          case InteractionField.turn_ended:
            return {
              kind: "turn_ended",
              inputTokens: firstVarint(bf, 1),
              outputTokens: firstVarint(bf, 2),
              cacheReadTokens: firstVarint(bf, 3),
              cacheWriteTokens: firstVarint(bf, 4),
              interactionField: f.field,
            };
          default:
            return { kind: "unknown", interactionField: f.field };
        }
      }
      return { kind: "unknown" };
    }
    const exec = firstBytes(top, 2);
    if (exec) {
      const ef = decodeFields(exec);
      // mcp_args = 11
      const mcpBuf = firstBytes(ef, 11);
      return {
        kind: "exec_server_message",
        messageId: firstVarint(ef, 1),
        execId: firstString(ef, 15),
        mcpArgs: mcpBuf ? decodeMcpArgs(mcpBuf) : undefined,
      };
    }
    const checkpoint = firstBytes(top, 3);
    if (checkpoint) {
      const checkpointFields = decodeFields(checkpoint);
      const tokenDetails = firstBytes(checkpointFields, 5);
      const tokenFields = tokenDetails ? decodeFields(tokenDetails) : [];
      return {
        kind: "conversation_checkpoint",
        usedTokens: firstVarint(tokenFields, 1),
        maxTokens: firstVarint(tokenFields, 2),
      };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/** JSON 形态（protojson camelCase）对齐 ExecServerMessage */
export function buildExecServerMessageJson(opts: {
  messageId: number;
  execId: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const a = opts.args || {};
  const toolCallId = opts.toolCallId;
  const base = {
    id: opts.messageId,
    execId: opts.execId,
  };

  switch (opts.toolName) {
    case "Read":
      return {
        execServerMessage: {
          ...base,
          readArgs: {
            path: String(a.path || ""),
            toolCallId,
            offset: a.offset != null ? Number(a.offset) : undefined,
            limit: a.limit != null ? Number(a.limit) : undefined,
          },
        },
      };
    case "Write":
      return {
        execServerMessage: {
          ...base,
          writeArgs: {
            path: String(a.path || ""),
            fileText: String(a.contents ?? a.file_text ?? a.fileText ?? ""),
            toolCallId,
          },
        },
      };
    case "Delete":
      return {
        execServerMessage: {
          ...base,
          deleteArgs: {
            path: String(a.path || ""),
            toolCallId,
          },
        },
      };
    case "Ls":
      return {
        execServerMessage: {
          ...base,
          lsArgs: {
            path: String(a.path || "."),
            toolCallId,
          },
        },
      };
    case "Shell":
      return {
        execServerMessage: {
          ...base,
          shellStreamArgs: {
            command: String(a.command || ""),
            workingDirectory: String(
              a.working_directory || a.workingDirectory || "",
            ),
            timeout: Number(a.block_until_ms || a.timeout || 30000),
            toolCallId,
            description: String(a.description || ""),
            isBackground: Number(a.block_until_ms) === 0,
          },
        },
      };
    case "WebFetch":
      return {
        execServerMessage: {
          ...base,
          fetchArgs: {
            url: String(a.url || ""),
            toolCallId,
          },
        },
      };
    case "Grep":
      return {
        execServerMessage: {
          ...base,
          grepArgs: {
            pattern: String(a.pattern || ""),
            path: String(a.path || ""),
            toolCallId,
            caseInsensitive: Boolean(a.case_insensitive || a.caseInsensitive),
            headLimit: a.head_limit != null ? Number(a.head_limit) : undefined,
          },
        },
      };
    case "CallMcpTool": {
      const server = String(a.server || a.providerIdentifier || "");
      const toolName = String(a.toolName || a.tool_name || "");
      const lookup =
        server && toolName ? `${server}/${toolName}` : toolName || server;
      return {
        execServerMessage: {
          ...base,
          mcpArgs: {
            name: lookup,
            toolCallId,
            providerIdentifier: server,
            toolName,
            // map 字段在 JSON 用普通 object 近似
            args:
              a.arguments && typeof a.arguments === "object"
                ? a.arguments
                : {},
          },
        },
      };
    }
    case "Task":
      return {
        execServerMessage: {
          ...base,
          subagentArgs: {
            description: String(a.description || ""),
            prompt: String(a.prompt || ""),
            subagentType: String(a.subagent_type || a.subagentType || "explore"),
            model: a.model != null ? String(a.model) : undefined,
            resume: a.resume != null ? String(a.resume) : undefined,
            toolCallId,
            attachments: Array.isArray(a.attachments) ? a.attachments : undefined,
          },
        },
      };
    case "ListMcpResources":
      return {
        execServerMessage: {
          ...base,
          listMcpResourcesExecArgs: {
            server: String(a.server || ""),
          },
        },
      };
    case "FetchMcpResource":
      return {
        execServerMessage: {
          ...base,
          readMcpResourceExecArgs: {
            server: String(a.server || ""),
            uri: String(a.uri || ""),
            toolCallId,
          },
        },
      };
    default:
      return {
        execServerMessage: {
          ...base,
          // 非标准扩展：保留工具名，便于调试客户端
          toolName: opts.toolName,
          args: a,
          toolCallId,
        },
      };
  }
}

/** InteractionQuery oneof 字段号 */
export const InteractionQueryField = {
  web_search_request_query: 2,
  ask_question_interaction_query: 3,
  switch_mode_request_query: 4,
  create_plan_request_query: 7,
  web_fetch_request_query: 9,
} as const;

/** JSON 形态 InteractionQuery（AgentServerMessage.interactionQuery） */
export function buildInteractionQueryJson(opts: {
  messageId: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const a = opts.args || {};
  const id = opts.messageId;
  const toolCallId = opts.toolCallId;

  switch (opts.toolName) {
    case "AskQuestion":
      return {
        interactionQuery: {
          id,
          askQuestionInteractionQuery: {
            args: {
              title: a.title != null ? String(a.title) : undefined,
              questions: Array.isArray(a.questions) ? a.questions : [],
            },
            toolCallId,
          },
        },
      };
    case "SwitchMode":
      return {
        interactionQuery: {
          id,
          switchModeRequestQuery: {
            args: {
              targetModeId: String(a.target_mode_id || a.targetModeId || ""),
              explanation:
                a.explanation != null ? String(a.explanation) : undefined,
              toolCallId,
            },
          },
        },
      };
    case "CreatePlan":
      return {
        interactionQuery: {
          id,
          createPlanRequestQuery: {
            args: {
              plan: String(a.plan || ""),
              overview: a.overview != null ? String(a.overview) : undefined,
              name: a.name != null ? String(a.name) : undefined,
              isProject: Boolean(a.is_project || a.isProject),
              todos: Array.isArray(a.todos) ? a.todos : undefined,
            },
            toolCallId,
          },
        },
      };
    case "WebSearch":
      return {
        interactionQuery: {
          id,
          webSearchRequestQuery: {
            args: {
              searchTerm: String(
                a.search_term || a.searchTerm || a.query || "",
              ),
              toolCallId,
            },
          },
        },
      };
    default:
      return {
        interactionQuery: {
          id,
          toolName: opts.toolName,
          toolCallId,
          args: a,
        },
      };
  }
}

/** 编码 AgentServerMessage { interaction_query = 7 } */
export function encodeAgentServerInteractionQuery(opts: {
  messageId: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Buffer {
  const a = opts.args || {};
  let queryField = 0;
  let queryBody: Buffer = Buffer.alloc(0);

  switch (opts.toolName) {
    case "AskQuestion": {
      const questions = Array.isArray(a.questions) ? a.questions : [];
      const qParts: Buffer[] = [];
      for (const q of questions) {
        if (!q || typeof q !== "object") continue;
        const qq = q as Record<string, unknown>;
        const optsArr = Array.isArray(qq.options) ? qq.options : [];
        const optMsgs = optsArr.map((o) => {
          const oo = (o || {}) as Record<string, unknown>;
          return concatMessages(
            encodeString(1, String(oo.id || "")),
            encodeString(2, String(oo.label || "")),
          );
        });
        qParts.push(
          encodeMessage(
            2,
            concatMessages(
              encodeString(1, String(qq.id || "")),
              encodeString(2, String(qq.prompt || "")),
              ...optMsgs.map((m) => encodeMessage(3, m)),
              qq.allow_multiple || qq.allowMultiple
                ? encodeUint32(4, 1)
                : Buffer.alloc(0),
            ),
          ),
        );
      }
      const argsMsg = concatMessages(
        encodeString(1, String(a.title || "")),
        ...qParts,
      );
      queryField = InteractionQueryField.ask_question_interaction_query;
      queryBody = Buffer.from(
        concatMessages(
          encodeMessage(1, argsMsg),
          encodeString(2, opts.toolCallId),
        ),
      );
      break;
    }
    case "SwitchMode": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.target_mode_id || a.targetModeId || "")),
        encodeString(2, String(a.explanation || "")),
        encodeString(3, opts.toolCallId),
      );
      queryField = InteractionQueryField.switch_mode_request_query;
      queryBody = Buffer.from(encodeMessage(1, argsMsg));
      break;
    }
    case "CreatePlan": {
      const argsMsg = concatMessages(
        encodeString(1, String(a.plan || "")),
        encodeString(3, String(a.overview || "")),
        encodeString(4, String(a.name || "")),
      );
      queryField = InteractionQueryField.create_plan_request_query;
      queryBody = Buffer.from(
        concatMessages(
          encodeMessage(1, argsMsg),
          encodeString(2, opts.toolCallId),
        ),
      );
      break;
    }
    case "WebSearch": {
      const argsMsg = concatMessages(
        encodeString(
          1,
          String(a.search_term || a.searchTerm || a.query || ""),
        ),
        encodeString(2, opts.toolCallId),
      );
      queryField = InteractionQueryField.web_search_request_query;
      // WebSearchRequestQuery { args = 1 }
      queryBody = Buffer.from(encodeMessage(1, argsMsg));
      break;
    }
    default: {
      // 回落 AskQuestion 空壳，避免 0 字段
      queryField = InteractionQueryField.ask_question_interaction_query;
      queryBody = Buffer.from(
        concatMessages(
          encodeMessage(1, encodeString(1, opts.toolName)),
          encodeString(2, opts.toolCallId),
        ),
      );
    }
  }

  const interactionQuery = concatMessages(
    encodeVarintFieldForce(1, opts.messageId),
    encodeMessage(queryField, queryBody),
  );
  // AgentServerMessage.interaction_query = 7
  return encodeMessage(7, interactionQuery);
}
