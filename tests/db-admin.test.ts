import { describe, expect, it } from 'vitest';
import { buildDbAdminScript, dbAdminCommand } from '../src/db-admin';

const target = {
  engine: 'postgres' as const,
  host: '127.0.0.1',
  port: 5432,
  username: 'postgres',
  password: 'secret',
};

describe('db admin commands', () => {
  it('builds a postgres exec that does not use the credential vault', () => {
    const command = buildDbAdminScript(target, { op: 'list_databases' });
    expect(command.startsWith('sh -c ')).toBe(true);
    expect(command).not.toContain('credential_id');
  });

  it('rejects unsafe names and redis create database', () => {
    expect(() => buildDbAdminScript(target, { op: 'create_database', name: 'bad-name' })).toThrow();
    expect(() => buildDbAdminScript(
      { ...target, engine: 'redis', port: 6379 },
      { op: 'create_database', name: 'app' }
    )).toThrow(/Redis/);
  });

  it('accepts redis info and a key on db 31', () => {
    const redis = { ...target, engine: 'redis' as const, port: 6379, username: '' };
    expect(dbAdminCommand(redis, { op: 'redis_info' })).toBe('REDIS_INFO');
    expect(dbAdminCommand(redis, { op: 'set_redis_key', redisDb: 31, name: 'cloudssh:hello', value: 'hi' })).toBe('REDIS_KEY');
    expect(() => dbAdminCommand(redis, { op: 'set_redis_key', redisDb: 31, name: 'a', value: 'x'.repeat(9000) })).toThrow();
  });

  it('adds a MySQL charset when creating a database', () => {
    const mysql = { ...target, engine: 'mysql' as const, port: 3306 };
    expect(dbAdminCommand(mysql, { op: 'create_database', name: 'app', charset: 'utf8mb4_unicode_ci' })).toBe(
      'CREATE DATABASE `app` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    );
    expect(() => dbAdminCommand(mysql, { op: 'create_database', name: 'app', charset: 'utf8mb4;drop' })).toThrow();
  });

  it('requires the typed name before drop', () => {
    expect(() => buildDbAdminScript(target, { op: 'drop_database', name: 'app', confirm: 'nope' })).toThrow();
    expect(buildDbAdminScript(target, { op: 'drop_database', name: 'app', confirm: 'app' })).toContain('base64');
  });
});
