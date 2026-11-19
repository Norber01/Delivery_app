/**
 * Simulated GPS for the demo (in place of the driver app + Realtime Database): each driver on
 * shift moves at city speed toward their next stop (pickup, hub or customer), so the dispatch map
 * and the customer's tracking page show real movement.
 */
import type { DeliveryDoc, DriverLocation, LatLng } from '@courier/shared-types';
import { haversineKm } from '@courier/shared-utils';
import { runQuery } from '../db/query.js';
import { demoNow, theDb } from './core.js';

const LIVE = '_demoLive';
const SPEED_KMH = 22;
const BUSY = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];

interface Anchor {
  shiftId: string;
  activeUntilMs: number;
  lat: number;
  lng: number;
  at: number;
  target: LatLng | null;
  vehicleId?: string;
}

function targetFor(uid: string): LatLng | null {
  const rows = runQuery(theDb(), { collection: 'deliveries', filters: [{ field: 'currentDriverUid', op: '==', value: uid }, { field: 'status', op: 'in', value: BUSY }], orders: [] });
  const jobs = rows.map((r) => r.data as unknown as DeliveryDoc).sort((a, b) => a.expectedDeliveryAt.localeCompare(b.expectedDeliveryAt));
  const plan = theDb().get(`routePlans/${uid}`) as { stops?: { deliveryId: string; location: LatLng }[] } | undefined;
  const next = plan?.stops?.find((s) => jobs.some((j) => j.id === s.deliveryId));
  if (next) return next.location;
  const d = jobs.find((j) => j.status === 'out_for_delivery') ?? jobs[0];
  if (!d) return null;
  if (d.status === 'out_for_delivery' || d.status === 'delivery_failed') return d.destination.location;
  if (d.status === 'picked_up') return d.originHub?.location ?? d.destination.location;
  if (d.status === 'returning_to_sender') return d.pickup.location;
  return d.custodian.type === 'hub' && d.destinationHub ? d.destinationHub.location : d.pickup.location;
}

function move(a: Anchor, now: number): LatLng {
  if (!a.target) return { lat: a.lat, lng: a.lng };
  const dist = haversineKm(a, a.target);
  const travelled = (SPEED_KMH * (now - a.at)) / 3_600_000;
  if (dist < 0.01 || travelled >= dist) return a.target;
  const f = travelled / dist;
  return { lat: a.lat + (a.target.lat - a.lat) * f, lng: a.lng + (a.target.lng - a.lng) * f };
}

function position(uid: string): DriverLocation | null {
  const a = theDb().get(`${LIVE}/${uid}`) as unknown as Anchor | undefined;
  const now = demoNow().getTime();
  if (!a || a.activeUntilMs < now) return null;
  const here = move(a, now);
  const target = targetFor(uid);
  if (JSON.stringify(target) !== JSON.stringify(a.target)) {
    // New destination: re-anchor at the current position.
    theDb().commit([{ type: 'set', path: `${LIVE}/${uid}`, data: { ...a, ...here, at: now, target } }]);
  }
  const moving = a.target && haversineKm(here, a.target) > 0.01;
  return { lat: here.lat, lng: here.lng, accuracyM: 12, speedKph: moving ? SPEED_KMH : 0, recordedAt: now, serverAt: now, shiftId: a.shiftId, ...(a.vehicleId ? { vehicleId: a.vehicleId } : {}) };
}

export const demoLive = {
  async setShift(uid: string, s: { shiftId: string; activeUntilMs: number }) {
    const prev = theDb().get(`${LIVE}/${uid}`) as unknown as Anchor | undefined;
    const driver = theDb().get(`drivers/${uid}`) as { homeServiceAreaId?: string; currentShift?: { vehicleId?: string } } | undefined;
    const area = theDb().get(`serviceAreas/${driver?.homeServiceAreaId ?? 'accra'}`) as { center?: LatLng } | undefined;
    const start = prev ?? { ...(area?.center ?? { lat: 5.6037, lng: -0.187 }) };
    // A small offset per driver so markers do not sit on top of each other.
    const jitter = (uid.charCodeAt(uid.length - 1) % 10) / 400;
    theDb().commit([
      {
        type: 'set',
        path: `${LIVE}/${uid}`,
        data: { shiftId: s.shiftId, activeUntilMs: s.activeUntilMs, lat: start.lat + (prev ? 0 : jitter), lng: start.lng - (prev ? 0 : jitter), at: demoNow().getTime(), target: null, vehicleId: driver?.currentShift?.vehicleId ?? null },
      },
    ]);
  },
  async clearShift(uid: string) {
    theDb().commit([{ type: 'delete', path: `${LIVE}/${uid}` }]);
  },
  async getDriverLocation(uid: string) {
    return position(uid);
  },
};

/** Everything the Realtime Database `driverLocations` node would hold right now. */
export function allPositions(): Record<string, DriverLocation> {
  const out: Record<string, DriverLocation> = {};
  for (const [uid] of theDb().list(LIVE)) {
    const p = position(uid);
    if (p) out[uid] = p;
  }
  return out;
}
