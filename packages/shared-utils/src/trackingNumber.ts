/**
 * Tracking numbers: "GH" + 10 random Crockford base32 symbols + 1 check symbol.
 * 50 bits of randomness → infeasible to enumerate; the check symbol (mod 37)
 * catches typos before a lookup is made.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const CHECK_ALPHABET = ALPHABET + '*~$=U';
const BODY_LENGTH = 10;

export type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
};

function checkSymbol(body: string): string {
  let value = 0n;
  for (const ch of body) value = value * 32n + BigInt(ALPHABET.indexOf(ch));
  return CHECK_ALPHABET[Number(value % 37n)]!;
}

export function generateTrackingNumber(random: RandomBytes = defaultRandom): string {
  // Rejection-free: each byte's low 5 bits are uniform over 32 symbols.
  const bytes = random(BODY_LENGTH);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[bytes[i]! & 31];
  return `GH${body}${checkSymbol(body)}`;
}

/** Normalise user input (case, spaces, dashes, Crockford aliases) — returns null when invalid. */
export function normalizeTrackingNumber(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (!s.startsWith('GH')) return null;
  const rest = s
    .slice(2)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  s = `GH${rest}`;
  if (s.length !== 2 + BODY_LENGTH + 1) return null;
  const body = s.slice(2, 2 + BODY_LENGTH);
  if (![...body].every((c) => ALPHABET.includes(c))) return null;
  return checkSymbol(body) === s.at(-1) ? s : null;
}

export function isValidTrackingNumber(input: string): boolean {
  return normalizeTrackingNumber(input) === input;
}
