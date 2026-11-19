import type { VehicleDoc } from '@courier/shared-types';
import { describe, expect, it } from 'vitest';
import { fuelStats, maintenanceStatus } from './maintenance.js';

const now = new Date('2026-11-19T08:00:00Z');
const v = (p: Partial<VehicleDoc>): VehicleDoc => ({ id: 'v', registrationNumber: 'GR-1-26', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null, ...p });

describe('maintenance status', () => {
  it('is ok with no schedule', () => expect(maintenanceStatus(v({}), now)).toEqual({ state: 'ok', documentsExpired: false, reasons: [] }));
  it('warns before and flags after the service distance', () => {
    expect(maintenanceStatus(v({ serviceIntervalKm: 3000, lastServiceKm: 10_000, odometerKm: 12_700 }), now).state).toBe('due_soon');
    const s = maintenanceStatus(v({ serviceIntervalKm: 3000, lastServiceKm: 10_000, odometerKm: 13_250 }), now);
    expect(s.state).toBe('overdue');
    expect(s.reasons[0]).toBe('Service overdue by 250 km');
    expect(s.documentsExpired).toBe(false);
  });
  it('flags a service overdue by date', () => {
    expect(maintenanceStatus(v({ serviceIntervalDays: 90, lastServiceAt: '2026-08-01T00:00:00Z' }), now).state).toBe('overdue');
    expect(maintenanceStatus(v({ serviceIntervalDays: 90, lastServiceAt: '2026-08-25T00:00:00Z' }), now).state).toBe('due_soon');
  });
  it('treats lapsed insurance or roadworthiness as documents expired', () => {
    const s = maintenanceStatus(v({ insuranceExpiry: '2026-11-18T23:59:59Z', roadworthyExpiry: '2026-11-25T00:00:00Z' }), now);
    expect(s).toMatchObject({ state: 'overdue', documentsExpired: true });
    expect(s.reasons).toEqual(['Insurance expired 2026-11-18', 'Roadworthy certificate expires 2026-11-25']);
  });
});

describe('fuel stats', () => {
  const fill = (odometerKm: number, litres: number, cedis: number, fullTank = true, day = 1) => ({ odometerKm, litres, amountPesewas: cedis * 100, fullTank, filledAt: `2026-11-${String(day).padStart(2, '0')}T08:00:00Z` });
  it('measures full-tank to full-tank efficiency and cost per km', () => {
    // 10 000 → 10 300 km on 5 + 5 litres bought after the first full fill.
    const s = fuelStats([fill(10_000, 6, 90, true, 1), fill(10_150, 5, 75, false, 3), fill(10_300, 5, 75, true, 5)]);
    expect(s).toEqual({ litres: 16, spendPesewas: 24_000, km: 300, kmPerLitre: 30, costPerKmPesewas: 50 });
  });
  it('gives no efficiency without two full fills', () => {
    expect(fuelStats([fill(100, 5, 75, false), fill(200, 5, 75, true)]).kmPerLitre).toBeNull();
    expect(fuelStats([]).costPerKmPesewas).toBeNull();
  });
});
