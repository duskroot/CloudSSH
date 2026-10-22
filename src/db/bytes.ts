export function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

export function readU16be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

export function readI32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

export function i32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

export function i64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

export class Cursor {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  rest(): number {
    return this.bytes.length - this.offset;
  }

  u8(): number {
    return this.bytes[this.offset++];
  }

  i32be(): number {
    const value = readU32be(this.bytes, this.offset);
    this.offset += 4;
    return value;
  }

  i16be(): number {
    const value = readU16be(this.bytes, this.offset);
    this.offset += 2;
    return value;
  }

  take(length: number): Uint8Array {
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  cstring(): string {
    const start = this.offset;
    while (this.bytes[this.offset] !== 0) this.offset += 1;
    const value = text(this.bytes.subarray(start, this.offset));
    this.offset += 1;
    return value;
  }
}

export function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomNonce(bytes = 18): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return bytesBase64(raw);
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
