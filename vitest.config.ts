/**
 * vitest.config.ts — TDSF Terminal Agent v4.0 测试配置
 * -----------------------------------------------------------------------------
 * 复用 vite.config.ts 的所有配置, 仅追加 test 字段.
 * 用 mergeConfig 避免重复定义 plugins / resolve / 等.
 * -----------------------------------------------------------------------------
 */
import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      globals: true,
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
  }),
);
