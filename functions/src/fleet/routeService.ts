import type { LatLng, RoutePlanDoc, RoutePlanStop } from '@courier/shared-types';
import { baselineOrder, estimateTravelSec, evaluateOrder, optimiseRoute, type RouteStop } from '@courier/shared-utils';
import { planRouteSchema } from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { DeliveryRecord, LivePort } from '../ops/types.js';
import { parse } from './common.js';
import type { FleetStore } from './types.js';

export interface RouteDeps {
  fleet: FleetStore;
  live: Pick<LivePort, 'getDriverLocation'>;
  now: () => Date;
}

const STALE_LOCATION_MS = 15 * 60_000;

/**
 * The stops a driver still has to make for one delivery. A package the driver already holds
 * needs only its drop; otherwise it is collected first (from the sender, or from the hub for a
 * last-mile leg). Intercity first miles end at the origin hub; returns go back to the sender.
 */
export function stopsFor(d: DeliveryRecord, uid: string): (RouteStop & { label: string; deliveryId: string })[] {
  const leg = d.legs.find((l) => l.id === d.currentLegId);
  if (!leg || leg.type === 'linehaul' || leg.driverUid !== uid) return [];
  const holding = d.custodian.type === 'driver' && d.custodian.id === uid;
  const returning = d.status === 'returning_to_sender';
  const from = leg.type === 'last_mile' && d.destinationHub ? { at: d.destinationHub.location, label: `Collect at ${d.destinationHub.name}` } : { at: d.pickup.location, label: `Collect: ${d.pickup.line1}, ${d.pickup.city}` };
  const to = returning
    ? { at: d.pickup.location, label: `Return to sender: ${d.pickup.line1}` }
    : leg.type === 'first_mile' && d.originHub
      ? { at: d.originHub.location, label: `Drop at ${d.originHub.name}` }
      : { at: d.destination.location, label: `Deliver: ${d.destination.line1}, ${d.destination.city}` };
  const due = Date.parse(d.expectedDeliveryAt);
  const drop = { id: `${d.id}:drop`, deliveryId: d.id, location: to.at, kind: 'drop' as const, label: to.label, ...(leg.type === 'first_mile' ? {} : { dueAt: due }) };
  if (holding) return [drop];
  return [{ id: `${d.id}:pickup`, deliveryId: d.id, location: from.at, kind: 'pickup', label: from.label }, { ...drop, after: `${d.id}:pickup` }];
}

/** Plan (or re-plan) a driver's current run. Dispatch for any driver in scope; drivers for themselves. */
export async function planDriverRoute(deps: RouteDeps, caller: Caller, raw: unknown): Promise<RoutePlanDoc> {
  requireRole(caller, ['driver', 'dispatcher', 'admin', 'super_admin']);
  const input = parse(planRouteSchema, raw);
  const uid = caller.role === 'driver' ? caller.uid : input.driverUid;
  if (!uid) throw new AppError('VALIDATION_FAILED', 'Choose a driver.', 'invalid-argument');
  const driver = await deps.fleet.getDriver(uid);
  if (!driver) throw new AppError('NOT_FOUND', 'Driver not found.', 'not-found');
  if (caller.role === 'dispatcher' && caller.serviceAreaIds?.length && !caller.serviceAreaIds.includes(driver.homeServiceAreaId)) {
    throw new AppError('PERMISSION_DENIED', 'This driver is outside your service areas.', 'permission-denied');
  }
  const deliveries = (await deps.fleet.activeDeliveriesForDriver(uid)).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  const stops = deliveries.flatMap((d) => stopsFor(d, uid));
  const now = deps.now();
  const loc = await deps.live.getDriverLocation(uid);
  const fresh = loc && now.getTime() - loc.recordedAt < STALE_LOCATION_MS;
  const start: LatLng | null = fresh ? { lat: loc.lat, lng: loc.lng } : (stops[0]?.location ?? null);
  const vehicleClass = driver.currentShift?.vehicleClass ?? 'motorbike';
  const base = {
    driverUid: uid,
    startFrom: (fresh ? 'live_location' : 'first_stop') as RoutePlanDoc['startFrom'],
    vehicleClass,
    computedAt: now.toISOString(),
    computedBy: caller.uid,
  };
  if (!start || stops.length === 0) {
    const empty: RoutePlanDoc = { ...base, stops: [], travelMinutes: 0, baselineMinutes: 0, savingPercent: 0, lateStops: 0 };
    await deps.fleet.saveRoutePlan(empty);
    return empty;
  }
  const input2 = { start, stops, departAt: now.getTime(), travelSec: estimateTravelSec(vehicleClass) };
  const plan = optimiseRoute(input2);
  const baseline = evaluateOrder(input2, baselineOrder(stops))!;
  const byId = new Map(stops.map((s) => [s.id, s]));
  const planStops: RoutePlanStop[] = plan.order.map((id, i) => {
    const s = byId.get(id)!;
    const eta = plan.arrivals[id]!;
    return {
      seq: i + 1,
      deliveryId: s.deliveryId,
      kind: s.kind,
      label: s.label,
      location: s.location,
      eta: new Date(eta).toISOString(),
      dueAt: s.dueAt !== undefined ? new Date(s.dueAt).toISOString() : null,
      late: s.dueAt !== undefined && eta > s.dueAt,
    };
  });
  const doc: RoutePlanDoc = {
    ...base,
    stops: planStops,
    travelMinutes: Math.round(plan.travelSec / 60),
    baselineMinutes: Math.round(baseline.travelSec / 60),
    savingPercent: baseline.travelSec > 0 ? Math.max(0, Math.round((1 - plan.travelSec / baseline.travelSec) * 100)) : 0,
    lateStops: planStops.filter((s) => s.late).length,
  };
  await deps.fleet.saveRoutePlan(doc);
  return doc;
}
