import { beforeEach, describe, expect, it } from 'vitest';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { AppError } from '../src/lib/errors.js';
import { deliverNotification } from '../src/services/notificationService.js';
import {
  getPaymentStatus,
  handlePaymentWebhook,
  initiatePayment,
  paymentId,
  reconcilePayments,
} from '../src/services/paymentService.js';
import { reconcileRefunds, requestRefund } from '../src/services/refundService.js';
import { chargeWebhook, meta, world, type World } from './helpers.js';

let w: World;
const noRefund = async () => {};
const finance: Caller = { uid: 'fin', role: 'finance', businessId: null, mfa: true };
const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);

beforeEach(() => {
  w = world();
});

async function paidBooking() {
  const b = await w.book();
  const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
  w.provider.complete(reference);
  const hook = chargeWebhook(reference);
  await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund);
  return { ...b, reference };
}

describe('initiatePayment', () => {
  it('charges the stored booking total, never a client amount', async () => {
    const b = await w.book();
    const res = await initiatePayment(
      w.pay,
      { trackingNumber: b.trackingNumber, accessToken: b.token, amountPesewas: 1 } as never,
      GUEST,
      meta,
    );
    expect(res.authorizationUrl).toContain(res.reference);
    expect(w.provider.lastInit?.amountPesewas).toBe(b.total);
    expect(w.provider.lastInit?.callbackUrl).toBe(`https://www.example.com.gh/payment/return?tn=${b.trackingNumber}`);
    expect(w.store.payments.get(paymentId('paystack', res.reference))).toMatchObject({ status: 'pending', amountPesewas: b.total });
  });

  it('requires the access code (or ownership) and does not reveal whether a booking exists', async () => {
    const b = await w.book();
    await expectCode(initiatePayment(w.pay, { trackingNumber: b.trackingNumber }, GUEST, meta), 'BOOKING_NOT_FOUND');
    await expectCode(initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: 'A'.repeat(32) }, GUEST, meta), 'BOOKING_NOT_FOUND');
    const stranger: Caller = { uid: 'x', role: 'customer', businessId: null, mfa: false };
    await expectCode(initiatePayment(w.pay, { trackingNumber: b.trackingNumber }, stranger, meta), 'BOOKING_NOT_FOUND');
  });

  it('lets a signed-in owner pay without a token', async () => {
    const alice: Caller = { uid: 'alice', role: 'customer', businessId: null, mfa: false };
    const b = await w.book(alice);
    await expect(initiatePayment(w.pay, { trackingNumber: b.trackingNumber }, alice, meta)).resolves.toBeTruthy();
  });

  it('refuses cash bookings and already-paid bookings', async () => {
    const cash = await w.book(GUEST, 'cash_on_pickup');
    await expectCode(initiatePayment(w.pay, { trackingNumber: cash.trackingNumber, accessToken: cash.token }, GUEST, meta), 'PAYMENT_NOT_REQUIRED');
    const paid = await paidBooking();
    await expectCode(initiatePayment(w.pay, { trackingNumber: paid.trackingNumber, accessToken: paid.token }, GUEST, meta), 'ALREADY_PAID');
  });

  it('marks the attempt failed when the provider is down', async () => {
    const b = await w.book();
    w.provider.initFail = true;
    await expectCode(initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta), 'PAYMENT_PROVIDER_ERROR');
    expect([...w.store.payments.values()][0]!.status).toBe('failed');
  });
});

