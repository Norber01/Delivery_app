import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref, serverTimestamp, set } from 'firebase/database';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;
const mfa = { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } };
const point = () => ({ lat: 5.6, lng: -0.18, accuracyM: 12, recordedAt: Date.now(), serverAt: serverTimestamp(), shiftId: 'shift1' });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-courier',
    database: { rules: readFileSync(resolve(__dirname, '../../database.rules.json'), 'utf8') },
  });
});
afterAll(() => env.cleanup());
beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), 'shifts/drv1'), { activeUntil: Date.now() + 3_600_000, shiftId: 'shift1' });
    await set(ref(ctx.database(), 'shifts/drv2'), { activeUntil: Date.now() - 1000, shiftId: 'shift2' });
  });
});

const db = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, claims).database();

describe('driver location writes', () => {
  it('a driver on an active shift can write their own location', async () => {
    await assertSucceeds(set(ref(db('drv1', { role: 'driver' }), 'driverLocations/drv1'), point()));
  });
  it('cannot write another driver’s location', async () => {
    await assertFails(set(ref(db('drv1', { role: 'driver' }), 'driverLocations/drv2'), point()));
  });
  it('cannot write after the shift authorisation expired', async () => {
    await assertFails(set(ref(db('drv2', { role: 'driver' }), 'driverLocations/drv2'), { ...point(), shiftId: 'shift2' }));
  });
  it('non-drivers cannot write locations', async () => {
    await assertFails(set(ref(db('drv1', { role: 'customer' }), 'driverLocations/drv1'), point()));
  });
  it('rejects coordinates outside Ghana, unknown fields and client-chosen server time', async () => {
    const d = db('drv1', { role: 'driver' });
    await assertFails(set(ref(d, 'driverLocations/drv1'), { ...point(), lat: 51.5 }));
    await assertFails(set(ref(d, 'driverLocations/drv1'), { ...point(), extra: 1 }));
    await assertFails(set(ref(d, 'driverLocations/drv1'), { ...point(), serverAt: 1 }));
    await assertFails(set(ref(d, 'driverLocations/drv1'), { ...point(), shiftId: 'other' }));
  });
  it('drivers cannot extend their own shift', async () => {
    await assertFails(set(ref(db('drv2', { role: 'driver' }), 'shifts/drv2/activeUntil'), Date.now() + 9e6));
  });
});

describe('driver location reads', () => {
  it('dispatchers with MFA can read; customers and drivers cannot', async () => {
    await assertSucceeds(get(ref(db('d', { role: 'dispatcher', ...mfa }), 'driverLocations')));
    await assertFails(get(ref(db('d', { role: 'dispatcher' }), 'driverLocations')));
    await assertFails(get(ref(db('c', { role: 'customer' }), 'driverLocations/drv1')));
    await assertFails(get(ref(db('drv1', { role: 'driver' }), 'driverLocations')));
  });
});
