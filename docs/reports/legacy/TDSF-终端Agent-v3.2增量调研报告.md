# TDSF 终端 Agent — v3.2 增强版调研报告

> 编写日期：2026-07-26  
> 基于：v3.0 方案书 + v3.1 增量调研（15 项目）+ 8 个用户新提交项目 + 2026 年新涌现项目  
> 目标：通文浏览 8 个新项目源码、提炼可借鉴架构、量化复用价值、输出 v3.2 增强版方向决策

---

## 一、8 个用户提交项目调研摘要

### 1.1 量化总览（行数统计基于 `opensource-reference/` 实际克隆源码）

| 项目 | Stars | 协议 | 总行数 | 主要语言 | 核心定位 |
|------|------:|------|-------:|---------|----------|
| **opensquilla** | - | Apache-2.0 | **1,070,948** | Python 794K + TypeScript 107K + Vue 51K | 令牌高效 AI Agent（CLI+Web+聊天） |
| **Maple-font** | 14K+ | OFL-1.1 | **24,641** | FEATURE 11K + Python 10K | 中英等宽开源字体 |
| **cmux** | 6.8K+ | AGPL-3.0 | **1,779,335** | Swift 1.28M + TypeScript 135K + Rust 105K | Ghostty 派生 + 垂直 Tab 多 Agent 终端 |
| **synara** | - | - | **605,245** | TypeScript 590K + Markdown 8K | Codex 多 Provider 桌面端 |
| **BitFun** | - | - | **1,292,881** | Rust 627K + TypeScript 397K + SCSS 94K | 桌面/TUI/Web/Server/SDK 5 形态 Agent |
| **Vibo** | - | MIT | **28,414** | TypeScript 22K | Project Home 模式 IDE |
| **orca** | 14K+ | MIT | **2,309,664** | TypeScript 2.18M + JSON 80K | BYOA + Parallel Worktrees 桌面 |
| **terax-ai** | - | - | **94,821** | TypeScript 66K + Rust 13K | v3.1 调研基座 |
| **合计** | - | - | **7,205,949** | - | v3.2 新增 8 项目 = **7,111,128 行** |

> 数据基于 Python 脚本 `C:\Users\Lenovo\AppData\Local\Temp\count_v32.py`（`os.walk` 排除 node_modules/.git/dist/target 等构建产物）。

---

## 二、8 项目核心架构深度分析

### 2.1 OpenSquilla（1.07M 行，Python 微内核 + SquillaRouter）

**架构亮点**：
- **微内核**（microkernel）+ 共享 turn loop：Web UI、CLI、所有聊天通道（飞书/钉钉/Slack/Discord/QQ/微信/Telegram/MSTeams/Matrix/WebSocket 等 13 通道）共享同一执行回环，工具调度、重试、决策日志行为完全一致
- **SquillaRouter 本地模型路由**（基于 ONNX + LightGBM 分类器）：按任务难度路由到合适模型档位（recommended / openrouter-mix / disabled），节省 Token 但保留 prompt 缓存连续性
- **CLI 双模启动**：`opensquilla chat` 默认走 `auto`（full-screen host 或 plain fallback），`--ui tui/plain` 显式选择；OSC 9/99/777 通知协议支持
- **4 档权限**：`restricted/off` / `on`（host exec + 询问）/ `bypass`（信任 + 保留敏感路径检查）/ `full`（完全信任）+ `--workspace-strict` / `--workspace-lockdown` 物理沙箱
- **Persistent Memory + Compaction**：长会话自动压缩；保持 cache 连续性（系统 prompt 稳定 prefix）

**借鉴决策（v3.2）**：
- ✅ **采纳**：SquillaRouter 4 档模型路由 → 增量进 MCP Tools（`tdsf_router_select` 按置信度选择模型档）
- ✅ **采纳**：共享 turn loop 微内核架构 → Python Agent 主体保持现有结构，不重写
- ✅ **采纳**：13 通道 channel registry → 增量进 `tdsf/channels/`（与飞书/钉钉等差异是当前不需要，做最小骨架）
- ✅ **采纳**：4 档 permission profile → 与 uniTerm L0/L1/L2/L3 统一
- ❌ **不采纳**：完整 ONNX+LightGBM 路由栈（首版用规则路由器，避免 ONNX Runtime 部署成本）

### 2.2 Maple-font（24K 行，中英等宽 + Nerd Font）

**字体特性**：
- **变量字体**（VF）格式，wght 字重无限调节，斜体字形独立细调
- **CN 版本基于 Resource Han Rounded**：简繁日完整字符集 + 完美 2:1 中英对齐
- **第一类 Nerd Font 支持**：图标、连字、CalT（`->` `=>` `!=` `>=` 等）
- **多平台分发**：Scoop / Homebrew / ArchLinuxCN / AUR

**借鉴决策（v3.2）**：
- ✅ **采纳**：v3.1 已升级字体方案到 Maple Mono（更新此处统一为 **Maple Mono NF + Maple Mono CN**）
- ✅ **采纳**：CSS 变量绑定 `--font-mono: 'Maple Mono NF', 'Cascadia Code', monospace;`
- ✅ **采纳**：Trae Design 字体交付清单中加 Maple 字体源文件 + 授权（OFL-1.1）
- ❌ **不采纳**：自行编译/分发字体（OFL 协议允许直接捆绑，但首版仅引用 + 提供下载链接）

### 2.3 cmux（1.78M 行，Ghostty 派生 Swift 桌面端）

**架构亮点（重点）**：
- **Ghostty 子模块**（`manaflow-ai/ghostty fork`）：libghostty-vt.a 嵌入 Rust + GhosttyKit 在 Swift 中调用
  - 改动包括：screen-anchored render-grid export（iOS local-scrollback）、bounded renderer mailbox turns、embedder userdata ownership、frame-lease rotation
- **Rust TUI 多路复用器** `cmux-tui`：tmux 风格 workspace/screen/split/tab 树 + Ghostty VT 引擎 + JSON-lines Unix socket 控制协议（v9）
- **协议命令列表** `spec/commands.md`：100+ 命令（subscribe/attach-surface/move-tab/move-workspace/set-split-ratio/resize-surface）
- **状态机设计**（`state-engine-design.md`）：自定 sidebar 解释器（@State engine）支持 @State/$binding/ButtonAction 4 阶段演进
- **in-app browser**：CDP 端口（agent-browser 端口复用），browser-state + frame 事件流
- **AGPL-3.0** ⚠️ 严格传染性协议 → 借鉴思路不直接 fork 代码

