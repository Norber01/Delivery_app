import { describe, expect, it } from 'vitest';
import type { PackageInfo, PricingRuleSet } from '@courier/shared-types';
import {
  PricingError,
  chargeableWeightKg,
  classifyDelivery,
  priceShipment,
  weightCharge,
  type PricingInput,
} from '../src/index.js';
import { LOCATIONS, areas, rules, small } from './fixtures.js';

const base: PricingInput = {
  deliveryType: 'intra_city',
  distanceKm: 8.3,
  distanceSource: 'route',
  packages: [small],
  urgency: 'standard',
  specialHandling: [],
};
const amounts = (q: ReturnType<typeof priceShipment>) => Object.fromEntries(q.lines.map((l) => [l.code, l.amountPesewas]));
const withRules = (patch: Partial<PricingRuleSet>): PricingRuleSet => ({ ...rules, ...patch });
const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PricingError);
    expect((e as PricingError).code).toBe(code);
    return;
  }
  throw new Error(`expected PricingError ${code}`);
};

describe('chargeable weight', () => {
  it('uses volumetric weight when larger and rounds up to 0.1 kg', () => {
    // 35×25×15 / 5000 = 2.625 → 2.7
    expect(chargeableWeightKg([small], 5000)).toBe(2.7);
  });
  it('uses actual weight when larger and multiplies by quantity', () => {
    const p: PackageInfo = { ...small, weightKg: 4, quantity: 3 };
    expect(chargeableWeightKg([p], 5000)).toBe(12);
  });
});

describe('weight bands', () => {
  it('charges nothing up to the included weight', () => {
    expect(weightCharge(rules, 5)).toBe(0);
  });
  it('charges across bands', () => {
    // 15 kg @ 1.00 + 10 kg @ 0.50
    expect(weightCharge(rules, 30)).toBe(2000);
  });
});

describe('intra-city pricing', () => {
  it('prices a small parcel by motorbike with distance beyond the included km', () => {
    const q = priceShipment(rules, base);
    expect(q.vehicleClass).toBe('motorbike');
    expect(q.distanceKm).toBe(8.3);
    expect(amounts(q)).toEqual({ TRANSPORT: 2500, DISTANCE: 990 });
    expect(q.totalPesewas).toBe(3490);
    expect(q.pricingVersion).toBe(3);
    expect(Object.is(q.discountPesewas, 0)).toBe(true); // never -0

  });

  it('upgrades the vehicle for heavier loads and applies weight, urgency and handling fees', () => {
    const q = priceShipment(rules, {
      ...base,
      distanceKm: 4,
      urgency: 'express',
      specialHandling: ['fragile'],
      packages: [{ ...small, weightKg: 30, lengthCm: 50, widthCm: 40, heightCm: 40 }],
    });
    expect(q.vehicleClass).toBe('car');
    expect(amounts(q)).toEqual({ TRANSPORT: 4500, WEIGHT: 2000, URGENCY_EXPRESS: 1950, HANDLING_FRAGILE: 500 });
    expect(q.totalPesewas).toBe(8950);
  });

  it('applies the urgency minimum when the percentage is smaller', () => {
    const q = priceShipment(rules, { ...base, distanceKm: 2, urgency: 'same_day' });
    // base 2500 × 50% = 1250 < 2000 minimum
    expect(amounts(q).URGENCY_SAME_DAY).toBe(2000);
  });

  it('selects a larger vehicle for long items even when light', () => {
    const q = priceShipment(rules, { ...base, packages: [{ ...small, weightKg: 1, lengthCm: 100, widthCm: 10, heightCm: 10 }] });
    expect(q.vehicleClass).toBe('car');
  });

  it('rejects shipments no enabled vehicle can carry', () => {
    expectCode(() => priceShipment(rules, { ...base, packages: [{ ...small, weightKg: 1000, quantity: 2 }] }), 'NO_SUITABLE_VEHICLE');
  });

  it('requires a distance', () => {
    expectCode(() => priceShipment(rules, { ...base, distanceKm: null }), 'DISTANCE_UNAVAILABLE');
  });
});

