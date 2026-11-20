import { beforeEach, describe, expect, it } from 'vitest';
import type { DriverDoc, VehicleDoc } from '@courier/shared-types';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { dispatchAction, driverAction, endShift, ensureDeliveryForBooking, startShift, type OpsDeps } from '../src/ops/opsService.js';
import { exportRecentDays, TABLES, type BqRow } from '../src/fleet/bigqueryExport.js';
import { buildFinanceReport, getFinanceReport } from '../src/fleet/financeService.js';
import { exportBackup } from '../src/fleet/backupService.js';
import {
  adjustDriverPay,
  approveDriverPay,
  generateDriverPay,
  logFuel,
  markDriverPaid,
  payLines,
  recordCashRemittance,
  recordMaintenance,
  requestReceiptUpload,
  reviewExpense,
  setPayRules,
  setVehicleSchedule,
  submitExpense,
  type FleetDeps,
} from '../src/fleet/fleetService.js';
import { planDriverRoute, stopsFor } from '../src/fleet/routeService.js';
import { site, world, type World } from './helpers.js';
import { MemoryFleetStore } from './fleetMemory.js';
import { MemoryEvidence, MemoryLive, MemoryOpsStore } from './opsMemory.js';

const dispatcher: Caller = { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true };
const kumasiDispatcher: Caller = { ...dispatcher, uid: 'disp2', serviceAreaIds: ['kumasi'] };
const fleetMgr: Caller = { uid: 'fleet', role: 'fleet_manager', businessId: null, mfa: true };
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const finance2: Caller = { uid: 'fin2', role: 'finance', businessId: null, mfa: true };
const hubOp: Caller = { uid: 'hubop', role: 'hub_operator', businessId: null, mfa: true, hubIds: ['acc-01'] };
const kwame: Caller = { uid: 'kwame', role: 'driver', businessId: null, mfa: false };

let w: World;
let ops: MemoryOpsStore;
let fleet: MemoryFleetStore;
let live: MemoryLive;
let evidence: MemoryEvidence;
let deps: OpsDeps;
let fdeps: FleetDeps;
let seq = 0;

const expectCode = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  return e as AppError;
};
const act = (deliveryId: string, type: string, extra: Record<string, unknown> = {}) =>
  driverAction(deps, kwame, { actionId: `act${String(++seq).padStart(16, "0")}`, deliveryId, type, occurredAt: w.clock.now.toISOString(), ...extra });
const driver = (uid: string, area = 'accra'): DriverDoc => ({ uid, name: uid === 'kwame' ? 'Kwame Mensah' : uid, phone: '+233241111111', email: `${uid}@x.gh`, employeeNumber: uid.toUpperCase(), homeServiceAreaId: area, status: 'active', currentShift: null });
const bike: VehicleDoc = { id: 'bike1', registrationNumber: 'M-22-GR 101', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null };

beforeEach(async () => {
  w = world();
  ops = new MemoryOpsStore(w.store, w.clock);
  fleet = new MemoryFleetStore(ops, w.store);
  live = new MemoryLive();
  evidence = new MemoryEvidence();
  seq = 0;
  deps = { ops, live, evidence, now: () => w.clock.now, newId: () => `id${++seq}`, newOtp: () => '123456', site, uploads: { workerUrl: 'https://edge.test', secret: 'upload-secret' }, fleet };
  fdeps = { fleet, evidence, uploads: deps.uploads, now: () => w.clock.now, newId: () => `f${++seq}` };
  await ops.createDriver(driver('kwame'));
  await ops.upsertVehicle({ ...bike });
});

async function cashJob() {
  const b = await w.book(GUEST, 'cash_on_pickup');
  await ensureDeliveryForBooking(deps, w.store.bookings.get(b.trackingNumber)!);
  await dispatchAction(deps, dispatcher, { type: 'assign', deliveryId: b.trackingNumber, driverUid: 'kwame' });
  return b;
}
async function deliver(tn: string) {
  await act(tn, 'start_assignment');
  await act(tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true });
  await act(tn, 'complete_delivery', { receivedByName: 'Kofi', otp: '123456' });
}

