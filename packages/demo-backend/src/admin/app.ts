/** Stand-in for `firebase-admin/app`: apps are just names in the demo. */
export function initializeApp(options: Record<string, unknown> = {}, name = '[DEFAULT]') {
  return { name, options };
}
export async function deleteApp(_app: unknown) {}
export function getApps() {
  return [];
}
