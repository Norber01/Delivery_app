import { describe, expect, it } from 'vitest';
import { demoReady, theDb, withClock } from '../src/runtime/core.js';
import { allPositions } from '../src/runtime/live.js';
import { keepDriversOnShift } from '../src/runtime/start.js';
import { callAs } from '../src/runtime/wiring.js';
import type { FinanceReport } from '@courier/shared-types';

describe('demo sample data', () => {
  it('builds a consistent business through the real services', async () => {
    const t0 = Date.now();
    await demoReady();
    const ms = Date.now() - t0;
    const db = theDb();
    const count = (c: string) => db.list(c).length;
    console.log(`seeded in ${ms} ms:`, ['deliveryRequests', 'deliveries', 'payments', 'invoices', 'expenses', 'driverPayments', 'shifts', 'fuelLogs', 'notifications'].map((c) => `${c}=${count(c)}`).join(' '));
    expect(count('deliveryRequests')).toBeGreaterThan(40);
    expect(count('invoices')).toBe(1);
    expect(db.list('driverPayments').filter(([, s]) => s.status === 'paid')).toHaveLength(2);
    const statuses = db.list('deliveries').map(([, d]) => d.status);
    expect(statuses).toContain('out_for_delivery');
    expect(statuses).toContain('awaiting_assignment');
    expect(statuses).toContain('at_origin_hub');
    expect((db.get('routePlans/d_kwame') as { stops: unknown[] }).stops.length).toBeGreaterThan(1);

    for (const period of [new Date().toISOString().slice(0, 7), new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7)]) {
      const r = await callAs<FinanceReport>('d_finance', 'getFinanceReport', { period, refresh: true });
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.revenue.bookedPesewas).toBeGreaterThan(0);
      expect(r.byArea[0]?.label).toBe('Greater Accra (Accra–Tema)');
    }
  });

  it('lets the demo customer see their bookings and the business owner their invoice', async () => {
    const r = await callAs<{ month: string; bookings: number }>('d_adwoa', 'getBusinessReport', { month: new Date().toISOString().slice(0, 7) });
    expect(r.bookings).toBeGreaterThan(0);
    await expect(callAs('d_ama', 'getFinanceReport', { period: '2026-11' })).rejects.toMatchObject({ code: 'functions/permission-denied' });
  });

  it('puts the sample drivers back on shift when the demo is opened again the next day', async () => {
    const tomorrow = new Date(Date.now() + 20 * 3600_000);
    const onShift = (uid: string) => {
      const s = (theDb().get(`drivers/${uid}`) as { currentShift?: { activeUntil: string } | null }).currentShift;
      return !!s && Date.parse(s.activeUntil) > tomorrow.getTime();
    };
    expect(onShift('d_kwame')).toBe(false);
    await withClock(tomorrow, async () => {
      expect(Object.keys(allPositions())).toEqual([]);
      await keepDriversOnShift();
      expect(Object.keys(allPositions()).sort()).toEqual(['d_esi', 'd_kojo', 'd_kwame']);
    });
    expect(['d_kwame', 'd_esi', 'd_kojo'].every(onShift)).toBe(true);
    expect(onShift('d_yaw')).toBe(false); // was never on shift in the sample data
  });
});