describe('route planning', () => {
  it('orders every pickup before its drop, holds only drops for parcels already collected, and saves the plan', async () => {
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    const a = await cashJob();
    const b = await cashJob();
    const c = await cashJob();
    await act(a.trackingNumber, 'start_assignment');
    await act(a.trackingNumber, 'confirm_pickup', { scannedCode: a.trackingNumber, cashCollected: true });
    live.locations.set('kwame', { lat: 5.6, lng: -0.19, accuracyM: 10, recordedAt: w.clock.now.getTime(), serverAt: w.clock.now.getTime(), shiftId: 's' });

    const plan = await planDriverRoute({ fleet, live, now: () => w.clock.now }, dispatcher, { driverUid: 'kwame' });
    expect(plan.startFrom).toBe('live_location');
    expect(plan.stops).toHaveLength(5); // a: drop only; b, c: pickup + drop
    expect(plan.stops.filter((s) => s.deliveryId === a.trackingNumber).map((s) => s.kind)).toEqual(['drop']);
    for (const tn of [b.trackingNumber, c.trackingNumber]) {
      const idx = plan.stops.filter((s) => s.deliveryId === tn).map((s) => `${s.kind}@${s.seq}`);
      expect(idx[0]).toMatch(/^pickup@/);
      expect(Number(idx[0]!.split('@')[1])).toBeLessThan(Number(idx[1]!.split('@')[1]));
    }
    expect(plan.travelMinutes).toBeLessThanOrEqual(plan.baselineMinutes);
    expect(fleet.plans.get('kwame')?.stops).toHaveLength(5);
    // Drivers can plan their own run; out-of-scope dispatchers cannot.
    expect((await planDriverRoute({ fleet, live, now: () => w.clock.now }, kwame, {})).stops).toHaveLength(5);
    await expectCode(planDriverRoute({ fleet, live, now: () => w.clock.now }, kumasiDispatcher, { driverUid: 'kwame' }), 'PERMISSION_DENIED');
  });

  it('starts from the first stop when the driver’s position is stale, and ignores linehaul legs', async () => {
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    const a = await cashJob();
    live.locations.set('kwame', { lat: 5.6, lng: -0.19, accuracyM: 10, recordedAt: w.clock.now.getTime() - 3600_000, serverAt: 0, shiftId: 's' });
    const plan = await planDriverRoute({ fleet, live, now: () => w.clock.now }, dispatcher, { driverUid: 'kwame' });
    expect(plan.startFrom).toBe('first_stop');
    const d = ops.deliveries.get(a.trackingNumber)!;
    d.legs[0]!.type = 'linehaul';
    expect(stopsFor(d, 'kwame')).toEqual([]);
  });
});

describe('shifts, odometer and vehicle documents', () => {
  it('records odometer readings and refuses readings that go down or jump implausibly', async () => {
    const s = await startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 12_000 });
    expect(ops.vehicles.get('bike1')!.odometerKm).toBe(12_000);
    expect(fleet.shifts.get(s.id)).toMatchObject({ driverUid: 'kwame', startOdometerKm: 12_000, endedAt: null });
    await expectCode(endShift(deps, kwame, { odometerKm: 11_900 }), 'ODOMETER_INVALID');
    await expectCode(endShift(deps, kwame, { odometerKm: 19_000 }), 'ODOMETER_INVALID');
    await endShift(deps, kwame, { odometerKm: 12_085 });
    expect(fleet.shifts.get(s.id)).toMatchObject({ endOdometerKm: 12_085, endedAt: w.clock.now.toISOString() });
    await expectCode(startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 12_000 }), 'ODOMETER_INVALID');
    expect(ops.vehicles.get('bike1')!.status).toBe('available'); // refused before reserving the vehicle
  });

  it('blocks a shift on a vehicle whose insurance or roadworthiness has lapsed', async () => {
    await setVehicleSchedule(fdeps, fleetMgr, { vehicleId: 'bike1', serviceIntervalKm: 3000, serviceIntervalDays: 90, insuranceExpiry: '2026-11-01T00:00:00Z', roadworthyExpiry: null });
    const e = await expectCode(startShift(deps, kwame, { vehicleId: 'bike1' }), 'VEHICLE_DOCUMENTS_EXPIRED');
    expect(e.message).toContain('Insurance expired 2026-11-01');
    await expectCode(setVehicleSchedule(fdeps, kwame, { vehicleId: 'bike1', serviceIntervalKm: null, serviceIntervalDays: null, insuranceExpiry: null, roadworthyExpiry: null }), 'PERMISSION_DENIED');
  });
});

