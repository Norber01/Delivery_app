import {
  ONLINE_PAYMENT_PREFERENCES,
  PAYMENT_EXPIRE_AFTER_HOURS,
  PAYMENT_RECONCILE_AFTER_MINUTES,
  type PaymentPreference,
} from '@courier/constants';
import type { InitiatePaymentResponse, PaymentStatusResponse, PaymentSummary } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { bookingAccessSchema, issuesToFieldErrors } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/hash.js';
import { PaymentProviderError, type PaymentProvider, type VerifiedTransaction } from '../payments/provider.js';
import { renderSms } from '../notifications/sms.js';
import type { BookingRecord, Mutation, PaymentRecord, RateLimiter, Store } from '../store/types.js';
import { bookingAccess } from './access.js';
import { enforceRateLimit, rateKey, type RequestMeta } from './quoteService.js';

export interface PaymentDeps {
  store: Store;
  rateLimiter: RateLimiter;
  provider: PaymentProvider;
  now: () => Date;
  site: { publicUrl: string; companyName: string; fallbackEmailDomain: string };
}

export const INITIATE_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };
export const STATUS_RATE_LIMIT = { limit: 60, windowSeconds: 600 };
/** Minimum gap between provider verify calls triggered by customer polling. */
const POLL_VERIFY_MIN_SECONDS = 20;

export const paymentId = (provider: string, reference: string) => `${provider}_${reference}`;

export function toSummary(p: PaymentRecord): PaymentSummary {
  return {
    reference: p.reference,
    status: p.status,
    amountPesewas: p.amountPesewas,
    channel: p.channel,
    paidAt: p.paidAt?.toISOString() ?? null,
    refundedPesewas: p.refundedPesewas,
  };
}

export function isOnlinePreference(p: PaymentPreference): boolean {
  return (ONLINE_PAYMENT_PREFERENCES as readonly string[]).includes(p);
}

async function loadAuthorisedBooking(store: Store, raw: unknown, caller: Caller) {
  const parsed = bookingAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid request.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const booking = await store.getBooking(parsed.data.trackingNumber);
  // Same error whether the booking is missing or the caller lacks access: no enumeration.
  if (!booking || !bookingAccess(booking, caller, parsed.data.accessToken)) {
    throw new AppError('BOOKING_NOT_FOUND', 'We could not find a booking with those details.', 'not-found');
  }
  return booking;
}

/** Start an online payment for the booking's confirmed total. The amount never comes from the client. */
export async function initiatePayment(
  deps: PaymentDeps,
  raw: unknown,
  caller: Caller,
  meta: RequestMeta,
): Promise<InitiatePaymentResponse> {
  await enforceRateLimit(deps, rateKey('pay-init', caller, meta), INITIATE_RATE_LIMIT);
  const booking = await loadAuthorisedBooking(deps.store, raw, caller);

  if (booking.status === 'cancelled') throw new AppError('PAYMENT_NOT_REQUIRED', 'This booking was cancelled.');
  if (booking.paymentStatus !== 'unpaid' && booking.paymentStatus !== 'pending') {
    throw new AppError('ALREADY_PAID', 'This booking has already been paid.');
  }
  if (!isOnlinePreference(booking.paymentPreference)) {
    throw new AppError('PAYMENT_NOT_REQUIRED', 'This booking is paid at pickup or by invoice.');
  }

  const reference = `${booking.trackingNumber}-${randomId(8)}`;
  const now = deps.now();
  const record: PaymentRecord = {
    id: paymentId(deps.provider.name, reference),
    provider: deps.provider.name,
    reference,
    trackingNumber: booking.trackingNumber,
    customerUid: booking.customerUid,
    businessId: booking.businessId,
    amountPesewas: booking.price.totalPesewas,
    currency: 'GHS',
    status: 'initiated',
    reviewReason: null,
    channel: null,
    providerTransactionId: null,
    verificationSource: null,
    refundedPesewas: 0,
    refundPendingPesewas: 0,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: null,
    paidAt: null,
  };
  // Record first, so a webhook for this reference always finds its payment.
  await deps.store.createPayment(record);

  try {
    const email = booking.sender.email ?? `booking+${booking.trackingNumber.toLowerCase()}@${deps.site.fallbackEmailDomain}`;
    const { authorizationUrl } = await deps.provider.initialize({
      reference,
      amountPesewas: record.amountPesewas,
      email,
      callbackUrl: `${deps.site.publicUrl}/payment/return?tn=${booking.trackingNumber}`,
      metadata: { trackingNumber: booking.trackingNumber },
    });
    await deps.store.updatePayment(record.id, { status: 'pending', updatedAt: deps.now() });
    return { reference, authorizationUrl };
  } catch (e) {
    await deps.store.updatePayment(record.id, { status: 'failed', updatedAt: deps.now() });
    if (e instanceof PaymentProviderError) {
      console.error('Payment initialisation failed', e.message);
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Online payment is temporarily unavailable. Please try again shortly.', 'unavailable');
    }
    throw e;
  }
}

