/**
 * Stand-in for `firebase-admin/firestore` used by the demo build (and its tests): the real
 * Cloud Functions store classes run unchanged against the in-browser DemoDb.
 */
import { runQuery, type QuerySpec, type Row } from '../db/query.js';
import { DemoDb, FirestoreError, splitPath, type Write } from '../db/store.js';
import { clone, FieldValue, getPath, normalize, Timestamp, type Doc, type WhereOp } from '../db/values.js';

export { FieldValue, Timestamp };

let defaultDb: DemoDb | null = null;
/** The database every `getFirestore()` returns (set by the demo runtime, or lazily in tests). */
export function setDemoDb(db: DemoDb) {
  defaultDb = db;
}
export function demoDb(): DemoDb {
  defaultDb ??= new DemoDb();
  return defaultDb;
}

export const FieldPath = { documentId: () => '__name__' };

export const AggregateField = {
  sum: (field: string) => ({ kind: 'sum' as const, field }),
  count: () => ({ kind: 'count' as const, field: '' }),
  average: (field: string) => ({ kind: 'avg' as const, field }),
};
type Agg = ReturnType<(typeof AggregateField)['sum']> | ReturnType<(typeof AggregateField)['count']> | ReturnType<(typeof AggregateField)['average']>;

export class DocumentSnapshot {
  constructor(
    readonly ref: DocumentReference,
    private readonly doc: Doc | undefined,
  ) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.doc !== undefined;
  }
  data(): Doc | undefined {
    return this.doc === undefined ? undefined : clone(this.doc);
  }
  get(field: string): unknown {
    return this.doc === undefined ? undefined : clone(getPath(this.doc, field));
  }
}
export class QueryDocumentSnapshot extends DocumentSnapshot {
  override data(): Doc {
    return super.data()!;
  }
}
export class QuerySnapshot {
  constructor(readonly docs: QueryDocumentSnapshot[]) {}
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(fn: (d: QueryDocumentSnapshot) => void) {
    this.docs.forEach(fn);
  }
}

export class Query {
  constructor(
    protected readonly fs: Firestore,
    readonly spec: QuerySpec,
  ) {}
  private with(patch: Partial<QuerySpec>) {
    return new Query(this.fs, { ...this.spec, ...patch, filters: [...this.spec.filters, ...(patch.filters ?? [])] });
  }
  where(field: string, op: WhereOp, value: unknown) {
    return this.with({ filters: [{ field, op, value }] });
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return this.with({ orders: [...this.spec.orders, { field, dir }], filters: [] });
  }
  limit(n: number) {
    return this.with({ limit: n, filters: [] });
  }
  limitToLast(n: number) {
    return this.with({ limitToLast: n, filters: [] });
  }
  startAfter(...values: unknown[]) {
    const v = values[0] instanceof DocumentSnapshot ? this.spec.orders.map((o) => (values[0] as DocumentSnapshot).get(o.field)) : values.map((x) => normalize(x));
    return this.with({ startAfter: v, filters: [] });
  }
  select() {
    return this;
  }
  rows(): Row[] {
    return runQuery(this.fs.db, this.spec);
  }
  async get() {
    return this.snapshot();
  }
  snapshot() {
    return new QuerySnapshot(this.rows().map((r) => new QueryDocumentSnapshot(this.fs.doc(r.path), r.data)));
  }
  count() {
    return this.aggregate({ count: AggregateField.count() });
  }
  aggregate(spec: Record<string, Agg>) {
    return {
      get: async () => {
        const rows = this.rows();
        const out: Record<string, number | null> = {};
        for (const [k, a] of Object.entries(spec)) {
          if (a.kind === 'count') out[k] = rows.length;
          else {
            const nums = rows.map((r) => getPath(r.data, a.field)).filter((x): x is number => typeof x === 'number');
            out[k] = a.kind === 'sum' ? nums.reduce((n, x) => n + x, 0) : nums.length ? nums.reduce((n, x) => n + x, 0) / nums.length : null;
          }
        }
        return { data: () => out };
      },
    };
  }
}

