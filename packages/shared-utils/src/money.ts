/** All money is integer pesewas. 1 GHS = 100 pesewas. */

export function assertPesewas(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Not an integer pesewa amount: ${n}`);
  return n;
}

/** Percentage of an amount, rounded half away from zero to whole pesewas. */
export function percentOf(amountPesewas: number, percent: number): number {
  const raw = (amountPesewas * percent) / 100;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

export function cedisToPesewas(cedis: number): number {
  return Math.round(cedis * 100);
}

/** Format for display, e.g. 12345 → "GH₵ 123.45". */
export function formatGhs(pesewas: number): string {
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  const cedis = Math.floor(abs / 100).toLocaleString('en-GH');
  const p = String(abs % 100).padStart(2, '0');
  return `${sign}GH₵ ${cedis}.${p}`;
}
