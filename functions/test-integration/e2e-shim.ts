/**
 * Local E2E harness (not deployed). Runs the real services against the Firestore and Auth
 * emulators and stands in for the infrastructure that needs real accounts:
 *
 *   :5001  Firebase callable protocol (+ ID-token verification) and the Paystack webhook route
 *   :8787  fixed geocoder in place of the edge Worker
 *   :7070  fake Paystack API + hosted checkout page; the real PaystackProvider talks to it and
 *          webhooks are signed exactly like Paystack's (HMAC-SHA512)
 *
 * Env: FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, SITE_URL (web app origin).
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
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

const SECRET = 'sk_test_e2e';
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:4173';
const PAYSTACK = 'http://127.0.0.1:7070';

const app = initializeApp({ projectId: 'demo-courier' });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth(app);
const store = new FirestoreStore(db);
const rateLimiter = new FirestoreRateLimiter(db);
const site = { publicUrl: SITE, companyName: 'Example Courier GH', fallbackEmailDomain: 'pay.example.test' };
const pay: PaymentDeps = { store, rateLimiter, provider: new PaystackProvider(SECRET, PAYSTACK), now: () => new Date(), site };
const quoteDeps = { store, rateLimiter, maps: null, now: () => new Date(), newId: () => randomId() };
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
      getTrackingView: () => getTrackingView({ store, rateLimiter }, data, caller, meta),
      initiatePayment: () => initiatePayment(pay, data, caller, meta),
      getPaymentStatus: () => getPaymentStatus(pay, data, caller, meta),
      completeSignUp: () => completeSignUp({ store, identity }, caller, data),
      claimBooking: () => claimBooking({ store }, caller, data),
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
