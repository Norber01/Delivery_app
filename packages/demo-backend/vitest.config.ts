import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Two suites:
 *  - this package's own tests (test/*.test.ts)
 *  - the real Cloud Functions emulator integration tests, re-run against the in-browser database
 *    (firebase-admin replaced by the demo fakes), proving the demo behaves like Firestore.
 */
export default defineConfig({
  resolve: {
    alias: {
      'firebase-admin/firestore': here('./src/admin/firestore.ts'),
      'firebase-admin/app': here('./src/admin/app.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', '../../functions/test-integration/{firestoreStore,payments,business,fleet}.int.test.ts'],
    setupFiles: [here('./test/setup.ts')],
    env: { FIRESTORE_EMULATOR_HOST: 'demo-db' },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
