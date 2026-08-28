---
name: "design-to-delivery"
description: "Design-to-Delivery Dead Code Governance. 当设计稿交付后落地开发、识别并砍掉占位死代码、补齐可兑现功能、循环工程子agent验证时调用。触发词：设计稿交付后治理/死代码治理/功能兑现/设计稿落地/按钮真实化/砍掉死代码/补齐功能。"
---

# Design-to-Delivery：设计稿交付到开发落地通用指南

> **来源**：知行读书 2026-07-21 死代码治理循环工程经验沉淀
> **适用**：任何"设计稿先行 + AI 辅助开发"的项目（Electron/React/Vue 等）
> **完整教程**：`docs/design-to-delivery-guide.md`

## 何时调用本 Skill

**必须调用场景**：
- 用户说"设计稿交付后治理" / "死代码治理" / "功能兑现" / "设计稿落地"
- 用户说"按钮真实化" / "砍掉死代码" / "补齐功能" / "循环工程"
- 用户反馈"按钮点了没用" / "占位死代码" / "toast 即将上线太多"
- AI 设计工具（TRAE Design / Figma AI / v0）交付设计稿后开发
- 设计稿含臆想功能，需要识别可兑现 vs 不可兑现

**不要调用场景**：
- 纯静态网站（无后端能力）
- 已有完整后端的设计稿落地（无臆想功能）
- 单页面小改动（不需要循环工程）
- 原型验证阶段（允许占位死代码）

## 核心方法论：Gap 三角 + 六阶段循环

### Gap 三角

设计稿（目标态）与开发现状（当前态）存在三类 gap：

| Gap 类型 | 表现 | 处理策略 |
|---------|------|---------|
| **视觉 gap** | 颜色/字体/间距/布局不一致 | 第一阶段 1:1 还原 |
| **可兑现功能 gap** | 设计稿有按钮，后端有 skill/API 但前端没接 | 第四阶段全链路补齐 |
| **不可兑现臆想** | 设计稿有按钮，但无任何后端能力支撑 | 第三阶段直接砍掉 |

### 死代码治理决策树（核心！）

```
死代码识别
├── 有 skill / API 能力支撑吗？
│   ├── 是 → 分类：可兑现 → 第四阶段补齐
│   │       验证：查 skill 文档 / API swagger / 后端 handler
│   └── 否 → 分类：不可兑现 → 第三阶段砍掉
│           验证：确认无任何后端能力（不是"暂时没做"）
└── 是真实功能但 UX 差？
    └── 分类：UX 待优化 → 保留，记录到优化清单
```

**原则**：能砍则砍 / 能补则补 / 按钮要真。**不要留 disabled + tooltip 占位**。

## 六阶段循环工程

### 第一阶段：还原设计稿（视觉 1:1）

1. 建立 design token（colors / typography / spacing / radius / shadow 写入 CSS 变量）
2. 逐页面还原 HTML 结构 → JSX/TSX
3. 占位交互用 `data-dom-id="cta-xxx"` 标记，**不要写 toast.info 占位**
4. 验收：截图像素 diff < 2%

**反模式**：还原阶段同时写功能实现 / 用 Lorem Ipsum / 留 console.log 占位

### 第二阶段：死代码识别

#### 静态扫描命令

```bash
# 搜索占位 toast
grep -rn "toast.info.*即将\|toast.info.*上线\|toast.info.*敬请期待" src/

# 搜索 TODO / FIXME / 空 onClick / disabled 占位
grep -rn "TODO\|FIXME" src/ --include="*.tsx"
grep -rn "onClick={() => {}}" src/ --include="*.tsx"
grep -rn "disabled.*title=" src/ --include="*.tsx"

# 搜索 navigate 到不存在路由
grep -rn "navigate(" src/ --include="*.tsx" | grep -v "import"
```

#### 动态走查

启动应用逐页面点击每个按钮，记录：无反应 / toast 占位 / 跳 404 / console 报错。

#### 输出表格

| 设计稿元素 | 文件位置 | onClick 实现 | 状态 |
|-----------|---------|-------------|------|
| ... | ... | ... | 死代码 / 需修复 / 可补齐 |

### 第三阶段：功能裁剪

1. 砍掉前 grep 确认无依赖
2. 砍掉 JSX + handler + prop + state + import（全部清理）
3. 记录到归档文档（位置/原因/替代方案）
4. **不要留 disabled + tooltip="功能开发中"**

