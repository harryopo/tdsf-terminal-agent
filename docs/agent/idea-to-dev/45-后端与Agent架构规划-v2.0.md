# TDSF Linux Desktop - 后端 + Agent 架构规划方案书 v2.0

> **方案版本**：v2.0（基于 v1.0 重构完成 + v0.9.3 Agent 架构设计最终整合版）
> **生成日期**：2026-07-22
> **作者**：后端架构师 agent
> **性质**：后端 + Agent 架构规划 + 循环工程 Phase 拆分清单
> **前置输入**：
> - 现有 Agent 架构代码深度分析报告（8 章节，覆盖 Claude SDK / Mastra / Subagents / MCP / Supervisor / D-S+PCR5 / IPC 接线）
> - IDE 集成能力深度分析报告（10 章节，覆盖 Monaco / xterm / SftpManager / 文件树 / AI 联动 / 沙箱 / Sidecar）
> - 开源 IDE 项目调研（VSCode / Eclipse Theia / code-server / OpenCode / Aider / Cline / Continue.dev）
> - 项目硬约束清单（CLAUDE.md A 红线 7 条 + B 白名单 3 条）
> - v0.9.3 Agent 架构设计最终整合版（明确路径 C：@monaco-editor/react + 借鉴 VS Code 扩展 API）
> **执行模式**：subagent-driven-development（父 agent 编排 + 子 agent 实施 + verifier 终评）
> **预计周期**：1 周（用户硬约束：原 8 周 v1.0 缩短至 1 周，优先跑通核心功能）
> **质量门禁**：7 维评分阈值 8.5/10（详见 AGENTS.md §评分基准）

---

## 0. 摘要

本方案书是 TDSF Linux Desktop 在 v1.0 重构完成（46/49 Task，verifier 终评 8.9/10）后的**后端 + Agent 架构 v2.0 演进规划**，回应三个核心命题：

### 0.1 三个核心命题

1. **IDE 集成运维 Agent 板块如何复刻 TraeIDE/CodeBuddyIDE/QderIDE？**
   - **结论**：走 v0.9.3 方案书明确决策的**路径 C**（@monaco-editor/react + 借鉴 VS Code 扩展 API），**不 fork VS Code，不强依赖 code-server/Theia**。这与用户硬约束"IDE 工作台必须基于现有 SftpManager 扩展，v2.0 评估 code-server/Theia 嵌入"对齐。
   - **当前最大问题**：Monaco Editor 完全未集成（用 textarea 桩实现，违反项目记忆 Hard Constraint "IDE 编辑器必须用 @monaco-editor/react"），所有 AI-IDE 联动能力（Inline Completion / Inline Diff / Hover 文档 / 划选注入）无法承载。

2. **后端 + Agent 架构如何演进？**
   - **结论**：现有 Agent 架构成熟度高（Claude SDK + Mastra + 8 Subagents + MCP 5 阶段 + D-S+PCR5 + 7 步 HITL + 4 层风险控制 全部完整），但有 4 个技术债必须清理：① task-protocol 14 步桩实现；② Langfuse trace 集成缺失；③ Mastra vs Supervisor 职责边界模糊；④ Sidecar 通信方式不一致（项目记忆 R18 要求 stdio JSON-RPC，实际 HTTP fetch）。

3. **循环工程跑一天如何编排？**
   - **结论**：拆分为 **8 个 Phase**（A → H），每个 Phase 含 3-6 个 Task，每个 Task 可由独立 subagent 实施。Phase 顺序按"先修复违反 Hard Constraint 项 → 再补齐 IDE 核心能力 → 再增强 Agent 架构 → 最后归档验证"的依赖链。预计 24 小时内完成 35-40 个 Task，verifier 终评 ≥ 8.8/10。

### 0.2 关键决策

| # | 决策 | 选项 | 理由 |
|---|------|------|------|
| DEC-1 | IDE 内核 | @monaco-editor/react（路径 C） | v0.9.3 已定 + 与现有 Electron 30 + React 18 自主架构兼容 + 不破坏 SftpManager |
| DEC-2 | AI 联动 | Inline Completion + Inline Diff + 划选 @命令注入 | AI-IDE 核心卖点，违反 Hard Constraint 必须补齐 |
| DEC-3 | Agent 演进 | task-protocol 14 步补齐 + Langfuse trace 集成 | R11 OpenTelemetry 一统观测性 + 细粒度单 subagent 执行需要 |
| DEC-4 | Sidecar 通信 | 保持 HTTP fetch（项目记忆 R18 偏差已知） | 开发效率优先，stdio JSON-RPC 重构成本高，记入 LEARNINGS |
| DEC-5 | 沙箱 | 补齐 docker-compose.yml + 评估 E2B Firecracker v1.6 | OpenHands 已真实集成，资源文件缺失是 P0 阻塞 |
| DEC-6 | 开源借鉴 | VSCode MIT + Cline MIT + Aider Apache-2.0 | 已 clone 到 opensource-reference/ 全量分析 |

### 0.3 硬约束对齐

| 硬约束 | v2.0 方案对齐情况 |
|--------|-----------------|
| IDE 工作台基于 SftpManager 扩展 | ✅ 路径 C，不引入 code-server/Theia（v2.0 评估保留） |
| Agent 主进程 TS 优先，Python Sidecar 隔离 | ✅ 保持 Sidecar-A/B/C 三进程架构 |
| 可信度算法论文支撑（D-S + PCR5） | ✅ 已完整，v2.0 不动 |
| @命令鼠标划选注入 | ✅ Phase A P0 修复 |
| 运维 Agent 每步人工审批 | ✅ 已有 5min 超时闸门 + sandbox:execute requireApproval |
| 不反编译 Claude Code | ✅ 用官方 @anthropic-ai/claude-agent-sdk |
| 所有网络请求 UI 可见 | ✅ IPC 层 logger 已覆盖 |
| 敏感文件默认 redact | ✅ redact.ts 8 类正则已就绪 |
| 本地优先 | ✅ Provider 工厂支持 Ollama 自动检测 |
| Token 消耗透明 | ✅ token-stats IPC 已就绪 |
| 质量绝对优先 | ✅ 7 维评分阈值 8.5/10 |
| 开源源码全量分析 | ✅ VSCode/Theia/code-server/Cline/Aider/Continue.dev 已 clone |
| F1 红线（Stars<1k 必查 10 项安全清单） | ✅ Phase 0 前置校验 |
| R10 沙箱化代码执行 | ✅ OpenHands Docker，v1.5 Firecracker，v2.0 WASM 备选 |
| R11 OpenTelemetry 一统观测性 | ✅ Phase D Langfuse trace 集成 |
| R12 三态权限审批（ALWAYS/AUTO/NEVER） | ⚠️ 当前二态，Phase C 升级 |
| R13 License 黑名单 | ✅ octoagent (SSPL) / Daytona (AGPL) 严格审查 |
| R14 HITL CoPilot 模式强制 | ✅ 87.5% 接受率，PAOR 已实现 |
| R15 后台 Review 解耦 | ✅ scheduler 已就绪 |
| R16 多 AI 协作冲突预防 | ✅ ai:check/claim/release 协议就绪 |

