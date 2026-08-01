# 多 Agent 联合开发规范（TDSF Terminal Agent）

> **用途**：规范多个 AI agent 在本项目的接手、并行、联合开发行为，避免冲突与污染。
> **生效范围**：本项目（基于 `crynta/terax-ai` v0.8.6 魔改）所有 AI 接手与开发行为。
> **版本**：v2.0（2026-07-30 · 新增 A/B/C 三场景分层、接手声明模板、改动影响分析表、CDP 实测责任、commit 拆分策略）
> **依据**：业界多 agent 协作最佳实践（Anthropic Claude Code subagents / OpenAI Agents SDK Handoffs / AWS AGENTOPS01-BP02 / GALDUR 体系 / Loop Engineering / `dispatching-parallel-agents` skill）+ 本项目 `CLAUDE.md` 防污染红线 + `docs/dev-state.md` 已知踩坑 + `docs/reports/upstream-terax-architecture.md` 模块依赖。
> **优先级**：本规范与 `CLAUDE.md` 同级，是 AI 接手必读第二文档（在 `CLAUDE.md` 之后、`docs/dev-state.md` 之前）。
> **唯一准绳**：本规范是项目内多 agent 协作的**唯一现行规范**。早期的 `.agent-collaboration/`（CONTRACT.md + file-ownership.json，2026-07-28 建立）已于 2026-07-31 废弃归档至 `docs/archive/agent-collaboration-20260728/`，不再执行；锁机制以 §3.2 的 `docs/.agent-locks.md` 为准。

---

## 0. 阅读顺序与定位

任何 AI（主 agent / subagent）接手本项目，必读文档顺序：

1. `AGENTS.md` —— 一句话指路
2. `CLAUDE.md` —— 开发规范总纲 + 防污染红线 + 五绿门禁 + 诊断方法论
3. **`docs/MULTI-AGENT-WORKFLOW.md`（本文件）** —— 多 agent 协作规范
4. `docs/dev-state.md` —— 唯一进度记忆源（特别是末尾「§<N> 交接指南」）
5. 已批准的 plan 文件（路径在 dev-state.md 末尾「记忆/规划文件在哪」表格）
6. 上游参考 `opensource-reference/terax-ai/`（遇架构问题对照同名文件）

本规范在阅读链中位于第 3 位，是「多 agent 如何不打架」的硬约束。

---

## 1. 三大协作场景（A/B/C 风险分层）

本规范按**风险等级**把多 agent 协作分为三类场景。任何多 agent 任务派发前，主 agent 必须先明确属于哪一类，并套用对应规范。

### 场景 A：并行 subagent 调研任务（最安全 · 低风险）

**特征**：多个 subagent 同时做调研、写文档，**不动任何源代码**。

| 维度 | 规则 |
|------|------|
| subagent 权限 | 只读代码 + 只写 `docs/reports/*.md` |
| 输出文件路径 | 每个 subagent **独占**一个 `docs/reports/<topic>-<YYYY-MM-DD>.md`，路径不冲突 |
| 文件锁 | 仅声明各自输出文件，互斥矩阵 §3.1 全部「不触碰」 |
| 五绿门禁 | 不需跑（无代码改动） |
| CDP/dev server | 不持有、不连接 |
| commit | 由主 agent 统一提交（见 §11.3 拆分策略） |
| 并行上限 | 无硬上限（建议 ≤ 5，避免主 agent 集成负担） |

**主 agent 汇总流程**：
1. 派发前在 `docs/.agent-locks.md` 登记每个 subagent 的输出文件路径（§3.2）
2. 各 subagent 独立工作，完成后返回「自检报告」（§9.4，场景 A 简化版：只填输出路径 + 字数 + 是否碰源码）
3. 主 agent 检查输出文件是否互斥、是否误碰源码（`git status` 应只显示 `docs/reports/*.md` 新增）
4. 主 agent 在 `docs/dev-state.md` 追加交接章，记录调研结论摘要 + 文件路径
5. 主 agent 用单条 `docs(reports):` commit 提交全部调研报告（或按主题拆分，见 §11.3）

### 场景 B：并行 subagent 修复独立模块（中等风险）

**特征**：多个 subagent 各修一个**独立模块**（如 subagent-1 改 `src-tauri/src/modules/sidecar.rs`，subagent-2 改 `src/modules/ssh-explorer/SshTerminalHost.tsx`），模块间无直接依赖。

| 维度 | 规则 |
|------|------|
| subagent 权限 | 只写**声明的模块目录**内文件 + 该模块的测试 |
| 模块边界声明 | **强制**（§3.1 模块互斥级别）：一个模块目录同时只能一个 agent 改 |
| 共享文件 | **禁止碰**：`src/app/App.tsx`、`src-tauri/src/lib.rs`、`package.json`、`Cargo.toml`、`tsconfig*.json`、`vite.config.ts`、`docs/dev-state.md`（见 §3.1 严格互斥） |
| 五绿门禁 | 每个 subagent **必须**跑前三绿（typecheck + lint + test），见 §7.5 |
| CDP/dev server | 不持有、不连接；改前端走主 agent HMR 验证，改 Rust 走 `cargo check` |
| commit | subagent **不 commit**，主 agent 集成时按模块拆 commit（§11.3） |
| 冲突预防 | 派发前用 §4.5 改动影响分析表核对：改 X 是否会牵动 Y |
| 并行上限 | ≤ 3（多于 3 时主 agent 难以同步核对依赖） |

**主 agent 集成流程**：
1. 派发前：用 §4.5 核对模块对是否可并行（属 §4.3 才可并行，属 §4.4 不可并行）
2. 在 `docs/.agent-locks.md` 登记 N 个模块锁
3. 各 subagent 改完后返回自检报告（§9.4 完整版）
4. 主 agent 按模块**逐个**集成：每接入一个 subagent 的改动 → 跑一次前三绿 → 通过才接下一个
5. 全部接入后跑**五绿全过**（含 build:web + tauri:dev）
6. 按 §11.3 拆 commit：每个模块一个 `fix(<scope>):` 或 `refactor(<scope>):`
7. 更新 `docs/dev-state.md`，记录多 agent 协作情况

### 场景 C：主 agent + subagent 协作（高风险）

**特征**：主 agent 做主线（如 SSH 终端集成，需改 `App.tsx`/`lib.rs` 等严格互斥文件），subagent 做旁支（如运维 agent 调研、可用性审计、规范撰写）。**主 agent 与 subagent 同时活跃**，冲突风险最高。

| 维度 | 规则 |
|------|------|
| 主工作树原则 | **主 agent 拥有 `src/` 和 `src-tauri/` 的写权**（§5.3） |
| subagent 权限 | **只读**代码；或**限定目录写**（仅 `docs/`，或主 agent 显式授权的子目录） |
| 共享文件 | `docs/dev-state.md`、`App.tsx`、`lib.rs` 等**全部归主 agent**，subagent 不得触碰 |
| 同步时机 | ① subagent 完成时同步；② 主 agent 每完成一个里程碑（五绿过 + commit）时同步；③ 主 agent 发现 subagent 越界时立即叫停 |
| 五绿门禁 | 主 agent 全权负责五绿 + CDP 实测；subagent 不跑门禁（除非主 agent 授权改代码，此时按场景 B） |
| CDP/dev server | 主 agent **独占** 9300/9222 端口（§8.1） |
| commit | 主 agent 独占 commit 权 |
| 冲突解决 | 主工作树优先（§10.4）：主 agent 的改动保留，subagent 若越界改了主 agent 正在改的文件，subagent 改动**作废**，由主 agent 用 Edit 反向编辑撤销（不 `git checkout`，CLAUDE.md §0 铁律 3） |

**何时用场景 C**：
- 主线任务涉及严格互斥文件（App.tsx / lib.rs / 启动链 / 权限配置）
- 主线任务需要 dev server 实时验证（HMR / CDP 实测）
- 同时有旁支调研/审计/文档任务可并行

**场景 C 的 subagent 边界声明**（主 agent 派发时必须明示）：
```
subagent-<ID>:
  可读: 全项目（除 .env / credentials）
  可写: docs/reports/<topic>-<date>.md（仅此一个文件）
  禁碰: src/**, src-tauri/**, *.json, *.toml, docs/dev-state.md, docs/MULTI-AGENT-WORKFLOW.md
  端口: 不起 dev server, 不连 CDP
  返回: 自检报告（场景 A 简化版）
```

### 1.4 三场景速查表

| 维度 | 场景 A（调研） | 场景 B（独立模块修复） | 场景 C（主+sub 协作） |
|------|---------------|---------------------|---------------------|
| 风险 | 低 | 中 | 高 |
| subagent 写权 | `docs/reports/*.md` | 声明的模块目录 | 限定单文件（通常 `docs/`） |
| 共享文件 | 不碰 | 不碰 | 全归主 agent |
| 五绿门禁 | 不跑 | 前三绿 | 主 agent 全权 |
| CDP/dev | 不持有 | 不持有 | 主 agent 独占 |
| commit | 主 agent 统一 | 主 agent 按模块拆 | 主 agent 独占 |
| 主 agent 角色 | 派发+汇总 | 派发+集成+拆 commit | 主线开发+派发+集成 |
| 并行上限 | ≤ 5 | ≤ 3 | ≤ 3（含主线） |

---

## 2. 接手协议（Handoff Protocol）

### 2.1 接手第一动作（强制顺序，不可跳步）

任何 AI 接手本项目，按以下顺序执行（违反顺序 = 接手失败）：

1. **读 `AGENTS.md`** —— 一句话指路，确认项目身份
2. **读 `CLAUDE.md`** —— 开发规范 + 架构地图 + 防污染红线 + 五绿门禁 + 诊断方法论
3. **读 `docs/MULTI-AGENT-WORKFLOW.md`（本文件）** —— 多 agent 协作规范
4. **读 `docs/dev-state.md`** —— 唯一进度记忆源，**特别读末尾「§<N> 交接指南」**
5. **读相关 plan 文件**（如有，路径在 dev-state.md 末尾「记忆/规划文件在哪」表格）
6. **读上游参考** `opensource-reference/terax-ai/`（遇架构问题对照同名文件）
7. **跑接手检查脚本**（§12），确认基线绿
8. **跑五绿门禁前三绿**（typecheck + lint + test），确认基线无回归
9. **填写接手声明**（§2.4），声明本次工作范围 + 文件锁

### 2.2 接手检查清单

接手 AI 必须逐项打勾后才能开始改动：

- [ ] `git status` 工作区干净？或与 dev-state.md 末尾「本 session 改动的文件」一致？
- [ ] `git log -1` 最新 commit 与 dev-state.md 描述一致？
- [ ] `pnpm typecheck` 0 错误？
- [ ] `pnpm lint` 0 错误 0 警告？
- [ ] `pnpm test` 832 全过（或与 dev-state.md 记录数一致）？
- [ ] dev-state.md 末尾「§<N> 接手下一步」明确？
- [ ] 已知踩坑已读？（CLAUDE.md §3 防污染红线 8 条 + dev-state.md §四 大恢复经验）
- [ ] 当前任务边界清晰？（互斥文件清单见 §3.1，改动影响见 §4.5）
- [ ] 接手声明已填？（§2.4 模板，追加到对话或 dev-state.md 临时区）

### 2.3 接手失败回退

若接手时发现以下任一情况，**立即停止开发**：

- 基线不绿（typecheck/lint/test 任一失败，且非任务相关预期失败）
- 工作区被污染（0 字节源文件、依赖被退回、git checkout 已跟踪文件痕迹）
- dev-state.md 描述与实际工作区严重不符（说明前序 AI 没保存记忆）

回退动作：
1. 立即停止改动
2. 用 AskUserQuestion 报告问题（说明：基线状态、与 dev-state.md 描述的差异、建议回退到哪个 commit）
3. **绝不在污染基线上继续开发**（这是 CLAUDE.md §0 铁律 1 的延伸）

### 2.4 接手声明模板（强制使用）

任何 agent（主 agent / subagent）接手时，**必须先填以下声明**（追加到对话首条消息，或派发任务的回执中）。声明是软约束的「文件锁」，未声明就改 = 越界。

```markdown
# 接手声明

## 身份
- Agent 标识：<main / subagent-A / subagent-B / ...>
- 接手时间：<YYYY-MM-DD HH:MM>
- 任务一句话：<描述>

## 我已读的上下文（按 §2.1 顺序）
- [x] AGENTS.md
- [x] CLAUDE.md
- [x] docs/MULTI-AGENT-WORKFLOW.md
- [x] docs/dev-state.md（末尾 §<N>）
- [ ] plan 文件：<路径或「无」>
- [ ] 上游参考：<文件或「未对照」>

## 已读最新调研报告（v2.1 新增，必填）
- [x] `docs/reports/ops-agent-opensource-survey-2026-07-v4.md`（v4，37 项目，Strands 首选确认 + AgentSSH/OpAgent/LearnSSH/ANOLISA 发现）
- [x] `docs/reports/modded-agent-code-review-2026-07-30.md`（P1-NEW-1/2/3/4 + P2-NEW-1~6，含修复状态）
- [ ] 其他相关报告：<路径或「无」>

## 当前 sidecar 异步执行状态（v2.1 新增，改 sidecar 必填）
- `_slow_methods` / `_main_executor` 是否已注入：<是/否/未确认>
  - 证据：`src-tauri/sidecar/main.py:129` `_slow_methods: frozenset[str] = frozenset({"agent.invoke"})` + `main.py:130` `_main_executor: ThreadPoolExecutor | None = None`
  - 初始化：`main.py:782-787` `ThreadPoolExecutor(max_workers=2, thread_name_prefix="sidecar-async")`
  - 派发：`main.py:842-851` 慢方法走 `_main_executor.submit(_dispatch_in_executor, ...)`
  - 关闭：`main.py:877-882` `_main_executor.shutdown(wait=True, cancel_futures=True)`
- 若改 `main.py` 主循环 / `_slow_methods` / `_main_executor`，必须先读 §17 多 agent 与 sidecar 异步执行协作规则
- 若改 `agents/__init__.py` 的 `set_backend` / `clear_backend` / `_global_backend_override`，必须先读 §19 Strands 适配层协作红线

## 我将修改的文件清单（文件锁，其他人不得触碰）
- <绝对路径 1> —— <改动说明>
- <绝对路径 2> —— <改动说明>

## 我将只读不碰的严格互斥文件（§3.1）
- src/app/App.tsx
- src-tauri/src/lib.rs
- package.json / pnpm-lock.yaml
- src-tauri/Cargo.toml / Cargo.lock
- src-tauri/tauri.conf.json / tauri.windows.conf.json
- src-tauri/capabilities/default.json
- tsconfig.json / tsconfig.app.json / tsconfig.node.json
- vite.config.ts
- eslint.config.js
- docs/dev-state.md（由主 agent 统一更新）

## 协作场景（§1）
- [ ] 场景 A（调研，只写 docs/reports/）
- [ ] 场景 B（独立模块修复，写声明的模块目录）
- [ ] 场景 C（主+sub 协作，主 agent 持 src/ 与 src-tauri/ 写权）

## 我不持有的运行态（场景 A/B 必填，场景 C 主 agent 跳过）
- 不起 pnpm tauri:dev（端口 9300/9222 由主 agent 持有）
- 不连 CDP 9222
- 改 Rust 只跑 cargo check，改前端只跑 typecheck/lint/test

## 预计完成时间与回滚点
- 预计完成：<HH:MM>
- 回滚点：<最近 commit hash 或「无（首改）」>
```

接手声明填好后，主 agent 把 subagent 的声明汇总到 `docs/.agent-locks.md`（§3.2）。

---

## 3. 文件锁与互斥规则

### 3.1 文件级互斥矩阵

同一文件/目录在同一时间只能由一个 agent 改动。互斥级别：

