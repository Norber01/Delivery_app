import { QUOTE_TTL_MINUTES } from '@courier/constants';
import type { DistanceSource, LatLng, PricingRuleSet, QuoteResponse } from '@courier/shared-types';
import {
  classifyDelivery,
  haversineKm,
  priceShipment,
  type MapProvider,
} from '@courier/shared-utils';
import { issuesToFieldErrors, quoteRequestSchema } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { hashObject } from '../lib/hash.js';
import type { RateLimiter, Store, StoredQuote } from '../store/types.js';

export interface ServiceDeps {
  store: Store;
  rateLimiter: RateLimiter;
  maps: MapProvider | null;
  now: () => Date;
  newId: () => string;
}

export interface RequestMeta {
  ipHash: string | null;
}

export const QUOTE_RATE_LIMIT = { limit: 30, windowSeconds: 600 };

export function rateKey(prefix: string, caller: Caller, meta: RequestMeta): string {
  return caller.uid ? `${prefix}:u:${caller.uid}` : `${prefix}:ip:${meta.ipHash ?? 'unknown'}`;
}

export async function enforceRateLimit(
  deps: Pick<ServiceDeps, 'rateLimiter'>,
  key: string,
  limit: { limit: number; windowSeconds: number },
): Promise<void> {
  if (!(await deps.rateLimiter.consume(key, limit.limit, limit.windowSeconds))) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a few minutes and try again.', 'resource-exhausted');
  }
}

/** Road distance from the map provider, with an explicitly flagged estimate fallback. */
export async function resolveDistance(
  maps: MapProvider | null,
  rules: PricingRuleSet,
  from: LatLng,
  to: LatLng,
): Promise<{ km: number; source: DistanceSource }> {
  if (maps) {
    try {
      const r = await maps.route(from, to);
      return { km: r.distanceKm, source: 'route' };
    } catch (e) {
      console.warn('Map provider route failed; considering estimate fallback', (e as Error).message);
    }
  }
  if (rules.distance.allowEstimateFallback) {
    return { km: haversineKm(from, to) * rules.distance.estimateRoadFactor, source: 'estimated' };
  }
  throw new AppError('DISTANCE_UNAVAILABLE', 'We could not calculate the distance right now. Please try again shortly.', 'unavailable');
}

export async function getQuote(
  deps: ServiceDeps,
  raw: unknown,
  caller: Caller,
  meta: RequestMeta,
): Promise<QuoteResponse> {
  const parsed = quoteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const input = parsed.data;
  await enforceRateLimit(deps, rateKey('quote', caller, meta), QUOTE_RATE_LIMIT);

  const [rules, areas] = await Promise.all([deps.store.getActivePricingRules(), deps.store.getServiceAreas()]);
  if (!rules) throw new AppError('PRICING_NOT_CONFIGURED', 'Online pricing is temporarily unavailable.', 'unavailable');

  const c = classifyDelivery(rules, areas, input.pickup.location, input.destination.location);
  const distance =
    c.deliveryType === 'intercity'
      ? null
      : await resolveDistance(deps.maps, rules, input.pickup.location, input.destination.location);

  const isBusiness = caller.role === 'business_owner' || caller.role === 'business_staff';
  const businessId = isBusiness ? caller.businessId : null;
  const contract = businessId ? await deps.store.getContractTerms(businessId) : null;

  const result = priceShipment(rules, {
    deliveryType: c.deliveryType,
    distanceKm: distance?.km ?? null,
    distanceSource: distance?.source ?? 'fixed_route',
    route: c.route,
    packages: input.packages,
    urgency: input.urgency,
    specialHandling: input.specialHandling,
    contract,
  });

  const now = deps.now();
  const quote: StoredQuote = {
    id: deps.newId(),
    inputHash: hashObject(input),
    input,
    result,
    pickupAreaId: c.pickupArea.id,
    pickupAreaName: c.pickupArea.name,
    destinationAreaId: c.destinationArea?.id ?? null,
    destinationAreaName: c.destinationArea?.name ?? null,
    requesterUid: caller.uid,
    businessId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MINUTES * 60_000),
    usedByTrackingNumber: null,
  };
  await deps.store.saveQuote(quote);

  return {
    quoteId: quote.id,
    expiresAt: quote.expiresAt.toISOString(),
    quote: result,
    pickupAreaName: quote.pickupAreaName,
    destinationAreaName: quote.destinationAreaName,
  };
}
