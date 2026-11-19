import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentProviderError,
  type InitializeParams,
  type PaymentProvider,
  type ProviderRefund,
  type ProviderTransactionStatus,
  type VerifiedTransaction,
  type WebhookEvent,
} from './provider.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackTransaction {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  channel?: string | null;
  paid_at?: string | null;
}

interface PaystackRefund {
  id: number;
  status: string;
  amount: number;
}

/** Map Paystack transaction statuses onto our three outcomes. */
export function mapTransactionStatus(s: string): ProviderTransactionStatus {
  if (s === 'success') return 'success';
  if (s === 'failed' || s === 'reversed') return 'failed';
  return 'pending'; // abandoned, ongoing, pending, processing, queued
}

function mapRefundStatus(s: string): ProviderRefund['status'] {
  if (s === 'processed') return 'processed';
  if (s === 'failed') return 'failed';
  return 'pending'; // pending, processing, needs-attention
}

/**
 * Paystack adapter (GHS: amounts are in pesewas, Paystack's subunit).
 * API: https://paystack.com/docs/api/ — initialize, verify, refund; webhooks are
 * signed with HMAC-SHA512 of the raw body using the secret key.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = 'https://api.paystack.co',
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly timeoutMs = 10_000,
  ) {
    if (!secretKey) throw new Error('Paystack secret key is required');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
      if (!res.ok || !json?.status) {
        throw new PaymentProviderError(`Paystack ${path} failed: ${json?.message ?? res.status}`, res.status);
      }
      return json.data;
    } catch (e) {
      if (e instanceof PaymentProviderError) throw e;
      throw new PaymentProviderError(`Paystack ${path} error: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(p: InitializeParams) {
    const data = await this.request<{ authorization_url: string; reference: string }>('POST', '/transaction/initialize', {
      email: p.email,
      amount: p.amountPesewas,
      currency: 'GHS',
      reference: p.reference,
      callback_url: p.callbackUrl,
      channels: ['mobile_money', 'card'],
      metadata: p.metadata,
    });
    if (data.reference !== p.reference) throw new PaymentProviderError('Paystack returned a different reference');
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const t = await this.request<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      reference: t.reference,
      status: mapTransactionStatus(t.status),
      amountPesewas: t.amount,
      currency: t.currency,
      channel: t.channel ?? null,
      providerTransactionId: String(t.id),
      paidAt: t.paid_at ? new Date(t.paid_at) : null,
      rawStatus: t.status,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const signature = headers['x-paystack-signature'];
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return null;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let body: { event?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const type = String(body.event ?? 'unknown');
    const data = body.data ?? {};
    const id = data.id !== undefined ? String(data.id) : String(data.reference ?? data.transaction_reference ?? 'none');
    const eventKey = `paystack_${type.replace(/[^a-z._]/gi, '')}_${id.replace(/[^A-Za-z0-9-]/g, '')}`;

    if (type === 'charge.success' && typeof data.reference === 'string') {
      return { kind: 'charge', eventKey, reference: data.reference };
    }
    if (type.startsWith('refund.')) {
      const tx = data.transaction as { reference?: string } | undefined;
      return {
        kind: 'refund',
        eventKey,
        providerRefundId: data.id !== undefined ? String(data.id) : null,
        transactionReference: (data.transaction_reference as string | undefined) ?? tx?.reference ?? null,
      };
    }
    return { kind: 'ignored', eventKey, type };
  }

  async refund(p: { reference: string; amountPesewas: number; note: string }): Promise<ProviderRefund> {
    const r = await this.request<PaystackRefund>('POST', '/refund', {
      transaction: p.reference,
      amount: p.amountPesewas,
      merchant_note: p.note.slice(0, 200),
    });
    return { providerRefundId: String(r.id), status: mapRefundStatus(r.status), amountPesewas: r.amount };
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    const r = await this.request<PaystackRefund>('GET', `/refund/${encodeURIComponent(providerRefundId)}`);
    return { providerRefundId: String(r.id), status: mapRefundStatus(r.status), amountPesewas: r.amount };
  }
}
