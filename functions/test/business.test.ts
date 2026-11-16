import { beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import {
  deleteAddressEntry,
  inviteStaff,
  registerBusiness,
  removeStaff,
  requestBusinessDocumentUpload,
  reviewBusiness,
  saveAddressEntry,
  setContractPricing,
  setCreditTerms,
  type BusinessDeps,
} from '../src/business/businessService.js';
import { confirmBulkBooking, previewBulkBooking, type BulkDeps } from '../src/business/bulkService.js';
import { generateInvoices, getBusinessReport, markOverdueInvoices, previousPeriod, recordInvoicePayment, voidInvoice, type InvoiceDeps } from '../src/business/invoiceService.js';
import { dispatchAction, ensureDeliveryForBooking } from '../src/ops/opsService.js';
import { getQuote } from '../src/services/quoteService.js';
import { MemoryBusinessStore, MemoryIdentity } from './businessMemory.js';
import { meta, quoteReq, site, world, type World } from './helpers.js';
import { MemoryEvidence, MemoryLive, MemoryOpsStore } from './opsMemory.js';

let w: World;
let ops: MemoryOpsStore;
let biz: MemoryBusinessStore;
let identity: MemoryIdentity;
let evidence: MemoryEvidence;
let bdeps: BusinessDeps;
let bulk: BulkDeps;
let inv: InvoiceDeps;
let seq = 0;

const ama: Caller = { uid: 'ama', role: 'customer', businessId: null, mfa: false };
const admin: Caller = { uid: 'adm', role: 'admin', businessId: null, mfa: true };
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);

const accra = { line1: '1 Ring Road', city: 'Accra', region: 'Greater Accra', location: { lat: 5.57, lng: -0.21 } };
const regInput = (keys: string[]) => ({
  legalName: 'Ama Styles Limited',
  tradingName: 'Ama Styles',
  registrationNumber: 'CS123456789',
  tin: 'C0012345678',
  contact: { name: 'Ama Mensah', phone: '0241234567', email: 'ama@styles.gh' },
  billingAddress: accra,
  pickupAddress: { ...accra, location: { lat: 5.556, lng: -0.1823 } },
  documentKeys: keys,
});

/** Customer Ama registers (with an uploaded certificate); returns her owner caller. */
async function registered(): Promise<Caller> {
  const t = await requestBusinessDocumentUpload(bdeps, ama, { contentType: 'application/pdf', bytes: 200_000 });
  evidence.objects.add(t.key);
  const { businessId } = await registerBusiness(bdeps, ama, regInput([t.key]));
  return { uid: 'ama', role: 'business_owner', businessId, mfa: false };
}
async function verifiedWithCredit(limit = 1_000_000): Promise<Caller> {
  const owner = await registered();
  await reviewBusiness(bdeps, admin, { businessId: owner.businessId, decision: 'verified' });
  await setCreditTerms(bdeps, finance, { businessId: owner.businessId, limitPesewas: limit, termDays: 30 });
  return owner;
}

const csvRow = (o: Record<string, string> = {}) => ({
  reference: 'ORD-1',
  recipient_name: 'Kofi Boateng',
  recipient_phone: '0501234567',
  address_line1: 'Madina Market',
  city: 'Accra',
  region: 'Greater Accra',
  lat: '5.6681',
  lng: '-0.1653',
  description: 'Dress',
  weight_kg: '1',
  length_cm: '30',
  width_cm: '20',
  height_cm: '5',
  ...o,
});
const pickup = { line1: 'Ama Styles shop', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };

beforeEach(() => {
  w = world();
  ops = new MemoryOpsStore(w.store, w.clock);
  biz = new MemoryBusinessStore(w.store, ops);
  identity = new MemoryIdentity();
  evidence = new MemoryEvidence();
  seq = 0;
  const newId = () => `id${++seq}`;
  bdeps = { biz, ops, evidence, identity, uploads: { workerUrl: 'https://edge.test', secret: 's' }, now: () => w.clock.now, newId };
  bulk = {
    store: w.store,
    biz,
    rateLimiter: w.pay.rateLimiter,
    maps: {
      name: 'fake',
      geocode: async (q) => (q.startsWith('Adum') ? [{ label: 'Adum, Kumasi', location: { lat: 6.6966, lng: -1.6233 } }] : q.startsWith('Nowhere') ? [] : [{ label: `${q} (matched)`, location: { lat: 5.6, lng: -0.17 } }]),
      route: async () => ({ distanceKm: 8.3, durationMinutes: 20 }),
    },
    now: () => w.clock.now,
    newId,
    site,
  };
  inv = { biz, now: () => w.clock.now, newId };
});

