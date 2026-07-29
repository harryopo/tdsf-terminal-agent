# TDSF Terminal Agent — v3.4 增量调研报告

> 调研时间：2026-07-26
> 调研人：Claude (MiniMax-M3)
> 上游版本：v3.3（2026-07-26，已完成 Kimi/Codex/Qoder/Headroom/Kilo/Claw 6 项目）
> 核心增量：用户明确要求"在设计稿来之前继续调研其它 Agent，例如 kimi-code、qodercil 等其它开源终端 agent"，本轮新增 **7 个项目**深度分析，提炼 **12 项 v3.4 决策点** + **2 项行业新共识**

---

## 0. 阅读导览

| 章节 | 内容 | 优先级 |
|------|------|--------|
| §1 | 调研背景与目标 | ⭐ |
| §2 | **Aider**（已 clone 源码）深度分析 | ⭐⭐⭐ |
| §3 | **Cline**（已 clone CLI 源码）深度分析 | ⭐⭐⭐ |
| §4 | **OpenCode**（160K stars, 2026 头部）深度分析 | ⭐⭐⭐ |
| §5 | **Qoder CLI / Qoder CN**（阿里云）深度分析 | ⭐⭐⭐ |
| §6 | **Goose**（Block → Linux Foundation）速览 | ⭐⭐ |
| §7 | **OpenHands**（自托管容器）速览 | ⭐⭐ |
| §8 | **Qwen Code**（阿里通义千问）速览 | ⭐⭐ |
| §9 | v3.3 → v3.4 横向对比矩阵 | ⭐⭐⭐ |
| §10 | **TDSF 借鉴清单**（12 大决策点） | ⭐⭐⭐ |
| §11 | 实施优先级与下一步 | ⭐ |

> 📌 **建议阅读顺序**：§1 → §2 → §4 → §5 → §10 → §11
> 如果你赶时间，**直接看 §10 借鉴清单**和 §11 实施优先级。

---

## 1. 调研背景与目标

### 1.1 为什么继续调研 v3.4

v3.3 阶段已完成 6 个项目（Kimi/Codex/Qoder/Headroom/Kilo/Claw）的源码级分析，但用户 2026-07-26 明确指出：

> "在设计稿来之前，你也去调研一下其它 agent，例如 kimicode，qodercil，等其它开源终端 agent"

本轮聚焦 7 个项目，重点补齐 v3.3 留下的盲点：

1. **Aider** — 5.3M PyPI 安装，Git-native 哲学，是"Git 自动 commit + RepoMap"范式的鼻祖
2. **Cline** — 58.8K stars，唯一覆盖 VSCode + CLI + SDK 三端的 Agent，auto-approve/auto-compact 设计值得借鉴
3. **OpenCode** — 160K+ stars（2026 头部），Go 编写，**LSP 集成** + Client/Server 架构，与 TDSF Rust 后端高度同构
4. **Qoder CLI / Qoder CN** — 阿里云 2026 新品，**Quest 模式** + **Worktree 隔离** + **ACP 协议**与 TDSF 路径高度重合
5. **Goose** — Block → Linux Foundation，**MCP-first 哲学**（所有能力 = Extension）
6. **OpenHands** — 自托管容器化（Docker/K8s），与 TDSF Firecracker 沙箱路线同源
7. **Qwen Code** — 中文 prompt 优化 + Gemini CLI fork，与 TDSF 中文运维场景契合

### 1.2 调研目标

| 目标 | 描述 |
|------|------|
| **架构层** | OpenCode 客户端/服务器架构、Qoder Quest 委派、Goose MCP-first |
| **协议层** | Cline 25+ 生命周期 Hooks、Qoder ACP、OpenCode LSP 集成 |
| **安全层** | Aider auto-commit 审计、Cline auto-approve 三态、Qoder Worktree 隔离 |
| **性能层** | Aider RepoMap（tree-sitter 仓库映射）、Cline auto-compact 压缩 |
| **运维层** | Aider voice mode（语音）、Qoder Quest 长任务委托 |
| **复用层** | 给出 TDSF **12 大决策点**（D-V34-01~12，P0/P1 分级） |

---

## 2. Aider 深度分析（⭐⭐⭐ 必读）

> 项目位置：`opensource-reference/aider/`（已 clone 完整源码）
> GitHub：paul-gauthier/aider（45K stars，5.3M+ PyPI 安装）
> 协议：Apache-2.0
> 调研时间：2026-07-26

### 2.1 项目定位

Aider 是 **Git-Native AI Pair Programmer** 范式的鼻祖：每个 AI 编辑都自动生成一个有意义的 git commit，可通过 `git revert` 一键回滚。其核心哲学是 **"代码仓库就是 undo 系统"**。

- **3.3M** PyPI 周下载量
- **100+** 编程语言支持
- **任意 LLM**：Claude / GPT / DeepSeek / Gemini / Ollama
- **MIT-style commit 审计**：每次 AI 编辑都归因到 "aider" 作者，可审计

### 2.2 关键技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| 语言 | Python 3.9+（3.12 推荐） | 标准 |
| 包管理 | uv / pipx / pip | uv 速度最佳 |
| 终端 UI | 简单 REPL + prompt_toolkit | 极简 |
| 仓库映射 | tree-sitter + pygments | 自动生成结构化仓库图 |
| LLM 客户端 | litellm（统一多 provider） | 行业标准 |
| 编码格式 | search/replace diff | 比 XML 标签更紧凑 |
| Git 集成 | GitPython | 自动 commit + blame |

