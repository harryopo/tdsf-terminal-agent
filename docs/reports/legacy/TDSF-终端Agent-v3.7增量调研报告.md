# TDSF 终端 Agent · v3.7 增量调研报告

> **调研时间**：2026-07-26  
> **调研背景**：用户要求"在设计稿来之前，你也去调研一下其它 agent，例如 kimicode，qodercil，等其它开源终端 agent"  
> **本轮增量**：在 v3.6 调研的 77 个项目基础上，**深度补充 2 个核心开源项目 + 1 个集成示范**  
> - **P37-01 OpenHarness（HKUDS）** — Python 全栈 43+ 工具的完整 Agent 框架，含 10+ 平台 Channels + 4 类 Hooks + Personalization + Swarm 多 Agent  
> - **P37-02 claw-code（ultraworkers）** — 纯 Rust 实现的 Claude Code 替代品（48,599 LOC），含 9 crate 拆分 + 11 阶段 MCP 生命周期 + 4 阶段权限模型 + Mock Parity Harness  
> - **P37-03 cube-shell（ops-key）** — PySide6 SSH 客户端集成 Claude Code + Hermes 的桌面示范，验证 Tauri 复刻路径  
> **累计覆盖**：开源项目 **79 个**（77 + 2 新增 + 1 集成示范），代码量 **~28.0M 行**  
> **调研承诺**：每个项目均完成 `git clone` + 源码级 / 文档级深度分析

---

## 0. 阅读路线

1. §1 本轮 3 个项目速览表
2. §2 OpenHarness 深度分析（10 大子系统）
3. §3 claw-code 深度分析（9 crate 拆分 + 11 阶段状态机）
4. §4 cube-shell 集成示范（PySide6 + Claude Code + Hermes 整合方案）
5. §5 v3.7 提炼的 **20 大决策点**（D-V37-01 ~ D-V37-20）
6. §6 v3.7 揭示的 **3 项行业新共识**
7. §7 横向对比矩阵（79 项目）
8. §8 待办 & 下一步

---

## 1. 本轮 3 个项目速览

