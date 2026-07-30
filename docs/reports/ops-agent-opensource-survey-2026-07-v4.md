# TDSF Terminal Agent — 2026 年运维 Agent 开源生态调研报告（v4）

> **位置**：`docs/reports/ops-agent-opensource-survey-2026-07-v4.md`
> **版本**：v4.0（2026-07-30，在 v3 终版 22 项目基础上新增 15 个 2026-07 下旬最新项目）
> **作用**：在 v3（22 项目横向对比，Strands 首选确认）基础上，补充 2026-07 最后两周密集发布的新项目，重点发现 **AgentSSH（Rust + russh，与 TDSF SSH 后端同栈）**、**OpAgent（三层安全 + hash-chained 审计）**、**LearnSSH（别名机制 + 凭据隔离）**、**ANOLISA（Agentic OS，Token-Less + AgentSight）**、**Open Interpreter 0.0.26（Rust 重写，harness 切换）** 等高价值新项目，给出"是否替换 Strands"的最终结论与更新后的集成路线图。
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **数据基准**：2026-07-30 的 WebSearch + WebFetch + GitHub + PyPI + crates.io + npm + 官方文档站真实抓取。Stars / 下载量为各来源披露的近似值。
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07-30-v3.md`（v3 终版，22 项目深度评估）
> - `docs/reports/ops-agent-opensource-survey-2026-07-v2.md`（v2.0，2026-07 下半月补充）
> - `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
> - `docs/reports/ops-agent-strands-integration-plan.md`（Strands 集成方案深化版）
> - `docs/reports/strands-tools-integration-plan-2026-07-30.md`（Strands Tools 0.8.5 集成方案）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [v3 结论回顾（22 项目基线）](#2-v3-结论回顾22-项目基线)
3. [v4 新发现的 15 个项目](#3-v4-新发现的-15-个项目)
4. [新项目横向对比矩阵](#4-新项目横向对比矩阵)
5. [重点新发现项目深度分析](#5-重点新发现项目深度分析)
   - 5.1 [AgentSSH（Rust + russh，与 TDSF 同栈）](#51-agentsshrust--russh与-tdsf-同栈)
   - 5.2 [OpAgent（三层安全 + hash-chained 审计）](#52-opagent三层安全--hash-chained-审计)
   - 5.3 [LearnSSH（别名机制 + 凭据隔离）](#53-learnssh别名机制--凭据隔离)
   - 5.4 [ANOLISA（Agentic OS，Token-Less + AgentSight）](#54-anolisaagentic-ostoken-less--agentsight)
   - 5.5 [Open Interpreter 0.0.26（Rust 重写，harness 切换）](#55-open-interpreter-0026rust-重写harness-切换)
6. [其他新发现项目简介](#6-其他新发现项目简介)
7. [更新后的结论与建议](#7-更新后的结论与建议)
8. [更新后的集成路线图](#8-更新后的集成路线图)
9. [附录：调研来源汇总](#附录调研来源汇总)

---

## 1. 执行摘要

### 1.1 核心结论（一句话）

**维持 v3 判断：Strands Agents 1.48.0 仍是 TDSF Terminal Agent 集成运维 agent 能力的首选框架，不替换**。2026-07 最后两周密集发布的 15 个新项目中，**AgentSSH（Rust + russh，与 TDSF SSH 后端同栈）** 是最重要的新发现——它证明了"AI-native SSH toolkit + 结构化 JSON 输出 + daemon-pooled 连接"是 TDSF `rust_bridge` 双向 JSON-RPC 桥接的最佳参考实现；**OpAgent（@xianzongwendao/op-agent，三层安全 + hash-chained 审计链）** 是 TDSF `RiskChecker` + `needs_you` 审批层的进阶对标；**ANOLISA（阿里云 Agentic OS，Token-Less + AgentSight）** 的"token 优化 + agent 可观测性"范式值得 TDSF P2 借鉴。**无任何新项目颠覆 Strands 首选结论**。

### 1.2 v4 新增的 15 个项目（v3 未覆盖）

| # | 项目 | 类型 | 价值定位 |
|---|------|------|----------|
| 1 | **AgentSSH** | Rust AI-native SSH toolkit | **与 TDSF 同栈（russh）**，结构化 JSON 输出，daemon-pooled 连接，SKILL.md 集成 |
| 2 | **OpAgent**（@xianzongwendao） | 轻量 Linux 运维 agent | 三层安全（PolicyGuard + LlmAuditor + Confirm gate）+ hash-chained 审计链 + 单 Bun 进程 |
| 3 | **LearnSSH** | AI SSH 安全桥梁 | 别名机制 + 凭据隔离（密码/私钥不进聊天记录）+ 高危命令本地拦截 |
| 4 | **ANOLISA** | 阿里云 Agentic OS | Token-Less（节省 60%）+ Copilot Shell + AgentSight 可观测 + 内置 Skills |
| 5 | **SLES 16** | SUSE 企业 Linux | 首个内置 Agentic AI 的企业 Linux（2025-11-04 GA） |
| 6 | **Open Interpreter 0.0.26** | Rust 编码 agent（Codex fork） | 65.9k stars，4 harness 切换（claude-code/kimi-cli/qwen-code/deepseek-tui）+ ACP 兼容 |
| 7 | **SWE-agent / mini-swe-agent** | 学术编码 agent | Princeton NLP，19.8k stars，mini-swe-agent 100 行 Python SWE-bench 65% |
| 8 | **OpenHarness** | Agent Harness 框架（港大 HKUDS） | 1.4 万 stars，5 层架构（Loop/Toolkit/Memory/Governance/Swarm）+ 43 工具 + ohmo 助手 |
| 9 | **OpenSquilla 0.4.0** | 自我验证编码 agent | 红绿回归证据链 + SquillaRouter 智能模型路由（成本降 60-80%） |
| 10 | **MiMo Code V0.1.0** | 小米终端编程助手 | 基于 OpenCode，MIT，5.1k stars，持久记忆 + 无限上下文 |
| 11 | **OpenOcta v1.0.5** | 国产桌面 agent | 30M 安装包，国产模型 + 钉钉/飞书/企业微信 |
| 12 | **qwen-code v0.19.8** | 终端编程 agent | 25k stars，Apache 2.0，4 模型协议（OpenAI/Anthropic/Gemini/Qwen） |
| 13 | **Reasonix** | DeepSeek 优化终端 agent | Go 重写 v1.0，Prefix Cache 优化，90%+ 命中率，DeepSeek 官方推荐 |
| 14 | **CodeWhale** | Rust 终端编码 agent | 纯 TUI，轻快，无 IDE 插件 |
| 15 | **agent-ssh-cli** | npm SSH 代理工具 | 基于 ssh-mcp-server 改写，命令白名单/黑名单，SKILL.md 集成 |

### 1.3 关键发现（v4 新增）

1. **AgentSSH 是 v4 最重要的新发现**：它基于 `russh`（纯 Rust 异步 SSH 实现），与 TDSF `src-tauri/src/modules/ssh/client.rs` 使用的 `russh 0.61` **完全同栈**。其"daemon-pooled 连接复用 + 结构化 JSON 输出 + 长命令自动 suspend + SKILL.md 集成"设计，直接为 TDSF P2 双向 JSON-RPC 桥接提供了经过生产验证的参考实现。TDSF 不直接集成 AgentSSH（它是独立 CLI 工具），但其架构范式（特别是 `session send --expect --respond` 的交互式 PTY 模式）值得 TDSF `SshTerminalPane.tsx` 借鉴。[来源：lib.rs/crates/agentssh]

2. **OpAgent 的三层安全 + hash-chained 审计链是 TDSF 安全设计的进阶对标**：OpAgent 的 Tier 1（PolicyGuard 正则拦截）+ Tier 2（LlmAuditor 语义审计）+ Tier 3（Confirm gate + audit）三层防御，比 TDSF 现有的 `RiskChecker`（10 条正则）+ `needs_you`（审批事件）更精细。特别是 **LlmAuditor 语义审计层**（检测变量间接、混淆、数据外泄、提权）是 TDSF 当前缺失的——TDSF 的 RiskChecker 只做命令级正则匹配，不做语义级审计。OpAgent 的 **hash-chained 审计链**（sha256 前后链）也比 TDSF 现有的日志记录更防篡改。[来源：npmjs.com/package/@xianzongwendao/op-agent]

3. **LearnSSH 的"别名机制 + 凭据隔离"直击 TDSF 教学场景痛点**：LearnSSH 让 AI Agent 只通过别名（如"生产环境"）发起请求，凭据（密码/私钥/Passphrase）存储在本地 SSH Agent 中，AI 只接触命令执行结果（stdout/stderr），**完全杜绝凭据进入聊天记录或被模型上传云端**。这与 TDSF 的 `keyring` 凭据持久化 + `ssh-bridge.ts` 凭据不暴露给前端的设计理念一致，但 LearnSSH 的"别名解耦"更彻底——TDSF 当前仍需把 `sshSessionId` 传给 sidecar，LearnSSH 的模式可作为 TDSF P2 凭据安全强化的参考。[来源：80aj.com/2026/07/04/learnssh-ai-security]

4. **ANOLISA 的 Token-Less 工具包揭示了 TDSF 的 token 优化盲区**：ANOLISA 通过"模式压缩 + 响应压缩 + 命令重写"三大策略，在 CVE 评估场景节省 60% token。TDSF 当前 `adapter.py` 的 `_build_prompt` 把 `cwd / activeFile / workspaceRoot / terminalPrivate / sshSessionId` 全部注入 prompt，**80% token 花在"理解环境"而非"执行任务"**（ANOLISA 内部数据）。ANOLISA 的"内置 Skills 封装高频运维操作"（agent 直接调用 skill 不消耗 token 探索环境）是 TDSF P2 token 优化的方向。[来源：alibabacloud.com/blog/alibaba-cloud-releases-anolisa-agentic-os]

5. **Open Interpreter 0.0.26 的 harness 切换范式与 TDSF 多模型适配对标**：Open Interpreter 通过 `/harness` 命令在 claude-code / kimi-cli / qwen-code / deepseek-tui 等 4 个 harness 间切换，让低成本开源模型获得 frontier 模型的 agent 性能。TDSF 现有 `model_adapter.py` 的 `create_strands_model(config)` 已支持 OpenAI/Anthropic/LiteLLM 三 provider，但缺少"harness 级别"的切换（不同模型用不同的 prompt 模板 + 工具调用格式）。Open Interpreter 的 harness 思路可作为 TDSF P2 "模型感知的 agent 配置"参考。[来源：ai-tldr.dev/releases/openinterpreter-rust-0-0-26]

6. **2026-07 开源 AI 编程工具爆发：从"代码补全"走向"持续交付"**：OpenSquilla 0.4.0 的"自我验证"机制（红绿回归证据链）让 AI Agent 在交付前先跑测试证明"改对了"；小米 MiMo Code、美团 LongCat-2.0、qwen-code v0.19.8、OpenOcta v1.0.5 等密集发布。这些项目虽非运维专用，但其"自我验证 + 模型路由 + 持久记忆"范式是 TDSF `fix_loop` + `self_evolution` 模块的进阶参考。[来源：cloud.tencent.com/developer/article/2707508]

7. **OpenHarness 的 5 层 Agent Harness 架构是 TDSF agent 基础设施的完整对标**：港大 HKUDS 的 OpenHarness（1.4 万 stars，1 万行 Python）定义了 Agent Harness 的 5 层（Agent Loop / Toolkit 43 工具 / Context & Memory / Governance / Swarm Coordination），与 TDSF 的 `strands_backend/adapter.py`（Loop）+ `tools/`（Toolkit）+ `knowledge/`（Memory）+ `permissions/` + `needs_you`（Governance）+ 多 agent（Swarm）结构同构。OpenHarness 的 43 工具 + 54 指令 + 10 子智能体是 TDSF 工具集扩展的参考。[来源：toutiao.com/group/7658965387723407912]

### 1.4 v4 维持的判断

1. **Strands Agents 首选、PydanticAI 备选**（不变，v3 已充分论证）
2. **OpenWorker 是最重要的架构对标参考**（同栈 Tauri 2 + React + Python sidecar）
3. **MCP 在运维场景已成熟**（TencentOS MCP Server 22 工具、ssh-mcp-server、AgentSSH SKILL.md 均验证）
4. **集成路径**：维持 `strands_backend/` + `pydanticai_backend/` 三后端 Feature Flag（`strands|pydanticai|langgraph`）
5. **TDSF 现有 `strands_backend/` 实现质量高**（1400+ 行，9/10 契合度），继续深化而非切换

### 1.5 v4 新增建议

1. **借鉴 AgentSSH 的 daemon-pooled 连接 + 结构化 JSON 输出**：在 P2 双向 JSON-RPC 桥接实现时，参考 AgentSSH 的"长命令自动 suspend（30s 默认）+ session_id 后台读取 + SFTP→exec 内置"设计，强化 TDSF `rust_bridge` 的连接复用与长命令处理。
2. **借鉴 OpAgent 的 LlmAuditor 语义审计层 + hash-chained 审计链**：在 TDSF `RiskChecker`（命令级正则）之上新增 LlmAuditor（语义级审计，检测变量间接/混淆/外泄/提权），并将所有工具调用决策写入 hash-chained 审计表（防篡改）。
3. **借鉴 LearnSSH 的别名机制强化凭据隔离**：在 P2 评估引入"服务器别名"层，sidecar 只接收别名不接收凭据，凭据由 Rust 侧 `keyring` 管理并按别名解析。
4. **借鉴 ANOLISA 的 Token-Less + 内置 Skills**：在 P2 评估"高频运维操作封装为 Skill 模块"（agent 直接调用不消耗 token 探索环境），目标降低 30%+ token 开销。
5. **借鉴 Open Interpreter 的 harness 切换**：在 P2 评估"模型感知的 agent 配置"，不同模型用不同的 prompt 模板 + 工具调用格式（harness）。
6. **借鉴 OpenSquilla 的自我验证机制**：在 TDSF `fix_loop` 模块新增"红绿回归证据链"（先写失败测试 → 修功能 → 跑回归），强化 `debug_agent` 的验证闭环。

---

## 2. v3 结论回顾（22 项目基线）

v3 报告（`ops-agent-opensource-survey-2026-07-30-v3.md`）已覆盖 22 个项目，核心结论如下：

### 2.1 v3 核心结论

1. **Strands Agents 1.48.0 是 TDSF 首选**（契合度 9/10，与 OpenWorker / TencentOS MCP Server 并列最高）
2. **TDSF 现有 `strands_backend/` 实现质量高**（1400+ 行，8 源文件 + 2 测试文件，覆盖完整 P0+P1）
3. **PydanticAI v2.13.0 为备选**（触发条件明确：litellm 冲突 / 类型安全 / 原生 HITL / 轻体积 / Durable Execution）
4. **LangGraph 被 Thoughtworks 2026-04 从 Adopt 降级到 Trial**（TDSF 切换 Strands 有额外支撑）
5. **OpenWorker（Andrew Ng, 2026-07-25）是最重要的架构对标参考**（同栈 Tauri 2 + React + Python sidecar + typed risk engine 4 级）

### 2.2 v3 22 项目分类

| 类型 | 项目数 | 代表项目 |
|------|:---:|------|
| A. 通用 Agent SDK 框架 | 5 | Strands / PydanticAI / OpenAI Agents SDK / Claude Agent SDK / LangGraph |
| B. K8s / 云原生运维专用 Agent | 6 | K8sGPT / Robusta / HolmesGPT / kagent / Aurora / OpenSRE |
| C. 桌面端 / IDE 集成方向 Agent | 4 | OpenWorker / BitFun / TuriX-CUA / Termi AI |
| D. 教学 / 评估 / 模式对比 | 3 | SRE Lab Doctor / AIOps-example / DevOps Open Agent |
| E. 运维 MCP Server | 2 | TencentOS MCP Server / ssh-mcp-server |
| F. 国内运维 agent | 2 | Lerwee Agentic Ops / OpsAgent（Lenovo 学术） |

### 2.3 v3 前 5 名契合度排名

| 排名 | 项目 | 契合度 | 主要价值 |
|:---:|------|:---:|------|
| 1 | Strands Agents | 9/10 | **直接集成**（@tool + MCPClient + stream_async） |
| 2 | OpenWorker | 9/10 | 同栈对标 + typed risk engine 4 级 + prompt-injection posture |
| 3 | TencentOS MCP Server | 9/10 | **22 工具分类法直接借鉴** |
| 4 | PydanticAI | 8/10 | 备选方案（类型安全 + Human-in-the-loop） |
| 5 | SRE Lab Doctor | 8/10 | **Diagnosis-only 模式 + 17 高危命令 + 教学对标** |

### 2.4 v3 集成路线图（P0/P1/P2/P3）

- **P0（已完成）**：`strands_backend/` 8 文件 1400+ 行 + 5 运维 @tool + model_adapter + Feature Flag
- **P1（待执行）**：stream_async 升级 + 终端上下文完善 + OpenWorker 安全设计 + SRE Lab Doctor 教学模式 + TencentOS 22 工具扩展 + PydanticAI 备选 + AIOps-example 对比评估
- **P2（待执行）**：双向 JSON-RPC + 多 Agent 模式 + MCPClient 消费外部 MCP + kagent CRD 借鉴 + HolmesGPT toolsets 借鉴 + Steering + MLflow
- **P3（长期）**：MCP server 反向暴露 + Aurora 多 agent + BitFun 四模式 + A2A 协议 + Bedrock AgentCore

---

## 3. v4 新发现的 15 个项目

v4 在 v3 的 22 项目基础上，通过 2026-07-30 的补充 WebSearch + WebFetch，新发现 15 个 v3 未覆盖的项目。按 TDSF 契合度降序排列：

### 3.1 AgentSSH（Rust AI-native SSH toolkit，与 TDSF 同栈）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub / crates.io | github.com/trtyr/agentssh · crates.io/crates/agentssh | lib.rs |
| 最新版本 | 0.4.0（2026-05-31） | lib.rs |
| License | MIT | lib.rs |
| 语言 | Rust（Rust 2024 edition） | lib.rs |
| 代码量 | 4.5K SLoC / 195KB | lib.rs |
| 发布数 | 24 releases（0.1.12 → 0.4.0） | lib.rs |
| 底层 SSH | **russh**（纯 Rust 异步 SSH，与 TDSF `src-tauri/src/modules/ssh/client.rs` 同库） | lib.rs |
| 形态 | 单二进制（client + daemon + proxy） | lib.rs |
| 输出 | **结构化 JSON**（`{"ok":true,"status":"completed","exit_code":0,"stdout":"...","stderr":""}`） | lib.rs |
| 连接模式 | **daemon-pooled**（连接复用）+ one-shot | lib.rs |
| 文件传输 | SFTP → exec 内置（Linux/macOS/Windows 通用） | lib.rs |
| 端口转发 | daemon-managed（-L / -D） | lib.rs |
| PTY | async drain task（非 screen-scraping） | lib.rs |
| 认证 | JSON profiles（~/.ssh/config 兼容） | lib.rs |
| Agent 集成 | **SKILL.md**（drop 到 agent skill 目录即获得 SSH 能力） | lib.rs |
| 长命令处理 | **自动 suspend（30s 默认）+ session_id 后台读取** | lib.rs |
| 交互式 PTY | `session send --expect --respond`（自动响应 sudo 密码等） | lib.rs |

**核心价值**：与 TDSF SSH 后端**完全同栈**（都用 `russh`），其"daemon-pooled 连接 + 结构化 JSON + 长命令 suspend + SKILL.md"设计是 TDSF P2 双向 JSON-RPC 桥接的**最佳参考实现**。

### 3.2 OpAgent（@xianzongwendao/op-agent，轻量 Linux 运维 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| npm | @xianzongwendao/op-agent | npmjs.com |
| GitHub | github.com/liveljack/op_agent | npmjs.com |
| 最新版本 | 0.1.3（13 天前发布） | npmjs.com |
| 运行时 | Bun（单进程）+ 嵌入式 SQLite | npmjs.com |
| 资源占用 | **1c1g 服务器可运行**（无 Redis/Mongo/Milvus） | npmjs.com |
| 底层 SDK | pi coding agent SDK（复用 agent loop / tools / sessions / skills / TUI / providers） | npmjs.com |
| 默认模型 | DeepSeek（支持任意 pi-supported provider） | npmjs.com |
| 安全层级 | **三层防御**（见下） | npmjs.com |
| 审计 | **hash-chained 审计链**（sha256 前后链，防篡改） | npmjs.com |
| 运维能力 | inspect / monitor / alert / execute / script / security review / recover | npmjs.com |
| 部署 | `bun build --compile` → 单静态二进制 | npmjs.com |

**三层安全防御**（TDSF RiskChecker 的进阶对标）：

| 层级 | 职责 | TDSF 对标 |
|:---:|------|------|
| Tier 1: PolicyGuard | 正则拦截破坏性命令（rm -rf / mkfs / find -delete / \| sh / eval / base64\|sh）+ 破坏性 SQL（DROP/TRUNCATE/DELETE without WHERE）+ 保护路径（/etc/shadow / ~/.ssh / /proc / /sys / /dev / /boot） | TDSF `RiskChecker`（10 条正则）的**超集** |
| Tier 2: LlmAuditor | **语义审计**：检测变量间接、混淆、数据外泄、提权。LLM 只能升级不能降级。出错时 fail-safe 升级到人工确认 | TDSF **缺失**（当前只有命令级正则，无语义审计） |
| Tier 3: Confirm gate + audit | 写/破坏操作需交互式 y/N 确认；无 UI 时 fail-closed 阻断。所有决策+结果写入 hash-chained 审计日志 | TDSF `needs_you` 审批事件 + 日志记录（但无 hash chain） |

**核心价值**：三层安全 + hash-chained 审计链是 TDSF 安全设计的**进阶对标**，特别是 LlmAuditor 语义审计层填补了 TDSF 当前缺失。

### 3.3 LearnSSH（别名机制 + 凭据隔离）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | 2026-07-04（Linux.do 社区开源） | 80aj.com |
| 定位 | 连接 Codex 等 AI Agent 与远程服务器的安全桥梁 | 80aj.com |
| 核心机制 | **别名机制**（Agent 通过别名如"生产环境"发起请求） | 80aj.com |
| 凭据隔离 | 密码/私钥/Passphrase 存储在本地 SSH Agent，AI 只接触 stdout/stderr | 80aj.com |
| 高危拦截 | 内置 `rm -rf /` 等高危命令本地拦截 | 80aj.com |
| 输出 | JSON 格式（便于 AI 解析） | 80aj.com |
| 安装 | `npx` 一键安装 | 80aj.com |
| 认证 | 密码 / 私钥 / Agent 多种方式 | 80aj.com |
| 跳板机 | 兼容跳板机架构 | 80aj.com |

**核心价值**：别名机制 + 凭据隔离直击 TDSF 教学场景痛点——AI 获得操作权限的同时，凭据不进聊天记录、不被模型上传云端。与 MCP 协议"模型不应触碰核心凭据"的安全理念一致。

### 3.4 ANOLISA（阿里云 Agentic OS）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | 2026-03-30（阿里云） | alibabacloud.com |
| GitHub | github.com/alibaba/anolisa（开源） | help.aliyun.com |
| 基础 | Alinux4（完全兼容） | help.aliyun.com |
| 定位 | **首个为 AI Agent 打造的操作系统** | alibabacloud.com |
| 5 大增强 | 内置 Skills / Copilot Shell (cosh) / 安全增强 / AgentSight / Token-Less | help.aliyun.com |
| Token-Less | 模式压缩 + 响应压缩 + 命令重写（CVE 评估场景节省 **60% token**） | alibabacloud.com |
| Copilot Shell | 替代 bash，自然语言交互（人/Agent 双模式） | alibabacloud.com |
| AgentSight | 零侵入 agent 运行全链路细粒度数据采集 + 关联分析 | alibabacloud.com |
| 安全 | Skills 签名防投毒 + 沙箱隔离 + 系统调用管控 + 安全基线加固 | help.aliyun.com |
| 内置 Skills | 系统管理 + 性能调优 + 安全运维 + 角色基础技能 | alibabacloud.com |
| 兼容 | OpenClaw / Claude Code 一句话部署 | help.aliyun.com |

**核心价值**：揭示了 TDSF 的 token 优化盲区——80% token 花在"理解环境"。Token-Less + 内置 Skills + AgentSight 三大范式值得 TDSF P2 借鉴。

### 3.5 SLES 16（SUSE 企业 Linux，首个内置 Agentic AI）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | 2025-11-04 GA | suse.com |
| 定位 | **首个内置 Agentic AI 的企业 Linux** | suse.com |
| 维护方 | SUSE | suse.com |

**核心价值**：与 ANOLISA 同属"Agentic OS"赛道，验证了"操作系统为 Agent 优化"是 2026 年趋势。TDSF 作为桌面 IDE 不直接集成，但其"OS 级 agent 支持"思路是 TDSF 教学场景的未来演进方向（学员在 Agentic OS 上学习运维）。

### 3.6 Open Interpreter 0.0.26（Rust 重写，harness 切换）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | github.com/openinterpreter/openinterpreter | ai-tldr.dev |
| Stars | **65.9k** | ai-tldr.dev |
| 最新版本 | 0.0.26（2026-07-16，Rust 重写首个稳定 tag） | ai-tldr.dev |
| License | Apache-2.0 | ai-tldr.dev |
| 语言 | Rust | ai-tldr.dev |
| 基础 | OpenAI Codex fork | ai-tldr.dev |
| 定位 | **为低成本模型优化的编码 agent** | ai-tldr.dev |
| Harness 切换 | `/harness` 命令切换 4+ harness（native/claude-code/claude-code-bare/zcode/kimi-cli/kimi-code/qwen-code/deepseek-tui/swe-agent/minimal） | gitmemories.com |
| 模型支持 | claude-code / kimi-cli / qwen-code / deepseek-tui（任意 Codex 兼容 provider） | ai-tldr.dev |
| 协议 | **ACP（Agent Client Protocol）兼容** + Codex SDK 兼容（一行 binary override） | gitmemories.com |
| Computer Use | 内置 QA skill（agent-browser 驱动 Web 应用 / trycua 操作原生应用） | gitmemories.com |
| 沙箱 | 原生沙箱（macOS/Linux/Windows） | gitmemories.com |
| 配置 | `~/.openinterpreter`（本地） | gitmemories.com |
| 支持 | exec / MCP / skills / hooks / permissions / AGENTS.md | gitmemories.com |

**核心价值**：harness 切换范式（同一 agent loop + 不同 harness 适配不同模型）是 TDSF 多模型适配的进阶参考。65.9k stars + Apache-2.0 + Rust 重写证明"低成本模型 + 好 harness = frontier 性能"。

### 3.7 SWE-agent / mini-swe-agent（Princeton NLP，学术编码 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | github.com/princeton-nlp/SWE-agent | yuzec.com |
| Stars | **19.8k** | theaiagentindex.com |
| License | MIT | theaiagentindex.com |
| 维护方 | Princeton NLP + Stanford | theaiagentindex.com |
| 论文 | NeurIPS 2024 | theaiagentindex.com |
| 最新状态 | **主力转向 mini-swe-agent**（100 行 Python，SWE-bench 65%） | theaiagentindex.com |
| MCP 支持 | ❌ 无 | theaiagentindex.com |
| 配置 | 单 YAML 文件 | theaiagentindex.com |
| 定位 | 研究基础设施（非产品化商业软件） | theaiagentindex.com |
| 核心创新 | **Agent-Computer Interface (ACI)**：为 LLM 优化的代码库交互接口 | yuv.ai |

**核心价值**：学术参考，ACI（Agent-Computer Interface）设计思想可借鉴。mini-swe-agent 证明"100 行 Python + 好的 ACI = SWE-bench 65%"，印证 Strands 的"model-driven agentic loop + @tool"轻量范式正确。

### 3.8 OpenHarness（港大 HKUDS，Agent Harness 框架）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | HKUDS/OpenHarness | toutiao.com |
| Stars | **1.4 万**（3 个月） | toutiao.com |
| 语言 | Python（1 万行） | toutiao.com |
| 定位 | Agent Harness = 模型的"操作系统" | toutiao.com |
| 5 层架构 | Agent Loop / Toolkit / Context & Memory / Governance / Swarm Coordination | toutiao.com |
| 工具数 | **43 个内置工具**（文件/Shell/搜索/网页/MCP） | toutiao.com |
| 指令数 | 54 条 | toutiao.com |
| 子智能体 | 10 个 | toutiao.com |
| 个人助手 | **ohmo**（接入飞书/Slack/Telegram/Discord） | toutiao.com |
| 安装 | `pip install openharness-ai` → `oh setup` → `oh` | toutiao.com |
| 兼容 | Anthropic skills 生态 | toutiao.com |

**核心价值**：5 层 Harness 架构与 TDSF agent 基础设施完整对标。43 工具 + 54 指令 + 10 子智能体是 TDSF 工具集扩展的参考规模。

### 3.9 OpenSquilla 0.4.0（自我验证编码 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | 0.4.0（2026-07-01） | cloud.tencent.com |
| 核心创新 | **自我验证机制**（红绿回归证据链） | cloud.tencent.com |
| 证据链 | 先写注定失败的测试定性 → 修功能让测试由红转绿 → 过项目原有回归测试 | cloud.tencent.com |
| 模型路由 | **SquillaRouter**（按任务难度自动选模型，成本降 60-80%） | toutiao.com |

**核心价值**：自我验证机制是 TDSF `fix_loop` 模块的进阶参考。SquillaRouter 智能模型路由与 Open Interpreter harness 切换、ANOLISA Token-Less 同属"token 优化"赛道。

### 3.10 MiMo Code V0.1.0（小米终端编程助手）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | V0.1.0（2026-07） | cloud.tencent.com |
| 维护方 | 小米 | cloud.tencent.com |
| 基础 | 基于 OpenCode 二次开发 | cloud.tencent.com |
| License | MIT | cloud.tencent.com |
| Stars | 5.1k（两周内） | cloud.tencent.com |
| 特性 | 持久记忆系统 + 无限上下文 + 模型 Agent 协同优化 | cloud.tencent.com |
| 模型 | DeepSeek / Kimi / GLM 等主流模型 | cloud.tencent.com |

**核心价值**：国产大厂终端编程助手参考。持久记忆系统与 TDSF `knowledge/` 模块对标。

### 3.11 OpenOcta v1.0.5（国产桌面 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | v1.0.5 桌面版（2026-07） | toutiao.com |
| 安装包 | **30M** | toutiao.com |
| 国产化 | 国产 OS + 国产云 + 钉钉/飞书/企业微信 + DeepSeek/豆包/千问/GLM | toutiao.com |
| 协议 | 兼容 OpenAI 协议 | toutiao.com |

**核心价值**：国产企业市场参考。30M 安装包 + 全国产化是 TDSF 国内教学场景的参考（TDSF 当前 Tauri 安装包约 104MB）。

### 3.12 qwen-code v0.19.8（终端编程 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| 发布 | v0.19.8（2026-07） | toutiao.com |
| Stars | **25k** | toutiao.com |
| License | Apache 2.0 | toutiao.com |
| 模型协议 | **4 种**（OpenAI/Anthropic/Gemini/Qwen） | toutiao.com |
| 定位 | 终端编程 Agent，多协议抽象层 | toutiao.com |

**核心价值**：4 模型协议抽象层与 TDSF `model_adapter.py` 多 provider 工厂对标。Apache 2.0 与 TDSF 兼容。

### 3.13 Reasonix（DeepSeek 优化终端 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | github.com/esengine/deepseek-reasonix | toutiao.com |
| 语言 | Go（v1.0 重写） | toutiao.com |
| 核心优化 | **DeepSeek Prefix Cache**（128 token 粒度，约 90% 成本折扣） | toutiao.com |
| 命中率 | 长会话 90%+ | toutiao.com |
| 官方认可 | **DeepSeek 官方 API 文档推荐集成** | toutiao.com |

**核心价值**：Prefix Cache 优化是 TDSF DeepSeek 教学场景的 token 成本控制参考。

### 3.14 CodeWhale（Rust 终端编码 agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| 语言 | Rust | toutiao.com |
| 形态 | 纯 TUI（无浏览器、无 IDE 插件） | toutiao.com |
| 特点 | 启动快、占用低 | toutiao.com |

**核心价值**：Rust 终端 agent 参考。轻量纯 TUI 与 TDSF 终端优先定位一致。

### 3.15 agent-ssh-cli（npm SSH 代理工具）

| 维度 | 数据 | 来源 |
|------|------|------|
| npm | agent-ssh-cli | npmjs.com |
| 发布 | 0.3.9（17 天前） | npmjs.com |
| 基础 | 基于 ssh-mcp-server 改写 | npmjs.com |
| 能力 | 远程执行 / 文件上传 / 文件下载 / 连接配置 / 命令白名单 / 命令黑名单 / Agent Skill 集成 | npmjs.com |
| 平台 | macOS arm64/x64、Linux x64/arm64、Windows x64 | npmjs.com |
| 安全 | 密码加密保存（secrets.json + secret.key） | npmjs.com |
| 上传稳定性 | .part 临时文件 + 断点续传 + 失败重试 | npmjs.com |
| SKILL.md | 集成 | npmjs.com |

**核心价值**：ssh-mcp-server 的 CLI 化改造，命令白名单/黑名单 + 断点续传是 TDSF SFTP 操作的参考。

---

## 4. 新项目横向对比矩阵

### 4.1 v4 新 15 项目按 TDSF 契合度排序

| # | 项目 | Stars | License | 活跃度 | 运维场景 | SSH 支持 | 集成难度 | 与 TDSF 契合度 (1-10) |
|---|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | **AgentSSH** | <1k | MIT | 中（24 releases） | **AI-native SSH** | ✅ **russh 同栈** | 低（架构借鉴） | **9/10**（同栈 + 参考实现） |
| 2 | **OpAgent** | <1k | 开源 | 中（0.1.3） | **轻量 Linux 运维** | ⚠️ 本地 | 低（fork 改造） | **8/10**（安全设计对标） |
| 3 | **LearnSSH** | <1k | 开源 | 低 | **AI SSH 安全桥梁** | ✅ 别名机制 | 低（借鉴理念） | **8/10**（凭据隔离对标） |
| 4 | **ANOLISA** | N/A | 开源 | 高（阿里云） | **Agentic OS** | ⚠️ OS 层 | N/A（OS 不同层） | **7/10**（Token-Less 借鉴） |
| 5 | **Open Interpreter 0.0.26** | **65.9k** | Apache 2.0 | 极高 | 编码 agent（非运维） | ⚠️ Computer Use | 中（Rust 不同栈） | 7/10（harness 切换借鉴） |
| 6 | **OpenHarness** | **14k** | 开源 | 高（3 个月） | 通用 Harness | ✅ Shell 工具 | 中（Python 可借鉴） | 7/10（5 层架构对标） |
| 7 | **OpenSquilla 0.4.0** | <1k | 开源 | 中 | 编码 agent（自我验证） | ⚠️ | 中 | 6/10（fix_loop 借鉴） |
| 8 | **qwen-code** | **25k** | Apache 2.0 | 高 | 编码 agent | ⚠️ | 中 | 6/10（多协议借鉴） |
| 9 | **SWE-agent** | **19.8k** | MIT | 中（转向 mini） | 学术编码 | ❌ | N/A（学术） | 5/10（ACI 参考） |
| 10 | **Reasonix** | <1k | 开源 | 中 | DeepSeek 优化 | ⚠️ | 中 | 5/10（Prefix Cache 借鉴） |
| 11 | **MiMo Code** | 5.1k | MIT | 中 | 编码 agent | ⚠️ | 中 | 5/10（持久记忆借鉴） |
| 12 | **agent-ssh-cli** | <1k | 开源 | 中 | SSH 代理 CLI | ✅ 白名单 | 低（npm 子进程） | 5/10（SFTP 断点续传借鉴） |
| 13 | **OpenOcta** | N/A | 开源 | 中 | 国产桌面 agent | ⚠️ | N/A | 4/10（国产化参考） |
| 14 | **CodeWhale** | <1k | 开源 | 低 | Rust 终端 agent | ⚠️ | N/A | 4/10（Rust TUI 参考） |
| 15 | **SLES 16** | N/A | 商业 | 高（SUSE） | Agentic OS | ⚠️ | N/A | 3/10（OS 不同层） |

### 4.2 关键差异点速读

- **唯一与 TDSF SSH 后端同栈（russh）的 AI-native SSH 工具**：**AgentSSH**（契合度 9/10，v4 最重要发现）
- **唯一实现三层安全（正则 + 语义审计 + 确认门）+ hash-chained 审计链的轻量运维 agent**：**OpAgent**（契合度 8/10，安全设计进阶对标）
- **唯一实现别名机制 + 凭据完全隔离的 AI SSH 桥梁**：**LearnSSH**（契合度 8/10，凭据安全对标）
- **唯一节省 60% token 的 Agentic OS**：**ANOLISA**（契合度 7/10，Token-Less + AgentSight 借鉴）
- **唯一 65.9k stars + Rust 重写 + harness 切换的编码 agent**：**Open Interpreter 0.0.26**（契合度 7/10，harness 范式借鉴）
- **唯一 1.4 万 stars + 5 层 Harness 架构 + 43 工具的学术框架**：**OpenHarness**（契合度 7/10，架构对标）

### 4.3 v4 新项目与 v3 项目的 SSH/安全维度对比

| 项目 | SSH 底层 | 结构化输出 | 凭据隔离 | 高危拦截 | 语义审计 | 审计链 | TDSF 借鉴点 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|------|
| **AgentSSH**（v4） | **russh**（同栈） | ✅ JSON | ⚠️ profile | ⚠️ | ❌ | ❌ | daemon-pooled + suspend |
| **OpAgent**（v4） | 本地 | ⚠️ | ⚠️ | ✅ 正则 | ✅ **LlmAuditor** | ✅ **hash-chain** | 三层安全 + 审计链 |
| **LearnSSH**（v4） | OpenSSH | ✅ JSON | ✅ **别名解耦** | ✅ | ❌ | ❌ | 别名机制 |
| **TencentOS MCP**（v3） | SSH 远程 | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | 22 工具分类法 |
| **ssh-mcp-server**（v3） | Node.js | ⚠️ | ⚠️ | ✅ 白名单 | ❌ | ❌ | 白名单/黑名单 |
| **TDSF 现有** | **russh 0.61** | ❌（PTY 流） | ⚠️ keyring | ✅ 10 正则 | ❌ | ❌ 日志 | — |

**关键差距**：TDSF 当前缺失 **语义审计（LlmAuditor）**、**hash-chained 审计链**、**别名机制凭据隔离**、**结构化 JSON 输出**、**daemon-pooled 连接复用**——这些是 v4 新发现揭示的改进方向。

---

## 5. 重点新发现项目深度分析

本节聚焦 v4 新发现中与 TDSF 契合度最高的 5 个项目：**AgentSSH（9/10）**、**OpAgent（8/10）**、**LearnSSH（8/10）**、**ANOLISA（7/10）**、**Open Interpreter 0.0.26（7/10）**。

### 5.1 AgentSSH（Rust + russh，与 TDSF 同栈）

#### 5.1.1 为什么是 v4 最重要的发现

TDSF 的 SSH 后端 `src-tauri/src/modules/ssh/client.rs` 使用 **`russh 0.61`**（纯 Rust 异步 SSH 实现）。AgentSSH 同样基于 **`russh`**（lib.rs 明确说明"Not an OpenSSH wrapper. AgentSSH speaks SSH directly through russh — a pure-Rust async SSH implementation"）。这意味着：

1. **架构同源**：两者都用纯 Rust 实现 SSH，不依赖 libssh2/OpenSSH C 库
2. **连接复用范式可直接借鉴**：AgentSSH 的 daemon-pooled 连接复用解决了 TDSF 当前每次 `ssh_command` 调用可能重建连接的问题
3. **结构化 JSON 输出是 TDSF 双向 JSON-RPC 的最佳格式**：AgentSSH 所有命令输出 `{"ok":true,"status":"completed","exit_code":0,"stdout":"...","stderr":""}`，与 TDSF `rust_bridge.send_request()` 的返回值格式完全对齐
4. **SKILL.md 集成印证 TDSF MCP 路线正确**：AgentSSH 通过 SKILL.md 让 agent 获得 SSH 能力，与 TDSF 计划的"sidecar 工具暴露为 MCP server"思路一致

#### 5.1.2 AgentSSH 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentSSH 架构（单二进制）                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  单二进制：client + daemon + proxy                     │     │
│  │  cargo install agentssh → agentssh 二进制              │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌─────────────────┬────────┴───────────┬─────────────────┐    │
│  │  one-shot exec  │  daemon-pooled     │  proxy mode     │    │
│  │  (单次执行)      │  (连接复用)         │  (代理模式)      │    │
│  │                 │                    │                 │    │
│  │  agentssh exec  │  agentssh connect  │  agentssh proxy │    │
│  │  --profile prod │  --profile prod    │  --listen :2222 │    │
│  │  -- uptime      │  --reconnect       │                 │    │
│  │                 │  → session_id s1   │                 │    │
│  │  → JSON 结果    │  → 后续复用 s1     │                 │    │
│  └─────────────────┴────────────────────┴─────────────────┘    │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  底层：russh（纯 Rust 异步 SSH）                       │     │
│  │  - 无 C 库依赖（vs sshparamiko/libssh2 需 C 库）       │     │
│  │  - async drain task（非 screen-scraping PTY）          │     │
│  │  - JSON profiles 认证（~/.ssh/config 兼容）            │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  长命令处理：自动 suspend（30s 默认）                  │     │
│  │                                                        │     │
│  │  agentssh exec -p prod -- cargo build                 │     │
│  │  → {"status":"suspended","session_id":"s7","..."}     │     │
│  │                                                        │     │
│  │  agentssh session status --session-id s7              │     │
│  │  agentssh session read --session-id s7 --follow       │     │
│  │  agentssh session read --session-id s7 --follow       │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  交互式 PTY：expect-respond 模式                       │     │
│  │                                                        │     │
│  │  agentssh session send --session-id s1 \              │     │
│  │    --input $'sudo systemctl restart nginx\n' \         │     │
│  │    --expect "[sudo] password" \                        │     │
│  │    --respond $'mypassword\n'                           │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  文件传输：SFTP → exec 内置（跨平台）                  │     │
│  │                                                        │     │
│  │  agentssh file upload --profile prod \                │     │
│  │    --local ./app --remote /opt/app                    │     │
│  │  agentssh file download --profile prod \              │     │
│  │    --remote /var/log/syslog --local ./syslog          │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Agent 集成：SKILL.md                                  │     │
│  │                                                        │     │
│  │  # Drop SKILL.md into agent's skill directory          │     │
│  │  # Agent gains: exec / file upload-download /          │     │
│  │  # session management / port forwarding / SOCKS5       │     │
│  │  # All via structured JSON                             │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.1.3 与 TDSF 集成路径评估

| 维度 | 评估 |
|------|------|
| 直接集成 | ⚠️ AgentSSH 是独立 CLI 工具，TDSF 已有 Rust SSH 后端，不直接替换 |
| 架构借鉴 | ✅ **daemon-pooled 连接复用**：TDSF P2 双向 JSON-RPC 应实现连接池 |
| 输出格式借鉴 | ✅ **结构化 JSON**：TDSF `rust_bridge.send_request()` 返回值应采用 AgentSSH 的 JSON 格式 |
| 长命令处理借鉴 | ✅ **自动 suspend + session_id**：TDSF `ssh_command` 工具应支持长命令 suspend |
| 交互式 PTY 借鉴 | ✅ **expect-respond**：TDSF `SshTerminalPane.tsx` 的 sudo 密码交互可参考 |
| SKILL.md 借鉴 | ✅ 印证 TDSF "sidecar 工具暴露为 MCP server" 路线正确 |

**TDSF 借鉴清单（P2 落地）**：
1. 在 `src-tauri/src/modules/ssh/` 新增连接池（参考 AgentSSH daemon-pooled）
2. `rust_bridge.send_request()` 返回值统一为 `{"ok":bool,"status":str,"exit_code":int,"stdout":str,"stderr":str}` 格式
3. `ssh_command` 工具新增 `suspend_timeout` 参数（默认 30s），超时返回 `session_id` 供后续读取
4. `SshTerminalPane.tsx` 的 sudo 交互参考 `expect-respond` 模式

### 5.2 OpAgent（三层安全 + hash-chained 审计）

#### 5.2.1 三层安全防御详解

```
┌─────────────────────────────────────────────────────────────────┐
│              OpAgent 三层安全防御（pi tool_call hook 内拦截）      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  模型提出动作                                                    │
│       │                                                          │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Tier 1: PolicyGuard（快速确定性拦截）                 │     │
│  │  - 破坏性命令：rm -rf / mkfs / find -delete /          │     │
│  │    | sh / eval / base64|sh / interpreter deletion      │     │
│  │  - 破坏性 SQL：DROP / TRUNCATE / DELETE without WHERE  │     │
│  │  - 保护路径：/etc/shadow / ~/.ssh / /proc /            │     │
│  │    /sys / /dev / /boot                                 │     │
│  │  → 命中即阻断（不进入 Tier 2）                         │     │
│  └────────────────────────────────────────────────────────┘     │
│       │ 通过                                                     │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Tier 2: LlmAuditor（LLM 语义审计）                    │     │
│  │  - 检测变量间接（a=$b; rm $a）                         │     │
│  │  - 检测混淆（base64 编码 / hex 编码 / 字符拼接）       │     │
│  │  - 检测数据外泄（curl | sh / wget | bash /             │     │
│  │    scp 到外部 IP / 数据库导出到文件后上传）            │     │
│  │  - 检测提权（sudo / su / chmod 4755 / setcap）         │     │
│  │  - 合并严格：LLM 只能升级（deny→confirm），            │     │
│  │    不能降级（confirm→allow）                            │     │
│  │  - Fail-safe：审计出错时升级到人工确认                  │     │
│  └────────────────────────────────────────────────────────┘     │
│       │ 通过                                                     │
│       ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Tier 3: Confirm gate + audit                          │     │
│  │  - 写/破坏操作需交互式 y/N 确认                        │     │
│  │  - 无 UI（print 模式）→ fail-closed 阻断               │     │
│  │  - 所有决策 + 结果写入 hash-chained 审计日志           │     │
│  │    hash = sha256(prev_hash || fields)                  │     │
│  │    任何事后篡改都会断链，可检测                        │     │
│  └────────────────────────────────────────────────────────┘     │
│       │ 通过                                                     │
│       ▼                                                          │
│  执行动作                                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.2.2 与 TDSF 安全设计对比

| 安全维度 | TDSF 现有 | OpAgent | TDSF 差距 |
|----------|-----------|---------|-----------|
| 命令级正则拦截 | ✅ RiskChecker 10 条 | ✅ PolicyGuard（超集） | TDSF 正则更少 |
| **语义级审计** | ❌ **缺失** | ✅ LlmAuditor | **TDSF 需新增** |
| 确认门 | ✅ needs_you 审批事件 | ✅ Confirm gate | 对齐 |
| **审计链防篡改** | ❌ 普通日志 | ✅ hash-chained | **TDSF 需新增** |
| 保护路径 | ⚠️ 部分 | ✅ /etc/shadow/~/.ssh//proc//sys//dev//boot | TDSF 需扩展 |
| 破坏性 SQL 拦截 | ❌ | ✅ DROP/TRUNCATE/DELETE without WHERE | TDSF 需新增 |
| Fail-safe | ⚠️ | ✅ 审计出错升级人工 | TDSF 需强化 |

#### 5.2.3 TDSF 借鉴清单（P1/P2 落地）

1. **P1：扩展 RiskChecker 正则**（从 10 条扩展到 OpAgent PolicyGuard 全集，含破坏性 SQL + 保护路径）
2. **P1：新增 LlmAuditor 语义审计层**（在 RiskChecker 之后、needs_you 之前，用 LLM 检测变量间接/混淆/外泄/提权）
3. **P2：hash-chained 审计链**（所有工具调用决策 + 结果写入 `~/.tdsf-data/audit.db`，sha256 前后链）
4. **P2：Fail-safe 机制**（LlmAuditor 出错时升级到 needs_you 人工确认，不降级）

### 5.3 LearnSSH（别名机制 + 凭据隔离）

#### 5.3.1 别名机制架构

```
┌─────────────────────────────────────────────────────────────────┐
│              LearnSSH 别名机制 + 凭据隔离架构                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    别名请求     ┌─────────────────┐        │
│  │  AI Agent       │ ──────────────▶ │  LearnSSH CLI   │        │
│  │  (Codex 等)     │                 │  (本地 npx)     │        │
│  │                 │ ◀────────────── │                 │        │
│  │  只接触:        │    stdout/stderr │                 │        │
│  │  - 命令结果     │    (JSON)        │                 │        │
│  │  - 元数据       │                 │                 │        │
│  └─────────────────┘                 └────────┬────────┘        │
│                                                │ 凭据查询        │
│                                                ▼                 │
│                                      ┌─────────────────┐        │
│                                      │  本地 SSH Agent  │        │
│                                      │  - 密码          │        │
│                                      │  - 私钥          │        │
│                                      │  - Passphrase   │        │
│                                      │  (不进聊天记录)  │        │
│                                      └─────────────────┘        │
│                                                                  │
│  安全保证：                                                      │
│  1. 凭据永不进入 AI 聊天记录                                      │
│  2. 凭据永不上传云端模型                                          │
│  3. AI 只通过别名发起请求                                         │
│  4. 高危命令（rm -rf /）本地拦截                                  │
│  5. JSON 输出便于 AI 解析                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.3.2 与 TDSF 凭据管理对比

| 凭据维度 | TDSF 现有 | LearnSSH | TDSF 差距 |
|----------|-----------|----------|-----------|
| 凭据存储 | ✅ Rust `keyring`（系统密钥库） | ✅ 本地 SSH Agent | 对齐 |
| 凭据传输 | ⚠️ `sshSessionId` 传给 sidecar | ✅ **别名解耦**（sidecar 不接触凭据） | **TDSF 需强化** |
| 凭据暴露 | ⚠️ sidecar 理论上可访问会话 | ✅ AI 只接触 stdout/stderr | TDSF 需评估 |
| 别名机制 | ❌ | ✅ | **TDSF 需新增** |
| 高危拦截 | ✅ RiskChecker | ✅ 本地拦截 | 对齐 |

#### 5.3.3 TDSF 借鉴清单（P2 落地）

1. **P2：服务器别名层**：sidecar 只接收别名（如"教学服务器-1"），Rust 侧 `keyring` 按别名解析凭据
2. **P2：凭据零暴露**：sidecar 工具只获得 `ssh_session_id`，永不获得密码/私钥原文（当前已部分实现，需强化审计）
3. **P2：高危命令本地拦截**：在 Rust 侧（`ssh_command` Tauri command）也加一层 RiskChecker（当前只在 sidecar 的 `ssh_command.py` 工具内）

### 5.4 ANOLISA（Agentic OS，Token-Less + AgentSight）

#### 5.4.1 Token-Less 三大策略

```
┌─────────────────────────────────────────────────────────────────┐
│              ANOLISA Token-Less 三大策略（节省 60% token）        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  策略 1: 模式压缩（Pattern Compression）                         │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  重复的环境探索模式（ls / pwd / whoami / uname）       │     │
│  │  → 封装为内置 Skill，agent 直接调用不消耗 token        │     │
│  │  例：agent 调 get_system_info() 一次性获得全部信息     │     │
│  │      而非 13 轮 ls/cat/whoami 探索                     │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  策略 2: 响应压缩（Response Compression）                        │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  长输出（journalctl / dmesg / log）截断 + 摘要         │     │
│  │  例：1000 行日志 → 摘要为 50 行关键信息 + 统计         │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  策略 3: 命令重写（Command Rewriting）                           │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  agent 提出的低效命令 → 重写为高效等效命令             │     │
│  │  例：for i in $(ls); do cat $i; done                   │     │
│  │      → cat *（等效但 token 更少）                      │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  效果：CVE 评估场景节省 60% token                                │
│  原因：传统 OS 80% token 花在"理解环境"，ANOLISA 内置 Skills     │
│        让 agent 直接调用不探索                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.4.2 AgentSight 可观测性

```
┌─────────────────────────────────────────────────────────────────┐
│              ANOLISA AgentSight（零侵入 agent 可观测）            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  零侵入：不改变业务逻辑，自动采集                      │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌─────────────────┬────────┴───────────┬─────────────────┐    │
│  │  工具调用链      │  token 消耗分布    │  执行延迟       │    │
│  │  (哪个工具→      │  (环境探索 vs      │  (每步耗时)     │    │
│  │   哪个工具)      │   实际任务)        │                 │    │
│  └─────────────────┴────────────────────┴─────────────────┘    │
│                            │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  关联分析：跨工具调用路径分析                           │     │
│  │  - 识别"无效探索循环"（agent 卡在环境探索）             │     │
│  │  - 识别"token 浪费点"（哪些工具调用可合并）             │     │
│  │  - 识别"延迟瓶颈"（哪个工具最慢）                      │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.4.3 与 TDSF 对比

| 维度 | TDSF 现有 | ANOLISA | TDSF 差距 |
|------|-----------|---------|-----------|
| Token 优化 | ❌ 全量 prompt 注入 | ✅ Token-Less 三策略 | **TDSF 需新增** |
| 内置 Skills | ⚠️ 5 运维 @tool | ✅ 系统管理+性能调优+安全运维 | TDSF 需扩展 |
| Agent 可观测 | ⚠️ langfuse_client | ✅ AgentSight 零侵入 | TDSF 需强化 |
| Copilot Shell | ❌ | ✅ cosh 自然语言 | 不同层（TDSF 是 IDE） |

#### 5.4.4 TDSF 借鉴清单（P2 落地）

1. **P2：Token-Less 模式压缩**：把高频环境探索（`pwd / whoami / uname / ls / cat /etc/os-release`）封装为 `get_system_info()` 单工具，agent 一次调用获得全部信息
2. **P2：Token-Less 响应压缩**：`analyze_logs` 工具的长输出自动截断 + 摘要（前 50 行 + 统计 + 关键行）
3. **P2：AgentSight 可观测**：在 `adapter.py` 的 `TdsfStrandsCallbackHandler` 中新增工具调用链 + token 消耗分布 + 延迟采集（零侵入，复用现有 callback_handler）

### 5.5 Open Interpreter 0.0.26（Rust 重写，harness 切换）

#### 5.5.1 Harness 切换范式

```
┌─────────────────────────────────────────────────────────────────┐
│              Open Interpreter 0.0.26 Harness 切换范式             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  单一 Agent Loop（Codex fork，Rust 重写）              │     │
│  │  - 流式工具调用循环                                    │     │
│  │  - API 重试 / 并行执行 / Token 计数 / 成本追踪         │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│  ┌─────────────────┬────────┴───────────┬─────────────────┐    │
│  │                 │  /harness 切换      │                 │    │
│  ▼                 ▼                    ▼                 ▼    │
│  ┌──────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐        │
│  │native│  │claude-code│  │ kimi-cli   │  │deepseek-  │  ...   │
│  │      │  │           │  │           │  │tui        │        │
│  │通用  │  │Anthropic  │  │Kimi K3    │  │DeepSeek   │        │
│  │harness│ │prompt模板 │  │prompt模板 │  │prompt模板 │        │
│  │      │  │+工具格式  │  │+工具格式  │  │+工具格式  │        │
│  └──────┘  └───────────┘  └───────────┘  └───────────┘        │
│                                                                  │
│  核心思想：                                                      │
│  - 模型是"大脑"（可替换）                                        │
│  - Harness 是"工作服"（不同模型用不同 prompt + 工具格式）         │
│  - 同一 agent loop + 不同 harness = 不同模型的最佳表现           │
│  - 让低成本模型（Kimi K3/Qwen/DeepSeek）获得 frontier 性能       │
│                                                                  │
│  完整 harness 列表：                                             │
│  native / claude-code / claude-code-bare / zcode /               │
│  kimi-cli / kimi-code / qwen-code / deepseek-tui /               │
│  swe-agent / minimal                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.5.2 与 TDSF 多模型适配对比

| 维度 | TDSF 现有 | Open Interpreter | TDSF 差距 |
|------|-----------|------------------|-----------|
| 多 provider | ✅ model_adapter.py（OpenAI/Anthropic/LiteLLM） | ✅ 4+ harness | 对齐 |
| **模型感知 prompt** | ❌ 统一 system_prompt | ✅ **harness 级 prompt 模板** | **TDSF 需新增** |
| **模型感知工具格式** | ❌ 统一 @tool 格式 | ✅ **harness 级工具格式** | **TDSF 需新增** |
| 切换方式 | ⚠️ 环境变量 LLMConfig | ✅ `/harness` 命令运行时切换 | TDSF 需评估 |
| ACP 兼容 | ❌ | ✅ | 不同层 |
| Codex SDK 兼容 | ❌ | ✅ 一行 binary override | 不同层 |

#### 5.5.3 TDSF 借鉴清单（P2 评估）

1. **P2 评估：模型感知的 agent 配置**：不同模型（DeepSeek / Qwen / Claude / GPT）用不同的 system_prompt 模板 + 工具调用格式（harness），而非统一的 system_prompt
2. **P2 评估：运行时 harness 切换**：前端新增"模型+harness"切换 UI（类似 Open Interpreter 的 `/harness`），而非重启 sidecar 切换

---

## 6. 其他新发现项目简介

### 6.1 SLES 16（SUSE 企业 Linux，Agentic OS）

与 ANOLISA 同属"Agentic OS"赛道，2025-11-04 GA，是**首个内置 Agentic AI 的企业 Linux**。TDSF 不直接集成（OS 层不同），但其"OS 级 agent 支持"是 TDSF 教学场景的未来演进方向。

### 6.2 SWE-agent / mini-swe-agent（Princeton NLP，学术参考）

19.8k stars，MIT，NeurIPS 2024。**主力转向 mini-swe-agent**（100 行 Python，SWE-bench 65%）。核心创新是 **ACI（Agent-Computer Interface）**——为 LLM 优化的代码库交互接口。TDSF 不直接集成（无 MCP / 研究基础设施），但 ACI 设计思想可借鉴。mini-swe-agent 证明"100 行 Python + 好 ACI = SWE-bench 65%"，印证 Strands 轻量范式正确。

### 6.3 OpenHarness（港大 HKUDS，5 层 Harness 框架）

1.4 万 stars（3 个月），Python 1 万行。5 层架构（Agent Loop / Toolkit 43 工具 / Context & Memory / Governance / Swarm）与 TDSF agent 基础设施完整对标。自带 ohmo 个人助手（飞书/Slack/Telegram/Discord）。**43 工具 + 54 指令 + 10 子智能体**是 TDSF 工具集扩展的参考规模。

### 6.4 OpenSquilla 0.4.0（自我验证编码 agent）

2026-07-01 发布。**红绿回归证据链**（先写失败测试 → 修功能 → 跑回归）让 AI Agent 在交付前证明"改对了"。**SquillaRouter** 智能模型路由按任务难度自动选模型（成本降 60-80%）。自我验证机制是 TDSF `fix_loop` 模块的进阶参考。

### 6.5 MiMo Code V0.1.0（小米终端编程助手）

5.1k stars（两周），MIT，基于 OpenCode。持久记忆系统 + 无限上下文 + 模型 Agent 协同优化。持久记忆与 TDSF `knowledge/` 模块对标。

### 6.6 OpenOcta v1.0.5（国产桌面 agent）

30M 安装包，国产 OS + 国产云 + 钉钉/飞书/企业微信 + DeepSeek/豆包/千问/GLM。国产企业市场参考。TDSF 当前 Tauri 安装包约 104MB，OpenOcta 的 30M 是体积优化参考。

### 6.7 qwen-code v0.19.8（终端编程 agent）

25k stars，Apache 2.0。**4 模型协议抽象层**（OpenAI/Anthropic/Gemini/Qwen），开发者可在 GPT-5.6 / Qwen3.6 / 本地 Ollama 间无缝切换。多协议抽象与 TDSF `model_adapter.py` 对标。

### 6.8 Reasonix（DeepSeek 优化终端 agent）

Go 重写 v1.0。**DeepSeek Prefix Cache 优化**（128 token 粒度，约 90% 成本折扣），长会话命中率 90%+。DeepSeek 官方 API 文档推荐集成。TDSF DeepSeek 教学场景的 token 成本控制参考。

### 6.9 CodeWhale（Rust 终端编码 agent）

纯 TUI，无浏览器、无 IDE 插件，启动快、占用低。Rust 终端 agent 轻量参考。

### 6.10 agent-ssh-cli（npm SSH 代理工具）

基于 ssh-mcp-server 改写的 CLI 形态。命令白名单/黑名单 + 断点续传 + 失败重试 + SKILL.md 集成。SFTP 断点续传是 TDSF SFTP 操作的参考。

---

## 7. 更新后的结论与建议

### 7.1 最终结论：Strands Agents 仍是首选，不替换

**v4 综合 v3 的 22 项目 + v4 新增 15 项目（共 37 项目）调研，结论不变：Strands Agents 1.48.0 仍是 TDSF Terminal Agent 集成运维 agent 能力的首选框架。**

**支撑理由**：

1. **37 项目中无任何项目颠覆 Strands 首选判断**：
   - AgentSSH（v4 新发现，9/10）：是 SSH 工具而非 agent 框架，借鉴架构而非替换 Strands
   - OpAgent（v4 新发现，8/10）：是独立运维 agent 而非 SDK 框架，借鉴安全设计而非替换 Strands
   - LearnSSH（v4 新发现，8/10）：是 SSH 桥梁而非 agent 框架，借鉴凭据隔离而非替换 Strands
   - ANOLISA（v4 新发现，7/10）：是 OS 层而非 agent 框架，借鉴 Token-Less 而非替换 Strands
   - Open Interpreter 0.0.26（v4 新发现，7/10）：是编码 agent 而非运维 agent 框架，借鉴 harness 切换而非替换 Strands

2. **TDSF 现有 `strands_backend/` 实现质量高**（1400+ 行，9/10 契合度，v3 审计确认）

3. **Strands 的不可替代优势**（37 项目中唯一同时满足）：
   - Python SDK 原生嵌入 sidecar
   - `@tool` 装饰器与 TDSF `tools/*.py` 范式对齐
   - MCPClient 原生支持（stdio + Streamable HTTP）
   - `stream_async` 异步流式
   - Apache 2.0 与上游 terax-ai 兼容
   - 13+ 模型提供商（含 Ollama 本地、LiteLLM 国内 DeepSeek/Qwen）
   - Agents-as-Tools / Handoffs / Swarm / Graph 多 Agent 模式
   - AWS 生产验证 + re:Invent 2025 新增能力（TypeScript SDK / BidiAgent / Steering / Evaluations）

4. **备选方案 PydanticAI v2.13.0 仍可用**（触发条件见 v3 §8.2，未触发）

### 7.2 是否需要第二套 agent 框架

**不需要**。理由：

1. **Strands + LangGraph 双后端 Feature Flag 已足够**（`TDSF_AGENT_BACKEND=strands|langgraph`）
2. **PydanticAI 作为备选**（触发条件明确，未触发时不动）
3. **v4 新发现的项目都是"借鉴对象"而非"替换对象"**：
   - AgentSSH 借鉴 SSH 架构（russh 同栈）
   - OpAgent 借鉴安全设计（三层 + 审计链）
   - LearnSSH 借鉴凭据隔离（别名机制）
   - ANOLISA 借鉴 Token 优化（Token-Less）
   - Open Interpreter 借鉴 harness 切换（模型感知 prompt）
4. **引入第二套框架的代价**（2-3 人日重写 + 维护成本）远高于收益

### 7.3 推荐的集成路线（v4 更新版）

**核心策略**：**Strands 首选 + 多项目借鉴深化**，不替换，在 P1/P2 阶段把 v4 新发现的安全/Token/SSH 架构借鉴点落地到现有 `strands_backend/`。

---

## 8. 更新后的集成路线图

### 8.1 v4 更新后的 P0/P1/P2/P3 路线图

#### P0（已完成）✅

维持 v3，`strands_backend/` 8 文件 1400+ 行已实现。

#### P1（1-2 人日，待执行，v4 新增 3 项）

**v3 原有 7 项**（维持）：
1. stream_async 升级
2. 终端上下文完善（transport.ts 传 live）
3. OpenWorker 安全设计强化（typed risk engine 4 级）
4. SRE Lab Doctor 教学模式（Diagnosis-only 开关）
5. TencentOS 22 工具分类法扩展
6. PydanticAI 备选后端
7. AIOps-example 07-framework-comparison 对比评估

**v4 新增 3 项**：
8. **OpAgent 三层安全借鉴**：
   - 扩展 `RiskChecker` 正则（从 10 条扩展到 OpAgent PolicyGuard 全集，含破坏性 SQL + 保护路径 /etc/shadow/~/.ssh//proc//sys//dev//boot）
   - 新增 **LlmAuditor 语义审计层**（在 RiskChecker 之后、needs_you 之前，用 LLM 检测变量间接/混淆/外泄/提权）
   - Fail-safe 机制（LlmAuditor 出错时升级到 needs_you，不降级）
9. **OpenSquilla 自我验证借鉴**：
   - 在 `fix_loop` 模块新增"红绿回归证据链"（先写失败测试 → 修功能 → 跑回归）
   - 强化 `debug_agent` 的验证闭环
10. **OpenHarness 工具集规模参考**：
   - 评估从 5 运维 @tool 扩展到 43 工具的优先级排序（参考 OpenHarness Toolkit 43 工具分类）

#### P2（2-3 人日，待执行，v4 新增 5 项）

**v3 原有 7 项**（维持）：
1. 双向 JSON-RPC（Python → Rust 请求）
2. 多 Agent 模式（Agents-as-Tools）
3. MCPClient 消费外部 MCP server
4. kagent 声明式 Agent CRD 借鉴
5. HolmesGPT toolsets YAML 借鉴
6. Steering 边界引导
7. MLflow 可观测性

**v4 新增 5 项**：
8. **AgentSSH 架构借鉴**（最重要）：
   - `src-tauri/src/modules/ssh/` 新增连接池（参考 AgentSSH daemon-pooled）
   - `rust_bridge.send_request()` 返回值统一为 `{"ok":bool,"status":str,"exit_code":int,"stdout":str,"stderr":str}` JSON 格式
   - `ssh_command` 工具新增 `suspend_timeout` 参数（默认 30s），超时返回 `session_id` 供后续读取
   - `SshTerminalPane.tsx` 的 sudo 交互参考 `expect-respond` 模式
9. **OpAgent hash-chained 审计链借鉴**：
   - 所有工具调用决策 + 结果写入 `~/.tdsf-data/audit.db`（SQLite）
   - sha256 前后链（`hash = sha256(prev_hash || fields)`），防篡改
   - 前端新增审计查看 UI（`/audit list` / `/audit verify`）
10. **LearnSSH 别名机制借鉴**：
    - 新增服务器别名层（sidecar 只接收别名，Rust 侧 keyring 按别名解析凭据）
    - 凭据零暴露强化（sidecar 工具只获得 ssh_session_id，永不获得密码/私钥原文）
    - Rust 侧 ssh_command Tauri command 加一层 RiskChecker（双层拦截）
11. **ANOLISA Token-Less 借鉴**：
    - 模式压缩：把高频环境探索封装为 `get_system_info()` 单工具
    - 响应压缩：`analyze_logs` 长输出自动截断 + 摘要
    - AgentSight 可观测：在 callback_handler 新增工具调用链 + token 消耗分布 + 延迟采集
12. **Open Interpreter harness 切换借鉴**：
    - 评估模型感知的 agent 配置（不同模型用不同 system_prompt + 工具格式）
    - 前端新增"模型+harness"切换 UI（运行时切换，不重启 sidecar）

#### P3（视情况落地，长期，v4 新增 2 项）

**v3 原有 5 项**（维持）：
1. MCP server 反向暴露
2. Aurora 多 agent 范式借鉴
3. BitFun 四模式 UX
4. A2A 协议支持
5. Bedrock AgentCore 9 服务评估

**v4 新增 2 项**：
6. **ANOLISA 内置 Skills 生态借鉴**：评估"高频运维操作封装为 Skill 模块"（agent 直接调用不消耗 token 探索环境），目标降低 30%+ token 开销
7. **SLES 16 / Agentic OS 教学场景**：评估 TDSF 教学场景在 Agentic OS（ANOLISA / SLES 16）上的演进方向（学员在 Agentic OS 上学习运维）

### 8.2 v4 更新后的借鉴项目全景（v3 的 12 + v4 的 6 = 18 项目）

| 借鉴维度 | 项目 | TDSF 落地点 | 阶段 |
|----------|------|------------|:---:|
| @tool + MCPClient + stream_async | Strands Agents | 直接集成 | P0 ✅ |
| typed risk engine 4 级 | OpenWorker | tools/risk.py 强化 | P1 |
| Diagnosis-only 教学模式 | SRE Lab Doctor | 教学模式开关 | P1 |
| 22 工具分类法 | TencentOS MCP Server | 工具集扩展 | P1 |
| **三层安全 + LlmAuditor** | **OpAgent**（v4） | **RiskChecker + 语义审计** | **P1** |
| **自我验证证据链** | **OpenSquilla**（v4） | **fix_loop 强化** | **P1** |
| **43 工具规模参考** | **OpenHarness**（v4） | **工具集扩展优先级** | **P1** |
| 双向 JSON-RPC | v3 路线图 | rust_bridge | P2 |
| **daemon-pooled + JSON + suspend** | **AgentSSH**（v4） | **SSH 连接池 + 输出格式** | **P2** |
| **hash-chained 审计链** | **OpAgent**（v4） | **audit.db** | **P2** |
| **别名机制凭据隔离** | **LearnSSH**（v4） | **服务器别名层** | **P2** |
| **Token-Less + AgentSight** | **ANOLISA**（v4） | **token 优化 + 可观测** | **P2** |
| **harness 切换** | **Open Interpreter**（v4） | **模型感知 agent 配置** | **P2** |
| 声明式 Agent CRD | kagent | YAML 定义 agent | P2 |
| toolsets YAML | HolmesGPT | YAML 定义工具集 | P2 |
| MCP server 反向暴露 | v3 路线图 | FastMCP + streamable-http | P3 |
| Memgraph + Weaviate | Aurora | 依赖图 + 知识库 | P3 |
| **内置 Skills 生态** | **ANOLISA**（v4） | **Skill 模块封装** | **P3** |

### 8.3 风险与缓解（v4 更新）

| 风险 | 概率 | 影响 | 缓解 |
|------|:---:|:---:|------|
| Strands 依赖 litellm 与 pydantic/chromadb 冲突 | 中 | 高 | 虚拟环境隔离测试；冲突时切 PydanticAI |
| sidecar async event loop 不支持 stream_async | 中 | 中 | 保留 callback_handler 兼容路径 |
| **LlmAuditor 语义审计增加 LLM 调用成本** | **高** | **中** | **只对写/破坏操作触发语义审计，只读跳过（参考 OpAgent）** |
| **hash-chained 审计链 SQLite 性能** | **低** | **低** | **异步写入 + 批量提交** |
| **别名机制破坏现有 sshSessionId 传递** | **中** | **中** | **P2 先做别名层兼容 sshSessionId，P3 再完全切换** |
| 22 工具扩展工作量超预期 | 高 | 低 | 分批实现（P1 先 10 个核心，P2 再 12 个高级） |
| kagent/HolmesGPT 范式借鉴引入过度设计 | 中 | 中 | 严格按需，不盲目跟风 |
| LangGraph 后端废弃影响现有功能 | 低 | 高 | 保留 LangGraph 后端作为第三 Feature Flag |

---

## 附录：调研来源汇总

### A.1 v4 新增来源（WebSearch + WebFetch）

**AgentSSH**：
- [lib.rs/crates/agentssh](https://lib.rs/crates/agentssh) — AgentSSH crates.io 主页（MIT，Rust，russh 同栈）

**OpAgent**：
- [npmjs.com/package/@xianzongwendao/op-agent](https://www.npmjs.com/package/@xianzongwendao/op-agent) — OpAgent npm 主页（三层安全 + hash-chained 审计）
- 注意：蚂蚁集团 CodeFuse-ai/OpAgent 是 Web GUI Agent（WebArena SOTA 71.6%），与运维无关，不作为 TDSF 集成对象

**LearnSSH**：
- [80aj.com/2026/07/04/learnssh-ai-security](https://www.80aj.com/2026/07/04/learnssh-ai-security/) — LearnSSH 开源报道（别名机制 + 凭据隔离）

**ANOLISA**：
- [alibabacloud.com/blog/alibaba-cloud-releases-anolisa-agentic-os](https://www.alibabacloud.com/blog/alibaba-cloud-releases-anolisa-agentic-os-the-first-agent-oriented-operating-system_603295) — ANOLISA 发布博客
- [help.aliyun.com/en/alinux/faq](https://help.aliyun.com/en/alinux/faq) — ANOLISA FAQ（Token-Less + AgentSight + 开源地址）
- [alibabacloud.com/blog/alibaba-cloud-unveils-the-agent-infrastructure-panorama](https://www.alibabacloud.com/blog/alibaba-cloud-unveils-the-agent-infrastructure-panorama-%E2%80%94-anolisa-as-the-runtime-foundation-for-every-agent_603359) — ANOLISA Agent Infrastructure Panorama

**SLES 16**：
- [suse.com/c/2025/11/](https://www.suse.com/c/2025/11/) — SUSE 2025-11 博客（SLES 16 GA，首个内置 Agentic AI 的企业 Linux）

**Open Interpreter 0.0.26**：
- [ai-tldr.dev/releases/openinterpreter-rust-0-0-26/](https://ai-tldr.dev/releases/openinterpreter-rust-0-0-26/) — Open Interpreter 0.0.26 Rust 重写发布
- [gitmemories.com/index.php/openinterpreter/openinterpreter](http://www.gitmemories.com/index.php/openinterpreter/openinterpreter) — Open Interpreter README（harness 列表）
- [cloud.tencent.com/developer/article/2710226](https://cloud.tencent.com.cn/developer/article/2710226) — Open Interpreter 中文解析

**SWE-agent**：
- [yuzec.com/tools/swe-agent](https://yuzec.com/tools/swe-agent) — SWE-agent 介绍
- [theaiagentindex.com/agents/swe-agent](https://theaiagentindex.com/agents/swe-agent) — SWE-agent 评测（19.8k stars，mini-swe-agent 转向）
- [yuv.ai/blog/swe-agent-v2](https://yuv.ai/blog/swe-agent-v2) — SWE-agent 2.0 ACI 详解

**OpenHarness**：
- [toutiao.com/group/7658965387723407912](http://m.toutiao.com/group/7658965387723407912/?upstream_biz=VolcEngine) — OpenHarness 港大 HKUDS 开源（1.4 万 stars，5 层架构）

**OpenSquilla / MiMo Code / OpenOcta / qwen-code / Reasonix**：
- [cloud.tencent.com/developer/article/2707508](https://cloud.tencent.com/developer/article/2707508) — 2026-07 开源 AI 编程工具爆发（OpenSquilla 自我验证）
- [toutiao.com/group/7662587806052680228](http://m.toutiao.com/group/7662587806052680228/?upstream_biz=VolcEngine) — 去模型化革命（qwen-code / OpenOcta / OpenSquilla）
- [toutiao.com/group/7649974421381333544](http://m.toutiao.com/group/7649974421381333544/?upstream_biz=VolcEngine) — 2026-06 7 个开源 AI Agent（Reasonix / CodeWhale）

**agent-ssh-cli**：
- [npmjs.com/package/agent-ssh-cli](https://www.npmjs.com/package/agent-ssh-cli) — agent-ssh-cli npm 主页

### A.2 v3 原有来源（见 v3 报告附录 A）

完整来源列表见 `docs/reports/ops-agent-opensource-survey-2026-07-30-v3.md` 附录 A。

---

> **报告终**
> **版本**：v4.0（2026-07-30，v3 + 15 新发现项目）
> **作者**：TDSF Terminal Agent 调研
> **数据基准**：2026-07-30 WebSearch + WebFetch + GitHub + PyPI + crates.io + npm + 官方文档站真实抓取
> **总项目数**：37（v3 的 22 + v4 的 15）
> **核心结论**：Strands Agents 首选不变，v4 新发现的 AgentSSH / OpAgent / LearnSSH / ANOLISA / Open Interpreter 作为借鉴对象强化 P1/P2 路线图
> **下一步**：按 §8 P1 路线图执行（v3 的 7 项 + v4 新增 3 项 = 10 项），重点落地 OpAgent 三层安全 + OpenSquilla 自我验证 + OpenHarness 工具规模参考
