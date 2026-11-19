import type { DeliveryDoc, DriverDoc, RoutePlanDoc, VehicleDoc } from '@courier/shared-types';
import { formatGhs, PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

/** Provided by the demo runtime (demo builds only). */
interface DemoApi {
  drivers: { uid: string; name: string; area: string }[];
  callAs: <T>(uid: string, fn: string, data: unknown) => Promise<T>;
  latestCode: (trackingNumber: string) => string | null;
}
const demo = () => (window as unknown as { __courierDemo?: DemoApi }).__courierDemo;
const BUSY = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];
let n = 0;
const actionId = () => `demo-web-${Date.now()}-${++n}`.replace(/[^A-Za-z0-9_-]/g, '').padEnd(16, '0');

/**
 * Demo only: plays the driver's Android app in the browser so the whole flow can be shown —
 * start a shift, follow the planned stops, collect (with cash), deliver with the customer's code.
 */
export function DriverDemoPage() {
  const api = demo();
  const [uid, setUid] = useState(api?.drivers[0]?.uid ?? '');
  if (!api) return <p className="p-8 text-slate-600">This page only exists in the demo.</p>;
  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Demo: this screen stands in for the driver’s Android app. Pick a driver and walk a parcel through pickup and delivery — the website’s tracking page and the dispatch board update live.
      </div>
      <label className="block text-sm">
        Driver
        <select className="input mt-1" value={uid} onChange={(e) => setUid(e.target.value)} aria-label="Driver">
          {api.drivers.map((d) => <option key={d.uid} value={d.uid}>{d.name} ({d.area})</option>)}
        </select>
      </label>
      {uid && <DriverPhone key={uid} uid={uid} api={api} />}
    </main>
  );
}

