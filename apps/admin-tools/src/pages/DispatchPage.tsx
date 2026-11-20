import { EXCEPTION_REASONS } from '@courier/constants';
import { MapView, type MapMarker } from '@courier/map-ui';
import type { DeliveryDoc, DriverDoc, ProofOfDeliveryDoc } from '@courier/shared-types';
import { formatGhs, locationFreshness, normalizeTrackingNumber, PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { collection, doc, getDoc, limit, orderBy, query, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { SignatureView } from '../components/SignatureView';
import { api, ApiError } from '../lib/api';
import { config } from '../lib/config';
import { RIDER_TYPE_LABELS } from '@courier/constants';
import { ACTIVE_STATUSES, columnFor, COLUMN_TITLE, countActiveJobs, rankDrivers, riderNeeded, type BoardColumn } from '../lib/dispatch';
import { getFirebase } from '../lib/firebase';
import { useDriverLocations, useNow, useQuery } from '../lib/useLive';

type Delivery = DeliveryDoc & { _id: string; updatedAt?: Timestamp };
type Driver = DriverDoc & { _id: string };

const REASON_LABEL = Object.fromEntries(EXCEPTION_REASONS.map((r) => [r, r.replace(/_/g, ' ')])) as Record<string, string>;
const ago = (ms: number, now: number) => {
  const m = Math.round((now - ms) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function DispatchPage() {
  const { db } = getFirebase();
  const now = useNow();
  const deliveries = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('status', 'in', ACTIVE_STATUSES), orderBy('updatedAt', 'desc'), limit(300)), []);
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), where('currentShift', '!=', null)), []);
  const locations = useDriverLocations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened, setOpened] = useState<Delivery | null>(null); // looked up by tracking number (may be completed)
  const [search, setSearch] = useState('');
  const [onlyDelayed, setOnlyDelayed] = useState(false);

  const selected = deliveries.data.find((d) => d._id === selectedId) ?? (opened?._id === selectedId ? opened : null);
  const visible = deliveries.data.filter((d) => !onlyDelayed || d.delayed);
  const columns: Record<BoardColumn, Delivery[]> = { needs_pickup: [], picking_up: [], at_warehouse: [], delivering: [], problems: [] };
  for (const d of visible) columns[columnFor(d)].push(d);
  // Stable order (most urgent first): cards must not jump while a dispatcher is clicking.
  for (const c of Object.values(columns)) {
    c.sort((a, b) => a.expectedDeliveryAt.localeCompare(b.expectedDeliveryAt) || a.trackingNumber.localeCompare(b.trackingNumber));
  }
  const jobs = useMemo(() => countActiveJobs(deliveries.data), [deliveries.data]);
  const onShift = drivers.data.filter((d) => d.currentShift && Date.parse(d.currentShift.activeUntil) > now);
  const pickupRiders = onShift.filter((d) => d.riderType !== 'delivery').length;
  const deliveryRiders = onShift.filter((d) => d.riderType !== 'pickup').length;
  const riderName = (uid: string | null) => drivers.data.find((x) => x.uid === uid)?.name ?? null;
  const [showMap, setShowMap] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);
  // Below the two-column layout the details panel sits under the board: bring it into view.
  useEffect(() => {
    if (selectedId && window.innerWidth < 1280) document.getElementById('order-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  const markers: MapMarker[] = [
    ...drivers.data.flatMap((d): MapMarker[] => {
      const loc = locations[d.uid];
      if (!loc || loc.shiftId !== d.currentShift?.id) return [];
      return [{ id: `driver:${d.uid}`, kind: 'driver', lat: loc.lat, lng: loc.lng, label: d.name, muted: locationFreshness(loc.serverAt, now) !== 'live' }];
    }),
    ...(selected
      ? ([
          { id: 'pickup', kind: 'pickup', label: 'Pickup', ...selected.pickup.location, selected: true },
          { id: 'destination', kind: 'destination', label: 'Destination', ...selected.destination.location, selected: true },
        ] as MapMarker[])
      : []),
  ];

  async function openByTracking() {
    const tn = normalizeTrackingNumber(search);
    if (!tn) return;
    const snap = await getDoc(doc(db, 'deliveries', tn));
    if (snap.exists()) {
      setOpened({ ...(snap.data() as DeliveryDoc), _id: snap.id });
      setSelectedId(snap.id);
    } else {
      setOpened(null);
      alert('No delivery with that tracking number (it may not be confirmed yet).');
    }
  }

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight">Orders</h1>
          <span className="text-sm text-slate-500">
            {deliveries.data.length} active · on shift: {pickupRiders} pickup, {deliveryRiders} delivery riders
          </span>
          <button className="text-sm font-medium text-slate-600 underline-offset-2 hover:underline" onClick={() => setShowMap((v) => !v)}>
            {showMap ? 'Hide map' : 'Show map'}
          </button>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyDelayed} onChange={(e) => setOnlyDelayed(e.target.checked)} /> Delayed only
          </label>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void openByTracking();
            }}
          >
            <input className="input w-48 font-mono" placeholder="Tracking number" aria-label="Open by tracking number" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="btn-secondary">Open</button>
          </form>
        </div>
        {(deliveries.error || drivers.error) && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{deliveries.error ?? drivers.error}</p>}

        {showMap && <MapView ariaLabel="Riders and selected order" markers={markers} mapboxToken={config.mapboxPublicToken} height={280} />}

        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 2xl:mx-0 2xl:grid 2xl:grid-cols-5 2xl:overflow-visible 2xl:px-0">
          {(Object.keys(columns) as BoardColumn[]).map((c) => (
            <section key={c} aria-label={COLUMN_TITLE[c]} className="w-64 shrink-0 snap-start space-y-2 rounded-2xl bg-black/[0.03] p-2 2xl:w-auto">
              <h2 className="flex items-center justify-between px-1 text-sm font-bold">
                <span className={c === 'problems' && columns[c].length ? 'text-red-700' : ''}>{COLUMN_TITLE[c]}</span>
                <span className="chip bg-white text-slate-700">{columns[c].length}</span>
              </h2>
              {columns[c].map((d) => (
                <button
                  key={d._id}
                  onClick={() => setSelectedId(d._id)}
                  className={`card w-full space-y-1 p-3 text-left text-sm ${selectedId === d._id ? 'ring-2 ring-brand-500' : 'hover:ring-1 hover:ring-slate-300'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{d.trackingNumber}</span>
                    <span className="flex gap-1">
                      {d.urgency !== 'standard' && <Badge tone="blue">{d.urgency.replace('_', ' ')}</Badge>}
                      {d.delayed && <Badge tone="red">delayed</Badge>}
                    </span>
                  </div>
                  <p className="font-semibold">{PUBLIC_STATUS_LABELS[d.status]}</p>
                  <p className="truncate text-slate-600">
                    {d.pickup.line1} → {d.destination.line1}
                  </p>
                  {riderName(d.currentDriverUid) && <p className="text-xs text-slate-500">🛵 {riderName(d.currentDriverUid)}</p>}
                  {d.openException && <p className="text-xs text-red-700">⚠ {REASON_LABEL[d.openException]}</p>}
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>

      <aside id="order-panel" className="scroll-mt-20 xl:sticky xl:top-4 xl:self-start">
        {selected ? (
          <DeliveryPanel key={selected._id} delivery={selected} drivers={drivers.data} locations={locations} jobs={jobs} now={now} onClose={() => setSelectedId(null)} />
        ) : (
          <p className="card text-sm text-slate-500">Choose an order to see its details and assign a rider.</p>
        )}
      </aside>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'red' | 'blue' | 'slate'; children: React.ReactNode }) {
  const c = { red: 'bg-red-100 text-red-700', blue: 'bg-blue-100 text-blue-700', slate: 'bg-slate-100 text-slate-700' }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
}

function DeliveryPanel({
  delivery: d,
  drivers,
  locations,
  jobs,
  now,
  onClose,
}: {
  delivery: Delivery;
  drivers: Driver[];
  locations: ReturnType<typeof useDriverLocations>;
  jobs: Record<string, number>;
  now: number;
  onClose: () => void;
}) {
  const { db } = getFirebase();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [driverUid, setDriverUid] = useState('');
  const [reason, setReason] = useState('');
  const events = useQuery<{ type: string; publicMessage: string; internalNote?: string; occurredAt: Timestamp; actorRole: string }>(
    query(collection(db, 'trackingEvents'), where('trackingNumber', '==', d.trackingNumber), orderBy('occurredAt', 'desc'), limit(50)),
    [d.trackingNumber],
  );
  const leg = d.legs.find((l) => l.id === d.currentLegId);
  const lastMile = leg?.type === 'last_mile';
  // Last mile: rank drivers in the destination area by distance from the destination hub.
  const target = lastMile && d.destinationHub
    ? { serviceAreaId: d.destinationAreaId ?? '', requiredVehicleClass: d.requiredVehicleClass, pickup: { ...d.pickup, location: d.destinationHub.location } }
    : d;
  const needed = riderNeeded(d);
  const options = useMemo(() => rankDrivers(target, drivers, locations, jobs, now, needed), [target, drivers, locations, jobs, now, needed]);
  const canAssign = (d.status === 'awaiting_assignment' && (leg?.type === 'direct' || leg?.type === 'first_mile')) || (d.status === 'at_destination_hub' && lastMile && !d.currentAssignmentId);
  const isTerminal = ['delivered', 'returned', 'cancelled'].includes(d.status);

  async function act(type: Parameters<typeof api.dispatch>[0]['type'], extra: { driverUid?: string; reason?: string } = {}) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.dispatch({ type, deliveryId: d._id, ...extra });
      setMsg({ tone: 'ok', text: `Done — ${PUBLIC_STATUS_LABELS[r.status as DeliveryDoc['status']]}` });
      setReason('');
    } catch (e) {
      setMsg({ tone: 'err', text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  const holder = drivers.find((x) => x.uid === d.currentDriverUid);

  return (
    <div className="card space-y-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-500">{d.trackingNumber}</p>
          <h2 className="text-lg font-semibold">{PUBLIC_STATUS_LABELS[d.status]}</h2>
          <p className="text-slate-500">
            {d.deliveryType === 'intra_city' ? 'Same city' : d.deliveryType.replace('_', ' ')} · {d.urgency.replace('_', ' ')} · due {new Date(d.expectedDeliveryAt).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        </div>
        <button className="text-slate-400 hover:text-slate-700" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {msg && <p className={`rounded px-3 py-2 ${msg.tone === 'ok' ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}

      <div className="grid grid-cols-2 gap-3">
        <Stop title="Pickup" contact={d.sender} address={d.pickup} />
        <Stop title="Delivery" contact={d.recipient} address={d.destination} />
      </div>
      <p className="text-slate-600">
        {d.packages.reduce((n, p) => n + p.quantity, 0)} item(s): {d.packages.map((p) => p.description).join(', ')}
        {d.specialHandling.length > 0 && <> · {d.specialHandling.join(', ')}</>}
      </p>
      {d.collectOnPickupPesewas > 0 && <p className="font-medium text-amber-800">Rider collects {formatGhs(d.collectOnPickupPesewas)} cash at pickup</p>}
      {d.instructions && <p className="rounded bg-slate-50 px-2 py-1 text-slate-700">“{d.instructions}”</p>}
      {holder && (
        <p>
          {holder.riderType ? RIDER_TYPE_LABELS[holder.riderType] : 'Rider'}: <strong>{holder.name}</strong> ({holder.phone}) · {holder.currentShift?.vehicleClass}
        </p>
      )}

      {!isTerminal && (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          {d.originHub && d.originHub.id === d.destinationHub?.id && (
            <p className="rounded-xl bg-field px-3 py-2 text-slate-700">
              Goes through <strong>{d.originHub.name}</strong>:{' '}
              {leg?.type === 'first_mile' ? 'a pickup rider brings it in, then a delivery rider takes it out.' : 'picked up — now a delivery rider takes it to the recipient.'}
            </p>
          )}
          {d.originHub && d.originHub.id !== d.destinationHub?.id && (
            <p className="rounded-xl bg-violet-50 px-3 py-2 text-violet-800">
              Intercity via {d.originHub.code} → {d.destinationHub?.code} · current leg: {leg?.type.replace('_', ' ')}
              {leg?.type === 'linehaul' && ' (handled on the warehouse screen)'}
            </p>
          )}
          {(canAssign || (d.status === 'awaiting_assignment' && leg?.type === 'linehaul')) &&
            (canAssign ? (
              <div className="space-y-2">
                <label className="block font-semibold" htmlFor="driver-select">
                  {needed === 'pickup' ? 'Assign a pickup rider' : needed === 'delivery' ? 'Assign a delivery rider' : 'Assign a rider'}
                </label>
                <select id="driver-select" className="input" value={driverUid} onChange={(e) => setDriverUid(e.target.value)}>
                  <option value="">{needed === 'pickup' ? 'Choose a pickup rider…' : needed === 'delivery' ? 'Choose a delivery rider…' : 'Choose a rider…'}</option>
                  {options.map((o) => (
                    <option key={o.driver.uid} value={o.driver.uid} disabled={!o.eligible}>
                      {o.driver.name} · {o.driver.currentShift?.vehicleClass ?? '—'}
                      {o.distanceKm !== null ? ` · ${o.distanceKm} km` : ''}
                      {o.freshness && o.freshness !== 'live' ? ` (${o.freshness} GPS)` : ''}
                      {o.activeJobs ? ` · ${o.activeJobs} job(s)` : ''}
                      {o.reason ? ` — ${o.reason}` : ''}
                    </option>
                  ))}
                </select>
                <button className="btn-accent w-full" disabled={busy || !driverUid} onClick={() => act('assign', { driverUid })}>
                  Assign
                </button>
              </div>
            ) : (
              <p className="rounded-xl bg-violet-50 px-3 py-2 text-violet-800">Waiting for the warehouse team.</p>
            ))}
          <div className="flex flex-wrap gap-2">
            {(d.status === 'assigned' || (d.status === 'at_destination_hub' && d.currentAssignmentId)) && (
              <ActionButton onClick={() => act('unassign')} busy={busy}>Unassign</ActionButton>
            )}
            {d.status === 'pickup_failed' && <ActionButton onClick={() => act('reschedule')} busy={busy}>Reschedule pickup</ActionButton>}
            {d.status === 'delivery_failed' && (
              <>
                <ActionButton onClick={() => act('reattempt')} busy={busy}>Reattempt (new code)</ActionButton>
                <ActionButton onClick={() => act('return_to_sender')} busy={busy}>Return to sender</ActionButton>
              </>
            )}
            {d.status === 'on_hold' && <ActionButton onClick={() => act('release')} busy={busy}>Release hold</ActionButton>}
          </div>
          {d.status !== 'on_hold' && (
            <div className="flex gap-2">
              <input className="input" placeholder="Reason (for hold or cancel)" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <ActionButton onClick={() => act('hold', { reason })} busy={busy || reason.trim().length < 3}>Hold</ActionButton>
              {['awaiting_assignment', 'assigned', 'pickup_failed'].includes(d.status) && (
                <ActionButton tone="danger" onClick={() => confirm('Cancel this delivery and its booking?') && act('cancel', { reason })} busy={busy || reason.trim().length < 3}>
                  Cancel
                </ActionButton>
              )}
            </div>
          )}
        </div>
      )}

      {d.status === 'delivered' || d.status === 'returned' ? <PodSection deliveryId={d._id} kind={d.status === 'returned' ? 'return' : 'delivery'} /> : null}

      {d.exceptions.length > 0 && (
        <div>
          <h3 className="mb-1 font-semibold">Exceptions</h3>
          <ul className="space-y-1">
            {d.exceptions.map((x, i) => (
              <li key={i} className="text-red-700">
                {new Date(x.at).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })} · {x.stage}: {REASON_LABEL[x.reason]}
                {x.note && <span className="text-slate-600"> — {x.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-1 font-semibold">Timeline</h3>
        <ol className="space-y-1">
          {events.data.map((e) => (
            <li key={e._id}>
              <span className="text-slate-400">{ago(e.occurredAt?.toMillis() ?? now, now)}</span> · {e.publicMessage}
              {e.internalNote && <span className="block pl-4 text-xs text-slate-500">{e.internalNote}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Stop({ title, contact, address }: { title: string; contact: DeliveryDoc['sender']; address: DeliveryDoc['pickup'] }) {
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <p>{contact.name}</p>
      <a className="text-brand-700" href={`tel:${contact.phone}`}>
        {contact.phone}
      </a>
      <p className="text-slate-600">{address.line1}</p>
      {address.landmark && <p className="text-slate-500">Near {address.landmark}</p>}
    </div>
  );
}

function ActionButton({ children, onClick, busy, tone }: { children: React.ReactNode; onClick: () => void; busy: boolean; tone?: 'danger' }) {
  return (
    <button className={tone === 'danger' ? 'btn border border-red-300 bg-white text-red-700 hover:bg-red-50' : 'btn-secondary'} disabled={busy} onClick={onClick}>
      {children}
    </button>
  );
}

function PodSection({ deliveryId, kind }: { deliveryId: string; kind: 'delivery' | 'return' }) {
  const { db } = getFirebase();
  const pod = useQuery<ProofOfDeliveryDoc>(query(collection(db, 'proofOfDelivery'), where('deliveryId', '==', deliveryId), where('kind', '==', kind)), [deliveryId, kind]);
  const [photo, setPhoto] = useState<string | null>(null);
  const p = pod.data[0];
  if (!p) return null;
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <h3 className="font-semibold">Proof of {kind}</h3>
      <p>
        Received by <strong>{p.receivedByName}</strong> · {p.method === 'otp' ? 'verified with delivery code' : 'signature'} ·{' '}
        {new Date(p.capturedAt).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })}
      </p>
      {p.flaggedFarFromDestination && <p className="text-red-700">⚠ Captured {p.distanceFromDestinationM} m from the address</p>}
      {p.signature && <SignatureView strokes={p.signature} />}
      {p.photoKeys.map((k) => (
        <button key={k} className="text-brand-700 underline" onClick={async () => setPhoto((await api.getEvidenceUrl(k)).url)}>
          View photo
        </button>
      ))}
      {photo && <img src={photo} alt="Proof of delivery" className="max-h-64 rounded border" />}
    </div>
  );
}