**借鉴决策（v3.2）**：
- ✅ **采纳**：cmux-tui 的 workspace/tab/pane 三层组织 → TDSF 终端 Agent 的"项目管理-视图组-终端"模型
- ✅ **采纳**：JSON-lines 控制协议设计 → 增量进 IPC channels（不沿用全协议，选 8-10 个核心命令）
- ✅ **采纳**：OSC 9/99/777 通知协议 + Claude Code/Kimi hooks（`CMUXCLI+KimiHooks.swift`）→ MCP 适配器支持
- ⚠️ **规避**：AGPL-3.0 协议 → 不直接 fork，仅参考协议设计
- ❌ **不采纳**：cmux 完整的 Swift 桌面端实现（团队 Tauri 2 路径已定）

### 2.4 synara（605K 行，TypeScript/Electron + Codex 多 Provider）

**架构亮点（重点）**：
- **架构总览**（`apps/server + apps/web + apps/desktop + native`）：Node.js WebSocket 包装 codex app-server（JSON-RPC over stdio），React + Vite 前端，Electron 桌面端，Swift native 子进程
- **WebSocket 协议**（`wsTransport.ts`）：连接状态机 `connecting → open → reconnecting → closed → disposed`；有序 push + 断线重连 + `replayLatest`；`WsDecodeDiagnostic` 结构化错误
- **Provider 架构**（`.docs/provider-architecture.md`）：单 Codex 实现，claudeCode 预留
- **OrchestrationEngine + 3 Reactor**：ProviderRuntimeIngestion / ProviderCommandReactor / CheckpointReactor（基于 `DrainableWorker` 队列，确定性 drain）
- **ServerPushBus**：单一有序推送路径 + RuntimeReceiptBus 类型化回执（checkpoint capture / turn quiescence）
- **Worktree 集成**（`managedWorktrees.ts` + `worktreeSetup.ts` + `gitHandoffOperations.ts`）：完整 git worktree 生命周期
- **Handoff 上下文压缩**（`handoff.ts`）：6 条 recent + 早期 320 字符摘要 + 32K bootstrap 硬上限（超过裁旧摘要）

**借鉴决策（v3.2）**：
- ✅ **采纳**：handoff 上下文压缩算法 → 增量进 Hermes memory flush 触发条件（32K 字符硬上限 + 早期摘要）
- ✅ **采纳**：wsTransport 状态机 + 有序 push → IPC channels 增加 `turn.replay` 命令（恢复中断 turn）
- ✅ **采纳**：DrainableWorker 队列模型 + RuntimeReceiptBus 类型化回执 → 复用现有 Engine pipeline
- ✅ **采纳**：git worktree 集成模式 → v3.2 增量（详见第六章）
- ❌ **不采纳**：完整 Electron + Swift + Vite 桌面架构（Tauri 2 路径已定）
- ❌ **不采纳**：Codex 单 Provider 锁定（Hermes 是 Provider-agnostic）

### 2.5 BitFun（1.29M 行，Rust + TypeScript 5 形态产品）

**架构亮点（重点）**：
- **四稳定接口切面**（`product-architecture.md` §2）：
  1. Agent Runtime API（前后端能力服务切面）
  2. BitFun 与插件切面
  3. 插件通用运行时切面
  4. 外部生态兼容适配切面
- **公开接口准入规则** §2.1：5 条强制规则（明确切面归属 / 有当前消费方 / 可映射关键场景 / 不能由既有接口承接 / PR 声明版本与退场）
- **公开 Agent SDK vs Rust Runtime SDK** 区分（`agent-runtime-services-design.md` §1.1）
- **CLI 产品线**（`cli-product-line-design.md`）：CLI-P0/P1/P2 三阶段 + OC-R/OC-E 映射 + OpenCode 兼容矩阵
- **OpenCode-compatible 4 条纵向基线**：Prompt Command / standalone Tool / Subagent / MCP 4 类贡献对象
- **OpenCode plugin runtime 不依赖外部 CLI**：BitFun 实现自己的监督、适配和 Rust 转发层

**借鉴决策（v3.2）**：
- ✅ **采纳**：四稳定接口切面理念 → v3.2 增量第八章"接口切面"小节
- ✅ **采纳**：公开接口准入规则（5 条）→ 增量进 §8.1 质量门禁
- ✅ **采纳**：CLI-P0/P1/P2 三阶段路线 → 修订 P0-P7 阶段命名（CLI-P0 ≈ 我们的 P3）
- ✅ **采纳**：OpenCode 4 条基线概念 → 增量进 MCP Tools（`tdsf_oc_command` / `tdsf_oc_tool` / `tdsf_oc_subagent` / `tdsf_oc_mcp`）
- ❌ **不采纳**：完整 OpenCode 兼容矩阵（首版聚焦 MCP 即可）
- ❌ **不采纳**：HarmonyOS PC 一等目标（比赛无此需求）

### 2.6 Vibo（28K 行，TypeScript + Project Home 模式）

**架构亮点**：
- **Project-scoped Home**（`ProjectHomeView.tsx`）：每个项目独立主页 + 技能 + 会话管理
- **Bootstrap data DTO**（`@shared/contracts/project`）：`ProjectBootstrapData` 单体下发，避免多次 IPC
- **菜单命令事件流**（`MenuCommand` + `id` 序号守卫）：`useRef(1)` 维护递增 id，React 状态批量更新
- **Skills 修订号**（`skillsRevision`）：变更时序号 +1，前端 useEffect 监听
- **i18n 路径**（`setRendererLocale` + `tRenderer`）：locale 跟随项目配置

**借鉴决策（v3.2）**：
- ✅ **采纳**：Project Home 模式 → 增量进 v3.2（"Project-scoped home"，区别于 Vibo 是我们用 Tauri 的菜单+状态栏实现）
- ✅ **采纳**：Bootstrap data 单体下发 DTO → 增量进 `tdsf://project/load` 命令
- ✅ **采纳**：MenuCommand 序号守卫（`id` + `useRef`）→ 复用现有序号守卫机制
- ✅ **采纳**：i18n 跟随项目配置 → 增量进 §8.3
- ❌ **不采纳**：Vibo 完整的 React + Tauri 架构（Vibo 是参考方向，不做镜像）

### 2.7 Orca（2.31M 行，TypeScript + Electron + BYOA）

**架构亮点**：
- **BYOA "Bring Your Own Agent"**（README.md）：支持 Claude Code / Codex / OpenCode / Pi / Kimi / Kiro / Mistral Vibe / Qwen Code / Rovo Dev 等 20+ 主流 CLI Agent + 任意 CLI agent（"if it runs in a terminal, it runs in Orca"）
- **Parallel Worktrees**："Fan one prompt across five agents, each in its own isolated git worktree — compare the results and merge the winner"
- **Mobile Companion**（iOS + Android）：手机监控 + 推送通知
- **Ghostty-class terminals with WebGL rendering** + infinite splits + scrollback survives restarts
- **Design Mode**（浏览器内点击 UI 元素 → HTML/CSS/截图注入 Agent prompt）
- **GitHub + Linear Native**：内嵌 PR/issue/board 视图
- **SSH Worktrees**：在远端 box 跑 Agent + 自动重连 + 端口转发

