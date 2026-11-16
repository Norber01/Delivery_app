const env = import.meta.env;

export const config = {
  companyName: env.VITE_COMPANY_NAME || 'Courier',
  supportPhone: env.VITE_SUPPORT_PHONE || '',
  edgeApiUrl: (env.VITE_EDGE_API_URL || '').replace(/\/$/, ''),
  /** Public, URL-restricted Mapbox token for map display (optional: schematic map without it). */
  mapboxPublicToken: (env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined) || undefined,
  useEmulators: env.VITE_USE_EMULATORS === 'true',
  /** Set to "false" by the deploy until a Paystack key is configured. */
  onlinePayments: env.VITE_ONLINE_PAYMENTS !== 'false',
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-courier',
    appId: env.VITE_FIREBASE_APP_ID,
  },
  recaptchaSiteKey: env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined,
};
