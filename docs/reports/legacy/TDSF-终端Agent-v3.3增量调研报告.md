# TDSF Terminal Agent — v3.3 增量调研报告
> 调研时间：2026-07-26  
> 调研人：Claude (MiniMax-M3)  
> 上游版本：v3.2.1（2026-07-26）  
> 核心增量：在 v3.2.1 调研 8 个项目基础上，新增 **5 个深度调研项目**，并提炼对 TDSF 的具体借鉴清单

---

## 0. 阅读导览

| 章节 | 内容 | 优先级 |
|------|------|--------|
| §1 | 调研背景与目标 | ⭐ |
| §2 | **Kimi Code CLI**（已 clone `kimi-cli/`）深度分析 | ⭐⭐⭐ |
| §3 | **Qoder CLI**（qodercli / 阿里云）深度分析 | ⭐⭐⭐ |
| §4 | **Codex CLI**（openai/codex）深度分析 | ⭐⭐⭐ |
| §5 | **Headroom**（可逆上下文压缩层）深度分析 | ⭐⭐ |
| §6 | **Kilo Code** + **Claw Code** 速览 | ⭐⭐ |
| §7 | v3.2.1 → v3.3 横向对比矩阵 | ⭐⭐⭐ |
| §8 | **TDSF 借鉴清单**（9 大决策点） | ⭐⭐⭐ |
| §9 | 实施优先级与下一步 | ⭐ |

> 📌 **建议阅读顺序**：§1 → §2 → §3 → §4 → §8 → §9  
> 如果你赶时间，**直接看 §8 借鉴清单**和 §9 实施优先级。

---

## 1. 调研背景与目标

### 1.1 为什么继续调研 v3.3

v3.2.1 阶段（2026-07-26）已完成 8 个项目的初步分析（opensquilla、Maple-font、Orca、Synara、Termio、cmux、BitFun、Vibo），但**未深入到源码层**。v3.3 阶段：

1. **设计稿未到**（Trae Design 还在排期）— 利用窗口期做更深的源码级调研
2. **用户明确要求**（2026-07-26）："在设计稿来之前，你也去调研一下其它 agent，例如 kimicode，qodercil"
3. **关键项目已 clone**：kimi-cli、kilo-code、claw-code、headroom 全部在 `opensource-reference/`
4. **行业 6 月 7 月密集涌现新项目**：Codex CLI v0.135、Qoder CLI 0.18、Claude Code SDK 0.x 等

### 1.2 调研目标

| 目标 | 描述 |
|------|------|
| **架构层** | 提炼主流终端 Agent 的核心架构（Soul / Runtime / Wire / Tools） |
| **协议层** | 分析 Kimi Wire / Codex MCP / Headroom CCR 协议设计 |
| **安全层** | 总结 Codex 三档沙箱、Kimi Approval 系统、Qoder Worktree 隔离 |
| **性能层** | 分析 Headroom 可逆压缩、Codex OAuth 设备码、Kimi 32K AGENTS.md 预算 |
| **复用层** | 给出 TDSF 9 大决策点（P0 必复用 / P1 推荐复用 / P2 可选） |

---

## 2. Kimi Code CLI 深度分析（⭐⭐⭐ 必读）

> 项目位置：`opensource-reference/kimi-cli/`  
> GitHub：MoonshotAI/kimi-cli（10.8K stars / 2026-07-16 最后提交）  
> 协议：MIT（推断，待核实）  
> 调研时间：2026-07-26

### 2.1 项目定位

Kimi Code CLI 是**月之暗面（Moonshot AI）**开源的终端 AI 编程 agent，被官方定位为"下一代智能体的起点"。其核心特征：

- **多模式前端**：TUI 交互模式 / Print 非交互模式 / ACP server 模式（IDE 集成） / Wire 模式
- **插件化架构**：通过 Agent Skills、Hooks、Sub-agents、MCP 协议扩展能力
- **底层依赖两个核心包**：
  - `kosong` — LLM 抽象层（统一消息结构、异步工具编排、可插拔聊天提供商）
  - `kaos` (PyKAOS) — 文件系统抽象层（本地 + SSH 远程统一接口）

### 2.2 关键技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| 语言 | Python 3.12+ | 工具配置 3.14 |
| CLI 框架 | Typer | 比 Click 更现代 |
| 异步运行时 | asyncio | 标准库 |
| LLM 框架 | kosong | Moonshot 自研 |
| MCP 集成 | fastmcp | 标准 MCP |
| 日志 | loguru | 比 logging 更友好 |
| 包管理 | uv + uv_build | 现代 Python 包管理 |
| 二进制分发 | PyInstaller | 跨平台单文件 |
| 测试 | pytest + pytest-asyncio | 行业标准 |
| Lint/Format | ruff | 比 flake8+black 更快 |
| 类型 | pyright + ty | 双类型检查器 |

### 2.3 核心架构（5 层）

```
┌─────────────────────────────────────────────────────┐
│  UI Layer (ui/)                                      │
│  shell/  print/  acp/  wire/                        │  ← 4 种前端
├─────────────────────────────────────────────────────┤
│  Soul Layer (soul/)                                  │
│  KimiSoul → 工具调用循环                              │  ← 核心循环
│  ├── Context (对话历史)                               │
│  ├── Compaction (上下文压缩)                          │
│  ├── Approval (权限审批)                              │
│  ├── DynamicInjection (动态注入)                     │
│  ├── Toolset (KimiToolset / MCP)                     │
│  └── Slash Commands                                  │
├─────────────────────────────────────────────────────┤
│  Wire Layer (wire/)                                  │
│  RootWireHub → 事件流（异步）                         │  ← UI-Soul 解耦
│  Event Types: TurnBegin/StepBegin/ToolResult/...     │
├─────────────────────────────────────────────────────┤
│  Tools Layer (tools/)                                │
│  Built-in: agent / ask_user / background / dmail /   │
│   file / plan / shell / think / todo / web            │
│  MCP: 动态加载                                        │
├─────────────────────────────────────────────────────┤
│  Runtime Layer (soul/agent.py)                        │
│  Runtime → Config + Session + Builtins + OAuth      │  ← 单例运行时
│  Agent → System Prompt + Toolset                     │
│  LaborMarket → Subagent 类型注册表                     │
└─────────────────────────────────────────────────────┘
```

**借鉴价值**：**Wire 事件层**的设计非常优秀，Soul 与 UI 完全解耦，UI 可以是 TUI / Web / IDE 而不改动核心循环。**TDSF 应该采用同样的 Wire 模式**。

### 2.4 核心工具集（11 类）

