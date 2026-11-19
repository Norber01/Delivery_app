import type {
  DriverPayStatus,
  ExpenseCategory,
  ExpenseStatus,
  LegType,
  MaintenanceType,
  PayoutMethod,
  VehicleClass,
} from '@courier/constants';
import type { IsoDateString, LatLng } from './common.js';

/** `routePlans/{driverUid}`: the optimised order of a driver's current stops. */
export interface RoutePlanStop {
  seq: number;
  deliveryId: string;
  kind: 'pickup' | 'drop';
  label: string;
  location: LatLng;
  eta: IsoDateString;
  dueAt: IsoDateString | null;
  late: boolean;
}
export interface RoutePlanDoc {
  driverUid: string;
  stops: RoutePlanStop[];
  travelMinutes: number;
  /** Same stops in assignment order (what a driver would do without a plan). */
  baselineMinutes: number;
  savingPercent: number;
  lateStops: number;
  startFrom: 'live_location' | 'first_stop';
  vehicleClass: VehicleClass;
  computedAt: IsoDateString;
  computedBy: string;
}

/** `shifts/{shiftId}`: history of shifts (days worked, distance driven). */
export interface ShiftRecord {
  id: string;
  driverUid: string;
  vehicleId: string;
  startedAt: IsoDateString;
  endedAt: IsoDateString | null;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
}

/** `vehicles/{id}/maintenance/{id}` */
export interface MaintenanceRecord {
  id: string;
  vehicleId: string;
  type: MaintenanceType;
  description: string;
  costPesewas: number;
  odometerKm: number | null;
  performedAt: IsoDateString;
  vendor: string | null;
  receiptKey: string | null;
  expenseId: string | null;
  recordedBy: string;
}

/** `vehicles/{id}/fuelLogs/{id}` */
export interface FuelLog {
  id: string;
  vehicleId: string;
  driverUid: string;
  litres: number;
  amountPesewas: number;
  odometerKm: number;
  fullTank: boolean;
  station: string | null;
  receiptKey: string | null;
  expenseId: string;
  filledAt: IsoDateString;
}

/** `expenses/{id}` */
export interface ExpenseDoc {
  id: string;
  category: ExpenseCategory;
  description: string;
  amountPesewas: number;
  vehicleId: string | null;
  hubId: string | null;
  driverUid: string | null;
  receiptKey: string | null;
  incurredAt: IsoDateString;
  status: ExpenseStatus;
  submittedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  /** Source record (fuel log, maintenance record, driver pay statement). */
  sourceId: string | null;
}

/** `config/driverPay`: how driver pay statements are calculated. */
export interface DriverPayRules {
  /** Paid for each calendar day with at least one shift. */
  dailyRatePesewas: number;
  /** Paid per completed job (pickup + delivery, or one leg of an intercity parcel). */
  perJobPesewas: Record<Exclude<LegType, 'linehaul'>, number>;
  /** Paid per completed linehaul trip (manifest arrived). */
  perLinehaulTripPesewas: number;
  updatedBy: string;
  updatedAt: IsoDateString;
}

export interface PayLine {
  label: string;
  quantity: number;
  ratePesewas: number;
  amountPesewas: number;
}
export interface PayAdjustment {
  label: string;
  amountPesewas: number;
  by: string;
  at: IsoDateString;
}

/** `driverPayments/{period}_{uid}`: monthly pay statement. */
export interface DriverPayStatement {
  id: string;
  period: string;
  driverUid: string;
  driverName: string;
  lines: PayLine[];
  adjustments: PayAdjustment[];
  grossPesewas: number;
  /** Informational: cash collected by the driver not yet handed in when the statement was made. */
  cashOutstandingPesewas: number;
  daysWorked: number;
  kmDriven: number;
  status: DriverPayStatus;
  generatedAt: IsoDateString;
  approvedBy: string | null;
  paidAt: IsoDateString | null;
  payout: { method: PayoutMethod; reference: string; by: string } | null;
  expenseId: string | null;
}

/** `driverCash/{uid}`: cash collected from customers vs handed in to the company. */
export interface DriverCashLedger {
  driverUid: string;
  collectedPesewas: number;
  remittedPesewas: number;
}
/** `cashRemittances/{id}` */
export interface CashRemittance {
  id: string;
  driverUid: string;
  amountPesewas: number;
  method: PayoutMethod;
  reference: string;
  receivedBy: string;
  receivedAt: IsoDateString;
}

export interface MoneyByKey {
  key: string;
  label: string;
  revenuePesewas: number;
  costPesewas: number;
  contributionPesewas: number;
  deliveries: number;
}

/** `reports/finance-{period}`: monthly finance report (computed on request). */
export interface FinanceReport {
  period: string;
  computedAt: IsoDateString;
  revenue: { bookedPesewas: number; deliveries: number; byType: Record<string, number> };
  collections: {
    onlinePesewas: number;
    cashCollectedPesewas: number;
    invoicePaymentsPesewas: number;
    refundsPesewas: number;
    cashRemittedPesewas: number;
  };
  costs: { byCategory: Record<string, number>; totalPesewas: number; pendingApprovalPesewas: number };
  contributionPesewas: number;
  byArea: MoneyByKey[];
  byRoute: MoneyByKey[];
  byVehicle: (MoneyByKey & { kmDriven: number; fuelLitres: number; kmPerLitre: number | null; costPerKmPesewas: number | null })[];
  /** Ledger cross-checks; each must be ok for the books to reconcile. */
  checks: { name: string; ok: boolean; expectedPesewas: number; actualPesewas: number; note: string }[];
}
