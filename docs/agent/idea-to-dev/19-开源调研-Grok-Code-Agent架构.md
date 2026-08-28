# 开源调研：xAI Grok Code / Grok Build Agent 架构

> **调研日期**：2026-07-17
> **调研对象**：xAI（Elon Musk 旗下）Grok Build CLI 及其底层模型族（grok-code-fast-1 / grok-build-0.1 / Grok 4.5）
> **调研目的**：为 `tdsf-linux-desktop`（Electron 30 + React 18 + TS + Mastra + Vercel AI SDK 7）v0.9 Agent 模块架构设计提供参考，评估 Grok Build 的 Agent 循环、并行 subagent、沙箱机制、开源状态与国内可用性。
> **调研方法**：官方文档抓取（x.ai/news、docs.x.ai/build、github.com/xai-org/grok-build）+ 多源第三方技术评测（ChatForest、Remio、Codersera、TempMail Ninja、zenvanriel 等）+ 国内接入实践（掘金、CSDN、36Kr）交叉验证。
> **核心结论**：Grok Build 是 **2026 年 7 月 15 日开源（Apache-2.0）的 Rust 实现 Agent Harness**，其 **「最多 8 个并行 subagent + 每个 subagent 独立 Git worktree 隔离」** 是当前编码 Agent 品类中最具差异化与可借鉴价值的设计；Plan-Search-Build 三阶段工作流、分级权限/沙箱、Skills/Plugins/Hooks/MCP 扩展体系对 tdsf-linux-desktop v0.9 具有直接参考意义。国内官方访问受限，需通过 OpenRouter / 第三方中转 / 自建本地推理（开源后可行）接入。

---

## 1. 概述

### 1.1 命名澄清（重要）

「Grok Code」在不同语境下指代不同对象，调研中需先厘清：

| 名称 | 实际所指 | 发布时间 |
|---|---|---|
| **Grok Code Fast 1** | 编码专用 **模型**（API ID: `grok-code-fast-1`），x.ai 首个为 agentic coding 从头训练的快速推理模型 | 2025-08-28 |
| **Grok Build 0.1** | 编码专用 **模型**（API ID: `grok-build-0.1`），Grok Code Fast 1 的后继者，支持图像输入 | 2026-05-20 |
| **Grok Build CLI**（即「Grok Code」） | 终端 **Agent Harness / CLI / TUI**，调用上述模型 | 2026-05-14（early beta） |
| **Grok 4.5** | 通用旗舰模型（500K 上下文，与 Cursor 联合训练） | 2026-07-08 |
| **Grok 4 Heavy / 4.20** | 多智能体通用模型（3-32 个智能体辩论） | 2025-07 / 2026-02 |

> **本报告聚焦「Grok Build CLI」这一 Agent Harness 及其底层编码模型族**，对应调研任务中的「Grok Code agent 架构」。

### 1.2 核心定位与时间线

| 属性 | 详情 |
|---|---|
| **开发主体** | xAI（2026 年与 SpaceX 合并后称 SpaceXAI） |
| **产品定位** | 终端原生（terminal-first）Agentic 编码 Agent，对标 Claude Code、OpenAI Codex CLI、Cursor Composer |
| **首发时间** | 2026-05-14（early beta） |
| **模型 API** | 2026-05-20 开放 `grok-build-0.1` |
| **访问门槛** | 早期 SuperGrok Heavy 独占；2026-05-24 扩展至 SuperGrok（$30/月）+ X Premium+（$40/月） |
| **开源时间** | 2026-07-15（Apache-2.0） |
| **开源诱因** | 2026-07-12 安全研究员 cereblab 披露 v0.2.93 后台静默上传整个 Git 仓库（含 .env 明文凭据）至 GCS bucket `grok-code-session-traces`，数据量达正常 API 调用的 27,800 倍 |
| **实现语言** | Rust 99.6% |
| **当前版本** | v0.2.73+（2026-06-28，仍 Beta） |
| **二进制名** | 内部 `xai-grok-pager`，官方发布为 `grok` |
| **GitHub 仓库** | `xai-org/grok-build` |

### 1.3 与 Claude Code / Cursor / Codex CLI 的对比

| 维度 | Grok Build | Claude Code | OpenAI Codex CLI | Cursor Composer |
|---|---|---|---|---|
| **形态** | 终端 TUI + Headless + ACP | 终端 REPL + Headless | 终端 CLI | IDE 内嵌 |
| **架构** | 多智能体并行（≤8 subagent） | 单 Agent 串行 | 单 Agent | 单 Agent + 并行 Tab |
| **并行隔离** | 每个 subagent 独立 Git worktree | 无 | 共享/松隔离 | 并行 Tab |
| **上下文窗口** | 256K（Build 0.1）/ 500K（Grok 4.5）/ 2M（Grok 4 chat） | 200K / 1M（Opus 4.6+） | 200K | 模型相关 |
| **开源状态** | Apache-2.0（不接受外部 PR） | 源码可见但限制 redistribute | MIT 风格开放 | 闭源 |
| **模型锁定** | 默认 Grok，支持 OpenRouter 自定义路由 | 仅 Anthropic | 仅 OpenAI | 多模型（含 Grok Code） |
| **CLAUDE.md 兼容** | 原生支持（自动读取） | 原生 | 否 | 否 |
| **MCP 支持** | 原生 | 原生 | 原生 | 原生 |
| **SWE-Bench Verified** | 70.8%（grok-code-fast-1） | 80.9%（Opus 4.6） | ~75% | 模型相关 |
| **定价（API）** | $1/$2 per M tokens | $3/$15 per M tokens | ~$2/$8 per M tokens | 订阅制 |