| 工具 | 职责 | TDSF 借鉴 |
|------|------|-----------|
| `Agent` | subagent 调度（支持 resume） | ✅ P0 必复用 |
| `AskUserQuestion` | 询问用户偏好（多选项） | ✅ P0 必复用 |
| `Background` | 后台任务（list/output/stop） | ✅ P1 推荐 |
| `DMail` | 异步消息（checkpointed replies） | ⚪ P2 暂不 |
| `File` (read/write/replace/glob/grep) | 文件操作 | ✅ P0（已有 RiskEngine） |
| `Plan` | 计划模式（enter/plan file） | ✅ P1 推荐 |
| `Shell` (bash) | Shell 执行 | ✅ P0 必复用 |
| `Think` | 思考块（reasoning） | ⚪ P2 |
| `Todo` | 待办列表 | ✅ P1 推荐 |
| `Web` (fetch/search) | 网页获取 | ✅ P0 必复用 |
| `Plan` (heroes) | 计划管理 | ✅ P1 |

**WriteFile 工具的关键设计**（TDSF 直接借鉴）：
```python
# 文件路径验证
1. canonical() 解析符号链接
2. is_within_workspace() 检查工作区
3. inspect_plan_edit_target() 检查 plan 模式
4. parent.exists() 检查父目录
5. approval.request() 请求审批
6. write_text() / append_text() 实际写入
7. build_diff_blocks() 返回 diff 给 UI 显示
```

**Shell 工具的关键设计**：
- 每次执行都是**全新 shell 环境**（不保留 cd / export / history）
- 区分**前台**和**后台**（`run_in_background=true`）
- **timeout 参数**防止永久运行
- **拒绝 sudo**（除非用户显式允许）
- 推荐**链式执行**：`cd /path && ls`

### 2.5 上下文压缩（Compaction）核心算法

`SimpleCompaction` 是 TDSF 必须借鉴的实现：

```python
class SimpleCompaction:
    def __init__(self, max_preserved_messages: int = 2):
        self.max_preserved_messages = max_preserved_messages  # 保留最近 2 条

    async def compact(self, messages, llm, *, custom_instruction=""):
        # 1. 拆分：要压缩的历史 + 要保留的尾部
        # 2. 调用 LLM 生成摘要（COMPACTION_SYSTEM_PROMPT）
        # 3. 拼装：[摘要消息] + [保留的消息]
        # 4. 标记前缀 "Previous context has been compacted..."
```

**关键参数**（`should_auto_compact`）：
- 触发条件 A（比率）：`token_count >= max_context_size * trigger_ratio`
- 触发条件 B（绝对值）：`token + reserved >= max_context_size`
- Token 估算：4 字符 / token（英文）；对 CJK 略偏低估（暂时方案，下次 LLM 调用纠正）

**TDSF 借鉴**：v3.2.1 中规划了"32K 硬上限压缩"，v3.3 应**直接采用 Kimi 的 SimpleCompaction + custom_instruction**，无需自研。

### 2.6 Approval 权限系统（4 档 + 3 模式融合）

**核心类**：
- `Approval`（soul/approval.py）— 工具面向的 facade
- `ApprovalState` — 状态对象（yolo / afk / runtime_afk / auto_approve_actions）
- `ApprovalRuntime`（approval_runtime/）— session 级**待审批队列源**
- `ApprovalResult` — 审批结果（approve / approve_for_session / reject）

**核心设计点**：
1. **Yolo 模式** — 显式 `--yolo` 跳过所有审批（**仅用于可信目录**）
2. **AFK 模式** — 离开状态（持久化 + 运行时），自动 approve
3. **Surface 类型**（4 种）：
   - `command` — Shell 命令
   - `diff` — 文件编辑
   - `todo_list` — 待办更新
   - `task` — 后台任务
   - `generic` — 默认
4. **Telemetry 集成** — `permission_approval_result` 事件，结构化记录（policy_name / tool_name / result / duration_ms / has_feedback / trace_id）
5. **Session Cache** — `session_cache_written` 标记，避免重复审批
6. **Subagent 适配** — 子代理被拒时收到明确提示："Try a different approach...Do not retry the same tool call, and do not attempt to bypass this restriction through indirect means."

**TDSF 借鉴**（4 档权限融合）：
- L0 免确认（读操作 / 已审批命令）— 对应 Kimi 的 auto_approve_actions
- L1 仅高危（写文件 / Shell）— 对应 Kimi 的 surface-based approval
- L2 写操作 — 每次审批
- L3 全部（含 sudo / 远程）— 强审批 + 二次确认

### 2.7 Wire 事件协议

**事件类型**（`wire/types.py`）：
- `TurnBegin(user_input)` / `TurnEnd()` — 完整回合
- `StepBegin(n)` / `StepInterrupted()` / `StepRetry()` — 单步
- `TextPart(text)` / `ToolResult(name, result, display)` — 内容
- `CompactionBegin()` / `CompactionEnd()` — 压缩事件
- `MCPLoadingBegin()` / `MCPLoadingEnd()` — MCP 加载
- `StatusUpdate(snapshot)` — 状态快照
- `SteerInput(input)` — 中途转向

**传输**：
- 默认：内存 EventBus
- ACP server：stdio JSON-RPC
- Web UI：SSE / WebSocket

**TDSF 借鉴**（v3.3 新增）：将 5 状态 mood ring（v3.2.1）扩展到完整 **StatusUpdate 协议**：
- status: 'idle' | 'thinking' | 'stream' | 'working' | 'done' | 'error' | 'waiting'
- progress?: number（0-1）
- current_tool?: string
- approval_required?: ApprovalRequest

### 2.8 PyKAOS 文件系统抽象（核心创新）

`kaos` 库是 Kimi 的**杀手锏**，让本地 / 远程操作透明：

```python
# 本地
from kaos import local_kaos
await local_kaos.readtext("/etc/hosts")

# SSH 远程（接口完全相同）
from kaos.ssh import SSHKaos
ssh = await SSHKaos.create(host="server.com", username="admin", key_paths=["~/.ssh/id_rsa"])
await ssh.readtext("/etc/hosts")

# 路径抽象
from kaos.path import KaosPath
p = KaosPath("/var/log/app.log")
async for line in p.read_lines():
    print(line)
```

**核心抽象**（`Kaos` Protocol）：
- `pathclass() → type[PurePath]`
- `getcwd() / gethome() / chdir()`
- `stat() / iterdir() / glob()`
- `readbytes() / readtext() / readlines() / writebytes() / writetext()`
- `mkdir() / exec()`（exec 启动进程，返回 `KaosProcess`）

**TDSF 借鉴**（P0 必复用）：TDSF 已有 `SftpManager` + `LocalExecutor`，但接口不统一。**v3.3 引入 PyKAOS 风格的 `TdsfFs` 抽象层**：
- 本地后端：`LocalTdsfFs`（基于 `aiofiles` + `asyncio.subprocess`）
- 远程后端：`SshTdsfFs`（基于 `asyncssh` 或我们已有的 SSH 客户端）
- 工具代码只依赖 `TdsfFs` 接口，不关心后端

