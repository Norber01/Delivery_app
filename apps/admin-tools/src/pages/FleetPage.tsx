import { RIDER_TYPE_LABELS, RIDER_TYPES, VEHICLE_CLASSES } from '@courier/constants';
import type { DriverDoc, ServiceArea, VehicleDoc } from '@courier/shared-types';
import { collection, orderBy, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';
import { VehicleCare } from './VehicleCare';

export function FleetPage() {
  const { db } = getFirebase();
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), orderBy('name')), []);
  const vehicles = useQuery<VehicleDoc>(query(collection(db, 'vehicles'), orderBy('registrationNumber')), []);
  const areas = useQuery<ServiceArea>(query(collection(db, 'serviceAreas')), []);
  const [tab, setTab] = useState<'riders' | 'vehicles'>('riders');
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Riders & vehicles</h1>
        <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm" role="tablist">
          {(['riders', 'vehicles'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === t ? 'bg-accent-400 text-black' : 'text-slate-600'}`} onClick={() => setTab(t)}>
              {t === 'riders' ? 'Riders' : 'Vehicles'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'riders' ? (
        <RidersSection drivers={drivers.data} areas={areas.data} />
      ) : (
        <>
          <section className="space-y-3">
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Registration</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Capacity</th>
                    <th className="px-4 py-3">Area</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.data.map((v) => (
                    <tr key={v.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono">{v.registrationNumber}</td>
                      <td className="px-4 py-2.5">{v.vehicleClass}</td>
                      <td className="px-4 py-2.5">{v.capacityKg} kg</td>
                      <td className="px-4 py-2.5">{areas.data.find((a) => a.id === v.homeServiceAreaId)?.name ?? v.homeServiceAreaId}</td>
                      <td className="px-4 py-2.5">
                        <VehicleStatus v={v} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <NewVehicleForm />
          </section>
          <VehicleCare vehicles={vehicles.data} />
        </>
      )}
    </div>
  );
}

const TYPE_FILTERS = [
  ['all', 'All'],
  ['pickup', 'Pickup riders'],
  ['delivery', 'Delivery riders'],
] as const;

function RidersSection({ drivers, areas }: { drivers: (DriverDoc & { _id: string })[]; areas: ServiceArea[] }) {
  const [filter, setFilter] = useState<(typeof TYPE_FILTERS)[number][0]>('all');
  const [err, setErr] = useState<string | null>(null);
  const shown = drivers.filter((d) => filter === 'all' || d.riderType === filter || !d.riderType);
  const onShift = (d: DriverDoc) => d.currentShift && new Date(d.currentShift.activeUntil) > new Date();
  async function update(req: Parameters<typeof api.updateDriver>[0]) {
    setErr(null);
    try {
      await api.updateDriver(req);
    } catch (x) {
      setErr((x as ApiError).message);
    }
  }
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {TYPE_FILTERS.map(([k, label]) => (
          <button key={k} className={`chip px-3 py-1.5 text-sm ${filter === k ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 shadow-sm'}`} onClick={() => setFilter(k)}>
            {label} · {k === 'all' ? drivers.length : drivers.filter((d) => d.riderType === k).length}
          </button>
        ))}
      </div>
      {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Works as</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Area</th>
              <th className="px-4 py-3">Now</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.uid} className="border-t border-slate-100">
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{d.name}</span>
                  <span className="block text-xs text-slate-500">{d.employeeNumber}</span>
                </td>
                <td className="px-4 py-2.5">
                  <select
                    aria-label={`Rider type of ${d.name}`}
                    className="rounded-lg bg-field px-2 py-1"
                    value={d.riderType ?? ''}
                    onChange={(e) => void update({ uid: d.uid, riderType: e.target.value as 'pickup' | 'delivery' })}
                  >
                    {!d.riderType && <option value="">Pickup and delivery</option>}
                    {RIDER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {RIDER_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5">{d.phone}</td>
                <td className="px-4 py-2.5">{areas.find((a) => a.id === d.homeServiceAreaId)?.name ?? d.homeServiceAreaId}</td>
                <td className="px-4 py-2.5">
                  {d.status === 'suspended' ? (
                    <span className="chip bg-red-100 text-red-700">Suspended</span>
                  ) : onShift(d) ? (
                    <span className="chip bg-emerald-100 text-emerald-800">On shift · {d.currentShift?.vehicleClass}</span>
                  ) : (
                    <span className="chip bg-field text-slate-600">Off</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button className="text-xs font-semibold text-slate-500 hover:text-black" onClick={() => void update({ uid: d.uid, status: d.status === 'suspended' ? 'active' : 'suspended' })}>
                    {d.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NewDriverForm areas={areas} />
    </section>
  );
}

function VehicleStatus({ v }: { v: VehicleDoc }) {
  const [err, setErr] = useState<string | null>(null);
  if (v.status === 'in_use') return <span className="text-brand-700">In use</span>;
  return (
    <span>
      <select
        aria-label={`Status of ${v.registrationNumber}`}
        className="rounded border border-slate-300 px-1 py-0.5"
        value={v.status}
        onChange={async (e) => {
          setErr(null);
          try {
            await api.upsertVehicle({ ...v, status: e.target.value });
          } catch (x) {
            setErr((x as ApiError).message);
          }
        }}
      >
        <option value="available">Available</option>
        <option value="maintenance">Maintenance</option>
        <option value="retired">Retired</option>
      </select>
      {err && <span className="block text-xs text-red-600">{err}</span>}
    </span>
  );
}

function useForm<T extends Record<string, string>>(initial: T) {
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: keyof T & string, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input className="input" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} {...extra} />
      {errors[k] && <span className="text-xs text-red-600">{errors[k]}</span>}
    </label>
  );
  const submit = (fn: () => Promise<string>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setErrors({});
    try {
      setMsg(await fn());
      setV(initial);
    } catch (x) {
      setErrors((x as ApiError).fields ?? {});
      setMsg((x as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return { v, field, submit, msg, busy };
}

function NewDriverForm({ areas }: { areas: ServiceArea[] }) {
  const [link, setLink] = useState<string | null>(null);
  const [riderType, setRiderType] = useState<'pickup' | 'delivery'>('pickup');
  const [area, setArea] = useState('accra');
  const f = useForm({ name: '', phone: '', email: '', employeeNumber: '' });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={f.submit(async () => {
        const r = await api.createDriverAccount({ ...f.v, homeServiceAreaId: area, riderType });
        setLink(r.setupLink);
        return `${RIDER_TYPE_LABELS[riderType]} account created.`;
      })}
    >
      <h3 className="text-lg font-bold sm:col-span-2 lg:col-span-4">Add a rider</h3>
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="mb-1 text-sm font-medium">Works as</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {RIDER_TYPES.map((t) => (
            <label key={t} className={`flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ${riderType === t ? 'bg-brand-50 ring-brand-500' : 'ring-slate-200'}`}>
              <input type="radio" name="riderType" className="mt-1" checked={riderType === t} onChange={() => setRiderType(t)} />
              <span>
                <span className="block font-semibold">{RIDER_TYPE_LABELS[t]}</span>
                <span className="text-xs text-slate-600">{t === 'pickup' ? 'Collects parcels from senders and brings them to the warehouse.' : 'Takes parcels from the warehouse to the recipients.'}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {f.field('name', 'Full name')}
      {f.field('phone', 'Mobile number', { type: 'tel' })}
      {f.field('email', 'Email (to sign in)', { type: 'email' })}
      {f.field('employeeNumber', 'Staff number')}
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Area</span>
        <select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
          {(areas.length ? areas : [{ id: 'accra', name: 'accra' } as ServiceArea]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end lg:col-start-4">
        <button className="btn-primary w-full" disabled={f.busy}>
          Create rider account
        </button>
      </div>
      {f.msg && <p className="text-sm sm:col-span-2 lg:col-span-4">{f.msg}</p>}
      {link && (
        <p className="break-all rounded-xl bg-brand-50 px-3 py-2 text-sm sm:col-span-2 lg:col-span-4">
          Send this one-time link to the rider so they can set their own password (it expires): <span className="font-mono">{link}</span>
        </p>
      )}
    </form>
  );
}

function NewVehicleForm() {
  const [cls, setCls] = useState<(typeof VEHICLE_CLASSES)[number]>('motorbike');
  const f = useForm({ registrationNumber: '', capacityKg: '20', homeServiceAreaId: 'accra' });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-4"
      onSubmit={f.submit(async () => {
        await api.upsertVehicle({ ...f.v, capacityKg: Number(f.v.capacityKg), vehicleClass: cls, status: 'available' });
        return 'Vehicle saved.';
      })}
    >
      <h3 className="font-semibold sm:col-span-4">Add vehicle</h3>
      {f.field('registrationNumber', 'Registration')}
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Class</span>
        <select className="input" value={cls} onChange={(e) => setCls(e.target.value as typeof cls)}>
          {VEHICLE_CLASSES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {f.field('capacityKg', 'Capacity (kg)', { type: 'number', min: 1 })}
      {f.field('homeServiceAreaId', 'Service area id')}
      <button className="btn-primary sm:col-start-4" disabled={f.busy}>
        Save vehicle
      </button>
      {f.msg && <p className="text-sm sm:col-span-4">{f.msg}</p>}
    </form>
  );
}
