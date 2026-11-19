import { MAINTENANCE_WARNING } from '@courier/constants';
import type { FuelLog, VehicleDoc } from '@courier/shared-types';

export interface MaintenanceState {
  state: 'ok' | 'due_soon' | 'overdue';
  /** True when insurance or roadworthiness has lapsed: the vehicle must not be driven. */
  documentsExpired: boolean;
  reasons: string[];
}

const DAY = 86_400_000;

/** Service and legal-document status of a vehicle (shown on the Fleet page, enforced at shift start). */
export function maintenanceStatus(v: VehicleDoc, now: Date): MaintenanceState {
  const reasons: string[] = [];
  let state: MaintenanceState['state'] = 'ok';
  let documentsExpired = false;
  const bump = (s: MaintenanceState['state']) => {
    if (s === 'overdue' || (s === 'due_soon' && state === 'ok')) state = s;
  };
  for (const [label, iso] of [['Insurance', v.insuranceExpiry], ['Roadworthy certificate', v.roadworthyExpiry]] as const) {
    if (!iso) continue;
    const left = Date.parse(iso) - now.getTime();
    if (left < 0) {
      documentsExpired = true;
      bump('overdue');
      reasons.push(`${label} expired ${iso.slice(0, 10)}`);
    } else if (left < MAINTENANCE_WARNING.days * DAY) {
      bump('due_soon');
      reasons.push(`${label} expires ${iso.slice(0, 10)}`);
    }
  }
  const odo = v.odometerKm ?? null;
  if (v.serviceIntervalKm && odo !== null) {
    const since = odo - (v.lastServiceKm ?? 0);
    const left = v.serviceIntervalKm - since;
    if (left <= 0) {
      bump('overdue');
      reasons.push(`Service overdue by ${-left} km`);
    } else if (left <= MAINTENANCE_WARNING.km) {
      bump('due_soon');
      reasons.push(`Service due in ${left} km`);
    }
  }
  if (v.serviceIntervalDays && v.lastServiceAt) {
    const due = Date.parse(v.lastServiceAt) + v.serviceIntervalDays * DAY;
    const left = due - now.getTime();
    if (left <= 0) {
      bump('overdue');
      reasons.push(`Service overdue since ${new Date(due).toISOString().slice(0, 10)}`);
    } else if (left <= MAINTENANCE_WARNING.days * DAY) {
      bump('due_soon');
      reasons.push(`Service due ${new Date(due).toISOString().slice(0, 10)}`);
    }
  }
  if ((v.serviceIntervalKm || v.serviceIntervalDays) && !v.lastServiceAt && v.lastServiceKm == null) reasons.push('No service recorded yet');
  return { state, documentsExpired, reasons };
}

export interface FuelStats {
  litres: number;
  spendPesewas: number;
  /** Distance covered between the first and last fill-up. */
  km: number;
  /** Full-tank to full-tank efficiency (most reliable), else null. */
  kmPerLitre: number | null;
  costPerKmPesewas: number | null;
}

/**
 * Fuel efficiency from fill-ups. Between two full-tank fills, the fuel used is everything bought
 * after the first full fill up to and including the second; the distance is the odometer change.
 */
export function fuelStats(logs: Pick<FuelLog, 'litres' | 'amountPesewas' | 'odometerKm' | 'fullTank' | 'filledAt'>[]): FuelStats {
  const sorted = [...logs].sort((a, b) => a.odometerKm - b.odometerKm || a.filledAt.localeCompare(b.filledAt));
  const litres = sorted.reduce((n, l) => n + l.litres, 0);
  const spend = sorted.reduce((n, l) => n + l.amountPesewas, 0);
  const km = sorted.length > 1 ? sorted.at(-1)!.odometerKm - sorted[0]!.odometerKm : 0;
  const fulls = sorted.map((l, i) => (l.fullTank ? i : -1)).filter((i) => i >= 0);
  let kmPerLitre: number | null = null;
  if (fulls.length >= 2) {
    const a = fulls[0]!;
    const b = fulls.at(-1)!;
    const used = sorted.slice(a + 1, b + 1).reduce((n, l) => n + l.litres, 0);
    const dist = sorted[b]!.odometerKm - sorted[a]!.odometerKm;
    if (used > 0 && dist > 0) kmPerLitre = Math.round((dist / used) * 10) / 10;
  }
  // Fuel bought at the first fill-up is burnt after it, so it does not count towards this distance.
  const costPerKm = km > 0 ? Math.round((spend - sorted[0]!.amountPesewas) / km) : null;
  return { litres: Math.round(litres * 10) / 10, spendPesewas: spend, km, kmPerLitre, costPerKmPesewas: costPerKm };
}
