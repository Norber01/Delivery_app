import { beforeEach, describe, expect, it } from 'vitest';
import { GUEST, type Caller } from '../src/lib/auth.js';
import { generateTrackingNumber } from '@courier/shared-utils';
import { AppError } from '../src/lib/errors.js';
import { claimBooking, completeSignUp, type IdentityPort } from '../src/services/accountService.js';
import { handlePaymentWebhook, initiatePayment } from '../src/services/paymentService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { chargeWebhook, meta, world, type World } from './helpers.js';

let w: World;
const alice: Caller = { uid: 'alice', role: 'customer', businessId: null, mfa: false };
const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
const track = (raw: unknown, caller: Caller = GUEST) => getTrackingView({ store: w.store, rateLimiter: w.pay.rateLimiter }, raw, caller, meta);

beforeEach(() => {
  w = world();
});

describe('tracking view', () => {
  it('shows only non-personal information with the tracking number alone', async () => {
    const b = await w.book();
    const v = await track({ trackingNumber: b.trackingNumber.toLowerCase() });
    expect(v).toMatchObject({ access: 'public', statusLabel: 'Awaiting payment', origin: { city: 'Accra' }, liveLocation: null });
    expect(v.details).toBeUndefined();
    const json = JSON.stringify(v);
    for (const secret of ['Ama', 'Kofi', '+233', 'Oxford', '3490']) expect(json).not.toContain(secret);
  });

  it('shows full details with the access code or to the owner', async () => {
    const b = await w.book();
    const v = await track({ trackingNumber: b.trackingNumber, accessToken: b.token });
    expect(v.access).toBe('full');
    expect(v.details).toMatchObject({ canPayOnline: true, ownedByCaller: false, recipient: { name: 'Kofi Boateng' } });

    const owned = await w.book(alice);
    expect((await track({ trackingNumber: owned.trackingNumber }, alice)).details?.ownedByCaller).toBe(true);
    expect((await track({ trackingNumber: owned.trackingNumber }, { ...alice, uid: 'bob' })).access).toBe('public');
  });

  it('builds a timeline from tracking events', async () => {
    const b = await w.book();
    const { reference } = await initiatePayment(w.pay, { trackingNumber: b.trackingNumber, accessToken: b.token }, GUEST, meta);
    w.provider.complete(reference);
    const hook = chargeWebhook(reference);
    await handlePaymentWebhook(w.pay, hook.raw, hook.headers, async () => {});
    const v = await track({ trackingNumber: b.trackingNumber, accessToken: b.token });
    expect(v.timeline.map((t) => t.type)).toEqual(['booking_created', 'payment_received', 'booking_confirmed']);
    expect(v.statusLabel).toBe('Booking confirmed — awaiting driver assignment');
    expect(v.details?.canPayOnline).toBe(false);
  });

  it('distinguishes malformed and unknown tracking numbers', async () => {
    await expectCode(track({ trackingNumber: 'GH123' }), 'VALIDATION_FAILED');
    await expectCode(track({ trackingNumber: generateTrackingNumber(() => new Uint8Array(10)) }), 'BOOKING_NOT_FOUND');
  });
});

describe('accounts', () => {
  const identity = (claims: Record<string, unknown>, user: Partial<{ email: string | null; phone: string | null; emailVerified: boolean }> = {}) => {
    const state = { claims: { ...claims } };
    const port: IdentityPort = {
      getUser: async () => ({ email: 'a@b.com', phone: null, emailVerified: true, ...user, claims: state.claims }),
      setClaims: async (_uid, c) => {
        state.claims = c;
      },
    };
    return { port, state };
  };
  const newUser: Caller = { uid: 'u1', role: null, businessId: null, mfa: false };

  it('grants the customer role to new verified accounts and creates a profile', async () => {
    const { port, state } = identity({});
    expect(await completeSignUp({ store: w.store, identity: port }, newUser, { displayName: 'Ama' })).toEqual({ role: 'customer', claimsUpdated: true });
    expect(state.claims.role).toBe('customer');
    expect(w.store.users.get('u1')).toMatchObject({ role: 'customer', displayName: 'Ama' });
  });

  it('never changes an existing role', async () => {
    const { port, state } = identity({ role: 'admin' });
    expect(await completeSignUp({ store: w.store, identity: port }, newUser, {})).toEqual({ role: 'admin', claimsUpdated: false });
    expect(state.claims.role).toBe('admin');
  });

  it('requires a verified email or a phone number', async () => {
    const { port } = identity({}, { emailVerified: false });
    await expectCode(completeSignUp({ store: w.store, identity: port }, newUser, {}), 'PERMISSION_DENIED');
    const phone = identity({}, { email: null, phone: '+233241234567', emailVerified: false });
    await expect(completeSignUp({ store: w.store, identity: phone.port }, newUser, {})).resolves.toMatchObject({ role: 'customer' });
  });

  it('claims a guest booking with its access code, once', async () => {
    const b = await w.book();
    expect(await claimBooking({ store: w.store }, alice, { trackingNumber: b.trackingNumber, accessToken: b.token })).toEqual({
      trackingNumber: b.trackingNumber,
    });
    expect(w.store.bookings.get(b.trackingNumber)!.customerUid).toBe('alice');
    // Idempotent for the owner, refused for anyone else.
    await expect(claimBooking({ store: w.store }, alice, { trackingNumber: b.trackingNumber, accessToken: b.token })).resolves.toBeTruthy();
    await expectCode(
      claimBooking({ store: w.store }, { ...alice, uid: 'bob' }, { trackingNumber: b.trackingNumber, accessToken: b.token }),
      'BOOKING_ALREADY_CLAIMED',
    );
  });

  it('refuses claims without the right code or by non-customers', async () => {
    const b = await w.book();
    await expectCode(claimBooking({ store: w.store }, alice, { trackingNumber: b.trackingNumber, accessToken: 'B'.repeat(32) }), 'BOOKING_NOT_FOUND');
    await expectCode(
      claimBooking({ store: w.store }, { ...alice, role: 'driver' }, { trackingNumber: b.trackingNumber, accessToken: b.token }),
      'PERMISSION_DENIED',
    );
  });
});
