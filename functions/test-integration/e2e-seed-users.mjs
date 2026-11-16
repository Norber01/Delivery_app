/**
 * Creates the E2E accounts in the Auth emulator (idempotent). Staff have SMS MFA enrolled.
 * Run from functions/: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node test-integration/e2e-seed-users.mjs
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
const auth = getAuth(initializeApp({ projectId: 'demo-courier' }));
async function user(email, password, claims, phone) {
  try {
    await auth.deleteUser((await auth.getUserByEmail(email)).uid);
  } catch {
    /* new */
  }
  const u = await auth.createUser({ email, password, emailVerified: true, ...(phone ? { multiFactor: { enrolledFactors: [{ phoneNumber: phone, factorId: 'phone' }] } } : {}) });
  await auth.setCustomUserClaims(u.uid, claims);
}
await user('ops@example.test', 'ops-password-1', { role: 'admin' }, '+233244000111');
await user('finance@example.test', 'ops-password-1', { role: 'finance' }, '+233244000444');
await user('owner@example.test', 'biz-password-1', { role: 'customer' });
console.log('users ready');