/**
 * Pure decision: what a verified provider result means for the payment and booking.
 * Runs inside the store's transaction with freshly read records.
 */
export function decidePaymentUpdate(
  payment: PaymentRecord,
  booking: BookingRecord,
  v: VerifiedTransaction,
  source: NonNullable<PaymentRecord['verificationSource']>,
  now: Date,
  site: PaymentDeps['site'],
): Mutation {
  // Terminal outcomes are never re-opened.
  if (payment.status === 'succeeded' || payment.status === 'flagged') return { payment: { lastVerifiedAt: now } };

  const base: Partial<PaymentRecord> = {
    lastVerifiedAt: now,
    updatedAt: now,
    verificationSource: source,
    channel: v.channel ?? payment.channel,
    providerTransactionId: v.providerTransactionId ?? payment.providerTransactionId,
  };
  const audit = (action: string, after: unknown) => ({
    actorUid: null,
    actorRole: 'system' as const,
    action,
    targetType: 'payment',
    targetId: payment.id,
    after,
  });

  if (v.reference !== payment.reference) {
    return { payment: { ...base, status: 'flagged', reviewReason: 'reference_mismatch' }, audit: [audit('payment.flagged', { reason: 'reference_mismatch' })] };
  }
  if (v.status === 'pending') {
    const expired = now.getTime() - payment.createdAt.getTime() > PAYMENT_EXPIRE_AFTER_HOURS * 3600_000;
    return { payment: { ...base, status: expired ? 'expired' : 'pending' } };
  }
  if (v.status === 'failed') return { payment: { ...base, status: 'failed' } };

  // Success: verify the money matches exactly what this booking costs.
  if (v.currency !== 'GHS' || v.amountPesewas !== payment.amountPesewas || payment.amountPesewas !== booking.price.totalPesewas) {
    return {
      payment: { ...base, status: 'flagged', reviewReason: 'amount_mismatch' },
      audit: [audit('payment.flagged', { reason: 'amount_mismatch', reported: v.amountPesewas, currency: v.currency, expected: payment.amountPesewas })],
    };
  }

  const paid: Partial<PaymentRecord> = { ...base, status: 'succeeded', paidAt: v.paidAt ?? now };
  if (booking.paymentStatus !== 'unpaid' && booking.paymentStatus !== 'pending') {
    return { payment: { ...paid, reviewReason: 'duplicate_payment' }, audit: [audit('payment.duplicate', { bookingPaymentStatus: booking.paymentStatus })] };
  }
  if (booking.status === 'cancelled') {
    return {
      payment: { ...paid, reviewReason: 'booking_cancelled' },
      booking: { paymentStatus: 'paid' },
      audit: [audit('payment.received_for_cancelled_booking', {})],
    };
  }

  const amount = formatGhs(payment.amountPesewas);
  const events: Mutation['events'] = [
    {
      trackingNumber: booking.trackingNumber,
      deliveryId: booking.deliveryId,
      type: 'payment_received',
      publicMessage: 'Payment received',
      actorUid: null,
      actorRole: 'system',
      occurredAt: now,
    },
  ];
  if (booking.status === 'pending_payment') {
    events.push({ ...events[0]!, type: 'booking_confirmed', publicMessage: 'Booking confirmed — awaiting driver assignment' });
  }
  return {
    payment: paid,
    booking: { paymentStatus: 'paid', status: booking.status === 'pending_payment' ? 'confirmed' : booking.status },
    events,
    notifications: [
      {
        channel: 'sms',
        recipientPhone: booking.sender.phone,
        template: 'payment_received',
        trackingNumber: booking.trackingNumber,
        body: renderSms('payment_received', {
          trackingNumber: booking.trackingNumber,
          companyName: site.companyName,
          amount,
          trackUrl: `${site.publicUrl}/track/${booking.trackingNumber}`,
        }),
      },
    ],
    audit: [audit('payment.succeeded', { amountPesewas: payment.amountPesewas, source })],
  };
}

