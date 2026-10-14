import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['build/**', 'dist/**', '**/dist/**', '**/.wrangler/**', 'node_modules/**', 'docs/archive/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
