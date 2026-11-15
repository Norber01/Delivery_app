import { beforeEach, describe, expect, it } from 'vitest';
import type { DriverDoc } from '@courier/shared-types';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import {
  createDriverAccount,
  dispatchAction,
  driverAction,
  endShift,
  ensureDeliveryForBooking,
  flagDelayedDeliveries,
  requestUpload,
  startShift,
  upsertVehicle,
  type OpsDeps,
} from '../src/ops/opsService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { meta, quoteReq, site, world, type World } from './helpers.js';
import { MemoryEvidence, MemoryLive, MemoryOpsStore } from './opsMemory.js';

let w: World;
let ops: MemoryOpsStore;
let live: MemoryLive;
let evidence: MemoryEvidence;
let deps: OpsDeps;
let seq = 0;
let otp = '123456';

const dispatcher: Caller = { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true };
const kwame: Caller = { uid: 'kwame', role: 'driver', businessId: null, mfa: false };
const esi: Caller = { uid: 'esi', role: 'driver', businessId: null, mfa: false };
const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
const act = (caller: Caller, deliveryId: string, type: string, extra: Record<string, unknown> = {}) =>
  driverAction(deps, caller, { actionId: `act${String(++seq).padStart(16, '0')}`, deliveryId, type, occurredAt: w.clock.now.toISOString(), ...extra });
const dispatch = (type: string, deliveryId: string, extra: Record<string, unknown> = {}) => dispatchAction(deps, dispatcher, { type, deliveryId, ...extra });
const sig = [Array.from({ length: 12 }, (_, i) => [i / 12, 0.5])];

function driver(uid: string, area = 'accra'): DriverDoc {
  return { uid, name: uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid.toUpperCase(), homeServiceAreaId: area, status: 'active', currentShift: null };
}

beforeEach(async () => {
  w = world();
  ops = new MemoryOpsStore(w.store, w.clock);
  live = new MemoryLive();
  evidence = new MemoryEvidence();
  seq = 0;
  otp = '123456';
  deps = {
    ops,
    live,
    evidence,
    now: () => w.clock.now,
    newId: () => `id${++seq}`,
    newOtp: () => otp,
    site,
    uploads: { workerUrl: 'https://edge.test', secret: 'upload-secret' },
  };
  await ops.createDriver(driver('kwame'));
  await ops.createDriver(driver('esi'));
  await ops.upsertVehicle({ id: 'bike1', registrationNumber: 'M-22-GR 101', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
  await ops.upsertVehicle({ id: 'van1', registrationNumber: 'GR 2020-24', vehicleClass: 'van', capacityKg: 1000, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
});

/** Cash booking (confirmed at creation) → delivery. */
async function cashDelivery() {
  const b = await w.book(GUEST, 'cash_on_pickup');
  await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!);
  return b;
}

async function outForDelivery() {
  const b = await cashDelivery();
  await startShift(deps, kwame, { vehicleId: 'bike1' });
  await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
  await act(kwame, b.trackingNumber, 'start_assignment');
  await act(kwame, b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber, cashCollected: true });
  return b;
}

describe('delivery creation', () => {
  it('creates one direct-leg delivery for a confirmed booking', async () => {
    const b = await cashDelivery();
    const d = ops.deliveries.get(b.trackingNumber)!;
    expect(d).toMatchObject({ status: 'awaiting_assignment', serviceAreaId: 'accra', requiredVehicleClass: 'motorbike', collectOnPickupPesewas: b.total });
    expect(d.legs).toEqual([expect.objectContaining({ type: 'direct', status: 'planned' })]);
    expect(new Date(d.expectedDeliveryAt).getTime() - w.clock.now.getTime()).toBe(48 * 3600_000);
    expect(await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!)).toBe('not_ready'); // already linked
    expect(w.store.bookings.get(b.trackingNumber)!.deliveryId).toBe(b.trackingNumber);
  });

  it('waits for payment on online bookings', async () => {
    const b = await w.book(GUEST, 'mobile_money');
    expect(await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!)).toBe('not_ready');
  });
});