### 2.9 AGENTS.md 自动发现 + 32K 预算

Kimi 的 AGENTS.md 加载是**业内最佳实践**：

```python
_AGENTS_MD_MAX_BYTES = 32 * 1024  # 32 KiB
```

**加载顺序**（优先级从高到低）：
1. `.kimi/AGENTS.md`（项目本地 kimi 配置）
2. `AGENTS.md`（标准）
3. `agents.md`（小写变体，与 2 互斥，大写优先）

**预算分配**：**leaf-first 分配**（深目录优先），保证具体性

**TDSF 借鉴**（P0 必复用）：TDSF 已有 `knowledge/` 目录的 Markdown 文件，但缺少自动聚合机制。v3.3 应**实现 AGENTS.md 自动发现**：
- 全局：`~/TDSF.md`（v3.2.1 DEC-V321-06 已规划）
- 项目：`<project>/.tdsf/AGENTS.md` 或 `<project>/TDSF.md`
- 预算：32 KiB（与 Kimi 一致）

### 2.10 Subagent 调度（LaborMarket）

- `LaborMarket` 注册 builtin subagent 类型
- `SubagentStore` 持久化实例元数据、提示词、wire logs、context
- 位置：`session/subagents/<agent_id>/`
- 支持 `agent_id` 恢复

**TDSF 借鉴**：TDSF v3.2.1 DEC-V321-03 已规划 "1-16 flash 子任务并行"，v3.3 落地**直接采用 Kimi 的 LaborMarket + SubagentStore 模式**。

### 2.11 Kimi CLI 对 TDSF 的完整借鉴清单

| 决策点 | TDSF v3.2.1 | Kimi 做法 | v3.3 建议 |
|--------|------------|-----------|-----------|
| 前端 | TUI / Web / IDE | TUI / Print / ACP / Wire | ✅ **采用 Wire 协议**（同 Kimi） |
| 上下文压缩 | 32K 硬上限 | SimpleCompaction + custom_instruction | ✅ **直接复用** |
| 权限系统 | 4 档 + 3 模式 | Yolo / AFK / surface-based | ✅ **融合 Kimi 的 AFK + surface** |
| 文件系统 | SftpManager + LocalExecutor | PyKAOS 抽象 | ✅ **引入 TdsfFs Protocol** |
| AGENTS.md | 无 | 自动发现 + 32K 预算 | ✅ **必复用** |
| 工具集 | 已有 | 11 类工具 | ✅ **必复用 Agent/Shell/File/Web** |
| Subagent | RLM 1-16 flash | LaborMarket | ✅ **直接采用** |
| 后台任务 | /task 命令 | Background 工具 | ✅ **采用** |
| 状态协议 | 5 状态 mood ring | StatusUpdate | ✅ **扩展为 7 状态 StatusUpdate** |
| Slash 命令 | 已有 | soul + ui 两层 | ✅ **参考 soul + ui 分层** |

---

## 3. Qoder CLI 深度分析（⭐⭐⭐ 必读）

> 项目位置：未在 `opensource-reference/` 单独 clone（仅有 npm 包）  
> npm：`@qoder-ai/qodercli` v1.1.3（2026-07-26 发布）  
> GitHub：nicepkg/qodercli  
> 调研时间：2026-07-26（基于 WebSearch + 官方文档）

### 3.1 项目定位

Qoder CLI 是**阿里云**出品的 Agentic 编码平台 CLI（**前身是通义灵码 Lingma，2026-05-20 升级**）。产品矩阵：

| 产品形态 | 平台 |
|---------|------|
| Qoder IDE | 独立桌面 IDE |
| **Qoder CLI** | 终端原生（`qodercli`） |
| Qoder JetBrains 插件 | IntelliJ 生态 |
| Qoder VS Code 插件 | VSCode |
| QoderWork CN | 桌面 AI 工作助手 |
| Qoder Cloud Agents | 全托管云端 Agent 平台 |
| QoderWake CN | 数字员工（7×24 自主） |

**底层模型**：GLM / DeepSeek / Kimi / Qwen 等**国内主流大模型**（全链路国内云，符合数据安全合规）。

### 3.2 核心特性（与 TDSF 强相关）

