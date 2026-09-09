import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'tests/fixtures/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // House style: every function is an arrow function, and there are no
      // classes — stateful objects are closure factories returning an object
      // literal, paired with an exported `interface` of the same name so type
      // positions read unchanged.
      'func-style': ['error', 'expression'],
      'prefer-arrow-callback': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // §10/§11: lifecycle must never go through a shell built from strings.
          selector: "CallExpression[callee.property.name='exec']",
          message: 'child_process.exec is forbidden; use the ProcessExecutor (argv arrays).',
        },
        {
          selector: 'ClassDeclaration',
          message: 'No classes: use a closure factory returning an object literal.',
        },
        {
          selector: 'ClassExpression',
          message: 'No classes: use a closure factory returning an object literal.',
        },
        {
          selector: 'FunctionExpression',
          message: 'Use an arrow function instead of a function expression.',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
  {
    // Test files live beside the code they cover, so this has to match every
    // `tests/` directory in the workspace, not just the root one.
    files: ['**/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
