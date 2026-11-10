import { COLLECTIONS } from '@courier/constants';
import type { ContractTerms, DeliveryRequestDoc, PricingRuleSet, ServiceArea } from '@courier/shared-types';
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
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
} from './types.js';

const CACHE_MS = 5 * 60_000;

/**
 * Tiny per-instance TTL cache for rarely-changing configuration (cost control).
 * Empty results (no pricing published yet, no active areas) are not cached, so a newly
 * configured project works immediately instead of after the TTL.
 */
class Cached<T> {
  private value: T | undefined;
  private at = 0;
  constructor(
    private readonly load: () => Promise<T>,
    private readonly isEmpty: (v: T) => boolean = (v) => v === null,
  ) {}
  async get(): Promise<T> {
    if (this.value === undefined || Date.now() - this.at > CACHE_MS) {
      const v = await this.load();
      this.value = this.isEmpty(v) ? undefined : v;
      this.at = Date.now();
      return v;
    }
    return this.value;
  }
  invalidate() {
    this.value = undefined;
  }
}

const toDate = (v: unknown): Date => (v instanceof Timestamp ? v.toDate() : (v as Date));

/** Deep-convert Firestore Timestamps to Dates (top-level and nested plain objects). */
function fromDoc<T>(data: FirebaseFirestore.DocumentData): T {
  const conv = (v: unknown): unknown => {
    if (v instanceof Timestamp) return v.toDate();
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
    }
    return v;
  };
  return conv(data) as T;
}

function notificationDoc(n: NewNotification) {
  return { ...n, status: 'queued', attempts: 0, providerMessageId: null, error: null, createdAt: FieldValue.serverTimestamp() };
}

export class FirestoreStore implements Store {
  private readonly rules: Cached<PricingRuleSet | null>;
  private readonly areas: Cached<ServiceArea[]>;

  constructor(private readonly db: Firestore) {
    this.rules = new Cached(async () => {
      const cfg = await db.collection(COLLECTIONS.config).doc('pricing').get();
      const v = cfg.get('activeVersion') as number | undefined;
      if (!v) return null;
      const snap = await db.collection(COLLECTIONS.pricingRules).doc(String(v)).get();
      return snap.exists ? (snap.get('rules') as PricingRuleSet) : null;
    });
    this.areas = new Cached(async () => {
      const snap = await db.collection(COLLECTIONS.serviceAreas).where('active', '==', true).get();
      return snap.docs.map((d) => ({ ...(d.data() as Omit<ServiceArea, 'id'>), id: d.id }));
    }, (v) => v.length === 0);
  }

  getActivePricingRules() {
    return this.rules.get();
  }

  getServiceAreas() {
    return this.areas.get();
  }

  async getContractTerms(businessId: string): Promise<ContractTerms | null> {
    const now = Timestamp.now();
    const snap = await this.db
      .collection(COLLECTIONS.contractPricing)
      .where('businessId', '==', businessId)
      .where('validTo', '>', now)
      .orderBy('validTo', 'desc')
      .limit(5)
      .get();
    const doc = snap.docs.find((d) => (d.get('validFrom') as Timestamp).toMillis() <= now.toMillis());
    if (!doc) return null;
    return {
      contractId: doc.id,
      discountPercent: (doc.get('discountPercent') as number | undefined) ?? 0,
      routeBaseOverrides: doc.get('routeBaseOverrides') as Record<string, number> | undefined,
    };
  }

  async getBusiness(businessId: string): Promise<BusinessAccount | null> {
    const snap = await this.db.collection(COLLECTIONS.sellers).doc(businessId).get();
    if (!snap.exists) return null;
    return {
      id: snap.id,
      verificationStatus: snap.get('verificationStatus'),
      creditApproved: Boolean(snap.get('creditTerms.approvedAt')),
    };
  }

  async saveQuote(q: StoredQuote): Promise<void> {
    await this.db
      .collection(COLLECTIONS.quotes)
      .doc(q.id)
      .create({ ...q, createdAt: Timestamp.fromDate(q.createdAt), expiresAt: Timestamp.fromDate(q.expiresAt) });
  }

  async getQuote(id: string): Promise<StoredQuote | null> {
    const snap = await this.db.collection(COLLECTIONS.quotes).doc(id).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return { ...(d as StoredQuote), createdAt: toDate(d.createdAt), expiresAt: toDate(d.expiresAt) };
  }

