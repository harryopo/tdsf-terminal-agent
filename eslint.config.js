// ESLint v9 flat config — TDSF Terminal Agent v4.0
// 规则: 项目硬约束 (反 AI 味 + 避免重复造轮子 + 质量优先)
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri/target',
      '**/coverage',
      // TDSF 魔改: 上游开源项目源码克隆（仅供调研参考，不参与 lint/typecheck）
      'opensource-reference/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          // store 文件遵循 React Context 模式, 需导出 Provider + hook + 常量
          allowExportNames: [
            'useRuntime',
            'RuntimeProvider',
            'MOOD_LIST',
            'MODE_LIST',
            'PERM_LIST',
            'RISK_LIST',
          ],
        },
      ],
      // 项目硬约束
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'debug'] }],
      'prefer-const': 'error',
      // null: 'ignore' 保留 `x == null` / `x != null` 的惯用 null/undefined 检查写法
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // terax 上游大量使用 best-effort 空 catch (剪贴板/持久化等可失败操作), 全部 29 处均为 catch 块
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 终端 ANSI/OSC 转义序列处理: 正则中的控制字符 (\x00 \x1b \x07 等) 是功能本体
    files: [
      'src/modules/terminal/**/*.{ts,tsx}',
      'src/components/Terminal.tsx',
      'src/components/SshTerminal.tsx',
      'src/lib/shell-integration.ts',
      'src/lib/command-tracker-addon.ts',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // 这些文件遵循 React Context / 工具模块模式, 需导出 Provider + hook + 常量 + 工具函数
    files: [
      'src/store/**/*.{ts,tsx}',
      'src/modules/theme/**/*.{ts,tsx}',
      'src/components/ai-elements/conversation.tsx',
      'src/components/ai-elements/markdown-code.tsx',
      'src/components/ai-elements/reasoning.tsx',
      'src/components/ui/badge.tsx',
      'src/components/ui/button-group.tsx',
      'src/components/ui/button.tsx',
      'src/components/ui/tabs.tsx',
      'src/components/ui/toggle.tsx',
      'src/lib/risk-engine/guard.tsx',
      'src/modules/ai/components/AgentStatusPill.tsx',
      'src/modules/ai/lib/composer.tsx',
      'src/modules/git-history/GraphRail.tsx',
      'src/modules/ssh-explorer/SshStatusDot.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // xterm.js addon 标准模式: interface + class 声明合并 (官方 API 要求)
    files: ['src/lib/command-tracker-addon.ts', 'src/lib/shell-integration.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
    },
  },
  {
    files: ['**/*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
