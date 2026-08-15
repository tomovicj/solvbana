import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling config belongs to no package tsconfig.
          allowDefaultProject: ['vitest.config.ts', 'eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // The diagnosis engine is a library that happens to have consumers. Keeping
    // it framework-free is what makes the planned CLI and CI-integration API
    // cheap to add, so the boundary fails lint rather than review.
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'fastify/*', '@fastify/*', 'node:http', 'node:https', 'node:net'],
              message: '@solvbana/core must not depend on HTTP or any web framework.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
