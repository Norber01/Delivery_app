import { z } from 'zod';
import { PAYMENT_PREFERENCES, SPECIAL_HANDLING, URGENCY_LEVELS } from '@courier/constants';
import { addressSchema, contactSchema, optional, pesewasSchema, safeText } from './primitives.js';

export const packageSchema = z.object({
  description: safeText(2, 200),
  weightKg: z.number().finite().min(0.01).max(1000),
  lengthCm: z.number().finite().min(1).max(300),
  widthCm: z.number().finite().min(1).max(300),
  heightCm: z.number().finite().min(1).max(300),
  quantity: z.number().int().min(1).max(500),
  declaredValuePesewas: optional(pesewasSchema),
});

export const quoteRequestSchema = z
  .object({
    pickup: addressSchema,
    destination: addressSchema,
    packages: z.array(packageSchema).min(1).max(50),
    urgency: z.enum(URGENCY_LEVELS),
    specialHandling: z
      .array(z.enum(SPECIAL_HANDLING))
      .max(SPECIAL_HANDLING.length)
      .transform((arr) => [...new Set(arr)].sort()),
  })
  .superRefine((q, ctx) => {
    const total = q.packages.reduce((s, p) => s + p.quantity, 0);
    if (total > 500) {
      ctx.addIssue({ code: 'custom', path: ['packages'], message: 'A single booking may contain at most 500 items' });
    }
    if (q.specialHandling.includes('high_value') && !q.packages.some((p) => (p.declaredValuePesewas ?? 0) > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['packages'],
        message: 'Declare the value of high-value items',
      });
    }
    if (
      q.pickup.location.lat === q.destination.location.lat &&
      q.pickup.location.lng === q.destination.location.lng
    ) {
      ctx.addIssue({ code: 'custom', path: ['destination'], message: 'Pickup and destination are the same place' });
    }
  });

export const createBookingRequestSchema = z.object({
  quoteId: z.string().regex(/^[A-Za-z0-9]{10,40}$/),
  quote: quoteRequestSchema,
  sender: contactSchema,
  recipient: contactSchema,
  instructions: optional(safeText(1, 500)),
  paymentPreference: z.enum(PAYMENT_PREFERENCES),
  acceptTerms: z.literal(true),
});

export type QuoteRequestInput = z.input<typeof quoteRequestSchema>;
export type ValidQuoteRequest = z.output<typeof quoteRequestSchema>;
export type CreateBookingInput = z.input<typeof createBookingRequestSchema>;
export type ValidCreateBookingRequest = z.output<typeof createBookingRequestSchema>;

/** Flatten zod issues into `{ path: message }` for display and for function error details. */
export function issuesToFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