describe('payment webhook', () => {
  it('confirms the booking only after server-side verification, exactly once', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    const hook = chargeWebhook(reference);

    // Signed webhook, but the provider says the charge has not succeeded: nothing is credited.
    expect((await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund)).status).toBe(200);
    expect(w.store.bookings.get(b.trackingNumber)!.paymentStatus).toBe('unpaid');

    w.provider.complete(reference);
    const hook2 = chargeWebhook(reference, 556);
    expect((await handlePaymentWebhook(w.pay, hook2.raw, hook2.headers, noRefund)).body).toBe('applied');
    const booking = w.store.bookings.get(b.trackingNumber)!;
    expect(booking).toMatchObject({ paymentStatus: 'paid', status: 'confirmed' });
    expect(w.store.payments.get(paymentId('paystack', reference))).toMatchObject({ status: 'succeeded', verificationSource: 'webhook', channel: 'mobile_money' });

    // Replay of the same event is ignored.
    expect((await handlePaymentWebhook(w.pay, hook2.raw, hook2.headers, noRefund)).body).toBe('duplicate_event');
    expect(w.store.events.filter((e) => e.type === 'payment_received')).toHaveLength(1);
    expect(w.store.notifications.filter((n) => n.template === 'payment_received')).toHaveLength(1);
    expect(w.store.audit.some((a) => a.action === 'payment.succeeded')).toBe(true);
  });

  it('rejects unsigned or forged webhooks without touching data', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    w.provider.complete(reference);
    const hook = chargeWebhook(reference);
    const res = await handlePaymentWebhook(w.pay, hook.raw, { 'x-paystack-signature': 'f'.repeat(128) }, noRefund);
    expect(res.status).toBe(401);
    expect(w.provider.verifyCalls).toBe(0);
    expect(w.store.bookings.get(b.trackingNumber)!.paymentStatus).toBe('unpaid');
  });

  it('flags an amount mismatch instead of confirming', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    w.provider.complete(reference, { amountPesewas: 100 });
    const hook = chargeWebhook(reference);
    await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund);
    expect(w.store.payments.get(paymentId('paystack', reference))).toMatchObject({ status: 'flagged', reviewReason: 'amount_mismatch' });
    expect(w.store.bookings.get(b.trackingNumber)!.paymentStatus).toBe('unpaid');
  });

  it('flags a currency mismatch', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    w.provider.complete(reference, { currency: 'NGN' });
    const hook = chargeWebhook(reference);
    await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund);
    expect(w.store.payments.get(paymentId('paystack', reference))!.status).toBe('flagged');
  });

  it('marks a second successful payment for review without double-crediting', async () => {
    const b = await w.book();
    const a1 = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    const a2 = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    for (const [i, a] of [a1, a2].entries()) {
      w.provider.complete(a.reference);
      const hook = chargeWebhook(a.reference, 900 + i);
      await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund);
    }
    expect(w.store.payments.get(paymentId('paystack', a2.reference))).toMatchObject({ status: 'succeeded', reviewReason: 'duplicate_payment' });
    expect(w.store.audit.some((a) => a.action === 'payment.duplicate')).toBe(true);
  });

  it('acknowledges webhooks for unknown references', async () => {
    const hook = chargeWebhook('GHUNKNOWN-xyz');
    expect(await handlePaymentWebhook(w.pay, hook.raw, hook.headers, noRefund)).toEqual({ status: 200, body: 'unknown reference' });
  });
});