function DriverPhone({ uid, api }: { uid: string; api: DemoApi }) {
  const { db } = getFirebase();
  const [driver, setDriver] = useState<DriverDoc | null>(null);
  const [plan, setPlan] = useState<RoutePlanDoc | null>(null);
  useEffect(() => onSnapshot(doc(db, 'drivers', uid), (s) => setDriver(s.exists() ? (s.data() as DriverDoc) : null)), [db, uid]);
  useEffect(() => onSnapshot(doc(db, 'routePlans', uid), (s) => setPlan(s.exists() ? (s.data() as RoutePlanDoc) : null)), [db, uid]);
  const jobs = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('currentDriverUid', '==', uid), where('status', 'in', BUSY)), [uid]);
  const vehicles = useQuery<VehicleDoc>(query(collection(db, 'vehicles'), where('status', '==', 'available')), []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [odo, setOdo] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const onShift = !!driver?.currentShift && Date.parse(driver.currentShift.activeUntil) > Date.now();

  async function run(fn: string, data: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api.callAs(uid, fn, data);
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const act = (d: DeliveryDoc, type: string, extra: Record<string, unknown>, ok: string) =>
    run('driverAction', { actionId: actionId(), deliveryId: d.id, type, occurredAt: new Date().toISOString(), ...extra }, ok);

  const order = new Map((plan?.stops ?? []).map((s) => [s.deliveryId, s.seq] as const).reverse());
  const sorted = [...jobs.data].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  return (
    <section className="space-y-3 rounded-2xl border-4 border-slate-800 bg-white p-4 shadow-lg" aria-label="Driver phone">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{driver?.name ?? '…'}</h1>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${onShift ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>{onShift ? `On shift · ${driver?.currentShift?.vehicleClass}` : 'Off shift'}</span>
      </header>
      {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      {!onShift ? (
        <div className="space-y-2 text-sm">
          <label className="block">Vehicle
            <select className="input mt-1" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Choose…</option>
              {vehicles.data.map((v) => <option key={v.id} value={v.id}>{v.registrationNumber} · {v.vehicleClass}{v.odometerKm ? ` · ${v.odometerKm.toLocaleString()} km` : ''}</option>)}
            </select>
          </label>
          <label className="block">Odometer now (km)<input className="input mt-1" inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} /></label>
          <button className="btn-primary w-full" disabled={busy || !vehicleId} onClick={() => run('startShift', { vehicleId, odometerKm: Number(odo) || undefined }, 'Shift started. Location sharing is on.')}>Start shift</button>
        </div>
      ) : (
        <>
          {sorted.length > 1 && (
            <button className="btn-secondary w-full" disabled={busy} onClick={() => run('planDriverRoute', {}, 'Route planned.')}>
              {plan ? `Re-plan my route (${plan.travelMinutes} min now)` : 'Plan my route'}
            </button>
          )}
          {sorted.length === 0 && <p className="text-sm text-slate-500">No jobs. Assign one from Dispatch.</p>}
          {sorted.map((d) => <Job key={d.id} d={d} seq={order.get(d.id)} code={api.latestCode(d.trackingNumber)} busy={busy} act={act} />)}
          <div className="space-y-2 border-t border-slate-100 pt-3 text-sm">
            <label className="block">Odometer at end of shift (km)<input className="input mt-1" inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} /></label>
            <button className="btn-secondary w-full" disabled={busy} onClick={() => run('endShift', { odometerKm: Number(odo) || undefined }, 'Shift ended.')}>End shift</button>
          </div>
        </>
      )}
    </section>
  );
}

function Job({ d, seq, code, busy, act }: { d: DeliveryDoc; seq?: number; code: string | null; busy: boolean; act: (d: DeliveryDoc, type: string, extra: Record<string, unknown>, ok: string) => void }) {
  const [otp, setOtp] = useState('');
  const [name, setName] = useState(d.recipient.name);
  const toHub = d.legs.find((l) => l.id === d.currentLegId)?.type === 'first_mile';
  return (
    <article className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm" aria-label={`Job ${d.trackingNumber}`}>
      <div className="flex items-center gap-2">
        {seq && <span className="h-6 w-6 rounded-full bg-brand-600 text-center text-xs leading-6 text-white">{seq}</span>}
        <span className="font-semibold">{PUBLIC_STATUS_LABELS[d.status]}</span>
        <span className="ml-auto font-mono text-xs text-slate-500">{d.trackingNumber}</span>
      </div>
      <p>From {d.pickup.line1}, {d.pickup.city} → {toHub && d.originHub ? d.originHub.name : `${d.destination.line1}, ${d.destination.city}`}</p>
      {(d.status === 'assigned') && <button className="btn-primary w-full" disabled={busy} onClick={() => act(d, 'start_assignment', {}, 'On the way to the pickup.')}>Start — go to pickup</button>}
      {d.status === 'en_route_to_pickup' && (
        <button className="btn-primary w-full" disabled={busy} onClick={() => act(d, 'confirm_pickup', { scannedCode: d.trackingNumber, cashCollected: d.collectOnPickupPesewas > 0 }, 'Collected.')}>
          Scan label & collect{d.collectOnPickupPesewas > 0 ? ` (take ${formatGhs(d.collectOnPickupPesewas)} cash)` : ''}
        </button>
      )}
      {d.status === 'picked_up' && toHub && <p className="text-slate-600">Take it to {d.originHub?.name}. Hub staff scan it in (ops app → Hub).</p>}
      {d.status === 'out_for_delivery' && (
        <div className="space-y-2">
          <p className="text-slate-600">Ask the recipient for the code they received by SMS{code ? ` — in the demo it is ${code}` : ''}.</p>
          <input className="input" placeholder="6-digit code" aria-label="Delivery code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} />
          <input className="input" placeholder="Received by" aria-label="Received by" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary w-full" disabled={busy} onClick={() => act(d, 'complete_delivery', { otp, receivedByName: name }, 'Delivered.')}>Complete delivery</button>
        </div>
      )}
    </article>
  );
}
