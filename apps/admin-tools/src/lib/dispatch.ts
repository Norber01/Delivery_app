import { RIDER_TYPE_LABELS, VEHICLE_RANK, type DeliveryStatus, type RiderType } from '@courier/constants';
import type { DeliveryDoc, DriverDoc, DriverLocation, LocationFreshness } from '@courier/shared-types';
import { distanceMeters, locationFreshness } from '@courier/shared-utils';

export const ACTIVE_STATUSES: DeliveryStatus[] = [
  'awaiting_assignment',
  'assigned',
  'en_route_to_pickup',
  'picked_up',
  'out_for_delivery',
  'pickup_failed',
  'delivery_failed',
  'returning_to_sender',
  'on_hold',
  'at_origin_hub',
  'in_transit',
  'at_destination_hub',
];

/**
 * The order board, left to right, follows the parcel:
 * needs a pickup rider → being picked up → at the warehouse (needs / waiting for a delivery rider)
 * → out for delivery; anything that went wrong is under "Problems".
 */
export type BoardColumn = 'needs_pickup' | 'picking_up' | 'at_warehouse' | 'delivering' | 'problems';

export const COLUMN_TITLE: Record<BoardColumn, string> = {
  needs_pickup: 'Needs pickup rider',
  picking_up: 'Being picked up',
  at_warehouse: 'At warehouse',
  delivering: 'Out for delivery',
  problems: 'Problems',
};

export function columnFor(d: Pick<DeliveryDoc, 'status' | 'openException'> & Partial<Pick<DeliveryDoc, 'currentAssignmentId'>>): BoardColumn {
  if (d.status === 'pickup_failed' || d.status === 'delivery_failed' || d.status === 'on_hold' || d.openException) return 'problems';
  if (d.status === 'awaiting_assignment') return 'needs_pickup';
  if (d.status === 'assigned' || d.status === 'en_route_to_pickup' || d.status === 'picked_up') return 'picking_up';
  if (d.status === 'at_origin_hub' || d.status === 'at_destination_hub' || d.status === 'in_transit') return 'at_warehouse';
  return 'delivering';
}

/** Which kind of rider the delivery needs next (null: a rider of either type, or none). */
export function riderNeeded(d: Pick<DeliveryDoc, 'legs' | 'currentLegId'>): RiderType | null {
  const leg = d.legs.find((l) => l.id === d.currentLegId)?.type;
  return leg === 'first_mile' ? 'pickup' : leg === 'last_mile' ? 'delivery' : null;
}

export interface DriverOption {
  driver: DriverDoc;
  eligible: boolean;
  reason: string | null;
  distanceKm: number | null;
  freshness: LocationFreshness | null;
  activeJobs: number;
}

/**
 * Drivers for an assignment: eligible ones first (same area, vehicle big enough, live shift),
 * nearest to the pickup by live GPS, then by workload. Mirrors the server's checks so the
 * dispatcher sees why a driver cannot take a job; the server still enforces them.
 */
export function rankDrivers(
  delivery: Pick<DeliveryDoc, 'serviceAreaId' | 'requiredVehicleClass' | 'pickup'>,
  drivers: DriverDoc[],
  locations: Record<string, DriverLocation>,
  activeJobs: Record<string, number>,
  nowMs: number,
  riderType: RiderType | null = null,
): DriverOption[] {
  const options = drivers.map((driver): DriverOption => {
    const shift = driver.currentShift;
    const loc = locations[driver.uid];
    const usableLoc = loc && shift && loc.shiftId === shift.id ? loc : null;
    let reason: string | null = null;
    if (driver.status !== 'active') reason = 'Suspended';
    else if (riderType && driver.riderType && driver.riderType !== riderType) reason = RIDER_TYPE_LABELS[driver.riderType];
    else if (!shift || new Date(shift.activeUntil).getTime() <= nowMs) reason = 'Not on shift';
    else if (shift.serviceAreaId !== delivery.serviceAreaId) reason = 'Different service area';
    else if (delivery.requiredVehicleClass && VEHICLE_RANK[shift.vehicleClass] < VEHICLE_RANK[delivery.requiredVehicleClass]) {
      reason = `Needs ${delivery.requiredVehicleClass}`;
    }
    return {
      driver,
      eligible: reason === null,
      reason,
      distanceKm: usableLoc ? Math.round(distanceMeters(usableLoc, delivery.pickup.location) / 100) / 10 : null,
      freshness: usableLoc ? locationFreshness(usableLoc.serverAt, nowMs) : null,
      activeJobs: activeJobs[driver.uid] ?? 0,
    };
  });
  const score = (o: DriverOption) => (o.distanceKm !== null && o.freshness !== 'stale' ? o.distanceKm : 1e6) + o.activeJobs * 2;
  return options.sort((a, b) => Number(b.eligible) - Number(a.eligible) || score(a) - score(b) || a.driver.name.localeCompare(b.driver.name));
}

/** Count of a driver's open jobs from the board's active deliveries. */
export function countActiveJobs(deliveries: Pick<DeliveryDoc, 'currentDriverUid' | 'status'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of deliveries) {
    if (d.currentDriverUid && ['assigned', 'en_route_to_pickup', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'].includes(d.status)) {
      out[d.currentDriverUid] = (out[d.currentDriverUid] ?? 0) + 1;
    }
  }
  return out;
}
