import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '127.0.0.1', fs: { strict: false } },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
  esbuild: { target: 'es2022' },
});
