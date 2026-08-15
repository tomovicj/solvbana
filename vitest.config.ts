import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @solvbana/* to TypeScript source, so tests never run against a stale dist.
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    server: { deps: { inline: [/@solvbana\//] } },
  },
});
