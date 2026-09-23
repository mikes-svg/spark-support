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
    // functions/ is CommonJS JS, not TS, but its tests are the ONLY guard on the
    // recurrence date maths and the Google Calendar sync loop — the app build
    // cannot catch a bug in either. Leaving them out of `include` made 86 tests
    // invisible to CI while still passing locally, which is worse than no tests.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'functions/**/*.test.js',
    ],
    // gcal.test.js is written against node:test, not vitest, so vitest can't
    // collect it. It runs in the same `npm test` via `node --test` instead of
    // being rewritten — 40 hand-written assertions about OAuth loop suppression
    // are worth more as-is than re-typed by someone who didn't write them.
    exclude: ['**/node_modules/**', 'functions/__tests__/gcal.test.js'],
  },
});