| 特性 | 描述 | TDSF 借鉴 |
|------|------|-----------|
| **Quest 模式** | Agent 自主拆解复杂任务，生成技术方案并执行 | ✅ P1 推荐 |
| **Worktree 模式** | 并行会话需 Git 仓库，`qodercli --worktree feature-a` | ✅ P1（与 v3.2.1 side-git 对齐） |
| **TUI 3 模式** | `>` 对话 / `!` Bash / `/` 斜杠命令 / `\` 多行 | ✅ P0 必复用 |
| **Print 模式** | `qodercli -q -p "hi"`，非交互，适合 CI/CD | ✅ P1 |
| **Skills 系统** | `~/.qoder/skills/bailian-cli/` 注册 Skill，对话调用 | ✅ P0 必复用（与 Kimi SKILL.md 一致） |
| **MCP 协议** | `--mcp-config` JSON 文件 / inline JSON | ✅ P0 必复用 |
| **插件市场** | 扩展 Skills / Plugins | ✅ P1 |
| **远程控制** | 手机 / Web 远程管理 CLI 会话 | ⚪ P2 暂不 |
| **多会话 Tab** | Alt+T / Option+T 新建标签 | ✅ P1（与 cmux 对齐） |
| **网络诊断** | Settings 中内置 Network Diagnostics 面板 | ✅ P1 |
| **Mermaid 渲染** | 对话回复中稳定渲染 Mermaid 图表 | ✅ P1 |
| **任务自动继续** | 倒计时自动继续（需点击 Continue 的任务） | ✅ P1 |

### 3.3 命令系统

**内置命令**（TUI 类型不可自定义，Prompt 类型可自定义）：

| 命令 | 类型 | 用途 |
|------|------|------|
| `/agents` | TUI | Subagent 清单管理 |
| `/tasks` | TUI | 后台任务管理 |
| `/workflows` | TUI | 动态工作流任务面板 |
| `/clear` | TUI | 清除当前对话 |
| `/commands` | TUI | 自定义命令管理 |
| `/compact` | Prompt | 压缩对话历史 |
| `/config` | TUI | 配置管理 |
| `/init` | TUI | 初始化项目，生成 AGENTS.md |
| `/login` | TUI | 登录 |
| `/mcp` | TUI | MCP 服务管理 |
| `/memory` | TUI | 记忆概览（自动记忆 / 主题文件） |
| `/model` | TUI | 模型选择 |
| `/effort` | TUI | 模型思考深度 |
| `/context-window` | TUI | 上下文窗口大小 |

### 3.4 启动选项

| 选项 | 说明 |
|------|------|
| `-w <dir>` | 指定工作区 |
| `-c` | 继续上次会话 |
| `-r <id>` | 恢复指定会话 |
| `--allowed-tools=Read,Write` | 仅允许指定工具 |
| `--disallowed-tools=Write,Edit` | 禁止指定工具 |
| `--max-turns=10` | 最大对话轮数 |
| `--yolo` | 跳过权限检查 |
| `--print` / `-p` | 非交互 |
| `--output-format=json` | 输出 text/json/stream-json |
| `--worktree <name>` | Worktree 模式 |

### 3.5 认证机制

| 方式 | 说明 |
|------|------|
| `/login` (推荐) | TUI 交互式，浏览器 OAuth |
| `QODER_PERSONAL_ACCESS_TOKEN` | 环境变量（CI/CD） |
| `NO_BROWSER=1` | 禁止自动打开浏览器 |

后台**每 30 分钟自动刷新 token**。

### 3.6 权限系统（4 档 + Yolo）

- `--permission-mode` 环境变量
- **Permission Mode 三态**：`untrusted` / `on-request` / `never`
- **环境变量**：`QODER_PERMISSION_MODE`

**TDSF 借鉴**：Qoder 的环境变量配置（`QODER_MODEL`、`QODER_MCP_CONFIG`、`QODER_WORKING_DIR`、`QODER_SESSION_ID`、`QODER_SESSION_NAME`、`QODER_PERMISSION_MODE`）是**最佳实践**。TDSF v3.3 应统一为 `TDSF_*` 前缀。

### 3.7 Qoder 对 TDSF 的完整借鉴清单

| 决策点 | v3.2.1 | Qoder 做法 | v3.3 建议 |
|--------|--------|----------|-----------|
| 国内模型 | 已支持 GLM/DeepSeek | GLM/DeepSeek/Kimi/Qwen | ✅ **优先 Qwen + Kimi K2** |
| Worktree 模式 | side-git | git worktree | ✅ **保留 side-git 作为补充** |
| TUI 三模式 | 无 | `>` / `!` / `/` | ✅ **必复用（与 Kimi 共识）** |
| Print 模式 | 无 | `-p` / `--print` | ✅ **必复用** |
| Skills | SKILL.md 草案 | `~/.qoder/skills/<name>/` | ✅ **路径对齐** |
| MCP | 已支持 | `--mcp-config` | ✅ **保持** |
| 多会话 Tab | 无 | Alt+T | ✅ **P1（cmux 对齐）** |
| 网络诊断 | 无 | Settings 面板 | ✅ **P1** |
| Mermaid | 无 | 对话渲染 | ✅ **P1** |
| 任务自动继续 | 无 | 倒计时 | ✅ **P1（与 Fix-loop 协同）** |
| 认证 | OAuth + 环境变量 | OAuth + PAT + 自动刷新 | ✅ **自动刷新 token** |
| Permission Mode | 4 档 | 3 态 | ✅ **融合为 4 档 × 3 态 = 12 组合** |
| 环境变量 | 无 | `QODER_*` 前缀 | ✅ **统一 `TDSF_*` 前缀** |

---

## 4. Codex CLI 深度分析（⭐⭐⭐ 必读）

> GitHub：openai/codex（**87,300+ stars** / 805 个版本 / 2026-05-28 v0.135.0）  
> 调研时间：2026-07-26（基于 WebSearch + Docker 集成文档）

### 4.1 项目定位

Codex CLI 是**OpenAI** 推出的本地 AI 编程代理，**以 Rust 编写**。两种本地入口：
- `codex` — 终端 TUI 模式
- `codex app` — 桌面图形界面（GUI 专属：并行 Worktrees、可视化 Review UI、内置浏览器、Computer Use）

**核心能力**：
- 本地执行 + 安全沙盒
- 多模态支持（截图 / 技术图表）
- 长程推理 + 自主多步任务（GPT-5.2-Codex / OpenAI o4-mini）
- 与 GitHub 深度集成

### 4.2 三档沙箱策略（**核心安全设计**）

| 模式 | 参数值 | 行为 |
|------|--------|------|
| **工作区写入**（默认） | `workspace-write` | 可读写工作目录，出界操作需人工确认 |
| **只读** | `read-only` | 仅浏览文件，不做任何变更 |
| **完全访问** | `danger-full-access` | 跨目录和网络操作，无需确认（仅限隔离环境） |

**批准模式**（`--ask-for-approval` 或 `-a`）：
- `untrusted` — 所有命令执行前询问
- `on-request` — 仅在不确定时询问
- `never` — 从不询问（等同 `--yolo`）

**TDSF 借鉴**（P0 必复用）：Codex 的三档沙箱 + 三态批准的**乘积组合**（9 种）= **业内最佳实践**。TDSF v3.3 应直接采用。

### 4.3 TUI 模式快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+L | 清屏（保留对话历史） |
| Ctrl+O | 复制最新输出到剪贴板 |
| Ctrl+R | 搜索提示词历史 |
| Ctrl+G | 打开外部编辑器（$EDITOR）编辑输入 |
| Tab（运行中） | 将下一轮输入排队（不打断当前任务） |
| Esc×2 | 编辑上一条消息 |
| @ | 模糊文件搜索，快速引用文件路径 |
| !cmd | 直接执行本地 Shell 命令 |

### 4.4 Slash 命令

| 命令 | 功能 |
|------|------|
| `/review` | 代码审查（支持分支对比、未提交变更） |
| `/model` | 切换 AI 模型 |
| `/fork` | 分叉当前会话为新分支 |
| `/permissions` | 切换沙盒权限模式 |
| `/compact` | 压缩会话历史，节省上下文 |
| `/side` | 开启侧边视图 |
| `/diff` | 查看当前会话产生的所有文件变更 |
| `/status` | 查看会话状态 |
| `/keymap` | 重绑 TUI 快捷键 |
| `/debug-config` | 诊断配置加载层级 |

### 4.5 非交互执行（CI / 脚本化）

```bash
# 基础
codex exec "fix all failing tests"

# 多模态（截图分析）
codex exec --image screenshot.png,diagram.png "explain this architecture"

# CI 场景
codex exec --json --output-last-message result.txt --sandbox workspace-write "fix CI failure"

# 从 stdin 读取
echo "fix the bug in main.py" | codex exec -

