import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, parseCsvObjects, priceShipment, toCsv } from '../src/index.js';
import { rules, small } from './fixtures.js';

describe('CSV', () => {
  it('parses quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const text = '﻿name,address\r\n"Mensah, Ama","Flat 2\nOsu"\r\nKofi,"He said ""hi"""\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'address'],
      ['Mensah, Ama', 'Flat 2\nOsu'],
      ['Kofi', 'He said "hi"'],
    ]);
  });
  it('keys rows by normalised headers and fills missing cells', () => {
    const { headers, rows } = parseCsvObjects('Recipient Name,Weight-KG\nAma,2\nKofi\n');
    expect(headers).toEqual(['recipient_name', 'weight_kg']);
    expect(rows).toEqual([{ recipient_name: 'Ama', weight_kg: '2' }, { recipient_name: 'Kofi', weight_kg: '' }]);
  });
  it('round-trips and neutralises formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    const out = toCsv(['a', 'b'], [['x,y', 'plain']]);
    expect(parseCsv(out)).toEqual([['a', 'b'], ['x,y', 'plain']]);
  });
});

describe('batch bulk discount', () => {
  it('uses the batch item count for the tier', () => {
    const base = { deliveryType: 'intra_city' as const, distanceKm: 5, distanceSource: 'route' as const, packages: [small], urgency: 'standard' as const, specialHandling: [] };
    expect(priceShipment(rules, base).discountPesewas).toBe(0);
    const q = priceShipment(rules, { ...base, bulkQuantity: 60 });
    expect(q.lines.find((l) => l.code === 'DISCOUNT_BULK')!.label).toBe('Bulk discount (10%)');
  });
});
