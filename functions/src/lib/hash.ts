import { createHash, createHmac, randomBytes } from 'node:crypto';
import { canonicalJson } from '@courier/shared-utils';

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable hash of a normalised object (sorted keys). */
export const hashObject = (o: unknown) => sha256Hex(canonicalJson(o));

/** Keyed hash for IPs so raw addresses are never stored. */
export const hashIp = (ip: string, salt: string) => createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Firestore-safe random document ID (alphanumeric), unbiased via rejection sampling. */
export function randomId(length = 20): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const limit = 256 - (256 % chars.length);
  let id = '';
  while (id.length < length) {
    for (const b of randomBytes(length)) {
      if (b < limit && id.length < length) id += chars[b % chars.length];
    }
  }
  return id;
}
