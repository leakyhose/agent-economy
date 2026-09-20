import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Everything the backend owns. `/dashboard` is ours (a route in this app), so it is not here.
const API = ['/state', '/agent', '/tunables', '/start', '/stop', '/pause', '/resume', '/events'];

// Where the village is running. `BACKEND=http://127.0.0.1:8811 npm run dev` points the dev
// server at a test instance; the default is the port the backend picks by itself.
const target = process.env.BACKEND ?? 'http://127.0.0.1:8787';

// /events is a Server-Sent Events stream. http-proxy passes it through as it arrives; the
// one thing that would break it is a proxy that buffers or re-encodes, so nothing is added
// here beyond keeping the connection open.
const proxy = Object.fromEntries(API.map(p => [p, { target, changeOrigin: true, ws: false, timeout: 0, proxyTimeout: 0 }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true, proxy },
  preview: { proxy },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
