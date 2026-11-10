import type { LatLng } from '@courier/shared-types';

export interface GeocodeResult {
  label: string;
  location: LatLng;
  /** Locality / city name if known. */
  city?: string;
  /** Region name as returned by the provider (not guaranteed to match GhanaRegion). */
  region?: string;
}

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  /** Encoded polyline (precision 5) when requested. */
  polyline?: string;
}

/**
 * Provider-neutral mapping interface. All server and edge code depends on this,
 * never on a vendor SDK, so the provider can be swapped by adding an adapter.
 */
export interface MapProvider {
  readonly name: string;
  geocode(query: string, opts?: { proximity?: LatLng; limit?: number }): Promise<GeocodeResult[]>;
  route(from: LatLng, to: LatLng, opts?: { geometry?: boolean }): Promise<RouteResult>;
}

export class MapProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MapProviderError';
  }
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface MapboxGeocodeResponse {
  features?: {
    properties?: {
      full_address?: string;
      name?: string;
      context?: { place?: { name?: string }; region?: { name?: string } };
    };
    geometry?: { coordinates?: [number, number] };
  }[];
}

interface MapboxDirectionsResponse {
  code?: string;
  routes?: { distance: number; duration: number; geometry?: string }[];
}

/** Mapbox adapter (Geocoding v6 + Directions v5). Works in Node 18+, Workers and browsers. */
export class MapboxProvider implements MapProvider {
  readonly name = 'mapbox';
  private readonly base = 'https://api.mapbox.com';

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly timeoutMs = 6000,
  ) {
    if (!accessToken) throw new Error('Mapbox access token is required');
  }

  private async getJson<T>(url: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new MapProviderError(`Mapbox request failed (${res.status})`, res.status);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof MapProviderError) throw e;
      throw new MapProviderError(`Mapbox request error: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async geocode(query: string, opts: { proximity?: LatLng; limit?: number } = {}): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q: query,
      country: 'gh',
      limit: String(Math.min(opts.limit ?? 5, 10)),
      language: 'en',
      access_token: this.accessToken,
    });
    if (opts.proximity) params.set('proximity', `${opts.proximity.lng},${opts.proximity.lat}`);
    const data = await this.getJson<MapboxGeocodeResponse>(`${this.base}/search/geocode/v6/forward?${params}`);
    return (data.features ?? []).flatMap((f) => {
      const c = f.geometry?.coordinates;
      if (!c) return [];
      return [
        {
          label: f.properties?.full_address ?? f.properties?.name ?? query,
          location: { lng: c[0], lat: c[1] },
          city: f.properties?.context?.place?.name,
          region: f.properties?.context?.region?.name,
        },
      ];
    });
  }

  async route(from: LatLng, to: LatLng, opts: { geometry?: boolean } = {}): Promise<RouteResult> {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const params = new URLSearchParams({
      access_token: this.accessToken,
      overview: opts.geometry ? 'full' : 'false',
      geometries: 'polyline',
    });
    const data = await this.getJson<MapboxDirectionsResponse>(
      `${this.base}/directions/v5/mapbox/driving/${coords}?${params}`,
    );
    const r = data.routes?.[0];
    if (data.code !== 'Ok' || !r) throw new MapProviderError(`No route found (${data.code ?? 'unknown'})`);
    return {
      distanceKm: r.distance / 1000,
      durationMinutes: r.duration / 60,
      ...(opts.geometry && r.geometry ? { polyline: r.geometry } : {}),
    };
  }
}
