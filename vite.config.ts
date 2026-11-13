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
  build: {
    rollupOptions: {
      // The single-file build has nowhere to put a second chunk. Dynamic
      // imports (the Anthropic SDK pulls in a couple) would otherwise emit
      // separate files that the inliner cannot represent.
      output: process.env.VITE_SINGLE_FILE ? { inlineDynamicImports: true } : {},
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
