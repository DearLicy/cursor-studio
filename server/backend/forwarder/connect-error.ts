/**
 * Cursor renders RunSSE failures from the Connect end-stream trailer. A bare
 * Connect error is enough for generic clients, but Cursor also looks for its
 * aiserver.v1.ErrorDetails payload to select the native error treatment.
 */
import {
  concatMessages,
  encodeMessage,
  encodeString,
  encodeVarintFieldForce,
} from "./protobuf-wire";

export type ConnectTerminalErrorInput = {
  code?: string;
  message?: string;
  status?: number;
};

export type CursorTerminalError = {
  connectCode: string;
  message: string;
  title: string;
  detail: string;
  errorDetailCode: number;
  retryable: boolean;
  expected: boolean;
};

const ERROR_DETAILS_TYPE = "type.googleapis.com/aiserver.v1.ErrorDetails";

// aiserver.v1.ErrorDetails.Error from Cursor's public protocol descriptor.
const ERROR_BAD_API_KEY = 1;
const ERROR_USER_ABORTED_REQUEST = 21;
const ERROR_RATE_LIMITED = 50;
const ERROR_CONVERSATION_TOO_LONG = 43;
const ERROR_UNAUTHORIZED = 38;
const ERROR_BAD_REQUEST = 36;
const ERROR_PROVIDER_ERROR = 57;
const ERROR_INTERNAL = 59;

const MAX_DETAIL_LENGTH = 1_000;

function textOf(input: ConnectTerminalErrorInput): string {
  return `${input.code || ""}\n${input.message || ""}`.toLowerCase();
}

function normalizedMessage(input: ConnectTerminalErrorInput, fallback: string): string {
  const value = String(input.message || "").trim();
  if (!value) return fallback;
  return value
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, MAX_DETAIL_LENGTH);
}

function extractStatus(input: ConnectTerminalErrorInput): number | undefined {
  if (Number.isInteger(input.status) && input.status! >= 100 && input.status! <= 599) {
    return input.status;
  }
  const match = textOf(input).match(/\b(401|403|408|409|413|422|425|429|500|501|502|503|504|520|521|522|523|524)\b/);
  return match ? Number(match[1]) : undefined;
}

function isCancelled(text: string): boolean {
  return /\bcancel(?:led|ed)?\b|\babort(?:ed)?\b|client_cancel/.test(text);
}

function isContextLimit(text: string): boolean {
  return [
    /context(?:\s+(?:window|length))?[^\n]{0,80}(?:limit|length|long|large|exceed|overflow)/,
    /(?:maximum|max)[_\s-]*(?:context|input|token)/,
    /(?:prompt|input)[^\n]{0,80}(?:too[_\s-]?(?:long|large)|exceed|limit|length)/,
    /(?:too[_\s-]?many|exceeds?|exceeded)[^\n]{0,80}tokens?/,
    /tokens?[^\n]{0,80}(?:exceed|exceeded|limit|length|maximum|max)/,
    /\u4e0a\u4e0b\u6587[^\n]{0,24}(?:\u8d85|\u957f|\u6ee1|\u9650)/,
    /(?:\u5bf9\u8bdd|\u8f93\u5165)[^\n]{0,24}(?:\u8fc7\u957f|\u592a\u957f|\u8d85)/,
  ].some((pattern) => pattern.test(text));
}

function isRateLimited(text: string, status: number | undefined): boolean {
  return status === 429 || /rate[\s_-]*limit|too many requests|\u8bf7\u6c42[^\n]{0,16}(?:\u8f83\u591a|\u9891\u7e41|\u8fc7\u591a)|\u7a0d\u540e\u91cd\u8bd5/.test(text);
}

function isProviderFailure(text: string, status: number | undefined): boolean {
  return (
    (status != null && (status >= 500 || status === 408 || status === 425)) ||
    /\bunavailable\b|\bprovider(?:[_\s-]*error)?\b|\bnetwork\b|\btimeout\b|fetch failed|econn|enotfound|etimedout|\u670d\u52a1[^\n]{0,24}(?:\u4e0d\u53ef\u7528|\u5931\u8d25|\u6682\u65f6)/.test(text)
  );
}

/**
 * Convert an upstream/local terminal condition into the pair Cursor expects:
 * a Connect code plus an aiserver.v1.ErrorDetails enum. Callers may pass an
 * HTTP status directly, or only the existing StreamEvent code/message.
 */
