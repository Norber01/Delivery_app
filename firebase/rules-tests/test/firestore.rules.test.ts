import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;
const mfa = { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } };

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-courier',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'deliveryRequests/GHALICE'), { customerUid: 'alice', businessId: null, price: { totalPesewas: 3490 } });
    await setDoc(doc(db, 'deliveryRequests/GHBIZ'), { customerUid: 'bob', businessId: 'biz1', price: { totalPesewas: 5000 } });
    await setDoc(doc(db, 'deliveryRequests/GHGUEST'), { customerUid: null, businessId: null, price: { totalPesewas: 100 } });
    await setDoc(doc(db, 'users/alice'), { role: 'customer' });
    await setDoc(doc(db, 'pricingRules/1'), { status: 'active' });
    await setDoc(doc(db, 'quotes/q1'), { requesterUid: 'alice' });
    await setDoc(doc(db, 'auditLogs/a1'), { action: 'x' });
    await setDoc(doc(db, 'serviceAreas/accra'), { name: 'Accra' });
    await setDoc(doc(db, 'payments/p1'), { customerUid: 'alice', businessId: null, status: 'succeeded' });
  });
});

const as = (uid: string, claims: Record<string, unknown> = {}) => env.authenticatedContext(uid, claims).firestore();
const guest = () => env.unauthenticatedContext().firestore();

describe('bookings (deliveryRequests)', () => {
  it('owner can read, others cannot', async () => {
    await assertSucceeds(getDoc(doc(as('alice', { role: 'customer' }), 'deliveryRequests/GHALICE')));
    await assertFails(getDoc(doc(as('mallory', { role: 'customer' }), 'deliveryRequests/GHALICE')));
    await assertFails(getDoc(doc(guest(), 'deliveryRequests/GHGUEST')));
  });
  it('business members read their business bookings only', async () => {
    await assertSucceeds(getDoc(doc(as('staff1', { role: 'business_staff', businessId: 'biz1' }), 'deliveryRequests/GHBIZ')));
    await assertFails(getDoc(doc(as('staff2', { role: 'business_staff', businessId: 'biz2' }), 'deliveryRequests/GHBIZ')));
    // businessId claim without a business role is not enough
    await assertFails(getDoc(doc(as('c', { role: 'customer', businessId: 'biz1' }), 'deliveryRequests/GHBIZ')));
  });
  it('nobody can create or modify bookings from the client — including the owner and admins', async () => {
    await assertFails(setDoc(doc(guest(), 'deliveryRequests/GHNEW'), { customerUid: null }));
    await assertFails(updateDoc(doc(as('alice', { role: 'customer' }), 'deliveryRequests/GHALICE'), { 'price.totalPesewas': 1 }));
    await assertFails(updateDoc(doc(as('adm', { role: 'admin', ...mfa }), 'deliveryRequests/GHALICE'), { status: 'cancelled' }));
    await assertFails(deleteDoc(doc(as('alice', { role: 'customer' }), 'deliveryRequests/GHALICE')));
  });
  it('dispatchers need MFA to read', async () => {
    await assertFails(getDoc(doc(as('d', { role: 'dispatcher' }), 'deliveryRequests/GHGUEST')));
    await assertSucceeds(getDoc(doc(as('d', { role: 'dispatcher', ...mfa }), 'deliveryRequests/GHGUEST')));
  });
});

describe('privilege escalation', () => {
  it('users cannot write their own user document or role', async () => {
    await assertFails(setDoc(doc(as('alice', { role: 'customer' }), 'users/alice'), { role: 'super_admin' }));
    await assertFails(updateDoc(doc(as('alice', { role: 'customer' }), 'users/alice'), { role: 'admin' }));
  });
  it('users can read their own user document only', async () => {
    await assertSucceeds(getDoc(doc(as('alice', { role: 'customer' }), 'users/alice')));
    await assertFails(getDoc(doc(as('bob', { role: 'customer' }), 'users/alice')));
  });
  it('customer profile writes are limited to allowed fields', async () => {
    const db = as('alice', { role: 'customer' });
    await assertSucceeds(setDoc(doc(db, 'customers/alice'), { marketingOptIn: false, savedAddresses: [] }));
    await assertFails(setDoc(doc(db, 'customers/alice'), { role: 'admin' }));
    await assertFails(setDoc(doc(db, 'customers/bob'), { marketingOptIn: true }));
    await assertFails(setDoc(doc(db, 'customers/alice'), { defaultPaymentPreference: 'business_invoice' }));
  });
});

describe('server-only and restricted collections', () => {
  it('quotes are never client-readable', async () => {
    await assertFails(getDoc(doc(as('alice', { role: 'customer' }), 'quotes/q1')));
  });
  it('pricing rules are readable only by MFA staff and never writable', async () => {
    await assertFails(getDoc(doc(as('alice', { role: 'customer' }), 'pricingRules/1')));
    await assertSucceeds(getDoc(doc(as('f', { role: 'finance', ...mfa }), 'pricingRules/1')));
    await assertFails(setDoc(doc(as('adm', { role: 'admin', ...mfa }), 'pricingRules/2'), { status: 'active' }));
  });
  it('audit logs are admin-read-only', async () => {
    await assertFails(getDoc(doc(as('f', { role: 'finance', ...mfa }), 'auditLogs/a1')));
    await assertSucceeds(getDoc(doc(as('adm', { role: 'admin', ...mfa }), 'auditLogs/a1')));
    await assertFails(updateDoc(doc(as('adm', { role: 'super_admin', ...mfa }), 'auditLogs/a1'), { action: 'y' }));
  });
  it('payments cannot be written by anyone on the client', async () => {
    await assertSucceeds(getDoc(doc(as('alice', { role: 'customer' }), 'payments/p1')));
    await assertFails(updateDoc(doc(as('alice', { role: 'customer' }), 'payments/p1'), { status: 'succeeded' }));
    await assertFails(setDoc(doc(as('f', { role: 'finance', ...mfa }), 'payments/p2'), { status: 'succeeded' }));
  });
  it('service areas are public read-only', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'serviceAreas/accra')));
    await assertFails(setDoc(doc(as('adm', { role: 'admin', ...mfa }), 'serviceAreas/x'), { name: 'X' }));
  });
  it('unknown collections are denied', async () => {
    await assertFails(setDoc(doc(as('alice', { role: 'customer' }), 'anything/x'), { a: 1 }));
  });
});
