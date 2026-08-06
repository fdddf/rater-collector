import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * The console ships *inside* the Worker bundle, so the build has to collapse to one
 * self-contained `index.html` — `scripts/build-admin.mjs` then wraps that file in a
 * TypeScript string constant. Hence `viteSingleFile`: no separate asset pipeline, no
 * static-asset binding, and deploying the Worker still deploys the console.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    // The `esnext` target keeps the inlined bundle small; the console is an internal tool
    // and only ever runs in a current browser.
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
  server: {
    // `npm run dev` here talks to a `wrangler dev` on 8787, so the console can be worked on
    // with hot reload against the real API.
    proxy: { '/admin/api': 'http://127.0.0.1:8787' },
  },
});
