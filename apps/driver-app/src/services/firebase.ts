import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp as getNativeApp } from '@react-native-firebase/app';
import {
  getToken as getNativeToken,
  initializeAppCheck as initializeNativeAppCheck,
  ReactNativeFirebaseAppCheckProvider,
} from '@react-native-firebase/app-check';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { CustomProvider, getToken, initializeAppCheck, type AppCheck } from 'firebase/app-check';
import * as FirebaseAuth from 'firebase/auth';
import { initializeFirestore, type Firestore } from 'firebase/firestore';
import { getFunctions, type Functions } from 'firebase/functions';
import { FIREBASE_REGION } from '@courier/constants';
import { config } from './config';

// The React Native build of firebase/auth exports getReactNativePersistence; the web types do not.
const { initializeAuth, getAuth } = FirebaseAuth;
const getReactNativePersistence = (FirebaseAuth as unknown as { getReactNativePersistence: (s: typeof AsyncStorage) => FirebaseAuth.Persistence }).getReactNativePersistence;

const app = getApps().length ? getApp() : initializeApp(config.firebase);

/**
 * App Check tokens come from Play Integrity through React Native Firebase, handed to the JS SDK so
 * callables and RTDB writes are attested. Play Integrity only vouches for apps installed from
 * Google Play; builds installed directly on phones (APK) carry a per-build App Check debug token
 * registered by the build workflow instead, which is revoked by deleting it in the Firebase console.
 */
const buildToken = process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN || undefined;
const nativeProvider = new ReactNativeFirebaseAppCheckProvider();
nativeProvider.configure({
  android: __DEV__ || buildToken ? { provider: 'debug', ...(buildToken ? { debugToken: buildToken } : {}) } : { provider: 'playIntegrity' },
});
const nativeAppCheck = initializeNativeAppCheck(getNativeApp(), { provider: nativeProvider, isTokenAutoRefreshEnabled: true });

export const appCheck: AppCheck = initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: async () => {
      const { token } = await getNativeToken(nativeAppCheck, false);
      return { token, expireTimeMillis: Date.now() + 30 * 60_000 };
    },
  }),
  isTokenAutoRefreshEnabled: true,
});

export const auth: FirebaseAuth.Auth = (() => {
  try {
    return initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    return getAuth(app); // already initialised (fast refresh / headless task)
  }
})();

export const db: Firestore = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const functions: Functions = getFunctions(app, FIREBASE_REGION);

/** App Check token for raw HTTP calls (RTDB REST writes). */
export async function appCheckToken(): Promise<string | null> {
  try {
    return (await getToken(appCheck)).token;
  } catch {
    return null;
  }
}

/** Resolves once persisted auth state has loaded (needed in the headless location task). */
export function authReady(): Promise<FirebaseAuth.User | null> {
  return new Promise((resolve) => {
    const unsub = FirebaseAuth.onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });
}
