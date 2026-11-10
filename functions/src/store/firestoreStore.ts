import { COLLECTIONS } from '@courier/constants';
import type { ContractTerms, DeliveryRequestDoc, PricingRuleSet, ServiceArea } from '@courier/shared-types';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { AuditEntry, BusinessAccount, CreateBookingOutcome, RateLimiter, Store, StoredQuote } from './types.js';

const CACHE_MS = 5 * 60_000;

/** Tiny per-instance TTL cache for rarely-changing configuration (cost control). */
class Cached<T> {
  private value: T | undefined;
  private at = 0;
  constructor(private readonly load: () => Promise<T>) {}
  async get(): Promise<T> {
    if (this.value === undefined || Date.now() - this.at > CACHE_MS) {
      this.value = await this.load();
      this.at = Date.now();
    }
    return this.value;
  }
}

const toDate = (v: unknown): Date => (v instanceof Timestamp ? v.toDate() : (v as Date));

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
    });
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

  async createBooking(booking: DeliveryRequestDoc, quoteId: string, audit: AuditEntry): Promise<CreateBookingOutcome> {
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
    return version;
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    await this.db.collection(COLLECTIONS.auditLogs).add({ ...entry, at: FieldValue.serverTimestamp() });
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