---

## 2. Agent 架构详解

### 2.1 总体架构图（文字描述）

```
┌─────────────────────────────────────────────────────────────────┐
│                      Grok Build CLI / TUI                        │
│  (Rust 实现, crates/xai-grok-pager + xai-grok-shell)             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Interactive  │  │  Headless   │  │    ACP      │  ← 三种运行模式
│  │  TUI Mode    │  │  (-p flag)  │  │  (stdio)    │              │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘              │
│         └────────────────┬┴────────────────┘                      │
│                          ▼                                       │
│         ┌────────────────────────────────────────┐              │
│         │      Agent Runtime (Leader)            │              │
│         │  Plan → Search → Build 三阶段循环       │              │
│         └────────────────┬───────────────────────┘              │
│                          │                                       │
│         ┌────────────────┼────────────────┐                      │
│         ▼                ▼                ▼                       │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐  ... (≤8)        │
│   │Subagent 1│    │Subagent 2│    │Subagent N│                   │
│   │worktree A│    │worktree B│    │worktree N│  ← Git Worktree 隔离
│   └─────┬────┘    └─────┬────┘    └─────┬────┘                   │
│         └────────────────┼────────────────┘                      │
│                          ▼                                       │
│   ┌──────────────────────────────────────────────┐              │
│   │           Tool Layer (xai-grok-tools)       │              │
│   │  read / write / search / terminal / git /    │              │
│   │  web_search / web_fetch                      │              │
│   └──────────────────┬───────────────────────────┘              │
│                      ▼                                           │
│   ┌──────────────────────────────────────────────┐              │
│   │   Extension Layer                            │              │
│   │  Skills · Plugins · Hooks · MCP · LSP        │              │
│   └──────────────────┬───────────────────────────┘              │
│                      ▼                                           │
│   ┌──────────────────────────────────────────────┐              │
│   │   Model Routing (config.toml)               │              │
│   │  grok-build-0.1 / Grok 4.5 / OpenRouter     │              │
│   └──────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Agent 循环：Plan-Search-Build 三阶段（不是经典 ReAct）

Grok Build **没有采用** 经典的 Plan-Act-Observe-Reflect 循环，而是采用 **Plan → Search → Build** 的显式三阶段工作流，每个 subagent 都遵循此流程：

| 阶段 | 行为 | 用户介入点 |
|---|---|---|
| **Plan** | 生成 step-by-step 执行计划（plaintext），列出将修改的文件、将执行的命令、中间检查 | 可整体批准 / 逐条评论 / 完全重写 |
| **Search** | 读取相关文件、导航仓库、构建工作记忆 | 只读，不可改文件 |
| **Build** | 执行已批准的计划，运行命令、写代码 | 每个变更以 diff 形式展示 |

**关键设计**：Plan Mode 是复杂任务的 **默认入口**（非 opt-in），通过 `Shift+Tab` 切换四种权限模式：
- `Manual`：每步都需人工确认
- `Plan`：先出计划再执行（默认）
- `Accept edits`：自动接受文件编辑
- `Bypass`（即 `/yolo`）：全自动

### 2.3 Subagent / Coordinator 模式

**这是 Grok Build 最具差异化的设计。**

| 维度 | 规格 |
|---|---|
| **是否支持 subagent** | ✅ 原生支持，且为核心特性 |
| **并行 subagent 数量** | **最多 8 个**（4 个模型 × 2 路，或按 worktree 分配） |
| **隔离机制** | 每个 subagent 在 **独立 Git worktree** 中运行（非共享目录） |
| **协调器** | Leader / Captain（主 Agent）负责任务分解、调度、合并 |
| **Arena Mode** | 实验特性：多个 agent 对同一问题独立求解，自动评分排名（测试通过率/diff 大小/计划符合度），取最优方案 |
| **subagent 类型** | explore / plan / review / general |
| **共享状态** | shared scratchpad（共享草稿区）+ 状态坞（status dock） |
| **取消机制** | 支持运行中取消 subagent |

**Worktree 隔离的价值**（区别于 Codex Cloud / Cursor 并行 Tab 的共享环境）：
- 每个 subagent 拥有完整的、独立的工作树副本
- 不会出现「两个 agent 写同一文件中途冲突」的隐式累积
- 冲突在 **merge 时显式暴露**，diff 反映每个 agent 的真实工作
- 实践中可同时跑：1 个迁移数据库 schema、1 个写测试、1 个重构 API 客户端，零冲突风险
- 每个 worktree 完成后可独立 review / merge / discard

### 2.4 工具调用协议

| 协议 | 支持状态 | 说明 |
|---|---|---|
| **Function Calling** | ✅ 原生 | 模型层原生支持，OpenAI 兼容格式 |
| **Structured Outputs** | ✅ 原生 | JSON Schema 验证，`--json-schema` flag 在 headless 模式生效 |
| **MCP（Model Context Protocol）** | ✅ 原生 | 自动加载 `~/.grok/grokcode/mcp.json` 与项目级 `.mcp.json`，会话中可热替换 MCP server 无需重启 |
| **ACP（Agent Client Protocol）** | ✅ 原生 | `grok agent stdio` 暴露 JSON-RPC 服务，可被 IDE / 其他 Agent 框架驱动 |
| **Skills** | ✅ 原生 | 兼容 Claude Code 的 `.skill` / `.zip` / `.md` 格式，自动读取 `AGENTS.md` |
| **Plugins** | ✅ 原生 | Skills marketplace，社区可发布 |
| **Hooks** | ✅ 原生 | 在 Agent 工作流特定节点执行预定义动作 |
| **LSP** | ✅ 原生 | 可挂载 LSP server 增强代码理解 |
| **Web 工具** | ✅ 内置 | `web_search` + `web_fetch` |

### 2.5 上下文管理策略

| 策略 | 实现 |
|---|---|
| **上下文窗口** | grok-build-0.1：256K tokens；Grok 4.5：500K；Grok 4 chat：2M |
| **Prompt Caching** | 支持，缓存命中价格仅正常的 1/10（grok-build-0.1：$0.20/M cache vs $1/M input） |
| **缓存命中率** | xAI 投入快速缓存优化，**通常 > 90%** |
| **Auto-Compact** | `grokcode.autoCompact` 默认开启，长历史自动压缩 |
| **Checkpoints** | 支持 fork 会话 / rewind 文件编辑 / fork+rewind 三种回滚方式 |
| **会话持久化** | 本地存储于 `~/.grok/grokcode/`，窗口重载后可恢复 |
| **AGENTS.md** | 自动读取仓库根目录的项目约定、架构说明、构建命令 |
| **CLAUDE.md 兼容** | 直接读取现有 Claude Code 项目的指令、skills、plugins、hooks、marketplace、MCP 配置 |
| **图像输入** | 支持（grok-build-0.1），可截图 UI / 架构图作为输入 |

### 2.6 多智能体模型层的另一条线（Grok 4 Heavy / 4.20）

值得区分的是，**模型层** 也有多智能体能力（与 Agent Harness 的 subagent 不同）：

- **Grok 4 Heavy**：根据问题难度自动生成 3-32 个专业智能体并行辩论，性能提升 127%，但成本约 10 倍
- **Grok 4.20 Beta**：固定 4-agent 系统（Grok 协调器 + Harper 研究 + Benjamin 逻辑/数学 + Lucas 反方核查），xAI 自称幻觉率从 12% 降至 4.2%
- **Grok 4.20 Heavy**：16-agent 变体

> 这一层是 **模型推理内部的多智能体**，对调用方透明；而 Grok Build CLI 的 subagent 是 **Harness 层的多智能体**，是本报告重点。

---

## 3. 沙箱与安全机制

### 3.1 三层隔离体系

Grok Build 的沙箱设计是品类中最完整的，分为三层：

#### 第一层：Git Worktree 隔离（subagent 间）

```bash
# 启动一个隔离 worktree 会话
grok -w

