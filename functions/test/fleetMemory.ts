import type {
  CashRemittance,
  DriverPayRules,
  DriverPayStatement,
  ExpenseDoc,
  FinanceReport,
  FuelLog,
  InvoiceDoc,
  MaintenanceRecord,
  RoutePlanDoc,
  ShiftRecord,
  VehicleDoc,
} from '@courier/shared-types';
import { odometerProblem } from '../src/fleet/fleetService.js';
import type { FleetStore, LedgerTotals, PeriodData, Refusal } from '../src/fleet/types.js';
import type { AuditEntry } from '../src/store/types.js';
import type { MemoryStore } from './memoryStore.js';
import type { MemoryOpsStore } from './opsMemory.js';

const BUSY = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];
const clone = <T>(v: T): T => structuredClone(v);
const inRange = (iso: string | null | undefined, s: Date, e: Date) => !!iso && iso >= s.toISOString() && iso < e.toISOString();

/** In-memory FleetStore over the memory ops/booking stores (same semantics as FirestoreFleetStore). */
export class MemoryFleetStore implements FleetStore {
  plans = new Map<string, RoutePlanDoc>();
  shifts = new Map<string, ShiftRecord>();
  maintenance: MaintenanceRecord[] = [];
  fuel: FuelLog[] = [];
  expenses = new Map<string, ExpenseDoc>();
  payRules: DriverPayRules | null = null;
  statements = new Map<string, DriverPayStatement>();
  remittances: CashRemittance[] = [];
  reports = new Map<string, FinanceReport>();
  invoices = new Map<string, InvoiceDoc>();

  constructor(
    private readonly ops: MemoryOpsStore,
    private readonly store: MemoryStore,
  ) {}

