import { describe, expect, it } from 'vitest';
import { clampInterval, initialSenderState, locationFreshness, shouldSend, type Fix, type SenderState } from '../src/index.js';

const at = (s: number) => s * 1000;
const fix = (s: number, lat = 5.6, extra: Partial<Fix> = {}): Fix => ({ lat, lng: -0.18, accuracyM: 10, speedKph: 30, at: at(s), ...extra });
// ~111 m per 0.001° of latitude
const run = (fixes: Fix[]) => {
  let st: SenderState = initialSenderState();
  return fixes.map((f) => {
    const r = shouldSend(st, f);
    st = r.next;
    return r.send;
  });
};

describe('location freshness', () => {
  it('classifies live, delayed and stale', () => {
    expect(locationFreshness(0, at(80))).toBe('live');
    expect(locationFreshness(0, at(100))).toBe('delayed');
    expect(locationFreshness(0, at(601))).toBe('stale');
  });
  it('clamps intervals to 30–60 s', () => {
    expect(clampInterval(5)).toBe(30);
    expect(clampInterval(90)).toBe(60);
    expect(clampInterval(45)).toBe(45);
  });
});

describe('send policy', () => {
  it('sends the first fix and then every interval', () => {
    expect(run([fix(0), fix(10), fix(30), fix(45), fix(60), fix(90)])).toEqual([true, false, false, true, false, true]);
  });
  it('sends early after moving 100 m', () => {
    expect(run([fix(0, 5.6), fix(10, 5.6012)])).toEqual([true, true]);
  });
  it('backs off to 3 minutes when stationary for 5 minutes', () => {
    const still = (s: number) => fix(s, 5.6, { speedKph: 0 });
    const sends = run([still(0), still(45), still(90), still(135), still(180), still(225), still(270), still(315), still(360), still(405), still(450), still(495)]);
    // Interval sending until 5 min stationary, then only every 180 s.
    expect(sends.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(sends.slice(7)).toEqual([false, false, false, true, false]); // 315..495 s; sent at 450 (180 s after 270)
  });
  it('drops inaccurate fixes unless nothing better arrives for 3 intervals', () => {
    const bad = (s: number) => fix(s, 5.6, { accuracyM: 500 });
    expect(run([fix(0), bad(45), bad(90), bad(135), bad(180)])).toEqual([true, false, false, false, true]);
  });
});
