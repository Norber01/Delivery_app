import { FIREBASE_REGION } from '@courier/constants';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { config } from './config';

interface Backend {
  app: FirebaseApp;
  auth: Auth;
  functions: Functions;
}

let backend: Backend | null = null;

/** Lazily initialise Firebase (+ App Check) once for the whole app. */
export function getFirebase(): Backend {
  if (backend) return backend;
  const app = initializeApp(config.firebase);
  if (config.useEmulators) {
    // Emulators accept a debug token; never enabled in production builds.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  if (config.recaptchaSiteKey) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
  } else if (!config.useEmulators) {
    console.warn('App Check site key missing: backend calls will be rejected.');
  }
  const auth = getAuth(app);
  const functions = getFunctions(app, FIREBASE_REGION);
  if (config.useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  backend = { app, auth, functions };
  return backend;
}

/** Back-compat for callers that only need Functions. */
export const getBackend = () => getFirebase().functions;
