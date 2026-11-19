import { beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../src/lib/auth.js';
import { GUEST } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { createManifest, hubScan, manifestAction, manifestParcel, upsertHub, upsertRoute } from '../src/ops/hubService.js';
import { dispatchAction, driverAction, endShift, ensureDeliveryForBooking, startShift, type OpsDeps } from '../src/ops/opsService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { meta, site, world, type World } from './helpers.js';
import { MemoryEvidence, MemoryLive, MemoryOpsStore } from './opsMemory.js';

let w: World;
let ops: MemoryOpsStore;
let live: MemoryLive;
let deps: OpsDeps;
let seq = 0;
const OTP = '135790';

const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const disp: Caller = { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true };
const accraHubOp: Caller = { uid: 'hubA', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['acc-01'] };
const kumasiHubOp: Caller = { uid: 'hubK', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['ksi-01'] };
const drv = (uid: string): Caller => ({ uid, role: 'driver', businessId: null, mfa: false });
const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
const act = (uid: string, d: string, type: string, extra: Record<string, unknown> = {}) =>
  driverAction(deps, drv(uid), { actionId: `act${String(++seq).padStart(16, '0')}`, deliveryId: d, type, occurredAt: w.clock.now.toISOString(), ...extra });

const kumasi = { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } };
const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };

async function setupNetwork() {
  await upsertHub(deps, admin, { id: 'acc-01', code: 'acc-01', name: 'Accra Central Hub', type: 'hub', serviceAreaId: 'accra', city: 'Accra', primaryForArea: true, address: 'Ring Road, Accra', location: { lat: 5.57, lng: -0.21 }, active: true });
  await upsertHub(deps, admin, { id: 'ksi-01', code: 'KSI-01', name: 'Kumasi Hub', type: 'hub', serviceAreaId: 'kumasi', city: 'Kumasi', primaryForArea: true, address: 'Suame, Kumasi', location: { lat: 6.72, lng: -1.63 }, active: true });
  await upsertRoute(deps, admin, { id: 'acc-ksi', code: 'acc-ksi', originHubId: 'acc-01', destinationHubId: 'ksi-01', distanceKm: 250, typicalDurationMinutes: 300, schedule: { daysOfWeek: [1, 2, 3, 4, 5], departureTimes: ['18:00'] }, active: true });
}

async function intercityBooking(weightKg = 3) {
  const req = { pickup: osu, destination: kumasi, packages: [{ description: 'Phone parts', weightKg, lengthCm: 20, widthCm: 20, heightCm: 10, quantity: 1 }], urgency: 'standard', specialHandling: [] };
  const q = await getQuote({ store: w.store, rateLimiter: w.pay.rateLimiter, maps: null, now: () => w.clock.now, newId: () => `quoteic${String(++seq).padStart(10, '0')}` }, req, GUEST, meta);
  const b = await createBooking(
    { store: w.store, rateLimiter: w.pay.rateLimiter, now: () => w.clock.now },
    { quoteId: q.quoteId, quote: req, sender: { name: 'Ama Mensah', phone: '0241234567' }, recipient: { name: 'Yaw Boateng', phone: '0201234567' }, paymentPreference: 'cash_on_pickup', acceptTerms: true },
    GUEST,
    meta,
  );
  await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!);
  return b.trackingNumber;
}

const driverDoc = (uid: string, area: string) => ({ uid, name: uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid, homeServiceAreaId: area, status: 'active' as const, currentShift: null });
const vehicle = (id: string, cls: 'motorbike' | 'van' | 'truck', area: string, capacityKg: number) => ({ id, registrationNumber: `GR ${id}`, vehicleClass: cls, capacityKg, homeServiceAreaId: area, status: 'available' as const, currentDriverUid: null });

