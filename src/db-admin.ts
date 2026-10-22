export const DB_ENGINES = ['postgres', 'mysql', 'redis', 'mongodb'] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

export const DB_ADMIN_OPS = [
  'list_databases',
  'list_users',
  'create_database',
  'drop_database',
  'create_user',
  'drop_user',
  'grant',
  'revoke',
  'flush_redis',
  'reset_password',
  'list_redis_keys',
  'get_redis_key',
  'redis_info',
  'set_redis_key',
  'del_redis_key',
] as const;
export type DbAdminOp = (typeof DB_ADMIN_OPS)[number];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const HOST = /^[A-Za-z0-9._:-]{1,253}$/;

const PRIVILEGES: Record<DbEngine, readonly string[]> = {
  postgres: ['CONNECT', 'CREATE', 'TEMPORARY', 'ALL'],
  mysql: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'],
  redis: ['read', 'write', 'admin'],
  mongodb: ['read', 'readWrite', 'dbAdmin', 'userAdmin'],
};

export function privilegesFor(engine: DbEngine): readonly string[] {
  return PRIVILEGES[engine];
}

export function defaultDbPort(engine: DbEngine): number {
  if (engine === 'postgres') return 5432;
  if (engine === 'mysql') return 3306;
  if (engine === 'redis') return 6379;
  return 27017;
}

export interface DbArchiveTarget {
  engine: DbEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  region?: string;
  inferred_hint?: string;
}

export interface DbAdminRequest {
  op: DbAdminOp;
  name?: string;
  database?: string;
  password?: string;
  privileges?: string[];
  confirm?: string;
  redisDb?: number;
  value?: string;
  charset?: string;
}

