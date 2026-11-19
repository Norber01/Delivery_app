import type { InvoiceDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '../../lib/auth';
import { config } from '../../lib/config';
import { getDb } from '../../lib/db';
import { INVOICE_STATUS } from './Invoices';

/** Printable tax invoice (browser Print → Save as PDF). */
export function InvoicePage() {
  const { id = '' } = useParams();
  const { loading } = useAuth();
  const [inv, setInv] = useState<InvoiceDoc | null | 'denied'>(null);
  useEffect(() => {
    if (loading) return;
    getDoc(doc(getDb(), 'invoices', id))
      .then((s) => setInv(s.exists() ? (s.data() as InvoiceDoc) : 'denied'))
      .catch(() => setInv('denied'));
  }, [id, loading]);
  if (inv === null) return <p className="px-4 py-16 text-center text-slate-500">Loading…</p>;
  if (inv === 'denied') return <p className="px-4 py-16 text-center text-slate-600">This invoice is not available to your account.</p>;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <button className="btn-secondary" onClick={() => window.print()}>Print / save as PDF</button>
      </div>
      <article className="card space-y-6 print:border-0 print:shadow-none">
        <header className="flex justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{config.companyName}</h1>
            <p className="text-sm text-slate-500">{config.supportPhone}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">Invoice {inv.number}</p>
            <p className="text-sm">Period {inv.period}{inv.part > 1 ? ` (part ${inv.part})` : ''}</p>
            <p className="text-sm">Issued {new Date(inv.issuedAt).toLocaleDateString('en-GH')} · Due {new Date(inv.dueAt).toLocaleDateString('en-GH')}</p>
            <p className={`text-sm font-semibold ${inv.status === 'overdue' ? 'text-red-700' : ''}`}>{INVOICE_STATUS[inv.status]}</p>
          </div>
        </header>
        <section className="text-sm">
          <p className="font-semibold">Bill to</p>
          <p>{inv.businessName}</p>
          <p>TIN {inv.tin}</p>
        </section>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-300 text-left">
            <tr>
              <th className="py-1.5">Date</th>
              <th className="py-1.5">Tracking</th>
              <th className="py-1.5">Ref</th>
              <th className="py-1.5">Description</th>
              <th className="py-1.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.trackingNumber} className="border-b border-slate-100">
                <td className="py-1.5">{new Date(l.date).toLocaleDateString('en-GH')}</td>
                <td className="py-1.5 font-mono text-xs">{l.trackingNumber}</td>
                <td className="py-1.5">{l.reference ?? ''}</td>
                <td className="py-1.5">{l.description}</td>
                <td className="py-1.5 text-right tabular-nums">{formatGhs(l.amountPesewas)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4} className="pt-3 font-semibold">Total ({inv.lines.length} deliveries)</td><td className="pt-3 text-right font-semibold tabular-nums">{formatGhs(inv.totalPesewas)}</td></tr>
            <tr><td colSpan={4}>Paid</td><td className="text-right tabular-nums">{formatGhs(inv.paidPesewas)}</td></tr>
            <tr><td colSpan={4} className="font-semibold">Balance due</td><td className="text-right font-semibold tabular-nums">{formatGhs(inv.totalPesewas - inv.paidPesewas)}</td></tr>
          </tfoot>
        </table>
        <footer className="text-xs text-slate-500">Line amounts are the confirmed booking prices, including any taxes shown on each booking. Quote {inv.number} with your payment.</footer>
      </article>
    </div>
  );
}
