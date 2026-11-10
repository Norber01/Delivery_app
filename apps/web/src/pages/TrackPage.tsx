import type { TrackingView } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { PayButton } from '../components/PayButton';
import { PriceBreakdown } from '../components/PriceBreakdown';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ApiError } from '../lib/errors';
import { accessFromHash, recallAccess, rememberAccess } from '../lib/guestAccess';
import { DELIVERY_TYPE_LABEL, PAYMENT_PREFERENCE_LABEL, PAYMENT_RECORD_LABEL, PAYMENT_STATUS_LABEL } from '../lib/labels';

export function TrackPage() {
  const { tn } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState(tn ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim().toUpperCase().replace(/[\s-]/g, '');
    if (v) navigate(`/track/${v}`);
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <h1 className="text-3xl font-bold">Track a delivery</h1>
      <form onSubmit={submit} className="flex gap-2">
        <input
          className="input font-mono uppercase"
          aria-label="Tracking number"
          placeholder="GH…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn-primary shrink-0">Track</button>
      </form>
      {tn && <TrackingResult key={tn} trackingNumber={tn} />}
    </div>
  );
}

function TrackingResult({ trackingNumber }: { trackingNumber: string }) {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [view, setView] = useState<TrackingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | undefined>(() => accessFromHash(location.hash) ?? recallAccess(trackingNumber));
  const [codeInput, setCodeInput] = useState('');

  useEffect(() => {
    const fromHash = accessFromHash(location.hash);
    if (fromHash) {
      rememberAccess(trackingNumber, fromHash);
      // Keep the code out of the visible address bar/history once captured.
      history.replaceState(null, '', location.pathname);
    }
  }, [location.hash, location.pathname, trackingNumber]);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    setError(null);
    api
      .getTrackingView({ trackingNumber, accessToken: token })
      .then((v) => !cancelled && setView(v))
      .catch((e: ApiError) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [trackingNumber, token, authLoading, user]);

  if (error) return <p className="card text-red-700">{error}</p>;
  if (!view) return <p className="text-slate-500">Loading…</p>;
  const d = view.details;

  return (
    <div className="space-y-6">
      <div className="card space-y-2">
        <p className="font-mono text-sm text-slate-500">{view.trackingNumber}</p>
        <h2 className="text-2xl font-bold">{view.statusLabel}</h2>
        <p className="text-slate-600">
          {DELIVERY_TYPE_LABEL[view.deliveryType]} · {view.origin.city} → {view.destination.city}
        </p>
        <p className="text-sm text-slate-500">Payment: {PAYMENT_STATUS_LABEL[view.paymentStatus]}</p>
      </div>

      {d?.canPayOnline && (
        <div className="card flex flex-wrap items-center justify-between gap-4 border-amber-200 bg-amber-50">
          <div>
            <p className="font-semibold">Payment needed to confirm this booking</p>
            <p className="text-sm text-slate-600">Total {formatGhs(d.price.totalPesewas)}</p>
          </div>
          <PayButton trackingNumber={view.trackingNumber} accessToken={token} />
        </div>
      )}

      <section className="card">
        <h3 className="mb-4 font-semibold">History</h3>
        <ol className="relative space-y-4 border-l border-slate-200 pl-6">
          {[...view.timeline].reverse().map((t, i) => (
            <li key={`${t.type}-${t.at}-${i}`}>
              <span className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${i === 0 ? 'bg-brand-600' : 'bg-slate-300'}`} />
              <p className="font-medium">{t.label}</p>
              <p className="text-xs text-slate-500">{new Date(t.at).toLocaleString('en-GH')}</p>
            </li>
          ))}
        </ol>
      </section>

      <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
        Live driver location appears here once a driver is on the way with your package.
      </p>

      {d ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['Pickup', d.sender, d.pickup],
                ['Delivery', d.recipient, d.destination],
              ] as const
            ).map(([title, contact, address]) => (
              <div key={title} className="card text-sm">
                <h3 className="mb-2 font-semibold">{title}</h3>
                <p>{contact.name}</p>
                <p className="text-slate-600">{contact.phone}</p>
                <p className="mt-2 text-slate-600">{address.line1}</p>
                {address.landmark && <p className="text-slate-500">Near {address.landmark}</p>}
                <p className="text-slate-500">
                  {address.city}, {address.region}
                </p>
              </div>
            ))}
          </section>
          <PriceBreakdown quote={d.price} />
          <section className="card text-sm">
            <h3 className="mb-2 font-semibold">Payment</h3>
            <p className="text-slate-600">Method: {PAYMENT_PREFERENCE_LABEL[d.paymentPreference]}</p>
            {d.payments.length > 0 && (
              <ul className="mt-2 space-y-1">
                {d.payments.map((p) => (
                  <li key={p.reference} className="flex justify-between gap-2 text-slate-600">
                    <span className="font-mono text-xs">{p.reference}</span>
                    <span>
                      {PAYMENT_RECORD_LABEL[p.status]} · {formatGhs(p.amountPesewas)}
                      {p.refundedPesewas > 0 && ` (refunded ${formatGhs(p.refundedPesewas)})`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(view.paymentStatus === 'paid' || view.paymentStatus === 'partially_refunded' || view.paymentStatus === 'refunded') && (
              <Link to={`/receipt/${view.trackingNumber}`} className="mt-3 inline-block text-brand-700 hover:underline">
                View receipt
              </Link>
            )}
          </section>
        </>
      ) : (
        <form
          className="card flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeInput.trim()) setToken(codeInput.trim());
          }}
        >
          {token && <p className="w-full text-sm text-amber-700">That access code does not match this booking.</p>}
          <label className="min-w-0 flex-1 text-sm">
            Are you the sender? Enter your booking access code to see full details{user ? '' : ' (or sign in)'}.
            <input className="input mt-1 font-mono" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} />
          </label>
          <button className="btn-secondary">Show details</button>
        </form>
      )}
    </div>
  );
}
