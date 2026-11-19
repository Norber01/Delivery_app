/** Stand-in for `firebase/database`: only the live driver positions the dispatch map reads. */
import { demoReady } from '../runtime/core.js';

export interface Database {
  type: 'database';
}
export const getDatabase = (_app?: unknown): Database => ({ type: 'database' });
export const connectDatabaseEmulator = () => {};
export const ref = (_db: Database, path = '') => ({ path });

export function onValue(r: { path: string }, cb: (snap: { val: () => unknown; exists: () => boolean }) => void, _err?: (e: Error) => void) {
  let stop = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  void demoReady().then(async () => {
    if (stop) return;
    const { allPositions } = await import('../runtime/live.js');
    const tick = () => {
      const all = allPositions();
      const parts = r.path.split('/').filter(Boolean);
      const v = parts[0] === 'driverLocations' ? (parts[1] ? (all[parts[1]] ?? null) : all) : null;
      cb({ val: () => v, exists: () => v !== null });
    };
    tick();
    timer = setInterval(tick, 3000);
  });
  return () => {
    stop = true;
    if (timer) clearInterval(timer);
  };
}
export const off = () => {};
