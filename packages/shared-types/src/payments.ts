import type { BookingStatus, PaymentRecordStatus, PaymentStatus, RefundStatus } from '@courier/constants';
import type { IsoDateString } from './common.js';

/** Identifies a booking plus proof of access: the owner's session or a guest access token. */
export interface BookingAccessRequest {
  trackingNumber: string;
  /** Guest access token returned at booking time (never needed when signed in as the owner). */
  accessToken?: string;
}

export interface InitiatePaymentResponse {
  reference: string;
  /** Hosted checkout page (Mobile Money or card) to redirect the customer to. */
  authorizationUrl: string;
}

export interface PaymentSummary {
  reference: string;
  status: PaymentRecordStatus;
  amountPesewas: number;
  channel: string | null;
  paidAt: IsoDateString | null;
  refundedPesewas: number;
}

export interface PaymentStatusResponse {
  trackingNumber: string;
  bookingStatus: BookingStatus;
  paymentStatus: PaymentStatus;
  totalPesewas: number;
  payments: PaymentSummary[];
}

export interface RefundRequest {
  paymentReference: string;
  amountPesewas: number;
  reason: string;
}

export interface RefundResponse {
  refundId: string;
  status: RefundStatus;
}