describe('shifts', () => {
  it('starts a shift, authorises GPS, and reserves the vehicle', async () => {
    const shift = await startShift(deps, kwame, { vehicleId: 'bike1' });
    expect(shift).toMatchObject({ vehicleClass: 'motorbike', serviceAreaId: 'accra' });
    expect(live.shifts.get('kwame')?.shiftId).toBe(shift.id);
    expect(ops.vehicles.get('bike1')).toMatchObject({ status: 'in_use', currentDriverUid: 'kwame' });
    await expectCode(startShift(deps, esi, { vehicleId: 'bike1' }), 'VEHICLE_UNAVAILABLE');
    await expectCode(startShift(deps, kwame, { vehicleId: 'van1' }), 'SHIFT_ACTIVE');
    expect((await startShift(deps, kwame, { vehicleId: 'bike1' })).id).toBe(shift.id); // resume
  });

  it('cannot end a shift while holding a package; ending clears the live location', async () => {
    const b = await outForDelivery();
    live.locations.set('kwame', { lat: 5.6, lng: -0.18, accuracyM: 5, recordedAt: 0, serverAt: 0, shiftId: 'x' });
    await expectCode(endShift(deps, kwame), 'SHIFT_ACTIVE');
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp });
    expect(await endShift(deps, kwame)).toEqual({ ended: true });
    expect(live.locations.has('kwame')).toBe(false);
    expect(ops.vehicles.get('bike1')!.status).toBe('available');
  });

  it('suspended drivers cannot start shifts', async () => {
    ops.drivers.get('esi')!.status = 'suspended';
    await expectCode(startShift(deps, esi, { vehicleId: 'van1' }), 'DRIVER_UNAVAILABLE');
  });
});

