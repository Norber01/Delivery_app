/**
 * Short-lived signed URLs for evidence objects in R2 (POD photos). Cloud Functions issue them
 * after an authorisation check; the edge Worker verifies them. Web Crypto only, so the same
 * code runs in Node 22, Workers and browsers.
 */
export interface UploadTokenParams {
  method: 'PUT' | 'GET' | 'HEAD';
  key: string;
  /** Unix seconds. */
  expires: number;
  contentType?: string;
  maxBytes?: number;
}

const enc = new TextEncoder();
const canonical = (p: UploadTokenParams) => [p.method, p.key, p.contentType ?? '', p.maxBytes ?? '', p.expires].join('\n');
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signUploadToken(secret: string, p: UploadTokenParams): Promise<string> {
  if (!secret) throw new Error('Signing secret missing');
  return hmac(secret, canonical(p));
}

export async function verifyUploadToken(secret: string, p: UploadTokenParams, signature: string, nowSeconds: number): Promise<boolean> {
  if (!secret || !/^[0-9a-f]{64}$/.test(signature) || p.expires < nowSeconds) return false;
  const expected = await hmac(secret, canonical(p));
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Build the Worker URL for an evidence object. */
export async function evidenceUrl(baseUrl: string, secret: string, p: UploadTokenParams): Promise<string> {
  const sig = await signUploadToken(secret, p);
  const q = new URLSearchParams({ exp: String(p.expires), sig });
  if (p.contentType) q.set('ct', p.contentType);
  if (p.maxBytes) q.set('max', String(p.maxBytes));
  return `${baseUrl.replace(/\/$/, '')}/evidence/${p.key}?${q}`;
}
