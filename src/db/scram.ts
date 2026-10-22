import { base64Bytes, bytesBase64, concat, utf8 } from './bytes';

export type ScramHash = 'SHA-1' | 'SHA-256';

export async function scramClientFinal(options: {
  hash: ScramHash;
  password: string;
  clientFirstBare: string;
  serverFirst: string;
}): Promise<{ clientFinal: string; serverSignature: string }> {
  const fields = parseFields(options.serverFirst);
  const nonce = fields.r;
  const salt = base64Bytes(fields.s);
  const iterations = Number(fields.i);
  if (!nonce || !fields.s || !Number.isInteger(iterations) || iterations < 1) {
    throw new Error('数据库认证参数不完整');
  }
  const clientFinalWithoutProof = `c=biws,r=${nonce}`;
  const authMessage = `${options.clientFirstBare},${options.serverFirst},${clientFinalWithoutProof}`;
  const salted = await pbkdf2(options.hash, options.password, salt, iterations);
  const clientKey = await hmac(options.hash, salted, utf8('Client Key'));
  const storedKey = new Uint8Array(await crypto.subtle.digest(options.hash, clientKey));
  const clientSignature = await hmac(options.hash, storedKey, utf8(authMessage));
  const proof = xor(clientKey, clientSignature);
  const serverKey = await hmac(options.hash, salted, utf8('Server Key'));
  const serverSignature = await hmac(options.hash, serverKey, utf8(authMessage));
  return {
    clientFinal: `${clientFinalWithoutProof},p=${bytesBase64(proof)}`,
    serverSignature: bytesBase64(serverSignature),
  };
}

export function verifyServerFinal(serverFinal: string, expectedSignature: string): void {
  const signature = parseFields(serverFinal).v;
  if (!signature || signature !== expectedSignature) throw new Error('数据库认证失败');
}

function parseFields(message: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of message.split(',')) {
    const split = part.indexOf('=');
    if (split > 0) fields[part.slice(0, split)] = part.slice(split + 1);
  }
  return fields;
}

async function pbkdf2(hash: ScramHash, password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash, salt: salt as BufferSource, iterations },
    key,
    hash === 'SHA-1' ? 160 : 256
  );
  return new Uint8Array(bits);
}

async function hmac(hash: ScramHash, keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = left[i] ^ right[i];
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  return concat(parts);
}
