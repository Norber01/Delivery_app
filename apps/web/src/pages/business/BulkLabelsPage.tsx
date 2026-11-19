import type { Address, Contact } from '@courier/shared-types';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { config } from '../../lib/config';

interface Label {
  trackingNumber: string;
  reference: string | null;
  recipient?: Contact;
  destination?: Address;
  deliveryType?: string;
}

/** All labels from the last bulk upload, two per A4 row, ready to print. */
export function BulkLabelsPage() {
  const [data, setData] = useState<{ sender: string; labels: (Label & { qr: string })[] } | null>(null);
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('bulk-labels');
    } catch {
      /* unavailable */
    }
    if (!raw) return setData({ sender: '', labels: [] });
    const parsed = JSON.parse(raw) as { sender: string; labels: Label[] };
    void Promise.all(parsed.labels.map(async (l) => ({ ...l, qr: await QRCode.toString(l.trackingNumber, { type: 'svg', margin: 1 }) }))).then((labels) => setData({ sender: parsed.sender, labels }));
  }, []);
  if (!data) return <p className="px-4 py-16 text-center text-slate-500">Preparing labels…</p>;
  if (!data.labels.length) return <p className="px-4 py-16 text-center text-slate-600">No labels to print. Labels are available right after a bulk upload in this browser tab.</p>;
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 print:p-0">
      <div className="mb-4 flex justify-between print:hidden">
        <p className="text-sm text-slate-600">{data.labels.length} label(s)</p>
        <button className="btn-primary" onClick={() => window.print()}>Print labels</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {data.labels.map((l) => (
          <article key={l.trackingNumber} className="break-inside-avoid space-y-2 rounded border-2 border-black p-3 text-black" aria-label={`Label ${l.trackingNumber}`}>
            <header className="flex justify-between text-xs font-semibold uppercase"><span>{config.companyName}</span><span>{l.deliveryType?.replace('_', '-')}</span></header>
            <div className="flex items-center gap-3">
              <div className="w-24 shrink-0" dangerouslySetInnerHTML={{ __html: l.qr }} />
              <p className="break-all font-mono text-base font-bold">{l.trackingNumber}</p>
            </div>
            <p className="text-xs uppercase">To</p>
            <p className="font-bold">{l.recipient?.name}</p>
            <p className="text-sm">{l.recipient?.phone}</p>
            <p className="text-sm">{l.destination?.line1}, {l.destination?.city}</p>
            <p className="border-t border-black pt-1 text-xs">From {data.sender}{l.reference ? ` · Ref ${l.reference}` : ''}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