/** Verify with the provider and apply the result atomically. */
export async function verifyAndApply(
  deps: PaymentDeps,
  payment: PaymentRecord,
  source: NonNullable<PaymentRecord['verificationSource']>,
  eventKey: string | null,
) {
  const verified = await deps.provider.verify(payment.reference);
  return deps.store.applyPaymentMutation(payment.id, eventKey, (p, b) =>
    decidePaymentUpdate(p, b, verified, source, deps.now(), deps.site),
  );
}

/**
 * Customer polling after returning from checkout. Shows only database state; if a payment is
 * still pending it asks the provider directly (rate limited) in case the webhook is delayed.
 */
export async function getPaymentStatus(
  deps: PaymentDeps,
  raw: unknown,
  caller: Caller,
  meta: RequestMeta,
): Promise<PaymentStatusResponse> {
  await enforceRateLimit(deps, rateKey('pay-status', caller, meta), STATUS_RATE_LIMIT);
  let booking = await loadAuthorisedBooking(deps.store, raw, caller);
  let payments = await deps.store.listPaymentsForBooking(booking.trackingNumber);

  const now = deps.now().getTime();
  const stale = payments.filter(
    (p) =>
      (p.status === 'pending' || p.status === 'initiated') &&
      (!p.lastVerifiedAt || now - p.lastVerifiedAt.getTime() > POLL_VERIFY_MIN_SECONDS * 1000),
  );
  if (stale.length) {
    for (const p of stale.slice(0, 3)) {
      try {
        await verifyAndApply(deps, p, 'status_poll', null);
      } catch (e) {
        console.warn('Poll verification failed', p.reference, (e as Error).message);
      }
    }
    booking = (await deps.store.getBooking(booking.trackingNumber)) ?? booking;
    payments = await deps.store.listPaymentsForBooking(booking.trackingNumber);
  }

  return {
    trackingNumber: booking.trackingNumber,
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus,
    totalPesewas: booking.price.totalPesewas,
    payments: payments.map(toSummary),
  };
}

export type WebhookResult = { status: number; body: string };

/** Signed webhook from the provider. Signature first, then always re-verify with the API. */
export async function handlePaymentWebhook(
  deps: PaymentDeps,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  onRefundEvent: (e: { eventKey: string; providerRefundId: string | null }) => Promise<void>,
): Promise<WebhookResult> {
  const event = deps.provider.parseWebhook(rawBody, headers);
  if (!event) {
    console.warn('Rejected webhook with invalid signature');
    return { status: 401, body: 'invalid signature' };
  }
  if (event.kind === 'ignored') return { status: 200, body: 'ignored' };
  if (event.kind === 'refund') {
    await onRefundEvent(event);
    return { status: 200, body: 'ok' };
  }

  const payment = await deps.store.getPayment(paymentId(deps.provider.name, event.reference));
  if (!payment) {
    // Not ours (or created outside this system): acknowledge so the provider stops retrying, but log for finance.
    console.error('Webhook for unknown payment reference', event.reference);
    return { status: 200, body: 'unknown reference' };
  }
  const outcome = await verifyAndApply(deps, payment, 'webhook', event.eventKey);
  return { status: 200, body: outcome };
}

/** Scheduled: re-verify payments still pending after the reconcile window. */
export async function reconcilePayments(deps: PaymentDeps, limit = 50): Promise<{ checked: number; errors: number }> {
  const before = new Date(deps.now().getTime() - PAYMENT_RECONCILE_AFTER_MINUTES * 60_000);
  const due = await deps.store.listPaymentsToReconcile(before, limit);
  let errors = 0;
  for (const p of due) {
    try {
      await verifyAndApply(deps, p, 'reconciliation', null);
    } catch (e) {
      errors++;
      const age = deps.now().getTime() - p.createdAt.getTime();
      // The provider has no record of it (e.g. checkout never opened): expire once old enough.
      if (e instanceof PaymentProviderError && (e.status === 404 || e.status === 400) && age > PAYMENT_EXPIRE_AFTER_HOURS * 3600_000) {
        await deps.store.updatePayment(p.id, { status: 'expired', updatedAt: deps.now() });
      } else {
        console.warn('Reconciliation failed', p.reference, (e as Error).message);
      }
    }
  }
  return { checked: due.length, errors };
}
