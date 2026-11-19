import type { ErrorCode } from '@courier/constants';

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  RATE_LIMITED: 'You have made too many requests. Please wait a few minutes and try again.',
  PICKUP_NOT_SERVICED: 'We do not collect from this pickup location yet. We are expanding — please check back soon.',
  DESTINATION_NOT_SERVICED: 'We do not deliver to this destination yet.',
  NO_SUITABLE_VEHICLE: 'This shipment is too large or heavy to book online. Please call us for a custom quote.',
  SAME_DAY_NOT_AVAILABLE: 'Same-day delivery is only available within the same city.',
  DISTANCE_UNAVAILABLE: 'We could not calculate the distance right now. Please try again shortly.',
  DISTANCE_LIMIT_EXCEEDED: 'This distance is beyond our long-distance service. Please call us.',
  PRICING_NOT_CONFIGURED: 'Online booking is temporarily unavailable. Please call us.',
  QUOTE_EXPIRED: 'Your quote has expired. Please get a new price.',
  QUOTE_ALREADY_USED: 'This quote was already used for a booking.',
  QUOTE_MISMATCH: 'Your shipment details changed. Please get a new price.',
  QUOTE_NOT_FOUND: 'Your quote could not be found. Please get a new price.',
  PAYMENT_METHOD_NOT_ALLOWED: 'Invoice billing is only available to approved business accounts.',
  BOOKING_NOT_FOUND: 'We could not find a booking with those details.',
  ALREADY_PAID: 'This booking has already been paid.',
  PAYMENT_NOT_REQUIRED: 'This booking does not need online payment.',
  PAYMENT_PROVIDER_ERROR: 'Online payment is temporarily unavailable. Please try again shortly.',
  BOOKING_ALREADY_CLAIMED: 'This booking already belongs to another account.',
  CREDIT_LIMIT_EXCEEDED: 'Your business credit limit has been reached. Pay an invoice or choose another payment method.',
  INVOICES_OVERDUE: 'An invoice is overdue. Settle it to keep booking on account.',
  ALREADY_REGISTERED: 'You already have a business account.',
  ACCOUNT_EXISTS: 'That email already has an account. Use a work email that is not yet registered.',
  BATCH_EXPIRED: 'This preview has expired. Check the file again to get current prices.',
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode | 'UNKNOWN',
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Convert a Firebase callable error into a user-friendly ApiError. */
export function toApiError(e: unknown): ApiError {
  const err = e as { message?: string; details?: { code?: ErrorCode; fields?: Record<string, string> } };
  const code = err.details?.code;
  // The SDK may append the HTTP status ("… [400]"); customers should see only the message.
  if (code) return new ApiError(MESSAGES[code] ?? (err.message ?? 'Request failed.').replace(/\s*\[\d{3}\]$/, ''), code, err.details?.fields ?? {});
  return new ApiError('We could not reach our servers. Check your connection and try again.', 'UNKNOWN');
}

export const QUOTE_INVALIDATING_CODES: readonly string[] = ['QUOTE_EXPIRED', 'QUOTE_ALREADY_USED', 'QUOTE_MISMATCH', 'QUOTE_NOT_FOUND'];