describe('dispatch', () => {
  it('assigns only to on-shift drivers with a big-enough vehicle in the same area', async () => {
    const b = await cashDelivery();
    await expectCode(dispatch('assign', b.trackingNumber, { driverUid: 'kwame' }), 'DRIVER_UNAVAILABLE'); // no shift
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    ops.deliveries.get(b.trackingNumber)!.requiredVehicleClass = 'car';
    await expectCode(dispatch('assign', b.trackingNumber, { driverUid: 'kwame' }), 'VEHICLE_TOO_SMALL');
    await startShift(deps, esi, { vehicleId: 'van1' });
    expect((await dispatch('assign', b.trackingNumber, { driverUid: 'esi' })).status).toBe('assigned');
    const d = ops.deliveries.get(b.trackingNumber)!;
    expect(d.driverUids).toEqual(['esi']);
    expect(ops.assignments.get(d.currentAssignmentId!)).toMatchObject({ driverUid: 'esi', vehicleId: 'van1', status: 'assigned' });
    expect(w.store.events.at(-1)).toMatchObject({ type: 'assigned', publicMessage: 'Driver assigned' });
  });

  it('refuses drivers from another service area and enforces dispatcher scope', async () => {
    const b = await cashDelivery();
    ops.drivers.get('esi')!.homeServiceAreaId = 'kumasi';
    await startShift(deps, esi, { vehicleId: 'van1' });
    await expectCode(dispatch('assign', b.trackingNumber, { driverUid: 'esi' }), 'DRIVER_UNAVAILABLE');
    await expectCode(dispatchAction(deps, { ...dispatcher, serviceAreaIds: ['kumasi'] }, { type: 'hold', deliveryId: b.trackingNumber, reason: 'Weather' }), 'PERMISSION_DENIED');
  });

  it('requires a dispatcher with MFA', async () => {
    const b = await cashDelivery();
    await expectCode(dispatchAction(deps, { ...dispatcher, mfa: false }, { type: 'hold', deliveryId: b.trackingNumber, reason: 'x x x' }), 'MFA_REQUIRED');
    await expectCode(dispatchAction(deps, kwame, { type: 'hold', deliveryId: b.trackingNumber, reason: 'x x x' }), 'PERMISSION_DENIED');
  });

  it('refuses intercity assignment until hubs and a route are configured', async () => {
    const q = await import('../src/services/quoteService.js');
    const bk = await import('../src/services/bookingService.js');
    const kumasi = { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } };
    const req = { ...quoteReq, destination: kumasi };
    const quote = await q.getQuote({ store: w.store, rateLimiter: w.pay.rateLimiter, maps: null, now: () => w.clock.now, newId: () => 'qintercity00001' }, req, GUEST, meta);
    const r = await bk.createBooking(
      { store: w.store, rateLimiter: w.pay.rateLimiter, now: () => w.clock.now },
      { quoteId: quote.quoteId, quote: req, sender: { name: 'Ama', phone: '0241234567' }, recipient: { name: 'Yaw', phone: '0201234567' }, paymentPreference: 'cash_on_pickup', acceptTerms: true },
      GUEST,
      meta,
    );
    await ensureDeliveryForBooking(deps, w.store.bookings.get(r.trackingNumber)!);
    expect(ops.deliveries.get(r.trackingNumber)!.legs.map((l) => l.type)).toEqual(['first_mile', 'linehaul', 'last_mile']);
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await expectCode(dispatch('assign', r.trackingNumber, { driverUid: 'kwame' }), 'HUB_NOT_CONFIGURED');
  });

  it('unassigns before start, cancels before pickup (cancelling the booking), and holds/releases', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    await dispatch('hold', b.trackingNumber, { reason: 'Customer asked to wait' });
    expect(ops.deliveries.get(b.trackingNumber)).toMatchObject({ status: 'on_hold', heldFrom: 'assigned' });
    await dispatch('release', b.trackingNumber);
    expect(ops.deliveries.get(b.trackingNumber)!.status).toBe('assigned');
    await dispatch('unassign', b.trackingNumber);
    expect(ops.deliveries.get(b.trackingNumber)).toMatchObject({ status: 'awaiting_assignment', currentDriverUid: null });
    await dispatch('cancel', b.trackingNumber, { reason: 'Customer cancelled' });
    expect(ops.deliveries.get(b.trackingNumber)!.status).toBe('cancelled');
    expect(w.store.bookings.get(b.trackingNumber)!.status).toBe('cancelled');
  });

  it('cannot cancel once the package is collected', async () => {
    const b = await outForDelivery();
    await expectCode(dispatch('cancel', b.trackingNumber, { reason: 'Too late now' }), 'INVALID_TRANSITION');
  });
});