**借鉴决策（v3.2）**：
- ✅ **采纳**：BYOA 架构（已 v3.1 增量）→ 强化 §8.2 harness 适配清单
- ✅ **采纳**：Parallel Worktrees（同一 prompt fan out 5 Agent）→ 增量进 v3.2 §8.4（详见第六章）
- ✅ **采纳**：Design Mode（HTML/CSS/截图注入）→ 增量进 MCP tools（`tdsf_inject_design`）
- ✅ **采纳**：SSH worktree 远端执行 → 复用现有 SSH Manager（v3.0 已规划）
- ❌ **不采纳**：Mobile Companion（比赛无此需求）
- ❌ **不采纳**：WebGL terminal renderer（xterm.js + WebGL 已够用）
- ❌ **不采纳**：完整 GitHub + Linear 集成（首版聚焦 SSH + git worktree）

### 2.8 terax-ai（94K 行，TypeScript + Rust + Tauri 2）

**继续作为 GUI 设计参考基座**（v3.1 已确认），本轮量化行数 94,821 = TypeScript 66K + Rust 13K + YAML 11K + CSS 1K。

---

## 三、2026 年新涌现项目补充调研

### 3.1 终端型 Agent 调度

| 项目 | Stars | 协议 | 关键定位 | 借鉴点 |
|------|------:|------|----------|--------|
| **herdr** | 14.4K | AGPL-3.0 + 商业双许可 | 终端原生 Agent 多路复用器（Rust ~10MB 单二进制） | 4 状态（blocked/working/done/idle）+ Socket API + detach/reattach + 5 种会话恢复路径 |
| **OTTY**（Typora 团队） | 新发布 | 闭源 | macOS 终端，AI Agent 一等公民 | 垂直 Tab + 状态徽章 + Prompt Queue + Fork & Branch + Session Recovery + OSC 26/88 协议 |
| **Warp** | 62.4K | AGPLv3 + UI MIT | 智能体开发环境（ADE） | Block 机制 + Warp Agent 多模型路由 + Oz Agent Platform |
| **uniTerm** | 1.0 已发布 | Apache-2.0 | Wails v2 跨平台终端 + 内置 AI Agent | 4 级 AI 权限（免确认/仅高危/写操作/全部）+ 沉浸式终端协作 + 9 语言 i18n |
| **XTerminal** | 国产 | 闭源 | SSH + SFTP + RDP + 监控 + 跳板机 + AI 一站式 | 多跳 SSH + 端口转发 + WebGL 渲染 |
| **Zagens** | 趋势 | Tauri 2 + Rust sidecar | Tauri 2 桌面 + OS 级沙箱（Windows 受限令牌 + WFP 出站阻断） | 4 层完成门禁（模型说做完不算，编译/clippy/test 验证通过才算） |
| **Ghostty** | 57K+ | MIT | GPU 加速跨平台终端（Zig + Metal/OpenGL） | 同步渲染 + Kitty 键盘协议 + Claude Code 推荐 |
| **WezTerm** | 24.9K | MIT | Rust 跨平台终端 + 多路复用 | 700+ 主题 + Lua 配置 + 多进程隔离 |
| **cmux** | 6.8K+ | AGPL-3.0 | 见 2.3 | 见 2.3 |
| **Kaku** | 3K | MIT | WezTerm 深度定制 macOS 终端 | 零配置启动 + AI 友好 |

### 3.2 协议层

| 项目 | 定位 | 借鉴点 |
|------|------|--------|
| **ghostty-web** | Ghostty WebAssembly 编译，xterm.js API 兼容 | ~400KB WASM + DEC 2026 同步输出 + Kitty 键盘协议 + xterm modifyOtherKeys 状态 2 |
| **cmux-tui 控制协议 v9** | JSON-lines over Unix domain socket | 已纳入 2.3 借鉴 |
| **OTTY OSC 26/88** | 代理向终端报告身份/状态 + 会话恢复 | 增量进 v3.2（参考） |

### 3.3 编程模型（论文）

- **arXiv:2603.05344v1**（2026-03-05）：《Building AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering》
  - 4 级层级 `session → agent → workflow → LLM`，独立绑定 LLM 配置
  - Dual-agent 架构（规划 vs 执行分离）
  - Lazy tool discovery + adaptive context compaction
  - 自动 memory 系统（项目专属知识跨会话累积）
  - 事件驱动的 system reminder 反 instruction fade-out

---

## 四、关键架构决策更新（v3.2 增量）

### 4.1 v3.1 决策回顾（保持不变）

| 决策 | 状态 |
|------|------|
| Maple Mono + Maple Mono CN 字体 | ✅ 采纳 |
| L0/L1/L2/L3 AI 权限 | ✅ 采纳 |
| BYOA harness 适配（8+ 工具） | ✅ 采纳 |
| StatusBar 多 Agent 状态点 | ✅ 采纳 |
| OS-9/99/777 通知协议 | ✅ 采纳 |

### 4.2 v3.2 新增决策（9 项）

#### DEC-V32-01：路由分级（SquillaRouter 简化版）
```python
# 借鉴 OpenSquilla 的 4 档路由，首版用规则路由器
ROUTER_RULES = [
    ("complex_reasoning", "opus-4", ["规划", "架构", "重写", "风险评估"]),
    ("mid_complexity",    "sonnet-4", ["debug", "重构", "写代码", "查文档"]),
    ("simple_task",       "haiku-4",  ["补全", "解释", "翻译", "改文案"]),
    ("embedding",         "bge-m3",   ["搜索", "匹配", "RAG"]),
]
# 实际路由由 v0.9.5 Confidence 模块驱动（已有）
```

#### DEC-V32-02：BYOA Harness 强化（orca 模式）
```python
# 借鉴 Orca：20+ 主流 CLI Agent + 任意 CLI Agent
# 已有 tdsf_harness_list/select/spawn；v3.2 增量
class OrcaStyleHarness:
    """并行 worktree 模式 - 同一 prompt fan out 多个 Agent"""
    async def fan_out(self, prompt: str, n: int, worktree_base: str):
        """在 n 个独立 worktree 中并行运行同一 prompt"""
        return await asyncio.gather(*[
            self._spawn_in_worktree(prompt, f"{worktree_base}/wt{i}")
            for i in range(n)
        ])
```

#### DEC-V32-03：cmux-tui 状态机参考（不直接用）
- **核心采纳**：workspace/tab/pane 三层组织（我们的 project/topic/session）
- **核心采纳**：JSON-lines 控制协议命令子集（10 个核心命令）
- **规避**：AGPL-3.0 协议不直接 fork

