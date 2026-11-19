import { TRACKING_DEFAULTS } from '@courier/constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { LocationReporter, type LocationPayload } from '../core/locationReporter';
import { config } from './config';
import { appCheckToken, auth, authReady } from './firebase';
import { shiftStore } from './storage';

export const LOCATION_TASK = 'courier-shift-location';

let cachedShift: { shiftId: string; vehicleId: string; activeUntilMs: number } | null = null;
async function refreshShift() {
  const s = await shiftStore.get();
  cachedShift = s ? { shiftId: s.id, vehicleId: s.vehicleId, activeUntilMs: new Date(s.activeUntil).getTime() } : null;
}

/** RTDB REST write of the driver's own node (rules: own uid, active shift, Ghana bounds). */
async function writeLocation(p: LocationPayload) {
  const user = auth.currentUser ?? (await authReady());
  if (!user) throw new Error('signed out');
  const [idToken, ac] = await Promise.all([user.getIdToken(), appCheckToken()]);
  const res = await fetch(`${config.firebase.databaseURL}/driverLocations/${user.uid}.json?auth=${idToken}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(ac ? { 'X-Firebase-AppCheck': ac } : {}) },
    body: JSON.stringify({ ...p, serverAt: { '.sv': 'timestamp' } }),
  });
  if (!res.ok) throw new Error(`location write ${res.status}`);
}

const reporter = new LocationReporter({ write: writeLocation, shift: () => cachedShift });

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  if (!cachedShift) await refreshShift();
  for (const l of data.locations) {
    const result = await reporter.onFix({
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      accuracyM: l.coords.accuracy ?? 999,
      speedKph: l.coords.speed !== null && l.coords.speed >= 0 ? l.coords.speed * 3.6 : undefined,
      heading: l.coords.heading ?? undefined,
      at: l.timestamp,
    });
    if (result === 'no_shift') await stopShiftTracking();
  }
});

/** Ask for foreground then background location; returns a reason when refused. */
export async function requestLocationPermissions(): Promise<string | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'Location permission is needed to start a shift.';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'Choose “Allow all the time” so tracking continues while you navigate in another app.';
  return null;
}

/** Start GPS sharing for the shift as an Android foreground service (persistent notification). */
export async function startShiftTracking() {
  await refreshShift();
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    // Collect fixes more often than we send; the reporter applies the 30–60 s / 100 m policy.
    timeInterval: 15_000,
    distanceInterval: 25,
    deferredUpdatesInterval: TRACKING_DEFAULTS.minIntervalSeconds * 1000,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    foregroundService: {
      notificationTitle: `${config.companyName}: on shift`,
      notificationBody: 'Your location is shared with dispatch until you end your shift.',
      notificationColor: '#15803d',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopShiftTracking() {
  cachedShift = null;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}
