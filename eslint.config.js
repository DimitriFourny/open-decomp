import { fileURLToPath } from 'node:url';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default defineConfig([
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url)), {
    gitignoreResolution: true,
  }),
  includeIgnoreFile(fileURLToPath(new URL('.prettierignore', import.meta.url)), {
    gitignoreResolution: true,
  }),
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [{ blankLine: 'always', prev: 'method', next: 'method' }],
        },
      ],
    },
  },
]);