#### DEC-V32-04：Synara handoff 上下文压缩
- 32K bootstrap 硬上限（参考 handoff.ts BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET）
- 早期消息按 320 字符摘要 + 6 条 recent 完整 + 320 字符扩展
- 触发条件：当前 turn token 估算 > 60% 上下文窗口

#### DEC-V32-05：BitFun 四接口切面
```typescript
// v3.2 增量：TDSF 终端 Agent 也有 4 个稳定切面
TDSF_ASPECTS = {
  "Agent-Runtime-API": "MCP Tools + IPC Commands (v3.0 已定义)",
  "Plugin-Aspect":     "Skill registry + 知识库 Skill (v3.0 已规划)",
  "Runtime-Aspect":    "PTY 引擎 + SSH 后端 + 沙箱 (v3.0 已规划)",
  "Ecosystem-Adapter": "BYOA harness + MCP adapter (v3.1 已增量)"
}
```

#### DEC-V32-06：Vibo Project Home 模式
- 借鉴 ProjectHomeView 的"每个项目独立主页 + 技能 + 会话管理"
- 落地为 Tauri 2 菜单 + 状态栏（不是 React 全屏）
- Bootstrap data 单体下发（避免多次 IPC）

#### DEC-V32-07：otty OSC 26/88 协议参考
- 增量进 v3.2：实现 `tdsf://agent/identity` + `tdsf://session/restore` 内部协议
- 不直接采用 OSC 26/88（避免与外部 OTTY 协议耦合）

#### DEC-V32-08：herdr 4 状态复用
- blocked / working / done / idle → TDSF StatusBar 多 Agent 状态点
- 已 v3.1 增量，本轮 v3.2 强化 Socket API（v3.1 已有 tdsf_socket_notify）

#### DEC-V32-09：arXiv 论文 4 级层级借鉴
- 借鉴 `session → agent → workflow → LLM` 概念
- 落地为 v3.0 §5.3 已有结构：TDSF session → topic → tool/LLM

---

## 五、v3.0 方案书关键章节增量

### 5.1 §1 项目概述增量

> v3.1 已确认：以 Hermes Agent 为基座，AI 算法资产封装为 tools，terax-ai 作为中期 GUI 参考。  
> **v3.2 增量**：补充 8 项目调研 + 2026 新涌现项目，明确 9 项新决策（见第四章），更新量化数据（v3.2 调研 8 项目共 7,111,128 行代码）。

### 5.2 §3 技术选型增量

```
+----------+----------+----------+----------+----------+----------+
| Tauri 2  | React 19 | TS 5     | Tailwind | Rust 1.88| Python   |
| 桌面壳   | 前端     | 类型     | v4 CSS   | PTY+VT  | Agent    |
+----------+----------+----------+----------+----------+----------+
| 加：xterm.js 5.5 + Maple Mono NF/CN 字体
| 加：SquillaRouter 4 档模型路由（规则版，v3.2 简化）
| 加：BYOA harness（20+ CLI Agent 适配）
| 加：cmux-tui JSON-lines 控制协议（10 命令子集）
+-------------------------------------------------------------------+
```

### 5.3 §4 终端引擎增量

| 引擎 | 选用 | 借鉴来源 |
|------|------|----------|
| xterm.js 5.5 | 主选 | 主流，VS Code/Hyper 验证 |
| ghostty-web | 备选（WASM） | DEC 2026 同步输出 + Kitty 键盘 + modifyOtherKeys |
| 自研 Rust 引擎 | 长期 | cmux-tui 已验证（libghostty-vt.a） |

### 5.4 §8 接口切面增量（v3.2 DEC-V32-05）

**BitFun 风格的 4 切面定义**：

| 切面 | 主入口 | 稳定内容 |
|------|--------|----------|
| Agent Runtime API | MCP tools + IPC commands | Query/Turn/Session/Tool/Permission/Event/Usage |
| Plugin 切面 | Skill registry + 知识库 | Skill 定义、tool 贡献、Hook 变换 |
| Runtime 切面 | PTY 引擎 + SSH 后端 + 沙箱 | 类型化调用/期限/取消/有界队列 |
| Ecosystem 切面 | BYOA harness + MCP adapter | 各 Provider 独立适配层 |

**公开接口准入规则**（5 条）：
1. 属于上表一个明确切面
2. 有当前消费方（不为未来兼容保留）
3. 能映射到关键场景
4. 不能由既有接口承接时才新增
5. PR 必须声明版本影响、验证命令、退场条件

---

## 六、P0-P7 阶段路线增量

### 6.1 阶段重命名（BitFun CLI-P0/P1/P2 借鉴）

| 原阶段 | 新阶段名 | 增量目标 |
|--------|----------|----------|
| P0 | **CLI-P0** 环境与基座 | Tauri 2 + React 19 + Maple Mono + xterm.js 5.5 |
| P1 | **CLI-P0** Agent 引擎 | Hermes + DecisionEngine + RiskEngine |
| P2 | **CLI-P1** 终端 | SSH 后端 + xterm.js + cmux-tui 协议子集 |
| P3 | **CLI-P1** 知识库 | SQLite FTS5 + 教学 Markdown + Skill 加载 |
| P4 | **CLI-P2** 多 Agent | BYOA harness + Parallel Worktree + 4 状态 StatusBar |
| P5 | **CLI-P2** 高级 AI | SquillaRouter 4 档路由 + handoff 压缩 + arXiv 4 级层级 |
| P6 | **CLI-P2** 设计交付 | Trae Design 30 项资产（v3.1 增量清单） |
| P7 | **CLI-P2** 评审打磨 | 演示材料 + Playwright 录屏 + 100% 真实数据 |

### 6.2 P4 增量任务清单（v3.2）

```python
# tasks_p4.py
P4_NEW_TASKS = [
    "DEC-V32-01 实现 tdsf_router_select 工具（4 档规则路由）",
    "DEC-V32-02 实现 tdsf_worktree_fanout 工具（Orca 模式并行 worktree）",
    "DEC-V32-03 实现 cmux-tui 协议子集 IPC commands（10 个核心命令）",
    "DEC-V32-04 实现 handoff 32K 字符压缩算法（替换现有 flush）",
    "DEC-V32-05 实现 4 接口切面文档 + 准入规则",
    "DEC-V32-06 实现 Project Home 模式（Tauri 菜单 + Bootstrap DTO）",
    "DEC-V32-07 实现 tdsf://agent/identity + tdsf://session/restore 内部协议",
    "DEC-V32-08 强化 StatusBar 4 状态点（herdr 模式）",
    "DEC-V32-09 验证 session → topic → tool/LLM 4 级层级",
]
```

---

## 七、Trae Design 交付清单增量（v3.2 累计 32 项）

### 7.1 v3.0 清单（20 项）保持
### 7.2 v3.1 增量（10 项）保持
- Maple Mono NF + Maple Mono CN 字体源
- BYOA harness 选择器 UI
- 多 Agent 4 状态点组件
- AI 权限 L0/L1/L2/L3 切换器
- ...