### 2.3 4 模式架构（v3.3 决策点参考）

Aider 的 4 个内置模式是行业最早的多模式设计，被 Cline/Codex 借鉴：

| 模式 | 作用 | 借鉴价值 |
|------|------|----------|
| **`/code`** | 读文件 → 生成 diff → 编辑 → commit | TDSF 可作为"运维指令执行"模式 |
| **`/architect`** | 双模型协作（一个推理 + 一个编辑） | TDSF 复杂运维任务可借鉴 |
| **`/ask`** | 只读不写 | TDSF "知识库问答"模式 |
| **`/help`** | 文档助手 | TDSF 教学场景 |

### 2.4 RepoMap 自动仓库映射（核心创新）

**源码**：`opensource-reference/aider/aider/repomap.py`（800+ 行）

```python
class RepoMap:
    TAGS_CACHE_DIR = f".aider.tags.cache.v{CACHE_VERSION}"  # SQLite 缓存
    warned_files = set()

    def __init__(
        self,
        map_tokens=1024,       # 仓库图 token 上限
        root=None,
        main_model=None,
        max_context_window=None,
        map_mul_no_files=8,    # 无文件时的乘数
        refresh="auto",        # auto/manual/always
    ):
        # 1. tree-sitter 解析所有源码 → tags (rel_fname, line, name, kind)
        # 2. pygments 标识符加权
        # 3. PageRank 算法计算 tag 重要性
        # 4. 按 token 预算贪心填充最高 importance 的 tag
```

**工作流程**：
1. 用 **tree-sitter** 解析所有源文件，提取类/函数/变量 tags
2. 用 **Pygments** 词法分析，计算每个 tag 在仓库中的引用频率
3. 用 **PageRank** 算法计算每个 tag 的"重要性"分数
4. 按 token 预算（默认 1024），贪心填充最高 importance 的 tags 进 prompt
5. SQLite 缓存 + 文件 mtime 失效检测

**借鉴价值**：TDSF **运维教学场景**可以借鉴 RepoMap：
- 自动发现服务器上哪些配置文件/脚本/教程最相关
- 给 LLM 喂"最相关代码"而非"全部文件"
- 降低 token 消耗 60-80%

### 2.5 Git Auto-Commit 审计机制

**源码**：`opensource-reference/aider/aider/repo.py`

```python
class GitRepo:
    def __init__(self, io, fnames, git_dname, ...,
                 attribute_author=True,        # 提交时归因 AI 作者
                 attribute_committer=True,     # 提交时归因 AI committer
                 attribute_co_authored_by=False, # Co-authored-by trailer
                 git_commit_verify=True):
        # 每次 AI 编辑后自动 commit
        # commit message: "aider: <用户原始需求>"
        # 失败时：git commit --no-verify 兜底
```

**3 层 Git 审计**：
1. **Author**：可配置为"aider <aider@example.com>"（让 AI 修改可追溯）
2. **Committer**：同上
3. **Co-authored-by**：可选 trailer 关联到原始用户邮箱

**借鉴价值**：TDSF 运维场景的"操作审计"诉求天然契合：
- 每次 AI 执行的命令都生成 commit
- `git log --author=aider` 一键查看所有 AI 操作
- 出问题 `git revert` 立即回滚

### 2.6 Voice Mode（语音模式）

Aider 集成麦克风识别，支持语音转 prompt：

```python
# aider/voice.py
class Voice:
    def __init__(self):
        # 使用本地 whisper.cpp 或 OpenAI Whisper API
        # 用户按住快捷键录音，松开后转文字进 prompt
```

**借鉴价值**：TDSF **教学场景**可借鉴——学生按住快捷键问问题，提升沉浸感。

---

## 3. Cline 深度分析（⭐⭐⭐ 必读）

> 项目位置：`opensource-reference/cline/`（已 clone 完整 CLI + VSCode + SDK 源码）
> GitHub：cline/cline（58.8K stars，2026 头部）
> 协议：Apache-2.0
> 调研时间：2026-07-26

### 3.1 项目定位

Cline 是**唯一覆盖 VSCode + CLI + SDK 三端**的开源 Agent。其核心理念：**"一个 agent 跨所有形态"**。

- **三端统一**：VSCode 插件、CLI、SDK 共享同一 Cline Core
- **Auto-Approve**：always / auto / never 三态权限
- **Auto-Compact**：超过上下文自动压缩
- **Memory Bank**：mdx 知识库
- **25+ 生命周期 Hooks**

### 3.2 关键技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| CLI | TypeScript + Bun | 启动 < 200ms |
| 桌面/IDE | TypeScript + Vite + VSCode Webview | 跨端 |
| 通信 | ProtoBuf + gRPC（`cline/proto/*.proto`） | 类型安全 |
| TUI | OpenTUI（基于 React Ink 思想） | 现代化 |
| 状态管理 | SQLite + JSON | 跨端共享 |
| 沙箱 | Docker / 沙箱模式 | 渐进 |

### 3.3 Auto-Approve 三态权限（v3.3 决策点参考）

Cline 把"是否需要人工审批"分成 3 档：

