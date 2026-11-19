/** Stand-in for `firebase-functions/v2/https` (only HttpsError is used by the services). */
const STATUS: Record<string, number> = {
  ok: 200, cancelled: 499, unknown: 500, 'invalid-argument': 400, 'deadline-exceeded': 504, 'not-found': 404, 'already-exists': 409,
  'permission-denied': 403, unauthenticated: 401, 'resource-exhausted': 429, 'failed-precondition': 400, aborted: 409, 'out-of-range': 400,
  unimplemented: 501, internal: 500, unavailable: 503, 'data-loss': 500,
};
export type FunctionsErrorCode = keyof typeof STATUS;
export class HttpsError extends Error {
  readonly httpErrorCode: { status: number; canonicalName: string };
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.httpErrorCode = { status: STATUS[code] ?? 500, canonicalName: code.toUpperCase().replace(/-/g, '_') };
  }
}
export type CallableRequest = { data: unknown; auth?: unknown; rawRequest: { ip?: string } };