export class CollectionReference extends Query {
  constructor(fs: Firestore, readonly path: string) {
    super(fs, { collection: path, filters: [], orders: [] });
  }
  get id() {
    return this.path.split('/').at(-1)!;
  }
  doc(id?: string) {
    return this.fs.doc(`${this.path}/${id ?? autoId()}`);
  }
  async add(data: Doc) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export class DocumentReference {
  constructor(
    private readonly fs: Firestore,
    readonly path: string,
  ) {}
  get id() {
    return splitPath(this.path)[1];
  }
  get parent() {
    return new CollectionReference(this.fs, splitPath(this.path)[0]);
  }
  collection(name: string) {
    return new CollectionReference(this.fs, `${this.path}/${name}`);
  }
  async get() {
    return new DocumentSnapshot(this, this.fs.db.get(this.path));
  }
  async set(data: Doc, opts?: { merge?: boolean }) {
    this.fs.db.commit([{ type: 'set', path: this.path, data, merge: opts?.merge }]);
  }
  async create(data: Doc) {
    this.fs.db.commit([{ type: 'create', path: this.path, data }]);
  }
  async update(data: Doc | string, ...rest: unknown[]) {
    this.fs.db.commit([{ type: 'update', path: this.path, data: toUpdate(data, rest) }]);
  }
  async delete() {
    this.fs.db.commit([{ type: 'delete', path: this.path }]);
  }
}

function toUpdate(data: Doc | string, rest: unknown[]): Doc {
  if (typeof data !== 'string') return data;
  const out: Doc = { [data]: rest[0] };
  for (let i = 1; i < rest.length; i += 2) out[rest[i] as string] = rest[i + 1];
  return out;
}

const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => AUTO[b % AUTO.length]).join('');
}

class Writer {
  readonly writes: Write[] = [];
  set(ref: DocumentReference, data: Doc, opts?: { merge?: boolean }) {
    this.writes.push({ type: 'set', path: ref.path, data, merge: opts?.merge });
    return this;
  }
  create(ref: DocumentReference, data: Doc) {
    this.writes.push({ type: 'create', path: ref.path, data });
    return this;
  }
  update(ref: DocumentReference, data: Doc | string, ...rest: unknown[]) {
    this.writes.push({ type: 'update', path: ref.path, data: toUpdate(data, rest) });
    return this;
  }
  delete(ref: DocumentReference) {
    this.writes.push({ type: 'delete', path: ref.path });
    return this;
  }
}

export class WriteBatch extends Writer {
  constructor(private readonly fs: Firestore) {
    super();
  }
  async commit() {
    this.fs.db.commit(this.writes);
    return [];
  }
}

export class Transaction extends Writer {
  constructor(private readonly fs: Firestore) {
    super();
  }
  async get(target: DocumentReference | Query) {
    if (target instanceof DocumentReference) return target.get();
    return target.snapshot();
  }
  async getAll(...refs: DocumentReference[]) {
    return Promise.all(refs.map((r) => r.get()));
  }
}

export class Firestore {
  constructor(readonly db: DemoDb) {}
  settings() {}
  collection(path: string) {
    return new CollectionReference(this, path);
  }
  collectionGroup(group: string) {
    return new Query(this, { collection: group, group: true, filters: [], orders: [] });
  }
  doc(path: string) {
    if (path.split('/').length % 2) throw new FirestoreError('invalid-argument', `Not a document path: ${path}`);
    return new DocumentReference(this, path);
  }
  batch() {
    return new WriteBatch(this);
  }
  async getAll(...refs: DocumentReference[]) {
    return Promise.all(refs.map((r) => r.get()));
  }
  /** Runs `fn` alone (no interleaving with other transactions); its writes commit atomically. */
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.exclusive(async () => {
      const tx = new Transaction(this);
      const result = await fn(tx);
      this.db.commit(tx.writes);
      return result;
    });
  }
}

const instances = new WeakMap<DemoDb, Firestore>();
export function getFirestore(_app?: unknown): Firestore {
  const db = demoDb();
  if (!instances.has(db)) instances.set(db, new Firestore(db));
  return instances.get(db)!;
}
