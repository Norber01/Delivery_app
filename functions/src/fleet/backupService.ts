/**
 * Excel backup for the manager: one workbook with a sheet per kind of record for a date range.
 * The server gathers and labels the data (so the columns are the same everywhere); the ops app
 * turns the sheets into an .xlsx file in the browser.
 */
import { RIDER_TYPE_LABELS, type Role } from '@courier/constants';
import type { BackupWorkbook, BackupSheet } from '@courier/shared-types';
import { PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { backupSchema } from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { parse } from './common.js';
import type { FleetStore, PeriodData } from './types.js';

export const BACKUP_ROLES: Role[] = ['manager', 'finance', 'admin', 'super_admin'];
const MAX_DAYS = 3700;

const ghs = (pesewas: number | null | undefined) => (pesewas == null ? null : Math.round(pesewas) / 100);
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  const t = v as { toDate?: () => Date; toMillis?: () => number };
  if (typeof t.toDate === 'function') return t.toDate().toISOString();
  if (typeof t.toMillis === 'function') return new Date(t.toMillis()).toISOString();
  return null;
}
/** "2026-11-20 14:05" (UTC) — Excel sorts and filters it as text without surprises. */
const when = (v: unknown) => iso(v)?.slice(0, 16).replace('T', ' ') ?? null;
const sheet = (name: string, columns: string[], rows: (string | number | boolean | null)[][]): BackupSheet => ({ name, columns, rows });

const PAYMENT_METHOD: Record<string, string> = { mobile_money: 'Mobile Money', card: 'Card', cash_on_pickup: 'Cash to rider', business_invoice: 'Monthly invoice' };
const TYPE: Record<string, string> = { intra_city: 'Same city', intercity: 'Intercity', long_distance: 'Long distance' };

