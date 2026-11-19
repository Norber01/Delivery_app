import type { DriverDoc, RoutePlanDoc } from '@courier/shared-types';
import { collection, orderBy, query } from 'firebase/firestore';
import { useState } from 'react';
import { api, type ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useNow, useQuery } from '../lib/useLive';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' });

/** Plan each on-shift driver's stops in the best order; drivers see the same plan in their app. */
export function RoutesPage() {
  const { db } = getFirebase();
  const now = useNow(60_000);
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), orderBy('name')), []);
  const plans = useQuery<RoutePlanDoc>(collection(db, 'routePlans'), []);
  const onShift = drivers.data.filter((d) => d.currentShift && Date.parse(d.currentShift.activeUntil) > now);
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold">Routes</h1>
        <p className="text-sm text-slate-600">
          Plan the order of each driver’s pickups and drops: every package is collected before it is delivered, promised times come first, then the shortest driving. Re-plan after assigning new jobs.
        </p>
      </div>
      {drivers.error && <p className="text-sm text-red-700">{drivers.error}</p>}
      {onShift.length === 0 && <p className="card text-sm text-slate-500">No drivers on shift.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {onShift.map((d) => (
          <DriverRoute key={d.uid} driver={d} plan={plans.data.find((p) => p.driverUid === d.uid) ?? null} />
        ))}
      </div>
    </main>
  );
}

function DriverRoute({ driver, plan }: { driver: DriverDoc; plan: RoutePlanDoc | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function replan() {
    setBusy(true);
    setErr(null);
    try {
      await api.planDriverRoute(driver.uid);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card space-y-3 text-sm" aria-label={`Route for ${driver.name}`}>
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{driver.name}</h2>
          <p className="text-slate-500">{driver.currentShift?.vehicleClass} · {driver.homeServiceAreaId}</p>
        </div>
        <button className="btn-primary py-1" onClick={replan} disabled={busy}>{busy ? 'Planning…' : plan ? 'Re-plan' : 'Plan route'}</button>
      </header>
      {err && <p className="text-red-700">{err}</p>}
      {plan && (
        <>
          <p className="rounded bg-brand-50 px-3 py-2 text-brand-800" role="status">
            {plan.stops.length ? (
              <>
                {plan.stops.length} stops · about <strong>{plan.travelMinutes} min</strong> driving
                {plan.baselineMinutes > plan.travelMinutes && <> (vs {plan.baselineMinutes} min in assignment order — {plan.savingPercent}% less)</>}
                {plan.lateStops > 0 && <span className="text-red-700"> · {plan.lateStops} stop(s) will be late</span>}
              </>
            ) : (
              'No open jobs.'
            )}
          </p>
          <ol className="divide-y divide-slate-100">
            {plan.stops.map((s) => (
              <li key={`${s.deliveryId}-${s.kind}`} className="flex gap-3 py-1.5">
                <span className={`mt-0.5 h-6 w-6 shrink-0 rounded-full text-center text-xs leading-6 text-white ${s.kind === 'pickup' ? 'bg-amber-500' : 'bg-brand-600'}`}>{s.seq}</span>
                <span className="flex-1">
                  {s.label}
                  <span className="block font-mono text-xs text-slate-500">{s.deliveryId}</span>
                </span>
                <span className={`text-right tabular-nums ${s.late ? 'font-semibold text-red-700' : 'text-slate-600'}`}>
                  {time(s.eta)}
                  {s.dueAt && <span className="block text-xs text-slate-400">due {time(s.dueAt)}</span>}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-slate-400">
            Planned {time(plan.computedAt)} from {plan.startFrom === 'live_location' ? 'the driver’s live position' : 'the first stop (no recent GPS)'}. Driving times are estimates.
          </p>
        </>
      )}
    </section>
  );
}