beforeEach(async () => {
  w = world();
  ops = new MemoryOpsStore(w.store, w.clock);
  live = new MemoryLive();
  seq = 0;
  deps = { ops, live, evidence: new MemoryEvidence(), now: () => w.clock.now, newId: () => `id${++seq}`, newOtp: () => OTP, site, uploads: { workerUrl: 'https://edge.test', secret: 's' } };
  await setupNetwork();
  await ops.createDriver(driverDoc('kwame', 'accra')); // first mile, Accra
  await ops.createDriver(driverDoc('trucker', 'accra')); // linehaul
  await ops.createDriver(driverDoc('kofi', 'kumasi')); // last mile, Kumasi
  await ops.upsertVehicle(vehicle('bike1', 'motorbike', 'accra', 20));
  await ops.upsertVehicle(vehicle('truck1', 'truck', 'accra', 10));
  await ops.upsertVehicle(vehicle('bike9', 'motorbike', 'kumasi', 20));
});

/** First mile: assign, pick up, receive at Accra hub. */
async function toOriginHub(tn: string) {
  await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
  await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' });
  await act('kwame', tn, 'start_assignment');
  await act('kwame', tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true });
  return hubScan(deps, accraHubOp, { hubId: 'acc-01', type: 'receive', trackingNumber: tn });
}

async function loadedManifest(tns: string[]) {
  const { id } = await createManifest(deps, accraHubOp, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-10T18:00:00Z' });
  for (const tn of tns) await manifestParcel(deps, accraHubOp, { manifestId: id, trackingNumber: tn }, 'add');
  return id;
}

describe('intercity network setup', () => {
  it('resolves hubs and route when the delivery is created', async () => {
    const tn = await intercityBooking();
    const d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ routeId: 'acc-ksi', originHub: { id: 'acc-01', code: 'ACC-01', city: 'Accra' }, destinationHub: { id: 'ksi-01' }, destinationAreaId: 'kumasi', requiredVehicleClass: 'motorbike' });
    expect(d.legs.map((l) => l.type)).toEqual(['first_mile', 'linehaul', 'last_mile']);
  });

  it('only admins manage the network; routes need hubs in different areas', async () => {
    await expectCode(upsertHub(deps, disp, {}), 'PERMISSION_DENIED');
    await expectCode(
      upsertRoute(deps, admin, { id: 'bad', code: 'ACC-ACC', originHubId: 'acc-01', destinationHubId: 'nope', distanceKm: 1, typicalDurationMinutes: 1, schedule: { daysOfWeek: [1], departureTimes: ['08:00'] }, active: true }),
      'NOT_FOUND',
    );
  });
});

