# TDSF-Linux Desktop 高质量做大方案 · 终稿

> **生成时间**：2026-07-25 Asia/Shanghai
> **核心理念**：质量绝对优先 · 不降级 · 不卡死阈值 · 保留所有技术亮点 · 引入确定性门禁
> **比赛截止**：2026-07-30（剩 5 天）
> **战略定位**：做大做精，不是做完就够

---

## 0. 战略调整说明

### 0.1 与上一版方案的关键差异

| 维度 | 上版方案（约束完善方案） | 本方案（终稿） | 调整理由 |
|------|----------------------|--------------|---------|
| CLAUDE.md 行数 | ≤ 50 行 | ≤ 150 行（保留必要内容） | 用户希望做大，规范要全 |
| 依赖数量 | 目标 ≤ 50 个 | 不卡死（保留技术亮点） | three/reactflow/Mastra 都是亮点 |
| preload 行数 | ≤ 500 行 | 拆分但允许单模块 800 行 | 为质量拆分，不为减体积 |
| 安装包体积 | ≤ 250MB | 不卡死（功能优先） | 用户明确允许做大 |
| 删除依赖 | 7 个 | 0 个（保留全部） | 保留 @ai-sdk/google 等多模型 |
| 删除功能 | 砍 EU AI Act / three / Claude SDK | 0 个（保留全部） | 学术亮点 + 技术深度都要 |
| 三绿硬门禁 | 三绿硬 + 两绿软 | 三绿硬 + 两绿软（保留） | 这是质量底线，不退让 |
| Stop Hook / Verifier / Playwright / Knip | 全部 P0 启用 | 全部 P0 启用（保留） | 治理工具与做大不冲突 |

### 0.2 三大原则

1. **质量绝对优先** — 不允许为了效率跳步或降级（用户硬约束 LRN-20260717-001）
2. **超阈值可接受** — 行数/体积/依赖数等指标卡的是"治理建议"，不是"质量红线"
3. **治理工具必装** — Stop Hook / Verifier Subagent / Playwright / Knip 是质量保障，与做大不冲突

---

## 1. 简化后的 CLAUDE.md（≤ 150 行，建议立即替换）

> 依据：Anthropic 官方建议 CLAUDE.md 不超 ~100 行，但本项目"做大"需要保留必要内容，控制在 150 行内是合理折中。
> 关键：删除自明规则、文件级描述、频繁变化信息；保留 Claude 猜不到的项目特有知识。