### 第四阶段：功能补齐（全链路）

**全链路 checklist（Electron + React 为例）**：

```
UI 按钮点击
    ↓
preload.ts 暴露 API
    ↓
shared/ipc-channels.ts 定义通道
    ↓
electron/ipc.ts 注册 handler
    ↓
后端 service 实现
    ↓
返回数据 → UI 更新
```

**任何一个环节缺失都会变成死代码**。

#### 降级策略（关键！）

第三方 API 调用必须走"gateway 优先 + 衍生降级"模式：

```typescript
export async function fetchRecommendations(): Promise<RecommendationItem[]> {
  try {
    const data = await gatewayRequest('/book/recommend')
    if (data.books?.length > 0) return data.books.map(...)
    return await generateDerivedRecommendations() // 降级
  } catch (error) {
    logger.warn('Gateway failed, falling back', { error })
    return await generateDerivedRecommendations() // 降级
  }
}
```

#### 安全 checklist

- [ ] CSV 导出：防御公式注入（`= + - @` 前置单引号）+ UTF-8 BOM
- [ ] 批量 DELETE：用事务包裹（`runTransaction(fn)`）
- [ ] 危险操作：多次确认（清理历史 2 次，重置数据库 3 次）
- [ ] Modal：`role="dialog"` + `aria-modal="true"` + ESC 关闭 + 焦点管理
- [ ] URL 拼接：`encodeURIComponent` 编码用户输入
- [ ] 外部链接：`window.open(url, '_blank', 'noopener,noreferrer')`

### 第五阶段：循环工程验证

#### spec 三件套（启动前必写）

| 文档 | 路径 | 内容 |
|------|------|------|
| **spec.md** | `.trae/specs/<project>/spec.md` | 背景、子 agent 角色、循环协议、提交规范、验收标准、硬约束 |
| **tasks.md** | `.trae/specs/<project>/tasks.md` | 每个任务的详细描述、输入、输出、验收 |
| **checklist.md** | `.trae/specs/<project>/checklist.md` | 每个任务的勾选项 + 总体硬约束 |

#### 子 agent 角色

| 角色 | 职责 |
|------|------|
| **implementer-subagent** | 实施代码 + 自审 + 提交 |
| **spec-reviewer-subagent** | 验证符合 spec、无 over-engineer |
| **code-quality-reviewer-subagent** | 7 维审查（安全/性能/正确性/可维护性/测试/可访问性/文档）|
| **verifier-subagent** | 跑编译门禁 + 手动走查 + 全量 review |
| **fix-implementer-subagent** | 根据 reviewer 反馈修复 P0/P1 |

#### 单任务循环协议

```
1. 主 agent 派 implementer（附完整 task 描述）
2. implementer 实施 + 自审 + 提交
3. 主 agent 派 spec-reviewer
   - ✅ 通过 → 步骤 4
   - ❌ 不通过 → 派 fix-implementer → 回到步骤 3
4. 主 agent 派 code-quality-reviewer
   - ✅ 通过 → 任务完成
   - ❌ 不通过 → 派 fix-implementer → 回到步骤 4
5. TodoWrite 标记完成 → 下一任务
```

#### 编译门禁三绿

```bash
npm run lint        # 0 errors（warnings 可接受）
npm run typecheck   # exit 0
npm run build       # exit 0
```

#### 7 维质量评分

| 维度 | 重点检查 |
|------|---------|
| 安全 | CSV 注入 / 事务包裹 / 多次确认 / Modal aria |
| 性能 | runTransaction / useMemo / Map 去重 / Promise.all |
| 正确性 | 幂等迁移 / `?.` 短路 / 按钮 onClick 真实跳转 |
| 可维护性 | IPC 集中定义 / wrapper 转发 / 类型复用 |
| 测试 | 无测试框架时手动走查覆盖核心场景 |
| 可访问性 | Modal role/aria/ESC/焦点管理 |
| 文档 | spec/tasks/checklist/verify-report 四件套 |

**评分基准**：8.5/10 以上可归档，低于 8.0 必须修复 P1 后重审。

### 第六阶段：沉淀归档

#### 归档五件套