  async createBooking(
    booking: DeliveryRequestDoc,
    quoteId: string,
    audit: AuditEntry,
    extras: { events?: TrackingEventRecord[]; notifications?: NewNotification[] } = {},
  ): Promise<CreateBookingOutcome> {
    const quoteRef = this.db.collection(COLLECTIONS.quotes).doc(quoteId);
    const bookingRef = this.db.collection(COLLECTIONS.deliveryRequests).doc(booking.trackingNumber);
    const auditRef = this.db.collection(COLLECTIONS.auditLogs).doc();
    return this.db.runTransaction(async (tx) => {
      const [quote, existing] = await Promise.all([tx.get(quoteRef), tx.get(bookingRef)]);
      if (!quote.exists) return 'quote_not_found';
      if (quote.get('usedByTrackingNumber')) return 'quote_already_used';
      if (existing.exists) return 'tracking_number_taken';
      tx.create(bookingRef, {
        ...booking,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: booking.customerUid ?? 'guest',
      });
      tx.update(quoteRef, { usedByTrackingNumber: booking.trackingNumber });
      tx.create(auditRef, { ...audit, at: FieldValue.serverTimestamp() });
      for (const e of extras.events ?? []) tx.create(this.db.collection(COLLECTIONS.trackingEvents).doc(), e);
      for (const n of extras.notifications ?? []) tx.create(this.db.collection(COLLECTIONS.notifications).doc(), notificationDoc(n));
      return 'created';
    });
  }

