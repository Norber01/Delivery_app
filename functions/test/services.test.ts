import { describe, expect, it, beforeEach } from 'vitest';
import type { MapProvider } from '@courier/shared-utils';
import { MapProviderError } from '@courier/shared-utils';
import type { PricingRuleSet, ServiceArea } from '@courier/shared-types';
import rulesJson from '../../firebase/seed/pricing-rules.sample.json' with { type: 'json' };
import areasJson from '../../firebase/seed/service-areas.sample.json' with { type: 'json' };
import { GUEST, type Caller } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { sha256Hex } from '../src/lib/hash.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote, type ServiceDeps } from '../src/services/quoteService.js';
import { authorizeRoleChange, publishPricingRules } from '../src/services/adminService.js';
import { MemoryRateLimiter, MemoryStore } from './memoryStore.js';

const rules = rulesJson as unknown as PricingRuleSet;
const areas = areasJson as ServiceArea[];

const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };
const madina = { line1: 'Madina Market', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6681, lng: -0.1653 } };
const kumasi = { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } };
const quoteReq = {
  pickup: osu,
  destination: madina,
  packages: [{ description: 'Shoes', weightKg: 2, lengthCm: 35, widthCm: 25, heightCm: 15, quantity: 1 }],
  urgency: 'standard',
  specialHandling: [],
};
const contacts = {
  sender: { name: 'Ama Mensah', phone: '0241234567' },
  recipient: { name: 'Kofi Boateng', phone: '0501234567' },
  paymentPreference: 'cash_on_pickup',
  acceptTerms: true,
};
const meta = { ipHash: 'iphash' };

const fixedMaps = (km: number): MapProvider & { calls: number } => ({
  name: 'fake',
  calls: 0,
  async geocode() {
    return [];
  },
  async route() {
    this.calls++;
    return { distanceKm: km, durationMinutes: 20 };
  },
});

let store: MemoryStore;
let deps: ServiceDeps;
let clock: Date;
let ids: number;

beforeEach(() => {
  store = new MemoryStore(rules, areas);
  clock = new Date('2026-11-10T10:00:00Z');
  ids = 0;
  deps = {
    store,
    rateLimiter: new MemoryRateLimiter(),
    maps: fixedMaps(8.3),
    now: () => clock,
    newId: () => `quote${String(++ids).padStart(10, '0')}`,
  };
});

async function expectAppError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

describe('getQuote', () => {
  it('prices an intra-city request with the provider distance and stores the quote', async () => {
    const res = await getQuote(deps, quoteReq, GUEST, meta);
    expect(res.quote.deliveryType).toBe('intra_city');
    expect(res.quote.distanceSource).toBe('route');
    expect(res.quote.totalPesewas).toBe(3490);
    expect(res.expiresAt).toBe('2026-11-10T10:30:00.000Z');
    expect(store.quotes.get(res.quoteId)?.requesterUid).toBeNull();
  });

  it('does not call Directions for intercity routes', async () => {
    const maps = fixedMaps(250);
    const res = await getQuote({ ...deps, maps }, { ...quoteReq, destination: kumasi }, GUEST, meta);
    expect(res.quote.deliveryType).toBe('intercity');
    expect(maps.calls).toBe(0);
    expect(res.destinationAreaName).toBe('Kumasi Metropolitan');
  });

  it('falls back to a flagged estimate when the provider fails', async () => {
    const failing: MapProvider = {
      name: 'down',
      geocode: async () => [],
      route: async () => {
        throw new MapProviderError('down', 503);
      },
    };
    const res = await getQuote({ ...deps, maps: failing }, quoteReq, GUEST, meta);
    expect(res.quote.distanceSource).toBe('estimated');
  });

  it('refuses when fallback is disabled and the provider fails', async () => {
    store.rules = { ...rules, distance: { allowEstimateFallback: false, estimateRoadFactor: 1.35 } };
    await expectAppError(getQuote({ ...deps, maps: null }, quoteReq, GUEST, meta), 'DISTANCE_UNAVAILABLE');
  });

  it('applies business contract pricing only to business callers', async () => {
    store.contracts.set('biz1', { contractId: 'k', discountPercent: 10 });
    const biz: Caller = { uid: 'u1', role: 'business_owner', businessId: 'biz1', mfa: false };
    const res = await getQuote(deps, quoteReq, biz, meta);
    expect(res.quote.lines.find((l) => l.code === 'DISCOUNT_CONTRACT')?.amountPesewas).toBe(-349);
    // A customer claim with a businessId must not unlock contract prices.
    const res2 = await getQuote(deps, quoteReq, { ...biz, role: 'customer' }, meta);
    expect(res2.quote.discountPesewas).toBe(0);
  });

  it('rejects invalid input with field errors', async () => {
    const p = getQuote(deps, { ...quoteReq, packages: [] }, GUEST, meta);
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED' && !!e.fields?.packages);
  });

  it('rate limits per IP for guests', async () => {
    for (let i = 0; i < 30; i++) await getQuote(deps, quoteReq, GUEST, meta);
    await expectAppError(getQuote(deps, quoteReq, GUEST, meta), 'RATE_LIMITED');
    // A different IP is unaffected.
    await expect(getQuote(deps, quoteReq, GUEST, { ipHash: 'other' })).resolves.toBeTruthy();
  });

  it('reports when pricing is not configured', async () => {
    store.rules = null;
    await expectAppError(getQuote(deps, quoteReq, GUEST, meta), 'PRICING_NOT_CONFIGURED');
  });

  it('rejects pickups outside service areas', async () => {
    const tamale = { line1: 'Central Market', city: 'Tamale', region: 'Northern', location: { lat: 9.4034, lng: -0.8424 } };
    await expect(getQuote(deps, { ...quoteReq, pickup: tamale }, GUEST, meta)).rejects.toMatchObject({ code: 'PICKUP_NOT_SERVICED' });
  });
});

