/**
 * e2e/multi-agent.spec.ts — P4 E2E 测试（多 Agent 系统 + SteerInject）
 * -----------------------------------------------------------------------------
 * 测试场景：
 *   1. AgentPanel 默认渲染 9 个 sub-agent 卡片
 *      - data-testid="tdsf-sub-agent-grid" 可见
 *      - 9 个 data-testid="tdsf-sub-agent-card" 元素
 *      - 每个卡片 data-agent-name 属性正确（main/coding/explore/...）
 *      - 默认 data-active="false"（所有 Agent 空闲）
 *   2. SteerInjectBar 默认渲染（Agent 空闲时 disabled）
 *      - data-testid="tdsf-steer-inject-bar" 可见
 *      - 9 个 agent 名出现在下拉菜单
 *      - 输入框 disabled（因为 agentBusy=false）
 *   3. 通过 __tdsfTestHook.dispatch 注入活跃 Agent 状态
 *      - update-agent-state 将 coding Agent 设为 active
 *      - 对应卡片 data-active="true"
 *      - invocations > 0 时显示 ×N 标记
 *   4. SteerInjectBar 在 agentBusy=true 时启用
 *      - dispatch set-agent-busy true
 *      - 输入框 enabled
 *      - 选择 agent / priority
 *      - 输入文字后 Enter（提交会因 IPC 失败，但 UI 应有反馈）
 *   5. StatusBar 4 状态切换
 *      - dispatch set-statusbar-state herd/solo/review
 *      - StatusBar 徽章显示对应状态
 *   6. activeAgentCount 影响 StatusBar 显示
 *
 * 技术方案：
 * - 浏览器预览模式 (pnpm dev) 下 sidecar-bridge 返回 no-op
 * - 通过 RuntimeProvider 暴露的 window.__tdsfTestHook.dispatch 注入状态
 * - 仅 dev 模式生效（import.meta.env.DEV），生产构建无此 hook
 */
import { test, expect } from '@playwright/test';

/** 9 子 Agent 名列表（与 SUB_AGENT_DEFAULTS 对齐） */
const SUB_AGENT_NAMES = [
  'main',
  'coding',
  'explore',
  'history',
  'teach',
  'debug',
  'refactor',
  'test',
  'deploy',
] as const;

/** 测试 hook 类型定义（与 src/store/runtime.tsx 暴露的 __tdsfTestHook 对齐） */
interface TdsfTestHook {
  dispatch: (action: unknown) => void;
  getState: () => unknown;
}

/**
 * 通过 page.evaluate 注入 dispatch action 到 React state
 * 封装类型断言，避免 each call 重复 any 类型
 */
async function dispatchAction(
  page: import('@playwright/test').Page,
  action: unknown,
): Promise<void> {
  await page.evaluate((a) => {
    const w = window as unknown as { __tdsfTestHook?: TdsfTestHook };
    if (!w.__tdsfTestHook) {
      throw new Error('__tdsfTestHook not exposed');
    }
    w.__tdsfTestHook.dispatch(a);
  }, action);
}