export const MYSQL_CHARSETS = [
  { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
  { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
  { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' },
  { charset: 'utf8mb4', collation: 'utf8mb4_bin' },
  { charset: 'utf8mb3', collation: 'utf8mb3_general_ci' },
  { charset: 'latin1', collation: 'latin1_swedish_ci' },
  { charset: 'gbk', collation: 'gbk_chinese_ci' },
  { charset: 'gb18030', collation: 'gb18030_chinese_ci' },
] as const;

export function dbAdminCommand(target: DbArchiveTarget, request: DbAdminRequest): string {
  validateTarget(target);
  return statement(target.engine, request);
}

export function buildDbAdminScript(target: DbArchiveTarget, request: DbAdminRequest): string {
  const sql = dbAdminCommand(target, request);
  const body = scriptBody(target, sql);
  return `sh -c ${shellQuote(`printf %s ${shellQuote(encodeBase64(body))} | base64 -d | sh`)}`;
}

export function parseNameList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Warning') && line !== 'ok');
}

function statement(engine: DbEngine, request: DbAdminRequest): string {
  if (request.op === 'redis_info') {
    if (engine !== 'redis') throw new Error('只有 Redis 可以读取实例信息');
    return 'REDIS_INFO';
  }
  if (request.op === 'list_redis_keys' || request.op === 'get_redis_key' || request.op === 'set_redis_key' || request.op === 'del_redis_key') {
    if (engine !== 'redis') throw new Error('只有 Redis 可以浏览键');
    assertRedisDb(request.redisDb ?? 0);
    if (request.op !== 'list_redis_keys') assertRedisKey(request.name || '');
    if (request.op === 'set_redis_key') assertRedisValue(request.value || '');
    return 'REDIS_KEY';
  }
  const name = optionalIdent(request.name);
  const database = optionalIdent(request.database);
  const privileges = checkedPrivileges(engine, request.privileges);
  if (request.op === 'list_databases') return listDatabases(engine);
  if (request.op === 'list_users') return listUsers(engine);
  if (request.op === 'flush_redis') {
    if (engine !== 'redis') throw new Error('只有 Redis 可以清空当前库');
    if (request.confirm !== 'FLUSH') throw new Error('确认词必须是 FLUSH');
    assertRedisDb(request.redisDb ?? 0);
    return `FLUSHDB ${request.redisDb ?? 0}`;
  }
  if (!name) throw new Error('名称只能包含字母、数字和下划线');
  if ((request.op === 'drop_database' || request.op === 'drop_user') && request.confirm !== name) {
    throw new Error('确认名称不匹配');
  }
  if (request.op === 'create_database') return createDatabase(engine, name, request.charset);
  if (request.op === 'drop_database') return dropDatabase(engine, name);
  if (request.op === 'create_user') {
    if (!request.password) throw new Error('请填写用户密码');
    return createUser(engine, name, request.password, database, privileges);
  }
  if (request.op === 'reset_password') {
    if (!request.password) throw new Error('请填写用户密码');
    return resetPassword(engine, name, request.password);
  }
  if (request.op === 'drop_user') return dropUser(engine, name);
  if (!database && engine !== 'redis') throw new Error('请选择库');
  if (request.op === 'grant') return grant(engine, name, database, privileges);
  return revoke(engine, name, database, privileges);
}

function assertRedisDb(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 1023) throw new Error('Redis 库号必须是 0 到 1023');
}

function assertRedisKey(key: string): void {
  if (!key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('键名不合法');
}

function assertRedisValue(value: string): void {
  if (value.length > 8192 || value.includes('\u0000')) throw new Error('键值不能超过 8192 个字符');
}

function listDatabases(engine: DbEngine): string {
  if (engine === 'postgres') return 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1';
  if (engine === 'mysql') return 'SHOW DATABASES';
  if (engine === 'redis') return 'INFO keyspace';
  return 'LIST_DATABASES';
}

function listUsers(engine: DbEngine): string {
  if (engine === 'postgres') {
    return "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%' ORDER BY 1";
  }
  if (engine === 'mysql') return "SELECT CONCAT(user, '@', host) FROM mysql.user ORDER BY 1";
  if (engine === 'redis') return 'ACL LIST';
  return 'LIST_USERS';
}

function createDatabase(engine: DbEngine, name: string, charset?: string): string {
  if (engine === 'postgres') return `CREATE DATABASE ${quoteIdent(name)}`;
  if (engine === 'mysql') {
    const chosen = MYSQL_CHARSETS.find((item) => item.collation === (charset || 'utf8mb4_0900_ai_ci'));
    if (!chosen) throw new Error('不支持这个数据库编码');
    return `CREATE DATABASE \`${name}\` CHARACTER SET ${chosen.charset} COLLATE ${chosen.collation}`;
  }
  if (engine === 'redis') throw new Error('Redis 没有创建库操作');
  return JSON.stringify({ op: 'create_database', name });
}

function dropDatabase(engine: DbEngine, name: string): string {
  if (engine === 'postgres') return `DROP DATABASE ${quoteIdent(name)}`;
  if (engine === 'mysql') return `DROP DATABASE \`${name}\``;
  if (engine === 'redis') throw new Error('Redis 请使用清空当前库，而不是删除库');
  return JSON.stringify({ op: 'drop_database', name });
}

function createUser(engine: DbEngine, name: string, password: string, database: string | null, privileges: string[]): string {
  assertPassword(password);
  if (engine === 'postgres') return `CREATE USER ${quoteIdent(name)} WITH PASSWORD ${quoteLiteral(password)}`;
  if (engine === 'mysql') return `CREATE USER ${quoteLiteral(name)}@'%' IDENTIFIED BY ${quoteLiteral(password)}`;
  if (engine === 'redis') return `ACL SETUSER ${name} on >${password} ~* ${redisRules(privileges)}`;
  return JSON.stringify({ op: 'create_user', name, password, database: database || name, privileges });
}

function resetPassword(engine: DbEngine, name: string, password: string): string {
  assertPassword(password);
  if (engine === 'postgres') return `ALTER USER ${quoteIdent(name)} WITH PASSWORD ${quoteLiteral(password)}`;
  if (engine === 'mysql') return `ALTER USER ${quoteLiteral(name)}@'%' IDENTIFIED BY ${quoteLiteral(password)}`;
  if (engine === 'redis') return `ACL SETUSER ${name} resetpass on >${password}`;
  return JSON.stringify({ op: 'reset_password', name, password });
}

function dropUser(engine: DbEngine, name: string): string {
  if (engine === 'postgres') return `DROP ROLE ${quoteIdent(name)}`;
  if (engine === 'mysql') return `DROP USER ${quoteLiteral(name)}@'%'`;
  if (engine === 'redis') return `ACL DELUSER ${name}`;
  return JSON.stringify({ op: 'drop_user', name });
}

function grant(engine: DbEngine, name: string, database: string | null, privileges: string[]): string {
  if (privileges.length === 0) throw new Error('请选择权限');
  if (engine === 'postgres') return `GRANT ${privileges.join(', ')} ON DATABASE ${quoteIdent(database || '')} TO ${quoteIdent(name)}`;
  if (engine === 'mysql') {
    const priv = privileges.includes('ALL') ? 'ALL PRIVILEGES' : privileges.join(', ');
    return `GRANT ${priv} ON \`${database}\`.* TO ${quoteLiteral(name)}@'%'`;
  }
  if (engine === 'redis') return `ACL SETUSER ${name} on ~* ${redisRules(privileges)}`;
  return JSON.stringify({ op: 'grant', name, database, privileges });
}

function revoke(engine: DbEngine, name: string, database: string | null, privileges: string[]): string {
  if (privileges.length === 0) throw new Error('请选择权限');
  if (engine === 'postgres') return `REVOKE ${privileges.join(', ')} ON DATABASE ${quoteIdent(database || '')} FROM ${quoteIdent(name)}`;
  if (engine === 'mysql') {
    const priv = privileges.includes('ALL') ? 'ALL PRIVILEGES' : privileges.join(', ');
    return `REVOKE ${priv} ON \`${database}\`.* FROM ${quoteLiteral(name)}@'%'`;
  }
  if (engine === 'redis') return `ACL SETUSER ${name} -@read -@write -@admin`;
  return JSON.stringify({ op: 'revoke', name, database, privileges });
}

function scriptBody(target: DbArchiveTarget, command: string): string {
  const password = encodeBase64(target.password);
  const payload = encodeBase64(command);
  const host = target.host;
  const port = String(target.port);
  const user = target.username;
  if (target.engine === 'postgres') {
    return `set -eu
PW=$(printf %s ${shellQuote(password)} | base64 -d)
SQL=$(printf %s ${shellQuote(payload)} | base64 -d)
export PGPASSWORD="$PW"
psql -h ${shellQuote(host)} -p ${port} -U ${shellQuote(user)} -d postgres -v ON_ERROR_STOP=1 -At -c "$SQL"
`;
  }
  if (target.engine === 'mysql') {
    return `set -eu
PW=$(printf %s ${shellQuote(password)} | base64 -d)
SQL=$(printf %s ${shellQuote(payload)} | base64 -d)
export MYSQL_PWD="$PW"
mysql --protocol=TCP -h ${shellQuote(host)} -P ${port} -u ${shellQuote(user)} -N -B -e "$SQL"
`;
  }
  if (target.engine === 'redis') {
    return `set -eu
PW=$(printf %s ${shellQuote(password)} | base64 -d)
CMD=$(printf %s ${shellQuote(payload)} | base64 -d)
export REDISCLI_AUTH="$PW"
if [ "$CMD" = "INFO keyspace" ]; then
  redis-cli -h ${shellQuote(host)} -p ${port} --no-auth-warning INFO keyspace | sed -n 's/^\\(db[0-9][0-9]*\\):.*/\\1/p'
elif [ "$CMD" = "ACL LIST" ]; then
  redis-cli -h ${shellQuote(host)} -p ${port} --no-auth-warning ACL LIST | awk '{print $2}'
elif [ "$CMD" = "FLUSHDB 0" ] || echo "$CMD" | grep -q '^FLUSHDB '; then
  db=$(echo "$CMD" | awk '{print $2}')
  redis-cli -h ${shellQuote(host)} -p ${port} -n "$db" --no-auth-warning FLUSHDB
else
  redis-cli -h ${shellQuote(host)} -p ${port} --no-auth-warning $CMD
fi
`;
  }
  return `set -eu
PW=$(printf %s ${shellQuote(password)} | base64 -d)
JS=$(printf %s ${shellQuote(mongoProgram(command))} | base64 -d)
mongosh --quiet --host ${shellQuote(host)} --port ${port} -u ${shellQuote(user)} -p "$PW" --authenticationDatabase admin --eval "$JS"
`;
}

function mongoProgram(command: string): string {
  if (command === 'LIST_DATABASES') {
    return 'print(db.adminCommand({listDatabases:1}).databases.map(d => d.name).join("\\n"))';
  }
  if (command === 'LIST_USERS') {
    return 'print(db.getSiblingDB("admin").getUsers().users.map(u => u.user).join("\\n"))';
  }
  const action = JSON.parse(command) as { op: string; name: string; password?: string; database?: string; privileges?: string[] };
  const name = JSON.stringify(action.name);
  if (action.op === 'create_user') {
    const roles = (action.privileges || ['readWrite']).map((role) => ({ role, db: action.database || action.name }));
    return `db.getSiblingDB("admin").createUser({user:${name}, pwd:${JSON.stringify(action.password)}, roles:${JSON.stringify(roles)}})`;
  }
  if (action.op === 'drop_user') return `db.getSiblingDB("admin").dropUser(${name})`;
  if (action.op === 'grant') {
    const roles = (action.privileges || []).map((role) => ({ role, db: action.database }));
    return `db.getSiblingDB("admin").grantRolesToUser(${name}, ${JSON.stringify(roles)})`;
  }
  if (action.op === 'revoke') {
    const roles = (action.privileges || []).map((role) => ({ role, db: action.database }));
    return `db.getSiblingDB("admin").revokeRolesFromUser(${name}, ${JSON.stringify(roles)})`;
  }
  if (action.op === 'create_database') return `db.getSiblingDB(${name}).createCollection("_cloudssh")`;
  if (action.op === 'drop_database') return `db.getSiblingDB(${name}).dropDatabase()`;
  return `db.getSiblingDB(${name}).dropDatabase()`;
}

function validateTarget(target: DbArchiveTarget): void {
  if (!DB_ENGINES.includes(target.engine)) throw new Error('不支持的数据库类型');
  if (!HOST.test(target.host)) throw new Error('主机地址不合法');
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('端口不合法');
  if (target.username && !IDENT.test(target.username)) throw new Error('管理员用户名不合法');
  if (!target.username && target.engine !== 'redis') throw new Error('管理员用户名不合法');
}

function optionalIdent(value: string | undefined): string | null {
  if (!value) return null;
  if (!IDENT.test(value)) throw new Error('名称只能包含字母、数字和下划线');
  return value;
}

function checkedPrivileges(engine: DbEngine, requested: string[] | undefined): string[] {
  const allowed = new Set(PRIVILEGES[engine]);
  return (requested || []).filter((item) => allowed.has(item));
}

function redisRules(privileges: string[]): string {
  const rules = privileges.map((item) => `+@${item}`);
  return rules.length > 0 ? rules.join(' ') : '+@read';
}

function assertPassword(password: string): void {
  if (!/^[\x21-\x7E]{1,128}$/.test(password) || /['"\\$]/.test(password)) {
    throw new Error('用户密码需为 1 到 128 位可见字符，且不能包含引号、反斜杠或 $');
  }
}

function quoteIdent(value: string): string {
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
