import { z } from 'zod';
import { HUB_TYPES } from '@courier/constants';
import { ghanaPhoneSchema, latLngSchema, optional, safeText } from './primitives.js';
import { trackingNumberSchema } from './account.js';

const slug = z.string().regex(/^[a-z0-9-]{2,40}$/, 'Lowercase letters, digits and dashes');
const docId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

export const hubSchema = z.object({
  id: slug,
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}-\d{2}$/, 'Use a code like ACC-01'),
  name: safeText(2, 80),
  type: z.enum(HUB_TYPES),
  serviceAreaId: slug,
  city: safeText(2, 80),
  primaryForArea: z.boolean(),
  address: safeText(3, 200),
  location: latLngSchema,
  phone: optional(ghanaPhoneSchema),
  active: z.boolean(),
});

export const routeSchema = z
  .object({
    id: slug,
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}-[A-Z]{3}$/, 'Use a code like ACC-KSI'),
    originHubId: slug,
    destinationHubId: slug,
    distanceKm: z.number().positive().max(2000),
    typicalDurationMinutes: z.number().int().positive().max(48 * 60),
    schedule: z.object({
      daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      departureTimes: z.array(hhmm).min(1).max(12),
    }),
    active: z.boolean(),
  })
  .refine((r) => r.originHubId !== r.destinationHubId, { path: ['destinationHubId'], message: 'Origin and destination must differ' });

export const createManifestSchema = z.object({
  routeId: slug,
  vehicleId: docId,
  driverUid: docId,
  scheduledDepartureAt: z.string().datetime({ offset: true }),
});

export const manifestParcelSchema = z.object({ manifestId: docId, trackingNumber: trackingNumberSchema });
export const manifestActionSchema = z.object({
  manifestId: docId,
  action: z.enum(['seal', 'reopen', 'depart', 'arrive', 'close']),
});
export const hubScanSchema = z.object({
  hubId: slug,
  type: z.enum(['receive', 'handover']),
  trackingNumber: trackingNumberSchema,
});