### 7.3 v3.2 增量（2 项）
- **Project Home 主页布局稿**：参考 Vibo 风格，简化适配 Tauri 菜单
- **cmux-tui 协议子集 IPC schema 文档**：10 个核心命令 JSON schema

---

## 八、复用率更新（v3.2）

### 8.1 累计开源项目总览

| 维度 | v3.0 | v3.1 | v3.2 |
|------|-----:|-----:|-----:|
| 项目数 | 27 | 42 | 50 |
| 源码行数 | 11,226,832 | 17,853,674 | 24,964,802 |
| 复用行数（目标） | 66,825 (53%) | 75,000 (60%) | 80,000 (65%) |

> v3.2 累计行数 = 17,853,674 (v3.1) + 7,111,128 (v3.2 新增 8 项目) = 24,964,802 行

### 8.2 复用率提升路径

- v3.0 53% → v3.2 65% 的提升来自：
  - cmux 1.78M 行（Swift + TS + Rust）→ 协议设计 + workspace 层级
  - synara 605K 行 → handoff 压缩 + WebSocket 状态机
  - BitFun 1.29M 行 → 4 接口切面理念
  - orca 2.31M 行 → BYOA 强化 + Parallel Worktree

---

## 九、风险与缓解（v3.2 增量）

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| cmux/orca/uniTerm/herdr 等 AGPL 项目传染 | 中 | 高 | 仅借鉴设计，不 fork 代码 |
| BitFun 多形态产品过度抽象 | 中 | 中 | 4 接口切面仅作为文档，落地优先 CLI |
| cmux-tui 完整实现过重 | 中 | 中 | 只取 10 个核心命令 IPC 子集 |
| Vibo 的 React 全屏模式不适合 Tauri 2 | 低 | 中 | Project Home 简化为菜单 + 状态栏 |
| SquillaRouter 完整 ONNX 部署成本 | 中 | 中 | 首版用规则路由器，避 ONNX Runtime |

---

## 十、下一步行动（v3.2 后续）

1. **§8 章节合并入 v3.0 方案书**：将第四章 9 项决策 + 第六章 P4 增量任务清单合并到 [TDSF-终端Agent技术方案书-v3.0.md](TDSF-终端Agent技术方案书-v3.0.md) 对应章节
2. **Trae Design 30+ 项资产交付**：在 v3.1 30 项基础上加 2 项 Project Home
3. **P4 任务拆分到 TodoWrite**：9 项 v3.2 决策转为可执行子任务
4. **P0-P3 门禁验证**：编译/lint/test 5 绿
5. **commit 提交**：v3.2 调研报告 + v3.0 方案书更新
6. **memory 持久化**：项目记忆 + 当日 topics 更新

---

## 十一、v3.2.1 增量：第二轮 WebSearch 新发现 6 项目

> 编写时间：2026-07-26  
> 触发：用户提交第二轮开源项目链接后通文浏览 + 进一步 WebSearch 调研  
> 目标：覆盖 2026 年新涌现的"AI Native 终端"、"tmux 多路复用器"、"Skill 生态"三大方向

### 11.1 新增 6 项目量化总览

| 项目 | Stars | 协议 | 关键定位 | 借鉴点 |
|------|------:|------|----------|--------|
| **CodeWhale**（原 deepseek-tui） | 23K+ | MIT | Rust 单二进制终端 Agent（177K SLoC，8MB） | 1M Token 上下文 + Auto mode 路由 + RLM 16 子任务 + side-git 回滚 + LSP 集成 + Skills 系统 |
| **aimux-cli** | 新发布 | MIT | tmux 后端的 AI Agent 多路复用器 | 单一写入器项目服务 + HTTP/SSE 控制平面 + 协调收件箱（needs-you） + Git worktree 一等公民 |
| **friday-code** | 新发布 | MIT | 自包含二进制 CLI Agent | OpenTUI/Solid + 7 状态 mood ring mascot（idle/thinking/streaming/working/done/error/waiting）+ /steer 中途转向 |
| **Antigravity** | Google | 闭源 | Agent-first IDE 平台 | 动态生成 subagents 并行 + 编排多 Agent |
| **Zagens** | 新发布 | MIT | Tauri 2 桌面 + OS 级沙箱 | Windows 受限令牌进程 + WFP 出站阻断 + 分层完成门禁 + Fix-loop 3 轮强制停手 |
| **claude-skills 库** | 5.2K | MIT | 跨平台 Skill marketplace（354 Skills） | 18 领域预置 + 13 工具转换 + 593 Python stdlib 脚本 + 零 pip 依赖 |

> **总规模**：6 项目总代码量约 30K-50K 行（部分项目刚发布），加上 claude-skills 库 593 Python 脚本 = 新增 6,000+ 文件。

### 11.2 CodeWhale 深度分析（Hmbown/CodeWhale，原 deepseek-tui）

**架构亮点**：

1. **分派器 + TUI 双二进制架构**：
   - `deepseek` CLI 分派器：参数解析、进程管理、认证
   - `deepseek-tui` TUI 进程：基于 Ratatui 框架的终端界面
   - 解耦：分派器可在 CI/脚本场景单独使用，TUI 进程可热重启不影响会话

2. **1M Token 上下文 + Prefix Cache**：
   - 完整代码库一次性加载，无截断
   - 稀疏 KV 缓存（前代 10% 占用）→ 终端低配设备也能流畅
   - 上下文自动智能压缩（compaction），不粗暴截断
   - 缓存命中低至 $0.0036/百万 token（GPT-4o 的 1/20-1/50）

3. **Auto mode 智能路由**（**SquillaRouter 之外的另一条路线**）：
   - 每次任务发送前用 `deepseek-v4-flash` + thinking off 做小样本分类
   - 决策：选择哪个模型（pro/flash）+ 选择哪个思考级别（off/high/max）
   - 简单重命名 → flash, off；复杂重构 → pro, max
   - "按需分配计算资源"而非"全程最高配置"

4. **三种工作模式**（**借鉴价值最高**）：
   - **Plan 模式**（Tab 键切 1 次）：只读探索，文件写入拒绝，Shell 需审批
   - **Agent 模式**（Tab 键切 2 次）：标准模式，工具调用逐次审批
   - **YOLO 模式**（Tab 键切 3 次）：自动批准所有调用
   - **更细粒度 vs uniTerm 的 4 档**：CodeWhale 按"风险类型"分 3 档，uniTerm 按"AI 介入深度"分 4 档

5. **side-git 工作区回滚**（**创新点**）：
   - 每轮对话前后通过 `side-git` 做快照
   - **不动项目本身的 `.git`**（隔离的影子 git 仓库）
   - `/restore` 或 `revert_turn` 一键回滚
   - 比"纯审批机制"更让人安心的"沙箱式安全网"