| 文档 | 路径 | 内容 |
|------|------|------|
| **LEARNINGS.md** | `.learnings/LEARNINGS.md` | 追加 LRN-YYYYMMDD-NNN 条目 |
| **PROGRESS.md** | `.learnings/PROGRESS.md` | 更新进度表 + 验证门禁状态 |
| **AGENTS.md** | `AGENTS.md` | 新增章节（经验 + IPC 通道清单 + 评分基准）|
| **CLAUDE.md** | `CLAUDE.md` | 新增硬约束（A 红线 + B 白名单）|
| **memory** | `~/.trae-cn/memory/projects/<proj>/project_memory.md` | 追加本次循环总结 |

#### commit message 规范

```
<type>(<scope>): <subject>

[详细描述]

Refs: <spec 任务 ID>
```

| 字段 | 取值 |
|------|------|
| `type` | `feat` / `fix` / `refactor` / `docs` / `test` / `chore` |
| `scope` | 模块名 / `dead-code-governance` 等 |
| `subject` | 50 字内，祈使语气，无句号 |

**不要 squash** —— 每个 commit 单独可读、code review 友好、保留 bisect 能力。

## 通用提示词模板

### 提示词 1：启动死代码治理（用户给主 agent）

```
设计稿很好，项目也可以用起来，但是目前还是有点按钮的交互功能
没有开发或者说开发无用，比如说 [举例：点击阅读按钮]，
[skill 名] 并没有提供相关的功能，我点击了 [按钮]，但是并没有用。

以此为例把某些功能给砍掉，同时充分发掘 [skill 名] 的功能，
以及相关能落地的衍生功能，确保一个按钮能够点击能够有真的功能，
而不是占位死代码。

请按循环工程子 agent 开发模式实施：
1. 写 spec 三件套（spec.md / tasks.md / checklist.md）
2. 派 implementer → spec-reviewer → code-quality-reviewer → fix-implementer
3. 最终 verifier subagent 全量 review
4. 归档到 LEARNINGS / PROGRESS / AGENTS / CLAUDE / memory
```

### 提示词 2：识别阶段（给 implementer）

```
请识别 [页面/模块] 中所有按钮和交互元素，分类为：
- 可立即实现（已有 skill/API 能力）
- 需要后端支撑（有 skill 文档但前端没接）
- 纯臆想（无任何后端能力）

输出表格：位置 | 按钮 | 类型 | 处理策略 | 依据
不要凭印象判断，必须查 skill 文档 / API 实际能力。
```

### 提示词 3：砍掉死代码（给 implementer）

```
对以下死代码直接砍掉（不要留 disabled + tooltip 占位）：
[list]

砍掉前必须：
1. grep 确认无其他模块依赖
2. 砍掉按钮 JSX + handler + prop + state + import
3. 记录到归档文档（位置/原因/替代方案）

不要留 toast.info("即将上线") 类占位。
```

### 提示词 4：补齐功能（给 implementer）

```
对以下可补齐功能全链路实现：
[list]

全链路 checklist：
- [ ] IPC 通道定义
- [ ] handler 注册
- [ ] preload 暴露
- [ ] 类型声明
- [ ] UI 接入
- [ ] 降级策略（gateway 失败时的衍生方案）
- [ ] 安全 checklist（CSV 注入 / 事务 / 确认 / aria）

任何一个环节缺失都会变成死代码。
```

### 提示词 5：verifier 全量 review（给 verifier subagent）

```
你是 [项目名] 循环工程的 verifier subagent，负责对 Task 1-N 的全部改动
做最终全量 code review。

## 任务
1. 阅读 spec 三件套
2. 验证每个 Task 的落地情况（逐项勾选）
3. 全量 git diff 检查（无 over-engineer / 无 dead code 残留）
4. 编译门禁验证（lint / typecheck / build）
5. 输出 verify-report.md

## 7 维评分
安全 / 性能 / 正确性 / 可维护性 / 测试 / 可访问性 / 文档

## 约束
- 只读 review，不修改代码
- 严格基于 spec 和代码事实
- P0 阻塞项必须修复，P1 建议修复，P2 可选
```

## 反模式清单（不要做）

- ❌ 不要全盘照搬设计稿（臆想功能会变死代码）
- ❌ 不要全盘砍掉臆想（有些臆想是好的创新）
- ❌ 不要留 disabled + tooltip 占位（用户会等，但永远不会来）
- ❌ 不要留 toast.info "即将上线"（同上，且污染日志）
- ❌ 不要凭印象判断死代码（必须查 skill 文档 / API 实际能力）
- ❌ 不要单 agent 做全循环（上下文污染，必须用子 agent）
- ❌ 不要省 spec（spec 不写完，reviewer 不知道 check 什么）
- ❌ 不要省双审（spec-reviewer + code-quality-reviewer 缺一不可）
- ❌ 不要省归档（经验不沉淀，下次循环无沉淀）
- ❌ 不要提交 installer 产物（installer/ / installer-v2/ / out/ / release/ 都要 gitignore）

