import { z } from 'zod';
import { SPECIAL_HANDLING, VEHICLE_CLASSES } from '@courier/constants';
import { latLngSchema, pesewasSchema, regionSchema, safeText } from './primitives.js';

const percent = z.number().finite().min(0).max(100);
const km = z.number().finite().min(0).max(2000);

const vehicleLimits = z.object({
  enabled: z.boolean(),
  maxWeightKg: z.number().positive().max(40000),
  maxDimensionCm: z.number().positive().max(2000),
});

const distanceRate = z.object({ basePesewas: pesewasSchema, perKmPesewas: pesewasSchema });
const intraRate = distanceRate.extend({ includedKm: km });

const ratesFor = <T extends z.ZodTypeAny>(rate: T) =>
  z.object(Object.fromEntries(VEHICLE_CLASSES.map((c) => [c, rate.optional()])) as Record<
    (typeof VEHICLE_CLASSES)[number],
    z.ZodOptional<T>
  >);

const areaId = z.string().regex(/^[a-z0-9-]{2,40}$/);

export const pricingRuleSetSchema = z
  .object({
    version: z.number().int().positive(),
    currency: z.literal('GHS'),
    volumetricDivisor: z.number().int().min(1000).max(10000),
    vehicles: z.object(
      Object.fromEntries(VEHICLE_CLASSES.map((c) => [c, vehicleLimits])) as Record<
        (typeof VEHICLE_CLASSES)[number],
        typeof vehicleLimits
      >,
    ),
    intraCity: z.object({ rates: ratesFor(intraRate) }),
    longDistance: z.object({
      enabled: z.boolean(),
      maxDistanceKm: km,
      minimumPesewas: pesewasSchema,
      rates: ratesFor(distanceRate),
    }),
    intercity: z.object({
      routes: z
        .array(
          z.object({
            originAreaId: areaId,
            destinationAreaId: areaId,
            bidirectional: z.boolean(),
            basePesewas: pesewasSchema,
            firstMilePesewas: pesewasSchema,
            lastMilePesewas: pesewasSchema,
            includedWeightKg: z.number().min(0).max(1000),
            perExtraKgPesewas: pesewasSchema,
            serviceLevel: safeText(2, 80).optional(),
          }),
        )
        .max(500),
    }),
    weight: z.object({
      includedKg: z.number().min(0).max(1000),
      bands: z
        .array(z.object({ upToKg: z.number().positive().nullable(), perKgPesewas: pesewasSchema }))
        .min(1)
        .max(20),
    }),
    urgency: z.object({
      express: z.object({ percent, minimumPesewas: pesewasSchema }),
      same_day: z.object({ percent, minimumPesewas: pesewasSchema }),
    }),
    specialHandling: z.object({
      ...(Object.fromEntries(SPECIAL_HANDLING.map((h) => [h, pesewasSchema])) as Record<
        (typeof SPECIAL_HANDLING)[number],
        typeof pesewasSchema
      >),
      highValuePercent: percent,
      highValueMinimumPesewas: pesewasSchema,
    }),
    bulkDiscounts: z.array(z.object({ minPackages: z.number().int().min(2), percent })).max(20),
    maxDiscountPercent: percent,
    minimumChargePesewas: pesewasSchema,
    taxes: z
      .array(z.object({ code: z.string().regex(/^[A-Z_]{2,20}$/), label: safeText(2, 60), percent }))
      .max(10),
    distance: z.object({
      allowEstimateFallback: z.boolean(),
      estimateRoadFactor: z.number().min(1).max(2),
    }),
  })
  .superRefine((r, ctx) => {
    // Weight bands: ascending, only the last may be open-ended.
    let prev = r.weight.includedKg;
    r.weight.bands.forEach((b, i) => {
      const last = i === r.weight.bands.length - 1;
      if (b.upToKg === null && !last) {
        ctx.addIssue({ code: 'custom', path: ['weight', 'bands', i], message: 'Only the last band may be open-ended' });
      }
      if (b.upToKg !== null) {
        if (b.upToKg <= prev) {
          ctx.addIssue({ code: 'custom', path: ['weight', 'bands', i], message: 'Bands must be ascending' });
        }
        prev = b.upToKg;
      }
    });
    if (r.weight.bands.at(-1)?.upToKg !== null) {
      ctx.addIssue({ code: 'custom', path: ['weight', 'bands'], message: 'The last band must be open-ended (upToKg: null)' });
    }
    // Every enabled vehicle class needs rates.
    for (const c of VEHICLE_CLASSES) {
      if (!r.vehicles[c].enabled) continue;
      if (!r.intraCity.rates[c]) {
        ctx.addIssue({ code: 'custom', path: ['intraCity', 'rates', c], message: `Missing intra-city rate for ${c}` });
      }
      if (r.longDistance.enabled && !r.longDistance.rates[c]) {
        ctx.addIssue({ code: 'custom', path: ['longDistance', 'rates', c], message: `Missing long-distance rate for ${c}` });
      }
    }
    // Vehicle classes ascending in capacity.
    for (let i = 1; i < VEHICLE_CLASSES.length; i++) {
      const a = r.vehicles[VEHICLE_CLASSES[i - 1]!];
      const b = r.vehicles[VEHICLE_CLASSES[i]!];
      if (b.maxWeightKg < a.maxWeightKg) {
        ctx.addIssue({ code: 'custom', path: ['vehicles', VEHICLE_CLASSES[i]!], message: 'Vehicle capacity must not decrease' });
      }
    }
    // Unique route pairs.
    const seen = new Set<string>();
    r.intercity.routes.forEach((route, i) => {
      if (route.originAreaId === route.destinationAreaId) {
        ctx.addIssue({ code: 'custom', path: ['intercity', 'routes', i], message: 'Origin and destination must differ' });
      }
      const keys = [`${route.originAreaId}->${route.destinationAreaId}`];
      if (route.bidirectional) keys.push(`${route.destinationAreaId}->${route.originAreaId}`);
      for (const k of keys) {
        if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['intercity', 'routes', i], message: `Duplicate route ${k}` });
        seen.add(k);
      }
    });
  });

export const serviceAreaSchema = z.object({
  id: areaId,
  name: safeText(2, 80),
  city: safeText(2, 80),
  region: regionSchema,
  center: latLngSchema,
  radiusKm: z.number().positive().max(150),
  active: z.boolean(),
});
