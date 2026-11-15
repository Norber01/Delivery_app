import type { DriverActionRequest } from '@courier/shared-types';
import { describe, expect, it } from 'vitest';
import { nextStep, newActionId, sortJobs } from './jobs';
import { LocationReporter, type LocationPayload } from './locationReporter';
import { ActionError, ActionQueue, toActionError, type KeyValueStorage } from './queue';
import { normaliseStrokes, signaturePointCount } from './signature';

class MemStorage implements KeyValueStorage {
  data = new Map<string, string>();
  async getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
const req = (id: string, type: DriverActionRequest['type'] = 'start_assignment'): DriverActionRequest => ({ actionId: id, type, deliveryId: 'GHX', occurredAt: '2026-11-15T10:00:00Z' });

describe('ActionQueue', () => {
  it('sends in order and keeps actions across restarts while offline', async () => {
    const storage = new MemStorage();
    let online = false;
    const sent: string[] = [];
    const deps = {
      storage,
      now: () => new Date('2026-11-15T10:00:00Z'),
      uploadPhoto: async () => 'k',
      send: async (r: DriverActionRequest) => {
        if (!online) throw new ActionError('offline', 'UNKNOWN', true);
        sent.push(r.actionId);
        return { actionId: r.actionId, deliveryId: r.deliveryId, status: 'en_route_to_pickup' as const, duplicate: false };
      },
    };
    const q1 = new ActionQueue(deps);
    await q1.enqueue(req('a1'));
    await q1.enqueue(req('a2', 'confirm_pickup'));
    await q1.process();
    expect(q1.snapshot().pending).toHaveLength(2);
    expect(q1.snapshot().pending[0]!.attempts).toBe(1);

    // App restarted, connection back.
    online = true;
    const q2 = new ActionQueue(deps);
    await q2.process();
    expect(sent).toEqual(['a1', 'a2']);
    expect(q2.snapshot().pending).toHaveLength(0);
  });

  it('moves business-rule rejections to failed and continues', async () => {
    const q = new ActionQueue({
      storage: new MemStorage(),
      now: () => new Date(),
      uploadPhoto: async () => 'k',
      send: async (r) => {
        if (r.actionId === 'bad') throw new ActionError('This delivery is not assigned to you.', 'NOT_ASSIGNED_TO_YOU', false);
        return { actionId: r.actionId, deliveryId: 'GHX', status: 'assigned', duplicate: false };
      },
    });
    await q.enqueue(req('bad'));
    await q.enqueue(req('good'));
    await q.process();
    const s = q.snapshot();
    expect(s.pending).toHaveLength(0);
    expect(s.failed).toEqual([expect.objectContaining({ code: 'NOT_ASSIGNED_TO_YOU' })]);
    await q.dismissFailed('bad');
    expect(q.snapshot().failed).toHaveLength(0);
  });

  it('uploads photos before sending and never re-uploads after a later failure', async () => {
    const uploads: string[] = [];
    let attempt = 0;
    const q = new ActionQueue({
      storage: new MemStorage(),
      now: () => new Date(),
      uploadPhoto: async (uri) => {
        uploads.push(uri);
        return `pod/GHX/${uri.replace(/\W/g, '')}aaaaaaaa.jpg`;
      },
      send: async (r) => {
        if (attempt++ === 0) throw new ActionError('timeout', 'deadline-exceeded', true);
        expect(r.photoKeys).toHaveLength(2);
        return { actionId: r.actionId, deliveryId: 'GHX', status: 'delivered', duplicate: false };
      },
    });
    await q.enqueue(req('d1', 'complete_delivery'), ['file1', 'file2']);
    await q.process();
    await q.process();
    expect(uploads).toEqual(['file1', 'file2']);
    expect(q.snapshot().pending).toHaveLength(0);
  });

  it('classifies callable errors', () => {
    expect(toActionError({ code: 'functions/failed-precondition', message: 'x', details: { code: 'INVALID_TRANSITION' } }).retryable).toBe(false);
    expect(toActionError({ code: 'functions/unavailable', message: 'x' }).retryable).toBe(true);
    expect(toActionError({ code: 'functions/failed-precondition', message: 'That code is not correct. [400]', details: { code: 'OTP_INVALID' } }).message).toBe('That code is not correct.');
    expect(toActionError(new TypeError('Network request failed')).retryable).toBe(true);
  });
});

describe('LocationReporter', () => {
  const shift = { shiftId: 's1', vehicleId: 'v1', activeUntilMs: 10_000_000 };
  it('applies the policy and keeps only the newest point while offline', async () => {
    const writes: LocationPayload[] = [];
    let online = true;
    const r = new LocationReporter({
      shift: () => shift,
      write: async (p) => {
        if (!online) throw new Error('offline');
        writes.push(p);
      },
    });
    const fix = (s: number, lat = 5.6) => ({ lat, lng: -0.18, accuracyM: 8.4, speedKph: 30, at: s * 1000 });
    expect(await r.onFix(fix(0))).toBe('sent');
    expect(await r.onFix(fix(10))).toBe('skipped');
    online = false;
    expect(await r.onFix(fix(50))).toBe('queued');
    online = true;
    expect(await r.onFix(fix(55, 5.6001))).toBe('sent'); // newest fix sent immediately after reconnect
    expect(writes.map((w) => w.recordedAt)).toEqual([0, 55_000]);
    expect(writes[0]).toMatchObject({ shiftId: 's1', accuracyM: 8 });
  });

  it('stops when there is no active shift', async () => {
    const r = new LocationReporter({ shift: () => ({ ...shift, activeUntilMs: 1000 }), write: async () => {} });
    expect(await r.onFix({ lat: 5.6, lng: -0.18, accuracyM: 5, at: 2000 })).toBe('no_shift');
  });
});

describe('jobs & signatures', () => {
  it('orders jobs with packages in hand first', () => {
    const jobs = sortJobs([
      { status: 'assigned' as const, expectedDeliveryAt: '2026-11-15T12:00:00Z' },
      { status: 'out_for_delivery' as const, expectedDeliveryAt: '2026-11-16T12:00:00Z' },
      { status: 'en_route_to_pickup' as const, expectedDeliveryAt: '2026-11-15T09:00:00Z' },
    ]);
    expect(jobs.map((j) => j.status)).toEqual(['out_for_delivery', 'en_route_to_pickup', 'assigned']);
    expect(nextStep({ status: 'en_route_to_pickup', collectOnPickupPesewas: 100 })).toContain('Collect payment');
    expect(nextStep({ status: 'picked_up', collectOnPickupPesewas: 0, originHub: { id: 'a', code: 'ACC-01', name: 'Accra Central Hub', city: 'Accra', location: { lat: 0, lng: 0 } } })).toBe('Take the package to Accra Central Hub');
  });
  it('makes 32-char hex action ids', () => {
    expect(newActionId((n) => new Uint8Array(n).fill(171))).toBe('ab'.repeat(16));
  });
  it('normalises and thins signature strokes', () => {
    const raw = [Array.from({ length: 200 }, (_, i) => ({ x: i * 0.5, y: 50 })), [{ x: 500, y: -10 }]];
    const s = normaliseStrokes(raw, 400, 100);
    expect(signaturePointCount(s)).toBeLessThan(60);
    expect(s[1]).toEqual([[1, 0]]);
  });
});
