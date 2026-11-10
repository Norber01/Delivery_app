import { createHmac } from 'node:crypto';
import type { PricingRuleSet, ServiceArea } from '@courier/shared-types';
import rulesJson from '../../firebase/seed/pricing-rules.sample.json' with { type: 'json' };
import areasJson from '../../firebase/seed/service-areas.sample.json' with { type: 'json' };
import { GUEST, type Caller } from '../src/lib/auth.js';
import { PaystackProvider } from '../src/payments/paystack.js';
import {
  PaymentProviderError,
  type InitializeParams,
  type PaymentProvider,
  type ProviderRefund,
  type VerifiedTransaction,
} from '../src/payments/provider.js';
import { createBooking } from '../src/services/bookingService.js';
import type { PaymentDeps } from '../src/services/paymentService.js';
import { getQuote } from '../src/services/quoteService.js';
import { MemoryRateLimiter, MemoryStore } from './memoryStore.js';

export const SECRET = 'sk_test_secret';
export const rules = rulesJson as unknown as PricingRuleSet;
export const areas = areasJson as ServiceArea[];
export const meta = { ipHash: 'iphash' };
export const site = { publicUrl: 'https://www.example.com.gh', companyName: 'Example Courier', fallbackEmailDomain: 'pay.example.com.gh' };

export const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };
export const madina = { line1: 'Madina Market', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6681, lng: -0.1653 } };
export const quoteReq = {
  pickup: osu,
  destination: madina,
  packages: [{ description: 'Shoes', weightKg: 2, lengthCm: 35, widthCm: 25, heightCm: 15, quantity: 1 }],
  urgency: 'standard',
  specialHandling: [],
};
export const contacts = {
  sender: { name: 'Ama Mensah', phone: '0241234567', email: 'ama@example.com' },
  recipient: { name: 'Kofi Boateng', phone: '0501234567' },
  acceptTerms: true,
};

export const sign = (body: string, secret = SECRET) => createHmac('sha512', secret).update(body).digest('hex');

/** Programmable stand-in for Paystack; webhook parsing uses the real adapter. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  tx = new Map<string, VerifiedTransaction>();
  refunds = new Map<string, ProviderRefund>();
  verifyCalls = 0;
  initFail = false;
  refundFail = false;
  lastInit: InitializeParams | null = null;
  private parser = new PaystackProvider(SECRET);
  private refundSeq = 0;

  async initialize(p: InitializeParams) {
    if (this.initFail) throw new PaymentProviderError('down', 503);
    this.lastInit = p;
    this.tx.set(p.reference, {
      reference: p.reference,
      status: 'pending',
      amountPesewas: p.amountPesewas,
      currency: 'GHS',
      channel: null,
      providerTransactionId: String(this.tx.size + 1000),
      paidAt: null,
      rawStatus: 'ongoing',
    });
    return { authorizationUrl: `https://checkout.test/${p.reference}`, reference: p.reference };
  }
  /** Simulate the customer completing checkout. */
  complete(reference: string, override: Partial<VerifiedTransaction> = {}) {
    const t = this.tx.get(reference)!;
    this.tx.set(reference, { ...t, status: 'success', channel: 'mobile_money', paidAt: new Date('2026-11-10T10:05:00Z'), rawStatus: 'success', ...override });
  }
  async verify(reference: string) {
    this.verifyCalls++;
    const t = this.tx.get(reference);
    if (!t) throw new PaymentProviderError('Transaction reference not found', 400);
    return { ...t };
  }
  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    return this.parser.parseWebhook(raw, headers);
  }
  async refund(p: { reference: string; amountPesewas: number }) {
    if (this.refundFail) throw new PaymentProviderError('refund rejected', 400);
    const r: ProviderRefund = { providerRefundId: String(++this.refundSeq), status: 'pending', amountPesewas: p.amountPesewas };
    this.refunds.set(r.providerRefundId, r);
    return { ...r };
  }
  async getRefund(id: string) {
    return { ...this.refunds.get(id)! };
  }
}

export function chargeWebhook(reference: string, id = 555) {
  const body = JSON.stringify({ event: 'charge.success', data: { id, reference, amount: 1, currency: 'GHS', status: 'success' } });
  return { raw: Buffer.from(body), headers: { 'x-paystack-signature': sign(body) } };
}

export interface World {
  store: MemoryStore;
  provider: FakeProvider;
  clock: { now: Date };
  pay: PaymentDeps;
  book(caller?: Caller, pref?: string): Promise<{ trackingNumber: string; token: string | null; total: number }>;
}

export function world(): World {
  const store = new MemoryStore(rules, areas);
  const clock = { now: new Date('2026-11-10T10:00:00Z') };
  store.now = () => clock.now;
  const provider = new FakeProvider();
  const rateLimiter = new MemoryRateLimiter();
  let ids = 0;
  const quoteDeps = {
    store,
    rateLimiter,
    maps: { name: 'fake', geocode: async () => [], route: async () => ({ distanceKm: 8.3, durationMinutes: 20 }) },
    now: () => clock.now,
    newId: () => `quote${String(++ids).padStart(10, '0')}`,
  };
  return {
    store,
    provider,
    clock,
    pay: { store, rateLimiter, provider, now: () => clock.now, site },
    async book(caller = GUEST, pref = 'mobile_money') {
      const q = await getQuote(quoteDeps, quoteReq, caller, meta);
      const r = await createBooking(
        { store, rateLimiter, now: () => clock.now, site },
        { quoteId: q.quoteId, quote: quoteReq, ...contacts, paymentPreference: pref },
        caller,
        meta,
      );
      return { trackingNumber: r.trackingNumber, token: r.guestAccessToken, total: r.totalPesewas };
    },
  };
}