describe('business registration & verification', () => {
  it('turns a customer into the owner of a pending business', async () => {
    const owner = await registered();
    expect(identity.claims.get('ama')).toEqual({ role: 'business_owner', businessId: owner.businessId });
    expect(await biz.getBusiness(owner.businessId!)).toMatchObject({ verificationStatus: 'pending', creditTerms: null, tin: 'C0012345678' });
    await expectCode(registerBusiness(bdeps, ama, regInput(['kyb/ama/AAAAAAAAAAAA.pdf'])), 'UPLOAD_NOT_FOUND');
  });

  it('requires documents uploaded by the applicant, and one business per owner', async () => {
    const t = await requestBusinessDocumentUpload(bdeps, ama, { contentType: 'application/pdf', bytes: 1000 });
    // Uploaded by Ama but submitted by Bob: refused.
    evidence.objects.add(t.key);
    await expectCode(registerBusiness(bdeps, { ...ama, uid: 'bob' }, regInput([t.key])), 'UPLOAD_NOT_FOUND');
    await registerBusiness(bdeps, ama, regInput([t.key]));
    await expectCode(registerBusiness(bdeps, ama, regInput([t.key])), 'ALREADY_REGISTERED');
    await expectCode(registerBusiness(bdeps, { ...ama, role: 'driver' }, regInput([t.key])), 'PERMISSION_DENIED');
  });

  it('only admins verify; credit needs verification; suspension withdraws credit', async () => {
    const owner = await registered();
    await expectCode(reviewBusiness(bdeps, finance, { businessId: owner.businessId, decision: 'verified' }), 'PERMISSION_DENIED');
    await expectCode(setCreditTerms(bdeps, finance, { businessId: owner.businessId, limitPesewas: 100_000, termDays: 30 }), 'BUSINESS_NOT_VERIFIED');
    await expectCode(reviewBusiness(bdeps, admin, { businessId: owner.businessId, decision: 'rejected' }), 'VALIDATION_FAILED'); // reason required
    await reviewBusiness(bdeps, admin, { businessId: owner.businessId, decision: 'verified' });
    await setCreditTerms(bdeps, finance, { businessId: owner.businessId, limitPesewas: 100_000, termDays: 14 });
    expect((await biz.getBusiness(owner.businessId!))!.creditTerms).toMatchObject({ limitPesewas: 100_000, termDays: 14, approvedBy: 'fin' });
    await reviewBusiness(bdeps, admin, { businessId: owner.businessId, decision: 'suspended', note: 'Unpaid invoices' });
    expect((await biz.getBusiness(owner.businessId!))!.creditTerms).toBeNull();
    expect(w.store.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['business.verified', 'business.credit_terms', 'business.suspended']));
  });

  it('applies contract pricing to the business’s quotes', async () => {
    const owner = await verifiedWithCredit();
    await setContractPricing(bdeps, finance, { businessId: owner.businessId, discountPercent: 10, validFrom: '2026-11-01T00:00:00Z', validTo: '2027-11-01T00:00:00Z' });
    const q = await getQuote({ store: w.store, rateLimiter: w.pay.rateLimiter, maps: bulk.maps, now: () => w.clock.now, newId: () => 'quotebiz000001' }, quoteReq, owner, meta);
    expect(q.quote.lines.find((l) => l.code === 'DISCOUNT_CONTRACT')!.amountPesewas).toBe(-349);
  });
});

