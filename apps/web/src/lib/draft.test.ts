import { quoteRequestSchema } from '@courier/validation';
import { describe, expect, it } from 'vitest';
import { draftToQuoteRequest, initialDraft } from './draft';

describe('draftToQuoteRequest', () => {
  it('produces a request the shared schema accepts', () => {
    const d = initialDraft();
    d.pickup = { ...d.pickup, line1: 'Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };
    d.destination = { ...d.destination, line1: 'Madina', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6681, lng: -0.1653 } };
    d.packages = [{ description: 'Laptop', weightKg: '2.5', lengthCm: '40', widthCm: '30', heightCm: '8', quantity: '1', declaredValueGhs: '4500.50' }];
    d.specialHandling = ['high_value'];
    const req = draftToQuoteRequest(d);
    expect(req.packages[0]!.declaredValuePesewas).toBe(450050);
    expect(quoteRequestSchema.safeParse(req).success).toBe(true);
  });

  it('is rejected by the schema while incomplete', () => {
    const r = quoteRequestSchema.safeParse(draftToQuoteRequest(initialDraft()));
    expect(r.success).toBe(false);
  });
});