# 指定模型
codex exec -m gpt-5.5 -c features.web_search=true "research and implement rate limiting"
```

### 4.6 会话恢复与 Fork

```bash
codex resume            # 打开会话选择器
codex resume --last     # 直接继续最近一次会话
codex resume <UUID>     # 精确恢复指定会话
codex fork --last       # Fork 最近会话为新分支（不覆盖原始历史）
```

### 4.7 MCP 工具集成

```bash
codex mcp add myserver -- /path/to/server --arg1
codex mcp add myserver --url https://example.com/mcp
codex mcp list --json
codex mcp remove myserver
```

### 4.8 插件市场（Agent Skills）

```bash
codex plugin marketplace add owner/repo
codex plugin marketplace add owner/repo@v1.0 --sparse plugins/
```

**TDSF 借鉴**：Codex 的 plugin marketplace 与 skills.sh 协议一致，TDSF v3.3 应**直接采用 skills.sh 协议**（v3.2.1 DEC-V321-12 已规划）。

### 4.9 Codex 对 TDSF 的完整借鉴清单

| 决策点 | v3.2.1 | Codex 做法 | v3.3 建议 |
|--------|--------|-----------|-----------|
| 沙箱 | Docker → Firecracker → OS | **3 档沙箱 + 3 态批准** | ✅ **直接采用 9 组合** |
| 快捷键 | 已有 | Ctrl+L/O/R/G/Tab/Esc/@/! | ✅ **必复用** |
| Slash | 已有 | /review/model/fork/permissions/compact | ✅ **必复用** |
| exec 模式 | /print 草案 | `--json --output-last-message` | ✅ **必复用 `--json`** |
| 会话恢复 | 已有 | `codex resume` / `codex fork` | ✅ **保留** |
| 多模态 | 无 | `--image` | ✅ **P1** |
| Code Review | 无 | `/review` | ✅ **P1** |
| Fork 会话 | 无 | `--last` | ✅ **P1** |
| Side 视图 | 浮动面板 | `/side` | ✅ **P0 必复用** |
| 插件市场 | skills.sh 草案 | plugin marketplace | ✅ **对齐 skills.sh** |
| TUI 多模态 | 无 | 截图 / 图表 | ✅ **P1** |

---

## 5. Headroom 深度分析（⭐⭐）

> 项目位置：`opensource-reference/headroom/`（Apache 2.0）  
> GitHub：chopratejas/headroom（PyPI: headroom-ai / npm: headroom-ai / Model: kompress-v2-base）  
> 调研时间：2026-07-26

### 5.1 项目定位

Headroom 是**"AI agent 的上下文压缩层"**，定位独特：

> "Headroom compresses everything your AI agent reads — tool outputs, logs, RAG chunks, files, and conversation history — before it reaches the LLM. Same answers, fraction of the tokens."

**核心数据**（README 声称）：
- JSON 数据：**60-95%** 更少 token
- 编程 Agent：**15-20%** 更少 token

### 5.2 三种使用模式

```bash
# 1. Library（直接调用）
from headroom import compress
result = await compress(messages)

