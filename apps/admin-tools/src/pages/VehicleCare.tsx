import { MAINTENANCE_TYPES } from '@courier/constants';
import type { FuelLog, MaintenanceRecord, VehicleDoc } from '@courier/shared-types';
import { formatGhs, fuelStats, maintenanceStatus } from '@courier/shared-utils';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { cedis, uploadReceipt } from '../lib/receipt';
import { useQuery } from '../lib/useLive';

const BADGE = { ok: 'bg-green-100 text-green-800', due_soon: 'bg-amber-100 text-amber-900', overdue: 'bg-red-100 text-red-800' } as const;
const LABEL = { ok: 'OK', due_soon: 'Due soon', overdue: 'Action needed' } as const;
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');

/** Service schedules, legal documents, maintenance history and fuel economy per vehicle. */
export function VehicleCare({ vehicles }: { vehicles: (VehicleDoc & { _id: string })[] }) {
  const { db } = getFirebase();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const fuel = useQuery<FuelLog>(query(collection(db, 'fuelLogs'), where('filledAt', '>=', since), orderBy('filledAt', 'desc'), limit(1000)), []);
  const [open, setOpen] = useState<string | null>(null);
  const now = new Date();
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Vehicle care</h2>
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Vehicle</th>
              <th className="px-3 py-2">Odometer</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Fuel (90 days)</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => {
              const m = maintenanceStatus(v, now);
              const f = fuelStats(fuel.data.filter((x) => x.vehicleId === v.id));
              return (
                <tr key={v.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 font-mono">{v.registrationNumber}</td>
                  <td className="px-3 py-2 tabular-nums">{v.odometerKm != null ? `${v.odometerKm.toLocaleString()} km` : '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${BADGE[m.state]}`}>{LABEL[m.state]}</span>
                    {m.reasons.map((r) => (
                      <span key={r} className="block text-xs text-slate-600">{r}</span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {f.litres ? (
                      <>
                        {f.litres} L · {formatGhs(f.spendPesewas)}
                        {f.kmPerLitre !== null && <span className="block">{f.kmPerLitre} km/L</span>}
                        {f.costPerKmPesewas !== null && <span className="block">{formatGhs(f.costPerKmPesewas)}/km</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="text-brand-700 hover:underline" onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? 'Close' : 'Manage'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && <VehiclePanel key={open} v={vehicles.find((v) => v.id === open)!} />}
    </section>
  );
}

function VehiclePanel({ v }: { v: VehicleDoc }) {
  const { db } = getFirebase();
  const history = useQuery<MaintenanceRecord>(query(collection(db, 'maintenance'), where('vehicleId', '==', v.id), orderBy('performedAt', 'desc'), limit(10)), [v.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sched, setSched] = useState({ km: String(v.serviceIntervalKm ?? ''), days: String(v.serviceIntervalDays ?? ''), insurance: day(v.insuranceExpiry), roadworthy: day(v.roadworthyExpiry) });
  const [work, setWork] = useState({ type: 'service', description: '', cost: '', odometer: String(v.odometerKm ?? ''), date: new Date().toISOString().slice(0, 10), vendor: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(f: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      const x = e as ApiError;
      setMsg({ ok: false, text: [x.message, ...Object.values(x.fields ?? {})].join(' ') });
    } finally {
      setBusy(false);
    }
  }
  const iso = (d: string) => (d ? new Date(`${d}T23:59:59Z`).toISOString() : null);
  const saveSchedule = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () => api.setVehicleSchedule({ vehicleId: v.id, serviceIntervalKm: sched.km ? Number(sched.km) : null, serviceIntervalDays: sched.days ? Number(sched.days) : null, insuranceExpiry: iso(sched.insurance), roadworthyExpiry: iso(sched.roadworthy) }),
      'Schedule saved.',
    );
  };
  const saveWork = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const receiptKey = file ? await uploadReceipt(file) : undefined;
      await api.recordMaintenance({
        vehicleId: v.id,
        type: work.type,
        description: work.description,
        costPesewas: cedis(work.cost || '0'),
        odometerKm: work.odometer ? Number(work.odometer) : null,
        performedAt: new Date(`${work.date}T12:00:00Z`).toISOString(),
        ...(work.vendor ? { vendor: work.vendor } : {}),
        ...(receiptKey ? { receiptKey } : {}),
      });
      setWork({ ...work, description: '', cost: '', vendor: '' });
      setFile(null);
    }, 'Recorded. The cost was sent to finance for approval.');
  };
  return (
    <div className="card grid gap-6 text-sm lg:grid-cols-3" aria-label={`Manage ${v.registrationNumber}`}>
      <form onSubmit={saveSchedule} className="space-y-2">
        <h3 className="font-semibold">Schedule & documents — {v.registrationNumber}</h3>
        <label className="block">Service every (km)<input className="input mt-1" inputMode="numeric" value={sched.km} onChange={(e) => setSched({ ...sched, km: e.target.value })} /></label>
        <label className="block">…or every (days)<input className="input mt-1" inputMode="numeric" value={sched.days} onChange={(e) => setSched({ ...sched, days: e.target.value })} /></label>
        <label className="block">Insurance expires<input className="input mt-1" type="date" value={sched.insurance} onChange={(e) => setSched({ ...sched, insurance: e.target.value })} /></label>
        <label className="block">Roadworthy expires<input className="input mt-1" type="date" value={sched.roadworthy} onChange={(e) => setSched({ ...sched, roadworthy: e.target.value })} /></label>
        <p className="text-xs text-slate-500">Drivers cannot start a shift on a vehicle with expired insurance or roadworthiness.</p>
        <button className="btn-primary" disabled={busy}>Save schedule</button>
      </form>
      <form onSubmit={saveWork} className="space-y-2">
        <h3 className="font-semibold">Record maintenance</h3>
        <label className="block">Type
          <select className="input mt-1" value={work.type} onChange={(e) => setWork({ ...work, type: e.target.value })}>
            {MAINTENANCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">What was done<input className="input mt-1" value={work.description} onChange={(e) => setWork({ ...work, description: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">Cost (GH₵)<input className="input mt-1" inputMode="decimal" value={work.cost} onChange={(e) => setWork({ ...work, cost: e.target.value })} /></label>
          <label className="block">Odometer (km)<input className="input mt-1" inputMode="numeric" value={work.odometer} onChange={(e) => setWork({ ...work, odometer: e.target.value })} /></label>
          <label className="block">Date<input className="input mt-1" type="date" value={work.date} onChange={(e) => setWork({ ...work, date: e.target.value })} /></label>
          <label className="block">Garage<input className="input mt-1" value={work.vendor} onChange={(e) => setWork({ ...work, vendor: e.target.value })} /></label>
        </div>
        <label className="block">Receipt (photo or PDF)<input className="mt-1 block" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <button className="btn-primary" disabled={busy}>Record</button>
      </form>
      <div className="space-y-2">
        <h3 className="font-semibold">History</h3>
        {msg && <p role="status" className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}
        <ul className="space-y-1 text-slate-600">
          {history.data.length === 0 && <li>No maintenance recorded.</li>}
          {history.data.map((m) => (
            <li key={m._id}>
              {day(m.performedAt)} · <span className="font-medium">{m.type}</span> · {m.description} · {formatGhs(m.costPesewas)}
              {m.odometerKm != null && ` · ${m.odometerKm.toLocaleString()} km`}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
