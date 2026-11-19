import { DEFAULT_POLICY, initialSenderState, shouldSend, type Fix, type SenderState, type TrackingPolicy } from '@courier/shared-utils';

export interface LocationPayload {
  lat: number;
  lng: number;
  accuracyM: number;
  speedKph?: number;
  heading?: number;
  recordedAt: number;
  shiftId: string;
  vehicleId: string;
}

export interface ReporterDeps {
  /** Write the latest position (RTDB REST in the app). Throws when offline. */
  write: (p: LocationPayload) => Promise<void>;
  shift: () => { shiftId: string; vehicleId: string; activeUntilMs: number } | null;
  policy?: TrackingPolicy;
}

/**
 * Applies the send policy to raw GPS fixes. Offline: only the newest unsent point is kept
 * (RTDB stores the current position only), and it is retried with the next fix.
 */
export class LocationReporter {
  private state: SenderState = initialSenderState();
  private unsent: LocationPayload | null = null;
  constructor(private readonly deps: ReporterDeps) {}

  async onFix(fix: Fix & { heading?: number }): Promise<'sent' | 'skipped' | 'queued' | 'no_shift'> {
    const shift = this.deps.shift();
    if (!shift || shift.activeUntilMs <= fix.at) return 'no_shift';
    const decision = shouldSend(this.state, fix, this.deps.policy ?? DEFAULT_POLICY);
    const payload: LocationPayload = {
      lat: +fix.lat.toFixed(6),
      lng: +fix.lng.toFixed(6),
      accuracyM: Math.round(fix.accuracyM),
      ...(fix.speedKph !== undefined ? { speedKph: Math.max(0, Math.round(fix.speedKph)) } : {}),
      ...(fix.heading !== undefined && fix.heading >= 0 ? { heading: Math.round(fix.heading) % 360 } : {}),
      recordedAt: fix.at,
      shiftId: shift.shiftId,
      vehicleId: shift.vehicleId,
    };
    // After a failed write, send the newest fix as soon as it arrives.
    if (!decision.send && !this.unsent) {
      this.state = decision.next;
      return 'skipped';
    }
    try {
      await this.deps.write(payload);
      this.unsent = null;
      this.state = { lastSent: fix, stationarySince: decision.next.stationarySince, poorAccuracyStreak: 0 };
      return 'sent';
    } catch {
      // Offline: remember only the newest point; delivery state is not advanced.
      this.unsent = payload;
      this.state = { ...this.state, stationarySince: decision.next.stationarySince };
      return 'queued';
    }
  }
}
