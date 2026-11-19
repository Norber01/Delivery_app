/** Stand-in for `firebase/app`. */
export interface FirebaseApp {
  name: string;
  options: Record<string, unknown>;
}
const app: FirebaseApp = { name: '[DEFAULT]', options: { projectId: 'demo-courier' } };
export const initializeApp = (_o?: unknown): FirebaseApp => app;
export const getApp = () => app;
export const getApps = () => [app];
