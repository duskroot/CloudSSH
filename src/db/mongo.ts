import type { DbAdminRequest, DbArchiveTarget } from '../db-admin';
import { type Bson, decodeBson, encodeBson } from './bson';
import { concat, i32le, text, utf8 } from './bytes';
import { scramClientFinal, verifyServerFinal } from './scram';
import { TcpConn } from './tcp';

let requestId = 1;

export async function mongoAdmin(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  const conn = await TcpConn.open(target.host, target.port);
  try {
    if (target.password) await authenticate(conn, target.username, target.password);
    if (request.op === 'list_databases') {
      const result = await command(conn, { listDatabases: 1, nameOnly: true, $db: 'admin' });
      return documents(result.databases).map((item) => String(item.name || '')).filter(Boolean);
    }
    if (request.op === 'list_users') {
      const result = await command(conn, { usersInfo: 1, $db: 'admin' });
      return documents(result.users).map((item) => String(item.user || '')).filter(Boolean);
    }
    if (request.op === 'create_database') {
      await command(conn, { create: '_cloudssh', $db: request.name || '' });
      return [];
    }
    if (request.op === 'drop_database') {
      await command(conn, { dropDatabase: 1, $db: request.name || '' });
      return [];
    }
    if (request.op === 'create_user') {
      const roles = rolesFor(request);
      await command(conn, { createUser: request.name || '', pwd: request.password || '', roles, $db: 'admin' });
      return [];
    }
    if (request.op === 'reset_password') {
      await command(conn, { updateUser: request.name || '', pwd: request.password || '', $db: 'admin' });
      return [];
    }
    if (request.op === 'drop_user') {
      await command(conn, { dropUser: request.name || '', $db: 'admin' });
      return [];
    }
    if (request.op === 'grant') {
      await command(conn, { grantRolesToUser: request.name || '', roles: rolesFor(request), $db: 'admin' });
      return [];
    }
    await command(conn, { revokeRolesFromUser: request.name || '', roles: rolesFor(request), $db: 'admin' });
    return [];
  } finally {
    conn.close();
  }
}

async function authenticate(conn: TcpConn, username: string, password: string): Promise<void> {
  const hello = await helloCommand(conn, username);
  const mechanisms = Array.isArray(hello.saslSupportedMechs) ? hello.saslSupportedMechs.map(String) : [];
  const hash = mechanisms.includes('SCRAM-SHA-256') || mechanisms.length === 0 ? 'SHA-256' : 'SHA-1';
  const mechanism = hash === 'SHA-256' ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1';
  const nonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(18)));
  const clientFirstBare = `n=${username},r=${nonce}`;
  const started = await command(conn, {
    saslStart: 1,
    mechanism,
    payload: utf8(`n,,${clientFirstBare}`),
    $db: 'admin',
  });
  const proof = await scramClientFinal({
    hash,
    password,
    clientFirstBare,
    serverFirst: text(bytesOf(started.payload)),
  });
  let conversation = Number(started.conversationId);
  let done = started.done === true;
  let payload: Bson = utf8(proof.clientFinal);
  let verified = false;
  while (!done) {
    const step = await command(conn, { saslContinue: 1, conversationId: conversation, payload, $db: 'admin' });
    conversation = Number(step.conversationId || conversation);
    const serverMessage = text(bytesOf(step.payload));
    if (serverMessage.includes('v=')) {
      verifyServerFinal(serverMessage, proof.serverSignature);
      verified = true;
    }
    done = step.done === true;
    payload = new Uint8Array(0);
  }
  if (!verified) throw new Error('数据库认证失败');
}

async function helloCommand(conn: TcpConn, username: string): Promise<{ [key: string]: Bson }> {
  const fields = { saslSupportedMechs: `admin.${username}`, $db: 'admin' };
  try {
    return await command(conn, { hello: 1, ...fields });
  } catch {
    return command(conn, { isMaster: 1, ...fields });
  }
}

async function command(conn: TcpConn, document: { [key: string]: Bson }): Promise<{ [key: string]: Bson }> {
  const id = requestId++;
  const body = encodeBson(document);
  const message = concat([
    i32le(16 + 4 + 1 + body.length),
    i32le(id),
    i32le(0),
    i32le(2013),
    i32le(0),
    Uint8Array.of(0),
    body,
  ]);
  await conn.write(message);
  const header = await conn.readExactly(16);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const length = view.getInt32(0, true);
  const payload = await conn.readExactly(length - 16);
  const flags = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  if ((flags & 1) !== 0) throw new Error('MongoDB 返回了校验和，当前不读取');
  if (payload[4] !== 0) throw new Error('MongoDB 返回了不支持的消息段');
  const result = decodeBson(payload.subarray(5));
  if (Number(result.ok) !== 1) throw new Error(String(result.errmsg || 'MongoDB 拒绝了命令'));
  return result;
}

function rolesFor(request: DbAdminRequest): Bson[] {
  const database = request.database || request.name || '';
  const privileges = request.privileges && request.privileges.length > 0 ? request.privileges : ['readWrite'];
  return privileges.map((role) => ({ role, db: database }));
}

function documents(value: Bson): Array<{ [key: string]: Bson }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { [key: string]: Bson } => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function bytesOf(value: Bson): Uint8Array {
  return value instanceof Uint8Array ? value : utf8(String(value || ''));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
