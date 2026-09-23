import { defineConfig } from 'vitest/config';

/**
 * Kept separate from vite.config.ts on purpose: the app build pulls in the PWA
 * plugin and a manual-chunks strategy that a test run has no use for, and which
 * would otherwise emit a service worker on every `npm test`.
 *
 * Node environment by default — the units worth testing here are pure (date
 * maths, status predicates, recurrence rules). A suite that needs the DOM
 * should add jsdom rather than making every test pay for it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
