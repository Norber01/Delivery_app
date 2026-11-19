import type { DeliveryRequestDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, limit, onSnapshot, orderBy, query, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getDb } from '../../lib/db';
import { BOOKING_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '../../lib/labels';

type Row = DeliveryRequestDoc & { createdAt?: Timestamp };

export function BusinessBookings({ businessId }: { businessId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(
    () =>
      onSnapshot(query(collection(getDb(), 'deliveryRequests'), where('businessId', '==', businessId), orderBy('createdAt', 'desc'), limit(200)), (s) =>
        setRows(s.docs.map((d) => d.data() as Row)),
      ),
    [businessId],
  );
  const f = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !f || [r.trackingNumber, r.clientReference ?? '', r.recipient.name, r.destination.city].some((x) => x.toLowerCase().includes(f)));
  return (
    <section className="space-y-3">
      <input className="input max-w-sm" placeholder="Search tracking no., reference, recipient, city" aria-label="Search bookings" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {rows === null ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2">Tracking</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.trackingNumber} className="border-t border-slate-100">
                  <td className="px-3 py-2"><Link className="font-mono text-brand-700 hover:underline" to={`/track/${r.trackingNumber}`}>{r.trackingNumber}</Link></td>
                  <td className="px-3 py-2">{r.clientReference ?? '—'}</td>
                  <td className="px-3 py-2">{r.recipient.name}</td>
                  <td className="px-3 py-2">{r.destination.city}</td>
                  <td className="px-3 py-2">
                    {BOOKING_STATUS_LABEL[r.status]}
                    <span className="block text-xs text-slate-500">{PAYMENT_STATUS_LABEL[r.paymentStatus]}{r.invoiceId ? ' · on invoice' : ''}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatGhs(r.price.totalPesewas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