# 命名 worktree 并分配任务
grok --worktree=auth-refactor "Refactor the authentication middleware"

# 指定 base reference
grok -w --ref main "Fix the failing tests"
```

每个 subagent 在独立工作树中操作完整仓库副本，merge 时才显式合并。

#### 第二层：OS 级沙箱配置文件（`config.toml` 的 `[sandbox]` 表）

| Profile | 文件系统 | 进程 | 网络 | 适用场景 |
|---|---|---|---|---|
| `off`（默认！） | 无限制 | 无限制 | 无限制 | 信任环境 |
| `workspace` | 仅 `--bind` 挂载的项目目录 | 隔离 | 受控 | 推荐生产 |
| `read-only` | 只读 | 隔离 | 禁止 | 探索/审计 |
| `strict` | 最严，`--unshare-all` | 完全隔离 IPC/用户表/命名空间 | 禁止 | 敏感代码 |

**关键参数**：
- `--bind`：仅将活动项目目录挂载到 sandbox 内 `/workspace`，**防止 agent 向上遍历访问 SSH keys / 文档 / 父目录**
- `--unshare-all`：完全隔离进程、IPC 命名空间、用户表
- **敏感目录默认写保护**：SSH keys、云凭据、Grok 授权数据，**无论选哪个 profile 都受保护**

> ⚠️ **重要警示**：默认 `off`，用户必须主动启用 `workspace` / `read-only` / `strict`。

#### 第三层：权限模式（Permission Mode）

| 模式 | 行为 |
|---|---|
| `Manual` | 每个工具调用都需确认 |
| `Plan` | 先出计划，批准后执行（默认） |
| `Accept edits` | 自动接受文件编辑，命令仍需确认 |
| `Bypass`（`/yolo`） | 全自动，不推荐生产 |

外加 **allowlists**：可对工具、shell 命令、MCP server 分别配置白名单。全局权限存于 `~/.grok/grokcode/permissions.json`，UI 内可编辑。

### 3.2 2026-07-12 数据丑闻（开源的直接诱因）

调研中发现的重要安全事件，**对 tdsf-linux-desktop 设计有直接警示价值**：

| 维度 | 详情 |
|---|---|
| **披露时间** | 2026-07-12，研究员 cereblab |
| **受影响版本** | Grok Build v0.2.93 |
| **发现方法** | macOS 上用 `mitmproxy` 抓包 |
| **双通道架构** | ① Model-Turn 通道 `POST /v1/responses`（正常 API）；② **Background Storage 通道 `POST /v1/storage`（静默上传）** |
| **数据量** | 12 GB 仓库测试：Model-Turn 仅传 192 KB，Background 通道传 **5.10 GiB**（73 个分块，平均 75 MB/块，全部 HTTP 200）—— **27,800 倍超量** |
| **上传目标** | Google Cloud Storage bucket `grok-code-session-traces` |
| **内容** | 整个本地 Git 仓库的 Git bundle（含完整历史）+ `.env` 明文 `API_KEY` / `DB_PASSWORD` |
| **无视指令** | 即便 prompt 明确「reply OK, do not read any files」，仍上传整个 workspace |
| **canary 验证** | 研究员下载拦截到的 Git bundle，本地重建后成功恢复 agent 从未被授权读取的 `src/_probe/never_read_canary.txt` |
| **xAI 应对** | 2026-07-15 紧急开源全部 Rust 代码（Apache-2.0）以重建信任 |

### 3.3 开源后的本地优先能力

开源后，开发者可：
- 编译自己的 `grok` 二进制
- 在 `config.toml` 中指向 **本地推理服务器**（如本地 Ollama / vLLM）
- 完全不依赖 xAI 云端即可驱动整个 Agent 循环
- 审计每条网络请求的来源

---

## 4. 模型与 API 规格

### 4.1 编码专用模型族

| 模型 | API ID | 上下文 | 输入 $/M | 输出 $/M | 缓存 $/M | 状态 |
|---|---|---|---|---|---|---|
| Grok Code Fast 1 | `grok-code-fast-1` | 256K | $0.20 | $1.50 | $0.02 | ⚠️ 2026-08-15 deprecated |
| Grok Build 0.1 | `grok-build-0.1` | 256K | $1.00 | $2.00 | $0.20 | Early beta |
| Grok 4.5 | `grok-4.5` | 500K | $2.00 | $6.00 | - | 2026-07-08 发布 |
| Grok 4 | `grok-4` | 256K | $3.00 | $15.00 | $0.75 | GA |
| Grok 4 Fast | `grok-4-fast` | 256K | $0.20 | $0.50 | - | GA |
| Grok 4 Heavy | - | 256K | 订阅制 | - | - | SuperGrok Heavy |

### 4.2 grok-code-fast-1 详细规格（被 Grok Build CLI 早期采用）

| 参数 | 规格 |
|---|---|
| 上下文窗口 | 256,000 tokens |
| 最大输出 | 256K tokens（无固定截断） |
| 输入模态 | 文本 |
| 吞吐 | ~90-100 tokens/秒（实测可达 ~190 t/s） |
| 工具调用 | ✅ 原生 |
| Structured Outputs | ✅ JSON Schema |
| Reasoning Tokens | ✅ 可见推理痕迹（Summarized Thinking Traces） |
| Prompt Caching | ✅（命中率 > 90%） |
| 知识截止 | 2023-10 |
| 速率限制 | 480 req/min，2,000,000 tokens/min |
| 部署区域 | us-east-1 |
| 擅长语言 | TypeScript / Python / Java / Rust / C++ / Go |
| 基准（SWE-Bench Verified） | 70.8%（x.ai 内部工具） |
| 基准（Terminal-Bench Hard） | 17.4% |
| 基准（τ²-Bench 工具使用） | 75.7% |
| 基准（GPQA Diamond） | 72.7% |
| 基准（LiveCodeBench） | 65.7% |

### 4.3 grok-build-0.1 详细规格（当前主推）

| 参数 | 规格 |
|---|---|
| 上下文窗口 | 256,000 tokens |
| 输入模态 | **文本 + 图像**（新增） |
| 输出 | 文本，无固定输出长度限制 |
| Function Calling | ✅ |
| Structured Outputs | ✅ JSON Schema |
| Reasoning Tokens | ✅ |
| Prompt Caching | ✅ |
| 训练目标 | 交互式编码 Agent + 工具调用 + 多步骤开发任务 |
| 三方渠道 | xAI 官方 API、OpenRouter、Vercel AI Gateway（均 OpenAI 兼容） |

### 4.4 Grok 4.5 规格（2026-07-08 发布，与 Cursor 联合训练）

| 参数 | 规格 |
|---|---|
| 架构 | V9 foundation，~1.5T 参数 MoE |
| 上下文窗口 | 500,000 tokens |
| 输入模态 | 文本 + 图像 |
| 定价 | $2 / $6 per M tokens |
| 吞吐 | ~80 tokens/秒 |
| 推理努力 | low / medium / high 可配置 |
| 工具调用 | ✅ 原生（function calling、web search、X search、code execution） |
| 训练数据 | 与 Cursor 联合训练，含大量真实编码会话 |
| 评价 | Artificial Analysis 168 模型中第 4，agentic tool use 第 1 |
| Musk 定位 | 「Opus-class，但更快、更省 token、更便宜」 |

### 4.5 API 调用示例

```bash
# 环境变量
export XAI_API_KEY="xai-xxxxxxxxxxxxxxxx"