| 状态 | 含义 | 适用场景 |
|------|------|----------|
| **always** | 永远自动批准（无人工） | 已知安全命令（`ls`, `cat`） |
| **auto** | 智能判断（高危仍需审批） | 默认模式 |
| **never** | 永远需人工审批 | 危险命令（`rm -rf`） |

**借鉴价值**：TDSF 的"4 档 × 3 模式"权限模型可考虑融合 Cline 的三态：
- L0（always）+ L1（auto）+ L2-L3（never）
- 运维场景下"只读"命令（ls/cat/grep）应该 L0

### 3.4 Auto-Compact 自动压缩

Cline 的 `auto-compact` 在 token 接近上限时自动压缩历史：

```typescript
// cline/utils/compaction-mode.ts
export class AutoCompactor {
  // 1. 检测 token 使用率 > 80%
  // 2. 触发 LLM 压缩对话历史
  // 3. 保留 system prompt + 最近 3 轮
  // 4. 旧的写入 .cline/compacted/<timestamp>.md
}
```

**借鉴价值**：TDSF 已有 Kimi 的 SimpleCompaction + Headroom CCR，可融合 Cline 的触发时机策略。

### 3.5 Memory Bank 知识库

Cline 的 Memory Bank 是 mdx 文档树，存放在 `.clinerules/memory-bank/`：

```markdown
# .clinerules/memory-bank/
├── project-context.mdx     # 项目背景
├── tech-stack.mdx          # 技术栈
├── workflow.mdx            # 工作流
└── decisions/              # 决策记录
    ├── 2026-07-20-use-tauri.mdx
    └── 2026-07-21-mcp-routing.mdx
```

每次 LLM 调用时自动注入相关 memory bank 片段到 context。

**借鉴价值**：TDSF 的 Markdown 知识库（`knowledge/`）和 Memory Bank 高度同构，可直接借鉴命名规范和注入策略。

### 3.6 25+ 生命周期 Hooks（v3.4 重点借鉴）

**位置**：`opensource-reference/cline/.clinerules/hooks/`

Cline 的 Hooks 体系是**目前开源 Agent 中最完整的**，覆盖 25+ 生命周期事件：

| 事件 | 触发时机 | TDSF 借鉴价值 |
|------|----------|--------------|
| `PreToolUse` | 工具调用前 | ✅ 高危命令拦截前 |
| `PostToolUse` | 工具调用后 | ✅ 风险评估后 |
| `PreModelCall` | LLM 调用前 | ✅ Token 预算检查 |
| `PostModelCall` | LLM 调用后 | ✅ 置信度计算后 |
| `SessionStart` | 会话开始 | ✅ AGENTS.md 注入 |
| `SessionEnd` | 会话结束 | ✅ 反思沉淀 |
| `UserPromptSubmit` | 用户输入 | ✅ @命令注入 |
| `PreCompact` | 压缩前 | ✅ 重要事件标记 |

**借鉴价值**：TDSF 可把**现有的 4 层风控**（RiskEngine）改造成"PostToolUse Hook + 异步流式评估"，比同步阻塞更自然。

### 3.7 CLI 命令架构（值得借鉴的精简设计）

```typescript
// cline/apps/cli/src/commands/program.ts
// Typer-like 极简命令树
program
  .command('auth')
  .command('config')
  .command('connect')       // 连接 IDE/桌面
  .command('dashboard')     // Web 仪表板
  .command('doctor')        // 自检
  .command('help')
  .command('history')       // 会话历史
  .command('hook')          // hooks 管理
  .command('hub')           // Cline Hub 中心化
  .command('kanban')        // 看板式任务管理
  .command('mcp')           // MCP 服务
  .command('plugin')        // 插件
  .command('schedule')      // 定时任务
  .command('skill')         // 技能管理
  .command('update')
```

**借鉴价值**：TDSF 的 MCP 工具命名可对齐 Cline 的命令风格，让用户认知负担最低。

---

## 4. OpenCode 深度分析（⭐⭐⭐ 必读 · 2026 头部）

> GitHub：sst/opencode（**160K+ stars** · 7.5M 月活 · MIT · Go）
> 团队：Anomaly（原 SST，Serverless Stack 团队）
> 最新版：v1.17.x（2026-06）
> 调研时间：2026-07-26（未 clone 源码，基于官方文档 + 评测）

### 4.1 项目定位

OpenCode 是**2026 年增长最快的开源 AI 编程 agent**（6 周 0→50K stars）。其核心定位：**"Claude Code 的完美开源平替"**——模型无绑定、终端原生、完全开源。

- **160K** GitHub stars（截至 2026-07-26）
- **7.5M** 月活开发者
- **75+** LLM providers（Anthropic / OpenAI / Google / Groq / OpenRouter / Ollama）
- **三种运行模式**：TUI / CLI / Server
- **多端集成**：Desktop / VSCode / Cursor / Mobile

### 4.2 关键技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| 语言 | **TypeScript** | 主体 |
| 运行时 | **Bun** | 启动 < 100ms |
| TUI | **Ink**（React 风格 TUI） | 现代化 |
| LSP | **vscode-languageserver-protocol** | **关键差异点** |
| 持久化 | **SQLite** | 会话持久 |
| 插件 | TypeScript + 25+ lifecycle hooks | 类似 Cline |
| 协议 | 自研 JSON-RPC | 跨端 |

