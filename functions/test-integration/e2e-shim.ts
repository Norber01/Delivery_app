/**
 * Local E2E harness (not deployed): serves the built web app's callable protocol
 * by running the real services against the Firestore emulator, plus a fixed
 * geocoder in place of the edge Worker. Used for browser smoke tests.
 */
import { createServer } from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GUEST } from '../src/lib/auth.js';
import { toHttpsError } from '../src/lib/errors.js';
import { randomId } from '../src/lib/hash.js';
import { createBooking } from '../src/services/bookingService.js';
import { getQuote } from '../src/services/quoteService.js';
import { FirestoreRateLimiter, FirestoreStore } from '../src/store/firestoreStore.js';

const db = getFirestore(initializeApp({ projectId: 'demo-courier' }));
db.settings({ ignoreUndefinedProperties: true });
const deps = { store: new FirestoreStore(db), rateLimiter: new FirestoreRateLimiter(db), maps: null, now: () => new Date(), newId: () => randomId() };
const PLACES = [
  { label: 'Oxford Street, Osu, Accra', location: { lat: 5.556, lng: -0.1823 }, city: 'Accra', region: 'Greater Accra' },
  { label: 'Madina Market, Madina, Accra', location: { lat: 5.6681, lng: -0.1653 }, city: 'Accra', region: 'Greater Accra' },
  { label: 'Adum, Kumasi', location: { lat: 6.6966, lng: -1.6233 }, city: 'Kumasi', region: 'Ashanti' },
];
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const url = new URL(req.url!, 'http://x');
  if (url.pathname === '/geocode') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return res.writeHead(200, cors).end(JSON.stringify({ results: PLACES.filter((p) => p.label.toLowerCase().includes(q.split(' ')[0]!)) }));
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { data } = JSON.parse(body || '{}');
  const fn = url.pathname.split('/').pop();
  try {
    const meta = { ipHash: 'e2e' };
    const result = fn === 'getQuote' ? await getQuote(deps, data, GUEST, meta) : await createBooking(deps, data, GUEST, meta);
    res.writeHead(200, cors).end(JSON.stringify({ result }));
  } catch (e) {
    const h = toHttpsError(e);
    res.writeHead(h.httpErrorCode.status, cors).end(JSON.stringify({ error: { status: h.httpErrorCode.canonicalName, message: h.message, details: h.details } }));
  }
}).listen(Number(process.env.PORT ?? 5001), '127.0.0.1', () => console.log('shim ready'));
