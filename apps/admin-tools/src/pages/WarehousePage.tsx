import type { DeliveryDoc, DriverDoc, HubDoc } from '@courier/shared-types';
import { collection, query, where } from 'firebase/firestore';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';
import { useNow, useQuery } from '../lib/useLive';

type Delivery = DeliveryDoc & { _id: string };

/**
 * The warehouse: pickup riders bring parcels in (scan "Receive"), dispatch assigns a delivery
 * rider, the warehouse gives the parcel to that rider (scan "Give to rider"). Scan fields work with
 * keyboard-wedge barcode scanners and with typing the tracking number.
 */
export function WarehousePage() {
  const { db } = getFirebase();
  const { role, hubIds } = useStaffAuth();
  const all = useQuery<HubDoc>(query(collection(db, 'hubs'), where('active', '==', true)), []);
  const mine = all.data.filter((h) => role !== 'hub_operator' || hubIds.includes(h.id));
  const [hubId, setHubId] = useState('');
  useEffect(() => {
    if (!hubId && mine[0]) setHubId(mine[0].id);
  }, [hubId, mine]);
  const hub = mine.find((h) => h.id === hubId);

  if (all.data.length > 0 && mine.length === 0) return <p className="p-6 text-slate-600">You are not assigned to a warehouse yet. Ask an administrator.</p>;
  if (!hub) return <p className="p-6 text-slate-500">{all.data.length === 0 ? 'No warehouse is set up yet. An administrator adds it under Settings → Areas & warehouses.' : 'Loading…'}</p>;
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Warehouse</h1>
        {mine.length > 1 ? (
          <select className="input w-auto" aria-label="Warehouse" value={hubId} onChange={(e) => setHubId(e.target.value)}>
            {mine.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-slate-500">{hub.name}</span>
        )}
      </div>
      <Workspace key={hub.id} hub={hub} />
    </div>
  );
}

function Workspace({ hub }: { hub: HubDoc }) {
  const { db } = getFirebase();
  const now = useNow();
  const coming = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('originHub.id', '==', hub.id), where('status', '==', 'picked_up')), [hub.id]);
  const inside = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('custodian.id', '==', hub.id), where('status', 'in', ['at_origin_hub', 'at_destination_hub'])), [hub.id]);
  const out = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('destinationHub.id', '==', hub.id), where('status', 'in', ['out_for_delivery', 'delivery_failed'])), [hub.id]);
  const riders = useQuery<DriverDoc>(query(collection(db, 'drivers'), where('status', '==', 'active')), []);
  const rider = (uid: string | null) => riders.data.find((r) => r.uid === uid)?.name ?? '—';
  const here = inside.data.filter((d) => d.custodian.type === 'hub');
  const needsRider = here.filter((d) => !d.currentAssignmentId);
  const ready = here.filter((d) => d.currentAssignmentId);
  const comingBack = out.data.filter((d) => d.status === 'delivery_failed');
  const delivering = out.data.filter((d) => d.status === 'out_for_delivery');
  const since = (d: Delivery & { updatedAt?: { toMillis(): number } }) => {
    const m = d.updatedAt ? Math.round((now - d.updatedAt.toMillis()) / 60_000) : null;
    return m === null ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
      <ScanPanel hub={hub} />
      <div className="grid content-start gap-4 md:grid-cols-2">
        <Bucket title="Coming in from pickup riders" hint="Picked up, on the way here. Scan them when they arrive." items={coming.data} line={(d) => `${rider(d.currentDriverUid)} · from ${d.pickup.line1} · ${since(d)}`} />
        <Bucket title="Needs a delivery rider" hint="In the warehouse. Dispatch assigns a delivery rider on the Orders screen." tone="warn" items={needsRider} line={(d) => `To ${d.destination.line1}${d.urgency !== 'standard' ? ` · ${d.urgency.replace('_', ' ')}` : ''}`} />
        <Bucket title="Ready for the delivery rider" hint="Scan “Give to rider” when the rider collects it." tone="ok" items={ready} line={(d) => `${rider(d.currentDriverUid)} → ${d.destination.line1}`} />
        <Bucket title="Out with delivery riders" items={delivering} line={(d) => `${rider(d.currentDriverUid)} → ${d.destination.line1}`} />
        {comingBack.length > 0 && (
          <Bucket title="Coming back (not delivered)" hint="The rider could not deliver; scan it in when they bring it back." tone="warn" items={comingBack} line={(d) => `${rider(d.currentDriverUid)} · ${d.openException?.replace(/_/g, ' ') ?? ''}`} />
        )}
      </div>
    </div>
  );
}

function Bucket({ title, hint, items, line, tone }: { title: string; hint?: string; items: Delivery[]; line: (d: Delivery) => string; tone?: 'warn' | 'ok' }) {
  const badge = tone === 'warn' && items.length ? 'bg-accent-400 text-black' : tone === 'ok' && items.length ? 'bg-emerald-100 text-emerald-800' : 'bg-field text-slate-700';
  return (
    <section className="card space-y-2 text-sm" aria-label={title}>
      <h2 className="flex items-center justify-between gap-2 font-bold">
        {title} <span className={`chip ${badge}`}>{items.length}</span>
      </h2>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <ul className="divide-y divide-slate-100">
        {items.map((d) => (
          <li key={d._id} className="py-1.5">
            <span className="font-mono text-xs font-semibold">{d.trackingNumber}</span>
            <span className="block truncate text-slate-600">{line(d)}</span>
          </li>
        ))}
        {items.length === 0 && <li className="py-1.5 text-slate-400">Nothing here.</li>}
      </ul>
    </section>
  );
}

function ScanPanel({ hub }: { hub: HubDoc }) {
  const [mode, setMode] = useState<'receive' | 'handover'>('receive');
  const [log, setLog] = useState<{ at: number; ok: boolean; text: string }[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const push = (ok: boolean, text: string) => setLog((l) => [{ at: Date.now(), ok, text }, ...l].slice(0, 12));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = value.trim();
    if (!code) return;
    setBusy(true);
    setValue('');
    try {
      const r = await api.hubScan({ hubId: hub.id, type: mode, trackingNumber: code });
      push(true, `${r.trackingNumber}: ${mode === 'receive' ? 'received into the warehouse' : 'given to the delivery rider'}`);
    } catch (x) {
      push(false, `${code}: ${(x as ApiError).message}`);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }
  return (
    <section className="card space-y-3 self-start lg:sticky lg:top-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-field p-1 text-sm" role="tablist">
        {(
          [
            ['receive', 'Receive parcel'],
            ['handover', 'Give to rider'],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`rounded-lg py-2 font-semibold ${mode === m ? 'bg-white shadow-sm' : 'text-slate-600'}`} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">{mode === 'receive' ? 'A pickup rider (or a returning delivery rider) hands you a parcel.' : 'The assigned delivery rider collects a parcel.'}</p>
      <form onSubmit={submit} className="flex gap-2">
        <input ref={ref} className="input font-mono uppercase placeholder:normal-case" aria-label={mode === 'receive' ? 'Scan parcel to receive' : 'Scan parcel to hand over'} placeholder="Scan or type the tracking number" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <button className="btn-primary shrink-0" disabled={busy}>
          Scan
        </button>
      </form>
      <ol className="space-y-1 text-sm" aria-label="Scan results">
        {log.map((l) => (
          <li key={l.at} className={l.ok ? 'text-emerald-700' : 'text-red-700'}>
            {l.ok ? '✓' : '✕'} {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