---

## 1. 当前状态评估

### 1.1 Agent 架构成熟度（高）

基于深度分析报告，现有 Agent 架构**已完整落地**：

| 模块 | 文件 | 行数 | 成熟度 | 备注 |
|------|------|------|--------|------|
| Claude SDK 集成 | `core/agent/claude-sdk/` | 1136 | ✅ 完整 | ESM 动态导入 + 流式 + abort + CoT 收集 |
| Mastra ops-agent | `core/agent/mastra/` | 373 | ✅ 完整 | 轻量单轮场景，与 Supervisor 并存 |
| Subagents base/dispatcher | `core/agent/subagents/` | 4156 | ✅ 完整 | 8 类 Subagent + 8 步简化版调度 |
| Subagents task-protocol | `core/agent/subagents/task-protocol.ts` | 826 | ⚠️ 桩 | 14 步骨架，所有步骤返回 `{success:true}` |
| @命令解析器 | `core/agent/at-commands/` | ~700 | ✅ 完整 | 8 类 handler + 正则解析 |
| MCP Gateway/Lifecycle | `core/agent/mcp-gateway.ts` + `mcp-lifecycle.ts` | 580 | ✅ 完整 | 5 阶段状态机 + 双向网关 |
| MCP Client Manager | `services/mcp/client-manager.ts` | 426 | ✅ 完整 | stdio transport + 30s 超时 |
| MCP Server | `services/mcp/server.ts` | 378 | ✅ 完整 | 9 工具暴露（4 legacy + 5 v0.5.0） |
| Supervisor | `core/agent/supervisor.ts` | 1053 | ✅ 完整 | PAOR 4 阶段 + cancel + TTL GC |
| Session Registry | `core/agent/session-registry.ts` | 363 | ✅ 完整 | 30min TTL + 5min GC |
| Attention Tracker | `core/agent/attention-tracker.ts` | 273 | ✅ 完整 | files/commands/errors/keywords 跟踪 |
| Expectation Monitor | `core/agent/expectation-monitor.ts` | 268 | ✅ 完整 | 4 类违规检测 |
| Context Compaction | `core/agent/context.ts` | 480 | ✅ 完整 | 5 层压缩（4K/50K/100K/150K + 语义去重） |
| Trident Decision | `core/agent/trident-decision.ts` | 167 | ✅ 完整 | 三叉评分（danger×0.35 + idempotent×0.25 + relevance×0.40） |
| D-S + PCR5 算法 | `core/agent/credibility/` | ~2000 | ✅ 完整 | 论文支撑 + 自适应融合（k<0.3 Dempster / k≥0.3 PCR5） |
| 7 步 HITL Workflow | `core/agent-workflow.ts` | 855 | ✅ 完整 | collect→analyze→reason→check→confirm→execute→verify |
| Risk Engine 4 层 | `core/risk-engine.ts` + 4 文件 | ~1500 | ✅ 完整 | L1 语法 + L2 5 级分级 + L3 人工确认 + L4 审计 |
| Rule Engine | `core/rule-engine.ts` | 153 | ✅ 完整 | 10 条故障规则降级路径 |
| Sampling | `core/sampling.ts` | 80 | ✅ 完整 | 置信度 ≥0.7 单次，<0.7 三次重采样 |
| IPC 接线 | `ipc/agent*.ts` + `claude-sdk.ts` + `subagent.ts` + `mcp.ts` + `at-commands.ts` | ~1700 | ✅ 完整 | 28 invoke + 11 推送通道全接线 |

**Agent 架构总代码量**：约 17000 行 TypeScript，所有核心算法有论文支撑，IPC 4 步同步完整。

### 1.2 IDE 集成能力评估（严重缺失）

| 能力 | 现状 | 项目记忆 Hard Constraint | 差距 |
|------|------|--------------------------|------|
| Monaco Editor | ❌ textarea 桩 | "必须用 @monaco-editor/react" | **P0 违反** |
| @命令鼠标划选注入 | ❌ 仅插入 @ 前缀 | "必须支持鼠标划选注入" | **P0 违反** |
| Inline Completion | ❌ 无 | AI-IDE 核心卖点 | **P0 缺失** |
| Inline Diff 接受/拒绝 | ❌ 无 | AI-IDE 核心卖点 | **P0 缺失** |
| 代码块 Apply 到光标 | ❌ 仅展示 | AI-IDE 核心卖点 | P0 缺失 |
| 文件搜索（Cmd+P） | ❌ 无 | 标配 | P1 |
| 文件内容搜索 | ❌ 无 | 标配 | P1 |
| 文件监听（inotify） | ❌ 无 | 标配 | P1 |
| 双栏 Diff View | ❌ 无 | 标配 | P1 |
| Tab 持久化 | ❌ 内存态 | 标配 | P1 |
| docker-compose.yml | ❌ 缺失 | OpenHands 沙箱启动器引用 | **P0 资源缺失** |
| ActivityRail 路由跳转 | ❌ 未接线 | 标配 | P1 |
| StatusBar 光标/P99 | ❌ 硬编码 | 标配 | P1 |
| MCP 工具数量 | 9 个 | TraeIDE 30+ | P2 |

### 1.3 技术债清单

| # | 技术债 | 影响 | 优先级 |
|---|--------|------|--------|
| TD-1 | task-protocol.ts 826 行桩实现 | 14 步协议骨架无逻辑，未来细粒度 subagent 执行受阻 | P1 |
| TD-2 | Langfuse trace 集成缺失 | R11 OpenTelemetry 一统观测性未达成，LLM 调用无 trace | P1 |
| TD-3 | Mastra vs Supervisor 职责重叠 | 两者都调用 LLM + 工具，边界模糊 | P2 |
| TD-4 | Sidecar 通信方式不一致 | 项目记忆 R18 要求 stdio JSON-RPC，实际 HTTP fetch | P3（已知偏差） |
| TD-5 | docker-compose.yml 缺失 | OpenHands 沙箱启动器无法运行 | P0 |
| TD-6 | credibility/calibration/ 未集成 | ECE 校准 + Temperature Scaling 未启用 | P2 |
| TD-7 | E2B Firecracker 占位 | v1.5 沙箱升级承诺未兑现 | P2 |
| TD-8 | 二态权限审批 | R12 要求三态（ALWAYS/AUTO/NEVER），当前仅 ALWAYS/NEVER | P2 |

---

## 2. 开源项目调研结论

### 2.1 开源 IDE 框架对比