  async activeDeliveriesForDriver(uid: string) {
    return [...this.ops.deliveries.values()].filter((d) => d.currentDriverUid === uid && BUSY.includes(d.status)).map(clone);
  }
  async saveRoutePlan(p: RoutePlanDoc) {
    this.plans.set(p.driverUid, clone(p));
  }
  async getVehicle(id: string) {
    const v = this.ops.vehicles.get(id);
    return v ? clone(v) : null;
  }
  async getDriver(uid: string) {
    const d = this.ops.drivers.get(uid);
    return d ? clone(d) : null;
  }
  private odometer(v: VehicleDoc, km: number): Refusal | null {
    const problem = odometerProblem(v.odometerKm ?? null, km);
    if (problem) return { error: problem };
    v.odometerKm = Math.max(v.odometerKm ?? 0, km);
    return null;
  }
  async recordOdometer(vehicleId: string, km: number) {
    const v = this.ops.vehicles.get(vehicleId);
    if (!v) return { error: 'Vehicle not found.' };
    const prev = v.odometerKm ?? 0;
    return this.odometer(v, km) ?? { previous: prev };
  }
  async recordShiftStart(s: ShiftRecord) {
    this.shifts.set(s.id, { ...(this.shifts.get(s.id) ?? {}), ...clone(s) });
  }
  async recordShiftEnd(id: string, endedAt: string, endOdometerKm: number | null) {
    const s = this.shifts.get(id);
    if (s) Object.assign(s, { endedAt, endOdometerKm });
  }
  async updateVehicle(id: string, patch: Partial<VehicleDoc>, audit: AuditEntry) {
    Object.assign(this.ops.vehicles.get(id)!, clone(patch));
    this.store.audit.push(audit);
  }
  async addMaintenance(m: MaintenanceRecord, e: ExpenseDoc | null, patch: Partial<VehicleDoc> | null, audit: AuditEntry) {
    this.maintenance.push(clone(m));
    if (e) this.expenses.set(e.id, clone(e));
    if (patch) Object.assign(this.ops.vehicles.get(m.vehicleId)!, patch);
    this.store.audit.push(audit);
  }
  async addFuelLog(log: FuelLog, e: ExpenseDoc) {
    const v = this.ops.vehicles.get(log.vehicleId);
    if (!v) return { error: 'Vehicle not found.' };
    const before = v.odometerKm;
    const refused = this.odometer(v, log.odometerKm);
    if (refused) {
      v.odometerKm = before;
      return refused;
    }
    this.fuel.push(clone(log));
    this.expenses.set(e.id, clone(e));
    return 'ok' as const;
  }
  createUploadTicket(t: Parameters<MemoryOpsStore['createUploadTicket']>[0]) {
    return this.ops.createUploadTicket(t);
  }
  getUploadTicket(key: string) {
    return this.ops.getUploadTicket(key);
  }
  async createExpense(e: ExpenseDoc, audit: AuditEntry) {
    this.expenses.set(e.id, clone(e));
    this.store.audit.push(audit);
  }
  async updateExpense(id: string, decide: (e: ExpenseDoc) => Partial<ExpenseDoc> | Refusal, audit: AuditEntry) {
    const e = this.expenses.get(id);
    if (!e) return null;
    const r = decide(clone(e));
    if ('error' in r) return r as Refusal;
    Object.assign(e, r);
    this.store.audit.push(audit);
    return clone(e);
  }
  async getPayRules() {
    return this.payRules;
  }
  async setPayRules(r: DriverPayRules, audit: AuditEntry) {
    this.payRules = clone(r);
    this.store.audit.push(audit);
  }
  async listDrivers() {
    return [...this.ops.drivers.values()].map(clone);
  }
  async listShifts(s: Date, e: Date) {
    return [...this.shifts.values()].filter((x) => inRange(x.startedAt, s, e)).map(clone);
  }
  async listCompletedJobs(s: Date, e: Date) {
    return [...this.ops.assignments.values()]
      .filter((a) => a.status === 'completed' && a.endedAt && a.endedAt >= s && a.endedAt < e)
      .flatMap((a) => {
        const leg = this.ops.deliveries.get(a.deliveryId)?.legs.find((l) => l.id === a.legId);
        return leg ? [{ driverUid: a.driverUid, legType: leg.type }] : [];
      });
  }
  async listLinehaulTrips(s: Date, e: Date) {
    return [...this.ops.manifests.values()].filter((m) => inRange(m.arrivedAt, s, e)).map((m) => ({ driverUid: m.driverUid }));
  }
  async getStatement(id: string) {
    const x = this.statements.get(id);
    return x ? clone(x) : null;
  }
  async saveDraftStatement(s: DriverPayStatement) {
    const cur = this.statements.get(s.id);
    if (cur && cur.status !== 'draft') return 'final' as const;
    this.statements.set(s.id, clone(s));
    return 'saved' as const;
  }
  async updateStatement(id: string, decide: (s: DriverPayStatement) => { patch: Partial<DriverPayStatement>; expense?: ExpenseDoc } | Refusal, audit: AuditEntry) {
    const cur = this.statements.get(id);
    if (!cur) return null;
    const r = decide(clone(cur));
    if ('error' in r) return r;
    Object.assign(cur, r.patch);
    if (r.expense) this.expenses.set(r.expense.id, clone(r.expense));
    this.store.audit.push(audit);
    return clone(cur);
  }
  async getCash(uid: string) {
    const l = this.ops.driverCash.get(uid);
    return { driverUid: uid, collectedPesewas: l?.collectedPesewas ?? 0, remittedPesewas: l?.remittedPesewas ?? 0 };
  }
  async recordRemittance(r: CashRemittance, audit: AuditEntry) {
    const l = this.ops.driverCash.get(r.driverUid) ?? { driverUid: r.driverUid, collectedPesewas: 0, remittedPesewas: 0 };
    const outstanding = l.collectedPesewas - l.remittedPesewas;
    if (r.amountPesewas > outstanding) return { error: `This driver only holds GH₵ ${(Math.max(0, outstanding) / 100).toFixed(2)} in cash.` };
    l.remittedPesewas += r.amountPesewas;
    this.ops.driverCash.set(r.driverUid, l);
    this.remittances.push(clone(r));
    this.store.audit.push(audit);
    return 'ok' as const;
  }
  async periodData(s: Date, e: Date): Promise<PeriodData> {
    const bookings = [...this.store.bookings.values()].filter((b) => b.createdAt >= s && b.createdAt < e).map(clone);
    return {
      bookings,
      deliveries: bookings.flatMap((b) => (this.ops.deliveries.has(b.trackingNumber) ? [clone(this.ops.deliveries.get(b.trackingNumber)!)] : [])),
      payments: [...this.store.payments.values()]
        .filter((p) => p.status === 'succeeded' && p.paidAt && p.paidAt >= s && p.paidAt < e)
        .map((p) => ({ id: p.id, provider: p.provider, amountPesewas: p.amountPesewas, trackingNumber: p.trackingNumber, collectedBy: p.collectedBy ?? null })),
      refunds: [...this.store.refunds.values()].filter((r) => r.status === 'processed' && r.updatedAt >= s && r.updatedAt < e).map((r) => ({ amountPesewas: r.amountPesewas })),
      invoices: [...this.invoices.values()].map(clone),
      expenses: [...this.expenses.values()].filter((x) => inRange(x.incurredAt, s, e)).map(clone),
      remittances: this.remittances.filter((r) => inRange(r.receivedAt, s, e)).map(clone),
      shifts: await this.listShifts(s, e),
      fuelLogs: this.fuel.filter((f) => inRange(f.filledAt, s, e)).map(clone),
      manifests: [...this.ops.manifests.values()].filter((m) => inRange(m.departedAt, s, e)).map((m) => ({ id: m.id, routeId: m.routeId, vehicleId: m.vehicleId })),
      statements: [...this.statements.values()].filter((x) => inRange(x.paidAt, s, e)).map(clone),
      vehicles: [...this.ops.vehicles.values()].map(clone),
      areas: clone(this.store.areas),
      routes: [...this.ops.routes.values()].map(clone),
      hubs: [...this.ops.hubs.values()].map(clone),
      drivers: [...this.ops.drivers.values()].map(clone),
    };
  }
  async ledgerTotals(): Promise<LedgerTotals> {
    const ledgers = [...this.ops.driverCash.values()];
    return {
      cashPaymentsPesewas: [...this.store.payments.values()].filter((p) => p.provider === 'cash' && p.status === 'succeeded').reduce((n, p) => n + p.amountPesewas, 0),
      ledgerCollectedPesewas: ledgers.reduce((n, l) => n + l.collectedPesewas, 0),
      ledgerRemittedPesewas: ledgers.reduce((n, l) => n + l.remittedPesewas, 0),
      remittancesPesewas: this.remittances.reduce((n, r) => n + r.amountPesewas, 0),
    };
  }
  async saveReport(r: FinanceReport) {
    this.reports.set(r.period, clone(r));
  }
  async getReport(period: string) {
    return this.reports.get(period) ?? null;
  }
}
