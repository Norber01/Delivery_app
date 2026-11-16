import { COLLECTIONS } from '@courier/constants';
import type { AddressBookEntry, BusinessDoc, InvoiceDoc } from '@courier/shared-types';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { DeliveryRecord } from '../ops/types.js';
import { fromDoc } from '../store/firestoreStore.js';
import type { AuditEntry, BookingRecord } from '../store/types.js';
import type { BulkBatch, BusinessStore, InvoiceMutation } from './types.js';

export class FirestoreBusinessStore implements BusinessStore {
  constructor(private readonly db: Firestore) {}
  private col(name: keyof typeof COLLECTIONS) {
    return this.db.collection(COLLECTIONS[name]);
  }
  private audit(tx: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch, a: AuditEntry) {
    (tx as FirebaseFirestore.WriteBatch).create(this.col('auditLogs').doc(), { ...a, at: FieldValue.serverTimestamp() });
  }

  async getBusiness(id: string) {
    const s = await this.col('sellers').doc(id).get();
    return s.exists ? fromDoc<BusinessDoc>(s.data()!) : null;
  }
  async findBusinessByOwner(uid: string) {
    const s = await this.col('sellers').where('ownerUid', '==', uid).limit(1).get();
    return s.empty ? null : fromDoc<BusinessDoc>(s.docs[0]!.data());
  }
  async createBusiness(b: BusinessDoc) {
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(this.col('sellers').where('ownerUid', '==', b.ownerUid).limit(1));
      if (!existing.empty) return 'owner_has_business' as const;
      tx.create(this.col('sellers').doc(b.id), { ...b, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      this.audit(tx, { actorUid: b.ownerUid, actorRole: 'customer', action: 'business.register', targetType: 'business', targetId: b.id });
      return 'created' as const;
    });
  }
  async updateBusiness(id: string, patch: Partial<BusinessDoc>, audit?: AuditEntry) {
    const batch = this.db.batch();
    batch.update(this.col('sellers').doc(id), { ...patch, updatedAt: FieldValue.serverTimestamp() });
    if (audit) this.audit(batch, audit);
    await batch.commit();
  }
  async addStaff(id: string, uid: string) {
    await this.col('sellers').doc(id).update({ staffUids: FieldValue.arrayUnion(uid) });
  }
  async removeStaff(id: string, uid: string) {
    await this.col('sellers').doc(id).update({ staffUids: FieldValue.arrayRemove(uid) });
  }
  async setContract(c: { businessId: string; discountPercent: number; validFrom: Date; validTo: Date; approvedBy: string }) {
    await this.col('contractPricing').add({ ...c, validFrom: Timestamp.fromDate(c.validFrom), validTo: Timestamp.fromDate(c.validTo), createdAt: FieldValue.serverTimestamp() });
  }

  private book(bid: string) {
    return this.col('sellers').doc(bid).collection('addressBook');
  }
  async countAddressEntries(bid: string) {
    return (await this.book(bid).count().get()).data().count;
  }
  async saveAddressEntry(bid: string, e: AddressBookEntry) {
    await this.book(bid).doc(e.id).set({ ...e, updatedAt: FieldValue.serverTimestamp() });
  }
  async deleteAddressEntry(bid: string, id: string) {
    await this.book(bid).doc(id).delete();
  }

  async saveBatch(b: BulkBatch) {
    await this.col('bulkBatches').doc(b.id).set({ ...b, createdAt: Timestamp.fromDate(b.createdAt), expiresAt: Timestamp.fromDate(b.expiresAt) });
  }
  async getBatch(id: string) {
    const s = await this.col('bulkBatches').doc(id).get();
    return s.exists ? fromDoc<BulkBatch>(s.data()!) : null;
  }