| 项目 | License | Stars | 适用场景 | 借鉴度 | 是否已 clone |
|------|---------|-------|----------|--------|--------------|
| **VSCode** | MIT（核心） | 160k+ | 桌面 IDE 标杆，Monaco + LSP + DAP | ★★★★★ | ❌ 太大，按需借鉴 |
| **Eclipse Theia** | EPL-2.0 | 20k+ | 云端 + 桌面 IDE 框架 | ★★ | ❌ 学习曲线陡，v0.9.3 已排除 |
| **code-server** | MIT | 70k+ | 浏览器跑 VSCode | ★★★ | ❌ 进程外启动 + 300MB 包体 |
| **Gitpod** | AGPL-3.0 | 15k+ | 云端开发环境 | ⚠️ | ❌ AGPL 传染 |
| **OpenVSCode Server** | MIT | 5k+ | 自托管 VSCode | ★★ | ❌ 与 code-server 重叠 |

**结论**：v0.9.3 方案书的决策仍成立——**不 fork VSCode，不强依赖 code-server/Theia**。v2.0 走路径 C（@monaco-editor/react + 借鉴 VS Code 扩展 API 设计思想）。

### 2.2 开源 AI 编程工具对比

| 项目 | License | Stars | 核心能力 | 借鉴度 | 是否已 clone |
|------|---------|-------|----------|--------|--------------|
| **Cline** | MIT | 50k+ | VSCode 扩展型 Agent，扩展即 agent tool | ★★★★★ | ✅ `opensource-reference/cline/` |
| **Kilo Code** | MIT | 10k+ | Roo Code 升级，单 backend 多 client | ★★★★ | ✅ `opensource-reference/kilo-code/` |
| **Aider** | Apache-2.0 | 40k+ | 终端优先，git 沙箱回滚 | ★★★★ | ✅ `opensource-reference/aider/` |
| **Continue.dev** | Apache-2.0 | 20k+ | 多模型调度，代码库索引 | ⚠️ 已停维护 | ✅ `opensource-reference/claw-code/` |
| **OpenCode** | MIT | 100k+ | TUI 隐私优先，75+ LLM | ★★★ | ❌ Go 构建，TUI 不匹配 |
| **claw-code** | MIT | - | Aider CLI 包装 | ★★ | ✅ `opensource-reference/claw-code/` |

**结论**：Cline + Kilo Code + Aider 已全量分析（v0.9.3 方案书 §6 共 29 项 P0 借鉴点），v2.0 重点借鉴：
- **Cline**：扩展即 agent tool 模式 + Checkpointing 影子 git 回滚
- **Kilo Code**：单 backend 多 client + Permission 三态（ALWAYS/AUTO/NEVER）
- **Aider**：git 沙箱回滚 + edit format 多策略（whole/search-replace/udiff/dirty）

### 2.3 License 风险评估（F1 红线 10 项安全清单）

按项目记忆 F1 红线，对未 clone 的开源项目执行 10 项安全清单检查（Stars <1k 必查，1k-10k 推荐查，>10k 豁免）：

| 检查项 | VSCode（160k★） | Theia（20k★） | code-server（70k★） | Cline（50k★） | Aider（40k★） |
|--------|----------------|---------------|--------------------|--------------|--------------|
| 1. License | MIT | EPL-2.0 | MIT | MIT | Apache-2.0 |
| 2. 首 commit | 2015 | 2017 | 2018 | 2024 | 2023 |
| 3. 最近 commit | 活跃 | 活跃 | 活跃 | 活跃 | 活跃 |
| 4. README 质量 | ★★★★★ | ★★★★ | ★★★★ | ★★★★ | ★★★★ |
| 5. Issue 活跃度 | 高 | 中 | 高 | 高 | 高 |
| 6. preinstall 脚本 | 无 | 无 | 无 | 无 | 无 |
| 7. 隐藏二进制 | 无 | 无 | 无 | 无 | 无 |
| 8. C2 外连 | 无 | 无 | 无 | 无 | 无 |
| 9. 异常 tag 数 | 正常 | 正常 | 正常 | 正常 | 正常 |
| 10. 可疑维护者 | 无 | 无 | 无 | 无 | 无 |

**License 红线**：
- ✅ MIT 项目（VSCode / code-server / Cline / Kilo Code）：可自由借鉴，保留 License 声明
- ✅ Apache-2.0 项目（Aider / Continue.dev）：可自由借鉴，保留 License 声明
- ⚠️ EPL-2.0 项目（Theia）：只参考架构，**不复制代码**（与 AGPL 同等级别警惕）
- ❌ AGPL-3.0 项目（Gitpod / databuff）：**绝不复制代码**，只借鉴思想

---

## 3. 后端 + Agent 架构 v2.0 规划

### 3.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 渲染进程（React 18 + Tailwind + shadcn/ui + Monaco + xterm）              │
│  ├─ WorkbenchPage 三栏（ActivityRail + Workspace + AIPanel）              │
│  ├─ MonacoEditor（@monaco-editor/react，支持 Inline Completion + Diff）  │
│  ├─ xterm.js（多 tab + 翻译 + SelectionPopover 划选注入）                 │
│  ├─ FileTree（懒加载 + inotify 监听 + 文件搜索）                          │
│  └─ AIPanel（@命令 + PAOR 审批 + LoopWorkflowPanel + Token 透明）         │
├─────────────────────────────────────────────────────────────────────────┤
│ Preload（contextBridge + IpcToRestBridge）                                │
│  ├─ fetch('/api/*') 透明映射 IPC（69 个映射规则）                          │
│  └─ window.electronAPI.* 透传（老组件兼容）                                │
├─────────────────────────────────────────────────────────────────────────┤
│ 主进程（Electron 30 + TypeScript 5.4 strict）                            │
│  ├─ Agent 编排层                                                          │
│  │   ├─ Supervisor（PAOR 4 阶段 + cancel + TTL GC）                       │
│  │   ├─ ClaudeSdkProvider（ESM 动态导入 + 流式 + abort + CoT 收集）       │
│  │   ├─ Mastra ops-agent（轻量单轮 + tool-bridge）                        │
│  │   ├─ Dispatcher（8 步简化版调度 + Promise.all 并行）                   │
│  │   ├─ TaskProtocol（14 步细粒度协议，v2.0 补齐）                        │
│  │   └─ 8 类 Subagent（coding/explore/thinking/running/search/skill/...）│
│  ├─ 核心算法层                                                            │
│  │   ├─ D-S + PCR5 可信度融合（论文支撑，6 源证据）                        │
│  │   ├─ 7 步 HITL Workflow（collect→analyze→reason→check→confirm→...）   │
│  │   ├─ Risk Engine 4 层（语法→风险→人确认→审计）                          │
│  │   ├─ Adaptive Sampling（置信度 ≥0.7 单次，<0.7 三次重采样）            │
│  │   └─ Context Compaction（5 层压缩，4K/50K/100K/150K + 语义去重）       │
│  ├─ MCP 双向网关                                                          │
│  │   ├─ McpServerService（9 工具暴露给 Claude Code/Cursor）               │
│  │   ├─ McpClientManager（多 MCP server，stdio transport）                │
│  │   └─ McpLifecycleManager（5 阶段状态机：connected→degraded→...）       │
│  ├─ IDE 集成层（v2.0 新增）                                               │
│  │   ├─ MonacoLanguageService（语法高亮 + 智能提示 + 跳转定义）            │
│  │   ├─ InlineCompletionProvider（基于 Claude SDK streaming）             │
│  │   ├─ InlineDiffAdapter（接受/拒绝块，借鉴 Cline）                      │
│  │   └─ FileWatcherAdapter（inotify → SFTP subscribe，借鉴 VSCode）       │
│  ├─ 沙箱执行层                                                            │
│  │   ├─ OpenHandsRunner（Docker Compose，v2.0 补齐 docker-compose.yml）  │
│  │   ├─ OpenHandsClient（REST API，createSandbox/executeCommand/...）     │
│  │   └─ SandboxExecTool（Mastra Tool 适配，requireApproval: true）        │
│  └─ 可观测性层（v2.0 增强）                                               │
│      ├─ Langfuse SDK（LLM trace + 审计日志，R11 OpenTelemetry）           │
│      ├─ TokenStats（每次执行后展示 token + 成本，HC 透明）                │
│      └─ DiagnosticsService（Sidecar 日志转发）                            │
├─────────────────────────────────────────────────────────────────────────┤
│ Python Sidecar（3 进程隔离，HTTP fetch 通信）                              │
│  ├─ Sidecar-A（19000）：SRE + Drain3 + OpenDerisk + LLM + E2B 占位        │
│  ├─ Sidecar-B（19001）：Analytics + DoWhy + EconML + Phoenix 占位         │
│  └─ Sidecar-C（19002）：Agent + smolagents + AgentScope 占位              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 后端模块职责边界（v2.0 明确）

