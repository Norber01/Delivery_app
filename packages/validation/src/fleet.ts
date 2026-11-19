import { z } from 'zod';
import { EXPENSE_CATEGORIES, MAINTENANCE_TYPES, PAYOUT_METHODS } from '@courier/constants';
import { optional, pesewasSchema, safeText } from './primitives.js';
import { periodSchema } from './business.js';

const docId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const isoDate = z.string().datetime({ offset: true });
const receiptKey = z.string().regex(/^receipt\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp|pdf)$/);
const odometer = z.number({ error: 'Enter the odometer reading in km' }).int('Whole kilometres only').min(0).max(5_000_000);

export const planRouteSchema = z.object({ driverUid: optional(z.string().min(1).max(128)) });

export const startShiftOdometerSchema = z.object({ vehicleId: docId, odometerKm: odometer.optional() });
export const endShiftSchema = z.object({ odometerKm: odometer.optional() });

export const vehicleScheduleSchema = z.object({
  vehicleId: docId,
  serviceIntervalKm: z.number().int().min(500).max(100_000).nullable(),
  serviceIntervalDays: z.number().int().min(7).max(730).nullable(),
  insuranceExpiry: isoDate.nullable(),
  roadworthyExpiry: isoDate.nullable(),
});

export const maintenanceSchema = z.object({
  vehicleId: docId,
  type: z.enum(MAINTENANCE_TYPES),
  description: safeText(3, 300),
  costPesewas: pesewasSchema,
  odometerKm: odometer.nullable(),
  performedAt: isoDate,
  vendor: optional(safeText(2, 120)),
  receiptKey: optional(receiptKey),
});

export const fuelLogSchema = z.object({
  litres: z.number({ error: 'Enter the litres' }).positive('Enter the litres').max(1000),
  amountPesewas: pesewasSchema.refine((n) => n > 0, 'Enter the amount paid'),
  odometerKm: odometer,
  fullTank: z.boolean(),
  station: optional(safeText(2, 120)),
  receiptKey: optional(receiptKey),
});

export const receiptUploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  bytes: z.number().int().positive().max(8 * 1024 * 1024, 'Files must be under 8 MB'),
});

export const expenseSchema = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES).exclude(['driver_payment']),
    description: safeText(3, 300),
    amountPesewas: pesewasSchema.refine((n) => n > 0, 'Enter the amount'),
    vehicleId: optional(docId),
    hubId: optional(docId),
    incurredAt: isoDate,
    receiptKey: optional(receiptKey),
  })
  .refine((e) => e.category !== 'hub' || !!e.hubId, { path: ['hubId'], message: 'Choose the hub' })
  .refine((e) => !['fuel', 'maintenance'].includes(e.category) || !!e.vehicleId, { path: ['vehicleId'], message: 'Choose the vehicle' });

export const reviewExpenseSchema = z
  .object({ expenseId: docId, decision: z.enum(['approved', 'rejected']), note: optional(safeText(3, 300)) })
  .refine((v) => v.decision === 'approved' || !!v.note, { path: ['note'], message: 'Give a reason' });

const rate = z.number().int().min(0).max(100_000_000);
export const payRulesSchema = z.object({
  dailyRatePesewas: rate,
  perJobPesewas: z.object({ direct: rate, first_mile: rate, last_mile: rate }),
  perLinehaulTripPesewas: rate,
});

export const generatePaySchema = z.object({ period: periodSchema });
export const payAdjustmentSchema = z.object({
  statementId: docId,
  label: safeText(3, 120),
  amountPesewas: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, 'Enter an amount'),
});
export const approvePaySchema = z.object({ statementId: docId });
export const markPaidSchema = z.object({ statementId: docId, method: z.enum(PAYOUT_METHODS), reference: safeText(2, 80) });

export const cashRemittanceSchema = z.object({
  driverUid: z.string().min(1).max(128),
  amountPesewas: pesewasSchema.refine((n) => n > 0, 'Enter the amount received'),
  method: z.enum(PAYOUT_METHODS),
  reference: safeText(2, 80),
});

export const financeReportSchema = z.object({ period: periodSchema, refresh: z.boolean().optional() });
