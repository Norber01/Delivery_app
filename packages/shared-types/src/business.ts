import type {
  BusinessVerificationStatus,
  DeliveryStatus,
  DeliveryType,
  InvoicePaymentMethod,
  InvoiceStatus,
  PaymentPreference,
  SpecialHandling,
  Urgency,
} from '@courier/constants';
import type { Address, Contact, IsoDateString, PackageInfo } from './common.js';
import type { PriceQuote } from './pricing.js';

/** `sellers/{businessId}` — a business customer account. */
export interface BusinessDoc {
  id: string;
  legalName: string;
  tradingName: string;
  /** Registrar-General registration number. */
  registrationNumber: string;
  /** GRA taxpayer identification number. */
  tin: string;
  contact: Contact;
  billingAddress: Address;
  /** Default pickup location for bulk bookings. */
  pickupAddress: Address;
  ownerUid: string;
  staffUids: string[];
  /** Display info for staff (owners cannot read other users' profiles). */
  staffDirectory: Record<string, { name: string; email: string }>;
  verificationStatus: BusinessVerificationStatus;
  verificationNote: string | null;
  /** R2 keys of registration documents (certificate, TIN). */
  documentKeys: string[];
  creditTerms: { limitPesewas: number; termDays: number; approvedBy: string; approvedAt: IsoDateString } | null;
  /** Invoiced bookings not yet paid (reserved against the credit limit). */
  creditUsedPesewas: number;
  /** True while any invoice is overdue: invoice billing is blocked. */
  hasOverdueInvoices: boolean;
  contractDiscountPercent: number;
}

export interface AddressBookEntry {
  id: string;
  label: string;
  contact: Contact;
  address: Address;
}

export interface BulkRowResult {
  index: number;
  /** Seller's own order reference from the CSV, if any. */
  reference: string | null;
  ok: boolean;
  errors: string[];
  recipient?: Contact;
  destination?: Address;
  /** "Matched to" text when the address was geocoded. */
  geocodedLabel?: string | null;
  packages?: PackageInfo[];
  urgency?: Urgency;
  specialHandling?: SpecialHandling[];
  instructions?: string | null;
  destinationAreaId?: string | null;
  quote?: PriceQuote;
  trackingNumber?: string | null;
}

export interface BulkPreview {
  batchId: string;
  expiresAt: IsoDateString;
  rows: BulkRowResult[];
  validCount: number;
  invalidCount: number;
  totalPesewas: number;
  bulkDiscountPercent: number;
  paymentPreference: PaymentPreference;
}

export interface BulkConfirmResult {
  batchId: string;
  created: { index: number; trackingNumber: string }[];
  failed: { index: number; message: string }[];
}

export interface InvoiceLine {
  trackingNumber: string;
  date: IsoDateString;
  description: string;
  reference: string | null;
  amountPesewas: number;
}

/** `invoices/{id}` */
export interface InvoiceDoc {
  id: string;
  number: string;
  businessId: string;
  businessName: string;
  tin: string;
  period: string; // YYYY-MM
  part: number;
  lines: InvoiceLine[];
  totalPesewas: number;
  paidPesewas: number;
  status: InvoiceStatus;
  issuedAt: IsoDateString;
  dueAt: IsoDateString;
  payments: { amountPesewas: number; method: InvoicePaymentMethod; reference: string; recordedBy: string; at: IsoDateString }[];
  voidReason: string | null;
}

export interface BusinessReport {
  month: string;
  bookings: number;
  delivered: number;
  inProgress: number;
  cancelled: number;
  failedAttempts: number;
  onTimePercent: number | null;
  spendPesewas: number;
  byType: Record<DeliveryType, number>;
  byDestination: { city: string; count: number }[];
  rows: {
    trackingNumber: string;
    createdAt: IsoDateString;
    reference: string | null;
    recipient: string;
    destinationCity: string;
    deliveryType: DeliveryType;
    status: DeliveryStatus | 'awaiting_payment' | 'cancelled';
    deliveredAt: IsoDateString | null;
    amountPesewas: number;
    paymentPreference: PaymentPreference;
  }[];
}
