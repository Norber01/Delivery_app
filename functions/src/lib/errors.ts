import type { ErrorCode } from '@courier/constants';
import { PricingError } from '@courier/shared-utils';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';

/** Domain error carried through services; converted to HttpsError at the callable boundary. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpsCode: FunctionsErrorCode = 'failed-precondition',
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof AppError) return new HttpsError(e.httpsCode, e.message, { code: e.code, fields: e.fields });
  if (e instanceof PricingError) return new HttpsError('failed-precondition', e.message, { code: e.code });
  console.error('Unhandled error', e);
  return new HttpsError('internal', 'Something went wrong. Please try again.');
}
