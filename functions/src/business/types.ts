import type { AddressBookEntry, BulkRowResult, BusinessDoc, InvoiceDoc } from '@courier/shared-types';
import type { PaymentPreference } from '@courier/constants';
import type { Address } from '@courier/shared-types';
import type { AuditEntry, BookingRecord } from '../store/types.js';
import type { DeliveryRecord } from '../ops/types.js';

export interface BulkBatch {
  id: string;
  businessId: string;
  createdBy: string;
  pickup: Address;
  pickupAreaId: string;
  paymentPreference: PaymentPreference;
  rows: BulkRowResult[];
  bulkDiscountPercent: number;
  /** Row index → tracking number, written in the same transaction as each booking. */
  created: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
}

export type InvoiceMutation = (inv: InvoiceDoc) => { invoice: Partial<InvoiceDoc>; creditReleasePesewas?: number } | { error: string };

export interface BusinessStore {
  getBusiness(id: string): Promise<BusinessDoc | null>;
  findBusinessByOwner(uid: string): Promise<BusinessDoc | null>;
  /** Creates the business unless the owner already has one. */
  createBusiness(b: BusinessDoc): Promise<'created' | 'owner_has_business'>;
  updateBusiness(id: string, patch: Partial<BusinessDoc>, audit?: AuditEntry): Promise<void>;
  addStaff(id: string, uid: string): Promise<void>;
  removeStaff(id: string, uid: string): Promise<void>;
  setContract(c: { businessId: string; discountPercent: number; validFrom: Date; validTo: Date; approvedBy: string }): Promise<void>;

  countAddressEntries(businessId: string): Promise<number>;
  saveAddressEntry(businessId: string, e: AddressBookEntry): Promise<void>;
  deleteAddressEntry(businessId: string, id: string): Promise<void>;

  saveBatch(b: BulkBatch): Promise<void>;
  getBatch(id: string): Promise<BulkBatch | null>;

  /** Invoice-billed, not yet invoiced, not cancelled bookings created before `before`. */
  listUninvoicedBookings(businessId: string, before: Date, limit: number): Promise<BookingRecord[]>;
  listCreditBusinesses(): Promise<BusinessDoc[]>;
  nextInvoiceNumber(period: string): Promise<string>;
  /** Creates the invoice and stamps `invoiceId` on bookings still uninvoiced; returns the bookings actually included. */
  createInvoice(inv: InvoiceDoc, bookingIds: string[]): Promise<string[]>;
  getInvoice(id: string): Promise<InvoiceDoc | null>;
  /** Transactional invoice update; credit release is applied to the business in the same transaction. */
  updateInvoice(id: string, mutate: InvoiceMutation, audit: AuditEntry): Promise<InvoiceDoc | { error: string } | null>;
  /** Clear `invoiceId` (void) or set paymentStatus 'paid' on an invoice's bookings. */
  updateInvoiceBookings(ids: string[], patch: { invoiceId?: null; paymentStatus?: 'paid' }): Promise<void>;
  listOverdueCandidates(now: Date): Promise<InvoiceDoc[]>;
  /** Recompute `hasOverdueInvoices` from the business's invoices. */
  refreshOverdueFlag(businessId: string): Promise<boolean>;

  listBusinessBookings(businessId: string, from: Date, to: Date): Promise<BookingRecord[]>;
  getDeliveries(ids: string[]): Promise<DeliveryRecord[]>;
}

/** Firebase Auth operations for business accounts. */
export interface BusinessIdentityPort {
  getClaims(uid: string): Promise<Record<string, unknown>>;
  setClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  revokeSessions(uid: string): Promise<void>;
  /** New sign-in without a password; returns a set-password link. Fails with 'exists' if the email is taken. */
  createUserWithSetupLink(p: { email: string; name: string }): Promise<{ uid: string; setupLink: string } | 'exists'>;
}
