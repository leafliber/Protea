import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `pnpm --filter @protea/web dev` proxies the API to a running daemon (PROTEA_URL, default :7788).
const target = process.env['PROTEA_URL'] ?? 'http://127.0.0.1:7788';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
      '/metrics': { target },
    },
  },
});
