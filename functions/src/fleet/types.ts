import type { LegType } from '@courier/constants';
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
import type { DeliveryRecord } from '../ops/types.js';
import type { AuditEntry, BookingRecord } from '../store/types.js';

export type LegTypeName = LegType;

/** A refusal decided inside a transaction, returned instead of thrown so the store stays generic. */
export type Refusal = { error: string; code?: string };

export interface PeriodData {
  bookings: BookingRecord[];
  deliveries: DeliveryRecord[];
  /** Succeeded payments paid within the period. */
  payments: { id: string; provider: string; amountPesewas: number; trackingNumber: string; collectedBy?: string | null }[];
  refunds: { amountPesewas: number }[];
  invoices: InvoiceDoc[];
  expenses: ExpenseDoc[];
  remittances: CashRemittance[];
  shifts: ShiftRecord[];
  fuelLogs: FuelLog[];
  manifests: { id: string; routeId: string; vehicleId: string }[];
  statements: DriverPayStatement[];
  vehicles: VehicleDoc[];
  areas: ServiceArea[];
  routes: RouteDoc[];
  hubs: HubDoc[];
  drivers: DriverDoc[];
}

export interface LedgerTotals {
  /** All time: succeeded cash payments vs the drivers' cash ledgers. */
  cashPaymentsPesewas: number;
  ledgerCollectedPesewas: number;
  ledgerRemittedPesewas: number;
  remittancesPesewas: number;
}

export interface FleetStore {
  // Route planning
  activeDeliveriesForDriver(uid: string): Promise<DeliveryRecord[]>;
  saveRoutePlan(plan: RoutePlanDoc): Promise<void>;

  // Vehicles, shifts, odometer
  getVehicle(id: string): Promise<VehicleDoc | null>;
  getDriver(uid: string): Promise<DriverDoc | null>;
  /** Raise the odometer (never lowers it); returns the previous value or a refusal. */
  recordOdometer(vehicleId: string, km: number, maxJumpKm: number): Promise<{ previous: number } | Refusal>;
  recordShiftStart(s: ShiftRecord): Promise<void>;
  recordShiftEnd(shiftId: string, endedAt: string, endOdometerKm: number | null): Promise<void>;
  updateVehicle(id: string, patch: Partial<VehicleDoc>, audit: AuditEntry): Promise<void>;
  addMaintenance(m: MaintenanceRecord, expense: ExpenseDoc | null, vehiclePatch: Partial<VehicleDoc> | null, audit: AuditEntry): Promise<void>;
  addFuelLog(log: FuelLog, expense: ExpenseDoc, maxJumpKm: number): Promise<'ok' | Refusal>;

  // Uploads (receipts share the upload-ticket mechanism with POD photos)
  createUploadTicket(t: { key: string; deliveryId: string; driverUid: string; contentType: string; maxBytes: number; expiresAt: Date }): Promise<void>;
  getUploadTicket(key: string): Promise<{ deliveryId: string; driverUid: string } | null>;

  // Expenses
  createExpense(e: ExpenseDoc, audit: AuditEntry): Promise<void>;
  updateExpense(id: string, decide: (e: ExpenseDoc) => Partial<ExpenseDoc> | Refusal, audit: AuditEntry): Promise<ExpenseDoc | Refusal | null>;

  // Driver pay
  getPayRules(): Promise<DriverPayRules | null>;
  setPayRules(r: DriverPayRules, audit: AuditEntry): Promise<void>;
  listDrivers(): Promise<DriverDoc[]>;
  listShifts(start: Date, end: Date): Promise<ShiftRecord[]>;
  /** Completed assignments ended in [start, end), with the type of the leg they covered. */
  listCompletedJobs(start: Date, end: Date): Promise<{ driverUid: string; legType: LegTypeName }[]>;
  /** Linehaul trips that arrived in [start, end). */
  listLinehaulTrips(start: Date, end: Date): Promise<{ driverUid: string }[]>;
  getStatement(id: string): Promise<DriverPayStatement | null>;
  /** Write a draft unless the statement already exists in a final state (keeps adjustments). */
  saveDraftStatement(s: DriverPayStatement): Promise<'saved' | 'final'>;
  updateStatement(
    id: string,
    decide: (s: DriverPayStatement) => { patch: Partial<DriverPayStatement>; expense?: ExpenseDoc } | Refusal,
    audit: AuditEntry,
  ): Promise<DriverPayStatement | Refusal | null>;

  // Cash
  getCash(uid: string): Promise<DriverCashLedger>;
  recordRemittance(r: CashRemittance, audit: AuditEntry): Promise<'ok' | Refusal>;

  // Reporting
  periodData(start: Date, end: Date): Promise<PeriodData>;
  ledgerTotals(): Promise<LedgerTotals>;
  saveReport(r: FinanceReport): Promise<void>;
  getReport(period: string): Promise<FinanceReport | null>;
}