describe('maintenance, fuel and expenses', () => {
  it('records a service, resets the service clock and raises a maintenance expense for finance', async () => {
    const r = await recordMaintenance(fdeps, fleetMgr, { vehicleId: 'bike1', type: 'service', description: 'Oil and chain', costPesewas: 35_000, odometerKm: 9_000, performedAt: '2026-11-09T09:00:00Z', vendor: 'Abossey Okai Motors' });
    expect(ops.vehicles.get('bike1')).toMatchObject({ lastServiceAt: '2026-11-09T09:00:00Z', lastServiceKm: 9_000, odometerKm: 9_000 });
    expect(fleet.expenses.get(r.expenseId!)).toMatchObject({ category: 'maintenance', status: 'submitted', vehicleId: 'bike1', amountPesewas: 35_000 });
    expect(fleet.maintenance).toHaveLength(1);
  });

  it('lets a driver on shift log fuel with a receipt; checks the receipt was uploaded', async () => {
    await expectCode(logFuel(fdeps, kwame, { litres: 5, amountPesewas: 7_500, odometerKm: 100, fullTank: true }), 'SHIFT_REQUIRED');
    await startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 12_000 });
    const t = await requestReceiptUpload(fdeps, kwame, { contentType: 'image/jpeg', bytes: 50_000 });
    expect(t.key).toMatch(/^receipt\/kwame\/[A-Za-z0-9_-]+\.jpg$/);
    await expectCode(logFuel(fdeps, kwame, { litres: 5, amountPesewas: 7_500, odometerKm: 12_040, fullTank: true, receiptKey: t.key }), 'UPLOAD_NOT_FOUND');
    evidence.objects.add(t.key);
    await expectCode(logFuel(fdeps, kwame, { litres: 5, amountPesewas: 7_500, odometerKm: 11_000, fullTank: true, receiptKey: t.key }), 'ODOMETER_INVALID');
    expect(fleet.fuel).toHaveLength(0);
    const r = await logFuel(fdeps, kwame, { litres: 5, amountPesewas: 7_500, odometerKm: 12_040, fullTank: true, station: 'GOIL Osu', receiptKey: t.key });
    const log = fleet.fuel.find((f) => f.id === r.id)!;
    expect(log).toMatchObject({ vehicleId: 'bike1', driverUid: 'kwame', receiptKey: t.key });
    expect(fleet.expenses.get(log.expenseId)).toMatchObject({ category: 'fuel', status: 'submitted', driverUid: 'kwame' });
    expect(ops.vehicles.get('bike1')!.odometerKm).toBe(12_040);
  });

  it('keeps hub staff to their own hub and requires a second person to approve', async () => {
    const at = '2026-11-09T09:00:00Z';
    await expectCode(submitExpense(fdeps, hubOp, { category: 'hub', description: 'Generator diesel', amountPesewas: 20_000, hubId: 'ksi-01', incurredAt: at }), 'PERMISSION_DENIED');
    await expectCode(submitExpense(fdeps, hubOp, { category: 'other', description: 'Snacks', amountPesewas: 2_000, incurredAt: at }), 'PERMISSION_DENIED');
    const { id } = await submitExpense(fdeps, finance, { category: 'hub', description: 'Generator diesel', amountPesewas: 20_000, hubId: 'acc-01', incurredAt: at });
    await expectCode(reviewExpense(fdeps, finance, { expenseId: id, decision: 'approved' }), 'VALIDATION_FAILED');
    await expectCode(reviewExpense(fdeps, finance2, { expenseId: id, decision: 'rejected' }), 'VALIDATION_FAILED'); // reason required
    expect((await reviewExpense(fdeps, finance2, { expenseId: id, decision: 'approved' })).status).toBe('approved');
    await expectCode(reviewExpense(fdeps, finance2, { expenseId: id, decision: 'approved' }), 'VALIDATION_FAILED');
    await expectCode(submitExpense(fdeps, finance, { category: 'fuel', description: 'Fuel', amountPesewas: 2_000, incurredAt: at }), 'VALIDATION_FAILED'); // vehicle required
  });
});