describe('intercity journey', () => {
  it('moves a parcel driver → hub → linehaul → hub → driver → recipient with one custodian at a time', async () => {
    const tn = await intercityBooking();
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' });
    await act('kwame', tn, 'start_assignment');
    await act('kwame', tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true });
    let d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'picked_up', custodian: { type: 'driver', id: 'kwame' } });
    expect(ops.podSecrets.has(tn)).toBe(false); // no delivery code on the first mile
    await expectCode(endShift(deps, drv('kwame')), 'SHIFT_ACTIVE'); // holding the parcel

    // Wrong hub refuses the parcel; right hub receives it.
    await expectCode(hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn }), 'WRONG_HUB');
    await hubScan(deps, accraHubOp, { hubId: 'acc-01', type: 'receive', trackingNumber: tn });
    d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'at_origin_hub', custodian: { type: 'hub', id: 'acc-01' }, currentLegId: 'leg2', currentDriverUid: null });
    expect(d.legs[0]!.status).toBe('completed');
    expect(await endShift(deps, drv('kwame'))).toEqual({ ended: true });

    // Manifest: load, seal, depart (driver must be on shift with the truck).
    const mid = await loadedManifest([tn]);
    await expectCode(manifestAction(deps, accraHubOp, { manifestId: mid, action: 'depart' }), 'INVALID_TRANSITION'); // not sealed
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'seal' });
    await expectCode(manifestAction(deps, accraHubOp, { manifestId: mid, action: 'depart' }), 'DRIVER_UNAVAILABLE');
    await startShift(deps, drv('trucker'), { vehicleId: 'truck1' });
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'depart' });
    d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'in_transit', custodian: { type: 'vehicle', id: 'truck1' }, linehaul: { manifestId: mid } });
    expect(new Date(d.linehaul!.expectedArrivalAt).getTime() - w.clock.now.getTime()).toBe(300 * 60_000);
    await expectCode(endShift(deps, drv('trucker')), 'SHIFT_ACTIVE'); // manifest still on the road

    // Customer view during linehaul: no position at all.
    const live1 = await getTrackingView({ store: w.store, rateLimiter: w.pay.rateLimiter, ops, live, now: () => w.clock.now }, { trackingNumber: tn }, GUEST, meta);
    expect(live1).toMatchObject({ statusLabel: 'In transit to Kumasi', liveLocation: null, network: { originHub: { city: 'Accra' }, destinationHub: { city: 'Kumasi' } } });
    expect(live1.network!.expectedArrivalAtHub).toBe(d.linehaul!.expectedArrivalAt);

    // Arrival at Kumasi: only Kumasi can mark arrival and unload.
    await expectCode(manifestAction(deps, accraHubOp, { manifestId: mid, action: 'arrive' }), 'PERMISSION_DENIED');
    await expectCode(hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn }), 'INVALID_TRANSITION'); // not arrived yet
    await manifestAction(deps, kumasiHubOp, { manifestId: mid, action: 'arrive' });
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn });
    expect(ops.manifests.get(mid)!.receivedIds).toEqual([tn]);
    await manifestAction(deps, kumasiHubOp, { manifestId: mid, action: 'close' });
    expect(ops.manifests.get(mid)).toMatchObject({ status: 'closed', missingIds: [] });
    expect(await endShift(deps, drv('trucker'))).toEqual({ ended: true });
    d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'at_destination_hub', custodian: { type: 'hub', id: 'ksi-01' }, currentLegId: 'leg3' });

    // Last mile: Kumasi dispatch assigns a Kumasi driver; hub hands over; OTP delivery.
    await expectCode(hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'handover', trackingNumber: tn }), 'DRIVER_UNAVAILABLE'); // no driver yet
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await expectCode(dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' }), 'DRIVER_UNAVAILABLE'); // Accra driver
    await startShift(deps, drv('kofi'), { vehicleId: 'bike9' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kofi' });
    expect(ops.deliveries.get(tn)!.status).toBe('at_destination_hub'); // still in the hub's custody
    await expectCode(act('kofi', tn, 'start_assignment'), 'INVALID_TRANSITION');
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'handover', trackingNumber: tn });
    d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'out_for_delivery', custodian: { type: 'driver', id: 'kofi' } });
    expect(w.store.notifications.find((n) => n.template === 'delivery_otp')!.recipientPhone).toBe('+233201234567');
    await act('kofi', tn, 'complete_delivery', { receivedByName: 'Yaw Boateng', otp: OTP });
    expect(ops.deliveries.get(tn)!.status).toBe('delivered');
    expect(ops.deliveries.get(tn)!.legs.map((l) => l.status)).toEqual(['completed', 'completed', 'completed']);

    const types = w.store.events.filter((e) => e.trackingNumber === tn).map((e) => e.type);
    expect(types).toEqual(['booking_created', 'assigned', 'en_route_to_pickup', 'picked_up', 'payment_received', 'hub_in', 'departed', 'hub_in', 'assigned', 'out_for_delivery', 'delivered']);
  });

  it('a failed last-mile delivery comes back into the destination hub and can be reassigned', async () => {
    const tn = await intercityBooking();
    await toOriginHub(tn);
    const mid = await loadedManifest([tn]);
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'seal' });
    await startShift(deps, drv('trucker'), { vehicleId: 'truck1' });
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'depart' });
    await manifestAction(deps, kumasiHubOp, { manifestId: mid, action: 'arrive' });
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn });
    await startShift(deps, drv('kofi'), { vehicleId: 'bike9' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kofi' });
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'handover', trackingNumber: tn });
    await act('kofi', tn, 'report_delivery_failed', { reason: 'recipient_unavailable' });
    await expectCode(dispatchAction(deps, disp, { type: 'return_to_sender', deliveryId: tn }), 'PHASE_NOT_AVAILABLE');
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn });
    const d = ops.deliveries.get(tn)!;
    expect(d).toMatchObject({ status: 'at_destination_hub', custodian: { type: 'hub', id: 'ksi-01' }, currentDriverUid: null });
    expect(ops.podSecrets.has(tn)).toBe(false); // old code invalidated
    expect(await endShift(deps, drv('kofi'))).toEqual({ ended: true });
  });
});