describe('driver workflow', () => {
  it('runs pickup (with cash) to OTP delivery end to end', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    await expectCode(act(esi, b.trackingNumber, 'start_assignment'), 'NOT_ASSIGNED_TO_YOU');
    await act(kwame, b.trackingNumber, 'start_assignment');
    await expectCode(act(kwame, b.trackingNumber, 'confirm_pickup', { scannedCode: 'GH000000000000' }), 'WRONG_PACKAGE');
    await expectCode(act(kwame, b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber }), 'CASH_NOT_CONFIRMED');
    await act(kwame, b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber.toLowerCase(), cashCollected: true });

    const d = ops.deliveries.get(b.trackingNumber)!;
    expect(d).toMatchObject({ status: 'out_for_delivery', custodian: { type: 'driver', id: 'kwame' }, collectOnPickupPesewas: 0 });
    expect(w.store.bookings.get(b.trackingNumber)!.paymentStatus).toBe('paid');
    expect(w.store.payments.get(`cash_${b.trackingNumber}`)).toMatchObject({ provider: 'cash', amountPesewas: b.total, collectedBy: 'kwame' });
    const otpSms = w.store.notifications.find((n) => n.template === 'delivery_otp')!;
    expect(otpSms.recipientPhone).toBe('+233501234567');
    expect(otpSms.body).toContain('123456');
    expect(ops.podSecrets.get(b.trackingNumber)!.otpHash).not.toContain('123456');

    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '000000' }), 'OTP_INVALID');
    expect(ops.podSecrets.get(b.trackingNumber)!.attempts).toBe(1);
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp, location: { lat: 5.6681, lng: -0.1653 } });

    expect(ops.deliveries.get(b.trackingNumber)).toMatchObject({ status: 'delivered', custodian: { type: 'none' } });
    expect(ops.pods.get(b.trackingNumber)).toMatchObject({ method: 'otp', otpVerified: true, receivedByName: 'Kofi Boateng', flaggedFarFromDestination: false });
    expect(ops.podSecrets.has(b.trackingNumber)).toBe(false);
    expect([...ops.assignments.values()][0]!.status).toBe('completed');
    const publicTypes = w.store.events.filter((e) => e.trackingNumber === b.trackingNumber).map((e) => e.type);
    expect(publicTypes).toEqual(['booking_created', 'assigned', 'en_route_to_pickup', 'picked_up', 'payment_received', 'out_for_delivery', 'delivered']);
    expect(w.store.events.find((e) => e.type === 'delivered')!.publicMessage).not.toContain('Kofi');
    expect(w.store.notifications.some((n) => n.template === 'delivered' && n.recipientPhone === '+233241234567')).toBe(true);
  });

  it('applies a replayed action once (offline queue)', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    const body = { actionId: 'offline-action-0001', deliveryId: b.trackingNumber, type: 'start_assignment', occurredAt: w.clock.now.toISOString() };
    const first = await driverAction(deps, kwame, body);
    const again = await driverAction(deps, kwame, body);
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, status: 'en_route_to_pickup' });
    expect(w.store.events.filter((e) => e.type === 'en_route_to_pickup')).toHaveLength(1);
    await expectCode(driverAction(deps, esi, body), 'PERMISSION_DENIED');
    // Same id, different action/delivery: rejected, never a false success.
    await expectCode(driverAction(deps, kwame, { ...body, type: 'confirm_pickup', scannedCode: b.trackingNumber }), 'VALIDATION_FAILED');
    await expectCode(driverAction(deps, kwame, { ...body, deliveryId: 'GHOTHER' }), 'VALIDATION_FAILED');
  });

  it('flags POD captured far from the destination', async () => {
    const b = await outForDelivery();
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp, location: { lat: 5.6, lng: -0.2 } });
    expect(ops.pods.get(b.trackingNumber)!.flaggedFarFromDestination).toBe(true);
    expect(w.store.audit.some((a) => a.action === 'pod.far_from_destination')).toBe(true);
  });

  it('locks the code after 5 wrong attempts and then requires signature + uploaded photo', async () => {
    const b = await outForDelivery();
    for (let i = 0; i < 4; i++) await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '999999' }), 'OTP_INVALID');
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '999999' }), 'OTP_LOCKED');
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp }), 'OTP_LOCKED');
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', signature: sig }), 'EVIDENCE_REQUIRED');

    const ticket = await requestUpload(deps, kwame, { deliveryId: b.trackingNumber, contentType: 'image/jpeg', bytes: 200_000 });
    expect(ticket.key).toMatch(new RegExp(`^pod/${b.trackingNumber}/[A-Za-z0-9]{20}\\.jpg$`));
    expect(new URL(ticket.uploadUrl).searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    // Key issued but not uploaded yet.
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', signature: sig, photoKeys: [ticket.key] }), 'UPLOAD_NOT_FOUND');
    evidence.objects.add(ticket.key);
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', signature: sig, photoKeys: [ticket.key] });
    expect(ops.pods.get(b.trackingNumber)).toMatchObject({ method: 'signature', otpVerified: false, photoKeys: [ticket.key] });
  });

  it('requires a photo for high-value deliveries', async () => {
    const b = await outForDelivery();
    ops.deliveries.get(b.trackingNumber)!.specialHandling = ['high_value'];
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp }), 'EVIDENCE_REQUIRED');
  });

  it('rejects photo keys issued to another driver or delivery', async () => {
    const b = await outForDelivery();
    await expectCode(requestUpload(deps, esi, { deliveryId: b.trackingNumber, contentType: 'image/jpeg', bytes: 1000 }), 'NOT_ASSIGNED_TO_YOU');
    const forged = `pod/${b.trackingNumber}/AAAAAAAAAAAAAAAAAAAA.jpg`;
    evidence.objects.add(forged);
    await expectCode(act(kwame, b.trackingNumber, 'report_delivery_failed', { reason: 'refused', photoKeys: [forged] }), 'UPLOAD_NOT_FOUND');
  });

  it('handles failed delivery → reattempt with a new code → delivered', async () => {
    const b = await outForDelivery();
    await act(kwame, b.trackingNumber, 'report_delivery_failed', { reason: 'recipient_unavailable', note: 'No answer at gate' });
    expect(ops.deliveries.get(b.trackingNumber)).toMatchObject({ status: 'delivery_failed', openException: 'recipient_unavailable', custodian: { type: 'driver', id: 'kwame' } });
    otp = '654321';
    await dispatch('reattempt', b.trackingNumber);
    await expectCode(act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '123456' }), 'OTP_INVALID'); // old code invalid
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '654321' });
    expect(ops.deliveries.get(b.trackingNumber)!.status).toBe('delivered');
  });

  it('handles failed delivery → return to sender with signature', async () => {
    const b = await outForDelivery();
    await act(kwame, b.trackingNumber, 'report_delivery_failed', { reason: 'refused' });
    await dispatch('return_to_sender', b.trackingNumber);
    await act(kwame, b.trackingNumber, 'complete_return', { receivedByName: 'Ama Mensah', signature: sig });
    expect(ops.deliveries.get(b.trackingNumber)!.status).toBe('returned');
    expect(ops.pods.get(`${b.trackingNumber}_return`)).toMatchObject({ kind: 'return', receivedByName: 'Ama Mensah' });
  });

  it('handles failed pickup → reschedule → reassign to another driver', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    await act(kwame, b.trackingNumber, 'start_assignment');
    await act(kwame, b.trackingNumber, 'report_pickup_failed', { reason: 'package_not_ready' });
    expect(ops.deliveries.get(b.trackingNumber)).toMatchObject({ status: 'pickup_failed', currentDriverUid: null });
    expect(await endShift(deps, kwame)).toEqual({ ended: true }); // not holding anything
    await dispatch('reschedule', b.trackingNumber);
    await startShift(deps, esi, { vehicleId: 'van1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'esi' });
    expect(ops.deliveries.get(b.trackingNumber)!.driverUids).toEqual(['kwame', 'esi']);
  });

  it('requires an active shift to start or collect', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    w.clock.now = new Date(w.clock.now.getTime() + 13 * 3600_000); // shift expired
    await expectCode(act(kwame, b.trackingNumber, 'start_assignment'), 'SHIFT_REQUIRED');
  });
});

