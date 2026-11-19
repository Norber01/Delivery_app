import type { FinanceReport, MoneyByKey } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { useState } from 'react';
import { api, type ApiError } from '../lib/api';
import { thisMonth } from '../lib/receipt';

const TYPE = { intra_city: 'Same city', intercity: 'Intercity', long_distance: 'Long distance' } as Record<string, string>;
const CAT = { fuel: 'Fuel', maintenance: 'Maintenance', driver_payment: 'Driver pay', hub: 'Hubs', other: 'Other' } as Record<string, string>;

/** Monthly revenue, costs and contribution (by area, route, vehicle), with ledger cross-checks. */
export function AnalyticsPage() {
  const [period, setPeriod] = useState(thisMonth());
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(refresh = false) {
    setBusy(true);
    setErr(null);
    try {
      setReport(await api.getFinanceReport(period, refresh));
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  const r = report;
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-bold">Analytics</h1>
      <div className="card flex flex-wrap items-end gap-3 text-sm">
        <label>Month<input className="input mt-1" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button className="btn-primary" onClick={() => load(false)} disabled={busy}>{busy ? 'Calculating…' : 'Show report'}</button>
        {r && <button className="btn-secondary" onClick={() => load(true)} disabled={busy}>Recalculate</button>}
        {r && <span className="text-slate-500">Calculated {new Date(r.computedAt).toLocaleString('en-GH')}</span>}
        {err && <p className="w-full text-red-700">{err}</p>}
      </div>
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Revenue booked" value={formatGhs(r.revenue.bookedPesewas)} sub={`${r.revenue.deliveries} bookings`} />
            <Tile label="Costs (approved)" value={formatGhs(r.costs.totalPesewas)} sub={r.costs.pendingApprovalPesewas ? `${formatGhs(r.costs.pendingApprovalPesewas)} awaiting approval` : 'none awaiting approval'} />
            <Tile label="Contribution" value={formatGhs(r.contributionPesewas)} tone={r.contributionPesewas < 0 ? 'bad' : 'good'} sub={r.revenue.bookedPesewas ? `${Math.round((r.contributionPesewas / r.revenue.bookedPesewas) * 100)}% of revenue` : ''} />
            <Tile label="Checks" value={`${r.checks.filter((c) => c.ok).length}/${r.checks.length} pass`} tone={r.checks.every((c) => c.ok) ? 'good' : 'bad'} sub="books reconcile" />
          </div>

          <section className="card space-y-2 text-sm">
            <h2 className="font-semibold">Reconciliation</h2>
            <ul className="space-y-1">
              {r.checks.map((c) => (
                <li key={c.name} className="flex gap-2">
                  <span aria-hidden className={c.ok ? 'text-green-700' : 'text-red-700'}>{c.ok ? '✔' : '✖'}</span>
                  <span className="flex-1">
                    <span className={c.ok ? '' : 'font-semibold text-red-700'}>{c.name}</span>
                    {!c.ok && <span className="block text-red-700">Expected {formatGhs(c.expectedPesewas)}, found {formatGhs(c.actualPesewas)}.</span>}
                    <span className="block text-xs text-slate-500">{c.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card space-y-1 text-sm">
              <h2 className="mb-1 font-semibold">Money in</h2>
              <Row k="Online (Mobile Money / card)" v={r.collections.onlinePesewas} />
              <Row k="Cash collected by drivers" v={r.collections.cashCollectedPesewas} />
              <Row k="Cash handed in by drivers" v={r.collections.cashRemittedPesewas} />
              <Row k="Business invoice payments" v={r.collections.invoicePaymentsPesewas} />
              <Row k="Refunds paid" v={-r.collections.refundsPesewas} />
              <h3 className="pt-2 font-medium">Revenue by service</h3>
              {Object.entries(r.revenue.byType).map(([k, v]) => <Row key={k} k={TYPE[k] ?? k} v={v} />)}
            </section>
            <section className="card space-y-1 text-sm">
              <h2 className="mb-1 font-semibold">Costs by category</h2>
              {Object.keys(r.costs.byCategory).length === 0 && <p className="text-slate-500">No approved costs this month.</p>}
              {Object.entries(r.costs.byCategory).map(([k, v]) => <Row key={k} k={CAT[k] ?? k} v={v} />)}
            </section>
          </div>

          <Breakdown title="By service area" rows={r.byArea} />
          <Breakdown title="By intercity route" rows={r.byRoute} empty="No intercity bookings this month." />
          <section className="card overflow-x-auto p-0">
            <h2 className="px-4 pt-3 font-semibold">By vehicle</h2>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-slate-500">
                <tr><th className="px-3 py-2">Vehicle</th><th className="px-3 py-2 text-right">Revenue</th><th className="px-3 py-2 text-right">Costs</th><th className="px-3 py-2 text-right">Contribution</th><th className="px-3 py-2 text-right">km</th><th className="px-3 py-2 text-right">km/L</th><th className="px-3 py-2 text-right">Cost/km</th></tr>
              </thead>
              <tbody>
                {r.byVehicle.map((v) => (
                  <tr key={v.key} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono">{v.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatGhs(v.revenuePesewas)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatGhs(v.costPesewas)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${v.contributionPesewas < 0 ? 'text-red-700' : ''}`}>{formatGhs(v.contributionPesewas)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.kmDriven || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.kmPerLitre ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.costPerKmPesewas !== null ? formatGhs(v.costPerKmPesewas) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-slate-500">
            Revenue: confirmed bookings made this month. Costs: approved expenses dated this month (driver pay counts when paid). Area: bookings by pickup area; vehicle costs by the vehicle’s home area, hub costs by hub, driver pay by the driver’s area. Route costs share each linehaul vehicle’s costs by its trips. Vehicle revenue: each booking split between the vehicles that carried it.
          </p>
        </>
      )}
    </main>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-brand-700' : ''}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: number }) => (
  <p className="flex justify-between gap-2"><span>{k}</span><span className="tabular-nums">{formatGhs(v)}</span></p>
);

/** Contribution bars: positive to the right in green, negative in red; values always written out. */
function Breakdown({ title, rows, empty }: { title: string; rows: MoneyByKey[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.contributionPesewas)));
  return (
    <section className="card space-y-2 text-sm">
      <h2 className="font-semibold">{title}</h2>
      {rows.length === 0 && <p className="text-slate-500">{empty ?? 'No data.'}</p>}
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
          <span className="truncate">{r.label}</span>
          <div className="h-3 rounded bg-slate-100" aria-hidden>
            <div className={`h-3 rounded ${r.contributionPesewas < 0 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${(Math.abs(r.contributionPesewas) / max) * 100}%` }} />
          </div>
          <span className="text-right tabular-nums">
            {formatGhs(r.contributionPesewas)}
            <span className="block text-xs text-slate-500">{formatGhs(r.revenuePesewas)} − {formatGhs(r.costPesewas)} · {r.deliveries} bookings</span>
          </span>
        </div>
      ))}
    </section>
  );
}
