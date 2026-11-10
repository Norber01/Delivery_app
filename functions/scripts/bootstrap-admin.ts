/**
 * Grants `super_admin` to an existing Firebase Auth user. This is the only way to create the
 * first super admin; afterwards use the `setUserRole` function. Requires operator credentials
 * with Firebase Auth admin rights (Cloud Audit Logs record the call).
 *
 *   pnpm --filter @courier/functions bootstrap-admin --project <project-id> --email owner@company.com.gh
 */
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const { values } = parseArgs({ options: { project: { type: 'string' }, email: { type: 'string' } } });
if (!values.project || !values.email) throw new Error('--project and --email are required');

const app = initializeApp({ projectId: values.project });
const auth = getAuth(app);
const db = getFirestore(app);

const user = await auth.getUserByEmail(values.email);
if (!user.emailVerified) throw new Error('The user must verify their email address first.');
const existing = await db.collection('users').where('role', '==', 'super_admin').limit(3).get();
if (existing.size >= 3) throw new Error('There are already 3 super admins; use setUserRole instead.');

await auth.setCustomUserClaims(user.uid, { role: 'super_admin' });
await auth.revokeRefreshTokens(user.uid);
await db.collection('users').doc(user.uid).set(
  { uid: user.uid, role: 'super_admin', email: user.email, updatedAt: FieldValue.serverTimestamp() },
  { merge: true },
);
await db.collection('auditLogs').add({
  actorUid: null,
  actorRole: 'system',
  action: 'user.bootstrapSuperAdmin',
  targetType: 'user',
  targetId: user.uid,
  at: FieldValue.serverTimestamp(),
});
console.log(`${values.email} is now super_admin. They must enrol MFA before using staff tools.`);
