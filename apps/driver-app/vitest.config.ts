import { defineConfig } from 'vitest/config';
// Core logic only (no React Native runtime needed).
export default defineConfig({ test: { include: ['src/core/**/*.test.ts'] } });
