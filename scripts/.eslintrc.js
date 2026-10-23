/* scripts/ holds one-off Admin SDK Node scripts (CommonJS), not browser code —
 * mirrors the existing api/**\/*.js override in the root .eslintrc.js rather
 * than editing that shared file. Cascades under the root config automatically;
 * this file only adds the Node globals (require, module, process, __dirname). */
module.exports = {
  env: { node: true, es2020: true },
  rules: {
    // require() is how this Admin SDK script (and functions/) load modules —
    // it's CommonJS, not an ESM bundle.
    '@typescript-eslint/no-var-requires': 'off',
  },
};
