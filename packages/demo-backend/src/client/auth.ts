/**
 * Stand-in for `firebase/auth` in the demo build. Accounts live in the demo database (shared by
 * the website and ops app); phone sign-in codes are always 123456; staff count as having used
 * two-step verification. Each app keeps its own signed-in user.
 */
import { randomId } from './ids.js';
import {
  authFor,
  demoReady,
  findAccount,
  getAccount,
  isStaffRole,
  onSessionChange,
  saveAccount,
  sessionUid,
  setSessionUid,
  theDb,
  type DemoAccount,
} from '../runtime/core.js';

export const DEMO_CODE = '123456';

class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class DemoUser {
  constructor(private acc: DemoAccount) {}
  get uid() {
    return this.acc.uid;
  }
  get email() {
    return this.acc.email;
  }
  get phoneNumber() {
    return this.acc.phone;
  }
  get displayName() {
    return this.acc.displayName;
  }
  get emailVerified() {
    return this.acc.emailVerified;
  }
  readonly isAnonymous = false;
  get providerData() {
    return [{ providerId: this.acc.email ? 'password' : 'phone' }];
  }
  async getIdToken(_force?: boolean) {
    return `demo-token-${this.uid}`;
  }
  async getIdTokenResult(_force?: boolean) {
    this.refresh();
    const t = authFor(this.uid)!.token;
    return { token: `demo-token-${this.uid}`, claims: t as Record<string, unknown>, signInSecondFactor: isStaffRole(this.acc.claims.role) ? 'phone' : null, signInProvider: t.firebase.sign_in_provider };
  }
  async reload() {
    this.refresh();
  }
  refresh() {
    const a = getAccount(this.uid);
    if (a) this.acc = a;
  }
}

export interface Auth {
  currentUser: DemoUser | null;
  settings: Record<string, unknown>;
  languageCode: string | null;
}
export type User = DemoUser;
export type ConfirmationResult = { verificationId: string; confirm: (code: string) => Promise<{ user: DemoUser }> };
export type MultiFactorError = AuthError;
export type MultiFactorResolver = { hints: unknown[]; session: unknown; resolveSignIn: (a: unknown) => Promise<{ user: DemoUser }> };
export type TotpSecret = { secretKey: string; generateQrCodeUrl: () => string };

const auth: Auth = { currentUser: null, settings: {}, languageCode: null };
const listeners = new Set<(u: DemoUser | null) => void>();
let lastKey = '';

function current(): DemoUser | null {
  const uid = sessionUid();
  const acc = uid ? getAccount(uid) : null;
  if (!acc) return null;
  if (auth.currentUser?.uid === acc.uid) {
    auth.currentUser.refresh();
    return auth.currentUser;
  }
  return new DemoUser(acc);
}
/** Tell listeners when the user or their claims change (also after another tab changes claims). */
function emit(force = false) {
  const u = current();
  auth.currentUser = u;
  const key = u ? JSON.stringify([u.uid, getAccount(u.uid)?.claims, u.emailVerified]) : '';
  if (!force && key === lastKey) return;
  lastKey = key;
  listeners.forEach((l) => l(u));
}
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  void demoReady().then(() => {
    theDb().subscribe(() => emit());
    onSessionChange(() => emit());
    emit(true);
  });
}

export const getAuth = (_app?: unknown): Auth => {
  wire();
  return auth;
};
export const connectAuthEmulator = () => {};

export function onIdTokenChanged(_a: Auth, cb: (u: DemoUser | null) => void) {
  wire();
  listeners.add(cb);
  void demoReady().then(() => {
    if (listeners.has(cb)) cb(current());
  });
  return () => listeners.delete(cb);
}
export const onAuthStateChanged = onIdTokenChanged;

async function signInAs(acc: DemoAccount) {
  setSessionUid(acc.uid);
  emit(true);
  return { user: auth.currentUser! };
}

export async function signInWithEmailAndPassword(_a: Auth, email: string, password: string) {
  await demoReady();
  const acc = findAccount({ email: email.trim() });
  if (!acc || acc.password !== password) throw new AuthError('auth/invalid-credential', 'Email or password is incorrect. Demo accounts use the password "demo1234".');
  return signInAs(acc);
}

export async function createUserWithEmailAndPassword(_a: Auth, email: string, password: string) {
  await demoReady();
  if (findAccount({ email })) throw new AuthError('auth/email-already-in-use', 'An account with this email already exists.');
  if (password.length < 6) throw new AuthError('auth/weak-password', 'Use at least 6 characters.');
  const acc: DemoAccount = { uid: `u_${randomId(16)}`, email: email.trim().toLowerCase(), phone: null, password, displayName: null, emailVerified: false, claims: {} };
  saveAccount(acc);
  return signInAs(acc);
}

export class RecaptchaVerifier {
  constructor(..._args: unknown[]) {}
  async render() {
    return 0;
  }
  async verify() {
    return 'demo';
  }
  clear() {}
}

export async function signInWithPhoneNumber(_a: Auth, phone: string, _v?: unknown): Promise<ConfirmationResult> {
  await demoReady();
  return {
    verificationId: 'demo',
    confirm: async (code: string) => {
      if (code !== DEMO_CODE) throw new AuthError('auth/invalid-verification-code', `Wrong code. In the demo the code is always ${DEMO_CODE}.`);
      let acc = findAccount({ phone });
      if (!acc) {
        acc = { uid: `u_${randomId(16)}`, email: null, phone, password: null, displayName: null, emailVerified: false, claims: {} };
        saveAccount(acc);
      }
      return signInAs(acc);
    },
  };
}

export async function sendEmailVerification(user: DemoUser) {
  const acc = getAccount(user.uid);
  if (acc) saveAccount({ ...acc, emailVerified: true }); // the demo "inbox" verifies instantly
}
export async function sendPasswordResetEmail() {}
export async function updateProfile(user: DemoUser, p: { displayName?: string | null }) {
  const acc = getAccount(user.uid);
  if (acc) saveAccount({ ...acc, displayName: p.displayName ?? acc.displayName });
}
export async function signOut(_a?: Auth) {
  setSessionUid(null);
  emit(true);
}

// Two-step verification is not exercised in the demo (staff are treated as verified).
export function multiFactor(_u: DemoUser) {
  return { enrolledFactors: [] as unknown[], getSession: async () => ({}), enroll: async () => {}, unenroll: async () => {} };
}
export function getMultiFactorResolver(): MultiFactorResolver {
  throw new AuthError('auth/argument-error', 'Not used in the demo.');
}
export class PhoneAuthProvider {
  constructor(_a?: Auth) {}
  async verifyPhoneNumber() {
    return 'demo';
  }
  static credential(_id: string, _code: string) {
    return {};
  }
}
export const PhoneMultiFactorGenerator = { assertion: (c: unknown) => c, FACTOR_ID: 'phone' };
export const TotpMultiFactorGenerator = {
  generateSecret: async (): Promise<TotpSecret> => ({ secretKey: 'DEMO', generateQrCodeUrl: () => '' }),
  assertionForEnrollment: (..._a: unknown[]) => ({}),
  assertionForSignIn: (..._a: unknown[]) => ({}),
  FACTOR_ID: 'totp',
};