describe('discounts, minimum and taxes', () => {
  it('applies bulk then contract discount, capped at the maximum', () => {
    const q = priceShipment(rules, {
      ...base,
      distanceKm: 5,
      packages: [{ ...small, weightKg: 0.5, lengthCm: 10, widthCm: 10, heightCm: 10, quantity: 60 }],
      contract: { contractId: 'c1', discountPercent: 15 },
    });
    expect(q.vehicleClass).toBe('car'); // 30 kg
    expect(amounts(q)).toMatchObject({ TRANSPORT: 4500, WEIGHT: 2000, DISCOUNT_BULK: -650, DISCOUNT_CONTRACT: -650 });
    expect(q.discountPesewas).toBe(1300);
    expect(q.totalPesewas).toBe(5200);
  });

  it('does not discount handling fees', () => {
    const q = priceShipment(rules, {
      ...base,
      distanceKm: 5,
      specialHandling: ['perishable'],
      contract: { contractId: 'c1', discountPercent: 10 },
    });
    expect(amounts(q)).toMatchObject({ TRANSPORT: 2500, HANDLING_PERISHABLE: 800, DISCOUNT_CONTRACT: -250 });
    expect(q.totalPesewas).toBe(3050);
  });

  it('tops up to the minimum charge', () => {
    const q = priceShipment(withRules({ minimumChargePesewas: 5000 }), base);
    expect(amounts(q).MINIMUM_CHARGE).toBe(1510);
    expect(q.totalPesewas).toBe(5000);
  });

  it('applies configured taxes to the discounted subtotal', () => {
    const q = priceShipment(withRules({ taxes: [{ code: 'VAT', label: 'VAT', percent: 15 }] }), base);
    expect(amounts(q).TAX_VAT).toBe(524); // 3490 × 15% = 523.5 → 524
    expect(q.taxPesewas).toBe(524);
    expect(q.totalPesewas).toBe(4014);
  });

  it('charges high-value cover as a percentage of declared value', () => {
    const q = priceShipment(rules, {
      ...base,
      specialHandling: ['high_value'],
      packages: [{ ...small, declaredValuePesewas: 200_000 }],
    });
    expect(amounts(q)).toMatchObject({ HANDLING_HIGH_VALUE: 1000, HIGH_VALUE_COVER: 2000 });
  });
});

describe('intercity and long-distance pricing', () => {
  const route = rules.intercity.routes[0]!;
  const intercity: PricingInput = {
    ...base,
    deliveryType: 'intercity',
    distanceKm: null,
    route,
    packages: [{ ...small, weightKg: 6, lengthCm: 30, widthCm: 30, heightCm: 30, quantity: 2 }],
  };

  it('uses the fixed route price plus first/last mile and extra weight', () => {
    const q = priceShipment(rules, intercity);
    expect(amounts(q)).toEqual({ TRANSPORT: 6000, FIRST_MILE: 1500, LAST_MILE: 1500, WEIGHT: 1400 });
    expect(q.totalPesewas).toBe(10400);
    expect(q.distanceSource).toBe('fixed_route');
    expect(q.vehicleClass).toBeNull();
    expect(q.intercityServiceLevel).toBe('Next day');
  });

  it('honours contract route overrides', () => {
    const q = priceShipment(rules, {
      ...intercity,
      contract: { contractId: 'c', discountPercent: 0, routeBaseOverrides: { 'accra->kumasi': 4000 } },
    });
    expect(amounts(q).TRANSPORT).toBe(4000);
  });

  it('does not offer same-day outside a city', () => {
    expectCode(() => priceShipment(rules, { ...intercity, urgency: 'same_day' }), 'SAME_DAY_NOT_AVAILABLE');
  });

  it('prices long distance by km', () => {
    const q = priceShipment(rules, { ...base, deliveryType: 'long_distance', distanceKm: 150 });
    expect(amounts(q).TRANSPORT).toBe(5000 + 150 * 250);
  });

  it('applies the long-distance minimum', () => {
    const q = priceShipment(rules, { ...base, deliveryType: 'long_distance', distanceKm: 10 });
    expect(amounts(q).TRANSPORT).toBe(15000);
  });

  it('rejects distances beyond the long-distance limit', () => {
    expectCode(() => priceShipment(rules, { ...base, deliveryType: 'long_distance', distanceKm: 900 }), 'DISTANCE_LIMIT_EXCEEDED');
  });
});

