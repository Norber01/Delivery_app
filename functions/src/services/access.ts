import { timingSafeEqual } from 'node:crypto';
import { isStaff, type Caller } from '../lib/auth.js';
import { sha256Hex } from '../lib/hash.js';
import type { BookingRecord } from '../store/types.js';

export type BookingAccess = 'owner' | 'business' | 'staff' | 'guest_token';

function tokenMatches(token: string | undefined, hash: string | null): boolean {
  if (!token || !hash) return false;
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Who may see the full booking (contacts, addresses, price) and act on it. Null = public view only. */
export function bookingAccess(booking: BookingRecord, caller: Caller, accessToken?: string): BookingAccess | null {
  if (caller.uid && booking.customerUid === caller.uid) return 'owner';
  if (
    booking.businessId &&
    (caller.role === 'business_owner' || caller.role === 'business_staff') &&
    caller.businessId === booking.businessId
  ) {
    return 'business';
  }
  if (isStaff(caller.role) && caller.mfa && caller.role !== 'fleet_manager') return 'staff';
  if (tokenMatches(accessToken, booking.guestAccessHash)) return 'guest_token';
  return null;
}
