import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { PinHasher } from '@cake-pos/panel';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

const derive = (secret: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(secret, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/**
 * scrypt with a random salt per PIN. Stored as scrypt$N$r$p$salt$hash so the cost can be raised
 * later without breaking existing PINs. Comparison is constant-time.
 */
export function createScryptHasher(): PinHasher {
  return {
    hash: async (userId, pin) => {
      const salt = randomBytes(16);
      const key = await derive(`${userId}:${pin}`, salt, N, R, P);
      return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
    },
    verify: async (stored, userId, pin) => {
      const parts = stored.split('$');
      if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
      const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (![n, r, p].every(Number.isInteger)) return false;
      const expected = Buffer.from(parts[5]!, 'base64');
      const actual = await derive(`${userId}:${pin}`, Buffer.from(parts[4]!, 'base64'), n, r, p);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}
