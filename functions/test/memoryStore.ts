import type { ContractTerms, DeliveryRequestDoc, PricingRuleSet, ServiceArea } from '@courier/shared-types';
import type {
  AuditEntry,
  BookingRecord,
  BusinessAccount,
  CreateBookingOutcome,
  Mutation,
  MutationOutcome,
  NewNotification,
  NotificationRecord,
  PaymentRecord,
  RateLimiter,
  RefundRecord,
  Store,
  StoredQuote,
  TrackingEventRecord,
  UserProfileInput,
} from '../src/store/types.js';

/** In-memory Store with the same atomicity semantics as FirestoreStore (single-threaded JS). */
export class MemoryStore implements Store {
  rules: PricingRuleSet | null;
  areas: ServiceArea[];
  contracts = new Map<string, ContractTerms>();
  businesses = new Map<string, BusinessAccount>();
  quotes = new Map<string, StoredQuote>();
  bookings = new Map<string, BookingRecord>();
  events: TrackingEventRecord[] = [];
  notifications: NotificationRecord[] = [];
  payments = new Map<string, PaymentRecord>();
  refunds = new Map<string, RefundRecord>();
  processedEvents = new Set<string>();
  users = new Map<string, UserProfileInput>();
  audit: AuditEntry[] = [];
  pricingVersions: PricingRuleSet[] = [];
  now = () => new Date('2026-11-10T10:00:00Z');

  constructor(rules: PricingRuleSet | null, areas: ServiceArea[]) {
    this.rules = rules;
    this.areas = areas;
  }

  async getActivePricingRules() {
    return this.rules;
  }
  async getServiceAreas() {
    return this.areas.filter((a) => a.active);
  }
  async getContractTerms(id: string) {
    return this.contracts.get(id) ?? null;
  }
  async getBusiness(id: string) {
    return this.businesses.get(id) ?? null;
  }
  async saveQuote(q: StoredQuote) {
    if (this.quotes.has(q.id)) throw new Error('exists');
    this.quotes.set(q.id, structuredClone(q));
  }
  async getQuote(id: string) {
    const q = this.quotes.get(id);
    return q ? structuredClone(q) : null;
  }
  async createBooking(
    b: DeliveryRequestDoc,
    quoteId: string,
    audit: AuditEntry,
    extras: { events?: TrackingEventRecord[]; notifications?: NewNotification[] } = {},
  ): Promise<CreateBookingOutcome> {
    const q = this.quotes.get(quoteId);
    if (!q) return 'quote_not_found';
    if (q.usedByTrackingNumber) return 'quote_already_used';
    if (this.bookings.has(b.trackingNumber)) return 'tracking_number_taken';
    this.bookings.set(b.trackingNumber, structuredClone({ ...b, createdAt: this.now(), updatedAt: this.now() }));
    q.usedByTrackingNumber = b.trackingNumber;
    this.audit.push(audit);
    this.events.push(...(extras.events ?? []));
    for (const n of extras.notifications ?? []) await this.queueNotification(n);
    return 'created';
  }
  async publishPricingRules(rules: Omit<PricingRuleSet, 'version'>, audit: Omit<AuditEntry, 'targetId'>) {
    const version = (this.rules?.version ?? 0) + 1;
    this.rules = { ...rules, version } as PricingRuleSet;
    this.pricingVersions.push(this.rules);
    this.audit.push({ ...audit, targetId: String(version) });
    return version;
  }
  async writeAudit(e: AuditEntry) {
    this.audit.push(e);
  }

  async getBooking(tn: string) {
    const b = this.bookings.get(tn);
    return b ? structuredClone(b) : null;
  }
  async listTrackingEvents(tn: string) {
    return this.events.filter((e) => e.trackingNumber === tn).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
  async claimBooking(tn: string, uid: string, audit: AuditEntry) {
    const b = this.bookings.get(tn);
    if (!b) return 'not_found' as const;
    if (b.customerUid === uid) return 'claimed' as const;
    if (b.customerUid) return 'already_owned' as const;
    b.customerUid = uid;
    for (const p of this.payments.values()) if (p.trackingNumber === tn) p.customerUid = uid;
    this.audit.push(audit);
    return 'claimed' as const;
  }

  async createPayment(p: PaymentRecord) {
    if (this.payments.has(p.id)) throw new Error('exists');
    this.payments.set(p.id, structuredClone(p));
  }
  async getPayment(id: string) {
    const p = this.payments.get(id);
    return p ? structuredClone(p) : null;
  }
  async listPaymentsForBooking(tn: string) {
    return [...this.payments.values()]
      .filter((p) => p.trackingNumber === tn)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => structuredClone(p));
  }
  async listPaymentsToReconcile(before: Date, limit: number) {
    return [...this.payments.values()]
      .filter((p) => (p.status === 'initiated' || p.status === 'pending') && p.createdAt < before)
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }
  async updatePayment(id: string, patch: Partial<PaymentRecord>) {
    const p = this.payments.get(id);
    if (!p) throw new Error('missing');
    Object.assign(p, patch);
  }