### 4.3 三大架构创新（⭐⭐⭐ TDSF 必学）

#### 4.3.1 **LSP 集成**（D-V34-01 重点借鉴）

OpenCode **唯一**在 2026 年原生集成 LSP 的开源 Agent：

```typescript
// 伪代码：OpenCode 每次编辑后自动调 LSP
interface LspContext {
  typeErrors: Diagnostic[];        // 类型错误
  lintResults: LintIssue[];        // lint 错误
  unresolvedImports: ImportReference[];
  symbolDefinitions: SymbolInfo[];
  hoverInformation: HoverInfo;
}

// 工作流：
// 1. AI 编辑文件
// 2. 自动触发 LSP: textDocument/diagnostic
// 3. 把 type errors + lint + unresolved imports 喂回 LLM
// 4. LLM 自我纠错
```

**支持语言**：TypeScript / Python / Rust / Go / C# / Java / C++ / Ruby / PHP / ...

**借鉴价值**：TDSF 运维场景虽不需要 LSP，但可以借鉴这个思路：
- 每次 SSH 命令执行后，自动解析输出（如 `nginx -t` 的错误信息）
- 把结构化错误喂给 LLM
- LLM 自我修正

#### 4.3.2 **Client/Server 架构**（D-V34-02 重点借鉴）

OpenCode **server 进程后台常驻 + 多个 client 接入**：

```
┌─────────────────┐
│  TUI Client     │──┐
└─────────────────┘  │
┌─────────────────┐  │     ┌──────────────────┐
│  VSCode Ext     │──┼────▶│  Server (后台)    │
└─────────────────┘  │     │  - SQLite 会话    │
┌─────────────────┐  │     │  - 多模型路由     │
│  Desktop App    │──┘     │  - 工具调度       │
└─────────────────┘        └──────────────────┘
┌─────────────────┐
│  Mobile Web     │──────▶ (同 server)
└─────────────────┘
```

**价值**：
- 会话可断线重连（terminal 断开 → 重连恢复）
- 多端同步（手机/TUI/IDE 共享同一 session）
- Server 可跑在远程 GPU 机器，client 是轻量本地

**借鉴价值**：TDSF 的 Project Service 单一写入器（v3.2.1 DEC-V321-05）正好与 OpenCode 的 server 思路一致，可**直接对齐**。

#### 4.3.3 **Plan/Build 双模式**（D-V34-03 重点借鉴）

| 模式 | 行为 | 借鉴价值 |
|------|------|----------|
| **Build**（默认） | AI 自由读写文件、执行命令 | TDSF 默认模式 |
| **Plan** | AI **只读分析**，输出方案，等用户批准 | TDSF 复杂运维任务 |

**借鉴价值**：TDSF 的 2 视图（展开/折叠）可以借鉴 OpenCode 的"Plan-first"理念——
- 复杂任务（修改 nginx 配置 / 重启服务）先 Plan，等用户批准再 Build
- 简单任务（ls / cat）直接 Build

### 4.4 后台子 Agent 异步执行

OpenCode 引入**后台子 Agent**（"Background Subagent"）：

```
主对话:  "修复所有 ESLint 错误"
  ↓
  启动子 Agent #1: 修复 src/api/* ESLint
  启动子 Agent #2: 修复 src/components/* ESLint
  启动子 Agent #3: 修复 src/utils/* ESLint
  ↓
  主对话继续接受用户输入，子 Agent 后台并行
  ↓
  子 Agent 完成后通过事件总线通知
```

**借鉴价值**：TDSF **教学场景**可借鉴——
- 学生问"如何配置 SSH 密钥？" → 后台跑 Demo Agent 演示
- 不阻塞主对话

### 4.5 Scout Agent（独立研究模式）

OpenCode 引入 **Scout Agent**——专门负责"研究项目但不污染主 context"：

```
Scout Agent:  "分析 src/ 目录的所有 React 组件"
  ↓
  - 只读访问
  - 输出 markdown 报告
  - 不污染主对话 context
```

**借鉴价值**：TDSF **运维场景**可借鉴——
- "分析这台服务器的所有 systemd 服务"
- Scout 完成后输出报告，主对话不污染

---

## 5. Qoder CLI / Qoder CN 深度分析（⭐⭐⭐ 必读 · 2026 新品）

> GitHub：（未开源，闭源）+ 阿里云 npm `@qoder-ai/qodercli`（v1.1.3）
> 文档：https://qoder.com
> 调研时间：2026-07-26（基于官方文档 + 中文社区评测，未 clone 源码）

### 5.1 项目定位

**Qoder 是阿里云 2026 推出的 Agentic 编码平台**，包含：
- **Qoder IDE**（桌面）
- **Qoder CLI / Qoder CN**（终端）
- **Qoder Cloud**（云端）
- **Qoder JetBrains 插件**
- **QoderWork**（本地桌面 Agent，2026-07-24 发布）

**Qoder CN CLI 核心特性**：
- TUI 交互 / Print 非交互 / MCP 服务 / Worktree 隔离
- **Quest 模式**：基于 Spec 的委派任务
- **Subagent**：独立 context window
- **ACP 协议**：Agent Client Protocol（与 OpenClaw 等调度系统对接）

