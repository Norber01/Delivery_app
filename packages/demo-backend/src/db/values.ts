/**
 * Value model of the in-browser demo database: Firestore-like timestamps, write sentinels
 * (serverTimestamp, increment, arrayUnion, arrayRemove, delete), field paths and ordering.
 */

/** Timestamp shared by the admin and client fakes (both `instanceof` checks see this class). */
export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}
  static fromDate(d: Date) {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number) {
    const s = Math.floor(ms / 1000);
    return new Timestamp(s, Math.round((ms - s * 1000) * 1e6));
  }
  static now() {
    return Timestamp.fromMillis(Date.now());
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  toDate() {
    return new Date(this.toMillis());
  }
  isEqual(o: Timestamp) {
    return o instanceof Timestamp && o.toMillis() === this.toMillis();
  }
  valueOf() {
    return String(this.toMillis()).padStart(16, '0');
  }
  toJSON() {
    return this.toDate().toISOString();
  }
}

export class Sentinel {
  constructor(
    readonly kind: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete',
    readonly operand?: unknown,
  ) {}
}

export const FieldValue = {
  serverTimestamp: () => new Sentinel('serverTimestamp'),
  increment: (n: number) => new Sentinel('increment', n),
  arrayUnion: (...v: unknown[]) => new Sentinel('arrayUnion', v),
  arrayRemove: (...v: unknown[]) => new Sentinel('arrayRemove', v),
  delete: () => new Sentinel('delete'),
};

export type Doc = Record<string, unknown>;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** Deep copy; Dates become Timestamps (as Firestore stores them); undefined fields are dropped. */
export function normalize(v: unknown): unknown {
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (v instanceof Timestamp || v instanceof Sentinel) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = normalize(x);
    return out;
  }
  return v;
}

export function clone<T>(v: T): T {
  if (v instanceof Timestamp) return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const p of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function equalValues(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0 && typeof a === typeof b;
}

function applySentinel(current: unknown, s: Sentinel, now: () => Timestamp): unknown {
  switch (s.kind) {
    case 'serverTimestamp':
      return now();
    case 'increment':
      return (typeof current === 'number' ? current : 0) + (s.operand as number);
    case 'arrayUnion': {
      const arr = Array.isArray(current) ? [...current] : [];
      for (const v of s.operand as unknown[]) if (!arr.some((x) => equalValues(x, v))) arr.push(normalize(v));
      return arr;
    }
    case 'arrayRemove': {
      const arr = Array.isArray(current) ? current : [];
      return arr.filter((x) => !(s.operand as unknown[]).some((v) => equalValues(x, v)));
    }
    default:
      return undefined;
  }
}

/** Write `value` at a dotted path, resolving sentinels against the current value. */
export function setPath(doc: Doc, path: string, value: unknown, now: () => Timestamp) {
  const parts = path.split('.');
  let cur: Doc = doc;
  for (const p of parts.slice(0, -1)) {
    if (!isPlain(cur[p])) cur[p] = {};
    cur = cur[p] as Doc;
  }
  const last = parts.at(-1)!;
  if (value instanceof Sentinel) {
    if (value.kind === 'delete') delete cur[last];
    else cur[last] = applySentinel(cur[last], value, now);
  } else cur[last] = resolveDeep(value, now);
}

/** Resolve sentinels nested inside a value being written (e.g. `{ at: serverTimestamp() }`). */
export function resolveDeep(v: unknown, now: () => Timestamp, current?: unknown): unknown {
  if (v instanceof Sentinel) return v.kind === 'delete' ? undefined : applySentinel(current, v, now);
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, now));
  if (isPlain(v)) {
    const out: Doc = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolveDeep(x, now, isPlain(current) ? current[k] : undefined);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return v;
}

/** Merge (set with {merge: true}): nested objects merge, other values replace. */
export function mergeInto(target: Doc, patch: Doc, now: () => Timestamp) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlain(v) && !(v instanceof Sentinel)) {
      if (!isPlain(target[k])) target[k] = {};
      mergeInto(target[k] as Doc, v, now);
    } else if (v instanceof Sentinel) {
      if (v.kind === 'delete') delete target[k];
      else target[k] = applySentinel(target[k], v, now);
    } else target[k] = resolveDeep(v, now);
  }
}

const typeRank = (v: unknown) =>
  v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : v instanceof Timestamp ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 6 : 7;

/** Firestore-like ordering: by type, then value. */
export function compare(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toMillis() - b.toMillis();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (a === null && b === null) return 0;
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}

export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';

export function matches(doc: Doc, field: string, op: WhereOp, value: unknown): boolean {
  const v = getPath(doc, field);
  if (v === undefined) return false; // missing fields never match (Firestore semantics)
  const val = normalize(value);
  switch (op) {
    case '==':
      return equalValues(v, val);
    case '!=':
      return !equalValues(v, val);
    case 'in':
      return (val as unknown[]).some((x) => equalValues(v, x));
    case 'not-in':
      return !(val as unknown[]).some((x) => equalValues(v, x));
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => equalValues(x, val));
    case 'array-contains-any':
      return Array.isArray(v) && v.some((x) => (val as unknown[]).some((y) => equalValues(x, y)));
    default: {
      if (typeRank(v) !== typeRank(val)) return false; // range filters only compare like types
      const c = compare(v, val);
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
  }
}

// ---- Persistence encoding (JSON with tagged timestamps) --------------------------------------

export function encode(v: unknown): unknown {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(encode);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
export function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (isPlain(v)) {
    if (typeof v.__ts === 'number' && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}