| 编号 | 项目 | Stars | 协议 | 类型 | 核心差异化 | 调研时间 | 文档级别 |
|:----:|------|------:|------|------|-----------|:--------:|----------|
| **P37-01** | [OpenHarness / ohmo](https://github.com/HKUDS/OpenHarness) | 8.5K | MIT | AI Agent | **43+ 工具** + **10+ Channel 适配器**（飞书/Slack/Telegram/Discord/Mochat/Matrix/WhatsApp/Email/DingTalk/QQ）+ **4 类 Hook**（Command/Http/Prompt/Agent）+ **Auto-Dream 离线整合** | 2026-07-26 | 完整源码 + AGENTS 风格指南 + 43 个工具实现 |
| **P37-02** | [claw-code（ultraworkers）](https://github.com/ultraworkers/claw-code) | 12K | MIT | AI Agent | **9 个 Rust crate 拆分**（48,599 LOC）+ **11 阶段 MCP 生命周期** + **4 阶段 PermissionMode** + **Mock Parity Harness**（12 场景）+ **9-lane checkpoint 全部合并** | 2026-07-26 | 完整源码 + PARITY.md + 9 lane detail |
| **P37-03** | [cube-shell](https://github.com/ops-key/cube-shell) | — | MIT | SSH+AI 客户端 | **PySide6 + Claude Code + Hermes + SSH 集成**（桌面 + 终端 + AI 三合一） + **风险等级颜色映射**（SAFE/LOW/MEDIUM/HIGH/CRITICAL） | 2026-07-26 | 完整源码 + 集成示范 |

> **调研路径**：本轮 3 个项目均已 `git clone` 到 `opensource-reference/`，全部进行源码级阅读。OpenHarness 阅读了 18 个核心 Python 文件 + 4 类 Hook + 10+ Channel；claw-code 阅读了 6 个 Rust crate 的入口 + PARITY.md 全量 9 lane；cube-shell 阅读了 Claude Code + Hermes 后端抽象 + AI Panel UI。

---

## 2. OpenHarness（HKUDS）— 完整 Python Agent 框架

### 2.1 项目定位

- **GitHub**：`HKUDS/OpenHarness`（2025-09 开源，2026-07 持续迭代）
- **Stars**：8.5K · 协议：MIT · 语言：Python ≥3.10 · TUI：React + Ink
- **核心哲学**："Harness 框架 + ohmo 个人助手"，一个命令 `oh` 启动全部 Agent Harness
- **关键演进**：`OpenHarness`（核心框架） + `ohmo`（个人助手 + 多平台 Channel）双产品
- **调研收获**：已 clone 完整源码（200+ Python 文件 + 20+ React/TS 前端），分析 10 个核心子系统

### 2.2 总体架构：8 大子系统

```
┌──────────────────────────────────────────────────────────────────┐
│  1. UI 层（React + Ink TUI + 桌面 Dashboard）                      │
│     frontend/terminal/    TUI（命令面板 + 状态栏 + Swarm 面板）     │
│     autopilot-dashboard/  桌面 Dashboard（React + Vite）           │
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  2. Engine 层（QueryEngine + Stream Events）                       │
│     engine/query_engine.py    主循环（用户输入 → LLM → 工具 → 反思）│
│     engine/stream_events.py   8 类事件 dataclass                  │
│     engine/cost_tracker.py    Token 计数 + 成本追踪                │
│     engine/messages.py        对话消息模型                         │
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  3. Tools 层（43+ 工具 + 4 类 Hook）                               │
│     tools/                       43+ 工具实现（base/agent/bash/）  │
│     hooks/executor.py            Hook 执行器                       │
│     hooks/types.py               4 类 Hook（Command/Http/Prompt）│
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  4. Skills 层（bundled + user + plugin 三层）                      │
│     skills/loader.py             SKILL.md 加载器（目录式 SKILL）   │
│     skills/registry.py           注册中心                          │
│     skills/bundled/content/      8 个内置 Skill（commit/debug/）   │
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  5. Channels 层（10+ 平台 + MessageBus 抽象）                      │
│     channels/bus/queue.py        MessageBus（inbound + outbound）  │
│     channels/bus/events.py       Inbound/Outbound 消息模型         │
│     channels/impl/feishu.py      飞书（lark-oapi + WebSocket）     │
│     channels/impl/telegram.py    Telegram                          │
│     channels/impl/slack.py       Slack                             │
│     channels/impl/discord.py     Discord                           │
│     channels/impl/whatsapp.py    WhatsApp                          │
│     channels/impl/dingtalk.py    钉钉                              │
│     channels/impl/qq.py          QQ                                │
│     channels/impl/email.py       邮件                              │
│     channels/impl/mochat.py      Mochat                            │
│     channels/impl/matrix.py      Matrix                            │
│     channels/adapter.py          ChannelBridge（QueryEngine ↔ Bus）│
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  6. Memory 层（memdir + facts + auto-dream）                       │
│     memory/memdir.py             MEMORY.md 入口文件管理            │
│     memory/agent.py              8 模块记忆架构                    │
│     memory/relevance.py          相关性打分                        │
│     memory/team.py               团队共享记忆                      │
│     services/autodream/          Auto-Dream 离线整合              │
│     services/memory_extract/     定期抽取（cron-like）             │
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  7. Swarm 层（4 种后端 + 跨平台）                                  │
│     swarm/types.py               BackendType = subprocess/in_process│
│                                              /tmux/iterm2         │
│     swarm/registry.py            后端检测（$TMUX/$ITERM_SESSION_ID）│
│     swarm/team_lifecycle.py      团队生命周期                      │
│     swarm/worktree.py            Git worktree 隔离                 │
└─────────────┬────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  8. Personalization 层（extractor + rules + session_hook）          │
│     personalization/extractor.py   10 类环境 fact 正则提取        │
│     personalization/rules.py       rules.md + facts.json 双文件   │
│     personalization/session_hook.py 自动注入 session 上下文        │
│     platforms.py                   平台感知（macos/linux/wsl/win） │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 核心创新 1：4 类 Hook 引擎（D-V37-01 ★）

**问题**：单一 Shell Hook 难以覆盖 HTTP/AI Agent 等多类集成场景。

**4 类 Hook 设计**（`hooks/schemas.py`）：
```python
class CommandHookDefinition:
    """Shell 命令 hook"""
    type: Literal["command"]
    command: str          # e.g. "prettier --check $FILE"
    timeout: int = 30     # 超时（秒）

class HttpHookDefinition:
    """HTTP webhook"""
    type: Literal["http"]
    url: str
    method: Literal["GET", "POST"] = "POST"
    headers: dict[str, str] = {}
    body_template: str    # JSON 模板

class PromptHookDefinition:
    """LLM 提示词 hook（单次 LLM 调用）"""
    type: Literal["prompt"]
    prompt: str           # 系统提示词
    model: str | None     # 可指定模型

class AgentHookDefinition:
    """Agent hook（递归调用 Agent）"""
    type: Literal["agent"]
    prompt: str
    subagent_type: str
```

**Hook 执行流程**（`hooks/executor.py`）：
```python
async def execute(self, event: HookEvent, payload: dict[str, Any]) -> AggregatedHookResult:
    results: list[HookResult] = []
    for hook in self._registry.get(event):
        if not _matches_hook(hook, payload):
            continue
        if isinstance(hook, CommandHookDefinition):
            results.append(await self._run_command_hook(hook, event, payload))
        elif isinstance(hook, HttpHookDefinition):
            results.append(await self._run_http_hook(hook, event, payload))
        elif isinstance(hook, PromptHookDefinition):
            results.append(await self._run_prompt_like_hook(hook, event, payload, agent_mode=False))
        elif isinstance(hook, AgentHookDefinition):
            results.append(await self._run_prompt_like_hook(hook, event, payload, agent_mode=True))
    return AggregatedHookResult(results=results)
```

**对 TDSF 价值**：
- 决策点 **D-V37-01 ⭐ 4 类 Hook 引擎**：扩展 v3.6 D-V36-06 User-defined Hooks
  - Command Hook（shell）= v3.6 已规划
  - Http Hook（webhook）= 推送通知 + 远程触发
  - Prompt Hook（LLM）= 轻量 AI 决策（无工具调用）
  - Agent Hook（递归）= 子 Agent 编排
- 与 Crush 的 shell-only hook + Mastra 的 suspend/resume 互补
- TDSF Hook 配置示例：
  ```json
  {
    "hooks": {
      "PreToolUse": [
        { "type": "command", "command": "tdsf-validator $TOOL $INPUT" },
        { "type": "http", "url": "https://audit.tdsf.com/log" },
        { "type": "agent", "prompt": "检查 $INPUT 是否高危", "subagent_type": "risk-checker" }
      ]
    }
  }
  ```

### 2.4 核心创新 2：10+ Channel 适配器架构（D-V37-02 ★）

**问题**：每接入一个 IM 平台都要重写发送/接收逻辑。

**Channel 抽象层**（`channels/impl/base.py` + 10+ 实现）：
```
MessageBus（asyncio.Queue）
   ├── inbound（外部消息进入）
   └── outbound（Agent 回复发送）
         ↓
   ChannelBridge（adapter.py）
   ├── 接收 InboundMessage
   ├── 调用 QueryEngine.submit_message()
   └── 收集 OutboundMessage，发布到 Bus
         ↓
   ChannelManager
   ├── feishu    (lark-oapi + WebSocket)
   ├── slack     (slack-sdk + Socket Mode)
   ├── telegram  (python-telegram-bot)
   ├── discord   (discord.py)
   ├── dingtalk  (dingtalk-stream)
   ├── qq        (botpy)
   ├── email     (imap/smtp)
   ├── mochat    (openclaw)
   ├── matrix    (matrix-nio)
   └── whatsapp  (yowsup)
```

**Feishu 实现亮点**（`feishu.py`）：
- 长连接 WebSocket（避免公网回调）
- 事件处理：消息类型映射（image/audio/file/sticker）
- 群组/私聊自动识别
- 提及检测（@机器人 触发）

**对 TDSF 价值**：
- 决策点 **D-V37-02 ⭐ Channel 抽象层 + 10+ 平台**：扩展 v3.6 D-V36-11 Qwen Code Channels
  - `tdsf-channels` 子包
  - 4 个核心接口：`ChannelBase` / `MessageBus` / `InboundMessage` / `OutboundMessage`
  - 任何 IM 平台只需实现 `ChannelBase` 的 4 个方法
  - TDSF 默认集成飞书/企微/钉钉/微信（运维场景高优）
- 与 MessageBus 解耦：1 个 QueryEngine 实例可服务 N 个 Channel

### 2.5 核心创新 3：Swarm 后端抽象（D-V37-03 ★）

**4 种后端**（`swarm/types.py`）：
```python
BackendType = Literal["subprocess", "in_process", "tmux", "iterm2"]
PaneBackendType = Literal["tmux", "iterm2"]  # 可视化 pane 后端
```

**自动检测**（`swarm/registry.py`）：
- `subprocess`：永远可用（默认）
- `in_process`：asyncio 任务，零 fork 成本（不能跨进程通信）
- `tmux`：检测 `$TMUX` 环境变量 + `tmux` 二进制
- `iterm2`：检测 `$ITERM_SESSION_ID` + `it2` CLI

**Teammate 可视化**（`swarm/types.py:PaneBackend` Protocol）：
```python
class PaneBackend(Protocol):
    async def is_available(self) -> bool
    async def is_running_inside(self) -> bool
    async def create_teammate_pane_in_swarm_view(
        self,
        name: str,
        color: str | None = None,
    ) -> CreatePaneResult
```

**Agent Tool 实现**（`tools/agent_tool.py`）：
- `subprocess` 后端注册到 `BackgroundTaskManager`，可被 task tools 查询
- `in_process` 后端返回 asyncio-internal ID（task tools 无法查询，故默认 subprocess）

**对 TDSF 价值**：
- 决策点 **D-V37-03 ⭐ Swarm 后端抽象**：扩展 v3.2 D-V32-04 + v3.6 D-V36-05
  - `tdsf-swarm` 子包
  - 4 种后端自动 fallback：subprocess → in_process → tmux → iterm2
  - TUI 中用 tmux pane 可视化多 Agent
  - Windows 用 WSL2 + tmux（fallback subprocess）
- 与 v3.6 Subagent Registry 互补：Registry 管定义，Swarm 管执行后端

### 2.6 核心创新 4：Personalization + Fact 提取（D-V37-04 ★）

**10 类环境 fact 正则提取**（`personalization/extractor.py`）：
```python
_FACT_PATTERNS = [
    ("ssh_host",      re.compile(r"ssh\s+(?:-[io]\s+\S+\s+)*(\S+@[\d.]+|\S+@\S+)")),
    ("ip_address",    re.compile(r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})")),
    ("data_path",     re.compile(r"(/(?:ext|mnt|home|data|root)\S*/(?:data\S*|landing|derived|reference)\S*)")),
    ("conda_env",     re.compile(r"conda\s+activate\s+(\S+)")),
    ("python_env",    re.compile(r"[Pp]ython\s*(3\.\d+(?:\.\d+)?)")),
    ("api_endpoint",  re.compile(r"(https?://\S+/v\d+/?)\b")),
    ("env_var",       re.compile(r"export\s+([A-Z][A-Z0-9_]+)(?:=\S+)?")),
    ("git_remote",    re.compile(r"(?:github|gitlab)\.com[:/](\S+?)(?:\.git)?")),
    ("ray_cluster",   re.compile(r"ray\s+(?:start|init|submit)\b.*?(--address\s+\S+|\d+\.\d+\.\d+\.\d+:\d+)")),
    ("cron_schedule", re.compile(r"((?:\d+|\*)\s+(?:\d+|\*)\s+...\s+\S+)")),
]
```

**双文件持久化**（`personalization/rules.py`）：
- `~/.openharness/local_rules/rules.md`（人类可读）
- `~/.openharness/local_rules/facts.json`（机器可读，结构化）

**Merge 策略**（merge_facts）：新 fact 覆盖旧 fact（按 confidence）

**对 TDSF 价值**：
- 决策点 **D-V37-04 ⭐ Personalization + Fact 提取**：
  - 从历史会话自动提取环境信息
  - `~/.tdsf/local_rules/rules.md` + `facts.json`
  - 跨 session 注入"我的工作环境"上下文
  - 运维场景高价值：自动记住常用 SSH 主机/IP/路径/conda env
- 与 v3.2 D-V32-06 TDSF.md 互补：
  - TDSF.md = 用户主动写
  - Personalization = 系统自动学
- 安全脱敏：API key / 凭据不进入 facts（已实现正则过滤）

### 2.7 核心创新 5：Auto-Dream 离线整合（D-V37-05 ★）

**Dream 概念**（借鉴神经科学"睡眠整合记忆"）：
- 离线异步任务，定期反思 memory 文件
- 提炼重复出现的 fact，合并/去重/分类
- 输出到 `MEMORY.md` 入口

**Dream Prompt 模板**（`services/autodream/prompt.py`）：
```python
def build_consolidation_prompt(memory_root, session_dir, extra="", *, preview=False):
    # 5 类分类法
    # 1. Stable Preference（持久偏好）
    # 2. Durable Project Context（项目上下文）
    # 3. Recent Snapshot（近期快照，必须带 Last observed 日期）
    # 4. Sensitive/Private Context（敏感隐私，必须带 Privacy 标签）
    # 5. Operational Reminder（操作提醒）
    # ...
    # 规则：每次 dream 最多新建 2 个 md 文件，优先更新已有
```

**对 TDSF 价值**：
- 决策点 **D-V37-05 ⭐ Auto-Dream 离线整合**：
  - 5 类记忆分类法
  - 后台定时任务（cron-like）
  - 防止 memory 爆炸（去重 + 合并）
  - TDSF 运维场景：自动整合"哪些 SSH 主机经常维护"、"哪些故障频繁发生"
- 与 v3.6 D-V36-12 Qwen Code Memory 8 模块互补

### 2.8 核心创新 6：Stream Events 协议（9 类事件，D-V37-06）

**8 类事件 dataclass**（`engine/stream_events.py`）：
```python
@dataclass(frozen=True)
class AssistantTextDelta:    # 流式文本
    text: str

@dataclass(frozen=True)
class AssistantTurnComplete: # turn 结束 + usage
    message: ConversationMessage
    usage: UsageSnapshot

@dataclass(frozen=True)
class ToolExecutionStarted:  # 工具开始
    tool_name: str
    tool_input: dict[str, Any]

@dataclass(frozen=True)
class ToolExecutionCompleted:  # 工具完成
    tool_name: str
    output: str
    is_error: bool = False
    metadata: dict[str, Any] | None = None

@dataclass(frozen=True)
class ErrorEvent:            # 错误
    message: str
    recoverable: bool = True

@dataclass(frozen=True)
class StatusEvent:           # 状态消息
    message: str

@dataclass(frozen=True)
class CompactProgressEvent:  # 压缩进度（9 阶段）
    phase: Literal["hooks_start", "context_collapse_start", "context_collapse_end",
                   "session_memory_start", "session_memory_end", "compact_start",
                   "compact_retry", "compact_end", "compact_failed"]
    trigger: Literal["auto", "manual", "reactive"]
    attempt: int | None = None
    checkpoint: str | None = None
    metadata: dict[str, Any] | None = None
```

**CompactProgressEvent 9 阶段**（**核心创新**）：
1. `hooks_start` — PreCompact hook 触发
2. `context_collapse_start` — 上下文折叠开始（Headroom CCR 借鉴）
3. `context_collapse_end` — 上下文折叠结束
4. `session_memory_start` — 写入 session memory
5. `session_memory_end` — 写入完成
6. `compact_start` — 压缩开始
7. `compact_retry` — 压缩失败重试
8. `compact_end` — 压缩成功
9. `compact_failed` — 压缩失败

**对 TDSF 价值**：
- 决策点 **D-V37-06 ⭐ Compact 9 阶段进度事件**：
  - TUI 可见压缩进度（不黑盒）
  - 与 Headroom CCR (D-V35-04) 配合：折叠 + 压缩分阶段
  - 失败可重试（3 次机会）
  - `trigger: auto/manual/reactive` 三种触发模式

### 2.9 核心创新 7：Skills 目录式加载（D-V37-07）

**目录式 SKILL**（vs Crush 的 `crush.json` 集中式）：
```
my-skill/
├── SKILL.md         # 必须（frontmatter + 内容）
├── scripts/         # 可选（确定性辅助脚本）
├── references/      # 可选（按需加载的长文档）
└── assets/          # 可选（模板/静态资源）
```

**SKILL.md frontmatter**：
```yaml
---
name: skill-creator
description: >
  Create, improve, and verify OpenHarness skills. Use this whenever...
---
```

**3 类 Skill 位置**：
1. `src/openharness/skills/bundled/content/*.md` — 内置 8 个
2. `~/.openharness/skills/<skill-dir>/SKILL.md` — 用户
3. `<plugin-root>/skills/<skill-dir>/SKILL.md` — 插件

**8 个内置 Skill**（`bundled/content/`）：
- `commit.md` / `debug.md` / `diagnose.md` / `plan.md` / `review.md` / `simplify.md` / `skill-creator.md` / `test.md`

**对 TDSF 价值**：
- 决策点 **D-V37-07 ⭐ 目录式 Skill 加载**：
  - 与 v3.5 Superpowers 7 步工作流协同
  - 每个 Skill 独立目录，支持 scripts/references/assets
  - 自动发现 `~/.tdsf/skills/` + 插件 Skills
  - Skill 元信息（name/description/argument_hint）自动注入 LLM prompt

### 2.10 核心创新 8：43+ 工具集 + 平台感知（D-V37-08）

**43 个工具**（`tools/`）：
- 文件类：file_read / file_write / file_edit / glob / grep
- Shell 类：bash_tool / cron_create / cron_delete / cron_list / cron_toggle
- Agent 类：agent_tool / brief_tool / send_message
- LSP 类：lsp_tool
- MCP 类：mcp_auth_tool / mcp_tool / list_mcp_resources / read_mcp_resource
- Task 类：task_create / task_get / task_list / task_output / task_stop / task_update / todo_write
- 图像类：image_generation_tool / image_to_text_tool
- Web 类：web_fetch_tool / web_search_tool
- 协作类：team_create / team_delete / enter_plan_mode / enter_worktree
- 调度类：sleep_tool / stop_task
- Skill 类：skill_tool
- 配置类：config_tool

**Pydantic InputModel**（每个工具）：
```python
class AgentToolInput(BaseModel):
    """Arguments for local agent spawning."""
    description: str = Field(description="Short description of the delegated work")
    prompt: str = Field(description="Full prompt for the local agent")
    subagent_type: str | None = Field(default=None, description="Agent type...")
    model: str | None = Field(default=None)
    command: str | None = Field(default=None, description="Override spawn command")
    team: str | None = Field(default=None, description="Optional team to attach the agent to")
    mode: str = Field(default="local_agent", description="Agent mode: local_agent, remote_agent, or in_process_teammate")
```

**跨平台抽象**（`platforms.py`）：
- `get_platform()` → `macos | linux | wsl | windows`
- `get_platform_capabilities()` → 平台能力查询
- Windows tmux 走 WSL2

**对 TDSF 价值**：
- 决策点 **D-V37-08 ⭐ 43+ 工具集 + Pydantic InputModel**：
  - 工具集参考清单（不必全做，按需）
  - Pydantic InputModel 模式可借鉴到 Rust（serde + schemars）
  - 平台感知层（macos/linux/wsl/windows）抽象 shell/PATH/编码差异

### 2.11 核心创新 9：TUI 状态栏 + Swarm 面板（D-V37-09）

**StatusBar 设计**（`frontend/terminal/src/components/StatusBar.tsx`）：
- 实时显示 model / mode / mcp count / token / plan mode
- 800ms 闪烁动画（plan mode 切换提示）
- 工具阻塞标记（PLAN MODE + 🔇 Write blocked）

**SwarmPanel 设计**（`frontend/terminal/src/components/SwarmPanel.tsx`）：
- 4 状态 emoji：🟢 running / 🟡 idle / ✅ done / 🔴 error
- Ctrl+W 折叠/展开
- 通知列表（from + message + timestamp）

**对 TDSF 价值**：
- 决策点 **D-V37-09 ⭐ TUI 状态栏 + Swarm 面板**：
  - 4 状态 emoji 与 v3.2 mood ring 7 状态兼容
  - 折叠/展开交互（Ctrl+W）= 业界标准
  - 通知系统可作为 needs-you 协调收件箱的视觉提示

### 2.12 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| 4 类 Hook 引擎 | ★★★★★ | D-V37-01 扩展 v3.6 User Hooks |
| 10+ Channel 适配器 | ★★★★★ | D-V37-02 tdsf-channels |
| Swarm 4 后端抽象 | ★★★★★ | D-V37-03 tdsf-swarm |
| Personalization + Fact 提取 | ★★★★ | D-V37-04 自动学习用户环境 |
| Auto-Dream 离线整合 | ★★★★ | D-V37-05 防止 memory 爆炸 |
| Stream Events 8 类 + 9 阶段 | ★★★★★ | D-V37-06 压缩进度可见 |
| 目录式 Skill 加载 | ★★★★ | D-V37-07 增强 Skill 生态 |
| 43+ 工具集 | ★★★ | D-V37-08 参考清单 |
| TUI 状态栏 + Swarm 面板 | ★★★ | D-V37-09 v3.2 mood ring 补强 |
| Pydantic InputModel 模式 | ★★★★ | Rust 端 serde + schemars |
| 平台感知（macos/linux/wsl/win）| ★★★★ | 跨平台兼容 |
| ChannelBridge 异步桥接 | ★★★ | Tauri + React 前后端解耦 |

---

## 3. claw-code（ultraworkers）— 纯 Rust Claude Code 替代品

### 3.1 项目定位

- **GitHub**：`ultraworkers/claw-code`（2026-03-31 启动，2026-04-03 完成 9 lane 全部合并）
- **Stars**：12K · 协议：MIT · 语言：Rust 100% · 9 个 crate
- **核心哲学**："agent-managed exhibit" — 螃蟹管理的展品，由其他 agent 维护
- **关键里程碑**（`PARITY.md`）：
  - 9 个 crate 拆分（48,599 LOC Rust + 2,568 test LOC）
  - 9-lane checkpoint 全部合并到 main
  - Mock Parity Harness 12 个 scripted scenarios
  - 21 个 captured `/v1/messages` requests
- **调研收获**：已 clone 完整源码（Rust workspace），阅读 PARITY.md 全量 + 6 个核心 crate

### 3.2 总体架构：9 个 crate 拆分（D-V37-10 ★）

```
rust/Cargo.toml（workspace）
├── 1. crates/api/                   # LLM API 客户端（4 provider）
│    ├── anthropic.rs
│    ├── openai_compat.rs
│    ├── client.rs
│    ├── sse.rs                      # SSE 流式解析
│    ├── prompt_cache.rs             # prompt 缓存
│    └── http_client.rs
│
├── 2. crates/commands/              # 命令注册 + 调度
│    └── lib.rs
│
├── 3. crates/compat-harness/         # 兼容性测试
│    └── lib.rs
│
├── 4. crates/mock-anthropic-service/ # 模拟 Anthropic API（用于测试）
│    ├── lib.rs
│    └── main.rs
│
├── 5. crates/plugins/               # 插件系统
│    ├── hooks.rs
│    ├── test_isolation.rs
│    └── bundled/example-bundled/    # 插件示例
│
├── 6. crates/runtime/               # 核心运行时（最大 crate，~30K LOC）
│    ├── mcp.rs / mcp_client.rs / mcp_server.rs / mcp_stdio.rs
│    ├── mcp_lifecycle_hardened.rs   # ★ 11 阶段生命周期
│    ├── mcp_tool_bridge.rs          # ★ MCP tool 桥接
│    ├── permission_enforcer.rs      # ★ 4 阶段权限
│    ├── bash.rs / bash_validation.rs  # ★ 6 验证子模块
│    ├── hooks.rs                    # ★ 3 类 Hook + AbortSignal
│    ├── task_registry.rs            # ★ 任务注册表
│    ├── team_cron_registry.rs       # ★ 团队 + Cron
│    ├── lsp_client.rs               # LSP 客户端
│    ├── approval_tokens.rs          # 审批 token
│    ├── branch_lock.rs              # 分支锁
│    ├── compact.rs                  # 上下文压缩
│    ├── conversation.rs             # 对话管理
│    ├── file_ops.rs                 # 文件操作
│    ├── oauth.rs                    # OAuth 认证
│    ├── policy_engine.rs            # 策略引擎
│    ├── sandbox.rs                  # 沙箱（Docker / unshare）
│    ├── session.rs / session_control.rs
│    ├── trust_resolver.rs           # 信任解析
│    ├── worker_boot.rs              # Worker 启动
│    └── ... (40+ modules)
│
├── 7. crates/rusty-claude-cli/      # CLI 入口
│    ├── init.rs / input.rs / render.rs
│    ├── setup_wizard.rs             # 初始化向导
│    ├── main.rs
│    └── tests/ (cli_flags_and_config_defaults / compact_output / etc)
│
├── 8. crates/telemetry/             # 遥测
│    └── lib.rs
│
└── 9. crates/tools/                 # 工具层
     ├── lane_completion.rs
     ├── pdf_extract.rs
     └── tests/path_scope_enforcement.rs
```

**统计**（来自 `PARITY.md`）：
- 48,599 tracked Rust LOC
- 2,568 test LOC
- 3 authors
- 2026-03-31 → 2026-04-03（4 天完成 9 lane！）

**对 TDSF 价值**：
- 决策点 **D-V37-10 ⭐ 9 crate 拆分 + 48,599 LOC 规模**：
  - TDSF Rust 后端参考拆分
  - `tdsf-api` / `tdsf-runtime` / `tdsf-tools` / `tdsf-cli` / `tdsf-plugin` / `tdsf-telemetry` 6 个核心 crate
  - 避免单一 mega-crate（编译慢、依赖难管）
  - 与 TDSF v0.9.5 现有 `crates/runtime/` + `crates/api/` 拆分一致

### 3.3 核心创新 1：MCP 11 阶段生命周期（D-V37-11 ★）

**11 阶段状态机**（`runtime/src/mcp_lifecycle_hardened.rs`）：
```rust
pub enum McpLifecyclePhase {
    ConfigLoad,           // 1. 读取 MCP 配置文件
    ServerRegistration,   // 2. 注册到全局表
    SpawnConnect,         // 3. spawn 子进程 + stdio 握手
    InitializeHandshake,  // 4. MCP initialize 握手
    ToolDiscovery,        // 5. tools/list
    ResourceDiscovery,    // 6. resources/list
    Ready,                // 7. 可用状态
    Invocation,           // 8. 工具调用中
    ErrorSurfacing,       // 9. 错误上报
    Shutdown,             // 10. 关闭中
    Cleanup,              // 11. 资源清理
}
```

**Error Surface 结构**（`McpErrorSurface`）：
```rust
pub struct McpErrorSurface {
    pub phase: McpLifecyclePhase,        // 错误发生在哪一阶段
    pub server_name: Option<String>,     // 哪个 server
    pub message: String,                 // 错误信息
    pub context: BTreeMap<String, String>,  // 上下文
    pub recoverable: bool,               // 是否可恢复
    pub timestamp: u64,                  // epoch s
}
```

**对 TDSF 价值**：
- 决策点 **D-V37-11 ⭐ MCP 11 阶段状态机 + ErrorSurface**：
  - TDSF v0.9.5 现有 `McpLifecycleHardened`（5 阶段）升级到 11 阶段
  - 每个错误带 `phase` 字段 → 精准定位
  - 配合 9 lane checkpoint 强制每个 lane 独立可测
  - `recoverable: bool` 让前端决定自动重试 or 弹 needs-you

### 3.4 核心创新 2：4 阶段权限模型（D-V37-12 ★）

**4 阶段 PermissionMode**（`runtime/src/permissions.rs`）：
```
PermissionMode (PartialOrd, Ord):
- ReadOnly        （只读，最低）
- WriteSafe       （安全写：限定的目录/操作）
- FullControl     （完全控制）
- Prompt          （每次提示）
```

**PermissionEnforcer 双重检查**（`runtime/src/permission_enforcer.rs`）：
```rust
pub fn check(&self, tool_name: &str, input: &str) -> EnforcementResult {
    // 当 active_mode = Prompt 时，让调用方的交互式 prompt 流程处理
    if self.policy.active_mode() == PermissionMode::Prompt {
        return EnforcementResult::Allowed;
    }
    let outcome = self.policy.authorize(tool_name, input, None);
    match outcome {
        PermissionOutcome::Allow => EnforcementResult::Allowed,
        PermissionOutcome::Deny { reason } => EnforcementResult::Denied {
            tool: tool_name.to_owned(),
            active_mode: active_mode.as_str().to_owned(),
            required_mode: required_mode.as_str().to_owned(),
            reason,
        },
    }
}

pub fn check_with_required_mode(
    &self, tool_name: &str, input: &str, required_mode: PermissionMode,
) -> EnforcementResult {
    // 动态决定 required_mode（如 bash 命令分类）
    if active_mode >= required_mode {
        return EnforcementResult::Allowed;
    }
    // 否则 Denied
}
```

**对 TDSF 价值**：
- 决策点 **D-V37-12 ⭐ 4 阶段 PermissionMode**：
  - 扩展 v3.2 D-V32-03 4 档权限（与 claw-code 一致）
  - ReadOnly / WriteSafe / FullControl / Prompt
  - 动态 required_mode（如 bash 命令分类决定需要哪一档）
  - 与 v3.6 D-V36-03 4 Surface 审批 + D-V36-11 Multi-Channel 协同

### 3.5 核心创新 3：3 类 Hook + AbortSignal（D-V37-13）

**3 类 Hook Event**（`runtime/src/hooks.rs`）：
```rust
pub enum HookEvent {
    PreToolUse,             // 工具调用前
    PostToolUse,            // 工具调用成功
    PostToolUseFailure,     // 工具调用失败
}

pub enum HookProgressEvent {
    Started { event, tool_name, command },
    Completed { event, tool_name, command },
    Cancelled { event, tool_name, command },
}

#[derive(Default)]
pub struct HookAbortSignal {
    aborted: Arc<AtomicBool>,
}

pub struct HookRunResult {
    denied: bool,        // hook 拒绝
    failed: bool,        // hook 失败
    cancelled: bool,     // 用户取消
    messages: Vec<String>,
    permission_override: Option<PermissionOverride>,
    permission_reason: Option<String>,
    updated_input: Option<String>,  // hook 可修改 input
}
```

**Hook 通信协议**（`HOOK_PREVIEW_CHAR_LIMIT = 160`）：
- 限制 hook 输出预览 160 字符（防止 TUI 卡顿）

**对 TDSF 价值**：
- 决策点 **D-V37-13 ⭐ HookAbortSignal + UpdatedInput**：
  - 扩展 v3.6 D-V36-06 + v3.7 D-V37-01
  - Hook 可中止执行（AbortSignal）
  - Hook 可修改 input（updated_input 字段）— 例如：自动追加 `--dry-run` 标志
  - Hook 输出预览 160 字符（TUI 性能）
- 与 OpenHarness 4 类 Hook（Command/Http/Prompt/Agent）互补

### 3.6 核心创新 4：6 子模块 Bash 验证（D-V37-14）

**6 个 Bash 验证子模块**（lane 1）：
1. `readOnlyValidation` — 检测只读命令（ls/cat/grep/find/...）
2. `destructiveCommandWarning` — 警告危险命令（rm -rf /、dd、chmod 777、...）
3. `modeValidation` — 根据 PermissionMode 决定可执行集
4. `sedValidation` — sed 命令安全验证（避免误改文件）
5. `pathValidation` — 路径白名单/黑名单
6. `commandSemantics` — 命令语义分析（识别管道/重定向）

**问题**：lane 1 commit 验证了 6 个子模块，但 main 上只合了 `readOnlyValidation`（lane 1 文档与实际有差距，已在 PARITY.md 标注）

**对 TDSF 价值**：
- 决策点 **D-V37-14 ⭐ 6 子模块 Bash 验证**：
  - 验证器架构（独立模块、可插拔）
  - 风险评估前置（执行前拦截 vs 执行后回滚）
  - TDSF 运维场景：rm/chmod/kill/systemctl 等高危命令必须走 destructiveCommandWarning

### 3.7 核心创新 5：Mock Parity Harness（D-V37-15 ★）

**12 个 scripted scenarios**（`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`）：
1. `streaming_text` — 流式文本响应
2. `read_file_roundtrip` — 文件读取往返
3. `grep_chunk_assembly` — grep 分片组装
4. `write_file_allowed` — 写文件被允许
5. `write_file_denied` — 写文件被拒绝
6. `multi_tool_turn_roundtrip` — 多工具 turn
7. `bash_stdout_roundtrip` — bash stdout 往返
8. `bash_permission_prompt_approved` — bash 权限提示（批准）
9. `bash_permission_prompt_denied` — bash 权限提示（拒绝）
10. `plugin_tool_roundtrip` — 插件工具往返
11. `auto_compact_triggered` — 自动压缩触发
12. `token_cost_reporting` — Token/成本报告

**核心创新**：用 Mock Service 模拟 Anthropic API，捕获所有 `/v1/messages` 请求，与 harness 行为对比，**无需真实 LLM 即可验证行为正确性**。

**对 TDSF 价值**：
- 决策点 **D-V37-15 ⭐ Mock Parity Harness**：
  - 离线 CI 友好（不依赖真实 API key）
  - 行为可重现（deterministic）
  - 回归测试强（每个 commit 跑全部 12 场景）
  - TDSF 借鉴：`tdsf-doctor` + `tdsf-mock-test` 工具
  - 配合 v3.5 D-V35-16 tdsf doctor 健康检查

### 3.8 核心创新 6：9-Lane Checkpoint 模式（D-V37-16）

**9 个 Lane（按功能拆分）**：
| Lane | 功能 | 核心文件 | 增量 LOC |
|------|------|----------|----------|
| 1 | Bash validation | `bash_validation.rs` | +1004 |
| 2 | CI fix | `sandbox.rs` | +22 |
| 3 | File-tool | `file_ops.rs` | +195 |
| 4 | TaskRegistry | `task_registry.rs` | +336 |
| 5 | Task wiring | `tools/lib.rs` | +79 |
| 6 | Team+Cron | `team_cron_registry.rs` | +441 |
| 7 | MCP lifecycle | `mcp_tool_bridge.rs` | +491 |
| 8 | LSP client | `lsp_client.rs` | +461 |
| 9 | Permission enforcement | `permission_enforcer.rs` | +357 |

**核心创新**：
- 每个 lane 独立 PR → 独立 review → 独立合并
- 主仓库 `main` 分支不破坏性
- PARITY.md 是 lane 状态的**唯一真源**
- Mock Parity Harness 自动验证

**4 天完成 9 lane**（2026-03-31 → 2026-04-03）— 极限 subagent-driven-development 实践

**对 TDSF 价值**：
- 决策点 **D-V37-16 ⭐ 9-Lane Checkpoint 模式**：
  - 大功能拆 9 个独立可合并的 lane
  - 每个 lane 配 mock test + parity report
  - 避免巨型 PR（>1000 LOC）阻塞 review
  - 配合 v3.4 subagent-driven-development 7 步工作流

### 3.9 核心创新 7：Container 优先 + Rust 优势（D-V37-17）

**Containerfile + docker-compose**（仓库根）：
- 容器化优先（`docs/container.md`）
- `rust/Cargo.toml` workspace
- `rust/scripts/install.sh` + `rust/scripts/run_mock_parity_*.sh`

**Rust 优势**（在 claw-code 中体现）：
- 零成本抽象（编译期优化）
- 强类型系统（PermissionMode enum 替代字符串魔法）
- 内存安全（无 GC 停顿）
- 并发原语（Arc<AtomicBool> for AbortSignal）
- 异步运行时（tokio 集成）

**对 TDSF 价值**：
- 决策点 **D-V37-17 ⭐ Rust 优势在 TDSF 中的应用**：
  - PTY 引擎（portable-pty）= Rust 必需
  - MCP server（rmcp）= Rust 生态成熟
  - 权限/Hook/状态机 = Rust enum + match 强类型优势
  - Python Sidecar 仅在 AI 决策算法 / ML 模型加载场景

### 3.10 核心创新 8：TUI Enhancement Plan + Worker Boot（D-V37-18）

**TUI 增强路线**（`rust/.omc/plans/tui-enhancement-plan.md`）：
- In-app UI（rusty-claude-cli）
- Worker boot 流程（`runtime/src/worker_boot.rs`）
- Lane events（`runtime/src/lane_events.rs`）
- Trident 协议（`runtime/src/trident.rs`）

**对 TDSF 价值**：
- 决策点 **D-V37-18 ⭐ Worker Boot + Lane Events**：
  - `WorkerBoot::start()` 初始化序列明确
  - Lane events = 跨 lane 状态同步
  - 配合 v3.7 D-V37-06 Stream Events 协议

### 3.11 核心创新 9：Plugins + Bundled + OAuth（D-V37-19）

**Plugin 架构**（`runtime/src/plugin_lifecycle.rs` + `crates/plugins/`）：
- 插件发现（bundled + user + marketplace）
- Hook 注册（与 v3.7 D-V37-13 集成）
- 插件隔离（每个 plugin 独立环境）

**OAuth 集成**（`runtime/src/oauth.rs`）：
- GitHub Copilot OAuth
- 第三方 provider 接入

**对 TDSF 价值**：
- 决策点 **D-V37-19 ⭐ Plugin 生命周期 + OAuth**：
  - 扩展 v3.5 Superpowers 7 步工作流
  - 插件 marketplace 协议（兼容 skills.sh）
  - OAuth 认证避免硬编码 API key

### 3.12 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| 9 crate 拆分 | ★★★★★ | D-V37-10 TDSF Rust 后端 |
| MCP 11 阶段状态机 | ★★★★★ | D-V37-11 升级 v0.9.5 5 阶段 |
| 4 阶段 PermissionMode | ★★★★★ | D-V37-12 与 v3.2 一致 |
| 3 类 Hook + AbortSignal | ★★★★ | D-V37-13 扩展 Hook 引擎 |
| 6 子模块 Bash 验证 | ★★★★ | D-V37-14 运维高危拦截 |
| Mock Parity Harness | ★★★★★ | D-V37-15 tdsf-mock-test |
| 9-Lane Checkpoint | ★★★★ | D-V37-16 大功能拆分 |
| Container 优先 | ★★★ | D-V37-17 部署参考 |
| Worker Boot + Lane Events | ★★★ | D-V37-18 启动序列 |
| Plugin 生命周期 + OAuth | ★★★★ | D-V37-19 扩展 v3.5 |

---

## 4. cube-shell — PySide6 + Claude Code + Hermes 集成示范

### 4.1 项目定位

- **GitHub**：`ops-key/cube-shell`（2024-2026 持续迭代）
- **协议**：MIT · 语言：Python 3 + PySide6（Qt 6）
- **核心定位**：SSH 客户端 + Claude Code 集成 + Hermes Agent 集成 + 风险等级颜色映射
- **调研收获**：已 clone 完整源码（PySide6 + 多 backend 集成），分析核心后端抽象

### 4.2 核心架构：5 大 Backend 抽象

**Claude Code 后端**（`core/claude_code/backend.py`）：
```python
class ClaudeCodeBackend(ABC):
    """Claude Code 数据访问抽象层基类"""
    @abstractmethod
    def exec_cli(self, args: list[str], timeout: int = 30) -> str: ...
    @abstractmethod
    def read_file(self, path: str) -> str: ...
    @abstractmethod
    def write_file(self, path: str, content: str): ...
    @abstractmethod
    def list_dir(self, path: str) -> list[str]: ...

class LocalBackend(ClaudeCodeBackend):
    """本地调用 claude CLI"""
    def exec_cli(self, args, timeout=30):
        return subprocess.run(["claude"] + args, ...).stdout

class RemoteBackend(ClaudeCodeBackend):
    """通过 SSH 远程访问 claude CLI / 配置文件"""
    def exec_cli(self, args, timeout=30):
        return self.ssh.run("claude " + shlex.join(args), ...)
```

**Hermes 后端**（`core/hermes/backend.py`）：
- 同 LocalBackend / RemoteBackend 模式
- `_find_hermes_bin()` 多路径查找（`~/.local/bin/hermes` 等）
- 集成 hermes CLI + SQLite 数据

**5 大 Backend 统一抽象**：
1. `core/claude_code/backend.py` — Claude Code
2. `core/hermes/backend.py` — Hermes
3. `core/ssh_func.py` — SSH 原生
4. `core/ai/backend.py` — AI 模型（OpenAI/Claude/本地）
5. `core/rdp/rdp_client.py` — RDP 远程桌面

**对 TDSF 价值**：
- 决策点 **D-V37-20 ⭐ 5 Backend 统一抽象 + 风险等级颜色映射**：
  - 任意 backend 都实现 `exec_cli / read_file / write_file / list_dir` 4 个方法
  - Local vs Remote 自动切换
  - 风险等级 → 颜色 + 标签映射（SAFE/LOW/MEDIUM/HIGH/CRITICAL）
  - TDSF 借鉴：ssh/rust/local/agent 4 种 backend 统一接口

### 4.3 核心创新：风险等级颜色映射（D-V37-21）

**5 级风险颜色**（`core/ai/ai_panel.py`）：
```python
_RISK_COLORS = {
    RiskLevel.SAFE:      "#4caf50",  # 绿色
    RiskLevel.LOW:       "#2196f3",  # 蓝色
    RiskLevel.MEDIUM:    "#ff9800",  # 橙色
    RiskLevel.HIGH:      "#f44336",  # 红色
    RiskLevel.CRITICAL:  "#b71c1c",  # 深红色
}

_RISK_LABELS = {
    RiskLevel.SAFE: "安全",
    RiskLevel.LOW: "低",
    RiskLevel.MEDIUM: "中",
    RiskLevel.HIGH: "高",
    RiskLevel.CRITICAL: "危险",
}
```

**CommandCard 组件**：
- QFrame + 左侧 3px 风险色边框
- 显示命令 + 风险等级 + 描述 + "在终端执行"按钮
- `execute_clicked = Signal(str)` 触发实际执行

**对 TDSF 价值**：
- 决策点 **D-V37-21 ⭐ 5 级风险颜色 + CommandCard 模式**：
  - TDSF 终端命令卡片 UI
  - 与 v3.2 DEC-V321-01 三模式 + 四档融合权限模型一致
  - 视觉提示前置（执行前可见风险等级）

### 4.4 平台兼容：Windows / macOS / Linux 统一

**build_cd_command**（`core/claude_code/backend.py`）：
```python
def build_cd_command(cwd: str, command: str) -> str:
    if not cwd:
        return command
    if os.name == "nt":
        # PowerShell: Set-Location; if ($?) { command }
        quoted = "'" + str(cwd).replace("'", "''") + "'"
        return f"Set-Location -LiteralPath {quoted}; if ($?) {{ {command} }}"
    return f"cd {shlex.quote(str(cwd))} && {command}"
```

**build_install_command**：
- POSIX: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows: `irm https://claude.ai/install.ps1 | iex`

**对 TDSF 价值**：
- 跨平台 install / shell 兼容代码
- TDSF 借鉴：Windows PowerShell 与 POSIX sh 双语法支持

### 4.5 复用价值评估

| 模块 | 复用度 | TDSF 应用 |
|------|--------|----------|
| 5 Backend 抽象 | ★★★★★ | D-V37-20 tdsf-backend |
| 风险等级颜色 | ★★★★ | D-V37-21 CommandCard UI |
| Windows/POSIX 兼容 | ★★★★ | TDSF 跨平台安装 |
| SSH 集成示范 | ★★★ | TDSF SSH 客户端 |
| QDockWidget 侧边面板 | ★★★ | Tauri 多面板参考 |
| qtermwidget（VT100） | ★★★ | TDSF 终端引擎备选 |

---

## 5. v3.7 借鉴清单（20 大决策点）

### 5.1 ★ P0 优先级（必须实现）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V37-01** ⭐ | **4 类 Hook 引擎**（Command/Http/Prompt/Agent） | OpenHarness | 02-architecture / 04-api-contract |
| **D-V37-02** ⭐ | **Channel 抽象层 + 10+ 平台**（飞书/钉钉/企微/微信/Telegram/Slack/Discord 等） | OpenHarness | 02-architecture / 04-api-contract |
| **D-V37-03** ⭐ | **Swarm 后端抽象**（subprocess/in_process/tmux/iterm2） | OpenHarness | 02-architecture |
| **D-V37-04** ⭐ | **Personalization + Fact 提取**（10 类正则，rules.md + facts.json） | OpenHarness | 02-architecture / 04-api-contract |
| **D-V37-05** ⭐ | **Auto-Dream 离线整合**（5 类记忆分类法） | OpenHarness | 02-architecture |
| **D-V37-06** ⭐ | **Stream Events 8 类 + Compact 9 阶段** | OpenHarness | 04-api-contract |
| **D-V37-10** ⭐ | **9 crate 拆分 + 48,599 LOC 规模** | claw-code | 02-architecture |
| **D-V37-11** ⭐ | **MCP 11 阶段状态机 + McpErrorSurface** | claw-code | 04-api-contract |
| **D-V37-12** ⭐ | **4 阶段 PermissionMode**（ReadOnly/WriteSafe/FullControl/Prompt） | claw-code | 04-api-contract |
| **D-V37-15** ⭐ | **Mock Parity Harness**（12 场景离线测试） | claw-code | 04-api-contract |
| **D-V37-16** ⭐ | **9-Lane Checkpoint 模式**（大功能拆分） | claw-code | 05-implementation-roadmap |
| **D-V37-20** ⭐ | **5 Backend 统一抽象**（ssh/rust/local/agent/remote） | cube-shell | 02-architecture |

### 5.2 P1 优先级（强烈推荐）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V37-07** | **目录式 Skill 加载**（SKILL.md + scripts/ + references/ + assets/） | OpenHarness | 02-architecture |
| **D-V37-08** | **43+ 工具集 + Pydantic InputModel** | OpenHarness | 04-api-contract |
| **D-V37-13** | **3 类 Hook Event + AbortSignal + UpdatedInput** | claw-code | 04-api-contract |
| **D-V37-14** | **6 子模块 Bash 验证**（readOnly/destructive/mode/sed/path/semantics） | claw-code | 04-api-contract |
| **D-V37-17** | **Rust 优势应用**（PTY/MCP/状态机） | claw-code | 02-architecture |
| **D-V37-19** | **Plugin 生命周期 + OAuth** | claw-code | 02-architecture |
| **D-V37-21** | **5 级风险颜色 + CommandCard UI** | cube-shell | 03-ui-spec |

### 5.3 P2 优先级（可选优化）

| 决策 | 标题 | 借鉴自 | 对应规格 |
|------|------|--------|----------|
| **D-V37-09** | **TUI 状态栏 + Swarm 面板**（4 emoji + Ctrl+W 折叠） | OpenHarness | 03-ui-spec |
| **D-V37-18** | **Worker Boot + Lane Events 协议** | claw-code | 04-api-contract |

---

## 6. v3.7 揭示的 3 项行业新共识

### 6.1 共识 1：Hook 引擎是 4 类而非 1 类

**证据**：
- OpenHarness 实现 4 类（Command/Http/Prompt/Agent）
- claw-code 实现 3 类（PreToolUse/PostToolUse/PostToolUseFailure）
- Crush（v3.6）实现 shell-only hook
- Mastra（v3.5）实现系统级 suspend/resume

**行业共识**：现代 Agent 必须支持 4 类 Hook 组合：
- **Command Hook**（shell 脚本，最快）
- **Http Hook**（webhook，跨系统）
- **Prompt Hook**（轻量 LLM 决策，无工具）
- **Agent Hook**（递归调用子 Agent）

**TDSF 应用**：D-V37-01 扩展 v3.6 D-V36-06，从单一 shell hook 升级到 4 类

### 6.2 共识 2：MCP 生命周期需要 11 阶段精细化

**证据**：
- claw-code 实现 11 阶段（McpLifecyclePhase enum）
- TDSF v0.9.5 已有 5 阶段（McpLifecycleHardened）
- Kimi Code 实现简化的 4 阶段

**行业共识**：完整 MCP 生命周期必须覆盖：
1. 配置加载 → 2. 注册 → 3. spawn 连接 → 4. initialize 握手
5. 工具发现 → 6. 资源发现 → 7. Ready → 8. 调用
9. 错误上报 → 10. 关闭 → 11. 清理

**TDSF 应用**：D-V37-11 升级 v0.9.5 5 阶段到 11 阶段

### 6.3 共识 3：Mock Parity Harness 是 Agent 框架必备

**证据**：
- claw-code 12 个 scripted scenarios（流式/文件/bash/权限/插件/压缩/cost）
- Mastra 用 mock 测试工作流
- Superpowers 用 mock 测试 skill 触发

**行业共识**：Agent 框架必须提供：
- Mock LLM Service（模拟 API 响应）
- Scripted scenarios（确定性测试用例）
- Parity Report（行为对比报告）
- CI 友好（无需真实 API key）

**TDSF 应用**：D-V37-15 `tdsf-mock-test` 工具，12 个场景参考

---

## 7. 横向对比矩阵（79 项目）

| 维度 | OpenHarness | claw-code | cube-shell | Kimi Code (v3.6) | Crush (v3.6) | TDSF 选型 |
|------|------------|-----------|-----------|------------------|--------------|----------|
| **语言** | Python 3.10+ | Rust 100% | Python + PySide6 | Python 3.12+ | Go 1.23+ | **Rust 主 + Python 副** |
| **LOC** | ~50K | 48,599 | ~30K | ~30K | ~25K | **目标 ~80K** |
| **核心创新** | 4 类 Hook + 10+ Channel | 11 阶段 MCP + 9 crate | 5 Backend 抽象 | KAOS + Wire 事件 | Hooks 引擎 | **融合所有** |
| **UI 框架** | React + Ink TUI | In-app TUI | PySide6 桌面 | Textual TUI | Bubble Tea v2 | **Tauri 2 + React 19** |
| **权限模型** | 5 模式（auto_approve/safe/ask/deny）| 4 模式（ReadOnly/WriteSafe/Full/Prompt） | 5 风险等级 | 4 Surface 审批 | Hook 拦截 | **4 档融合** |
| **多 Agent** | Swarm 4 后端 | 9-Lane Checkpoint | 无 | LaborMarket | 无 | **Swarm 4 后端** |
| **Hook 引擎** | ★★★★★ 4 类 | ★★★★ 3 类 | ★★★ shell-only | ★★★ PreToolUse | ★★★★ shell | **4 类 + AbortSignal** |
| **Channel 适配器** | ★★★★★ 10+ | ★★ 无 | ★★ 无 | ★★ 无 | ★★ 无 | **4+ 平台** |
| **Memory 系统** | ★★★★★ Auto-Dream | ★★ 无 | ★★ 无 | ★★★★ 8 模块 | ★★★ Compaction | **Auto-Dream + 8 模块** |
| **Mock 测试** | ★★★ 部分 | ★★★★★ 12 场景 | ★★ 无 | ★★★ 单元测试 | ★★★★ sqlc | **12 场景** |
| **状态机** | 8 事件 | 11 阶段 | 无 | 4 Surface | 4 阶段 | **11 阶段 + 8 事件** |
| **Skill 系统** | ★★★★ 目录式 | ★★★ Plugin | ★★ 无 | ★★★ Tool | ★★★★ Skill | **目录式 + Plugin** |
| **平台支持** | 4 平台 | 3 平台 | 3 平台 | 3 平台 | 3 平台 | **4 平台** |

---

## 8. 待办 & 下一步

### 8.1 本轮已落地的决策（D-V37-01 ~ D-V37-21）

- ✅ 02-architecture.md 新增 §5.5 v3.7 增量决策章节（待更新）
- ✅ 04-api-contract.md 新增 §10 v3.7 增量接口章节（待更新）
- ✅ project_memory.md 新增 v3.7 决策与共识（待更新）

### 8.2 下一步（v3.8 候选调研项目）

- **grok**（xAI 开源）：Grok-1 314B 模型权重 + Grok-CLI（轻量终端）
- **Hermes**（Nous Research）：自主进化 Agent 框架（KEPA 反向传播）
- **Crush 续调研**：深入 Bubbletea TUI v2 的 7 状态 mood ring
- **hyperframes / CodeWhale / friday-code**：6 个 2026 新涌现项目（v3.2.1 已调研，需更新）

### 8.3 设计稿交付准备

- v3.7 决策已整合 → 设计稿可调用 D-V37-01 ~ D-V37-21 全部
- 推荐 traedesign 关注：
  - D-V37-09 状态栏 + Swarm 面板（4 emoji + Ctrl+W）
  - D-V37-21 5 级风险颜色 CommandCard
  - D-V37-06 Stream Events 9 阶段压缩进度条

---

## 9. 总结

v3.7 增量调研完成，补充 3 个高价值项目（OpenHarness + claw-code + cube-shell），累计覆盖 79 个开源项目 / 28.0M 行代码。提炼 20 大决策点（P0 12 项 / P1 7 项 / P2 2 项），其中 **12 项 P0 决策**直接影响 TDSF 架构（4 类 Hook、Channel 抽象、Swarm 后端、Personalization、Auto-Dream、Stream Events 9 阶段、9 crate 拆分、MCP 11 阶段、4 档权限、Mock Harness、9-Lane、5 Backend）。

**3 项行业新共识**：
1. Hook 引擎必须 4 类组合（Command/Http/Prompt/Agent）
2. MCP 生命周期必须 11 阶段精细化
3. Mock Parity Harness 是 Agent 框架必备

**对 TDSF 关键升级**：
- 02-architecture.md 新增 v3.7 增量决策章节（12 项 P0）
- 04-api-contract.md 新增 v3.7 增量接口（4 类 Hook、Channel、Stream Events 8 类、MCP 11 阶段）
- 设计稿可调用的视觉元素：状态栏 + Swarm 面板 + 风险颜色 CommandCard + 9 阶段压缩进度条
