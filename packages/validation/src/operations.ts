import { z } from 'zod';
import { DISPATCH_ACTIONS, EXCEPTION_REASONS, VEHICLE_CLASSES } from '@courier/constants';
import { ghanaPhoneSchema, latLngSchema, optional, safeText } from './primitives.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const reason = z.enum(EXCEPTION_REASONS);

/** Signature strokes normalised to 0..1; capped so a POD document stays small. */
export const signatureSchema = z
  .array(z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(1000))
  .min(1)
  .max(60)
  .refine((s) => s.reduce((n, stroke) => n + stroke.length, 0) <= 3000, 'Signature is too detailed')
  .refine((s) => s.reduce((n, stroke) => n + stroke.length, 0) >= 10, 'Signature is too short');

const photoKeys = z.array(z.string().regex(/^pod\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp)$/)).max(5);

const base = {
  actionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  deliveryId: id,
  occurredAt: z.string().datetime({ offset: true }),
  location: optional(latLngSchema),
};

export const driverActionSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('start_assignment') }),
  z.object({ ...base, type: z.literal('confirm_pickup'), scannedCode: z.string().max(64), cashCollected: optional(z.boolean()) }),
  z.object({ ...base, type: z.literal('report_pickup_failed'), reason, note: optional(safeText(1, 300)) }),
  z.object({
    ...base,
    type: z.literal('complete_delivery'),
    receivedByName: safeText(2, 120),
    otp: optional(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code')),
    signature: optional(signatureSchema),
    photoKeys: optional(photoKeys),
  }),
  z.object({ ...base, type: z.literal('report_delivery_failed'), reason, note: optional(safeText(1, 300)), photoKeys: optional(photoKeys) }),
  z.object({
    ...base,
    type: z.literal('complete_return'),
    receivedByName: safeText(2, 120),
    signature: signatureSchema,
    photoKeys: optional(photoKeys),
  }),
]);
export type ValidDriverAction = z.output<typeof driverActionSchema>;

export const dispatchActionSchema = z
  .object({
    type: z.enum(DISPATCH_ACTIONS),
    deliveryId: id,
    driverUid: optional(id),
    reason: optional(safeText(3, 300)),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'assign' && !v.driverUid) ctx.addIssue({ code: 'custom', path: ['driverUid'], message: 'Choose a driver' });
    if ((v.type === 'cancel' || v.type === 'hold') && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Give a reason' });
  });
export type ValidDispatchAction = z.output<typeof dispatchActionSchema>;

export const createDriverSchema = z.object({
  name: safeText(2, 120),
  phone: ghanaPhoneSchema,
  email: z.string().trim().toLowerCase().email().max(254),
  employeeNumber: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, 'Letters, digits and dashes only'),
  homeServiceAreaId: z.string().regex(/^[a-z0-9-]{2,40}$/),
});

export const vehicleSchema = z.object({
  id: optional(id),
  // Ghana formats vary (e.g. "GR 1234-24", "GT 5678-Z", motorbikes "M-22-GR 1234"): letters, digits,
  // spaces and dashes, with at least one letter and one digit.
  registrationNumber: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s.replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .regex(/^[A-Z0-9][A-Z0-9 -]{2,14}[A-Z0-9]$/, 'Use the registration as shown on the vehicle, e.g. GR 1234-24')
        .refine((s) => /[A-Z]/.test(s) && /\d/.test(s), 'Use the registration as shown on the vehicle, e.g. GR 1234-24'),
    ),
  vehicleClass: z.enum(VEHICLE_CLASSES),
  capacityKg: z.number().positive().max(40000),
  homeServiceAreaId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  status: z.enum(['available', 'maintenance', 'retired']),
});

export const startShiftSchema = z.object({ vehicleId: id });

export const uploadRequestSchema = z.object({
  deliveryId: id,
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  bytes: z.number().int().positive().max(5 * 1024 * 1024, 'Photos must be under 5 MB'),
});
