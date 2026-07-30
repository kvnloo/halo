import { defineConfig } from 'vite';
export default defineConfig({
  // HMR is disabled for captures: a dozen agents edit shaders continuously, and a hot
  // reload landing mid-capture destroys the page's execution context and kills the run.
  server: { host: '127.0.0.1', fs: { strict: false }, hmr: !process.env.HALO_NO_HMR },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
  esbuild: { target: 'es2022' },
});
