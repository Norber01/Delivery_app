/**
 * Shared state of the demo runtime: the database, the start-up promise, and the signed-in user of
 * this app (website and ops app keep separate sessions in the same browser).
 */
import { setDemoDb } from '../admin/firestore.js';
import { DemoDb } from '../db/store.js';

/** Bump when the sample data changes shape: browsers holding an older copy start fresh. */
export const STORAGE_KEY = 'courier-demo-v2';

function dropOldCopies() {
  try {
    for (const k of Object.keys(localStorage)) {
      // Older sample databases, and sign-ins that may name people who no longer exist.
      if (/^courier-demo-v\d+$/.test(k) && k !== STORAGE_KEY) {
        localStorage.removeItem(k);
        for (const s of Object.keys(localStorage)) if (s.startsWith('courier-demo-session')) localStorage.removeItem(s);
      }
    }
  } catch {
    /* storage blocked: nothing saved anyway */
  }
}
/** Demo clock offset: lets the seed run "in the past" through the real services. */
let clockOverride: Date | null = null;
export const demoNow = () => clockOverride ?? new Date();
export function withClock<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  clockOverride = at;
  return fn().finally(() => {
    clockOverride = null;
  });
}

let db: DemoDb | null = null;
export function theDb(): DemoDb {
  if (!db) {
    if (typeof localStorage !== 'undefined') dropOldCopies();
    db = new DemoDb({ storageKey: typeof localStorage === 'undefined' ? undefined : STORAGE_KEY, now: demoNow });
    setDemoDb(db);
    db.load();
  }
  return db;
}

let ready: Promise<void> | null = null;
/** Resolves once services are wired and the sample data exists. */
export function demoReady(): Promise<void> {
  ready ??= import('./start.js').then((m) => m.start());
  return ready;
}

// ---- Accounts and sessions -------------------------------------------------------------------

export interface DemoAccount {
  uid: string;
  email: string | null;
  phone: string | null;
  password: string | null;
  displayName: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}
export const ACCOUNTS = '_demoAccounts';

export function getAccount(uid: string): DemoAccount | null {
  return (theDb().get(`${ACCOUNTS}/${uid}`) as DemoAccount | undefined) ?? null;
}
export function findAccount(by: { email?: string; phone?: string }): DemoAccount | null {
  for (const [, a] of theDb().list(ACCOUNTS)) {
    const acc = a as unknown as DemoAccount;
    if (by.email && acc.email?.toLowerCase() === by.email.toLowerCase()) return acc;
    if (by.phone && acc.phone === by.phone) return acc;
  }
  return null;
}
export function saveAccount(a: DemoAccount) {
  theDb().commit([{ type: 'set', path: `${ACCOUNTS}/${a.uid}`, data: a as unknown as Record<string, unknown> }]);
}

const appKey = () => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `courier-demo-session:${base}`;
};
export function sessionUid(): string | null {
  try {
    return localStorage.getItem(appKey());
  } catch {
    return null;
  }
}
export function setSessionUid(uid: string | null) {
  try {
    if (uid) localStorage.setItem(appKey(), uid);
    else localStorage.removeItem(appKey());
  } catch {
    /* private mode: session lasts until reload */
  }
  sessionListeners.forEach((l) => l());
}
const sessionListeners = new Set<() => void>();
export function onSessionChange(fn: () => void) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

const STAFF = ['hub_operator', 'dispatcher', 'fleet_manager', 'finance', 'manager', 'admin', 'super_admin'];
/** The decoded-token shape the Cloud Functions code expects (`req.auth`). */
export function authFor(uid: string | null) {
  const a = uid ? getAccount(uid) : null;
  if (!a) return undefined;
  const staff = STAFF.includes(String(a.claims.role ?? ''));
  return {
    uid: a.uid,
    token: {
      ...a.claims,
      email: a.email ?? undefined,
      phone_number: a.phone ?? undefined,
      email_verified: a.emailVerified,
      // Demo staff are treated as signed in with two-step verification.
      firebase: { sign_in_provider: a.email ? 'password' : 'phone', ...(staff ? { sign_in_second_factor: 'phone' } : {}) },
    },
  };
}
export const isStaffRole = (role: unknown) => STAFF.includes(String(role ?? ''));
