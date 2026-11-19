import type { TrackingView } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { config } from '../lib/config';
import type { ApiError } from '../lib/errors';
import { recallAccess } from '../lib/guestAccess';
import { DELIVERY_TYPE_LABEL, PAYMENT_PREFERENCE_LABEL } from '../lib/labels';

/** Printable receipt built from server data (browser "Print → Save as PDF" for a file). */
export function ReceiptPage() {
  const { tn = '' } = useParams();
  const { loading } = useAuth();
  const [view, setView] = useState<TrackingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    api
      .getTrackingView({ trackingNumber: tn, accessToken: recallAccess(tn) })
      .then(setView)
      .catch((e: ApiError) => setError(e.message));
  }, [tn, loading]);

  if (error) return <p className="mx-auto max-w-xl px-4 py-16 text-center text-red-700">{error}</p>;
  if (!view) return <p className="px-4 py-16 text-center text-slate-500">Loading…</p>;
  const d = view.details;
  if (!d) {
    return (
      <p className="mx-auto max-w-xl px-4 py-16 text-center text-slate-600">
        Receipts are available to the account holder or with the booking access code. <Link to={`/track/${tn}`} className="text-brand-700 underline">Open the booking</Link>.
      </p>
    );
  }
  const paid = d.payments.filter((p) => p.status === 'succeeded');
  const isPaid = paid.length > 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 print:py-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <button className="btn-secondary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
      </div>
      <article className="card space-y-6 print:border-0 print:shadow-none">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold">{config.companyName}</h1>
            {config.supportPhone && <p className="text-sm text-slate-500">{config.supportPhone}</p>}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{isPaid ? 'Payment receipt' : 'Booking summary'}</p>
            <p className="font-mono text-sm">{view.trackingNumber}</p>
            <p className="text-sm text-slate-500">Booked {new Date(view.bookedAt).toLocaleDateString('en-GH')}</p>
          </div>
        </header>
        <section className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="font-semibold">From</p>
            <p>{d.sender.name}</p>
            <p className="text-slate-600">{d.pickup.line1}, {d.pickup.city}</p>
          </div>
          <div>
            <p className="font-semibold">To</p>
            <p>{d.recipient.name}</p>
            <p className="text-slate-600">{d.destination.line1}, {d.destination.city}</p>
          </div>
        </section>
        <p className="text-sm text-slate-600">{DELIVERY_TYPE_LABEL[view.deliveryType]}</p>
        <table className="w-full text-sm">
          <tbody>
            {d.price.lines.map((l) => (
              <tr key={l.code} className="border-b border-slate-100">
                <td className="py-1.5">{l.label}</td>
                <td className="py-1.5 text-right tabular-nums">{formatGhs(l.amountPesewas)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-3 font-semibold">Total</td>
              <td className="pt-3 text-right font-semibold tabular-nums">{formatGhs(d.price.totalPesewas)}</td>
            </tr>
          </tbody>
        </table>
        <section className="text-sm">
          <p className="font-semibold">Payment</p>
          {isPaid ? (
            paid.map((p) => (
              <p key={p.reference} className="text-slate-600">
                {formatGhs(p.amountPesewas)} via {p.channel === 'mobile_money' ? 'Mobile Money' : p.channel === 'card' ? 'card' : p.channel ?? 'online payment'}
                {p.paidAt && ` on ${new Date(p.paidAt).toLocaleString('en-GH')}`} · Ref {p.reference}
                {p.refundedPesewas > 0 && ` · Refunded ${formatGhs(p.refundedPesewas)}`}
              </p>
            ))
          ) : (
            <p className="text-slate-600">Not yet paid — {PAYMENT_PREFERENCE_LABEL[d.paymentPreference]}.</p>
          )}
        </section>
        <footer className="text-xs text-slate-500">Prices include all charges shown. Price rules version {d.price.pricingVersion}.</footer>
      </article>
    </div>
  );
}
