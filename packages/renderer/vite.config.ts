import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The server has no route prefix, so we forward the three route
      // roots verbatim (no rewrite). This matches the prod path exactly
      // (origin + `/music/...`), so dev and packaged builds behave the
      // same. `/music` also covers the <audio>/cover-proxy media paths.
      '/music': { target: 'http://localhost:3200', changeOrigin: true },
      '/auth': { target: 'http://localhost:3200', changeOrigin: true },
      '/reco': { target: 'http://localhost:3200', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
