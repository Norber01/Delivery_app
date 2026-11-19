import type { DemoDb } from './store.js';
import { compare, getPath, matches, type Doc, type WhereOp } from './values.js';

export interface QuerySpec {
  collection: string;
  group?: boolean;
  filters: { field: string; op: WhereOp; value: unknown }[];
  orders: { field: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  limitToLast?: number;
  startAfter?: unknown[];
}

export interface Row {
  path: string;
  id: string;
  data: Doc;
}

const ID_FIELD = '__name__';

/** Evaluate a query the way Firestore does (missing order-by fields exclude the document). */
export function runQuery(db: DemoDb, q: QuerySpec): Row[] {
  const source: Row[] = q.group
    ? db.listGroup(q.collection).map(([col, id, data]) => ({ path: `${col}/${id}`, id, data }))
    : db.list(q.collection).map(([id, data]) => ({ path: `${q.collection}/${id}`, id, data }));
  let rows = source.filter((r) =>
    q.filters.every((f) => (f.field === ID_FIELD ? matches({ [ID_FIELD]: r.id }, ID_FIELD, f.op, f.value) : matches(r.data, f.field, f.op, f.value))),
  );
  const orders = [...q.orders];
  // Firestore orders by the inequality field first when no explicit order is given.
  const range = q.filters.find((f) => ['<', '<=', '>', '>='].includes(f.op));
  if (range && !orders.some((o) => o.field === range.field)) orders.unshift({ field: range.field, dir: 'asc' });
  rows = rows.filter((r) => orders.every((o) => o.field === ID_FIELD || getPath(r.data, o.field) !== undefined));
  rows.sort((a, b) => {
    for (const o of orders) {
      const c = o.field === ID_FIELD ? compare(a.id, b.id) : compare(getPath(a.data, o.field), getPath(b.data, o.field));
      if (c) return o.dir === 'asc' ? c : -c;
    }
    return compare(a.id, b.id);
  });
  if (q.startAfter?.length) {
    const after = q.startAfter;
    rows = rows.filter((r) => {
      for (let i = 0; i < after.length; i++) {
        const o = orders[i]!;
        const c = compare(getPath(r.data, o.field), after[i]);
        const dirC = o.dir === 'asc' ? c : -c;
        if (dirC > 0) return true;
        if (dirC < 0) return false;
      }
      return false;
    });
  }
  if (q.limit !== undefined) rows = rows.slice(0, q.limit);
  if (q.limitToLast !== undefined) rows = rows.slice(-q.limitToLast);
  return rows;
}