# cURL（OpenAI 兼容）
curl https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-build-0.1",
    "input": "Refactor this function to handle null inputs."
  }'
```

```python
# Python（OpenAI SDK 兼容）
from openai import OpenAI
client = OpenAI(api_key=os.getenv("XAI_API_KEY"), base_url="https://api.x.ai/v1")
response = client.responses.create(model="grok-build-0.1", input="...")
```

```python
# Python（xAI 原生 SDK，gRPC）
from xai_sdk import Client
from xai_sdk.chat import user
client = Client(api_key=os.getenv("XAI_API_KEY"))
chat = client.chat.create(model="grok-build-0.1")
chat.append(user("..."))
print(chat.sample().content)
```

---

## 5. 开源与 License 状态

### 5.1 开源仓库

| 维度 | 详情 |
|---|---|
| **仓库** | https://github.com/xai-org/grok-build |
| **开源时间** | 2026-07-15 |
| **License** | **Apache License 2.0**（第一方代码） |
| **第三方代码** | 保留原始 license（见 `THIRD-PARTY-NOTICES`） |
| **语言占比** | Rust 99.6% |
| **Commit 状态** | 单次导入 commit，从内部 monorepo 定期同步 |
| **外部贡献** | ❌ **不接受**（`CONTRIBUTING.md` 明确声明） |
| **是否开放开发流程** | ❌ 仅开放源码，非开放开发（可 fork，xAI 掌控上游） |
| **模型权重** | ❌ 未开源（仅开源 Harness） |

### 5.2 仓库结构（Rust workspace）

```
xai-org/grok-build/
├── crates/
│   ├── codegen/
│   │   ├── xai-grok-pager-bin/      # 组合根，构建 xai-grok-pager 二进制
│   │   ├── xai-grok-pager/          # TUI：scrollback/prompt/modals/rendering
│   │   ├── xai-grok-shell/          # Agent runtime + leader/stdio/headless
│   │   ├── xai-grok-tools/          # 工具实现（terminal/file edit/search/...）
│   │   ├── xai-grok-workspace/      # 文件系统/VCS/执行/checkpoints
│   │   └── ...                      # config/MCP/markdown/sandbox 等
│   ├── common/                      # 共享 leaf crates
│   └── build/
├── prod/mc/cli-chat-proxy-types/
├── third_party/                     # vendored Mermaid diagram stack
├── bin/protoc                       # dotslash launcher
├── Cargo.toml（生成，read-only）
├── rust-toolchain.toml
└── rustfmt.toml
```

### 5.3 从源码构建

```bash
# 依赖：Rust（rustup 自动安装 pin 版本）+ protoc
cargo run -p xai-grok-pager-bin              # 构建 + 启动 TUI
cargo build -p xai-grok-pager-bin --release   # release：target/release/xai-grok-pager
cargo check -p xai-grok-pager-bin             # 快速校验
cargo test -p xai-grok-config                 # per-crate 测试
```

> ⚠️ macOS / Linux 完整支持；**Windows 构建为 best-effort，未测试**。

### 5.4 文档与扩展生态

- 在线文档：https://docs.x.ai/build/overview
- 用户指南随源码分发：`crates/codegen/xai-grok-pager/docs/user-guide/`（含认证/快捷键/slash 命令/配置/主题/MCP/skills/plugins/hooks/headless/sandboxing 等）
- 第三方 NOTICE 揭示：源码中**移植了 openai/codex 和 sst/opencode 的工具实现**（按 Apache §4(b) 发出变更通知）

### 5.5 周边 SDK / 社区项目

| 项目 | 类型 | License | 说明 |
|---|---|---|---|
| `xai-sdk`（Python） | 官方 SDK | - | gRPC 优先，性能更好 |
| `grok-code-mcp-server` | npm 包 | MIT | 把 grok-code-fast-1 包装为 MCP server，供 Claude Desktop 调用 |
| VSCode 扩展 `xrquic.grokcode` | 社区扩展 | MIT | 将 Grok Build 能力带入 VS Code，支持 plan/subagent/skills/MCP |
| `superagent-ai/grok-cli` | 社区 CLI | - | ⚠️ 非官方，与 Grok Build 命令冲突，需用 `which grok` 区分 |

---

## 6. 国内可用性评估

### 6.1 官方访问门槛

| 维度 | 要求 |
|---|---|
| **网络** | 需要海外 IP（直连 api.x.ai / console.x.ai 不稳定） |
| **账号** | X (Twitter) 账号 |
| **订阅（CLI 用）** | SuperGrok（$30/月）或 X Premium+（$40/月）；SuperGrok Heavy（$299-300/月，含完整 beta） |
| **API 调用** | 可不订阅，仅用 API Key，按 token 付费 |
| **支付** | 需海外信用卡 / PayPal（订阅场景） |
| **API Key 获取** | `console.x.ai` → API Keys → Create（一次性展示） |
| **认证方式** | 浏览器 OAuth（推荐）/ Device Code / API Key 粘贴 |

### 6.2 国内中转 / 替代方案

| 方案 | 可用性 | 说明 |
|---|---|---|
| **OpenRouter** | ✅ 推荐 | 以 `grok-build-0.1` / `grok-code-fast-1` 相同 ID 调用，OpenAI 兼容格式，国内可走代理 |
| **Vercel AI Gateway** | ✅ | 同上 |
| **MetaChat（元语）** | ✅ | 国内直连中转 API，`https://llm-api.mmchat.xyz/v1`，无需海外卡，按量付费（元点） |
| **Grsai** | ✅ | 国内 API 源头供应商，`grsai.ai`（.ai 域名国内可访问，.com 需代理） |
| **Flux Art** | ✅ | 聚合平台，接入 Grok Imagine 图像能力，国内直连 |
| **自建本地推理（开源后）** | ✅ 最优 | 编译 grok-build + 指向本地 Ollama / vLLM，完全离线 |