# 2. Proxy（零代码，drop-in）
headroom proxy --port 8787
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# 3. Agent wrap（一行命令包装任何 agent）
headroom wrap claude|codex|grok|copilot|cursor|aider|opencode|cline|continue|goose|openhands|openclaw|vibe|omp|zcode
```

### 5.3 4 大组件

| 组件 | 职责 |
|------|------|
| **CacheAligner** | 稳定前缀，让 provider KV cache 真正命中 |
| **ContentRouter** | 检测内容类型，选择合适压缩器 |
| **CCR** | Compress-Cache-Retrieve 可逆压缩 |
| **SmartCrusher / CodeCompressor / Kompress-v2-base** | 压缩 JSON / AST / 文本 |

### 5.4 CCR 可逆压缩（**核心创新**）

```
┌─────────────────────────────────────────────────────┐
│  TOOL OUTPUT (1000 items, 12K tokens)                │
│  └─ SmartCrusher 压缩到 20 items                     │
│  └─ Original 缓存到 LRU cache（hash=abc123）          │
│  └─ Marker: "[1000 items compressed to 20. hash=abc123]"│
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│  LLM PROCESSING                                     │
│  Option A: LLM 用 20 items 解决任务 → Done (90% 节省) │
│  Option B: LLM 调用 headroom_retrieve(hash=abc123)   │
│            → 1ms 检索完整数据                          │
│            → LLM 准确回答                             │
└─────────────────────────────────────────────────────┘
```

**关键设计**：
- 注入 `headroom_retrieve` 工具到 LLM 的工具列表
- **客户端不可见**（透明处理）
- **Context Tracker**：跨轮次记住压缩内容，主动扩展相关数据

**TDSF 借鉴**（P0 必复用）：TDSF v3.2.1 DEC-V321-08 规划的 7 状态 mood ring 主要是状态可视化，**未涉及内容压缩**。v3.3 应引入 **Headroom 风格的 CCR 压缩**：

| 场景 | 当前行为 | v3.3 改造 |
|------|---------|----------|
| 大文件 grep 输出 5000 行 | 全部塞上下文 | SmartCrusher 压缩到 50 行 + hash 标记 |
| Shell 命令输出 100KB | 全部塞上下文 | 压缩到 1KB + hash |
| 知识库 MD 文件 1MB | 全部塞上下文 | 摘要 + 链接，按需 retrieve |
| 多轮对话 | 全部保留 | 旧轮压缩 + 保留最近 N 轮 |

### 5.5 MCP server（headroom 暴露 3 个工具）

```bash
# 安装
pip install "headroom-ai[mcp]"
headroom mcp install  # 注册到 Claude Code
```

**3 个工具**：
- `headroom_compress(content)` — 按需压缩
- `headroom_retrieve(hash, query?)` — 检索原内容
- `headroom_stats()` — 会话统计

**TDSF 借鉴**：TDSF 已有 MCP 35+ tools，v3.3 应**新增 `tdsf_compress` / `tdsf_retrieve` / `tdsf_stats` 三个 MCP 工具**，让任何 MCP 客户端（包括 Claude Code / Cursor）都能用 TDSF 的压缩能力。

### 5.6 Rust 扩展

Headroom 的核心压缩逻辑有 **Rust 实现**（`crates/headroom-core/`），通过 PyO3 暴露给 Python：

```rust
// crates/headroom-core/src/lib.rs
// 高性能 JSON 压缩 / AST 压缩
```

**TDSF 借鉴**：TDSF v3.2.1 已规划 Tauri 2 + Rust 后端。v3.3 落地时，**关键路径用 Rust 实现**（如 PTY / VT100 / 终端 diff 渲染），Python 仅用于 AI 决策。

### 5.7 Headroom 对 TDSF 的完整借鉴清单

| 决策点 | v3.2.1 | Headroom 做法 | v3.3 建议 |
|--------|--------|--------------|-----------|
| 上下文压缩 | 32K 硬上限 | **CCR 可逆压缩** | ✅ **采用 CCR 模式** |
| 压缩触发 | 固定阈值 | 比率 + 绝对值双触发 | ✅ **采用 Kimi + Headroom 双触发** |
| 检索 | 无 | `headroom_retrieve` 工具 | ✅ **MCP 暴露** |
| 缓存 | 无 | LRU + 1h TTL | ✅ **本地 LRU** |
| Rust 扩展 | 无 | PyO3 + Rust core | ✅ **关键路径用 Rust** |
| 跨 Agent 记忆 | 无 | 共享 store + dedup | ✅ **P1** |
| 输出 token 减少 | 无 | 修剪 model 回写（去掉 ceremony） | ✅ **P1** |
| MCP 集成 | 35+ tools | 3 工具 server | ✅ **新增 3 工具** |

---

## 6. Kilo Code + Claw Code 速览（⭐⭐）

### 6.1 Kilo Code（fork of OpenCode）

> 项目位置：`opensource-reference/kilo-code/`
> GitHub：Kilo-Org/kilocode
> 协议：Apache 2.0

**核心定位**：opencode 的 fork，500+ 模型，开源 + 开放定价（按 provider 价 + 0 加价）。

**Kilo 关键决策**：
- **kilocode_change 标记** — fork 与 upstream 的边界
- **极简命名规范** — pid / cfg / err / opts / dir / root
- **避免 else** — 早返回 / IIFE
- **avoid let** — 优先 const + 三元 / IIFE
- **avoid try/catch** — 优先恢复 / 重试 / 抛出
- **no empty catch** — 至少 log.error
- **.kilo/skills/** — 域内 skill（如 `gh-issues/SKILL.md`）
- **.opencode/** — opencode 的 skills + commands + themes

**Kilo 的 Agent Manager**（VSCode 扩展内）：
- `KiloConnectionService`（每 sidebar / editor tab / Agent Manager 一个）
- 共享当前 `kilo serve` 后端
- Worktree 会话通过 dir context 共享后端
- 状态捕获通过 Snapshot `trackState`

**TDSF 借鉴**（P0）：
- **kilocode_change 标记** — 区分 TDSF 自研 vs 复用开源
- **极简命名** — 应用于 Rust 端
- **.tdsf/skills/** + **./TDSF.md** — 域内 skill + 项目记忆

### 6.2 Claw Code（ultraworkers/claw-code）

> 项目位置：`opensource-reference/claw-code/`
> 协议：MIT

**项目哲学**（README 自述）：
> "Claw Code is not the serious production project here. This repository is closer to a museum exhibit than a product pitch."

**核心特点**：
- `claw doctor` 健康检查
- `Parity Harness` — Python 源码 + Rust 端口一致性验证
- PowerShell-first Windows 安装
- Local OpenAI-compatible providers + offline skill installs
- 容器优先工作流

**TDSF 借鉴**（P2）：
- **Parity Harness** — 写测试对比 Python 和 Rust 实现的一致性
- **claw doctor** — TDSF 启动时健康检查

---

## 7. v3.2.1 → v3.3 横向对比矩阵

### 7.1 13 个项目核心维度对比

| 项目 | 语言 | 沙箱 | 压缩 | 工具 | Skills | 多模态 | Worktree | 远程 | 自主性 |
|------|------|------|------|------|--------|--------|----------|------|--------|
| **Kimi CLI** | Python | AFK/Yolo | SimpleCompaction | 11 | ✅ SKILL.md | ⚪ | ⚪ | ✅ SSH | 🟢 |
| **Qoder CLI** | Node.js | 3 档 | /compact | 基础 + MCP | ✅ ~/.qoder/skills | ✅ 截图 | ✅ | ✅ | 🟢🟢 |
| **Codex CLI** | Rust | **3 档** | /compact | 工具集 | ✅ plugin marketplace | ✅ 多图 | ✅ | ✅ | 🟢🟢🟢 |
| **Headroom** | Rust+Py | n/a | **CCR 可逆** | 3 个 MCP | n/a | n/a | n/a | n/a | n/a |
| **Kilo Code** | TypeScript | PTY | 内部 | 完整 | ✅ .kilo/skills | n/a | ✅ Agent Manager | ✅ | 🟢🟢 |
| **Claw Code** | Rust | OS | Parity | CLI | ✅ offline | n/a | n/a | ✅ | 🟢 |
| **opensquilla** | Python | Python sandbox | Token routing | Squilla Router | n/a | n/a | n/a | ✅ | 🟢 |
| **terax-ai** | Rust | Tauri 2 | n/a | MCP | n/a | n/a | n/a | n/a | n/a |
| **Orca** | TypeScript | WSL | n/a | 完整 | n/a | n/a | ✅ | ✅ | 🟢 |
| **Synara** | TypeScript | n/a | **handoff 32K** | 工具集 | n/a | n/a | n/a | n/a | 🟢 |
| **cmux** | Swift+Next | Seatbelt | n/a | 完整 | n/a | n/a | ✅ @State | ✅ | 🟢 |
| **BitFun** | Rust | 4 接口切面 | n/a | Plugin | n/a | n/a | n/a | n/a | 🟢🟢 |
| **Vibo** | TypeScript | n/a | n/a | 基础 | n/a | n/a | n/a | n/a | 🟢 |

### 7.2 行业共识（v3.3 强化版）

v3.2.1 已有 5 大共识，v3.3 补充 5 大新共识：

| # | 共识 | 验证项目 |
|---|------|---------|
| 1 | **Shift+Tab 三模式（plan/agent/yolo）= 行业标准** | Kimi Yolo + Qoder /permission-mode + Codex /permissions |
| 2 | **mood ring 状态可视化 = 优秀 UX 必选项** | friday-code + Qoder /status + Codex /status |
| 3 | **side-git / workspace snapshot = 主流回滚方案** | CodeWhale + Qoder --worktree + Codex fork |
| 4 | **SKILL.md = 事实标准** | Kimi SKILL.md + Qoder ~/.qoder/skills + Codex plugin |
| 5 | **单写入器控制平面 + 多客户端 = 企业级架构** | aimux-cli + cmux + Qoder Cloud |
| **6** ⭐ | **可逆上下文压缩（CCR）= 长会话必选** | Headroom + Kimi Compaction |
| **7** ⭐ | **OS 级沙箱 = 安全底线** | Codex 3 档 + Zagens WFP + Kimi AFK |
| **8** ⭐ | **多模式前端（TUI/Print/ACP/IDE）= 全场景覆盖** | Kimi 4 种 + Codex 2 种 + Qoder 3 种 |
| **9** ⭐ | **环境变量统一前缀 = 工程最佳实践** | Qoder QODER_* + Kimi KIMI_* + Codex CODEX_* |
| **10** ⭐ | **AGENTS.md 自动发现 = 项目记忆标准** | Kimi + Qoder /init + Codex config |

---

## 8. **TDSF 借鉴清单（9 大决策点）**

> 这是 v3.3 增量调研的**最核心产出**，直接驱动 v3.3.1 实施路线。

### 决策 D-V33-01：前端多模式（4 模式 + 2 视图）

| 模式 | 描述 | 借鉴自 |
|------|------|--------|
| TUI 主模式 | 终端内交互 | Kimi shell + Codex TUI |
| Print 模式 | `tdsf -p "..."` 非交互 | Kimi + Qoder + Codex |
| ACP server | IDE 集成 | Kimi acp + Qoder JetBrains |
| Web UI | 浏览器远程 | Qoder 远程控制 + Kimi kimi web |

**视图模式**（沿用 v3.2.1）：
- 展开模式：终端主区 + Agent 浮动面板
- 折叠模式：纯终端（沉浸），右下角 mood ring 浮窗

### 决策 D-V33-02：Wire 事件协议（**核心新决策**）

```python
# TDSF Wire 事件类型（沿用 Kimi 设计）
class StatusUpdate:
    status: Literal['idle', 'thinking', 'stream', 'working', 'done', 'error', 'waiting']
    progress: float | None = None  # 0-1
    current_tool: str | None = None
    approval_required: ApprovalRequest | None = None
    trace_id: str | None = None

