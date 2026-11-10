import { z } from 'zod';
import { normalizeTrackingNumber } from '@courier/shared-utils';
import { addressSchema, optional, pesewasSchema, safeText } from './primitives.js';

export const trackingNumberSchema = z.string().transform((v, ctx) => {
  const n = normalizeTrackingNumber(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Check the tracking number — it should look like GH1234567890X' });
    return z.NEVER;
  }
  return n;
});

/** Guest access tokens are 32 base64url characters (24 random bytes). */
export const accessTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'Invalid access code');

export const bookingAccessSchema = z.object({
  trackingNumber: trackingNumberSchema,
  accessToken: optional(accessTokenSchema),
});

export const refundRequestSchema = z.object({
  paymentReference: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  amountPesewas: pesewasSchema.refine((n) => n > 0, 'Refund must be more than zero'),
  reason: safeText(5, 300),
});

export const savedAddressSchema = addressSchema.extend({
  label: safeText(1, 40),
});

export const notificationPrefsSchema = z.object({
  smsBookingUpdates: z.boolean(),
  smsPaymentReceipts: z.boolean(),
  emailReceipts: z.boolean(),
});

export const completeSignUpSchema = z.object({
  displayName: optional(safeText(2, 120)),
});

export type SavedAddress = z.output<typeof savedAddressSchema>;
export type NotificationPrefs = z.output<typeof notificationPrefsSchema>;
export const MAX_SAVED_ADDRESSES = 20;
