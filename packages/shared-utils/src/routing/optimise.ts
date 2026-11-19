import type { LatLng } from '@courier/shared-types';
import { haversineKm } from '../geo/distance.js';

/**
 * Multi-stop route planning for one driver (Phase 6).
 *
 * A driver's run mixes pickups and drops; a drop whose package has not been collected yet must
 * come after its pickup. The planner minimises travel time plus a penalty for arriving after a
 * stop's due time, starting from the driver's position. It builds a greedy route and improves it
 * with moves that keep every pickup before its drop (relocate one stop, reverse a segment) until
 * nothing improves. Runs of up to ~60 stops plan in milliseconds, so it runs inside a function
 * call with no external optimisation service.
 */
export interface RouteStop {
  id: string;
  location: LatLng;
  kind: 'pickup' | 'drop';
  /** For drops: the pickup stop that must come first (absent when already collected). */
  after?: string;
  /** Epoch ms the stop should be reached by. */
  dueAt?: number;
  /** Time spent at the stop, seconds (default 300). */
  serviceSec?: number;
}

export interface PlanInput {
  start: LatLng;
  stops: RouteStop[];
  departAt: number;
  /** Seconds to drive from a to b. */
  travelSec: (a: LatLng, b: LatLng) => number;
  /** Cost of one second of lateness relative to one second of driving (default 10: a promised time matters far more than a few extra minutes of driving). */
  latePenalty?: number;
}

export interface PlanResult {
  order: string[];
  travelSec: number;
  lateSec: number;
  cost: number;
  /** Epoch ms of arrival at each stop. */
  arrivals: Record<string, number>;
}

const DEFAULT_SERVICE_SEC = 300;

/** Road speed estimate when no routing matrix is used: straight line × 1.35, by vehicle class. */
export function estimateTravelSec(vehicleClass: 'motorbike' | 'car' | 'van' | 'truck' = 'car') {
  const kmh = { motorbike: 24, car: 20, van: 18, truck: 16 }[vehicleClass];
  return (a: LatLng, b: LatLng) => Math.round(((haversineKm(a, b) * 1.35) / kmh) * 3600);
}

function compile(input: PlanInput) {
  const n = input.stops.length;
  const points = [input.start, ...input.stops.map((s) => s.location)];
  const t: number[][] = points.map((a) => points.map((b) => (a === b ? 0 : input.travelSec(a, b))));
  const index = new Map(input.stops.map((s, i) => [s.id, i + 1]));
  const pred = input.stops.map((s) => (s.after && index.has(s.after) ? index.get(s.after)! : 0));
  const penalty = input.latePenalty ?? 10;
  /** Route = list of point indexes (1..n). */
  const evaluate = (route: number[]) => {
    let at = input.departAt;
    let prev = 0;
    let travel = 0;
    let late = 0;
    const seen = new Uint8Array(n + 1);
    for (const p of route) {
      if (pred[p - 1] && !seen[pred[p - 1]!]) return null; // drop before its pickup
      travel += t[prev]![p]!;
      at += t[prev]![p]! * 1000;
      const due = input.stops[p - 1]!.dueAt;
      if (due !== undefined && at > due) late += (at - due) / 1000;
      at += (input.stops[p - 1]!.serviceSec ?? DEFAULT_SERVICE_SEC) * 1000;
      seen[p] = 1;
      prev = p;
    }
    return { travel, late, cost: travel + penalty * late };
  };
  return { n, t, pred, evaluate };
}

function result(input: PlanInput, route: number[], ev: { travel: number; late: number; cost: number }): PlanResult {
  const arrivals: Record<string, number> = {};
  let at = input.departAt;
  let prev = input.start;
  for (const p of route) {
    const s = input.stops[p - 1]!;
    at += input.travelSec(prev, s.location) * 1000;
    arrivals[s.id] = at;
    at += (s.serviceSec ?? DEFAULT_SERVICE_SEC) * 1000;
    prev = s.location;
  }
  return { order: route.map((p) => input.stops[p - 1]!.id), travelSec: ev.travel, lateSec: Math.round(ev.late), cost: ev.cost, arrivals };
}

