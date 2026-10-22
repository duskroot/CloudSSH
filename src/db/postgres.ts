import { dbAdminCommand, type DbAdminRequest, type DbArchiveTarget } from '../db-admin';
import { concat, Cursor, randomNonce, text, u32be, utf8 } from './bytes';
import { md5Hex } from './md5';
import { scramClientFinal, verifyServerFinal } from './scram';
import { TcpConn } from './tcp';

export async function postgresAdmin(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  const sql = dbAdminCommand(target, request);
  const conn = await TcpConn.open(target.host, target.port);
  try {
    await conn.write(startup(target.username));
    await authenticate(conn, target.username, target.password);
    return await query(conn, sql);
  } finally {
    conn.close();
  }
}

function startup(username: string): Uint8Array {
  const body = concat([
    u32be(196608),
    utf8('user'),
    Uint8Array.of(0),
    utf8(username),
    Uint8Array.of(0),
    utf8('database'),
    Uint8Array.of(0),
    utf8('postgres'),
    Uint8Array.of(0),
    Uint8Array.of(0),
  ]);
  return concat([u32be(body.length + 4), body]);
}

async function authenticate(conn: TcpConn, username: string, password: string): Promise<void> {
  let clientFirstBare = '';
  let serverSignature = '';
  while (true) {
    const message = await readMessage(conn);
    if (message.type === 'E') throw new Error(errorMessage(message.payload));
    if (message.type === 'Z') return;
    if (message.type !== 'R') continue;
    const cursor = new Cursor(message.payload);
    const kind = cursor.i32be();
    if (kind === 0) continue;
    if (kind === 3) {
      await conn.write(passwordMessage(utf8(`${password}\0`)));
    } else if (kind === 5) {
      const salt = cursor.take(4);
      const inner = md5Hex(utf8(password + username));
      const outer = md5Hex(concat([utf8(inner), salt]));
      await conn.write(passwordMessage(utf8(`md5${outer}\0`)));
    } else if (kind === 10) {
      const nonce = randomNonce();
      clientFirstBare = `n=${username},r=${nonce}`;
      const initial = utf8(`n,,${clientFirstBare}`);
      await conn.write(saslInitial(initial));
    } else if (kind === 11) {
      const serverFirst = text(message.payload.subarray(4));
      const proof = await scramClientFinal({
        hash: 'SHA-256',
        password,
        clientFirstBare,
        serverFirst,
      });
      serverSignature = proof.serverSignature;
      await conn.write(passwordMessage(utf8(proof.clientFinal)));
    } else if (kind === 12) {
      verifyServerFinal(text(message.payload.subarray(4)), serverSignature);
    } else {
      throw new Error('PostgreSQL 使用了不支持的认证方式');
    }
  }
}

async function query(conn: TcpConn, sql: string): Promise<string[]> {
  await conn.write(concat([utf8('Q'), u32be(sql.length + 5), utf8(sql), Uint8Array.of(0)]));
  const rows: string[] = [];
  while (true) {
    const message = await readMessage(conn);
    if (message.type === 'E') throw new Error(errorMessage(message.payload));
    if (message.type === 'Z') return rows;
    if (message.type !== 'D') continue;
    const cursor = new Cursor(message.payload);
    const count = cursor.i16be();
    if (count < 1) continue;
    const size = cursor.i32be();
    if (size < 0) continue;
    rows.push(text(cursor.take(size)));
  }
}

async function readMessage(conn: TcpConn): Promise<{ type: string; payload: Uint8Array }> {
  const type = String.fromCharCode((await conn.readExactly(1))[0]);
  const length = new DataView((await conn.readExactly(4)).buffer).getUint32(0);
  const payload = await conn.readExactly(length - 4);
  return { type, payload };
}

function passwordMessage(payload: Uint8Array): Uint8Array {
  return concat([utf8('p'), u32be(payload.length + 4), payload]);
}

function saslInitial(initial: Uint8Array): Uint8Array {
  const mechanism = utf8('SCRAM-SHA-256\0');
  const payload = concat([mechanism, u32be(initial.length), initial]);
  return passwordMessage(payload);
}

function errorMessage(payload: Uint8Array): string {
  const cursor = new Cursor(payload);
  let message = 'PostgreSQL 拒绝了命令';
  while (cursor.rest() > 1) {
    const field = String.fromCharCode(cursor.u8());
    const value = cursor.cstring();
    if (field === 'M') message = value;
  }
  return message;
}
