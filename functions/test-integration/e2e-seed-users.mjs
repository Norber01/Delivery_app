/**
 * Creates the E2E accounts in the Auth emulator (idempotent). Staff have SMS MFA enrolled.
 * Run from functions/: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test-integration/e2e-seed-users.mjs
 * (Firestore is optional: without it only the accounts are created.)
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
const app = initializeApp({ projectId: 'demo-courier' });
const auth = getAuth(app);
async function user(email, password, claims, phone) {
  try {
    await auth.deleteUser((await auth.getUserByEmail(email)).uid);
  } catch {
    /* new */
  }
  const u = await auth.createUser({ email, password, emailVerified: true, ...(phone ? { multiFactor: { enrolledFactors: [{ phoneNumber: phone, factorId: 'phone' }] } } : {}) });
  await auth.setCustomUserClaims(u.uid, claims);
  return u.uid;
}
await user('ops@example.test', 'ops-password-1', { role: 'admin' }, '+233244000111');
await user('finance@example.test', 'ops-password-1', { role: 'finance' }, '+233244000444');
await user('owner@example.test', 'biz-password-1', { role: 'customer' });
// Phase 6: a driver with a fresh motorbike (no shift, no odometer yet).
const driverUid = await user('kwame6@example.test', 'driver-pass-77', { role: 'driver' });
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const db = getFirestore(app);
  // Earlier runs left drivers under old account ids: remove them so each run starts clean.
  for (const d of (await db.collection('drivers').where('email', '==', 'kwame6@example.test').get()).docs) {
    await d.ref.delete();
    await db.doc(`routePlans/${d.id}`).delete();
  }
  for (const p of (await db.collection('driverPayments').where('driverName', '==', 'Kwame Asante').get()).docs) await p.ref.delete();
  await db.doc(`drivers/${driverUid}`).set({ uid: driverUid, name: 'Kwame Asante', phone: '+233244777666', email: 'kwame6@example.test', employeeNumber: 'DRV-0601', homeServiceAreaId: 'accra', status: 'active', currentShift: null });
  await db.doc('vehicles/bike6').set({ id: 'bike6', registrationNumber: 'M-26-GR 606', vehicleClass: 'motorbike', capacityKg: 25, homeServiceAreaId: 'accra', status: 'available', currentDriverUid: null });
}
console.log('users ready');
