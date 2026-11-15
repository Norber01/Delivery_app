/** Phase 3 operations against the Firestore + RTDB emulators (FIRESTORE_EMULATOR_HOST, FIREBASE_DATABASE_EMULATOR_HOST). */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { randomId } from '../src/lib/hash.js';
import { FirestoreOpsStore, RtdbLive } from '../src/ops/firestoreOps.js';
import { dispatchAction, driverAction, endShift, ensureDeliveryForBooking, startShift, type OpsDeps } from '../src/ops/opsService.js';
import { publishPricingRules } from '../src/services/adminService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';
import { areas, contacts, quoteReq, rules, site } from '../test/helpers.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_DATABASE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let store: FirestoreStore;
let deps: OpsDeps;
let live: RtdbLive;
const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const disp: Caller = { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true };
const drv = (uid: string): Caller => ({ uid, role: 'driver', businessId: null, mfa: false });
const act = (uid: string, deliveryId: string, type: string, extra: Record<string, unknown> = {}, actionId = `a${randomId(20)}`) =>
  driverAction(deps, drv(uid), { actionId, deliveryId, type, occurredAt: new Date().toISOString(), ...extra });

async function cashDelivery() {
  const ip = { ipHash: randomId(6) };
  const qd = { store, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
  const q = await getQuote(qd, quoteReq, GUEST, ip);
  const b = await createBooking({ ...qd, site }, { quoteId: q.quoteId, quote: quoteReq, ...contacts, paymentPreference: 'cash_on_pickup' }, GUEST, ip);
  const booking = (await store.getBooking(b.trackingNumber))!;
  expect(await ensureDeliveryForBooking(deps, booking)).toBe('created');
  return b;
}

describe.runIf(enabled)('Phase 3 operations (emulators)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${PROJECT}` }, `int3-${randomId(6)}`);
    db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
    live = new RtdbLive(getDatabase(app));
  });
  afterAll(() => deleteApp(app));

  beforeEach(async () => {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    await getDatabase(app).ref().set(null);
    const batch = db.batch();
    for (const a of areas) batch.set(db.collection('serviceAreas').doc(a.id), a);
    for (const uid of ['kwame', 'esi']) {
      batch.set(db.doc(`drivers/${uid}`), { uid, name: uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid, homeServiceAreaId: 'accra', status: 'active', currentShift: null });
    }
    for (const id of ['bike1', 'bike2']) {
      batch.set(db.doc(`vehicles/${id}`), { id, registrationNumber: `GR ${id}`, vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
    }
    await batch.commit();
    store = new FirestoreStore(db);
    await publishPricingRules(store, admin, rules);
    deps = {
      ops: new FirestoreOpsStore(db),
      live,
      evidence: { exists: async () => false },
      now: () => new Date(),
      newId: () => randomId(12),
      newOtp: () => '246810',
      site,
      uploads: { workerUrl: 'https://edge.test', secret: 's' },
    };
  });

  it('runs a delivery end to end with RTDB shift authorisation and live location', async () => {
    const b = await cashDelivery();
    const shift = await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    expect((await getDatabase(app).ref('shifts/kwame').get()).val()).toMatchObject({ shiftId: shift.id });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: b.trackingNumber, driverUid: 'kwame' });
    await act('kwame', b.trackingNumber, 'start_assignment');
    await act('kwame', b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber, cashCollected: true });

    await getDatabase(app).ref('driverLocations/kwame').set({ lat: 5.62, lng: -0.17, accuracyM: 9, recordedAt: Date.now(), serverAt: Date.now(), shiftId: shift.id });
    const view = await getTrackingView({ store, rateLimiter: new FirestoreRateLimiter(db), ops: deps.ops, live, maps: null }, { trackingNumber: b.trackingNumber }, GUEST, { ipHash: 'v' });
    expect(view).toMatchObject({ deliveryStatus: 'out_for_delivery', liveLocation: { lat: 5.62, freshness: 'live' } });

    await act('kwame', b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp: '246810' });
    const d = await db.doc(`deliveries/${b.trackingNumber}`).get();
    expect(d.get('status')).toBe('delivered');
    expect((await db.doc(`proofOfDelivery/${b.trackingNumber}`).get()).get('method')).toBe('otp');
    expect((await db.doc(`podSecrets/${b.trackingNumber}`).get()).exists).toBe(false);
    expect((await db.doc(`payments/cash_${b.trackingNumber}`).get()).get('provider')).toBe('cash');
    expect((await db.doc(`deliveryRequests/${b.trackingNumber}`).get()).get('paymentStatus')).toBe('paid');

    expect(await endShift(deps, drv('kwame'))).toEqual({ ended: true });
    expect((await getDatabase(app).ref('driverLocations/kwame').get()).exists()).toBe(false);
    expect((await db.doc('vehicles/bike1').get()).get('status')).toBe('available');
  });

  it('two dispatchers assigning the same delivery: exactly one succeeds', async () => {
    const b = await cashDelivery();
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await startShift(deps, drv('esi'), { vehicleId: 'bike2' });
    const results = await Promise.allSettled(
      ['kwame', 'esi'].map((uid) => dispatchAction(deps, disp, { type: 'assign', deliveryId: b.trackingNumber, driverUid: uid })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.collection('assignments').where('deliveryId', '==', b.trackingNumber).get()).size).toBe(1);
  });

  it('two drivers starting shifts on the same vehicle: exactly one gets it', async () => {
    const results = await Promise.allSettled(['kwame', 'esi'].map((uid) => startShift(deps, drv(uid), { vehicleId: 'bike1' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a replayed driver action is applied once, even concurrently', async () => {
    const b = await cashDelivery();
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: b.trackingNumber, driverUid: 'kwame' });
    const id = `replay${randomId(16)}`;
    const results = await Promise.all([1, 2, 3].map(() => act('kwame', b.trackingNumber, 'start_assignment', {}, id)));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const events = await db.collection('trackingEvents').where('trackingNumber', '==', b.trackingNumber).where('type', '==', 'en_route_to_pickup').get();
    expect(events.size).toBe(1);
  });

  it('a wrong code is counted even though the action fails', async () => {
    const b = await cashDelivery();
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: b.trackingNumber, driverUid: 'kwame' });
    await act('kwame', b.trackingNumber, 'start_assignment');
    await act('kwame', b.trackingNumber, 'confirm_pickup', { scannedCode: b.trackingNumber, cashCollected: true });
    await expect(act('kwame', b.trackingNumber, 'complete_delivery', { receivedByName: 'Kofi', otp: '000000' })).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect((await db.doc(`podSecrets/${b.trackingNumber}`).get()).get('attempts')).toBe(1);
  });

  it('cannot end a shift while holding a package', async () => {
    const b = await cashDelivery();
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
    await dispatchAction(deps, disp, { type: 'assign', deliveryId: b.trackingNumber, driverUid: 'kwame' });
    await expect(endShift(deps, drv('kwame'))).rejects.toMatchObject({ code: 'SHIFT_ACTIVE' });
  });
});
