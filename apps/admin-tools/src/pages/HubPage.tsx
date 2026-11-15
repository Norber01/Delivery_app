import type { DeliveryDoc, DriverDoc, HubDoc, ManifestDoc, RouteDoc, VehicleDoc } from '@courier/shared-types';
import { collection, query, where } from 'firebase/firestore';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

type Delivery = DeliveryDoc & { _id: string };
type Manifest = ManifestDoc & { _id: string };
interface ScanLog {
  at: number;
  ok: boolean;
  text: string;
}

/**
 * Hub operations: receive parcels, hand them to last-mile drivers, and run linehaul manifests.
 * Scan inputs accept keyboard-wedge barcode scanners (they type the code and press Enter).
 */
export function HubPage() {
  const { db } = getFirebase();
  const { role, hubIds } = useStaffAuth();
  const allHubs = useQuery<HubDoc>(query(collection(db, 'hubs'), where('active', '==', true)), []);
  const hubs = allHubs.data.filter((h) => role !== 'hub_operator' || hubIds.includes(h.id));
  const [hubId, setHubId] = useState<string>('');
  useEffect(() => {
    if (!hubId && hubs[0]) setHubId(hubs[0].id);
  }, [hubId, hubs]);
  const hub = hubs.find((h) => h.id === hubId);

  if (allHubs.data.length > 0 && hubs.length === 0) return <p className="p-6 text-slate-600">You are not assigned to any hub. Ask an administrator.</p>;
  if (!hub) return <p className="p-6 text-slate-500">Loading hubs…</p>;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Hub</h1>
        <select className="input w-auto" aria-label="Hub" value={hubId} onChange={(e) => setHubId(e.target.value)}>
          {hubs.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name} ({h.code})
            </option>
          ))}
        </select>
      </div>
      <HubWorkspace key={hub.id} hub={hub} />
    </div>
  );
}

