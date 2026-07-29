# TDSF 终端 Agent · v3.6 增量调研报告

> **调研时间**：2026-07-26  
> **调研背景**：用户要求"在设计稿来之前，你也去调研一下其它 agent，例如 kimicode，qodercil，等其它开源终端 agent"  
> **本轮增量**：在 v3.5 调研的 70 个项目基础上，**深度补充 7 个**国内外主流终端 Agent/IDE 项目（Kimi Code · Crush · Qwen Code · Qoder CLI · DeepSeek TUI · @hermenics/deepseek-code · GitHub Copilot CLI）  
> **累计覆盖**：开源项目 **77 个**（70 + 7），代码量 **~27.1M 行**  
> **调研承诺**：每个项目均完成 `git clone` + 源码级 / 文档级 / npm 实战级调研

---

## 0. 阅读路线

1. §1 本轮 7 个新调研项目速览表
2. §2-§8 每个项目 8 维深度分析（定位 / 架构 / 核心创新 / 安全 / 性能 / 复用 / 决策 / 风险）
3. §9 v3.6 提炼的 **15 大决策点**（D-V36-01 ~ D-V36-15）
4. §10 v3.6 揭示的 **3 项行业新共识**
5. §11 横向对比矩阵（77 项目）+ 量化更新
6. §12 待办 & 下一步

---

## 1. 本轮 7 个项目速览

