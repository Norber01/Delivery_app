const env = import.meta.env;

export const config = {
  companyName: env.VITE_COMPANY_NAME || 'Courier',
  useEmulators: env.VITE_USE_EMULATORS === 'true',
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-courier',
    appId: env.VITE_FIREBASE_APP_ID,
    databaseURL: env.VITE_FIREBASE_DATABASE_URL || 'http://127.0.0.1:9000?ns=demo-courier',
  },
  recaptchaSiteKey: env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined,
  mapboxPublicToken: (env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined) || undefined,
};