| 文件/目录 | 互斥级别 | 说明 | 违反后果 |
|----------|---------|------|---------|
| `src/app/App.tsx` | 严格互斥 | 1600 行主壳，任何改动需独占整个 session | 多 agent 同改 = 整树重挂载、PTY 重 spawn、卡死 |
| `src/app/components/WorkspaceSurface.tsx` | 严格互斥 | 工作区表面（tab 切换/invisible 挂载逻辑） | 同改 = tab 不卸载策略被破坏 |
| `src/main.tsx` | 严格互斥 | 启动链入口 | 同改 = 启动链断 |
| `src-tauri/src/lib.rs` | 严格互斥 | Tauri 命令注册中心（80+ 命令） | 同改 = invoke_handler 重复/遗漏 |
| `src-tauri/src/main.rs` | 严格互斥 | Tauri 入口 | 同改 = 启动链断 |
| `package.json` / `pnpm-lock.yaml` | 严格互斥 | 依赖变更需独占 + `pnpm install` | 同改 = lock 不一致、依赖被退回（CLAUDE.md §3 红线 3） |
| `src-tauri/Cargo.toml` / `Cargo.lock` | 严格互斥 | Rust 依赖 | 同改 = cargo build 失败 |
| `src-tauri/tauri.conf.json` | 严格互斥 | Tauri 配置（窗口/端口/CSP） | 同改 = 启动失败 |
| `src-tauri/tauri.windows.conf.json` / `tauri.linux.conf.json` | 严格互斥 | 平台窗口配置 | 同改 = 窗口不可见 |
| `src-tauri/capabilities/default.json` | 严格互斥 | Tauri 权限清单 | 同改 = show() 被拦截、窗口永不可见 |
| `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | 严格互斥 | TS 配置（per-project -p 检查方式） | 同改 = typecheck 误报 TS2742 |
| `vite.config.ts` | 严格互斥 | Vite 配置（端口 9300 strictPort） | 同改 = dev server 起不来 |
| `eslint.config.js` / `biome.json` | 严格互斥 | lint 配置 | 同改 = 门禁不一致 |
| `docs/dev-state.md` | 协调互斥 | 唯一进度记忆源 | 写入前先读最新 → 追加新章节 → 立即 commit（不覆盖历史章节） |
| `docs/MULTI-AGENT-WORKFLOW.md`（本文件） | 协调互斥 | 多 agent 规范 | 改动需主 agent 独占 + 用户确认；**subagent 经主 agent 派发授权 + 用户确认后可改**（见 §9.5 实例 + §13 红线 13 例外条款） |
| `AGENTS.md` / `CLAUDE.md` | 协调互斥 | 顶层规范，改动需主 agent 独占 + 用户确认 | 同改 = 规范混乱 |
| `src/modules/<module>/` 目录内 | 模块互斥 | 同一模块内多文件改动需独占（例如改 `terminal/` 时不可有另一 agent 同时改 `terminal/lib/rendererPool.ts`） | 同改 = 模块内部状态不一致 |
| `src-tauri/src/modules/<module>/` 目录内 | 模块互斥 | 同上（Rust 侧） | 同改 = cargo check 失败 |
| `opensource-reference/terax-ai/` | 只读 | 上游参考，任何 agent 不可修改 | 改 = 失去对照基线 |
| `docs/reports/legacy/` | 只读 | 历史 v3 报告归档 | 改 = 历史失真 |
| `docs/architecture/` | 只读 | 上游架构文档（来自 terax） | 改 = 失去上游架构参考 |
| `src/modules/theme/` | 模块互斥 + 高风险 | 曾因 useThemeFileEditing effect 自反循环卡死 50 万次/秒 | 同改 = 极易触发无限渲染（CLAUDE.md §3 红线 4） |
| `src/modules/ai/lib/composer.tsx` | 模块互斥 + 高风险 | AiComposerProvider 最外层 Provider，TERAX.md 警告无条件挂载 | 同改 = 整树重挂载 |
| `src/lib/ssh-bridge.ts` / `sftp-bridge.ts` / `pty-bridge.ts` | 模块互斥 | invoke 桥，被多处依赖 | 同改 = 终端/SSH 联动断裂 |
| `src-tauri/sidecar/strands_backend/` 目录内 | 模块互斥 | Strands 适配器（adapter.py / model_adapter.py）+ 5 个运维工具（log_analyzer / network_diagnostic / process_inspector / remote_file / ssh_command） | 同改 = agent 行为不一致（dev-state §十二~§十五 已集成） |
| `src-tauri/sidecar/strands_backend/tools/ssh_command.py` | 模块互斥 + 高风险 | SSH 远程命令执行工具（高危命令经 RiskChecker + emit_needs_you 审批；通过 rust_bridge.ipc_invoke("ssh_command") 调 Rust） | 同改 = 审批链路断 / 高危命令误执行 |
| `src-tauri/sidecar/rust_bridge.py` | 模块互斥 | sidecar → Rust 反向 JSON-RPC 桥（Python 阻塞等 Rust 响应 30s，ID 1,000,000+ 与 Rust 1+ 隔离） | 同改 = SSH/SFTP/PTY 调用链断（所有 strands_backend/tools/ 调 Rust 必经此桥） |
| `src-tauri/sidecar/event_bus.py` | 模块互斥 | 事件总线（EventType 枚举 + pub-sub + emit_mock_warning/emit_agent_switch/emit_needs_you 便捷方法） | 同改 = 事件发布/订阅断裂（前端 MockLLMWarning / AgentStatusPill / needs-you 全失效） |
| `src-tauri/sidecar/agents/` 目录内 | 模块互斥 | 9 个内置 agent 定义（main / coding / debug / deploy / explore / history / refactor / teach / test，继承 BaseAgent PAOR） | 同改 = agent 切换行为不一致 |
| `src/modules/ssh-explorer/SshTerminalHost.tsx` | 模块互斥 + 高风险 | SSH 终端宿主组件（`SshTerminalHost.tsx:47` 接收 `{sessionId, allocId, className}`，`SshTerminalHost.tsx:72-77` 构造 `TerminalTransport` 注入 `useTerminalSession`；深度集成 rendererPool 后紧耦合） | 同改 = SSH 终端无法挂载 / transport 工厂断裂（§18） |
| `src/modules/terminal/lib/useTerminalSession.ts` | 模块互斥 + 高风险 | 终端会话 hook（`useTerminalSession.ts:33` import `TerminalTransport`，`:76` `pty: TerminalTransport \| null`，`:81`/`:1014` `openTransport` 工厂签名；本地 PTY 与远程 SSH 共用此 hook） | 同改 = 本地 + SSH 终端同时断裂（§18） |
| `src/modules/terminal/lib/pty-bridge.ts`（含 `TerminalTransport` 接口） | 模块互斥 + 高风险 | `TerminalTransport` 接口定义源（被 `useTerminalSession.ts:33` / `SshTerminalHost.tsx:31` / `TerminalPane.tsx` 共同 import；`useTerminalSession.ts:524` 注释 resize 返回 `Promise<void>\|void`） | 同改 = 本地 PTY + SSH 终端 transport 契约全断（§18） |
| `src/modules/ai/components/BackendPill.tsx` | 模块互斥 | 后端状态指示器（订阅 `sidecar:backend_status` 事件，显示 Strands / Mock / PydanticAI 等后端类型；P0-E 新增） | 同改 = 后端状态不显示 / 事件订阅断裂 |
| `src-tauri/sidecar/main.py`（主循环 + `_main_executor`） | 模块互斥 + 高风险 | sidecar 入口（`main.py:129` `_slow_methods` / `:130` `_main_executor` / `:782-787` 初始化 `ThreadPoolExecutor(max_workers=2)` / `:842-851` 慢方法走线程池 / `:877-882` shutdown；P1-NEW-1 修复） | 同改 = 主循环阻塞回退 / health_check 误判 Crashed（§17） |
| `src-tauri/sidecar/agents/__init__.py`（`set_backend` / `clear_backend` / `_global_backend_override`） | 模块互斥 + 高风险 | 后端注入接口（`agents/__init__.py:168-210` set_backend/clear_backend；`_global_backend_override` 单写者；P1-NEW-2 修复 walrus hack） | 同改 = Strands 后端注入断裂 / 多 agent 后端不一致（§19） |
| `src-tauri/sidecar/agents/base.py` | 模块互斥 + 高风险 | BaseAgent PAOR 模板方法（`base.py:191` invoke / `:584` emit_mock_warning / `:163` `_mock_warning_dedup_ts` 60s dedup；400+ 行核心逻辑无单元测试，T3 缺口） | 同改 = 全部 9 个 Agent 行为不一致 |
| `src-tauri/sidecar/strands_backend/adapter.py` | 模块互斥 + 高风险 | StrandsAgentAdapter（封装 Strands Agent 创建/工具注册/invoke；`Strands 1.50.2` 已移除 `max_iterations`，改用 `hooks=[LimitToolCounts]`；`_get_or_create_agent` 用 model_adapter 注入 model） | 同改 = Strands 后端 invoke 链断（§19） |
| `src-tauri/sidecar/strands_backend/model_adapter.py` | 模块互斥 | `create_strands_model(config)`（LLMConfig → OpenAIModel/AnthropicModel/LiteLLMModel；优雅降级返回 None；23 测试覆盖） | 同改 = LLM 调用链断 / 多 provider 切换失效 |
| `src-tauri/src/modules/ipc.rs` | 模块互斥 | Rust JSON-RPC 协议层（`ipc_invoke` Tauri 命令 + 反向请求路由；`ipc.rs:269-272` JSDoc 文档漂移残留 P2-NEW-4） | 同改 = 前端 ↔ sidecar 通信全断 / 反向请求路由失效 |
| `src-tauri/src/modules/sidecar.rs`（`HEARTBEAT_TIMEOUT` / `send_request` / `health_check`） | 模块互斥 + 高风险 | Rust 进程管理（`sidecar.rs:55` `REQUEST_TIMEOUT=30s` / `:1240-1258` `HEARTBEAT_TIMEOUT=30s` 检查 / `:551-602` send_request 30s 超时 / `:835-917` reader_task 反向响应路由 / `:979,1001,...` 共 8 处 `as u32` 截断 P2-NEW-3） | 同改 = health_check 误判 / 进程重启循环失效 / 反向请求路由错乱 |

**互斥级别含义**：
- **严格互斥**：整个 session 独占，场景 A/B 的 subagent **一律禁止碰**，场景 C 只有主 agent 可改
- **模块互斥**：同一模块目录内同时只能一个 agent 改；不同模块可并行（受 §4 依赖图约束）
- **协调互斥**：改动前先读最新 → 改 → 立即 commit；多 agent 同时改时由主 agent 协调
- **只读**：任何 agent 不可修改

### 3.2 互斥声明机制（轻量文件锁）

本项目不引入额外的锁服务（如 AWF 那种 Docker 编排）。采用**轻量声明文件**机制：

- 锁文件路径：`docs/.agent-locks.md`（运行时生成，git 不跟踪，加入 `.gitignore`）
- 锁文件格式（Markdown 表格，追加写入）：

```markdown
# Agent Locks（运行时声明，非持久化）

| 时间 | Agent 标识 | 场景 | 持有的文件/目录 | 任务简述 | 预计释放 |
|------|-----------|------|---------------|---------|---------|
| 2026-07-30 14:00 | main | C | src/app/App.tsx, src/modules/ssh-explorer/, src/modules/terminal/, src-tauri/src/modules/ssh/, src-tauri/src/lib.rs | SSH 终端深度集成 #15-#20 | 18:00 |
| 2026-07-30 14:05 | subagent-A | A | docs/reports/ops-agent-opensource-research-2026-07-30.md | 调研运维 agent 开源项目 | 16:00 |
| 2026-07-30 14:05 | subagent-B | B | src/modules/translate/ | 补 translate 模块 vitest 测试 | 16:30 |
```

主 agent 在派发 subagent 任务前：
1. 在 `docs/.agent-locks.md` 追加声明（包含 subagent 标识、场景、持有的文件清单、任务简述、预计释放时间）
2. subagent 完成后，主 agent 删除对应行

声明机制是**软约束**（agent 自律 + 主 agent 监督），不是硬约束（无 pre-commit hook 拦截，避免引入 GALDUR 那套 git hook 复杂度）。理由：本项目以主工作树为主，主 agent 全程可见，不需要机器强制。

### 3.3 互斥冲突时的处理

若两个 agent 同时声明了同一文件（主 agent 派发失误）：
1. 后声明的 agent 立即放弃该文件
2. 报告主 agent
3. 主 agent 重新分配任务边界（用 AskUserQuestion 询问用户，或拆分任务）

---

## 4. 模块依赖图与改动影响分析

### 4.1 前端模块依赖图（基于上游架构报告 + 本项目魔改）

本项目前端模块（共 24 个，上游 20 + 魔改独有 4）：

```
上游模块（20）：
agents / ai / command-palette / editor / explorer / git-history / header
lsp / markdown / preview / settings / shortcuts / sidebar / source-control
spaces / statusbar / tabs / terminal / theme / updater / workspace

魔改独有模块（4）：
translate / ssh-explorer / skills / strands-integration（虚拟节点：前端 ai 模块通过 sidecar-adapter.ts + chatRuntime.ts 调用后端 Python Strands backend，dev-state §十二~§十五 集成）
```

依赖关系（→ 表示依赖，被依赖方改动时依赖方需重新验证）：

```
                              ┌─→ theme（底层，被所有 UI 模块依赖）
                              │
shortcuts（横切）──────────────┼─→ 所有模块（注册全局快捷键）
                              │
App.tsx（顶层壳）──────────────┼─→ 几乎所有模块（Provider 树 + 布局）
                              │
                              ├─→ tabs ←─ editor / terminal / preview / markdown / ai-diff / git-diff
                              │   （tabs 是 tagged union，不卸载策略的协调者）
                              │
                              ├─→ editor ←─ lsp（diagnosticsReporter / useLspExtension）
                              │           ←─ theme（editorTheme）
                              │           ←─ tabs（openFileTab）
                              │
                              ├─→ terminal ←─ theme（terminal token / resolveTerminalFont）
                              │             ←─ tabs（visibility 保活）
                              │             ←─ Rust pty（pty-bridge）
                              │             ←─ ai（agent 工具调用终端，魔改加）
                              │             │
                              │             ├─→ pty-bridge.ts（TerminalTransport 接口定义源，被 4 处 import）
                              │             │       ←─ useTerminalSession.ts:33 import { TerminalTransport }
                              │             │       ←─ SshTerminalHost.tsx:31 import type { TerminalTransport }
                              │             │       ←─ TerminalPane.tsx import
                              │             │       ←─ useTerminalSession.ts:524 注释 resize 返回 Promise<void>|void
                              │             │
                              │             ├─→ useTerminalSession.ts（终端会话 hook，本地 PTY 与远程 SSH 共用）
                              │             │       ←─ pty-bridge.ts（TerminalTransport 类型 + openPty 工厂）
                              │             │       ←─ rendererPool.ts（xterm 实例复用池，含 ResizeObserver 防抖 fit）
                              │             │       ←─ tabs（openTransport 注入，:81/:1014 工厂签名）
                              │             │       ←─ SshTerminalHost.tsx（远程分支：:72-77 构造 TerminalTransport 注入）
                              │             │
                              │             └─→ rendererPool.ts（xterm 实例复用池，深度集成后 SSH 终端并入）
                              │
                              ├─→ explorer ←─ Rust fs（useFileTree）
                              │             ←─ git（useGitStatus）
                              │             ←─ ssh-explorer（useRemoteFileTree，魔改加）
                              │
                              ├─→ ssh-explorer ←─ Rust ssh/sftp（ssh-bridge / sftp-bridge）
                              │                  ←─ Rust secrets（凭据持久化）
                              │                  ←─ explorer（远程分支复用 FileExplorer）
                              │                  ←─ terminal（待并入 rendererPool，见 dev-state §七）
                              │                  ←─ theme（终端 token）
                              │                  │
                              │                  └─→ SshTerminalHost.tsx（SSH 终端宿主，:47 接收 {sessionId, allocId, className}）
                              │                          ←─ terminal/lib/pty-bridge.ts（TerminalTransport 接口，:31 import）
                              │                          ←─ terminal/lib/useTerminalSession.ts（:32 import disposeSession）
                              │                          ←─ sshStore.ts（:33 useSshStore，sessionId 源）
                              │                          ←─ TerminalPane.tsx（:30 复用本地终端渲染组件）
                              │                          ←─ WorkspaceSurface.tsx（挂载点，tab 切换时 invisible 保活）
                              │
                              ├─→ ai ←─ Rust net（HTTP 代理 + SSRF 防御）
                              │       ←─ Rust secrets（API key）
                              │       ←─ Rust sidecar（Python AI 引擎，魔改独有）
                              │       ←─ agents（外部 agent 通知）
                              │       ←─ composer.tsx（AiComposerProvider 最外层）
                              │       ←─ terminal（agent 工具调用）
                              │       ←─ strands-integration（虚拟节点：sidecar-adapter.ts + chatRuntime.ts.getSshRustSessionId + transport.ts LiveSnapshot.sshSessionId 注入）
                              │       │
                              │       ├─→ BackendPill.tsx（后端状态指示器，订阅 sidecar:backend_status 事件）
                              │       │       ←─ event_bus.py（BACKEND_STATUS EventType，P0-E 新增）
                              │       │       ←─ sidecar-bridge.ts（onBackendStatus 订阅函数）
                              │       │       ←─ main.py（_backend_status 字段 + _sidecar_health 返回）
                              │       │
                              │       ├─→ composer.tsx（AiComposerProvider 最外层 + attachFileByPath 闭包）
                              │       │       ←─ useChatStore（zustand）
                              │       │       ←─ sidecar-adapter.ts（runSidecarStream）
                              │       │       ←─ attachFileByPath（:173-207，P1-NEW-4 修复：需 useCallback 稳定引用）
                              │       │
                              │       └─→ sidecar-adapter.ts + chatRuntime.ts（strands-integration 桥接层）
                              │               ←─ sidecar-bridge.ts（ipc_invoke 桥）
                              │               ←─ Python main.py（agent.invoke JSON-RPC）
                              │               ←─ Python strands_backend/adapter.py（StrandsAgentAdapter）
                              │
                              ├─→ agents ←─ ai（agent 通知桥）
                              │
                              ├─→ skills（魔改独有，依赖 ai 的工具调用）
                              │
                              ├─→ strands-integration（魔改独有虚拟节点，非独立目录）
                              │       ←─ ai（sidecar-adapter.ts 桥接 Python sidecar）
                              │       ←─ Python strands_backend（adapter + tools，dev-state §十二~§十五）
                              │       ←─ Python rust_bridge（反向 JSON-RPC 调 Rust ssh_command/sftp_*）
                              │       ←─ Rust ssh::ssh_command（exec 模式，dev-state §十三 集成）
                              │       ←─ Rust ssh（sessionId 由 chatRuntime.getSshRustSessionId 实时查）
                              │
                              ├─→ translate（魔改独有，独立，仅依赖 Radix Popover）
                              │
                              ├─→ source-control ←─ git-history（GraphRail 复用）
                              │
                              ├─→ statusbar ←─ workspace（CwdBreadcrumb）
                              │
                              ├─→ command-palette（独立，cmdk）
                              │
                              ├─→ preview / markdown（独立）
                              │
                              └─→ settings（独立窗口入口）
```

### 4.2 Rust 后端模块依赖图（基于上游架构报告 + 本项目魔改）

本项目 Rust 模块（共 14 个，上游 11 + 魔改独有 3）：

```
上游模块（11）：
agent / fs / git / history / lsp / net / proc / pty / secrets / shell / workspace

