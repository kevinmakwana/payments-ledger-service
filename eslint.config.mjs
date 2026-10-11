import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'eslint.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Third-party provider payloads are untyped JSON; narrowing every field adds noise, not safety.
    files: ['src/providers/*.provider.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
