import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // In dev the UI runs on vite and talks to the hub on its own port.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
      '/health': 'http://127.0.0.1:7777',
    },
  },
});
