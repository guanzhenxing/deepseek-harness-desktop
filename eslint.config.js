import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/coverage/**', '**/lib/**', '**/node_modules/**', '**/release/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
  {
    // Sandboxed CommonJS preload (Electron ESM limitation) and the recovery
    // renderer are intentionally plain scripts with DOM/require globals.
    files: ['apps/desktop-launcher/src/recovery-preload.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
    languageOptions: { globals: { require: 'readonly' } },
  },
  {
    files: ['apps/desktop-launcher/src/recovery-view.js'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly' } },
  },
)
