/**
 * Every Cloud Function the website and ops app call, wired to the real service code with the
 * in-browser stores (the same wiring as functions/src/index.ts, minus the cloud services).
 */
import { callerFromToken, type Caller } from '../../../../functions/src/lib/auth.js';
import { toHttpsError } from '../../../../functions/src/lib/errors.js';
import { FirestoreStore } from '../../../../functions/src/store/firestoreStore.js';
import { FirestoreOpsStore } from '../../../../functions/src/ops/firestoreOps.js';
import { FirestoreBusinessStore } from '../../../../functions/src/business/firestoreBusiness.js';
import { FirestoreFleetStore } from '../../../../functions/src/fleet/firestoreFleet.js';
import * as ops from '../../../../functions/src/ops/opsService.js';
import * as hub from '../../../../functions/src/ops/hubService.js';
import * as business from '../../../../functions/src/business/businessService.js';
import * as bulk from '../../../../functions/src/business/bulkService.js';
import * as invoices from '../../../../functions/src/business/invoiceService.js';
import * as fleet from '../../../../functions/src/fleet/fleetService.js';
import { getFinanceReport } from '../../../../functions/src/fleet/financeService.js';
import { planDriverRoute } from '../../../../functions/src/fleet/routeService.js';
import { createBooking } from '../../../../functions/src/services/bookingService.js';
import { getQuote } from '../../../../functions/src/services/quoteService.js';
import { getTrackingView } from '../../../../functions/src/services/trackingService.js';
import { claimBooking, completeSignUp } from '../../../../functions/src/services/accountService.js';
import { setUserRole } from '../../../../functions/src/services/adminService.js';
import { AppError } from '../../../../functions/src/lib/errors.js';
import type { BookingRecord } from '../../../../functions/src/store/types.js';
import { fromDoc } from '../../../../functions/src/store/firestoreStore.js';
import { getFirestore } from '../admin/firestore.js';
import { randomId } from '../client/ids.js';
import { authFor, demoNow, findAccount, getAccount, saveAccount, theDb, type DemoAccount } from './core.js';
import { demoEvidence, evidenceObjectUrl, EVIDENCE_HOST } from './evidence.js';
import { demoLive } from './live.js';

export const DEMO_PASSWORD = 'demo1234';
// The demo Firestore implements the subset of the Admin SDK the stores use (type-checked by the shared tests).
const db = () => getFirestore() as never;
const now = () => demoNow();
const newId = () => randomId(12);
const site = { publicUrl: typeof location === 'undefined' ? 'https://demo.example' : location.origin, companyName: ((import.meta as { env?: Record<string, string> }).env?.VITE_COMPANY_NAME || 'Courier') + ' (demo)', fallbackEmailDomain: 'pay.demo.example' };
const meta = { ipHash: 'demo' };
const rateLimiter = { consume: async () => true };
const uploads = { workerUrl: EVIDENCE_HOST, secret: 'demo-signing-secret' };

let wired: ReturnType<typeof build> | null = null;
export function services() {
  wired ??= build();
  return wired;
}

function claimsSetter(uid: string, claims: Record<string, unknown>) {
  const acc = getAccount(uid);
  if (!acc) return;
  saveAccount({ ...acc, claims });
  theDb().commit([{ type: 'set', path: `users/${uid}`, data: { uid, role: claims.role ?? null, businessId: claims.businessId ?? null, email: acc.email, name: acc.displayName }, merge: true }]);
}
function newAccount(p: { email: string; name: string; phone?: string }): DemoAccount {
  const acc: DemoAccount = { uid: `u_${randomId(16)}`, email: p.email.toLowerCase(), phone: p.phone ?? null, password: DEMO_PASSWORD, displayName: p.name, emailVerified: true, claims: {} };
  saveAccount(acc);
  return acc;
}
const setupNote = `Demo: sign in with this email and the password "${DEMO_PASSWORD}".`;

