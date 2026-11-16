import { ROLES, STAFF_ROLES, type Role } from '@courier/constants';
import { AppError } from './errors.js';

export interface Caller {
  uid: string | null;
  role: Role | null;
  businessId: string | null;
  /** True when the current session used a second factor. */
  mfa: boolean;
  /** Optional dispatcher scope; when set, only these service areas may be managed. */
  serviceAreaIds?: string[];
  /** Hub operator scope. */
  hubIds?: string[];
}

export const GUEST: Caller = { uid: null, role: null, businessId: null, mfa: false };

/** Derive the caller from verified ID-token claims. Never from request data. */
export function callerFromToken(auth: { uid: string; token: Record<string, unknown> } | undefined): Caller {
  if (!auth) return GUEST;
  const t = auth.token;
  const role = typeof t.role === 'string' && (ROLES as readonly string[]).includes(t.role) ? (t.role as Role) : null;
  const firebase = t.firebase as { sign_in_second_factor?: string } | undefined;
  return {
    uid: auth.uid,
    role,
    businessId: typeof t.businessId === 'string' ? t.businessId : null,
    mfa: Boolean(firebase?.sign_in_second_factor),
    ...(Array.isArray(t.serviceAreaIds) ? { serviceAreaIds: t.serviceAreaIds.filter((x): x is string => typeof x === 'string') } : {}),
    ...(Array.isArray(t.hubIds) ? { hubIds: t.hubIds.filter((x): x is string => typeof x === 'string') } : {}),
  };
}

export function isStaff(role: Role | null): boolean {
  return role !== null && (STAFF_ROLES as readonly string[]).includes(role);
}

/** Require one of the roles; staff roles additionally require an MFA session. */
export function requireRole(caller: Caller, roles: readonly Role[]): asserts caller is Caller & { uid: string; role: Role } {
  if (!caller.uid || !caller.role || !roles.includes(caller.role)) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to do this.', 'permission-denied');
  }
  if (isStaff(caller.role) && !caller.mfa) {
    throw new AppError('MFA_REQUIRED', 'Multi-factor authentication is required for staff actions.', 'permission-denied');
  }
}