### 6.3 国内开发者接入实践（掘金/CSDN 实证）

```bash
# Windows PowerShell 临时走代理（掘金教程）
$env:http_proxy="http://127.0.0.1:7890"
$env:https_proxy="http://127.0.0.1:7890"
grok
```

> **结论**：官方订阅路径对国内不友好（需海外 IP + 海外支付）；**API + OpenRouter / 中转 / 开源本地推理** 是国内团队的可行路径。

---

## 7. 对 tdsf-linux-desktop v0.9 的借鉴价值

### 7.1 直接可借鉴的 7 个核心设计点

| # | 设计点 | Grok Build 实现 | tdsf-linux-desktop v0.9 应用建议 |
|---|---|---|---|
| **1** | **Plan-Search-Build 三阶段循环** | Plan 默认入口，复杂任务先出计划再执行 | Agent 模块默认 Plan 模式；提供 `/plan`、`/yolo` 切换；计划支持逐条评论/重写。**Mastra workflow 可直接建模三阶段** |
| **2** | **Git Worktree 隔离的并行 subagent** | ≤8 subagent，每个独立 worktree | Linux 运维场景天然适配：1 个 subagent 改 nginx 配置、1 个查日志、1 个跑诊断命令，互不污染。**Electron 主进程通过 `simple-git` 创建 worktree** |
| **3** | **分级沙箱配置（off/workspace/read-only/strict）** | `--bind` 限制目录 + `--unshare-all` 命名空间隔离 | Linux 运维 IDE 必须：默认 `strict`，仅挂载 `/workspace`；SSH keys、`/etc/shadow`、生产凭据强制写保护；可用 Linux namespace / Docker container 实现 |
| **4** | **分级权限模式（Manual/Plan/Accept/Bypass）+ allowlists** | 工具/shell/MCP 三类白名单 | 运维场景命令危险度高（`rm -rf`、`dd`、`mkfs`），**必须默认 Manual + 命令白名单**；危险命令二次确认 |
| **5** | **Skills/Plugins/Hooks/MCP 四层扩展** | 兼容 Claude Code 生态，自动读 AGENTS.md | v0.9 可直接复用：运维 skill 包（如「nginx 故障排查」）、Hook（命令执行前预检）、MCP server（接入 Prometheus / Ansible / k8s） |
| **6** | **ACP（Agent Client Protocol）** | `grok agent stdio` 暴露 JSON-RPC | Electron 主进程可暴露 ACP server，让外部 IDE / 上级 Agent 调用；也可作为 ACP client 接入其他 Agent |
| **7** | **Headless + 结构化输出** | `grok -p` + `--json-schema` | CI/CD 集成：定时巡检、自动修复 PR；输出 JSON 便于 React 前端渲染 |

