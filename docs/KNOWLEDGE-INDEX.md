# TDSF Terminal Agent 知识体系总索引

> **位置**：`docs/KNOWLEDGE-INDEX.md`
> **作用**：本项目所有文档的统一导航入口。任何 AI 或人接手项目，先读本文件了解文档全貌，再按需深入。
> **版本**：v1.2（2026-07-31 · sidecar 编码契约 + 双问题修复 + better-harness 识别）
> **维护规则**：新增文档必须在此登记；文档废弃移入 `docs/reports/legacy/` 并在此标注
> **上游参考**：https://github.com/crynta/terax-ai

---

## 0. 一句话项目身份

**本项目 = `crynta/terax-ai` v0.8.6 的魔改版**（"站在巨人肩膀上魔改"）。Tauri 2（Rust 壳）+ React 19 前端 + Python sidecar（AI 引擎）的桌面终端 IDE：终端优先、面向 Linux 运维教学，内置 SSH、远程文件资源管理器、代码编辑器、离线选词翻译、AI Agent 面板。

自研的 "tdsf-terminal-agent v4.0.0" 已废弃删除，**严禁**再引入其代码/配置/文档。

---

## 1. 文档分类导航（9 大类）

### 1.1 规范类（接手必读，最高优先级）

| 文档 | 路径 | 作用 | 优先级 |
|------|------|------|--------|
| **AI 入口** | `AGENTS.md` | 一句话指路（自动加载） | P0 |
| **开发规范总纲** | `CLAUDE.md` | 身份铁律 + 架构地图 + 防污染红线 + 五绿门禁 + 诊断方法论 | P0 |
| **多 agent 协作规范** | `docs/MULTI-AGENT-WORKFLOW.md` | A/B/C 三场景分层 + 文件锁矩阵 + 改动影响分析 + 接手声明模板 | P0 |

**接手顺序**：AGENTS.md → CLAUDE.md → MULTI-AGENT-WORKFLOW.md → dev-state.md（末尾交接章）→ 本索引 → 按需深入

### 1.2 进度记忆类（唯一进度源）

| 文档 | 路径 | 作用 | 当前版本 |
|------|------|------|----------|
| **当前状态/进度/已知问题** | `docs/dev-state.md` | ⭐**唯一进度记忆源**：§一到§三十七交接章，接手看末尾「§<N> 交接指南」 | §三十七（2026-08-01） |

**关键章节速查**：
- §一~§七：项目初始状态 + 已知问题 + 大恢复经验 + SSH 集成真相
- §八~§二十四：历次交接章（SSH 终端深度集成 / P0+P1 修复 / Strands 集成 / CDP 实测）
- §二十五~§二十九：知识沉淀体系 + 死代码清理 / P1-P4 AI 全面修复
- §三十~§三十四：**终端/Space 架构重构全流程**（阶段 0 UI 清理 → 阶段 1 Space/SSH 集成 → 阶段 2 SSH OSC 7 cwd 同步 → 阶段 3 本地 OSC 7 cwd 同步 → 阶段 4+5 容错收尾 + 完整验收）
- §三十六：**双问题修复 + sidecar GBK/UTF-8 根因闭环**（AI not_running / 选词翻译 / better-harness 识别）
- §三十七：**AI 面板双问题修复（Input {} / thinking 泄漏 env）+ 后端日志诊断系统**（sidecar.log 落盘 + `scripts/dev-log.py`）

### 1.3 架构文档类（理解系统设计）

| 文档 | 路径 | 作用 |
|------|------|------|
| AI 子系统 | `docs/architecture/ai-subsystem.md` | 9 Agent + PAOR 监督循环 + MCP 工具 + 知识库架构 |
| 终端渲染池 | `docs/architecture/terminal-renderer-pool.md` | xterm.js 5 槽位 + DR 复用 + 主题/字体管理 |
| PTY Shell 集成 | `docs/architecture/pty-shell-integration.md` | portable-pty + spawn pwsh/bash + 数据流 |
| 安全模型 | `docs/architecture/security-model.md` | TOFU 主机审批 + 工具审批 + SSRF 防护 + 路径校验 |
| 两进程模型 | `docs/architecture/two-process-model.md` | Tauri 主进程 + Python sidecar + JSON-RPC over stdio |
| 上游架构参考 | `docs/reports/upstream-terax-architecture.md` | terax-ai v0.8.6 模块依赖图（魔改对照基准） |