describe('createBooking', () => {
  async function quoteThenBook(caller: Caller = GUEST, overrides: Record<string, unknown> = {}) {
    const q = await getQuote(deps, quoteReq, caller, meta);
    return createBooking(deps, { quoteId: q.quoteId, quote: quoteReq, ...contacts, ...overrides }, caller, meta);
  }

  it('creates a guest booking with an immutable price snapshot and a hashed access token', async () => {
    const res = await quoteThenBook();
    expect(res.trackingNumber).toMatch(/^GH/);
    expect(res.guestAccessToken).toBeTruthy();
    expect(res.status).toBe('confirmed');
    const doc = store.bookings.get(res.trackingNumber)!;
    expect(doc.price.totalPesewas).toBe(3490);
    expect(doc.price.pricingVersion).toBe(1);
    expect(doc.guestAccessHash).toBe(sha256Hex(res.guestAccessToken!));
    expect(doc.sender.phone).toBe('+233241234567');
    expect(store.audit.at(-1)?.action).toBe('booking.create');
  });

  it('keeps the confirmed price when pricing rules change after the quote', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, meta);
    store.rules = { ...rules, version: 2, minimumChargePesewas: 99_999 };
    const res = await createBooking(deps, { quoteId: q.quoteId, quote: quoteReq, ...contacts }, GUEST, meta);
    expect(store.bookings.get(res.trackingNumber)!.price.totalPesewas).toBe(3490);
  });

  it('marks online payment bookings as pending payment', async () => {
    const res = await quoteThenBook(GUEST, { paymentPreference: 'mobile_money' });
    expect(res).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid' });
  });

  it('rejects a reused quote', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, meta);
    const body = { quoteId: q.quoteId, quote: quoteReq, ...contacts };
    await createBooking(deps, body, GUEST, meta);
    await expectAppError(createBooking(deps, body, GUEST, meta), 'QUOTE_ALREADY_USED');
  });

  it('rejects an expired quote', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, meta);
    clock = new Date(clock.getTime() + 31 * 60_000);
    await expectAppError(createBooking(deps, { quoteId: q.quoteId, quote: quoteReq, ...contacts }, GUEST, meta), 'QUOTE_EXPIRED');
  });

  it('rejects bookings whose packages differ from the quote (tamper protection)', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, meta);
    const heavier = { ...quoteReq, packages: [{ ...quoteReq.packages[0], weightKg: 19 }] };
    await expectAppError(createBooking(deps, { quoteId: q.quoteId, quote: heavier, ...contacts }, GUEST, meta), 'QUOTE_MISMATCH');
  });

  it("does not allow using another user's quote", async () => {
    const alice: Caller = { uid: 'alice', role: 'customer', businessId: null, mfa: false };
    const q = await getQuote(deps, quoteReq, alice, meta);
    await expectAppError(createBooking(deps, { quoteId: q.quoteId, quote: quoteReq, ...contacts }, GUEST, meta), 'QUOTE_NOT_FOUND');
  });

  it('signed-in customers get no guest token and own the booking', async () => {
    const alice: Caller = { uid: 'alice', role: 'customer', businessId: null, mfa: false };
    const res = await quoteThenBook(alice);
    expect(res.guestAccessToken).toBeNull();
    expect(store.bookings.get(res.trackingNumber)!.customerUid).toBe('alice');
  });

  it('only allows invoice billing for verified businesses with approved credit', async () => {
    await expectAppError(quoteThenBook(GUEST, { paymentPreference: 'business_invoice' }), 'PAYMENT_METHOD_NOT_ALLOWED');
    const biz: Caller = { uid: 'b1', role: 'business_owner', businessId: 'biz1', mfa: false };
    store.businesses.set('biz1', { id: 'biz1', verificationStatus: 'verified', creditApproved: false });
    await expectAppError(quoteThenBook(biz, { paymentPreference: 'business_invoice' }), 'PAYMENT_METHOD_NOT_ALLOWED');
    store.businesses.set('biz1', { id: 'biz1', verificationStatus: 'verified', creditApproved: true });
    const ok = await quoteThenBook(biz, { paymentPreference: 'business_invoice' });
    expect(ok.paymentStatus).toBe('invoiced');
    expect(store.bookings.get(ok.trackingNumber)!.businessId).toBe('biz1');
  });

  it('retries on tracking number collision', async () => {
    const seq = ['GHDUPLICATE01', 'GHDUPLICATE01', 'GHUNIQUE00001'];
    const d = { ...deps, newTrackingNumber: () => seq.shift()! };
    const q1 = await getQuote(deps, quoteReq, GUEST, meta);
    const q2 = await getQuote(deps, quoteReq, GUEST, meta);
    await createBooking(d, { quoteId: q1.quoteId, quote: quoteReq, ...contacts }, GUEST, meta);
    const r2 = await createBooking(d, { quoteId: q2.quoteId, quote: quoteReq, ...contacts }, GUEST, meta);
    expect(r2.trackingNumber).toBe('GHUNIQUE00001');
  });

  it('treats null optional fields (as sent by the callable SDK) as matching the quote', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, meta);
    const withNulls = { ...quoteReq, pickup: { ...osu, line2: null, landmark: null }, packages: [{ ...quoteReq.packages[0], declaredValuePesewas: null }] };
    const res = await createBooking(deps, { quoteId: q.quoteId, quote: withNulls, ...contacts, instructions: null }, GUEST, meta);
    expect(res.trackingNumber).toMatch(/^GH/);
  });

  it('requires accepting the terms', async () => {
    await expectAppError(quoteThenBook(GUEST, { acceptTerms: false }), 'VALIDATION_FAILED');
  });
});

