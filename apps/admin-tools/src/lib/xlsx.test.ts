import { describe, expect, it } from 'vitest';
import { buildXlsx, crc32 } from './xlsx';

describe('xlsx writer', () => {
  it('writes a valid stored ZIP with one worksheet per sheet', () => {
    const bytes = buildXlsx([
      { name: 'Orders', columns: ['Tracking', 'Price (GH₵)'], rows: [['GH1', 61.3], ['<b>&"x"', null]] },
      { name: 'A/B:[weird]*name that is far too long for excel', columns: ['x'], rows: [] },
    ]);
    const text = new TextDecoder().decode(bytes);
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(text).toContain('xl/worksheets/sheet2.xml');
    expect(text).toContain('<c r="B2"><v>61.3</v></c>');
    expect(text).toContain('&lt;b&gt;&amp;&quot;x&quot;');
    expect(text).toContain('name="A B  weird  name that is far to"');
    expect(text).toContain('GH₵');
  });
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