### 1.4 API 文档类（协议契约）

| 文档 | 路径 | 作用 |
|------|------|------|
| 前端↔Rust | `docs/api/frontend-rust.md` | Tauri IPC 命令（105+ 条） |
| Rust↔Python | `docs/api/rust-python.md` | JSON-RPC 2.0 over stdio 协议 |
| Python LangGraph | `docs/api/python-langgraph.md` | 9 Agent + PAOR + 工具注册 |
| Python MCP | `docs/api/python-mcp.md` | 9 MCP 工具 + 风险评估 + 知识检索 |

### 1.5 审查报告类（代码质量与问题追踪）

| 文档 | 路径 | 作用 | 状态 |
|------|------|------|------|
| v1 审查 | `docs/reports/modded-agent-code-review-2026-07-30.md` | 0 P0 + 4 P1 + 6 P2（P1-NEW-1/2/3/4） | P1 已修 |
| **v2 审查** | `docs/reports/modded-agent-code-review-2026-07-30-v2.md` | 0 P0 + 6 P1 + 9 P2（Strands 缓存串台 / fix-loop 失效 / subscribe 泄漏） | 5/6 P1 已修 |
| **v3 审查** | `docs/reports/modded-agent-code-review-2026-07-30-v3.md` | 0 P0 + 4 P1 + 4 P2（agent.configure 失效 / toolCallId 错乱 / 审批超时 / 线程池卡死） | 4/4 P1 已修 |
| 可用性审计 | `docs/reports/modded-agent-usability-audit-2026-07-30.md` | 魔改 agent 可用性 9.5/10 | ✅ |
| P0-D 验证 | `docs/reports/modded-agent-p0d-verification-2026-07-30.md` | Rust ssh_command 实现验证 | ✅ |
| 深度审计 | `docs/reports/modded-agent-deep-audit.md` | 魔改模块深度审计 | 参考 |
| 字体+MockLLM 审计 | `docs/reports/modded-agent-font-mockllm-audit.md` | 字体加载 + MockLLM 路径审计 | 参考 |
| 多 agent 规范审查 | `docs/reports/multi-agent-workflow-review-2026-07-30.md` | 协作规范合规度审查 | 参考 |
| Strands 后端审计 | `docs/reports/strands_backend-audit-2026-07-30.md` | Strands 适配层审计 | 参考 |
| Rust Bridge 审查 | `docs/reports/p1-rust-bridge-code-review-2026-07-30.md` | RustBridge 协议审查 | 参考 |
| 外部审查 | `docs/reports/outsider-review-2026-07-28.md` | 早期外部审查 | 参考 |

### 1.6 调研报告类（开源项目 + 技术方案）

