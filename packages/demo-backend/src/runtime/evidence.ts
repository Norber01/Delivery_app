/**
 * Uploaded files (proof-of-delivery photos, business documents, receipts) in the demo: the apps
 * upload to "signed URLs" exactly as in production; a fetch interceptor stores the files in the
 * browser's IndexedDB (shared by the website and ops app) instead of cloud storage.
 */
export const EVIDENCE_HOST = 'https://evidence.demo.invalid';
const DB = 'courier-demo-files';
const STORE = 'files';
const memory = new Map<string, Blob>(); // fallback when IndexedDB is unavailable

function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}
/** Store a file directly (sample data). */
export const storeFile = (key: string, blob: Blob) => put(key, blob);
async function put(key: string, blob: Blob) {
  memory.set(key, blob);
  const d = await idb();
  if (!d) return;
  await new Promise<void>((res) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}
async function get(key: string): Promise<Blob | null> {
  if (memory.has(key)) return memory.get(key)!;
  const d = await idb();
  if (!d) return null;
  return new Promise((res) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res((r.result as Blob | undefined) ?? null);
    r.onerror = () => res(null);
  });
}
export async function clearFiles() {
  memory.clear();
  const d = await idb();
  if (d) d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
}

export const demoEvidence = () => ({ exists: async (key: string) => (await get(key)) !== null });

export async function evidenceObjectUrl(key: string): Promise<string | null> {
  const b = await get(key);
  return b ? URL.createObjectURL(b) : null;
}

/** Route uploads/downloads aimed at the evidence host (and the edge geocoder) to the demo. */
export function installFetchInterceptor(geocode: (q: string) => unknown) {
  if (typeof window === 'undefined' || (window as { __courierDemoFetch?: boolean }).__courierDemoFetch) return;
  (window as { __courierDemoFetch?: boolean }).__courierDemoFetch = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin === EVIDENCE_HOST) {
      const key = decodeURIComponent(url.pathname.replace(/^\/evidence\//, ''));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        const body = init?.body;
        const blob = body instanceof Blob ? body : new Blob([body as BlobPart], { type: url.searchParams.get('ct') ?? 'application/octet-stream' });
        await put(key, blob);
        return new Response(null, { status: 201 });
      }
      const blob = await get(key);
      return blob ? new Response(blob, { status: 200 }) : new Response('not found', { status: 404 });
    }
    if (url.origin === DEMO_EDGE && url.pathname === '/geocode') {
      return new Response(JSON.stringify({ results: geocode(url.searchParams.get('q') ?? '') }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(input, init);
  };
}
export const DEMO_EDGE = 'https://edge.demo.invalid';
