import { defineConfig } from 'vitest/config';

// Unit tests only; integration tests use vitest.integration.config.ts.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
