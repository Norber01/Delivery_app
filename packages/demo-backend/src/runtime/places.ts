import type { GeocodeResult } from '@courier/shared-utils';

/** Address search for the demo (in place of Mapbox): well-known places in Ghana. */
export const PLACES: GeocodeResult[] = [
  ['Oxford Street, Osu, Accra', 5.556, -0.1823, 'Accra', 'Greater Accra'],
  ['Accra Mall, Spintex Road, Accra', 5.6215, -0.1737, 'Accra', 'Greater Accra'],
  ['Makola Market, Accra Central', 5.5475, -0.2105, 'Accra', 'Greater Accra'],
  ['Madina Market, Madina, Accra', 5.6681, -0.1653, 'Accra', 'Greater Accra'],
  ['East Legon, Lagos Avenue, Accra', 5.6353, -0.1606, 'Accra', 'Greater Accra'],
  ['Labadi Beach Road, La, Accra', 5.5603, -0.1489, 'Accra', 'Greater Accra'],
  ['Kotoka International Airport, Accra', 5.6052, -0.1668, 'Accra', 'Greater Accra'],
  ['Achimota Mall, Achimota, Accra', 5.6203, -0.2253, 'Accra', 'Greater Accra'],
  ['Kaneshie Market, Kaneshie, Accra', 5.5651, -0.2366, 'Accra', 'Greater Accra'],
  ['Dansoman Roundabout, Dansoman, Accra', 5.5449, -0.2685, 'Accra', 'Greater Accra'],
  ['University of Ghana, Legon', 5.6508, -0.1869, 'Accra', 'Greater Accra'],
  ['Adenta Barrier, Adenta', 5.7085, -0.1656, 'Adenta', 'Greater Accra'],
  ['West Hills Mall, Weija', 5.5577, -0.3302, 'Accra', 'Greater Accra'],
  ['Community 1, Tema', 5.6698, -0.0166, 'Tema', 'Greater Accra'],
  ['Tema Harbour, Tema', 5.6345, 0.0115, 'Tema', 'Greater Accra'],
  ['Kasoa Toll Booth, Kasoa', 5.5328, -0.4183, 'Kasoa', 'Central'],
  ['Adum, Kumasi', 6.6966, -1.6233, 'Kumasi', 'Ashanti'],
  ['Kejetia Market, Kumasi', 6.7004, -1.6253, 'Kumasi', 'Ashanti'],
  ['KNUST Campus, Kumasi', 6.6745, -1.5716, 'Kumasi', 'Ashanti'],
  ['Asokwa, Kumasi', 6.6667, -1.6111, 'Kumasi', 'Ashanti'],
  ['Bantama, Kumasi', 6.7065, -1.6421, 'Kumasi', 'Ashanti'],
  ['Kumasi City Mall, Asokwa', 6.6705, -1.6052, 'Kumasi', 'Ashanti'],
  ['Market Circle, Takoradi', 4.8977, -1.7558, 'Takoradi', 'Western'],
  ['Takoradi Harbour, Takoradi', 4.8889, -1.7444, 'Takoradi', 'Western'],
  ['Anaji, Takoradi', 4.9282, -1.7839, 'Takoradi', 'Western'],
  ['Cape Coast Castle, Cape Coast', 5.1036, -1.2411, 'Cape Coast', 'Central'],
  ['Koforidua Central Market, Koforidua', 6.0941, -0.2591, 'Koforidua', 'Eastern'],
  ['Ho Central Market, Ho', 6.6008, 0.4713, 'Ho', 'Volta'],
  ['Tamale Central Market, Tamale', 9.4008, -0.8393, 'Tamale', 'Northern'],
  ['Sunyani Main Station, Sunyani', 7.3349, -2.3123, 'Sunyani', 'Bono'],
].map(([label, lat, lng, city, region]) => ({ label: label as string, location: { lat: lat as number, lng: lng as number }, city: city as string, region: region as string }));

/** Places whose name contains every word typed (case-insensitive). */
export function searchPlaces(q: string): GeocodeResult[] {
  const words = q.toLowerCase().split(/[\s,]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  return PLACES.filter((p) => words.every((w) => p.label.toLowerCase().includes(w))).slice(0, 6);
}
export const place = (label: string) => PLACES.find((p) => p.label === label)!;
