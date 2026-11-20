import { Buffer } from 'buffer';
import { demoNow, theDb } from './core.js';
import { installFetchInterceptor } from './evidence.js';
import { searchPlaces } from './places.js';

/** Wire the services, create the sample data on first visit, and show the demo bar. */
export async function start() {
  const g = globalThis as { Buffer?: unknown };
  g.Buffer ??= Buffer;
  const db = theDb(); // before any store is built, so they all use the saved database
  installFetchInterceptor(searchPlaces);
  const { services } = await import('./wiring.js');
  services();
  if (db.isEmpty()) {
    const { seed } = await import('./seed.js');
    await seed(new Date());
    db.flush();
  }
  await keepDriversOnShift();
  if (typeof window !== 'undefined') {
    const { callAs } = await import('./wiring.js');
    const { DRIVERS } = await import('./seed.js');
    /** Used by the ops app's "Driver phone" page to act as a driver (the real app is Android-only). */
    (window as unknown as { __courierDemo: unknown }).__courierDemo = {
      drivers: DRIVERS,
      callAs,
      /** The delivery code texted to the recipient (the demo shows it so you can complete deliveries). */
      latestCode(trackingNumber: string) {
        const bodies = db
          .list('notifications')
          .map(([, n]) => n as { template?: string; trackingNumber?: string; body?: string; createdAt?: { toMillis(): number } })
          .filter((n) => n.template === 'delivery_otp' && n.trackingNumber === trackingNumber)
          .sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0));
        return /(\d{6})/.exec(bodies.at(-1)?.body ?? '')?.[1] ?? null;
      },
    };
  }
  if (typeof document !== 'undefined') (await import('./banner.js')).mountBanner();
  // A page left open past a shift's end keeps its drivers too.
  if (typeof window !== 'undefined') setInterval(() => void keepDriversOnShift(), 60_000);
}

/**
 * Real shifts end after 12 hours, so sample drivers whose shift ran out (the demo was first
 * opened yesterday) would vanish from the maps and the driver lists. Start a new shift on the same
 * vehicle for each of them. Drivers whose shift was ended on purpose (no current shift) stay off.
 */
export async function keepDriversOnShift() {
  const { callAs } = await import('./wiring.js');
  const { DRIVERS } = await import('./seed.js');
  const now = demoNow().getTime();
  for (const { uid } of DRIVERS) {
    const shift = (theDb().get(`drivers/${uid}`) as { currentShift?: { vehicleId: string; activeUntil: string } | null } | undefined)?.currentShift;
    if (!shift || Date.parse(shift.activeUntil) > now) continue;
    try {
      await callAs(uid, 'startShift', { vehicleId: shift.vehicleId });
    } catch {
      /* e.g. the vehicle was taken or sent for maintenance: leave this driver off shift */
    }
  }
  theDb().flush();
}
