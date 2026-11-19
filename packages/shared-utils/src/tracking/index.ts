import { TRACKING_DEFAULTS } from '@courier/constants';
import type { LatLng, LocationFreshness } from '@courier/shared-types';
import { haversineKm } from '../geo/distance.js';

export interface TrackingPolicy {
  intervalSeconds: number;
  minDistanceMeters: number;
  stationaryIntervalSeconds: number;
  stationarySpeedKph: number;
  stationaryAfterSeconds: number;
  maxAccuracyMeters: number;
  staleAfterSeconds: number;
}

export const DEFAULT_POLICY: TrackingPolicy = {
  intervalSeconds: TRACKING_DEFAULTS.intervalSeconds,
  minDistanceMeters: TRACKING_DEFAULTS.minDistanceMeters,
  stationaryIntervalSeconds: TRACKING_DEFAULTS.stationaryIntervalSeconds,
  stationarySpeedKph: TRACKING_DEFAULTS.stationarySpeedKph,
  stationaryAfterSeconds: TRACKING_DEFAULTS.stationaryAfterSeconds,
  maxAccuracyMeters: TRACKING_DEFAULTS.maxAccuracyMeters,
  staleAfterSeconds: TRACKING_DEFAULTS.staleAfterSeconds,
};

/** Clamp a configured interval into the allowed 30–60 s range. */
export function clampInterval(seconds: number): number {
  return Math.min(TRACKING_DEFAULTS.maxIntervalSeconds, Math.max(TRACKING_DEFAULTS.minIntervalSeconds, Math.round(seconds)));
}

/** live ≤ 2 × interval < delayed ≤ staleAfter < stale (docs/06 §6.4). */
export function locationFreshness(serverAtMs: number, nowMs: number, policy: Pick<TrackingPolicy, 'intervalSeconds' | 'staleAfterSeconds'> = DEFAULT_POLICY): LocationFreshness {
  const age = (nowMs - serverAtMs) / 1000;
  if (age <= policy.intervalSeconds * 2) return 'live';
  if (age <= policy.staleAfterSeconds) return 'delayed';
  return 'stale';
}

export interface Fix extends LatLng {
  accuracyM: number;
  speedKph?: number;
  /** Device time in ms. */
  at: number;
}

export interface SenderState {
  lastSent: Fix | null;
  /** Device time since which speed has been below the stationary threshold (null = moving). */
  stationarySince: number | null;
  /** Consecutive fixes rejected for poor accuracy. */
  poorAccuracyStreak: number;
}

export const initialSenderState = (): SenderState => ({ lastSent: null, stationarySince: null, poorAccuracyStreak: 0 });

/**
 * Decide whether a new GPS fix should be sent (docs/06 §6.3): time interval, early send on
 * distance moved, back-off while stationary, and rejection of inaccurate fixes unless no
 * better fix has arrived for 3 intervals.
 */
export function shouldSend(state: SenderState, fix: Fix, policy: TrackingPolicy = DEFAULT_POLICY): { send: boolean; next: SenderState } {
  const moving = fix.speedKph === undefined || fix.speedKph >= policy.stationarySpeedKph;
  const stationarySince = moving ? null : (state.stationarySince ?? fix.at);

  if (fix.accuracyM > policy.maxAccuracyMeters && state.poorAccuracyStreak < 3 && state.lastSent) {
    return { send: false, next: { ...state, stationarySince, poorAccuracyStreak: state.poorAccuracyStreak + 1 } };
  }
  const last = state.lastSent;
  if (!last) return { send: true, next: { lastSent: fix, stationarySince, poorAccuracyStreak: 0 } };

  const elapsed = (fix.at - last.at) / 1000;
  const movedM = haversineKm(last, fix) * 1000;
  const isStationary = stationarySince !== null && (fix.at - stationarySince) / 1000 >= policy.stationaryAfterSeconds;
  const interval = isStationary ? policy.stationaryIntervalSeconds : policy.intervalSeconds;
  const due = elapsed >= interval || (movedM >= policy.minDistanceMeters && elapsed >= 5);
  return due
    ? { send: true, next: { lastSent: fix, stationarySince, poorAccuracyStreak: 0 } }
    : { send: false, next: { ...state, stationarySince } };
}

/** Metres between two points. */
export const distanceMeters = (a: LatLng, b: LatLng) => haversineKm(a, b) * 1000;
