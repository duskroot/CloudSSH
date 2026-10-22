import { i32le, i64le, readI32le, text, utf8 } from './bytes';

export type Bson = null | boolean | number | string | Uint8Array | Bson[] | { [key: string]: Bson };

export function encodeBson(value: { [key: string]: Bson }): Uint8Array {
  const body = encodeElements(value);
  const size = 4 + body.length + 1;
  const out = new Uint8Array(size);
  out.set(i32le(size), 0);
  out.set(body, 4);
  return out;
}

export function decodeBson(bytes: Uint8Array): { [key: string]: Bson } {
  const size = readI32le(bytes, 0);
  return readDocument(bytes.subarray(0, size), 0).value;
}

function encodeElements(value: { [key: string]: Bson } | Bson[]): Uint8Array {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const parts: Uint8Array[] = [];
  for (const [key, item] of entries) parts.push(encodeElement(key, item));
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeElement(key: string, value: Bson): Uint8Array {
  const name = [...utf8(key), 0];
  let type = 0x0a;
  let payload = new Uint8Array(0);
  if (value === null) {
    type = 0x0a;
  } else if (typeof value === 'boolean') {
    type = 0x08;
    payload = Uint8Array.of(value ? 1 : 0);
  } else if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      type = 0x10;
      payload = i32le(value);
    } else if (Number.isSafeInteger(value)) {
      type = 0x12;
      payload = i64le(value);
    } else {
      type = 0x01;
      payload = new Uint8Array(8);
      new DataView(payload.buffer).setFloat64(0, value, true);
    }
  } else if (typeof value === 'string') {
    type = 0x02;
    const bytes = utf8(value);
    payload = new Uint8Array(4 + bytes.length + 1);
    payload.set(i32le(bytes.length + 1), 0);
    payload.set(bytes, 4);
  } else if (value instanceof Uint8Array) {
    type = 0x05;
    payload = new Uint8Array(4 + 1 + value.length);
    payload.set(i32le(value.length), 0);
    payload.set(value, 5);
  } else if (Array.isArray(value) || typeof value === 'object') {
    type = Array.isArray(value) ? 0x04 : 0x03;
    const body = encodeElements(value);
    const size = 4 + body.length + 1;
    payload = new Uint8Array(size);
    payload.set(i32le(size), 0);
    payload.set(body, 4);
  }
  const out = new Uint8Array(1 + name.length + payload.length);
  out[0] = type;
  out.set(name, 1);
  out.set(payload, 1 + name.length);
  return out;
}

function readDocument(bytes: Uint8Array, offset: number): { value: { [key: string]: Bson }; next: number } {
  const size = readI32le(bytes, offset);
  const end = offset + size - 1;
  let cursor = offset + 4;
  const value: { [key: string]: Bson } = {};
  while (cursor < end) {
    const type = bytes[cursor++];
    const nameStart = cursor;
    while (bytes[cursor] !== 0) cursor += 1;
    const name = text(bytes.subarray(nameStart, cursor));
    cursor += 1;
    const read = readValue(type, bytes, cursor);
    value[name] = read.value;
    cursor = read.next;
  }
  return { value, next: offset + size };
}

function readValue(type: number, bytes: Uint8Array, offset: number): { value: Bson; next: number } {
  if (type === 0x01) {
    return { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, true), next: offset + 8 };
  }
  if (type === 0x02) {
    const size = readI32le(bytes, offset);
    return { value: text(bytes.subarray(offset + 4, offset + 4 + size - 1)), next: offset + 4 + size };
  }
  if (type === 0x03) {
    const doc = readDocument(bytes, offset);
    return { value: doc.value, next: doc.next };
  }
  if (type === 0x04) {
    const doc = readDocument(bytes, offset);
    const array = Object.keys(doc.value)
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => doc.value[key]);
    return { value: array, next: doc.next };
  }
  if (type === 0x05) {
    const size = readI32le(bytes, offset);
    return { value: bytes.slice(offset + 5, offset + 5 + size), next: offset + 5 + size };
  }
  if (type === 0x07) return { value: null, next: offset + 12 };
  if (type === 0x08) return { value: bytes[offset] === 1, next: offset + 1 };
  if (type === 0x09) return { value: Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true)), next: offset + 8 };
  if (type === 0x0a) return { value: null, next: offset };
  if (type === 0x0d || type === 0x0e) {
    const size = readI32le(bytes, offset);
    return { value: text(bytes.subarray(offset + 4, offset + 4 + size - 1)), next: offset + 4 + size };
  }
  if (type === 0x10) return { value: readI32le(bytes, offset), next: offset + 4 };
  if (type === 0x11) return { value: null, next: offset + 8 };
  if (type === 0x12) return { value: Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true)), next: offset + 8 };
  if (type === 0x13) return { value: null, next: offset + 16 };
  if (type === 0x7f || type === 0xff) return { value: null, next: offset };
  throw new Error(`暂不支持的 BSON 类型 ${type}`);
}
