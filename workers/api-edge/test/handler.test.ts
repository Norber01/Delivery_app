import { describe, expect, it, beforeEach } from 'vitest';
import type { MapProvider } from '@courier/shared-utils';
import { handleRequest, normalizeQuery, type EdgeCache, type Env } from '../src/handler.js';

class MapCache implements EdgeCache {
  store = new Map<string, Response>();
  async match(k: Request) {
    return this.store.get(k.url)?.clone();
  }
  async put(k: Request, r: Response) {
    this.store.set(k.url, r);
  }
}

let calls: { q: string; proximity?: unknown }[];
let cache: MapCache;
let pending: Promise<unknown>[];
let limiterOk: boolean;
const maps: MapProvider = {
  name: 'fake',
  async geocode(q, opts) {
    calls.push({ q, proximity: opts?.proximity });
    return [{ label: 'Osu, Accra', location: { lat: 5.55, lng: -0.18 } }];
  },
  async route() {
    throw new Error('unused');
  },
};
const env = (): Env => ({
  MAPBOX_TOKEN: 't',
  ALLOWED_ORIGINS: 'https://www.example.com.gh',
  GEOCODE_LIMITER: { limit: async () => ({ success: limiterOk }) },
});
const call = async (path: string, init: RequestInit = {}) => {
  const res = await handleRequest(new Request(`https://edge.test${path}`, init), env(), {
    maps,
    cache,
    waitUntil: (p) => pending.push(p),
  });
  await Promise.all(pending);
  return res;
};
const ORIGIN = { headers: { Origin: 'https://www.example.com.gh' } };

beforeEach(() => {
  calls = [];
  cache = new MapCache();
  pending = [];
  limiterOk = true;
});

describe('geocode proxy', () => {
  it('returns results with CORS for allowed origins', async () => {
    const res = await call('/geocode?q=Osu', ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.example.com.gh');
    expect(await res.json()).toEqual({ results: [{ label: 'Osu, Accra', location: { lat: 5.55, lng: -0.18 } }] });
  });

  it('serves repeated (normalised) queries from cache without calling the provider', async () => {
    await call('/geocode?q=Oxford%20Street', ORIGIN);
    const res = await call('/geocode?q=%20oxford%20%20STREET', ORIGIN);
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(calls).toHaveLength(1);
  });

  it('rejects disallowed origins', async () => {
    const res = await call('/geocode?q=Osu', { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('validates the query', async () => {
    expect((await call('/geocode?q=ab', ORIGIN)).status).toBe(400);
    expect((await call(`/geocode?q=${'x'.repeat(121)}`, ORIGIN)).status).toBe(400);
  });

  it('rate limits cache misses', async () => {
    limiterOk = false;
    const res = await call('/geocode?q=Osu', ORIGIN);
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it('only accepts proximity inside Ghana and rounds it', async () => {
    await call('/geocode?q=Osu&lat=5.55612&lng=-0.18233', ORIGIN);
    await call('/geocode?q=Market&lat=51.5&lng=-0.12', ORIGIN);
    expect(calls[0]!.proximity).toEqual({ lat: 5.56, lng: -0.18 });
    expect(calls[1]!.proximity).toBeUndefined();
  });

  it('handles preflight and unknown routes', async () => {
    expect((await call('/geocode', { method: 'OPTIONS', ...ORIGIN })).status).toBe(204);
    expect((await call('/other', ORIGIN)).status).toBe(404);
    expect((await call('/geocode?q=Osu', { method: 'POST', ...ORIGIN })).status).toBe(405);
  });

  it('normalises queries', () => {
    expect(normalizeQuery('  Kotoka   AIRPORT ')).toBe('kotoka airport');
  });
});