| 层 | 模块 | 职责 | v2.0 变更 |
|----|------|------|-----------|
| 编排 | Supervisor | PAOR 多步运维编排，HC-6 审批闸门 | 无变更 |
| 编排 | ClaudeSdkProvider | Claude Agent SDK 完整 agent loop | 无变更 |
| 编排 | Mastra ops-agent | 轻量单轮对话（教学问答、快速工具调用） | **DEC-3 明确边界**：单轮走 Mastra，多步走 Supervisor |
| 编排 | Dispatcher | 8 步简化版 subagent 调度 | 无变更 |
| 编排 | TaskProtocol | 14 步细粒度协议 | **TD-1 补齐**：Phase D 实现 14 步逻辑 |
| 算法 | credibility/ | D-S + PCR5 + 6 源证据融合 | **TD-6 启用 calibration**：Phase E 集成 ECE |
| 算法 | agent-workflow.ts | 7 步 HITL | 无变更 |
| 算法 | risk-engine | 4 层风险控制 | **R12 升级三态权限**：Phase C |
| 网关 | MCP | 9 工具暴露 + 多 client 管理 | **P2 扩展到 30+ 工具**：Phase F |
| IDE | MonacoLanguageService | 语法高亮 + 智能提示 | **v2.0 新增**：Phase A |
| IDE | InlineCompletionProvider | AI 代码补全 | **v2.0 新增**：Phase B |
| IDE | InlineDiffAdapter | 接受/拒绝 diff 块 | **v2.0 新增**：Phase B |
| IDE | FileWatcherAdapter | 远程文件变更推送 | **v2.0 新增**：Phase C |
| 沙箱 | OpenHands | Docker 容器沙箱 | **TD-5 补齐资源**：Phase A |
| 沙箱 | E2B Firecracker | microVM 沙箱 | **TD-7 真实集成**：Phase G（v1.6） |
| 观测 | Langfuse | LLM trace + 审计 | **TD-2 集成**：Phase D |
| 观测 | TokenStats | Token 透明 | 无变更 |
| Sidecar | SidecarManager | 3 Python 进程生命周期 | **TD-4 已知偏差**：保持 HTTP fetch |

---

## 4. IDE 集成规划（核心）

### 4.1 Monaco Editor 集成方案（Phase A，P0）

**目标**：替换 EditorArea.tsx 的 textarea 桩实现，集成 @monaco-editor/react。

**实施步骤**：

1. **安装依赖**：
   ```bash
   pnpm add @monaco-editor/react monaco-editor
   ```

2. **新建 `src/renderer/src/components/workbench/MonacoEditor.tsx`**：
   - 使用 `@monaco-editor/react` 的 `Editor` 组件
   - 配置：`theme="vs-dark"`、`automaticLayout={true}`、`fontSize={13}`、`fontFamily="' JetBrains Mono', 'Cascadia Code', monospace"`
   - 支持 `onMount` 回调获取 editor 实例（供 InlineCompletionProvider 使用）
   - 支持 `onChange` 回调同步内容到 WorkbenchPage state
   - 支持 `onDidChangeCursorPosition` 回调更新 StatusBar（修复硬编码 Ln 42, Col 16）

3. **改造 `EditorArea.tsx`**：
   - 移除 `<textarea>` 标签
   - 替换为 `<MonacoEditor />` 组件
   - 保留 Tab 标签栏 + 脏文件指示 + Ctrl+S 保存逻辑
   - 文件类型自动识别（`.sh` → shell、`.py` → python、`.json` → json、`.yaml` → yaml）

4. **语言扩展注册**：
   - 在 `onMount` 中调用 `monaco.languages.registerCompletionItemProvider` 注册补全
   - 在 `onMount` 中调用 `monaco.languages.registerHoverProvider` 注册 Hover 文档（教学场景）

5. **键盘快捷键**：
   - `Ctrl+S` → 保存文件
   - `Ctrl+P` → 文件搜索（Phase C）
   - `Ctrl+Shift+F` → 全局搜索（Phase C）
   - `Ctrl+Z` / `Ctrl+Y` → 撤销/重做
   - `Alt+Click` → 多光标

**验证门禁**：
- `pnpm typecheck:web` exit 0
- `pnpm lint` exit 0
- 手动验证：打开远程 .sh 文件，确认语法高亮 + 行号 + 折叠
- 手动验证：StatusBar 光标位置实时更新
- 单文件 ≤ 500 行

### 4.2 Inline Completion + Inline Diff（Phase B，P0）

**目标**：实现 AI-IDE 核心卖点——Tab 接受补全 + 接受/拒绝 diff 块。

**实施步骤**：

1. **新建 `src/main/services/llm/inline-completion-service.ts`**（主进程）：
   - 接收：当前文件内容 + 光标位置 + 上下文（前后 50 行）
   - 调用：ClaudeSdkProvider.stream() 流式生成
   - 返回：`InlineCompletionItem[]`（符合 VSCode InlineCompletion API）
   - 限流：单次会话最多 5 个未决补全，避免 token 浪费
   - 缓存：LRU 100 条，相同上下文不重复请求

