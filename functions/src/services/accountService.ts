import { completeSignUpSchema, bookingAccessSchema, issuesToFieldErrors } from '@courier/validation';
import type { Role } from '@courier/constants';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { Store } from '../store/types.js';
import { bookingAccess } from './access.js';

/** Admin Auth operations needed by account flows (Firebase Admin Auth in production). */
export interface IdentityPort {
  getUser(uid: string): Promise<{ email: string | null; phone: string | null; emailVerified: boolean; claims: Record<string, unknown> }>;
  setClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

/**
 * Called once after a customer signs up (idempotent). Grants the `customer` role only to
 * accounts with no role — it can never change or downgrade an existing role.
 */
export async function completeSignUp(
  deps: { store: Store; identity: IdentityPort },
  caller: Caller,
  raw: unknown,
): Promise<{ role: Role; claimsUpdated: boolean }> {
  if (!caller.uid) throw new AppError('PERMISSION_DENIED', 'Please sign in first.', 'unauthenticated');
  const parsed = completeSignUpSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid profile.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const user = await deps.identity.getUser(caller.uid);
  const existing = typeof user.claims.role === 'string' ? (user.claims.role as Role) : null;
  if (existing) return { role: existing, claimsUpdated: false };

  if (!user.phone && !(user.email && user.emailVerified)) {
    throw new AppError('PERMISSION_DENIED', 'Please verify your email address or phone number first.', 'failed-precondition');
  }
  await deps.identity.setClaims(caller.uid, { ...user.claims, role: 'customer' });
  await deps.store.upsertUserProfile({
    uid: caller.uid,
    role: 'customer',
    displayName: parsed.data.displayName ?? null,
    email: user.email,
    phone: user.phone,
  });
  await deps.store.writeAudit({
    actorUid: caller.uid,
    actorRole: 'customer',
    action: 'user.signUp',
    targetType: 'user',
    targetId: caller.uid,
  });
  return { role: 'customer', claimsUpdated: true };
}

/** Attach a guest booking to the signed-in customer's account using its access token. */
export async function claimBooking(deps: { store: Store }, caller: Caller, raw: unknown): Promise<{ trackingNumber: string }> {
  if (!caller.uid || caller.role !== 'customer') {
    throw new AppError('PERMISSION_DENIED', 'Sign in with a customer account to save bookings.', 'permission-denied');
  }
  const parsed = bookingAccessSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.accessToken) {
    throw new AppError('VALIDATION_FAILED', 'Enter the tracking number and access code.', 'invalid-argument');
  }
  const booking = await deps.store.getBooking(parsed.data.trackingNumber);
  if (!booking || bookingAccess(booking, { ...caller, role: null }, parsed.data.accessToken) !== 'guest_token') {
    if (booking?.customerUid === caller.uid) return { trackingNumber: booking.trackingNumber };
    throw new AppError('BOOKING_NOT_FOUND', 'We could not find a booking with those details.', 'not-found');
  }
  const outcome = await deps.store.claimBooking(booking.trackingNumber, caller.uid, {
    actorUid: caller.uid,
    actorRole: 'customer',
    action: 'booking.claim',
    targetType: 'deliveryRequest',
    targetId: booking.trackingNumber,
  });
  if (outcome === 'already_owned') {
    throw new AppError('BOOKING_ALREADY_CLAIMED', 'This booking already belongs to another account.', 'failed-precondition');
  }
  if (outcome === 'not_found') throw new AppError('BOOKING_NOT_FOUND', 'We could not find a booking with those details.', 'not-found');
  return { trackingNumber: booking.trackingNumber };
}
