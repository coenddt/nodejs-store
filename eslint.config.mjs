// eslint flat config（nodejs-store，CJS + Node >=18）
//
// 规则从现有代码风格反推（评测报告 m-5）：2 空格缩进、单引号、分号、
// 未用形参以 `_` 前缀约定豁免。`js.configs.recommended` 提供正确性底线
// （no-undef / no-unused-vars / eqeqeq 之外的兜底项），刻意不引入
// prettier/stylistic 全家桶 —— 避免一次性大规模重排历史代码。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'coverage/', '**/*.node'],
  },
  js.configs.recommended,
  {
    // 仅约束仓库源码（.js / .cjs）；config 自身（.mjs）保持 ESM 默认解析
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      indent: ['error', 2, { SwitchCase: 1 }],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // 测试与脚本同为 CJS，但允许宽松的断言风格
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    rules: {},
  },
];
