import { verifyUploadToken, type GeocodeResult, type MapProvider } from '@courier/shared-utils';

/** Subset of the R2 bucket binding used here (easy to fake in tests). */
export interface EvidenceBucket {
  put(key: string, value: ArrayBuffer, opts: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  head(key: string): Promise<unknown | null>;
}

export interface Env {
  MAPBOX_TOKEN: string;
  ALLOWED_ORIGINS: string;
  UPLOAD_SIGNING_SECRET?: string;
  EVIDENCE?: EvidenceBucket;
  GEOCODE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export interface HandlerDeps {
  maps: MapProvider;
  cache: EdgeCache | null;
  waitUntil: (p: Promise<unknown>) => void;
  nowMs?: () => number;
}

const CACHE_SECONDS = 24 * 3600;
// Restrict proximity bias to Ghana so it cannot be used as a general-purpose proxy.
const inGhana = (lat: number, lng: number) => lat >= 4.5 && lat <= 11.3 && lng >= -3.4 && lng <= 1.3;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
  });

/** Normalise a free-text query so equivalent searches share a cache entry. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// POD photos and business registration documents (PDF allowed for documents only).
const EVIDENCE_KEY = /^(pod\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp)|(kyb|receipt)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp|pdf))$/;

/**
 * Proof-of-delivery photos in a private R2 bucket. Every request needs a short-lived URL signed
 * by Cloud Functions after its own authorisation check (PUT: assigned driver; GET: ops staff;
 * HEAD: functions confirming an upload). Objects are write-once.
 */
async function handleEvidence(req: Request, url: URL, env: Env, nowSeconds: number): Promise<Response> {
  if (!env.EVIDENCE || !env.UPLOAD_SIGNING_SECRET) return json({ error: 'not_configured' }, 503);
  const key = decodeURIComponent(url.pathname.slice('/evidence/'.length));
  const method = req.method as 'PUT' | 'GET' | 'HEAD';
  if (!EVIDENCE_KEY.test(key) || !['PUT', 'GET', 'HEAD'].includes(method)) return json({ error: 'not_found' }, 404);
  const expires = Number(url.searchParams.get('exp'));
  const contentType = url.searchParams.get('ct') ?? undefined;
  const maxBytes = url.searchParams.has('max') ? Number(url.searchParams.get('max')) : undefined;
  const ok = await verifyUploadToken(env.UPLOAD_SIGNING_SECRET, { method, key, expires, contentType, maxBytes }, url.searchParams.get('sig') ?? '', nowSeconds);
  if (!ok) return json({ error: 'invalid_or_expired_link' }, 403);

  if (method === 'HEAD') return new Response(null, { status: (await env.EVIDENCE.head(key)) ? 200 : 404 });
  if (method === 'GET') {
    const obj = await env.EVIDENCE.get(key);
    if (!obj) return json({ error: 'not_found' }, 404);
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // Never render uploaded files as active content on our origin.
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  }
  // PUT
  if (!contentType || !maxBytes || req.headers.get('Content-Type') !== contentType) return json({ error: 'wrong_content_type' }, 415);
  const declared = Number(req.headers.get('Content-Length') ?? NaN);
  if (!Number.isFinite(declared) || declared > maxBytes) return json({ error: 'too_large' }, 413);
  if (await env.EVIDENCE.head(key)) return json({ error: 'already_uploaded' }, 409);
  const body = await req.arrayBuffer();
  if (body.byteLength > maxBytes || body.byteLength === 0) return json({ error: 'too_large' }, 413);
  await env.EVIDENCE.put(key, body, { httpMetadata: { contentType } });
  return json({ ok: true, key }, 201);
}

export async function handleRequest(req: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/evidence/')) return handleEvidence(req, url, env, Math.floor((deps.nowMs?.() ?? Date.now()) / 1000));
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  // Browsers must come from an allowed origin; non-browser callers (no Origin) are still rate limited.
  if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'origin_not_allowed' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);

  if (url.pathname === '/health') return json({ ok: true }, 200, cors);
  if (url.pathname !== '/geocode') return json({ error: 'not_found' }, 404, cors);

  const q = normalizeQuery(url.searchParams.get('q') ?? '');
  if (q.length < 3 || q.length > 120) return json({ error: 'invalid_query' }, 400, cors);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  const proximity = url.searchParams.has('lat') && inGhana(lat, lng) ? { lat: +lat.toFixed(2), lng: +lng.toFixed(2) } : undefined;

  const cacheKey = new Request(
    `https://cache.internal/geocode?q=${encodeURIComponent(q)}${proximity ? `&p=${proximity.lat},${proximity.lng}` : ''}`,
  );
  const cached = await deps.cache?.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    res.headers.set('X-Cache', 'HIT');
    return res;
  }

  // Only cache misses count against the limit (they are what costs money).
  if (env.GEOCODE_LIMITER) {
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.GEOCODE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '60' });
  }

  let results: GeocodeResult[];
  try {
    results = await deps.maps.geocode(q, { proximity, limit: 5 });
  } catch {
    return json({ error: 'upstream_unavailable' }, 502, cors);
  }

  const body = { results };
  const toCache = json(body, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  if (deps.cache) deps.waitUntil(deps.cache.put(cacheKey, toCache.clone()));
  return json(body, 200, { ...cors, 'Cache-Control': 'private, max-age=300', 'X-Cache': 'MISS' });
}