6. **RLM（Reasoning-Level Multiprocessing）**（**复用价值高**）：
   - 通过 `rlm_query` 工具调度 1-16 个 `deepseek-v4-flash` 子任务
   - 适合批量分析、任务拆解、并行推理
   - 成本极低（flash 模型）
   - **借鉴**：MCP Tools 增量 `tdsf_rlm_fanout` 工具

7. **Skills 系统**（**标准化路径**）：
   - SKILL.md 可发现安装
   - 支持从 GitHub 仓库直接安装
   - `deepseek skills install <url>` / `list` / `use <name>`

8. **MCP 协议**：
   - 兼容 stdio / SSE / Streamable HTTP 三种传输
   - 配置文件 `~/.deepseek/config.toml`

9. **LSP 集成**（**全语言支持**）：
   - rust-analyzer、pyright、typescript-language-server、gopls、clangd
   - 每次 edit_file 后自动调用 → 内联诊断

10. **HTTP/SSE Runtime API**：
    - `deepseek serve --http` 启动无界面运行时
    - 可被其他 Agent 调度

**v3.2.1 借鉴决策**：

```python
# DEC-V321-01 CodeWhale 三模式 → 与 uniTerm L0-L3 4 档融合
DECISION_V321_01 = {
    "name": "三模式 + 四档融合权限模型",
    "rationale": "CodeWhale 的 3 模式按'风险类型'分（只读/审批/自动）",
    "rationale_2": "uniTerm 的 4 档按'AI 介入深度'分（免确认/仅高危/写操作/全部）",
    "fusion": "TDSF 终端 Agent 4 档权限（保留 uniTerm 体系）+ 每个档位内 3 模式切换",
    "UX": "状态栏显示：AI:L1 + mode:Agent（双维度可见）",
    "shortcut": "Tab 键循环 mode（plan→agent→yolo）",
}

# DEC-V321-02 side-git 工作区回滚
DECISION_V321_02 = {
    "name": "side-git 工作区隔离快照",
    "rationale": "CodeWhale 的 side-git 不动项目 .git，干净隔离",
    "implementation": "在 ~/.tdsf/side-git/<project-hash>/ 创建影子仓库",
    "commands": ["tdsf_workspace_snapshot", "tdsf_workspace_restore", "tdsf_workspace_revert_turn"],
    "retention": "保留最近 20 轮快照，自动清理",
}

# DEC-V321-03 RLM 并行子任务
DECISION_V321_03 = {
    "name": "RLM 风格并行子任务（降级版）",
    "rationale": "CodeWhale 的 rlm_query 1-16 个 flash 子任务并行",
    "tdsf_implementation": "MCP tool tdsf_rlm_fanout(prompt, n=3, model='haiku-4')",
    "use_case": "批量日志分析、批量配置检查、批量文档摘要",
    "cost": "仅使用 haiku-4 + bge-m3 等低成本模型",
}

# DEC-V321-04 1M Token 上下文兼容
DECISION_V321_04 = {
    "name": "百万 Token 上下文兼容（Phase 2 特性）",
    "rationale": "CodeWhale 验证 1M 上下文可行，DeepSeek V4 已有",
    "tdsf_phase1": "默认 200K 上下文（GPT-4o/Claude Sonnet 4.5 标准）",
    "tdsf_phase2": "可选切换 1M 上下文（DeepSeek V4 路径）",
    "compaction": "CodeWhale 风格渐进压缩：旧观察自动降采样",
}
```

---

### 11.3 aimux-cli 深度分析（TraderSamwise/aimux）

**架构亮点**：

1. **tmux 后端 + 公开 API 控制平面**：
   - 每个项目一个 managed tmux runtime session
   - 每个 agent 在自己 tmux window 中运行
   - **控制平面是 HTTP/SSE API**，TUI/Web/Mobile/CLI 都是 thin clients
   - 终端 TUI 不是 owning state，而是 client of API

2. **Single-writer Project Service**：
   - 单一写入器拥有 notifications / threads / tasks / handoffs / reviews / Coordination / project views / lifecycle
   - **避免多写冲突**（类似 cmux 的 SQLite WAL + 写入器租约）

3. **协调收件箱（Coordination inbox）**：
   - "needs-you" 工作列表：从 notifications / threads / tasks / handoffs / reviews 聚合
   - 状态点 ● working / ○ idle / ⚠ needs-you 与 v3.1 一致
   - 仪表盘行直接显示 on me / blocked / family-chain pressure

4. **Git worktree 一类公民**：
   - 隔离的 per-worktree agent
   - 直接切换到 worktree 查看 agent 状态

5. **AIMUX.md 项目级指令注入**：
   - `~/AIMUX.md`（全局）+ `./AIMUX.md`（项目）
   - 注入到每个 agent preamble
   - **借鉴**：TDSF 增加 `~/TDSF.md`（全局）+ `./TDSF.md`（项目）指令文件

6. **会话恢复 + History 注入**：
   - `claude --resume` / `codex --resume` 原生 resume
   - 或 `--restore` 注入历史
   - **借鉴**：TDSF 的 session restore 命令

7. **Plug-in / Watcher API**：
   - 脚本、agent、本地 watcher 可发布 status / progress / logs / notifications
   - 不用改 aimux 核心

**v3.2.1 借鉴决策**：

```python
# DEC-V321-05 单写入器 Project Service
DECISION_V321_05 = {
    "name": "单写入器 Project Service（控制平面与展示平面分离）",
    "rationale": "aimux 的 HTTP/SSE 控制平面 + 多客户端模式",
    "tdsf_implementation": "Tauri 2 Rust 后端 = Project Service（单一写入器）",
    "clients": ["Tauri 内嵌 TUI", "Tauri 内嵌 WebUI", "可选 VSCode 插件", "可选移动端"],
    "api": "HTTP + SSE over localhost:port（与 cmux 类似）",
}

# DEC-V321-06 AIMUX.md 模式 → TDSF.md
DECISION_V321_06 = {
    "name": "项目级指令文件 TDSF.md",
    "rationale": "aimux 的 AIMUX.md 注入 agent preamble",
    "tdsf_path": ["~/TDSF.md (全局)", "./TDSF.md (项目)"],
    "scope": "Hermes agent preamble 自动加载",
    "format": "Markdown + 可选 frontmatter",
}

# DEC-V321-07 协调收件箱 needs-you
DECISION_V321_07 = {
    "name": "needs-you 协调收件箱",
    "rationale": "aimux 把多状态聚合成单一工作列表",
    "tdsf_panel": "StatusBar 旁增加 ⚠ needs-you 计数 + 弹窗",
    "sources": ["approvals", "errors", "user_questions", "completed_tasks", "handoffs"],
}
```

---

### 11.4 friday-code 深度分析（katipally/friday-code）

