// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import customRules from './eslint-rules/index.mjs';

export default [
    // Ignore patterns
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'build/**',
            'coverage/**',
            '*.min.js',
            'public/**',
            '.env*',
            'validations/**',
        ],
    },

    // Base JavaScript config
    js.configs.recommended,

    // TypeScript files
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                project: './tsconfig.json',
            },
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                NodeJS: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
            prettier: prettier,
            custom: customRules,
        },
        rules: {
            ...tseslint.configs.recommended.rules,
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-var-requires': 'error',
            'no-console': 'warn',
            'no-debugger': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
            'prettier/prettier': 'error',
            'custom/no-direct-response': [
                'error',
                {
                    allowedFiles: [
                        '**/res-utils.ts',
                        '**/res-utils.js',
                        '**/server.ts',
                        '**/*.test.ts',
                        '**/*.test.js',
                        '**/*.spec.ts',
                        '**/*.spec.js',
                    ],
                    resUtilsFunctions: [
                        'sendSuccess',
                        'sendError',
                        'sendAck',
                        'sendNack',
                        'sendRawBody',
                    ],
                },
            ],
        },
    },

    // Test files
    {
        files: [
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/test/**/*.ts',
            '**/tests/**/*.ts',
        ],
        languageOptions: {
            globals: {
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                test: 'readonly',
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            'no-console': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },

    // JavaScript files
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
            },
        },
        plugins: {
            prettier: prettier,
        },
        rules: {
            'prettier/prettier': 'error',
        },
    },

    // Prettier config to disable conflicts
    // prettierConfig,
];