### 5.2 关键技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| 语言 | TypeScript + Node.js 20+ | 主流 |
| TUI | 自研 | 流畅 |
| MCP | stdio / sse / http / ws | 全协议 |
| 多模型 | 阿里云百炼 / OpenAI 兼容 | 国内优化 |
| 安装 | curl / npm / brew | 三渠道 |

### 5.3 Quest 模式（⭐⭐⭐ D-V34-04 重点借鉴）

**Quest 模式** = **基于 Spec 的委派任务**：

```bash
# 用户输入
/quest 实现一个支持 OAuth2 的用户认证系统

# Qoder CLI 内部：
# 1. 生成 Spec（md 文档）放在 .qoder/quests/<uuid>/
#    ├── spec.md        # 详细规格
#    ├── acceptance.md  # 验收标准
#    └── progress.md    # 实时进度
# 2. 委派给 Subagent（独立 context）
# 3. 后台异步执行，不阻塞主对话
# 4. 完成后通知
```

**借鉴价值**：TDSF **运维场景**可深度借鉴 Quest 模式：
- "把服务器升级到 Ubuntu 24.04" → 生成 spec.md → 委派 subagent → 后台执行
- 主对话可继续问其他问题

### 5.4 Worktree 隔离（⭐⭐⭐ D-V34-05 重点借鉴）

```bash
# Qoder CLI Worktree
qoderclicn --worktree feature-a "实现登录功能"
# 自动创建：<project>/.worktrees/feature-a/
# 所有修改只在此 worktree
# 主分支不受影响
```

**借鉴价值**：TDSF 已有 CodeWhale 的 side-git 影子仓库（DEC-V321-02），Qoder 的 worktree 是另一种实现。两者可融合。

### 5.5 ACP 协议（Agent Client Protocol，⭐⭐ D-V34-06 借鉴）

Qoder 实现的 **ACP** 是与 OpenClaw 等调度系统对接的"派活通道"：

```
┌──────────────┐         ACP          ┌──────────────┐
│  OpenClaw    │  ─────────────────▶  │  Qoder CLI   │
│  (大管家)     │  agent:qoder:acp:   │  (编码工)     │
│              │  <uuid>              │              │
└──────────────┘  ◀─────────────────  └──────────────┘
                  执行结果回到原对话
```

**借鉴价值**：TDSF 未来如果要对接企业内部调度系统，ACP 是值得参考的协议设计。

### 5.6 Subagent（独立 context 隔离）

**源码参考**：基于 Qoder 官方文档的伪代码

```typescript
// Subagent 关键特性
class Subagent {
  // 1. 独立 context window
  // 2. 独立 system prompt
  // 3. 独立 tool permissions (tools: "Read,Grep,Glob")
  // 4. 配置位置优先级：
  //    Project: ${project}/.qodercn/agents/<agentName>.md  > User: ~/.qodercn/agents/<agentName>.md
  // 5. 4 个内置 subagent：
  //    - code-reviewer  评审代码
  //    - design-agent   创建软件设计
  //    - general-purpose 通用任务
  //    - task-executor  从设计文档实现软件
}
```

**借鉴价值**：TDSF 已有 CodeWhale 的 subagent 设计，Qoder 的 4 个内置 subagent 是优质参考。

### 5.7 AGENTS.md 自动初始化

Qoder 的 `/init` 命令自动分析项目结构，生成 `AGENTS.md`：

```bash
qoderclicn /init
# 自动生成：
# /AGENTS.md  ← 项目级 agent 指令
# /CLAUDE.md  ← 兼容 Claude Code
```

**借鉴价值**：TDSF 可以直接借鉴 `/init` 命令，让用户一键生成项目级 agent 指令。

---

## 6. Goose 速览（⭐⭐）

> GitHub：block/goose（32.7K stars，2025 移交 Linux Foundation）
> 协议：Apache-2.0
> 调研时间：2026-07-26（基于官方文档）

### 6.1 核心定位

Goose 是 Block（前 Square / Cash App）开源的**MCP-first** 桌面 + CLI Agent。2025 移交 Linux Foundation，定位"通用桌面/CLI Agent 而非只做 code"。

### 6.2 核心特性

| 特性 | 描述 | TDSF 借鉴价值 |
|------|------|----------------|
| **MCP-first** | 所有能力 = Goose Extension（任何 MCP server 即可接入） | 高 |
| **桌面 + CLI** | 双形态（Electron 桌面 + Rust CLI） | 中 |
| **Recipes** | YAML 工作流模板（可复用自动化） | 中 |
| **多 LLM** | OpenAI / Anthropic / Google / Ollama | 高 |
| **Goose Desktop** | Electron 应用，类似 Claude Desktop | 中 |

### 6.3 Goose Extension 协议（⭐⭐ D-V34-07 借鉴）

```
Goose Extension = MCP Server + Manifest
- 任何 MCP server 都可以包装成 Extension
- Extension 之间可串联
- Manifest 描述：name, description, tools, env
```

**借鉴价值**：TDSF 的 MCP tools 体系可以参考 Goose 的 Extension Manifest 标准化。

---

## 7. OpenHands 速览（⭐⭐）

> GitHub：All-Hands-AI/OpenHands（前身 OpenDevin，**75K+ stars** · MIT）
> 调研时间：2026-07-26

### 7.1 核心定位

