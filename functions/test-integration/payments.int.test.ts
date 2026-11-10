/** Phase 2 FirestoreStore paths against the Firestore emulator (requires FIRESTORE_EMULATOR_HOST). */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { randomId } from '../src/lib/hash.js';
import { claimBooking } from '../src/services/accountService.js';
import { publishPricingRules } from '../src/services/adminService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getPaymentStatus, handlePaymentWebhook, initiatePayment, paymentId, type PaymentDeps } from '../src/services/paymentService.js';
import { getQuote } from '../src/services/quoteService.js';
import { reconcileRefunds, requestRefund } from '../src/services/refundService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';
import { FakeProvider, areas, chargeWebhook, contacts, quoteReq, rules, site } from '../test/helpers.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let store: FirestoreStore;
let provider: FakeProvider;
let pay: PaymentDeps;
const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const noRefund = async () => {};

async function book(caller: Caller = GUEST) {
  const ip = { ipHash: randomId(6) };
  const deps = { store, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
  const q = await getQuote(deps, quoteReq, caller, ip);
  const b = await createBooking({ ...deps, site }, { quoteId: q.quoteId, quote: quoteReq, ...contacts, paymentPreference: 'mobile_money' }, caller, ip);
  return { tn: b.trackingNumber, token: b.guestAccessToken ?? undefined, total: b.totalPesewas, ip };
}

describe.runIf(enabled)('Phase 2 FirestoreStore (emulator)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, `int2-${randomId(6)}`);
    db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
  });
  afterAll(() => deleteApp(app));

  beforeEach(async () => {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const batch = db.batch();
    for (const a of areas) batch.set(db.collection('serviceAreas').doc(a.id), a);
    await batch.commit();
    store = new FirestoreStore(db);
    await publishPricingRules(store, admin, rules);
    provider = new FakeProvider();
    pay = { store, rateLimiter: new FirestoreRateLimiter(db), provider, now: () => new Date(), site };
  });

  it('confirms a booking once even when the same webhook is delivered concurrently', async () => {
    const b = await book();
    const { reference } = await initiatePayment(pay, { trackingNumber: b.tn, accessToken: b.token }, GUEST, b.ip);
    provider.complete(reference);
    const hook = chargeWebhook(reference);
    const results = await Promise.all([1, 2, 3].map(() => handlePaymentWebhook(pay, hook.raw, hook.headers, noRefund)));
    expect(results.filter((r) => r.body === 'applied')).toHaveLength(1);

    const booking = await db.doc(`deliveryRequests/${b.tn}`).get();
    expect(booking.get('paymentStatus')).toBe('paid');
    expect(booking.get('status')).toBe('confirmed');
    const events = await db.collection('trackingEvents').where('trackingNumber', '==', b.tn).get();
    expect(events.docs.map((d) => d.get('type')).sort()).toEqual(['booking_confirmed', 'booking_created', 'payment_received']);
    const sms = await db.collection('notifications').where('trackingNumber', '==', b.tn).get();
    expect(sms.docs.map((d) => d.get('template')).sort()).toEqual(['booking_pending_payment', 'payment_received']);
    const p = await db.doc(`payments/${paymentId('paystack', reference)}`).get();
    expect(p.get('status')).toBe('succeeded');
    expect(p.get('paidAt').toDate()).toBeInstanceOf(Date);
  });

  it('caps concurrent refund requests at the captured amount', async () => {
    const b = await book();
    const { reference } = await initiatePayment(pay, { trackingNumber: b.tn, accessToken: b.token }, GUEST, b.ip);
    provider.complete(reference);
    await getPaymentStatus(pay, { trackingNumber: b.tn, accessToken: b.token }, GUEST, b.ip);
    const half = Math.ceil(b.total * 0.6);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => requestRefund(pay, finance, { paymentReference: reference, amountPesewas: half, reason: 'Concurrent test' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const p = await db.doc(`payments/${paymentId('paystack', reference)}`).get();
    expect(p.get('refundPendingPesewas')).toBe(half);

    for (const r of provider.refunds.values()) r.status = 'processed';
    await reconcileRefunds(pay);
    const after = await db.doc(`payments/${paymentId('paystack', reference)}`).get();
    expect(after.get('refundedPesewas')).toBe(half);
    expect(after.get('refundPendingPesewas')).toBe(0);
    expect((await db.doc(`deliveryRequests/${b.tn}`).get()).get('paymentStatus')).toBe('partially_refunded');
  });

  it('claims a guest booking (and its payments) into an account and tracks it', async () => {
    const b = await book();
    await initiatePayment(pay, { trackingNumber: b.tn, accessToken: b.token }, GUEST, b.ip);
    const alice: Caller = { uid: 'alice', role: 'customer', businessId: null, mfa: false };
    await claimBooking({ store }, alice, { trackingNumber: b.tn, accessToken: b.token });
    expect((await db.doc(`deliveryRequests/${b.tn}`).get()).get('customerUid')).toBe('alice');
    const payments = await db.collection('payments').where('trackingNumber', '==', b.tn).get();
    expect(payments.docs.every((d) => d.get('customerUid') === 'alice')).toBe(true);

    const view = await getTrackingView({ store, rateLimiter: pay.rateLimiter }, { trackingNumber: b.tn }, alice, b.ip);
    expect(view.access).toBe('full');
    expect(view.bookedAt).toMatch(/^\d{4}-/);
    expect(view.details?.payments).toHaveLength(1);
  });
});