| 文档 | 路径 | 作用 | 结论 |
|------|------|------|------|
| **v5 运维 agent 调研** | `docs/reports/ops-agent-opensource-survey-2026-07-v5.md` | 17 新项目（RSSH/OPENDEV/Headroom/gotoHuman MCP） | 维持 Strands 首选 |
| v5 补充 | `docs/reports/ops-agent-opensource-survey-2026-07-v5-supplement.md` | v5 补充材料 | 同上 |
| v4 调研 | `docs/reports/ops-agent-opensource-survey-2026-07-v4.md` | 22+15 项目（AgentSSH/OpAgent/LearnSSH/ANOLISA） | 同上 |
| v3 调研 | `docs/reports/ops-agent-opensource-survey-2026-07-30-v3.md` | v3 版本 | 同上 |
| v2 调研 | `docs/reports/ops-agent-opensource-survey-2026-07-v2.md` | v2 版本 | 同上 |
| v1 调研 | `docs/reports/ops-agent-opensource-survey-2026-07.md` | v1 版本 | 同上 |
| 深度研究 | `docs/reports/ops-agent-deep-research.md` | 运维 agent 深度研究 | 参考 |
| Strands 集成方案 | `docs/reports/strands-integration-implementation-plan-2026-07-30.md` | Strands 集成实施计划 | 已实施 |
| Strands 工具方案 | `docs/reports/strands-tools-integration-plan-2026-07-30.md` | 4 新工具注入方案 | backlog |
| SSH 编辑器方案 | `docs/reports/ssh-editor-integration-plan.md` | SSH 文件编辑器集成 | 已实施 |
| SSH 编辑器 diff | `docs/reports/ssh-editor-implementation-diff.md` | 实施差异记录 | 参考 |
| sidecar P0 修复方案 | `docs/reports/sidecar-p0-fix-plan.md` | sidecar P0 修复计划 | 已实施 |
| 技术栈参考 | `docs/reports/tech-stack-references.md` | 技术栈官方文档索引 | 参考 |
| 运维 agent 研究 | `docs/reports/ops-agent-research-2026-07-30.md` / `ops-agent-survey-2026-07-30.md` / `ops-agent-strands-integration-plan.md` / `ops-agent-tool-examples.md` | 早期运维 agent 研究 | 已被 v5 取代 |
| **终端/Space 重构规划** | `docs/reports/terminal-space-refactor-plan.md` | 终端/Space 架构重构主规划（阶段 0-5） | ✅ 已全部实施 |
| 终端问题根因分析 | `docs/reports/terminal-problem-analysis.md` | 终端问题清单 + 根因分析（OSC 7 / OscParser 短路等） | 参考 |
| AI 流式/主题/翻译调研 | `docs/reports/ai-theme-translate-streaming-research-2026-07-31.md` | P1-P4 修复前综合调研（流式/深思考/浅色模式/翻译） | 已实施 |
| 比赛材料冲突分析 | `docs/reports/contest-materials-integration-2026-07-31.md` | 比赛材料与实现 13 项冲突（4 项 P0） | 参考 |
| Python CI 作业评估 | `docs/reports/python-ci-job-evaluation-2026-07-31.md` | 是否在 ci.yml 增加 Python 作业（含 yaml 模板 + 风险清单） | 建议实施 |

### 1.7 比赛文档类

| 文档 | 路径 | 作用 |
|------|------|------|
| 参赛说明书 | `docs/竞赛/参赛说明书.md` | 比赛参赛说明书（IPC 105 命令 + 已知限制） |
| 技术白皮书 | `docs/竞赛/技术白皮书.md` | 技术白皮书（架构 + 通信协议 + 安全模型） |
| 开源许可与魔改说明 | `docs/OPEN-SOURCE-AND-MODIFICATIONS.md` | 上游 Apache-2.0 义务 + 本项目原创贡献 |
| 数据来源与合规 | `docs/合规/数据来源与合规说明.md` | 数据来源 + AI 使用合规 |

### 1.8 教程类

| 文档 | 路径 | 作用 |
|------|------|------|
| 使用手册 | `docs/教程/TDSF Terminal Agent 使用手册.md` | 用户使用手册 |
| FAQ | `docs/教程/TDSF Terminal Agent 常见问题FAQ.md` | 常见问题解答 |

### 1.9 历史归档类（自研 v4.0.0 时期，已废弃，仅供考古）

| 文档 | 路径 | 说明 |
|------|------|------|
| 历史归档目录 | `docs/reports/legacy/` | 自研 v4.0.0 时期的开发报告/调研/方案书（P2-Docker/P2-SSH/P5-测试/P7-门禁/v3.1-v3.7 增量调研等） |
| ⚠️ 警告 | — | **这些文档属于已废弃的自研 v4.0.0，严禁再引入其代码/配置/文档**。仅供了解历史决策背景 |

---

## 2. 检索指南（按场景找文档）

### 2.1 我是新接手的 AI，从哪开始？

1. 读 `AGENTS.md`（一句话指路）
2. 读 `CLAUDE.md`（规范总纲 + 防污染红线 + 五绿门禁）
3. 读 `docs/MULTI-AGENT-WORKFLOW.md`（多 agent 协作规范）
4. 读 `docs/dev-state.md` 末尾「§<N> 交接指南」（当前是 §三十六）
5. 读本索引了解文档全貌
6. 按需深入：架构问题看 §1.3，协议问题看 §1.4，bug 修复看 §1.5，运维 agent 集成看 §1.6

