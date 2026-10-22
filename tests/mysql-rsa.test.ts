import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptMysqlPassword } from '../src/db/mysql-rsa';

describe('MySQL caching_sha2 public-key login', () => {
  it('encrypts the scrambled password so the server key can decrypt it', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const seed = randomBytes(20);
    const password = 'secret-pass';
    const encrypted = await encryptMysqlPassword(password, seed, pem, 'oaep');
    const plain = privateDecrypt({
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    }, encrypted);
    const body = Buffer.concat([Buffer.from(password), Buffer.from([0])]);
    for (let i = 0; i < body.length; i++) body[i] ^= seed[i % seed.length];
    const expected = body;
    expect(Buffer.compare(plain, expected)).toBe(0);
  });

  it('encrypts with the older PKCS1 padding used by MySQL 8.0', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const seed = randomBytes(20);
    const password = 'secret-pass';
    const encrypted = await encryptMysqlPassword(password, seed, pem, 'pkcs1');
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, encrypted);
    const body = Buffer.concat([Buffer.from(password), Buffer.from([0])]);
    for (let i = 0; i < body.length; i++) body[i] ^= seed[i % seed.length];
    expect(Buffer.compare(plain, body)).toBe(0);
  });
});