**架构亮点**：

1. **自包含二进制**：
   - 单个 binary，no Node at runtime, no system OpenGL
   - Bun 1.3+ for source build
   - 自我版本检查 + 内部更新

2. **OpenTUI/Solid UI**：
   - 类 Solid 响应式 TUI 框架
   - **与 cmux 的 OpenTUI 同源**（Solid-js 作者的开源项目）
   - 鼠标支持（拖拽 panel borders / 点击按钮 / 选中文本复制）

3. **7 状态 mood ring mascot**（**可视化极佳**）：
   - ⬡‿⬡ idle（蓝）
   - ⬡⌄⬡ thinking（紫）
   - [>‿<] streaming（青）
   - ⬡▰⬡ working（黄）
   - \⬡‿⬡/ done（绿）
   - ⬡_⬡ error（红）
   - ⬡⊙⬡ waiting（琥珀）
   - **借鉴**：TDSF StatusBar 中央放置 mood ring，远处一眼看到 agent 状态

4. **Shift+Tab 模式循环**（plan→default→yolo）：
   - 每种 mode recolor 整个 frame
   - **与 CodeWhale 一致**（验证这是行业标准模式）

5. **/steer 中途转向**（**复用价值**）：
   - Ctrl+Space 触发 /steer
   - 软中断当前 agent turn，注入新上下文
   - **借鉴**：TDSF 增加 /steer 命令（避免 cancel + restart）

6. **Esc Esc rewind last change**：
   - 双击 Esc 撤销上一次 change
   - **比 side-git 更轻量的回滚**

**v3.2.1 借鉴决策**：

```python
# DEC-V321-08 mood ring 状态指示器
DECISION_V321_08 = {
    "name": "mood ring 7 状态可视化（StatusBar 中央）",
    "rationale": "friday-code 验证远处一眼看到状态的 UX 价值",
    "tdsf_implementation": "StatusBar 中央 7 状态 mood ring + 颜色编码",
    "mappings": [
        ("idle",    "⬡‿⬡", "neutral"),
        ("thinking","⬡⌄⬡", "purple"),
        ("stream",  "[>‿<]", "cyan"),
        ("working", "⬡▰⬡", "amber"),
        ("done",    "\⬡‿⬡/", "green"),
        ("error",   "⬡_⬡", "red"),
        ("waiting", "⬡⊙⬡", "yellow"),
    ],
}

# DEC-V321-09 /steer 中途转向
DECISION_V321_09 = {
    "name": "/steer 中途转向命令",
    "rationale": "friday-code Ctrl+Space 触发 /steer，软中断注入上下文",
    "tdsf_shortcut": "Ctrl+Space 触发 tdsf_steer 命令",
    "behavior": "软中断当前 turn（不取消），插入新 context，继续执行",
    "use_case": "用户发现 agent 走偏时，无需 cancel 重建",
}
```

---

### 11.5 Antigravity 深度分析（Google 新品）

**关键信息**（闭源，仅从评测获取）：

1. **Agent-first 平台**：
   - 启动 dynamic subagents 并行运行
   - 在 Gemini 上原生
   - 多 Agent 编排（不像 Cursor 单 agent）

2. **多模型接入**：
   - Claude / GPT / Gemini / xAI / DeepSeek
   - 内置 Composer 模型（Kimi K2.5 开源权重）
   - Cursor 3 重新设计 UI 围绕 agent 而非 file

3. **Composer 2.5 性能**：
   - SWE-Bench Multilingual 79.8% vs Claude Opus 4.7 80.5%
   - Terminal-Bench 2.0 69.3% vs 69.4%
   - **约 1/10 token 成本**（标准 tier）

**v3.2.1 借鉴决策**：
- ❌ **不直接采纳**：闭源 + Google 生态绑定
- ✅ **方向借鉴**：多 Agent 编排是 2026 主流方向，与 TDSF 路线一致

---

### 11.6 Zagens 深度分析（didclawapp-ai/zagens）

**架构亮点**：

1. **Tauri 2 桌面 + OS 级沙箱**（**与 TDSF 路径一致**）：
   - Windows 受限令牌进程（Restricted Token Process）
   - 工作区外写入拦截（Workspace Write Intercept）
   - 敏感目录读保护（Sensitive Directory Read Protection）
   - WFP 出站阻断（Windows Filtering Platform outbound block）
   - **不是免责声明，是系统强制**

2. **分层完成门禁**（**与 TDSF 5 绿门禁一致**）：
   - 模型说"做完了"不算
   - 必须经过：编译、Clippy、测试等验证层
   - 任一层不过 → 任务不标记完成
   - **借鉴**：TDSF 在 P0-P3 阶段已用 5 绿门禁，与 Zagens 一致

3. **Fix-loop 强制停手**（**复用价值**）：
   - 连续 3 轮无有效进展 → 强制停手
   - 避免 Agent 无限重试
   - **借鉴**：TDSF 加 `tdsf_max_retry=3` 配置项

4. **Code + Office 同一 runtime**：
   - 写代码与产出 XLSX / DOCX / PPTX / PDF 不切工具
   - Office 模式内置 10+ 场景技能
   - **借鉴**：TDSF 增加 Office 模式（v2.0 阶段）

5. **会话逐轮回放**：
   - 命令、输出、拦截记录均可回溯
   - 借鉴 v3.0 的 session replay 功能

**v3.2.1 借鉴决策**：

```python
# DEC-V321-10 OS 级沙箱（Windows + macOS Seatbelt + Linux）
DECISION_V321_10 = {
    "name": "OS 级沙箱（Zagens 验证可行）",
    "rationale": "Zagens 在 Windows 上落地受限令牌 + WFP",
    "tdsf_phase1": "Docker 沙箱（现有 RiskEngine 路径）",
    "tdsf_phase2": "Firecracker microVM（v1.5）",
    "tdsf_phase3": "OS 原生沙箱（Windows Restricted Token + WFP，参考 Zagens）",
    "macOS": "Seatbelt（v1.0 已规划）",
    "linux": "landlock + seccomp（v1.0 已规划）",
}

# DEC-V321-11 Fix-loop 强制停手
DECISION_V321_11 = {
    "name": "Fix-loop 强制停手（避免无限重试）",
    "rationale": "Zagens 3 轮无进展强制停手",
    "tdsf_default": "max_retry=3（可配置）",
    "behavior": "连续 3 轮无 diff 无效进展 → 弹出 needs-you 询问用户",
    "config": "tdsf.toml [safety] max_retry = 3",
}
```

---

### 11.7 claude-skills 库 深度分析（alirezarezvani/claude-skills）

**架构亮点**：

