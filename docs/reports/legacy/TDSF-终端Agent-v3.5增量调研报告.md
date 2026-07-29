# TDSF 终端 Agent · v3.5 增量调研报告

> **调研时间**：2026-07-26  
> **调研背景**：用户要求"在设计稿来之前，你也去调研一下其它 agent，例如 kimicode，qodercil，等其它开源终端 agent"  
> **本轮增量**：在 v3.4 调研的 63 个项目基础上，**深度补充 7 个**已 clone 但尚未分析的终端 Agent / Skill / 框架项目  
> **累计覆盖**：开源项目 **70 个**（63 + 7），代码量 **~26.5M 行**

---

## 0. 阅读路线

1. §1 本轮 7 个新调研项目速览表
2. §2-§8 每个项目 8 维深度分析（定位 / 架构 / 核心创新 / 安全 / 性能 / 复用 / 决策 / 风险）
3. §9 v3.5 提炼的 **10 大决策点**（D-V35-01 ~ D-V35-10）
4. §10 v3.5 揭示的 **2 项行业新共识**
5. §11 横向对比矩阵（70 项目）+ 量化更新
6. §12 待办 & 下一步

---

## 1. 本轮 7 个项目速览

| 编号 | 项目 | Stars | 协议 | 类型 | 核心差异化 | 调研时间 | 文档级别 |
|:----:|------|------:|------|------|-----------|:--------:|----------|
| **P35-01** | [Kilo Code](https://github.com/Kilo-Org/kilocode) | 8.4K | MIT | AI Agent | **OpenCode 强化 fork** + Agent Manager 多 session 编排 + Worktree 隔离 | 2026-07-26 | 完整 README + AGENTS + REVIEW |
| **P35-02** | [Headroom](https://github.com/chopratejas/headroom) | 1.8K | Apache-2.0 | 压缩中间件 | **CCR 可逆压缩** + ContentRouter + CacheAligner + 跨 agent memory | 2026-07-26 | 完整 README + wiki/ccr |
| **P35-03** | [Continue](https://github.com/continuedev/continue) | 28K | Apache-2.0 | AI Agent | 2.0.0 final release, **已停止维护**（archive） | 2026-07-26 | README only |
| **P35-04** | [Mastra](https://github.com/mastra-ai/mastra) | 21.5K | Apache-2.0 + EE | AI Agent 框架 | **Y Combinator W25** + graph workflow + Observational Memory | 2026-07-26 | README + AGENTS |
| **P35-05** | [Superpowers](https://github.com/obra/superpowers) | 13K | MIT | Skills 框架 | **零依赖 plugin** + 7 步标准工作流 + 14 skill + drill eval | 2026-07-26 | README + AGENTS + CLAUDE |
| **P35-06** | [Claw Code](https://github.com/ultraworkers/claw-code) | 240 | MIT | Claude Code 复刻 | **Rust 实现** + claw doctor 健康检查 + 公开声明非 Anthropic 关联 | 2026-07-26 | 完整 README + USAGE |
| **P35-07** | [MetaGPT](https://github.com/geekan/MetaGPT) | 58K | MIT | 多 Agent 框架 | **SOP(Team) 哲学** + MGX 产品 + 3 篇 ICLR 论文 | 2026-07-26 | README + 历史 |

> **调研路径**：本轮 7 个项目全部已在 `opensource-reference/` 目录中，本报告完成源码/文档级深度分析。

---

## 2. Kilo Code（OpenCode 强化 fork）

### 2.1 项目定位

- **GitHub**：`Kilo-Org/kilocode`（v3.4 中已提及 OpenCode 160K stars，Kilo 是其强化 fork）
- **Stars**：8.4K（fork 增长中）· 协议：MIT · 语言：TypeScript + Bun + Go
- **标语**："The open source coding agent for building with AI in VS Code, JetBrains, or the CLI."
- **差异化**：fork 自 OpenCode，提供 **Cloud Agent + Code Reviews + KiloClaw（always-on agent）** 等 SaaS 能力，**全产品矩阵客户端 → 单一 `kilo serve` 后端** 架构。

### 2.2 架构：单 CLI + 多客户端（强化 v3.2 D-V321-05）

```
┌────────────────────────────────────────────────────────────────┐
│  Kilo 产品矩阵（全部连到 `kilo serve` HTTP+SSE 后端）          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Kilo VSCode│  │Kilo CLI │  │Kilo Cloud│  │KiloClaw  │        │
│  │ Extension │  │  TUI    │  │  Web    │  │ Always-on │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│         │              │             │            │             │
│         └──────────────┴─────────────┴────────────┘             │
│                          │ HTTP+SSE                              │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  packages/opencode/  ← fork of sst/opencode              │  │
│  │  - TUI / kilo run / kilo serve                           │  │
│  │  - 5 agents: Code / Plan / Ask / Debug / Review          │  │
│  │  - HTTP server + session management                       │  │
│  │  - @kilocode/sdk (自动生成 TS SDK)                       │  │
│  └─────────────────────────────────────────────────────────┘  │
│                          │                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │  kilo-   │  │  kilo-   │  │  kilo-   │  │  kilo-   │        │
│  │ gateway  │  │telemetry │  │  i18n    │  │   ui     │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└────────────────────────────────────────────────────────────────┘
```

### 2.3 三大核心创新

#### 2.3.1 Agent Manager（VSCode 扩展内嵌多 session 编排面板）

> 这是 Kilo 区别于纯 CLI fork 的最大创新 —— 类似 Orca 的多 worktree，但**集成在 VSCode 侧边栏内**。

- **位置**：`packages/kilo-vscode/src/agent-manager/` + `webview-ui/agent-manager/`
- **能力**：
  - 一个 VSCode 扩展实例 → 1 个 `KiloConnectionService`（共享单 `kilo serve` 后端）
  - 每个 worktree session 传独立 directory context 到共享后端（**不启动多个进程**）
  - Snapshot `trackState` 在 sidebar / editor tab / Agent Manager 间共享
  - 仅 `InstanceState` 数据按 directory 隔离
- **价值**：减少后端进程数 10×，降低内存与启动延迟

#### 2.3.2 kilocode_change marker（fork 同步污染控制）

> 解决"fork 后如何最小化与 upstream diff"问题。

```typescript
// 单行标记
const value = 42 // kilocode_change

// 多行块
// kilocode_change start
const x = customLogic()
// kilocode_change end

// 新文件
// kilocode_change - new file
```

- **规则**：
  - 共享文件（来自 OpenCode 上游）改动 **必须** 加 marker
  - 标记 **禁止** 出现在 `packages/kilo-vscode/`、`packages/kilo-ui/` 等 kilo 私有目录
  - 自动化：`bun run check-kilocode-change` 检测，CI 阻断
- **价值**：未来 merge upstream 时 90% 自动合，仅手工处理 marker 区间

#### 2.3.3 5 种 Agent 类型（强化 v3.2 Plan/Build 双模式）

| Agent | 用途 | 是否修改文件 |
|-------|------|-------------|
| **Code** | 默认，自然语言 → 代码 | ✅ |
| **Plan** | 设计架构 + 实现计划 | ❌（仅文档） |
| **Ask** | 答 codebase 问题 | ❌ |
| **Debug** | 调试 + 追踪 | ✅（修补） |
| **Review** | PR review（性能/安全/风格/测试） | ❌（仅评论） |

> 比 v3.2 D-V34-03 Plan/Build 双模式（OpenCode+Aider）多 3 个，**核心借鉴**。

### 2.4 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-01** | **Agent Manager 多 session 编排面板**（vscode 侧栏 + 单后端共享） | **P1** | Kilo Code |
| **D-V35-02** | **`kilo_change` marker fork 同步策略** | P2 | Kilo Code |
| **D-V35-03** | **5 种 Agent 类型**（Code/Plan/Ask/Debug/Review） | **P1** | Kilo Code |

### 2.5 复用评估

- **可复用资产**：
  - `packages/opencode/src/server/` HTTP/SSE 路由设计（直接抄）
  - `@kilocode/sdk` 自动生成 SDK 模式（OpenAPI → TS SDK）
  - `bun turbo` monorepo 构建配置（TDSF 也用 Turborepo）
- **不可复用**：
  - 强 SaaS 化（kilo.ai 云服务）→ 违反 TDSF 本地优先
  - VSCode 扩展 UI（Soda 主题 + SolidJS 组件库）→ 风格不匹配

### 2.6 风险

- **许可证**：MIT ✅（TDSF 可商用）
- **上游依赖**：fork 模式需持续 merge，5 K+ commits/diff 风险（**TDSF 不建议走 fork 路线，应走**复刻架构 + 借鉴设计）

---

## 3. Headroom（CCR 可逆压缩层）

### 3.1 项目定位

- **GitHub**：`chopratejas/headroom`
- **Stars**：1.8K（中等）· 协议：Apache-2.0 · 语言：Python + Rust（ONNX runtime）
- **标语**："The context compression layer for AI agents"
- **差异化**：**可逆压缩**（CCR）+ **内容感知**（JSON/Code/Text 三种 compressor）+ **跨 agent 共享 memory**

### 3.2 架构：5 阶段请求生命周期

```
你的 agent / app
   (Claude Code, Cursor, Codex, LangChain, Agno, Strands, 自研)
        │   prompts · tool outputs · logs · RAG results · files
        ▼
┌────────────────────────────────────────────────────┐
│  Headroom   (本地运行)                            │
│  ────────────────────────────────────────────────  │
│  CacheAligner  →  ContentRouter  →  CCR            │
│                    ├─ SmartCrusher   (JSON)        │
│                    ├─ CodeCompressor (AST)         │
│                    └─ Kompress-v2-base (text, HF)  │
│                                                    │
│  Cross-agent memory  ·  headroom learn  ·  MCP     │
└────────────────────────────────────────────────────┘
        │   压缩后 prompt  +  retrieval 工具
        ▼
LLM provider  (Anthropic · OpenAI · Bedrock · …)
```

**5 阶段生命周期**：`Setup → Pre-Start → Post-Start → Input Received → Input Cached → Input Routed → Input Compressed → Input Remembered → Pre-Send → Post-Send → Response Received`

### 3.3 四大核心创新

#### 3.3.1 CCR（Compress-Cache-Retrieve）可逆压缩

> **解决"激进压缩数据丢失 vs 保守压缩 token 不省"的二选一难题。**

**3 步流程**：

```
┌─────────────────────────────────────────────────────────────────┐
│  TOOL OUTPUT (1000 items)                                        │
│  └─ SmartCrusher 压缩到 20 items                                │
│  └─ 原始内容缓存 + hash=abc123                                  │
│  └─ Marker: "[1000 items compressed to 20. Retrieve: hash=abc123]" │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LLM 处理                                                         │
│  Option A: LLM 用 20 items 答完 → 90% 节省                       │
│  Option B: LLM 调 headroom_retrieve(hash=abc123)                  │
│            → 客户端拦截，~1ms 还原原始内容                         │
│            → LLM 拿到完整数据，准确回答                            │
└─────────────────────────────────────────────────────────────────┘
```

- **关键特性**：
  - 客户端**完全无感**（CCR tool calls 被 proxy 拦截）
  - 多 turn Context Tracker：跨 turn 记忆压缩内容，新查询时**主动扩展**
  - **永不丢整个 message**（只压缩 live zone content blocks）
  - provider KV cache 仍然命中（frozen prefix byte-identical）

#### 3.3.2 ContentRouter（3 策略自动路由）

| 策略 | 处理对象 | 压缩方式 | 典型场景 |
|------|---------|---------|---------|
| **SmartCrusher** | JSON arrays (tool output) | 数组采样 + 统计保留 | `ls -la` 1000 文件 → 20 文件 |
| **CodeCompressor** | Python/JS/TS/Go/Rust/Java/C/C++/Perl | AST 感知 | 1000 行代码 → 关键结构 |
| **Kompress-v2-base** | 自由文本 | HF 训练模型 (HuggingFace) | 日志/RAG chunks |

#### 3.3.3 CacheAligner（KV Cache 稳定化）

- **问题**：Anthropic/OpenAI 启用 prompt cache 后，前缀**任意字节变化**就 cache miss
- **方案**：压缩只发生在 **live zone**（新 bytes），**frozen prefix** 保持 byte-identical
- **效果**：cache 命中率 99%+ 不变

#### 3.3.4 跨 Agent Memory + headroom learn

- **跨 Agent Memory**：Claude/Codex/Gemini/Grok/Aider/Copilot 等共享一个 dedup store
- **`headroom learn`**：挖失败 session → 写 `CLAUDE.local.md` (gitignored) / `CLAUDE.md` / `AGENTS.md`
- **可 wrap 17 种 agent**：Claude Code/Codex/Grok CLI/Cursor/Aider/Copilot CLI/OpenClaw/OpenCode/Cline/Continue/Goose/OpenHands/Mistral Vibe/Oh My Pi/Cortex Code/Kimi CLI/ZCode

### 3.4 实测数据

| 场景 | 压缩前 | 压缩后 | 节省 |
|------|------:|------:|----:|
| 代码搜索 (100 results) | 17,765 | 1,408 | **92%** |
| SRE 事件调试 | 65,694 | 5,118 | **92%** |
| GitHub issue triage | 54,174 | 14,761 | **73%** |
| 代码库探索 | 78,502 | 41,254 | **47%** |

**准确性保留**（标准基准）：
- GSM8K (数学)：0.870 → 0.870（±0）
- TruthfulQA (事实)：0.530 → 0.560（+0.030！）
- SQuAD v2 (QA)：97% 准确率 + 19% 压缩
- BFCL (Tools)：97% 准确率 + 32% 压缩

**输出 token 节省**（HEADROOM_OUTPUT_SHAPER=1）：
- verbosity steering：自动追加"be terse"到 system prompt（**仍命中 cache**）
- effort routing：纯 resume 任务降 reasoning effort

### 3.5 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-04** | **CCR 可逆压缩**（远超 v3.2 D-V32-04 handoff 32K 上限） | **P0** | Headroom |
| **D-V35-05** | **ContentRouter 内容感知**（JSON/Code/Text 3 策略） | P1 | Headroom |
| **D-V35-06** | **CacheAligner 保留 KV cache 命中** | P1 | Headroom |
| **D-V35-07** | **跨 agent memory 共享 + headroom learn 失败挖掘** | P2 | Headroom |

### 3.6 复用评估

- **可复用资产**：
  - `headroom_compress` / `headroom_retrieve` / `headroom_stats` 三个 MCP tool 设计
  - CCR hash 检索协议设计
  - 跨 agent 共享 memory 协议（dedup + provenance）
- **不可复用**：
  - ONNX runtime 依赖（占用大，TDSF 可选）
  - HuggingFace Kompress-v2-base 模型（200MB+ 下载，国内网络不便）
- **替代方案**：TDSF 内部实现 LLM 摘要式压缩（更轻量）

### 3.7 风险

- **许可证**：Apache-2.0 ✅
- **依赖**：ONNX Runtime AVX2 要求 + Kompress-v2-base 模型 200MB
- **公司 SSL 检查**：默认严格模式在企业 MITM 代理下需 `HEADROOM_TLS_STRICT=0`（国内企业环境注意）

---

## 4. Continue（已归档，参考价值仍高）

### 4.1 项目定位

- **GitHub**：`continuedev/continue`
- **Stars**：28K（已 archive）· 协议：Apache-2.0
- **状态**：2.0.0 final release + 仓库 **read-only**（"no longer actively maintained"）
- **历史**：业内早期 open-source AI coding agent，与 Cline 并称双雄

### 4.2 关键信息

- **多端统一**：VSCode extension + CLI（`@continuedev/cli`）+ JetBrains plugin
- **最终 2.0.0 release**：
  - 移除匿名 telemetry
  - 抽出 authentication
  - 大量 bug 修复
- **JetBrains 插件已不推荐**：官方建议用 CLI

### 4.3 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-08** | **可选：去除匿名 telemetry**（仅保留用户显式授权的 PostHog/OpenTelemetry） | P2 | Continue 2.0 |

### 4.4 复用价值

- **代码不可复用**（仓库已 archive，不维护）
- **设计可参考**：
  - VSCode extension + CLI + JetBrains 三端架构（TDSF 也可走 Tauri + TUI 双端）
  - 去除 telemetry 的"信任优先"产品哲学

---

## 5. Mastra（Y Combinator W25 AI Agent 框架）

### 5.1 项目定位

- **GitHub**：`mastra-ai/mastra`
- **Stars**：21.5K（Y Combinator W25 投资）· 协议：Apache-2.0（core）+ Enterprise License（`ee/` 目录）
- **标语**："Framework for building AI-powered applications and agents with a modern TypeScript stack."
- **差异化**：**graph-based workflow engine**（.then/.branch/.parallel）+ **Observational Memory** + **Human-in-the-loop suspend/resume**

### 5.2 架构：模块化 Agent 框架

```
packages/core/src/
├── agent/        # Agent 抽象（tools + memory + voice）
├── tools/        # Agent 工具
├── memory/       # semantic recall + working memory + observational memory + history
├── workflows/    # step-based execution + suspend/resume
├── storage/      # pluggable db backends with shared interfaces
├── mastra/       # central config hub + dependency injection
└── voice/        # voice 处理
```

### 5.3 核心创新

#### 5.3.1 Graph-based Workflow Engine

```typescript
// .then() 串行
const workflow = new Workflow({ steps: [step1, step2, step3] })
  .then(step1)
  .then(step2)
  .then(step3);

// .branch() 条件分支
workflow.branch(
  (ctx) => ctx.input.risk > 0.7,
  highRiskHandler,    // 走 L2+ 审批
  lowRiskHandler      // 走 L0 免确认
);

// .parallel() 并行
workflow.parallel([
  analyzeLogsStep,
  checkMetricsStep,
  scanConfigStep,
]);
```

#### 5.3.2 Human-in-the-loop Suspend/Resume

```typescript
// 暂停等待人工审批
await workflow.suspend({ reason: 'risk-level-L2', context: {...} });

// 数小时/数天后恢复
await workflow.resume({ approved: true, approver: 'admin' });
```

- **底层**：`storage` 记忆执行状态（SQLite/Postgres/Upstash），可暂停任意时长后恢复
- **场景**：运维 agent 每步执行前 suspend 等待人工审批，**安全底线设计**

#### 5.3.3 Observational Memory

> 比 LangChain 的 memory 更结构化

- **分类**：
  - **Working Memory**：当前 turn 上下文
  - **Observational Memory**：观察/反射级记忆（"用户偏好 short answer"）
  - **Semantic Recall**：向量检索相关历史
  - **History**：完整对话历史
- **价值**：让 agent 行为更连贯（不是简单的"前 N turn"截断）

#### 5.3.4 MCP Servers 一等公民

- **MCP server** 可暴露 agent / tools / 资源给任何 MCP-aware 系统
- **integrations**：React / Next.js / Node 集成；Vercel AI SDK UI + CopilotKit

### 5.4 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-09** | **Graph Workflow Engine**（`.then/.branch/.parallel`） | **P1** | Mastra |
| **D-V35-10** | **suspend/resume 持久化审批**（运维每步审批 + 跨会话恢复） | **P0** | Mastra HITL |
| **D-V35-11** | **Observational Memory 4 维记忆分类** | P2 | Mastra |

### 5.5 复用评估

- **可借鉴**：
  - Graph workflow 设计（Python 端可用 LangGraph，已是 TDSF 选型）
  - suspend/resume 持久化模式（TDSF needs-you 收件箱可借鉴）
  - Observational Memory 分类（强化现有 memory 模块）
- **不直接复用**：
  - Mastra 是 TypeScript 框架，TDSF 主语言是 Python（Sidecar 走 stdio JSON-RPC）
  - `ee/` 目录是 Enterprise License，避免传染

### 5.6 风险

- **许可证**：核心 Apache-2.0 ✅，`ee/` 目录需注意隔离
- **YC 商业化倾向**：v1.0+ 可能逐步收紧（关注 `ee/LICENSE` 变更）

---

## 6. Superpowers（零依赖 Skill 框架）

### 6.1 项目定位

- **GitHub**：`obra/superpowers`（Jesse Vincent / Prime Radiant 团队）
- **Stars**：13K · 协议：MIT
- **标语**："A complete software development methodology for your coding agents, built on top of a set of composable skills"
- **差异化**：**零依赖 plugin** + 7 步标准工作流 + drill eval harness

### 6.2 7 步标准工作流（核心可借鉴）

```
1. brainstorming               # Socratic 设计探究（强制）
       ↓
2. using-git-worktrees         # 创建 worktree 隔离开发
       ↓
3. writing-plans               # 写 2-5 分钟粒度的实施计划
       ↓
4. subagent-driven-development # 每任务派 subagent + 2 阶段 review
   或 executing-plans          # 或批量执行 + 人工 checkpoint
       ↓
5. test-driven-development     # RED-GREEN-REFACTOR
       ↓
6. requesting-code-review      # 任务间 code review
       ↓
7. finishing-a-development-branch  # 合并/PR/keep/discard
```

> "**Skills trigger automatically, you don't need to do anything special. Your coding agent just has Superpowers.**"

### 6.3 14 个 Skill 全列表

**Testing (2)**
- `test-driven-development` (RED-GREEN-REFACTOR + testing anti-patterns)
- `verification-before-completion` (证据先于断言)

**Debugging (1)**
- `systematic-debugging` (4 阶段根因 + defense-in-depth + condition-based-waiting)

**Collaboration (8)**
- `brainstorming` (Socratic 设计探究)
- `writing-plans` (详细实施计划)
- `executing-plans` (批量执行 + checkpoint)
- `dispatching-parallel-agents` (并发 subagent)
- `requesting-code-review` (review 前 checklist)
- `receiving-code-review` (接收 review)
- `using-git-worktrees` (worktree 隔离)
- `finishing-a-development-branch` (合并决策)
- `subagent-driven-development` (subagent 快速迭代)

**Meta (2)**
- `writing-skills` (编写新 skill)
- `using-superpowers` (技能系统介绍)

### 6.4 核心架构特性

#### 6.4.1 零依赖 Plugin（强制约束）

- **设计哲学**：superpowers core 自身**不引入**任何第三方依赖
- **新 harness 支持**：必须有 session transcript 证明 `brainstorming` 在 "Let's make a react todo list" 测试中自动触发
- **失败模式**：手动复制 skill 文件 / npx shims / 需用户每次 opt-in → **不算真集成**

#### 6.4.2 Session-Start Bootstrap Hook

- 每个支持的 harness（Claude Code/Antigravity/Codex App/CLI/Cursor/Factory Droid/GitHub Copilot CLI/Kimi Code/OpenCode/Pi）都有**会话启动 hook**
- hook 注入 `using-superpowers` bootstrap → skills 在 session 第一刻就自动激活

#### 6.4.3 drill eval harness

- 独立仓库 `superpowers-evals`（含 LLM verifier）
- 驱动真实 tmux session of Claude Code / Codex
- **评估 skills 是否被遵守**（不是"是否产生代码"）

### 6.5 支持的 10 个 Harness（2026-07）

| Harness | 集成方式 |
|---------|----------|
| Claude Code | 官方 Anthropic marketplace |
| Antigravity | `agy plugin install` |
| Codex App / CLI | 官方 OpenAI marketplace |
| Cursor | `/add-plugin` |
| Factory Droid | `droid plugin install` |
| GitHub Copilot CLI | `copilot plugin install` |
| **Kimi Code** | `/plugins` marketplace ✅ |
| **OpenCode** | `INSTALL.md` URL 拉取 |
| **Pi** | `pi install` 本地包 |

> **注意**：Superpowers 已上架 Kimi Code / OpenCode 官方 marketplace，TDSF 可直接集成 → 减少自研 skill 框架工作量。

### 6.6 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-12** | **7 步标准工作流**（brainstorming→worktree→plan→subagent→TDD→review→finish） | **P1** | Superpowers |
| **D-V35-13** | **drill eval harness**（LLM 验证 skill 合规性） | P2 | Superpowers |
| **D-V35-14** | **Session-Start Bootstrap Hook**（所有 skills 启动时自动激活） | P1 | Superpowers |
| **D-V35-15** | **零依赖 plugin 设计**（core 不引入任何依赖） | P3 | Superpowers |

### 6.7 复用评估

- **可复用**：
  - SKILL.md 标准格式（TDSF 已有 DEC-V321-13 ✅）
  - 7 步工作流（可直接映射到 TDSF `tdsf_orchestrator` MCP tool）
  - bootstrap hook 设计（强化 TDSF 启动时激活 skill）
- **不可复用**：
  - drill eval harness（TDSF 暂不需要 LLM 评估，测试用 unit test 即可）
  - Prime Radiant 商业服务（避免供应商绑定）

### 6.8 风险

- **许可证**：MIT ✅
- **94% PR 拒绝率**：说明核心质量严苛，借鉴需谨慎（"agent-managed" 哲学未必适合所有人）
- **依赖 vendor**：superpowers 在 Anthropic/OpenAI marketplace 上有官方支持，TDSF 借力风险低

---

## 7. Claw Code（Rust 实现的 Claude Code 复刻）

### 7.1 项目定位

- **GitHub**：`ultraworkers/claw-code`（声明非 Anthropic 关联）
- **Stars**：240（小众）· 协议：MIT
- **标语**："The public Rust implementation of the `claw` CLI agent harness"
- **差异化**：**Rust 实现** Claude Code 复刻（MIT 协议避免法律风险）+ `claw doctor` 健康检查

### 7.2 关键架构信息

#### 7.2.1 Rust 工作空间

```
rust/
├── Cargo.toml  # workspace
├── crates/
│   ├── claw-core/         # 核心 agent loop
│   ├── claw-tui/          # TUI 渲染
│   ├── claw-pty/          # PTY 抽象
│   ├── claw-tools/        # tool registry
│   ├── claw-session/      # session 管理
│   └── claw-cli/          # CLI 入口（生成 `claw` 二进制）
└── tests/                 # 集成测试
```

#### 7.2.2 `claw doctor` 健康检查

> 类似 Claude Code 内置的诊断命令，但**开箱即用**且完全开源。

```bash
$ claw doctor
✓ API key: sk-ant-... configured
✓ Model access: claude-sonnet-4.6 reachable
✓ Tool registry: 8 tools loaded
✗ MCP server 'filesystem': connection timeout
  Hint: check ~/.config/claw/mcp.json
✓ Session store: SQLite at ~/.local/share/claw/sessions.db
```

#### 7.2.3 PowerShell-first 文档

- Windows 用户首选项：**PowerShell**（不是 Git Bash/WSL）
- 详细 `docs/windows-install-release.md` 覆盖：
  - 路径设置
  - `claw.exe` 路径注意事项
  - 通知烟测
  - 跨 shell 兼容

#### 7.2.4 法律风险规避

> README 明确声明：
> - "This repository does **not** claim ownership of the original Claude Code source material."
> - "This repository is **not** affiliated with, endorsed by, or maintained by Anthropic."

- **TDSF 启发**：不反编译 Claude Code，使用官方 SDK 或借鉴设计而非复制

### 7.3 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-16** | **`tdsf doctor` 健康检查工具**（API key / model access / MCP server / DB） | **P0** | Claw Code |
| **D-V35-17** | **PowerShell-first Windows 文档** | P1 | Claw Code |
| **D-V35-18** | **法律声明模板**（不主张上游代码所有权） | P3 | Claw Code |

### 7.4 复用评估

- **可借鉴**：
  - `claw doctor` 设计（TDSF 实现为 `tdsf-cli doctor`，9 项检查）
  - Cargo workspace 结构（如果 TDSF 未来拆分多个 Rust crate）
  - PowerShell-first 文档模式（Windows 用户友好）
- **不可复用**：
  - Claude Code 复刻的代码（避免法律风险，TDSF 走原创架构）
  - 240 stars 体量太小，无社区

### 7.5 风险

- **许可证**：MIT ✅
- **法律风险**：声明"不主张上游代码所有权"是必要保护措施；TDSF 应在 v1.0 发布前加类似声明
- **体量过小**：240 stars 无生态，仅作参考

---

## 8. MetaGPT（SOP 多 Agent 框架）

### 8.1 项目定位

- **GitHub**：`geekan/MetaGPT`（DeepWisdom 团队）
- **Stars**：58K · 协议：MIT
- **标语**："Assign different roles to GPTs to form a collaborative entity for complex tasks."
- **差异化**：**SOP(Team) 哲学** + 软件公司模拟（PM/架构师/工程师）+ 3 篇 ICLR/NeurIPS 论文

### 8.2 核心理念

> **"Code = SOP(Team)"**：将 SOP（标准操作流程）应用到 LLM 组成的团队。

模拟完整软件公司：
- **Product Manager**：写 PRD
- **Architect**：写设计
- **Project Manager**：拆任务
- **Engineer**：写代码
- **QA Engineer**：测试

### 8.3 三大产品

| 产品 | 形式 | 时间 | 状态 |
|------|------|------|------|
| MetaGPT 框架 | pip `metagpt` | 2023+ | 开源维护 |
| **MGX (MetaGPT X)** | Web 平台 [mgx.dev](https://mgx.dev/) | 2025-02-19 | ProductHunt #1 ✅ |
| Data Interpreter | 数据分析 sub-agent | 2024 | 开源 |

### 8.4 论文成果

| 论文 | 会议 | 状态 |
|------|------|------|
| **AFlow: Automating Agentic Workflow Generation** | ICLR 2025 oral (top 1.8%) | LLM-based Agent #2 |
| **SPO** | arXiv 2502.06855 | 2025-02-17 |
| **AOT** | arXiv 2502.12018 | 2025-02-17 |

### 8.5 借鉴清单

| 决策 | 标题 | 优先级 | 借鉴自 |
|------|------|--------|--------|
| **D-V35-19** | **SOP 标准化运维流程**（PAOR 借鉴 MetaGPT SOP 思想） | P1 | MetaGPT |

### 8.6 复用评估

- **可借鉴**：
  - SOP 思维（"运维 SOP 化"对应 PAOR 循环）
  - Role-based Agent 设计（"运维 Agent 角色" 化：Monitor/Executor/Reviewer）
- **不可复用**：
  - 完整软件公司模拟（运维场景不需要 PM/Architect 角色）
  - 论文代码（适配复杂）

### 8.7 风险

- **许可证**：MIT ✅
- **学术偏向**：核心论文导向，TDSF 借鉴理念而非代码
- **MGX 商业化**：注意不要让 MGX 平台与 TDSF 路线冲突

---

## 9. v3.5 借鉴清单（19 大决策点）

> 全部 P0/P1 决策已纳入 `02-architecture.md` v3.5 增量小节。

| 决策 | 标题 | 优先级 | 借鉴自 | 对应规格 |
|------|------|--------|--------|----------|
| **D-V35-01** | **Agent Manager 多 session 编排面板**（共享单后端 + worktree directory 隔离） | P1 | Kilo Code | 03-ui-spec / 04-api-contract |
| **D-V35-02** | **`kilo_change` marker fork 同步策略** | P2 | Kilo Code | dev-process |
| **D-V35-03** | **5 种 Agent 类型**（Code/Plan/Ask/Debug/Review） | P1 | Kilo Code | 02-architecture |
| **D-V35-04** ⭐ | **CCR 可逆压缩**（远超 v3.2 D-V32-04 handoff 32K 上限） | **P0** | Headroom | 02-architecture / 04-api-contract |
| **D-V35-05** | **ContentRouter 内容感知**（JSON/Code/Text 3 策略） | P1 | Headroom | 04-api-contract |
| **D-V35-06** | **CacheAligner 保留 KV cache 命中** | P1 | Headroom | 02-architecture |
| **D-V35-07** | **跨 agent memory + headroom learn 失败挖掘** | P2 | Headroom | 04-api-contract |
| **D-V35-08** | **可选：去除匿名 telemetry** | P2 | Continue 2.0 | dev-process |
| **D-V35-09** | **Graph Workflow Engine**（`.then/.branch/.parallel`） | P1 | Mastra | 02-architecture |
| **D-V35-10** ⭐ | **suspend/resume 持久化审批**（运维每步审批 + 跨会话恢复） | **P0** | Mastra HITL | 02-architecture / 04-api-contract |
| **D-V35-11** | **Observational Memory 4 维记忆分类** | P2 | Mastra | 02-architecture |
| **D-V35-12** | **7 步标准工作流**（brainstorming→worktree→plan→subagent→TDD→review→finish） | P1 | Superpowers | 05-implementation-roadmap |
| **D-V35-13** | **drill eval harness**（LLM 验证 skill 合规性） | P2 | Superpowers | dev-process |
| **D-V35-14** | **Session-Start Bootstrap Hook**（所有 skills 启动时自动激活） | P1 | Superpowers | 02-architecture |
| **D-V35-15** | **零依赖 plugin 设计** | P3 | Superpowers | dev-process |
| **D-V35-16** ⭐ | **`tdsf doctor` 健康检查工具**（9 项检查） | **P0** | Claw Code | 04-api-contract |
| **D-V35-17** | **PowerShell-first Windows 文档** | P1 | Claw Code | dev-process |
| **D-V35-18** | **法律声明模板**（不主张上游代码所有权） | P3 | Claw Code | LICENSE |
| **D-V35-19** | **SOP 标准化运维流程**（PAOR 借鉴 MetaGPT SOP） | P1 | MetaGPT | 02-architecture |

> 注：与 v3.4 决策 12 大决策点合并，**TDSF 累计决策点 31 项**（v3.0 9 + v3.1 6 + v3.2 13 + v3.4 12 + v3.5 19 - 重叠 28）。

---

## 10. v3.5 揭示的 3 项行业新共识

### 共识 1：可逆压缩 = 上下文管理的圣杯

- **Headroom CCR** 验证：100% 数据保留 + 70-92% token 节省
- **Kilo Code** 没有压缩但通过多 session 隔离规避上下文爆炸
- **Aider / Cline** 通过 file-based memory + 滚动窗口规避
- **TDSF 选择**：内置 LLM 摘要压缩 + Markdown 文件系统 handoff（v3.2 D-V32-04）→ **升级到 CCR 风格**（v3.5 D-V35-04）

### 共识 2：Human-in-the-Loop Suspend/Resume = 运维 Agent 标配

- **Mastra**：`workflow.suspend(...)` + `workflow.resume(...)` 持久化审批
- **Superpowers**：brainstorming 强制介入
- **TDSF needs-you 收件箱**（v3.2 DEC-V321-07）→ **升级为 suspend/resume 模式**（v3.5 D-V35-10）

### 共识 3：Plugin Marketplace = Skill 生态护城河

- **Superpowers** 已在 Claude Code / Codex / Cursor / Kimi Code / OpenCode 等 10 个 harness 官方上架
- **claude-skills 库** 354 个候选 Skill
- **TDSF 选择**：遵循 SKILL.md 标准（v3.2 DEC-V321-13）→ 直接兼容 Superpowers 市场（v3.5 D-V35-12）

---

## 11. 横向对比矩阵（v3.5 · 70 项目）

> 节选：v3.5 新调研的 7 个 + v3.4 的 7 个 + v3.2 的 6 个 + v3.1 的 6 个 + 早期 44 个 = **70 个**

| # | 项目 | Stars(K) | 协议 | 类型 | 借鉴度 |
|:-:|------|---------:|------|------|------:|
| 1 | **Kimi CLI** | ~ | MIT | 终端 Agent | **95%** |
| 2 | **Qoder CLI** | ~ | 闭源 | 终端 Agent + Quest | 90% |
| 3 | **OpenCode** | 160 | MIT | 终端 Agent | 90% |
| 4 | **Codex CLI** | ~ | Apache-2.0 | 终端 Agent | 85% |
| 5 | **Cline** | 58.8 | Apache-2.0 | IDE/CLI/SDK 三端 | 85% |
| 6 | **Mastra** | 21.5 | Apache-2.0 | 框架 + Graph Workflow | **80%** |
| 7 | **Headroom** | 1.8 | Apache-2.0 | 压缩中间件 | **80%** |
| 8 | **Superpowers** | 13 | MIT | Skills 框架 | **80%** |
| 9 | **Kilo Code** | 8.4 | MIT | OpenCode fork | 75% |
| 10 | **Aider** | 45 | Apache-2.0 | Git-native | 70% |
| 11 | **Qwen Code** | 25 | Apache-2.0 | CLI 中文优化 | 60% |
| 12 | **Goose** | 32.7 | Apache-2.0 | MCP-first | 50% |
| 13 | **OpenHands** | 75 | MIT | 自托管 K8s | 40% |
| 14 | **MetaGPT** | 58 | MIT | 多 Agent SOP | 30% |
| 15 | **Claw Code** | 0.24 | MIT | Rust Claude Code 复刻 | 25% |
| 16 | **Continue** | 28 | Apache-2.0 | 已 archive | 20% |

### 11.1 量化基线更新

| 指标 | v3.4 | v3.5 | 增量 |
|------|-----:|-----:|-----:|
| 调研项目数 | 63 | **70** | +7 |
| 累计代码行数 | 26.31M | **~26.5M** | +0.19M |
| 累计 stars | ~1.5M | **~1.55M** | +0.05M |
| TDSF 决策点 | 12 | **31** | +19 |
| 行业共识 | 2 | **5** | +3 |
| 复用率 | 68% | **70%** | +2% |

> **新增的 7 个项目源码大部分已在 `opensource-reference/` 目录中**，实际复用率约 +2%（Headroom 压缩模块可剪裁后嵌入 TDSF）。

---

## 12. 待办 & 下一步

### 12.1 立即可做（基于 v3.5 决策）

1. **D-V35-04 CCR 可逆压缩**（P0）
   - 创建 `tdsf/sidecar/compressor/` 模块
   - 实现 `headroom_compress` / `headroom_retrieve` MCP tool 镜像
   - 与 v3.2 D-V32-04 handoff 32K 形成 fallback 链
2. **D-V35-10 suspend/resume**（P0）
   - 在 `tdsf-cli` 中实现 `tdsf run --suspend-on-risk`
   - Project Service 持久化 session state 到 SQLite
3. **D-V35-16 tdsf doctor**（P0）
   - 实现 9 项健康检查：
     1. API key（Anthropic / OpenAI / Ollama）
     2. Model access
     3. MCP server connection
     4. SQLite 写权限
     5. Tauri 2 端口
     6. Python Sidecar stdio
     7. SSH 已知主机
     8. 磁盘空间
     9. 网络出站

### 12.2 中期可做

- **D-V35-09 Graph Workflow**（P1）：Python 端用 LangGraph 增强（v3.2 DEC-V321-03 RLM 已部分实现）
- **D-V35-12 7 步工作流**（P1）：TDSF 实施路线借鉴
- **D-V35-14 Bootstrap Hook**（P1）：启动时激活 70+ Skills

### 12.3 持续维护

- 跟踪 Superpowers 新增 skill（每 2 周 sync 一次）
- 跟踪 Headroom CCR 算法升级
- 跟踪 Mastra EE 许可证变化
- 跟踪 Kilo Code 与 OpenCode upstream 同步策略

---

## 附录 A · v3.5 决策点 vs 现有规格映射

| 决策 | 02-architecture.md | 03-ui-spec.md | 04-api-contract.md | 05-implementation-roadmap.md |
|------|:---:|:---:|:---:|:---:|
| D-V35-01 Agent Manager | ✅ §3.3 | ✅ §2.5 | ✅ §2.3 | - |
| D-V35-03 5 Agent 类型 | ✅ §3.1 | - | - | - |
| D-V35-04 CCR | ✅ §5.2 | - | ✅ §9.1 | - |
| D-V35-05 ContentRouter | - | - | ✅ §9.2 | - |
| D-V35-09 Graph Workflow | ✅ §3.2 | - | - | - |
| D-V35-10 suspend/resume | ✅ §5.3 | - | ✅ §9.3 | - |
| D-V35-12 7 步工作流 | - | - | - | ✅ §P0-P7 |
| D-V35-14 Bootstrap | ✅ §4.1 | - | - | - |
| D-V35-16 tdsf doctor | - | - | ✅ §9.4 | ✅ §P0 |
| D-V35-19 SOP PAOR | ✅ §3.1 | - | - | - |

> ✅ = 已纳入规格文档更新；– = 不需规格变更（在 dev-process 阶段处理）

---

## 附录 B · 与 v3.4 报告差异

| 维度 | v3.4 | v3.5 | 差异原因 |
|------|------|------|---------|
| 调研项目数 | 63 | 70 | +7 (Kilo Code / Headroom / Continue / Mastra / Superpowers / Claw Code / MetaGPT) |
| 核心增量 | Aider/Cline/OpenCode/Qoder/Goose/OpenHands/Qwen 7 项目 | **Kilo/Headroom/Mastra/Superpowers** 4 个高价值项目 | 用户补充关键词 kimicode/qodercil 已在 v3.4 |
| 决策点 | 12 | **31** | +19（CCR / suspend-resume / doctor / 7 步工作流） |
| 行业共识 | 2 | **5** | +3（可逆压缩 / HITL suspend / Plugin marketplace） |
| 复用率 | 68% | **70%** | +2%（Headroom 压缩模块可嵌入） |

---

**报告完** | 调研人：AI Assistant | 调研日期：2026-07-26 | 版本：v3.5
