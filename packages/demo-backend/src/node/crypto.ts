/** Browser stand-in for the parts of `node:crypto` the Cloud Functions code uses. */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { Buffer } from 'buffer';

const bytes = (s: string | Uint8Array) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

/** Bytes with Node's `toString(encoding)`, including base64url (missing from the Buffer polyfill). */
class Bytes extends Uint8Array {
  override toString(enc?: string): string {
    if (enc === 'base64url') return Buffer.from(this).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (enc === 'hex' || enc === 'base64' || enc === 'utf8') return Buffer.from(this).toString(enc);
    return super.toString();
  }
}
const toBuffer = (u: Uint8Array) => new Bytes(u);

function hasher(update: (d: Uint8Array) => void, finish: () => Uint8Array) {
  const h = {
    update(d: string | Uint8Array) {
      update(bytes(d));
      return h;
    },
    digest(enc?: 'hex' | 'base64' | 'base64url') {
      const out = toBuffer(finish());
      return enc ? out.toString(enc) : out;
    },
  };
  return h;
}

export function createHash(alg: string) {
  if (alg !== 'sha256') throw new Error(`Unsupported hash ${alg}`);
  const h = sha256.create();
  return hasher((d) => h.update(d), () => h.digest());
}
export function createHmac(alg: string, key: string | Uint8Array) {
  if (alg !== 'sha256' && alg !== 'sha512') throw new Error(`Unsupported hmac ${alg}`);
  if (alg === 'sha512') throw new Error('sha512 HMAC is not used in the demo');
  const h = hmac.create(sha256, bytes(key));
  return hasher((d) => h.update(d), () => h.digest());
}
export function randomBytes(n: number) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return toBuffer(u);
}
export function randomInt(min: number, max?: number) {
  const [lo, hi] = max === undefined ? [0, min] : [min, max];
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return lo + (u[0]! % (hi - lo));
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same length');
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
export default { createHash, createHmac, randomBytes, randomInt, timingSafeEqual };