/** Cost of visiting the stops in the given order (e.g. the order a dispatcher would follow). */
export function evaluateOrder(input: PlanInput, order: string[]): PlanResult | null {
  const c = compile(input);
  const index = new Map(input.stops.map((s, i) => [s.id, i + 1]));
  const route = order.map((id) => index.get(id)!);
  const ev = c.evaluate(route);
  return ev ? result(input, route, ev) : null;
}

/**
 * The "manual" order: stops in the order they were given (assignment order), with each pickup
 * pulled in front of its drop. Used as the baseline the optimiser is compared against.
 */
export function baselineOrder(stops: RouteStop[]): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const ids = new Set(stops.map((s) => s.id));
  const byId = new Map(stops.map((s) => [s.id, s]));
  const visit = (s: RouteStop) => {
    if (done.has(s.id)) return;
    if (s.after && ids.has(s.after)) visit(byId.get(s.after)!);
    done.add(s.id);
    out.push(s.id);
  };
  stops.forEach(visit);
  return out;
}

export function optimiseRoute(input: PlanInput, opts: { maxPasses?: number } = {}): PlanResult {
  const c = compile(input);
  if (c.n === 0) return { order: [], travelSec: 0, lateSec: 0, cost: 0, arrivals: {} };

  // Greedy start: repeatedly go to the cheapest eligible stop (lateness-aware).
  const greedy = (): number[] => {
    const route: number[] = [];
    const seen = new Uint8Array(c.n + 1);
    let prev = 0;
    let at = input.departAt;
    for (let k = 0; k < c.n; k++) {
      let best = -1;
      let bestScore = Infinity;
      for (let p = 1; p <= c.n; p++) {
        if (seen[p] || (c.pred[p - 1] && !seen[c.pred[p - 1]!])) continue;
        const arrive = at + c.t[prev]![p]! * 1000;
        const due = input.stops[p - 1]!.dueAt;
        const score = c.t[prev]![p]! + (input.latePenalty ?? 10) * (due !== undefined && arrive > due ? (arrive - due) / 1000 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      route.push(best);
      seen[best] = 1;
      at += (c.t[prev]![best]! + (input.stops[best - 1]!.serviceSec ?? DEFAULT_SERVICE_SEC)) * 1000;
      prev = best;
    }
    return route;
  };

  const improve = (start: number[]) => {
    let route = start;
    let best = c.evaluate(route)!;
    const maxPasses = opts.maxPasses ?? 50;
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      // Relocate one stop.
      for (let i = 0; i < route.length && !improved; i++) {
        for (let j = 0; j < route.length; j++) {
          if (i === j) continue;
          const cand = route.slice();
          const [moved] = cand.splice(i, 1);
          cand.splice(j, 0, moved!);
          const ev = c.evaluate(cand);
          if (ev && ev.cost < best.cost - 1e-6) {
            route = cand;
            best = ev;
            improved = true;
            break;
          }
        }
      }
      // Reverse a segment (2-opt).
      for (let i = 0; i < route.length - 1 && !improved; i++) {
        for (let j = i + 1; j < route.length; j++) {
          const cand = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
          const ev = c.evaluate(cand);
          if (ev && ev.cost < best.cost - 1e-6) {
            route = cand;
            best = ev;
            improved = true;
            break;
          }
        }
      }
      if (!improved) break;
    }
    return { route, ev: best };
  };

  const index = new Map(input.stops.map((s, i) => [s.id, i + 1]));
  const starts = [greedy(), baselineOrder(input.stops).map((id) => index.get(id)!)];
  const dueSorted = baselineOrder([...input.stops].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))).map((id) => index.get(id)!);
  starts.push(dueSorted);
  let winner: { route: number[]; ev: { travel: number; late: number; cost: number } } | null = null;
  for (const s of starts) {
    const r = improve(s);
    if (!winner || r.ev.cost < winner.ev.cost) winner = r;
  }
  return result(input, winner!.route, winner!.ev);
}