describe('classifyDelivery', () => {
  it('classifies same-area trips as intra-city', () => {
    expect(classifyDelivery(rules, areas, LOCATIONS.osu, LOCATIONS.madina).deliveryType).toBe('intra_city');
  });
  it('classifies routed area pairs as intercity in both directions', () => {
    const a = classifyDelivery(rules, areas, LOCATIONS.osu, LOCATIONS.kumasiCentral);
    expect(a.deliveryType).toBe('intercity');
    expect(a.route?.originAreaId).toBe('accra');
    expect(classifyDelivery(rules, areas, LOCATIONS.kumasiCentral, LOCATIONS.osu).deliveryType).toBe('intercity');
  });
  it('falls back to long distance for unrouted destinations', () => {
    const c = classifyDelivery(rules, areas, LOCATIONS.osu, LOCATIONS.capeCoast);
    expect(c.deliveryType).toBe('long_distance');
    expect(c.destinationArea).toBeNull();
  });
  it('rejects pickups outside active service areas', () => {
    expectCode(() => classifyDelivery(rules, areas, LOCATIONS.tamale, LOCATIONS.osu), 'PICKUP_NOT_SERVICED');
  });
  it('rejects unrouted destinations when long distance is disabled', () => {
    const r = withRules({ longDistance: { ...rules.longDistance, enabled: false } });
    expectCode(() => classifyDelivery(r, areas, LOCATIONS.osu, LOCATIONS.capeCoast), 'DESTINATION_NOT_SERVICED');
  });
});

describe('pricing invariants', () => {
  it('total always equals the sum of lines and respects the minimum (randomised)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ruleSet = withRules({ taxes: [{ code: 'VAT', label: 'VAT', percent: 15 }, { code: 'NHIL', label: 'NHIL', percent: 2.5 }] });
    for (let i = 0; i < 500; i++) {
      const input: PricingInput = {
        ...base,
        distanceKm: rnd() * 40,
        urgency: (['standard', 'express', 'same_day'] as const)[Math.floor(rnd() * 3)]!,
        specialHandling: rnd() > 0.5 ? ['fragile', 'liquid'] : [],
        packages: [
          {
            ...small,
            weightKg: 0.1 + rnd() * 15,
            lengthCm: 5 + rnd() * 50,
            widthCm: 5 + rnd() * 50,
            heightCm: 5 + rnd() * 50,
            quantity: 1 + Math.floor(rnd() * 3),
          },
        ],
        contract: rnd() > 0.7 ? { contractId: 'x', discountPercent: Math.floor(rnd() * 30) } : null,
      };
      let q;
      try {
        q = priceShipment(ruleSet, input);
      } catch (e) {
        expect((e as PricingError).code).toBe('NO_SUITABLE_VEHICLE');
        continue;
      }
      expect(q.lines.reduce((s, l) => s + l.amountPesewas, 0)).toBe(q.totalPesewas);
      expect(Number.isInteger(q.totalPesewas)).toBe(true);
      expect(q.subtotalPesewas - q.discountPesewas).toBeGreaterThanOrEqual(ruleSet.minimumChargePesewas);
      expect(q).toEqual(priceShipment(ruleSet, input)); // deterministic
    }
  });
});