describe('live tracking', () => {
  const view = (raw: Record<string, unknown>, caller: Caller = GUEST) =>
    getTrackingView(
      {
        store: w.store,
        rateLimiter: w.pay.rateLimiter,
        ops,
        live,
        maps: { name: 'fake', geocode: async () => [], route: async () => ({ distanceKm: 3, durationMinutes: 11.6 }) },
        now: () => w.clock.now,
      },
      raw,
      caller,
      meta,
    );
  const setLoc = (ageSeconds: number, shiftId = ops.drivers.get('kwame')!.currentShift!.id) =>
    live.locations.set('kwame', { lat: 5.61, lng: -0.17, accuracyM: 8, recordedAt: 0, serverAt: w.clock.now.getTime() - ageSeconds * 1000, shiftId });

  it('shows the driver only while they hold the package, with freshness and ETA', async () => {
    const b = await cashDelivery();
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await dispatch('assign', b.trackingNumber, { driverUid: 'kwame' });
    await act(kwame, b.trackingNumber, 'start_assignment');
    setLoc(10);
    expect((await view({ trackingNumber: b.trackingNumber })).liveLocation).toBeNull(); // public, en route to pickup
    expect((await view({ trackingNumber: b.trackingNumber, accessToken: b.token })).liveLocation).toMatchObject({ freshness: 'live', etaMinutes: null });

    await act(kwame, b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber, cashCollected: true });
    const v = await view({ trackingNumber: b.trackingNumber });
    expect(v).toMatchObject({ deliveryStatus: 'out_for_delivery', statusLabel: 'Out for delivery' });
    expect(v.liveLocation).toMatchObject({ lat: 5.61, freshness: 'live', etaMinutes: 12 });
    expect(v.mapPoints.pickup).toBeNull();

    setLoc(120);
    expect((await view({ trackingNumber: b.trackingNumber })).liveLocation?.freshness).toBe('delayed');
    setLoc(900);
    expect((await view({ trackingNumber: b.trackingNumber })).liveLocation).toMatchObject({ freshness: 'stale', etaMinutes: null });
    setLoc(5, 'some-old-shift');
    expect((await view({ trackingNumber: b.trackingNumber })).liveLocation).toBeNull();

    setLoc(5);
    await act(kwame, b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp });
    expect((await view({ trackingNumber: b.trackingNumber })).liveLocation).toBeNull();
  });

  it('flags overdue deliveries once', async () => {
    const b = await cashDelivery();
    w.clock.now = new Date(w.clock.now.getTime() + 49 * 3600_000);
    expect(await flagDelayedDeliveries(deps)).toEqual({ flagged: 1 });
    expect(await flagDelayedDeliveries(deps)).toEqual({ flagged: 0 });
    expect((await view({ trackingNumber: b.trackingNumber })).delayed).toBe(true);
  });
});

