/** Stand-in for `firebase/app-check` (the demo has no backend to protect). */
export class ReCaptchaEnterpriseProvider {
  constructor(_key?: string) {}
}
export class CustomProvider {
  constructor(_o?: unknown) {}
}
export const initializeAppCheck = (_app?: unknown, _o?: unknown) => ({});
export const getToken = async () => ({ token: 'demo' });
