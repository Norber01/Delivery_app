const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomId(n = 20) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => CHARS[x % CHARS.length]).join('');
}