test.describe('P4 多 Agent 系统 — SubAgentGrid', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 等待 AgentPanel 加载
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toBeVisible({
      timeout: 10_000,
    });
    // 等待测试 hook 就绪
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __tdsfTestHook?: { dispatch?: unknown } };
        return !!w.__tdsfTestHook?.dispatch;
      },
      undefined,
      { timeout: 5_000 },
    );
  });

  // ==========================================================================
  // 1. 默认渲染 9 个 sub-agent 卡片
  // ==========================================================================

  test('T-P4-12.1 渲染 SubAgentGrid 容器', async ({ page }) => {
    await expect(page.locator('[data-testid="tdsf-sub-agent-grid"]')).toBeVisible();
  });

  test('T-P4-12.2 默认渲染 9 个 sub-agent 卡片', async ({ page }) => {
    const cards = page.locator('[data-testid="tdsf-sub-agent-card"]');
    await expect(cards).toHaveCount(9);
  });

  test('T-P4-12.3 9 个卡片包含所有 agent 名', async ({ page }) => {
    for (const name of SUB_AGENT_NAMES) {
      const card = page.locator(
        `[data-testid="tdsf-sub-agent-card"][data-agent-name="${name}"]`,
      );
      await expect(card).toHaveCount(1);
    }
  });

  test('T-P4-12.4 默认所有卡片 data-active="false"', async ({ page }) => {
    const cards = page.locator('[data-testid="tdsf-sub-agent-card"]');
    const count = await cards.count();
    expect(count).toBe(9);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toHaveAttribute('data-active', 'false');
    }
  });

  test('T-P4-12.5 默认卡片不显示 invocations 标记', async ({ page }) => {
    // 默认 invocations=0，不应渲染 ×N 标记
    const invocations = page.locator('[data-testid="tdsf-sub-agent-invocations"]');
    await expect(invocations).toHaveCount(0);
  });

  test('T-P4-12.6 卡片 title 属性显示 "name — role"', async ({ page }) => {
    const mainCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="main"]',
    );
    await expect(mainCard).toHaveAttribute('title', 'main — 主 Agent（PAOR 监督 + 路由）');
  });

  // ==========================================================================
  // 2. 注入活跃 Agent 状态
  // ==========================================================================

  test('T-P4-12.7 注入 coding Agent active=true', async ({ page }) => {
    await dispatchAction(page, {
      type: 'update-agent-state',
      name: 'coding',
      updates: { active: true, mood: 'working', lastTask: '修复 nginx 配置' },
    });

    const codingCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="coding"]',
    );
    await expect(codingCard).toHaveAttribute('data-active', 'true');
  });

  test('T-P4-12.8 注入 invocations > 0 显示 ×N 标记', async ({ page }) => {
    await dispatchAction(page, {
      type: 'update-agent-state',
      name: 'coding',
      updates: { invocations: 5 },
    });

    const codingCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="coding"]',
    );
    // 应包含 ×5 标记
    await expect(codingCard).toContainText('×5');
  });

  test('T-P4-12.9 注入多个 Agent 活跃状态', async ({ page }) => {
    // 同时激活 coding 和 explore
    await dispatchAction(page, {
      type: 'update-agent-state',
      name: 'coding',
      updates: { active: true, mood: 'working' },
    });
    await dispatchAction(page, {
      type: 'update-agent-state',
      name: 'explore',
      updates: { active: true, mood: 'thinking' },
    });

    const codingCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="coding"]',
    );
    const exploreCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="explore"]',
    );
    await expect(codingCard).toHaveAttribute('data-active', 'true');
    await expect(exploreCard).toHaveAttribute('data-active', 'true');
  });

  test('T-P4-12.10 clear-agent-states 重置为默认', async ({ page }) => {
    // 先激活 coding
    await dispatchAction(page, {
      type: 'update-agent-state',
      name: 'coding',
      updates: { active: true, invocations: 3 },
    });
    const codingCard = page.locator(
      '[data-testid="tdsf-sub-agent-card"][data-agent-name="coding"]',
    );
    await expect(codingCard).toHaveAttribute('data-active', 'true');

    // 清空状态
    await dispatchAction(page, { type: 'clear-agent-states' });

    // 应重置为 data-active="false"
    await expect(codingCard).toHaveAttribute('data-active', 'false');
  });
});

test.describe('P4 多 Agent 系统 — SteerInjectBar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="tdsf-agent-panel"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __tdsfTestHook?: { dispatch?: unknown } };
        return !!w.__tdsfTestHook?.dispatch;
      },
      undefined,
      { timeout: 5_000 },
    );
  });

  // ==========================================================================
  // 3. SteerInjectBar 默认渲染（Agent 空闲时 disabled）
  // ==========================================================================

  test('T-P4-12.11 渲染 SteerInjectBar 容器', async ({ page }) => {
    await expect(page.locator('[data-testid="tdsf-steer-inject-bar"]')).toBeVisible();
  });

  test('T-P4-12.12 默认输入框 disabled（agentBusy=false）', async ({ page }) => {
    const input = page.locator('[data-testid="tdsf-steer-inject-input"]');
    await expect(input).toBeDisabled();
  });

  test('T-P4-12.13 默认 agent select disabled', async ({ page }) => {
    const select = page.locator('[data-testid="tdsf-steer-inject-agent"]');
    await expect(select).toBeDisabled();
  });

  test('T-P4-12.14 默认 priority select disabled', async ({ page }) => {
    const select = page.locator('[data-testid="tdsf-steer-inject-priority"]');
    await expect(select).toBeDisabled();
  });

  test('T-P4-12.15 显示 "运行时指令注入" 提示文字', async ({ page }) => {
    const bar = page.locator('[data-testid="tdsf-steer-inject-bar"]');
    await expect(bar).toContainText('运行时指令注入');
  });

  test('T-P4-12.16 显示 "Agent 空闲" 提示（disabled 状态）', async ({ page }) => {
    const bar = page.locator('[data-testid="tdsf-steer-inject-bar"]');
    await expect(bar).toContainText('Agent 空闲');
  });

  // ==========================================================================
  // 4. SteerInjectBar 在 agentBusy=true 时启用
  // ==========================================================================

  test('T-P4-12.17 agentBusy=true 时输入框启用', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const input = page.locator('[data-testid="tdsf-steer-inject-input"]');
    await expect(input).toBeEnabled();
  });

  test('T-P4-12.18 agentBusy=true 时 agent select 启用', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-agent"]');
    await expect(select).toBeEnabled();
  });

  test('T-P4-12.19 agentBusy=true 时 priority select 启用', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-priority"]');
    await expect(select).toBeEnabled();
  });

  test('T-P4-12.20 agent select 包含 9 个 agent 名选项', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-agent"]');
    for (const name of SUB_AGENT_NAMES) {
      await expect(select.locator(`option[value="${name}"]`)).toHaveCount(1);
    }
  });

  test('T-P4-12.21 priority select 包含 low/normal/high 选项', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-priority"]');
    await expect(select.locator('option[value="low"]')).toHaveCount(1);
    await expect(select.locator('option[value="normal"]')).toHaveCount(1);
    await expect(select.locator('option[value="high"]')).toHaveCount(1);
  });

  test('T-P4-12.22 切换 agent select 选项', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-agent"]');
    await select.selectOption('coding');
    await expect(select).toHaveValue('coding');

    await select.selectOption('debug');
    await expect(select).toHaveValue('debug');
  });

  test('T-P4-12.23 切换 priority select 选项', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const select = page.locator('[data-testid="tdsf-steer-inject-priority"]');
    await select.selectOption('high');
    await expect(select).toHaveValue('high');

    await select.selectOption('low');
    await expect(select).toHaveValue('low');
  });

  test('T-P4-12.24 输入文字后 placeholder 切换', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const input = page.locator('[data-testid="tdsf-steer-inject-input"]');
    // busy 状态下 placeholder 应提示注入指令
    await expect(input).toHaveAttribute(
      'placeholder',
      '注入指令，如 "use type hints"',
    );

    // 输入文字
    await input.fill('use type hints everywhere');
    await expect(input).toHaveValue('use type hints everywhere');
  });

  test('T-P4-12.25 Enter 提交后显示反馈（IPC 失败提示）', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const input = page.locator('[data-testid="tdsf-steer-inject-input"]');
    await input.fill('use type hints');
    await input.press('Enter');

    // 浏览器预览模式下 sidecar-bridge 调用失败，应显示反馈
    const feedback = page.locator('[data-testid="tdsf-steer-inject-feedback"]');
    await expect(feedback).toBeVisible({ timeout: 5_000 });
    // 反馈应包含失败信息
    await expect(feedback).toContainText(/失败|error/i);
  });

  test('T-P4-12.26 空字符串不提交', async ({ page }) => {
    await dispatchAction(page, { type: 'set-agent-busy', busy: true });

    const input = page.locator('[data-testid="tdsf-steer-inject-input"]');
    // 空字符串
    await input.fill('');
    await input.press('Enter');

    // 不应显示反馈
    const feedback = page.locator('[data-testid="tdsf-steer-inject-feedback"]');
    await expect(feedback).not.toBeVisible();
  });
});