describe('fleet administration', () => {
  const fleet: Caller = { uid: 'fm', role: 'fleet_manager', businessId: null, mfa: true };
  it('creates driver accounts with a set-password link (no password handled by staff)', async () => {
    const created: string[] = [];
    const identity = {
      createDriverUser: async (p: { email: string }) => {
        created.push(p.email);
        return { uid: 'newdriver', setupLink: 'https://auth.example/reset?oob=x' };
      },
      setDriverClaims: async () => {},
    };
    const r = await createDriverAccount(deps, identity, fleet, { name: 'Yaw Mensah', phone: '0201112222', email: 'Yaw@Company.gh', employeeNumber: 'DRV-014', homeServiceAreaId: 'accra' });
    expect(r.setupLink).toContain('oob');
    expect(ops.drivers.get('newdriver')).toMatchObject({ phone: '+233201112222', email: 'yaw@company.gh', status: 'active' });
    await expectCode(createDriverAccount(deps, identity, dispatcher, {}), 'PERMISSION_DENIED');
  });

  it('manages vehicles but never takes an in-use vehicle out of service', async () => {
    const { id } = await upsertVehicle(deps, fleet, { registrationNumber: 'gr 4455-25', vehicleClass: 'car', capacityKg: 100, homeServiceAreaId: 'accra', status: 'available' });
    expect(ops.vehicles.get(id)!.registrationNumber).toBe('GR 4455-25');
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    await expectCode(upsertVehicle(deps, fleet, { id: 'bike1', registrationNumber: 'M-22-GR 101', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'maintenance' }), 'VEHICLE_UNAVAILABLE');
  });
});
