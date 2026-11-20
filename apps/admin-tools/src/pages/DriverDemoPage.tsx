import type { DeliveryDoc, DriverDoc, RoutePlanDoc, VehicleDoc } from '@courier/shared-types';
import { formatGhs, PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

/** Provided by the demo runtime (demo builds only). */
export interface DemoApi {
  drivers: { uid: string; name: string; area: string; riderType?: 'pickup' | 'delivery' }[];
  callAs: <T>(uid: string, fn: string, data: unknown) => Promise<T>;
  signInRider: (email: string, password: string) => { uid: string; name: string };
  latestCode: (trackingNumber: string) => string | null;
}
export const demo = () => (window as unknown as { __courierDemo?: DemoApi }).__courierDemo;
const BUSY = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];
let n = 0;
const actionId = () => `demo-web-${Date.now()}-${++n}`.replace(/[^A-Za-z0-9_-]/g, '').padEnd(16, '0');

/**
 * Demo only: plays the driver's Android app in the browser so the whole flow can be shown —
 * start a shift, follow the planned stops, collect (with cash), deliver with the customer's code.
 */
export function DriverDemoPage() {
  const api = demo();
  const { db } = getFirebase();
  // From the database, so riders added on "Riders & vehicles" appear too.
  const riders = useQuery<DriverDoc>(query(collection(db, 'drivers'), where('status', '==', 'active')), []);
  const [uid, setUid] = useState(api?.drivers[0]?.uid ?? '');
  if (!api) return <p className="p-8 text-slate-600">This page only exists in the demo.</p>;
  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <div className="rounded-2xl bg-brand-50 p-3 text-sm">
        Demo: this screen stands in for the riders’ Android app (riders can also sign in on their own: demo bar → Sign in as… → Riders). Pick a rider and walk a parcel through: the pickup rider brings it to the warehouse, the delivery rider takes it to the recipient. The website and the Orders board update live.
      </div>
      <label className="block text-sm font-medium">
        Rider
        <select className="input mt-1" value={uid} onChange={(e) => setUid(e.target.value)} aria-label="Driver">
          {(riders.data.length ? riders.data.map((d) => ({ uid: d.uid, name: d.name, riderType: d.riderType, area: d.homeServiceAreaId })) : api.drivers).map((d) => (
            <option key={d.uid} value={d.uid}>
              {d.name} — {d.riderType === 'pickup' ? 'pickup rider' : d.riderType === 'delivery' ? 'delivery rider' : 'rider'} ({d.area})
            </option>
          ))}
        </select>
      </label>
      {uid && <DriverPhone key={uid} uid={uid} api={api} />}
    </main>
  );
}

export function DriverPhone({ uid, api, onSignOut }: { uid: string; api: DemoApi; onSignOut?: () => void }) {
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
    <section className="space-y-3 rounded-[2rem] border-[6px] border-black bg-page p-4 shadow-xl" aria-label="Driver phone">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-extrabold">{driver?.name ?? '…'}</h1>
          {driver?.riderType && <p className="text-xs font-semibold text-slate-500">{driver.riderType === 'pickup' ? 'Pickup rider' : 'Delivery rider'}</p>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`chip ${onShift ? 'bg-emerald-100 text-emerald-800' : 'bg-white text-slate-600'}`}>{onShift ? `On shift · ${driver?.currentShift?.vehicleClass}` : 'Off shift'}</span>
          {onSignOut && (
            <button className="text-xs font-semibold text-slate-500 underline-offset-2 hover:underline" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
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
          {sorted.length === 0 && <p className="rounded-2xl bg-white p-4 text-center text-sm text-slate-500">No jobs right now. Dispatch assigns them on the Orders screen.</p>}
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
  const leg = d.legs.find((l) => l.id === d.currentLegId)?.type;
  const toHub = leg === 'first_mile';
  const fromWarehouse = leg === 'last_mile';
  return (
    <article className="space-y-2 rounded-2xl bg-white p-4 text-sm shadow-sm" aria-label={`Job ${d.trackingNumber}`}>
      <div className="flex items-center gap-2">
        {seq && <span className="h-6 w-6 rounded-full bg-accent-400 text-center text-xs font-bold leading-6 text-black">{seq}</span>}
        <span className="font-semibold">{PUBLIC_STATUS_LABELS[d.status]}</span>
        <span className="ml-auto font-mono text-xs text-slate-500">{d.trackingNumber}</span>
      </div>
      {fromWarehouse ? (
        <p>
          Collect at <strong>{d.destinationHub?.name}</strong> → deliver to {d.recipient.name}, {d.destination.line1}
        </p>
      ) : (
        <p>
          Pick up from {d.sender.name}, {d.pickup.line1} → {toHub && d.originHub ? <strong>{d.originHub.name}</strong> : `${d.destination.line1}`}
        </p>
      )}
      {(d.status === 'assigned') && <button className="btn-accent w-full" disabled={busy} onClick={() => act(d, 'start_assignment', {}, 'On the way to the pickup.')}>Start — go to pickup</button>}
      {d.status === 'at_destination_hub' && <p className="rounded-xl bg-field px-3 py-2 text-slate-700">Go to {d.destinationHub?.name}. Warehouse staff scan the parcel to you (ops app → Warehouse → Give to rider).</p>}
      {d.status === 'en_route_to_pickup' && (
        <button className="btn-accent w-full" disabled={busy} onClick={() => act(d, 'confirm_pickup', { scannedCode: d.trackingNumber, cashCollected: d.collectOnPickupPesewas > 0 }, 'Collected.')}>
          Scan label & collect{d.collectOnPickupPesewas > 0 ? ` (take ${formatGhs(d.collectOnPickupPesewas)} cash)` : ''}
        </button>
      )}
      {d.status === 'picked_up' && toHub && <p className="rounded-xl bg-field px-3 py-2 text-slate-700">Take it to {d.originHub?.name}. Warehouse staff scan it in (ops app → Warehouse → Receive).</p>}
      {d.status === 'out_for_delivery' && (
        <div className="space-y-2">
          <p className="text-slate-600">Ask the recipient for the code they received by SMS{code ? ` — in the demo it is ${code}` : ''}.</p>
          <input className="input" placeholder="6-digit code" aria-label="Delivery code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} />
          <input className="input" placeholder="Received by" aria-label="Received by" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-accent w-full" disabled={busy} onClick={() => act(d, 'complete_delivery', { otp, receivedByName: name }, 'Delivered.')}>Complete delivery</button>
        </div>
      )}
    </article>
  );
}
