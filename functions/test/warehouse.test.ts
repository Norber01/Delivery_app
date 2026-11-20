/**
 * Same-city flow through the warehouse: a pickup rider brings the parcel in, the warehouse
 * scans it, dispatch assigns a delivery rider, the warehouse hands it over, the delivery rider
 * delivers with the recipient's code. Riders only take the leg their account type allows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import sampleRules from '../../firebase/seed/pricing-rules.sample.json' with { type: 'json' };
import type { PricingRuleSet } from '@courier/shared-types';
import type { Caller } from '../src/lib/auth.js';
import { GUEST } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { hubScan, upsertHub } from '../src/ops/hubService.js';
import { dispatchAction, driverAction, ensureDeliveryForBooking, startShift, updateDriver, type OpsDeps } from '../src/ops/opsService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { meta, site, world, type World } from './helpers.js';
import { MemoryEvidence, MemoryLive, MemoryOpsStore } from './opsMemory.js';

let w: World;
let ops: MemoryOpsStore;
let deps: OpsDeps;
let seq = 0;
const OTP = '246810';

const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const manager: Caller = { uid: 'mgr', role: 'manager', businessId: null, mfa: true };
const disp: Caller = { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true };
const warehouse: Caller = { uid: 'wh', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['acc-01'] };
const rider = (uid: string): Caller => ({ uid, role: 'driver', businessId: null, mfa: false });
const expectCode = async (p: Promise<unknown>, code: string) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
const act = (uid: string, d: string, type: string, extra: Record<string, unknown> = {}) =>
  driverAction(deps, rider(uid), { actionId: `act${String(++seq).padStart(16, '0')}`, deliveryId: d, type, occurredAt: w.clock.now.toISOString(), ...extra });

const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };
const madina = { line1: 'Madina Market', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6681, lng: -0.1653 } };
const kumasi = { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } };
const pkg = [{ description: 'Shoes', weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 10, quantity: 1 }];
const quoteDeps = () => ({ store: w.store, rateLimiter: w.pay.rateLimiter, maps: null, now: () => w.clock.now, newId: () => `quotewh${String(++seq).padStart(10, '0')}` });

async function book(destination = madina) {
  const req = { pickup: osu, destination, packages: pkg, urgency: 'standard', specialHandling: [] };
  const q = await getQuote(quoteDeps(), req, GUEST, meta);
  const b = await createBooking(
    { store: w.store, rateLimiter: w.pay.rateLimiter, now: () => w.clock.now },
    { quoteId: q.quoteId, quote: req, sender: { name: 'Ama Mensah', phone: '0241234567' }, recipient: { name: 'Kofi Boateng', phone: '0501234567' }, paymentPreference: 'cash_on_pickup', acceptTerms: true },
    GUEST,
    meta,
  );
  await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!);
  return b.trackingNumber;
}

const riderDoc = (uid: string, riderType?: 'pickup' | 'delivery') => ({
  uid, name: uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid, homeServiceAreaId: 'accra', status: 'active' as const, currentShift: null, ...(riderType ? { riderType } : {}),
});
const bike = (id: string) => ({ id, registrationNumber: `GR ${id}`, vehicleClass: 'motorbike' as const, capacityKg: 20, homeServiceAreaId: 'accra', status: 'available' as const, currentDriverUid: null });

beforeEach(async () => {
  w = world();
  ops = new MemoryOpsStore(w.store, w.clock);
  seq = 0;
  deps = { ops, live: new MemoryLive(), evidence: new MemoryEvidence(), now: () => w.clock.now, newId: () => `id${++seq}`, newOtp: () => OTP, site, uploads: { workerUrl: 'https://edge.test', secret: 's' } };
  await upsertHub(deps, admin, { id: 'acc-01', code: 'acc-01', name: 'Accra Warehouse', type: 'hub', serviceAreaId: 'accra', city: 'Accra', primaryForArea: true, address: 'Ring Road, Accra', location: { lat: 5.57, lng: -0.21 }, active: true });
  await ops.createDriver(riderDoc('kwame', 'pickup'));
  await ops.createDriver(riderDoc('esi', 'delivery'));
  await ops.upsertVehicle(bike('bike1'));
  await ops.upsertVehicle(bike('bike2'));
  await startShift(deps, rider('kwame'), { vehicleId: 'bike1' });
  await startShift(deps, rider('esi'), { vehicleId: 'bike2' });
});

describe('same city through the warehouse', () => {
  it('pickup rider → warehouse → delivery rider → recipient', async () => {
    const tn = await book();
    const created = ops.deliveries.get(tn)!;
    expect(created.legs.map((l) => l.type)).toEqual(['first_mile', 'last_mile']);
    expect(created.originHub?.id).toBe('acc-01');
    expect(created.destinationHub?.id).toBe('acc-01');

    // Only a pickup rider can take the pickup.
    await expectCode(dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'esi' }), 'WRONG_RIDER_TYPE');
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' });
    await act('kwame', tn, 'start_assignment');
    await act('kwame', tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true });
    expect(ops.deliveries.get(tn)).toMatchObject({ status: 'picked_up', custodian: { type: 'driver', id: 'kwame' } });
    expect(w.store.notifications.some((n) => n.template === 'delivery_otp')).toBe(false); // no code until it leaves the warehouse

    // Warehouse scans it in: it now waits for a delivery rider.
    await hubScan(deps, warehouse, { hubId: 'acc-01', type: 'receive', trackingNumber: tn });
    expect(ops.deliveries.get(tn)).toMatchObject({ status: 'at_destination_hub', custodian: { type: 'hub', id: 'acc-01' }, currentDriverUid: null, currentLegId: 'leg2' });
    expect([...ops.assignments.values()].find((a) => a.driverUid === 'kwame')!.status).toBe('completed');

    // Only a delivery rider can take the delivery; the manager can assign too.
    await expectCode(dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' }), 'WRONG_RIDER_TYPE');
    await dispatchAction(deps, manager, { type: 'assign', deliveryId: tn, driverUid: 'esi' });
    await hubScan(deps, warehouse, { hubId: 'acc-01', type: 'handover', trackingNumber: tn });
    expect(ops.deliveries.get(tn)).toMatchObject({ status: 'out_for_delivery', custodian: { type: 'driver', id: 'esi' } });
    expect(w.store.notifications.find((n) => n.template === 'delivery_otp')!.recipientPhone).toBe('+233501234567');

    await act('esi', tn, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp: OTP, location: madina.location });
    expect(ops.deliveries.get(tn)!.status).toBe('delivered');

    const messages = w.store.events.filter((e) => e.trackingNumber === tn).map((e) => e.publicMessage);
    expect(messages).toContain('At our Accra warehouse');
  });

  it('older rider accounts without a type can still take either leg', async () => {
    await ops.createDriver(riderDoc('yaw'));
    await ops.upsertVehicle(bike('bike3'));
    await startShift(deps, rider('yaw'), { vehicleId: 'bike3' });
    const tn = await book();
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'yaw' });
    expect(ops.deliveries.get(tn)!.currentDriverUid).toBe('yaw');
  });

  it('lets dispatch or the manager switch a rider between pickup and delivery', async () => {
    await updateDriver(deps, manager, { uid: 'esi', riderType: 'pickup' });
    expect(ops.drivers.get('esi')!.riderType).toBe('pickup');
    await updateDriver(deps, disp, { uid: 'esi', riderType: 'delivery' });
    await expectCode(updateDriver(deps, rider('esi'), { uid: 'esi', riderType: 'pickup' }), 'PERMISSION_DENIED');
    await expectCode(updateDriver(deps, disp, { uid: 'nobody', riderType: 'pickup' }), 'NOT_FOUND');
  });

  it('without a warehouse, one rider goes door to door', async () => {
    await upsertHub(deps, admin, { id: 'acc-01', code: 'acc-01', name: 'Accra Warehouse', type: 'hub', serviceAreaId: 'accra', city: 'Accra', primaryForArea: true, address: 'Ring Road, Accra', location: { lat: 5.57, lng: -0.21 }, active: false });
    const tn = await book();
    expect(ops.deliveries.get(tn)!.legs.map((l) => l.type)).toEqual(['direct']);
  });

  it('the sample prices are same-city only: other cities are refused with a clear message', async () => {
    await w.store.publishPricingRules(sampleRules as unknown as PricingRuleSet, { actorUid: null, actorRole: 'system', action: 'pricing.publish', targetType: 'pricingRules' });
    const req = { pickup: osu, destination: kumasi, packages: pkg, urgency: 'standard', specialHandling: [] };
    await expect(getQuote(quoteDeps(), req, GUEST, meta)).rejects.toSatisfy((e: unknown) => (e as AppError).code === 'DESTINATION_NOT_SERVICED' && /only deliver within/.test((e as Error).message));
    await expect(getQuote(quoteDeps(), { ...req, destination: madina }, GUEST, meta)).resolves.toMatchObject({ quote: { deliveryType: 'intra_city' } });
  });
});
