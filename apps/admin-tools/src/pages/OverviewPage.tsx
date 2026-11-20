import type { DeliveryDoc, DeliveryRequestDoc, DriverCashLedger, DriverDoc, HubDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { Link } from 'react-router';
import { ACTIVE_STATUSES, columnFor, COLUMN_TITLE, type BoardColumn } from '../lib/dispatch';
import { getFirebase } from '../lib/firebase';
import { useNow, useQuery } from '../lib/useLive';

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** The manager's view of the whole operation today, live. */
export function OverviewPage() {
  const { db } = getFirebase();
  const now = useNow(30_000);
  const today = Timestamp.fromDate(startOfToday());
  const active = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('status', 'in', ACTIVE_STATUSES), orderBy('updatedAt', 'desc'), limit(500)), []);
  const delivered = useQuery<DeliveryDoc>(query(collection(db, 'deliveries'), where('status', '==', 'delivered'), where('updatedAt', '>=', today)), [today.toMillis()]);
  const booked = useQuery<DeliveryRequestDoc>(query(collection(db, 'deliveryRequests'), where('createdAt', '>=', today)), [today.toMillis()]);
  const riders = useQuery<DriverDoc>(query(collection(db, 'drivers'), where('status', '==', 'active')), []);
  const cash = useQuery<DriverCashLedger>(query(collection(db, 'driverCash')), []);
  const hubs = useQuery<HubDoc>(query(collection(db, 'hubs'), where('active', '==', true)), []);

  const columns = { needs_pickup: 0, picking_up: 0, at_warehouse: 0, delivering: 0, problems: 0 } as Record<BoardColumn, number>;
  for (const d of active.data) columns[columnFor(d)]++;
  const late = active.data.filter((d) => d.delayed || Date.parse(d.expectedDeliveryAt) < now).length;
  const confirmed = booked.data.filter((b) => b.status !== 'cancelled');
  const revenue = confirmed.reduce((n, b) => n + b.price.totalPesewas, 0);
  const onShift = riders.data.filter((r) => r.currentShift && Date.parse(r.currentShift.activeUntil) > now);
  const busy = new Set(active.data.map((d) => d.currentDriverUid).filter(Boolean));
  const cashHeld = cash.data.reduce((n, c) => n + Math.max(0, (c.collectedPesewas ?? 0) - (c.remittedPesewas ?? 0)), 0);
  const error = active.error ?? riders.error;

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Today</h1>
        <span className="text-slate-500">{new Date(now).toLocaleDateString('en-GH', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
      {error && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="New orders" value={String(confirmed.length)} sub={formatGhs(revenue)} />
        <Tile label="Delivered" value={String(delivered.data.length)} />
        <Tile label="In progress" value={String(active.data.length)} />
        <Tile label="Late or problems" value={String(late + columns.problems)} tone={late + columns.problems > 0 ? 'warn' : undefined} />
        <Tile label="Cash held by riders" value={formatGhs(cashHeld)} />
      </div>

      <section className="card space-y-3" aria-label="Orders by stage">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Where the orders are</h2>
          <Link to="/dispatch" className="text-sm font-semibold underline-offset-2 hover:underline">
            Open orders →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(Object.keys(columns) as BoardColumn[]).map((c) => (
            <div key={c} className={`rounded-xl p-3 ${c === 'problems' && columns[c] ? 'bg-red-50' : 'bg-field'}`}>
              <p className="text-2xl font-extrabold">{columns[c]}</p>
              <p className="text-xs font-medium text-slate-600">{COLUMN_TITLE[c]}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card space-y-3" aria-label="Riders on shift">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Riders on shift</h2>
            <Link to="/fleet" className="text-sm font-semibold underline-offset-2 hover:underline">
              All riders →
            </Link>
          </div>
          {(['pickup', 'delivery'] as const).map((t) => {
            const list = onShift.filter((r) => (r.riderType ?? t) === t);
            return (
              <div key={t}>
                <p className="mb-1 text-sm font-semibold text-slate-500">
                  {t === 'pickup' ? 'Pickup riders' : 'Delivery riders'} · {list.length}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {list.map((r) => (
                    <li key={r.uid} className={`chip px-3 py-1 text-sm ${busy.has(r.uid) ? 'bg-accent-400 text-black' : 'bg-field text-slate-700'}`}>
                      {r.name} {busy.has(r.uid) ? '· busy' : '· free'}
                    </li>
                  ))}
                  {list.length === 0 && <li className="text-sm text-slate-400">Nobody on shift.</li>}
                </ul>
              </div>
            );
          })}
          <p className="text-xs text-slate-500">{riders.data.length - onShift.length} riders off shift.</p>
        </section>

        <section className="card space-y-3" aria-label="Warehouses">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Warehouse</h2>
            <Link to="/hub" className="text-sm font-semibold underline-offset-2 hover:underline">
              Open warehouse →
            </Link>
          </div>
          {hubs.data.map((h) => {
            const inside = active.data.filter((d) => d.custodian.type === 'hub' && d.custodian.id === h.id);
            const coming = active.data.filter((d) => d.status === 'picked_up' && d.originHub?.id === h.id);
            return (
              <div key={h.id} className="grid grid-cols-3 gap-2 text-center">
                <p className="col-span-3 text-left text-sm font-semibold">{h.name}</p>
                <Mini label="Coming in" value={coming.length} />
                <Mini label="Inside" value={inside.length} />
                <Mini label="Need a delivery rider" value={inside.filter((d) => !d.currentAssignmentId).length} warn />
              </div>
            );
          })}
          {hubs.data.length === 0 && <p className="text-sm text-slate-500">No warehouse set up yet.</p>}
        </section>
      </div>

      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Backup</h2>
          <p className="text-sm text-slate-600">Download all orders, customers, payments, riders and costs as an Excel file.</p>
        </div>
        <Link to="/backup" className="btn-primary">
          Download Excel backup
        </Link>
      </section>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className={`card p-4 ${tone === 'warn' ? 'bg-accent-400' : ''}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tracking-tight">{value}</p>
      {sub && <p className="text-sm text-slate-600">{sub}</p>}
    </div>
  );
}

function Mini({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`rounded-xl p-2 ${warn && value ? 'bg-accent-400' : 'bg-field'}`}>
      <p className="text-xl font-extrabold">{value}</p>
      <p className="text-[11px] leading-tight text-slate-600">{label}</p>
    </div>
  );
}
