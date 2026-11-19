import { describe, expect, it } from 'vitest';
import { PaystackProvider, mapTransactionStatus } from '../src/payments/paystack.js';
import { PaymentProviderError } from '../src/payments/provider.js';
import { SECRET, sign } from './helpers.js';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function fake(responses: { ok?: boolean; status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
  return { calls, provider: new PaystackProvider(SECRET, 'https://api.paystack.test', fetchImpl) };
}

describe('PaystackProvider', () => {
  it('initialises a GHS checkout in pesewas with Mobile Money and card channels', async () => {
    const { calls, provider } = fake([{ body: { status: true, message: 'ok', data: { authorization_url: 'https://checkout/x', reference: 'GHREF-1' } } }]);
    const r = await provider.initialize({
      reference: 'GHREF-1',
      amountPesewas: 3490,
      email: 'a@b.com',
      callbackUrl: 'https://site/payment/return',
      metadata: { trackingNumber: 'GHX' },
    });
    expect(r.authorizationUrl).toBe('https://checkout/x');
    expect(calls[0]!.url).toBe('https://api.paystack.test/transaction/initialize');
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(calls[0]!.init.body!)).toMatchObject({ amount: 3490, currency: 'GHS', reference: 'GHREF-1', channels: ['mobile_money', 'card'] });
  });

  it('verifies a transaction and maps statuses', async () => {
    const { provider } = fake([
      { body: { status: true, message: 'ok', data: { id: 9, status: 'success', reference: 'R', amount: 3490, currency: 'GHS', channel: 'mobile_money', paid_at: '2026-11-10T10:00:00Z' } } },
    ]);
    const v = await provider.verify('R');
    expect(v).toMatchObject({ status: 'success', amountPesewas: 3490, currency: 'GHS', channel: 'mobile_money', providerTransactionId: '9' });
    expect(mapTransactionStatus('abandoned')).toBe('pending');
    expect(mapTransactionStatus('reversed')).toBe('failed');
  });

  it('raises PaymentProviderError on API errors', async () => {
    const { provider } = fake([{ ok: false, status: 400, body: { status: false, message: 'Transaction reference not found' } }]);
    await expect(provider.verify('nope')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('accepts only correctly signed webhooks', () => {
    const p = new PaystackProvider(SECRET);
    const body = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'GHREF-1' } });
    expect(p.parseWebhook(Buffer.from(body), { 'x-paystack-signature': sign(body) })).toEqual({
      kind: 'charge',
      eventKey: 'paystack_charge.success_1',
      reference: 'GHREF-1',
    });
    expect(p.parseWebhook(Buffer.from(body), { 'x-paystack-signature': sign(body, 'wrong') })).toBeNull();
    expect(p.parseWebhook(Buffer.from(body.replace('GHREF-1', 'GHREF-2')), { 'x-paystack-signature': sign(body) })).toBeNull();
    expect(p.parseWebhook(Buffer.from(body), {})).toBeNull();
  });

  it('parses refund and unrelated events', () => {
    const p = new PaystackProvider(SECRET);
    const refund = JSON.stringify({ event: 'refund.processed', data: { id: 77, transaction_reference: 'GHREF-1', status: 'processed' } });
    expect(p.parseWebhook(Buffer.from(refund), { 'x-paystack-signature': sign(refund) })).toMatchObject({ kind: 'refund', providerRefundId: '77' });
    const other = JSON.stringify({ event: 'transfer.success', data: { id: 3 } });
    expect(p.parseWebhook(Buffer.from(other), { 'x-paystack-signature': sign(other) })).toMatchObject({ kind: 'ignored' });
  });
});
