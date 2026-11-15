import { describe, expect, it } from 'vitest';
import { evidenceUrl, signUploadToken, verifyUploadToken } from '../src/index.js';

const p = { method: 'PUT' as const, key: 'pod/GHX/abc12345.jpg', expires: 2000, contentType: 'image/jpeg', maxBytes: 1000 };

describe('upload tokens', () => {
  it('verifies a valid token and rejects any change', async () => {
    const sig = await signUploadToken('s3cret', p);
    expect(await verifyUploadToken('s3cret', p, sig, 1000)).toBe(true);
    expect(await verifyUploadToken('other', p, sig, 1000)).toBe(false);
    expect(await verifyUploadToken('s3cret', { ...p, key: 'pod/GHY/abc12345.jpg' }, sig, 1000)).toBe(false);
    expect(await verifyUploadToken('s3cret', { ...p, maxBytes: 9999 }, sig, 1000)).toBe(false);
    expect(await verifyUploadToken('s3cret', { ...p, method: 'GET' }, sig, 1000)).toBe(false);
  });
  it('expires', async () => {
    const sig = await signUploadToken('s3cret', p);
    expect(await verifyUploadToken('s3cret', p, sig, 2001)).toBe(false);
  });
  it('builds worker URLs', async () => {
    const url = new URL(await evidenceUrl('https://edge.example/', 's3cret', p));
    expect(url.pathname).toBe('/evidence/pod/GHX/abc12345.jpg');
    expect(url.searchParams.get('ct')).toBe('image/jpeg');
    expect(url.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
  });
});