1. **18 领域预置 Skills（354 个）**：
   - 工程核心 52（架构 / 前后端 / QA / DevOps / SecOps / AI-ML / Playwright / 无障碍审计）
   - 工程高阶 80（RAG 架构师 / CI/CD 构建器 / 零幻觉编程 / 混沌工程 / Kubernetes Operator）
   - 产品 17（PM / 敏捷PO / UX研究 / UI设计 / SaaS 脚手架 / 实验设计）
   - 营销 48（SEO + AEO 面向 LLM 引用优化 / CRO / 增长智能）
   - 学术研究 9（文献综述 / NIH 基金 / 专利 / 教学大纲 / 深度研究）
   - 法规 19（MDR / FDA / ISO 27001 / GDPR / SOC 2 / CAPA）
   - 高管顾问 68（CEO / CTO / CFO / CMO 等 14 角色）
   - **核心三要素**：Skills（如何做）+ Agents（做什么）+ Personas（谁思考）

2. **13 工具跨平台支持**：
   - Claude Code / OpenAI Codex / Gemini CLI / OpenClaw / Hermes Agent / Mistral Vibe
   - Cursor / Aider / Windsurf / Kilo Code / OpenCode / Augment / Antigravity
   - **本项目就是 Hermes Agent 一等公民**！

3. **零 pip 依赖**：
   - 593 Python CLI 脚本全部 stdlib
   - 跨平台运行，部署简单
   - **借鉴**：TDSF 的 Skill 工具脚本应优先 stdlib

4. **多工具一键转换**：
   - `convert.sh --tool all` 约 15 秒转换所有技能
   - 各工具对应格式（.mdc 规则文件 / SKILL.md / etc）

5. **Skill 格式标准化**：
   - SKILL.md（结构化指令、工作流、决策框架）
   - Python 工具脚本（跨平台 CLI）
   - 参考文档（模板、清单、领域知识）

**v3.2.1 借鉴决策**：

```python
# DEC-V321-12 预置 18 领域 Skills 包
DECISION_V321_12 = {
    "name": "TDSF 预置 18 领域 Skills（运维/教学优先）",
    "rationale": "alirezarezvani 库 5.2K Star 验证 18 领域分法有效",
    "tdsf_phase1": "运维核心 30 Skills（Linux / 网络 / 数据库 / Docker / K8s / 监控 / 日志 / 安全）",
    "tdsf_phase2": "教学场景 20 Skills（Linux 教程 / 数据库教程 / 编程入门 / 论文检索）",
    "tdsf_phase3": "工程高阶 20 Skills（RAG / CI/CD / 零幻觉编程 / 混沌工程）",
    "total_phase3": "70+ 预置 Skills",
    "format": "SKILL.md + 工具脚本（stdlib 优先）",
    "marketplace": "tdsf://skills/<name> 协议 + 支持从 GitHub URL 安装",
}

# DEC-V321-13 SKILL.md 标准格式
DECISION_V321_13 = {
    "name": "TDSF Skill 标准格式（兼容 Claude Code SKILL.md）",
    "rationale": "claude-skills 库 + skills.sh marketplace 已成事实标准",
    "tdsf_skill_structure": {
        "SKILL.md": "YAML frontmatter (name/description/triggers) + Markdown 内容",
        "tools/": "可执行 Python/Bash 脚本（stdlib 优先）",
        "references/": "领域知识、模板、清单",
        "examples/": "示例输入输出",
    },
    "discovery": "扫描 ~/.tdsf/skills/ + ./tdsf-skills/ + GitHub URL",
    "install": "tdsf skill install <url|path>",
}
```

---

### 11.8 v3.2.1 新增 13 项决策汇总

| 决策 | 来源 | 复用价值 | 落地阶段 |
|------|------|---------|---------|
| DEC-V321-01 三模式 + 四档融合权限 | CodeWhale | 极高 | P0 |
| DEC-V321-02 side-git 工作区回滚 | CodeWhale | 高 | P2 |
| DEC-V321-03 RLM 风格并行子任务 | CodeWhale | 中 | P4 |
| DEC-V321-04 1M Token 兼容 | CodeWhale | 中 | P5 |
| DEC-V321-05 单写入器 Project Service | aimux-cli | 极高 | P0-P1 |
| DEC-V321-06 AIMUX.md 模式 → TDSF.md | aimux-cli | 高 | P1 |
| DEC-V321-07 needs-you 协调收件箱 | aimux-cli | 高 | P1 |
| DEC-V321-08 mood ring 7 状态 | friday-code | 极高 | P0 |
| DEC-V321-09 /steer 中途转向 | friday-code | 中 | P4 |
| DEC-V321-10 OS 级沙箱 | Zagens | 高 | P1/P3 |
| DEC-V321-11 Fix-loop 强制停手 | Zagens | 中 | P0 |
| DEC-V321-12 预置 18 领域 Skills | claude-skills 库 | 极高 | P1-P4 |
| DEC-V321-13 SKILL.md 标准格式 | claude-skills 库 | 极高 | P0 |

### 11.9 v3.2.1 量化数据更新

| 维度 | v3.2 | v3.2.1 | 增量 |
|------|-----:|------:|------|
| 已分析项目数 | 50 | **56** | +6（CodeWhale/aimux/friday/Antigravity/Zagens/claude-skills） |
| 预置 Skills 数 | 0 | **354+ 候选** | 借鉴 claude-skills 库 |
| 状态指示器 | 4 状态 | **7 状态** | friday-code mood ring |
| 权限模式 | 4 档 + 1 | **4 档 + 3 mode** | CodeWhale 融合 |
| 文档工具脚本 | 0 | **593 stdlib 脚本** | 借鉴 claude-skills 库 |
| 沙箱层级 | 3 | **4** | 加 OS 级（Zagens） |

### 11.10 v3.2.1 关键洞察（**重要**）

> ⚠️ **跨项目共性发现**（2026 年 5 大行业共识）：

1. **Shift+Tab 三模式**（plan/agent/yolo）= 行业标准（CodeWhale + friday-code + Claude Code 共识）
   - TDSF 应直接采用，与 v3.1 4 档权限融合
2. **mood ring 状态可视化** = 优秀 UX 必选项（friday-code 验证）
   - 远处一眼看到状态，比文字状态点更直观
3. **side-git / workspace snapshot** = 主流工作区回滚方案（CodeWhale 验证）
   - 比"纯审批机制"更让人安心
4. **SKILL.md** = 事实标准（Anthropic 官方 + claude-skills 库 + skills.sh marketplace）
   - TDSF 应兼容，零迁移成本
5. **单写入器控制平面 + 多客户端** = 企业级架构（aimux-cli + cmux 共识）
   - Tauri 2 Rust 后端 = Project Service 是正确选择

---

> v3.2.1 报告完成时间：2026-07-26  
> 数据来源：v3.2 + 第二轮 WebSearch（CodeWhale/aimux/friday/Antigravity/Zagens/claude-skills）  
> 下次更新：v3.3（实施后实测数据回填）