describe('cash and driver pay', () => {
  it('tracks cash a driver collects and what they hand in', async () => {
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    const a = await cashJob();
    await deliver(a.trackingNumber);
    expect(await fleet.getCash('kwame')).toMatchObject({ collectedPesewas: a.total, remittedPesewas: 0 });
    const err = await expectCode(recordCashRemittance(fdeps, finance, { driverUid: 'kwame', amountPesewas: a.total + 1, method: 'cash', reference: 'Hub safe' }), 'VALIDATION_FAILED');
    expect(err.message).toContain('only holds');
    await recordCashRemittance(fdeps, finance, { driverUid: 'kwame', amountPesewas: a.total, method: 'mobile_money', reference: 'MOMO-1' });
    expect(await fleet.getCash('kwame')).toMatchObject({ remittedPesewas: a.total });
    await expectCode(recordCashRemittance(fdeps, kwame, { driverUid: 'kwame', amountPesewas: 1, method: 'cash', reference: 'x1' }), 'PERMISSION_DENIED');
  });

  it('calculates pay lines from rates', () => {
    const rules = { dailyRatePesewas: 8_000, perJobPesewas: { direct: 500, first_mile: 300, last_mile: 400 }, perLinehaulTripPesewas: 6_000, updatedBy: 'x', updatedAt: '' };
    expect(payLines(rules, { days: 3, jobs: { direct: 10, last_mile: 2 }, linehaulTrips: 1 })).toEqual([
      { label: 'Days worked', quantity: 3, ratePesewas: 8_000, amountPesewas: 24_000 },
      { label: 'Same-city deliveries', quantity: 10, ratePesewas: 500, amountPesewas: 5_000 },
      { label: 'Deliveries from hub', quantity: 2, ratePesewas: 400, amountPesewas: 800 },
      { label: 'Intercity linehaul trips', quantity: 1, ratePesewas: 6_000, amountPesewas: 6_000 },
    ]);
  });

  it('builds monthly statements, keeps adjustments, and pays out exactly once through an expense', async () => {
    await expectCode(generateDriverPay(fdeps, finance, { period: '2026-11' }), 'VALIDATION_FAILED'); // no rates yet
    await setPayRules(fdeps, finance, { dailyRatePesewas: 8_000, perJobPesewas: { direct: 500, first_mile: 300, last_mile: 400 }, perLinehaulTripPesewas: 6_000 });
    await startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 1_000 });
    const a = await cashJob();
    const b = await cashJob();
    await deliver(a.trackingNumber);
    await deliver(b.trackingNumber);
    await endShift(deps, kwame, { odometerKm: 1_042 });

    expect(await generateDriverPay(fdeps, finance, { period: '2026-11' })).toEqual({ saved: 1, skipped: 0, final: 0 });
    const id = '2026-11_kwame';
    expect(fleet.statements.get(id)).toMatchObject({ daysWorked: 1, kmDriven: 42, grossPesewas: 9_000, status: 'draft', cashOutstandingPesewas: a.total + b.total });
    await adjustDriverPay(fdeps, finance, { statementId: id, label: 'Late return deduction', amountPesewas: -1_000 });
    await expectCode(adjustDriverPay(fdeps, finance, { statementId: id, label: 'Too much', amountPesewas: -100_000 }), 'VALIDATION_FAILED');
    await generateDriverPay(fdeps, finance, { period: '2026-11' }); // regenerate keeps the adjustment
    expect(fleet.statements.get(id)!.grossPesewas).toBe(8_000);

    await expectCode(approveDriverPay(fdeps, finance, { statementId: id }), 'VALIDATION_FAILED'); // month not over
    w.clock.now = new Date('2026-12-02T09:00:00Z');
    await expectCode(markDriverPaid(fdeps, finance, { statementId: id, method: 'mobile_money', reference: 'MOMO-77' }), 'ALREADY_FINAL');
    await approveDriverPay(fdeps, finance, { statementId: id });
    await expectCode(adjustDriverPay(fdeps, finance, { statementId: id, label: 'Bonus', amountPesewas: 500 }), 'ALREADY_FINAL');
    expect(await generateDriverPay(fdeps, finance, { period: '2026-11' })).toMatchObject({ final: 1 });
    await markDriverPaid(fdeps, finance, { statementId: id, method: 'mobile_money', reference: 'MOMO-77' });
    await expectCode(markDriverPaid(fdeps, finance, { statementId: id, method: 'mobile_money', reference: 'MOMO-77' }), 'ALREADY_FINAL');
    const s = fleet.statements.get(id)!;
    expect(s).toMatchObject({ status: 'paid', payout: { method: 'mobile_money', reference: 'MOMO-77' } });
    expect(fleet.expenses.get(s.expenseId!)).toMatchObject({ category: 'driver_payment', status: 'approved', amountPesewas: 8_000, sourceId: id });
  });
});

