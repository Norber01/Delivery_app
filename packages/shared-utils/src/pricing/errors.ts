import type { ErrorCode } from '@courier/constants';

/** Business-rule failure with a stable code that clients can map to a message. */
export class PricingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}