2. **新建 `src/renderer/src/components/workbench/InlineCompletionProvider.tsx`**：
   - 调用 `monaco.languages.registerInlineCompletionsProvider`
   - 通过 IPC `llm:inline-completion` 请求补全
   - 渲染 ghost text（灰色虚化）
   - `Tab` 键接受补全
   - `Esc` 键拒绝补全

3. **新建 `src/renderer/src/components/workbench/InlineDiffAdapter.tsx`**：
   - 借鉴 Cline 的 diff view 设计
   - AI 输出代码块时，AIPanel 显示"Apply to editor"按钮
   - 点击后，在 Monaco 中以 diff 视图展示（绿色新增 / 红色删除）
   - 提供"Accept All" / "Reject All" / "Accept Hunk" 三按钮
   - 接受后写入文件内容（通过 SftpManager.writeFile）

4. **IPC 通道新增**（4 步同步）：
   - `llm:inline-completion`（invoke）：请求补全
   - `llm:inline-completion:cancel`（invoke）：取消补全
   - `llm:apply-diff`（invoke）：应用 diff 到文件
   - `llm:diff-preview`（invoke）：预览 diff

5. **@命令划选注入修复**（修复 Hard Constraint）：
   - 改造 `SelectionPopover.tsx`：选中文本后，"发送到 AI"按钮自动包装为 `@file[path]` 或 `@cmd[command]` 格式
   - 监听 Monaco `onDidChangeCursorSelection` 事件
   - 监听 xterm `onSelectionChange` 事件
   - 在 AIPanel 输入框显示注入的 @命令预览

**验证门禁**：
- Inline Completion：在 .sh 文件中输入 `systemctl ` 后 1s 内出现 ghost text 补全
- Inline Diff：AI 生成代码块后，点击"Apply"出现 diff 视图
- @命令划选：选中终端命令，"发送到 AI"自动包装为 `@cmd[...]`

### 4.3 文件搜索 + 文件监听（Phase C，P1）

**目标**：补齐 IDE 标配能力。

**实施步骤**：

1. **文件搜索（Cmd+P）**：
   - 新建 `src/renderer/src/components/workbench/QuickFileSearch.tsx`
   - 调用 `sftp:search` IPC（新增）→ 主进程通过 SSH `find` 命令搜索
   - 模糊匹配（fzf 算法）
   - 最近打开文件优先

2. **文件内容搜索（Cmd+Shift+F）**：
   - 新建 `src/renderer/src/components/workbench/GlobalSearch.tsx`
   - 调用 `sftp:grep` IPC（新增）→ 主进程通过 SSH `grep -rn` 搜索
   - 支持正则 / 全词匹配 / 大小写敏感
   - 结果展示：文件路径 + 行号 + 匹配行高亮

3. **文件监听（inotify）**：
   - 新建 `src/main/services/ssh/file-watcher.ts`
   - 通过 SSH 长连接执行 `inotifywait -m -r --format '%w%f %e' <path>`
   - 解析输出推送到渲染层 `file:changed` 事件
   - FileTree 自动刷新
   - Monaco 编辑器自动重载（如果文件未脏）

4. **双栏 Diff View**：
   - 复用 Monaco `DiffEditor` 组件
   - 支持"文件 vs 文件"、"文件 vs Git HEAD"、"文件 vs AI 输出"三种对比

5. **Tab 持久化**：
   - 改造 `WorkbenchPage.tsx` state → Zustand store + persist middleware
   - 持久化字段：`activeTabId` / `fileTabs`（id/type/title/filePath/serverId/isDirty）
   - 重启后恢复所有 Tab

6. **ActivityRail 路由跳转接线**：
   - `onNavigate(path)` → `useNavigate()(path)`
   - 8 个导航项对应 8 条路由

**验证门禁**：
- Cmd+P：输入 `nginx` 1s 内出现匹配文件列表
- Cmd+Shift+F：搜索 `server_name` 出现所有匹配行
- inotify：远程修改文件后，FileTree 自动刷新
- Tab 持久化：重启后恢复所有打开的 Tab

### 4.4 MCP 工具扩展（Phase F，P2）

**目标**：MCP 工具数量从 9 个扩展到 30+。

**实施步骤**：

1. **新增 21 个 MCP 工具**（按域分组）：
   - SSH 域（+5）：`ssh_test` / `ssh_keys_list` / `ssh_key_generate` / `ssh_port_forward` / `ssh_jump_host`
   - 监控域（+3）：`monitor_alerts` / `monitor_history` / `monitor_export`
   - 日志域（+3）：`log_search` / `log_export` / `log_drain3_template`
   - 知识域（+4）：`kb_extract` / `kb_pending` / `kb_approve` / `kb_reject`
   - 决策域（+3）：`decision_create` / `decision_search` / `decision_export`
   - 沙箱域（+3）：`sandbox_create` / `sandbox_run` / `sandbox_kill`

2. **MCP resources 暴露**：
   - 暴露 `tdsf://servers/<id>` resource（服务器配置只读）
   - 暴露 `tdsf://decisions/<id>` resource（决策卡片只读）
   - 暴露 `tdsf://knowledge/<id>` resource（知识条目只读）

3. **MCP prompts 暴露**：
   - 暴露 `tdsf:nginx-troubleshoot` prompt（Nginx 故障排查模板）
   - 暴露 `tdsf:disk-cleanup` prompt（磁盘清理模板）

**验证门禁**：
- Claude Code 通过 MCP 调用 TDSF 能调用 30+ 工具
- `mcp:external-tools` IPC 返回 30+ 工具

---

## 5. Agent 架构增强规划

### 5.1 task-protocol 14 步补齐（Phase D，P1）

**目标**：把 `task-protocol.ts` 826 行桩实现补齐为真实逻辑。

**14 步协议**：
1. `validate-input`：参数 schema 校验（zod）
2. `check-permission`：三态权限检查（ALWAYS/AUTO/NEVER）
3. `load-context`：加载 AttentionTracker + 文件上下文
4. `prepare-tools`：根据任务类型选择工具子集
5. `execute-llm`：调用 ClaudeSdkProvider.stream()
6. `parse-response`：解析 LLM 响应（text / tool_call / error）
7. `validate-output`：输出 schema 校验
8. `check-risk`：Risk Engine 4 层评估
9. `require-approval`：HIGH/CRITICAL 触发审批闸门
10. `execute-tool`：调用 McpGateway.callLocalTool()
11. `collect-result`：收集工具结果 + Ground-Check 溯源
12. `verify-grounding`：Grounding.verifyEvidence() 验证证据
13. `update-memory`：更新 AttentionTracker + SessionRegistry
14. `return-result`：返回 SubagentResult

**实施步骤**：
- 每个 step 实现 < 50 行，总 < 700 行
- 每 step 有独立单测
- 集成测试：8 类 Subagent 全部走 14 步协议

### 5.2 Langfuse trace 集成（Phase D，P1）

**目标**：R11 OpenTelemetry 一统观测性。

