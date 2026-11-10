import type { ContractTerms, DeliveryRequestDoc, PricingRuleSet, ServiceArea } from '@courier/shared-types';
import type { AuditEntry, BusinessAccount, CreateBookingOutcome, RateLimiter, Store, StoredQuote } from '../src/store/types.js';

/** In-memory Store with the same atomicity semantics as FirestoreStore. */
export class MemoryStore implements Store {
  rules: PricingRuleSet | null;
  areas: ServiceArea[];
  contracts = new Map<string, ContractTerms>();
  businesses = new Map<string, BusinessAccount>();
  quotes = new Map<string, StoredQuote>();
  bookings = new Map<string, DeliveryRequestDoc>();
  audit: AuditEntry[] = [];
  pricingVersions: PricingRuleSet[] = [];

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
  async createBooking(b: DeliveryRequestDoc, quoteId: string, audit: AuditEntry): Promise<CreateBookingOutcome> {
    const q = this.quotes.get(quoteId);
    if (!q) return 'quote_not_found';
    if (q.usedByTrackingNumber) return 'quote_already_used';
    if (this.bookings.has(b.trackingNumber)) return 'tracking_number_taken';
    this.bookings.set(b.trackingNumber, structuredClone(b));
    q.usedByTrackingNumber = b.trackingNumber;
    this.audit.push(audit);
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
