import type { HubDoc, RouteDoc } from '@courier/shared-types';
import { collection, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

/** Admin: hubs and intercity routes (prices for routes are set in pricing rules). */
export function NetworkPage() {
  const { db } = getFirebase();
  const hubs = useQuery<HubDoc>(query(collection(db, 'hubs')), []);
  const routes = useQuery<RouteDoc>(query(collection(db, 'routes')), []);
  const hubName = (id: string) => hubs.data.find((h) => h.id === id)?.code ?? id;
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4">
      <h1 className="text-xl font-bold">Network</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Hubs</h2>
        <table className="card w-full p-0 text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Primary</th>
              <th className="px-3 py-2">Active</th>
            </tr>
          </thead>
          <tbody>
            {hubs.data.map((h) => (
              <tr key={h.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono">{h.code}</td>
                <td className="px-3 py-2">{h.name}</td>
                <td className="px-3 py-2">{h.serviceAreaId}</td>
                <td className="px-3 py-2">{h.primaryForArea ? 'Yes' : ''}</td>
                <td className="px-3 py-2">{h.active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <HubForm />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Routes</h2>
        <table className="card w-full p-0 text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">From → to</th>
              <th className="px-3 py-2">Distance</th>
              <th className="px-3 py-2">Typical time</th>
              <th className="px-3 py-2">Departures</th>
            </tr>
          </thead>
          <tbody>
            {routes.data.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono">{r.code}</td>
                <td className="px-3 py-2">
                  {hubName(r.originHubId)} → {hubName(r.destinationHubId)}
                </td>
                <td className="px-3 py-2">{r.distanceKm} km</td>
                <td className="px-3 py-2">{Math.round(r.typicalDurationMinutes / 6) / 10} h</td>
                <td className="px-3 py-2">
                  {r.schedule.departureTimes.join(', ')} · days {r.schedule.daysOfWeek.join(',')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <RouteForm hubs={hubs.data} />
        <p className="text-xs text-slate-500">Customer prices for intercity routes are set per service-area pair in the pricing rules.</p>
      </section>
    </div>
  );
}

function useSubmit() {
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = (fn: () => Promise<string>) => async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErrors({});
    try {
      setMsg(await fn());
    } catch (x) {
      setErrors((x as ApiError).fields ?? {});
      setMsg((x as ApiError).message);
    }
  };
  return { msg, errors, run };
}

const Input = ({ label, value, onChange, error, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) => (
  <label className="block space-y-1 text-sm">
    <span className="font-medium">{label}</span>
    <input className="input" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    {error && <span className="text-xs text-red-600">{error}</span>}
  </label>
);

function HubForm() {
  const [v, setV] = useState({ id: '', code: '', name: '', serviceAreaId: '', city: '', address: '', lat: '', lng: '' });
  const [primary, setPrimary] = useState(true);
  const { msg, errors, run } = useSubmit();
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-4"
      onSubmit={run(async () => {
        await api.upsertHub({ id: v.id, code: v.code, name: v.name, type: 'hub', serviceAreaId: v.serviceAreaId, city: v.city, primaryForArea: primary, address: v.address, location: { lat: Number(v.lat), lng: Number(v.lng) }, active: true });
        return 'Hub saved.';
      })}
    >
      <h3 className="font-semibold sm:col-span-4">Add or update hub</h3>
      <Input label="Id (e.g. ksi-01)" value={v.id} onChange={set('id')} error={errors.id} />
      <Input label="Code (e.g. KSI-01)" value={v.code} onChange={set('code')} error={errors.code} />
      <Input label="Name" value={v.name} onChange={set('name')} error={errors.name} />
      <Input label="Service area id" value={v.serviceAreaId} onChange={set('serviceAreaId')} error={errors.serviceAreaId} />
      <Input label="City" value={v.city} onChange={set('city')} error={errors.city} />
      <Input label="Address" value={v.address} onChange={set('address')} error={errors.address} />
      <Input label="Latitude" value={v.lat} onChange={set('lat')} inputMode="decimal" error={errors['location.lat']} />
      <Input label="Longitude" value={v.lng} onChange={set('lng')} inputMode="decimal" error={errors['location.lng']} />
      <label className="flex items-center gap-2 text-sm sm:col-span-3">
        <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Primary hub for this service area (intercity parcels route through it)
      </label>
      <button className="btn-primary">Save hub</button>
      {msg && <p className="text-sm sm:col-span-4">{msg}</p>}
    </form>
  );
}

function RouteForm({ hubs }: { hubs: HubDoc[] }) {
  const [v, setV] = useState({ id: '', code: '', originHubId: '', destinationHubId: '', distanceKm: '', hours: '', times: '18:00' });
  const { msg, errors, run } = useSubmit();
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  const select = (k: 'originHubId' | 'destinationHubId', label: string) => (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <select className="input" value={v[k]} onChange={(e) => set(k)(e.target.value)}>
        <option value="">Choose…</option>
        {hubs.map((h) => (
          <option key={h.id} value={h.id}>
            {h.code} · {h.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="card grid gap-3 sm:grid-cols-4"
      onSubmit={run(async () => {
        await api.upsertRoute({
          id: v.id,
          code: v.code,
          originHubId: v.originHubId,
          destinationHubId: v.destinationHubId,
          distanceKm: Number(v.distanceKm),
          typicalDurationMinutes: Math.round(Number(v.hours) * 60),
          schedule: { daysOfWeek: [1, 2, 3, 4, 5, 6], departureTimes: v.times.split(',').map((t) => t.trim()) },
          active: true,
        });
        return 'Route saved.';
      })}
    >
      <h3 className="font-semibold sm:col-span-4">Add or update route</h3>
      <Input label="Id (e.g. acc-ksi)" value={v.id} onChange={set('id')} error={errors.id} />
      <Input label="Code (e.g. ACC-KSI)" value={v.code} onChange={set('code')} error={errors.code} />
      {select('originHubId', 'From hub')}
      {select('destinationHubId', 'To hub')}
      <Input label="Distance (km)" value={v.distanceKm} onChange={set('distanceKm')} inputMode="decimal" error={errors.distanceKm} />
      <Input label="Typical duration (hours)" value={v.hours} onChange={set('hours')} inputMode="decimal" error={errors.typicalDurationMinutes} />
      <Input label="Departure times (HH:MM, comma-separated)" value={v.times} onChange={set('times')} error={errors['schedule.departureTimes.0']} />
      <button className="btn-primary self-end">Save route</button>
      {msg && <p className="text-sm sm:col-span-4">{msg}</p>}
    </form>
  );
}
