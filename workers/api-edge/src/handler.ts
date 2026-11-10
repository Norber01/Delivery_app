import type { GeocodeResult, MapProvider } from '@courier/shared-utils';

export interface Env {
  MAPBOX_TOKEN: string;
  ALLOWED_ORIGINS: string;
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

export async function handleRequest(req: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
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
