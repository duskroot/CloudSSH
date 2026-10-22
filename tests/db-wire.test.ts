import { describe, expect, it } from 'vitest';
import { decodeBson, encodeBson } from '../src/db/bson';
import { executeDirect } from '../src/db/execute';
import { md5Hex } from '../src/db/md5';
import { sha1 } from '../src/db/mysql';
import { encodeResp, parseRedisInfo } from '../src/db/redis';
import { scramClientFinal } from '../src/db/scram';
import { text, utf8 } from '../src/db/bytes';

describe('direct database wire helpers', () => {
  it('matches the MD5 and SHA-1 test vectors', () => {
    expect(md5Hex(utf8('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(Array.from(sha1(utf8('abc')), (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d'
    );
  });

  it('matches the SCRAM SHA-1 example from RFC 5802', async () => {
    const proof = await scramClientFinal({
      hash: 'SHA-1',
      password: 'pencil',
      clientFirstBare: 'n=user,r=fyko+d2lbbFgONRv9qkxdawL',
      serverFirst: 'r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096',
    });
    expect(proof.clientFinal).toBe(
      'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts='
    );
    expect(proof.serverSignature).toBe('rmF9pqV8S7suAoZWja4dJRkFsKQ=');
  });

  it('round-trips a BSON document', () => {
    const encoded = encodeBson({ hello: 1, name: 'admin', ok: true, empty: null });
    expect(decodeBson(encoded)).toEqual({ hello: 1, name: 'admin', ok: true, empty: null });
  });

  it('encodes a Redis command as RESP', () => {
    expect(text(encodeResp(['AUTH', 'secret']))).toBe('*2\r\n$4\r\nAUTH\r\n$6\r\nsecret\r\n');
  });

  it('parses Redis INFO into overview rows', () => {
    const rows = parseRedisInfo('# Server\r\nredis_version:7.4.10\r\n# Keyspace\r\ndb2:keys=3,expires=1,avg_ttl=50\r\n', 16);
    expect(rows[0]).toBe('meta\tdatabases\t16');
    expect(rows).toContain('info\tserver\tredis_version\t7.4.10');
    expect(rows).toContain('keyspace\tdb2\t3\t1\t50');
  });

  it('refuses a loopback database address before opening a socket', async () => {
    await expect(executeDirect(
      { engine: 'mongodb', host: '127.0.0.1', port: 27017, username: 'admin', password: 'secret' },
      { op: 'list_databases' }
    )).rejects.toThrow(/禁止连接/);
  });
});
