import type { InvoiceDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getDb } from '../../lib/db';

export const INVOICE_STATUS = { issued: 'Issued', partially_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', void: 'Void' } as const;

export function Invoices({ businessId }: { businessId: string }) {
  const [list, setList] = useState<InvoiceDoc[] | null>(null);
  useEffect(() => onSnapshot(query(collection(getDb(), 'invoices'), where('businessId', '==', businessId), orderBy('issuedAt', 'desc')), (s) => setList(s.docs.map((d) => d.data() as InvoiceDoc))), [businessId]);
  if (!list) return <p className="text-slate-500">Loading…</p>;
  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-600">Invoices are issued on the 1st of each month for the previous month's account bookings. Pay by bank transfer or Mobile Money quoting the invoice number.</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Invoice</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No invoices yet.</td></tr>
            )}
            {list.map((i) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="px-3 py-2"><Link className="font-mono text-brand-700 hover:underline" to={`/business/invoices/${i.id}`}>{i.number}</Link></td>
                <td className="px-3 py-2">{i.period}</td>
                <td className="px-3 py-2">{new Date(i.dueAt).toLocaleDateString('en-GH')}</td>
                <td className={`px-3 py-2 ${i.status === 'overdue' ? 'font-semibold text-red-700' : ''}`}>{INVOICE_STATUS[i.status]}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatGhs(i.totalPesewas)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{i.status === 'void' ? '—' : formatGhs(i.totalPesewas - i.paidPesewas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