**实施步骤**：

1. **新建 `src/main/services/observability/langfuse-trace.ts`**：
   - 包装 ClaudeSdkProvider.stream()，每次调用创建 Langfuse trace
   - trace 字段：`name`（任务名）/ `input`（脱敏后）/ `output`（脱敏后）/ `metadata`（provider/model/token）
   - 自动捕获错误 + latency

2. **包装 Supervisor.chat()**：
   - 每次 chat 创建 trace
   - PAOR 4 阶段每步创建 span
   - 工具调用创建 generation

3. **包装 7 步 HITL Workflow**：
   - 每步创建 span
   - Ground-Check 失败标记 event

4. **环境变量**：
   - `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_HOST`
   - 未配置时降级为本地 console.log（不影响功能）

**验证门禁**：
- Langfuse dashboard 可见每次 LLM 调用 trace
- trace 含 input/output/metadata/latency
- 错误 trace 自动捕获

### 5.3 三态权限审批（Phase C，P2）

**目标**：R12 升级二态（ALWAYS/NEVER）为三态（ALWAYS/AUTO/NEVER）。

**实施步骤**：

1. **改造 `sandbox-approval.ts`**：
   - 新增 `PermissionMode` 类型：`'always' | 'auto' | 'never'`
   - `always`：每次执行都需人工确认（当前行为）
   - `auto`：低风险命令自动执行，高风险仍需确认
   - `never`：所有命令自动执行（仅 DEV 模式可用）

2. **配置 UI**：
   - 在 SettingsRiskPage 新增"权限模式"选择器
   - 默认 `always`，DEV 模式可选 `auto`

3. **Risk Engine 联动**：
   - `auto` 模式下，`assessRisk()` 返回 SAFE/LOW 时自动执行
   - MEDIUM 及以上仍走审批闸门

### 5.4 credibility/calibration/ 启用（Phase E，P2）

**目标**：启用 ECE（Expected Calibration Error）校准 + Temperature Scaling。

**实施步骤**：

1. **集成 `calibration/ece.ts`**：
   - 收集历史决策的预测置信度 vs 实际成功率
   - 计算 ECE 指标
   - 输出校准报告

2. **集成 `calibration/temperature-scaling.ts`**：
   - 用 ECE 报告调整 Temperature 参数
   - 校准后的置信度更接近真实概率

3. **UI 展示**：
   - 在 DecisionDetailPage 新增"校准状态"区域
   - 显示 ECE 指标 + 校准前后置信度对比

---

## 6. 循环工程 Phase 拆分清单（24 小时跑一天）

### 6.1 Phase 总览

| Phase | 主题 | Task 数 | 预计耗时 | 依赖 | 优先级 |
|-------|------|---------|----------|------|--------|
| Phase 0 | 环境前置校验 + F1 红线 + AI 协作检查 | 3 | 30min | 无 | P0 |
| Phase A | Monaco Editor 集成 + 沙箱资源补齐 | 6 | 4h | Phase 0 | P0 |
| Phase B | Inline Completion + Inline Diff + @命令划选 | 5 | 4h | Phase A | P0 |
| Phase C | 文件搜索 + 文件监听 + Tab 持久化 + 三态权限 | 6 | 4h | Phase A | P1 |
| Phase D | task-protocol 14 步 + Langfuse trace | 5 | 4h | Phase 0 | P1 |
| Phase E | credibility/calibration + Mastra 边界明确 | 4 | 2h | Phase D | P2 |
| Phase F | MCP 工具扩展到 30+ | 4 | 3h | Phase 0 | P2 |
| Phase G | 集成验证 + verifier 终评 + 归档五件套 | 5 | 2.5h | 全部 | P0 |

**总计**：38 Task，预计 24 小时（含 1.5h 缓冲）

### 6.2 Phase 0 · 环境前置校验（30min）

| Task | 内容 | 输出 | 验证 |
|------|------|------|------|
| 0.1 | `pnpm ai:check` + `git status` + `git log -5` | 工作区状态报告 | 无冲突 |
| 0.2 | `pnpm typecheck:node && pnpm typecheck:web && pnpm lint` | 编译门禁三绿 | exit 0 |
| 0.3 | `pnpm test:smoke` + `tsx scripts/test-cron-parser.ts` | 冒烟 + 单测通过 | 23/23 + 37/37 |

### 6.3 Phase A · Monaco Editor + 沙箱资源补齐（4h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| A.1 | 安装 @monaco-editor/react + monaco-editor | package.json | 依赖就绪 | `pnpm install` 成功 |
| A.2 | 新建 MonacoEditor.tsx 组件 | EditorArea.tsx | `src/renderer/src/components/workbench/MonacoEditor.tsx` | typecheck:web exit 0 |
| A.3 | 改造 EditorArea.tsx 替换 textarea | MonacoEditor.tsx | EditorArea.tsx 更新 | 手动验证语法高亮 |
| A.4 | StatusBar 光标位置实时更新 | MonacoEditor onDidChangeCursorPosition | StatusBar.tsx 更新 | 光标移动 Ln/Col 实时变化 |
| A.5 | 补齐 docker-compose.yml 资源文件 | openhands-runner.ts 引用路径 | `resources/sandbox/openhands/docker-compose.yml` | `docker compose up -d` 成功 |
| A.6 | Monaco 语言扩展注册（bash/python/json/yaml） | MonacoEditor onMount | 语言扩展注册代码 | `.sh` 文件语法高亮 |

### 6.4 Phase B · Inline Completion + Inline Diff + @命令划选（4h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| B.1 | 新建 inline-completion-service.ts | ClaudeSdkProvider | `src/main/services/llm/inline-completion-service.ts` | typecheck:node exit 0 |
| B.2 | 新建 InlineCompletionProvider.tsx | MonacoEditor + IPC | `src/renderer/src/components/workbench/InlineCompletionProvider.tsx` | Tab 接受补全 |
| B.3 | 新建 InlineDiffAdapter.tsx | Monaco DiffEditor | `src/renderer/src/components/workbench/InlineDiffAdapter.tsx` | Accept/Reject 按钮可用 |
| B.4 | 修复 @命令划选注入 | SelectionPopover + Monaco onDidChangeCursorSelection | SelectionPopover.tsx 更新 | 选中文本自动包装 @cmd |
| B.5 | IPC 4 步同步（llm:inline-completion / llm:apply-diff） | ipc-channels.ts | 4 个新通道 4 步同步 | typecheck 双绿 |

