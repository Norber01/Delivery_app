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
