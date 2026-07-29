/**
 * playwright.config.ts — Playwright E2E 测试配置（P2-A T-P2-02）
 * -----------------------------------------------------------------------------
 * 策略：
 * - 浏览器预览模式（pnpm dev）下测试 UI 层（AgentPanel 渲染、输入框、按钮状态）
 * - 真实 Tauri + Python Sidecar 链路测试留作 P2-D 验收时手动测试
 * - 失败时保留 trace + screenshot 便于调试
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    // 与 vite.config.ts 的 server.port 对齐（避开 Windows 5173 保留段）
    baseURL: 'http://127.0.0.1:9000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:9000',
    // 强制复用：测试时若已有 vite dev 在跑则直接复用，避免端口冲突
    reuseExistingServer: true,
    timeout: 120_000, // 首次启动 Vite + 依赖预构建可能较慢
    cwd: process.cwd(),
  },
});
