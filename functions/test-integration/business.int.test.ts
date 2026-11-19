/** Phase 5 against the Firestore emulator: credit races, bulk idempotency, invoice runs. */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BusinessDoc } from '@courier/shared-types';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { randomId } from '../src/lib/hash.js';
import { FirestoreBusinessStore } from '../src/business/firestoreBusiness.js';
import { confirmBulkBooking, previewBulkBooking, type BulkDeps } from '../src/business/bulkService.js';
import { generateInvoices, recordInvoicePayment } from '../src/business/invoiceService.js';
import { publishPricingRules } from '../src/services/adminService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';
import { areas, contacts, quoteReq, rules } from '../test/helpers.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = 'demo-courier';
let app: App;
let db: Firestore;
let store: FirestoreStore;
let biz: FirestoreBusinessStore;
let bulk: BulkDeps;
const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const owner: Caller = { uid: 'ama', role: 'business_owner', businessId: 'biz1', mfa: false };
const addr = { line1: 'Ring Road', city: 'Accra', region: 'Greater Accra' as const, location: { lat: 5.556, lng: -0.1823 } };
const row = (ref: string) => ({ reference: ref, recipient_name: 'Kofi Boateng', recipient_phone: '0501234567', address_line1: 'Madina', city: 'Accra', region: 'Greater Accra', lat: '5.6681', lng: '-0.1653', description: 'Dress', weight_kg: '1', length_cm: '30', width_cm: '20', height_cm: '5' });

async function seedBusiness(limitPesewas: number) {
  const b: BusinessDoc = {
    id: 'biz1', legalName: 'Ama Styles Limited', tradingName: 'Ama Styles', registrationNumber: 'CS1', tin: 'C0012345678',
    contact: { name: 'Ama', phone: '+233241234567' }, billingAddress: addr, pickupAddress: addr, ownerUid: 'ama', staffUids: [], staffDirectory: {},
    verificationStatus: 'verified', verificationNote: null, documentKeys: [],
    creditTerms: { limitPesewas, termDays: 30, approvedBy: 'fin', approvedAt: '2026-11-01T00:00:00Z' },
    creditUsedPesewas: 0, hasOverdueInvoices: false, contractDiscountPercent: 0,
  };
  await db.doc('sellers/biz1').set(b);
}

async function singleInvoiceBooking() {
  const ip = { ipHash: randomId(6) };
  const qd = { store, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
  const q = await getQuote(qd, quoteReq, owner, ip);
  return createBooking(qd, { quoteId: q.quoteId, quote: quoteReq, ...contacts, paymentPreference: 'business_invoice' }, owner, ip);
}

describe.runIf(enabled)('Phase 5 business (emulator)', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, `int5-${randomId(6)}`);
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
    biz = new FirestoreBusinessStore(db);
    await publishPricingRules(store, admin, rules);
    bulk = { store, biz, rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId(12) };
  });

  it('never lets concurrent invoice bookings exceed the credit limit', async () => {
    await seedBusiness(10_000); // each booking costs 34.90 (estimated distance may vary slightly)
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => singleInvoiceBooking()));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const seller = (await db.doc('sellers/biz1').get()).data()!;
    const totals = await db.collection('deliveryRequests').where('businessId', '==', 'biz1').get();
    const sum = totals.docs.reduce((n, d) => n + (d.get('price.totalPesewas') as number), 0);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBe(totals.size);
    expect(seller.creditUsedPesewas).toBe(sum);
    expect(sum).toBeLessThanOrEqual(10_000);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { code: string }).code).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('a double-clicked bulk confirmation books each row once', async () => {
    await seedBusiness(1_000_000);
    const p = await previewBulkBooking(bulk, owner, { pickup: addr, paymentPreference: 'business_invoice', rows: [row('A'), row('B'), row('C')] });
    await Promise.all([1, 2].map(() => confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true })));
    const bookings = await db.collection('deliveryRequests').where('bulkBatchId', '==', p.batchId).get();
    expect(bookings.size).toBe(3);
    expect(Object.keys((await db.doc(`bulkBatches/${p.batchId}`).get()).get('created'))).toHaveLength(3);
    expect((await db.doc('sellers/biz1').get()).get('creditUsedPesewas')).toBe(p.totalPesewas);
  });

  it('invoices single and bulk bookings once even when two runs overlap; payment releases credit', async () => {
    await seedBusiness(1_000_000);
    await singleInvoiceBooking(); // single-booking path must be invoiceable too
    const p = await previewBulkBooking(bulk, owner, { pickup: addr, paymentPreference: 'business_invoice', rows: [row('A'), row('B')] });
    await confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true });
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const deps = { biz, now: () => new Date(), newId: () => randomId(12) };
    const runs = await Promise.all([generateInvoices(deps, finance, { period }), generateInvoices(deps, finance, { period })]);
    const invoices = await db.collection('invoices').get();
    const lines = invoices.docs.flatMap((d) => (d.get('lines') as { trackingNumber: string }[]).map((l) => l.trackingNumber));
    expect(lines).toHaveLength(3);
    expect(new Set(lines).size).toBe(3);
    expect(new Set(invoices.docs.map((d) => d.get('number'))).size).toBe(invoices.size);
    expect(runs.flatMap((r) => r.invoices)).toHaveLength(invoices.size);

    const used = (await db.doc('sellers/biz1').get()).get('creditUsedPesewas') as number;
    for (const d of invoices.docs) {
      await recordInvoicePayment(deps, finance, { invoiceId: d.id, amountPesewas: d.get('totalPesewas'), method: 'bank_transfer', reference: `GCB-${d.id}` });
    }
    expect((await db.doc('sellers/biz1').get()).get('creditUsedPesewas')).toBe(used - invoices.docs.reduce((n, d) => n + (d.get('totalPesewas') as number), 0));
    const paid = await db.collection('deliveryRequests').where('paymentStatus', '==', 'paid').get();
    expect(paid.size).toBe(3);
  });
});
