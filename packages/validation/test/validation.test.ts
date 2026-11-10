import { describe, expect, it } from 'vitest';
import {
  createBookingRequestSchema,
  ghanaPostGpsSchema,
  normalizeGhanaPhone,
  pricingRuleSetSchema,
  quoteRequestSchema,
} from '../src/index.js';
import sample from '../../../firebase/seed/pricing-rules.sample.json' with { type: 'json' };

const address = {
  line1: '12 Oxford Street',
  city: 'Accra',
  region: 'Greater Accra',
  location: { lat: 5.556, lng: -0.1823 },
};
const quote = {
  pickup: address,
  destination: { ...address, line1: 'Madina Market', location: { lat: 5.6681, lng: -0.1653 } },
  packages: [{ description: 'Shoes', weightKg: 2, lengthCm: 35, widthCm: 25, heightCm: 15, quantity: 1 }],
  urgency: 'standard',
  specialHandling: ['fragile', 'fragile'],
};

describe('Ghana phone numbers', () => {
  it.each([
    ['0241234567', '+233241234567'],
    ['024 123 4567', '+233241234567'],
    ['+233 20-123-4567', '+233201234567'],
    ['233551234567', '+233551234567'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeGhanaPhone(input)).toBe(expected);
  });
  it.each(['0211234567', '024123456', '+2342412345678', 'abc', '0301234567'])('rejects %s', (input) => {
    expect(normalizeGhanaPhone(input)).toBeNull();
  });
});

describe('GhanaPost GPS', () => {
  it('accepts and upper-cases valid codes', () => {
    expect(ghanaPostGpsSchema.parse(' ga-123-4567 ')).toBe('GA-123-4567');
    expect(ghanaPostGpsSchema.parse('AK-0039-5028')).toBe('AK-0039-5028');
  });
  it('rejects malformed codes', () => {
    expect(ghanaPostGpsSchema.safeParse('GA1234567').success).toBe(false);
  });
});

describe('quote request', () => {
  it('accepts a valid request and de-duplicates handling flags', () => {
    const r = quoteRequestSchema.parse(quote);
    expect(r.specialHandling).toEqual(['fragile']);
  });
  it('rejects coordinates outside Ghana', () => {
    const r = quoteRequestSchema.safeParse({ ...quote, pickup: { ...address, location: { lat: 51.5, lng: -0.12 } } });
    expect(r.success).toBe(false);
  });
  it('rejects identical pickup and destination', () => {
    expect(quoteRequestSchema.safeParse({ ...quote, destination: address }).success).toBe(false);
  });
  it('requires a declared value for high-value items', () => {
    expect(quoteRequestSchema.safeParse({ ...quote, specialHandling: ['high_value'] }).success).toBe(false);
  });
  it('rejects control characters and absurd weights', () => {
    expect(
      quoteRequestSchema.safeParse({ ...quote, packages: [{ ...quote.packages[0], description: 'a\u0000b' }] }).success,
    ).toBe(false);
    expect(quoteRequestSchema.safeParse({ ...quote, packages: [{ ...quote.packages[0], weightKg: 5000 }] }).success).toBe(false);
  });
  it('rejects unknown regions', () => {
    expect(quoteRequestSchema.safeParse({ ...quote, pickup: { ...address, region: 'Lagos' } }).success).toBe(false);
  });
});

describe('create booking request', () => {
  const booking = {
    quoteId: 'abcDEF1234567890',
    quote,
    sender: { name: 'Ama Mensah', phone: '0241234567', email: 'AMA@Example.com ' },
    recipient: { name: 'Kofi Boateng', phone: '0501234567' },
    paymentPreference: 'cash_on_pickup',
    acceptTerms: true,
  };
  it('normalises contacts', () => {
    const r = createBookingRequestSchema.parse(booking);
    expect(r.sender.phone).toBe('+233241234567');
    expect(r.sender.email).toBe('ama@example.com');
  });
  it('requires acceptance of terms', () => {
    expect(createBookingRequestSchema.safeParse({ ...booking, acceptTerms: false }).success).toBe(false);
  });
});

describe('pricing rule set', () => {
  it('accepts the sample rule set', () => {
    const r = pricingRuleSetSchema.safeParse(sample);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('rejects non-ascending weight bands', () => {
    const bad = { ...sample, weight: { includedKg: 5, bands: [{ upToKg: 3, perKgPesewas: 100 }, { upToKg: null, perKgPesewas: 50 }] } };
    expect(pricingRuleSetSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects enabled vehicles without rates', () => {
    const bad = { ...sample, intraCity: { rates: {} } };
    expect(pricingRuleSetSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects fractional pesewas', () => {
    const bad = { ...sample, minimumChargePesewas: 10.5 };
    expect(pricingRuleSetSchema.safeParse(bad).success).toBe(false);
  });
});

describe('friendly messages', () => {
  it('uses plain-language messages instead of zod defaults', () => {
    const r = quoteRequestSchema.safeParse({ ...quote, pickup: { ...address, city: '', region: 'Nowhere' } });
    expect(r.success).toBe(false);
    const msgs = Object.fromEntries(r.error!.issues.map((i) => [i.path.join('.'), i.message]));
    expect(msgs['pickup.city']).toBe('Enter at least 2 characters');
    expect(msgs['pickup.region']).toBe('Please choose an option');
    const n = quoteRequestSchema.safeParse({ ...quote, packages: [{ ...quote.packages[0], weightKg: NaN }] });
    expect(n.error!.issues[0]!.message).toBe('Enter a number');
  });
});

describe('null handling (Firebase callable encodes undefined as null)', () => {
  it('accepts null optional fields and normalises them away', () => {
    const withNulls = {
      ...quote,
      pickup: { ...address, line2: null, landmark: null, ghanaPostGps: null },
      packages: [{ ...quote.packages[0], declaredValuePesewas: null }],
    };
    const a = quoteRequestSchema.parse(withNulls);
    const b = quoteRequestSchema.parse(quote);
    expect(a).toEqual(b);
    expect('line2' in a.pickup && a.pickup.line2 !== undefined).toBe(false);
  });
});

describe('account & access schemas', async () => {
  const { bookingAccessSchema, refundRequestSchema } = await import('../src/index.js');
  const { generateTrackingNumber } = await import('@courier/shared-utils');
  it('normalises tracking numbers and rejects typos', () => {
    const t = generateTrackingNumber();
    expect(bookingAccessSchema.parse({ trackingNumber: t.toLowerCase(), accessToken: null })).toEqual({ trackingNumber: t, accessToken: undefined });
    expect(bookingAccessSchema.safeParse({ trackingNumber: 'GH123' }).success).toBe(false);
  });
  it('validates guest access tokens', () => {
    const t = generateTrackingNumber();
    expect(bookingAccessSchema.safeParse({ trackingNumber: t, accessToken: 'x'.repeat(32) }).success).toBe(true);
    expect(bookingAccessSchema.safeParse({ trackingNumber: t, accessToken: 'bad token' }).success).toBe(false);
  });
  it('requires positive integer refunds with a reason', () => {
    expect(refundRequestSchema.safeParse({ paymentReference: 'GHABC-12345', amountPesewas: 0, reason: 'Customer cancelled' }).success).toBe(false);
    expect(refundRequestSchema.safeParse({ paymentReference: 'GHABC-12345', amountPesewas: 100, reason: 'Customer cancelled' }).success).toBe(true);
  });
});
