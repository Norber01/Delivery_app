import type { BookingStatus, PaymentStatus } from '@courier/constants';
import type { CreateBookingResponse, DeliveryRequestDoc } from '@courier/shared-types';
import { generateTrackingNumber } from '@courier/shared-utils';
import { createBookingRequestSchema, issuesToFieldErrors, type ValidCreateBookingRequest } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { hashObject, randomToken, sha256Hex } from '../lib/hash.js';
import { enforceRateLimit, rateKey, type RequestMeta, type ServiceDeps } from './quoteService.js';

export const BOOKING_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };
const MAX_TRACKING_ATTEMPTS = 5;

export interface BookingDeps extends Omit<ServiceDeps, 'maps' | 'newId'> {
  newTrackingNumber?: () => string;
  newGuestToken?: () => string;
}

/**
 * Initial booking/payment state. Online payments stay `pending_payment` until a
 * verified webhook confirms them (Phase 2); never on the client's word.
 */
export function initialStatus(pref: ValidCreateBookingRequest['paymentPreference']): {
  status: BookingStatus;
  paymentStatus: PaymentStatus;
} {
  switch (pref) {
    case 'cash_on_pickup':
      return { status: 'confirmed', paymentStatus: 'unpaid' };
    case 'business_invoice':
      return { status: 'confirmed', paymentStatus: 'invoiced' };
    case 'mobile_money':
    case 'card':
      return { status: 'pending_payment', paymentStatus: 'unpaid' };
  }
}

export async function createBooking(
  deps: BookingDeps,
  raw: unknown,
  caller: Caller,
  meta: RequestMeta,
): Promise<CreateBookingResponse> {
  const parsed = createBookingRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const req = parsed.data;
  await enforceRateLimit(deps, rateKey('booking', caller, meta), BOOKING_RATE_LIMIT);

  const quote = await deps.store.getQuote(req.quoteId);
  // A quote belongs to whoever requested it; do not reveal others' quotes exist.
  if (!quote || quote.requesterUid !== caller.uid) {
    throw new AppError('QUOTE_NOT_FOUND', 'This quote could not be found. Please get a new quote.', 'not-found');
  }
  if (quote.usedByTrackingNumber) {
    throw new AppError('QUOTE_ALREADY_USED', 'This quote has already been used for a booking.');
  }
  if (quote.expiresAt.getTime() <= deps.now().getTime()) {
    throw new AppError('QUOTE_EXPIRED', 'This quote has expired. Please get a new quote.');
  }
  if (hashObject(req.quote) !== quote.inputHash) {
    throw new AppError('QUOTE_MISMATCH', 'The booking details changed after the quote. Please get a new quote.');
  }

  const isBusiness = caller.role === 'business_owner' || caller.role === 'business_staff';
  const businessId = isBusiness ? caller.businessId : null;
  if (req.paymentPreference === 'business_invoice') {
    const business = businessId ? await deps.store.getBusiness(businessId) : null;
    if (!business || business.verificationStatus !== 'verified' || !business.creditApproved) {
      throw new AppError(
        'PAYMENT_METHOD_NOT_ALLOWED',
        'Invoice billing is only available to verified business accounts with approved credit.',
        'permission-denied',
      );
    }
  }

  const guestToken = caller.uid ? null : (deps.newGuestToken ?? (() => randomToken()))();
  const { status, paymentStatus } = initialStatus(req.paymentPreference);
  const nextTracking = deps.newTrackingNumber ?? (() => generateTrackingNumber());

  for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS; attempt++) {
    const trackingNumber = nextTracking();
    const doc: DeliveryRequestDoc = {
      trackingNumber,
      customerUid: caller.uid,
      businessId,
      sender: req.sender,
      recipient: req.recipient,
      pickup: quote.input.pickup,
      destination: quote.input.destination,
      packages: quote.input.packages,
      deliveryType: quote.result.deliveryType,
      urgency: quote.input.urgency,
      specialHandling: quote.input.specialHandling,
      instructions: req.instructions ?? null,
      paymentPreference: req.paymentPreference,
      price: quote.result,
      quoteId: quote.id,
      pickupAreaId: quote.pickupAreaId,
      destinationAreaId: quote.destinationAreaId,
      status,
      paymentStatus,
      guestAccessHash: guestToken ? sha256Hex(guestToken) : null,
      deliveryId: null,
      source: isBusiness ? 'business_portal' : 'web',
    };
    const outcome = await deps.store.createBooking(doc, quote.id, {
      actorUid: caller.uid,
      actorRole: caller.role ?? 'guest',
      action: 'booking.create',
      targetType: 'deliveryRequest',
      targetId: trackingNumber,
      after: { totalPesewas: quote.result.totalPesewas, pricingVersion: quote.result.pricingVersion, paymentPreference: req.paymentPreference },
      ipHash: meta.ipHash,
    });
    switch (outcome) {
      case 'created':
        return { trackingNumber, guestAccessToken: guestToken, status, paymentStatus, totalPesewas: quote.result.totalPesewas };
      case 'quote_already_used':
        throw new AppError('QUOTE_ALREADY_USED', 'This quote has already been used for a booking.');
      case 'quote_not_found':
        throw new AppError('QUOTE_NOT_FOUND', 'This quote could not be found. Please get a new quote.', 'not-found');
      case 'tracking_number_taken':
        continue;
    }
  }
  throw new AppError('VALIDATION_FAILED', 'Could not allocate a tracking number. Please try again.', 'aborted');
}
