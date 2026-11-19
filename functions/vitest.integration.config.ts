import { defineConfig } from 'vitest/config';

// Requires FIRESTORE_EMULATOR_HOST, e.g. via `firebase emulators:exec --only firestore`.
// Files share one emulator database, so they must not run in parallel.
export default defineConfig({ test: { include: ['test-integration/**/*.test.ts'], testTimeout: 20000, fileParallelism: false } });