魔改独有模块（3）：
ssh / sidecar / sandbox
```

依赖关系：

```
lib.rs（命令注册中心，80+ 命令）───────── 所有模块（invoke_handler 注册）
  │
  ├─→ proc（无 invoke 命令，内部用 ProcessJob）←─ pty / lsp（共享 Job Object）
  │
  ├─→ workspace（WorkspaceRegistry + authorize_spawn_cwd）←─ pty / shell / lsp（本地 spawn 必经授权）
  │                                                          ssh（魔改，不走这套，自定义授权）
  │
  ├─→ pty（portable-pty，CONPTY_LIFECYCLE_LOCK，Job Object）←─ 前端 terminal
  │
  ├─→ ssh（魔改独有，russh 0.61 + russh-sftp 2.1）←─ 前端 ssh-explorer
  │       ├─→ secrets（建议复用，service=terax-ssh）
  │       └─→ ssh_command Tauri 命令（exec 模式，非 PTY，dev-state §十三 P0-D 集成）
  │              ←─ Python rust_bridge.ipc_invoke("ssh_command", {sessionId, command, timeout})
  │              ←─ Python strands_backend/tools/ssh_command.py（高危命令经 RiskChecker + emit_needs_you 审批）
  │
  ├─→ sidecar（魔改独有，Python 进程管理，P0 指数退避已修 commit 2091e2f：MAX_RETRY 3→5 / 1·2·4·8·16·32·60s + cancel_tx + child.kill+wait 失败路径）←─ 前端 ai（可选）
  │       ├─→ sidecar.rs（进程管理 + 重启循环 + health_check + 反向请求路由）
  │       │       ├─→ HEARTBEAT_TIMEOUT=30s（:1240-1258，30s 无 ping 响应判 Crashed，P1-NEW-1 根因）
  │       │       ├─→ REQUEST_TIMEOUT=30s（:55，send_request 30s 超时，与 rust_bridge.py:68 DEFAULT_TIMEOUT=30 叠加，K9 未修）
  │       │       ├─→ reader_task（:835-917，反向响应路由：id<1M → Rust pending；id≥1M → Python pending）
  │       │       ├─→ handle_reverse_request（:958-1148，8 个 method 分支：ssh_command/sftp_read/write/stat/list/mkdir/remove/rename，K8 无单元测试）
  │       │       ├─→ exit_watcher_task（:1366-1372，运行冷却判断，P0 重启循环已修 K1）
  │       │       └─→ as u32 截断（:979,1001,1021,... 共 8 处，P2-NEW-3 未修）
  │       │
  │       └─→ ipc.rs（JSON-RPC 协议层，ipc_invoke Tauri 命令）
  │               ├─→ ipc_invoke（:278-286，前端 → Python 请求转发）
  │               ├─→ IPCError 转换（:347-414，8 测试）
  │               └─→ JSDoc 文档漂移（:269-272 仍写 {input:'...'}，实际契约 {name,state:{input,messages,live}}，P2-NEW-4 未修）
  │
  ├─→ sandbox（魔改独有，命令沙箱执行）←─ sidecar / shell（高危命令拦截）
  │
  ├─→ net（ai_http_request/stream，SSRF 防御）←─ 前端 ai（上游路径）
  │
  ├─→ secrets（keyring，Linux 文件 0600）←─ 前端 ai（API key）+ ssh（凭据）
  │
  ├─→ fs（tree/file/mutate/search/grep/watch）←─ 前端 explorer
  │
  ├─→ git（git_* 17 命令）←─ 前端 source-control / git-history
  │
  ├─→ lsp（spawn/send/kill，授权 spawn）←─ 前端 editor / lsp
  │
  ├─→ shell（run/session/bg，授权 spawn）←─ 前端 ai（agent 工具）
  │
  ├─→ agent（外部 CLI agent 钩子，OSC 777）←─ 上游路径，魔改可能不用
  │
  └─→ history（suggest/commands/record/list）←─ 前端 terminal