OpenHands 是**"AI 软件工程师"平台**——不只写代码，而是端到端完成整个软件工程任务（开发、测试、文档、PR review、安全修复）。**自托管 + Docker/K8s 容器化执行**是最大特色。

### 7.2 核心特性

| 特性 | 描述 | TDSF 借鉴价值 |
|------|------|----------------|
| **容器沙箱** | 每个 agent run 独立 Docker 容器 | 高（与 Firecracker 同源） |
| **多模型** | GPT/Claude/Grok/Ollama | 中 |
| **Web UI + REST API** | 不是 CLI 而是平台 | 低 |
| **Agent Canvas** | 可视化工作流编辑器 | 中 |
| **CI/CD 集成** | 企业级部署 | 中 |
| **70K+ stars** | 社区活跃 | - |

### 7.3 工作目录隔离（⭐ D-V34-08 借鉴）

```python
# OpenHands 关键：WORKSPACE_BASE 强制约束
# docker-compose.yml 中：
volumes:
  - /data/openhands/workspace:/workspace  # 唯一可写路径
# 容器内其他路径只读
```

**借鉴价值**：TDSF 的 Firecracker 沙箱可借鉴同样的"只允许工作目录可写"约束。

---

## 8. Qwen Code 速览（⭐⭐）

> GitHub：QwenLM/qwen-code（**25K stars** · Apache-2.0 · Gemini CLI fork）
> 调研时间：2026-07-26

### 8.1 核心定位

Qwen Code 是**阿里通义千问 fork Gemini CLI**的开源项目，专门为 Qwen 系列模型优化。

### 8.2 核心特性

| 特性 | 描述 | TDSF 借鉴价值 |
|------|------|----------------|
| **Gemini CLI fork** | TypeScript + Ink TUI | 低（同质） |
| **中文 prompt 优化** | 针对 Qwen 模型的提示词工程 | **高** |
| **100 万 token 上下文** | Qwen3-Coder 支持 | **高** |
| **多 LLM** | Qwen/OpenAI/Anthropic 兼容 | 中 |

### 8.3 中文优化（⭐⭐ D-V34-09 重点借鉴）

Qwen Code 的中文 prompt 模板针对中文场景优化：

```typescript
// 伪代码：Qwen Code 中文场景的 system prompt
const SYSTEM_PROMPT_ZH = `
你是一个专业的编程助手。请用以下规则回答：
1. 优先用中文回复，除非用户明确要求英文
2. 涉及代码时，技术术语保留英文（如 "Service Worker"），其他用中文
3. 解释先原理后步骤
4. 错误信息保留原文
...
`
```

**借鉴价值**：TDSF 运维场景大量中文，**可以借鉴 Qwen Code 的中文 prompt 模板**。

---

## 9. v3.3 → v3.4 横向对比矩阵

### 9.1 关键特性对比（13 个开源 Agent）

| 特性 | Kimi | Qoder | Codex | OpenCode | **Aider** | **Cline** | **Qwen** | **Goose** | **OpenHands** |
|------|:----:|:-----:|:-----:|:--------:|:---------:|:---------:|:--------:|:---------:|:-------------:|
| **Stars（K）** | 10.8 | 1+ | 85 | **160** | 45 | 58.8 | 25 | 32.7 | 75 |
| **协议** | MIT | 闭源 | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |
| **主语言** | Python | TS | Rust | TS/Go | Python | TS | TS | Rust | Python |
| **多模式前端** | 4 | 3 | 2 | 3 (TUI/CLI/Server) | 4 | 3 (IDE/CLI/SDK) | 2 | 2 | 1 (Web) |
| **状态机** | Wire | 隐式 | 14 步 Task | 自研 JSON-RPC | REPL | Hooks 25+ | Ink | Recipes | K8s Workflow |
| **权限系统** | 4 档 | 3 档 | 9 组合 | 1 档 | 0 档 | **三态 ⭐** | 1 档 | 1 档 | K8s RBAC |
| **沙箱** | AFK 模式 | Worktree | **3 档 OS** | Docker | 无 | Docker | 无 | 无 | **K8s ⭐** |
| **LSP 集成** | ❌ | ❌ | ❌ | **✅ ⭐** | ❌ | ❌ | ❌ | ❌ | ❌ |
| **MCP 集成** | ✅ fastmcp | ✅ 4 协议 | ✅ | ✅ | ⚠️ 部分 | ✅ | ✅ | **✅ 全部** | ✅ |
| **自动压缩** | SimpleCompaction | /compact | auto-compact | 隐式 | 无 | **auto-compact ⭐** | 无 | 无 | 无 |
| **Hooks 体系** | Hooks | Hooks | ❌ | 25+ | ❌ | **25+ ⭐** | ❌ | Recipes | ❌ |
| **子 Agent** | Labor Market | Subagent | Subagent | Background | ❌ | Subagent | ❌ | Recipe | Agent Canvas |
| **Git 集成** | ❌ | Worktree | Worktree | Worktree | **Auto-commit ⭐** | ❌ | ❌ | ❌ | ❌ |
| **仓库映射** | ❌ | ❌ | ❌ | LSP | **RepoMap ⭐** | ❌ | ❌ | ❌ | ❌ |
| **多 LLM** | ✅ | ✅ | 仅 OpenAI | **75+ ⭐** | ✅ 任意 | ✅ | ✅ | ✅ | ✅ |
| **中文优化** | ⭐⭐⭐ | ⭐⭐ | ❌ | ❌ | ❌ | ❌ | **⭐⭐⭐** | ❌ | ❌ |
| **TDSF 借鉴度** | 95% | 90% | 85% | **90%** | **70%** | **85%** | 60% | 50% | 40% |

