import { VEHICLE_CLASSES } from '@courier/constants';
import type { DriverDoc, VehicleDoc } from '@courier/shared-types';
import { collection, orderBy, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

export function FleetPage() {
  const { db } = getFirebase();
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), orderBy('name')), []);
  const vehicles = useQuery<VehicleDoc>(query(collection(db, 'vehicles'), orderBy('registrationNumber')), []);
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4">
      <h1 className="text-xl font-bold">Fleet</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Drivers</h2>
        <table className="card w-full p-0 text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Employee no.</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Shift</th>
            </tr>
          </thead>
          <tbody>
            {drivers.data.map((d) => (
              <tr key={d.uid} className="border-t border-slate-100">
                <td className="px-3 py-2">{d.name}{d.status === 'suspended' && <span className="ml-1 text-red-600">(suspended)</span>}</td>
                <td className="px-3 py-2">{d.employeeNumber}</td>
                <td className="px-3 py-2">{d.phone}</td>
                <td className="px-3 py-2">{d.homeServiceAreaId}</td>
                <td className="px-3 py-2">
                  {d.currentShift && new Date(d.currentShift.activeUntil) > new Date() ? `On shift · ${d.currentShift.vehicleClass}` : 'Off'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <NewDriverForm />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Vehicles</h2>
        <table className="card w-full p-0 text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Registration</th>
              <th className="px-3 py-2">Class</th>
              <th className="px-3 py-2">Capacity</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.data.map((v) => (
              <tr key={v.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono">{v.registrationNumber}</td>
                <td className="px-3 py-2">{v.vehicleClass}</td>
                <td className="px-3 py-2">{v.capacityKg} kg</td>
                <td className="px-3 py-2">{v.homeServiceAreaId}</td>
                <td className="px-3 py-2">
                  <VehicleStatus v={v} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <NewVehicleForm />
      </section>
    </div>
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

function NewDriverForm() {
  const [link, setLink] = useState<string | null>(null);
  const f = useForm({ name: '', phone: '', email: '', employeeNumber: '', homeServiceAreaId: 'accra' });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-3"
      onSubmit={f.submit(async () => {
        const r = await api.createDriverAccount(f.v);
        setLink(r.setupLink);
        return 'Driver created.';
      })}
    >
      <h3 className="font-semibold sm:col-span-3">Add driver</h3>
      {f.field('name', 'Full name')}
      {f.field('phone', 'Mobile number', { type: 'tel' })}
      {f.field('email', 'Email (sign-in)', { type: 'email' })}
      {f.field('employeeNumber', 'Employee number')}
      {f.field('homeServiceAreaId', 'Service area id')}
      <div className="flex items-end">
        <button className="btn-primary w-full" disabled={f.busy}>
          Create driver
        </button>
      </div>
      {f.msg && <p className="text-sm sm:col-span-3">{f.msg}</p>}
      {link && (
        <p className="break-all rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:col-span-3">
          Send this one-time link to the driver so they can set their own password (it expires): <span className="font-mono">{link}</span>
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
