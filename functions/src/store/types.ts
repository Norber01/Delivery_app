import type { BookingStatus, PaymentRecordStatus, PaymentStatus, RefundStatus, Role } from '@courier/constants';
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

export interface BookingRecord extends DeliveryRequestDoc {
  createdAt: Date;
  updatedAt: Date;
}

export interface TrackingEventRecord {
  trackingNumber: string;
  deliveryId: string | null;
  type: string;
  /** Safe to show to anyone holding the tracking number. */
  publicMessage: string;
  internalNote?: string;
  actorUid: string | null;
  actorRole: Role | 'guest' | 'system';
  occurredAt: Date;
}

export interface NewNotification {
  channel: 'sms';
  recipientPhone: string;
  template: string;
  trackingNumber: string;
  body: string;
}

export interface NotificationRecord extends NewNotification {
  id: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  providerMessageId: string | null;
  error: string | null;
}

export interface PaymentRecord {
  /** `${provider}_${reference}` — deterministic so a reference can never map to two records. */
  id: string;
  provider: 'paystack';
  reference: string;
  trackingNumber: string;
  customerUid: string | null;
  businessId: string | null;
  amountPesewas: number;
  currency: 'GHS';
  status: PaymentRecordStatus;
  /** Set when money was captured but finance must act (duplicate payment, cancelled booking…). */
  reviewReason: string | null;
  channel: string | null;
  providerTransactionId: string | null;
  verificationSource: 'webhook' | 'status_poll' | 'reconciliation' | null;
  refundedPesewas: number;
  refundPendingPesewas: number;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt: Date | null;
  paidAt: Date | null;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  trackingNumber: string;
  amountPesewas: number;
  status: RefundStatus;
  providerRefundId: string | null;
  reason: string;
  requestedBy: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Changes computed by a pure decision function and applied atomically by the store. */
export interface Mutation {
  payment?: Partial<PaymentRecord>;
  refund?: Partial<RefundRecord>;
  booking?: { status?: BookingStatus; paymentStatus?: PaymentStatus };
  events?: TrackingEventRecord[];
  notifications?: NewNotification[];
  audit?: AuditEntry[];
}

export type MutationOutcome = 'applied' | 'duplicate_event' | 'not_found';

export interface UserProfileInput {
  uid: string;
  role: Role;
  displayName: string | null;
  email: string | null;
  phone: string | null;
}

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
  createBooking(
    booking: DeliveryRequestDoc,
    quoteId: string,
    audit: AuditEntry,
    extras?: { events?: TrackingEventRecord[]; notifications?: NewNotification[] },
  ): Promise<CreateBookingOutcome>;

  getBooking(trackingNumber: string): Promise<BookingRecord | null>;
  listTrackingEvents(trackingNumber: string): Promise<TrackingEventRecord[]>;
  /** Sets `customerUid` only if the booking currently has no owner. */
  claimBooking(trackingNumber: string, uid: string, audit: AuditEntry): Promise<'claimed' | 'already_owned' | 'not_found'>;

  createPayment(p: PaymentRecord): Promise<void>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  listPaymentsForBooking(trackingNumber: string): Promise<PaymentRecord[]>;
  listPaymentsToReconcile(createdBefore: Date, limit: number): Promise<PaymentRecord[]>;
  updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<void>;
  /**
   * In one transaction: skip if `eventKey` was already processed, read the payment and its
   * booking, compute the mutation and write everything (payment, booking, events,
   * notifications, audit, event marker).
   */
  applyPaymentMutation(
    paymentId: string,
    eventKey: string | null,
    decide: (payment: PaymentRecord, booking: BookingRecord) => Mutation,
  ): Promise<MutationOutcome>;

  /**
   * Atomically reserve `amountPesewas` of a payment for refund (fails with 'insufficient' when
   * captured − refunded − pending < amount) and create the refund record.
   */
  reserveRefund(refund: RefundRecord): Promise<'reserved' | 'insufficient' | 'not_found'>;
  getRefund(id: string): Promise<RefundRecord | null>;
  findRefundByProviderId(providerRefundId: string): Promise<RefundRecord | null>;
  listPendingRefunds(limit: number): Promise<RefundRecord[]>;
  applyRefundMutation(
    refundId: string,
    eventKey: string | null,
    decide: (refund: RefundRecord, payment: PaymentRecord, booking: BookingRecord) => Mutation,
  ): Promise<MutationOutcome>;

  upsertUserProfile(p: UserProfileInput): Promise<void>;
  queueNotification(n: NewNotification): Promise<void>;
  updateNotification(id: string, patch: Partial<NotificationRecord>): Promise<void>;

  /** Atomically publish a new pricing version; returns the version number assigned. */
  publishPricingRules(rules: Omit<PricingRuleSet, 'version'>, audit: Omit<AuditEntry, 'targetId'>): Promise<number>;

  writeAudit(entry: AuditEntry): Promise<void>;
}

export interface RateLimiter {
  /** Returns false when the key has exceeded `limit` in the current window. */
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
