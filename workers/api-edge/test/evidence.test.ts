import { describe, expect, it } from 'vitest';
import { evidenceUrl } from '@courier/shared-utils';
import { handleRequest, type EvidenceBucket, type Env } from '../src/handler.js';

const SECRET = 'upload-secret';
const KEY = 'pod/GHABC/AbCdEfGhIjKlMnOpQrSt.jpg';
const NOW = 1_800_000_000;

class FakeBucket implements EvidenceBucket {
  objects = new Map<string, { body: ArrayBuffer; contentType: string }>();
  async put(key: string, value: ArrayBuffer, opts: { httpMetadata: { contentType: string } }) {
    this.objects.set(key, { body: value, contentType: opts.httpMetadata.contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { body: new Response(o.body).body!, httpMetadata: { contentType: o.contentType } } : null;
  }
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
}

const setup = () => {
  const bucket = new FakeBucket();
  const env: Env = { MAPBOX_TOKEN: 't', ALLOWED_ORIGINS: '', UPLOAD_SIGNING_SECRET: SECRET, EVIDENCE: bucket };
  const call = (url: string, init?: RequestInit) =>
    handleRequest(new Request(url, init), env, { maps: {} as never, cache: null, waitUntil: () => {}, nowMs: () => NOW * 1000 });
  return { bucket, call };
};
const signed = (method: 'PUT' | 'GET' | 'HEAD', extra: Partial<{ key: string; expires: number; contentType: string; maxBytes: number }> = {}) =>
  evidenceUrl('https://edge.test', SECRET, { method, key: KEY, expires: NOW + 600, ...(method === 'PUT' ? { contentType: 'image/jpeg', maxBytes: 1000 } : {}), ...extra });
const photo = (n: number) => ({ method: 'PUT', body: new Uint8Array(n), headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(n) } });

describe('evidence storage', () => {
  it('accepts a signed upload once, then serves it only with a signed GET', async () => {
    const { bucket, call } = setup();
    expect((await call(await signed('PUT'), photo(500))).status).toBe(201);
    expect(bucket.objects.get(KEY)?.contentType).toBe('image/jpeg');
    expect((await call(await signed('PUT'), photo(500))).status).toBe(409); // write-once
    expect((await call(await signed('HEAD'), { method: 'HEAD' })).status).toBe(200);
    const get = await call(await signed('GET'));
    expect(get.status).toBe(200);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await get.arrayBuffer()).byteLength).toBe(500);
    expect((await call(`https://edge.test/evidence/${KEY}`)).status).toBe(403); // unsigned
  });

  it('rejects tampered, expired, oversized or mistyped uploads', async () => {
    const { call } = setup();
    const url = new URL(await signed('PUT'));
    url.searchParams.set('max', '999999');
    expect((await call(url.toString(), photo(500))).status).toBe(403);
    expect((await call(await signed('PUT', { expires: NOW - 1 }), photo(500))).status).toBe(403);
    expect((await call(await signed('PUT'), photo(2000))).status).toBe(413);
    expect((await call(await signed('PUT'), { ...photo(500), headers: { 'Content-Type': 'text/html', 'Content-Length': '500' } })).status).toBe(415);
    // A GET token cannot be used to upload.
    expect((await call(await signed('GET'), photo(500))).status).toBe(403);
  });

  it('refuses keys outside the evidence namespace', async () => {
    const { call } = setup();
    expect((await call(await signed('GET', { key: '../secrets.txt' }))).status).toBe(404);
  });
});
