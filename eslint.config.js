'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Shared rules. Empty catches are an intentional, documented pattern in this
// codebase (best-effort cache/notify/export), so they are allowed.
const common = {
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-var': 'error',
  'prefer-const': ['warn', { ignoreReadBeforeAssign: true }],
  eqeqeq: ['error', 'smart'],
  'no-shadow': 'warn',
  'no-implicit-coercion': 'off',
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'build/**', 'docs/**'] },
  js.configs.recommended,

  // Node context: main process, preload, the reusable scanner core, and tests.
  {
    files: ['src/main.js', 'src/preload.js', 'src/scanner/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: common,
  },

  // Renderer: runs in the browser, loaded as a plain <script> (no require/module).
  // All functions/consts share one file-level scope, so cross-references resolve.
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: common,
  },
];