```

#### 4.2.1 Python sidecar 内部模块依赖图（魔改独有，dev-state §十二~§十五 集成）

Python sidecar（`src-tauri/sidecar/`）是魔改独有的 AI 引擎，由 Rust `sidecar` 模块 spawn 为子进程。内部模块（共 7 类）：

```
main.py（JSON-RPC 入口 + agent 注册 + TDSF_AGENT_BACKEND feature flag 注入）
  │
  ├─→ _main_executor / _slow_methods（P1-NEW-1 修复，2026-07-30）
  │       ├─→ _slow_methods: frozenset[str] = frozenset({"agent.invoke"})（:129，慢方法清单）
  │       ├─→ _main_executor: ThreadPoolExecutor | None = None（:130，线程池单例）
  │       ├─→ 初始化：ThreadPoolExecutor(max_workers=2, thread_name_prefix="sidecar-async")（:782-787）
  │       ├─→ 派发：_main_executor.submit(_dispatch_in_executor, ...)（:842-851，慢方法走线程池）
  │       └─→ 关闭：_main_executor.shutdown(wait=True, cancel_futures=True)（:877-882，退出时清理）
  │           ※ 详见 §17 多 agent 与 sidecar 异步执行协作规则
  │
  ├─→ agents/（9 个内置 agent：main/coding/debug/deploy/explore/history/refactor/teach/test）
  │       ├─→ __init__.py（:168-210 set_backend/clear_backend + _global_backend_override 单写者，P1-NEW-2 修复 walrus hack）
  │       │       ├─→ set_backend(backend): _global_backend_override = backend（仅 main.py 启动段调用，§19 红线）
  │       │       ├─→ clear_backend(): _global_backend_override = None（仅 main.py 退出段调用，§19 红线）
  │       │       └─→ invoke_agent(name, state): 优先用 _global_backend_override，否则走 BaseAgent.invoke
  │       └─→ base.py（BaseAgent PAOR 主路径，:191 invoke / :584 emit_mock_warning / :163 _mock_warning_dedup_ts 60s dedup）
  │
  ├─→ strands_backend/（Strands 适配层，TDSF_AGENT_BACKEND=strands 时注入，dev-state §十二~§十五）
  │       ├─→ adapter.py（StrandsAgentAdapter：封装 Strands Agent 创建/工具注册/invoke；
  │       │              Strands 1.50.2 已移除 max_iterations，改用 hooks=[LimitToolCounts]）
  │       │       └─→ model_adapter.py（create_strands_model：LLMConfig → OpenAIModel/AnthropicModel/LiteLLMModel，
  │       │                              优雅降级：未配置/未安装/异常返回 None）
  │       │
  │       └─→ tools/（5 个运维工具，@tool 装饰，Strands 不可用时退化为 passthrough）
  │              ├─→ ssh_command.py（高危命令经 RiskChecker + emit_needs_you 审批；rust_bridge.ipc_invoke("ssh_command")）
  │              ├─→ log_analyzer.py
  │              ├─→ network_diagnostic.py
  │              ├─→ process_inspector.py
  │              └─→ remote_file.py
  │
  ├─→ rust_bridge.py（Python→Rust 反向 JSON-RPC 桥，dev-state §十三 P1-3 集成）
  │       ├─→ send_request_to_rust(method, params) 阻塞等响应 30s
  │       ├─→ ID 1,000,000+ 与 Rust 1+ 隔离（避免冲突）
  │       └─→ 被 strands_backend/tools/* 调用（ssh_command / sftp_read / sftp_write / sftp_stat）
  │
  ├─→ event_bus.py（事件总线，EventType 枚举 + pub-sub + 历史保留）
  │       ├─→ emit_mock_warning（MockLLMWarning，dev-state §十二 P1-c 修复）
  │       ├─→ emit_agent_switch（AgentStatusPill，dev-state §十二 P1-a 修复）
  │       ├─→ emit_needs_you（审批事件，被 ssh_command.py 高危命令触发）
  │       ├─→ BACKEND_STATUS EventType（P0-E 新增，前端 BackendPill.tsx 订阅 sidecar:backend_status）
  │       └─→ event.history JSON-RPC 方法（前端补发查询）
  │
  ├─→ core/（LLMConfig / RiskEngine / Confidence / DecisionEngine 等基础设施工具）
  ├─→ byoa/（Bring-Your-Own-Agent 适配器：aider/claude/codex/cursor/continue）
  ├─→ graph/ / knowledge/ / observability/ / skills/（图引擎/知识库/可观测/Skills 系统）
  └─→ tools/（confidence/credibility/decision/ground/history/risk/rlm_fanout/rpc_methods/steer_inject/worktree_fanout）
```

**关键调用链**（Strands backend 启用时，dev-state §十五 实测验证）：

```
前端 ai 模块（sidecar-adapter.ts + chatRuntime.ts）
  ↓ JSON-RPC agent.invoke
main.py（dispatch）
  ↓ agents.set_backend(adapter.invoke)（TDSF_AGENT_BACKEND=strands 时）
strands_backend/adapter.py（StrandsAgentAdapter.invoke）
  ↓ _get_or_create_agent → Strands Agent（model + tools + system_prompt）
  ↓ agent(prompt) → 真实 LLM API（DeepSeek/OpenAI/Anthropic，由 model_adapter 创建）
  ↓ 工具调用（如 ssh_command）
strands_backend/tools/ssh_command.py（RiskChecker 检测高危命令）
  ↓ rust_bridge.send_request("ssh_command", {sessionId, command, timeout})
rust_bridge.py（阻塞等响应 30s，ID 1,000,000+）
  ↓ JSON-RPC 反向请求
Rust ssh::ssh_command Tauri 命令（exec 模式）
  ↓ russh channel exec
SSH 远程主机
  ↓ 返回 SshCommandResult{ok, output, exit_code, stderr, duration}
rust_bridge.py（dispatch_response 唤醒 pending Event）
  ↓ 返回结构化 dict
strands_backend/tools/ssh_command.py（返回 {status:"success", ...}）
  ↓ event_bus.emit_tool_call / emit_agent_message
前端 ai 模块（流式渲染）
```

### 4.3 可并行模块对（基于依赖图）

下列模块对**没有直接依赖关系**，可由不同 subagent 同时改动（前提：都不碰 §3.1 的严格互斥文件）：

| 可并行模块对 A / B | 理由 |
|------------------|------|
| `terminal` / `ai` | 终端 vs AI 面板，独立组件，仅共享 theme |
| `editor` / `translate` | 编辑器 vs 翻译 tooltip，独立 |
| `ssh-explorer` / `git-history` | SSH 远程 vs 本地 git 历史，独立 |
| `markdown` / `preview` | Markdown 预览 vs web 预览，独立 |
| `command-palette` / `statusbar` | 命令面板 vs 状态栏，独立 |
| `Rust ssh` / `Rust fs` | SSH 后端 vs 文件系统后端，独立 crate |
| `Rust pty` / `Rust ssh` | 本地 PTY vs SSH 远程（注意：dev-state §七 计划并入 rendererPool 后会紧耦合） |
| `docs` / 任何代码模块 | 文档独立 |
| `translate` / `skills` | 两个魔改独有模块，互不依赖 |
| `Python strands_backend` / `Rust ssh::ssh_command` | Python 适配层 vs Rust 命令实现，独立语言/crate（注意：参数 + 返回结构契约需同步，改任一方需在 §4.5 表中核对） |
| `Python strands_backend/model_adapter.py` / `Rust ssh` | LLM 模型适配 vs SSH 后端，完全独立（model_adapter 不调 ssh_command） |
| `Python event_bus.py` / `Python agents/base.py`（除 emit_mock_warning 外） | 事件总线 vs agent 基类，仅在 emit_mock_warning 签名处耦合，改其他部分可并行 |
| `Python strands_backend` / `Python byoa/` | Strands 适配层 vs BYOA 适配器，独立 agent 后端 |
| `Python strands_backend/tools/log_analyzer.py` / `strands_backend/tools/network_diagnostic.py` | 5 个运维工具之间无直接依赖，可并行改（共享 ToolContext 但接口稳定） |

### 4.4 不可并行模块对（紧耦合）

| 不可并行模块对 A / B | 理由 |
|--------------------|------|
| `App.tsx` / 任何模块 | App 是顶层壳，改它会牵动整树 |
| `lib.rs` / 任何 Rust 模块 | 命令注册中心，改它影响所有 invoke |
| `package.json` / 任何前端模块 | 依赖变更全局影响 |
| `Cargo.toml` / 任何 Rust 模块 | 同上 |
| `tabs` / `terminal` / `editor` / `preview` / `markdown` / `ai-diff` | tabs 是 tagged union，kind 加新值需协调所有 tab 类型 |
| `theme` / 任何用 theme token 的模块 | theme 改 = 所有模块重新验证颜色 |
| `shortcuts` / 任何模块 | shortcuts 是横切，注册全局快捷键 |
| `editor` / `lsp` | editor 依赖 lsp 的 diagnosticsReporter |
| `source-control` / `git-history` | source-control 复用 git-history 的 GraphRail |
| `Rust pty` / `Rust ssh`（并入 rendererPool 后） | 见 dev-state §七，transport seam 之后会紧耦合 |
| `terminal` / `ssh-explorer`（深度集成后） | SSH 终端并入 rendererPool 后紧耦合 |
| `ai` / `agents` | agents 的通知桥依赖 ai |
| `ai` / `skills` | skills 依赖 ai 的工具调用 |
| `Rust sidecar` / `Rust sandbox` | sandbox 被 sidecar 调用做高危命令拦截 |
| `Python strands_backend/adapter.py` / `Python rust_bridge.py` | adapter.invoke 的工具调用经 rust_bridge.send_request 阻塞等响应，紧耦合（dev-state §十三 P1-3） |
| `Python strands_backend/adapter.py` / `Python strands_backend/model_adapter.py` | adapter._get_or_create_agent 用 model_adapter.create_strands_model 注入 model，紧耦合 |
| `Python strands_backend/tools/ssh_command.py` / `Rust ssh::ssh_command` | 参数（sessionId/command/timeout）+ 返回结构（SshCommandResult）契约紧耦合，改任一方需同步 |
| `Python event_bus.py` / `Python agents/base.py` | base._publish_mock_warning 调 event_bus.emit_mock_warning，签名 + EventType 枚举紧耦合（dev-state §十二 P1-b 修复） |
| `Python strands_backend/tools/ssh_command.py` / `Python event_bus.py` | ssh_command.py 高危命令调 emit_needs_you 推送审批事件，EventType + payload 结构紧耦合 |
| `Python rust_bridge.py` / `Rust lib.rs`（ipc_invoke 路由） | rust_bridge.send_request 调用的 method 名需在 Rust 侧 ipc_invoke 路由注册，紧耦合 |

### 4.5 改动影响分析表（改 X 文件会影响哪些文件）

> **使用方式**：派发 subagent 任务前，主 agent 查此表确认改动是否会牵动其他文件。被影响文件需在 subagent 自检中重新跑相关测试。

#### 前端关键文件影响表

| 改动的文件 | 直接影响（必须重新验证） | 间接影响（建议重新验证） | 验证手段 |
|-----------|----------------------|----------------------|---------|
| `src/app/App.tsx` | 几乎所有模块（Provider 树 + 布局） | 全树 | 五绿全过 + tauri:dev + CDP 实测 |
| `src/app/components/WorkspaceSurface.tsx` | `tabs` / `terminal` / `editor` / `preview` / `markdown` / `ssh-explorer` | tab 切换逻辑 | tauri:dev 切 tab 验证不卸载 |
| `src/modules/tabs/lib/useTabs.ts` | 所有 tab 类型组件（`EditorStack` / `TerminalStack` / `PreviewStack` / `MarkdownStack`） | App.tsx | 五绿 + tauri:dev 开关 tab |
| `src/modules/terminal/lib/rendererPool.ts` | `TerminalPane` / `useTerminalSession` / 待并入的 `SshTerminalHost` | App.tsx | tauri:dev 本地终端 + SSH 终端 |
| `src/modules/terminal/lib/useTerminalSession.ts` | `TerminalPane` / `TerminalStack` / `pty-bridge` | tabs | 五绿 + tauri:dev 本地终端回归 |
| `src/modules/terminal/lib/pty-bridge.ts` | `useTerminalSession` | rendererPool | typecheck + tauri:dev |
| `src/modules/ssh-explorer/sshStore.ts` | `SshExplorer` / `SshFileTree` / `SshTerminalHost` / `useRemoteFileTree` / `EditorStack`（远程 tab 透传 sessionId）/ `useDocument`（getRustSessionId 实时查 sessions） | App.tsx | 五绿 + tauri:dev SSH 自动连 + 文件树展开 + 远程文件可编辑（commit a4e6084 后 SshFileEditor 已删，远程编辑走 EditorStack） |
| `src/modules/ssh-explorer/SshTerminalHost.tsx` | `WorkspaceSurface` / `rendererPool`（深度集成后） | tabs | tauri:dev SSH 终端可见可交互 |
| `src/modules/explorer/lib/useRemoteFileTree.ts` | `FileExplorer` | App.tsx | tauri:dev 远程文件树展开（5316 项压力测试） |
| `src/modules/explorer/FileExplorer.tsx` | `useFileTree` / `useRemoteFileTree` / App.tsx | tabs | tauri:dev 本地 + 远程文件树 |
| `src/modules/editor/lib/useDocument.ts` | `EditorPane` / `EditorStack` | tabs | 五绿 + tauri:dev 打开本地/远程文件 |
| `src/modules/theme/ThemeProvider.tsx` | 所有 UI 模块（context） | 全树 | 五绿 + tauri:dev 切主题 |
| `src/modules/theme/useThemeFileEditing.ts` | `ThemeProvider` | 全树（曾是卡死根因，CLAUDE.md §3 红线 4） | tauri:dev + PerformanceObserver 验证 measure 0 次 |
| `src/modules/ai/lib/composer.tsx` | 所有 ai 子组件（`AiComposerProvider`） | 全树 | 五绿 + tauri:dev AI 面板 |
| `src/modules/shortcuts/shortcuts.ts` | `useGlobalShortcuts` → 所有模块 | 全树 | 五绿 + tauri:dev 验证快捷键 |
| `src/lib/ssh-bridge.ts` | `sshStore` / `SshConnectDialog` / `SshTerminalHost` | App.tsx | 五绿 + tauri:dev SSH 连接 |
| `src/lib/sftp-bridge.ts` | `sshStore` / `useRemoteFileTree` / `useDocument`（按 `tab.remote` 分流 `sftpRead`/`sftpWrite`/`sftpStat`）/ `EditorPane` | explorer | tauri:dev SFTP 读写 + 远程文件编辑（commit a4e6084 后远程编辑已并入 `EditorStack`，不再走 `SshFileEditor`） |
| `src/lib/pty-bridge.ts` | `useTerminalSession` | terminal | typecheck + tauri:dev 本地终端 |
| `src/store/runtime.tsx` | 凡引用 `SshSessionStateValue` 等类型处 | 全树 | typecheck |

#### Rust 关键文件影响表

| 改动的文件 | 直接影响 | 间接影响 | 验证手段 |
|-----------|---------|---------|---------|
| `src-tauri/src/lib.rs` | 所有 Rust 模块（invoke_handler） | 全前端 | cargo check + 五绿 + tauri:dev |
| `src-tauri/src/modules/ssh/session.rs` | `ssh-bridge` 的所有 SSH 命令 | `sshStore` | cargo check + tauri:dev SSH 自动连 + shell 常驻 |
| `src-tauri/src/modules/ssh/handler.rs` | `session.rs`（事件处理） | `ssh:host_verify` 前端事件 | cargo check + tauri:dev 主机验证弹窗 |
| `src-tauri/src/modules/ssh/credentials.rs` | `ssh-bridge`（凭据 API） | `sshStore` | cargo check + tauri:dev 凭据持久化 |
| `src-tauri/src/modules/pty/session.rs` | `pty-bridge` | `useTerminalSession` | cargo check + tauri:dev 本地终端 |
| `src-tauri/src/modules/sidecar.rs` | 前端 ai（可选） | sidecar-bridge | cargo check + 手动跑 sidecar/main.py |
| `src-tauri/src/modules/fs/*` | `sftp-bridge` / `useFileTree`（远程分流） | explorer | cargo check + tauri:dev 本地文件树 |
| `src-tauri/src/modules/secrets.rs` | `ssh-bridge` / `ai` 的 keyring | sshStore | cargo check + tauri:dev 凭据 |
| `src-tauri/tauri.conf.json` | 启动链（窗口/devUrl/CSP/CDP） | 全前端 | tauri:dev 重启验证窗口可见 |
| `src-tauri/capabilities/default.json` | 所有 invoke（权限） | 全前端 | tauri:dev 验证 show() 不被拦截 |

#### Python sidecar 关键文件影响表（魔改独有，dev-state §十二~§十五 集成）

| 改动的文件 | 直接影响（必须重新验证） | 间接影响（建议重新验证） | 验证手段 |
|-----------|----------------------|----------------------|---------|
| `src-tauri/sidecar/strands_backend/adapter.py` | `strands_backend/tools/*`（全部 5 个工具的 ctx 注入 + make_all_ops_tools）/ `strands_backend/model_adapter.py`（model 注入）/ `main.py`（set_backend 注册段） | 前端 ai 模块（流式响应）/ `event_bus.emit_agent_message` | pytest（test_strands_model_adapter）+ `TDSF_AGENT_BACKEND=strands python .tdsf-data/test_strands_e2e.py` |
| `src-tauri/sidecar/strands_backend/model_adapter.py` | `adapter.py`（_get_or_create_agent 用 strands_model）/ `strands_backend/__init__.py`（configure_strands 自动注入） | 所有 `strands_backend/tools/`（LLM 调用链路）/ `core/llm_config.py`（LLMConfig 共享） | pytest（test_strands_model_adapter 23 测试）+ 端到端 LLM 调用验证 |
| `src-tauri/sidecar/strands_backend/tools/ssh_command.py` | `rust_bridge.py`（ipc_invoke("ssh_command") 调用签名需同步）/ `event_bus.emit_needs_you`（高危命令审批协议） | 前端 `AiToolApproval.tsx`（审批协议需同步）/ Rust `ssh::ssh_command` 命令（参数 + 返回结构需同步） | pytest（test_tools）+ 改 Rust 时加 cargo check + tauri:dev SSH 工具调用实测 |
| `src-tauri/sidecar/rust_bridge.py` | 所有 `strands_backend/tools/`（ssh_command / remote_file 等调 Rust 必经此桥）/ `main.py`（dispatch_response 路由） | Rust 侧 `ipc_invoke` 路由（ssh_command / sftp_read / sftp_write / sftp_stat） | pytest（test_rust_bridge）+ 端到端 Strands 工具调用验证 |
| `src-tauri/sidecar/event_bus.py` | `agents/base.py`（emit_mock_warning / emit_needs_you）/ `strands_backend/adapter.py`（emit_agent_message / emit_tool_call）/ `MockLLMWarning.tsx` + `AgentStatusPill` + needs-you listener | 未来 ApprovalHook（dev-state §十五 backlog）/ `event.history` JSON-RPC 方法 | pytest（test_event_bus）+ tauri:dev 验证前端事件订阅 |

#### 配置文件影响表

| 改动的文件 | 影响 | 验证 |
|-----------|------|------|
| `package.json` | 全前端依赖 | `pnpm install` + 五绿全过 |
| `pnpm-lock.yaml` | 全前端依赖 | `pnpm install` 验证 lock 一致 |
| `src-tauri/Cargo.toml` | 全 Rust 依赖 | `cargo build` + 五绿 |
| `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | typecheck 方式 | `pnpm typecheck` |
| `vite.config.ts` | dev server / 构建 | `pnpm build:web` + `pnpm tauri:dev` |
| `eslint.config.js` | lint 规则 | `pnpm lint` |
| `src-tauri/Cargo.lock` | Rust 依赖图 | `cargo build` |

---

## 5. 主工作树原则（不用 git worktree）

### 5.1 为什么不用 git worktree

业界主流（juejin/51cto 多篇文章）推荐 git worktree 隔离并行 agent。但**本项目明确不用 worktree**，理由（来自 dev-state.md §八 实测踩坑）：

1. **HMR 不可见**：worktree 是独立工作目录，看不到运行中主 dev server 的 HMR 改动。改前端 TS 后，worktree 看不到效果，必须重启 dev server。
2. **CDP 单实例**：app 带 CDP 端口 9222 单实例。worktree 起的 dev server 用不同端口，但 Tauri app 的 CDP 只在 9222。worktree 无法共享主 app 的运行态。
3. **多 worktree 切换易乱**：本项目曾因 AI 改乱工作区导致大恢复（CLAUDE.md §0），多 worktree 切换是污染源。
4. **Vite 端口冲突**：Vite dev server strictPort 9300，多 worktree 起多个 dev server 会端口冲突。
5. **Windows 原子写**：dev-state.md §八 实测，`tauri dev` 本轮不自动重编 Rust（Windows 原子写），多 worktree 会让 Rust 编译更混乱。

业界反例（参考）：dimileeh 的「别再用 Git Worktrees 并行运行 AI 编程智能体了」指出 worktree 无法隔离端口/数据库/依赖/进程，建议用 Docker（AWF）。但 Docker 对本项目太重（Tauri 桌面 app 需要 GUI 实测，容器内不方便），且本项目以单工作树 + 文件锁已足够。

### 5.2 主工作树协作方式

所有 agent 在**同一主工作树**（`d:\ai\linux教学一体\tdsf-terminal-agent-clone`）操作：

1. **文件锁机制**（§3.2）避免冲突
2. **改动后立即 commit 固化**（五绿全过后）
3. **不 commit 半成品**（除非标 `WIP:` 前缀，且明确告知后续 agent）
4. **dev server 单实例**：主 agent 持有 dev server（9300 + 9222），subagent 不起 dev server
5. **subagent 改前端 TS 后**：依赖主 agent 的 dev server HMR 验证；subagent 自己只跑 typecheck/lint/test
6. **subagent 改 Rust 后**：subagent 只跑 `cargo check`，主 agent 重启 dev server 验证

### 5.3 主 agent 持有运行态与写权（场景 C 核心）

主 agent 全程持有：
- **dev server**（`pnpm tauri:dev`，端口 9300 + CDP 9222）
- **CDP 连接**（用于实测，见 §8）
- **git 提交权**（subagent 完成后由主 agent 集成 + commit）
- **`src/` 和 `src-tauri/` 的写权**（场景 C 时；场景 B 时按模块锁让渡给 subagent）

subagent 不持有运行态，只做：
- 静态代码改动（typecheck/lint/test 自检）
- 调研类任务（网络搜索 + clone + 分析，不改主工作树）
- 文档撰写
- 静态代码审计

**写权让渡规则**（场景 B）：
- 主 agent 派发场景 B 任务时，**临时**把指定模块目录的写权让给 subagent
- 让渡期间主 agent **不得**改该模块目录（避免与 subagent 冲突）
- subagent 完成并返回自检后，写权回归主 agent，主 agent 集成时改该模块视为「主 agent 持有」

---

## 6. 进度同步规范

### 6.1 唯一进度源：`docs/dev-state.md`

**`docs/dev-state.md` 是本项目唯一的进度记忆源**。任何 agent 的 session 状态都必须最终落到这里。

- 不使用项目外记忆（旧的 `.trae-cn/project_memory`、`.qoder/plans` 之外的临时文件）
- 不在对话上下文里保留进度（上下文会 compaction 丢失）
- 不依赖 git log（git log 是 commit 历史，不是进度描述）

### 6.2 更新责任

| 场景 | 更新责任 | 更新位置 |
|------|---------|---------|
| 场景 A（调研） | 主 agent | dev-state.md 追加交接章 + 「多 agent 协作情况」节 |
| 场景 B（独立模块修复） | 主 agent（subagent 不直接改 dev-state.md） | 同上 |
| 场景 C（主+sub 协作） | 主 agent | 同上 |
| 单 agent 顺序接手 | 当前 agent | 追加新交接章 |

**铁律**：subagent **永远不直接改 `docs/dev-state.md`**（§3.1 协调互斥，由主 agent 统一更新）。subagent 的进度通过自检报告返回给主 agent，主 agent 汇总后写入。

### 6.3 更新时机（强制保存）

以下时机必须立即更新 `docs/dev-state.md`：

| 时机 | 触发条件 | 保存内容 |
|------|---------|---------|
| 用户明示 | 用户说「保存记忆 / 接手 / 今天到此 / 提交」 | 全量交接章 |
| 里程碑达成 | 五绿全过 + tauri:dev 实测通过 | 完成项 + 改动文件 + 下一步 |
| 阻塞 | 遇无法自解的阻塞（环境/依赖/上游差异） | 阻塞描述 + 已尝试方案 + 求助点 |
| 新踩坑 | 发现新的污染/踩坑（违反 CLAUDE.md §3 红线） | 红线补充建议 + 根因 + 解法 |
| 全绿且可运行 | 五绿全过 + tauri:dev 实测通过 | **立即 git commit 固化**（安全回滚点） |
| subagent 完成 | 每个 subagent 完成子任务返回 | 主 agent 在交接章追加「多 agent 协作情况」 |
| 场景切换 | A→B / B→C / 单 agent → 多 agent | 协作模式变更说明 + 文件锁状态 |

### 6.4 更新内容格式（交接章模板，强制使用）

每次 session 结束前，**追加**新章节到 `docs/dev-state.md` 末尾（不覆盖历史章节）：

```markdown
## §<N> 交接指南（YYYY-MM-XX · 接手先读这节）

### 记忆 / 规划文件在哪
| 文件 | 作用 |
|------|------|
| `docs/dev-state.md`（本文件） | 唯一进度/问题记忆源 |
| `CLAUDE.md` | 开发规范 + 架构地图 + 防污染红线 + 五绿门禁 |
| `docs/MULTI-AGENT-WORKFLOW.md` | 多 agent 协作规范 |
| `<plan 文件绝对路径>` | 已批准的实施计划（如有） |
| `<其他相关文件>` | ... |

### 本 session 已完成/确认
1. 完成 <完成项 1，含 file:line>
2. 完成 <完成项 2>

### 本 session 改动的文件（标注保留/还原）
- 保留 <文件 1>：<改动说明>
- 保留 <文件 2>：<改动说明>
- 还原 <文件 3>：<改动说明>（诊断用，发布前还原）

### 多 agent 协作情况（本节仅多 agent session 填）
- 协作场景：A / B / C（见 MULTI-AGENT-WORKFLOW.md §1）
- 主 agent：<任务描述>，持有 <文件清单>，状态 <完成/进行中/阻塞>
- subagent-A：<任务描述>，持有 <文件清单>，状态 <完成/进行中/阻塞>
- subagent-B：...
- 文件锁状态：见 docs/.agent-locks.md（已清空 / 仍有 X 持有 Y）
- 集成顺序：<subagent 完成顺序 + 主 agent 集成步骤>
- 冲突处理：<无 / 描述 + 解法>

### 接手下一步
按 <plan 文件或本节描述> 分 N 步：
1. #<编号> <步骤描述>
2. ...

### 实测法（务必用）
- 起 dev：`pnpm tauri:dev`（app 开机自动连 `root@192.168.45.200`，无需手点）
- 读运行态：`node C:\Users\Lenovo\AppData\Local\Temp\cdp-read.mjs`（连 CDP 9222）
- 抓 Rust 日志：`tauri_plugin_log` 无视 `RUST_LOG`，用 `lib.rs` 的 `.level_for("russh", Debug)`
- 端口踩坑：后台跑 dev，kill 后 vite+app 子进程残留占 9300/9222，须 `taskkill //F //T //PID <PID>` 清干净

### 剩余 backlog
- ...
```

### 6.5 上下文交接的「数据契约」

参考 AWS AGENTOPS01-BP02 的 handoff data contract，本项目交接的最小数据集：

| 字段 | 内容 | 必填 |
|------|------|------|
| `task_description` | 当前任务的一句话描述 | 是 |
| `completed_work` | 已完成的项（含 file:line） | 是 |
| `failed_approaches` | 试过但失败的方法（避免后续 agent 重复踩） | 是 |
| `next_steps` | 下一步具体步骤 | 是 |
| `memory_artifacts` | 关联文件路径（plan/dev-state/上游参考） | 是 |
| `handoff_reason` | 为什么交接（用户明示/阻塞/session 结束） | 是 |
| `lock_state` | 当前文件锁状态（如有 subagent 未完成） | 多 agent 时必填 |
| `collaboration_scenario` | A / B / C（见 §1） | 多 agent 时必填 |

参考 ctx-handoff 工具的六段式 brief（objective / state / completed / failed / next / raw），本项目简化为上表 8 字段。

---

## 7. 五绿门禁责任

### 7.1 五绿门禁是完成的唯一标准

```bash
pnpm typecheck   # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint        # eslint . --max-warnings 0，0 错误 0 警告（注：上游用 biome，本项目魔改保留 eslint）
pnpm test        # vitest run，当前 832 全过
pnpm build:web   # tsc -p app + vite build，成功出 dist
pnpm tauri:dev   # 桌面端实测：窗口可见 + 能点击 + 目标功能真的工作
```

豁免规则（来自 CLAUDE.md §4）：
- 只能在 `eslint.config.js` 显式配置并注明理由（如终端 ANSI 文件的 `no-control-regex`、best-effort 空 catch 的 `allowEmptyCatch`）
- 禁止散落 `// @ts-ignore`、大段 `eslint-disable`
- tsconfig 用 per-project `-p` 检查（理由：pnpm 隔离布局下 composite 会误报 TS2742）

### 7.2 subagent 完成自检（强制四项）

每个 subagent 完成子任务后，**返回主 agent 前**必须自检并报告（见 §9.4 模板）：

```markdown
## subagent 自检报告

### 1. 改动的文件清单
- <文件 1 绝对路径>：<改动说明>
- <文件 2 绝对路径>：<改动说明>

### 2. 跑的门禁
- pnpm typecheck：<通过/失败，失败附错误>
- pnpm lint：<通过/失败>
- pnpm test：<通过/失败，失败附用例>
- pnpm build:web：<未跑/通过/失败>（subagent 可选）
- pnpm tauri:dev：<未跑>（subagent 不持有运行态，由主 agent 验证）
- cargo check：<未跑/通过/失败>（仅改 Rust 时必跑）

### 3. 依赖变更
- 新增依赖：<无/列表>（如有，需主 agent 确认 + pnpm install）
- 删除依赖：<无/列表>

### 4. 互斥文件触碰
- 严格互斥文件：<未碰/碰了哪些>（如碰了，说明理由 + 主 agent 是否授权）
- 0 字节源文件检查：<无/有，列出>（CLAUDE.md §3 红线 1）
```

### 7.3 主 agent 集成验证

所有 subagent 完成后，主 agent 做：

1. **收集所有 subagent 自检报告**
2. **按 §11.3 拆分策略集成**（一个 subagent 接入一次 → 跑前三绿 → 通过才接下一个）
3. **跑五绿全过**（typecheck + lint + test + build:web + tauri:dev）
4. **CDP 实测**（连 9222，读 `window.__TDSF_DBG__`、DOM、计算样式，见 §8）
5. **本地终端回归**（PTY pwsh 仍正常）
6. **SSH 回归**（自动连 `root@192.168.45.200`，shell 常驻、SFTP 可用）
7. **commit 固化**（见 §11 提交规范）
8. **更新 dev-state.md**（追加交接章，记录多 agent 协作情况）

### 7.4 门禁失败的回退

若主 agent 集成时发现门禁失败：

1. 用 `git diff` 定位是哪个 subagent 的改动引入
2. 主 agent 用 Edit 反向编辑修复（**禁止 `git checkout`/`reset`/`restore` 已跟踪文件**，CLAUDE.md §0 铁律 3）
3. 修复后重跑五绿
4. 仍失败则报告用户（AskUserQuestion）

### 7.5 各场景门禁责任矩阵

| 场景 | typecheck | lint | test | build:web | tauri:dev | cargo check |
|------|-----------|------|------|-----------|-----------|-------------|
| A（调研） | 不跑 | 不跑 | 不跑 | 不跑 | 不跑 | 不跑 |
| B（独立模块修复，subagent） | **必跑** | **必跑** | **必跑** | 可选 | 不跑 | 改 Rust 时必跑 |
| B（主 agent 集成） | **必跑** | **必跑** | **必跑** | **必跑** | **必跑** | 改 Rust 时必跑 |
| C（subagent，仅文档） | 不跑 | 不跑 | 不跑 | 不跑 | 不跑 | 不跑 |
| C（主 agent） | **必跑** | **必跑** | **必跑** | **必跑** | **必跑** | 改 Rust 时必跑 |

---

## 8. CDP 与 dev server 实测责任

### 8.1 端口单实例约定

本项目运行态端口是**单实例**，同一时间只能一个 agent 持有：

| 端口 | 用途 | 持有者 |
|------|------|--------|
| 9300 | Vite dev server（strictPort） | 主 agent |
| 9222 | Tauri WebView2 CDP 远程调试 | 主 agent |

**铁律**：
- subagent **不起** `pnpm tauri:dev`（端口冲突）
- subagent **不连** CDP 9222（单实例）
- 主 agent 全程持有 dev server；subagent 改前端后由主 agent HMR 验证

### 8.2 各场景实测责任

| 场景 | dev server | CDP 实测 | 责任人 |
|------|-----------|---------|--------|
| A（调研） | 不需要 | 不需要 | 无 |
| B（subagent） | 不持有 | 不连接 | subagent 只跑静态门禁；HMR/CDP 由主 agent 验证 |
| B（主 agent 集成） | 持有 | 连接 | 主 agent |
| C（subagent 仅文档） | 不持有 | 不连接 | 无 |
| C（主 agent 主线） | 持有 | 连接 | 主 agent |

### 8.3 CDP 实测脚本（来自 dev-state.md §八）

```bash
# 连 9222，读 window.__TDSF_DBG__、DOM、计算样式
node C:\Users\Lenovo\AppData\Local\Temp\cdp-read.mjs
```

注意：chrome-devtools MCP **连不上** app webview（自开空白 Chrome），不要用。

CDP 临时让出（仅场景 C，subagent 需要实测时）：
1. subagent 报告主 agent 需要实测
2. 主 agent 暂停 CDP 连接
3. subagent 临时连接 9222 跑断言
4. subagent 测完归还，主 agent 重新连接

### 8.4 端口清理

后台跑 dev 后，`TaskStop`/kill 残留 vite+app 子进程占 9300/9222：

```powershell
# 找占 9300 / 9222 的 PID
netstat -ano | findstr ":9300 :9222"
# 清干净
taskkill //F //T //PID <PID>
```

主 agent 在重启 dev server 前必须先清端口，否则新 dev server 起不来。

### 8.5 Rust 改动需手动重启 dev

dev-state.md §八 实测：本轮 `tauri dev` **不自动重编 Rust**（Windows 原子写）。改 Rust 后需手动重启 dev server。改前端 TS 走 Vite HMR 会热更。

**多 agent 场景**：
- subagent 改 Rust 后，只跑 `cargo check` 自检，**不重启 dev server**
- subagent 在自检报告中标注「改了 Rust，需主 agent 重启 dev 验证」
- 主 agent 收到报告后，清端口 → 重启 dev → CDP 实测

### 8.6 日志抓取

Rust 日志（来自 dev-state.md §八）：
- `RUST_LOG` 对 `tauri_plugin_log` **无效**
- 用 `lib.rs` 的 `.level_for("russh", Debug)` 等显式开启
- 靠**开机自动连 SSH**触发（无需手点），Monitor + `tee` + `grep` 全自动抓

日志归档：`docs/reports/logs/<date>-<task>.log`（如有需要保留，多 agent 共享读，只主 agent 写）。

---

## 9. subagent 任务分配

### 9.1 适合 subagent 的任务

| 类型 | 例子 | 场景 | subagent 模型选择 |
|------|------|------|------------------|
| 独立模块代码实现 | 改 `terminal/lib/rendererPool.ts`（不碰 App.tsx） | B | general-purpose |
| 调研类 | 网络搜索 + clone 开源项目 + 分析 | A | general-purpose / Explore（只读） |
| 静态代码审计 | 审计 `ssh-explorer` 模块可用性 | A | Explore（只读）或 general-purpose |
| 文档撰写 | 撰写本规范、撰写报告 | A / C | general-purpose |
| 测试编写 | 给 `translate` 模块补 vitest 测试 | B | general-purpose |
| 单文件 bug 修复 | 改 `theme/useThemeFileEditing.ts` 的自反循环 | B | general-purpose |
| Rust 单模块修复 | 改 `src-tauri/src/modules/sidecar.rs` 的 restart 退避 | B | general-purpose |

### 9.2 不适合 subagent 的任务（主 agent 独占）

| 类型 | 理由 |
|------|------|
| 改 `src/app/App.tsx` | 严格互斥，1600 行主壳 |
| 改 `src-tauri/src/lib.rs` | 严格互斥，命令注册中心 |
| 改 `package.json` / `pnpm-lock.yaml` | 严格互斥，依赖变更 |
| 改 `src-tauri/tauri.conf.json` | 严格互斥，启动配置 |
| 改 `src-tauri/capabilities/default.json` | 严格互斥，权限 |
| 启动链改动 | 窗口/权限/main.tsx，需主 agent 实测 |
| 依赖变更 | 需主 agent 确认 + pnpm install |
| 涉及多模块协同 | 需主 agent 集成 |
| 集成验证（五绿 + tauri:dev + CDP） | 主 agent 持有运行态 |
| 改 `docs/dev-state.md` | 协调互斥，主 agent 统一更新 |
| 改 `docs/MULTI-AGENT-WORKFLOW.md`（本文件） | 协调互斥 |

### 9.3 subagent 任务派发模板（主 agent 派发时复制填空）

```markdown
## 任务背景
- 项目根：`d:\ai\linux教学一体\tdsf-terminal-agent-clone`
- 项目身份：`crynta/terax-ai` v0.8.6 魔改版（Tauri 2 + React 19 + TypeScript + Rust + Python sidecar）
- 当前分支：`terax-clone-v0`（无远程，本地仓库）
- 协作场景：A / B / C（见 MULTI-AGENT-WORKFLOW.md §1）
- 你的任务边界：**只改** `<文件清单>`，**不可碰** `<互斥文件清单 + 其他模块>`

## 必读文档（按 §2.1 顺序）
1. `CLAUDE.md` —— 开发规范 + 防污染红线 + 五绿门禁
2. `docs/MULTI-AGENT-WORKFLOW.md` —— 多 agent 协作规范（特别是 §3 文件锁、§7 自检、§9.4 自检报告模板）
3. `docs/dev-state.md` —— 进度，特别是末尾「§<N> 交接指南」
4. `<相关 plan 或报告的绝对路径>`

## 接手声明（§2.4，必填后回执）
<copy §2.4 模板，填入你的身份 / 可改文件 / 不可碰文件 / 协作场景>

## 任务步骤
1. <步骤 1>
2. <步骤 2>
3. ...

## 改动影响预判（§4.5，主 agent 已替你核对）
- 你改的文件会影响：<列出，主 agent 已确认你的范围不越界>
- 你**不可碰**的关联文件：<列出，如需改需回报主 agent>

## 验证（自检报告必填，见 §9.4）
- `pnpm typecheck`：必须 0 错误
- `pnpm lint`：必须 0 错误 0 警告
- `pnpm test`：必须 832 全过（或与基线一致）
- `pnpm build:web`：可选（如改了构建相关）
- `cargo check`：改 Rust 时必跑
- `pnpm tauri:dev`：**不要跑**（主 agent 持有运行态）

## 约束（违反即任务失败）
1. **禁止改互斥文件**：`<互斥文件清单>`（见 MULTI-AGENT-WORKFLOW.md §3.1）
2. **禁止 `git checkout`/`reset`/`restore` 已跟踪文件**（CLAUDE.md §0 铁律 3）
3. **禁止 `git add -A`/`git add .`**（用具体文件名，CLAUDE.md 防污染）
4. **禁止自动 `git commit`**（除非任务明示要求；commit 由主 agent 集成时做）
5. **禁止起 `pnpm tauri:dev`**（主 agent 持有 dev server，端口 9300/9222 单实例）
6. **禁止连 CDP 9222**（主 agent 持有）
7. **禁止改 `package.json`/`Cargo.toml`/`pnpm-lock.yaml`/`Cargo.lock`**（依赖变更需主 agent 确认）
8. **禁止改 `docs/dev-state.md`**（记忆源由主 agent 统一更新）
9. **禁止改 `docs/MULTI-AGENT-WORKFLOW.md`**（规范由主 agent 独占）
10. **改完跑门禁前三绿**（typecheck + lint + test；改 Rust 加 cargo check），失败则修复后重跑
11. **返回时附 §9.4 的自检报告**
12. **遇阻即报**：环境问题/无法闭环时及时反馈主 agent，不强行带病开发

## 回滚点
- 当前最近 commit：<hash>
- 若任务失败，主 agent 会用 Edit 反向编辑撤销你的改动（不 git checkout）

## 完成标准
- 改动文件清单完整
- 五绿前三绿全过（typecheck + lint + test；改 Rust 加 cargo check）
- 自检报告附在返回消息中
- 未碰任何互斥文件
- 接手声明已填回执
```

### 9.4 subagent 自检报告模板（完成任务后返回）

```markdown
## subagent 自检报告

### 0. 接手声明回执（§2.4）
- Agent 标识：<main / subagent-A / ...>
- 协作场景：A / B / C
- 实际改动的文件清单：<列出，与接手声明一致 / 若不一致说明原因>

### 1. 改动的文件清单
- <文件 1 绝对路径>：<改动说明>
- <文件 2 绝对路径>：<改动说明>

### 2. 跑的门禁
- pnpm typecheck：<通过/失败，失败附错误>
- pnpm lint：<通过/失败，失败附错误>
- pnpm test：<通过/失败，失败附用例>（基线 832 全过，本次 <N> 全过）
- pnpm build:web：<未跑/通过/失败>（subagent 可选）
- cargo check：<未跑/通过/失败>（仅改 Rust 时必跑）
- pnpm tauri:dev：<未跑>（subagent 不持有运行态，由主 agent 验证）

### 3. 依赖变更
- 新增依赖：<无/列表>（如有，需主 agent 确认 + pnpm install）
- 删除依赖：<无/列表>

### 4. 互斥文件触碰
- 严格互斥文件：<未碰/碰了哪些>（如碰了，说明理由 + 主 agent 是否授权）
- 模块互斥文件：<未碰/碰了哪些>
- 0 字节源文件检查：<无/有，列出>（CLAUDE.md §3 红线 1）

### 5. 改动影响（§4.5）
- 我的改动会影响：<列出影响文件，主 agent 集成时需验证>
- 已自验证：<哪些影响已自测，哪些留给主 agent>

### 6. Rust 改动标注（仅改 Rust 时填）
- 改了 Rust：<是/否>
- 若是，需主 agent 重启 dev server 验证（Windows 原子写，HMR 不重编 Rust）

### 7. 阻塞与遗留
- 阻塞：<无/描述 + 求助点>
- 遗留：<无/描述，留给主 agent 处理>
```

### 9.5 派发实例（本项目 2026-07-30 实际案例）

> **例外说明**：本规范本身由 subagent-C 撰写（v2.0），这是 §13 红线 13「subagent 不直接改本规范」的**授权例外**——经主 agent 派发 + 用户确认后，subagent 在场景 A 撰写/更新本规范是允许的。此实例即该例外的真实案例。

主 agent 派发本规范撰写任务（场景 A）的实例：

```markdown
## 任务背景
- 项目根：d:\ai\linux教学一体\tdsf-terminal-agent-clone
- 项目身份：crynta/terax-ai v0.8.6 魔改版
- 协作场景：A（调研 + 文档撰写，只写 docs/MULTI-AGENT-WORKFLOW.md）
- 任务边界：只创建/改 docs/MULTI-AGENT-WORKFLOW.md，不可碰任何代码文件

## 必读文档
1. CLAUDE.md
2. docs/dev-state.md（特别是 §八）
3. docs/reports/upstream-terax-architecture.md（模块依赖图基础）
4. docs/OPEN-SOURCE-AND-MODIFICATIONS.md

## 任务步骤
1. Skill 调用 dispatching-parallel-agents 获取最佳实践
2. 读项目已有规范（CLAUDE.md / dev-state.md / 上游架构报告）
3. 梳理本项目模块依赖图（src/modules/ + src-tauri/src/modules/）
4. 产出规范文档，覆盖更新 docs/MULTI-AGENT-WORKFLOW.md

## 验证
- 文档存在
- 包含 A/B/C 三场景分层
- 模块依赖图节点数 ≥ 30（前端 23 + Rust 14）
- subagent 任务模板 ≥ 1 个可复制
- 接手声明模板 ≥ 1 个可复制
- 改动影响分析表 ≥ 20 行
- 中文输出，不堆 emoji

## 约束
- 禁止改除 docs/MULTI-AGENT-WORKFLOW.md 外的任何文件
- 禁止 git commit
- 不需要跑门禁（纯文档）
```

---

## 10. 冲突解决

### 10.1 文件冲突（两个 agent 同时改了同一文件）

若发现两个 agent 改了同一文件（主 agent 派发失误或 subagent 越界）：

1. **立即停止**双方改动
2. 主 agent 用 `git diff` 看双方改动
3. **手动合并**（用 Edit 反向编辑，不用 `git checkout`/`merge`/`stash`）
4. 合并后跑五绿验证
5. 在 dev-state.md 记录冲突原因 + 解法（防重复踩）

### 10.2 设计冲突（两个 agent 改动方向不一致）

若两个 subagent 改动方向冲突（例如 A 把 SSH 终端并入 rendererPool，B 又独立补 SshTerminalPane）：

1. 报告主 agent
2. 主 agent 用 AskUserQuestion 询问用户（不擅自决策，CLAUDE.md §7 决策边界）
3. 用户拍板后，被否决的 subagent 改动**用 Edit 反向编辑撤销**（不 `git checkout`）
4. 在 dev-state.md 记录决策

### 10.3 依赖冲突（subagent 引入了互斥依赖变更）

若 subagent 自检报告里写了「新增依赖」：

1. 主 agent 评估：是否真必要？能否用现有依赖实现？
2. 必要 → 主 agent 独占 `package.json`/`Cargo.toml`，用 `pnpm add`/`cargo add` 添加，跑 `pnpm install`/`cargo build`
3. 不必要 → subagent 用 Edit 撤销依赖引入，改用现有依赖
4. 永远不让 subagent 直接改 `package.json`/`Cargo.toml`（CLAUDE.md §3 红线 3）

### 10.4 主工作树优先原则（场景 C 冲突解决）

本项目不用 git worktree（§5.1），因此**不存在 rebase/merge 场景**。多 agent 冲突时遵循「主工作树优先」：

| 冲突类型 | 解决规则 |
|---------|---------|
| 主 agent vs subagent 改同一文件 | **主 agent 保留**，subagent 改动作废，主 agent 用 Edit 反向编辑撤销 subagent 改动 |
| subagent-A vs subagent-B 改同一文件 | 后声明的让位（§3.3），主 agent 重新分配 |
| subagent 越界改严格互斥文件 | subagent 改动**立即作废**，主 agent 用 Edit 反向编辑撤销，记录到 dev-state.md |
| subagent 改了未声明的文件 | 视同越界，主 agent 评估：合理 → 补登记文件锁；不合理 → 撤销 |

**撤销规则**（CLAUDE.md §0 铁律 3 重申）：
- 撤销 subagent 改动**只能用 Edit 反向编辑**
- **禁止** `git checkout <file>` / `git reset --hard` / `git restore <file>`（已跟踪文件）
- **禁止** `git stash`（易丢改动）

---

## 11. 提交规范

### 11.1 commit message 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type**：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `style` / `build` / `ci`
- **scope**：模块名（`terminal` / `ssh` / `editor` / `ai` / `sidecar` / `theme` / `explorer` / `translate` / `docs` / `config` / `multi-agent` ...）
- **subject**：简述（祈使句，首字母小写，不超过 50 字符）
- **body**：改动清单 + 验证结果（五绿状态 + tauri:dev 实测结果）
- **footer**：关联 plan 文件路径 / 关联 dev-state.md 章节 / 多 agent 协作说明

实例（单 agent 修复）：

```
feat(ssh): fix pty terminal_modes causing early eof

- request_pty terminal_modes from malformed &[(TTY_OP_END,0)] to empty &[]
- request_pty/shell want_reply false→true (confirm accepted)
- reader_task add Success/Failure branch logging
- handler.rs add disconnected() override (catch disconnect reason)

Verified:
- typecheck/lint/test(832) all pass
- tauri:dev: shell常驻、SFTP可用、reader first data: 129 bytes
- log: channel request Success (pty/shell accepted), no early eof

Refs: docs/dev-state.md §八, C:\Users\Lenovo\.qoder\plans\still-crest-linnet.md
```

实例（多 agent 协作，场景 B 集成）：

```
feat(ssh): integrate ssh terminal into rendererPool

Multi-agent collaboration (scenario B):
- main: integrated transport seam + WorkspaceSurface/App.tsx wiring
- subagent-A: implemented SshTerminalHost.tsx (transport factory + allocId)
- subagent-B: added useTerminalSession openTransport injection + remote guard

Verified:
- typecheck/lint/test(832)/build:web all pass
- tauri:dev: SSH terminal visible, monospace font, local terminal regression ok
- CDP: --terminal-foreground/#1a1a1a → matched local token

Refs: docs/dev-state.md §九, plan still-crest-linnet.md #15-#20
```

实例（纯文档，场景 A）：

```
docs(multi-agent): add A/B/C scenario layered collaboration spec

- add scenario A (research, low risk) / B (independent module fix, medium) / C (main+sub, high)
- add handoff declaration template (§2.4)
- add change impact analysis table (§4.5, 20+ rows)
- add CDP/dev server responsibility section (§8)
- add commit split strategy (§11.3)

Refs: docs/dev-state.md §八
```

### 11.2 何时提交

| 时机 | 是否提交 | 理由 |
|------|---------|------|
| 五绿全过 + tauri:dev 实测通过 | **立即提交** | 安全回滚点（CLAUDE.md §6） |
| 五绿前三绿过（typecheck/lint/test），但 tauri:dev 未实测 | 不提交 | 桌面端 bug 只在 Tauri 首屏暴露（CLAUDE.md §4） |
| 仅 typecheck 过 | 不提交 | 半成品 |
| subagent 完成 | 不提交 | 由主 agent 集成时提交 |
| 纯文档改动（如本规范） | 主 agent 提交 | 不需 tauri:dev 实测 |
| WIP 半成品（需切换 session） | 标 `WIP:` 前缀提交 + 在 dev-state.md 注明 | 防止丢失，但明确告知后续 agent |

### 11.3 commit 拆分策略（多 agent 改动如何拆）

多 agent 集成时，主 agent 按**模块/职责**拆分 commit，不混在一起：

| 场景 | 拆分策略 | commit 数 |
|------|---------|----------|
| A（多 subagent 调研） | 每个调研报告一个 `docs(reports):` commit；或全部合并一个 `docs(reports): add N research reports` | 1 ~ N |
| B（多 subagent 改独立模块） | **每个模块一个 commit**：`fix(<scope-A>):` / `fix(<scope-B>):` / ...；主 agent 集成改动单独一个 `chore(integration):` | N + 1 |
| C（主+sub 协作） | subagent 的旁支文档/调研一个 `docs:` commit；主 agent 主线改动按里程碑拆 `feat/fix` | 1 ~ N |
| 单 agent 多步骤 | 每个里程碑一个 commit（五绿过即提交） | N |

**拆分原则**：
1. **一个 commit 一个逻辑变更**（不混合 feat + fix + docs）
2. **同模块的多个 subagent 改动**可合并一个 commit（如多个 terminal/ 内修复）
3. **跨模块改动**必须拆分（除非是集成层如 App.tsx/lib.rs）
4. **集成层 commit** 单独一个，标注「Multi-agent collaboration」+ 列出参与 subagent
5. **commit 顺序**：底层先行（Rust → 前端桥 → 前端模块 → 集成层 App.tsx）

### 11.4 提交安全规则（来自 CLAUDE.md）

- **禁止 `git add -A` / `git add .`**（用具体文件名，防误加 .env/credentials/大文件）
- **禁止 `git push --force` / `--force-with-lease`**（除非用户明示）
- **禁止 push 到 main/master**（本项目无远程，但养成习惯）
- **禁止 `git checkout`/`reset`/`restore` 已跟踪文件**（CLAUDE.md §0 铁律 3）
- **禁止改 git config**
- **禁止 `git rebase -i` / `git add -i`**（交互式，工具不支持）
- commit message 用 HEREDOC 传（保证格式）

---

## 12. 接手检查脚本

接手 AI 一键跑的检查脚本（PowerShell，复制到项目根执行）：

```powershell
# === TDSF Terminal Agent 接手检查脚本 ===
# 在项目根 d:\ai\linux教学一体\tdsf-terminal-agent-clone 跑

Write-Host "=== 1. git 状态 ===" -ForegroundColor Cyan
git status
Write-Host ""

Write-Host "=== 2. 最新 commit ===" -ForegroundColor Cyan
git log -1
Write-Host ""

Write-Host "=== 3. pnpm typecheck ===" -ForegroundColor Cyan
pnpm typecheck
Write-Host ""

Write-Host "=== 4. pnpm lint ===" -ForegroundColor Cyan
pnpm lint
Write-Host ""

Write-Host "=== 5. pnpm test ===" -ForegroundColor Cyan
pnpm test
Write-Host ""

Write-Host "=== 6. dev-state.md 末尾交接指南 ===" -ForegroundColor Cyan
# 读 dev-state.md 末尾 80 行
Get-Content docs\dev-state.md -Tail 80
Write-Host ""

Write-Host "=== 7. 文件锁状态 ===" -ForegroundColor Cyan
if (Test-Path docs\.agent-locks.md) {
    Get-Content docs\.agent-locks.md
} else {
    Write-Host "无锁文件（正常，运行时生成）"
}
Write-Host ""

Write-Host "=== 8. 端口占用检查 ===" -ForegroundColor Cyan
netstat -ano | findstr ":9300 :9222"
Write-Host ""

Write-Host "=== 检查完成，对照 §2.2 接手检查清单逐项确认 ===" -ForegroundColor Green
```

---

## 13. 防污染红线（重申，每条都是血泪教训）

来自 `CLAUDE.md` §3，本规范重申并扩展为多 agent 场景：

| 红线 | 单 agent 场景 | 多 agent 场景扩展 |
|------|-------------|------------------|
| 1. 0 字节源文件 = 污染信号 | 先从 .bak/上游/git 历史恢复 | subagent 自检报告必填「无 0 字节文件」（§9.4 第 4 项） |
| 2. 禁止 git checkout/reset/restore 已跟踪文件 | 用 Edit 反向编辑撤销 | subagent 越界改文件时，主 agent 用 Edit 反向编辑撤销，不 git checkout（§10.4） |
| 3. 改依赖只用 pnpm add/remove | 改完 pnpm install | subagent 不直接改 package.json，报告主 agent（§10.3） |
| 4. useEffect 依赖禁止自反 | ref 存 cleanup 资源 | subagent 改 theme/ai 模块前先读 CLAUDE.md §3 红线 4 |
| 5. Context Provider value 用 useMemo | 回调用 useCallback | subagent 改 composer.tsx/ThemeProvider 前先读上游 |
| 6. zustand selector 别返回新引用 | 用 useShallow | subagent 改任何 store 前先读 CLAUDE.md §3 红线 6 |
| 7. 启动/窗口/权限问题先比对上游 terax | 不自创 | subagent 改启动链前报告主 agent，主 agent 比对上游 |
| 8. 五绿门禁 + tauri:dev 实测 | 全过才算完成 | subagent 跑前三绿，主 agent 跑后两绿（build:web + tauri:dev）（§7.5） |

新增多 agent 场景红线：

9. **subagent 不起 dev server**（端口单实例，主 agent 持有，§8.1）
10. **subagent 不连 CDP 9222**（主 agent 持有，§8.1）
11. **subagent 不直接 commit**（主 agent 集成时 commit，§11.3）
12. **subagent 不改 docs/dev-state.md**（记忆源由主 agent 统一更新，§6.2）
13. **subagent 不直接改 `docs/MULTI-AGENT-WORKFLOW.md`**（规范默认由主 agent 独占；**例外**：经主 agent 派发授权 + 用户确认后，subagent 可在场景 A 撰写/更新本规范，§9.5 实例即此例外的真实案例）
14. **subagent 自检报告必填**（§9.4，不填 = 任务未完成）
15. **subagent 接手声明必填**（§2.4，未声明就改 = 越界）
16. **改 Rust 后 subagent 只跑 cargo check**，重启 dev 由主 agent 做（§8.5）

---

## 14. 当前 session 多 agent 并行实例（2026-07-30）

记录本 session 如何用多 agent 并行（作为后续 session 的参考样板）：

### 14.1 任务编排

| Agent | 场景 | 任务 | 持有文件 | 状态 |
|-------|------|------|---------|------|
| main | C | SSH 终端深度集成 #15-#20（执行 plan `still-crest-linnet.md`） | `src/app/App.tsx`、`src/modules/ssh-explorer/`、`src/modules/terminal/`、`src-tauri/src/modules/ssh/`、`src-tauri/src/lib.rs`（还原 russh=debug） | 进行中 |
| subagent-A | A | 调研运维 agent 开源项目（网络搜索 + clone + 分析） | `docs/reports/ops-agent-opensource-research-2026-07-30.md` | 完成 |
| subagent-B | A | 审计魔改 agent 可用性（静态代码审计） | `docs/reports/modded-agent-usability-audit-2026-07-30.md` | 完成 |
| subagent-C | A | 撰写本规范文档（v2.0 覆盖更新） | `docs/MULTI-AGENT-WORKFLOW.md` | 完成 |

### 14.2 协作流程

1. 主 agent 读 dev-state.md §八，确认任务边界（互斥文件清单）
2. 主 agent 在 `docs/.agent-locks.md` 声明持有的文件 + 派发 3 个 subagent 的输出文件
3. 主 agent 派发 3 个 subagent（每个用 §9.3 模板，明确边界 + 约束 + 接手声明回执要求）
4. subagent 各自工作（不互碰，subagent-A/B/C 都只改 `docs/reports/` 和 `docs/MULTI-AGENT-WORKFLOW.md`，与主 agent 的代码改动无交集）
5. subagent 完成后返回 §9.4 自检报告
6. 主 agent 集成验证（五绿 + tauri:dev + CDP）
7. 主 agent 更新 dev-state.md（追加「§九 交接指南」，记录多 agent 协作情况）
8. 主 agent 按 §11.3 拆 commit 固化

### 14.3 并行收益

- 主 agent 专注 SSH 集成关键路径，不被调研/审计/文档分心
- subagent-A 的开源调研为后续魔改 agent 选型提供依据
- subagent-B 的可用性审计暴露魔改 agent 的潜在问题
- subagent-C 的本规范为后续多 agent 协作奠定基础
- 四个任务并行完成，总耗时 ≈ 最长任务（主 agent SSH 集成）的耗时

---

## 15. 附录：业界调研引用

本规范的若干设计参考了业界最佳实践（WebSearch 调研 + skill 调用，非凭记忆）：

| 来源 | 借鉴点 | 本规范对应章节 |
|------|-------|--------------|
| Anthropic Claude Code subagents 官方文档 | subagent 独立上下文窗口、工具限制、权限 | §9 subagent 任务分配 |
| OpenAI Agents SDK Handoffs | handoff 是数据契约、上下文传递 | §6.5 上下文交接数据契约 |
| AWS AGENTOPS01-BP02（multi-agent handoff） | 结构化 context package、escalation path、deadlock 检测 | §6 进度同步、§10 冲突解决 |
| GALDUR 体系五条机器纪律 | 提交再交接、工作区声明、提交前置守卫 | §3.2 互斥声明机制、§11 提交规范 |
| ctx-handoff 工具六段式 brief | objective/state/completed/failed/next/raw | §6.4 交接章模板 |
| Loop Engineering 五动作 | 发现-交付-验证-持久化-持久记忆 | §6 进度同步、§7 门禁 |
| dimileeh「别再用 Git Worktrees」 | worktree 无法隔离端口/数据库/依赖/进程 | §5 主工作树原则 |
| juejin/51cto「git worktree 多 agent」实践 | 文件锁串行化、一次只合并一个分支 | §3 文件锁、§11 提交 |
| Cognition「Multi-Agents: What's Actually Working」 | 多 agent 写入权分离、判断权归主 agent | §5.3 主 agent 持有运行态、§9.2 不适合 subagent 的任务 |
| `dispatching-parallel-agents` skill | 「Dispatch one agent per independent problem domain」、focused/self-contained/specific output 三原则、when NOT to use（related failures / shared state） | §1 三场景分层、§4.3/4.4 可并行判定、§9.3 派发模板 |
| `task-coordination-strategies` skill | 文件 ownership 拆分、dependency graph、acceptance criteria | §3 文件锁、§4 模块依赖图、§9.4 自检报告 |

---

## 16. 演进与反馈

本规范是活文档，遇以下情况更新（由主 agent 独占改动 + 用户确认）：

- 发现新的多 agent 协作踩坑（追加到 §13 红线表）
- 业界有新的最佳实践值得借鉴（追加到 §15 引用表）
- 本项目架构调整（如新增模块、移除模块 → 更新 §4 依赖图与 §4.5 影响表）
- 五绿门禁阈值变化（如 test 数从 832 变更 → 更新 §7.1 / §7.5 / §12 脚本）
- 协作场景扩展（如新增场景 D：跨 IDE 协作）

更新方式：直接 Edit 本文件 + 在 dev-state.md 记录变更原因。

---

## 17. 多 agent 与 sidecar 异步执行的协作规则

> **背景**：P1-NEW-1（`docs/reports/modded-agent-code-review-2026-07-30.md` §2）修复后，sidecar 主循环引入 `ThreadPoolExecutor` 异步执行慢方法。本节定义多 agent 改 sidecar 时的协作硬约束，避免回退到「单线程主循环阻塞 ping → health_check 误判 Crashed」的旧坑。
> **适用范围**：任何 agent（主 / sub）改 `src-tauri/sidecar/main.py` 主循环、`_slow_methods`、`_main_executor`、或新增 JSON-RPC method 时必读。

### 17.1 慢方法清单（`_slow_methods`）

**当前清单**（`main.py:129`）：

```python
_slow_methods: frozenset[str] = frozenset({"agent.invoke"})
```

**判定标准**（新方法是否应加入 `_slow_methods`）：

| 判定 | 加入 `_slow_methods` | 留在同步派发 |
|------|---------------------|-------------|
| 调用 LLM API（HTTP 请求，30-60s+） | ✅ `agent.invoke` 已在 | — |
| 调用 `rust_bridge.send_request`（阻塞等 Rust 响应 30s） | ✅ 应加入（如未来把工具调用直接暴露为 RPC method） | — |
| 调用 `strands_backend/adapter.py` invoke 链 | ✅ 间接经 agent.invoke | — |
| 纯内存操作（dict 查找 / 状态读取） | — | ✅ `ping` / `agent.list` / `sidecar.health` |
| event_bus.publish（pub-sub，微秒级） | — | ✅ |
| 文件读写（配置加载，<100ms） | — | ✅ |

**红线**：新加 JSON-RPC method 时，若该方法**可能耗时 >5s**（LLM 调用 / rust_bridge 阻塞 / 大文件读写），**必须**加入 `_slow_methods`，否则将回退到 P1-NEW-1 的主循环阻塞问题。

### 17.2 subagent 不能阻塞主循环

**主循环职责分离**（`main.py:790-871` 修复后）：

```
主循环（主线程）          _main_executor（worker 线程，max_workers=2）
─────────────────         ─────────────────────────────────────
读 stdin（阻塞）           agent.invoke 执行
  ↓                         ↓
解析 JSON-RPC              call_llm（HTTP 30-60s+）
  ↓                         ↓
慢方法？→ submit 到 executor    Strands Agent 工具调用
快方法？→ 同步 dispatch           ↓
  ↓                         rust_bridge.send_request（阻塞 30s）
写 stdout（_write_lock 保护）    ↓
  ↓                         send_response（_write_lock 保护）
继续读 stdin（不阻塞）         ↓
                          完成
```

**多 agent 协作规则**：

1. **subagent 改 sidecar 时，不得把慢方法改回同步派发**。若需移除 `_main_executor`（如重构为 asyncio），必须先在自检报告中说明替代方案，主 agent 审核后才可改。
2. **subagent 不得在主循环内直接调用 `agent.invoke` / `call_llm` / `rust_bridge.send_request`**（即使是在 `try/except` 内），这些必须走 `_main_executor.submit` 或经 `agent.invoke` 间接调用。
3. **subagent 新增的 JSON-RPC method 若调用了上述慢路径**，必须同步加入 `_slow_methods`（§17.1 判定标准）。

### 17.3 并发 `max_workers=2` 的约束

**当前值**（`main.py:783-784`）：

```python
_main_executor = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="sidecar-async",
)
```

**为什么是 2**（来自 `main.py:127-128` 注释）：

- 允许一个 `agent.invoke` 在跑时，另一个工作线程处理同时到达的慢方法（罕见但可能，如前端并发发两个 agent.invoke）
- 同时避免并发过多 LLM 调用导致资源紧张（LLM API 通常有 RPM 限制，DeepSeek 默认 60 RPM）

**多 agent 协作规则**：

1. **subagent 不得擅自调高 `max_workers`**（如改成 4/8）。调高会导致：
   - LLM API 限流（DeepSeek 60 RPM，4 并发易触发）
   - `_write_lock` 争用加剧（多个 worker 同时写 stdout）
   - Strands Agent 实例并发创建（`adapter._get_or_create_agent` 非线程安全部分可能出问题）
2. **subagent 不得擅自调低 `max_workers`**（如改成 1）。调低会回退到 P1-NEW-1 的阻塞问题（一个 agent.invoke 跑时，第二个慢方法排队等待，主循环的 ping 仍能响应，但第二个 agent.invoke 会等第一个完成才开始）。
3. **若业务确需调整 `max_workers`**（如新增批量 agent.invoke 场景），subagent 必须在自检报告中说明：
   - 调整后的值
   - 理由（为什么 2 不够）
   - 验证方案（LLM RPM 限制测试 + 并发写 stdout 压测）
   - 主 agent 审核后才可改

### 17.4 退出清理的协作规则

**当前退出清理**（`main.py:877-882`）：

```python
if _main_executor is not None:
    try:
        _main_executor.shutdown(wait=True, cancel_futures=True)
        logger.info("slow method executor shutdown complete")
    except Exception as e:
        logger.debug(f"executor shutdown on exit: {e}")
```

**多 agent 协作规则**：

1. **subagent 不得移除 `_main_executor.shutdown` 调用**。移除会导致 worker 线程在主进程退出时被强杀，正在执行的 agent.invoke 响应丢失（前端收到 timeout 而非正常错误）。
2. **subagent 不得把 `wait=True` 改为 `wait=False`**。`wait=False` 会立即返回，不等待正在执行的 agent.invoke 完成，响应丢失。
3. **若 subagent 改了退出清理逻辑**，必须在自检报告中验证：
   - 启动 sidecar → 发 agent.invoke → 立即 stop sidecar → 确认前端收到 error 响应（非 timeout）

### 17.5 异步执行状态的健康检查

**接手时必查**（配合 §2.4 接手声明的「当前 sidecar 异步执行状态」字段）：

```bash
# 确认 _slow_methods / _main_executor 已注入
grep -n "_slow_methods\|_main_executor" src-tauri/sidecar/main.py
# 预期输出：
# :48:from concurrent.futures import ThreadPoolExecutor
# :129:_slow_methods: frozenset[str] = frozenset({"agent.invoke"})
# :130:_main_executor: ThreadPoolExecutor | None = None
# :782:    global _main_executor
# :783:    _main_executor = ThreadPoolExecutor(
# :784:        max_workers=2,
# :842:            if _main_executor is not None and method in _slow_methods:
# :877:    if _main_executor is not None:
# :879:            _main_executor.shutdown(wait=True, cancel_futures=True)
```

若上述 grep 无输出 = 异步执行被回退 = **立即停止开发**，用 AskUserQuestion 报告主 agent。

---

## 18. SSH 终端深度集成后的文件锁扩展

> **背景**：SSH 终端深度集成（dev-state §七~§九，plan `still-crest-linnet.md` #15-#20）引入了 `SshTerminalHost.tsx` / `TerminalTransport` 接口 / `useTerminalSession` 远程分支。这些文件形成紧耦合三元组，多 agent 改动时需特别协调。
> **适用范围**：任何 agent 改 `src/modules/ssh-explorer/SshTerminalHost.tsx` / `src/modules/terminal/lib/useTerminalSession.ts` / `src/modules/terminal/lib/pty-bridge.ts`（含 `TerminalTransport` 接口）时必读。

### 18.1 紧耦合三元组的锁规则

**三元组关系**（基于 §4.1 依赖图）：

```
TerminalTransport 接口（pty-bridge.ts）
        ↑                   ↑
        │                   │
useTerminalSession.ts ──── SshTerminalHost.tsx
（消费接口，本地+远程共用）   （远程分支，构造 transport 注入）
```

**锁规则**：

| 改动场景 | 锁定文件 | 理由 |
|---------|---------|------|
| 改 `TerminalTransport` 接口签名（如加方法 / 改返回类型） | `pty-bridge.ts` + `useTerminalSession.ts` + `SshTerminalHost.tsx` **三文件同时锁** | 接口变更，所有实现 + 消费者都要同步改 |
| 改 `useTerminalSession` 的 `openTransport` 工厂签名（`:81`/`:1014`） | `useTerminalSession.ts` + `SshTerminalHost.tsx`（远程分支） | 工厂签名变更，远程构造处要同步 |
| 改 `SshTerminalHost` 的 transport 构造逻辑（`:72-77`） | 仅 `SshTerminalHost.tsx` | 不影响接口，可独立改 |
| 改 `useTerminalSession` 的本地 PTY 分支 | 仅 `useTerminalSession.ts` | 不影响远程分支，可独立改 |
| 改 `rendererPool` 的 xterm 实例复用逻辑 | 仅 `rendererPool.ts` | 但需验证本地 + SSH 终端都不回归（§4.5 影响表） |

### 18.2 多 agent 并行改三元组的判定

**不可并行**（紧耦合）：

| 不可并行模块对 A / B | 理由 |
|--------------------|------|
| `pty-bridge.ts`（接口）/ `useTerminalSession.ts` | 接口变更需同步消费者 |
| `pty-bridge.ts`（接口）/ `SshTerminalHost.tsx` | 接口变更需同步远程实现 |
| `useTerminalSession.ts` / `SshTerminalHost.tsx`（深度集成后） | SSH 终端并入 rendererPool 后紧耦合（§4.4 已列） |

**可并行**（独立）：

| 可并行模块对 A / B | 理由 |
|------------------|------|
| `useTerminalSession.ts`（本地分支）/ `SshTerminalHost.tsx`（远程分支，不改 transport 工厂） | 分支独立，仅共享接口 |
| `rendererPool.ts`（xterm 复用）/ `SshTerminalHost.tsx`（transport 构造） | 不同层，rendererPool 不关心 transport 来源 |

### 18.3 改动影响验证清单

改三元组任一文件后，subagent 自检报告中必须验证：

- [ ] **本地终端回归**：`pnpm tauri:dev` → 打开本地终端 → 输入命令 → 确认正常
- [ ] **SSH 终端回归**：`pnpm tauri:dev` → 连 SSH → 打开 SSH 终端 → 输入命令 → 确认正常
- [ ] **tab 切换不卸载**：本地终端 + SSH 终端同时开 → 切换 tab → 切回 → 确认终端内容不丢
- [ ] **resize 回归**：调整窗口大小 → 确认本地 + SSH 终端都正确 fit（`useTerminalSession.ts:524` 注释 resize 返回 `Promise<void>|void`）

**注**：subagent 不持有 dev server，上述 tauri:dev 验证由主 agent 在集成时做。subagent 只跑 typecheck + lint + test，并在自检报告「改动影响」节标注「需主 agent tauri:dev 验证本地 + SSH 终端回归」。

### 18.4 TerminalTransport 接口变更的协议

若 subagent 需改 `TerminalTransport` 接口（如加 `suspend` / `resume` 方法以支持 AgentSSH 范式借鉴，见 §20）：

1. **先报告主 agent**（不直接改），说明：
   - 加什么方法
   - 为什么需要（哪个借鉴项目 / 哪个 P2 任务）
   - 本地 PTY 分支如何实现（`pty-bridge.ts` 的 `openPty` 工厂）
   - 远程 SSH 分支如何实现（`SshTerminalHost.tsx` 的 transport 构造）
2. 主 agent 用 AskUserQuestion 询问用户确认
3. 用户确认后，主 agent 派发场景 B 任务：一个 subagent 改 `pty-bridge.ts`（接口 + 本地实现），另一个 subagent 改 `SshTerminalHost.tsx`（远程实现）
4. 两个 subagent 完成后，主 agent 集成 + tauri:dev 实测

---

## 19. Strands 适配层协作红线

> **背景**：Strands 适配层（`src-tauri/sidecar/strands_backend/` + `agents/__init__.py` 的 `set_backend`/`clear_backend`）是 sidecar 的核心后端注入点。P1-NEW-2 修复了 `set_backend` 的 walrus hack，但 `_global_backend_override` 的单写者原则仍需明确。
> **适用范围**：任何 agent 改 `src-tauri/sidecar/agents/__init__.py` 的 `set_backend` / `clear_backend` / `_global_backend_override`、或 `strands_backend/adapter.py`、或 `main.py` 启动段的后端注入逻辑时必读。

### 19.1 `set_backend` / `clear_backend` 调用权限

**当前实现**（`agents/__init__.py:168-210`，P1-NEW-2 修复后）：

```python
_global_backend_override: BackendInvokeCallable | None = None

def set_backend(backend: BackendInvokeCallable) -> None:
    global _global_backend_override
    if not callable(backend):
        raise TypeError(f"set_backend expects callable, got {type(backend).__name__}")
    _global_backend_override = backend
    logger.info(f"backend override set: {getattr(backend, '__name__', repr(backend))}")

def clear_backend() -> None:
    global _global_backend_override
    if _global_backend_override is not None:
        _global_backend_override = None
        logger.info("backend override cleared")
```

**调用权限矩阵**：

| 调用方 | `set_backend` | `clear_backend` | 理由 |
|--------|:---:|:---:|------|
| `main.py` 启动段（`TDSF_AGENT_BACKEND=strands` 时，`:428-502` feature flag 分支） | ✅ 允许 | ❌ 不调 | 仅启动时注入一次 |
| `main.py` 退出段（`:877-882` 之后） | ❌ 不调 | ✅ 允许 | 退出时清理 |
| `strands_backend/adapter.py` | ❌ 禁止 | ❌ 禁止 | adapter 只提供 callable，不直接调 set_backend |
| `strands_backend/model_adapter.py` | ❌ 禁止 | ❌ 禁止 | model_adapter 只创建 model，不碰后端注入 |
| `strands_backend/tools/*.py` | ❌ 禁止 | ❌ 禁止 | 工具只读后端状态，不写 |
| `agents/base.py` | ❌ 禁止 | ❌ 禁止 | BaseAgent 只读 `_global_backend_override`（经 `invoke_agent`） |
| `event_bus.py` | ❌ 禁止 | ❌ 禁止 | 事件总线不碰后端注入 |
| subagent（任何场景） | ❌ 禁止 | ❌ 禁止 | 后端注入是主 agent 独占职责 |

**红线**：

1. **subagent 不得在任何文件中调用 `set_backend` / `clear_backend`**。这两个函数是 `main.py` 启动/退出段的独占职责。
2. **subagent 不得在 `strands_backend/adapter.py` / `model_adapter.py` / `tools/*.py` 中 import `set_backend` / `clear_backend`**。若需传递后端 callable，应通过函数参数（如 `StrandsAgentAdapter(adapter_invoke_callable)`），不通过全局变量。
3. **若 subagent 需新增后端类型**（如 PydanticAI 备选），必须：
   - 在 `strands_backend/` 旁边新建 `pydanticai_backend/` 目录（不混入 strands_backend）
   - 实现 `PydanticAIAgentAdapter`（提供 callable）
   - 在 `main.py` 启动段加 `TDSF_AGENT_BACKEND=pydanticai` 分支（**此分支由主 agent 改**，subagent 只提供 adapter 实现）

### 19.2 `_global_backend_override` 单写者原则

**当前单写者**：`main.py` 启动段（`set_backend`）+ 退出段（`clear_backend`）。

**多 agent 协作规则**：

1. **`_global_backend_override` 是全局变量，单写者**（`main.py` 主线程）。subagent 不得在 worker 线程（`_main_executor` 的 worker）中读写此变量。
2. **`invoke_agent`（`agents/__init__.py:300-302`）读取 `_global_backend_override` 是线程安全的**（Python GIL 保护单条赋值语句），但 subagent 不得在 `invoke_agent` 之外的地方读 `_global_backend_override`。
3. **subagent 不得把 `_global_backend_override` 改成 `dict` / `list` 等可变容器**（如 `{name: callable}` 按 agent 名切换后端）。当前设计是「全局单一后端」，改为多后端会破坏 `invoke_agent` 的优先级逻辑。

### 19.3 Strands `tools/` 与 Rust `ssh_command` 的依赖图

**当前依赖链**（基于 §4.2.1）：

```
strands_backend/tools/ssh_command.py
  ↓ rust_bridge.ipc_invoke("ssh_command", {sessionId, command, timeout})
rust_bridge.py（send_request_to_rust，阻塞 30s）
  ↓ JSON-RPC 反向请求
Rust sidecar.rs（handle_reverse_request，:958-1148）
  ↓ 路由到 ssh_command Tauri 命令
Rust ssh::ssh_command（exec 模式，非 PTY）
  ↓ russh channel exec
SSH 远程主机
  ↓ 返回 SshCommandResult{ok, output, exit_code, stderr, duration}
rust_bridge.py（dispatch_response 唤醒 pending Event）
  ↓ 返回结构化 dict
strands_backend/tools/ssh_command.py（返回 {status:"success", ...}）
```

**契约紧耦合点**（改任一方需同步）：

| 契约点 | Python 侧 | Rust 侧 | 同步要求 |
|--------|-----------|---------|---------|
| 参数名 | `sessionId` / `command` / `timeout`（camelCase） | `ssh_command(session_id, command, timeout)` | 改任一方参数名必须同步（K2 已修） |
| 返回结构 | `{"ok":bool,"status":str,"exit_code":int,"stdout":str,"stderr":str}` | `SshCommandResult{ok, output, exit_code, stderr, duration}` | 字段名 + 类型必须同步 |
| 超时 | `rust_bridge.py:68` `DEFAULT_TIMEOUT=30.0` | `sidecar.rs:55` `REQUEST_TIMEOUT=30s` | 叠加超时问题 K9 未修，改任一方需考虑叠加 |
| 高危命令审批 | `ssh_command.py` RiskChecker + `emit_needs_you` | 无（Rust 侧无 RiskChecker） | LearnSSH 借鉴 P2 任务需在 Rust 侧加一层（§20） |

**多 agent 协作规则**：

1. **subagent 改 `strands_backend/tools/ssh_command.py` 的参数 / 返回结构时，必须同步改 Rust `ssh::ssh_command`**。这是 §4.4 已列的不可并行模块对。
2. **subagent 改 `rust_bridge.py` 的 `send_request` 签名 / 超时 / ID 范围时，必须同步改 Rust `sidecar.rs` 的 `handle_reverse_request` + `reader_task`**。
3. **subagent 不得单独改 Python 侧或 Rust 侧的契约**（如只改 Python 参数名不改 Rust），会导致 `rust_bridge.send_request` 返回后 `dispatch_response` 找不到字段。

### 19.4 Strands 适配层改动的自检清单

subagent 改 `strands_backend/` 或 `agents/__init__.py` 后，自检报告中必须验证：

- [ ] **`set_backend` / `clear_backend` 未被 subagent 改动**（若改了，说明越界，§19.1 红线）
- [ ] **`_global_backend_override` 仍是单写者**（`main.py` 启动 + 退出段）
- [ ] **`adapter.py` 的 `invoke` 链路完整**：`_get_or_create_agent` → Strands Agent → `agent(prompt)` → 工具调用 → 返回
- [ ] **`model_adapter.py` 的优雅降级**：未配置 LLMConfig / 未安装 strands / 异常时返回 `None`，不抛
- [ ] **`tools/*.py` 的 passthrough 降级**：Strands 不可用时退化为 passthrough（不报错）
- [ ] **pytest 通过**：`test_strands_model_adapter`（23 测试）+ `test_tools` + `test_rust_bridge`（25 测试）+ `test_event_bus`

---

## 20. 基于 v4 调研的集成路线图协作分工

> **背景**：`docs/reports/ops-agent-opensource-survey-2026-07-v4.md` §8 给出了更新后的 P0/P1/P2/P3 集成路线图（v3 的 12 + v4 的 6 = 18 借鉴项目）。本节把 v4 新增的借鉴点（AgentSSH / OpAgent / LearnSSH / ANOLISA / Open Interpreter / OpenSquilla）转化为可分工的 subagent 任务包，供主 agent 派发时参考。
> **适用范围**：主 agent 规划 P1/P2 阶段任务时，按本节任务包派发 subagent。

### 20.1 P1 阶段任务包（v4 新增 3 项）

#### 任务包 P1-v4-1：OpAgent 三层安全借鉴

**来源**：v4 报告 §5.2 + §8.1 P1 第 8 项

**目标**：扩展 `RiskChecker` 正则 + 新增 `LlmAuditor` 语义审计层 + Fail-safe 机制

**subagent 任务边界**（场景 B）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `src-tauri/sidecar/strands_backend/tools/ssh_command.py`（RiskChecker 扩展） + `src-tauri/sidecar/core/risk.py`（若存在） | 扩展 RiskChecker 正则到 OpAgent PolicyGuard 全集（含破坏性 SQL + 保护路径 /etc/shadow/~/.ssh//proc//sys//dev//boot） |
| subagent-B | `src-tauri/sidecar/strands_backend/llm_auditor.py`（新建） | 新增 LlmAuditor 语义审计层（检测变量间接/混淆/外泄/提权，LLM 只能升级不能降级，出错 fail-safe 升级 needs_you） |
| 主 agent | `src-tauri/sidecar/strands_backend/tools/ssh_command.py`（集成 LlmAuditor） + `src-tauri/sidecar/main.py`（注册 LlmAuditor） | 集成：RiskChecker → LlmAuditor → needs_you 三层链路 |

**不可并行**：subagent-A 和 subagent-B 都改 `ssh_command.py` 的审批链路，但 subagent-A 改 RiskChecker 部分，subagent-B 新建 llm_auditor.py，**集成由主 agent 做**（subagent 不直接改集成点）。

**验收标准**：
- RiskChecker 正则从 10 条扩展到 OpAgent PolicyGuard 全集
- LlmAuditor 检测 4 类语义攻击（变量间接/混淆/外泄/提权）
- Fail-safe：LlmAuditor 出错时升级到 needs_you，不降级
- pytest 覆盖 4 类语义攻击 + Fail-safe 路径

#### 任务包 P1-v4-2：OpenSquilla 自我验证借鉴

**来源**：v4 报告 §5.5 + §8.1 P1 第 9 项

**目标**：在 `fix_loop` 模块新增「红绿回归证据链」

**subagent 任务边界**（场景 B）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `src-tauri/sidecar/agents/debug.py`（若存在 fix_loop）或 `src-tauri/sidecar/tools/fix_loop.py` | 新增红绿回归证据链：先写注定失败的测试 → 修功能让测试由红转绿 → 过项目原有回归测试 |
| 主 agent | 集成 + tauri:dev 实测 | 验证 debug_agent 的验证闭环 |

**验收标准**：
- fix_loop 模块新增红绿回归证据链
- debug_agent 在修复后自动跑回归测试
- 证据链记录到 event_bus（前端可查看）

#### 任务包 P1-v4-3：OpenHarness 工具集规模参考

**来源**：v4 报告 §3.8 + §8.1 P1 第 10 项

**目标**：评估从 5 运维 @tool 扩展到 43 工具的优先级排序

**subagent 任务边界**（场景 A，调研类）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `docs/reports/tool-expansion-priority-2026-07-30.md`（新建） | 参考 OpenHarness Toolkit 43 工具分类，给出 TDSF 从 5 工具扩展到 N 工具的优先级排序 + 实现计划 |

**验收标准**：
- 报告含 43 工具分类法
- 报告含 TDSF 现有 5 工具的差距分析
- 报告含 P1/P2/P3 分批实现计划

### 20.2 P2 阶段任务包（v4 新增 5 项）

#### 任务包 P2-v4-1：AgentSSH 架构借鉴（最重要）

**来源**：v4 报告 §5.1 + §8.1 P2 第 8 项

**目标**：SSH 连接池 + 结构化 JSON 输出 + 长命令 suspend + expect-respond

**subagent 任务边界**（场景 B + 场景 C 混合）：

| subagent / 主 agent | 可写文件 | 任务 | 场景 |
|---------------------|---------|------|------|
| subagent-A | `src-tauri/src/modules/ssh/pool.rs`（新建） | 实现 daemon-pooled 连接池（参考 AgentSSH） | B |
| subagent-B | `src-tauri/sidecar/rust_bridge.py`（返回值格式统一） | `send_request()` 返回值统一为 `{"ok":bool,"status":str,"exit_code":int,"stdout":str,"stderr":str}` JSON 格式 | B |
| subagent-C | `src-tauri/sidecar/strands_backend/tools/ssh_command.py`（suspend_timeout 参数） | 新增 `suspend_timeout` 参数（默认 30s），超时返回 `session_id` 供后续读取 | B |
| 主 agent | `src/modules/ssh-explorer/SshTerminalHost.tsx`（expect-respond）+ `src-tauri/src/modules/ssh/`（集成连接池） | 集成连接池 + SshTerminalPane 的 sudo 交互参考 expect-respond | C |

**不可并行**：
- subagent-B 改 `rust_bridge.py` 返回值格式 = subagent-C 改 `ssh_command.py` 参数 = 契约紧耦合（§19.3），**必须主 agent 协调同步改**
- 主 agent 改 `SshTerminalHost.tsx` = §18 三元组锁定

**验收标准**：
- SSH 连接池实现，`ssh_command` 不再每次重建连接
- `rust_bridge.send_request` 返回 AgentSSH JSON 格式
- 长命令（>30s）suspend 返回 session_id，后续可读取
- SshTerminalHost 的 sudo 交互支持 expect-respond

#### 任务包 P2-v4-2：OpAgent hash-chained 审计链借鉴

**来源**：v4 报告 §5.2 + §8.1 P2 第 9 项

**目标**：所有工具调用决策 + 结果写入 `~/.tdsf-data/audit.db`（SQLite），sha256 前后链

**subagent 任务边界**（场景 B）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `src-tauri/sidecar/audit_chain.py`（新建） | 实现 hash-chained 审计链（SQLite + sha256 前后链，异步写入 + 批量提交） |
| subagent-B | `src-tauri/sidecar/strands_backend/tools/*.py`（所有工具调用点加审计写入） | 在每个工具调用前后写审计记录 |
| 主 agent | 前端审计查看 UI（`/audit list` / `/audit verify`） | 集成审计查看界面 |

**验收标准**：
- `~/.tdsf-data/audit.db` SQLite 数据库
- sha256 前后链，任何事后篡改都会断链
- 异步写入，不影响工具调用性能
- 前端可查看审计记录 + 验证链完整性

#### 任务包 P2-v4-3：LearnSSH 别名机制借鉴

**来源**：v4 报告 §5.3 + §8.1 P2 第 10 项

**目标**：服务器别名层 + 凭据零暴露 + Rust 侧双层 RiskChecker

**subagent 任务边界**（场景 B + C 混合）：

| subagent / 主 agent | 可写文件 | 任务 | 场景 |
|---------------------|---------|------|------|
| subagent-A | `src-tauri/sidecar/strands_backend/tools/ssh_command.py`（别名接收） | sidecar 工具只接收别名（如「教学服务器-1」），不接收 sessionId | B |
| subagent-B | `src-tauri/src/modules/ssh/alias.rs`（新建） | Rust 侧 keyring 按别名解析凭据，返回 sessionId | B |
| 主 agent | `src-tauri/src/modules/ssh/command.rs`（Rust 侧 RiskChecker） + 集成别名层 | Rust 侧 ssh_command 加一层 RiskChecker（双层拦截）+ 别名层兼容 sessionId | C |

**不可并行**：subagent-A 和 subagent-B 是契约紧耦合（别名 → sessionId 解析协议），**必须主 agent 协调同步改**。

**验收标准**：
- sidecar 工具只接收别名，不接触凭据
- Rust 侧 keyring 按别名解析凭据
- Rust 侧 ssh_command 加 RiskChecker（双层拦截）
- 别名层兼容现有 sessionId（P2 先兼容，P3 再完全切换）

#### 任务包 P2-v4-4：ANOLISA Token-Less 借鉴

**来源**：v4 报告 §5.4 + §8.1 P2 第 11 项

**目标**：模式压缩 + 响应压缩 + AgentSight 可观测

**subagent 任务边界**（场景 B）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `src-tauri/sidecar/strands_backend/tools/system_info.py`（新建） | 模式压缩：把高频环境探索（pwd/whoami/uname/ls/cat /etc/os-release）封装为 `get_system_info()` 单工具 |
| subagent-B | `src-tauri/sidecar/strands_backend/tools/log_analyzer.py`（响应压缩） | 响应压缩：长输出自动截断 + 摘要（前 50 行 + 统计 + 关键行） |
| subagent-C | `src-tauri/sidecar/strands_backend/adapter.py`（AgentSight） | AgentSight：在 `TdsfStrandsCallbackHandler` 新增工具调用链 + token 消耗分布 + 延迟采集 |

**可并行**：三个 subagent 改不同文件，无直接依赖。

**验收标准**：
- `get_system_info()` 单工具替代 13 轮 ls/cat/whoami 探索
- `analyze_logs` 长输出自动截断 + 摘要
- AgentSight 采集工具调用链 + token 消耗 + 延迟
- token 消耗降低 30%+

#### 任务包 P2-v4-5：Open Interpreter harness 切换借鉴

**来源**：v4 报告 §5.5 + §8.1 P2 第 12 项

**目标**：模型感知的 agent 配置 + 运行时 harness 切换 UI

**subagent 任务边界**（场景 A，调研类，P2 评估阶段）：

| subagent | 可写文件 | 任务 |
|----------|---------|------|
| subagent-A | `docs/reports/harness-switch-evaluation-2026-07-30.md`（新建） | 评估模型感知 agent 配置（不同模型用不同 system_prompt + 工具格式）的可行性与实现方案 |

**验收标准**：
- 报告含 Open Interpreter harness 切换范式分析
- 报告含 TDSF `model_adapter.py` 现状差距分析
- 报告含 harness 切换 UI 设计方案
- 报告含 P3 实现计划

### 20.3 任务包派发的协作规则

1. **P2-v4-1（AgentSSH）是最重要的 P2 任务**，涉及 §18 三元组 + §19 Strands tools 契约，**必须由主 agent 主导**（场景 C），subagent 只做独立子模块（连接池 / 返回值格式 / suspend 参数）。
2. **P2-v4-2（hash-chained 审计链）和 P2-v4-4（ANOLISA Token-Less）可并行**（不同文件，无依赖）。
3. **P2-v4-3（LearnSSH 别名机制）依赖 P2-v4-1（AgentSSH 连接池）**（别名解析后需走连接池），不可并行，需顺序执行。
4. **所有 P2 任务包的 subagent 自检报告中**，必须额外验证：
   - 是否改了 `set_backend` / `clear_backend`（§19.1 红线，应为「未碰」）
   - 是否改了 `_global_backend_override`（应为「未碰」）
   - 是否改了 `TerminalTransport` 接口（§18.4，若改了需主 agent 确认）
   - 是否改了 Python↔Rust 契约（§19.3，若改了需同步改两侧）

---

## 21. 代码审查 P1 问题预防清单

> **背景**：`docs/reports/modded-agent-code-review-2026-07-30.md` 新发现 4 个 P1 问题（P1-NEW-1/2/3/4），均已修复。本节把每个 P1 沉淀为「提交前自检清单」，每条配 file:line 反例 + 修复范式，供 subagent 自检 + 主 agent 集成时核对。
> **适用范围**：所有 subagent 自检报告（§9.4）+ 主 agent 集成验证（§7.3）必填。

### 21.1 P1-NEW-1：主循环阻塞 → health_check 误判 Crashed

**问题**：Python sidecar 单线程主循环 + 长耗时 `agent.invoke` 阻塞 ping 响应 → `health_check` 30s 无响应判定 Crashed。

**反例 file:line**（修复前）：

```python
# main.py:782（修复前，同步派发）
result = dispatcher.dispatch(method, params)  # agent.invoke 内 call_llm 耗时 30-60s+
if not is_notification:
    send_response(result, req_id)
# 期间主循环卡在 dispatch，不读 stdin，Rust 侧 ping 请求堆积
# → sidecar.rs:1240-1258 HEARTBEAT_TIMEOUT=30s 触发，标记 Crashed
```

**修复范式**（修复后，`main.py:842-851`）：

```python
# 慢方法走线程池，主循环立即继续读 stdin
if _main_executor is not None and method in _slow_methods:
    _main_executor.submit(
        _dispatch_in_executor,
        dispatcher,
        method,
        params,
        req_id,
        is_notification,
    )
    continue  # 主循环不阻塞，继续读 stdin
```

**自检清单**：

- [ ] 新增 JSON-RPC method 时，若可能耗时 >5s（LLM 调用 / rust_bridge 阻塞 / 大文件读写），**必须**加入 `_slow_methods`（`main.py:129`）
- [ ] 不得在主循环内直接调用 `agent.invoke` / `call_llm` / `rust_bridge.send_request`（即使 try/except 包裹）
- [ ] `max_workers=2` 不得擅自调整（§17.3）
- [ ] `_main_executor.shutdown(wait=True, cancel_futures=True)` 不得移除（§17.4）
- [ ] 接手时 grep 确认 `_slow_methods` / `_main_executor` 已注入（§17.5）

### 21.2 P1-NEW-2：set_backend walrus + __import__ hack

**问题**：`agents/__init__.py:196-198` 用 `logger.info(...) if (logger := __import__("logging").getLogger(...)) else None` 反模式，模块顶部未 import logging。

**反例 file:line**（修复前）：

```python
# agents/__init__.py:196-198（修复前，walrus + __import__ hack）
def set_backend(backend: BackendInvokeCallable) -> None:
    ...
    _global_backend_override = backend
    logger.info(
        f"backend override set: {getattr(backend, '__name__', repr(backend))}"
    ) if (logger := __import__("logging").getLogger("sidecar.agents")) else None
    # 问题：模块顶部未 import logging，用 __import__ hack 绕过
    # walrus 操作符在表达式内赋值，logger 作用域仅限该表达式
    # 三元 if ... else None 反模式，写法极度怪异
```

**修复范式**（修复后）：

```python
# 顶部加（模块级）
import logging
logger = logging.getLogger("sidecar.agents")

# set_backend 内改为（正常调用）
def set_backend(backend: BackendInvokeCallable) -> None:
    global _global_backend_override
    if not callable(backend):
        raise TypeError(f"set_backend expects callable, got {type(backend).__name__}")
    _global_backend_override = backend
    logger.info(f"backend override set: {getattr(backend, '__name__', repr(backend))}")
```

**自检清单**：

- [ ] 不得在函数内用 `__import__("...")` hack 绕过 import（应在模块顶部 import）
- [ ] 不得用 walrus `:=` 在表达式内赋值 logger（应在模块顶部 `logger = logging.getLogger(...)`）
- [ ] 不得用 `if ... else None` 三元反模式包裹函数调用（直接调用即可）
- [ ] `set_backend` / `clear_backend` 的调用权限遵循 §19.1 矩阵（仅 main.py 启动/退出段）
- [ ] `_global_backend_override` 单写者原则（§19.2）

### 21.3 P1-NEW-3：主循环异常后 pending 不清理

**问题**：`main.py:780-793` 主循环 except 分支虽有 `send_error`，但若 `send_response` / `send_error` 本身抛异常（stdout 写入失败），或 `dispatcher.dispatch` 内 `call_llm` 因网络异常卡住（socket hang，不抛异常），主循环阻塞，Rust 侧 30s 超时后清理 pending，Python 侧无响应。

**反例 file:line**（修复前，`main.py:780-793`）：

```python
# 修复前：同步派发，dispatch 内 call_llm 卡住时主循环阻塞
try:
    result = dispatcher.dispatch(method, params)  # call_llm 可能 socket hang，不抛异常
    if not is_notification:
        send_response(result, req_id)  # 若 stdout 写入失败，这里抛异常
except JSONRPCError as e:
    ...
    if not is_notification:
        send_error(e.code, e.message, req_id, e.data)
except Exception as e:
    logger.exception(f"unexpected error in method {method}")
    if not is_notification:
        send_error(ERR_INTERNAL_ERROR, str(e), req_id)  # 若 send_error 也抛，主循环外层 except 捕获，但已无法响应
```

**修复范式**（P1-NEW-1 修复后，慢方法走线程池，主循环不阻塞）：

```python
# P1-NEW-1 修复后：慢方法走 _main_executor，主循环不阻塞
# _dispatch_in_executor 内的异常由 worker 线程的 try/except 捕获，调 send_error
# 主循环的 except 仅处理快方法的异常（快方法不会长时间阻塞）
def _dispatch_in_executor(dispatcher, method, params, req_id, is_notification):
    try:
        result = dispatcher.dispatch(method, params)
        if not is_notification:
            send_response(result, req_id)
    except JSONRPCError as e:
        if not is_notification:
            send_error(e.code, e.message, req_id, e.data)
    except Exception as e:
        logger.exception(f"unexpected error in method {method}")
        if not is_notification:
            send_error(ERR_INTERNAL_ERROR, str(e), req_id)
```

**自检清单**：

- [ ] 慢方法（`agent.invoke`）走 `_main_executor`，不在主循环同步派发（§17.2）
- [ ] `_dispatch_in_executor` 内有完整 try/except，异常时调 `send_error`（不静默吞）
- [ ] `send_response` / `send_error` 用 `_write_lock` 保护（线程安全）
- [ ] 若 `send_error` 本身抛异常，worker 线程的 except 捕获并 log（不导致主循环崩溃）
- [ ] 主循环的 except（`main.py:869-871`）仅处理快方法异常 + IO 异常，不处理慢方法异常

### 21.4 P1-NEW-4：composer.tsx useEffect 闭包陷阱

**问题**：`composer.tsx:104-113` 的 useEffect 依赖数组为 `[]`，但闭包了 `attachFileByPath`（每次 render 重新创建），监听器闭包了首次 render 的 `attachFileByPath`。当前不会读旧 state（`attachFileByPath` 内部只用 `setFiles` + `invoke` + `useChatStore.getState()`，都稳定），但未来若在 `attachFileByPath` 里读 `value` 或 `files` state，会读到 mount 时的旧值。

**反例 file:line**（修复前，`composer.tsx:104-113`）：

```typescript
// 修复前：useEffect 依赖 []，闭包了首次 render 的 attachFileByPath
useEffect(() => {
  const onAttach = (e: Event) => {
    const path = (e as CustomEvent<string>).detail;
    if (typeof path === "string" && path.length > 0) {
      void attachFileByPath(path);  // ← 闭包了 attachFileByPath（每次 render 重新创建）
    }
  };
  window.addEventListener("tdsf:ai-attach-file", onAttach);
  return () => window.removeEventListener("tdsf:ai-attach-file", onAttach);
}, []);  // ← 空依赖数组，只在 mount 时注册
// biome-ignore 注释声称"closes over setFiles only"是当前正确但脆弱的假设
```

**修复范式**（修复后）：

```typescript
// 修复后：attachFileByPath 用 useCallback 稳定引用
const attachFileByPath = useCallback(async (path: string) => {
  // ... 现有实现（只用 setFiles / invoke / useChatStore.getState()）
}, []);  // 显式声明依赖为空

useEffect(() => {
  const onAttach = (e: Event) => {
    const path = (e as CustomEvent<string>).detail;
    if (typeof path === "string" && path.length > 0) {
      void attachFileByPath(path);
    }
  };
  window.addEventListener("tdsf:ai-attach-file", onAttach);
  return () => window.removeEventListener("tdsf:ai-attach-file", onAttach);
}, [attachFileByPath]);  // 依赖 attachFileByPath（useCallback 稳定，不会每次 render 触发 re-register）
```

**自检清单**：

- [ ] useEffect 依赖数组不得为 `[]`（若闭包了非 stable 引用）
- [ ] 闭包的函数引用若是普通函数声明，**必须**改为 `useCallback`（CLAUDE.md §3 红线 5）
- [ ] 不得用 `biome-ignore lint/correctness/useExhaustiveDependencies` 掩盖闭包陷阱（除非确认真 stable，如 `setFiles` / `invoke` / `useChatStore.getState()`）
- [ ] 顶层 Provider（AiComposerProvider / ThemeProvider）的 value 用 `useMemo`，回调用 `useCallback`（CLAUDE.md §3 红线 5）
- [ ] 改 `composer.tsx` 后，tauri:dev 验证：拖文件到 AI 面板 → 确认 attach 事件触发 → 确认读到当前 state（非 mount 时旧值）

### 21.5 P1 预防清单的强制使用

**subagent 自检报告**（§9.4）必须额外附「P1 预防清单核对」节：

```markdown
### 8. P1 预防清单核对（§21，必填）

- [ ] P1-NEW-1：慢方法走 `_main_executor`，未在主循环同步派发（§21.1）
- [ ] P1-NEW-2：未用 `__import__` hack / walrus / `if...else None` 反模式（§21.2）
- [ ] P1-NEW-3：`_dispatch_in_executor` 内有完整 try/except，异常时调 send_error（§21.3）
- [ ] P1-NEW-4：useEffect 依赖数组正确，闭包的函数引用用 useCallback（§21.4）

若任一项未通过，说明原因 + 修复方案。
```

**主 agent 集成验证**（§7.3）必须核对所有 subagent 的 P1 预防清单，未通过的 subagent 改动**不集成**，退回修复。

---

> **最后更新**：2026-07-30 · v2.1 · 整合 v4 调研报告（37 项目，Strands 首选确认）+ 魔改 agent 代码审查报告（P1-NEW-1/2/3/4 修复），新增 §17~§21 五章节（sidecar 异步执行协作 / SSH 终端文件锁扩展 / Strands 适配层红线 / v4 路线图分工 / P1 预防清单），更新 §2.4 接手声明模板（+2 字段）、§3.1 文件锁矩阵（+11 行）、§4 模块依赖图（+12 新节点）。
> **维护者**：主 agent（subagent 不直接改本文件，建议通过主 agent）。
> **上游参考**：https://github.com/crynta/terax-ai（架构基线，非多 agent 规范来源）。
> **配套调研报告**：
> - `docs/reports/ops-agent-opensource-survey-2026-07-v4.md`（v4，37 项目，Strands 首选 + AgentSSH/OpAgent/LearnSSH/ANOLISA 发现）
> - `docs/reports/modded-agent-code-review-2026-07-30.md`（P1-NEW-1/2/3/4 + P2-NEW-1~6，含修复状态）
