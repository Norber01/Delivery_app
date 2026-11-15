/** Phase 4 manifest/hub transactions against the Firestore + RTDB emulators. */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { randomId } from '../src/lib/hash.js';
import { FirestoreOpsStore, RtdbLive } from '../src/ops/firestoreOps.js';
import { createManifest, hubScan, manifestAction, manifestParcel, upsertHub, upsertRoute } from '../src/ops/hubService.js';
import { dispatchAction, driverAction, endShift, ensureDeliveryForBooking, startShift, type OpsDeps } from '../src/ops/opsService.js';
import { publishPricingRules } from '../src/services/adminService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';
import { areas, rules, site } from '../test/helpers.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_DATABASE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let store: FirestoreStore;
let deps: OpsDeps;
const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const hubA: Caller = { uid: 'ha', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['acc-01'] };
const hubK: Caller = { uid: 'hk', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['ksi-01'] };
const disp: Caller = { uid: 'd', role: 'dispatcher', businessId: null, mfa: true };
const drv = (uid: string): Caller => ({ uid, role: 'driver', businessId: null, mfa: false });
const kumasi = { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } };
const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };

async function parcelAtAccraHub() {
  const ip = { ipHash: randomId(6) };
  const qd = { store, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
  const req = { pickup: osu, destination: kumasi, packages: [{ description: 'Parts', weightKg: 2, lengthCm: 20, widthCm: 20, heightCm: 10, quantity: 1 }], urgency: 'standard', specialHandling: [] };
  const q = await getQuote(qd, req, GUEST, ip);
  const b = await createBooking({ ...qd, site }, { quoteId: q.quoteId, quote: req, sender: { name: 'Ama', phone: '0241234567' }, recipient: { name: 'Yaw', phone: '0201234567' }, paymentPreference: 'cash_on_pickup', acceptTerms: true }, GUEST, ip);
  const tn = b.trackingNumber;
  await ensureDeliveryForBooking(deps, (await store.getBooking(tn))!);
  await dispatchAction(deps, disp, { type: 'assign', deliveryId: tn, driverUid: 'kwame' });
  await driverAction(deps, drv('kwame'), { actionId: `a${randomId(20)}`, deliveryId: tn, type: 'start_assignment', occurredAt: new Date().toISOString() });
  await driverAction(deps, drv('kwame'), { actionId: `a${randomId(20)}`, deliveryId: tn, type: 'confirm_pickup', occurredAt: new Date().toISOString(), scannedCode: tn, cashCollected: true });
  await hubScan(deps, hubA, { hubId: 'acc-01', type: 'receive', trackingNumber: tn });
  return tn;
}

describe.runIf(enabled)('Phase 4 manifests (emulators)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${PROJECT}` }, `int4-${randomId(6)}`);
    db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
  });
  afterAll(() => deleteApp(app));

  beforeEach(async () => {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    await getDatabase(app).ref().set(null);
    const batch = db.batch();
    for (const a of areas) batch.set(db.collection('serviceAreas').doc(a.id), a);
    for (const [uid, area] of [['kwame', 'accra'], ['trucker', 'accra']]) {
      batch.set(db.doc(`drivers/${uid}`), { uid, name: uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid, homeServiceAreaId: area, status: 'active', currentShift: null });
    }
    batch.set(db.doc('vehicles/bike1'), { id: 'bike1', registrationNumber: 'M-1', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
    batch.set(db.doc('vehicles/truck1'), { id: 'truck1', registrationNumber: 'GT 1', vehicleClass: 'truck', capacityKg: 1000, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
    await batch.commit();
    store = new FirestoreStore(db);
    await publishPricingRules(store, admin, rules);
    deps = { ops: new FirestoreOpsStore(db), live: new RtdbLive(getDatabase(app)), evidence: { exists: async () => false }, now: () => new Date(), newId: () => randomId(12), newOtp: () => '111222', site, uploads: { workerUrl: 'https://e', secret: 's' } };
    await upsertHub(deps, admin, { id: 'acc-01', code: 'ACC-01', name: 'Accra Central Hub', type: 'hub', serviceAreaId: 'accra', city: 'Accra', primaryForArea: true, address: 'Ring Road', location: { lat: 5.57, lng: -0.21 }, active: true });
    await upsertHub(deps, admin, { id: 'ksi-01', code: 'KSI-01', name: 'Kumasi Hub', type: 'hub', serviceAreaId: 'kumasi', city: 'Kumasi', primaryForArea: true, address: 'Suame', location: { lat: 6.72, lng: -1.63 }, active: true });
    await upsertRoute(deps, admin, { id: 'acc-ksi', code: 'ACC-KSI', originHubId: 'acc-01', destinationHubId: 'ksi-01', distanceKm: 250, typicalDurationMinutes: 330, schedule: { daysOfWeek: [1], departureTimes: ['18:00'] }, active: true });
    await startShift(deps, drv('kwame'), { vehicleId: 'bike1' });
  });

  it('departs, arrives and unloads several parcels atomically', async () => {
    const tns = [await parcelAtAccraHub(), await parcelAtAccraHub(), await parcelAtAccraHub()];
    const { id } = await createManifest(deps, hubA, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-16T18:00:00Z' });
    for (const tn of tns) await manifestParcel(deps, hubA, { manifestId: id, trackingNumber: tn }, 'add');
    await manifestAction(deps, hubA, { manifestId: id, action: 'seal' });
    await startShift(deps, drv('trucker'), { vehicleId: 'truck1' });
    await manifestAction(deps, hubA, { manifestId: id, action: 'depart' });
    for (const tn of tns) {
      const d = (await db.doc(`deliveries/${tn}`).get()).data()!;
      expect(d.status).toBe('in_transit');
      expect(d.custodian).toEqual({ type: 'vehicle', id: 'truck1' });
    }
    await expect(endShift(deps, drv('trucker'))).rejects.toMatchObject({ code: 'SHIFT_ACTIVE' });
    await manifestAction(deps, hubK, { manifestId: id, action: 'arrive' });
    await Promise.all(tns.map((tn) => hubScan(deps, hubK, { hubId: 'ksi-01', type: 'receive', trackingNumber: tn })));
    expect(((await db.doc(`manifests/${id}`).get()).get('receivedIds') as string[]).sort()).toEqual([...tns].sort());
    expect((await manifestAction(deps, hubK, { manifestId: id, action: 'close' })).missing).toEqual([]);
    expect(await endShift(deps, drv('trucker'))).toEqual({ ended: true });
  });

  it('two manifests loading the same parcel at once: it ends up on exactly one', async () => {
    const tn = await parcelAtAccraHub();
    const m1 = await createManifest(deps, hubA, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-16T18:00:00Z' });
    const m2 = await createManifest(deps, hubA, { routeId: 'acc-ksi', vehicleId: 'truck1', driverUid: 'trucker', scheduledDepartureAt: '2026-11-17T18:00:00Z' });
    const results = await Promise.allSettled([m1.id, m2.id].map((manifestId) => manifestParcel(deps, hubA, { manifestId, trackingNumber: tn }, 'add')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loaded = [(await db.doc(`manifests/${m1.id}`).get()).get('deliveryIds'), (await db.doc(`manifests/${m2.id}`).get()).get('deliveryIds')].flat();
    expect(loaded).toEqual([tn]);
  });
});