export function buildBackup(from: string, to: string, d: PeriodData, now: Date): BackupWorkbook {
  const name = (uid: string | null | undefined) => (uid ? (d.drivers.find((x) => x.uid === uid)?.name ?? uid) : null);
  const vehicle = (id: string | null | undefined) => (id ? (d.vehicles.find((v) => v.id === id)?.registrationNumber ?? id) : null);
  const deliveries = new Map(d.deliveries.map((x) => [x.id, x]));

  const orders = d.bookings
    .slice()
    .sort((a, b) => (iso(a.createdAt) ?? '').localeCompare(iso(b.createdAt) ?? ''))
    .map((b) => {
      const del = deliveries.get(b.trackingNumber);
      const legRider = (types: string[]) => name(del?.legs.find((l) => types.includes(l.type) && l.driverUid)?.driverUid);
      return [
        b.trackingNumber,
        when(b.createdAt),
        b.status === 'cancelled' ? 'Cancelled' : del ? PUBLIC_STATUS_LABELS[del.status] : b.status === 'pending_payment' ? 'Waiting for payment' : 'Booked',
        TYPE[b.deliveryType] ?? b.deliveryType,
        b.sender.name,
        b.sender.phone,
        [b.pickup.line1, b.pickup.city].filter(Boolean).join(', '),
        b.recipient.name,
        b.recipient.phone,
        [b.destination.line1, b.destination.city].filter(Boolean).join(', '),
        b.packages.map((p) => `${p.quantity} × ${p.description}`).join('; '),
        b.price.chargeableWeightKg,
        ghs(b.price.totalPesewas),
        PAYMENT_METHOD[b.paymentPreference] ?? b.paymentPreference,
        b.paymentStatus,
        legRider(['first_mile', 'direct']),
        legRider(['last_mile', 'direct']),
        b.businessId,
        b.clientReference ?? null,
      ];
    });

  // Customers: everyone who sent something in the period, with their totals.
  const customers = new Map<string, { name: string; phone: string; orders: number; spent: number; last: string }>();
  for (const b of d.bookings) {
    if (b.status === 'cancelled') continue;
    const c = customers.get(b.sender.phone) ?? { name: b.sender.name, phone: b.sender.phone, orders: 0, spent: 0, last: '' };
    c.orders++;
    c.spent += b.price.totalPesewas;
    c.last = [c.last, when(b.createdAt) ?? ''].sort().at(-1)!;
    customers.set(b.sender.phone, c);
  }

  const sheets: BackupSheet[] = [
    sheet(
      'Orders',
      ['Tracking number', 'Booked (UTC)', 'Status', 'Type', 'Sender', 'Sender phone', 'Pickup address', 'Recipient', 'Recipient phone', 'Delivery address', 'Items', 'Weight (kg)', 'Price (GH₵)', 'Payment method', 'Payment status', 'Pickup rider', 'Delivery rider', 'Business', 'Business reference'],
      orders,
    ),
    sheet(
      'Customers',
      ['Name', 'Phone', 'Orders', 'Total (GH₵)', 'Last order (UTC)'],
      [...customers.values()].sort((a, b) => b.spent - a.spent).map((c) => [c.name, c.phone, c.orders, ghs(c.spent), c.last]),
    ),
    sheet(
      'Payments',
      ['Tracking number', 'Amount (GH₵)', 'Method', 'Collected by rider'],
      d.payments.map((p) => [p.trackingNumber, ghs(p.amountPesewas), p.provider === 'cash' ? 'Cash' : p.provider, name(p.collectedBy)]),
    ),
    sheet(
      'Riders',
      ['Name', 'Rider type', 'Phone', 'Email', 'Staff number', 'Area', 'Status', 'On shift now'],
      d.drivers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => [
          r.name,
          r.riderType ? RIDER_TYPE_LABELS[r.riderType] : 'Pickup and delivery',
          r.phone,
          r.email,
          r.employeeNumber,
          d.areas.find((a) => a.id === r.homeServiceAreaId)?.name ?? r.homeServiceAreaId,
          r.status === 'active' ? 'Active' : 'Suspended',
          r.currentShift && Date.parse(r.currentShift.activeUntil) > now.getTime() ? 'Yes' : 'No',
        ]),
    ),
    sheet(
      'Rider cash hand-ins',
      ['Received (UTC)', 'Rider', 'Amount (GH₵)', 'Method', 'Reference'],
      d.remittances.map((r) => [when(r.receivedAt), name(r.driverUid), ghs(r.amountPesewas), r.method, r.reference]),
    ),
    sheet(
      'Rider pay',
      ['Rider', 'Month', 'Status', 'Gross pay (GH₵)'],
      d.statements.map((s) => [s.driverName, s.period, s.status, ghs(s.grossPesewas)]),
    ),
    sheet(
      'Expenses',
      ['Date (UTC)', 'Category', 'Description', 'Amount (GH₵)', 'Status', 'Vehicle', 'Rider'],
      d.expenses.map((e) => [when(e.incurredAt), e.category, e.description, ghs(e.amountPesewas), e.status, vehicle(e.vehicleId), name(e.driverUid)]),
    ),
    sheet(
      'Fuel',
      ['Filled (UTC)', 'Rider', 'Vehicle', 'Litres', 'Amount (GH₵)', 'Odometer (km)', 'Station'],
      d.fuelLogs.map((f) => [when(f.filledAt), name(f.driverUid), vehicle(f.vehicleId), f.litres, ghs(f.amountPesewas), f.odometerKm, f.station]),
    ),
    sheet(
      'Shifts',
      ['Started (UTC)', 'Ended (UTC)', 'Rider', 'Vehicle', 'Start km', 'End km'],
      d.shifts.map((s) => [when(s.startedAt), when(s.endedAt), name(s.driverUid), vehicle(s.vehicleId), s.startOdometerKm, s.endOdometerKm]),
    ),
  ];
  return { from, to, createdAt: now.toISOString(), sheets };
}

export async function exportBackup(deps: { fleet: FleetStore; now: () => Date }, caller: Caller, raw: unknown): Promise<BackupWorkbook> {
  requireRole(caller, BACKUP_ROLES);
  const { from, to } = parse(backupSchema, raw);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS) throw new AppError('VALIDATION_FAILED', 'Choose at most 10 years.', 'invalid-argument');
  return buildBackup(from, to, await deps.fleet.periodData(start, end), deps.now());
}
