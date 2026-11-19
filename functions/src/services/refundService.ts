import type { RefundResponse } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { issuesToFieldErrors, refundRequestSchema } from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/hash.js';
import { renderSms } from '../notifications/sms.js';
import type { ProviderRefund } from '../payments/provider.js';
import type { BookingRecord, Mutation, PaymentRecord, RefundRecord } from '../store/types.js';
import { paymentId, type PaymentDeps } from './paymentService.js';

/** Pure decision for a provider-confirmed refund status. Idempotent on terminal refunds. */
export function decideRefundUpdate(
  refund: RefundRecord,
  payment: PaymentRecord,
  booking: BookingRecord,
  pr: Pick<ProviderRefund, 'status' | 'providerRefundId'> & { error?: string },
  now: Date,
  site: PaymentDeps['site'],
): Mutation {
  if (refund.status !== 'pending') return {};
  if (pr.status === 'pending') return { refund: { providerRefundId: pr.providerRefundId || refund.providerRefundId, updatedAt: now } };

  const pending = Math.max(0, payment.refundPendingPesewas - refund.amountPesewas);
  const audit = {
    actorUid: null,
    actorRole: 'system' as const,
    action: `refund.${pr.status}`,
    targetType: 'refund',
    targetId: refund.id,
    after: { amountPesewas: refund.amountPesewas, paymentId: payment.id },
  };
  if (pr.status === 'failed') {
    return {
      refund: { status: 'failed', error: pr.error ?? 'Provider reported failure', updatedAt: now },
      payment: { refundPendingPesewas: pending, updatedAt: now },
      audit: [audit],
    };
  }
  const refunded = payment.refundedPesewas + refund.amountPesewas;
  const fully = refunded >= payment.amountPesewas;
  // Only a payment that actually paid this booking changes the booking's payment status.
  const creditedBooking = payment.reviewReason !== 'duplicate_payment';
  return {
    refund: { status: 'processed', providerRefundId: pr.providerRefundId || refund.providerRefundId, updatedAt: now },
    payment: { refundedPesewas: refunded, refundPendingPesewas: pending, updatedAt: now },
    ...(creditedBooking ? { booking: { paymentStatus: fully ? 'refunded' : 'partially_refunded' } } : {}),
    events: [
      {
        trackingNumber: booking.trackingNumber,
        deliveryId: booking.deliveryId,
        type: 'refund_processed',
        publicMessage: fully ? 'Payment refunded' : 'Partial refund processed',
        actorUid: null,
        actorRole: 'system',
        occurredAt: now,
      },
    ],
    notifications: [
      {
        channel: 'sms',
        recipientPhone: booking.sender.phone,
        template: 'refund_processed',
        trackingNumber: booking.trackingNumber,
        body: renderSms('refund_processed', {
          trackingNumber: booking.trackingNumber,
          companyName: site.companyName,
          amount: formatGhs(refund.amountPesewas),
        }),
      },
    ],
    audit: [audit],
  };
}

/** Finance/admin (MFA) refunds a captured payment, capped at the remaining refundable amount. */
export async function requestRefund(deps: PaymentDeps, caller: Caller, raw: unknown): Promise<RefundResponse> {
  requireRole(caller, ['finance', 'admin', 'super_admin']);
  const parsed = refundRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid refund request.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const { paymentReference, amountPesewas, reason } = parsed.data;
  const payment = await deps.store.getPayment(paymentId(deps.provider.name, paymentReference));
  if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found.', 'not-found');
  if (payment.status !== 'succeeded') throw new AppError('REFUND_NOT_ALLOWED', 'Only successful payments can be refunded.');

  const now = deps.now();
  const refund: RefundRecord = {
    id: `rf_${randomId(16)}`,
    paymentId: payment.id,
    trackingNumber: payment.trackingNumber,
    amountPesewas,
    status: 'pending',
    providerRefundId: null,
    reason,
    requestedBy: caller.uid,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  const reserved = await deps.store.reserveRefund(refund);
  if (reserved === 'not_found') throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found.', 'not-found');
  if (reserved === 'insufficient') {
    throw new AppError('REFUND_NOT_ALLOWED', 'The refund exceeds the amount still refundable on this payment.');
  }
  await deps.store.writeAudit({
    actorUid: caller.uid,
    actorRole: caller.role,
    action: 'refund.requested',
    targetType: 'refund',
    targetId: refund.id,
    after: { paymentId: payment.id, amountPesewas, reason },
  });

  try {
    const pr = await deps.provider.refund({ reference: payment.reference, amountPesewas, note: reason });
    await deps.store.applyRefundMutation(refund.id, null, (r, p, b) => decideRefundUpdate(r, p, b, pr, deps.now(), deps.site));
    const latest = await deps.store.getRefund(refund.id);
    return { refundId: refund.id, status: latest?.status ?? 'pending' };
  } catch (e) {
    // The provider did not accept the refund: release the reservation.
    await deps.store.applyRefundMutation(refund.id, null, (r, p, b) =>
      decideRefundUpdate(r, p, b, { status: 'failed', providerRefundId: '', error: (e as Error).message }, deps.now(), deps.site),
    );
    throw new AppError('PAYMENT_PROVIDER_ERROR', 'The payment provider rejected the refund. Nothing was refunded.', 'unavailable');
  }
}

/** Refund webhook or reconciliation: always fetch the refund from the provider before applying. */
export async function syncRefund(deps: PaymentDeps, refund: RefundRecord, eventKey: string | null) {
  if (!refund.providerRefundId) return 'not_found' as const;
  const pr = await deps.provider.getRefund(refund.providerRefundId);
  return deps.store.applyRefundMutation(refund.id, eventKey, (r, p, b) => decideRefundUpdate(r, p, b, pr, deps.now(), deps.site));
}

export async function handleRefundEvent(deps: PaymentDeps, e: { eventKey: string; providerRefundId: string | null }) {
  if (!e.providerRefundId) return;
  const refund = await deps.store.findRefundByProviderId(e.providerRefundId);
  if (!refund) {
    console.error('Refund webhook for unknown refund', e.providerRefundId);
    return;
  }
  await syncRefund(deps, refund, e.eventKey);
}

export async function reconcileRefunds(deps: PaymentDeps, limit = 50) {
  const pending = await deps.store.listPendingRefunds(limit);
  for (const r of pending) {
    try {
      await syncRefund(deps, r, null);
    } catch (e) {
      console.warn('Refund reconciliation failed', r.id, (e as Error).message);
    }
  }
  return { checked: pending.length };
}
