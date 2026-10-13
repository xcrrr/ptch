import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          // Ink renders only the final frame when it detects CI (CI=true on GitHub Actions); the
          // UI tests drive a fake terminal and need it to render live, as it does for users.
          env: { CI: '0', CONTINUOUS_INTEGRATION: '0' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