  async listUninvoicedBookings(businessId: string, before: Date, limit: number) {
    const s = await this.col('deliveryRequests')
      .where('businessId', '==', businessId)
      .where('paymentPreference', '==', 'business_invoice')
      .where('invoiceId', '==', null)
      .where('createdAt', '<', Timestamp.fromDate(before))
      .orderBy('createdAt')
      .limit(limit + 50)
      .get();
    return s.docs.map((d) => fromDoc<BookingRecord>(d.data())).filter((b) => b.status !== 'cancelled').slice(0, limit);
  }
  async listCreditBusinesses() {
    const s = await this.col('sellers').where('verificationStatus', 'in', ['verified', 'suspended']).get();
    return s.docs.map((d) => fromDoc<BusinessDoc>(d.data()));
  }
  async nextInvoiceNumber(period: string) {
    const ref = this.col('counters').doc(`invoice-${period}`);
    const n = await this.db.runTransaction(async (tx) => {
      const cur = ((await tx.get(ref)).get('value') as number | undefined) ?? 0;
      tx.set(ref, { value: cur + 1 });
      return cur + 1;
    });
    return `INV-${period.replace('-', '')}-${String(n).padStart(4, '0')}`;
  }
  async createInvoice(inv: InvoiceDoc, ids: string[]) {
    return this.db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...ids.map((id) => this.col('deliveryRequests').doc(id)));
      const ok = snaps.filter((s) => s.exists && !s.get('invoiceId') && s.get('status') !== 'cancelled').map((s) => s.id);
      if (ok.length === 0) return [];
      const lines = inv.lines.filter((l) => ok.includes(l.trackingNumber));
      tx.create(this.col('invoices').doc(inv.id), { ...inv, lines, totalPesewas: lines.reduce((n, l) => n + l.amountPesewas, 0), createdAt: FieldValue.serverTimestamp() });
      for (const id of ok) tx.update(this.col('deliveryRequests').doc(id), { invoiceId: inv.id, updatedAt: FieldValue.serverTimestamp() });
      this.audit(tx, { actorUid: null, actorRole: 'system', action: 'invoice.issue', targetType: 'invoice', targetId: inv.id, after: { number: inv.number, businessId: inv.businessId, lines: ok.length } });
      return ok;
    });
  }
  async getInvoice(id: string) {
    const s = await this.col('invoices').doc(id).get();
    return s.exists ? (s.data() as InvoiceDoc) : null;
  }
  async updateInvoice(id: string, mutate: InvoiceMutation, audit: AuditEntry) {
    const ref = this.col('invoices').doc(id);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const inv = s.data() as InvoiceDoc;
      const r = mutate(inv);
      if ('error' in r) return r;
      tx.update(ref, { ...r.invoice, updatedAt: FieldValue.serverTimestamp() });
      if (r.creditReleasePesewas) tx.update(this.col('sellers').doc(inv.businessId), { creditUsedPesewas: FieldValue.increment(-r.creditReleasePesewas) });
      this.audit(tx, audit);
      return { ...inv, ...r.invoice };
    });
  }
  async updateInvoiceBookings(ids: string[], patch: { invoiceId?: null; paymentStatus?: 'paid' }) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = this.db.batch();
      for (const id of ids.slice(i, i + 400)) batch.update(this.col('deliveryRequests').doc(id), { ...patch, updatedAt: FieldValue.serverTimestamp() });
      await batch.commit();
    }
  }
  async listOverdueCandidates(now: Date) {
    const s = await this.col('invoices').where('status', 'in', ['issued', 'partially_paid']).where('dueAt', '<', now.toISOString()).limit(500).get();
    return s.docs.map((d) => d.data() as InvoiceDoc);
  }
  async refreshOverdueFlag(businessId: string) {
    const s = await this.col('invoices').where('businessId', '==', businessId).where('status', '==', 'overdue').limit(1).get();
    await this.col('sellers').doc(businessId).update({ hasOverdueInvoices: !s.empty });
    return !s.empty;
  }

  async listBusinessBookings(businessId: string, from: Date, to: Date) {
    const s = await this.col('deliveryRequests')
      .where('businessId', '==', businessId)
      .where('createdAt', '>=', Timestamp.fromDate(from))
      .where('createdAt', '<', Timestamp.fromDate(to))
      .orderBy('createdAt')
      .limit(5000)
      .get();
    return s.docs.map((d) => fromDoc<BookingRecord>(d.data()));
  }
  async getDeliveries(ids: string[]) {
    const out: DeliveryRecord[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const snaps = await this.db.getAll(...ids.slice(i, i + 300).map((id) => this.col('deliveries').doc(id)));
      out.push(...snaps.filter((s) => s.exists).map((s) => fromDoc<DeliveryRecord>(s.data()!)));
    }
    return out;
  }
}