describe('role assignment', () => {
  const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
  const superAdmin: Caller = { uid: 'sup', role: 'super_admin', businessId: null, mfa: true };

  it('lets admins grant operational roles', () => {
    expect(authorizeRoleChange(admin, { uid: 'u2', role: 'dispatcher' }, null).role).toBe('dispatcher');
  });
  it('prevents admins from granting or modifying admin roles', () => {
    expect(() => authorizeRoleChange(admin, { uid: 'u2', role: 'admin' }, null)).toThrow(AppError);
    expect(() => authorizeRoleChange(admin, { uid: 'u2', role: 'driver' }, 'super_admin')).toThrow(AppError);
  });
  it('prevents anyone changing their own role', () => {
    expect(() => authorizeRoleChange(superAdmin, { uid: 'sup', role: 'customer' }, 'super_admin')).toThrow(/own role/);
  });
  it('lets super admins grant admin', () => {
    expect(authorizeRoleChange(superAdmin, { uid: 'u2', role: 'admin' }, null).role).toBe('admin');
  });
  it('requires MFA and a privileged role', () => {
    expect(() => authorizeRoleChange({ ...admin, mfa: false }, { uid: 'u2', role: 'driver' }, null)).toThrow(/Multi-factor/);
    expect(() => authorizeRoleChange({ uid: 'c', role: 'customer', businessId: null, mfa: true }, { uid: 'c2', role: 'admin' }, null)).toThrow(
      AppError,
    );
    expect(() => authorizeRoleChange(GUEST, { uid: 'u2', role: 'admin' }, null)).toThrow(AppError);
  });
  it('requires a businessId for business roles', () => {
    expect(() => authorizeRoleChange(admin, { uid: 'u2', role: 'business_owner' }, null)).toThrow(AppError);
  });
});

describe('publishPricingRules', () => {
  const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
  it('validates, versions and audits', async () => {
    const { version } = await publishPricingRules(store, admin, { ...rules, version: 999 });
    expect(version).toBe(2);
    expect(store.rules?.version).toBe(2);
    expect(store.audit.at(-1)).toMatchObject({ action: 'pricing.publish', targetId: '2' });
  });
  it('rejects invalid rule sets', async () => {
    await expectAppError(publishPricingRules(store, admin, { ...rules, minimumChargePesewas: -1 }), 'VALIDATION_FAILED');
  });
  it('rejects non-admins', async () => {
    await expectAppError(
      publishPricingRules(store, { uid: 'f', role: 'finance', businessId: null, mfa: true }, rules),
      'PERMISSION_DENIED',
    );
  });
});