describe('staff and address book', () => {
  it('owners invite and remove staff; staff cannot manage staff', async () => {
    const owner = await registered();
    const { uid, setupLink } = await inviteStaff(bdeps, owner, { name: 'Efua Ansah', email: 'efua@styles.gh' });
    expect(setupLink).toContain('oobCode');
    expect(identity.claims.get(uid)).toEqual({ role: 'business_staff', businessId: owner.businessId });
    const staff: Caller = { uid, role: 'business_staff', businessId: owner.businessId, mfa: false };
    await expectCode(inviteStaff(bdeps, staff, { name: 'X Y', email: 'x@styles.gh' }), 'PERMISSION_DENIED');
    await expectCode(inviteStaff(bdeps, owner, { name: 'Efua Ansah', email: 'efua@styles.gh' }), 'ACCOUNT_EXISTS');
    await removeStaff(bdeps, owner, { uid });
    expect(identity.claims.get(uid)).toEqual({ role: 'customer' });
    expect(identity.revoked).toEqual([uid]);
    // A removed staff member's old claims no longer match the business.
    await expectCode(saveAddressEntry(bdeps, staff, { label: 'x', contact: { name: 'Kofi', phone: '0501234567' }, address: accra }), 'PERMISSION_DENIED');
  });

  it('members keep an address book of their customers', async () => {
    const owner = await registered();
    const { id } = await saveAddressEntry(bdeps, owner, { label: 'Kofi (Madina)', contact: { name: 'Kofi Boateng', phone: '0501234567' }, address: accra });
    expect(biz.addressBooks.get(owner.businessId!)!.get(id)!.contact.phone).toBe('+233501234567');
    await deleteAddressEntry(bdeps, owner, { id });
    expect(biz.addressBooks.get(owner.businessId!)!.size).toBe(0);
    await expectCode(saveAddressEntry(bdeps, { ...owner, businessId: 'biz_other' }, { label: 'x', contact: { name: 'Kofi', phone: '0501234567' }, address: accra }), 'PERMISSION_DENIED');
  });
});

describe('bulk booking', () => {
  it('previews every row server-side: validation, geocoding, intercity, batch bulk discount', async () => {
    const owner = await verifiedWithCredit();
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => csvRow({ reference: `ORD-${i}`, quantity: '1' })),
      csvRow({ reference: 'GEO', lat: '', lng: '', address_line1: 'Osu Oxford Street' }),
      csvRow({ reference: 'KSI', lat: '', lng: '', address_line1: 'Adum', city: 'Kumasi', region: 'Ashanti' }),
      csvRow({ reference: 'BAD', weight_kg: 'heavy' }),
      csvRow({ reference: 'LOST', lat: '', lng: '', address_line1: 'Nowhere Lane' }),
    ];
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'business_invoice', rows });
    expect(p.validCount).toBe(11);
    expect(p.invalidCount).toBe(2);
    expect(p.bulkDiscountPercent).toBe(5); // 11 items in the batch → 10+ tier, although each row has 1
    const byRef = Object.fromEntries(p.rows.map((r) => [r.reference, r]));
    expect(byRef.GEO!.geocodedLabel).toContain('matched');
    expect(byRef.KSI!.quote!.deliveryType).toBe('intercity');
    expect(byRef.KSI!.destinationAreaId).toBe('kumasi');
    expect(byRef.BAD!.errors).toEqual(['weight_kg must be a number']);
    expect(byRef.LOST!.errors[0]).toContain('Address not found');
    expect(p.totalPesewas).toBe(p.rows.filter((r) => r.ok).reduce((n, r) => n + r.quote!.totalPesewas, 0));
  });

  it('confirms valid rows exactly once, reserving credit', async () => {
    const owner = await verifiedWithCredit();
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'business_invoice', rows: [csvRow({ reference: 'A' }), csvRow({ reference: 'B' }), csvRow({ reference: 'C', region: 'Lagos' })] });
    const r1 = await confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true });
    expect(r1.created).toHaveLength(2);
    expect(r1.failed).toEqual([]);
    const bk = w.store.bookings.get(r1.created[0]!.trackingNumber)!;
    expect(bk).toMatchObject({ businessId: owner.businessId, source: 'bulk', clientReference: 'A', paymentStatus: 'invoiced', status: 'confirmed', sender: { name: 'Ama Styles' } });
    expect((await biz.getBusiness(owner.businessId!))!.creditUsedPesewas).toBe(p.totalPesewas);
    // Retrying the same confirmation creates nothing new.
    const r2 = await confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true });
    expect(r2.created.map((c) => c.trackingNumber).sort()).toEqual(r1.created.map((c) => c.trackingNumber).sort());
    expect(w.store.bookings.size).toBe(2);
  });

  it('refuses invoice billing beyond the credit limit or when unverified; cash at pickup works', async () => {
    const owner = await verifiedWithCredit(5000);
    const rows = [csvRow({ reference: 'A' }), csvRow({ reference: 'B' })];
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'business_invoice', rows });
    await expectCode(confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true }), 'CREDIT_LIMIT_EXCEEDED');
    const cash = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'cash_on_pickup', rows });
    expect((await confirmBulkBooking(bulk, owner, { batchId: cash.batchId, acceptTerms: true })).created).toHaveLength(2);
  });

  it('expires previews and protects other businesses’ batches', async () => {
    const owner = await verifiedWithCredit();
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'cash_on_pickup', rows: [csvRow()] });
    await expectCode(confirmBulkBooking(bulk, { ...owner, uid: 'mallory', businessId: 'biz_x' }, { batchId: p.batchId, acceptTerms: true }), 'PERMISSION_DENIED');
    w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000);
    await expectCode(confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true }), 'BATCH_EXPIRED');
  });

  it('refuses a pickup outside service areas', async () => {
    const owner = await verifiedWithCredit();
    await expectCode(previewBulkBooking(bulk, owner, { pickup: { ...pickup, location: { lat: 9.4, lng: -0.84 } }, paymentPreference: 'cash_on_pickup', rows: [csvRow()] }), 'PICKUP_NOT_SERVICED');
  });
});

