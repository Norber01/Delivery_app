/**
 * Runs the real FirestoreStore + services against the Firestore emulator.
 * Requires FIRESTORE_EMULATOR_HOST (see `pnpm test:integration`).
 */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import rulesJson from '../../firebase/seed/pricing-rules.sample.json' with { type: 'json' };
import areasJson from '../../firebase/seed/service-areas.sample.json' with { type: 'json' };
import { GUEST } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { randomId } from '../src/lib/hash.js';
import { publishPricingRules } from '../src/services/adminService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote, type ServiceDeps } from '../src/services/quoteService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let deps: ServiceDeps;

const admin = { uid: 'adm', role: 'admin' as const, businessId: null, mfa: true };
const quoteReq = {
  pickup: { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } },
  destination: { line1: 'Adum', city: 'Kumasi', region: 'Ashanti', location: { lat: 6.6966, lng: -1.6233 } },
  packages: [{ description: 'Phone accessories', weightKg: 3, lengthCm: 30, widthCm: 20, heightCm: 10, quantity: 2 }],
  urgency: 'express',
  specialHandling: ['fragile'],
};
const contacts = {
  sender: { name: 'Ama Mensah', phone: '0241234567' },
  recipient: { name: 'Kwame Asante', phone: '0201234567' },
  paymentPreference: 'mobile_money',
  acceptTerms: true,
};

async function clear() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
}

describe.runIf(enabled)('FirestoreStore (emulator)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, `int-${randomId(6)}`);
    db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
  });
  afterAll(() => deleteApp(app));

  beforeEach(async () => {
    await clear();
    const batch = db.batch();
    for (const a of areasJson) batch.set(db.collection('serviceAreas').doc(a.id), a);
    await batch.commit();
    // New store per test so the in-memory config cache starts empty.
    const store = new FirestoreStore(db);
    deps = { store, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
    await publishPricingRules(store, admin, rulesJson);
  });

  it('publishes pricing as a versioned, audited document', async () => {
    expect((await db.doc('config/pricing').get()).get('activeVersion')).toBe(1);
    const { version } = await publishPricingRules(deps.store, admin, { ...rulesJson, minimumChargePesewas: 2500 });
    expect(version).toBe(2);
    expect((await db.doc('pricingRules/1').get()).get('status')).toBe('superseded');
    expect((await db.doc('pricingRules/2').get()).get('rules.minimumChargePesewas')).toBe(2500);
    const audits = await db.collection('auditLogs').where('action', '==', 'pricing.publish').get();
    expect(audits.size).toBe(2);
  });

  it('quotes and books an intercity shipment end to end', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, { ipHash: 'h1' });
    expect(q.quote.deliveryType).toBe('intercity');
    // 6000 + 1500 + 1500 + (6 kg − 5) × 200 = 9200; express 30 % = 2760; fragile 500
    expect(q.quote.totalPesewas).toBe(12460);

    const stored = await db.doc(`quotes/${q.quoteId}`).get();
    expect(stored.get('expiresAt').toDate()).toBeInstanceOf(Date);

    const b = await createBooking(deps, { quoteId: q.quoteId, quote: quoteReq, ...contacts }, GUEST, { ipHash: 'h1' });
    expect(b.status).toBe('pending_payment');
    const doc = await db.doc(`deliveryRequests/${b.trackingNumber}`).get();
    expect(doc.get('price.totalPesewas')).toBe(12460);
    expect(doc.get('recipient.phone')).toBe('+233201234567');
    expect(doc.get('createdAt')).toBeTruthy();
    expect((await db.doc(`quotes/${q.quoteId}`).get()).get('usedByTrackingNumber')).toBe(b.trackingNumber);
  });

  it('stores bookings whose optional fields arrive as null from the callable SDK', async () => {
    const withNulls = {
      ...quoteReq,
      pickup: { ...quoteReq.pickup, line2: null, landmark: null, ghanaPostGps: null },
      packages: [{ ...quoteReq.packages[0], declaredValuePesewas: null }],
    };
    const q = await getQuote(deps, withNulls, GUEST, { ipHash: 'h3' });
    const b = await createBooking(deps, { quoteId: q.quoteId, quote: withNulls, ...contacts, instructions: null }, GUEST, { ipHash: 'h3' });
    const doc = await db.doc(`deliveryRequests/${b.trackingNumber}`).get();
    expect(doc.get('pickup.line2')).toBeUndefined();
    expect(doc.get('instructions')).toBeNull();
  });

  it('lets only one of two concurrent bookings use a quote', async () => {
    const q = await getQuote(deps, quoteReq, GUEST, { ipHash: 'h2' });
    const body = { quoteId: q.quoteId, quote: quoteReq, ...contacts };
    const results = await Promise.allSettled([
      createBooking(deps, body, GUEST, { ipHash: 'h2' }),
      createBooking(deps, body, GUEST, { ipHash: 'h2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as AppError).code).toBe('QUOTE_ALREADY_USED');
    expect((await db.collection('deliveryRequests').get()).size).toBe(1);
  });

  it('enforces the rate limit with Firestore counters', async () => {
    const limiter = new FirestoreRateLimiter(db);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('test:ip:x', 3, 600));
    expect(results).toEqual([true, true, true, false]);
  });
});