```markdown
# CLAUDE.md · TDSF-Linux Desktop

> 比赛截止 2026-07-30。质量优先，做大做精。

## 项目定位

**TDSF-Linux Desktop** = SSH 终端 + AI 辅助 + 高危拦截 + 日志分析 + 可信决策
帮助 Linux 初学者不怕命令行的桌面工具。

## 技术栈

- Electron 43 + React 18 + TypeScript strict + Antd 5 + Tailwind 4
- 状态：Zustand 4（计划升 5）
- SSH：ssh2 + @xterm/xterm + addon-fit/search/web-links
- AI：Vercel AI SDK 7（多模型路由）+ Anthropic Claude SDK（扩展思考）+ Mastra（Agent 编排）
- MCP：@modelcontextprotocol/sdk 1.0
- 数据库：better-sqlite3 + @photostructure/sqlite-vec（向量）
- 编辑器：monaco-editor + web-tree-sitter（语法）
- 安全：dompurify + zod

## 6 条核心红线（违反 = 不能合并）

1. **IPC 4 步同步**：main/ipc/handler → main/ipc/index.ts 注册 → preload 扁平暴露 → electron.d.ts 类型声明
2. **catch 脱敏**：error 写日志前必须 `redactSensitiveInfo()`，禁止泄漏 SSH 凭据/密钥
3. **高危命令黑名单**：SSH exec 必须经过 12 条高危命令拦截（rm -rf /、:(){:|:&};:、dd if=/dev/zero 等）
4. **Electron 安全三原则**：contextIsolation:true / nodeIntegration:false / sandbox:true（不可绕过）
5. **XSS 防护**：渲染层 `dangerouslySetInnerHTML` 必须 `DOMPurify.sanitize()`
6. **做事与打分分离**：声明"任务完成"前必须 dispatch 独立 verifier subagent，贴实际命令输出（不是总结）

## 三绿硬门禁（必须全过才能合并）

```bash
pnpm typecheck:node   # tsc --noEmit -p tsconfig.node.json
pnpm typecheck:web    # tsc --noEmit -p tsconfig.web.json
pnpm lint             # eslint src --ext .ts,.tsx（0 errors，warnings 允许）
```

## 两绿软门禁（尽量过，不过要在 PR 说明原因）

```bash
pnpm test             # vitest run（可降级为只跑改动模块）
pnpm build:win        # 缺 SDK 时允许 SKIP，但发布前必须在 windows-latest CI 跑通
```

## 开发命令

```bash
pnpm dev              # electron-vite dev
pnpm typecheck        # typecheck:node + typecheck:web
pnpm lint:fix         # 自动修复
pnpm test:watch       # 监听模式
pnpm test:e2e         # Playwright E2E
pnpm build:win        # Windows 打包
pnpm rebuild          # 重编译原生模块（better-sqlite3, ssh2）
```

## AI 协作协议

- **比赛阶段强制单 AI 模式**：避免并发冲突重演（calibration 误删教训）
- 若必须并行：
  1. 用 `git worktree add` 隔离工作区
  2. 修改前 `git status` 确认工作区干净
  3. 修改后立即 `git commit` 提交
  4. 高共享文件禁止并行修改：`preload/index.ts` / `main/ipc/index.ts` / `electron.d.ts`
- 多 AI claim/release 协议保留：`pnpm ai:claim <file>` / `pnpm ai:release <file>`

## 跨进程类型规则

- 跨进程共享类型必须放 `src/shared/`（不是 main/services/types）
- 主进程 types.ts 用 `export type { X } from '../../../shared/x-types'` 兼容
- 渲染层 `import type { X } from '@/shared/x-types'`

## 降级保留原则（关键）

- "降级"≠"完全切除"
- 任何功能废弃必须保留：代码文件 + 接口签名 + 类型声明
- 不允许"接口没了，类型没了，文件没了"
- v3.x 恢复时只需开关 flag，不需要重写

## 大文件治理（建议非强制）

- 单文件 > 800 行：PR 中说明拆分计划
- 单文件 > 1500 行：必须拆分（除非有充分理由）
- 单文件 > 3000 行：硬限制，必须拆分

## 删除前检查

删除任何文件前必须：
1. `grep -r "import.*filename"` 确认无引用
2. `git log --oneline -5 -- <file>` 查看最近修改
3. 在 PR 中说明删除理由

## 环境要求

- Node 18+ / pnpm 11+ / Python 3.11+（仅 sidecar-a）
- Windows 11 + VS Build Tools（编译原生模块）
- 缺 SDK 时 `pnpm rebuild` 重建 better-sqlite3 / ssh2

## 参考文档

- 编码规范：`CODING.md`
- 技术栈教程：`docs/技术栈教程注意事项-v1.0.md`
- 开源复用清单：`../docs/technical/开源项目复用清单.md`
- 项目救援盘点：`../docs/reports/项目救援盘点.md`
- 经验沉淀：`../.learnings/LEARNINGS.md`
```

> **行数**：约 130 行，符合 ≤ 150 行目标。

---

## 2. 简化后的 CODING.md（保留 80 行核心，仅微调）

> 依据：原 CODING.md 80 行已是合理规模，只需调整 4 处过严约束。

### 2.1 需要调整的 4 条约束

| 原约束 | 调整后 | 理由 |
|--------|-------|------|
| "TypeScript strict，禁止 any / 隐式 any" | "允许边界 any（如第三方库类型不全），禁止业务 any" | 一刀切导致 `as unknown as` 绕过 |
| "所有 CSS 颜色使用 var(--trae-*) token，禁止硬编码" | "Demo 阶段允许硬编码，v1.1 统一 token 化" | 改 UI 一次要改 5 文件，阻碍进度 |
| "质量门禁五绿全过才能合并" | "三绿硬门禁 + 两绿软门禁" | build:win 缺 SDK 持续 SKIP |
| "删比加重要" | "改比加重要，加比删重要" | "降级保留"被走样为"完全切除" |

### 2.2 需要新增的 6 条约束

