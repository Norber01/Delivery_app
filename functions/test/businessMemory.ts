import type { AddressBookEntry, BusinessDoc, InvoiceDoc } from '@courier/shared-types';
import type { BulkBatch, BusinessIdentityPort, BusinessStore, InvoiceMutation } from '../src/business/types.js';
import type { AuditEntry } from '../src/store/types.js';
import type { MemoryOpsStore } from './opsMemory.js';
import type { MemoryStore } from './memoryStore.js';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory BusinessStore; business records live in MemoryStore.sellers so booking credit checks see them. */
export class MemoryBusinessStore implements BusinessStore {
  addressBooks = new Map<string, Map<string, AddressBookEntry>>();
  batches = new Map<string, BulkBatch>();
  invoices = new Map<string, InvoiceDoc>();
  contracts: { businessId: string; discountPercent: number }[] = [];
  counters = new Map<string, number>();

  constructor(
    private readonly store: MemoryStore,
    private readonly ops: MemoryOpsStore | null = null,
  ) {}

  private all(): BusinessDoc[] {
    return [...this.store.sellers.values()] as unknown as BusinessDoc[];
  }
  async getBusiness(id: string) {
    const b = this.store.sellers.get(id) as unknown as BusinessDoc | undefined;
    return b ? clone(b) : null;
  }
  async findBusinessByOwner(uid: string) {
    const b = this.all().find((x) => x.ownerUid === uid);
    return b ? clone(b) : null;
  }
  async createBusiness(b: BusinessDoc) {
    if (this.all().some((x) => x.ownerUid === b.ownerUid)) return 'owner_has_business' as const;
    this.store.sellers.set(b.id, clone(b) as never);
    return 'created' as const;
  }
  async updateBusiness(id: string, patch: Partial<BusinessDoc>, audit?: AuditEntry) {
    Object.assign(this.store.sellers.get(id)!, clone(patch));
    if (audit) this.store.audit.push(audit);
  }
  async addStaff(id: string, uid: string) {
    const b = this.store.sellers.get(id) as unknown as BusinessDoc;
    if (!b.staffUids.includes(uid)) b.staffUids.push(uid);
  }
  async removeStaff(id: string, uid: string) {
    const b = this.store.sellers.get(id) as unknown as BusinessDoc;
    b.staffUids = b.staffUids.filter((x) => x !== uid);
  }
  async setContract(c: { businessId: string; discountPercent: number }) {
    this.contracts.push(c);
    this.store.contracts.set(c.businessId, { contractId: `c${this.contracts.length}`, discountPercent: c.discountPercent });
  }
  async countAddressEntries(bid: string) {
    return this.addressBooks.get(bid)?.size ?? 0;
  }
  async saveAddressEntry(bid: string, e: AddressBookEntry) {
    if (!this.addressBooks.has(bid)) this.addressBooks.set(bid, new Map());
    this.addressBooks.get(bid)!.set(e.id, clone(e));
  }
  async deleteAddressEntry(bid: string, id: string) {
    this.addressBooks.get(bid)?.delete(id);
  }
  async saveBatch(b: BulkBatch) {
    this.batches.set(b.id, clone(b));
  }
  async getBatch(id: string) {
    const b = this.batches.get(id);
    return b ? { ...clone(b), created: { ...(this.store.batchCreated.get(id) ?? {}) } } : null;
  }
  async listUninvoicedBookings(businessId: string, before: Date, limit: number) {
    return [...this.store.bookings.values()]
      .filter((k) => k.businessId === businessId && k.paymentPreference === 'business_invoice' && !k.invoiceId && k.status !== 'cancelled' && k.createdAt < before)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }
  async listCreditBusinesses() {
    return this.all().filter((b) => b.verificationStatus === 'verified' || b.verificationStatus === 'suspended').map(clone);
  }
  async nextInvoiceNumber(period: string) {
    const n = (this.counters.get(period) ?? 0) + 1;
    this.counters.set(period, n);
    return `INV-${period.replace('-', '')}-${String(n).padStart(4, '0')}`;
  }
  async createInvoice(inv: InvoiceDoc, ids: string[]) {
    const ok = ids.filter((id) => {
      const k = this.store.bookings.get(id);
      return k && !k.invoiceId && k.status !== 'cancelled';
    });
    if (!ok.length) return [];
    const lines = inv.lines.filter((l) => ok.includes(l.trackingNumber));
    this.invoices.set(inv.id, { ...clone(inv), lines, totalPesewas: lines.reduce((n, l) => n + l.amountPesewas, 0) });
    for (const id of ok) this.store.bookings.get(id)!.invoiceId = inv.id;
    return ok;
  }
  async getInvoice(id: string) {
    const i = this.invoices.get(id);
    return i ? clone(i) : null;
  }
  async updateInvoice(id: string, mutate: InvoiceMutation, audit: AuditEntry) {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    const r = mutate(clone(inv));
    if ('error' in r) return r;
    Object.assign(inv, clone(r.invoice));
    if (r.creditReleasePesewas) this.store.sellers.get(inv.businessId)!.creditUsedPesewas -= r.creditReleasePesewas;
    this.store.audit.push(audit);
    return clone(inv);
  }
  async updateInvoiceBookings(ids: string[], patch: { invoiceId?: null; paymentStatus?: 'paid' }) {
    for (const id of ids) Object.assign(this.store.bookings.get(id)!, patch);
  }
  async listOverdueCandidates(now: Date) {
    return [...this.invoices.values()].filter((i) => (i.status === 'issued' || i.status === 'partially_paid') && i.dueAt < now.toISOString()).map(clone);
  }
  async refreshOverdueFlag(businessId: string) {
    const flag = [...this.invoices.values()].some((i) => i.businessId === businessId && i.status === 'overdue');
    this.store.sellers.get(businessId)!.hasOverdueInvoices = flag;
    return flag;
  }
  async listBusinessBookings(businessId: string, from: Date, to: Date) {
    return [...this.store.bookings.values()].filter((k) => k.businessId === businessId && k.createdAt >= from && k.createdAt < to).map(clone);
  }
  async getDeliveries(ids: string[]) {
    return ids.map((id) => this.ops?.deliveries.get(id)).filter((d): d is NonNullable<typeof d> => !!d).map(clone);
  }
}

export class MemoryIdentity implements BusinessIdentityPort {
  claims = new Map<string, Record<string, unknown>>();
  emails = new Set<string>();
  revoked: string[] = [];
  private n = 0;
  async getClaims(uid: string) {
    return { ...(this.claims.get(uid) ?? {}) };
  }
  async setClaims(uid: string, c: Record<string, unknown>) {
    this.claims.set(uid, { ...c });
  }
  async revokeSessions(uid: string) {
    this.revoked.push(uid);
  }
  async createUserWithSetupLink(p: { email: string }) {
    if (this.emails.has(p.email)) return 'exists' as const;
    this.emails.add(p.email);
    return { uid: `staff${++this.n}`, setupLink: `https://auth.example/reset?oobCode=${this.n}` };
  }
}
