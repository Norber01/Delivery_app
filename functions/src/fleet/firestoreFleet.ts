import { COLLECTIONS } from '@courier/constants';
import type {
  CashRemittance,
  DriverCashLedger,
  DriverDoc,
  DriverPayRules,
  DriverPayStatement,
  ExpenseDoc,
  FinanceReport,
  FuelLog,
  HubDoc,
  InvoiceDoc,
  MaintenanceRecord,
  RouteDoc,
  RoutePlanDoc,
  ServiceArea,
  ShiftRecord,
  VehicleDoc,
} from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { AggregateField, FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { DRIVER_BUSY_STATUSES } from '../ops/firestoreOps.js';
import type { DeliveryRecord, OpsStore } from '../ops/types.js';
import { fromDoc } from '../store/firestoreStore.js';
import type { AuditEntry, BookingRecord } from '../store/types.js';
import { odometerProblem } from './fleetService.js';
import type { FleetStore, LedgerTotals, PeriodData, Refusal } from './types.js';

type Col = keyof typeof COLLECTIONS;
const CHUNK = 300;

export class FirestoreFleetStore implements FleetStore {
  constructor(
    private readonly db: Firestore,
    private readonly uploads: Pick<OpsStore, 'createUploadTicket' | 'getUploadTicket'>,
  ) {}

  private col(name: Col) {
    return this.db.collection(COLLECTIONS[name]);
  }
  private auditIn(tx: Transaction | FirebaseFirestore.WriteBatch, a: AuditEntry) {
    (tx as Transaction).create(this.col('auditLogs').doc(), { ...a, at: FieldValue.serverTimestamp() });
  }
  /** Documents with their id (some collections, e.g. seeded service areas, keep it only as the doc id). */
  private async all<T>(q: FirebaseFirestore.Query): Promise<T[]> {
    return (await q.get()).docs.map((d) => fromDoc<T>({ id: d.id, ...d.data() }));
  }
  private async getMany<T>(name: Col, ids: string[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const refs = ids.slice(i, i + CHUNK).map((id) => this.col(name).doc(id));
      if (refs.length) out.push(...(await this.db.getAll(...refs)).filter((s) => s.exists).map((s) => fromDoc<T>(s.data()!)));
    }
    return out;
  }

  // ---- Routing ----------------------------------------------------------------------------------
  activeDeliveriesForDriver(uid: string) {
    return this.all<DeliveryRecord>(this.col('deliveries').where('currentDriverUid', '==', uid).where('status', 'in', DRIVER_BUSY_STATUSES).limit(100));
  }
  async saveRoutePlan(plan: RoutePlanDoc) {
    await this.col('routePlans').doc(plan.driverUid).set(plan);
  }

  // ---- Vehicles, shifts, odometer -----------------------------------------------------------------
  async getVehicle(id: string) {
    const s = await this.col('vehicles').doc(id).get();
    return s.exists ? fromDoc<VehicleDoc>(s.data()!) : null;
  }
  async getDriver(uid: string) {
    const s = await this.col('drivers').doc(uid).get();
    return s.exists ? fromDoc<DriverDoc>(s.data()!) : null;
  }
  private odometerIn(tx: Transaction, vehicle: FirebaseFirestore.DocumentSnapshot, km: number): Refusal | null {
    const prev = (vehicle.get('odometerKm') as number | undefined) ?? null;
    const problem = odometerProblem(prev, km);
    if (problem) return { error: problem };
    if (prev === null || km > prev) tx.update(vehicle.ref, { odometerKm: km });
    return null;
  }
  async recordOdometer(vehicleId: string, km: number) {
    return this.db.runTransaction(async (tx) => {
      const v = await tx.get(this.col('vehicles').doc(vehicleId));
      if (!v.exists) return { error: 'Vehicle not found.' };
      const prev = (v.get('odometerKm') as number | undefined) ?? 0;
      const refused = this.odometerIn(tx, v, km);
      return refused ?? { previous: prev };
    });
  }
  async recordShiftStart(s: ShiftRecord) {
    await this.col('shifts').doc(s.id).set(s, { merge: true });
  }
  async recordShiftEnd(shiftId: string, endedAt: string, endOdometerKm: number | null) {
    await this.col('shifts').doc(shiftId).set({ endedAt, endOdometerKm }, { merge: true });
  }
  async updateVehicle(id: string, patch: Partial<VehicleDoc>, audit: AuditEntry) {
    const b = this.db.batch();
    b.update(this.col('vehicles').doc(id), { ...patch, updatedAt: FieldValue.serverTimestamp() });
    this.auditIn(b, audit);
    await b.commit();
  }
  async addMaintenance(m: MaintenanceRecord, expense: ExpenseDoc | null, vehiclePatch: Partial<VehicleDoc> | null, audit: AuditEntry) {
    const b = this.db.batch();
    b.create(this.col('maintenance').doc(m.id), { ...m, createdAt: FieldValue.serverTimestamp() });
    if (expense) b.create(this.col('expenses').doc(expense.id), { ...expense, createdAt: FieldValue.serverTimestamp() });
    if (vehiclePatch) b.update(this.col('vehicles').doc(m.vehicleId), vehiclePatch);
    this.auditIn(b, audit);
    await b.commit();
  }
  async addFuelLog(log: FuelLog, expense: ExpenseDoc) {
    return this.db.runTransaction(async (tx): Promise<'ok' | Refusal> => {
      const v = await tx.get(this.col('vehicles').doc(log.vehicleId));
      if (!v.exists) return { error: 'Vehicle not found.' };
      const refused = this.odometerIn(tx, v, log.odometerKm);
      if (refused) return refused;
      tx.create(this.col('fuelLogs').doc(log.id), { ...log, createdAt: FieldValue.serverTimestamp() });
      tx.create(this.col('expenses').doc(expense.id), { ...expense, createdAt: FieldValue.serverTimestamp() });
      return 'ok';
    });
  }
  createUploadTicket(t: Parameters<OpsStore['createUploadTicket']>[0]) {
    return this.uploads.createUploadTicket(t);
  }
  getUploadTicket(key: string) {
    return this.uploads.getUploadTicket(key);
  }

  // ---- Expenses -----------------------------------------------------------------------------------
  async createExpense(e: ExpenseDoc, audit: AuditEntry) {
    const b = this.db.batch();
    b.create(this.col('expenses').doc(e.id), { ...e, createdAt: FieldValue.serverTimestamp() });
    this.auditIn(b, audit);
    await b.commit();
  }
  async updateExpense(id: string, decide: (e: ExpenseDoc) => Partial<ExpenseDoc> | Refusal, audit: AuditEntry) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.col('expenses').doc(id);
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const e = fromDoc<ExpenseDoc>(s.data()!);
      const r = decide(e);
      if ('error' in r) return r as Refusal;
      tx.update(ref, { ...r, updatedAt: FieldValue.serverTimestamp() });
      this.auditIn(tx, audit);
      return { ...e, ...r };
    });
  }

  // ---- Driver pay ---------------------------------------------------------------------------------
  async getPayRules() {
    const s = await this.col('config').doc('driverPay').get();
    return s.exists ? (s.data() as DriverPayRules) : null;
  }
  async setPayRules(r: DriverPayRules, audit: AuditEntry) {
    const b = this.db.batch();
    b.set(this.col('config').doc('driverPay'), r);
    this.auditIn(b, audit);
    await b.commit();
  }
  listDrivers() {
    return this.all<DriverDoc>(this.col('drivers'));
  }
  listShifts(start: Date, end: Date) {
    return this.all<ShiftRecord>(this.col('shifts').where('startedAt', '>=', start.toISOString()).where('startedAt', '<', end.toISOString()));
  }
  async listCompletedJobs(start: Date, end: Date) {
    const snap = await this.col('assignments')
      .where('status', '==', 'completed')
      .where('endedAt', '>=', Timestamp.fromDate(start))
      .where('endedAt', '<', Timestamp.fromDate(end))
      .get();
    const rows = snap.docs.map((d) => d.data() as { driverUid: string; deliveryId: string; legId: string });
    const deliveries = new Map((await this.getMany<DeliveryRecord>('deliveries', [...new Set(rows.map((r) => r.deliveryId))])).map((d) => [d.id, d]));
    return rows.flatMap((r) => {
      const leg = deliveries.get(r.deliveryId)?.legs.find((l) => l.id === r.legId);
      return leg ? [{ driverUid: r.driverUid, legType: leg.type }] : [];
    });
  }
  async listLinehaulTrips(start: Date, end: Date) {
    const snap = await this.col('manifests').where('arrivedAt', '>=', start.toISOString()).where('arrivedAt', '<', end.toISOString()).get();
    return snap.docs.map((d) => ({ driverUid: d.get('driverUid') as string }));
  }
  async getStatement(id: string) {
    const s = await this.col('driverPayments').doc(id).get();
    return s.exists ? (s.data() as DriverPayStatement) : null;
  }
  async saveDraftStatement(stmt: DriverPayStatement) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.col('driverPayments').doc(stmt.id);
      const s = await tx.get(ref);
      if (s.exists && s.get('status') !== 'draft') return 'final' as const;
      tx.set(ref, stmt);
      return 'saved' as const;
    });
  }
  async updateStatement(
    id: string,
    decide: (s: DriverPayStatement) => { patch: Partial<DriverPayStatement>; expense?: ExpenseDoc } | Refusal,
    audit: AuditEntry,
  ) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.col('driverPayments').doc(id);
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() as DriverPayStatement;
      const r = decide(cur);
      if ('error' in r) return r;
      tx.update(ref, r.patch);
      if (r.expense) tx.create(this.col('expenses').doc(r.expense.id), { ...r.expense, createdAt: FieldValue.serverTimestamp() });
      this.auditIn(tx, audit);
      return { ...cur, ...r.patch };
    });
  }

  // ---- Cash -------------------------------------------------------------------------------------
  async getCash(uid: string): Promise<DriverCashLedger> {
    const s = await this.col('driverCash').doc(uid).get();
    return { driverUid: uid, collectedPesewas: (s.get('collectedPesewas') as number | undefined) ?? 0, remittedPesewas: (s.get('remittedPesewas') as number | undefined) ?? 0 };
  }
  async recordRemittance(r: CashRemittance, audit: AuditEntry) {
    return this.db.runTransaction(async (tx): Promise<'ok' | Refusal> => {
      const ref = this.col('driverCash').doc(r.driverUid);
      const s = await tx.get(ref);
      const outstanding = ((s.get('collectedPesewas') as number | undefined) ?? 0) - ((s.get('remittedPesewas') as number | undefined) ?? 0);
      if (r.amountPesewas > outstanding) return { error: `This driver only holds ${formatGhs(Math.max(0, outstanding))} in cash.` };
      tx.create(this.col('cashRemittances').doc(r.id), { ...r, createdAt: FieldValue.serverTimestamp() });
      tx.set(ref, { driverUid: r.driverUid, remittedPesewas: FieldValue.increment(r.amountPesewas) }, { merge: true });
      this.auditIn(tx, audit);
      return 'ok';
    });
  }

  // ---- Reporting --------------------------------------------------------------------------------
  async periodData(start: Date, end: Date): Promise<PeriodData> {
    const iso = [start.toISOString(), end.toISOString()] as const;
    const ts = [Timestamp.fromDate(start), Timestamp.fromDate(end)] as const;
    const bookings = await this.all<BookingRecord>(this.col('deliveryRequests').where('createdAt', '>=', ts[0]).where('createdAt', '<', ts[1]));
    const [deliveries, payments, refunds, invoices, expenses, remittances, shifts, fuelLogs, manifests, statements, vehicles, areas, routes, hubs, drivers] = await Promise.all([
      this.getMany<DeliveryRecord>('deliveries', bookings.map((b) => b.trackingNumber)),
      this.col('payments').where('status', '==', 'succeeded').where('paidAt', '>=', ts[0]).where('paidAt', '<', ts[1]).get().then((s) =>
        s.docs.map((d) => ({ id: d.id, provider: d.get('provider') as string, amountPesewas: d.get('amountPesewas') as number, trackingNumber: d.get('trackingNumber') as string, collectedBy: (d.get('collectedBy') as string | undefined) ?? null })),
      ),
      this.col('refunds').where('status', '==', 'processed').where('updatedAt', '>=', ts[0]).where('updatedAt', '<', ts[1]).get().then((s) => s.docs.map((d) => ({ amountPesewas: d.get('amountPesewas') as number }))),
      this.all<InvoiceDoc>(this.col('invoices').limit(5000)),
      this.all<ExpenseDoc>(this.col('expenses').where('incurredAt', '>=', iso[0]).where('incurredAt', '<', iso[1])),
      this.all<CashRemittance>(this.col('cashRemittances').where('receivedAt', '>=', iso[0]).where('receivedAt', '<', iso[1])),
      this.listShifts(start, end),
      this.all<FuelLog>(this.col('fuelLogs').where('filledAt', '>=', iso[0]).where('filledAt', '<', iso[1])),
      this.col('manifests').where('departedAt', '>=', iso[0]).where('departedAt', '<', iso[1]).get().then((s) => s.docs.map((d) => ({ id: d.id, routeId: d.get('routeId') as string, vehicleId: d.get('vehicleId') as string }))),
      this.all<DriverPayStatement>(this.col('driverPayments').where('paidAt', '>=', iso[0]).where('paidAt', '<', iso[1])),
      this.all<VehicleDoc>(this.col('vehicles')),
      this.all<ServiceArea>(this.col('serviceAreas')),
      this.all<RouteDoc>(this.col('routes')),
      this.all<HubDoc>(this.col('hubs')),
      this.all<DriverDoc>(this.col('drivers')),
    ]);
    // Expenses for statements paid this month may be dated this month; include their statements' expenses.
    return { bookings, deliveries, payments, refunds, invoices, expenses, remittances, shifts, fuelLogs, manifests, statements, vehicles, areas, routes, hubs, drivers };
  }
  async ledgerTotals(): Promise<LedgerTotals> {
    const sum = async (q: FirebaseFirestore.Query, field: string) => ((await q.aggregate({ total: AggregateField.sum(field) }).get()).data().total as number | null) ?? 0;
    const [cashPayments, collected, remitted, remittances] = await Promise.all([
      sum(this.col('payments').where('provider', '==', 'cash').where('status', '==', 'succeeded'), 'amountPesewas'),
      sum(this.col('driverCash'), 'collectedPesewas'),
      sum(this.col('driverCash'), 'remittedPesewas'),
      sum(this.col('cashRemittances'), 'amountPesewas'),
    ]);
    return { cashPaymentsPesewas: cashPayments, ledgerCollectedPesewas: collected, ledgerRemittedPesewas: remitted, remittancesPesewas: remittances };
  }
  async saveReport(r: FinanceReport) {
    await this.col('reports').doc(`finance-${r.period}`).set(r);
  }
  async getReport(period: string) {
    const s = await this.col('reports').doc(`finance-${period}`).get();
    return s.exists ? (s.data() as FinanceReport) : null;
  }
}
