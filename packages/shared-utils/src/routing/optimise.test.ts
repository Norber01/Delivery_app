import { describe, expect, it } from 'vitest';
import { baselineOrder, estimateTravelSec, evaluateOrder, optimiseRoute, type PlanInput, type RouteStop } from './optimise.js';

const ACCRA = { lat: 5.6037, lng: -0.187 };
/** Deterministic pseudo-random generator so the comparison is repeatable. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
function scenario(seed: number, jobs: number, collected: number): PlanInput {
  const r = rng(seed);
  const near = () => ({ lat: ACCRA.lat + (r() - 0.5) * 0.25, lng: ACCRA.lng + (r() - 0.5) * 0.25 });
  const stops: RouteStop[] = [];
  for (let i = 0; i < jobs; i++) {
    if (i < collected) stops.push({ id: `d${i}`, location: near(), kind: 'drop' });
    else {
      stops.push({ id: `p${i}`, location: near(), kind: 'pickup' });
      stops.push({ id: `d${i}`, location: near(), kind: 'drop', after: `p${i}` });
    }
  }
  return { start: ACCRA, stops, departAt: Date.UTC(2026, 10, 19, 8), travelSec: estimateTravelSec('motorbike') };
}
const pos = (order: string[], id: string) => order.indexOf(id);

describe('route optimisation', () => {
  it('always collects a package before delivering it', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const input = scenario(seed, 8, 3);
      const plan = optimiseRoute(input);
      expect(plan.order).toHaveLength(input.stops.length);
      expect(new Set(plan.order).size).toBe(input.stops.length);
      for (const s of input.stops) if (s.after) expect(pos(plan.order, s.after)).toBeLessThan(pos(plan.order, s.id));
    }
  });

  it('beats the manual (assignment-order) baseline on travel time across 50 random runs', () => {
    let manual = 0;
    let optimised = 0;
    let neverWorse = true;
    for (let seed = 100; seed < 150; seed++) {
      const input = scenario(seed, 10, 4);
      const base = evaluateOrder(input, baselineOrder(input.stops))!;
      const plan = optimiseRoute(input);
      manual += base.travelSec;
      optimised += plan.travelSec;
      if (plan.cost > base.cost + 1e-6) neverWorse = false;
    }
    expect(neverWorse).toBe(true);
    // Typical saving on scattered city runs is large; require at least 25 % overall.
    expect(optimised).toBeLessThan(manual * 0.75);
  });

  it('finds the obvious order on a straight line', () => {
    const line = (k: number) => ({ lat: ACCRA.lat, lng: ACCRA.lng + k * 0.01 });
    const input: PlanInput = {
      start: line(0),
      stops: [5, 1, 4, 2, 3].map((k) => ({ id: `s${k}`, location: line(k), kind: 'drop' as const })),
      departAt: 0,
      travelSec: estimateTravelSec('car'),
    };
    expect(optimiseRoute(input).order).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('serves an urgent stop first even when it is a detour', () => {
    const input: PlanInput = {
      start: ACCRA,
      stops: [
        { id: 'near1', location: { lat: 5.605, lng: -0.188 }, kind: 'drop' },
        { id: 'near2', location: { lat: 5.607, lng: -0.189 }, kind: 'drop' },
        { id: 'urgent', location: { lat: 5.65, lng: -0.25 }, kind: 'drop', dueAt: Date.UTC(2026, 0, 1, 8, 33) },
      ],
      departAt: Date.UTC(2026, 0, 1, 8),
      travelSec: estimateTravelSec('motorbike'),
    };
    const plan = optimiseRoute(input);
    expect(plan.order[0]).toBe('urgent');
    expect(plan.lateSec).toBe(0);
  });

  it('handles empty and single-stop runs and rejects orders that break pickup-before-drop', () => {
    expect(optimiseRoute({ start: ACCRA, stops: [], departAt: 0, travelSec: () => 1 }).order).toEqual([]);
    const input = scenario(3, 1, 0);
    expect(optimiseRoute(input).order).toEqual(['p0', 'd0']);
    expect(evaluateOrder(input, ['d0', 'p0'])).toBeNull();
  });

  it('plans a busy 30-stop day quickly', () => {
    const input = scenario(7, 18, 6);
    const t0 = performance.now();
    optimiseRoute(input);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