describe('finance report', () => {
  it('reconciles bookings, cash, expenses and driver pay, and breaks contribution down by area and vehicle', async () => {
    await setPayRules(fdeps, finance, { dailyRatePesewas: 8_000, perJobPesewas: { direct: 500, first_mile: 300, last_mile: 400 }, perLinehaulTripPesewas: 6_000 });
    await startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 1_000 });
    const a = await cashJob();
    await deliver(a.trackingNumber);
    await w.book(GUEST, 'cash_on_pickup'); // booked, not yet delivered
    await logFuel(fdeps, kwame, { litres: 4, amountPesewas: 6_000, odometerKm: 1_010, fullTank: true });
    await endShift(deps, kwame, { odometerKm: 1_030 });
    const fuelExpense = [...fleet.expenses.values()].find((e) => e.category === 'fuel')!;
    await reviewExpense(fdeps, finance, { expenseId: fuelExpense.id, decision: 'approved' });
    await recordCashRemittance(fdeps, finance, { driverUid: 'kwame', amountPesewas: a.total, method: 'cash', reference: 'Safe' });

    const r = await getFinanceReport({ fleet, now: () => w.clock.now }, finance, { period: '2026-11' });
    expect(r.revenue.deliveries).toBe(2);
    expect(r.collections).toMatchObject({ cashCollectedPesewas: a.total, cashRemittedPesewas: a.total, onlinePesewas: 0 });
    expect(r.costs).toMatchObject({ totalPesewas: 6_000, byCategory: { fuel: 6_000 } });
    expect(r.contributionPesewas).toBe(r.revenue.bookedPesewas - 6_000);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const v = r.byVehicle.find((x) => x.key === 'bike1')!;
    expect(v).toMatchObject({ revenuePesewas: a.total, costPesewas: 6_000, kmDriven: 30, deliveries: 1, costPerKmPesewas: 200 });
    expect(r.byArea.reduce((n, x) => n + x.contributionPesewas, 0)).toBe(r.contributionPesewas);
    // Cached for 10 minutes; tampering with the ledger is caught on refresh.
    ops.driverCash.get('kwame')!.collectedPesewas += 100;
    expect((await getFinanceReport({ fleet, now: () => w.clock.now }, finance, { period: '2026-11' })).checks.every((c) => c.ok)).toBe(true);
    const fresh = await getFinanceReport({ fleet, now: () => w.clock.now }, finance, { period: '2026-11', refresh: true });
    expect(fresh.checks.find((c) => c.name.startsWith('Cash collected'))).toMatchObject({ ok: false, expectedPesewas: a.total, actualPesewas: a.total + 100 });
    await expectCode(getFinanceReport({ fleet, now: () => w.clock.now }, dispatcher, { period: '2026-11' }), 'PERMISSION_DENIED');
  });

  it('flags delivered parcels that were never paid for', async () => {
    await startShift(deps, kwame, { vehicleId: 'bike1' });
    const a = await cashJob();
    await deliver(a.trackingNumber);
    const data = await fleet.periodData(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    data.bookings[0]!.paymentStatus = 'unpaid';
    const r = buildFinanceReport('2026-11', data, await fleet.ledgerTotals(), w.clock.now);
    expect(r.checks.find((c) => c.name.startsWith('Delivered parcels'))).toMatchObject({ ok: false, actualPesewas: 0, expectedPesewas: a.total });
  });
});