```markdown
## 新增约束（v1.1）

### N1. 多 AI 协作协议
- 比赛阶段强制单 AI 模式
- 若并行：git worktree 隔离 + 高共享文件禁止并行修改

### N2. 大文件治理
- 单文件 > 1500 行：必须拆分（除非有充分理由）
- 单文件 > 3000 行：硬限制

### N3. 功能废弃规范
- "降级"必须保留代码 + 接口 + 类型
- 不允许"完全切除"

### N4. 删除前检查
- 删除任何文件前必须 grep 引用 + git log 确认

### N5. 性能基测
- 冷启动 / 内存 / IPC 延迟基线
- 每周回归测试

### N6. 打包规范
- 发布前必须 build:win 在 windows-latest CI 上跑通
```

### 2.3 需要删除的 4 条伪约束

| 约束 | 删除理由 |
|------|---------|
| A4 诚实标注未完成 | Anthropic 明确反对自明规则，应通过 verifier 强制 |
| A9 行数触发 Skill | 机械触发反而增加上下文负担，改为"提示拆分" |
| B5 UI 选型决策树 | 21 行规则表不如脚手架代码 |
| WIP 标注残留 | "WIP" 通用语已失效，必须明确"什么算完成" |

---

## 3. Stop Hook 配置（立即可用）

> 依据：Anthropic 官方 *"Unlike CLAUDE.md instructions which are advisory, hooks are deterministic."*

### 3.1 配置文件路径

`tdsf-linux-desktop/.claude/settings.json`（或 `~/.claude/settings.json` 全局）

### 3.2 配置内容

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd tdsf-linux-desktop && pnpm typecheck:node && pnpm typecheck:web && pnpm lint",
            "timeout": 300
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/hooks/pre-edit-check.cjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 3.3 PreEdit Hook 脚本（防止误删关键文件）

`tdsf-linux-desktop/scripts/hooks/pre-edit-check.cjs`：

```javascript
#!/usr/bin/env node
// PreEdit Hook: 防止误删关键文件
const fs = require('fs');
const path = require('path');

const PROTECTED_FILES = [
  'src/main/core/agent/credibility/calibration/',
  'src/main/core/agent/credibility/ds-theory.ts',
  'src/main/core/agent/credibility/pcr5.ts',
  'src/main/core/agent/credibility/fusion-engine.ts',
  'src/preload/index.ts',
  'src/preload/index.d.ts',
  'src/main/ipc/index.ts',
];

// 读取 stdin（Claude Code 传入的工具调用信息）
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data.tool_input?.file_path || '';
    
    for (const protected_ of PROTECTED_FILES) {
      if (filePath.includes(protected_)) {
        console.error(`⚠️  受保护文件：${filePath}`);
        console.error(`    修改前请确认：`);
        console.error(`    1. 是否在 PR 中说明理由`);
        console.error(`    2. 是否已 git status 确认工作区干净`);
        console.error(`    3. 是否已 grep 引用确认影响范围`);
        process.exit(2); // 阻止操作
      }
    }
    
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
```

---

## 4. Verifier Subagent 调用模板