### 2.2 我要修 SSH 终端 / 终端-Space 相关 bug

1. `docs/dev-state.md` §七（SSH 集成架构真相）+ §九（SSH 终端深度集成收尾）+ §三十~§三十四（终端/Space 重构全流程）
2. `docs/reports/terminal-space-refactor-plan.md`（终端/Space 重构主规划，阶段 0-5）
3. `docs/reports/terminal-problem-analysis.md`（终端问题根因分析）
4. `docs/architecture/terminal-renderer-pool.md`（渲染池机制）
5. `docs/architecture/pty-shell-integration.md`（PTY 集成）
6. `docs/reports/upstream-terax-architecture.md`（上游对照）
7. `CLAUDE.md` §2 架构地图（关键文件定位）

### 2.3 我要改 AI Agent / Strands 后端

1. `docs/architecture/ai-subsystem.md`（9 Agent + PAOR + MCP 工具）
2. `docs/api/python-langgraph.md`（Agent 注册 + PAOR 循环）
3. `docs/reports/strands-integration-implementation-plan-2026-07-30.md`（Strands 集成方案）
4. `docs/reports/modded-agent-code-review-2026-07-30-v3.md`（v3 审查，含已修 P1）
5. `docs/MULTI-AGENT-WORKFLOW.md` §19（Strands 适配层协作红线）

### 2.4 我要加新工具 / 新 Agent

1. `docs/api/python-mcp.md`（MCP 工具注册）
2. `docs/reports/strands-tools-integration-plan-2026-07-30.md`（4 新工具方案）
3. `docs/reports/ops-agent-opensource-survey-2026-07-v5.md`（开源工具借鉴）
4. `CLAUDE.md` §2 架构地图（前端/后端文件定位）

### 2.5 我要改 Tauri 命令 / IPC 协议

1. `docs/api/frontend-rust.md`（Tauri IPC 命令）
2. `docs/api/rust-python.md`（JSON-RPC over stdio）
3. `docs/architecture/two-process-model.md`（两进程模型）
4. `CLAUDE.md` §2 架构地图（Rust 后端文件定位）

### 2.6 我要准备比赛材料

1. `docs/竞赛/参赛说明书.md` + `docs/竞赛/技术白皮书.md`
2. `docs/OPEN-SOURCE-AND-MODIFICATIONS.md`（开源许可 + 魔改说明）
3. `docs/合规/数据来源与合规说明.md`（数据合规）
4. `docs/教程/TDSF Terminal Agent 使用手册.md`（用户手册）

### 2.7 我遇到卡死 / 无限渲染 / 窗口不显示

1. `CLAUDE.md` §5 诊断方法论（CDP 9222 + CPU Profiler + performance.measure）
2. `CLAUDE.md` §3 防污染红线（8 条血泪教训）
3. `docs/dev-state.md` §四（大恢复经验时间线）
4. `docs/MULTI-AGENT-WORKFLOW.md` §17（sidecar 异步执行协作规则）

---

## 3. 版本控制信息

### 3.1 文档版本规范

- **规范类**（AGENTS.md / CLAUDE.md / MULTI-AGENT-WORKFLOW.md）：版本号在文件头部，重大变更才升版本
- **进度记忆类**（dev-state.md）：用 §<N> 交接章累计，不改历史章节，只追加新章节
- **审查报告类**：用 `-v2` / `-v3` 后缀区分版本，旧版保留供考古
- **调研报告类**：用 `-v4` / `-v5` 后缀区分版本，最新版为权威
- **架构/API 文档类**：随代码变更同步更新，无独立版本号

### 3.2 commit 规范

- `fix(<scope>):` 修复 bug
- `feat(<scope>):` 新功能
- `refactor(<scope>):` 重构
- `docs(<scope>):` 文档变更（含 dev-state.md 交接章）
- `docs(reports):` 调研/审查报告

### 3.3 关键 commit 节点（2026-07-30 ~ 2026-07-31）

