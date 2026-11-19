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

describe('operations schemas', async () => {
  const { driverActionSchema, dispatchActionSchema, vehicleSchema, signatureSchema } = await import('../src/index.js');
  const base = { actionId: 'a'.repeat(20), deliveryId: 'GHABC', occurredAt: '2026-11-15T10:00:00Z' };
  const sig = [Array.from({ length: 12 }, (_, i) => [i / 12, 0.5] as [number, number])];
  it('validates driver actions by type', () => {
    expect(driverActionSchema.safeParse({ ...base, type: 'start_assignment' }).success).toBe(true);
    expect(driverActionSchema.safeParse({ ...base, type: 'report_pickup_failed' }).success).toBe(false); // reason required
    expect(driverActionSchema.safeParse({ ...base, type: 'report_delivery_failed', reason: 'missing_in_transit' }).success).toBe(false); // system-only
    expect(driverActionSchema.safeParse({ ...base, type: 'complete_delivery', receivedByName: 'Kofi', otp: '12345' }).success).toBe(false);
    expect(driverActionSchema.safeParse({ ...base, type: 'complete_return', receivedByName: 'Ama', signature: sig }).success).toBe(true);
    expect(driverActionSchema.safeParse({ ...base, type: 'complete_delivery', receivedByName: 'Kofi', photoKeys: ['../etc/passwd'] }).success).toBe(false);
  });
  it('caps signature size', () => {
    expect(signatureSchema.safeParse([[[0.1, 0.1]]]).success).toBe(false);
    expect(signatureSchema.safeParse(Array.from({ length: 61 }, () => sig[0])).success).toBe(false);
    expect(signatureSchema.safeParse([[[1.5, 0]]]).success).toBe(false);
  });
  it('requires a driver to assign and a reason to cancel', () => {
    expect(dispatchActionSchema.safeParse({ type: 'assign', deliveryId: 'GHX' }).success).toBe(false);
    expect(dispatchActionSchema.safeParse({ type: 'cancel', deliveryId: 'GHX' }).success).toBe(false);
    expect(dispatchActionSchema.safeParse({ type: 'cancel', deliveryId: 'GHX', reason: 'Customer request' }).success).toBe(true);
  });
  it('normalises Ghana vehicle registrations', () => {
    expect(vehicleSchema.parse({ registrationNumber: 'gr 1234-24', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available' }).registrationNumber).toBe('GR 1234-24');
    expect(vehicleSchema.parse({ registrationNumber: 'm-22-gr  1234', vehicleClass: 'motorbike', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available' }).registrationNumber).toBe('M-22-GR 1234');
    expect(vehicleSchema.safeParse({ registrationNumber: '!!', vehicleClass: 'car', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available' }).success).toBe(false);
    expect(vehicleSchema.safeParse({ registrationNumber: 'ABCDEF', vehicleClass: 'car', capacityKg: 20, homeServiceAreaId: 'accra', status: 'available' }).success).toBe(false);
  });
});

describe('business & bulk schemas', async () => {
  const { bulkCsvRowSchema, registerBusinessSchema, recordInvoicePaymentSchema } = await import('../src/index.js');
  const row = {
    reference: 'ORD-1001', recipient_name: 'Yaw Boateng', recipient_phone: '020 123 4567', recipient_email: '',
    address_line1: 'Adum Market', landmark: '', city: 'Kumasi', region: ' Ashanti ', ghanapost_gps: 'ak-039-5028',
    lat: '', lng: '', description: 'Shoes', weight_kg: '1.5', length_cm: '30', width_cm: '20', height_cm: '10',
    quantity: '', urgency: 'Same Day', special_handling: 'Fragile; liquid', declared_value_ghs: '', instructions: '',
  };
  it('converts CSV strings to typed values', () => {
    const r = bulkCsvRowSchema.parse(row);
    expect(r).toMatchObject({ recipient_phone: '+233201234567', region: 'Ashanti', ghanapost_gps: 'AK-039-5028', weight_kg: 1.5, urgency: 'same_day', special_handling: ['fragile', 'liquid'] });
    expect(r.quantity).toBeUndefined();
    expect(r.lat).toBeUndefined();
  });
  it('reports precise per-field errors', () => {
    const r = bulkCsvRowSchema.safeParse({ ...row, weight_kg: 'heavy', region: 'Lagos' });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(paths).toEqual(['region: Please choose an option', 'weight_kg: weight_kg must be a number']);
    // Cross-field checks run once the individual fields are valid.
    const half = bulkCsvRowSchema.safeParse({ ...row, lat: '5.6' });
    expect(half.error!.issues.map((i) => i.message)).toEqual(['Give both lat and lng, or neither']);
  });
  it('validates Ghana TINs and requires documents', () => {
    const addr = { line1: '1 Ring Road', city: 'Accra', region: 'Greater Accra', location: { lat: 5.57, lng: -0.21 } };
    const base = { legalName: 'Ama Styles Ltd', tradingName: 'Ama Styles', registrationNumber: 'cs123456789', tin: 'c0012345678', contact: { name: 'Ama', phone: '0241234567' }, billingAddress: addr, pickupAddress: addr, documentKeys: ['kyb/biz1/AbCdEfGhIj.pdf'] };
    expect(registerBusinessSchema.parse(base)).toMatchObject({ tin: 'C0012345678', registrationNumber: 'CS123456789' });
    expect(registerBusinessSchema.safeParse({ ...base, tin: '12345' }).success).toBe(false);
    expect(registerBusinessSchema.safeParse({ ...base, documentKeys: [] }).success).toBe(false);
    expect(registerBusinessSchema.safeParse({ ...base, documentKeys: ['pod/x/AbCdEfGhIj.jpg'] }).success).toBe(false);
  });
  it('requires positive invoice payments', () => {
    expect(recordInvoicePaymentSchema.safeParse({ invoiceId: 'inv1', amountPesewas: 0, method: 'bank_transfer', reference: 'TX1' }).success).toBe(false);
  });
});

describe('Phase 6 inputs', () => {
  it('expenses need a vehicle for fuel/maintenance and a hub for hub costs; driver pay is never entered by hand', async () => {
    const { expenseSchema } = await import('../src/index.js');
    const base = { description: 'Diesel for generator', amountPesewas: 20_000, incurredAt: '2026-11-19T09:00:00Z' };
    expect(expenseSchema.safeParse({ ...base, category: 'hub', hubId: 'acc-01' }).success).toBe(true);
    expect(expenseSchema.safeParse({ ...base, category: 'hub' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, category: 'fuel' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, category: 'driver_payment' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...base, category: 'other', amountPesewas: 0 }).success).toBe(false);
  });
  it('fuel logs need litres, an amount, a whole-km odometer and a receipt key in the receipt area', async () => {
    const { fuelLogSchema } = await import('../src/index.js');
    const ok = { litres: 5.5, amountPesewas: 8_000, odometerKm: 12_040, fullTank: true, receiptKey: 'receipt/kwame/AbCdEfGhIjKl.jpg' };
    expect(fuelLogSchema.safeParse(ok).success).toBe(true);
    expect(fuelLogSchema.safeParse({ ...ok, odometerKm: 12_040.5 }).success).toBe(false);
    expect(fuelLogSchema.safeParse({ ...ok, receiptKey: 'pod/GH1/AbCdEfGhIjKl.jpg' }).success).toBe(false);
    expect(fuelLogSchema.safeParse({ ...ok, litres: 0 }).success).toBe(false);
  });
  it('pay adjustments are non-zero; rejecting an expense needs a reason', async () => {
    const { payAdjustmentSchema, reviewExpenseSchema } = await import('../src/index.js');
    expect(payAdjustmentSchema.safeParse({ statementId: '2026-11_kwame', label: 'Bonus', amountPesewas: 0 }).success).toBe(false);
    expect(payAdjustmentSchema.safeParse({ statementId: '2026-11_kwame', label: 'Fuel advance', amountPesewas: -2_000 }).success).toBe(true);
    expect(reviewExpenseSchema.safeParse({ expenseId: 'exp_1', decision: 'rejected' }).success).toBe(false);
    expect(reviewExpenseSchema.safeParse({ expenseId: 'exp_1', decision: 'approved' }).success).toBe(true);
  });
});
