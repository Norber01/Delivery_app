import type { LatLng, ServiceArea } from '@courier/shared-types';

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The active service area containing a point. If areas overlap, the one whose
 * centre is closest wins, so assignment is deterministic.
 */
export function findServiceArea(point: LatLng, areas: readonly ServiceArea[]): ServiceArea | null {
  let best: { area: ServiceArea; d: number } | null = null;
  for (const area of areas) {
    if (!area.active) continue;
    const d = haversineKm(point, area.center);
    if (d <= area.radiusKm && (!best || d < best.d)) best = { area, d };
  }
  return best?.area ?? null;
}

/** Round distance up to 0.1 km so pricing is stable and never under-charges. */
export function roundDistanceKm(km: number): number {
  return Math.ceil(km * 10) / 10;
}
