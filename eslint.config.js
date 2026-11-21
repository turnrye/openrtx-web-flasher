// SPDX-License-Identifier: GPL-3.0-or-later
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'public/', 'node_modules/', 'playwright-report/', 'test-results/', '.vendor/'] },
  js.configs.recommended,
  {
    // TypeScript: the type-aware rules catch what matters most in a flasher, such as a
    // promise nobody waits for.
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Byte protocols are full of `x[i]!`-free index reads and deliberate casts to the
      // browser's device types in the simulators.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // The simulators implement the browser's promise-returning device interfaces;
      // most of those methods have nothing to wait for.
      '@typescript-eslint/require-await': 'off',
      // Empty bodies are deliberate here: `.catch(() => {})` on cleanup, and interface
      // methods a simulator has no use for.
      '@typescript-eslint/no-empty-function': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // Build and CI scripts run in Node and print to the console.
    files: ['scripts/**/*.mjs', 'tests/e2e/serve.mjs', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
