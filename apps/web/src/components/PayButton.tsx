import { useState } from 'react';
import { api } from '../lib/api';
import type { ApiError } from '../lib/errors';
import { rememberAccess } from '../lib/guestAccess';

/** Starts a hosted checkout. The amount is decided by the server from the booking. */
export function PayButton({ trackingNumber, accessToken, label = 'Pay now' }: { trackingNumber: string; accessToken?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      if (accessToken) rememberAccess(trackingNumber, accessToken); // needed after returning from checkout
      const { authorizationUrl } = await api.initiatePayment({ trackingNumber, accessToken });
      window.location.assign(authorizationUrl);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <button type="button" className="btn-primary" onClick={pay} disabled={busy}>
        {busy ? 'Opening secure checkout…' : label}
      </button>
      <p className="text-xs text-slate-500">Mobile Money (MTN, Telecel, AirtelTigo) or card, on our payment partner's secure page.</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
