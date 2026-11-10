/**
 * Provider-neutral payment port (docs/07-payments.md §7.2). Services depend only on this.
 * Every result here comes from a server-to-provider call or a signature-verified webhook,
 * never from the customer's browser.
 */
export type ProviderTransactionStatus = 'success' | 'failed' | 'pending';

export interface VerifiedTransaction {
  reference: string;
  status: ProviderTransactionStatus;
  /** Amount in pesewas as reported by the provider. */
  amountPesewas: number;
  currency: string;
  channel: string | null;
  providerTransactionId: string | null;
  paidAt: Date | null;
  /** Raw provider status for audit (e.g. "abandoned"). */
  rawStatus: string;
}

export interface InitializeParams {
  reference: string;
  amountPesewas: number;
  email: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}

export type WebhookEvent =
  | { kind: 'charge'; eventKey: string; reference: string }
  | { kind: 'refund'; eventKey: string; providerRefundId: string | null; transactionReference: string | null }
  | { kind: 'ignored'; eventKey: string; type: string };

export interface ProviderRefund {
  providerRefundId: string;
  status: 'pending' | 'processed' | 'failed';
  amountPesewas: number;
}

export interface PaymentProvider {
  readonly name: 'paystack';
  initialize(p: InitializeParams): Promise<{ authorizationUrl: string; reference: string }>;
  /** Authoritative status check with the provider. */
  verify(reference: string): Promise<VerifiedTransaction>;
  /** Returns the parsed event only when the signature is valid; otherwise null. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
  refund(p: { reference: string; amountPesewas: number; note: string }): Promise<ProviderRefund>;
  getRefund(providerRefundId: string): Promise<ProviderRefund>;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
