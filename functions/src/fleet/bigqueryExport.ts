/**
 * Daily export to BigQuery for analysis beyond the built-in reports (Looker Studio, SQL).
 *
 * Off unless the BIGQUERY_EXPORT parameter is "on". Each run reloads the last few days into
 * day-partitioned tables (replacing those partitions), so re-runs and missed days are safe and
 * the tables never hold duplicates. Load jobs are free; storage is cents per GB per month.
 * Personal details (names, phone numbers, addresses beyond the city) are not exported.
 */
import type { DriverPayStatement, ExpenseDoc, FuelLog, ShiftRecord } from '@courier/shared-types';
import type { BookingRecord } from '../store/types.js';

export type BqField = { name: string; type: 'STRING' | 'INT64' | 'FLOAT64' | 'BOOL' | 'TIMESTAMP' | 'DATE'; mode?: 'NULLABLE' | 'REQUIRED' };
export type BqRow = Record<string, string | number | boolean | null>;

export interface BigQueryPort {
  /** Replace one day's partition of `table` with `rows` (creating dataset/table as needed). */
  loadDay(table: string, schema: BqField[], day: string, rows: BqRow[]): Promise<void>;
}

export interface ExportSource {
  bookingsCreated(start: Date, end: Date): Promise<BookingRecord[]>;
  paymentsPaid(start: Date, end: Date): Promise<{ id: string; provider: string; channel: string | null; amountPesewas: number; trackingNumber: string; businessId: string | null; paidAt: Date }[]>;
  expensesIncurred(start: Date, end: Date): Promise<ExpenseDoc[]>;
  fuelLogs(start: Date, end: Date): Promise<FuelLog[]>;
  shiftsStarted(start: Date, end: Date): Promise<ShiftRecord[]>;
  statementsPaid(start: Date, end: Date): Promise<DriverPayStatement[]>;
}

const ghs = (pesewas: number) => Math.round(pesewas) / 100;
const s = (name: string): BqField => ({ name, type: 'STRING' });
const n = (name: string): BqField => ({ name, type: 'FLOAT64' });
const i = (name: string): BqField => ({ name, type: 'INT64' });
const t = (name: string): BqField => ({ name, type: 'TIMESTAMP' });

export const TABLES = {
  bookings: {
    schema: [s('tracking_number'), t('created_at'), s('status'), s('source'), s('delivery_type'), s('urgency'), s('payment_preference'), s('payment_status'), n('total_ghs'), n('chargeable_weight_kg'), i('packages'), s('pickup_city'), s('pickup_region'), s('destination_city'), s('destination_region'), s('business_id'), { name: 'customer_account', type: 'BOOL' } as BqField],
    rows: (b: BookingRecord): BqRow => ({
      tracking_number: b.trackingNumber,
      created_at: b.createdAt.toISOString(),
      status: b.status,
      source: b.source,
      delivery_type: b.deliveryType,
      urgency: b.urgency,
      payment_preference: b.paymentPreference,
      payment_status: b.paymentStatus,
      total_ghs: ghs(b.price.totalPesewas),
      chargeable_weight_kg: b.price.chargeableWeightKg ?? null,
      packages: b.packages.reduce((k, p) => k + p.quantity, 0),
      pickup_city: b.pickup.city,
      pickup_region: b.pickup.region,
      destination_city: b.destination.city,
      destination_region: b.destination.region,
      business_id: b.businessId ?? null,
      customer_account: Boolean(b.customerUid),
    }),
  },
  payments: {
    schema: [s('payment_id'), s('tracking_number'), s('provider'), s('channel'), n('amount_ghs'), s('business_id'), t('paid_at')],
    rows: (p: Awaited<ReturnType<ExportSource['paymentsPaid']>>[number]): BqRow => ({
      payment_id: p.id,
      tracking_number: p.trackingNumber,
      provider: p.provider,
      channel: p.channel,
      amount_ghs: ghs(p.amountPesewas),
      business_id: p.businessId,
      paid_at: p.paidAt.toISOString(),
    }),
  },
  expenses: {
    schema: [s('expense_id'), s('category'), s('status'), n('amount_ghs'), s('vehicle_id'), s('hub_id'), s('driver_uid'), t('incurred_at')],
    rows: (e: ExpenseDoc): BqRow => ({ expense_id: e.id, category: e.category, status: e.status, amount_ghs: ghs(e.amountPesewas), vehicle_id: e.vehicleId, hub_id: e.hubId, driver_uid: e.driverUid, incurred_at: e.incurredAt }),
  },
  fuel_logs: {
    schema: [s('fuel_log_id'), s('vehicle_id'), s('driver_uid'), n('litres'), n('amount_ghs'), i('odometer_km'), { name: 'full_tank', type: 'BOOL' } as BqField, t('filled_at')],
    rows: (f: FuelLog): BqRow => ({ fuel_log_id: f.id, vehicle_id: f.vehicleId, driver_uid: f.driverUid, litres: f.litres, amount_ghs: ghs(f.amountPesewas), odometer_km: f.odometerKm, full_tank: f.fullTank, filled_at: f.filledAt }),
  },
  shifts: {
    schema: [s('shift_id'), s('driver_uid'), s('vehicle_id'), t('started_at'), t('ended_at'), i('km_driven')],
    rows: (x: ShiftRecord): BqRow => ({
      shift_id: x.id,
      driver_uid: x.driverUid,
      vehicle_id: x.vehicleId,
      started_at: x.startedAt,
      ended_at: x.endedAt,
      km_driven: x.startOdometerKm !== null && x.endOdometerKm !== null ? Math.max(0, x.endOdometerKm - x.startOdometerKm) : null,
    }),
  },
  driver_payments: {
    schema: [s('statement_id'), s('period'), s('driver_uid'), n('gross_ghs'), i('days_worked'), i('km_driven'), s('payout_method'), t('paid_at')],
    rows: (p: DriverPayStatement): BqRow => ({ statement_id: p.id, period: p.period, driver_uid: p.driverUid, gross_ghs: ghs(p.grossPesewas), days_worked: p.daysWorked, km_driven: p.kmDriven, payout_method: p.payout?.method ?? null, paid_at: p.paidAt }),
  },
} as const;

/** Export each of the `days` days before `now` (UTC dates). Returns rows written per table. */
export async function exportRecentDays(src: ExportSource, bq: BigQueryPort, now: Date, days = 3) {
  const written: Record<string, number> = {};
  for (let k = days; k >= 1; k--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - k));
    const end = new Date(start.getTime() + 86_400_000);
    const day = start.toISOString().slice(0, 10).replaceAll('-', '');
    const batches: [keyof typeof TABLES, BqRow[]][] = [
      ['bookings', (await src.bookingsCreated(start, end)).map(TABLES.bookings.rows)],
      ['payments', (await src.paymentsPaid(start, end)).map(TABLES.payments.rows)],
      ['expenses', (await src.expensesIncurred(start, end)).map(TABLES.expenses.rows)],
      ['fuel_logs', (await src.fuelLogs(start, end)).map(TABLES.fuel_logs.rows)],
      ['shifts', (await src.shiftsStarted(start, end)).map(TABLES.shifts.rows)],
      ['driver_payments', (await src.statementsPaid(start, end)).map(TABLES.driver_payments.rows)],
    ];
    for (const [table, rows] of batches) {
      await bq.loadDay(table, [...TABLES[table].schema], day, rows);
      written[table] = (written[table] ?? 0) + rows.length;
    }
  }
  return written;
}
