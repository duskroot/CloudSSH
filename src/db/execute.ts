import { DB_ADMIN_OPS, type DbAdminRequest, type DbArchiveTarget, dbAdminCommand } from '../db-admin';
import { checkHostResolved } from '../worker/dns-check';
import { mongoAdmin } from './mongo';
import { mysqlAdmin } from './mysql';
import { postgresAdmin } from './postgres';
import { redisAdmin } from './redis';
export async function executeDirect(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  if (!DB_ADMIN_OPS.includes(request.op)) throw new Error('不支持的管理操作');
  dbAdminCommand(target, request);
  const dns = await checkHostResolved(target.host);
  if (dns.blocked) throw new Error(dns.reason || '禁止连接该地址');
  return withTimeout(dispatch(target, request), 8000);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接数据库超时')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function dispatch(target: DbArchiveTarget, request: DbAdminRequest): Promise<string[]> {
  if (target.engine === 'postgres') return postgresAdmin(target, request);
  if (target.engine === 'mysql') return mysqlAdmin(target, request);
  if (target.engine === 'redis') return redisAdmin(target, request);
  return mongoAdmin(target, request);
}