> 依据：Anthropic 官方 L4 + 论文 [arXiv:2310.01798](https://arxiv.org/abs/2310.01798)

### 4.1 何时调用

**每次声明"任务完成"前必须 dispatch 独立 verifier subagent。**

### 4.2 调用模板

```text
Task tool:
  subagent_type: general_purpose_task
  description: "Verify <task-name>"
  query: |
    你是独立 verifier subagent，任务是验证 <task-name> 是否真正完成。
    
    ## 必须执行的检查
    
    1. 跑三绿硬门禁，贴实际输出：
       ```bash
       cd tdsf-linux-desktop
       pnpm typecheck:node 2>&1 | tail -20
       pnpm typecheck:web 2>&1 | tail -20
       pnpm lint 2>&1 | tail -20
       ```
    
    2. 跑死代码扫描：
       ```bash
       npx knip --no-exit-code 2>&1 | tail -30
       ```
    
    3. 验证功能完整性（不能只看类型，要看实际行为）：
       - 列出本次改动涉及的所有文件
       - grep 检查关键函数是否真实实现（不是占位符）
       - 检查 IPC 4 步是否完整（main handler / ipc/index 注册 / preload 暴露 / electron.d.ts 类型）
    
    4. 检查"降级保留"原则：
       - 如果有功能被降级，确认代码 + 接口 + 类型仍存在
       - 不允许"完全切除"
    
    5. 输出验证报告（不要总结，要贴实际命令输出）：
       - 三绿门禁：PASS / FAIL（附输出）
       - 死代码：X 个未使用导出
       - 功能完整性：X/Y 项通过
       - 降级保留：X 项降级，X 项保留完整
    
    ## 严格规则
    
    - 你不是 implementer，不要修改任何代码
    - 不要相信 implementer 的总结，只相信实际命令输出
    - 如果发现任何问题，明确指出，不要软化措辞
    - 报告必须包含实际命令输出，不能是"已通过"这种总结
```

### 4.3 反模式（禁止）

```text
❌ 错误：implementer 自己说"已通过 typecheck"
✅ 正确：verifier subagent 实际跑 pnpm typecheck:node 并贴输出

❌ 错误：implementer 说"功能已实现"
✅ 正确：verifier subagent grep 关键函数 + Read 实现代码

❌ 错误：implementer 说"已降级保留"
✅ 正确：verifier subagent 检查代码文件 + 接口签名 + 类型声明都还在
```

---

## 5. Playwright E2E 启用方案

> 依据：@playwright/test 1.61.1 已在 devDependencies（[package.json L93](file:///d:/ai/linux教学一体/tdsf-linux-desktop/package.json#L93)），但从未启用。

### 5.1 配置文件

`tdsf-linux-desktop/playwright.config.ts`：

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,  // Electron 必须串行
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Electron 单实例
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: { ...devices['Desktop Electron'] },
    },
  ],
});
```

### 5.2 第一个 E2E 测试（Demo 9 步主路径）

`tdsf-linux-desktop/tests/e2e/demo-9-steps.spec.ts`：

```typescript
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test.describe('Demo 9 步主路径', () => {
  test('Step 1-2: 启动 + 工作台加载', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../out/main/index.js')],
    });
    const window = await app.firstWindow();
    
    // 等待工作台加载
    await window.waitForSelector('[data-testid="workbench"]', { timeout: 30000 });
    
    // 截图作为基线
    await window.screenshot({ path: 'tests/e2e/screenshots/01-workbench.png' });
    
    await app.close();
  });
  
  test('Step 3: SSH 连接', async () => {
    // TODO: 实现 SSH 连接测试
  });
  
  // ... Step 4-9
});
```

### 5.3 视觉对比（设计稿 vs 实际）

`tdsf-linux-desktop/tests/e2e/visual.spec.ts`：

```typescript
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test.describe('视觉对比', () => {
  test('工作台对比设计稿', async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '../../out/main/index.js')],
    });
    const window = await app.firstWindow();
    
    await window.waitForSelector('[data-testid="workbench"]');
    await window.screenshot({ path: 'tests/e2e/screenshots/workbench-actual.png' });
    
    // 对比设计稿
    await expect(window).toHaveScreenshot('../design/workbench-design.png', {
      maxDiffPixelRatio: 0.1,  // 允许 10% 像素差异
    });
    
    await app.close();
  });
});
```

### 5.4 package.json 脚本追加

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:visual": "playwright test --grep visual"
  }
}
```

---

## 6. Knip 死代码扫描配置

> 依据：ts-prune/depcheck 已归档，Knip 是 2026 年活跃维护的唯一选择。

### 6.1 安装

```bash
cd tdsf-linux-desktop
pnpm add -D knip
```

### 6.2 配置文件

`tdsf-linux-desktop/knip.json`：

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": [
    "src/main/index.ts",
    "src/preload/index.ts",
    "src/renderer/src/main.tsx",
    "src/renderer/src/App.tsx"
  ],
  "project": ["src/**/*.{ts,tsx}"],
  "ignore": [
    "src/**/*.d.ts",
    "src/**/*.test.ts",
    "src/**/*.spec.ts",
    "tests/**"
  ],
  "ignoreBinaries": ["electron-rebuild"]
}
```

### 6.3 package.json 脚本追加

```json
{
  "scripts": {
    "deadcode": "knip --no-exit-code",
    "deadcode:strict": "knip"
  }
}
```

### 6.4 使用方式

```bash
# 查看（不报错）
pnpm deadcode

# 严格模式（有死代码则报错，用于 CI）
pnpm deadcode:strict
```

---

## 7. 完整依赖安装清单

### 7.1 立即安装（P0，今天）

```bash
cd tdsf-linux-desktop

# 死代码检测
pnpm add -D knip

# Electron 日志规范
pnpm add electron-log

# @playwright/test 已装 1.61.1，无需重装
```

### 7.2 Demo 后安装（P1，2026-07-31 之后）

```bash
# 类型安全 IPC（替代手写通道字符串）
pnpm add electron-trpc @trpc/server @trpc/client

