import { dbAdminCommand, type DbAdminRequest, type DbArchiveTarget } from '../db-admin';
import { concat, text, utf8 } from './bytes';
import { encryptMysqlPassword, type MysqlRsaPadding } from './mysql-rsa';
import { TcpConn } from './tcp';

interface ByteConn {
  readExactly(length: number): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
}

const PROTOCOL_41 = 0x00000200;
const SECURE_CONNECTION = 0x00008000;
const PLUGIN_AUTH = 0x00080000;
const PLUGIN_AUTH_LENENC = 0x00200000;
const TRANSACTIONS = 0x00002000;
const CAPS = PROTOCOL_41 | SECURE_CONNECTION | PLUGIN_AUTH | PLUGIN_AUTH_LENENC | TRANSACTIONS;

export async function mysqlAdmin(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  const conn = await TcpConn.open(target.host, target.port);
  try {
    return await mysqlSession(conn, target, request, 'oaep');
  } finally {
    conn.close();
  }
}

export async function mysqlSession(
  conn: ByteConn,
  target: DbArchiveTarget,
  request: DbAdminRequest,
  padding: MysqlRsaPadding = 'oaep'
): Promise<string[]> {
  const sql = dbAdminCommand(target, request);
  const handshake = await readPacket(conn);
  const parsed = parseHandshake(handshake.payload);
  const seq = handshake.seq + 1;
  const auth = await authResponse(target.username, target.password, parsed.plugin, parsed.salt, CAPS);
  await conn.write(packet(seq, auth));
  await finishAuth(conn, target.password, parsed.salt, padding, false);
  await conn.write(packet(0, concat([Uint8Array.of(3), utf8(sql)])));
  return readResult(conn);
}

async function finishAuth(
  conn: ByteConn,
  password: string,
  seed: Uint8Array,
  padding: MysqlRsaPadding,
  secure: boolean
): Promise<void> {
  let currentSeed = seed;
  while (true) {
    const next = await readPacket(conn);
    const marker = next.payload[0];
    if (marker === 0x00) return;
    if (marker === 0xff) throw new Error(mysqlError(next.payload));
    if (marker === 0xfe) {
      const cursor = next.payload.indexOf(0, 1);
      const plugin = text(next.payload.subarray(1, cursor));
      currentSeed = trimNull(next.payload.subarray(cursor + 1));
      const response = await scramble(plugin, password, currentSeed);
      await conn.write(packet((next.seq + 1) & 0xff, response));
      continue;
    }
    if (marker === 0x01 && next.payload[1] === 0x03) continue;
    if (marker === 0x01 && next.payload[1] === 0x04 && secure) {
      await conn.write(packet((next.seq + 1) & 0xff, concat([utf8(password), Uint8Array.of(0)])));
      continue;
    }
    if (marker === 0x01 && next.payload[1] === 0x04) {
      await conn.write(packet((next.seq + 1) & 0xff, Uint8Array.of(0x02)));
      const keyPacket = await readPacket(conn);
      if (keyPacket.payload[0] === 0xff) throw new Error(mysqlError(keyPacket.payload));
      const pem = text(keyPacket.payload.subarray(1));
      const encrypted = await encryptMysqlPassword(password, currentSeed, pem, padding);
      await conn.write(packet((keyPacket.seq + 1) & 0xff, encrypted));
      continue;
    }
    if (marker === 0xfe || marker === 0x00) return;
    throw new Error('MySQL 认证没有完成');
  }
}

function parseHandshake(payload: Uint8Array): { capabilities: number; salt: Uint8Array; plugin: string } {
  if (payload[0] !== 10) throw new Error('不支持的 MySQL 协议');
  let offset = payload.indexOf(0, 1) + 1;
  offset += 4;
  const salt1 = payload.subarray(offset, offset + 8);
  offset += 9;
  const capLow = payload[offset] | (payload[offset + 1] << 8);
  offset += 5;
  const capHigh = payload[offset] | (payload[offset + 1] << 8);
  offset += 2;
  const authLen = payload[offset] || 21;
  offset += 11;
  const salt2Len = Math.max(13, authLen - 8);
  const salt2 = payload.subarray(offset, offset + salt2Len - 1);
  offset += salt2Len;
  const pluginEnd = payload.indexOf(0, offset);
  const plugin = pluginEnd > offset ? text(payload.subarray(offset, pluginEnd)) : 'mysql_native_password';
  return { capabilities: capLow | (capHigh << 16), salt: concat([salt1, salt2]), plugin };
}

async function authResponse(username: string, password: string, plugin: string, salt: Uint8Array, caps: number): Promise<Uint8Array> {
  const auth = await scramble(plugin, password, salt);
  const head = new Uint8Array(32);
  const view = new DataView(head.buffer);
  view.setUint32(0, caps, true);
  view.setUint32(4, 0xffffff, true);
  head[8] = 45;
  return concat([head, utf8(username), Uint8Array.of(0), Uint8Array.of(auth.length), auth, utf8(`${plugin}\0`)]);
}