  private write(m: Mutation, payment?: PaymentRecord, refund?: RefundRecord, booking?: BookingRecord) {
    if (m.payment && payment) Object.assign(payment, m.payment);
    if (m.refund && refund) Object.assign(refund, m.refund);
    if (m.booking && booking) Object.assign(booking, m.booking);
    this.events.push(...(m.events ?? []));
    for (const n of m.notifications ?? []) void this.queueNotification(n);
    this.audit.push(...(m.audit ?? []));
  }

  async applyPaymentMutation(id: string, eventKey: string | null, decide: (p: PaymentRecord, b: BookingRecord) => Mutation): Promise<MutationOutcome> {
    if (eventKey && this.processedEvents.has(eventKey)) return 'duplicate_event';
    const p = this.payments.get(id);
    const b = p && this.bookings.get(p.trackingNumber);
    if (!p || !b) return 'not_found';
    this.write(decide(structuredClone(p), structuredClone(b)), p, undefined, b);
    if (eventKey) this.processedEvents.add(eventKey);
    return 'applied';
  }

  async reserveRefund(r: RefundRecord) {
    const p = this.payments.get(r.paymentId);
    if (!p) return 'not_found' as const;
    if (p.status !== 'succeeded' || r.amountPesewas > p.amountPesewas - p.refundedPesewas - p.refundPendingPesewas) return 'insufficient' as const;
    p.refundPendingPesewas += r.amountPesewas;
    this.refunds.set(r.id, structuredClone(r));
    return 'reserved' as const;
  }
  async getRefund(id: string) {
    const r = this.refunds.get(id);
    return r ? structuredClone(r) : null;
  }
  async findRefundByProviderId(pid: string) {
    const r = [...this.refunds.values()].find((x) => x.providerRefundId === pid);
    return r ? structuredClone(r) : null;
  }
  async listPendingRefunds(limit: number) {
    return [...this.refunds.values()].filter((r) => r.status === 'pending').slice(0, limit).map((r) => structuredClone(r));
  }
  async applyRefundMutation(
    id: string,
    eventKey: string | null,
    decide: (r: RefundRecord, p: PaymentRecord, b: BookingRecord) => Mutation,
  ): Promise<MutationOutcome> {
    if (eventKey && this.processedEvents.has(eventKey)) return 'duplicate_event';
    const r = this.refunds.get(id);
    const p = r && this.payments.get(r.paymentId);
    const b = r && this.bookings.get(r.trackingNumber);
    if (!r || !p || !b) return 'not_found';
    this.write(decide(structuredClone(r), structuredClone(p), structuredClone(b)), p, r, b);
    if (eventKey) this.processedEvents.add(eventKey);
    return 'applied';
  }

  async upsertUserProfile(p: UserProfileInput) {
    this.users.set(p.uid, p);
  }
  smsPrefs = new Map<string, { smsBookingUpdates: boolean; smsPaymentReceipts: boolean }>();
  async getSmsPreferences(tn: string) {
    const uid = this.bookings.get(tn)?.customerUid;
    return uid ? (this.smsPrefs.get(uid) ?? null) : null;
  }
  async queueNotification(n: NewNotification) {
    this.notifications.push({ ...n, id: `n${this.notifications.length + 1}`, status: 'queued', attempts: 0, providerMessageId: null, error: null });
  }
  async updateNotification(id: string, patch: Partial<NotificationRecord>) {
    const n = this.notifications.find((x) => x.id === id);
    if (n) Object.assign(n, patch);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  counts = new Map<string, number>();
  async consume(key: string, limit: number) {
    const c = this.counts.get(key) ?? 0;
    if (c >= limit) return false;
    this.counts.set(key, c + 1);
    return true;
  }
}
