import type { BookingStatus, DeliveryType, PaymentPreference, PaymentRecordStatus, PaymentStatus } from '@courier/constants';

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Not paid',
  pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  invoiced: 'On account',
};

export const PAYMENT_RECORD_LABEL: Record<PaymentRecordStatus, string> = {
  initiated: 'Started',
  pending: 'Pending',
  succeeded: 'Successful',
  failed: 'Failed',
  flagged: 'Under review',
  expired: 'Expired',
};

export const PAYMENT_PREFERENCE_LABEL: Record<PaymentPreference, string> = {
  cash_on_pickup: 'Pay the driver at pickup',
  mobile_money: 'Mobile Money (online)',
  card: 'Card (online)',
  business_invoice: 'Business invoice',
};

export const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = {
  intra_city: 'Same-city delivery',
  intercity: 'Intercity delivery (via our hubs)',
  long_distance: 'Long-distance delivery',
};
