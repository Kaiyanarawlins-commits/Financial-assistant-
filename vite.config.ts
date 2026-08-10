import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `VITE_BASE` lets the same build target both a domain root and a project
 * subpath. GitHub Pages serves this repo under `/Financial-assistant-/`, and
 * without a matching base the bundle would request its assets from `/assets/…`
 * and 404 on every one.
 */
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
