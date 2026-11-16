/**
 * Local E2E harness (not deployed). Runs the real services against the Firestore and Auth
 * emulators and stands in for the infrastructure that needs real accounts:
 *
 *   :5001  Firebase callable protocol (+ ID-token verification) and the Paystack webhook route
 *   :8787  fixed geocoder in place of the edge Worker
 *   :7070  fake Paystack API + hosted checkout page; the real PaystackProvider talks to it and
 *          webhooks are signed exactly like Paystack's (HMAC-SHA512)
 *   :8788  in-memory evidence store in place of the R2 Worker (same signed-URL checks)
 *
 * Env: FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, SITE_URL (web app origin).
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreOpsStore, RtdbLive } from '../src/ops/firestoreOps.js';
import {
  createDriverAccount,
  dispatchAction,
  driverAction,
  endShift,
  ensureDeliveryForBooking,
  getEvidenceUrl,
  requestUpload,
  startShift,
  upsertVehicle,
  type OpsDeps,
} from '../src/ops/opsService.js';
import { fromDoc } from '../src/store/firestoreStore.js';
import * as hub from '../src/ops/hubService.js';
import type { BookingRecord } from '../src/store/types.js';
import { callerFromToken, GUEST } from '../src/lib/auth.js';
import { toHttpsError } from '../src/lib/errors.js';
import { randomId } from '../src/lib/hash.js';
import { PaystackProvider } from '../src/payments/paystack.js';
import { claimBooking, completeSignUp, type IdentityPort } from '../src/services/accountService.js';
import { createBooking } from '../src/services/bookingService.js';
import { getPaymentStatus, handlePaymentWebhook, initiatePayment, type PaymentDeps } from '../src/services/paymentService.js';
import { getQuote } from '../src/services/quoteService.js';
import { handleRefundEvent } from '../src/services/refundService.js';
import { getTrackingView } from '../src/services/trackingService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';
import { setUserRole } from '../src/services/adminService.js';
import { verifyUploadToken } from '@courier/shared-utils';
import * as businessService from '../src/business/businessService.js';
import * as bulkService from '../src/business/bulkService.js';
import * as invoiceService from '../src/business/invoiceService.js';
import { FirestoreBusinessStore } from '../src/business/firestoreBusiness.js';
import type { BusinessIdentityPort } from '../src/business/types.js';

const SECRET = 'sk_test_e2e';
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:4173';
const PAYSTACK = 'http://127.0.0.1:7070';

const app = initializeApp({ projectId: 'demo-courier', databaseURL: 'http://127.0.0.1:9000?ns=demo-courier' });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth(app);
const store = new FirestoreStore(db);
const rateLimiter = new FirestoreRateLimiter(db);
const site = { publicUrl: SITE, companyName: 'Example Courier GH', fallbackEmailDomain: 'pay.example.test' };
const pay: PaymentDeps = { store, rateLimiter, provider: new PaystackProvider(SECRET, PAYSTACK), now: () => new Date(), site };
const quoteDeps = { store, rateLimiter, maps: null, now: () => new Date(), newId: () => randomId() };
const opsStore = new FirestoreOpsStore(db);
const live = new RtdbLive(getDatabase(app));
const UPLOAD_SECRET = 'e2e-upload-secret';
const objects = new Map<string, { type: string; body: Buffer }>();
const opsDeps: OpsDeps = {
  ops: opsStore,
  live,
  evidence: { exists: async (key: string) => objects.has(key) },
  now: () => new Date(),
  newId: () => randomId(12),
  newOtp: () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0'),
  site,
  uploads: { workerUrl: 'http://127.0.0.1:8788', secret: UPLOAD_SECRET },
};
const bizStore = new FirestoreBusinessStore(db);
const businessIdentity: BusinessIdentityPort = {
  getClaims: async (uid) => (await auth.getUser(uid)).customClaims ?? {},
  async setClaims(uid, claims) {
    await auth.setCustomUserClaims(uid, claims);
    await db.collection('users').doc(uid).set({ uid, role: claims.role, businessId: claims.businessId ?? null }, { merge: true });
  },
  revokeSessions: (uid) => auth.revokeRefreshTokens(uid),
  async createUserWithSetupLink(p) {
    try {
      await auth.getUserByEmail(p.email);
      return 'exists';
    } catch {
      /* create */
    }
    const u = await auth.createUser({ email: p.email, displayName: p.name });
    return { uid: u.uid, setupLink: await auth.generatePasswordResetLink(p.email) };
  },
};
const businessDeps = { biz: bizStore, ops: opsStore, evidence: opsDeps.evidence, identity: businessIdentity, uploads: opsDeps.uploads, now: () => new Date(), newId: () => randomId(12) };
const bulkDeps = { store, biz: bizStore, rateLimiter, maps: null, now: () => new Date(), newId: () => randomId(12), site };
const invoiceDeps = { biz: bizStore, now: () => new Date(), newId: () => randomId(12) };
// Mirrors the deployed onBookingWritten trigger.
db.collection('deliveryRequests').onSnapshot((snap) => {
  for (const ch of snap.docChanges()) {
    if (ch.type !== 'removed') void ensureDeliveryForBooking({ ops: opsStore, now: () => new Date() }, fromDoc<BookingRecord>(ch.doc.data())).catch((e) => console.error('ensureDelivery', e));
  }
});

