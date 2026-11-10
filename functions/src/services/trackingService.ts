import type { TrackingView } from '@courier/shared-types';
import { PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { bookingAccessSchema, issuesToFieldErrors } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { BookingRecord, RateLimiter, Store } from '../store/types.js';
import { bookingAccess } from './access.js';
import { isOnlinePreference, toSummary } from './paymentService.js';
import { enforceRateLimit, rateKey, type RequestMeta } from './quoteService.js';

export const TRACKING_RATE_LIMIT = { limit: 30, windowSeconds: 600 };

const BOOKING_STATUS_LABEL: Record<BookingRecord['status'], string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Booking confirmed — awaiting driver assignment',
  cancelled: 'Cancelled',
};

/**
 * Tracking number alone → public view (status, timeline, cities). With the owner's session,
 * business membership, MFA staff session or the guest access token → full view.
 */
export async function getTrackingView(
  deps: { store: Store; rateLimiter: RateLimiter },
  raw: unknown,
  caller: Caller,
  meta: RequestMeta,
): Promise<TrackingView> {
  const parsed = bookingAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Check the tracking number.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  await enforceRateLimit(deps, rateKey('track', caller, meta), TRACKING_RATE_LIMIT);

  const booking = await deps.store.getBooking(parsed.data.trackingNumber);
  if (!booking) throw new AppError('BOOKING_NOT_FOUND', 'We could not find a booking with that tracking number.', 'not-found');
  const access = bookingAccess(booking, caller, parsed.data.accessToken);

  const events = await deps.store.listTrackingEvents(booking.trackingNumber);
  const timeline = events.map((e) => ({ at: e.occurredAt.toISOString(), label: e.publicMessage, type: e.type }));
  if (!events.some((e) => e.type === 'booking_created')) {
    timeline.unshift({ at: booking.createdAt.toISOString(), label: 'Booking received', type: 'booking_created' });
  }

  // Delivery operations (and their statuses) begin in Phase 3; until then the booking status drives the label.
  const deliveryStatus = null;
  const view: TrackingView = {
    trackingNumber: booking.trackingNumber,
    access: access ? 'full' : 'public',
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus,
    deliveryStatus,
    statusLabel: deliveryStatus ? PUBLIC_STATUS_LABELS[deliveryStatus] : BOOKING_STATUS_LABEL[booking.status],
    deliveryType: booking.deliveryType,
    urgency: booking.urgency,
    origin: { city: booking.pickup.city, region: booking.pickup.region },
    destination: { city: booking.destination.city, region: booking.destination.region },
    bookedAt: booking.createdAt.toISOString(),
    timeline,
    liveLocation: null,
  };
  if (!access) return view;

  const payments = await deps.store.listPaymentsForBooking(booking.trackingNumber);
  view.details = {
    sender: booking.sender,
    recipient: booking.recipient,
    pickup: booking.pickup,
    destination: booking.destination,
    packages: booking.packages,
    instructions: booking.instructions,
    price: booking.price,
    paymentPreference: booking.paymentPreference,
    canPayOnline:
      booking.status !== 'cancelled' &&
      (booking.paymentStatus === 'unpaid' || booking.paymentStatus === 'pending') &&
      isOnlinePreference(booking.paymentPreference),
    payments: payments.map(toSummary),
    ownedByCaller: access === 'owner',
  };
  return view;
}
