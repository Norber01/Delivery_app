import { clone, decode, encode, mergeInto, normalize, setPath, Timestamp, type Doc } from './values.js';

export class FirestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FirestoreError';
  }
}

export type Write =
  | { type: 'set'; path: string; data: Doc; merge?: boolean }
  | { type: 'create'; path: string; data: Doc }
  | { type: 'update'; path: string; data: Doc }
  | { type: 'delete'; path: string };

/** `col/id/sub/id` → [`col/id/sub`, `id`] */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf('/');
  if (i < 0) throw new FirestoreError('invalid-argument', `Not a document path: ${path}`);
  return [path.slice(0, i), path.slice(i + 1)];
}

interface Options {
  /** localStorage key; omit for a purely in-memory database (tests). */
  storageKey?: string;
  now?: () => Date;
}

/**
 * The demo's whole database, in memory. Every write goes through `commit` (atomic); the state is
 * saved to localStorage and other tabs of the same site are told to reload, so a booking made on
 * the website shows up live in the ops app in another tab.
 */
export class DemoDb {
  private cols = new Map<string, Map<string, Doc>>();
  private listeners = new Set<() => void>();
  private commitHooks = new Set<(paths: string[]) => void>();
  private lock: Promise<unknown> = Promise.resolve();
  private notifyScheduled = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  version = 0;
  clock: () => Date;

  constructor(private readonly opts: Options = {}) {
    this.clock = opts.now ?? (() => new Date());
    if (opts.storageKey && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`${opts.storageKey}:changes`);
      this.channel.onmessage = () => {
        if (this.load()) this.scheduleNotify();
      };
    }
  }

  now = () => Timestamp.fromDate(this.clock());

  // ---- Persistence ------------------------------------------------------------------------------
  /** Load from storage if it holds a newer version. Returns true when something changed. */
  load(): boolean {
    if (!this.opts.storageKey) return false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.opts.storageKey);
    } catch {
      return false;
    }
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version: number; cols: Record<string, Record<string, unknown>> };
    if (parsed.version <= this.version && this.cols.size) return false;
    this.cols = new Map(Object.entries(parsed.cols).map(([c, docs]) => [c, new Map(Object.entries(docs).map(([id, d]) => [id, decode(d) as Doc]))]));
    this.version = parsed.version;
    return true;
  }
  isEmpty() {
    return this.cols.size === 0;
  }
  private save() {
    if (!this.opts.storageKey) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    if (!this.opts.storageKey) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const cols = Object.fromEntries([...this.cols].map(([c, docs]) => [c, Object.fromEntries([...docs].map(([id, d]) => [id, encode(d)]))]));
    try {
      localStorage.setItem(this.opts.storageKey, JSON.stringify({ version: this.version, cols }));
      this.channel?.postMessage(this.version);
    } catch (e) {
      console.warn('Demo data could not be saved (browser storage full or blocked).', e);
    }
  }
  reset() {
    this.cols.clear();
    this.version = 0;
    if (this.opts.storageKey) {
      try {
        localStorage.removeItem(this.opts.storageKey);
      } catch {
        /* ignore */
      }
    }
  }

  // ---- Reads ------------------------------------------------------------------------------------
  get(path: string): Doc | undefined {
    const [col, id] = splitPath(path);
    const d = this.cols.get(col)?.get(id);
    return d ? clone(d) : undefined;
  }
  list(colPath: string): [string, Doc][] {
    return [...(this.cols.get(colPath) ?? new Map<string, Doc>())].map(([id, d]) => [id, clone(d)]);
  }
  /** All documents of every collection whose last segment is `group` (collection-group queries). */
  listGroup(group: string): [string, string, Doc][] {
    const out: [string, string, Doc][] = [];
    for (const [col, docs] of this.cols) {
      if (col === group || col.endsWith(`/${group}`)) for (const [id, d] of docs) out.push([col, id, clone(d)]);
    }
    return out;
  }

  // ---- Writes -----------------------------------------------------------------------------------
  /** Apply writes atomically (all or nothing). */
  commit(writes: Write[]) {
    if (!writes.length) return;
    // Work on copies of the touched collections; swap in only if every write succeeds.
    const staged = new Map<string, Map<string, Doc>>();
    const colOf = (c: string) => {
      if (!staged.has(c)) staged.set(c, new Map(this.cols.get(c) ?? []));
      return staged.get(c)!;
    };
    for (const w of writes) {
      const [c, id] = splitPath(w.path);
      const docs = colOf(c);
      const cur = docs.get(id);
      if (w.type === 'delete') {
        docs.delete(id);
        continue;
      }
      if (w.type === 'create' && cur) throw new FirestoreError('already-exists', `Document already exists: ${w.path}`);
      if (w.type === 'update' && !cur) throw new FirestoreError('not-found', `No document to update: ${w.path}`);
      const data = normalize(w.data) as Doc;
      let next: Doc;
      if (w.type === 'update') {
        next = clone(cur!);
        for (const [field, v] of Object.entries(data)) setPath(next, field, v, this.now);
      } else if (w.type === 'set' && w.merge && cur) {
        next = clone(cur);
        mergeInto(next, data, this.now);
      } else {
        next = {};
        mergeInto(next, data, this.now);
      }
      docs.set(id, next);
    }
    for (const [c, docs] of staged) this.cols.set(c, docs);
    this.version++;
    this.save();
    this.scheduleNotify();
    const paths = writes.map((w) => w.path);
    for (const h of this.commitHooks) queueMicrotask(() => h(paths));
  }

  /** Serialise transactions (JavaScript is single-threaded, but transactions await between steps). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(() => {
      this.load(); // pick up writes made in other tabs first
      return fn();
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ---- Change notification ------------------------------------------------------------------------
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onCommit(fn: (paths: string[]) => void) {
    this.commitHooks.add(fn);
    return () => this.commitHooks.delete(fn);
  }
  private scheduleNotify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const l of [...this.listeners]) l();
    });
  }
}
