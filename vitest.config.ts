import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@protea/protocol': r('./packages/protocol/src/index.ts'),
      '@protea/core': r('./packages/core/src/index.ts'),
      '@protea/control': r('./packages/control/src/index.ts'),
      '@protea/plugin-console': r('./plugins/console/src/index.ts'),
      '@protea/plugin-cron': r('./plugins/cron/src/index.ts'),
      '@protea/daemon': r('./apps/daemon/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