const identity: IdentityPort = {
  async getUser(uid) {
    const u = await auth.getUser(uid);
    return { email: u.email ?? null, phone: u.phoneNumber ?? null, emailVerified: u.emailVerified, claims: u.customClaims ?? {} };
  },
  setClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
};

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

// ---- :5001 callables + webhook ----------------------------------------------------
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const url = new URL(req.url!, 'http://x');
  const raw = await readBody(req);
  if (url.pathname === '/webhook/paystack') {
    const r = await handlePaymentWebhook(pay, raw, req.headers, (e) => handleRefundEvent(pay, e));
    return res.writeHead(r.status).end(r.body);
  }
  const fn = url.pathname.split('/').pop();
  const { data } = JSON.parse(raw.toString() || '{}');
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  const decoded = bearer ? await auth.verifyIdToken(bearer).catch(() => null) : null;
  const caller = decoded ? callerFromToken({ uid: decoded.uid, token: decoded as unknown as Record<string, unknown> }) : GUEST;
  // Rate limiting is covered by unit tests; give each harness request its own key.
  const meta = { ipHash: `e2e-${randomId(8)}` };
  try {
    const handlers: Record<string, () => Promise<unknown>> = {
      getQuote: () => getQuote(quoteDeps, data, caller, meta),
      createBooking: () => createBooking({ store, rateLimiter, now: () => new Date(), site }, data, caller, meta),
      getTrackingView: () => getTrackingView({ store, rateLimiter, ops: opsStore, live, maps: null }, data, caller, meta),
      dispatchAction: () => dispatchAction(opsDeps, caller, data),
      driverAction: () => driverAction(opsDeps, caller, data),
      startShift: () => startShift(opsDeps, caller, data),
      endShift: () => endShift(opsDeps, caller),
      requestUpload: () => requestUpload(opsDeps, caller, data),
      getEvidenceUrl: () => getEvidenceUrl(opsDeps, caller, data),
      upsertVehicle: () => upsertVehicle({ ops: opsStore }, caller, data),
      upsertHub: () => hub.upsertHub({ ops: opsStore }, caller, data),
      upsertRoute: () => hub.upsertRoute({ ops: opsStore }, caller, data),
      hubScan: () => hub.hubScan(opsDeps, caller, data),
      createManifest: () => hub.createManifest(opsDeps, caller, data),
      addToManifest: () => hub.manifestParcel(opsDeps, caller, data, 'add'),
      removeFromManifest: () => hub.manifestParcel(opsDeps, caller, data, 'remove'),
      manifestAction: () => hub.manifestAction(opsDeps, caller, data),
      createDriverAccount: () =>
        createDriverAccount(
          { ops: opsStore },
          {
            async createDriverUser(p) {
              const u = await auth.createUser({ email: p.email, phoneNumber: p.phone, displayName: p.name });
              return { uid: u.uid, setupLink: await auth.generatePasswordResetLink(p.email) };
            },
            setDriverClaims: (uid) => auth.setCustomUserClaims(uid, { role: 'driver' }),
          },
          caller,
          data,
        ),
      initiatePayment: () => initiatePayment(pay, data, caller, meta),
      getPaymentStatus: () => getPaymentStatus(pay, data, caller, meta),
      completeSignUp: () => completeSignUp({ store, identity }, caller, data),
      claimBooking: () => claimBooking({ store }, caller, data),
      setUserRole: () =>
        setUserRole(
          {
            store,
            identity: {
              async find(by) {
                const u = await ('email' in by ? auth.getUserByEmail(by.email) : auth.getUser(by.uid)).catch(() => null);
                return u && { uid: u.uid, email: u.email ?? null, name: u.displayName ?? null, claims: u.customClaims ?? {} };
              },
              async apply(uid, claims, profile) {
                await auth.setCustomUserClaims(uid, claims);
                await db.collection('users').doc(uid).set({ uid, ...profile }, { merge: true });
              },
            },
          },
          caller,
          data,
        ),
      requestBusinessDocumentUpload: () => businessService.requestBusinessDocumentUpload(businessDeps, caller, data),
      registerBusiness: () => businessService.registerBusiness(businessDeps, caller, data),
      reviewBusiness: () => businessService.reviewBusiness(businessDeps, caller, data),
      setCreditTerms: () => businessService.setCreditTerms(businessDeps, caller, data),
      setContractPricing: () => businessService.setContractPricing(businessDeps, caller, data),
      inviteBusinessStaff: () => businessService.inviteStaff(businessDeps, caller, data),
      removeBusinessStaff: () => businessService.removeStaff(businessDeps, caller, data),
      saveAddressEntry: () => businessService.saveAddressEntry(businessDeps, caller, data),
      deleteAddressEntry: () => businessService.deleteAddressEntry(businessDeps, caller, data),
      previewBulkBooking: () => bulkService.previewBulkBooking(bulkDeps, caller, data),
      confirmBulkBooking: () => bulkService.confirmBulkBooking(bulkDeps, caller, data),
      generateInvoices: () => invoiceService.generateInvoices(invoiceDeps, caller, data),
      recordInvoicePayment: () => invoiceService.recordInvoicePayment(invoiceDeps, caller, data),
      voidInvoice: () => invoiceService.voidInvoice(invoiceDeps, caller, data),
      getBusinessReport: () => invoiceService.getBusinessReport(invoiceDeps, caller, data),
    };
    const h = handlers[fn ?? ''];
    if (!h) return res.writeHead(404, cors).end('{}');
    const result = await h();
    res.writeHead(200, cors).end(JSON.stringify({ result }));
  } catch (e) {
    const h = toHttpsError(e);
    res.writeHead(h.httpErrorCode.status, cors).end(JSON.stringify({ error: { status: h.httpErrorCode.canonicalName, message: h.message, details: h.details } }));
  }
}).listen(5001, '127.0.0.1');

