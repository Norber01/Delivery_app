import { describe, expect, it } from 'vitest';
import {
  canTransition,
  canonicalJson,
  findServiceArea,
  formatGhs,
  generateTrackingNumber,
  haversineKm,
  isValidTrackingNumber,
  normalizeTrackingNumber,
  percentOf,
  MapboxProvider,
  MapProviderError,
} from '../src/index.js';
import { LOCATIONS, areas } from './fixtures.js';

describe('money', () => {
  it('formats pesewas as cedis', () => {
    expect(formatGhs(123456)).toBe('GH₵ 1,234.56');
    expect(formatGhs(5)).toBe('GH₵ 0.05');
    expect(formatGhs(-250)).toBe('-GH₵ 2.50');
  });
  it('rounds percentages half away from zero', () => {
    expect(percentOf(3490, 15)).toBe(524);
    expect(percentOf(-3490, 15)).toBe(-524);
  });
});

describe('tracking numbers', () => {
  it('generates valid, well-formed numbers', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateTrackingNumber();
      expect(t).toMatch(/^GH[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(isValidTrackingNumber(t)).toBe(true);
    }
  });
  it('is deterministic for given randomness', () => {
    const t = generateTrackingNumber(() => new Uint8Array(10));
    expect(t.slice(0, 12)).toBe('GH0000000000');
  });
  it('normalises customer input and rejects typos', () => {
    const t = generateTrackingNumber(() => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const spaced = `${t.slice(0, 2)} ${t.slice(2, 7)}-${t.slice(7)}`.toLowerCase();
    expect(normalizeTrackingNumber(spaced)).toBe(t);
    const body = t.slice(2, 12);
    const check = t.slice(12);
    const typo = `GH${body.slice(0, 3)}${body[3] === 'A' ? 'B' : 'A'}${body.slice(4)}${check}`;
    expect(normalizeTrackingNumber(typo)).toBeNull();
    expect(normalizeTrackingNumber('XX123')).toBeNull();
  });
});

describe('tracking number check symbols', () => {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  it('detect every single substitution and adjacent transposition', () => {
    for (let n = 0; n < 40; n++) {
      const t = generateTrackingNumber();
      const body = t.slice(2, 12);
      const check = t.slice(12);
      for (let i = 0; i < 10; i++) {
        for (const c of ALPHABET) {
          if (c === body[i]) continue;
          expect(normalizeTrackingNumber(`GH${body.slice(0, i)}${c}${body.slice(i + 1)}${check}`)).toBeNull();
        }
        if (i < 9 && body[i] !== body[i + 1]) {
          const swapped = body.slice(0, i) + body[i + 1] + body[i] + body.slice(i + 2);
          expect(normalizeTrackingNumber(`GH${swapped}${check}`)).toBeNull();
        }
      }
    }
  });
});

describe('geo', () => {
  it('computes great-circle distance', () => {
    // Accra ↔ Kumasi ≈ 200 km straight line
    const d = haversineKm(LOCATIONS.osu, LOCATIONS.kumasiCentral);
    expect(d).toBeGreaterThan(190);
    expect(d).toBeLessThan(210);
  });
  it('finds the containing active service area', () => {
    expect(findServiceArea(LOCATIONS.madina, areas)?.id).toBe('accra');
    expect(findServiceArea(LOCATIONS.tamale, areas)).toBeNull(); // inactive
  });
});

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(canonicalJson({ a: { d: [1, 2] }, b: 1 }));
  });
});

describe('delivery lifecycle', () => {
  it('allows the intercity happy path', () => {
    const path = [
      'awaiting_assignment',
      'assigned',
      'en_route_to_pickup',
      'picked_up',
      'at_origin_hub',
      'in_transit',
      'at_destination_hub',
      'out_for_delivery',
      'delivered',
    ] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });
  it('blocks skipping custody steps and leaving terminal states', () => {
    expect(canTransition('awaiting_assignment', 'delivered')).toBe(false);
    expect(canTransition('at_origin_hub', 'out_for_delivery')).toBe(false);
    expect(canTransition('delivered', 'out_for_delivery')).toBe(false);
    expect(canTransition('picked_up', 'cancelled')).toBe(false);
  });
  it('returns from hold only to the previous status (or cancellation)', () => {
    expect(canTransition('in_transit', 'on_hold')).toBe(true);
    expect(canTransition('on_hold', 'in_transit', 'in_transit')).toBe(true);
    expect(canTransition('on_hold', 'delivered', 'in_transit')).toBe(false);
    expect(canTransition('delivered', 'on_hold')).toBe(false);
  });
});

describe('MapboxProvider', () => {
  it('parses directions and converts units', async () => {
    let calledUrl = '';
    const p = new MapboxProvider('tok', async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 8300, duration: 1200 }] }) };
    });
    const r = await p.route(LOCATIONS.osu, LOCATIONS.madina);
    expect(r).toEqual({ distanceKm: 8.3, durationMinutes: 20 });
    expect(calledUrl).toContain('/directions/v5/mapbox/driving/-0.1823,5.556;-0.1653,5.6681');
  });
  it('restricts geocoding to Ghana and maps features', async () => {
    let calledUrl = '';
    const p = new MapboxProvider('tok', async (url) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            {
              properties: { full_address: 'Oxford Street, Osu, Accra', context: { place: { name: 'Accra' }, region: { name: 'Greater Accra' } } },
              geometry: { coordinates: [-0.18, 5.55] },
            },
          ],
        }),
      };
    });
    const res = await p.geocode('Oxford Street');
    expect(calledUrl).toContain('country=gh');
    expect(res).toEqual([{ label: 'Oxford Street, Osu, Accra', location: { lat: 5.55, lng: -0.18 }, city: 'Accra', region: 'Greater Accra' }]);
  });
  it('raises MapProviderError on HTTP failure', async () => {
    const p = new MapboxProvider('tok', async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(p.route(LOCATIONS.osu, LOCATIONS.madina)).rejects.toBeInstanceOf(MapProviderError);
  });
});
