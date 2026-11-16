import type { BusinessReport } from '@courier/shared-types';
import { formatGhs, toCsv } from '@courier/shared-utils';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { ApiError } from '../../lib/errors';

const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Reports() {
  const [month, setMonth] = useState(thisMonth());
  const [report, setReport] = useState<BusinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.getBusinessReport({ month }));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  function exportCsv() {
    if (!report) return;
    const csv = toCsv(
      ['tracking_number', 'date', 'reference', 'recipient', 'destination', 'service', 'status', 'delivered_at', 'amount_ghs', 'payment'],
      report.rows.map((r) => [r.trackingNumber, r.createdAt.slice(0, 10), r.reference ?? '', r.recipient, r.destinationCity, r.deliveryType, r.status, r.deliveredAt?.slice(0, 16).replace('T', ' ') ?? '', (r.amountPesewas / 100).toFixed(2), r.paymentPreference]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: `deliveries-${report.month}.csv` }).click();
    URL.revokeObjectURL(url);
  }
  const tiles: [string, string][] = report
    ? [
        ['Bookings', String(report.bookings)],
        ['Delivered', String(report.delivered)],
        ['In progress', String(report.inProgress)],
        ['On time', report.onTimePercent === null ? '—' : `${report.onTimePercent}%`],
        ['Failed attempts', String(report.failedAttempts)],
        ['Spend', formatGhs(report.spendPesewas)],
      ]
    : [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Month<input className="input mt-1" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <button className="btn-primary" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Show report'}</button>
        {report && <button className="btn-secondary" onClick={exportCsv}>Export CSV</button>}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map(([k, v]) => (
              <div key={k} className="card">
                <p className="text-xs text-slate-500">{k}</p>
                <p className="text-xl font-bold tabular-nums">{v}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card text-sm">
              <h3 className="mb-2 font-semibold">By service</h3>
              <p>Same city: {report.byType.intra_city} · Intercity: {report.byType.intercity} · Long distance: {report.byType.long_distance}</p>
            </div>
            <div className="card text-sm">
              <h3 className="mb-2 font-semibold">Top destinations</h3>
              <ul>{report.byDestination.map((d) => <li key={d.city}>{d.city}: {d.count}</li>)}</ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