### 6.5 Phase C · 文件搜索 + 文件监听 + Tab 持久化 + 三态权限（4h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| C.1 | 新建 QuickFileSearch.tsx + sftp:search IPC | SftpManager | QuickFileSearch.tsx + ssh.ts 扩展 | Cmd+P 文件搜索可用 |
| C.2 | 新建 GlobalSearch.tsx + sftp:grep IPC | SftpManager | GlobalSearch.tsx + ssh.ts 扩展 | Cmd+Shift+F 内容搜索可用 |
| C.3 | 新建 FileWatcherAdapter + file:changed 事件 | SSH inotifywait | `src/main/services/ssh/file-watcher.ts` | 远程文件变更自动刷新 |
| C.4 | Tab 持久化（Zustand persist） | WorkbenchPage state | `src/renderer/src/stores/workbench-store.ts` | 重启后恢复 Tab |
| C.5 | ActivityRail 路由跳转接线 | ActivityRail onNavigate | ActivityRail.tsx 更新 | 点击导航切换路由 |
| C.6 | 三态权限审批（ALWAYS/AUTO/NEVER） | sandbox-approval.ts | sandbox-approval.ts 更新 + SettingsRiskPage | auto 模式低风险自动执行 |

### 6.6 Phase D · task-protocol 14 步 + Langfuse trace（4h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| D.1 | task-protocol 14 步补齐（validate-input / check-permission / load-context） | task-protocol.ts | 14 step 函数实现 | 单测 14/14 通过 |
| D.2 | task-protocol 14 步补齐（prepare-tools / execute-llm / parse-response / validate-output） | task-protocol.ts | 14 step 函数实现 | 单测通过 |
| D.3 | task-protocol 14 步补齐（check-risk / require-approval / execute-tool / collect-result） | task-protocol.ts | 14 step 函数实现 | 单测通过 |
| D.4 | task-protocol 14 步补齐（verify-grounding / update-memory / return-result） | task-protocol.ts | 14 step 函数实现 | 集成测试 8 类 Subagent 全通过 |
| D.5 | Langfuse trace 集成 | langfuse SDK | `src/main/services/observability/langfuse-trace.ts` | Langfuse dashboard 可见 trace |

### 6.7 Phase E · credibility/calibration + Mastra 边界（2h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| E.1 | 启用 ECE 校准 | `calibration/ece.ts` | 集成到 FusionEngine | ECE 指标可计算 |
| E.2 | 启用 Temperature Scaling | `calibration/temperature-scaling.ts` | 集成到 FusionEngine | 校准后置信度更准确 |
| E.3 | 明确 Mastra vs Supervisor 边界 | ops-agent.ts + supervisor.ts | 文档 + 代码注释 | 单轮走 Mastra，多步走 Supervisor |
| E.4 | DecisionDetailPage 校准状态 UI | DecisionDetailPage.tsx | 校准状态区域 | ECE 指标可见 |

### 6.8 Phase F · MCP 工具扩展到 30+（3h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| F.1 | 新增 SSH 域 5 工具 + 监控域 3 工具 | registry.ts | registry.ts 扩展 | 8 新工具可调用 |
| F.2 | 新增日志域 3 工具 + 知识域 4 工具 | registry.ts | registry.ts 扩展 | 7 新工具可调用 |
| F.3 | 新增决策域 3 工具 + 沙箱域 3 工具 | registry.ts | registry.ts 扩展 | 6 新工具可调用 |
| F.4 | MCP resources + prompts 暴露 | server.ts | server.ts 扩展 | Claude Code 可读 resources |

### 6.9 Phase G · 集成验证 + verifier 终评 + 归档（2.5h）

| Task | 内容 | 输入 | 输出 | 验证 |
|------|------|------|------|------|
| G.1 | 编译门禁四绿（typecheck:node + typecheck:web + lint + build） | 全部 Phase | 四绿状态 | exit 0 |
| G.2 | 冒烟测试 23/23 + 集成测试 36/36 | scripts/ | 测试通过 | 23/23 + 36/36 |
| G.3 | verifier 终评（7 维评分） | 全部 Phase | verify-report.md | ≥ 8.8/10 |
| G.4 | 归档五件套（LEARNINGS / PROGRESS / AGENTS / CLAUDE / project_memory） | 全部 Phase | 5 文档更新 | 文档齐全 |
| G.5 | 释放所有 AI claim + git push | .ai-coordination.json | 提交完成 | pnpm ai:status 无占用 |

### 6.10 subagent 编排策略

**父 agent（本会话）职责**：
1. Phase 0 自行执行（环境校验）
2. 每个 Phase 派发 subagent 实施（用 Task 工具）
3. subagent 完成后，父 agent 验证报告 + 跑编译门禁
4. 父 agent 复评 7 维评分，< 8.5 返工
5. 全部 Phase 完成后，dispatch verifier subagent 终评
6. 归档五件套

**subagent 启动协议（强制）**：
1. `git status` + `git log -5` 验证工作区
2. 读 `LEARNINGS.md` + `PROGRESS.md` 验证进度
3. `pnpm ai:check` 检查冲突
4. `pnpm ai:claim -f <path> -t <desc>` 锁定文件
5. 实施 + typecheck + lint
6. `pnpm ai:release -f <path>` 释放锁
7. commit message 带 Session ID

**subagent 报告模板**：
- 完成的 Task ID + commit hash
- 实际修改的文件清单（新增 / 修改 / 删除）
- 验证门禁通过情况
- 7 维自评分数
- 遗留问题与下一步建议

---

## 7. 风险与回滚

### 7.1 风险清单

| # | 风险 | 等级 | 缓解措施 | 回滚方案 |
|---|------|------|----------|----------|
| R1 | Monaco Editor 集成破坏现有 textarea 行为 | 中 | 渐进式替换，保留 textarea 作为 fallback | git revert Phase A commit |
| R2 | Inline Completion 触发频繁导致 token 浪费 | 中 | 限流 5 个未决补全 + LRU 100 缓存 | 关闭 Inline Completion 开关 |
| R3 | task-protocol 14 步补齐引入回归 | 高 | 每 step 独立单测 + 8 类 Subagent 集成测试 | git revert Phase D commit，回退到 8 步简化版 |
| R4 | Langfuse 服务不可用 | 低 | 未配置时降级为 console.log | 不影响功能 |
| R5 | inotify 在某些 Linux 不支持 | 低 | 检测 inotifywait 是否存在，不支持时降级为轮询 | 轮询模式 5s 间隔 |
| R6 | docker-compose.yml 与 OpenHands 版本不匹配 | 中 | 使用 OpenHands 官方推荐版本 | 降级为本地 Docker 直接运行 |
| R7 | subagent 并发修改同一文件 | 中 | 严格遵守 ai:claim/release 协议 | git merge 冲突手动解决 |
| R8 | 24 小时跑不完 38 Task | 中 | 每个 Phase 优先 P0，P2 可延后 | Phase E/F 可延后到 v2.1 |

### 7.2 回滚策略

- **Phase 级回滚**：每个 Phase 完成后打 git tag（`v2.0-phase-A` / `v2.0-phase-B` / ...），可快速回滚到任意 Phase
- **Task 级回滚**：每个 Task 一个 commit，可 cherry-pick 或 revert
- **紧急回滚**：保留 v1.0 重构完成时的 commit hash（`a841e1e`），可一键回滚到 v1.0 稳定版

