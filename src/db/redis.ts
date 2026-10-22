import type { DbAdminRequest, DbArchiveTarget } from '../db-admin';
import { concat, text, utf8 } from './bytes';
import { TcpConn } from './tcp';

export function encodeResp(args: string[]): Uint8Array {
  const parts = [utf8(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = utf8(arg);
    parts.push(utf8(`$${bytes.length}\r\n`), bytes, utf8('\r\n'));
  }
  return concat(parts);
}

export type RespValue = string | number | null | RespValue[];

export async function readResp(conn: TcpConn): Promise<RespValue> {
  const prefix = (await conn.readExactly(1))[0];
  const line = await readLine(conn);
  if (prefix === 43) return line;
  if (prefix === 45) throw new Error(line);
  if (prefix === 58) return Number(line);
  if (prefix === 36) {
    const size = Number(line);
    if (size < 0) return null;
    const bytes = await conn.readExactly(size);
    await conn.readExactly(2);
    return text(bytes);
  }
  if (prefix === 42) {
    const count = Number(line);
    if (count < 0) return null;
    const items: RespValue[] = [];
    for (let i = 0; i < count; i++) items.push(await readResp(conn));
    return items;
  }
  throw new Error('无法识别 Redis 响应');
}

async function readLine(conn: TcpConn): Promise<string> {
  const chunks: number[] = [];
  while (true) {
    const byte = (await conn.readExactly(1))[0];
    if (byte === 13) {
      await conn.readExactly(1);
      return text(Uint8Array.from(chunks));
    }
    chunks.push(byte);
  }
}

export async function redisAdmin(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  const conn = await TcpConn.open(target.host, target.port);
  try {
    if (target.password) {
      const auth = target.username
        ? ['AUTH', target.username, target.password]
        : ['AUTH', target.password];
      await conn.write(encodeResp(auth));
      await readResp(conn);
    }
    if (request.op === 'flush_redis') {
      await conn.write(encodeResp(['SELECT', String(request.redisDb ?? 0)]));
      await readResp(conn);
      await conn.write(encodeResp(['FLUSHDB']));
      await readResp(conn);
      return [];
    }
    if (request.op === 'list_redis_keys') {
      await selectDb(conn, request.redisDb ?? 0);
      const pattern = redisPattern(request.name);
      const keys: string[] = [];
      let cursor = '0';
      for (let round = 0; round < 4 && keys.length < 300; round++) {
        const args = ['SCAN', cursor, 'COUNT', '100'];
        if (pattern) args.push('MATCH', pattern);
        await conn.write(encodeResp(args));
        const reply = await readResp(conn);
        if (!Array.isArray(reply) || reply.length < 2) break;
        cursor = String(reply[0] ?? '0');
        const batch = Array.isArray(reply[1]) ? reply[1] : [];
        for (const key of batch) {
          if (typeof key === 'string') keys.push(key);
        }
        if (cursor === '0') break;
      }
      return keys;
    }
    if (request.op === 'get_redis_key') {
      await selectDb(conn, request.redisDb ?? 0);
      const key = request.name || '';
      await conn.write(encodeResp(['TYPE', key]));
      const type = String(await readResp(conn));
      await conn.write(encodeResp(['TTL', key]));
      const ttl = await readResp(conn);
      const lines = await readKeyValue(conn, type, key);
      return [type, String(ttl ?? '-1'), ...lines];
    }
    if (request.op === 'set_redis_key') {
      await selectDb(conn, request.redisDb ?? 0);
      await conn.write(encodeResp(['SET', request.name || '', request.value || '']));
      await readResp(conn);
      return [];
    }
    if (request.op === 'del_redis_key') {
      await selectDb(conn, request.redisDb ?? 0);
      await conn.write(encodeResp(['DEL', request.name || '']));
      await readResp(conn);
      return [];
    }
    if (request.op === 'redis_info') return await readRedisInfo(conn);
    if (request.op === 'list_databases') {
      await conn.write(encodeResp(['INFO', 'keyspace']));
      const info = String(await readResp(conn));
      return info.split('\n').map((line) => line.match(/^(db\d+):/)?.[1] || '').filter(Boolean);
    }
    if (request.op === 'list_users') {
      await conn.write(encodeResp(['ACL', 'LIST']));
      const rows = await readResp(conn);
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => String(row).split(/\s+/)[1] || '').filter(Boolean);
    }
    if (request.op === 'create_user') {
      await conn.write(encodeResp(['ACL', 'SETUSER', request.name || '', 'on', `>${request.password || ''}`, '~*', ...redisRules(request.privileges)]));
      await readResp(conn);
      return [];
    }
    if (request.op === 'reset_password') {
      await conn.write(encodeResp(['ACL', 'SETUSER', request.name || '', 'resetpass', 'on', `>${request.password || ''}`]));
      await readResp(conn);
      return [];
    }
    if (request.op === 'drop_user') {
      await conn.write(encodeResp(['ACL', 'DELUSER', request.name || '']));
      await readResp(conn);
      return [];
    }
    if (request.op === 'grant') {
      await conn.write(encodeResp(['ACL', 'SETUSER', request.name || '', 'on', '~*', ...redisRules(request.privileges)]));
      await readResp(conn);
      return [];
    }
    await conn.write(encodeResp(['ACL', 'SETUSER', request.name || '', '-@read', '-@write', '-@admin']));
    await readResp(conn);
    return [];
  } finally {
    conn.close();
  }
}

