import type { BulkConfirmResult, BulkPreview, BusinessDoc } from '@courier/shared-types';
import { formatGhs, parseCsvObjects, toCsv } from '@courier/shared-utils';
import { BULK_CSV_COLUMNS } from '@courier/validation';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import type { ApiError } from '../../lib/errors';
import { canBookOnAccount } from '../../lib/useBusiness';

const SAMPLE = ['ORD-1001', 'Kofi Boateng', '0501234567', '', 'Madina Market, shop 12', 'Opposite the lorry station', 'Accra', 'Greater Accra', 'GA-492-1234', '', '', 'Dress', '0.5', '30', '20', '5', '1', 'standard', 'fragile', '', 'Call on arrival'];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function BulkUpload({ business }: { business: BusinessDoc }) {
  const onAccount = canBookOnAccount(business);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [payment, setPayment] = useState<'business_invoice' | 'cash_on_pickup'>(onAccount ? 'business_invoice' : 'cash_on_pickup');
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [result, setResult] = useState<BulkConfirmResult | null>(null);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setPreview(null);
    setResult(null);
    setError(null);
    const { headers, rows: parsed } = parseCsvObjects(await file.text());
    setFileName(file.name);
    setMissing(['recipient_name', 'recipient_phone', 'address_line1', 'city', 'region', 'description', 'weight_kg', 'length_cm', 'width_cm', 'height_cm'].filter((c) => !headers.includes(c)));
    setRows(parsed);
  }

  async function check() {
    setBusy(true);
    setError(null);
    try {
      if (rows.length > 200) throw new Error('Upload at most 200 rows at a time.');
      setPreview(await api.previewBulkBooking({ pickup: business.pickupAddress, paymentPreference: payment, rows }));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.confirmBulkBooking({ batchId: preview.batchId, acceptTerms: true });
      setResult(r);
      // Labels are printed from data already on screen (no extra server calls).
      const labels = r.created.map((c) => {
        const row = preview.rows.find((x) => x.index === c.index)!;
        return { trackingNumber: c.trackingNumber, reference: row.reference, recipient: row.recipient, destination: row.destination, deliveryType: row.quote?.deliveryType };
      });
      try {
        sessionStorage.setItem('bulk-labels', JSON.stringify({ sender: business.tradingName, labels }));
      } catch {
        /* printing labels then needs the tracking page */
      }
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (result && preview) {
    return (
      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">
          {result.created.length} parcel(s) booked{result.failed.length ? `, ${result.failed.length} not booked` : ''}
        </h2>
        {result.failed.length > 0 && (
          <ul className="text-sm text-red-700">
            {result.failed.map((f) => (
              <li key={f.index}>Row {f.index + 2}: {f.message}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Link to="/business/labels" className="btn-primary">Print labels</Link>
          <button
            className="btn-secondary"
            onClick={() =>
              download(
                `bookings-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(['row', 'reference', 'tracking_number', 'recipient', 'city', 'amount_ghs'], result.created.map((c) => {
                  const r = preview.rows.find((x) => x.index === c.index)!;
                  return [c.index + 2, r.reference ?? '', c.trackingNumber, r.recipient?.name ?? '', r.destination?.city ?? '', ((r.quote?.totalPesewas ?? 0) / 100).toFixed(2)];
                })),
              )
            }
          >
            Download tracking numbers (CSV)
          </button>
          <button className="btn-secondary" onClick={() => { setRows([]); setPreview(null); setResult(null); setTerms(false); setFileName(''); }}>
            Upload another file
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 text-sm">
        <h2 className="text-lg font-semibold">Upload a CSV of deliveries</h2>
        <p className="text-slate-600">
          One row per parcel, up to 200 rows. Collected from <strong>{business.pickupAddress.line1}</strong>. If you leave lat/lng empty we look the address up and show you what it matched.
        </p>
        <button className="btn-secondary" onClick={() => download('delivery-template.csv', toCsv([...BULK_CSV_COLUMNS], [SAMPLE]))}>
          Download template
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void onFile(e.target.files?.[0])} />
          {fileName && <span className="text-slate-600">{fileName}: {rows.length} row(s)</span>}
        </div>
        {missing.length > 0 && <p className="text-red-700">Missing columns: {missing.join(', ')}. Use the template.</p>}
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 font-medium">Payment</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={payment === 'business_invoice'} disabled={!onAccount} onChange={() => setPayment('business_invoice')} /> Monthly invoice{!onAccount && ' (needs approved credit)'}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={payment === 'cash_on_pickup'} onChange={() => setPayment('cash_on_pickup')} /> Pay the driver at pickup
          </label>
        </fieldset>
        <button className="btn-primary" disabled={busy || rows.length === 0 || missing.length > 0} onClick={check}>
          {busy && !preview ? 'Checking addresses and prices…' : 'Check and price'}
        </button>
        {error && <p role="alert" className="text-red-700">{error}</p>}
      </section>

      {preview && (
        <section className="card space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {preview.validCount} ready · {preview.invalidCount} to fix
            </h2>
            <p className="text-lg font-bold">{formatGhs(preview.totalPesewas)}</p>
          </div>
          {preview.bulkDiscountPercent > 0 && <p className="text-sm text-brand-700">Volume discount applied: {preview.bulkDiscountPercent}%</p>}
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Row</th>
                  <th className="px-2 py-1.5">Ref</th>
                  <th className="px-2 py-1.5">Recipient</th>
                  <th className="px-2 py-1.5">Destination</th>
                  <th className="px-2 py-1.5">Service</th>
                  <th className="px-2 py-1.5 text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index} className={`border-t border-slate-100 ${r.ok ? '' : 'bg-red-50'}`}>
                    <td className="px-2 py-1.5">{r.index + 2}</td>
                    <td className="px-2 py-1.5">{r.reference}</td>
                    <td className="px-2 py-1.5">{r.recipient?.name ?? rows[r.index]?.recipient_name}</td>
                    <td className="px-2 py-1.5">
                      {r.ok ? (
                        <>
                          {r.destination?.line1}, {r.destination?.city}
                          {r.geocodedLabel && <span className="block text-xs text-slate-500">Matched: {r.geocodedLabel}</span>}
                        </>
                      ) : (
                        <span className="text-red-700">{r.errors.join('; ')}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{r.quote?.deliveryType.replace('_', '-')}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.quote ? formatGhs(r.quote.totalPesewas) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.invalidCount > 0 && <p className="text-sm text-slate-600">Rows with problems are skipped. Fix them in your file and upload them again.</p>}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> I confirm the parcel details and accept the{' '}
            <Link to="/terms" className="text-brand-700 underline" target="_blank">terms of carriage</Link>
          </label>
          <button className="btn-primary" disabled={busy || !terms || preview.validCount === 0} onClick={confirm}>
            {busy ? 'Booking…' : `Book ${preview.validCount} parcel(s) — ${formatGhs(preview.totalPesewas)}`}
          </button>
          <p className="text-xs text-slate-500">Prices are held until {new Date(preview.expiresAt).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' })}.</p>
        </section>
      )}
    </div>
  );
}
