import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  css: {
    preprocessorOptions: {
      // Use Dart Sass's modern compiler API (the legacy one is deprecated
      // and prints a warning on every build).
      scss: { api: 'modern-compiler' },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // The server has no route prefix, so we forward the three route
      // roots verbatim (no rewrite). This matches the prod path exactly
      // (origin + `/music/...`), so dev and packaged builds behave the
      // same. `/music` also covers the <audio>/cover-proxy media paths.
      '/music': { target: 'http://127.0.0.1:3200', changeOrigin: true },
      '/auth': { target: 'http://127.0.0.1:3200', changeOrigin: true },
      '/reco': { target: 'http://127.0.0.1:3200', changeOrigin: true },
      '/storage': { target: 'http://127.0.0.1:3200', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
