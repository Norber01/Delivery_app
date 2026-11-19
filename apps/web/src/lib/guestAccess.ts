/**
 * Guest access codes are kept only for this browser tab (sessionStorage) so a guest can
 * return from the payment page. Never sent anywhere except our own callable functions.
 */
const key = (tn: string) => `access:${tn}`;

export function rememberAccess(trackingNumber: string, token: string) {
  try {
    sessionStorage.setItem(key(trackingNumber), token);
  } catch {
    /* storage unavailable: the guest can still paste the code */
  }
}

export function recallAccess(trackingNumber: string): string | undefined {
  try {
    return sessionStorage.getItem(key(trackingNumber)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Read `#k=<code>` from the URL fragment (fragments are never sent to servers). */
export function accessFromHash(hash: string): string | undefined {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{32})(?:&|$)/.exec(hash);
  return m?.[1];
}

export const trackLink = (trackingNumber: string, token?: string | null) =>
  `/track/${trackingNumber}${token ? `#k=${token}` : ''}`;
