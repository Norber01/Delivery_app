import { z } from 'zod';
import { INVOICE_PAYMENT_METHODS, SPECIAL_HANDLING, URGENCY_LEVELS } from '@courier/constants';
import { addressSchema, contactSchema, ghanaPhoneSchema, optional, pesewasSchema, regionSchema, safeText, ghanaPostGpsSchema } from './primitives.js';

const docId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const keyRe = /^kyb\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp|pdf)$/;

export const registerBusinessSchema = z.object({
  legalName: safeText(2, 160),
  tradingName: safeText(2, 120),
  registrationNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{4,20}$/, 'Enter the Registrar-General number'),
  /** Ghana TIN, e.g. C0012345678 (letter + 10 digits). */
  tin: z.string().trim().toUpperCase().regex(/^[CPGQV]\d{10}$/, 'Enter the 11-character GRA TIN, e.g. C0012345678'),
  contact: contactSchema,
  billingAddress: addressSchema,
  pickupAddress: addressSchema,
  documentKeys: z.array(z.string().regex(keyRe)).min(1, 'Upload your registration certificate').max(5),
});

export const businessDocumentUploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  bytes: z.number().int().positive().max(8 * 1024 * 1024, 'Files must be under 8 MB'),
});

export const reviewBusinessSchema = z.object({
  businessId: docId,
  decision: z.enum(['verified', 'rejected', 'suspended']),
  note: optional(safeText(3, 500)),
}).refine((v) => v.decision === 'verified' || !!v.note, { path: ['note'], message: 'Give a reason' });

export const creditTermsSchema = z.object({
  businessId: docId,
  /** 0 removes credit (invoice billing disabled). */
  limitPesewas: pesewasSchema,
  termDays: z.number().int().min(7).max(90),
});

export const contractPricingSchema = z.object({
  businessId: docId,
  discountPercent: z.number().min(0).max(50),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }),
}).refine((v) => v.validTo > v.validFrom, { path: ['validTo'], message: 'End must be after start' });

export const inviteStaffSchema = z.object({
  name: safeText(2, 120),
  email: z.string().trim().toLowerCase().email().max(254),
});

export const addressBookEntrySchema = z.object({
  id: optional(docId),
  label: safeText(1, 80),
  contact: contactSchema,
  address: addressSchema,
});

// ---- CSV bulk rows ---------------------------------------------------------------------------

/** Columns of the bulk CSV template (header row). */
export const BULK_CSV_COLUMNS = [
  'reference',
  'recipient_name',
  'recipient_phone',
  'recipient_email',
  'address_line1',
  'landmark',
  'city',
  'region',
  'ghanapost_gps',
  'lat',
  'lng',
  'description',
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'quantity',
  'urgency',
  'special_handling',
  'declared_value_ghs',
  'instructions',
] as const;

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s.optional());
const num = (label: string, min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v.replace(/,/g, ''))) : v),
    z.number({ error: `${label} must be a number` }).finite().min(min, `${label} must be at least ${min}`).max(max, `${label} must be at most ${max}`),
  );

/** One CSV row (all values arrive as strings). Coordinates are optional: the server geocodes. */
export const bulkCsvRowSchema = z
  .object({
    reference: optStr(safeText(1, 60)),
    recipient_name: safeText(2, 120),
    recipient_phone: ghanaPhoneSchema,
    recipient_email: optStr(z.string().trim().toLowerCase().email().max(254)),
    address_line1: safeText(3, 200),
    landmark: optStr(safeText(2, 200)),
    city: safeText(2, 80),
    region: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), regionSchema),
    ghanapost_gps: optStr(ghanaPostGpsSchema),
    lat: z.preprocess(blank, num('lat', 4.5, 11.3).optional()),
    lng: z.preprocess(blank, num('lng', -3.4, 1.3).optional()),
    description: safeText(2, 200),
    weight_kg: num('weight_kg', 0.01, 1000),
    length_cm: num('length_cm', 1, 300),
    width_cm: num('width_cm', 1, 300),
    height_cm: num('height_cm', 1, 300),
    quantity: z.preprocess(blank, num('quantity', 1, 500).pipe(z.number().int('quantity must be a whole number')).optional()),
    urgency: z.preprocess((v) => blank(typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : v), z.enum(URGENCY_LEVELS).optional()),
    special_handling: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() ? v.split(/[;|]/).map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean) : []),
      z.array(z.enum(SPECIAL_HANDLING)).max(5),
    ),
    declared_value_ghs: z.preprocess(blank, num('declared_value_ghs', 0, 10_000_000).optional()),
    instructions: optStr(safeText(1, 500)),
  })
  .refine((r) => (r.lat === undefined) === (r.lng === undefined), { path: ['lat'], message: 'Give both lat and lng, or neither' })
  .refine((r) => !r.special_handling.includes('high_value') || (r.declared_value_ghs ?? 0) > 0, {
    path: ['declared_value_ghs'],
    message: 'Declare the value of high-value items',
  });
export type BulkCsvRow = z.output<typeof bulkCsvRowSchema>;

export const bulkPreviewRequestSchema = z.object({
  pickup: addressSchema,
  paymentPreference: z.enum(['business_invoice', 'cash_on_pickup']),
  rows: z.array(z.record(z.string(), z.string().max(500))).min(1).max(200),
});

export const bulkConfirmSchema = z.object({ batchId: docId, acceptTerms: z.literal(true) });

// ---- Invoices & reports ----------------------------------------------------------------------

export const periodSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const generateInvoicesSchema = z.object({ period: periodSchema, businessId: optional(docId) });
export const recordInvoicePaymentSchema = z.object({
  invoiceId: docId,
  amountPesewas: pesewasSchema.refine((n) => n > 0, 'Amount must be more than zero'),
  method: z.enum(INVOICE_PAYMENT_METHODS),
  reference: safeText(2, 80),
});
export const voidInvoiceSchema = z.object({ invoiceId: docId, reason: safeText(5, 300) });
export const businessReportSchema = z.object({ month: periodSchema, businessId: optional(docId) });
