import { Buffer } from 'buffer';
import { theDb } from './core.js';
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
}