class TurnBegin(user_input: str | list[ContentPart])
class TurnEnd(stop_reason: str, final_message: Message | None)
class StepBegin(n: int)
class TextPart(text: str)
class ToolResult(name: str, result: Any, display: list[DisplayBlock])
class CompactionBegin()
class CompactionEnd(usage: TokenUsage)
class SteerInput(input: str)  # /steer 中途转向
```

**传输**：Tauri 2 Event Bus（前端 Rust 端 <-> Webview）

### 决策 D-V33-03：文件系统抽象（TdsfFs Protocol）

```python
# 协议定义（位于 tdsf_core.fs）
class TdsfFs(Protocol):
    name: str  # "local" | "ssh" | "docker" | "wsl"
    def pathclass(self) -> type[PurePath]: ...
    async def stat(self, path: TdsfPath) -> StatResult: ...
    async def readtext(self, path: TdsfPath) -> str: ...
    async def writetext(self, path: TdsfPath, data: str) -> int: ...
    async def exec(self, *args: str, env: dict | None = None) -> TdsfProcess: ...
    # ... 共 14 个方法

# 本地实现
class LocalTdsfFs:  # 基于 aiofiles + asyncio.subprocess

# 远程实现
class SshTdsfFs:  # 基于 asyncssh 或我们已有的 SSH 客户端
```

**实施**：v3.3 落地时**先实现 LocalTdsfFs**，SshTdsfFs 走 v3.4。

### 决策 D-V33-04：上下文压缩（CCR + 比率 + 绝对值双触发）

```python
class TdsfCompaction:
    """TDSF 可逆压缩（Headroom CCR 风格）"""
    def __init__(self, max_preserved_messages=4, trigger_ratio=0.7):
        self.trigger_ratio = trigger_ratio
        self.reserved_context = 8192  # 预留 8K 给 LLM 输出
        self.lru_cache = LRU(max_size=100_000_000)  # 100MB

    def should_compact(self, token_count, max_context):
        # Kimi 风格双触发
        return (
            token_count >= max_context * self.trigger_ratio
            or token_count + self.reserved_context >= max_context
        )

    async def compact(self, messages, llm) -> CompactionResult:
        # 1. 旧消息压缩
        # 2. 标记 [compacted: hash=xxx] + 缓存原内容
        # 3. 注入 tdsf_retrieve 工具
        ...

    async def retrieve(self, hash: str, query: str | None = None) -> str:
        return self.lru_cache.get(hash)
```

### 决策 D-V33-05：权限系统（Codex 9 组合 + Kimi AFK）

| | untrusted (L3 强审批) | on-request (L1/L2 智能) | never (L0 自动) |
|---|---|---|---|
| **read-only 沙箱** | 仅读，需每次确认 | 仅读，确认高危 | 仅读，自动 |
| **workspace-write 沙箱** | 所有写命令确认 | 高危命令确认 | 全部自动 |
| **danger-full-access** | 所有操作确认 | 智能确认 | 全部自动 |

**叠加 Kimi AFK**：
- 持久化 AFK 模式 = 离开时自动 L0
- 运行时 AFK 模式（`--print` / `--afk`）= 临时 L0
- Yolo 显式 = L0（仅可信目录）

### 决策 D-V33-06：环境变量统一（TDSF_* 前缀）

```bash
# 模型
TDSF_MODEL=qwen3-coder-plus
TDSF_PROVIDER=qwen

# 工作区
TDSF_WORKING_DIR=/path/to/project
TDSF_SESSION_ID=abc123
TDSF_SESSION_NAME="排查 server 502"

# 权限
TDSF_PERMISSION_MODE=on-request
TDSF_SANDBOX_MODE=workspace-write

# MCP
TDSF_MCP_CONFIG=/path/to/mcp.json
TDSF_SKILLS_DIR=/path/to/skills

# 压缩
TDSF_COMPACT_TRIGGER=0.7
TDSF_COMPACT_PRESERVE=4

# 日志
TDSF_LOG_LEVEL=info
TDSF_TRACE=1
```

### 决策 D-V33-07：AGENTS.md 自动发现（Kimi 模式）

```
全局：~/TDSF.md
项目：<project>/.tdsf/AGENTS.md 或 <project>/TDSF.md
预算：32 KiB（Kimi 同款）
优先级：leaf-first（深目录优先）
加载顺序：
  1. .tdsf/AGENTS.md（项目本地 TDSF 配置，最高优先级）
  2. TDSF.md（标准）
  3. tdsf.md（小写变体）
  4. AGENTS.md（AIMUX.md 兼容，行业标准）
