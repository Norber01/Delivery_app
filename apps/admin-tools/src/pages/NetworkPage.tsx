import type { HubDoc, ServiceArea } from '@courier/shared-types';
import { collection, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

/** Admin: each area's warehouse. */
export function NetworkPage() {
  const { db } = getFirebase();
  const hubs = useQuery<HubDoc>(query(collection(db, 'hubs')), []);
  const areas = useQuery<ServiceArea>(query(collection(db, 'serviceAreas')), []);
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Areas & warehouses</h1>
      <p className="max-w-2xl text-sm text-slate-600">
        Each area has one warehouse. Pickup riders bring parcels there, and delivery riders collect them from there. Without a warehouse, one rider takes a parcel door to door.
      </p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-4 py-3">Warehouse</th>
              <th className="px-4 py-3">Area</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Used for the area</th>
              <th className="px-4 py-3">Open</th>
            </tr>
          </thead>
          <tbody>
            {hubs.data.map((h) => (
              <tr key={h.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{h.name}</span>
                  <span className="block font-mono text-xs text-slate-500">{h.code}</span>
                </td>
                <td className="px-4 py-2.5">{areas.data.find((a) => a.id === h.serviceAreaId)?.name ?? h.serviceAreaId}</td>
                <td className="px-4 py-2.5">{h.address}</td>
                <td className="px-4 py-2.5">{h.primaryForArea ? 'Yes' : 'No'}</td>
                <td className="px-4 py-2.5">{h.active ? 'Yes' : 'Closed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <HubForm />
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
        return 'Warehouse saved.';
      })}
    >
      <h3 className="text-lg font-bold sm:col-span-4">Add or update a warehouse</h3>
      <Input label="Id (e.g. ksi-01)" value={v.id} onChange={set('id')} error={errors.id} />
      <Input label="Code (e.g. KSI-01)" value={v.code} onChange={set('code')} error={errors.code} />
      <Input label="Name" value={v.name} onChange={set('name')} error={errors.name} />
      <Input label="Area id (e.g. accra)" value={v.serviceAreaId} onChange={set('serviceAreaId')} error={errors.serviceAreaId} />
      <Input label="City" value={v.city} onChange={set('city')} error={errors.city} />
      <Input label="Address" value={v.address} onChange={set('address')} error={errors.address} />
      <Input label="Latitude" value={v.lat} onChange={set('lat')} inputMode="decimal" error={errors['location.lat']} />
      <Input label="Longitude" value={v.lng} onChange={set('lng')} inputMode="decimal" error={errors['location.lng']} />
      <label className="flex items-center gap-2 text-sm sm:col-span-3">
        <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> This is the area’s warehouse (orders in this area go through it)
      </label>
      <button className="btn-primary">Save warehouse</button>
      {msg && <p className="text-sm sm:col-span-4">{msg}</p>}
    </form>
  );
}
