import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";

/**
 * Connect 协议 envelope（gRPC-Web / Connect unary/stream 帧）。
 * 帧格式：1 byte flags + 4 byte big-endian length + payload
 * flags bit0 marks a compressed payload; unwrapRequestBody decodes it with
 * Connect-Content-Encoding before protocol parsing.
 */
export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

const MAX_CONNECT_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type ConnectFrame = {
  flags: number;
  payload: Buffer;
  compressed: boolean;
  endStream: boolean;
};

export function encodeConnectFrame(
  payload: Buffer | string,
  flags = 0,
): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = Buffer.alloc(5);
  header.writeUInt8(flags & 0xff, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodeConnectJson(obj: unknown, flags = 0): Buffer {
  return encodeConnectFrame(JSON.stringify(obj), flags);
}

/** 解析单帧；不足一帧返回 null */
export function decodeConnectFrame(buf: Buffer): ConnectFrame | null {
  if (!buf || buf.length < 5) return null;
  const flags = buf.readUInt8(0);
  const len = buf.readUInt32BE(1);
  if (buf.length < 5 + len) return null;
  const payload = buf.subarray(5, 5 + len);
  return {
    flags,
    payload: Buffer.from(payload),
    compressed: (flags & CONNECT_FLAG_COMPRESSED) !== 0,
    endStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
  };
}

/** 连续拆多帧（SSE/stream 调试用） */
export function decodeConnectFrames(buf: Buffer): {
  frames: ConnectFrame[];
  rest: Buffer;
} {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(offset + 5, offset + 5 + len));
    frames.push({
      flags,
      payload,
      compressed: (flags & CONNECT_FLAG_COMPRESSED) !== 0,
      endStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
    });
    offset += 5 + len;
  }
  return { frames, rest: Buffer.from(buf.subarray(offset)) };
}

/**
 * 若 body 是 Connect envelope，解出 payload；否则原样返回。
 * 用于 BidiAppend / unary 请求兼容「裸 JSON」与「Connect 帧包 JSON/二进制」。
 */
function decodeCompressedPayload(
  payload: Buffer,
  contentEncoding: string | string[] | undefined,
): Buffer {
  const encoding = (Array.isArray(contentEncoding)
    ? contentEncoding[0]
    : contentEncoding || "")
    .trim()
    .toLowerCase();
  const options = { maxOutputLength: MAX_CONNECT_PAYLOAD_BYTES };
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(payload, options);
    case "deflate":
      return inflateSync(payload, options);
    case "br":
      return brotliDecompressSync(payload, options);
    default:
      throw new Error(
        `compressed Connect frame is missing a supported connect-content-encoding: ${encoding || "none"}`,
      );
  }
}

export function unwrapRequestBody(
  buf: Buffer,
  connectContentEncoding?: string | string[],
): Buffer {
  if (!buf || buf.length < 5) return buf;
  // 启发式：flags 仅低 2 位有意义，且 length 合理
  const flags = buf[0];
  if (flags > 0x03) return buf;
  const len = buf.readUInt32BE(1);
  if (len <= 0 || len > 16 * 1024 * 1024) return buf;
  if (buf.length === 5 + len) {
    const payload = Buffer.from(buf.subarray(5));
    return (flags & CONNECT_FLAG_COMPRESSED) !== 0
      ? decodeCompressedPayload(payload, connectContentEncoding)
      : payload;
  }
  // 多帧：拼第一帧 payload（unary 常见单帧）
  const frame = decodeConnectFrame(buf);
  if (frame) {
    return frame.compressed
      ? decodeCompressedPayload(frame.payload, connectContentEncoding)
      : frame.payload;
  }
  return buf;
}

export function tryParseJson(buf: Buffer): Record<string, unknown> | null {
  try {
    const t = buf.toString("utf8").trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    const v = JSON.parse(t);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return null;
}
