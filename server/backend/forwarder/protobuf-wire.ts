/**
 * 精简 protobuf wire 编解码（不依赖 protoc / 生成代码）。
 * 覆盖 varint / length-delimited / 64-bit / 32-bit，足够 Agent 主链路。
 */

export type WireType = 0 | 1 | 2 | 5;

export type PbField = {
  field: number;
  wire: WireType;
  /** wire0 */ varint?: bigint;
  /** wire1 */ fixed64?: Buffer;
  /** wire2 */ bytes?: Buffer;
  /** wire5 */ fixed32?: number;
};

export function encodeVarint(value: number | bigint): Buffer {
  let n = typeof value === "bigint" ? value : BigInt(value >>> 0);
  if (typeof value === "number" && value < 0) {
    // 负 int32 按 64-bit zigzag 不在此处理；调用方应传 unsigned
    n = BigInt(value);
  }
  const out: number[] = [];
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

export function decodeVarint(
  buf: Buffer,
  offset = 0,
): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, next: pos };
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

export function encodeKey(field: number, wire: WireType): Buffer {
  return encodeVarint((field << 3) | wire);
}

export function encodeString(field: number, value: string): Buffer {
  if (value == null || value === "") return Buffer.alloc(0);
  const data = Buffer.from(value, "utf8");
  return Buffer.from(
    Buffer.concat([encodeKey(field, 2), encodeVarint(data.length), data]),
  );
}

export function encodeBytes(field: number, value: Buffer): Buffer {
  if (!value || !value.length) return Buffer.alloc(0);
  return Buffer.from(
    Buffer.concat([
      encodeKey(field, 2),
      encodeVarint(value.length),
      value,
    ]),
  );
}

export function encodeMessage(field: number, message: Buffer): Buffer {
  if (!message.length) {
    // 空 message 仍可编码
    return Buffer.concat([encodeKey(field, 2), encodeVarint(0)]);
  }
  return encodeBytes(field, message);
}

export function encodeVarintField(field: number, value: number | bigint): Buffer {
  if (value === 0 || value === 0n) return Buffer.alloc(0); // proto3 default skip
  return Buffer.from(
    Buffer.concat([encodeKey(field, 0), encodeVarint(value)]),
  );
}

/** 强制写入 varint（含 0），用于 id 等需要出现的字段 */
export function encodeVarintFieldForce(
  field: number,
  value: number | bigint,
): Buffer {
  return Buffer.from(
    Buffer.concat([encodeKey(field, 0), encodeVarint(value)]),
  );
}

export function encodeBool(field: number, value: boolean): Buffer {
  if (!value) return Buffer.alloc(0);
  return encodeVarintField(field, 1);
}

export function encodeUint32(field: number, value: number): Buffer {
  return encodeVarintField(field, value >>> 0);
}

export function encodeInt32(field: number, value: number): Buffer {
  if (!value) return Buffer.alloc(0);
  return encodeVarintField(field, value);
}

/** int64 / uint64（非负 token 计数）；默认 0 省略 */
export function encodeInt64(field: number, value: number | bigint): Buffer {
  const n = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (n === 0n) return Buffer.alloc(0);
  return encodeInt64Force(field, n);
}

/** 强制写 int64（含 0），TurnEnded 等 optional 统计字段用 */
export function encodeInt64Force(field: number, value: number | bigint): Buffer {
  let n = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (n < 0n) n = (1n << 64n) + n; // 有符号补码（本链路 token 一般为非负）
  const out: number[] = [];
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(Buffer.concat([encodeKey(field, 0), Buffer.from(out)]));
}

/** IEEE754 double，wire type 1 */
export function encodeDouble(field: number, value: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeDoubleLE(value, 0);
  return Buffer.from(Buffer.concat([encodeKey(field, 1), body]));
}

/**
 * google.protobuf.Value
 * 1 null_value | 2 number_value | 3 string_value | 4 bool_value | 5 struct | 6 list
 */
export function encodeProtoValue(value: unknown): Buffer {
  if (value === null || value === undefined) {
    return encodeVarintFieldForce(1, 0); // NullValue.NULL_VALUE
  }
  if (typeof value === "boolean") {
    return encodeVarintFieldForce(4, value ? 1 : 0);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return encodeDouble(2, value);
  }
  if (typeof value === "string") {
    return encodeString(3, value);
  }
  if (Array.isArray(value)) {
    // ListValue { repeated Value values = 1 }
    const items = value.map((v) => encodeMessage(1, encodeProtoValue(v)));
    return encodeMessage(6, concatMessages(...items));
  }
  if (typeof value === "object") {
    // Struct { map<string, Value> fields = 1 }
    return encodeMessage(5, encodeStringValueMap(1, value as Record<string, unknown>));
  }
  return encodeString(3, String(value));
}

