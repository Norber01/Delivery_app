import type { BookingStatus, DeliveryStatus, DeliveryType, GhanaRegion, PaymentPreference, PaymentStatus, Urgency } from '@courier/constants';
import type { Address, Contact, IsoDateString, PackageInfo } from './common.js';
import type { LiveLocationView } from './operations.js';
import type { PaymentSummary } from './payments.js';
import type { PriceQuote } from './pricing.js';

export interface TimelineEntry {
  at: IsoDateString;
  label: string;
  type: string;
}

/**
 * Customer-facing tracking view. `public` access (tracking number only) never contains
 * names, phone numbers, street addresses or prices.
 */
export interface TrackingView {
  trackingNumber: string;
  access: 'public' | 'full';
  bookingStatus: BookingStatus;
  paymentStatus: PaymentStatus;
  deliveryStatus: DeliveryStatus | null;
  statusLabel: string;
  deliveryType: DeliveryType;
  urgency: Urgency;
  origin: { city: string; region: GhanaRegion };
  destination: { city: string; region: GhanaRegion };
  bookedAt: IsoDateString;
  timeline: TimelineEntry[];
  /**
   * Driver position, only while that driver holds the package on an active leg
   * (out for delivery; also en route to pickup for full access). Never for hubs/linehaul.
   */
  liveLocation: LiveLocationView | null;
  delayed: boolean;
  expectedDeliveryAt: IsoDateString | null;
  /** Destination point for the map (city-level precision in public view). */
  mapPoints: { pickup: { lat: number; lng: number } | null; destination: { lat: number; lng: number } };
  details?: {
    sender: Contact;
    recipient: Contact;
    pickup: Address;
    destination: Address;
    packages: PackageInfo[];
    instructions: string | null;
    price: PriceQuote;
    paymentPreference: PaymentPreference;
    canPayOnline: boolean;
    payments: PaymentSummary[];
    ownedByCaller: boolean;
  };
}

export interface TrackingRequest {
  trackingNumber: string;
  accessToken?: string;
}

export interface BookingListItem {
  trackingNumber: string;
  createdAt: IsoDateString;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  deliveryType: DeliveryType;
  originCity: string;
  destinationCity: string;
  recipientName: string;
  totalPesewas: number;
}
