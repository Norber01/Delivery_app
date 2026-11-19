import { createHash as nodeHash, createHmac as nodeHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes, timingSafeEqual } from '../src/node/crypto.js';

describe('browser crypto stand-in', () => {
  it('matches Node for the hashes the services use', () => {
    expect(createHash('sha256').update('GH123').digest('hex')).toBe(nodeHash('sha256').update('GH123').digest('hex'));
    expect(createHmac('sha256', 'salt').update('1.2.3.4').digest('hex')).toBe(nodeHmac('sha256', 'salt').update('1.2.3.4').digest('hex'));
  });
  it('produces base64url and hex like Node', () => {
    const b = randomBytes(24);
    expect(b.toString('base64url')).toBe(Buffer.from(b).toString('base64url'));
    expect(b.toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect([...randomBytes(5)]).toHaveLength(5);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
});
