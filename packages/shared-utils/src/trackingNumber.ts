/**
 * Tracking numbers: "GH" + 10 random Crockford base32 symbols + 2 check symbols.
 *
 * - 50 bits of randomness → infeasible to enumerate.
 * - Check value = (body as a base-32 integer) mod 1021, written as two base32 symbols.
 *   1021 is prime and does not divide 31, so every single-symbol substitution and every
 *   adjacent transposition is detected before a lookup is made.
 * - Only [0-9A-Z] characters: safe in URLs, SMS and payment-provider references.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const BODY_LENGTH = 10;
const CHECK_MODULUS = 1021n;
export const TRACKING_NUMBER_LENGTH = 2 + BODY_LENGTH + 2;

export type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
};

function checkSymbols(body: string): string {
  let value = 0n;
  for (const ch of body) value = value * 32n + BigInt(ALPHABET.indexOf(ch));
  const c = Number(value % CHECK_MODULUS);
  return ALPHABET[Math.floor(c / 32)]! + ALPHABET[c % 32]!;
}

export function generateTrackingNumber(random: RandomBytes = defaultRandom): string {
  // Each byte's low 5 bits are uniform over the 32 symbols.
  const bytes = random(BODY_LENGTH);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[bytes[i]! & 31];
  return `GH${body}${checkSymbols(body)}`;
}

/** Normalise user input (case, spaces, dashes, Crockford aliases) — returns null when invalid. */
export function normalizeTrackingNumber(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (!s.startsWith('GH') || s.length !== TRACKING_NUMBER_LENGTH) return null;
  const rest = s.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (![...rest].every((c) => ALPHABET.includes(c))) return null;
  const body = rest.slice(0, BODY_LENGTH);
  return checkSymbols(body) === rest.slice(BODY_LENGTH) ? `GH${rest}` : null;
}

export function isValidTrackingNumber(input: string): boolean {
  return normalizeTrackingNumber(input) === input;
}