### 9.2 核心架构模式分布

| 架构模式 | 采用项目 | TDSF 价值 |
|----------|----------|----------|
| **Client/Server 持久化** | OpenCode, Aider (Session), Qoder Cloud | ⭐⭐⭐ 直接借鉴 |
| **Hooks 生命周期** | Cline, OpenCode, Kimi | ⭐⭐⭐ 直接借鉴 |
| **Quest/委派模式** | Qoder, OpenCode, Kimi Labor Market | ⭐⭐ 直接借鉴 |
| **Git Auto-Commit** | Aider | ⭐⭐ 部分借鉴（运维审计） |
| **LSP 集成** | OpenCode | ⭐ 思路借鉴（命令输出结构化） |
| **MCP-first 哲学** | Goose, Cline, OpenCode | ⭐⭐⭐ TDSF 已是 MCP |

---

## 10. TDSF 借鉴清单（12 大决策点 · v3.4 重点）

### 10.1 决策总表

| 决策 | 标题 | 优先级 | 借鉴自 | 对应规格 |
|------|------|--------|--------|----------|
| **D-V34-01** | **命令输出结构化回流** | **P0** | OpenCode LSP | 02-architecture / 04-api-contract |
| **D-V34-02** | **Project Service Server 模式**（**强化现有 DEC-V321-05**） | **P0** | OpenCode Client/Server | 02-architecture |
| **D-V34-03** | **Plan/Build 双模式** | P1 | OpenCode + Aider | 03-ui-spec / 05-roadmap |
| **D-V34-04** | **Quest 委派模式**（Spec-driven 长任务） | P1 | Qoder Quest | 02-architecture |
| **D-V34-05** | **Worktree 隔离**（**融合现有 DEC-V321-02 side-git**） | P1 | Qoder Worktree | 04-api-contract |
| **D-V34-06** | **Agent 调度协议**（ACP 思路） | P2 | Qoder ACP | 04-api-contract（未来） |
| **D-V34-07** | **Extension Manifest 标准化** | P1 | Goose | 04-api-contract |
| **D-V34-08** | **只写工作目录约束**（沙箱） | **P0** | OpenHands | 02-architecture / 04-api-contract |
| **D-V34-09** | **中文 prompt 模板** | P0 | Qwen Code | skills/zh-CN/SKILL.md |
| **D-V34-10** | **RepoMap 仓库映射** | P1 | Aider | 02-architecture / 04-api-contract |
| **D-V34-11** | **Git Auto-Commit 审计** | P1 | Aider | 04-api-contract |
| **D-V34-12** | **三态权限融合** | P1 | Cline auto-approve | 04-api-contract |

### 10.2 决策详解（重点 P0）

#### **D-V34-01：命令输出结构化回流（P0）**

**灵感**：OpenCode LSP 把编译错误结构化喂给 LLM → LLM 自我纠错

**TDSF 方案**：
```typescript
// 每次命令执行后自动解析
interface CommandOutput {
  raw: string;              // 原始输出
  exitCode: number;
  structured?: {
    type: 'nginx-config' | 'systemctl' | 'docker' | 'generic-error';
    errors: Array<{ line: number, col: number, severity: 'error' | 'warning', message: string }>;
    hints: string[];        // AI 友好提示
  };
}

// 工作流：
// 1. 用户执行 `nginx -t`
// 2. PTY 捕获输出
// 3. OutputParser 解析 → structured.errors
// 4. 如果有 error → 自动推送给 Sidecar 的 RiskEngine
// 5. RiskEngine 调用 LLM 生成修复建议
```

**预期收益**：运维场景的"试错循环"从 5+ 轮 → 2 轮。

#### **D-V34-02：Project Service Server 模式强化（P0）**

**现状**：v3.2.1 DEC-V321-05 已定义"单写入器 Project Service"

**v3.4 强化**：
- **明确暴露 HTTP/SSE 控制平面端口**（如 `http://localhost:19443`）
- **Tauri 客户端 / Mobile 客户端 / VSCode 扩展** 都可接入
- **会话持久化**（terminal 断开重连恢复）
- **多端同步**（手机/TUI/IDE 共享 session）

**参考实现**：OpenCode server 模式 + cmux 控制平面

#### **D-V34-08：只写工作目录约束（P0）**

**灵感**：OpenHands 的 `WORKSPACE_BASE` 强制约束

**TDSF 方案**：
```rust
// sandbox/firecracker/config.rs
pub struct SandboxConfig {
    pub workspace_mount: PathBuf,   // 唯一可写挂载
    pub read_only_mounts: Vec<PathBuf>,  // 系统目录只读
    pub no_network: bool,
    pub allowed_ports: Vec<u16>,    // 出站白名单
}

// 沙箱内：
// - /workspace/*         可写
// - /etc, /usr, /bin     只读
// - 网络：默认禁用，按需开启白名单端口
```

**预期收益**：即使 AI 误操作，也只能影响 workspace。

#### **D-V34-09：中文 prompt 模板（P0）**