describe('invoices', () => {
  async function invoiced(owner: Caller, n = 3) {
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'business_invoice', rows: Array.from({ length: n }, (_, i) => csvRow({ reference: `R${i}` })) });
    return (await confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true })).created.map((c) => c.trackingNumber);
  }

  it('invoices each uninvoiced booking once; cancelled ones are excluded and release credit', async () => {
    const owner = await verifiedWithCredit();
    const tns = await invoiced(owner);
    // Cancel one before invoicing: its credit comes back.
    const before = (await biz.getBusiness(owner.businessId!))!.creditUsedPesewas;
    const cancelled = w.store.bookings.get(tns[2]!)!;
    await ensureDeliveryForBooking({ ops, now: () => w.clock.now }, cancelled);
    await dispatchAction(
      { ops, live: new MemoryLive(), evidence, now: () => w.clock.now, newId: () => `x${++seq}`, newOtp: () => '000000', site, uploads: { workerUrl: 'x', secret: 's' } },
      { uid: 'disp', role: 'dispatcher', businessId: null, mfa: true },
      { type: 'cancel', deliveryId: tns[2], reason: 'Customer changed mind' },
    );
    expect((await biz.getBusiness(owner.businessId!))!.creditUsedPesewas).toBe(before - cancelled.price.totalPesewas);

    w.clock.now = new Date('2026-12-01T02:00:00Z');
    const r = await generateInvoices(inv, 'system', { period: previousPeriod(w.clock.now) });
    expect(r.invoices).toHaveLength(1);
    const invoice = biz.invoices.get(r.invoices[0]!.id)!;
    expect(invoice).toMatchObject({ number: 'INV-202611-0001', status: 'issued', businessName: 'Ama Styles Limited', tin: 'C0012345678' });
    expect(invoice.lines.map((l) => l.trackingNumber).sort()).toEqual([tns[0], tns[1]].sort());
    expect(invoice.lines[0]!.reference).toMatch(/^R\d$/);
    expect(new Date(invoice.dueAt).getTime() - new Date(invoice.issuedAt).getTime()).toBe(30 * 86_400_000);
    // Re-running issues nothing new.
    expect((await generateInvoices(inv, 'system', { period: '2026-11' })).invoices).toHaveLength(0);
  });

  it('records partial and full payments, releasing credit and marking bookings paid', async () => {
    const owner = await verifiedWithCredit();
    const tns = await invoiced(owner, 2);
    w.clock.now = new Date('2026-12-01T02:00:00Z');
    const { invoices } = await generateInvoices(inv, finance, { period: '2026-11' });
    const id = invoices[0]!.id;
    const total = invoices[0]!.totalPesewas;
    await expectCode(recordInvoicePayment(inv, finance, { invoiceId: id, amountPesewas: total + 1, method: 'bank_transfer', reference: 'GCB-1' }), 'VALIDATION_FAILED');
    await recordInvoicePayment(inv, finance, { invoiceId: id, amountPesewas: 1000, method: 'mobile_money', reference: 'MOMO-77' });
    expect(biz.invoices.get(id)!.status).toBe('partially_paid');
    const r = await recordInvoicePayment(inv, finance, { invoiceId: id, amountPesewas: total - 1000, method: 'bank_transfer', reference: 'GCB-2' });
    expect(r.status).toBe('paid');
    expect((await biz.getBusiness(owner.businessId!))!.creditUsedPesewas).toBe(0);
    expect(tns.map((t) => w.store.bookings.get(t)!.paymentStatus)).toEqual(['paid', 'paid']);
    await expectCode(recordInvoicePayment(inv, { ...finance, role: 'dispatcher' }, { invoiceId: id, amountPesewas: 1, method: 'cash', reference: 'x1' }), 'PERMISSION_DENIED');
  });

  it('overdue invoices block invoice billing until paid; void returns bookings to the next run', async () => {
    const owner = await verifiedWithCredit();
    await invoiced(owner, 1);
    w.clock.now = new Date('2026-12-01T02:00:00Z');
    const { invoices } = await generateInvoices(inv, 'system', { period: '2026-11' });
    w.clock.now = new Date('2027-01-05T00:00:00Z');
    expect(await markOverdueInvoices(inv)).toEqual({ overdue: 1 });
    expect((await biz.getBusiness(owner.businessId!))!.hasOverdueInvoices).toBe(true);
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'business_invoice', rows: [csvRow()] });
    await expectCode(confirmBulkBooking(bulk, { ...owner }, { batchId: p.batchId, acceptTerms: true }), 'INVOICES_OVERDUE');

    await voidInvoice(inv, finance, { invoiceId: invoices[0]!.id, reason: 'Raised against the wrong account' });
    expect((await biz.getBusiness(owner.businessId!))!.hasOverdueInvoices).toBe(false);
    expect([...w.store.bookings.values()].every((b) => !b.invoiceId)).toBe(true);
    const again = await generateInvoices(inv, 'system', { period: '2026-12' });
    expect(again.invoices).toHaveLength(1);
  });

  it('cannot invoice a month that has not started', async () => {
    await expectCode(generateInvoices(inv, finance, { period: '2027-05' }), 'VALIDATION_FAILED');
  });
});

describe('monthly report', () => {
  it('summarises a month for the business only', async () => {
    const owner = await verifiedWithCredit();
    const p = await previewBulkBooking(bulk, owner, { pickup, paymentPreference: 'cash_on_pickup', rows: [csvRow({ reference: 'A' }), csvRow({ reference: 'B', city: 'Accra' })] });
    await confirmBulkBooking(bulk, owner, { batchId: p.batchId, acceptTerms: true });
    const r = await getBusinessReport(inv, owner, { month: '2026-11' });
    expect(r).toMatchObject({ bookings: 2, cancelled: 0, spendPesewas: p.totalPesewas, byType: { intra_city: 2 } });
    expect(r.rows.map((x) => x.reference).sort()).toEqual(['A', 'B']);
    expect((await getBusinessReport(inv, owner, { month: '2026-10' })).bookings).toBe(0);
    await expectCode(getBusinessReport(inv, { uid: 'x', role: 'customer', businessId: null, mfa: false }, { month: '2026-11' }), 'PERMISSION_DENIED');
  });
});