describe('manifests', () => {
  it('enforces route, capacity, single manifest per parcel, and hub scope', async () => {
    const a = await intercityBooking(4);
    const b = await intercityBooking(4);
    const c = await intercityBooking(4);
    for (const tn of [a, b, c]) {
      await toOriginHub(tn);
      await endShift(deps, drv('kwame'));
    }
    const m1 = await loadedManifest([a, b]); // 8 kg of 10
    await expectCode(manifestParcel(deps, accraHubOp, { manifestId: m1, trackingNumber: c }, 'add'), 'MANIFEST_CAPACITY');
    const { id: m2 } = await createManifest(deps, accraHubOp, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-11T18:00:00Z' });
    await expectCode(manifestParcel(deps, accraHubOp, { manifestId: m2, trackingNumber: a }, 'add'), 'ALREADY_ON_MANIFEST');
    expect((await manifestParcel(deps, accraHubOp, { manifestId: m1, trackingNumber: a }, 'add')).parcels).toBe(2); // repeat scan is harmless
    await manifestParcel(deps, accraHubOp, { manifestId: m1, trackingNumber: b }, 'remove');
    expect(ops.manifests.get(m1)).toMatchObject({ deliveryIds: [a], totalWeightKg: 4 });
    await manifestAction(deps, accraHubOp, { manifestId: m1, action: 'seal' });
    await expectCode(manifestParcel(deps, accraHubOp, { manifestId: m1, trackingNumber: b }, 'add'), 'MANIFEST_NOT_OPEN');
    await expectCode(createManifest(deps, kumasiHubOp, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-11T18:00:00Z' }), 'PERMISSION_DENIED');
    await expectCode(hubScan(deps, { ...accraHubOp, mfa: false }, { hubId: 'acc-01', type: 'receive', trackingNumber: b }), 'MFA_REQUIRED');
  });

  it('refuses parcels that have not been received at the origin hub', async () => {
    const tn = await intercityBooking();
    const { id } = await createManifest(deps, accraHubOp, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-10T18:00:00Z' });
    await expectCode(manifestParcel(deps, accraHubOp, { manifestId: id, trackingNumber: tn }, 'add'), 'WRONG_HUB');
  });

  it('closing with parcels not unloaded flags them missing for investigation', async () => {
    const a = await intercityBooking(2);
    const b = await intercityBooking(2);
    for (const tn of [a, b]) {
      await toOriginHub(tn);
      await endShift(deps, drv('kwame'));
    }
    const mid = await loadedManifest([a, b]);
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'seal' });
    await startShift(deps, drv('trucker'), { vehicleId: 'truck1' });
    await manifestAction(deps, accraHubOp, { manifestId: mid, action: 'depart' });
    await manifestAction(deps, kumasiHubOp, { manifestId: mid, action: 'arrive' });
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: a });
    const r = await manifestAction(deps, kumasiHubOp, { manifestId: mid, action: 'close' });
    expect(r.missing).toEqual([b]);
    expect(ops.deliveries.get(b)).toMatchObject({ status: 'in_transit', openException: 'missing_in_transit' });
    expect(w.store.audit.some((x) => x.action === 'manifest.close_with_discrepancy')).toBe(true);
    // Found later and scanned in: the exception clears.
    await hubScan(deps, kumasiHubOp, { hubId: 'ksi-01', type: 'receive', trackingNumber: b });
    expect(ops.deliveries.get(b)).toMatchObject({ status: 'at_destination_hub', openException: null });
  });
});
