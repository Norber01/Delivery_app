/** Stand-in for `firebase/functions`: callables run the real services in this browser tab. */
import { demoReady, sessionUid } from '../runtime/core.js';

export interface Functions {
  type: 'functions';
  region: string;
}
export const getFunctions = (_app?: unknown, region = 'europe-west1'): Functions => ({ type: 'functions', region });
export const connectFunctionsEmulator = () => {};

export function httpsCallable<I = unknown, O = unknown>(_f: Functions, name: string, _opts?: { timeout?: number }) {
  return async (data?: I): Promise<{ data: O }> => {
    await demoReady();
    const { callAs } = await import('../runtime/wiring.js');
    // A short pause so screens show their "working…" state as they would against a server.
    await new Promise((r) => setTimeout(r, 120));
    return { data: await callAs<O>(sessionUid(), name, data) };
  };
}
