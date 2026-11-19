import { issuesToFieldErrors } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import type { AuditEntry } from '../store/types.js';
import type { Refusal } from './types.js';

export function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, raw: unknown, msg = 'Please check the highlighted fields.'): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION_FAILED', msg, 'invalid-argument', issuesToFieldErrors(r.error));
  return r.data;
}

export const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && 'error' in v;

export function refuse(r: Refusal): never {
  throw new AppError((r.code as never) ?? 'VALIDATION_FAILED', r.error);
}

export const audit = (caller: Caller & { uid: string }, action: string, targetType: string, targetId: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  actorUid: caller.uid,
  actorRole: caller.role ?? 'guest',
  action,
  targetType,
  targetId,
  ...extra,
});

/** [start, end) of a YYYY-MM period in UTC (Ghana is UTC+0 all year). */
export function periodRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
}