describe('status polling & reconciliation', () => {
  it('re-verifies a pending payment when the customer polls (missed webhook)', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    w.provider.complete(reference);
    const s = await getPaymentStatus(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    expect(s).toMatchObject({ paymentStatus: 'paid', bookingStatus: 'confirmed' });
    expect(s.payments[0]).toMatchObject({ status: 'succeeded', amountPesewas: b.total });
  });

  it('limits provider verification while polling', async () => {
    const b = await w.book();
    await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    for (let i = 0; i < 5; i++) await getPaymentStatus(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    expect(w.provider.verifyCalls).toBe(1);
    w.clock.now = new Date(w.clock.now.getTime() + 21_000);
    await getPaymentStatus(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    expect(w.provider.verifyCalls).toBe(2);
  });

  it('reconciles only payments past the window and expires abandoned ones after 24 h', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    expect((await reconcilePayments(w.pay)).checked).toBe(0);
    w.clock.now = new Date(w.clock.now.getTime() + 16 * 60_000);
    expect((await reconcilePayments(w.pay)).checked).toBe(1);
    expect(w.store.payments.get(paymentId('paystack', reference))!.status).toBe('pending');
    w.clock.now = new Date(w.clock.now.getTime() + 25 * 3600_000);
    await reconcilePayments(w.pay);
    expect(w.store.payments.get(paymentId('paystack', reference))!.status).toBe('expired');
  });
});

describe('refunds', () => {
  it('reserves, executes and settles a partial then full refund', async () => {
    const p = await paidBooking();
    const r1 = await requestRefund(w.pay, finance, { paymentReference: p.reference, amountPesewas: 1000, reason: 'Late delivery goodwill' });
    expect(r1.status).toBe('pending');
    const pay = () => w.store.payments.get(paymentId('paystack', p.reference))!;
    expect(pay().refundPendingPesewas).toBe(1000);

    // Provider settles the refund; reconciliation picks it up.
    for (const r of w.provider.refunds.values()) r.status = 'processed';
    await reconcileRefunds(w.pay);
    expect(pay()).toMatchObject({ refundedPesewas: 1000, refundPendingPesewas: 0 });
    expect(w.store.bookings.get(p.trackingNumber)!.paymentStatus).toBe('partially_refunded');

    await requestRefund(w.pay, finance, { paymentReference: p.reference, amountPesewas: p.total - 1000, reason: 'Booking cancelled' });
    for (const r of w.provider.refunds.values()) r.status = 'processed';
    await reconcileRefunds(w.pay);
    expect(w.store.bookings.get(p.trackingNumber)!.paymentStatus).toBe('refunded');
    expect(w.store.notifications.filter((n) => n.template === 'refund_processed')).toHaveLength(2);
  });

  it('never refunds more than was captured, including pending refunds', async () => {
    const p = await paidBooking();
    await requestRefund(w.pay, finance, { paymentReference: p.reference, amountPesewas: p.total - 100, reason: 'Partial cancel' });
    await expectCode(requestRefund(w.pay, finance, { paymentReference: p.reference, amountPesewas: 101, reason: 'Second refund' }), 'REFUND_NOT_ALLOWED');
  });

  it('releases the reservation when the provider rejects the refund', async () => {
    const p = await paidBooking();
    w.provider.refundFail = true;
    await expectCode(requestRefund(w.pay, finance, { paymentReference: p.reference, amountPesewas: 500, reason: 'Goodwill credit' }), 'PAYMENT_PROVIDER_ERROR');
    const pay = w.store.payments.get(paymentId('paystack', p.reference))!;
    expect(pay.refundPendingPesewas).toBe(0);
    expect([...w.store.refunds.values()][0]!.status).toBe('failed');
  });

  it('is restricted to finance/admin with MFA', async () => {
    const p = await paidBooking();
    const body = { paymentReference: p.reference, amountPesewas: 100, reason: 'Goodwill credit' };
    await expectCode(requestRefund(w.pay, { ...finance, role: 'dispatcher' }, body), 'PERMISSION_DENIED');
    await expectCode(requestRefund(w.pay, { ...finance, mfa: false }, body), 'MFA_REQUIRED');
    await expectCode(requestRefund(w.pay, GUEST, body), 'PERMISSION_DENIED');
  });

  it('refuses refunds on unpaid attempts', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    await expectCode(requestRefund(w.pay, finance, { paymentReference: reference, amountPesewas: 100, reason: 'Not paid yet' }), 'REFUND_NOT_ALLOWED');
  });
});

describe('notifications', () => {
  it('queues a booking SMS and marks it skipped when no provider is configured', async () => {
    await w.book();
    const n = w.store.notifications[0]!;
    expect(n).toMatchObject({ template: 'booking_pending_payment', recipientPhone: '+233241234567' });
    expect(n.body).toContain('/track/');
    expect(await deliverNotification({ store: w.store, sms: null }, n)).toBe('skipped');
  });

  it('sends, and retries failures up to the limit', async () => {
    await w.book();
    const n = { ...w.store.notifications[0]! };
    const ok = { name: 'x', send: async () => ({ providerMessageId: 'm1' }) };
    expect(await deliverNotification({ store: w.store, sms: ok }, n)).toBe('sent');
    const bad = { name: 'x', send: async () => { throw new Error('timeout'); } };
    const queued = { ...n, status: 'queued' as const, attempts: 0 };
    await expect(deliverNotification({ store: w.store, sms: bad }, queued)).rejects.toThrow();
    expect(await deliverNotification({ store: w.store, sms: bad }, { ...queued, attempts: 2 })).toBe('failed');
  });
});
