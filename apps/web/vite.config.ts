import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `pnpm --filter @protea/web dev` proxies the API to a running daemon (PROTEA_URL, default :7788).
const target = process.env['PROTEA_URL'] ?? 'http://127.0.0.1:7788';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Nothing is inlined as a data: URL: the console's CSP only loads fonts and scripts from its own files.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1600, assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
      '/metrics': { target },
    },
  },
});
