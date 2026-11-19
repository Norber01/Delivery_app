import { FIREBASE_REGION } from '@courier/constants';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { config } from './config';

interface Backend {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  rtdb: Database;
  functions: Functions;
}
let backend: Backend | null = null;

export function getFirebase(): Backend {
  if (backend) return backend;
  const app = initializeApp(config.firebase);
  if (config.recaptchaSiteKey) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
  }
  const auth = getAuth(app);
  const db = getFirestore(app);
  const rtdb = getDatabase(app);
  const functions = getFunctions(app, FIREBASE_REGION);
  if (config.useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    // The emulator has no reCAPTCHA; real projects always verify.
    auth.settings.appVerificationDisabledForTesting = true;
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectDatabaseEmulator(rtdb, '127.0.0.1', 9000);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  backend = { app, auth, db, rtdb, functions };
  return backend;
}