describe('Excel backup', () => {
  const manager: Caller = { uid: 'mgr', role: 'manager', businessId: null, mfa: true };
  it('gives the manager every order with its riders, customers, cash and costs for a date range', async () => {
    await startShift(deps, kwame, { vehicleId: 'bike1', odometerKm: 1_000 });
    const a = await cashJob();
    await deliver(a.trackingNumber);
    await w.book(GUEST, 'cash_on_pickup');
    await logFuel(fdeps, kwame, { litres: 4, amountPesewas: 6_000, odometerKm: 1_010, fullTank: true });
    await recordCashRemittance(fdeps, finance, { driverUid: 'kwame', amountPesewas: a.total, method: 'cash', reference: 'Safe' });

    const day = w.clock.now.toISOString().slice(0, 10);
    const wb = await exportBackup({ fleet, now: () => w.clock.now }, manager, { from: day, to: day });
    const get = (name: string) => wb.sheets.find((s) => s.name === name)!;
    expect(wb.sheets.map((s) => s.name)).toEqual(['Orders', 'Customers', 'Payments', 'Riders', 'Rider cash hand-ins', 'Rider pay', 'Expenses', 'Fuel', 'Shifts']);
    const orders = get('Orders');
    expect(orders.rows).toHaveLength(2);
    const row = Object.fromEntries(orders.columns.map((c, i) => [c, orders.rows.find((r) => r[0] === a.trackingNumber)![i]]));
    expect(row).toMatchObject({ Status: 'Delivered', 'Price (GH₵)': a.total / 100, 'Payment method': 'Cash to rider', 'Pickup rider': 'Kwame Mensah', 'Delivery rider': 'Kwame Mensah' });
    expect(get('Customers').rows[0]!.slice(1, 3)).toEqual(['+233241234567', 2]);
    expect(get('Payments').rows).toEqual([[a.trackingNumber, a.total / 100, 'Cash', 'Kwame Mensah']]);
    expect(get('Rider cash hand-ins').rows[0]![1]).toBe('Kwame Mensah');
    expect(get('Fuel').rows[0]!.slice(1, 5)).toEqual(['Kwame Mensah', 'M-22-GR 101', 4, 60]);
    // Every cell is a plain value Excel can hold.
    for (const s of wb.sheets) for (const r of s.rows) { expect(r).toHaveLength(s.columns.length); for (const c of r) expect(['string', 'number', 'boolean'].includes(typeof c) || c === null).toBe(true); }

    // Nothing that day before; finance and admins may export; riders and dispatchers may not.
    const earlier = await exportBackup({ fleet, now: () => w.clock.now }, finance, { from: '2026-01-01', to: '2026-01-31' });
    expect(earlier.sheets[0]!.rows).toHaveLength(0);
    await expectCode(exportBackup({ fleet, now: () => w.clock.now }, dispatcher, { from: day, to: day }), 'PERMISSION_DENIED');
    await expectCode(exportBackup({ fleet, now: () => w.clock.now }, kwame, { from: day, to: day }), 'PERMISSION_DENIED');
    await expectCode(exportBackup({ fleet, now: () => w.clock.now }, manager, { from: '2026-02-01', to: '2026-01-01' }), 'VALIDATION_FAILED');
  });
});

describe('BigQuery export', () => {
  it('replaces each of the last three days with that day’s rows and exports no personal details', async () => {
    const b = await w.book(GUEST, 'cash_on_pickup');
    const booking = w.store.bookings.get(b.trackingNumber)!;
    const loads: { table: string; day: string; rows: BqRow[] }[] = [];
    const empty = async () => [];
    const written = await exportRecentDays(
      { bookingsCreated: async (s) => (s.toISOString().startsWith('2026-11-09') ? [booking] : []), paymentsPaid: empty, expensesIncurred: empty, fuelLogs: empty, shiftsStarted: empty, statementsPaid: empty },
      { loadDay: async (table, _schema, day, rows) => void loads.push({ table, day, rows }) },
      new Date('2026-11-10T03:17:00Z'),
    );
    expect([...new Set(loads.map((l) => l.day))]).toEqual(['20261107', '20261108', '20261109']);
    expect(loads.filter((l) => l.day === '20261109' && l.table === 'bookings')[0]!.rows).toHaveLength(1);
    expect(written.bookings).toBe(1);
    const row = TABLES.bookings.rows(booking);
    expect(row).toMatchObject({ tracking_number: b.trackingNumber, total_ghs: b.total / 100, pickup_city: 'Accra' });
    const text = JSON.stringify(row);
    expect(text).not.toContain(booking.sender.name);
    expect(text).not.toContain(booking.recipient.phone);
    expect(Object.keys(row).sort()).toEqual(TABLES.bookings.schema.map((f) => f.name).sort());
  });
});
