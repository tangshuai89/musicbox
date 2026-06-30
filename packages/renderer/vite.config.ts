import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // /api/music/next → server :3200/music/next (strips /api)
      '/api': {
        target: 'http://localhost:3200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // /music/stream/* → server :3200/music/stream/* (no prefix to strip)
      // Needed because audio elements use track.audioUrl which is
      // `/music/stream/{provider}/{id}` (no /api prefix) — see
      // music.service.ts refillQueue.
      '/music': {
        target: 'http://localhost:3200',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
