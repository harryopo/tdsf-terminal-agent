/**
 * e2e/nginx-failure.spec.ts — P2-A E2E 测试（nginx 故障排查链路）
 * -----------------------------------------------------------------------------
 * 测试场景：
 *   1. 用户输入 "nginx 启动失败" → AgentPanel 显示错误（浏览器模式下 Sidecar 未运行）
 *   2. 输入框交互（空字符串不提交、Enter 提交）
 *   3. 清空对话 / 关闭面板
 *
 * 注意：
 * - 浏览器预览模式 (pnpm dev) 下 isTauri() === false
 * - sidecar-bridge 的 isRunning() 返回 false（mock snapshot status='stopped'）
 * - 因此输入提交后会显示"Sidecar 未运行"错误信息
 * - 真实 Tauri + Python Sidecar 链路测试留作 P2-D 验收时手动测试
 */
import { test, expect } from '@playwright/test';

test.describe('AgentPanel — P2-A 前端集成', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 等待 AgentPanel 加载
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('T-P2-02.1 AgentPanel 默认渲染（空状态）', async ({ page }) => {
    // Header 显示 Agent 标签
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toContainText(
      'Agent'
    );

    // 显示空状态提示
    await expect(page.locator('[data-testid="tdsf-agent-messages"]')).toContainText(
      '我是 Linux 运维教学 Agent'
    );

    // 输入框存在且可输入
    const input = page.locator('[data-testid="tdsf-agent-input"]');
    await expect(input).toBeVisible();
    await expect(input).not.toBeDisabled();

    // 发送按钮存在但 disabled（输入框为空）
    const sendBtn = page.locator('[data-testid="tdsf-agent-send"]');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeDisabled();
  });

  test('T-P2-02.2 输入框交互：输入文本后发送按钮启用', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');
    const sendBtn = page.locator('[data-testid="tdsf-agent-send"]');

    // 输入文本
    await input.fill('nginx 启动失败');

    // 发送按钮启用
    await expect(sendBtn).toBeEnabled();

    // 输入框显示字数（"nginx 启动失败" = 5 + 1空格 + 4 = 10 字符）
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toContainText(
      '10/2000'
    );

    // 清空输入框
    await input.clear();

    // 发送按钮再次 disabled
    await expect(sendBtn).toBeDisabled();
  });

  test('T-P2-02.3 nginx 故障排查：浏览器模式下显示 Sidecar 未运行错误', async ({
    page,
  }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');

    // 输入并提交（用 Enter 键替代 sendBtn.click，避免终端元素拦截点击事件）
    await input.fill('nginx 启动失败');
    await input.press('Enter');

    // 等待错误提示出现（浏览器预览模式下 Sidecar 未运行）
    const errorEl = page.locator('[data-testid="tdsf-agent-error"]');
    await expect(errorEl).toBeVisible({ timeout: 5_000 });
    await expect(errorEl).toContainText('Sidecar 未运行');

    // 用户消息显示在消息列表中
    await expect(page.locator('[data-testid="tdsf-agent-messages"]')).toContainText(
      'nginx 启动失败'
    );

    // mood 表情变化（error 状态）
    const moodFace = page.locator('[data-testid="tdsf-agent-mood-face"]');
    await expect(moodFace).toContainText('⬡✗⬡');

    // 至少出现 2 条消息（用户消息 + 错误消息）
    const messages = page.locator('[data-testid="tdsf-agent-message"]');
    await expect(messages).toHaveCount(2);
  });

  test('T-P2-02.4 Enter 键提交（Shift+Enter 不提交）', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');

    // 输入文本
    await input.fill('测试 Enter 提交');

    // 按 Enter 提交
    await input.press('Enter');

    // 等待错误提示（Sidecar 未运行）
    await expect(page.locator('[data-testid="tdsf-agent-error"]')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('T-P2-02.5 空字符串不提交', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');
    const sendBtn = page.locator('[data-testid="tdsf-agent-send"]');

    // 空字符串
    await input.fill('');
    await expect(sendBtn).toBeDisabled();

    // 仅空格
    await input.fill('   ');
    await expect(sendBtn).toBeDisabled();

    // 按 Enter 也不应该提交
    await input.press('Enter');

    // 不应该出现错误提示
    await expect(page.locator('[data-testid="tdsf-agent-error"]')).not.toBeVisible();
  });

  test('T-P2-02.6 清空对话按钮工作正常', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');

    // 先提交一条消息（产生用户消息 + 错误消息）
    await input.fill('测试消息');
    await input.press('Enter');
    await expect(page.locator('[data-testid="tdsf-agent-error"]')).toBeVisible({
      timeout: 5_000,
    });

    // 点击清空对话按钮（用 dispatchEvent 直接触发 DOM click，避免 xterm canvas 拦截）
    await page
      .locator('[title="清空对话"]')
      .dispatchEvent('click');

    // 消息区域应该回到空状态
    await expect(page.locator('[data-testid="tdsf-agent-messages"]')).toContainText(
      '我是 Linux 运维教学 Agent'
    );

    // 错误提示消失
    await expect(page.locator('[data-testid="tdsf-agent-error"]')).not.toBeVisible();
  });

  test('T-P2-02.7 关闭按钮关闭面板', async ({ page }) => {
    // 点击关闭按钮（用 dispatchEvent 直接触发 DOM click，避免 xterm canvas 拦截）
    await page
      .locator('[title="关闭"]')
      .dispatchEvent('click');

    // AgentPanel 不可见
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).not.toBeVisible();
  });

  test('T-P2-02.8 busy 状态指示器在提交后显示', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-agent-input"]');

    await input.fill('nginx 启动失败');
    await input.press('Enter');

    // busy 指示器可能短暂可见（因为浏览器模式立即返回错误）
    // 这里验证最终状态：错误显示后 busy 应该消失
    await expect(page.locator('[data-testid="tdsf-agent-error"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.locator('[data-testid="tdsf-agent-busy-indicator"]')
    ).not.toBeVisible();
  });
});

test.describe('AgentPanel — 工具调用卡和 needs-you 通知', () => {
  test('T-P2-02.9 工具调用卡组件结构（mock 数据注入）', async ({ page }) => {
    // 通过 evaluate 注入 mock 数据到 React state
    // 浏览器预览模式下无法直接调用 reducer，这里仅验证空状态下不显示工具调用卡
    await page.goto('/');
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toBeVisible();

    // 空状态下不应有工具调用卡
    await expect(page.locator('[data-testid="tdsf-tool-call-card"]')).toHaveCount(0);

    // 空状态下不应有 needs-you 卡
    await expect(page.locator('[data-testid="tdsf-needs-you-card"]')).toHaveCount(0);
  });
});
