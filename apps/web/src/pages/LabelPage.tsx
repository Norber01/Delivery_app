import type { TrackingView } from '@courier/shared-types';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { config } from '../lib/config';
import type { ApiError } from '../lib/errors';
import { recallAccess } from '../lib/guestAccess';

/**
 * Printable shipping label. The QR encodes only the tracking number, which the driver scans
 * at pickup to confirm the right package. Print on A6 or A4 and attach to the package.
 */
export function LabelPage() {
  const { tn = '' } = useParams();
  const { loading } = useAuth();
  const [view, setView] = useState<TrackingView | null>(null);
  const [qr, setQr] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    api
      .getTrackingView({ trackingNumber: tn, accessToken: recallAccess(tn) })
      .then(async (v) => {
        setView(v);
        setQr(await QRCode.toString(v.trackingNumber, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }));
      })
      .catch((e: ApiError) => setError(e.message));
  }, [tn, loading]);

  if (error) return <p className="mx-auto max-w-xl px-4 py-16 text-center text-red-700">{error}</p>;
  if (!view) return <p className="px-4 py-16 text-center text-slate-500">Loading…</p>;
  const d = view.details;
  return (
    <div className="mx-auto max-w-md px-4 py-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <button className="btn-primary" onClick={() => window.print()}>
          Print label
        </button>
      </div>
      <article className="space-y-3 rounded-lg border-2 border-black p-4 text-black" aria-label="Shipping label">
        <header className="flex items-center justify-between border-b-2 border-black pb-2">
          <strong className="text-lg">{config.companyName}</strong>
          <span className="text-sm uppercase">{view.deliveryType.replace('_', '-')} · {view.urgency.replace('_', ' ')}</span>
        </header>
        <div className="flex items-center gap-4">
          <div className="w-36 shrink-0" dangerouslySetInnerHTML={{ __html: qr }} aria-label={`QR code for ${view.trackingNumber}`} role="img" />
          <p className="font-mono text-xl font-bold tracking-wider break-all">{view.trackingNumber}</p>
        </div>
        <section>
          <p className="text-xs uppercase">To</p>
          {d ? (
            <>
              <p className="text-lg font-bold">{d.recipient.name}</p>
              <p>{d.recipient.phone}</p>
              <p>{d.destination.line1}</p>
              {d.destination.landmark && <p>Near {d.destination.landmark}</p>}
            </>
          ) : null}
          <p className="font-semibold">
            {view.destination.city}, {view.destination.region}
          </p>
        </section>
        {d && (
          <section className="border-t border-black pt-2 text-sm">
            <p className="text-xs uppercase">From</p>
            <p>
              {d.sender.name} · {view.origin.city}
            </p>
          </section>
        )}
        {d?.packages.some((p) => p.quantity > 1) || (d?.packages.length ?? 0) > 1 ? (
          <p className="text-sm">{d!.packages.reduce((n, p) => n + p.quantity, 0)} items — attach a copy to each</p>
        ) : null}
      </article>
    </div>
  );
}
