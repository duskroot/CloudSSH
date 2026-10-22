import { concat, utf8 } from './bytes';

export type MysqlRsaPadding = 'pkcs1' | 'oaep';

/** XOR the password, keep an unscrambled trailing NUL, then RSA-encrypt for caching_sha2. */
export async function encryptMysqlPassword(
  password: string,
  seed: Uint8Array,
  pem: string,
  padding: MysqlRsaPadding
): Promise<Uint8Array> {
  const message = concat([utf8(password), Uint8Array.of(0)]);
  const scramble = seed.subarray(0, 20);
  for (let i = 0; i < message.length; i++) message[i] ^= scramble[i % scramble.length];
  const spki = spkiBytes(pem);
  if (padding === 'oaep') {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, message));
  }
  const { modulus, exponent } = readRsaPublicKey(spki);
  return rsaPkcs1Encrypt(message, modulus, exponent);
}

function spkiBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function readRsaPublicKey(spki: Uint8Array): { modulus: bigint; exponent: bigint } {
  const outer = new Der(spki);
  const body = new Der(outer.sequence());
  body.sequence();
  const rsa = new Der(new Der(body.bitString()).sequence());
  return { modulus: rsa.unsignedInteger(), exponent: rsa.unsignedInteger() };
}

function rsaPkcs1Encrypt(message: Uint8Array, modulus: bigint, exponent: bigint): Uint8Array {
  const keyLength = Math.ceil(modulus.toString(16).length / 2);
  if (message.length > keyLength - 11) throw new Error('MySQL 密码加密失败');
  const encoded = new Uint8Array(keyLength);
  encoded[0] = 0x00;
  encoded[1] = 0x02;
  const paddingLength = keyLength - message.length - 3;
  const padding = new Uint8Array(paddingLength);
  crypto.getRandomValues(padding);
  for (let i = 0; i < padding.length; i++) {
    while (padding[i] === 0) {
      const next = new Uint8Array(1);
      crypto.getRandomValues(next);
      padding[i] = next[0];
    }
  }
  encoded.set(padding, 2);
  encoded[2 + paddingLength] = 0x00;
  encoded.set(message, 3 + paddingLength);
  return bigintBytes(modPow(bytesToBigInt(encoded), exponent, modulus), keyLength);
}

class Der {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  sequence(): Uint8Array {
    this.expect(0x30);
    return this.take(this.length());
  }

  bitString(): Uint8Array {
    this.expect(0x03);
    return this.take(this.length()).subarray(1);
  }

  unsignedInteger(): bigint {
    this.expect(0x02);
    const bytes = this.take(this.length());
    return bytesToBigInt(bytes[0] === 0 ? bytes.subarray(1) : bytes);
  }

  private expect(tag: number): void {
    if (this.bytes[this.offset++] !== tag) throw new Error('MySQL 公钥格式不正确');
  }

  private length(): number {
    const first = this.bytes[this.offset++];
    if (first < 0x80) return first;
    const count = first & 0x7f;
    let size = 0;
    for (let i = 0; i < count; i++) size = (size << 8) | this.bytes[this.offset++];
    return size;
  }

  private take(length: number): Uint8Array {
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigintBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let current = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    exp >>= 1n;
  }
  return result;
}