# TypeScript 优先 ORM
pnpm add drizzle-orm

# 视觉对比像素级 diff
pnpm add -D pixelmatch pngjs
```

### 7.3 不删除任何依赖（保留全部技术亮点）

| 依赖 | 保留理由 |
|------|---------|
| `@anthropic-ai/claude-agent-sdk` | 扩展思考分析高危命令，技术亮点 |
| `@ai-sdk/google` | 多模型路由，展示 BYOK 能力 |
| `@xenova/transformers` | 浏览器端 ML，技术深度 |
| `three` + `@types/three` | 3D 可视化（Credibility DAG） |
| `reactflow` | 流程图（Task Protocol 14 步可视化） |
| `@mastra/core` | Agent 编排框架，与 Vercel AI SDK 互补 |
| `turndown` + `cheerio` | HTML 处理双方案，按场景选择 |
| `tree-sitter-bash` + `web-tree-sitter` | 终端语法高亮，技术深度 |

---

## 8. GitHub Actions CI 配置（解决 build:win 持续 SKIP）

> 依据：Anthropic 官方 L3 确定性门禁 + build:win 持续 SKIP 4 个月问题。

### 8.1 配置文件

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  typecheck-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck:node
      - run: pnpm typecheck:web
      - run: pnpm lint
      - run: pnpm test
  
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm rebuild
      - run: pnpm build:win
      - uses: actions/upload-artifact@v4
        with:
          name: tdsf-windows-build
          path: dist_electron/*.exe
          retention-days: 30
  
  deadcode-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm deadcode
```

### 8.2 效果

- 三绿硬门禁在 CI 强制执行（不再依赖本地）
- build:win 在 windows-latest 上必跑（不再 SKIP）
- 死代码扫描每次 PR 自动跑
- Windows 安装包作为 artifact 上传，可直接下载

---

## 9. 5 天作战计划（做大版本）

### Day 1（2026-07-25）：基础设施 + 治理工具

