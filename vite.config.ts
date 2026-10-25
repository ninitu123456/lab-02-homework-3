import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Preserve the browser's Host so backend same-origin checks also work in dev.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: { outDir: 'dist' },
});
