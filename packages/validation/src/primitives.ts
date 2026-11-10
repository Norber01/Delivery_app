import { z } from 'zod';
import { GHANA_BOUNDS, GHANA_MOBILE_PREFIXES, GHANA_REGIONS } from '@courier/constants';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Trimmed text, bounded length, no control characters. */
export const safeText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), { message: 'Contains invalid characters' });

/**
 * Normalise a Ghanaian mobile number to E.164 (+233XXXXXXXXX).
 * Accepts 0XXXXXXXXX, 233XXXXXXXXX, +233XXXXXXXXX with spaces/dashes.
 * Returns null if not a valid Ghana mobile number.
 */
export function normalizeGhanaPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  let national: string | undefined;
  if (/^\+233\d{9}$/.test(digits)) national = digits.slice(4);
  else if (/^233\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  if (!national) return null;
  const prefix = national.slice(0, 2);
  if (!(GHANA_MOBILE_PREFIXES as readonly string[]).includes(prefix)) return null;
  return `+233${national}`;
}

export const ghanaPhoneSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeGhanaPhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid Ghana mobile number' });
      return z.NEVER;
    }
    return n;
  });

/** GhanaPost GPS digital address, e.g. GA-123-4567 or AK-0123-4567. */
export const GHANA_POST_GPS_REGEX = /^[A-Z]{2}-\d{3,4}-\d{4}$/;
export const ghanaPostGpsSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(GHANA_POST_GPS_REGEX, 'Use the format GA-123-4567'));

export const latLngSchema = z.object({
  lat: z.number().finite().min(GHANA_BOUNDS.minLat).max(GHANA_BOUNDS.maxLat),
  lng: z.number().finite().min(GHANA_BOUNDS.minLng).max(GHANA_BOUNDS.maxLng),
});

export const regionSchema = z.enum(GHANA_REGIONS);

export const addressSchema = z.object({
  line1: safeText(3, 200),
  line2: safeText(1, 200).optional(),
  city: safeText(2, 80),
  region: regionSchema,
  landmark: safeText(2, 200).optional(),
  ghanaPostGps: ghanaPostGpsSchema.optional(),
  location: latLngSchema,
});

export const contactSchema = z.object({
  name: safeText(2, 120),
  phone: ghanaPhoneSchema,
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});

export const pesewasSchema = z.number().int().nonnegative().max(1_000_000_000);
