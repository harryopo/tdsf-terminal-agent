/**
 * e2e/knowledge-skill.spec.ts — P3 E2E 测试（知识卡 + Skill 集成）
 * -----------------------------------------------------------------------------
 * 测试场景：
 *   1. AgentPanel 默认渲染时知识卡区域不显示（空状态）
 *   2. 通过 window.__tdsfTestHook 注入知识卡 → 渲染卡片 + 标题 + 来源 + 评分
 *   3. 知识卡展开按钮 → 显示 URL 链接
 *   4. 注入多张知识卡 → 按 FTS5 / Vector 类型显示标签
 *   5. 清空知识卡 → 卡片区域消失
 *   6. 知识卡点击 URL → 阻止默认跳转（target=_blank）
 *
 * 技术方案：
 * - 浏览器预览模式 (pnpm dev) 下 sidecar-bridge.subscribe 返回 no-op
 * - 通过 RuntimeProvider 暴露的 window.__tdsfTestHook.dispatch 注入状态
 * - 仅 dev 模式生效（import.meta.env.DEV），生产构建无此 hook
 */
import { test, expect } from '@playwright/test';

/** 知识卡 mock 数据（与 KnowledgeCardItem 接口对齐） */
const MOCK_CARDS = [
  {
    title: 'nginx 启动失败排查',
    source: 'nginx-docs',
    snippet: 'nginx 启动失败的常见原因：端口被占用、配置文件语法错误、权限不足。',
    url: 'https://nginx.org/docs/',
    score: 0.95,
    matchType: 'fts5' as const,
  },
  {
    title: 'Docker 容器中运行 nginx',
    source: 'docker-docs',
    snippet: '使用 docker run -p 80:80 nginx 部署 nginx 容器。',
    url: 'https://docs.docker.com/',
    score: 0.78,
    matchType: 'vector' as const,
  },
];

/** 单张知识卡 mock（用于展开测试） */
const SINGLE_CARD = MOCK_CARDS[0];

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
  action: unknown
): Promise<void> {
  await page.evaluate((a) => {
    const w = window as unknown as { __tdsfTestHook?: TdsfTestHook };
    if (!w.__tdsfTestHook) {
      throw new Error('__tdsfTestHook not exposed');
    }
    w.__tdsfTestHook.dispatch(a);
  }, action);
}

test.describe('AgentPanel — P3 知识卡注入', () => {
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

  test('T-P3-10.1 默认空状态：知识卡区域不显示', async ({ page }) => {
    // 空状态下不应有知识卡区域
    await expect(
      page.locator('[data-testid="tdsf-knowledge-cards-section"]')
    ).toHaveCount(0);
    // 空状态下不应有知识卡
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(0);
  });

  test('T-P3-10.2 注入知识卡：渲染卡片 + 标题 + 来源 + 评分', async ({ page }) => {
    // 通过测试 hook 注入 2 张知识卡
    await dispatchAction(page, { type: 'set-knowledge-cards', cards: MOCK_CARDS });

    // 知识卡区域出现
    await expect(
      page.locator('[data-testid="tdsf-knowledge-cards-section"]')
    ).toBeVisible({ timeout: 3_000 });

    // 应有 2 张知识卡
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(2);

    // 第一张卡：nginx 启动失败排查
    const card1 = page.locator('[data-testid="tdsf-knowledge-card"]').first();
    await expect(card1).toContainText('nginx 启动失败排查');
    await expect(card1).toContainText('nginx-docs');
    await expect(card1).toContainText('95%');

    // 第二张卡：Docker 容器中运行 nginx
    const card2 = page.locator('[data-testid="tdsf-knowledge-card"]').nth(1);
    await expect(card2).toContainText('Docker 容器中运行 nginx');
    await expect(card2).toContainText('docker-docs');
    await expect(card2).toContainText('78%');
  });

  test('T-P3-10.3 知识卡展开：显示 URL 链接', async ({ page }) => {
    // 注入单张知识卡
    await dispatchAction(page, { type: 'set-knowledge-cards', cards: [SINGLE_CARD] });

    // 等待卡片渲染
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(1);

    // 折叠状态下不应显示 URL
    await expect(
      page.locator('[data-testid="tdsf-knowledge-card-url"]')
    ).toHaveCount(0);

    // 点击展开按钮（▶）
    const expandBtn = page
      .locator('[data-testid="tdsf-knowledge-card"]')
      .locator('button[title="展开"]');
    await expandBtn.click();

    // 展开后应显示 URL 链接
    await expect(
      page.locator('[data-testid="tdsf-knowledge-card-url"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="tdsf-knowledge-card-url"]')
    ).toContainText('nginx.org');

    // 再次点击 → 折叠，URL 消失
    const collapseBtn = page
      .locator('[data-testid="tdsf-knowledge-card"]')
      .locator('button[title="折叠"]');
    await collapseBtn.click();
    await expect(
      page.locator('[data-testid="tdsf-knowledge-card-url"]')
    ).toHaveCount(0);
  });

  test('T-P3-10.4 知识卡匹配类型标签：FTS5 关键词 / Vector 语义', async ({ page }) => {
    // 注入 2 张卡（1 张 fts5，1 张 vector）
    await dispatchAction(page, { type: 'set-knowledge-cards', cards: MOCK_CARDS });

    // 等待渲染
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(2);

    // 第一张卡：matchType=fts5 → 显示"关键词"
    const card1 = page.locator('[data-testid="tdsf-knowledge-card"]').first();
    await expect(card1).toContainText('关键词');

    // 第二张卡：matchType=vector → 显示"语义"
    const card2 = page.locator('[data-testid="tdsf-knowledge-card"]').nth(1);
    await expect(card2).toContainText('语义');
  });

  test('T-P3-10.5 清空知识卡：卡片区域消失', async ({ page }) => {
    // 先注入 2 张卡
    await dispatchAction(page, { type: 'set-knowledge-cards', cards: MOCK_CARDS });
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(2);

    // 清空知识卡
    await dispatchAction(page, { type: 'clear-knowledge-cards' });

    // 卡片区域应消失
    await expect(
      page.locator('[data-testid="tdsf-knowledge-cards-section"]')
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(0);
  });

  test('T-P3-10.6 清空对话按钮同步清空知识卡', async ({ page }) => {
    // 注入知识卡
    await dispatchAction(page, { type: 'set-knowledge-cards', cards: MOCK_CARDS });
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(2);

    // 点击"清空对话"按钮（用 dispatchEvent 直接触发 DOM click，避免 xterm canvas 拦截）
    await page.locator('[title="清空对话"]').dispatchEvent('click');

    // 知识卡应同步清空（clear-agent-state reducer 同步清空 knowledgeCards）
    await expect(
      page.locator('[data-testid="tdsf-knowledge-cards-section"]')
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="tdsf-knowledge-card"]')).toHaveCount(0);
  });
});