export async function scramble(plugin: string, password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (!password) return new Uint8Array(0);
  if (plugin === 'caching_sha2_password') return cachingSha2(password, salt);
  if (plugin === 'mysql_native_password') return nativePassword(password, salt);
  throw new Error(`不支持的 MySQL 认证插件 ${plugin}`);
}

async function cachingSha2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const pw = utf8(password);
  const hash1 = new Uint8Array(await crypto.subtle.digest('SHA-256', pw));
  const hash2 = new Uint8Array(await crypto.subtle.digest('SHA-256', hash1));
  const hash3 = new Uint8Array(await crypto.subtle.digest('SHA-256', concat([hash2, salt.subarray(0, 20)])));
  const out = new Uint8Array(hash1.length);
  for (let i = 0; i < hash1.length; i++) out[i] = hash1[i] ^ hash3[i];
  return out;
}

async function nativePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const pw = utf8(password);
  const hash1 = sha1(pw);
  const hash2 = sha1(hash1);
  const hash3 = sha1(concat([salt.subarray(0, 20), hash2]));
  const out = new Uint8Array(hash1.length);
  for (let i = 0; i < hash1.length; i++) out[i] = hash1[i] ^ hash3[i];
  return out;
}

export function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const words = new Array<number>((((bitLength + 64) >> 9) << 4) + 16).fill(0);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[bitLength >> 5] |= 0x80 << (24 - (bitLength % 32));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  let e = 0xc3d2e1f0;
  for (let i = 0; i < words.length; i += 16) {
    const w = words.slice(i, i + 16);
    for (let t = 16; t < 80; t++) {
      const n = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (n << 1) | (n >>> 31);
    }
    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;
    let ee = e;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (bb & cc) | (~bb & dd) : t < 40 ? bb ^ cc ^ dd : t < 60 ? (bb & cc) | (bb & dd) | (cc & dd) : bb ^ cc ^ dd;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (((aa << 5) | (aa >>> 27)) + f + ee + k + w[t]) >>> 0;
      ee = dd;
      dd = cc;
      cc = ((bb << 30) | (bb >>> 2)) >>> 0;
      bb = aa;
      aa = temp;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
    e = (e + ee) >>> 0;
  }
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  view.setUint32(0, a);
  view.setUint32(4, b);
  view.setUint32(8, c);
  view.setUint32(12, d);
  view.setUint32(16, e);
  return out;
}

async function readResult(conn: ByteConn): Promise<string[]> {
  const first = await readPacket(conn);
  if (first.payload[0] === 0x00 || first.payload[0] === 0xfe) return [];
  if (first.payload[0] === 0xff) throw new Error(mysqlError(first.payload));
  const columns = first.payload[0];
  for (let i = 0; i < columns; i++) await readPacket(conn);
  const marker = await readPacket(conn);
  if (marker.payload[0] === 0xff) throw new Error(mysqlError(marker.payload));
  const rows: string[] = [];
  while (true) {
    const row = await readPacket(conn);
    if (row.payload[0] === 0xfe && row.payload.length < 9) return rows;
    if (row.payload[0] === 0xff) throw new Error(mysqlError(row.payload));
    rows.push(readLenencString(row.payload, 0).value);
  }
}

function readLenencString(payload: Uint8Array, offset: number): { value: string; next: number } {
  const first = payload[offset];
  if (first === 0xfb) return { value: '', next: offset + 1 };
  let size = first;
  let next = offset + 1;
  if (first === 0xfc) {
    size = payload[offset + 1] | (payload[offset + 2] << 8);
    next = offset + 3;
  } else if (first === 0xfd) {
    size = payload[offset + 1] | (payload[offset + 2] << 8) | (payload[offset + 3] << 16);
    next = offset + 4;
  }
  return { value: text(payload.subarray(next, next + size)), next: next + size };
}

function mysqlError(payload: Uint8Array): string {
  const start = payload[0] === 0xff ? 3 : 1;
  const sqlState = payload[start] === 0x23 ? start + 6 : start;
  return text(payload.subarray(sqlState)) || 'MySQL 拒绝了命令';
}

async function readPacket(conn: ByteConn): Promise<{ seq: number; payload: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let seq = 0;
  while (true) {
    const header = await conn.readExactly(4);
    const length = header[0] | (header[1] << 8) | (header[2] << 16);
    seq = header[3];
    chunks.push(await conn.readExactly(length));
    if (length < 0xffffff) break;
  }
  return { seq, payload: concat(chunks) };
}

function packet(seq: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = payload.length & 0xff;
  header[1] = (payload.length >> 8) & 0xff;
  header[2] = (payload.length >> 16) & 0xff;
  header[3] = seq & 0xff;
  return concat([header, payload]);
}

function trimNull(bytes: Uint8Array): Uint8Array {
  return bytes[bytes.length - 1] === 0 ? bytes.subarray(0, bytes.length - 1) : bytes;
}
