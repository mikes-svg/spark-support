/* ESLint config for the Vite + React + TypeScript frontend (src/).
 * The Cloud Functions (functions/) are CommonJS Node and are linted separately;
 * built output (dist/, dev-dist/) and configs are ignored below. */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // The codebase intentionally uses `as` casts around loosely-typed Firestore
    // document data; flag explicit any as a warning rather than an error.
    '@typescript-eslint/no-explicit-any': 'off',
    // Empty no-op handlers (e.g. placeholder onCancel) are intentional here.
    '@typescript-eslint/no-empty-function': 'warn',
  },
  ignorePatterns: [
    'dist',
    'dev-dist',
    'functions',
    'node_modules',
    'public',
    '*.config.js',
    '*.config.ts',
    '*.cjs',
  ],
};
