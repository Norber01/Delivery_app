import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { demoAlias, demoHtml } from '../../packages/demo-backend/vite';

/** VITE_DEMO=true builds the card-free demo (Firebase replaced by an in-browser backend). */
const demo = process.env.VITE_DEMO === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(demo ? [demoHtml()] : [])],
  ...(demo ? { resolve: { alias: demoAlias } } : {}),
  base: process.env.APP_BASE || '/',
  build: { sourcemap: true, target: 'es2022' },
  test: { environment: 'jsdom' },
});