  async publishPricingRules(rules: Omit<PricingRuleSet, 'version'>, audit: Omit<AuditEntry, 'targetId'>): Promise<number> {
    const cfgRef = this.db.collection(COLLECTIONS.config).doc('pricing');
    const version = await this.db.runTransaction(async (tx) => {
      const cfg = await tx.get(cfgRef);
      const prev = (cfg.get('activeVersion') as number | undefined) ?? 0;
      const next = prev + 1;
      const nextRef = this.db.collection(COLLECTIONS.pricingRules).doc(String(next));
      tx.create(nextRef, {
        version: next,
        status: 'active',
        rules: { ...rules, version: next },
        effectiveFrom: FieldValue.serverTimestamp(),
        publishedBy: audit.actorUid,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (prev > 0) {
        tx.update(this.db.collection(COLLECTIONS.pricingRules).doc(String(prev)), {
          status: 'superseded',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.set(cfgRef, { activeVersion: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(this.db.collection(COLLECTIONS.auditLogs).doc(), {
        ...audit,
        targetId: String(next),
        at: FieldValue.serverTimestamp(),
      });
      return next;
    });
    this.rules.invalidate();
    return version;
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    await this.db.collection(COLLECTIONS.auditLogs).add({ ...entry, at: FieldValue.serverTimestamp() });
  }

  // ---- Bookings & tracking ----------------------------------------------

  private bookingRef(trackingNumber: string) {
    return this.db.collection(COLLECTIONS.deliveryRequests).doc(trackingNumber);
  }

  async getBooking(trackingNumber: string): Promise<BookingRecord | null> {
    const snap = await this.bookingRef(trackingNumber).get();
    return snap.exists ? fromDoc<BookingRecord>(snap.data()!) : null;
  }

  async listTrackingEvents(trackingNumber: string): Promise<TrackingEventRecord[]> {
    const snap = await this.db
      .collection(COLLECTIONS.trackingEvents)
      .where('trackingNumber', '==', trackingNumber)
      .orderBy('occurredAt', 'asc')
      .limit(100)
      .get();
    return snap.docs.map((d) => fromDoc<TrackingEventRecord>(d.data()));
  }

  async claimBooking(trackingNumber: string, uid: string, audit: AuditEntry) {
    const ref = this.bookingRef(trackingNumber);
    return this.db.runTransaction(async (tx) => {
      // All reads first (Firestore transactions forbid reads after writes).
      const [snap, payments] = await Promise.all([
        tx.get(ref),
        tx.get(this.db.collection(COLLECTIONS.payments).where('trackingNumber', '==', trackingNumber)),
      ]);
      if (!snap.exists) return 'not_found' as const;
      const owner = snap.get('customerUid') as string | null;
      if (owner === uid) return 'claimed' as const;
      if (owner) return 'already_owned' as const;
      tx.update(ref, { customerUid: uid, updatedAt: FieldValue.serverTimestamp() });
      // Keep payment records' owner in sync so the customer can read them (rules use customerUid).
      payments.docs.forEach((d) => tx.update(d.ref, { customerUid: uid }));
      tx.create(this.db.collection(COLLECTIONS.auditLogs).doc(), { ...audit, at: FieldValue.serverTimestamp() });
      return 'claimed' as const;
    });
  }

  // ---- Payments -----------------------------------------------------------

  private paymentRef(id: string) {
    return this.db.collection(COLLECTIONS.payments).doc(id);
  }

  async createPayment(p: PaymentRecord): Promise<void> {
    await this.paymentRef(p.id).create(p);
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const snap = await this.paymentRef(id).get();
    return snap.exists ? fromDoc<PaymentRecord>(snap.data()!) : null;
  }

  async listPaymentsForBooking(trackingNumber: string): Promise<PaymentRecord[]> {
    const snap = await this.db
      .collection(COLLECTIONS.payments)
      .where('trackingNumber', '==', trackingNumber)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    return snap.docs.map((d) => fromDoc<PaymentRecord>(d.data()));
  }

  async listPaymentsToReconcile(createdBefore: Date, limit: number): Promise<PaymentRecord[]> {
    const snap = await this.db
      .collection(COLLECTIONS.payments)
      .where('status', 'in', ['initiated', 'pending'])
      .where('createdAt', '<', Timestamp.fromDate(createdBefore))
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => fromDoc<PaymentRecord>(d.data()));
  }

  async updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<void> {
    await this.paymentRef(id).update(patch);
  }

  /** Writes a computed mutation inside an open transaction (after all reads). */
  private writeMutation(
    tx: Transaction,
    m: Mutation,
    refs: { payment?: DocumentReference; refund?: DocumentReference; booking: DocumentReference },
  ) {
    if (m.payment && refs.payment && Object.keys(m.payment).length) tx.update(refs.payment, m.payment);
    if (m.refund && refs.refund && Object.keys(m.refund).length) tx.update(refs.refund, m.refund);
    if (m.booking && Object.keys(m.booking).length) tx.update(refs.booking, { ...m.booking, updatedAt: FieldValue.serverTimestamp() });
    for (const e of m.events ?? []) tx.create(this.db.collection(COLLECTIONS.trackingEvents).doc(), e);
    for (const n of m.notifications ?? []) tx.create(this.db.collection(COLLECTIONS.notifications).doc(), notificationDoc(n));
    for (const a of m.audit ?? []) tx.create(this.db.collection(COLLECTIONS.auditLogs).doc(), { ...a, at: FieldValue.serverTimestamp() });
  }

  async applyPaymentMutation(
    paymentId: string,
    eventKey: string | null,
    decide: (payment: PaymentRecord, booking: BookingRecord) => Mutation,
  ): Promise<MutationOutcome> {
    const paymentRef = this.paymentRef(paymentId);
    const eventRef = eventKey ? this.db.collection(COLLECTIONS.paymentEvents).doc(eventKey) : null;
    return this.db.runTransaction(async (tx) => {
      if (eventRef && (await tx.get(eventRef)).exists) return 'duplicate_event';
      const pSnap = await tx.get(paymentRef);
      if (!pSnap.exists) return 'not_found';
      const payment = fromDoc<PaymentRecord>(pSnap.data()!);
      const bookingRef = this.bookingRef(payment.trackingNumber);
      const bSnap = await tx.get(bookingRef);
      if (!bSnap.exists) return 'not_found';
      const m = decide(payment, fromDoc<BookingRecord>(bSnap.data()!));
      this.writeMutation(tx, m, { payment: paymentRef, booking: bookingRef });
      if (eventRef) tx.create(eventRef, { paymentId, processedAt: FieldValue.serverTimestamp() });
      return 'applied';
    });
  }

  // ---- Refunds ------------------------------------------------------------

  private refundRef(id: string) {
    return this.db.collection(COLLECTIONS.refunds).doc(id);
  }

  async reserveRefund(refund: RefundRecord) {
    const paymentRef = this.paymentRef(refund.paymentId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(paymentRef);
      if (!snap.exists) return 'not_found' as const;
      const p = fromDoc<PaymentRecord>(snap.data()!);
      const available = p.amountPesewas - p.refundedPesewas - p.refundPendingPesewas;
      if (p.status !== 'succeeded' || refund.amountPesewas > available) return 'insufficient' as const;
      tx.update(paymentRef, { refundPendingPesewas: p.refundPendingPesewas + refund.amountPesewas, updatedAt: refund.createdAt });
      tx.create(this.refundRef(refund.id), refund);
      return 'reserved' as const;
    });
  }

  async getRefund(id: string): Promise<RefundRecord | null> {
    const snap = await this.refundRef(id).get();
    return snap.exists ? fromDoc<RefundRecord>(snap.data()!) : null;
  }

  async findRefundByProviderId(providerRefundId: string): Promise<RefundRecord | null> {
    const snap = await this.db.collection(COLLECTIONS.refunds).where('providerRefundId', '==', providerRefundId).limit(1).get();
    return snap.empty ? null : fromDoc<RefundRecord>(snap.docs[0]!.data());
  }

  async listPendingRefunds(limit: number): Promise<RefundRecord[]> {
    const snap = await this.db.collection(COLLECTIONS.refunds).where('status', '==', 'pending').limit(limit).get();
    return snap.docs.map((d) => fromDoc<RefundRecord>(d.data()));
  }

  async applyRefundMutation(
    refundId: string,
    eventKey: string | null,
    decide: (refund: RefundRecord, payment: PaymentRecord, booking: BookingRecord) => Mutation,
  ): Promise<MutationOutcome> {
    const refundRef = this.refundRef(refundId);
    const eventRef = eventKey ? this.db.collection(COLLECTIONS.paymentEvents).doc(eventKey) : null;
    return this.db.runTransaction(async (tx) => {
      if (eventRef && (await tx.get(eventRef)).exists) return 'duplicate_event';
      const rSnap = await tx.get(refundRef);
      if (!rSnap.exists) return 'not_found';
      const refund = fromDoc<RefundRecord>(rSnap.data()!);
      const paymentRef = this.paymentRef(refund.paymentId);
      const bookingRef = this.bookingRef(refund.trackingNumber);
      const [pSnap, bSnap] = await Promise.all([tx.get(paymentRef), tx.get(bookingRef)]);
      if (!pSnap.exists || !bSnap.exists) return 'not_found';
      const m = decide(refund, fromDoc<PaymentRecord>(pSnap.data()!), fromDoc<BookingRecord>(bSnap.data()!));
      this.writeMutation(tx, m, { payment: paymentRef, refund: refundRef, booking: bookingRef });
      if (eventRef) tx.create(eventRef, { refundId, processedAt: FieldValue.serverTimestamp() });
      return 'applied';
    });
  }

  // ---- Accounts & notifications --------------------------------------------

  async upsertUserProfile(p: UserProfileInput): Promise<void> {
    const batch = this.db.batch();
    batch.set(
      this.db.collection(COLLECTIONS.users).doc(p.uid),
      { ...p, status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    batch.set(
      this.db.collection(COLLECTIONS.customers).doc(p.uid),
      { notificationPrefs: { smsBookingUpdates: true, smsPaymentReceipts: true } },
      { merge: true },
    );
    await batch.commit();
  }

  async getSmsPreferences(trackingNumber: string) {
    const booking = await this.bookingRef(trackingNumber).get();
    const uid = booking.get('customerUid') as string | null | undefined;
    if (!uid) return null;
    const prefs = (await this.db.collection(COLLECTIONS.customers).doc(uid).get()).get('notificationPrefs') as
      | { smsBookingUpdates?: boolean; smsPaymentReceipts?: boolean }
      | undefined;
    if (!prefs) return null;
    return { smsBookingUpdates: prefs.smsBookingUpdates !== false, smsPaymentReceipts: prefs.smsPaymentReceipts !== false };
  }

  async queueNotification(n: NewNotification): Promise<void> {
    await this.db.collection(COLLECTIONS.notifications).add(notificationDoc(n));
  }

  async updateNotification(id: string, patch: Partial<NotificationRecord>): Promise<void> {
    await this.db
      .collection(COLLECTIONS.notifications)
      .doc(id)
      .update({ ...patch, updatedAt: FieldValue.serverTimestamp(), ...(patch.status === 'sent' ? { sentAt: FieldValue.serverTimestamp() } : {}) });
  }
}

/** Fixed-window counter in Firestore. Documents carry `expiresAt` for a TTL policy. */
export class FirestoreRateLimiter implements RateLimiter {
  constructor(private readonly db: Firestore) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
    const ref = this.db.collection(COLLECTIONS.rateLimits).doc(`${key.replace(/\//g, '_')}:${windowStart}`);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.get('count') as number | undefined) ?? 0;
      if (count >= limit) return false;
      tx.set(ref, {
        count: count + 1,
        expiresAt: Timestamp.fromMillis((windowStart + windowSeconds * 2) * 1000),
      });
      return true;
    });
  }
}