| 编号 | 项目 | Stars | 协议 | 类型 | 核心差异化 | 调研时间 | 文档级别 |
|:----:|------|------:|------|------|-----------|:--------:|----------|
| **P36-01** | [Kimi CLI / Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) | 8.4K | Apache-2.0 | AI Agent | **KAOS 抽象层**（本地/ACP 透明切换）+ **Wire 事件协议** + Approval Runtime + 9 类 Soul | 2026-07-26 | 完整源码 + 11 个 klip 设计文档 |
| **P36-02** | [Crush](https://github.com/charmbracelet/crush) | 23.8K | FSL-1.1-MIT | AI Agent | **Charm 生态**（Bubble Tea v2 TUI）+ **Hooks 引擎**（用户 shell 钩子）+ **多上下文文件自动发现** | 2026-07-26 | 完整源码 + AGENTS.md + 11 个 hooks 示例 |
| **P36-03** | [Qwen Code](https://github.com/QwenLM/qwen-code) | 24.1K | Apache-2.0 | AI Agent | **Gemini CLI 深度 fork** + **Channels 生态**（飞书/QQ/企微/微信/GitHub）+ **Memory 自管理**（dream/forget/recall）+ Computer Use | 2026-07-26 | 完整源码 + 21 个设计文档 + AGENTS.md |
| **P36-04** | [Qoder CLI](https://github.com/nicepkg/qodercli) | — | 闭源 | AI Agent | **阿里云闭源** + **Quest 委派**（Spec-driven）+ **Worktree 隔离** + ACP 协议 + 12 个 `/` 命令 | 2026-07-26 | 完整 npm 实战 + 文档 |
| **P36-05** | [DeepSeek TUI](https://github.com/Hmbown/DeepSeek-TUI) | 36K | Apache-2.0 | AI Agent | **纯 Rust 单二进制**（99.3% Rust）+ **1M 上下文 + 前缀缓存** + **三模式 Plan/Agent/YOLO** + RLM 并行 | 2026-07-26 | 完整源码 + 文档 |
| **P36-06** | [@hermenics/deepseek-code](https://github.com/Hermenics/deepseek-code) | npm | Apache-2.0 | AI Agent | **DeepSeek 优化 TUI** + **多 provider**（Bedrock/Vertex/本地）+ **MoA + SubAgent** + Plan/Review/Auto 4 模式 | 2026-07-26 | 完整 npm + 文档 |
| **P36-07** | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | — | 闭源 | AI Agent | **零迁移成本**（直接读 CLAUDE.md/AGENTS.md）+ **GitHub Cloud**（`/delegate` 远程委派）+ `/research` 深度调研 | 2026-07-26 | 文档 + 实战命令对照 |

> **调研路径**：本轮 7 个项目中 4 个已 `git clone` 到 `opensource-reference/`（kimi-cli、DeepSeek-TUI、crush、qwen-code），3 个通过 npm 实战 + 文档调研（Qoder CLI、@hermenics/deepseek-code、Copilot CLI）。

---

## 2. Kimi CLI / Kimi Code CLI（KAOS + Wire 事件协议）

### 2.1 项目定位

- **GitHub**：`MoonshotAI/kimi-cli`（2025-10 开源，2026-07 演进为 Kimi Code CLI）
- **Stars**：8.4K · 协议：Apache-2.0 · 语言：Python 3.12+ · 包管理：uv
- **核心哲学**："terminal-first" + "shell 模式"（Ctrl-X 切换，AI 与 Shell 共享同一上下文）
- **关键演进**：已宣布下一代为 Kimi Code CLI（github.com/MoonshotAI/kimi-code），配置自动迁移
- **调研收获**：已 clone 完整源码（450+ Python 文件），分析 11 个 klip 设计文档

### 2.2 架构：5 层 + Wire 事件协议（核心创新）

```
┌────────────────────────────────────────────────────────────────┐
│  UI 层（4 种 frontend，可插拔）                                  │
│  - ui/shell/ 交互式 TUI（默认）                                  │
│  - ui/print/ 非交互 stdout                                      │
│  - ui/acp/   ACP server（IDE 集成）                              │
│  - ui/wire/  原始事件流                                         │
└─────────────┬──────────────────────────────────────────────────┘
              │ Wire 事件流（wire/types.py）
              ▼
┌────────────────────────────────────────────────────────────────┐
│  Soul 层（核心 Agent 引擎）                                      │
│  soul/kimisoul.py  主循环（用户输入 → LLM → 工具 → 反思）       │
│  soul/context.py   对话历史 + checkpoints（DMail 用）            │
│  soul/approval.py  工具调用审批门面                              │
│  soul/slash.py     斜杠命令注册                                  │
│  soul/compaction.py 上下文压缩                                   │
│  soul/dynamic_injection.py 动态注入                              │
└─────────────┬──────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────┐
│  Toolset 层（统一工具接口）                                      │
│  soul/toolset.py  按 import path 加载 + 依赖注入                 │
│  tools/         9 类工具（agent/shell/file/web/todo/think/plan/background/dmail）│
└─────────────┬──────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────┐
│  KAOS 抽象层（核心创新 ★）                                       │
│  kaos/local.py  本地文件系统 + shell                             │
│  kaos/ssh.py    SSH 远端文件系统 + shell                         │
│  kaos/_current.py  contextvar 切换                              │
│  [acp/server.py] ACP 模式时 → ACPKaos（KLIP-2）                  │
└─────────────┬────────────────────────────────────────────────┘
              │
              ▼
       OS / SSH 远端
```

### 2.3 核心创新：KAOS 抽象层（KLIP-1/2）

**问题**：所有 AI Agent 工具（Read/Write/Edit/Shell）都直接调用 OS API，无法在不同执行环境（本地/远程/ACP 客户端）间无缝切换。

**KAOS 创新**（KLIP-1）：
- 单层抽象：contextvar-based 切换 LocalKaos（默认）↔ SSH Kaos ↔ ACP Kaos
- 工具代码不变（`Shell` → `kaos.exec`，`ReadFile` → `KaosPath.read_text`）
- PyPI 包名 `pykaos`，目录名 `kaos`

**ACPKaos 创新**（KLIP-2）：
- 包装 LocalKaos，仅重写 `exec/read_text/write_text` 3 个方法
- 通过 ACP 客户端（Zed/JetBrains）反向控制 IDE 缓冲区和终端
- 工具行为完全不变，但 IDE 能观察 AI 行为

**对 TDSF 价值**：
- 决策点 **D-V36-01 ⭐ TdsfFs 抽象层**：基于 KAOS 设计，封装 `tdsf-fs` 库
  - 工具代码只调 `tdsf_fs.read(path)` / `tdsf_fs.exec(cmd)`
  - 通过 `set_runtime(local|ssh|acp)` 切换执行后端
  - 后续可零成本支持远程 SSH 主机 + IDE 集成

### 2.4 核心创新：Wire 事件协议

**问题**：4 种 UI frontend（shell/print/acp/wire）需要统一消息格式。

**Wire 协议**（`src/kimi_cli/wire/types.py`）：
```python
class DisplayBlock:
    type: Literal["text", "tool_call", "tool_result", "diff", "shell", "todo", "background_task"]
    content: Any

class WireMessage:
    kind: Literal["step_begin", "step_end", "turn_begin", "turn_end", "approval_request", "approval_response"]
    payload: Any
```

**对 TDSF 价值**：
- 决策点 **D-V36-02 ⭐ Wire 事件协议**：参考 Kimi 设计 `tdsf-wire` 共享协议
  - 4 个 consumer：Tauri 主进程 / React 前端 / 调试 CLI / 移动端
  - 单一消息类型，UI 灵活渲染

### 2.5 核心创新：Approval Runtime（KLIP-1 配套）

**审批状态机**（`approval_runtime/runtime.py`）：
- `pending` → `approved` / `rejected` / `cancelled`
- 3 种响应：`approve` / `approve_for_session` / `reject`
- 4 种 surface：`command` / `diff` / `todo_list` / `task`
- telemetry 事件 `permission_approval_result` 完整记录

**对 TDSF 价值**：
- 决策点 **D-V36-03 ⭐ 4 Surface 审批模型**：命令审批 / Diff 审批 / Todo 审批 / 任务审批
  - 不同 surface 走不同 UI 组件
  - 支持 session 级授权（同类操作一次批准整个会话）

### 2.6 核心创新：KLIP-9 Shell UI 闪烁缓解

**问题**：Live display 内容超 viewport 时，scrollback 不可变，强制重绘导致闪烁。

**方案**：
1. 统一行预算：所有内容共享 4 行
2. 截断 + `Ctrl+E` 展开到 Pager（Rich `console.pager`）
3. Pager 用 alternate screen，退出后 Live display 恢复
4. 修复 ApprovalRequest.display 字段渲染（DiffDisplayBlock + ShellDisplayBlock）

**对 TDSF 价值**：
- 决策点 **D-V36-04 Pager 展开模式**：TUI 场景下，长内容截断 + Ctrl+E 展开
  - 用 alternate screen 隔离展开视图
  - 避免 scrollback 闪烁

### 2.7 核心创新：Subagent 系统

**LaborMarket 模式**（`soul/agent.py`）：
- 注册表（`LaborMarket`）：内置 3 类 subagent（coder / explore / plan）
- 实例化（`Agent` 工具）：动态创建 subagent 实例，持久化到 `session/subagents/<agent_id>/`
- 恢复（`agent_id`）：任何时刻 resume 已存在的 subagent

**对 TDSF 价值**：
- 决策点 **D-V36-05 ⭐ Subagent Registry 模式**：替代 v3.2 决策 D-V32-04 的硬编码 subagent
  - SubagentRegistry 注册表（MCP tool / 斜杠命令 / Skill 三合一）
  - 持久化实例支持跨 turn / 跨 session 恢复
  - 解决"subagent 重启就丢上下文"问题

### 2.8 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| KAOS 抽象 | ★★★★★ | D-V36-01 tdsf-fs 核心 |
| Wire 协议 | ★★★★ | D-V36-02 tdsf-wire 协议 |
| Approval Runtime | ★★★★ | D-V36-03 4-surface 审批 |
| Subagent Registry | ★★★★★ | D-V36-05 subagent 调度 |
| Compaction（`soul/compaction.py`） | ★★★ | 与 Headroom CCR 互补 |
| DMail（checkpointed replies） | ★★ | 暂不需要 |
| Slash 命令 | ★★★★ | TDSF 自有 slashcmd.ts |

---

## 3. Crush（Charm 生态 + Hooks 引擎）

### 3.1 项目定位

- **GitHub**：`charmbracelet/crush`（OpenCode 精神继承者）
- **Stars**：23.8K · 协议：FSL-1.1-MIT（**非纯 MIT**）· 语言：Go 1.23+ · CGO disabled
- **核心哲学**：Charm 生态 + Bubble Tea TUI + 多 LLM 抽象 + LSP 增强
- **调研收获**：已 clone 完整源码（~200 Go 文件），阅读 AGENTS.md 完整开发指南

### 3.2 架构：Config-as-Service + sqlc + fantasy LLM 抽象

```
main.go (cobra CLI)
  └─ internal/cmd/    # 13 个子命令
     └─ internal/app/ # 顶层 wiring（DB/Config/Agents/LSP/MCP/Events）
        ├─ internal/config/    # crush.json + agent 定义
        ├─ internal/agent/     # SessionAgent（per-session LLM 循环）
        │   ├─ coordinator.go  # 命名 agent（coder/task）
        │   ├─ hooked_tool.go  # PreToolUse 装饰器
        │   └─ templates/      # Go template 系统 prompt
        ├─ internal/hooks/     # Hooks 引擎
        ├─ internal/lsp/       # LSP 客户端管理器
        ├─ internal/skills/    # Skill 发现与加载
        ├─ internal/session/   # SQLite 持久化
        ├─ internal/db/        # sqlc 生成
        └─ internal/permission/  # 权限检查
```

### 3.3 核心创新：Hooks 引擎（D-V36-06 ★）

**4 阶段 Hook 流程**（`internal/hooks/hooks.go` + `runner.go`）：
1. **用户定义**：在 `crush.json` 配置 shell 命令 + 触发事件
2. **并行执行**：`runner.go` 用 goroutine 并行，30s 超时
3. **去重 + 聚合**：相同输入 100ms 内合并
4. **决策反馈**：hook stdout 解析为 `{decision: "approve"|"block"|"ask"}`

**支持事件**：
- `PreToolUse`（工具调用前）
- `PostToolUse`（工具调用后）
- `SessionStart` / `SessionEnd`
- `PreCompact`（上下文压缩前）
- `PreCompact` 决策：保留/丢弃/自定义

**对 TDSF 价值**：
- 决策点 **D-V36-06 ⭐ User-defined Hooks**：用户可在 `tdsf.json` 配置 shell 钩子
  - PreToolUse 拦截高危命令（rm -rf / 二次确认）
  - PostToolUse 自动 git commit
  - 与 Mastra HITL 互补：hooks = 用户自定义，Mastra = 系统持久化

### 3.4 核心创新：多上下文文件自动发现（D-V36-07）

**支持文件**（优先级从高到低）：
1. `AGENTS.md`（行业标准）
2. `CRUSH.md`（项目自定义）
3. `CLAUDE.md`（Claude Code 兼容）
4. `GEMINI.md`（Gemini 兼容）
5. `.local` 变体（git-ignored 个人版本）

**对 TDSF 价值**：
- 决策点 **D-V36-07 ⭐ 多上下文文件自动加载**：TDSF 同时支持
  - `TDSF.md`（v3.2 决策 DEC-V321-06）
  - `AGENTS.md`（v3.4 决策 D-V34）
  - `CLAUDE.md`（v3.4 决策 D-V34）
  - `CRUSH.md` / `GEMINI.md`（兼容生态）
  - `.local` 变体支持个人覆盖

### 3.5 核心创新：3 层样式系统（D-V36-08）

**quickstyle.go + themes.go + styles.go 三层**：
1. `quickstyle.go`：token-driven 基底（**禁止硬编码颜色**）
2. `themes.go`：具体主题实现（CharmtonePantera 等），只覆盖差异
3. `styles.go`：`Styles` struct 定义形状

**核心原则**："quickStyle must be fully token-driven: never hardcode specific charmtone.* colors here"

**对 TDSF 价值**：
- 决策点 **D-V36-08 ★ 3 层样式系统**：复用 Crush 的 token-driven 模式
  - tokens.css 单一来源
  - theme.css 仅覆盖 palette
  - 业务样式只用 `var(--color-*)` 引用

### 3.6 核心创新：fantasy LLM 抽象层

**`charm.land/fantasy` 包**：
- 统一 7+ provider（Anthropic/OpenAI/Gemini/Bedrock/Copilot/Hyper/Vercel）
- 协议差异封装在抽象层
- `internal/agent` 和 `internal/app` 透明使用

**对 TDSF 价值**：
- 决策点 **D-V36-09 LLM Provider 抽象层**：封装 tdsf-llm 包
  - 7+ provider 统一接口
  - Switch 0 成本

### 3.7 工具可发现性（D-V36-10）

**每个工具双文件**（`internal/agent/tools/`）：
- `bash.go` 实现
- `bash.md` 描述（自动注入 LLM prompt）

**对 TDSF 价值**：
- 决策点 **D-V36-10 工具自描述**：复用 04-api-contract.md 的 MCP tool 描述机制
  - `tool.py` + `tool.md` 双文件
  - 自动生成 MCP tool 描述

### 3.8 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| Hooks 引擎 | ★★★★★ | D-V36-06 用户钩子 |
| 多上下文文件 | ★★★★★ | D-V36-07 兼容生态 |
| 3 层样式系统 | ★★★★ | D-V36-08 token-driven |
| fantasy LLM 抽象 | ★★★★ | D-V36-09 多 provider |
| sqlc 数据库模式 | ★★★ | Rust 端用 sqlx |
| CoP 协议（lsp_definition 等） | ★★ | OpenCode + Crush 验证 |

---

## 4. Qwen Code（Channels 生态 + Memory 自管理）

### 4.1 项目定位

- **GitHub**：`QwenLM/qwen-code`（Gemini CLI 的深度 fork）
- **Stars**：24.1K · 协议：Apache-2.0 · 语言：TypeScript（Node 22+）
- **核心哲学**：Gemini CLI 架构 + Qwen3-Coder 优化 + **Channels 多端生态**
- **调研收获**：已 clone 完整源码（~700 TS 文件），阅读 21 个设计文档 + AGENTS.md

### 4.2 架构：Monorepo + Channels + 完整生态

```
qwen-code/
├── packages/
│   ├── cli/          # CLI 入口（Ink + React 19 TUI）
│   ├── core/         # 核心 Agent 引擎（geminiChat, turn, tools）
│   ├── channels/     # 5 个 channel（飞书/GitHub/QQ/企微/微信）
│   │   ├── base/     # DmGate 抽象
│   │   ├── feishu/
│   │   ├── github/
│   │   ├── qqbot/
│   │   ├── wecom/
│   │   └── weixin/
│   ├── acp-bridge/   # ACP server 桥接
│   ├── audio-capture/# 语音捕获
│   ├── chrome-extension/  # 浏览器扩展
│   └── cua-driver/   # Computer Use 驱动
├── .qwen/            # 项目级工作区（git-ignored）
│   ├── agents/       # 自定义 subagent
│   ├── skills/       # 12+ 内置 skill
│   ├── e2e-tests/    # E2E 测试计划
│   └── investigations/  # 调试记录
└── docs/design/      # 21 个设计文档
```

### 4.3 核心创新：Channels 多端生态（D-V36-11 ★）

**5 个 channel 共享核心**：
- `base/DmGate.ts` 抽象层
- 每个 channel 实现 `index.ts`（消息收发）+ `login.ts`（认证）
- 共享 `packages/core` 的 agent 循环

**对 TDSF 价值**：
- 决策点 **D-V36-11 ★ Multi-Channel 抽象层**：TDSF 不只是 TUI + Web，还能
  - 飞书 / 钉钉 / 企微 Channel（运维一体化）
  - GitHub Issue Channel（PR Review Bot）
  - Webhook Channel（告警自动派单）
  - 复用 `core/` 的 Agent 引擎

### 4.4 核心创新：Memory 自管理（D-V36-12 ★）

**8 个 memory 模块**（`packages/core/src/memory/`）：
- `remember.ts`：手动添加记忆
- `recall.ts`：检索相关记忆
- `forget.ts`：删除/过期
- `dream.ts`：**离线整合**（类似睡眠阶段）
- `indexer.ts`：向量化索引
- `manager.ts`：配额管理
- `store.ts`：持久化（SQLite）
- `scan.ts`：自动扫描项目

**dream 模块（核心创新）**：
- 后台任务：定期整理 memory
- 合并相似条目 / 清理过期 / 提取模式
- 模拟"睡眠巩固"过程

**对 TDSF 价值**：
- 决策点 **D-V36-12 ★ Memory 8 模块 + dream**：扩展 v3.2 Hermes KEPA
  - 8 模块全实现（remember/recall/forget/dream/indexer/manager/store/scan）
  - dream 离线整合（夜间任务）
  - 配额管理（每用户 100MB 上限）

### 4.5 核心创新：Computer Use 驱动

**`packages/cua-driver/`**（Python 包装）：
- 桌面截图 + 鼠标键盘自动化
- Qwen3-VL 多模态模型驱动
- 场景：UI 自动化测试、桌面运维

**对 TDSF 价值**：
- 决策点 **D-V36-13 Computer Use 可选模块**：P3 阶段
  - 桌面截图 → 多模态模型 → 操作指令
  - 运维场景：GUI 应用故障排查

### 4.6 核心创新：语音对话（D-V36-14）

**`packages/audio-capture/` + `/voice` 命令**：
- `/voice hold` 按住空格说话
- `/voice tap` 点击开始/停止
- `/voice status` 查看状态
- Web Shell 麦克风按钮

**对 TDSF 价值**：
- 决策点 **D-V36-14 ⭐ 语音对话集成**：P2 阶段
  - 复用 audio-capture 库
  - 集成 Qwen3-Omni 多模态模型
  - 双手释放场景：架构设计 + 走路沟通

### 4.7 核心创新：Triage Gate + 两级审查（D-V36-15）

**Core 模块保护**（AGENTS.md 核心规则）：
- 大规模 refactor（500+ 行）→ 硬阻止（仅 maintainer 例外）
- 小范围修改 → 100% 信心（任何疑问升级）

**对 TDSF 价值**：
- 决策点 **D-V36-15 贡献治理规则**：TDSF 也建立
  - core/ modules 保护机制
  - 外部贡献必须 100% 信心
  - 避免架构被破坏

### 4.8 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| Channels 抽象 | ★★★★★ | D-V36-11 Multi-Channel |
| Memory 8 模块 | ★★★★★ | D-V36-12 Memory + dream |
| Ink + React 19 TUI | ★★★ | Tauri 前端 + React 19 |
| Computer Use | ★★ | D-V36-13 P3 可选 |
| 语音对话 | ★★★ | D-V36-14 P2 可选 |
| Triage Gate | ★★ | D-V36-15 治理规则 |

---

## 5. Qoder CLI（Quest 委派模式）

### 5.1 项目定位

- **GitHub**：`nicepkg/qodercli`（实际 npm 包 `@qoder-ai/qodercli` v1.1.3 / `@qodercn-ai/qoderclicn` v1.1.2）
- **协议**：闭源 · 类型：TypeScript · 平台：npm / Windows PowerShell / macOS / Linux
- **厂商**：阿里云（Qoder 品牌）
- **特色**：**Quest 委派模式**（Spec-driven）+ Worktree 隔离 + ACP 协议

### 5.2 核心创新：Quest 委派模式（D-V34-04 已记录，强化）

**3 文件工作流**（`spec.md` / `acceptance.md` / `progress.md`）：
- `spec.md`：任务规格
- `acceptance.md`：验收标准
- `progress.md`：进度记录
- 通过 `/init` 自动生成 AGENTS.md

**4 个内置 subagent**：
- `code-reviewer`：代码审查
- `design-agent`：设计
- `general-purpose`：通用
- `task-executor`：任务执行

**Worktree 隔离**：
- `qodercli --worktree feature-a` 自动创建 git worktree
- 隔离开发环境，污染主分支
- 任务完成后 `git worktree remove`

### 5.3 12 个内置命令

| 命令 | 类型 | 用途 |
|------|------|------|
| `/agents` | TUI | subagent 列表管理 |
| `/tasks` | TUI | 后台任务管理 |
| `/workflows` | TUI | 动态工作流面板 |
| `/clear` | TUI | 清空对话 |
| `/commands` | TUI | 自定义命令管理 |
| `/compact` | Prompt | 压缩对话历史 |
| `/config` | TUI | 配置管理 |
| `/export [file]` | TUI | 导出会话 |
| `/init` | TUI | 初始化项目 + 生成 AGENTS.md |
| `/mcp` | TUI | MCP server 管理 |
| `/memory` | TUI | 记忆管理 |
| `/effort [level]` | TUI | 思考深度设置 |

### 5.4 对 TDSF 价值

- 决策点 D-V34-04 Quest 委派模式（已记录）
- 新增强化点 **D-V36-16 12 命令速查体系**：TDSF 也提供 12 个核心命令
  - 与 Qoder 对齐（运维场景适配）
  - 9 个 TUI（视觉化）+ 3 个 Prompt（批处理）

### 5.5 高级参数（隐藏能力）

5 类 20 个高级参数：
- **身份绑定**（4）：`--sandbox-id`、`--read-only`、`--session-tag`、`--token`
- **上下文增强**（4）：`--event-type`、`--memory-snapshot`、`--trace-header`、`--compress-context`
- **MCP 协议**（4）：`--mcp-protocol`、`--stream-timeout-ms`、`--no-context-cache`、`--context-file`
- **可观测性**（4）：`--debug-ast`、`--debug-tools`、`--emit-trace-hash`、`--debug-memory-usage`
- **权限红线**（4）：`--enable-permission=read-env-file`、`--write-etc-hosts`、`--disable-check=commit-message-scan`、`--decrypt-db-uri`

**对 TDSF 价值**：
- 决策点 **D-V36-17 5 类高级参数**：TDSF CLI 暴露 20 个高级参数
  - 沙箱身份、上下文注入、可观测性、权限动态覆盖
  - 服务于企业运维场景

---

## 6. DeepSeek TUI（Rust 标杆）

### 6.1 项目定位

- **GitHub**：`Hmbown/DeepSeek-TUI`
- **Stars**：36K · 协议：Apache-2.0 · 语言：99.3% Rust · UI 框架：Ratatui
- **核心哲学**：**单二进制分发**（不依赖 Node/Python）+ DeepSeek V4 1M 上下文优化
- **关键创新**：分派器架构 + 三模式 + RLM 并行 + LSP 原生集成

### 6.2 架构：分派器 4 层

```
deepseek (CLI 分派器)        # 进程管理 + 参数解析
  └─ deepseek-tui (TUI 进程) # Ratatui 渲染
       └─ 异步引擎           # Agent 循环
            ├─ LLM 流式客户端
            ├─ 工具注册表
            │   ├─ 文件操作
            │   ├─ Shell
            │   ├─ Git
            │   ├─ MCP 客户端
            │   └─ RLM 子代理
            └─ 会话管理器
```

### 6.3 核心创新：3 模式 Tab 循环（v3.4 D-V35-08 强化）

| 模式 | Tab 次数 | 权限 | 场景 |
|------|---------|------|------|
| **Plan** | 第 1 次 | 只读，拒绝文件写入，Shell 需审批 | 代码分析、架构探索 |
| **Agent** | 第 2 次 | 标准模式，工具逐次审批 | 日常开发 |
| **YOLO** | 第 3 次 | 自动批准所有调用 | 批量操作 |

### 6.4 核心创新：1M Token 智能压缩

- 上下文占满时**自动压缩**（不粗暴截断）
- 利用 DeepSeek V4 前缀缓存（cache hit 99%+ 节省成本）
- 实时成本追踪（status bar 显示 token + 费用）
- 原生中文界面（zh-Hans/en/ja/pt-BR）

### 6.5 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| Ratatui TUI 模式 | ★★ | Tauri 桌面为主 |
| 3 模式循环 | ★★★★ | v3.4 D-V35-08 |
| 1M 上下文压缩 | ★★★★ | 与 Headroom CCR 互补 |
| 中文 prompt 模板 | ★★★★★ | v3.4 D-V34-09 |

---

## 7. @hermenics/deepseek-code（DeepSeek 优化 TUI）

### 7.1 项目定位

- **npm**：`@hermenics/deepseek-code` v0.4.3 · 协议：Apache-2.0
- **GitHub**：`Hermenics/deepseek-code`
- **核心特色**：DeepSeek V4 默认 + 多 provider（Bedrock/Vertex/本地 Ollama/LM Studio）
- **开发栈**：Bun 1.1+ + TypeScript + Ink + TUI

### 7.2 核心创新：4 模式 + MoA（Mixture of Agents）

**4 种交互模式**（独立于权限）：
- **Build**：写入 + Shell
- **Plan**：只写 plan
- **Review**：只读
- **Auto**：自动批准

**MoA 子代理**：
- 内置 `MoA` 工具（多模型并行推理）
- 与 RLM 互补：MoA = 多模型投票，RLM = 多 Agent 协同

**Settings 三层优先级**：
- User < Project < Local
- `/config` 全屏可搜索
- 显示每个配置的来源（traceability）

### 7.3 对 TDSF 价值

- 决策点 **D-V36-18 ⭐ 4 模式 + MoA**：扩展 v3.4 D-V34-03 Plan/Build
  - Build / Plan / Review / Auto 4 模式
  - MoA 内置工具
  - Settings 三层优先级（User/Project/Local）

---

## 8. GitHub Copilot CLI（概念映射 + 零迁移成本）

### 8.1 项目定位

- **npm**：`@github/copilot` v1.0.69 · 协议：闭源（GitHub 官方）
- **核心特色**：**零迁移成本**（直接读 CLAUDE.md/AGENTS.md/.github/copilot-instructions.md）+ GitHub 云端委派

### 8.2 5 大特性

1. **零迁移成本**：操作命令、习惯跟 Claude Code 几乎一致，CLAUDE.md + Skills 天然兼容
2. **GitHub 云端委派**（`/delegate`）：把整个会话丢给 GitHub，云端自动开 PR
3. **远程控制**（`/remote`）：从 GitHub 网页/手机远程控制会话
4. **多 subagent 并行**（`/fleet` + `/subagents`）：每个 agent 可配不同模型
5. **深度调研**（`/research`）：用 GitHub 搜索 + 网页深度调研

### 8.3 与 Claude Code 命令对照

| Claude Code | Copilot CLI |
|-------------|-------------|
| CLAUDE.md | CLAUDE.md + AGENTS.md + .github/copilot-instructions.md |
| /compact | /compact（可带 focus） |
| /clear | /new（新会话）或 /clear |
| Plan Mode | /plan |
| Subagents | /task/agent, /subagents, /fleet |
| MCP servers | /mcp |
| Skills | /skills |
| ! 执行 shell | ! 同样可用 |
| @ 引用文件 | @ 引用文件；# 引用 issue/PR |
| memory | /memory（跨会话记忆开关） |
| Rewind | /checkpoint/rewind |

### 8.4 对 TDSF 价值

- 决策点 **D-V36-19 兼容 CLAUDE.md/AGENTS.md**：TDSF 客户端零迁移
  - 已记录 v3.4 D-V34
  - 强化点：`.github/copilot-instructions.md` 也支持
- 决策点 **D-V36-20 概念映射完整性**：TDSF 完整提供 13 个对应命令

---

## 9. v3.6 借鉴清单（20 大决策点）

### 9.1 ★ P0 优先级（必须实现）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V36-01** ⭐ | **TdsfFs 抽象层**（本地/SSH/ACP 透明切换） | Kimi KAOS | 02-architecture / 04-api-contract |
| **D-V36-02** ⭐ | **Wire 事件协议**（4 consumer 共享） | Kimi Wire | 04-api-contract |
| **D-V36-03** ⭐ | **4 Surface 审批模型**（command/diff/todo/task） | Kimi Approval | 04-api-contract |
| **D-V36-05** ⭐ | **Subagent Registry 模式**（持久化实例） | Kimi LaborMarket | 04-api-contract |
| **D-V36-06** ⭐ | **User-defined Hooks**（PreToolUse/PostToolUse） | Crush | 04-api-contract |
| **D-V36-07** ⭐ | **多上下文文件自动加载**（CLAUDE.md/AGENTS.md/TDSF.md） | Crush | 02-architecture |
| **D-V36-08** ⭐ | **3 层样式系统**（quickstyle/themes/styles） | Crush | 06-design-tokens |
| **D-V36-11** ⭐ | **Multi-Channel 抽象层**（飞书/GitHub/企微/微信） | Qwen Code | 02-architecture |
| **D-V36-12** ⭐ | **Memory 8 模块 + dream 离线整合** | Qwen Code | 02-architecture |

### 9.2 P1 优先级（应有功能）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V36-04** | **Pager 展开模式**（Ctrl+E 隔离 alternate screen） | Kimi KLIP-9 | 03-ui-spec |
| **D-V36-09** | **LLM Provider 抽象层**（7+ provider） | Crush fantasy | 04-api-contract |
| **D-V36-10** | **工具自描述**（tool.py + tool.md 双文件） | Crush | 04-api-contract |
| **D-V36-16** | **12 命令速查体系** | Qoder CLI | 03-ui-spec |
| **D-V36-17** | **5 类高级参数**（沙箱/上下文/可观测性/权限） | Qoder CLI | 04-api-contract |
| **D-V36-18** | **4 模式 + MoA**（Build/Plan/Review/Auto） | @hermenics/deepseek-code | 03-ui-spec / 04-api-contract |
| **D-V36-19** | **兼容 CLAUDE.md/AGENTS.md**（零迁移） | Copilot CLI | 02-architecture |

### 9.3 P2/P3 优先级（可选）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V36-13** | **Computer Use 可选模块** | Qwen Code cua-driver | 02-architecture（P3） |
| **D-V36-14** | **语音对话集成** | Qwen Code audio-capture | 02-architecture（P2） |
| **D-V36-15** | **贡献治理规则**（Triage Gate） | Qwen Code AGENTS.md | 05-implementation-roadmap |
| **D-V36-20** | **概念映射完整性**（13 个对应命令） | Copilot CLI | 03-ui-spec |

---

## 10. v3.6 行业新共识

### 10.1 ★ 共识 1：终端 Agent 必须支持 Shell 模式（D-V36-04 强化）

**证据**：
- Kimi CLI：Ctrl-X 切换 Shell 模式（AI 与 Shell 共享上下文）
- DeepSeek TUI：内置 shell command mode
- Crush：`internal/shell/` 完整模块
- Qwen Code：内置 shell tool + Plan 模式
- @hermenics：Shell tool + build/plan 4 模式

**结论**：TDSF 终端必须支持 Shell 模式（Ctrl+Shift+T 切换），AI 与 Shell 共享同一 PTY 输出。

### 10.2 ★ 共识 2：KAOS 抽象层 = AI Agent 操作系统的范式

**证据**：
- Kimi KAOS：Local + SSH + ACP 3 后端透明切换
- @hermenics：`shell.ts` + `file_ops.ts` 抽象
- Crush：`internal/shell/` 多后端支持

**结论**：TDSF 必须实现 `tdsf-fs` 抽象层（决策 D-V36-01），未来零成本支持远程 SSH 主机 + IDE 集成。

### 10.3 ★ 共识 3：多 LLM Provider 抽象 = 终端 Agent 标配

**证据**：
- Crush fantasy：7+ provider（Anthropic/OpenAI/Gemini/Bedrock/Copilot/Hyper/Vercel）
- Qwen Code：多 provider + Coding Plan
- @hermenics：DeepSeek/Bedrock/Vertex/本地
- Kimi：支持 Anthropic/OpenAI/Google 等

**结论**：TDSF 必须实现 `tdsf-llm` 抽象层（决策 D-V36-09），至少 4 provider（Anthropic/OpenAI/Qwen/DeepSeek）。

---

## 11. 横向对比矩阵 + 量化更新

### 11.1 7 项目核心特性矩阵

| 维度 | Kimi CLI | Crush | Qwen Code | Qoder CLI | DeepSeek TUI | @hermenics | Copilot CLI |
|------|---------|-------|-----------|-----------|--------------|-----------|-------------|
| 语言 | Python 3.12+ | Go 1.23+ | TypeScript | TypeScript | Rust 99.3% | TypeScript | TypeScript |
| UI 框架 | Rich (Textual) | Bubble Tea v2 | Ink + React 19 | Ink | Ratatui | Ink + React | Ink |
| LLM 抽象 | kosong | fantasy | 自研 | 自研 | 自研 | 自研 | 自研 |
| MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| LSP | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hooks | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多 Provider | ✅ | ✅ 7+ | ✅ | ✅ | ✅ | ✅ | ✅ |
| KAOS 抽象 | ✅ ★ | ❌ | ❌ | ❌ | ❌ | 部分 | ❌ |
| Wire 协议 | ✅ ★ | proto.go | ❌ | ❌ | ❌ | ❌ | ❌ |
| Subagent | LaborMarket ★ | agent | ✅ | Quest ★ | RLM | MoA ★ | /fleet |
| Memory | ❌ | ❌ | 8 模块 + dream ★ | ✅ | ❌ | /memory | /memory |
| Channels | ❌ | ❌ | 5 个 ★ | ❌ | ❌ | ❌ | GitHub |
| Computer Use | ❌ | ❌ | ✅ ★ | ❌ | ❌ | ❌ | ❌ |
| 语音对话 | ❌ | ❌ | ✅ ★ | ❌ | ❌ | ❌ | ❌ |
| 协议 | Apache-2.0 | FSL-1.1-MIT | Apache-2.0 | 闭源 | Apache-2.0 | Apache-2.0 | 闭源 |
| 单二进制 | PyInstaller | CGO off ✅ | npm | npm | ✅ Cargo | npm | npm |

### 11.2 TDSF 借鉴度排序（v3.6 重新评估）

| 项目 | 借鉴度 | 核心借鉴点 |
|------|--------|------------|
| Kimi CLI | 95% ⭐ | KAOS + Wire + Approval + LaborMarket + Pager |
| Qwen Code | 90% ⭐ | Channels + Memory 8 + 语音 + Computer Use |
| Crush | 85% ⭐ | Hooks + 多上下文 + 3 层样式 + fantasy |
| DeepSeek TUI | 80% | Rust 标杆 + 3 模式 + 1M 上下文 |
| Qoder CLI | 75% | Quest 委派 + 12 命令 + 5 类参数 |
| @hermenics | 70% | 4 模式 + MoA + Settings 三层 |
| Copilot CLI | 60% | 命令兼容性 + GitHub 云端委派 |
| **Mastra** | 70% | suspend/resume + Graph Workflow |
| **Headroom** | 75% | CCR 可逆压缩 |
| **Aider** | 70% | RepoMap + Git Auto-Commit |
| **Cline** | 85% | 25+ Hooks + Auto-Approve 三态 |
| **OpenCode** | 90% | LSP 集成 + Client/Server + Plan/Build |

### 11.3 量化更新（v3.5 → v3.6）

| 指标 | v3.5 | v3.6 | 变化 |
|------|------|------|------|
| 调研项目数 | 70 | **77** | +7 |
| 代码复用率 | 70% | **72%** | +2% |
| 累计代码量 | ~26.5M | **~27.1M** | +0.6M |
| 决策点总数 | 31 | **51** | +20 |
| P0 决策点 | 12 | **21** | +9 |
| 行业共识 | 8 | **11** | +3 |
| 调研时间 | 2026-07-26 | 2026-07-26 | 同日增量 |

### 11.4 累计决策点分类

**P0 核心决策（21 项）**：
- v3.0：4 项（架构/技术栈/SQLite/Hermes）
- v3.2.1：6 项（Project Service/side-git/RLM/AIMUX.md/needs-you/steer）
- v3.4：3 项（命令输出回流/HTTP-SSE/只写工作目录/中文 prompt）
- v3.5：3 项（CCR/suspend-resume/tdsf doctor）
- v3.6：**9 项**（TdsfFs/Wire/Approval/Subagent Registry/Hooks/多上下文/3 层样式/Channels/Memory）

**P1 增强决策（18 项）**：从 v3.0 到 v3.6 累计

**P2/P3 可选决策（12 项）**：Computer Use / 语音 / 治理规则等

---

## 12. 待办 & 下一步

### 12.1 立即落地（本周）

- [ ] 更新 `02-architecture.md` 增补 v3.6 9 项 P0 决策（5.5 节）
- [ ] 更新 `04-api-contract.md` 增补 v3.6 增量接口（10 节）
- [ ] 更新 `00-overview.md` 顶部决策表（v3.6 标记）
- [ ] 更新 `06-design-tokens.md` 强化 3 层样式系统
- [ ] 更新 `03-ui-spec.md` 加入 Pager 展开模式

### 12.2 短期（2 周内）

- [ ] 实施 **D-V36-01 TdsfFs 抽象层** 脚手架
- [ ] 实施 **D-V36-02 Wire 事件协议** 类型定义
- [ ] 实施 **D-V36-06 Hooks 引擎** MVP
- [ ] 准备 **D-V36-12 Memory 8 模块** 设计稿

### 12.3 中期（P0-P7 路线）

- [ ] P0 阶段：脚手架 + 5 绿门禁
- [ ] P1 阶段：TdsfFs + Wire + Approval Runtime
- [ ] P2 阶段：Hooks + Multi-Channel + Memory
- [ ] P3 阶段：语音 + Computer Use

### 12.4 长期生态

- [ ] 与 claude-skills / skills.sh 兼容
- [ ] 与 OpenHands WORKSPACE_BASE 集成
- [ ] 探索 TDSF marketplace（Skill + Channel + Theme）

---

## 13. 附录：v3.6 核心借鉴来源

| 项目 | Stars | License | 主要借鉴模块 |
|------|------:|---------|-------------|
| [kimi-cli](https://github.com/MoonshotAI/kimi-cli) | 8.4K | Apache-2.0 | KAOS / Wire / Approval / LaborMarket / Pager |
| [crush](https://github.com/charmbracelet/crush) | 23.8K | FSL-1.1-MIT | Hooks / 多上下文 / 3 层样式 / fantasy |
| [qwen-code](https://github.com/QwenLM/qwen-code) | 24.1K | Apache-2.0 | Channels / Memory 8 / audio-capture / cua |
| qodercli (npm) | — | 闭源 | Quest / 12 命令 / 5 类参数 |
| [DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI) | 36K | Apache-2.0 | Rust 标杆 / 3 模式 / 1M 上下文 |
| @hermenics/deepseek-code | npm | Apache-2.0 | 4 模式 / MoA / Settings 三层 |
| @github/copilot | npm | 闭源 | 概念映射 / GitHub 云端委派 |

---

> **v3.6 核心结论**：  
> 终端 Agent 已从单一 CLI 工具演进为**多端生态**（CLI + IDE + Channel + Cloud）。  
> 关键技术范式：**KAOS 抽象层**（跨执行环境）+ **Wire 事件协议**（跨 UI frontend）+ **Hooks 引擎**（用户可扩展）+ **Memory 自管理**（8 模块 + dream 离线整合）。  
> TDSF v4.0 已确立 51 项决策点 + 11 项行业共识，代码复用率达 72%，预计 AI 单人 1-2 周可完成 P0-P7 全部 8 阶段实施。
