import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', 'packages/db/src/generated/**', '**/next-env.d.ts'] },
  ...tseslint.configs.recommended,
);