function HubWorkspace({ hub }: { hub: HubDoc }) {
  const { db } = getFirebase();
  const onHand = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('custodian.id', '==', hub.id), where('status', 'in', ['at_origin_hub', 'at_destination_hub', 'delivery_failed'])), [hub.id]);
  const incomingFirstMile = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('originHub.id', '==', hub.id), where('status', '==', 'picked_up')), [hub.id]);
  const inbound = useQuery<ManifestDoc>(query(collection(db, 'manifests'), where('destinationHubId', '==', hub.id), where('status', 'in', ['departed', 'arrived'])), [hub.id]);
  const outbound = useQuery<ManifestDoc>(query(collection(db, 'manifests'), where('originHubId', '==', hub.id), where('status', 'in', ['open', 'sealed'])), [hub.id]);
  const routes = useQuery<RouteDoc>(query(collection(db, 'routes'), where('originHubId', '==', hub.id), where('active', '==', true)), [hub.id]);
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), where('status', '==', 'active')), []);

  const parcels = onHand.data.filter((d) => d.custodian.type === 'hub');
  const waitingLinehaul = parcels.filter((d) => d.status === 'at_origin_hub');
  const waitingLastMile = parcels.filter((d) => d.status === 'at_destination_hub');
  const driverName = (uid: string | null) => drivers.data.find((x) => x.uid === uid)?.name ?? '—';

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
      <div className="space-y-6">
        <ScanPanel hub={hub} />
        <section className="card space-y-2 text-sm">
          <h2 className="font-semibold">Expected from pickup drivers ({incomingFirstMile.data.length})</h2>
          {incomingFirstMile.data.map((d) => (
            <p key={d._id}>
              <span className="font-mono">{d.trackingNumber}</span> · {driverName(d.currentDriverUid)} → {d.destinationHub?.city}
            </p>
          ))}
        </section>
        <section className="card space-y-3 text-sm">
          <h2 className="font-semibold">Inbound linehaul ({inbound.data.length})</h2>
          {inbound.data.map((m) => (
            <InboundManifest key={m._id} m={m} />
          ))}
        </section>
      </div>

      <div className="space-y-6">
        <section className="card space-y-2 text-sm">
          <h2 className="font-semibold">Waiting for final delivery ({waitingLastMile.length})</h2>
          <table className="w-full">
            <tbody>
              {waitingLastMile.map((d) => (
                <tr key={d._id} className="border-t border-slate-100">
                  <td className="py-1.5 font-mono">{d.trackingNumber}</td>
                  <td>{d.destination.city}</td>
                  <td>{d.currentDriverUid ? `Driver: ${driverName(d.currentDriverUid)} — scan to hand over` : <span className="text-amber-700">Needs a driver (dispatch)</span>}</td>
                  <td>{d.openException && <span className="text-red-700">⚠ {d.openException.replace(/_/g, ' ')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Outbound manifests</h2>
          <NewManifest hub={hub} routes={routes.data} drivers={drivers.data} />
          {outbound.data.map((m) => (
            <OutboundManifest key={m._id} m={m} waiting={waitingLinehaul} />
          ))}
          <div className="card text-sm">
            <h3 className="mb-1 font-semibold">Waiting for linehaul ({waitingLinehaul.length})</h3>
            {waitingLinehaul.map((d) => (
              <p key={d._id}>
                <span className="font-mono">{d.trackingNumber}</span> → {d.destinationHub?.city} · {d.chargeableWeightKg} kg
                {d.legs.find((l) => l.id === d.currentLegId)?.manifestId ? <span className="text-brand-700"> · loaded</span> : null}
              </p>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function useScanLog() {
  const [log, setLog] = useState<ScanLog[]>([]);
  return { log, push: (ok: boolean, text: string) => setLog((l) => [{ at: Date.now(), ok, text }, ...l].slice(0, 12)) };
}

/** Single scan field: Enter submits, the field clears and keeps focus for the next parcel. */
function ScanInput({ label, onScan, disabled }: { label: string; onScan: (code: string) => Promise<void>; disabled?: boolean }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const code = value.trim();
        if (!code) return;
        setBusy(true);
        setValue('');
        try {
          await onScan(code);
        } finally {
          setBusy(false);
          ref.current?.focus();
        }
      }}
      className="flex gap-2"
    >
      <input ref={ref} className="input font-mono uppercase" aria-label={label} placeholder={label} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} autoComplete="off" />
      <button className="btn-primary shrink-0" disabled={busy || disabled}>
        Scan
      </button>
    </form>
  );
}

function ScanPanel({ hub }: { hub: HubDoc }) {
  const [mode, setMode] = useState<'receive' | 'handover'>('receive');
  const { log, push } = useScanLog();
  return (
    <section className="card space-y-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {(
          [
            ['receive', 'Receive into hub'],
            ['handover', 'Hand to driver'],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" className={`rounded-md py-1.5 ${mode === m ? 'bg-white font-medium shadow-sm' : ''}`} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <ScanInput
        label={mode === 'receive' ? 'Scan parcel to receive' : 'Scan parcel to hand over'}
        onScan={async (code) => {
          try {
            const r = await api.hubScan({ hubId: hub.id, type: mode, trackingNumber: code });
            push(true, `${r.trackingNumber}: ${mode === 'receive' ? 'received' : 'handed to driver'} (${r.destination})`);
          } catch (e) {
            push(false, `${code}: ${(e as ApiError).message}`);
          }
        }}
      />
      <ol className="space-y-1 text-sm" aria-label="Scan results">
        {log.map((l) => (
          <li key={l.at} className={l.ok ? 'text-brand-700' : 'text-red-700'}>
            {l.ok ? '✓' : '✕'} {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

function NewManifest({ hub, routes, drivers }: { hub: HubDoc; routes: (RouteDoc & { _id: string })[]; drivers: (DriverDoc & { _id: string })[] }) {
  const { db } = getFirebase();
  const vehicles = useQuery<VehicleDoc>(query(collection(db, 'vehicles'), where('homeServiceAreaId', '==', hub.serviceAreaId)), [hub.serviceAreaId]);
  const [open, setOpen] = useState(false);
  const [routeId, setRouteId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [driverUid, setDriverUid] = useState('');
  const [when, setWhen] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!open)
    return (
      <button className="btn-secondary" onClick={() => setOpen(true)} disabled={routes.length === 0}>
        {routes.length ? '+ New manifest' : 'No routes from this hub'}
      </button>
    );
  const usable = vehicles.data.filter((v) => v.status !== 'maintenance' && v.status !== 'retired' && (v.vehicleClass === 'van' || v.vehicleClass === 'truck'));
  return (
    <form
      className="card grid gap-3 text-sm sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api.createManifest({ routeId, vehicleId, driverUid, scheduledDepartureAt: new Date(when).toISOString() });
          setMsg(`Created ${r.number}`);
          setOpen(false);
        } catch (x) {
          setMsg((x as ApiError).message);
        }
      }}
    >
      <label className="space-y-1">
        <span className="font-medium">Route</span>
        <select className="input" value={routeId} onChange={(e) => setRouteId(e.target.value)} required>
          <option value="">Choose…</option>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="font-medium">Departure</span>
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
      </label>
      <label className="space-y-1">
        <span className="font-medium">Vehicle (van/truck)</span>
        <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
          <option value="">Choose…</option>
          {usable.map((v) => (
            <option key={v.id} value={v.id}>
              {v.registrationNumber} · {v.vehicleClass} · {v.capacityKg} kg
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="font-medium">Linehaul driver</span>
        <select className="input" value={driverUid} onChange={(e) => setDriverUid(e.target.value)} required>
          <option value="">Choose…</option>
          {drivers
            .filter((d) => d.homeServiceAreaId === hub.serviceAreaId)
            .map((d) => (
              <option key={d.uid} value={d.uid}>
                {d.name}
              </option>
            ))}
        </select>
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn-primary">Create manifest</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {msg && <p className="sm:col-span-2">{msg}</p>}
    </form>
  );
}

function OutboundManifest({ m, waiting }: { m: Manifest; waiting: Delivery[] }) {
  const { log, push } = useScanLog();
  const [busy, setBusy] = useState(false);
  const pct = Math.min(100, Math.round((m.totalWeightKg / m.capacityKg) * 100));
  const act = async (action: 'seal' | 'reopen' | 'depart') => {
    setBusy(true);
    try {
      await api.manifestAction({ manifestId: m._id, action });
      push(true, `Manifest ${action === 'depart' ? 'departed' : action === 'seal' ? 'sealed' : 'reopened'}`);
    } catch (e) {
      push(false, (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card space-y-3 text-sm" aria-label={`Manifest ${m.number}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono font-semibold">{m.number}</p>
          <p className="text-slate-500">
            {m.vehicleRegistration} · {m.driverName} · departs {new Date(m.scheduledDepartureAt).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${m.status === 'open' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-800'}`}>{m.status}</span>
      </div>
      <div>
        <div className="h-2 rounded bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Load">
          <div className={`h-2 rounded ${pct > 90 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {m.deliveryIds.length} parcel(s) · {m.totalWeightKg} / {m.capacityKg} kg
        </p>
      </div>
      {m.status === 'open' && (
        <ScanInput
          label="Scan parcel to load"
          onScan={async (code) => {
            try {
              const r = await api.addToManifest({ manifestId: m._id, trackingNumber: code });
              push(true, `${code.toUpperCase()} loaded (${r.parcels} parcels, ${r.totalWeightKg} kg)`);
            } catch (e) {
              push(false, `${code}: ${(e as ApiError).message}`);
            }
          }}
        />
      )}
      <ul className="flex flex-wrap gap-2">
        {m.deliveryIds.map((id) => (
          <li key={id} className="flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">
            {id}
            {m.status === 'open' && (
              <button aria-label={`Remove ${id}`} className="text-red-600" onClick={() => api.removeFromManifest({ manifestId: m._id, trackingNumber: id }).catch((e: ApiError) => push(false, e.message))}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {m.status === 'open' && waiting.some((d) => d.routeId === m.routeId && !d.legs.find((l) => l.id === d.currentLegId)?.manifestId) && (
        <p className="text-xs text-slate-500">
          Ready for this route: {waiting.filter((d) => d.routeId === m.routeId && !d.legs.find((l) => l.id === d.currentLegId)?.manifestId).map((d) => d.trackingNumber).join(', ')}
        </p>
      )}
      <div className="flex gap-2">
        {m.status === 'open' && <button className="btn-secondary" disabled={busy || m.deliveryIds.length === 0} onClick={() => act('seal')}>Seal</button>}
        {m.status === 'sealed' && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => act('reopen')}>Reopen</button>
            <button className="btn-primary" disabled={busy} onClick={() => act('depart')}>Depart</button>
          </>
        )}
      </div>
      <ScanLogList log={log} />
    </article>
  );
}

function InboundManifest({ m }: { m: Manifest }) {
  const { log, push } = useScanLog();
  const outstanding = m.deliveryIds.filter((id) => !m.receivedIds.includes(id));
  const act = async (action: 'arrive' | 'close') => {
    if (action === 'close' && outstanding.length && !confirm(`${outstanding.length} parcel(s) not unloaded will be flagged missing. Close anyway?`)) return;
    try {
      const r = await api.manifestAction({ manifestId: m._id, action });
      push(true, action === 'arrive' ? 'Arrival recorded — scan parcels to unload' : `Closed${r.missing.length ? ` with ${r.missing.length} missing` : ''}`);
    } catch (e) {
      push(false, (e as ApiError).message);
    }
  };
  return (
    <article className="space-y-2 rounded-lg border border-slate-200 p-3" aria-label={`Inbound ${m.number}`}>
      <p className="font-mono font-semibold">{m.number}</p>
      <p className="text-slate-500">
        {m.vehicleRegistration} · {m.driverName} ·{' '}
        {m.status === 'departed' && m.expectedArrivalAt ? `expected ${new Date(m.expectedArrivalAt).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' })}` : 'arrived'}
      </p>
      <p>
        Unloaded {m.receivedIds.length} / {m.deliveryIds.length}
        {outstanding.length > 0 && m.status === 'arrived' && <span className="text-slate-500"> · still to scan: {outstanding.join(', ')}</span>}
      </p>
      {m.status === 'departed' ? (
        <button className="btn-primary" onClick={() => act('arrive')}>Vehicle arrived</button>
      ) : (
        <button className="btn-secondary" onClick={() => act('close')}>Close manifest</button>
      )}
      <ScanLogList log={log} />
    </article>
  );
}

function ScanLogList({ log }: { log: ScanLog[] }) {
  return (
    <ol className="space-y-1">
      {log.map((l) => (
        <li key={l.at} className={l.ok ? 'text-brand-700' : 'text-red-700'}>
          {l.ok ? '✓' : '✕'} {l.text}
        </li>
      ))}
    </ol>
  );
}
