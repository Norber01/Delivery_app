import { demoDb } from '../src/admin/firestore.js';

// The integration tests clear the emulator with an HTTP DELETE; here that resets the demo database.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('demo-db/emulator/v1/') && init?.method === 'DELETE') {
    demoDb().reset();
    return new Response('{}', { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;