### 7.2 必须规避的反面教训

| 教训 | 来源 | v0.9 应对 |
|---|---|---|
| **后台静默上传用户数据** | 2026-07-12 Grok Build 数据丑闻 | ① 所有网络请求必须 UI 可见 + 可审计；② 默认本地优先，云端需显式 opt-in；③ 敏感文件（`.env`、SSH key）默认 redact；④ 开源核心 Agent 循环接受社区审计 |
| **沙箱默认 off** | Grok Build 默认 `off` profile | 运维场景**默认 `strict`**，仅管理员可降级 |
| **subagent 协调偶尔回退** | 早期 beta 反馈 | v0.9 限制并行数 ≤4，提供 subagent 状态实时看板 |
| **不开源 vs 开源不开发** | xAI 模式 | tdsf-linux-desktop 可走真开源（接受 PR），建立信任 |

### 7.3 与 Mastra / Vercel AI SDK 7 的契合点

| Grok Build 概念 | Mastra / Vercel AI SDK 对应 |
|---|---|
| Agent Runtime (Leader) | `Mastra.Agent` + `workflow` |
| Plan-Search-Build 三阶段 | `createWorkflow` 的三个 `step` |
| subagent | `Agent` 嵌套 + `parallel` 步骤 |
| Tool Layer | `tool()` 定义 + Zod schema |
| MCP | `@mastra/mcp` + Vercel AI SDK `experimental_useMcp` |
| Skills | Mastra `agent.upsertMemory` + 自定义 prompt |
| Hooks | Mastra `middleware` / Vercel AI SDK `onStepFinish` |
| Model Routing | Vercel AI SDK `providerOptions` + 自定义 router |
| ACP | 可用 Mastra `server` 暴露 HTTP/stdio |