export function classifyCursorTerminalError(
  input: ConnectTerminalErrorInput,
): CursorTerminalError {
  const raw = textOf(input);
  const status = extractStatus(input);

  if (isCancelled(raw)) {
    const message = normalizedMessage(input, "Request cancelled");
    return {
      connectCode: "canceled",
      message,
      title: "Request cancelled",
      detail: message,
      errorDetailCode: ERROR_USER_ABORTED_REQUEST,
      retryable: false,
      expected: true,
    };
  }

  if (String(input.code || "").toLowerCase() === "unimplemented") {
    const message = normalizedMessage(input, "This request is not supported");
    return {
      connectCode: "unimplemented",
      message,
      title: "This request is not supported",
      detail: message,
      errorDetailCode: ERROR_INTERNAL,
      retryable: false,
      expected: true,
    };
  }

  if (isContextLimit(raw)) {
    const message = normalizedMessage(input, "Conversation context is too long");
    return {
      // Cursor's own forwarder uses invalid_argument for an overflow that
      // remains after compaction, rather than rendering it as assistant text.
      connectCode: "invalid_argument",
      message,
      title: "Conversation context is too long",
      detail: message,
      errorDetailCode: ERROR_CONVERSATION_TOO_LONG,
      retryable: false,
      expected: false,
    };
  }

  if (status === 401 || /\bunauthenticated\b|bad[_\s-]*api[_\s-]*key/.test(raw)) {
    const message = normalizedMessage(input, "Provider authentication failed");
    return {
      connectCode: "unauthenticated",
      message,
      title: "Provider authentication failed",
      detail: message,
      errorDetailCode: ERROR_BAD_API_KEY,
      retryable: false,
      expected: false,
    };
  }

  if (status === 403 || /\bpermission[_\s-]*denied\b|\bforbidden\b/.test(raw)) {
    const message = normalizedMessage(input, "Provider access was denied");
    return {
      connectCode: "permission_denied",
      message,
      title: "Provider access was denied",
      detail: message,
      errorDetailCode: ERROR_UNAUTHORIZED,
      retryable: false,
      expected: false,
    };
  }

  // An explicit upstream transport status is authoritative. Messages such as
  // "please retry later" are common for both outages and throttling; treating
  // a known 5xx/408/425 as rate limiting makes Cursor render the wrong native
  // recovery action. A real 429 continues through the rate-limit branch below.
  if (status != null && (status >= 500 || status === 408 || status === 425)) {
    const message = normalizedMessage(input, "Provider is temporarily unavailable. Please retry shortly.");
    return {
      connectCode: "unavailable",
      message,
      title: "Provider is temporarily unavailable",
      detail: message,
      errorDetailCode: ERROR_PROVIDER_ERROR,
      retryable: true,
      expected: false,
    };
  }

  if (isRateLimited(raw, status)) {
    const message = normalizedMessage(input, "Provider is rate limited. Please retry shortly.");
    return {
      connectCode: "resource_exhausted",
      message,
      title: "Provider is rate limited",
      detail: message,
      errorDetailCode: ERROR_RATE_LIMITED,
      retryable: true,
      expected: false,
    };
  }

  if (isProviderFailure(raw, status) || raw.includes("unavailable")) {
    const message = normalizedMessage(input, "Provider is temporarily unavailable. Please retry shortly.");
    return {
      connectCode: "unavailable",
      message,
      title: "Provider is temporarily unavailable",
      detail: message,
      errorDetailCode: ERROR_PROVIDER_ERROR,
      retryable: true,
      expected: false,
    };
  }

  if (/\binvalid[_\s-]*argument\b|\bbad[_\s-]*request\b/.test(raw)) {
    const message = normalizedMessage(input, "The request could not be processed");
    return {
      connectCode: "invalid_argument",
      message,
      title: "The request could not be processed",
      detail: message,
      errorDetailCode: ERROR_BAD_REQUEST,
      retryable: false,
      expected: false,
    };
  }

  const message = normalizedMessage(input, "The request did not complete");
  return {
    connectCode: "unknown",
    message,
    title: "The request did not complete",
    detail: message,
    errorDetailCode: ERROR_INTERNAL,
    retryable: true,
    expected: false,
  };
}

/** Encode aiserver.v1.ErrorDetails without introducing a generated proto runtime. */
export function encodeCursorErrorDetails(error: CursorTerminalError): Buffer {
  const customDetails = concatMessages(
    encodeString(1, error.title),
    encodeString(2, error.detail),
    // Optional fields must be present even when false so Cursor keeps the
    // intended native-error behavior rather than applying stale defaults.
    encodeVarintFieldForce(3, 1),
    encodeVarintFieldForce(4, error.retryable ? 1 : 0),
    encodeVarintFieldForce(5, 1),
    encodeVarintFieldForce(6, 0),
  );
  return concatMessages(
    encodeVarintFieldForce(1, error.errorDetailCode),
    encodeMessage(2, customDetails),
    encodeVarintFieldForce(3, error.expected ? 1 : 0),
  );
}

/** Build the standard Connect JSON end-stream error object. */
export function buildCursorConnectErrorTrailer(
  input: ConnectTerminalErrorInput,
): Record<string, unknown> {
  const error = classifyCursorTerminalError(input);
  return {
    error: {
      code: error.connectCode,
      message: error.message,
      details: [
        {
          type: ERROR_DETAILS_TYPE,
          value: encodeCursorErrorDetails(error).toString("base64"),
        },
      ],
    },
  };
}

export { ERROR_DETAILS_TYPE };
