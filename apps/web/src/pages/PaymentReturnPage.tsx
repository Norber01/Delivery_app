import type { PaymentStatusResponse } from '@courier/shared-types';
import { formatGhs, normalizeTrackingNumber } from '@courier/shared-utils';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PayButton } from '../components/PayButton';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ApiError } from '../lib/errors';
import { recallAccess } from '../lib/guestAccess';

const POLL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes; Mobile Money approvals can take a while

/**
 * Landing page after the hosted checkout. It never trusts the redirect itself: it only shows
 * what the server has verified with the payment provider.
 */
export function PaymentReturnPage() {
  const [params] = useSearchParams();
  const trackingNumber = normalizeTrackingNumber(params.get('tn') ?? '');
  const { loading: authLoading } = useAuth();
  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const accessToken = trackingNumber ? recallAccess(trackingNumber) : undefined;

  const settled = status && status.paymentStatus !== 'unpaid' && status.paymentStatus !== 'pending';
  const latest = status?.payments[0];
  const failed = !settled && latest && (latest.status === 'failed' || latest.status === 'expired');

  useEffect(() => {
    if (!trackingNumber || authLoading || settled || failed || polls >= MAX_POLLS) return;
    const t = setTimeout(
      async () => {
        try {
          setStatus(await api.getPaymentStatus({ trackingNumber, accessToken }));
        } catch (e) {
          setError((e as ApiError).message);
        }
        setPolls((n) => n + 1);
      },
      polls === 0 ? 0 : POLL_MS,
    );
    return () => clearTimeout(t);
  }, [trackingNumber, accessToken, authLoading, settled, failed, polls]);

  if (!trackingNumber) return <Shell title="Payment">Missing booking reference.</Shell>;
  if (error && !status) return <Shell title="Payment">{error}</Shell>;

  if (settled) {
    return (
      <Shell title="Payment received" tone="ok">
        <p>
          We received {formatGhs(status.totalPesewas)} for booking <span className="font-mono">{trackingNumber}</span>. Your booking is confirmed.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link className="btn-primary" to={`/track/${trackingNumber}`}>
            Track delivery
          </Link>
          <Link className="btn-secondary" to={`/receipt/${trackingNumber}`}>
            Receipt
          </Link>
        </div>
      </Shell>
    );
  }
  if (failed) {
    return (
      <Shell title="Payment not completed" tone="warn">
        <p>Your payment did not go through. No money was taken for this attempt. You can try again.</p>
        <div className="flex justify-center">
          <PayButton trackingNumber={trackingNumber} accessToken={accessToken} label="Try again" />
        </div>
      </Shell>
    );
  }
  if (polls >= MAX_POLLS) {
    return (
      <Shell title="Still waiting for confirmation" tone="warn">
        <p>
          We have not received confirmation from the payment provider yet. If you approved the payment, it will be confirmed automatically — you will
          get an SMS and can check the booking at any time.
        </p>
        <Link className="btn-secondary" to={`/track/${trackingNumber}`}>
          Check booking status
        </Link>
      </Shell>
    );
  }
  return (
    <Shell title="Confirming your payment…">
      <p>If you are paying with Mobile Money, approve the prompt on your phone. This page updates automatically.</p>
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" aria-hidden />
    </Shell>
  );
}

function Shell({ title, tone, children }: { title: string; tone?: 'ok' | 'warn'; children: React.ReactNode }) {
  const icon = tone === 'ok' ? '✓' : tone === 'warn' ? '!' : null;
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <div className="card space-y-4 text-center">
        {icon && (
          <div className={`mx-auto grid h-14 w-14 place-items-center rounded-full text-2xl ${tone === 'ok' ? 'bg-brand-100 text-brand-700' : 'bg-amber-100 text-amber-700'}`}>
            {icon}
          </div>
        )}
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="space-y-4 text-slate-600">{children}</div>
      </div>
    </div>
  );
}