### 7.4 推荐的 v0.9 Agent 模块架构（基于 Grok Build 借鉴）

```
tdsf-linux-desktop v0.9 Agent
├── Electron Main Process
│   ├── AgentRuntime（Mastra Agent + workflow）
│   │   ├── Plan Phase     → LLM 生成 step-by-step 计划
│   │   ├── Search Phase   → 本地工具只读探索（grep/cat/ls/系统状态）
│   │   └── Build Phase    → 执行变更（写文件/改配置/跑命令）
│   ├── SubagentManager（≤4 并行）
│   │   ├── WorktreePool   → 临时目录隔离（运维场景用 chroot/docker）
│   │   └── StatusDock     → 实时状态推送给 React 前端
│   ├── SandboxLayer
│   │   ├── Profile: strict(默认)/workspace/read-only/off
│   │   ├── CmdAllowlist   → 危险命令二次确认
│   │   └── SensitiveGuard  → SSH/.env/凭据强制 redact
│   └── ExtensionLayer
│       ├── MCP（接入 Ansible/Prometheus/k8s/SSH）
│       ├── Skills（运维 skill 包，复用 Claude Code 格式）
│       ├── Hooks（命令预检/后处理）
│       └── AGENTS.md（项目约定）
├── React Frontend（Renderer）
│   ├── ChatView（streaming + reasoning blocks）
│   ├── PlanReview（diff viewer + 逐条评论）
│   ├── SubagentDashboard（实时状态）
│   ├── PermissionChip（Manual/Plan/Accept/Bypass）
│   └── CheckpointTimeline（fork/rewind）
└── ModelRouter
    ├── 本地：Ollama / vLLM（隐私优先）
    ├── 云端：OpenRouter / 通义 / DeepSeek（国内可用）
    └── 可选：xAI grok-build-0.1（需中转）
```

### 7.5 实施优先级建议

| 优先级 | 借鉴项 | 工作量 | 价值 |
|---|---|---|---|
| **P0** | Plan-Search-Build 三阶段（Mastra workflow） | 中 | 高 |
| **P0** | 分级沙箱 + 命令白名单（运维刚需） | 中 | 极高 |
| **P0** | Plan Mode + diff review UI | 中 | 高 |
| **P1** | MCP 集成（Ansible/Prometheus/k8s） | 中 | 高 |
| **P1** | Checkpoints（fork/rewind） | 中 | 中 |
| **P1** | AGENTS.md + Skills 加载 | 低 | 中 |
| **P2** | 并行 subagent + worktree 隔离 | 高 | 中 |
| **P2** | ACP server 暴露 | 中 | 中 |
| **P3** | Arena Mode（多方案竞争） | 高 | 低 |

---

## 8. 参考链接

### 8.1 官方资源

- xAI Grok Build 开源公告：https://x.ai/news/grok-build-open-source
- xAI Grok Build CLI 发布：https://x.ai/news/grok-build-cli
- xAI Grok Code Fast 1 发布：https://x.ai/news/grok-code-fast-1
- xAI Grok 4.5 发布（与 Cursor 联合训练）：https://x.ai/news（2026-07-08）
- Grok Build 官方文档：https://docs.x.ai/build/overview
- Grok Build changelog：https://x.ai/build/changelog
- Grok Build CLI 安装页：https://x.ai/cli
- xAI 控制台（API Key）：https://console.x.ai
- Grok Build GitHub 仓库：https://github.com/xai-org/grok-build
- Grok Build 文档（随源码）：https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-pager/docs/user-guide
- xAI 开源总览：https://x.ai/open-source

### 8.2 第三方深度评测

- ChatForest：Grok Build Review（worktree 隔离深度分析）：https://chatforest.com/reviews/xai-grok-build-terminal-coding-agent-review/
- Remio：xAI Open Sources Grok Build（开源意义分析）：https://www.remio.ai/post/xai-open-sources-grok-build-coding-agent-and-terminal-interface-but-local-control-comes-with-limits
- Codersera：Grok Build, Grok Skills + Connectors 全栈解析：https://codersera.com/blog/xai-grok-build-skills-connectors-guide-2026/
- zenvanriel：Grok Build 进入 AI 编码 Agent 竞赛：https://zenvanriel.com/ai-engineer-blog/grok-build-xai-coding-agent-guide/
- aimadetools：Grok Build 完整指南：https://www.aimadetools.com/blog/grok-build-complete-guide
- aimadetools：Reasonix vs Grok Build vs Claude Code 三方对比：https://www.aimadetools.com/blog/reasonix-vs-grok-build-vs-claude-code/
- The Agent Times：Grok 4.5 发布分析（500K 上下文）：https://theagenttimes.com/articles/xai-launches-grok-4-5-targeting-agentic-coding-workflows-at--d1e8e995
- Verdent：Grok 4.20 4-Agent 系统详解：https://www.verdent.ai/guides/grok-4-20-multi-agent-system
- scriptbyai：Grok Build 开源终端 AI 编码 Agent：https://www.scriptbyai.com/grok-build-coding-cli/
- TempMail Ninja：Grok Build 开源与数据丑闻深度分析（含 sandbox 指南）：https://tempmail.ninja/blog/grok-build-open-source-scandal
- Progressive Robot：Grok Build Remote 与 SpaceX 收购 Cursor：https://www.progressiverobot.com/2026/06/22/grok-build-remote-xai-web-coding-agent-83/

