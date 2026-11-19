/**
 * Stand-in for the `firebase/firestore` web SDK in the demo build: reads and live listeners over
 * the in-browser database. Security rules are not enforced (the demo has no private data).
 */
import { runQuery, type QuerySpec } from '../db/query.js';
import { encode, getPath, clone, Timestamp, FieldValue, type Doc, type WhereOp } from '../db/values.js';
import { demoReady, theDb } from '../runtime/core.js';

export { Timestamp };
export const serverTimestamp = FieldValue.serverTimestamp;
export const increment = FieldValue.increment;
export const arrayUnion = FieldValue.arrayUnion;
export const arrayRemove = FieldValue.arrayRemove;
export const deleteField = FieldValue.delete;

export interface Firestore {
  type: 'firestore';
}
const FS: Firestore = { type: 'firestore' };
export const getFirestore = (_app?: unknown): Firestore => FS;
export const initializeFirestore = (_app?: unknown, _settings?: unknown): Firestore => FS;
export const connectFirestoreEmulator = () => {};

export interface CollectionReference {
  type: 'collection';
  path: string;
  id: string;
}
export interface DocumentReference {
  type: 'document';
  path: string;
  id: string;
}
export interface Query {
  type: 'query';
  spec: QuerySpec;
}
type Constraint = { kind: 'where'; field: string; op: WhereOp; value: unknown } | { kind: 'orderBy'; field: string; dir: 'asc' | 'desc' } | { kind: 'limit'; n: number };

const join = (base: { path?: string } | Firestore, segs: string[]) => [('path' in base ? base.path : '') ?? '', ...segs].filter(Boolean).join('/');

export function collection(base: Firestore | DocumentReference, ...segs: string[]): CollectionReference {
  const path = join(base, segs);
  return { type: 'collection', path, id: path.split('/').at(-1)! };
}
export function doc(base: Firestore | CollectionReference, ...segs: string[]): DocumentReference {
  const path = segs.length ? join(base, segs) : `${(base as CollectionReference).path}/${Math.random().toString(36).slice(2, 12)}`;
  return { type: 'document', path, id: path.split('/').at(-1)! };
}
export const where = (field: string, op: WhereOp, value: unknown): Constraint => ({ kind: 'where', field, op, value });
export const orderBy = (field: string, dir: 'asc' | 'desc' = 'asc'): Constraint => ({ kind: 'orderBy', field, dir });
export const limit = (n: number): Constraint => ({ kind: 'limit', n });

const specOf = (q: Query | CollectionReference): QuerySpec => (q.type === 'query' ? q.spec : { collection: q.path, filters: [], orders: [] });

export function query(q: Query | CollectionReference, ...cs: Constraint[]): Query {
  const spec = { ...specOf(q), filters: [...specOf(q).filters], orders: [...specOf(q).orders] };
  for (const c of cs) {
    if (c.kind === 'where') spec.filters.push({ field: c.field, op: c.op, value: c.value });
    else if (c.kind === 'orderBy') spec.orders.push({ field: c.field, dir: c.dir });
    else spec.limit = c.n;
  }
  return { type: 'query', spec };
}

export class DocumentSnapshot {
  constructor(
    readonly ref: DocumentReference,
    private readonly d: Doc | undefined,
  ) {}
  get id() {
    return this.ref.id;
  }
  exists() {
    return this.d !== undefined;
  }
  data(): Doc | undefined {
    return this.d === undefined ? undefined : clone(this.d);
  }
  get(field: string) {
    return this.d === undefined ? undefined : clone(getPath(this.d, field));
  }
}
export class QuerySnapshot {
  constructor(readonly docs: DocumentSnapshot[]) {}
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(fn: (d: DocumentSnapshot) => void) {
    this.docs.forEach(fn);
  }
}

function readDoc(ref: DocumentReference) {
  return new DocumentSnapshot(ref, theDb().get(ref.path));
}
function readQuery(q: Query | CollectionReference) {
  return new QuerySnapshot(runQuery(theDb(), specOf(q)).map((r) => new DocumentSnapshot({ type: 'document', path: r.path, id: r.id }, r.data)));
}

export async function getDoc(ref: DocumentReference) {
  await demoReady();
  return readDoc(ref);
}
export async function getDocs(q: Query | CollectionReference) {
  await demoReady();
  return readQuery(q);
}
export async function setDoc(ref: DocumentReference, data: Doc, opts?: { merge?: boolean }) {
  await demoReady();
  theDb().commit([{ type: 'set', path: ref.path, data, merge: opts?.merge }]);
}
export async function updateDoc(ref: DocumentReference, data: Doc) {
  await demoReady();
  theDb().commit([{ type: 'update', path: ref.path, data }]);
}
export async function deleteDoc(ref: DocumentReference) {
  await demoReady();
  theDb().commit([{ type: 'delete', path: ref.path }]);
}

type Next<T> = (s: T) => void;
type Observer<T> = { next?: Next<T>; error?: (e: Error) => void };

/** Live listener: fires once with the current data, then whenever the result changes. */
export function onSnapshot(target: DocumentReference, next: Next<DocumentSnapshot> | Observer<DocumentSnapshot>, error?: (e: Error) => void): () => void;
export function onSnapshot(target: Query | CollectionReference, next: Next<QuerySnapshot> | Observer<QuerySnapshot>, error?: (e: Error) => void): () => void;
export function onSnapshot(target: DocumentReference | Query | CollectionReference, nextOrObs: Next<never> | Observer<never>, error?: (e: Error) => void) {
  const next = (typeof nextOrObs === 'function' ? nextOrObs : nextOrObs.next) as (s: unknown) => void;
  const fail = typeof nextOrObs === 'function' ? error : nextOrObs.error;
  let last = '';
  let stopped = false;
  let unsub: () => void = () => {};
  const emit = () => {
    if (stopped) return;
    try {
      const snap = target.type === 'document' ? readDoc(target) : readQuery(target);
      const key = JSON.stringify(target.type === 'document' ? encode((snap as DocumentSnapshot).data() ?? null) : (snap as QuerySnapshot).docs.map((d) => [d.id, encode(d.data())]));
      if (key === last) return;
      last = key;
      next?.(snap);
    } catch (e) {
      fail?.(e as Error);
    }
  };
  void demoReady().then(() => {
    if (stopped) return;
    unsub = theDb().subscribe(emit);
    emit();
  });
  return () => {
    stopped = true;
    unsub();
  };
}
