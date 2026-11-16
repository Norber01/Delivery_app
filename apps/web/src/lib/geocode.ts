import type { GeocodeResult } from '@courier/shared-utils';
import { config } from './config';

/** Address search through the edge Worker (never calls Mapbox directly from the browser). */
export async function searchAddress(q: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  if (!config.edgeApiUrl) return [];
  const res = await fetch(`${config.edgeApiUrl}/geocode?q=${encodeURIComponent(q)}`, { signal });
  if (res.status === 429) throw new Error('Too many searches. Please wait a minute.');
  if (!res.ok) throw new Error('Address search is unavailable. You can use your current location instead.');
  const body = (await res.json()) as { results: GeocodeResult[] };
  return body.results;
}