| commit | 内容 |
|--------|------|
| `14de3c5` | **终端/Space 重构 Phase 4+5**：cwd 容错（盘符归一化 + root 静默化）+ 完整验收回归 |
| `ccb1af4` | **终端/Space 重构 Phase 3**：本地终端 OSC 7 cwd 同步（OscParser 短路根因修复） |
| `9ec558e` | **终端/Space 重构 Phase 2**：SSH Space OSC 7 cwd 同步 |
| `6a89ddc` | **终端/Space 重构 Stage 1**：Space 环境支持 SSH（Space 级终端/资源管理器/cwd 隔离 + UI 占位清理） |
| `9ede372` | P1-P4 全面修复（AI 流式 + 深度思考 + Skill 调用 + 主题浅色 + 翻译深浅色） |
| `f65150c` | 产品落地页（promotional landing page） |
| `dac90d2` | 删除 TDSFPanelSection 死代码 + 注释引用更新 |
| `64e9694` | 知识沉淀体系 L3 层建立（KNOWLEDGE-INDEX + HANDOVER + dev-state §二十五） |
| `ac8ec99` | dev-state §二十四交接章（v3 修复固化 + CDP 突破） |
| `642a4d0` | v3 修复批次（9 项 P1/P2）+ v2/v3 审查报告 + v5 运维 agent 调研 |
| `d72e1ad` | sidecar 流协议发 reasoning/工具行 part（前端隔离） |
| `bf7e68c` | 恢复上游 AiMiniWindow 替代自研 TdsfAgentPanel |
| `2084bfd` | P1-NEW-1/2/4 修复 + sidecar.rs TDSF_AGENT_BACKEND 默认注入 Strands |
| `229c1cd` | BackendPill 卡 loading 修复 + Critical-2/3 收尾 |
| `8dbed20` | dev-state §十九交接章（P0-E Strands override 修复） |
| `4c5640f` | sidecar.health RPC + backend_status 事件 |
| `6bc17b7` | invoke_agent 优先走 _global_backend_override 路径 |

---

## 4. 文档维护规则

1. **新增文档**：必须在 §1 对应分类登记路径 + 作用 + 版本
2. **文档废弃**：移入 `docs/reports/legacy/`，在本索引标注「已废弃」
3. **接手必读**：AGENTS.md → CLAUDE.md → MULTI-AGENT-WORKFLOW.md → dev-state.md（末尾交接章）→ 本索引
4. **唯一进度源**：dev-state.md 是唯一进度记忆源，其他文档不记录进度
5. **防污染红线**：严禁引入自研 v4.0.0 的代码/配置/文档（见 CLAUDE.md §0 铁律 2）
6. **五绿门禁**：代码改动必须过 typecheck/lint/test/build:web/tauri:dev（见 CLAUDE.md §4）

---

## 5. 知识沉淀体系（2026-07-30 建立）

本项目知识沉淀体系由以下 4 层组成：

| 层 | 载体 | 作用 | 维护频率 |
|----|------|------|----------|
| **L1 规范层** | AGENTS.md / CLAUDE.md / MULTI-AGENT-WORKFLOW.md | 开发规范 + 防污染红线 + 协作规则 | 重大变更才改 |
| **L2 进度层** | dev-state.md（§<N> 交接章） | 唯一进度记忆源，每次 session 追加 | 每次 session |
| **L3 知识层** | KNOWLEDGE-INDEX.md（本文件）+ HANDOVER.md | 文档导航 + 交接文档 + 经验沉淀 | 里程碑更新 |
| **L4 归档层** | docs/reports/ + docs/reports/legacy/ | 审查报告 + 调研报告 + 历史归档 | 产出即归档 |

**沉淀流程**：session 工作 → dev-state.md §<N> 交接章（L2）→ 里程碑更新 KNOWLEDGE-INDEX.md + HANDOVER.md（L3）→ 审查/调研报告归档（L4）

---

> **最后更新**：2026-07-31 · v1.2 · sidecar 编码契约 + 双问题修复 + better-harness 识别。上游参考：https://github.com/crynta/terax-ai