### 8.3 国内接入实践

- 掘金：Grok Build 0.1 安装到并行 Agent 全流程：https://juejin.cn/post/7644451660773703731
- 掘金：Grok Build 安装使用教程（超详细，含代理配置）：https://juejin.cn/post/7644117243852685322
- 腾讯云开发者社区：Grok Code Fast 1 深度解析：https://developer.cloud.tencent.com/article/2562613
- CSDN：Grok 4 + Grok 4 Code 多智能体架构解读：https://blog.csdn.net/zsh_1314520/article/details/161015457
- 36Kr（智东西）：Grok Code Fast 1 编程模型免费限时开放：https://eu.36kr.com/en/p/3443307917350274

### 8.4 模型卡片与基准

- Puter Developer：Grok Code Fast 1 Model Card：https://developer.puter.com/ai/x-ai/grok-code-fast-1/
- Puter Developer：Grok 4.5 Model Card：https://developer.puter.com/ai/x-ai/grok-4.5/
- Oracle OCI Generative AI：xAI Grok Code Fast 1（含退市通知）：https://docs.oracle.com/ja-jp/iaas/Content/generative-ai/xai-grok-code-fast-1.htm
- Artificial Analysis（基准聚合）：https://artificialanalysis.ai/

### 8.5 周边生态

- grok-code-mcp-server（npm）：https://www.jsdelivr.com/package/npm/grok-code-mcp-server
- VSCode Grok Code 扩展（xrquic.grokcode）：https://marketplace.visualstudio.com/items?itemName=xrquic.grokcode
- claude-code-alternatives Grok CLI 条目：https://claude-code-alternatives.com/cli-agents/grok-cli/
- SourceForge 中国区 Agentic CLI 工具对比：https://sourceforge.net/software/agentic-cli-coding-tools/china/

### 8.6 xAI SDK 与 API

- xAI API 文档：https://docs.x.ai
- xAI Python SDK（gRPC 优先）：`pip install xai-sdk`
- OpenAI 兼容端点：`base_url="https://api.x.ai/v1"`
- OpenRouter 接入：以相同 model ID 调用

---

## 附录 A：信息可信度声明

| 信息类别 | 可信度 | 说明 |
|---|---|---|
| 开源仓库、License、目录结构 | ⭐⭐⭐⭐⭐ | 直接来自 GitHub 抓取 |
| 模型 API 规格、定价 | ⭐⭐⭐⭐⭐ | 多源一致（x.ai 官方 + Puter + 腾讯云 + Oracle） |
| Plan-Search-Build 三阶段 | ⭐⭐⭐⭐ | 多篇独立评测一致 |
| ≤8 并行 subagent + worktree 隔离 | ⭐⭐⭐⭐⭐ | ChatForest、Codersera、zenvanriel 多源交叉验证 |
| 沙箱四级 profile | ⭐⭐⭐⭐ | TempMail Ninja + scriptbyai + 俄文 anonhaven 一致 |
| 2026-07-12 数据丑闻细节 | ⭐⭐⭐⭐ | 来自 cereblab 抓包报告，TempMail Ninja 详细复述 |
| Grok 4.20 的 4 个 agent 命名（Grok/Harper/Benjamin/Lucas） | ⭐⭐⭐ | Verdent 标注「社区记录，xAI 未官方确认」 |
| 国内中转渠道可用性 | ⭐⭐⭐ | 基于掘金/CSDN 实践，可能随政策变化 |

## 附录 B：与 v0.8 方案（Claude Code 借鉴）的互补关系

本报告（Grok Build）与 `20-开源调研-Claude-Code源码与集成可行性.md` 互补：

| 维度 | Claude Code | Grok Build | tdsf-linux-desktop v0.9 取舍 |
|---|---|---|---|
| Agent 循环 | 单 Agent 串行 | 多 subagent 并行 + worktree | 运维场景并行价值高，**借鉴 Grok Build** |
| 模型 | 仅 Anthropic | 默认 Grok + OpenRouter 多模型 | **借鉴 Grok Build 的 Model Routing** |
| 开源 | 源码可见但限制 | Apache-2.0 可 fork | **借鉴 Grok Build License 模式** |
| 沙箱 | 无原生 OS 级 | 四级 profile + 命名空间隔离 | **借鉴 Grok Build**（运维刚需） |
| Skills 生态 | 原生 | 兼容 Claude Code | **两者生态可直接复用** |
| 国内可用性 | 受限 | OpenRouter / 中转 / 本地推理 | **Grok Build 路径更灵活** |
| 成熟度 | 生产稳定 | 早期 beta | v0.9 自研，仅借鉴设计，不直接依赖任一 |

**建议**：v0.9 Agent 模块架构设计以 **Grok Build 的并行 + 沙箱 + 多模型路由** 为主骨架，工具/Skills/MCP 生态兼容 Claude Code 格式，模型后端优先选国内可用方案（DeepSeek / 通义 / 本地）。

---

**报告完。** 所有信息均基于 2026-07-17 前的公开调研数据，关键事实已多源交叉验证。标注「未公开」或「社区记录」的内容已在附录 A 中说明可信度等级。
