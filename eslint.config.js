// Lint config for development only (not shipped). Run: npx eslint .
export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                global: 'readonly', console: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
                log: 'readonly', logError: 'readonly', print: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-redeclare': 'error',
            'no-shadow': 'warn',
            'prefer-const': 'warn',
            'eqeqeq': ['warn', 'smart'],
        },
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {globals: {process: 'readonly'}},
    },
    {ignores: ['build/**']},
];
