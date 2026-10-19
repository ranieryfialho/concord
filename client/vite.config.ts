import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.CONCORD_SERVER ?? 'http://localhost:3001';

// Every production build gets an id. It is compiled into the app (__BUILD_ID__) and written to
// dist/version.json, which the server reads to tell connected clients that a newer build is out.
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function buildVersion(): Plugin {
  return {
    name: 'concord-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), buildVersion()],
  define: { __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev') },
  build: { chunkSizeWarningLimit: 700 }, // livekit-client is a lazily loaded ~570 kB chunk
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/uploads': SERVER,
      '/gateway': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
}));