function build() {
  theDb();
  const store = new FirestoreStore(db());
  const opsStore = new FirestoreOpsStore(db(), now);
  const bizStore = new FirestoreBusinessStore(db());
  const fleetStore = new FirestoreFleetStore(db(), opsStore);
  const evidence = demoEvidence();
  const opsDeps: ops.OpsDeps = { ops: opsStore, live: demoLive, evidence, now, newId, newOtp: () => String(100000 + Math.floor(Math.random() * 900000)), site, uploads, fleet: fleetStore };
  const quoteDeps = { store, rateLimiter, maps: null, now, newId: () => randomId() };
  const fleetDeps: fleet.FleetDeps = { fleet: fleetStore, evidence, uploads, now, newId };
  const invoiceDeps = { biz: bizStore, now, newId };
  const identity = {
    getUser: async (uid: string) => {
      const a = getAccount(uid);
      if (!a) throw new AppError('NOT_FOUND', 'User not found.', 'not-found');
      return { email: a.email, phone: a.phone, emailVerified: a.emailVerified, claims: a.claims };
    },
    setClaims: async (uid: string, claims: Record<string, unknown>) => claimsSetter(uid, claims),
  };
  const businessDeps: business.BusinessDeps = {
    biz: bizStore,
    ops: opsStore,
    evidence,
    uploads,
    now,
    newId,
    identity: {
      getClaims: async (uid) => getAccount(uid)?.claims ?? {},
      setClaims: async (uid, claims) => claimsSetter(uid, claims),
      revokeSessions: async () => {},
      createUserWithSetupLink: async (p) => (findAccount({ email: p.email }) ? 'exists' : { uid: newAccount(p).uid, setupLink: setupNote }),
    },
  };
  const bulkDeps = { store, biz: bizStore, rateLimiter, maps: null, now, newId, site };

  type H = (caller: Caller, data: unknown) => Promise<unknown>;
  const handlers: Record<string, H> = {
    getQuote: (c, d) => getQuote(quoteDeps, d, c, meta),
    createBooking: (c, d) => {
      const pref = (d as { paymentPreference?: unknown })?.paymentPreference;
      if (pref === 'mobile_money' || pref === 'card') throw new AppError('PAYMENT_METHOD_NOT_ALLOWED', 'Online payment is not part of the demo. Choose to pay the driver at pickup.');
      return createBooking({ store, rateLimiter, now, site }, d, c, meta);
    },
    initiatePayment: async () => {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Online payment is not part of the demo.');
    },
    getPaymentStatus: async () => {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Online payment is not part of the demo.');
    },
    getTrackingView: (c, d) => getTrackingView({ store, rateLimiter, ops: opsStore, live: demoLive, maps: null }, d, c, meta),
    completeSignUp: (c, d) => completeSignUp({ store, identity }, c, d),
    claimBooking: (c, d) => claimBooking({ store }, c, d),
    setUserRole: (c, d) =>
      setUserRole(
        {
          store,
          identity: {
            async find(by) {
              const a = 'email' in by ? findAccount({ email: by.email }) : getAccount(by.uid);
              return a && { uid: a.uid, email: a.email, name: a.displayName, claims: a.claims };
            },
            async apply(uid, claims, profile) {
              claimsSetter(uid, claims);
              theDb().commit([{ type: 'set', path: `users/${uid}`, data: { uid, ...profile }, merge: true }]);
            },
          },
        },
        c,
        d,
      ),
    // Operations
    dispatchAction: (c, d) => ops.dispatchAction(opsDeps, c, d),
    driverAction: (c, d) => ops.driverAction(opsDeps, c, d),
    startShift: (c, d) => ops.startShift(opsDeps, c, d),
    endShift: (c, d) => ops.endShift(opsDeps, c, d),
    requestUpload: (c, d) => ops.requestUpload(opsDeps, c, d),
    getEvidenceUrl: async (c, d) => {
      await ops.getEvidenceUrl(opsDeps, c, d); // permission and key checks
      const url = await evidenceObjectUrl((d as { key: string }).key);
      if (!url) throw new AppError('NOT_FOUND', 'File not found in this demo browser.', 'not-found');
      return { url };
    },
    upsertVehicle: (c, d) => ops.upsertVehicle({ ops: opsStore }, c, d),
    createDriverAccount: (c, d) =>
      ops.createDriverAccount(
        { ops: opsStore },
        {
          createDriverUser: async (p) => {
            if (findAccount({ email: p.email })) throw new AppError('ACCOUNT_EXISTS', 'That email already has an account.');
            return { uid: newAccount(p).uid, setupLink: setupNote };
          },
          setDriverClaims: async (uid) => claimsSetter(uid, { role: 'driver' }),
        },
        c,
        d,
      ),
    upsertHub: (c, d) => hub.upsertHub({ ops: opsStore }, c, d),
    upsertRoute: (c, d) => hub.upsertRoute({ ops: opsStore }, c, d),
    hubScan: (c, d) => hub.hubScan(opsDeps, c, d),
    createManifest: (c, d) => hub.createManifest(opsDeps, c, d),
    addToManifest: (c, d) => hub.manifestParcel(opsDeps, c, d, 'add'),
    removeFromManifest: (c, d) => hub.manifestParcel(opsDeps, c, d, 'remove'),
    manifestAction: (c, d) => hub.manifestAction(opsDeps, c, d),
    // Business
    requestBusinessDocumentUpload: (c, d) => business.requestBusinessDocumentUpload(businessDeps, c, d),
    registerBusiness: (c, d) => business.registerBusiness(businessDeps, c, d),
    reviewBusiness: (c, d) => business.reviewBusiness(businessDeps, c, d),
    setCreditTerms: (c, d) => business.setCreditTerms(businessDeps, c, d),
    setContractPricing: (c, d) => business.setContractPricing(businessDeps, c, d),
    inviteBusinessStaff: (c, d) => business.inviteStaff(businessDeps, c, d),
    removeBusinessStaff: (c, d) => business.removeStaff(businessDeps, c, d),
    saveAddressEntry: (c, d) => business.saveAddressEntry(businessDeps, c, d),
    deleteAddressEntry: (c, d) => business.deleteAddressEntry(businessDeps, c, d),
    previewBulkBooking: (c, d) => bulk.previewBulkBooking(bulkDeps, c, d),
    confirmBulkBooking: (c, d) => bulk.confirmBulkBooking(bulkDeps, c, d),
    generateInvoices: (c, d) => invoices.generateInvoices(invoiceDeps, c, d),
    recordInvoicePayment: (c, d) => invoices.recordInvoicePayment(invoiceDeps, c, d),
    voidInvoice: (c, d) => invoices.voidInvoice(invoiceDeps, c, d),
    getBusinessReport: (c, d) => invoices.getBusinessReport(invoiceDeps, c, d),
    // Fleet, expenses, pay, analytics
    planDriverRoute: (c, d) => planDriverRoute({ fleet: fleetStore, live: demoLive, now }, c, d),
    setVehicleSchedule: (c, d) => fleet.setVehicleSchedule(fleetDeps, c, d),
    recordMaintenance: (c, d) => fleet.recordMaintenance(fleetDeps, c, d),
    requestReceiptUpload: (c, d) => fleet.requestReceiptUpload(fleetDeps, c, d),
    logFuel: (c, d) => fleet.logFuel(fleetDeps, c, d),
    submitExpense: (c, d) => fleet.submitExpense(fleetDeps, c, d),
    reviewExpense: (c, d) => fleet.reviewExpense(fleetDeps, c, d),
    setDriverPayRules: (c, d) => fleet.setPayRules(fleetDeps, c, d),
    generateDriverPay: (c, d) => fleet.generateDriverPay(fleetDeps, c, d),
    adjustDriverPay: (c, d) => fleet.adjustDriverPay(fleetDeps, c, d),
    approveDriverPay: (c, d) => fleet.approveDriverPay(fleetDeps, c, d),
    markDriverPaid: (c, d) => fleet.markDriverPaid(fleetDeps, c, d),
    recordCashRemittance: (c, d) => fleet.recordCashRemittance(fleetDeps, c, d),
    getFinanceReport: (c, d) => getFinanceReport({ fleet: fleetStore, now }, c, d),
  };

  // The deployed onBookingWritten trigger: a confirmed booking becomes a delivery.
  theDb().onCommit((paths) => {
    for (const p of paths) {
      if (!p.startsWith('deliveryRequests/') || p.split('/').length !== 2) continue;
      const raw = theDb().get(p);
      if (raw) void ops.ensureDeliveryForBooking({ ops: opsStore, now }, fromDoc<BookingRecord>(raw)).catch((e) => console.error('ensureDelivery', e));
    }
  });

  return { handlers, store, opsStore, bizStore, fleetStore, opsDeps, quoteDeps, fleetDeps, businessDeps, invoiceDeps, bulkDeps, identity };
}

export class DemoFunctionsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Call a function as `uid` (the signed-in user, or anyone in the seed / driver simulator). */
export async function callAs<T = unknown>(uid: string | null, name: string, data: unknown): Promise<T> {
  const h = services().handlers[name];
  if (!h) throw new DemoFunctionsError('functions/not-found', `${name} is not available in the demo.`);
  try {
    const result = await h(callerFromToken(authFor(uid) as never), data ?? {});
    return JSON.parse(JSON.stringify(result ?? null)) as T;
  } catch (e) {
    const x = toHttpsError(e);
    throw new DemoFunctionsError(`functions/${x.code}`, x.message, x.details);
  }
}