test.describe('P4 多 Agent 系统 — StatusBar 状态切换', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="tdsf-statusbar"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __tdsfTestHook?: { dispatch?: unknown } };
        return !!w.__tdsfTestHook?.dispatch;
      },
      undefined,
      { timeout: 5_000 },
    );
  });

  // ==========================================================================
  // 5. StatusBar 4 状态切换
  // ==========================================================================

  test('T-P4-12.27 默认 StatusBar 显示 idle 状态', async ({ page }) => {
    const badge = page.locator('[data-testid="tdsf-statusbar-state"]');
    await expect(badge).toContainText('idle');
    await expect(badge).toContainText('○');
  });

  test('T-P4-12.28 dispatch herd 状态', async ({ page }) => {
    await dispatchAction(page, { type: 'set-statusbar-state', state: 'herd' });
    const badge = page.locator('[data-testid="tdsf-statusbar-state"]');
    await expect(badge).toContainText('herd');
    await expect(badge).toContainText('⬡⬡⬡');
  });

  test('T-P4-12.29 dispatch solo 状态', async ({ page }) => {
    await dispatchAction(page, { type: 'set-statusbar-state', state: 'solo' });
    const badge = page.locator('[data-testid="tdsf-statusbar-state"]');
    await expect(badge).toContainText('solo');
    await expect(badge).toContainText('⬡');
  });

  test('T-P4-12.30 dispatch review 状态', async ({ page }) => {
    await dispatchAction(page, { type: 'set-statusbar-state', state: 'review' });
    const badge = page.locator('[data-testid="tdsf-statusbar-state"]');
    await expect(badge).toContainText('review');
    await expect(badge).toContainText('!');
  });

  // ==========================================================================
  // 6. activeAgentCount 影响 StatusBar 显示
  // ==========================================================================

  test('T-P4-12.31 activeAgentCount=0 显示 "0 agents"', async ({ page }) => {
    await dispatchAction(page, { type: 'set-active-agent-count', count: 0 });
    const count = page.locator('[data-testid="tdsf-statusbar-active-count"]');
    await expect(count).toContainText('0 agents');
  });

  test('T-P4-12.32 activeAgentCount=3 显示 "3 agents"', async ({ page }) => {
    await dispatchAction(page, { type: 'set-active-agent-count', count: 3 });
    const count = page.locator('[data-testid="tdsf-statusbar-active-count"]');
    await expect(count).toContainText('3 agents');
  });

  test('T-P4-12.33 needs-you 注入后显示 "N pending"', async ({ page }) => {
    await dispatchAction(page, {
      type: 'add-needs-you',
      item: {
        type: 'approval',
        title: '审批高危操作',
        detail: '执行 rm -rf /tmp/test',
      },
    });
    const statusbar = page.locator('[data-testid="tdsf-statusbar"]');
    await expect(statusbar).toContainText('1 pending');
  });
});