// ---- :8787 geocoder -----------------------------------------------------------------
const PLACES = [
  { label: 'Oxford Street, Osu, Accra', location: { lat: 5.556, lng: -0.1823 }, city: 'Accra', region: 'Greater Accra' },
  { label: 'Madina Market, Madina, Accra', location: { lat: 5.6681, lng: -0.1653 }, city: 'Accra', region: 'Greater Accra' },
  { label: 'Adum, Kumasi', location: { lat: 6.6966, lng: -1.6233 }, city: 'Kumasi', region: 'Ashanti' },
];
createServer((req, res) => {
  const q = (new URL(req.url!, 'http://x').searchParams.get('q') ?? '').toLowerCase();
  res.writeHead(200, cors).end(JSON.stringify({ results: PLACES.filter((p) => p.label.toLowerCase().includes(q.split(' ')[0]!)) }));
}).listen(8787, '127.0.0.1');

// ---- :7070 fake Paystack ----------------------------------------------------------------
interface FakeTx { reference: string; amount: number; status: string; callback: string; id: number; paidAt?: string }
const txs = new Map<string, FakeTx>();
let nextId = 1;
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

async function sendWebhook(tx: FakeTx) {
  const body = JSON.stringify({ event: 'charge.success', data: { id: tx.id, reference: tx.reference, amount: tx.amount, currency: 'GHS', status: 'success' } });
  const signature = createHmac('sha512', SECRET).update(body).digest('hex');
  await fetch('http://127.0.0.1:5001/webhook/paystack', { method: 'POST', headers: { 'x-paystack-signature': signature, 'content-type': 'application/json' }, body });
}

createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const raw = await readBody(req);
  if (req.headers.authorization && req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { status: false, message: 'Invalid key' });

  if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
    const b = JSON.parse(raw.toString());
    const tx: FakeTx = { reference: b.reference, amount: b.amount, status: 'ongoing', callback: b.callback_url, id: nextId++ };
    txs.set(tx.reference, tx);
    return json(res, 200, { status: true, message: 'ok', data: { authorization_url: `${PAYSTACK}/checkout/${tx.reference}`, reference: tx.reference, access_code: 'x' } });
  }
  const verify = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
  if (verify) {
    const tx = txs.get(decodeURIComponent(verify[1]!));
    if (!tx) return json(res, 400, { status: false, message: 'Transaction reference not found' });
    return json(res, 200, { status: true, message: 'ok', data: { id: tx.id, status: tx.status, reference: tx.reference, amount: tx.amount, currency: 'GHS', channel: 'mobile_money', paid_at: tx.paidAt ?? null } });
  }
  const checkout = /^\/checkout\/([^/]+)(\/(pay|cancel))?$/.exec(url.pathname);
  if (checkout) {
    const tx = txs.get(decodeURIComponent(checkout[1]!));
    if (!tx) return res.writeHead(404).end('unknown');
    if (req.method === 'POST' && checkout[3] === 'pay') {
      tx.status = 'success';
      tx.paidAt = new Date().toISOString();
      await sendWebhook(tx);
      return res.writeHead(303, { Location: `${tx.callback}&reference=${tx.reference}` }).end();
    }
    if (req.method === 'POST' && checkout[3] === 'cancel') {
      tx.status = 'failed';
      return res.writeHead(303, { Location: `${tx.callback}&reference=${tx.reference}` }).end();
    }
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<!doctype html><title>Fake checkout</title><h1>Test checkout</h1><p>Amount: GHS ${(tx.amount / 100).toFixed(2)}</p>` +
          `<form method="post" action="/checkout/${tx.reference}/pay"><button>Approve Mobile Money payment</button></form>` +
          `<form method="post" action="/checkout/${tx.reference}/cancel"><button>Decline</button></form>`,
      );
  }
  json(res, 404, { status: false, message: 'not found' });
}).listen(7070, '127.0.0.1', () => console.log('shim ready'));

// ---- :8788 evidence store (stands in for workers/api-edge + R2) ------------------------------
createServer(async (req, res) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, h).end();
  const url = new URL(req.url ?? '/', 'http://x');
  const key = url.pathname.replace(/^\/evidence\//, '');
  const ct = url.searchParams.get('ct') ?? undefined;
  const max = url.searchParams.get('max');
  const params = { method: req.method as 'GET' | 'PUT', key, expires: Number(url.searchParams.get('exp')), ...(ct ? { contentType: ct } : {}), ...(max ? { maxBytes: Number(max) } : {}) };
  if (!(await verifyUploadToken(UPLOAD_SECRET, params, url.searchParams.get('sig') ?? '', Math.floor(Date.now() / 1000)))) return res.writeHead(403, h).end('bad signature');
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    objects.set(key, { type: ct ?? 'application/octet-stream', body: Buffer.concat(chunks) });
    return res.writeHead(201, h).end();
  }
  const o = objects.get(key);
  if (!o) return res.writeHead(404, h).end();
  res.writeHead(200, { ...h, 'Content-Type': o.type }).end(o.body);
}).listen(8788, '127.0.0.1');
