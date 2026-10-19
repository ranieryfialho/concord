import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.CONCORD_SERVER ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 700 }, // livekit-client is a lazily loaded ~570 kB chunk
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/uploads': SERVER,
      '/gateway': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
});
