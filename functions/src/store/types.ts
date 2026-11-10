import type { Role } from '@courier/constants';
import type {
  ContractTerms,
  DeliveryRequestDoc,
  PriceQuote,
  PricingRuleSet,
  ServiceArea,
} from '@courier/shared-types';
import type { ValidQuoteRequest } from '@courier/validation';

export interface StoredQuote {
  id: string;
  inputHash: string;
  input: ValidQuoteRequest;
  result: PriceQuote;
  pickupAreaId: string;
  pickupAreaName: string;
  destinationAreaId: string | null;
  destinationAreaName: string | null;
  requesterUid: string | null;
  businessId: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedByTrackingNumber: string | null;
}

export interface AuditEntry {
  actorUid: string | null;
  actorRole: Role | 'guest' | 'system';
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
}

export interface BusinessAccount {
  id: string;
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected';
  creditApproved: boolean;
}

export type CreateBookingOutcome = 'created' | 'tracking_number_taken' | 'quote_already_used' | 'quote_not_found';

/**
 * Persistence port. The Firestore implementation is in `firestoreStore.ts`;
 * tests use an in-memory implementation with identical semantics.
 */
export interface Store {
  getActivePricingRules(): Promise<PricingRuleSet | null>;
  getServiceAreas(): Promise<ServiceArea[]>;
  getContractTerms(businessId: string): Promise<ContractTerms | null>;
  getBusiness(businessId: string): Promise<BusinessAccount | null>;

  saveQuote(quote: StoredQuote): Promise<void>;
  getQuote(id: string): Promise<StoredQuote | null>;

  /**
   * Atomically: verify the quote is unused, create `deliveryRequests/{trackingNumber}`
   * (must not exist), mark the quote used and append the audit entry.
   */
  createBooking(booking: DeliveryRequestDoc, quoteId: string, audit: AuditEntry): Promise<CreateBookingOutcome>;

  /** Atomically publish a new pricing version; returns the version number assigned. */
  publishPricingRules(rules: Omit<PricingRuleSet, 'version'>, audit: Omit<AuditEntry, 'targetId'>): Promise<number>;

  writeAudit(entry: AuditEntry): Promise<void>;
}

export interface RateLimiter {
  /** Returns false when the key has exceeded `limit` in the current window. */
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
