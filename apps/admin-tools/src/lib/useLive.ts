import type { DriverLocation } from '@courier/shared-types';
import { onValue, ref } from 'firebase/database';
import { onSnapshot, type Query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { getFirebase } from './firebase';

/** Realtime Firestore query → array of docs with ids. */
export function useQuery<T>(q: Query | null, deps: unknown[]): { data: (T & { _id: string })[]; error: string | null } {
  const [data, setData] = useState<(T & { _id: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q) return;
    return onSnapshot(
      q,
      (snap) => {
        setError(null);
        setData(snap.docs.map((d) => ({ ...(d.data() as T), _id: d.id })));
      },
      (e) => setError(e.code === 'permission-denied' ? 'You do not have access to this data.' : 'Live updates interrupted. Retrying…'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

/** All live driver positions (RTDB; readable by MFA ops staff only). */
export function useDriverLocations(): Record<string, DriverLocation> {
  const [locs, setLocs] = useState<Record<string, DriverLocation>>({});
  useEffect(() => onValue(ref(getFirebase().rtdb, 'driverLocations'), (s) => setLocs((s.val() as Record<string, DriverLocation> | null) ?? {}), () => setLocs({})), []);
  return locs;
}

/** Re-render periodically so "N min ago" and freshness labels stay current. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