export function parseRedisInfo(info: string, databases: number): string[] {
  const lines = [`meta\tdatabases\t${databases}`];
  let section = 'server';
  let kept = 0;
  for (const raw of info.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.slice(1).trim().toLowerCase() || section;
      continue;
    }
    const split = line.indexOf(':');
    if (split <= 0) continue;
    const key = line.slice(0, split);
    const value = clip(line.slice(split + 1));
    if (section === 'keyspace' && /^db\d+$/.test(key)) {
      lines.push([
        'keyspace',
        key,
        value.match(/keys=(\d+)/)?.[1] || '0',
        value.match(/expires=(\d+)/)?.[1] || '0',
        value.match(/avg_ttl=(\d+)/)?.[1] || '0',
      ].join('\t'));
    }
    if (kept >= 600) continue;
    lines.push(['info', section, key, value].join('\t'));
    kept += 1;
  }
  return lines;
}

async function readRedisInfo(conn: TcpConn): Promise<string[]> {
  const databases = 16;
  await conn.write(encodeResp(['INFO']));
  const info = String(await readResp(conn));
  const lines = parseRedisInfo(info, databases);
  const highest = lines.reduce((max, line) => {
    const match = line.match(/^keyspace\tdb(\d+)\t/);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, databases);
  if (highest !== databases) lines[0] = `meta\tdatabases\t${Math.min(highest, 1024)}`;
  return lines;
}

async function selectDb(conn: TcpConn, index: number): Promise<void> {
  await conn.write(encodeResp(['SELECT', String(index)]));
  await readResp(conn);
}

function redisPattern(value: string | undefined): string {
  const textValue = (value || '').trim();
  if (!textValue || textValue.length > 128 || /[\r\n\0*?[\]]/.test(textValue)) return '';
  return `*${textValue}*`;
}

async function readKeyValue(conn: TcpConn, type: string, key: string): Promise<string[]> {
  if (type === 'string') {
    await conn.write(encodeResp(['GET', key]));
    const value = await readResp(conn);
    return [clip(String(value ?? ''))];
  }
  if (type === 'hash') {
    await conn.write(encodeResp(['HGETALL', key]));
    return pairLines(await readResp(conn));
  }
  if (type === 'list') {
    await conn.write(encodeResp(['LRANGE', key, '0', '199']));
    return flatLines(await readResp(conn));
  }
  if (type === 'set') {
    await conn.write(encodeResp(['SMEMBERS', key]));
    return flatLines(await readResp(conn));
  }
  if (type === 'zset') {
    await conn.write(encodeResp(['ZRANGE', key, '0', '199', 'WITHSCORES']));
    return pairLines(await readResp(conn));
  }
  return [`暂不展示 ${type} 类型的内容`];
}

function flatLines(value: RespValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 200).map(clip);
}

function pairLines(value: RespValue): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (let i = 0; i + 1 < value.length && lines.length < 200; i += 2) {
    lines.push(`${clip(String(value[i] ?? ''))}\t${clip(String(value[i + 1] ?? ''))}`);
  }
  return lines;
}

function clip(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
}

function redisRules(privileges: string[] | undefined): string[] {
  const rules = (privileges || []).map((item) => `+@${item}`);
  return rules.length > 0 ? rules : ['+@read'];
}
