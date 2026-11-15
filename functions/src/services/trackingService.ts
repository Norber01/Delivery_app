import { TRACKING_DEFAULTS } from '@courier/constants';
import type { LiveLocationView, TrackingView } from '@courier/shared-types';
import { locationFreshness, PUBLIC_STATUS_LABELS, type MapProvider } from '@courier/shared-utils';
import { bookingAccessSchema, issuesToFieldErrors } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { DeliveryRecord, LivePort, OpsStore } from '../ops/types.js';
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

export interface TrackingDeps {
  store: Store;
  rateLimiter: RateLimiter;
  ops?: OpsStore;
  live?: LivePort;
  maps?: MapProvider | null;
  now?: () => Date;
}

/** City-level precision (~1 km) for the public map. */
const coarse = (p: { lat: number; lng: number }) => ({ lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 });

/**
 * Driver position for a delivery, or null. Shown only while that driver holds the package on
 * an active leg with a live shift (docs/05 §5.4): never for hubs, linehaul or another vehicle.
 */
async function liveLocation(deps: TrackingDeps, d: DeliveryRecord, fullAccess: boolean, now: Date): Promise<LiveLocationView | null> {
  if (!deps.live || !deps.ops || !d.currentDriverUid) return null;
  const allowed =
    (d.status === 'out_for_delivery' && d.custodian.type === 'driver' && d.custodian.id === d.currentDriverUid) ||
    (fullAccess && d.status === 'en_route_to_pickup');
  if (!allowed) return null;
  const [driver, loc] = await Promise.all([deps.ops.getDriver(d.currentDriverUid), deps.live.getDriverLocation(d.currentDriverUid)]);
  const shift = driver?.currentShift;
  if (!loc || !shift || loc.shiftId !== shift.id || new Date(shift.activeUntil) <= now) return null;

  const freshness = locationFreshness(loc.serverAt, now.getTime());
  let etaMinutes: number | null = null;
  // ETA only when it can be reliable: live position, delivery leg, Directions available.
  if (freshness === 'live' && d.status === 'out_for_delivery') {
    const cached = d.eta && now.getTime() - new Date(d.eta.computedAt).getTime() < TRACKING_DEFAULTS.etaRefreshSeconds * 1000;
    if (cached) etaMinutes = d.eta!.minutes;
    else if (deps.maps) {
      try {
        const r = await deps.maps.route(loc, d.destination.location);
        etaMinutes = Math.max(1, Math.round(r.durationMinutes));
        await deps.ops.setEta(d.id, { minutes: etaMinutes, computedAt: now.toISOString() });
      } catch {
        etaMinutes = null;
      }
    }
  }
  return { lat: loc.lat, lng: loc.lng, updatedAt: new Date(loc.serverAt).toISOString(), freshness, etaMinutes };
}

/**
 * Tracking number alone → public view (status, timeline, cities). With the owner's session,
 * business membership, MFA staff session or the guest access token → full view.
 */
export async function getTrackingView(deps: TrackingDeps, raw: unknown, caller: Caller, meta: RequestMeta): Promise<TrackingView> {
  const parsed = bookingAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Check the tracking number.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  await enforceRateLimit(deps, rateKey('track', caller, meta), TRACKING_RATE_LIMIT);
  const now = deps.now?.() ?? new Date();

  const booking = await deps.store.getBooking(parsed.data.trackingNumber);
  if (!booking) throw new AppError('BOOKING_NOT_FOUND', 'We could not find a booking with that tracking number.', 'not-found');
  const access = bookingAccess(booking, caller, parsed.data.accessToken);
  const delivery = deps.ops && booking.deliveryId ? await deps.ops.getDelivery(booking.deliveryId) : null;

  const events = await deps.store.listTrackingEvents(booking.trackingNumber);
  const timeline = events.map((e) => ({ at: e.occurredAt.toISOString(), label: e.publicMessage, type: e.type }));
  if (!events.some((e) => e.type === 'booking_created')) {
    timeline.unshift({ at: booking.createdAt.toISOString(), label: 'Booking received', type: 'booking_created' });
  }

  const deliveryStatus = delivery?.status ?? null;
  const view: TrackingView = {
    trackingNumber: booking.trackingNumber,
    access: access ? 'full' : 'public',
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus,
    deliveryStatus,
    statusLabel:
      booking.status === 'cancelled' ? BOOKING_STATUS_LABEL.cancelled : deliveryStatus ? PUBLIC_STATUS_LABELS[deliveryStatus] : BOOKING_STATUS_LABEL[booking.status],
    deliveryType: booking.deliveryType,
    urgency: booking.urgency,
    origin: { city: booking.pickup.city, region: booking.pickup.region },
    destination: { city: booking.destination.city, region: booking.destination.region },
    bookedAt: booking.createdAt.toISOString(),
    timeline,
    liveLocation: delivery ? await liveLocation(deps, delivery, Boolean(access), now) : null,
    delayed: Boolean(delivery?.delayed),
    expectedDeliveryAt: delivery?.expectedDeliveryAt ?? null,
    mapPoints: access
      ? { pickup: booking.pickup.location, destination: booking.destination.location }
      : { pickup: null, destination: coarse(booking.destination.location) },
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