```

### 决策 D-V33-08：工具集（复用 Kimi 11 类 + TDSF 风险引擎）

| 工具 | 描述 | 实现 |
|------|------|------|
| `Agent` | subagent 调度 | LaborMarket（沿用 Kimi） |
| `AskUserQuestion` | 询问用户 | 4 选项 max |
| `Background` | 后台任务 | list/output/stop |
| `File` | 读/写/替换/glob/grep | TdsfFs 抽象 + RiskEngine |
| `Shell` | Shell 执行 | RiskEngine 4 层 + ASKP/审批 |
| `Web` (fetch/search) | 网页获取 | httpx + 搜索引擎 |
| `Todo` | 待办列表 | v3.2.1 已有 |
| `Plan` | 计划模式 | 沿用 Kimi heroes |
| `Think` | 思考块 | 沿用 Kimi |
| `Knowledge` | **TDSF 新增** | 知识库检索（14 源） |
| `Risk` | **TDSF 新增** | 风险评估（RiskEngine） |

### 决策 D-V33-09：快捷键 + Slash 命令（Codex 风格）

**TUI 快捷键**：
| 快捷键 | 功能 |
|--------|------|
| Ctrl+L | 清屏（保留对话历史） |
| Ctrl+O | 复制最新输出到剪贴板 |
| Ctrl+R | 搜索提示词历史 |
| Ctrl+G | 打开外部编辑器（$EDITOR） |
| Tab（运行中） | 下一轮排队（不打断） |
| Esc×2 | 编辑上一条消息 |
| @ | 模糊文件搜索 |
| !cmd | 直接执行本地 Shell |
| Shift+Tab | 切换 plan/agent/yolo 模式 |

**Slash 命令**：
| 命令 | 功能 |
|------|------|
| `/review` | 代码审查 |
| `/model` | 切换 AI 模型 |
| `/fork` | 分叉当前会话 |
| `/permissions` | 切换权限模式 |
| `/compact` | 压缩会话 |
| `/side` | 切换 Agent 面板 |
| `/diff` | 查看文件变更 |
| `/status` | 查看会话状态 |
| `/init` | 初始化项目 AGENTS.md |
| `/mcp` | MCP 服务管理 |
| `/skills` | 技能管理 |

---

## 9. 实施优先级与下一步

### 9.1 优先级矩阵

| 优先级 | 决策 | 实施阶段 | 预估工时 |
|--------|------|---------|---------|
| **P0 必复用** | D-V33-02 Wire 协议 + D-V33-03 TdsfFs + D-V33-04 CCR 压缩 | P1（脚手架） | 1-2 周 |
| **P0 必复用** | D-V33-05 权限 9 组合 + D-V33-06 环境变量 + D-V33-09 快捷键/Slash | P2（核心） | 1-2 周 |
| **P0 必复用** | D-V33-08 工具集（11 类） | P3（工具） | 1-2 周 |
| **P1 推荐** | D-V33-07 AGENTS.md 自动发现 | P2（核心） | 0.5 周 |
| **P1 推荐** | D-V33-01 多模式前端 | P4（前端） | 1-2 周 |
| **P2 暂不** | 多模态（截图分析） | P5+ | 后续 |

### 9.2 v3.3.1 实施路线（**8 周冲刺**）

| 阶段 | 周 | 目标 | 关键交付 |
|------|----|------|---------|
| **P0 准备** | 1 | 设计稿冻结 + Rust 环境 + Tauri 2 脚手架 | design/ + src-tauri/ |
| **P1 核心** | 2 | TdsfFs + Wire 协议 + CCR 压缩 | tdsf-core/ + Rust |
| **P2 集成** | 3 | 工具集（11 类）+ 权限 9 组合 | tdsf-tools/ |
| **P3 前端** | 4 | React 19 + 7 状态 mood ring + 浮动面板 | web/ |
| **P4 多模** | 5 | TUI/Print/ACP/Web 四模式前端 | web/ + tui/ |
| **P5 Skills** | 6 | 18 领域预置 Skills + skills.sh 集成 | skills/ |
| **P6 安全** | 7 | OS 级沙箱 + 3 档 + Firecracker | tdsf-sandbox/ |
| **P7 验收** | 8 | 5 绿门禁 + Playwright E2E + 性能压测 | tests/ + docs/ |

### 9.3 立即可做（无设计稿依赖）

1. ✅ **创建 v3.3 报告**（本文）
2. ⬜ **更新 00-overview.md**（反映 v3.3 决策）
3. ⬜ **更新技术方案书 v3.0 → v3.3**（增量）
4. ⬜ **开始 P0 准备工作**：Tauri 2 脚手架调研、依赖清单
5. ⬜ **保存项目记忆 + 今日 topics**

### 9.4 需要 Trae Design 的设计稿（设计稿到达后立即做）

- 7 状态 mood ring 视觉规范
- 浮动 Agent 面板的 4 种尺寸
- Slash 命令面板 UI
- @ 文件搜索面板 UI
- Skills marketplace UI
- 权限审批弹窗 UI
- 多模态截图预览 UI

---

## 附录 A：参考资料

### A.1 调研项目 GitHub

| 项目 | 仓库 | Stars | 协议 | 状态 |
|------|------|-------|------|------|
| Kimi CLI | MoonshotAI/kimi-cli | 10.8K | 待查 | 🟢 活跃 |
| Qoder CLI | nicepkg/qodercli | 待查 | 待查 | 🟢 活跃 |
| Codex CLI | openai/codex | 87.3K | Apache 2.0 | 🟢🟢 超活跃 |
| Headroom | chopratejas/headroom | 待查 | Apache 2.0 | 🟢 活跃 |
| Kilo Code | Kilo-Org/kilocode | 待查 | Apache 2.0 | 🟢 活跃 |
| Claw Code | ultraworkers/claw-code | 待查 | MIT | 🟢 活跃 |

### A.2 文档与教程

- Kimi Code CLI 快速参考：https://www.kimi.com/zh-cn/resources/kimi-code-cheat-sheet
- Qoder CLI 阿里云对接指南：https://developer.aliyun.com/article/1748521
- Codex CLI 完整教程：https://segmentfault.com/a/1190000047807970
- Headroom CCR 文档：https://headroom-docs.vercel.app/docs/ccr
- Headroom MCP 文档：https://headroom-docs.vercel.app/docs/mcp

### A.3 关键文件位置（clone 后分析）

- `opensource-reference/kimi-cli/src/kimi_cli/soul/kimisoul.py` — Kimi 核心循环
- `opensource-reference/kimi-cli/src/kimi_cli/soul/compaction.py` — Kimi 压缩
- `opensource-reference/kimi-cli/src/kimi_cli/soul/approval.py` — Kimi 权限
- `opensource-reference/kimi-cli/src/kimi_cli/soul/agent.py` — Kimi Runtime
- `opensource-reference/kimi-cli/packages/kaos/src/kaos/{local,ssh,path}.py` — PyKAOS 抽象
- `opensource-reference/kimi-cli/src/kimi_cli/tools/{file,shell,background,ask_user,agent}/` — Kimi 工具
- `opensource-reference/headroom/headroom/ccr/{context_tracker,response_handler,tool_injection}.py` — Headroom CCR
- `opensource-reference/headroom/crates/headroom-core/src/lib.rs` — Headroom Rust 核心

---

> **报告结束** | v3.3 增量调研已完成 | 下一步：更新 00-overview.md 和技术方案书
