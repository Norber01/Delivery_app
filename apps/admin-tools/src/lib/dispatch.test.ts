import type { DriverDoc } from '@courier/shared-types';
import { describe, expect, it } from 'vitest';
import { columnFor, countActiveJobs, rankDrivers } from './dispatch';

const now = Date.parse('2026-11-15T10:00:00Z');
const driver = (uid: string, vehicleClass: 'motorbike' | 'car' | 'van', area = 'accra', active = true): DriverDoc => ({
  uid,
  name: uid,
  phone: '',
  email: '',
  employeeNumber: uid,
  homeServiceAreaId: area,
  status: 'active',
  currentShift: active
    ? { id: `s-${uid}`, vehicleId: `v-${uid}`, vehicleClass, serviceAreaId: area, startedAt: '', activeUntil: '2026-11-15T20:00:00Z' }
    : null,
});
const delivery = { serviceAreaId: 'accra', requiredVehicleClass: 'car' as const, pickup: { location: { lat: 5.556, lng: -0.1823 } } as never };
const loc = (uid: string, lat: number, ageS = 10) => ({ lat, lng: -0.1823, accuracyM: 5, recordedAt: 0, serverAt: now - ageS * 1000, shiftId: `s-${uid}` });

describe('rankDrivers', () => {
  it('puts eligible drivers first, nearest first, and explains ineligibility', () => {
    const r = rankDrivers(
      delivery,
      [driver('bike', 'motorbike'), driver('far', 'van'), driver('near', 'car'), driver('off', 'van', 'accra', false), driver('ksi', 'van', 'kumasi')],
      { far: loc('far', 5.66), near: loc('near', 5.57), bike: loc('bike', 5.556) },
      {},
      now,
    );
    expect(r.map((o) => o.driver.uid)).toEqual(['near', 'far', 'bike', 'ksi', 'off']);
    expect(r.find((o) => o.driver.uid === 'bike')!.reason).toBe('Needs car');
    expect(r.find((o) => o.driver.uid === 'ksi')!.reason).toBe('Different service area');
    expect(r.find((o) => o.driver.uid === 'off')!.reason).toBe('Not on shift');
    expect(r[0]!.distanceKm).toBeCloseTo(1.6, 1);
  });

  it('ignores positions from another shift and penalises workload', () => {
    const stray = { ...loc('a', 5.556), shiftId: 'old' };
    const r = rankDrivers(delivery, [driver('a', 'car'), driver('b', 'car')], { a: stray, b: loc('b', 5.6) }, { b: 1 }, now);
    expect(r[0]!.driver.uid).toBe('b');
    expect(r[1]!.distanceKm).toBeNull();
  });
});

describe('board helpers', () => {
  it('sorts deliveries into columns', () => {
    expect(columnFor({ status: 'awaiting_assignment', openException: null })).toBe('needs_driver');
    expect(columnFor({ status: 'out_for_delivery', openException: null })).toBe('in_progress');
    expect(columnFor({ status: 'delivery_failed', openException: 'refused' })).toBe('exceptions');
    expect(columnFor({ status: 'at_destination_hub', openException: null, currentAssignmentId: null })).toBe('needs_driver');
    expect(columnFor({ status: 'at_destination_hub', openException: null, currentAssignmentId: 'as1' })).toBe('in_progress');
    expect(columnFor({ status: 'in_transit', openException: 'missing_in_transit' })).toBe('exceptions');
  });
  it('counts open jobs per driver', () => {
    expect(countActiveJobs([{ currentDriverUid: 'a', status: 'assigned' }, { currentDriverUid: 'a', status: 'delivered' }, { currentDriverUid: null, status: 'awaiting_assignment' }])).toEqual({ a: 1 });
  });
});