| 时段 | 任务 | 验收 |
|------|------|------|
| 上午 | 用本方案 §1 的 CLAUDE.md 替换 [tdsf-linux-desktop/CLAUDE.md](file:///d:/ai/linux教学一体/tdsf-linux-desktop/CLAUDE.md) | 行数 ≤ 150 |
| 上午 | 用本方案 §2 调整 CODING.md（4 条调整 + 6 条新增 + 4 条删除） | 改动可追溯 |
| 上午 | 安装 knip + electron-log | `pnpm add -D knip && pnpm add electron-log` |
| 下午 | 配置 Stop Hook（§3.2）+ PreEdit Hook 脚本（§3.3） | 实测拦截受保护文件 |
| 下午 | 配置 Knip（§6）+ 跑第一次 `pnpm deadcode` | 死代码清单 |
| 下午 | 配置 Playwright（§5.1-5.2）+ 写第一个 E2E 测试 | `pnpm test:e2e` 跑通 |
| 晚上 | 配置 GitHub Actions CI（§8） | push 后 CI 自动跑 |
| 晚上 | 跑三绿门禁确认基线 | typecheck + lint 全过 |
| 晚上 | dispatch 第一次 verifier subagent | 验证报告产出 |

### Day 2（2026-07-26）：Demo 9 步主路径验收

| 时段 | 任务 | 验收 |
|------|------|------|
| 上午 | 走通 Demo 9 步主路径 | 9 步全部 PASS |
| 上午 | 写 Demo 9 步 E2E 测试（§5.2 完整版） | `pnpm test:e2e` 全过 |
| 下午 | 修复 P0 阻塞问题（不拆超长文件，先保 Demo） | 9 步无阻塞 |
| 下午 | 视觉对比设计稿（§5.3） | 截图差异 < 10% |
| 晚上 | dispatch verifier subagent 验证 | 报告产出 |

### Day 3（2026-07-27）：打包 + 演示材料

| 时段 | 任务 | 验收 |
|------|------|------|
| 上午 | 在 windows-latest CI 上跑 build:win | 生成 .exe artifact |
| 上午 | 本地双击安装测试 | 另一台电脑能装能用 |
| 下午 | 制作 PPT 演示脚本（6 段每段 50 秒，共 5 分钟） | 脚本完整 |
| 下午 | 录屏（5:00 = 300s） | 时长精确 |
| 晚上 | dispatch verifier subagent 验证打包 | 报告产出 |

### Day 4（2026-07-28）：Bug 修复 + 质量加固

| 时段 | 任务 | 验收 |
|------|------|------|
| 上午 | 修复 P1 严重问题（IPC 字面量、类型不符、修改命令未传） | 三绿门禁仍过 |
| 上午 | 修复死占位 UI（EditorArea / StatusBar / LogsPage） | 实际行为验证 |
| 下午 | 跑 `pnpm deadcode` 清理死代码 | 死代码 < 10 个 |
| 下午 | 跑 `pnpm test:e2e` 回归 | 全过 |
| 晚上 | dispatch verifier subagent 验证 | 报告产出 |

### Day 5（2026-07-29）：冻结 + 演示彩排

| 时段 | 任务 | 验收 |
|------|------|------|
| 上午 | 全量回归测试（typecheck + lint + test + e2e + build:win） | 五绿全过 |
| 上午 | 最终打包 | .exe 生成 |
| 下午 | 演示彩排（按 PPT 脚本走一遍） | 流畅无卡顿 |
| 下午 | 冻结代码（不再合并新 PR） | git tag v1.0 |
| 晚上 | dispatch 最终 verifier subagent | 完整验证报告 |

### Day 6（2026-07-30）：比赛日

| 时段 | 任务 |
|------|------|
| 上午 | 仅修紧急 Bug |
| 下午 | 演示 |

---

## 10. 必须保留的硬约束清单（6 条）

| # | 约束 | 保留理由 | 官方依据 |
|---|------|---------|---------|
| 1 | IPC 4 步同步 | Electron 跨进程类型安全核心 | Electron 官方安全 |
| 2 | catch 脱敏 | SSH 凭据防泄漏 | 安全底线 |
| 3 | 高危命令黑名单 | 产品核心功能 | 业务需求 |
| 4 | Electron 安全三原则 | 官方红线 | Electron 官方安全 |
| 5 | DOMPurify XSS 防护 | 渲染层安全底线 | Electron 官方安全 |
| 6 | 独立 verifier subagent | 对抗 LLM 自我审查失效 | Anthropic L4 + arXiv:2310.01798 |

---

## 11. 必须删除的伪约束清单（4 条）

| # | 约束 | 删除理由 | 官方依据 |
|---|------|---------|---------|
| 1 | A4 诚实标注未完成 | Anthropic 明确反对自明规则 | Anthropic ❌ 对照表 |
| 2 | A9 行数触发 Skill | 机械触发增加上下文负担 | Anthropic Skill 原则 |
| 3 | B5 UI 选型决策树 | 应转为脚手架代码 | Anthropic ❌ 对照表 |
| 4 | WIP 标注残留 | "WIP" 通用语已失效 | 业界共识 |

---

## 12. 必须新增的约束清单（6 条）

| # | 约束 | 新增理由 | 官方依据 |
|---|------|---------|---------|
| 1 | 多 AI 协作协议 | 防止 calibration 误删重演 | Anthropic Worktrees |
| 2 | 大文件治理（> 1500 行必须拆分） | 防止 preload 3283 行重演 | Electron 性能 |
| 3 | 功能废弃规范（降级保留代码+接口+类型） | 防止 calibration 误删 | 项目教训 |
| 4 | 删除前检查（grep + git log） | 防止误删 | 项目教训 |
| 5 | 性能基测 | 防止性能退化无感知 | Electron 性能 |
| 6 | 打包规范（CI 必跑 build:win） | 防止 build:win 持续 SKIP | Anthropic L3 |

---

## 13. Skill 使用清单（立即启用 7 个）

| Skill | 触发场景 | 调用方式 |
|-------|---------|---------|
| `systematic-debugging` | 遇到 bug 时 | 在 prompt 中说"用 systematic-debugging skill 分析" |
| `test-driven-development` | 写新功能前 | 在 prompt 中说"用 TDD skill 实现" |
| `verification-before-completion` | 声明任务完成前 | 在 prompt 中说"用 verification-before-completion skill 验证" |
| `code-review-excellence` | 每次 commit 前 | 在 prompt 中说"用 code-review-excellence skill 审查" |
| `dogfood` | UI 验收时 | 在 prompt 中说"用 dogfood skill 系统化探索" |
| `webapp-testing` | Playwright UI 自动化 | 在 prompt 中说"用 webapp-testing skill 写 E2E" |
| `subagent-driven-development` | 大型 spec 执行 | 在 prompt 中说"用 subagent-driven-development skill 执行" |

---

## 14. P0 行动清单（今天 2026-07-25 必须完成）

### 14.1 文档替换

- [ ] 用 §1 的 CLAUDE.md 模板替换 [tdsf-linux-desktop/CLAUDE.md](file:///d:/ai/linux教学一体/tdsf-linux-desktop/CLAUDE.md)
- [ ] 用 §2 的调整方案修改 [tdsf-linux-desktop/CODING.md](file:///d:/ai/linux教学一体/tdsf-linux-desktop/CODING.md)
- [ ] 删除 [tdsf-linux-desktop/AGENTS.md](file:///d:/ai/linux-linux一体/tdsf-linux-desktop/AGENTS.md) 中的 22 条硬约束（保留 §1 已涵盖的）

### 14.2 工具安装

- [ ] `cd tdsf-linux-desktop && pnpm add -D knip`
- [ ] `pnpm add electron-log`
- [ ] 确认 @playwright/test 已装（1.61.1）

### 14.3 配置文件

- [ ] 创建 [tdsf-linux-desktop/.claude/settings.json](file:///d:/ai/linux教学一体/tdsf-linux-desktop/.claude/settings.json)（§3.2）
- [ ] 创建 [tdsf-linux-desktop/scripts/hooks/pre-edit-check.cjs](file:///d:/ai/linux教学一体/tdsf-linux-desktop/scripts/hooks/pre-edit-check.cjs)（§3.3）
- [ ] 创建 [tdsf-linux-desktop/knip.json](file:///d:/ai/linux教学一体/tdsf-linux-desktop/knip.json)（§6.2）
- [ ] 创建 [tdsf-linux-desktop/playwright.config.ts](file:///d:/ai/linux教学一体/tdsf-linux-desktop/playwright.config.ts)（§5.1）
- [ ] 创建 [tdsf-linux-desktop/tests/e2e/demo-9-steps.spec.ts](file:///d:/ai/linux教学一体/tdsf-linux-desktop/tests/e2e/demo-9-steps.spec.ts)（§5.2）
- [ ] 创建 [.github/workflows/ci.yml](file:///d:/ai/linux教学一体/.github/workflows/ci.yml)（§8.1）

### 14.4 package.json 脚本追加

- [ ] 追加 `deadcode` / `deadcode:strict` 脚本（§6.3）
- [ ] 追加 `test:e2e:ui` / `test:e2e:visual` 脚本（§5.4）

### 14.5 基线验证

- [ ] 跑 `pnpm typecheck:node && pnpm typecheck:web && pnpm lint` 确认三绿基线
- [ ] 跑 `pnpm deadcode` 生成死代码基线清单
- [ ] 跑 `pnpm test:e2e` 确认 Playwright 配置正确
- [ ] dispatch 第一次 verifier subagent，验证基线

---

## 15. 核心理念总结

### 15.1 三句话

1. **做大不等于做散** — 保留所有技术亮点（three / Mastra / Claude SDK / reactflow），但要引入治理工具（Knip / Playwright / Verifier）
2. **质量不等于卡死** — 6 条硬红线不退让，但行数/体积/依赖数等指标卡的是"治理建议"
3. **治理工具与做大不冲突** — Stop Hook + Verifier Subagent + Playwright + Knip + CI 是质量保障，让做大可持续

### 15.2 与上一版方案的差异

| 维度 | 上版方案 | 本方案 |
|------|---------|--------|
| 战略 | 救援 + 简化 | 做大 + 治理 |
| 删依赖 | 7 个 | 0 个 |
| 删功能 | 砍 EU AI Act / three / Claude SDK | 0 个 |
| CLAUDE.md | ≤ 50 行 | ≤ 150 行 |
| 体积目标 | ≤ 250MB | 不卡死 |
| 治理工具 | 全装 | 全装（一致） |

### 15.3 给用户的承诺

- 不删任何技术亮点
- 不降级任何功能
- 不卡死任何阈值
- 但必装治理工具（Stop Hook / Verifier / Playwright / Knip / CI）
- 6 条硬红线不退让
- 4 条伪约束必删除
- 6 条新约束必新增

---

*方案完成于 2026-07-25 Asia/Shanghai*
*核心理念：做大做精，治理保障，质量绝对优先。*
