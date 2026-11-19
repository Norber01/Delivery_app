import { ADMIN_GRANTABLE_ROLES, ROLES, type Role } from '@courier/constants';
import { pricingRuleSetSchema, issuesToFieldErrors } from '@courier/validation';
import type { PricingRuleSet } from '@courier/shared-types';
import { z } from 'zod';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { Store } from '../store/types.js';

export const setUserRoleSchema = z
  .object({
    uid: z.string().min(1).max(128),
    role: z.enum(ROLES),
    businessId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    hubIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(20).optional(),
  })
  .superRefine((v, ctx) => {
    const business = v.role === 'business_owner' || v.role === 'business_staff';
    if (business && !v.businessId) ctx.addIssue({ code: 'custom', path: ['businessId'], message: 'Required for business roles' });
    if (!business && v.businessId) ctx.addIssue({ code: 'custom', path: ['businessId'], message: 'Only for business roles' });
    if (v.role === 'hub_operator' && !v.hubIds?.length) ctx.addIssue({ code: 'custom', path: ['hubIds'], message: 'Required for hub operators' });
  });
export type SetUserRoleInput = z.output<typeof setUserRoleSchema>;

/**
 * Authorisation for role changes (docs/03 §3.4):
 * - nobody changes their own role;
 * - admins grant only non-admin roles and cannot modify admins/super admins;
 * - only super admins grant admin or super_admin.
 */
export function authorizeRoleChange(caller: Caller, raw: unknown, targetCurrentRole: Role | null): SetUserRoleInput {
  requireRole(caller, ['admin', 'super_admin']);
  const parsed = setUserRoleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid role change.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const input = parsed.data;
  if (input.uid === caller.uid) {
    throw new AppError('PERMISSION_DENIED', 'You cannot change your own role.', 'permission-denied');
  }
  if (caller.role === 'admin') {
    const privileged = (r: Role | null) => r === 'admin' || r === 'super_admin';
    if (!(ADMIN_GRANTABLE_ROLES as readonly Role[]).includes(input.role) || privileged(targetCurrentRole)) {
      throw new AppError('PERMISSION_DENIED', 'Only a super admin can manage administrator roles.', 'permission-denied');
    }
  }
  return input;
}

export interface RoleIdentityPort {
  find(by: { uid: string } | { email: string }): Promise<{ uid: string; email: string | null; name: string | null; claims: Record<string, unknown> } | null>;
  apply(
    uid: string,
    claims: Record<string, unknown>,
    profile: { role: Role; businessId: string | null; hubIds: string[]; email: string | null; name: string | null },
  ): Promise<void>;
}

/**
 * Grant or remove a role. The ops app's Staff page finds people by the email they signed up
 * with; the change takes effect at their next sign-in (sessions are revoked).
 */
export async function setUserRole(deps: { store: Store; identity: RoleIdentityPort }, caller: Caller, raw: unknown, ipHash: string | null = null) {
  requireRole(caller, ['admin', 'super_admin']); // before any lookup, so non-admins learn nothing
  const data = (raw ?? {}) as { uid?: unknown; email?: unknown };
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const target = email && !data.uid ? await deps.identity.find({ email }) : await deps.identity.find({ uid: String(data.uid ?? '') });
  if (!target) {
    throw new AppError('VALIDATION_FAILED', email ? 'No account with that email. Ask the person to sign up on the website first.' : 'User not found.', 'not-found');
  }
  const currentRole = (ROLES as readonly string[]).includes(target.claims.role as string) ? (target.claims.role as Role) : null;
  const input = authorizeRoleChange(caller, { ...(raw as object), uid: target.uid }, currentRole);
  const claims = { role: input.role, ...(input.businessId ? { businessId: input.businessId } : {}), ...(input.hubIds ? { hubIds: input.hubIds } : {}) };
  await deps.identity.apply(target.uid, claims, { role: input.role, businessId: input.businessId ?? null, hubIds: input.hubIds ?? [], email: target.email, name: target.name });
  await deps.store.writeAudit({
    actorUid: caller.uid,
    actorRole: caller.role ?? 'guest',
    action: 'user.setRole',
    targetType: 'user',
    targetId: target.uid,
    before: { role: currentRole },
    after: claims,
    ipHash,
  });
  return { ok: true, uid: target.uid };
}

export async function publishPricingRules(store: Store, caller: Caller, raw: unknown): Promise<{ version: number }> {
  requireRole(caller, ['admin', 'super_admin']);
  // `version` is assigned by the server; accept any placeholder from the editor.
  const candidate = { ...(raw as object), version: 1 };
  const parsed = pricingRuleSetSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The pricing rules are invalid.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  }
  const { version: _ignored, ...rules } = parsed.data as PricingRuleSet;
  const version = await store.publishPricingRules(rules, {
    actorUid: caller.uid,
    actorRole: caller.role,
    action: 'pricing.publish',
    targetType: 'pricingRules',
    after: rules,
  });
  return { version };
}