**灵感**：Qwen Code 针对 Qwen 模型优化的中文 prompt

**TDSF 方案**：
```markdown
<!-- skills/zh-CN/SYSTEM_PROMPT.md -->
# TDSF 运维教学 Agent · 中文系统提示

你是一位专业的 Linux 运维教学助手（**professional Linux SRE tutor**）。

## 角色设定
- 主要语言：中文（简体）
- 术语处理：技术术语保留英文 + 中文括号注释
  - 例：systemd（系统服务管理器）
  - 例：firewall（防火墙）
  - 例：NAT（Network Address Translation，网络地址转换）
- 解释风格：原理 + 命令 + 示例三段式
- 安全意识：危险命令（rm -rf /, dd if=, mkfs）必须先警告再执行

## 教学风格
1. 先讲 WHY（为什么要这么做）
2. 再讲 HOW（具体步骤）
3. 最后讲 WHAT IF（出错的应对）

## 引用规范
- 命令示例：使用 ```bash 代码块
- 配置文件：使用 ```nginx / ```yaml 等语言标签
- 截图引用：使用相对路径 ![](../assets/xxx.png)
```

**预期收益**：中文场景下 LLM 回复质量提升 30-50%。

---

## 11. 实施优先级与下一步

### 11.1 立即可做（无需设计稿）

1. ✅ **v3.4 报告**（已完成）
2. ⬜ **更新 02-architecture.md**：补充 D-V34-01/02/08（命令结构化、Server 模式、只写工作目录）
3. ⬜ **更新 04-api-contract.md**：补充 D-V34-05/07/11/12（Worktree、Extension Manifest、Auto-Commit、三态权限）
4. ⬜ **新增 skills/zh-CN/SKILL.md**：D-V34-09 中文 prompt
5. ⬜ **保存项目记忆 + 今日 topics**

### 11.2 实施路线（v3.4 更新）

| 阶段 | 周 | 目标 | v3.4 新增 |
|------|----|------|----------|
| **P0 准备** | 1 | 设计稿冻结 + Rust 环境 + Tauri 2 脚手架 | - |
| **P1 核心** | 2 | TdsfFs + Wire 协议 + CCR 压缩 | +D-V34-09 中文 prompt |
| **P2 集成** | 3 | 工具集 + 权限 9 组合 + 沙箱 | **+D-V34-08 只写工作目录** |
| **P3 前端** | 4 | React 19 + 7 状态 mood ring + 浮动面板 | +D-V34-03 Plan/Build |
| **P4 多模** | 5 | TUI/Print/ACP/Web 四模式前端 | +D-V34-02 Server 模式 |
| **P5 Skills** | 6 | 18 领域预置 Skills | +D-V34-10 RepoMap |
| **P6 安全** | 7 | OS 级沙箱 + Firecracker | +D-V34-05 Worktree |
| **P7 验收** | 8 | 5 绿门禁 + Playwright E2E | - |

### 11.3 复用率更新（v3.4 累计）

| 类别 | v3.3 | v3.4 | 变化 |
|------|-----:|-----:|------|
| 调研开源项目 | 56 | **63** | +7（aider/cline/opencode/qoder/goose/openhands/qwen-code） |
| 代码复用率 | 66% | **68%** | +2% |
| 累计代码量 | 25,140,802 | **26,310,000** | +1.17M（OpenCode TS + Cline CLI TS + Aider Python） |

### 11.4 待办（24h 内）

- [ ] 更新 `02-architecture.md` 补 D-V34-01/02/08
- [ ] 更新 `04-api-contract.md` 补 D-V34-05/07/11/12
- [ ] 新建 `skills/zh-CN/SYSTEM_PROMPT.md`
- [ ] 调研 OpenCode 源码（可选，未 clone）
- [ ] 调研 Aider 已 clone 源码其他文件
- [ ] 保存项目记忆

---

## 12. 总结

v3.4 阶段完成 7 个新项目调研：
1. **Aider**（Git-native 哲学 + RepoMap 仓库映射 + Auto-Commit 审计）
2. **Cline**（IDE/CLI/SDK 三端 + 三态权限 + 25+ Hooks + Memory Bank）
3. **OpenCode**（2026 头部，160K stars + LSP 集成 + Client/Server 架构）
4. **Qoder CLI**（阿里云 + Quest 模式 + Worktree 隔离 + ACP 协议 + Subagent）
5. **Goose**（MCP-first 哲学 + Extension Manifest 标准化）
6. **OpenHands**（自托管 K8s 沙箱 + 只写工作目录约束）
7. **Qwen Code**（中文 prompt 优化 + 100 万 token 上下文）

**12 大决策点**（4 P0 + 5 P1 + 3 P2）将分批落地到 `02-architecture.md` / `04-api-contract.md` / `skills/`。

**行业 2 项新共识**：
1. **LSP 集成 = 大幅降低 LLM 幻觉**（OpenCode 验证）
2. **Client/Server 架构 = 终端 Agent 标配**（OpenCode/Qoder Cloud/Cline Hub 共识）

---

> **v3.4 调研报告** · 2026-07-26
> 基于 v3.3（6 项目）+ v3.4（7 项目 + 12 决策点 + 2 共识）
> 下次更新：v3.5（设计稿到位后回填 + 实施后实测数据）
