/** Phase 6 against the Firestore emulator: cash, payout and odometer races; report queries. */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../src/lib/auth.js';
import { randomId } from '../src/lib/hash.js';
import { FirestoreFleetStore } from '../src/fleet/firestoreFleet.js';
import { getFinanceReport } from '../src/fleet/financeService.js';
import { approveDriverPay, generateDriverPay, logFuel, markDriverPaid, recordCashRemittance, setPayRules, type FleetDeps } from '../src/fleet/fleetService.js';
import { FirestoreOpsStore } from '../src/ops/firestoreOps.js';
import { areas } from '../test/helpers.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let fleet: FirestoreFleetStore;
let deps: FleetDeps;
let clock = new Date('2026-11-18T10:00:00Z');
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const kwame: Caller = { uid: 'kwame', role: 'driver', businessId: null, mfa: false };

describe.runIf(enabled)('Phase 6 fleet & finance (emulator)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, `int6-${randomId(6)}`);
    db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
  });
  afterAll(() => deleteApp(app));

  beforeEach(async () => {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    clock = new Date('2026-11-18T10:00:00Z');
    fleet = new FirestoreFleetStore(db, new FirestoreOpsStore(db));
    deps = { fleet, evidence: { exists: async () => true }, uploads: { workerUrl: 'https://edge.test', secret: 's' }, now: () => clock, newId: () => randomId(12) };
    const b = db.batch();
    // Seeded like the real seed script: the id is only the document id.
    for (const { id, ...a } of areas) b.set(db.collection('serviceAreas').doc(id), a);
    b.set(db.doc('drivers/kwame'), {
      uid: 'kwame', name: 'Kwame', phone: '+233241111111', email: 'k@x.gh', employeeNumber: 'K1', homeServiceAreaId: 'accra', status: 'active',
      currentShift: { id: 'sh1', vehicleId: 'bike1', vehicleClass: 'motorbike', serviceAreaId: 'accra', startedAt: '2026-11-18T07:00:00Z', activeUntil: '2026-11-18T21:00:00Z' },
    });
    b.set(db.doc('vehicles/bike1'), { id: 'bike1', registrationNumber: 'M-1', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'in_use', currentDriverUid: 'kwame', odometerKm: 5000 });
    b.set(db.doc('driverCash/kwame'), { driverUid: 'kwame', collectedPesewas: 10_000 });
    b.set(db.doc('payments/cash_GH1'), { id: 'cash_GH1', provider: 'cash', status: 'succeeded', amountPesewas: 10_000, trackingNumber: 'GH1', collectedBy: 'kwame', paidAt: new Date('2026-11-18T08:00:00Z') });
    await b.commit();
  });

  it('two hand-ins at once can never exceed the cash a driver holds', async () => {
    const r = await Promise.allSettled([6_000, 6_000].map((amountPesewas, i) => recordCashRemittance(deps, finance, { driverUid: 'kwame', amountPesewas, method: 'cash', reference: `safe-${i}` })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await db.doc('driverCash/kwame').get()).get('remittedPesewas')).toBe(6_000);
    expect((await db.collection('cashRemittances').get()).size).toBe(1);
  });

  it('a statement is paid out once even when finance double-taps', async () => {
    await setPayRules(deps, finance, { dailyRatePesewas: 8_000, perJobPesewas: { direct: 500, first_mile: 300, last_mile: 400 }, perLinehaulTripPesewas: 6_000 });
    await db.doc('shifts/sh1').set({ id: 'sh1', driverUid: 'kwame', vehicleId: 'bike1', startedAt: '2026-11-18T07:00:00Z', endedAt: '2026-11-18T18:00:00Z', startOdometerKm: 5000, endOdometerKm: 5060 });
    await generateDriverPay(deps, finance, { period: '2026-11' });
    clock = new Date('2026-12-01T09:00:00Z');
    await approveDriverPay(deps, finance, { statementId: '2026-11_kwame' });
    const r = await Promise.allSettled([1, 2, 3].map(() => markDriverPaid(deps, finance, { statementId: '2026-11_kwame', method: 'mobile_money', reference: 'MOMO-1' })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const expenses = await db.collection('expenses').where('category', '==', 'driver_payment').get();
    expect(expenses.size).toBe(1);
    expect(expenses.docs[0]!.get('amountPesewas')).toBe(8_000);
  });

  it('concurrent fuel logs keep the odometer at the highest valid reading', async () => {
    const readings = [5_040, 5_100, 4_000];
    const r = await Promise.allSettled(readings.map((odometerKm) => logFuel(deps, kwame, { litres: 3, amountPesewas: 4_500, odometerKm, fullTank: false })));
    // 4 000 is always refused; 5 040 is refused only if 5 100 committed first (readings never go down).
    expect(r[2]!.status).toBe('rejected');
    expect(r[1]!.status).toBe('fulfilled');
    const accepted = readings.filter((_, i) => r[i]!.status === 'fulfilled');
    expect((await db.doc('vehicles/bike1').get()).get('odometerKm')).toBe(Math.max(...accepted));
    expect((await db.collection('fuelLogs').get()).size).toBe(accepted.length);
    expect((await db.collection('expenses').where('category', '==', 'fuel').get()).size).toBe(accepted.length);
  });

  it('builds the month report from Firestore and the ledger reconciles', async () => {
    await recordCashRemittance(deps, finance, { driverUid: 'kwame', amountPesewas: 4_000, method: 'cash', reference: 'safe' });
    await db.doc('expenses/e1').set({ id: 'e1', category: 'maintenance', description: 'Tyre', amountPesewas: 2_500, vehicleId: 'bike1', hubId: null, driverUid: null, receiptKey: null, incurredAt: '2026-11-10T09:00:00.000Z', status: 'approved', submittedBy: 'fm', reviewedBy: 'fin', reviewNote: null, sourceId: null });
    const r = await getFinanceReport({ fleet, now: () => clock }, finance, { period: '2026-11' });
    expect(r.collections).toMatchObject({ cashCollectedPesewas: 10_000, cashRemittedPesewas: 4_000 });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.byArea).toEqual([expect.objectContaining({ key: 'accra', label: 'Greater Accra (Accra–Tema)', costPesewas: 2_500 })]);
    expect((await db.doc('reports/finance-2026-11').get()).exists).toBe(true);
  });
});