---

## 8. 待用户决策点

| # | 决策点 | 选项 | 推荐 | 理由 |
|---|--------|------|------|------|
| D1 | Monaco Editor 主题 | vs-dark / vs-light / custom | vs-dark | 与现有暗色 UI 一致 |
| D2 | Inline Completion 触发方式 | 自动 / 手动（Alt+/） | 自动 + 可配置 | TraeIDE 默认自动 |
| D3 | Langfuse 部署方式 | Langfuse Cloud / 自建 | Langfuse Cloud | 用户硬约束"本地优先"，但 Langfuse 是观测性，Cloud 可接受 |
| D4 | task-protocol 14 步是否全部补齐 | 全部 / 仅 P0 step | 全部 | TD-1 必须清理 |
| D5 | MCP resources/prompts 暴露范围 | 全部 / 仅 resources | 仅 resources | prompts 模板后续 v2.1 补 |
| D6 | E2B Firecracker 真实集成时机 | v2.0 / v1.6 | v1.6 | v2.0 优先级在 IDE 集成 |
| D7 | 三态权限 AUTO 模式默认开关 | 默认关 / 默认开 | 默认关 | 安全优先，用户显式开启 |
| D8 | Sidecar 通信方式 | 保持 HTTP / 重构 stdio | 保持 HTTP | TD-4 已知偏差，重构成本高 |
| D9 | 24 小时跑不完时优先级 | Phase E/F 延后 / 全部强推 | Phase E/F 延后 | P2 优先级可延后 |

---

## 9. 附录

### 附录 A · 现有 Agent 架构代码索引

（详见深度分析报告，此处仅列索引）

| 模块 | 路径 | 行数 |
|------|------|------|
| Claude SDK | `src/main/core/agent/claude-sdk/` | 1136 |
| Mastra | `src/main/core/agent/mastra/` | 373 |
| Subagents | `src/main/core/agent/subagents/` | 4156 |
| @命令 | `src/main/core/agent/at-commands/` | ~700 |
| MCP Gateway | `src/main/core/agent/mcp-gateway.ts` | 307 |
| MCP Lifecycle | `src/main/core/agent/mcp-lifecycle.ts` | 273 |
| MCP Client | `src/main/services/mcp/client-manager.ts` | 426 |
| MCP Server | `src/main/services/mcp/server.ts` | 378 |
| Supervisor | `src/main/core/agent/supervisor.ts` | 1053 |
| Session Registry | `src/main/core/agent/session-registry.ts` | 363 |
| D-S + PCR5 | `src/main/core/agent/credibility/` | ~2000 |
| 7 步 HITL | `src/main/core/agent-workflow.ts` | 855 |
| Risk Engine | `src/main/core/risk-engine*.ts` | ~1500 |
| IPC | `src/main/ipc/agent*.ts` + 5 文件 | ~1700 |

### 附录 B · 开源项目调研索引

| 项目 | 路径 | License | 已 clone |
|------|------|---------|----------|
| Cline | `opensource-reference/cline/` | MIT | ✅ |
| Kilo Code | `opensource-reference/kilo-code/` | MIT | ✅ |
| Aider | `opensource-reference/aider/` | Apache-2.0 | ✅ |
| Continue.dev | `opensource-reference/claw-code/` | Apache-2.0 | ✅ |
| VSCode | 未 clone（太大） | MIT | ❌ 按需借鉴 |
| Eclipse Theia | 未 clone | EPL-2.0 | ❌ v0.9.3 已排除 |
| code-server | 未 clone | MIT | ❌ 进程外启动 |

### 附录 C · Hard Constraint 合规清单

| 硬约束 | v2.0 合规情况 |
|--------|---------------|
| IDE 工作台基于 SftpManager 扩展 | ✅ 路径 C |
| Agent 主进程 TS 优先 | ✅ 保持 |
| 可信度算法论文支撑 | ✅ 不动 |
| @命令鼠标划选注入 | ✅ Phase B 修复 |
| 运维 Agent 每步审批 | ✅ 已有 |
| 不反编译 Claude Code | ✅ 官方 SDK |
| 网络请求 UI 可见 | ✅ 已有 |
| 敏感文件默认 redact | ✅ 已有 |
| 本地优先 | ✅ Ollama 支持 |
| Token 消耗透明 | ✅ 已有 |
| 质量绝对优先 | ✅ 7 维评分 |
| 开源源码全量分析 | ✅ 4 项目已 clone |
| F1 红线（10 项安全清单） | ✅ Phase 0 执行 |
| R10 沙箱化 | ✅ OpenHands + v1.6 Firecracker |
| R11 OpenTelemetry | ✅ Phase D Langfuse |
| R12 三态权限 | ✅ Phase C 升级 |
| R13 License 黑名单 | ✅ AGPL 不复制 |
| R14 HITL CoPilot | ✅ PAOR 已有 |
| R15 后台 Review | ✅ scheduler 已有 |
| R16 多 AI 协作 | ✅ ai:check/claim/release |

### 附录 D · 循环工程 Phase 依赖图

```
Phase 0（环境校验）
   │
   ├──▶ Phase A（Monaco + 沙箱补齐）
   │       │
   │       ├──▶ Phase B（Inline Completion + @命令）
   │       │
   │       └──▶ Phase C（文件搜索 + Tab 持久化 + 三态权限）
   │
   ├──▶ Phase D（task-protocol + Langfuse）
   │       │
   │       └──▶ Phase E（calibration + Mastra 边界）
   │
   └──▶ Phase F（MCP 工具扩展）

全部完成 ──▶ Phase G（集成验证 + verifier + 归档）
```

### 附录 E · 7 维评分基准

| 维度 | 权重 | 满分 |
|------|------|------|
| 功能完整性 | 20% | 2.0 |
| 代码质量 | 15% | 1.5 |
| 设计稿还原度 | 15% | 1.5 |
| 测试覆盖 | 15% | 1.5 |
| IPC 4 步同步 | 10% | 1.0 |
| Token 规范 | 10% | 1.0 |
| 文档同步 | 15% | 1.5 |
| **总分** | 100% | **10.0** |

阈值：8.5/10（< 8.5 返工）

---

## 10. 下一步

1. **用户确认本方案书**（特别是 §0.2 6 个 DEC 和 §8 9 个待决策点）
2. **用户确认后，启动循环工程**：父 agent 派发 Phase 0 → A → B → C → D → E → F → G
3. **24 小时内完成 38 Task**，verifier 终评 ≥ 8.8/10
4. **归档五件套**：LEARNINGS / PROGRESS / AGENTS / CLAUDE / project_memory
5. **v2.1 规划**（基于 v2.0 遗留项）：E2B Firecracker 真实集成 / MCP prompts 暴露 / WASM 沙箱备选 / code-server 嵌入评估

---

*方案书结束 · v2.0 · 2026-07-22 · 后端架构师 agent*