## 常见陷阱

1. **PowerShell heredoc 不支持**：`git commit -m "$(cat <<'EOF'...)"` 会报错，改用 `git commit -F file.txt`
2. **PowerShell `&&` 不是语句分隔符**：用 `;` 代替
3. **Windows 端口保留范围**：Hyper-V/WSL 会保留 5175-5274，导致 EACCES
4. **sql.js 是 WASM**：数据库在内存，持久化要显式 `saveDatabase()`
5. **Electron preload 路径**：构建后路径变化，`getPreloadPath()` 要兼容多路径

## 案例参考：知行读书 2026-07-21

### 治理结果

| 维度 | 数据 |
|------|------|
| 死代码识别 | 19 处 |
| 处理策略 | 7 砍 + 8 补 + 4 留 |
| 循环任务 | 6 个（Task 1-6）|
| commit 数 | 4 个 |
| 编译门禁 | lint 0e/189w / typecheck 0 / build OK |
| verifier 评分 | 8.5/10 |

### 5 条核心经验（沉淀为 LRN-20260721-006~010）

1. **SQLite 加列双轨幂等模式**：`CREATE TABLE IF NOT EXISTS + migrateXxxTable()` + DEFAULT 兜底旧数据
2. **CSV 导出公式注入防御**：`= + - @` 前置单引号 + UTF-8 BOM
3. **批量 DELETE 事务包裹**：`runTransaction(fn)` 保证原子性
4. **gateway 优先 + 衍生降级**：第三方 API 调用必须有降级策略
5. **死代码治理决策树**：砍/补/留三选一，按钮必须真实可用

完整案例详见：`docs/design-to-delivery-guide.md` 的"案例参考"章节。

## 使用本 Skill 的标准流程

当用户触发本 skill 时，按以下流程执行：

### Step 1：确认场景

询问用户：
- 设计稿在哪个目录？
- 哪些按钮/交互是死代码？（或让 implementer 识别）
- 有哪些 skill / API 能力可用？

### Step 2：写 spec 三件套

在 `.trae/specs/<project-name>/` 下创建：
- `spec.md`：背景、子 agent 角色、循环协议、提交规范、验收标准、硬约束
- `tasks.md`：每个任务的详细描述
- `checklist.md`：每个任务的勾选项

### Step 3：派子 agent 循环

按"单任务循环协议"派发：
1. implementer 实施 + 自审 + 提交
2. spec-reviewer 审 spec 合规
3. code-quality-reviewer 审 7 维
4. fix-implementer 修复 P0/P1
5. 循环直到双审通过

### Step 4：verifier 全量 review

派 verifier subagent：
- 跑 lint / typecheck / build
- 全量 git diff 检查
- 7 维评分（8.5/10 以上可归档）
- 输出 verify-report.md

### Step 5：归档五件套

更新：
- `.learnings/LEARNINGS.md`（追加 LRN 条目）
- `.learnings/PROGRESS.md`（更新进度）
- `AGENTS.md`（新增章节）
- `CLAUDE.md`（新增硬约束）
- `~/.trae-cn/memory/projects/<proj>/project_memory.md`（追加总结）

### Step 6：提交 git

每个 Task 单独 commit（不要 squash），commit message 遵循规范。

## 与其他 skill 的配合

| 配合 skill | 何时配合 |
|-----------|---------|
| **skill-creator** | 创建本 skill 时（已用于创建 design-to-delivery）|
| **agent-reach** | 调研 skill / API 能力时（确认是否可兑现）|
| **subagent-driven-development** | 执行循环工程时（派子 agent）|
| **executing-plans** | 执行 spec 三件套时 |
| **requesting-code-review** | 派 code-quality-reviewer 时 |
| **verification-before-completion** | verifier 评分前 |

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-07-21 | 初始版本（知行读书死代码治理循环工程经验沉淀）|

---

*本 skill 是活文档，每次循环工程后追加新经验。完整教程见 `docs/design-to-delivery-guide.md`。*
