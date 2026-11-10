import type {
  BookingStatus,
  PaymentPreference,
  PaymentStatus,
  SpecialHandling,
  Urgency,
} from '@courier/constants';
import type { Address, Contact, IsoDateString, PackageInfo } from './common.js';
import type { PriceQuote } from './pricing.js';

/** Input to the `getQuote` callable. */
export interface QuoteRequest {
  pickup: Address;
  destination: Address;
  packages: PackageInfo[];
  urgency: Urgency;
  specialHandling: SpecialHandling[];
}

export interface QuoteResponse {
  quoteId: string;
  expiresAt: IsoDateString;
  quote: PriceQuote;
  pickupAreaName: string;
  destinationAreaName: string | null;
}

/** Input to the `createBooking` callable. `quote` must equal the request that produced `quoteId`. */
export interface CreateBookingRequest {
  quoteId: string;
  quote: QuoteRequest;
  sender: Contact;
  recipient: Contact;
  instructions?: string;
  paymentPreference: PaymentPreference;
  acceptTerms: true;
}

export interface CreateBookingResponse {
  trackingNumber: string;
  /** Returned once for guest bookings; only its hash is stored. */
  guestAccessToken: string | null;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  totalPesewas: number;
}

/** `deliveryRequests/{trackingNumber}` document. */
export interface DeliveryRequestDoc {
  trackingNumber: string;
  customerUid: string | null;
  businessId: string | null;
  sender: Contact;
  recipient: Contact;
  pickup: Address;
  destination: Address;
  packages: PackageInfo[];
  deliveryType: PriceQuote['deliveryType'];
  urgency: Urgency;
  specialHandling: SpecialHandling[];
  instructions: string | null;
  paymentPreference: PaymentPreference;
  price: PriceQuote;
  quoteId: string;
  pickupAreaId: string;
  destinationAreaId: string | null;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  guestAccessHash: string | null;
  deliveryId: string | null;
  source: 'web' | 'business_portal' | 'ops';
}
