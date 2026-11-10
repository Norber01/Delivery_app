import { defineConfig } from 'vitest/config';

// Requires FIRESTORE_EMULATOR_HOST, e.g. via `firebase emulators:exec --only firestore`.
export default defineConfig({ test: { include: ['test-integration/**/*.test.ts'], testTimeout: 20000 } });