/**
 * map<string, google.protobuf.Value>：每个 entry 为 message{ key=1, value=2 }
 * 写入 map 字段号 field。
 */
export function encodeStringValueMap(
  field: number,
  obj: Record<string, unknown> | null | undefined,
): Buffer {
  if (!obj || typeof obj !== "object") return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const entry = concatMessages(
      encodeString(1, k),
      encodeMessage(2, encodeProtoValue(v)),
    );
    parts.push(encodeMessage(field, entry));
  }
  return concatMessages(...parts);
}

/** 解码 map<string, Value> 字段（尽力还原 JSON） */
export function decodeStringValueMap(
  fields: PbField[],
  field: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.field !== field || f.wire !== 2 || !f.bytes) continue;
    const entry = decodeFields(f.bytes);
    const key = firstString(entry, 1);
    if (!key) continue;
    const valBuf = firstBytes(entry, 2);
    out[key] = valBuf ? decodeProtoValue(valBuf) : null;
  }
  return out;
}

export function decodeProtoValue(buf: Buffer): unknown {
  if (!buf?.length) return null;
  try {
    const fields = decodeFields(buf);
    // null_value = 1
    if (fields.some((f) => f.field === 1 && f.wire === 0)) return null;
    // number_value = 2 (fixed64)
    const num = fields.find((f) => f.field === 2 && f.wire === 1 && f.fixed64);
    if (num?.fixed64 && num.fixed64.length >= 8) {
      return num.fixed64.readDoubleLE(0);
    }
    // string_value = 3
    const s = firstString(fields, 3);
    if (s != null) return s;
    // bool_value = 4
    const b = firstVarint(fields, 4);
    if (b != null) return b !== 0;
    // struct_value = 5
    const st = firstBytes(fields, 5);
    if (st) {
      const sf = decodeFields(st);
      return decodeStringValueMap(sf, 1);
    }
    // list_value = 6
    const list = firstBytes(fields, 6);
    if (list) {
      const lf = decodeFields(list);
      return lf
        .filter((f) => f.field === 1 && f.wire === 2 && f.bytes)
        .map((f) => decodeProtoValue(f.bytes!));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function concatMessages(...parts: Buffer[]): Buffer {
  return Buffer.from(Buffer.concat(parts.filter((p) => p.length)));
}

export function decodeFields(buf: Buffer): PbField[] {
  const fields: PbField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const key = decodeVarint(buf, offset);
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n) as WireType;
    if (wire === 0) {
      const v = decodeVarint(buf, offset);
      fields.push({ field, wire, varint: v.value });
      offset = v.next;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated fixed64");
      fields.push({ field, wire, fixed64: Buffer.from(buf.subarray(offset, offset + 8)) });
      offset += 8;
    } else if (wire === 2) {
      const len = decodeVarint(buf, offset);
      offset = len.next;
      const n = Number(len.value);
      if (offset + n > buf.length) throw new Error("truncated bytes");
      fields.push({
        field,
        wire,
        bytes: Buffer.from(buf.subarray(offset, offset + n)),
      });
      offset += n;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated fixed32");
      fields.push({ field, wire, fixed32: buf.readUInt32LE(offset) });
      offset += 4;
    } else {
      // wire 3/4 group 已废弃；跳过失败
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

export function firstString(fields: PbField[], field: number): string | undefined {
  const f = fields.find((x) => x.field === field && x.wire === 2 && x.bytes);
  return f?.bytes ? f.bytes.toString("utf8") : undefined;
}

export function firstBytes(fields: PbField[], field: number): Buffer | undefined {
  return fields.find((x) => x.field === field && x.wire === 2)?.bytes;
}

export function firstVarint(fields: PbField[], field: number): number | undefined {
  const f = fields.find((x) => x.field === field && x.wire === 0 && fVar(x));
  return f?.varint != null ? Number(f.varint) : undefined;
}

function fVar(x: PbField): boolean {
  return x.varint != null;
}

/** 递归收集 message 内所有 utf8 字符串（调试/结果摘要） */
export function collectStrings(buf: Buffer, max = 32): string[] {
  const out: string[] = [];
  try {
    walk(buf, out, max, 0);
  } catch {
    /* partial */
  }
  return out;
}

function walk(buf: Buffer, out: string[], max: number, depth: number) {
  if (depth > 6 || out.length >= max) return;
  for (const f of decodeFields(buf)) {
    if (out.length >= max) return;
    if (f.wire === 2 && f.bytes) {
      const s = f.bytes.toString("utf8");
      if (isPrintable(s) && s.trim().length >= 1) out.push(s);
      else if (f.bytes.length > 2) walk(f.bytes, out, max, depth + 1);
    }
  }
}

function isPrintable(s: string): boolean {
  if (!s || s.length > 20000) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) bad++;
  }
  return bad / Math.max(1, s.length) < 0.05;
}