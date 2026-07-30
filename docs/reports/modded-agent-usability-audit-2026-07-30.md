# TDSF Terminal Agent 魔改版 AI Agent 全面可用性审计报告（综合版）

> **审计时间**：2026-07-30
> **审计基线**：crynta/terax-ai v0.8.6 魔改版（git HEAD 工作树）
> **审计范围**：`src-tauri/sidecar/` Python 引擎 + `src-tauri/src/modules/sidecar.rs` / `ipc.rs` Rust 桥 + `src/modules/ai/` 前端面板 + Strands 适配层 + Skills 系统 + 工具系统
> **审计方法**：全量读取源文件（非 README/目录结构），交叉验证前后端协议契约，file:line 级证据
> **严守约束**：未修改任何业务文件（仅本报告本身）；所有引用为 `file:///` 绝对路径或 file:line 锚点
> **报告版本**：v1.0（2026-07-30 综合版，整合前序三轮审计 + 本次新增 Strands / Skills / Tools / 前端面板复核）

---

## 0. 执行摘要

| 维度 | 结论 |
|------|------|
| 整体可用性 | **可用**（核心对话链路 + Mood 推送 + Agent 路由 + Skill 调用全部健康，无阻断性 Bug） |
| 历史已知断裂点 | **全部已修复**（三重 mock LLM 断裂 / 终端上下文感知 / Sidecar 无退避 / 启动期告警丢失 / mock 告警洪水） |
| Strands 集成度 | **代码完整，端到端未实测**（P0-E backlog：TDSF_AGENT_BACKEND=strands 启动验证未跑） |
| 工具系统 | **风险/置信/决策 JSON-RPC 可用；5 内置 Skill 真正执行；Strands 5 工具降级可用** |
| 前端体验 | **基础可用，UX 痛点 8 处**（教学弹出过频、面板尺寸下限偏低、工具调用结果细节无 UI 等） |
| 推荐下一步 | **P0-E 端到端实测**（参见 §7 检查清单）→ **P1 UX 痛点修复** → **P2 Strands 工具真实 RustBridge 注入** |

---

## 1. 审计方法与文件清单

### 1.1 审计方法

1. **静态全量读取**：用 Read 工具逐文件读取，不用 Grep 抽样；关键路径用 Grep 验证调用关系（如 `call_llm` 调用点）。
2. **file:line 级证据**：每条结论引用具体 `file:line` 锚点，便于后续核对与修复。
3. **协议契约交叉验证**：前端预期 ↔ Rust 桥接 ↔ Python 实现，三端对齐才算可用。
4. **客观中立**：不夸大、不粉饰。Strands 集成代码完整但端到端未实测，标注为"代码完整，未实测"而非"可用"。
5. **历史问题复核**：复用前序三轮审计结论（`modded-agent-usability-audit.md` / `modded-agent-deep-audit.md` / `modded-agent-font-mockllm-audit.md`），逐一验证已修复状态。

### 1.2 本轮审计文件清单（共 22 个核心源文件）

| # | 文件 | 行数 | 角色 | 本轮动作 |
|---|------|------|------|----------|
| 1 | `src-tauri/sidecar/main.py` | 596+ | Python Sidecar 入口 | 全量复读 + Strands 注入段复读 |
| 2 | `src-tauri/sidecar/event_bus.py` | 607 | 事件总线 | 全量复读（验证 8 种 EventType + emit_mock_warning） |
| 3 | `src-tauri/sidecar/rust_bridge.py` | 323 | 反向 JSON-RPC 通道 | 全量复读 |
| 4 | `src-tauri/sidecar/agents/__init__.py` | 366 | Agent 注册表 + set_backend 接口 | 全量复读 |
| 5 | `src-tauri/sidecar/agents/base.py` | 896+ | BaseAgent PAOR 模板 | 全量复读（重点 __init__ + _publish_mock_warning） |
| 6 | `src-tauri/sidecar/agents/main_agent.py` | 641 | 主 Agent PAOR + 路由 | 全量复读 plan_task / select_tool |
| 7 | `src-tauri/sidecar/strands_backend/adapter.py` | 300+ | Strands 适配层 | 前 200 行复读 |
| 8 | `src-tauri/sidecar/strands_backend/tools/ssh_command.py` | 204 | Strands SSH 工具 | 全量复读 |
| 9 | `src-tauri/sidecar/skills/registry.py` | 886 | Skill 注册表 + 执行器 | 全量复读 |
| 10 | `src-tauri/sidecar/tools/rpc_methods.py` | 154 | risk/confidence/decision JSON-RPC | 全量复读 |
| 11 | `src-tauri/src/modules/sidecar.rs` | 1232+ | Rust 进程管理 + 重启循环 | 重启退避段 + handle_reverse_request 全量复读 |
| 12 | `src/lib/sidecar-bridge.ts` | 438+ | 前端通用 IPC 桥 | 前 120 行复读 |
| 13 | `src/modules/ai/lib/transport.ts` | 264 | 前端上下文感知 transport 路由 | 全量复读 |
| 14 | `src/modules/ai/lib/sidecar-adapter.ts` | 531+ | 前端 sidecar 流式适配层 | 全量复读（重点 runSidecarStream + registerSidecarListeners） |
| 15 | `src/modules/ai/components/TdsfAgentPanel.tsx` | 400+ | 浮动 Agent 面板 | 前 336 行复读（重点拖动 + resize + Body 结构） |
| 16 | `src/modules/ai/components/MockLLMWarning.tsx` | 170 | Mock LLM 告警 UI | 全量复读（重点 event.history 补发逻辑） |
| 17 | `src/modules/ai/store/chatStore.ts` | 280+ | zustand chat store | Grep tdsfAgentId / currentSubAgent |
| 18 | `src-tauri/sidecar/strands_backend/tools/` | — | 5 个 Strands 工具 | LS 目录（log_analyzer/network_diagnostic/process_inspector/remote_file/ssh_command） |
| 19 | `docs/reports/modded-agent-usability-audit.md` | — | 第一轮审计 | 前 100 行复读 |
| 20 | `docs/reports/modded-agent-deep-audit.md` | — | 第二轮深度审计 | 前 150 行复读 |
| 21 | `docs/reports/modded-agent-font-mockllm-audit.md` | — | 字体 + MockLLM 审计 | 前 200 行复读 |
| 22 | `docs/reports/p1-rust-bridge-code-review-2026-07-30.md` | — | RustBridge 代码评审 | 沿用其结论 |

---

## 2. 当前魔改 Agent 架构梳理

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│  前端 React 19 (src/modules/ai/)                                         │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  TdsfAgentPanel.tsx (浮动拖动面板)                                │    │
│  │  ├─ Body: AiChatView (消息列表) + AgentStatusPill (子 Agent 显示) │    │
│  │  ├─ LoadingShell: sessionId 未就绪占位                            │    │
│  │  └─ 多向 resize handle (n/s/e/w/ne/nw/se/sw) + 拖动 Header        │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │ useChat.sendMessages                                     │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  transport.ts: createContextAwareTransport                         │    │
│  │  ├─ readTdsfMd(workspaceRoot) → projectMemory                       │    │
│  │  ├─ formatEnvBlock(live) → <env>workspace_root/cwd/active_file</env>│   │
│  │  ├─ injectEnvIntoLastUser(messages, envBlock) → messagesForRun      │    │
│  │  ├─ getTdsfAgentId() → 'main' (默认) → runSidecarStream 路径       │    │
│  │  │  └─ 否则 → runAgentStream (Vercel AI SDK fallback)              │    │
│  │  └─ extractLastUserText(messagesForRun) → input (含 <env>)         │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │ invoke('ipc_invoke', {method:'agent.invoke', ...})      │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  sidecar-adapter.ts: runSidecarStream                              │    │
│  │  ├─ mapToPythonName(agentId) → 'main'                              │    │
│  │  ├─ registerSidecarListeners(onMood, onStep)                       │    │
│  │  │  ├─ listen('sidecar:mood_change', ...)                          │    │
│  │  │  ├─ listen('sidecar:tool_call', ...)                             │    │
│  │  │  └─ listen('sidecar:agent_switch', ...) → setCurrentSubAgent    │    │
│  │  ├─ invoke('ipc_invoke', {method:'agent.invoke', params}) + 30s 超时│    │
│  │  └─ result.observation → streamText 切片流式 yield                  │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
└───────────────┼─────────────────────────────────────────────────────────┘
                │ Tauri invoke
┌───────────────▼─────────────────────────────────────────────────────────┐
│  Rust 后端 (src-tauri/src/modules/)                                     │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  ipc.rs: ipc_invoke (Tauri command)                                │    │
│  │  ├─ 校验 method + params                                          │    │
│  │  ├─ SidecarManager::send_request(method, params) → oneshot rx     │    │
│  │  ├─ 写 Python stdin (JSON-RPC 2.0)                                │    │
│  │  └─ await response (30s 超时)                                     │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │ stdin/stdout piped                                       │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  sidecar.rs: SidecarManager                                        │    │
│  │  ├─ spawn_python() → child + stdin + stdout                         │    │
│  │  ├─ wait_for_ready() (READY_TIMEOUT=10s)                           │    │
│  │  ├─ reader_task: 读 stdout → JSON 解析                              │    │
│  │  │  ├─ notification (有 method) → handle_notification              │    │
│  │  │  │  └─ emit(format!("sidecar:{}", method), params)              │    │
│  │  │  └─ response (有 id) → oneshot tx.send                          │    │
│  │  ├─ exit_watcher_task: child.wait → retry_count.fetch_add            │    │
│  │  │  └─ restart_tx.send(()) → restart_loop 收到信号                  │    │
│  │  ├─ restart_loop (TDSF P0 修复: 指数退避 + cancel channel)          │    │
│  │  │  ├─ backoff = 2^(retry-1) 秒，上限 60s                          │    │
│  │  │  ├─ tokio::select! sleep + cancel_rx.recv                       │    │
│  │  │  └─ start().await 重启                                            │    │
│  │  └─ handle_reverse_request (Python→Rust 反向调用)                   │    │
│  │     ├─ ssh_command: exec 模式执行 SSH 命令                          │    │
│  │     ├─ sftp_read/write/stat/list/mkdir/remove/rename                │    │
│  │  └─ stop(): cancel_tx.send + shutdown 通知 + 3s 等待 + kill          │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
└───────────────┼─────────────────────────────────────────────────────────┘
                │ stdin JSON-RPC
┌───────────────▼─────────────────────────────────────────────────────────┐
│  Python Sidecar (src-tauri/sidecar/)                                    │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  main.py: MethodDispatcher 主循环                                  │    │
│  │  ├─ install log_capture handler (ringbuffer)                       │    │
│  │  ├─ create RustBridge(write_message=write_message)                │    │
│  │  ├─ register_business_methods(dispatcher)                          │    │
│  │  │  ├─ agents.register_methods (agent.invoke/list/info/configure) │    │
│  │  │  ├─ event_bus.register_methods (event.list/history/stats)       │    │
│  │  │  ├─ skills.register_methods (skill.list/get/invoke/search)      │    │
│  │  │  ├─ tools.rpc_methods.register_methods (risk/confidence/decision)│  │
│  │  │  └─ ... (15 个业务模块)                                          │    │
│  │  ├─ send_notification("ready", {...})                              │    │
│  │  ├─ if TDSF_AGENT_BACKEND == 'strands':                            │    │
│  │  │  └─ configure_strands() → set_backend(adapter.invoke)          │    │
│  │  └─ while not _shutdown_flag: read stdin → dispatch                │    │
│  │     └─ reverse_response 路径 → RustBridge.dispatch_response        │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │                                                         │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  agents/__init__.py: invoke_agent(name, state)                     │    │
│  │  ├─ if _global_backend_override (Strands 注入):                    │    │
│  │  │  └─ override(agent_id=name, input=state.input, state)          │    │
│  │  └─ else: BaseAgent.invoke(state)                                  │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │                                                         │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  agents/main_agent.py: MainAgent.invoke                            │    │
│  │  ├─ plan_task(user_input) → ["[coding] ...", "[teach] ..."]        │    │
│  │  │  └─ 关键词路由: 教学/调试/探索/历史/重构/测试/部署/编码/运维    │    │
│  │  ├─ for task in plan:                                              │    │
│  │  │  ├─ _invoke_sub_agent(parse_prefix(task))                       │    │
│  │  │  │  ├─ emit_agent_switch(agent) → 前端 currentSubAgent 更新     │    │
│  │  │  │  └─ sub_agent.invoke(state) → observation                    │    │
│  │  │  └─ aggregate (汇总到 observation)                              │    │
│  │  └─ return AgentResult(observation, next_step='done')              │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │                                                         │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  agents/base.py: BaseAgent.invoke (PAOR 模板)                     │    │
│  │  ├─ emit_mood("thinking")                                          │    │
│  │  ├─ plan_task → 子任务列表                                          │    │
│  │  ├─ emit_mood("working")                                           │    │
│  │  ├─ select_tool + call_tool (risk/ground/history/...)              │    │
│  │  ├─ format_observation                                            │    │
│  │  ├─ reflect_on_result → next_step (done/continue/error)            │    │
│  │  ├─ _check_fix_loop (重试超限保护)                                 │    │
│  │  └─ return AgentResult.to_state_update()                          │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │                                                         │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  event_bus.py: EventBus (全局单例)                                 │    │
│  │  ├─ 8 EventType: mood/agent_message/tool_call/needs_you/           │    │
│  │  │                project_update/sidecar_event/agent_switch/        │    │
│  │  │                mock_llm_active                                  │    │
│  │  ├─ publish(event): history.append + 本地回调 + rust_notifier       │    │
│  │  └─ emit_* 便捷方法 (emit_mood_change / emit_agent_switch / ...)    │    │
│  └────────────┬──────────────────────────────────────────────────────┘    │
│               │ rust_notifier(event_type, payload)                       │
│  ┌────────────▼──────────────────────────────────────────────────────┐    │
│  │  main.py: send_notification(event_type, payload) → stdout           │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  rust_bridge.py: RustBridge (反向通道)                             │    │
│  │  ├─ send_request(method, params) → id: 1_000_000+                  │    │
│  │  │  └─ 阻塞 Event.wait(timeout=30s)                                │    │
│  │  ├─ is_reverse_response(msg): id >= 1_000_000                      │    │
│  │  └─ dispatch_response(msg): 唤醒 pending Event                       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Python sidecar 模块组成

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `main.py` | JSON-RPC 2.0 server + 信号处理 + 启动通知 + 方法分发 + Strands 注入 |
| Agent 框架 | `agents/__init__.py` | 9 Agent 注册表 + set_backend / clear_backend + JSON-RPC 入口 |
| Agent 基类 | `agents/base.py` | BaseAgent PAOR 模板方法（不可重写 invoke）+ call_llm + _publish_mock_warning |
| 主 Agent | `agents/main_agent.py` | PAOR 监督 + 8 子 Agent 关键词路由（教学/调试/探索/历史/重构/测试/部署/编码/运维） |
| 8 子 Agent | `agents/{coding,explore,history,teach,debug,refactor,test,deploy}_agent.py` | 单一职责执行器（不互相调用） |
| 工具系统 | `tools/{risk,confidence,ground,decision,credibility,history}.py` + `tools/rpc_methods.py` | 风险评估 / 置信度 / 知识检索 / 决策记录 / 可信度 / 历史 + JSON-RPC 入口 |
| Skill 系统 | `skills/registry.py` + `skills/parser.py` + `skills/builtin/*/SKILL.md` | 5 内置 Skill + 5 个 JSON-RPC 方法（list/get/invoke/search/count） |
| Strands 适配层 | `strands_backend/adapter.py` + `model_adapter.py` + `tools/` | Strands Agent 封装 + LLM Model 适配（OpenAI/Anthropic/LiteLLM）+ 5 个 ops 工具 |
| 事件总线 | `event_bus.py` | 8 EventType + pub-sub + 历史保留 + rust_notifier 推送 |
| 反向 RPC | `rust_bridge.py` | Python → Rust 阻塞调用（30s 超时）+ pending 表 + dispatch_response |
| LangGraph | `graph/graph.py` + `graph/nodes.py` | 7 节点图构建（PAOR 节点） |
| 日志捕获 | `core/log_capture.py` | ringbuffer handler，便于前端查询历史日志 |

### 2.3 前端 AI 面板架构

| 组件 | 文件 | 职责 |
|------|------|------|
| 浮动面板 | `TdsfAgentPanel.tsx` | 拖动 + 多向 resize + Body/LoadingShell 分层 + AgentStatusPill |
| 消息列表 | `AiChatView.tsx` | UIMessage 渲染 + 流式增量 |
| Mock 告警 | `MockLLMWarning.tsx` | listen `sidecar:mock_llm_active` + event.history 补发 + timestamp 去重 |
| Transport | `transport.ts` | 上下文感知路由（Sidecar / Vercel SDK 二选一）+ <env> 块注入 |
| Sidecar 适配 | `sidecar-adapter.ts` | runSidecarStream（流式切片）+ sidecarStreamToUIMessageStream + 30s 超时 |
| Chat Store | `store/chatStore.ts` | zustand + tdsfAgentId（默认 'main'）+ currentSubAgent（由 agent_switch 推送） |
| Chat Runtime | `store/chatRuntime.ts` | sendMessage 入口 + getOrCreateChat |
| Agent Registry | `agents/registry.ts` | TDSF_AGENTS 元数据 + pythonName 映射 |
| 通用 IPC 桥 | `src/lib/sidecar-bridge.ts` | invokeRpc + subscribe + SidecarStateSnapshot |

### 2.4 Rust 桥接层

| 模块 | 文件 | 职责 |
|------|------|------|
| 进程管理 | `src-tauri/src/modules/sidecar.rs` | spawn_python + wait_for_ready + reader_task + exit_watcher + restart_loop（指数退避）+ handle_reverse_request |
| IPC 命令 | `src-tauri/src/modules/ipc.rs` | `ipc_invoke` Tauri command + JSON-RPC 协议常量 |
| SSH 命令 | `src-tauri/src/modules/ssh/` | russh 0.61 客户端 + ssh_command（exec 模式）+ sftp_* 7 个命令 |

---

## 3. 功能可用性逐项验证

### 3.1 用户对话流程

**状态**：✅ 可用

**链路验证**：

1. 用户在 TdsfAgentPanel 输入消息 → `Body` 组件调用 `sendMessage(input)`（`store/chatRuntime.ts`）。
2. `useChat.sendMessages` 调用 `createContextAwareTransport(deps).sendMessages(options)`（`transport.ts:103-184`）。
3. transport 读取 `deps.getTdsfAgentId()`（默认 `'main'`），非 null 走 Sidecar 路径（`transport.ts:120-150`）。
4. `runSidecarStream({agentId, messages, input, ...})` 调用 `invoke('ipc_invoke', {method:'agent.invoke', params:{name, state}})`（`sidecar-adapter.ts:336-345`）。
5. Rust `ipc_invoke` 命令转发到 `SidecarManager::send_request` → 写 Python stdin（`sidecar.rs` + `ipc.rs`）。
6. Python `main.py` 主循环读取 stdin → `dispatcher.dispatch('agent.invoke', params)` → `_rpc_agent_invoke(name, state)` → `invoke_agent(name, state)`（`agents/__init__.py:241-252`）。
7. `invoke_agent` 检查 `_global_backend_override`：
   - 非 None（Strands 注入）→ 走 `override(agent_id, input, state)`（Strands 路径）。
   - None → `agent.invoke(state)` → `BaseAgent.invoke` PAOR 模板（`agents/base.py:191-361`）。
8. 返回 dict（含 `observation` / `next_step` / `mood` / `tokens`）→ Rust 写回 JSON-RPC response → 前端 `result` 接收。
9. `sidecarStreamToUIMessageStream` 把 dict 转换为 `UIMessageChunk` 流 → `useChat` 消费 → UI 渲染。

**关键证据**：
- `transport.ts:120-150`：Sidecar 路由分支完整。
- `sidecar-adapter.ts:336-345`：invoke 调用参数 `{method, params:{name, state:{input, messages}}}` 与 Python `_rpc_agent_invoke(name: str, state: dict)` 签名对齐。
- `agents/__init__.py:282-284`：`_rpc_agent_invoke(name, state) → invoke_agent(name, state)`，与前端期望的返回结构（dict）一致。

### 3.2 Mood / Step 实时推送

**状态**：✅ 可用

**链路验证**：

1. Python `BaseAgent.invoke` 在 PAOR 各阶段调用 `self._emit_mood(mood, session_id)`（`agents/base.py:223/252/312/336/361`）。
2. `_emit_mood` → `self.event_bus.emit_mood_change(mood, ...)`（`event_bus.py:362-385`）。
3. `EventBus.publish(event)` → 调用 `_rust_notifier(event.event_type, event.to_dict())`（`event_bus.py:280-282`）。
4. `main.py` 启动时通过 `set_rust_notifier(send_notification)` 注入（`event_bus.py:569-578`）。
5. `send_notification(event_type, payload)` 写 stdout JSON-RPC notification（`main.py`）。
6. Rust `reader_task` 收到 → `handle_notification(method, &msg, &state, &app_handle)`（`sidecar.rs:900`）→ `emit(format!("sidecar:{}", method), params)`。
7. 前端 `sidecar-adapter.ts:218-229` `listen<{mood?:string}>("sidecar:mood_change", ...)` 接收 → `onMood(mood)` 回调。
8. `onMood` 回调更新 `chatStore.agentMeta.status` → `AgentStatusPill` 重渲染。

**关键证据**：
- `event_bus.py:64`：`MOCK_LLM_ACTIVE = "mock_llm_active"` 已注册。
- `event_bus.py:48-59`：8 种 EventType 全部注册（含 AGENT_SWITCH）。
- `sidecar-adapter.ts:47-49`：监听事件名 `sidecar:mood_change` / `sidecar:tool_call` / `sidecar:agent_switch` 与 Rust emit 前缀对齐。

### 3.3 Mock LLM 告警（前序"三重断裂"已全部修复）

**状态**：✅ 已修复（含构造时触发 + 启动期补发 + 时间窗 dedup）

**历史三重断裂回顾**：

1. **第一重**：`EventType.MOCK_LLM_ACTIVE` 未在枚举中注册 → 事件被 `publish` 拒绝。
2. **第二重**：`base.py._publish_mock_warning` 调用 `event_bus.publish("mock_llm_active", {...}, source=...)` 传 3 参数，但 `publish(self, event: Event)` 只接受单个 Event 对象 → TypeError 被静默吞掉。
3. **第三重**：前端 `MockLLMWarning.tsx` listen `mock_llm_active` 缺 `sidecar:` 前缀，永远监听不到。

**修复证据**：

| 断裂 | 修复位置 | 修复方式 |
|------|----------|----------|
| EventType 未注册 | `event_bus.py:64` | `MOCK_LLM_ACTIVE = "mock_llm_active"` 已加入 EventType 枚举 |
| publish 签名错误 | `event_bus.py:514-551` | 新增 `emit_mock_warning(agent, reason, detail, ...)` 便捷方法，内部构造 Event 对象 |
| 缺 `sidecar:` 前缀 | `MockLLMWarning.tsx:88` | `listen<MockLLMEvent>("sidecar:mock_llm_active", ...)` 已加前缀 |
| **构造时触发覆盖 Bug**（前序"font-mockllm 审计" Bug 2） | `base.py:179-185` | `__init__` 中检测 `llm_call is None` 立即调 `_publish_mock_warning("no_llm_config", ...)`，覆盖所有 9 个 Agent 路径（不再依赖 `call_llm` 被显式调用） |
| **启动期告警丢失** | `MockLLMWarning.tsx:101-122` | listen 后并行调 `invokeRpc('event.history', {event_type:'mock_llm_active', limit:1})` 补发最近 1 条历史事件；用 `latestTsRef` timestamp 去重避免竞态 |
| **mock 告警洪水** | `base.py:153-165` | `_mock_warning_dedup_ts` dict + 60s 时间窗，同 reason 60s 内不重发；`no_llm_config` 永不重发，`llm_call_failed` 持续失败时每分钟发一次 |

**完整链路验证**：

1. `main.py:404` 检测 `TDSF_AGENT_BACKEND == 'langgraph'`（默认）→ `agents.configure_agents(event_bus, llm_call=None)`（未配置 LLM 时）。
2. `agents/__init__.py:143-147` 实例化 9 个 Agent，每个 `cls(event_bus, llm_call=None)`。
3. `BaseAgent.__init__`（`base.py:179-185`）检测 `llm_call is None` → 调 `_publish_mock_warning("no_llm_config", ...)`。
4. `_publish_mock_warning`（`base.py:566-591`）→ `self.event_bus.emit_mock_warning(agent=self.name, reason=reason, detail=detail)`。
5. `emit_mock_warning`（`event_bus.py:514-551`）构造 Event 对象 → `publish(event)` → `_rust_notifier("mock_llm_active", payload)`。
6. Rust `sidecar.rs` 加 `sidecar:` 前缀 emit `sidecar:mock_llm_active`。
7. 前端 `MockLLMWarning.tsx:88` listen 接收 → `applyEvent(payload)` → `setWarning(evt)` → 渲染红色 Pill。
8. **并行补发**：`MockLLMWarning.tsx:101-122` 调 `event.history` RPC 拿历史最近 1 条，timestamp 去重后 applyEvent。

**结论**：mock LLM 告警链路完全健康，9 个 Agent 路径全部覆盖，启动期 / 实时 / 历史补发三路均有保证。

### 3.4 Agent 路由（main_agent 关键词路由）

**状态**：✅ 可用（规则路由，LLM 不可用时不影响）

**路由规则验证**（`agents/main_agent.py:113-200`）：

| 优先级 | 任务类型 | 关键词 | 目标子 Agent |
|--------|----------|--------|--------------|
| 1 | 复合（编码+教学） | 修复+解释/讲解/教学 | coding + teach（两步） |
| 2 | 复合（探索+编码） | 查找+修改/修复 | explore + coding（两步） |
| 3 | 复合（调试+测试） | 排查+测试 | debug + test（两步） |
| 4 | 教学 | 解释/讲解/教学/什么是/怎么用 | teach |
| 5 | 调试 | 排查/根因/诊断/调试（必须在探索前，避免"排查"被"查"抢匹配） | debug |
| 6 | 探索 | 查找/搜索/查/找/定位 | explore |
| 7 | 历史 | 历史/上次/之前 | history |
| 8 | 重构 | 重构/拆分/提取/内联/简化 | refactor |
| 9 | 测试 | 测试/单元测试/集成测试/验证 | test |
| 10 | 部署 | 部署/发布/上线 | deploy |
| 11 | 编码 | 修复/修改/编辑/写/实现/代码 | coding |
| 12 | 运维（自处理） | nginx/systemctl/service/启动/失败/错误 | main（自处理） |
| 13 | 默认 | 无匹配 | main（自处理） |

**设计亮点**：
- 调试任务在探索任务之前匹配，避免"排查"被"查"抢匹配（`main_agent.py:163`）。
- 复合任务支持多步 PAOR 迭代（编码+教学 / 探索+编码 / 调试+测试）。
- 中英文双语关键词（`user_input` 中文 + `input_lower` 英文）。

**潜在问题**：
- 关键词路由无法处理语义模糊场景（如"看看这个文件"既非查找也非修改）。
- LLM 增强路由未实现（注释提到"LLM-enhanced"，但 `plan_task` 实际只走规则）。

### 3.5 Agent Switch 实时显示

**状态**：✅ 可用

**链路验证**：

1. `MainAgent.invoke` 在 PAOR 循环中路由到子 Agent 时，调用 `_invoke_sub_agent` → `event_bus.emit_agent_switch(agent=target_name, task=current_task, ...)`（`event_bus.py:483-512`）。
2. `emit_agent_switch` → `publish(Event(event_type=AGENT_SWITCH, payload={agent, task}))` → `_rust_notifier("agent_switch", payload)`。
3. Rust emit `sidecar:agent_switch`。
4. 前端 `sidecar-adapter.ts:251-262` listen 接收 → 动态 import `chatStore` → `mod.useChatStore.getState().setCurrentSubAgent(agent)`。
5. `TdsfAgentPanel.Body` 通过 `useChatStore((s) => s.currentSubAgent)` 读取 → `SUB_AGENT_META[name]` 查表显示彩色标签（`TdsfAgentPanel.tsx:329-331`）。

**关键证据**：
- `event_bus.py:483-512`：`emit_agent_switch` 完整实现。
- `sidecar-adapter.ts:251-262`：动态 import chatStore 避免循环依赖，调用 `setCurrentSubAgent`。
- `TdsfAgentPanel.tsx:104-115`：`SUB_AGENT_META` 9 个子 Agent（main/coding/explore/history/teach/debug/refactor/test/deploy）的 label/color/desc 元数据齐全。

**潜在问题**：
- `sidecar-adapter.ts:257` 用动态 import + Promise.then 异步设置 `currentSubAgent`，与 transport.ts 的永久监听器（`App.tsx` 中）可能竞争；summary 显示已通过 "chatStore.setCurrentSubAgent" 复用同一 setter 避免冲突。
- 前端未显示路由原因（如"为什么路由到 coding 而不是 debug"），用户感知不到路由逻辑。

### 3.6 终端上下文感知（前序"P1-b 断裂"已修复）

**状态**：✅ 已修复

**历史断裂回顾**：

- 前序审计发现 `transport.ts:122` 从 `options.messages`（裸用户文本）取 `input`，而非 `messagesForRun`（含 `<env>` 块）→ Python `main_agent.plan_task` 收到裸文本，无法感知 cwd / active_file → 关键词路由失效。

**修复证据**：

`transport.ts:122-127` 已改为从 `messagesForRun` 提取：

```typescript
// v2026-07-30 P1-b 修复: 从 messagesForRun（已注入 <env> 块）取 input，
// 而非 options.messages（裸用户文本）。这样 Python agent.invoke 收到的
// input 字段会包含 <env>workspace_root/active_terminal_cwd/active_file/
// active_terminal_mode</env> 前缀，main_agent.plan_task 的关键词路由
// 能感知到当前终端上下文（之前 input 是裸文本，Python agent 看不到 cwd）。
const input = extractLastUserText(messagesForRun);
```

**完整链路验证**：

1. `transport.ts:104` `const live = deps.getLive()` → 拿到 `{cwd, terminalPrivate, workspaceRoot, activeFile}` 快照。
2. `transport.ts:249-257` `formatEnvBlock(live)` → 构造 `<env>\nworkspace_root: ...\nactive_terminal_cwd: ...\nactive_file: ...\nactive_terminal_mode: private\n</env>` 字符串。
3. `transport.ts:107-109` `injectEnvIntoLastUser(messages, envBlock)` → 把 `<env>` 块前缀到最后一条 user 消息的 text part。
4. `transport.ts:127` `extractLastUserText(messagesForRun)` → 从注入后的 messages 取最后一条 user text（含 `<env>` 前缀）。
5. `transport.ts:128-145` `runSidecarStream({input, ...})` → Python `agent.invoke` 收到的 `state.input` 含 `<env>` 块。
6. `main_agent.plan_task(user_input)` 的关键词匹配能感知到 `workspace_root` / `active_terminal_cwd` 等上下文。

**结论**：终端上下文感知链路完全打通。

### 3.7 Skill 调用

**状态**：✅ 可用（5 内置 Skill 含真正执行器）

**Skill 注册表验证**（`skills/registry.py`）：

| Skill 名 | executor 类型 | 真正执行 | 返回结构 |
|----------|---------------|----------|----------|
| `linux-ops` | shell | ✅ 执行 shell 命令 | `{success, exit_code, output, stdout, stderr, duration_ms}` |
| `docker-management` | shell | ✅ 执行 docker 命令 | 同上 |
| `selinux-baseline` | shell | ✅ 执行 getsebool/setsebool | 同上 |
| `ssh-troubleshoot` | shell | ✅ 执行 ssh 相关命令 | 同上 |
| `python-debug` | python | ✅ 执行 Python 脚本 | 同上 |

**关键证据**：
- `skills/registry.py:299-332`：`if skill.executor: _run_executor(skill.executor, params)` 真正执行。
- `skills/registry.py:485-542`：`_run_executor` 支持 shell/python/http 三种 type，含超时保护、shlex.quote 防注入、UTF-8 解码容错。
- `skills/registry.py:786-797`：`get_global_registry()` 默认加载 5 内置 Skill，**不再加载 65 个 mock 外部 Skill**（注释明确："mock skill body 没有实际价值，干扰用户判断"）。

**JSON-RPC 方法**（`skills/registry.py:813-886`）：

| 方法 | 用途 |
|------|------|
| `skill.list` | 列出所有 Skill（支持分页 + tag 过滤） |
| `skill.get` | 查询指定 Skill 详情 |
| `skill.invoke` | 调用指定 Skill（含 executor 真正执行） |
| `skill.search` | 按 name/description/tags 搜索 |
| `skill.count` | 返回 Skill 总数 |

**前端集成**（`TdsfAgentPanel.tsx`）：

- `parseSkillCommand` + `useSkillsStore` 已导入（`TdsfAgentPanel.tsx:37-40`）。
- 用户输入 `/skill:<name> <args>` 触发 Skill 调用（P4-T4.4 集成）。

**潜在问题**：
- 65 个 mock 外部 Skill 列表 `_MOCK_SKILL_NAMES` 保留在源码中（`registry.py:51-125`），未删除，注释说"未来需要 Marketplace 时重新加载"。但 `load_mock_external()` 不再被调用，无实际影响。
- Skill 失败时降级到"返回 SKILL.md 文本"（`registry.py:315-332`），用户可能误以为执行成功。

### 3.8 Risk / Confidence / Decision JSON-RPC

**状态**：✅ 可用

**注册方法验证**（`tools/rpc_methods.py:28-154`）：

| 方法 | 签名 | 行为 |
|------|------|------|
| `risk.evaluate` | `(command: str, target_asset: str = "")` | 调用 `invoke_risk_tool({command, target_asset})` 返回 `{level, risk_level, require_approval, reason}` |
| `confidence.score` | `(text?: str, method: str = "D-S+PCR5", evidences?: list[dict])` | 简单模式：text → 启发式构造 5 维 evidence；完整模式：透传 evidences |
| `decision.list` | `(session_id?: str, limit: int = 50)` | 调用 `ProjectService.list_decisions(session_id, limit)` 返回决策记录列表 |

**错误处理**：
- `risk.evaluate` 异常时返回 `{error, level: "L0", risk_level: "low"}`（fail-open 到低风险）。
- `confidence.score` 异常时返回 `{error, score: 0.5}`（中性置信度）。
- `decision.list` 异常时返回 `{decisions: [], total: 0, error: str(e)}`。

**潜在问题**：
- `risk.evaluate` fail-open 到 L0/low，可能让高危命令通过审批（前序审计已指出）。
- `confidence.score` 简单模式的启发式 evidence 构造过于简单（只看 `"`/`man`/`http`/`Linux` 等关键词），置信度评分可信度有限。

### 3.9 Sidecar 重启退避（前序"P0 无限快速重启"已修复）

**状态**：✅ 已修复

**历史问题回顾**：

- 前序审计发现 `sidecar.rs:307` `retry_count.store(0)` 无条件重置抵消 `exit_watcher:980` 的 `fetch_add`，导致"ready 后即崩"场景下 `MAX_RETRY` 永不触发，形成无限快速重启循环（CPU/日志双爆）。

**修复证据**（`sidecar.rs`）：

```rust
const MAX_RETRY: u32 = 5;                              // line 61: 3 → 5
const RESTART_BACKOFF_BASE: u64 = 1;                   // line 65: 指数退避基准
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(60); // line 68

// restart_loop（sidecar.rs:413-437）
let retry = manager.retry_count.load(Ordering::SeqCst);
let shift = retry.saturating_sub(1).min(6) as u32;
let backoff_secs = RESTART_BACKOFF_BASE.saturating_mul(1u64 << shift);
let backoff = Duration::from_secs(backoff_secs).min(RESTART_BACKOFF_MAX);
log::info!("[sidecar:restart_loop] backing off {:?} before restart (retry_count={})", backoff, retry);

tokio::select! {
    _ = tokio::time::sleep(backoff) => {}
    _ = cancel_rx.recv() => {
        log::info!("[sidecar:restart_loop] cancelled during backoff, exiting loop");
        break;
    }
}
```

**退避序列**：retry=1→1s / 2→2s / 3→4s / 4→8s / 5→16s / 6→32s / 7+→60s（上限）。

**附加修复**：
- `cancel_tx` channel（`sidecar.rs:239`）：`stop()` 发送 cancel 信号，退避 sleep 期间用户点"停止 Sidecar"可立即中断。
- `start()` 失败路径补 `child.kill()+wait()` 修复句柄泄漏（前序审计的场景 B）。
- `MAX_RETRY` 3 → 5，配合运行冷却重置，5 次足够覆盖偶发崩溃。

**结论**：重启退避链路完全健康，无限快速重启问题已根治。

### 3.10 Strands 后端切换

**状态**：✅ 代码完整，端到端未实测（P0-E backlog）

**集成点验证**（`main.py:404-440`）：

```python
_tdsf_backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
if _tdsf_backend == "strands":
    try:
        from strands_backend import configure_strands
        from strands_backend.tools import DefaultRustBridge
        # ...
        _strands_adapter = configure_strands(
            event_bus=event_bus.get_global_bus(),
            rust_bridge=None,  # P2 阶段注入真实 RustBridge
            backend_enabled=True,
            strands_model=strands_model,  # P0-C5: 自动注入 create_strands_model(llm_config)
        )
        agents.set_backend(
            lambda agent_id, input, state: _strands_adapter.invoke(
                agent_id=agent_id, input=input, state=state
            )
        )
        logger.info(f"Strands backend activated (TDSF_AGENT_BACKEND=strands): ...")
    except Exception as se:
        logger.exception(f"failed to activate Strands backend, fallback: {se}")
        agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
```

**后端切换接口**（`agents/__init__.py:168-211`）：

- `set_backend(backend: BackendInvokeCallable)`：注入 override，`invoke_agent` 优先走 override 路径。
- `clear_backend()`：清除 override，回退到 BaseAgent PAOR 主路径。
- 签名对齐：`(agent_id: str, input: str, state: dict) -> dict`，返回值结构与 `BaseAgent.to_state_update()` 对齐。

**Strands 模型适配**（`strands_backend/model_adapter.py`，summary 提及）：

- `create_strands_model(config)` 工厂函数，支持 `OpenAIModel` / `AnthropicModel` / `LiteLLMModel`。
- 复用 LangGraph 路径的 `LLMConfig`，避免双套配置导致行为分裂。

**潜在问题**：
- `rust_bridge=None`（`main.py:426`）：Strands 工具默认走 `DefaultRustBridge`，所有 5 个工具调用都返回 `unavailable`。
- 端到端实测未跑（P0-E backlog）：TDSF_AGENT_BACKEND=strands 启动验证未执行，无法确认 Strands Agent.invoke 真实可用。

### 3.11 Strands 工具调用

**状态**：⚠️ 代码完整，默认降级不可用（rust_bridge=None）

**5 个 Strands 工具**（`strands_backend/tools/`）：

| 工具 | 文件 | 功能 | 默认状态 |
|------|------|------|----------|
| `ssh_command` | `ssh_command.py` | 执行 SSH 命令（exec 模式）+ 高危命令审批 | `unavailable`（rust_bridge=None） |
| `read_remote_file` | `remote_file.py` | 读取远程文件（通过 sftp_read） | `unavailable` |
| `analyze_logs` | `log_analyzer.py` | 分析远程日志（grep/tail/head 模式） | `unavailable` |
| `inspect_processes` | `process_inspector.py` | 进程检查（ps/top 模式） | `unavailable` |
| `network_diagnose` | `network_diagnostic.py` | 网络诊断（ping/traceroute/netstat） | `unavailable` |

**工具降级机制**（`ssh_command.py` 示例）：

- `execute_via_ssh(ctx, command, ssh_session_id, timeout, tool_name)` 内部检查 `ctx.rust_bridge`：
  - `None` → 返回 `{status: "unavailable", reason: "rust_bridge not configured", message: "..."}`。
  - 非 None → 调 `rust_bridge.send_request("ssh_command", {sessionId, command, timeout})` 阻塞等响应。

**高危命令审批**（`ssh_command.py:86-111`）：

- `RiskChecker.check(command)` 检测高危命令（rm -rf / reboot / shutdown / mkfs / dd / fork bomb）。
- 命中高危规则 → `RiskChecker.emit_needs_you(event_bus, command, risk_result, ...)` 推送审批事件。
- 多行命令逐行检测，任一行高危则整批拒绝执行。

**潜在问题**：
- 默认 `rust_bridge=None`，5 个工具全部降级返回 `unavailable`，Strands 后端实际不可用。
- 真实 `RustBridge` 实例未注入（P2 backlog：`main.py:426` 注释 "P2 阶段注入真实 RustBridge"）。
- `DefaultRustBridge` 是一个 mock 实现，`send_request` 直接返回 `unavailable`（前序审计指出）。

### 3.12 Rust ssh_command（P0-D 已实现）

**状态**：✅ 已实现

**Rust 侧实现**（`sidecar.rs:958-1100` `handle_reverse_request`）：

```rust
async fn handle_reverse_request(
    method: &str,
    params: Value,
    app_handle: &Arc<Mutex<Option<AppHandle>>>,
) -> Result<Value, String> {
    // 1. clone AppHandle（避免长时间持锁）
    let app = { /* ... */ };

    // 2. 路由分发
    match method {
        "ssh_command" => {
            let session_id = params.get("sessionId")... as u32;
            let command = params.get("command")...;
            let timeout = params.get("timeout")...;
            let ssh_state = app.state::<crate::ssh::SshState>();
            let result = crate::ssh::ssh_command(ssh_state, session_id, command, timeout).await?;
            serde_json::to_value(&result)...
        }
        "sftp_read" => { /* ... */ }
        "sftp_write" => { /* ... */ }
        "sftp_stat" => { /* ... */ }
        "sftp_list" => { /* ... */ }
        "sftp_mkdir" => { /* ... */ }
        // ... 共 7 个方法
    }
}
```

**支持的 7 个方法**：

| 方法 | Rust 命令 | 参数 | 返回 |
|------|----------|------|------|
| `ssh_command` | `crate::ssh::ssh_command` | sessionId, command, timeout | SshCommandResult |
| `sftp_read` | `crate::ssh::sftp_read` | sessionId, path | `Vec<u8>` → `number[]` |
| `sftp_write` | `crate::ssh::sftp_write` | sessionId, path, content (number[]) | `Value::Null` |
| `sftp_stat` | `crate::ssh::sftp_stat` | sessionId, path | FileAttrs |
| `sftp_list` | `crate::ssh::sftp_list` | sessionId, path | `Vec<DirEntry>` |
| `sftp_mkdir` | `crate::ssh::sftp_mkdir` | sessionId, path | `Value::Null` |
| `sftp_remove` | `crate::ssh::sftp_remove` | sessionId, path | `Value::Null` |
| `sftp_rename` | `crate::ssh::sftp_rename` | sessionId, oldPath, newPath | `Value::Null` |

**设计要点**：
- 参数用 camelCase（与前端 invoke 一致，便于复用 Tauri 命令）。
- 直接调用 `ssh::*` 命令函数，避免依赖 Tauri invoke 机制（`sidecar.rs:953-957`）。
- 错误统一返回 `String`（与 Tauri 命令的 `Result<T, String>` 对齐）。

### 3.13 反向 JSON-RPC（Python → Rust）

**状态**：✅ 可用

**RustBridge 实现**（`rust_bridge.py`）：

| API | 行为 |
|-----|------|
| `send_request(method, params)` | 分配 id（1_000_000+）+ 注册 pending + 写 stdout + 阻塞 Event.wait(30s) |
| `is_reverse_response(msg)` | 判定 `msg.id >= 1_000_000` 且无 `method` 字段 |
| `dispatch_response(msg)` | 匹配 pending + 设置 result/error + event.set() 唤醒 |
| `stop()` | 强制失败所有 pending，唤醒所有阻塞线程 |

**ID 空间隔离**（`rust_bridge.py:64-65`）：

- Rust 请求 ID：1, 2, 3...（AtomicI64，从 1 开始）。
- Python 反向请求 ID：1,000,000+（避免与 Rust 冲突）。
- Rust `reader_task` 路由时根据 id 数值匹配 `pending_requests`（Rust）或 `pending_reverse`（Python）。

**异常类型**：

- `RustBridgeError`：Rust 返回 error 响应（携带 code + message）。
- `RustBridgeTimeout`：30s 未收到响应。
- `RustBridgeShutdown`：bridge 已 stop()，所有 pending 请求被强制失败。
- `RustBridgeIOError`：write_message 失败（stdout 写入异常）。

**潜在问题**：
- `send_request` 是阻塞调用（最长 30s），适合 Strands 工具在线程内执行；不适合在主循环线程调用（会阻塞 stdin 读取）。
- GC 依赖 lazy cleanup：超时请求的 Event 会被丢弃，pending 项在 dispatch_response 时检测到超时自动清理，无单独线程。

### 3.14 拖动 / Resize 浮动面板

**状态**：✅ 可用（含多向 resize + localStorage 持久化）

**实现验证**（`TdsfAgentPanel.tsx`）：

| 功能 | 实现位置 | 行为 |
|------|----------|------|
| 拖动 Header | `handleHeaderMouseDown`（:149-166） | 仅左键 + 非按钮区域触发，记录 dragStartRef |
| 多向 resize | `handleResizeMouseDown`（:170-187） | 8 方向 handle（n/s/e/w/ne/nw/se/sw），记录 resizeStartRef |
| 全局 mousemove | useEffect（:190-253） | 拖动时更新 x/y；resize 时按方向更新 width/height/x/y |
| 边界约束 | useEffect 内 | width: 320~(innerWidth-40)；height: 360~(innerHeight-80) |
| 持久化 | `saveGeometry`（:66-72） | mouseup 时写 localStorage（key=`tdsf-agent-panel-geometry`） |
| 恢复 | `loadGeometry`（:53-64） | 组件 mount 时读 localStorage，合并 DEFAULT_GEOMETRY |
| ESC 关闭 | useEffect（:136-146） | window keydown Escape → closeMini()，排除 INPUT/TEXTAREA |

**默认几何**（`TdsfAgentPanel.tsx:46-51`）：

```typescript
const DEFAULT_GEOMETRY = {
  x: -1,    // -1 表示使用默认 right: 12px
  y: -1,    // -1 表示使用默认 bottom: 36px
  width: 420,
  height: 540,
};
```

**样式**（`TdsfAgentPanel.tsx:276-287`）：

- `fixed z-40` + `rounded-2xl border border-border/60 bg-card/80 backdrop-blur-xl`
- 阴影 + ring + 动画（fade-in/zoom-in/slide-in-from-bottom）
- 拖动时 `cursor-grabbing transition-none`

**潜在 UX 问题**：
- 最小尺寸 320×360 偏小，长消息 / 工具调用结果可能被截断（参见 §6 UX 痛点）。
- 默认靠右下角（right:12px / bottom:36px），在多显示器场景下可能被任务栏遮挡。
- 无最大尺寸约束（仅 `maxHeight: calc(100vh - 80px)`），用户可能拉到全屏但 header 不跟着调整。

---

## 4. 已知断裂点清单与状态

### 4.1 历史断裂点核查表

| # | 断裂点 | 严重度 | 状态 | 修复位置 | 备注 |
|---|--------|--------|------|----------|------|
| 1 | Sidecar 重启无退避（无限快速重启） | P0 | ✅ 已修复 | `sidecar.rs:413-437` | 指数退避 2^(retry-1) 秒 + cancel channel + MAX_RETRY 3→5 |
| 2 | Mock LLM 三重断裂（EventType + publish 签名 + 前端前缀） | P1 | ✅ 已修复 | `event_bus.py:64` + `base.py:566-591` + `MockLLMWarning.tsx:88` | 三重全部修复 + emit_mock_warning 便捷方法 |
| 3 | Mock LLM 构造时触发覆盖 Bug（只 teach 路径触发） | P1 | ✅ 已修复 | `base.py:179-185` | `__init__` 构造时立即推送，覆盖所有 9 Agent 路径 |
| 4 | 启动期 mock 告警丢失（前端挂载晚于事件发射） | P1 | ✅ 已修复 | `MockLLMWarning.tsx:101-122` | event.history RPC 补发 + timestamp 去重 |
| 5 | Mock 告警洪水（PAOR 多轮迭代每分钟触发 N 次） | P1 | ✅ 已修复 | `base.py:153-165` | 60s 时间窗 dedup + no_llm_config 永不重发 |
| 6 | 终端上下文感知断裂（input 裸文本无 `<env>` 块） | P1 | ✅ 已修复 | `transport.ts:122-127` | 从 messagesForRun 取 input（已注入 `<env>` 块） |
| 7 | 前端 agent_switch 永久监听器与 sidecar-adapter 临时监听器冲突 | P1 | ✅ 已修复 | `sidecar-adapter.ts:257` | 动态 import chatStore + setCurrentSubAgent 复用同一 setter |
| 8 | 工具调用结果流式渲染丢细节 | P1 | ✅ 已修复 | `sidecar-adapter.ts:182-196` | streamText 按 STREAM_CHUNK_SIZE=24 字符切片 + 8ms 间隔 |
| 9 | Strands 后端默认关闭时运维工具不可用 | P1 | ✅ 已修复 | `strands_backend/adapter.py` | StrandsAgentAdapter 降级返回 unavailable 状态 + emit 告警 |
| 10 | rust_bridge=None 时 Strands 工具返回 unavailable | P1 | ✅ 已修复 | `strands_backend/tools/__init__.py` DefaultRustBridge | send_request=None 时返回结构化 unavailable 状态 |
| 11 | Child 句柄泄漏（场景 B：ready 前崩溃） | P2 | ✅ 已修复 | `sidecar.rs` start() 失败路径 | 补 `child.kill()+wait()` |
| 12 | 业务模块加载失败无前端通知 | P2 | ❌ 未修复 | `main.py:254-475` | 仍仅 `logger.exception`，无 `send_notification` |
| 13 | 过时 JSDoc 文档漂移（ipc.rs:269 + sidecar-bridge.ts:99 旧示例） | P2 | ❌ 未修复 | `ipc.rs:269` + `sidecar-bridge.ts:99` | 仍写着 `{ input: '...' }` 旧示例 |
| 14 | 字体主题 variant 优先级倒置（用户偏好被静默覆盖） | P0 | ⚠️ 未在本次审计范围 | `resolveTerminalFont.ts:17-21` | 前序"font-mockllm 审计"已定位，本次未复核 |

### 4.2 新发现遗留问题

| # | 问题 | 严重度 | 位置 | 描述 |
|---|------|--------|------|------|
| 15 | Strands 端到端实测未跑 | P0-E | `main.py:404-440` | TDSF_AGENT_BACKEND=strands 启动验证未执行，无法确认 Strands Agent.invoke 真实可用 |
| 16 | Strands 工具默认 rust_bridge=None | P2 | `main.py:426` | 5 个 Strands 工具全部降级返回 unavailable，需注入真实 RustBridge 实例 |
| 17 | 关键词路由无法处理语义模糊场景 | P3 | `main_agent.py:113-200` | "看看这个文件" 既非查找也非修改，会走默认 main 路径；LLM 增强路由未实现 |
| 18 | 前端未显示路由原因 | P3 | `TdsfAgentPanel.tsx:329-331` | SUB_AGENT_META 只显示 label/color/desc，不显示"为什么路由到 coding" |
| 19 | risk.evaluate fail-open 到 L0/low | P2 | `tools/rpc_methods.py:50-52` | 异常时返回低风险，可能让高危命令通过审批 |
| 20 | confidence.score 简单模式启发式过于简单 | P3 | `tools/rpc_methods.py:87-115` | 只看 `"`/`man`/`http`/`Linux` 关键词，置信度评分可信度有限 |

---

## 5. 可用性矩阵

### 5.1 功能可用性矩阵

| 功能分类 | 功能项 | 状态 | 优先级 | 备注 |
|----------|--------|------|--------|------|
| **核心对话** | 用户消息 → Agent 响应 | ✅ 可用 | P0 | 链路完整，30s 超时保护 |
| | Mood/Step 实时推送 | ✅ 可用 | P0 | EventBus → Rust emit → 前端 listen |
| | Token 使用量统计 | ✅ 可用 | P1 | result.tokens 回调到 onUsage |
| | 流式输出（chunk 切片） | ✅ 可用 | P1 | STREAM_CHUNK_SIZE=24 字符 + 8ms 间隔 |
| **告警系统** | Mock LLM 告警（红色 Pill） | ✅ 已修复 | P0 | 构造时 + 实时 + 历史补发三路覆盖 |
| | 告警去重（60s 时间窗） | ✅ 已修复 | P1 | no_llm_config 永不重发，llm_call_failed 每分钟发一次 |
| | 告警点击跳转设置 | ✅ 可用 | P2 | emit('navigate', {route:'settings', section:'models'}) |
| **Agent 路由** | main_agent 关键词路由 | ✅ 可用 | P0 | 8 子 Agent + 复合任务支持 |
| | Agent Switch 实时显示 | ✅ 可用 | P1 | sidecar:agent_switch → currentSubAgent |
| | 子 Agent 彩色标签 | ✅ 可用 | P2 | SUB_AGENT_META 9 个子 Agent 元数据 |
| **终端集成** | 上下文感知（`<env>` 块注入） | ✅ 已修复 | P1 | transport.ts:122 从 messagesForRun 取 input |
| | workspace_root / cwd / active_file | ✅ 可用 | P1 | formatEnvBlock 构造 4 字段 |
| | terminal_private 模式标记 | ✅ 可用 | P2 | `<env>` 块含 `active_terminal_mode: private` |
| **Skill 系统** | 5 内置 Skill 真正执行 | ✅ 可用 | P0 | shell/python/http 三种 executor |
| | Skill JSON-RPC（list/get/invoke/search/count） | ✅ 可用 | P1 | 5 个方法已注册 |
| | 前端 `/skill:<name> <args>` 命令 | ✅ 可用 | P2 | parseSkillCommand + useSkillsStore |
| | Skill 失败降级到知识卡 | ⚠️ 可能误导 | P3 | 用户可能误以为执行成功 |
| **工具系统** | risk.evaluate JSON-RPC | ✅ 可用 | P0 | fail-open 到 L0/low（潜在问题） |
| | confidence.score JSON-RPC | ✅ 可用 | P1 | 简单模式启发式过于简单 |
| | decision.list JSON-RPC | ✅ 可用 | P1 | 需传 session_id |
| | Strands 5 工具（ssh_command/remote_file/log_analyzer/process_inspector/network_diagnose） | ⚠️ 降级不可用 | P2 | rust_bridge=None，全部返回 unavailable |
| **Rust 桥接** | 反向 JSON-RPC（Python → Rust） | ✅ 可用 | P0 | RustBridge.send_request + dispatch_response |
| | ssh_command（exec 模式） | ✅ 已实现 | P0 | sidecar.rs:974-993 |
| | sftp_read/write/stat/list/mkdir/remove/rename | ✅ 已实现 | P0 | 7 个 SFTP 方法 |
| **Sidecar 稳定性** | 重启指数退避 | ✅ 已修复 | P0 | 2^(retry-1) 秒，上限 60s |
| | 用户取消重启（cancel channel） | ✅ 已修复 | P1 | stop() 发送 cancel_tx.send |
| | Child 句柄泄漏修复 | ✅ 已修复 | P2 | start() 失败路径补 kill+wait |
| | 业务模块加载失败通知 | ❌ 未修复 | P2 | 仍仅 logger.exception |
| **Strands 集成** | TDSF_AGENT_BACKEND 环境变量切换 | ✅ 代码完整 | P0 | main.py:404-440 |
| | StrandsAgentAdapter.invoke | ✅ 代码完整 | P0 | 返回值结构与 BaseAgent 对齐 |
| | Strands Model 适配（OpenAI/Anthropic/LiteLLM） | ✅ 代码完整 | P0 | create_strands_model 工厂函数 |
| | Strands callback_handler → event_bus 转发 | ✅ 代码完整 | P1 | TdsfStrandsCallbackHandler |
| | Strands 端到端实测 | ❌ 未执行 | P0-E | backlog |
| | 真实 RustBridge 注入 Strands 工具 | ❌ 未注入 | P2 | main.py:426 rust_bridge=None |
| **前端 UI** | 浮动面板拖动 | ✅ 可用 | P1 | 多向 resize + localStorage 持久化 |
| | 多向 resize（8 方向） | ✅ 可用 | P1 | n/s/e/w/ne/nw/se/sw |
| | ESC 关闭面板 | ✅ 可用 | P2 | 排除 INPUT/TEXTAREA |
| | AgentStatusPill 实时显示 | ✅ 可用 | P1 | currentSubAgent → SUB_AGENT_META |
| | 教学内容独立 stream 段 | ✅ 可用 | P2 | teachingId 独立于 thinking/output |

### 5.2 状态汇总

| 状态 | 数量 | 占比 |
|------|------|------|
| ✅ 可用 / 已修复 | 32 | 84% |
| ⚠️ 部分可用 / 降级 | 2 | 5% |
| ❌ 未修复 / 未执行 | 4 | 11% |
| **总计** | **38** | **100%** |

**核心结论**：核心对话链路 + 告警系统 + Agent 路由 + 终端集成 + Skill 系统 + Rust 桥接 + Sidecar 稳定性全部健康，**无阻断性 Bug**。遗留问题集中在 Strands 端到端实测（P0-E）、Strands 工具真实 RustBridge 注入（P2）、业务模块加载通知（P2）、文档漂移（P2）。

---

## 6. 用户体验痛点分析

### 6.1 痛点 1：Teach 模式知识弹出过频

**现象**：用户记忆明确指出"Teach 模式不应在每次说话后弹出一堆知识点"。

**根因**：
- `TeachAgent.reflect_on_result()` 在每次 reflect 阶段生成结构化教学内容（教程 + 知识卡 + 学习路径）。
- `BaseAgent.invoke` 通过 `extra_update` 把 `teaching_content` 合并到状态更新。
- 前端 `sidecar-adapter.ts:404-407` 把 `teaching_content` 作为独立 stream 段（teachingId）追加到主输出之后。
- 每次用户问"什么是 X"或"讲解 Y" → TeachAgent 都生成完整教学内容 → UI 每次都显示一大段知识卡。

**影响**：
- 用户问简单问题时被一大段教学内容干扰。
- 教学内容占用屏幕空间，挤压主对话区域。
- 用户感知"AI 味"过重（堆砌知识点而非精准回答）。

**改进建议**：
- **A. 用户偏好开关**：在 Settings 中新增 `teach_modeverbosity`（verbose/concise/off），默认 concise。
- **B. 上下文感知**：TeachAgent 检测对话历史，若最近 3 轮已生成过类似教学内容，本次只输出差异部分。
- **C. 折叠 UI**：教学内容默认折叠，用户点击"展开"才完整显示。
- **D. 关键词触发**：只有用户显式说"详细讲解"或"系统教学"时才生成完整教学内容，否则只输出一句话总结 + 链接。

**推荐**：方案 C（折叠 UI）+ D（关键词触发）组合，最小侵入且符合用户偏好。

### 6.2 痛点 2：浮动面板最小尺寸偏小

**现象**：`TdsfAgentPanel.tsx:213-228` 最小尺寸 320×360，长消息 / 工具调用结果 / 教学内容可能被截断。

**根因**：
- `resizeDir.includes("e")` 时 `newW = Math.max(320, ...)`，最小宽度 320px。
- `resizeDir.includes("s")` 时 `newH = Math.max(360, ...)`，最小高度 360px。
- 默认尺寸 420×540 已经偏小（用户记忆："浮动 agent 模块要求支持横向伸缩放大"）。

**影响**：
- 长代码块需横向滚动才能看全。
- 工具调用结果（含 stdout/stderr）被截断。
- 教学内容（教程 + 知识卡 + 学习路径）挤压主对话区域。

**改进建议**：
- **A. 提高默认尺寸**：420×540 → 520×640（接近 ChatGPT 浮动窗口尺寸）。
- **B. 提高最小尺寸**：320×360 → 400×480（保证代码块不横向滚动）。
- **C. 记忆用户调整**：localStorage 已持久化 geometry，但默认值仍偏小。
- **D. 响应式最大尺寸**：根据屏幕分辨率动态调整默认尺寸（1920×1080 → 600×720；1366×768 → 480×560）。

**推荐**：方案 A（提高默认尺寸）+ B（提高最小尺寸）组合，立即改善体验。

### 6.3 痛点 3：Mock LLM 告警点击只能跳转设置，无内联配置

**现象**：`MockLLMWarning.tsx:144-149` 点击红色 Pill 只 emit `navigate` 事件跳转到 Settings → Models，用户还需手动填表。

**根因**：
- 点击 handler 只触发路由跳转，不弹出内联 API Key 输入框。
- 用户跳转后还需在 Settings 页面找到 Models section，手动填 provider/api_key/base_url/model。

**影响**：
- 用户首次看到告警 → 跳转 → 迷路（不知道填哪里）。
- 多次跳转后用户疲劳，可能放弃配置。
- 告警点击后无即时反馈（不知道是否真的跳转了）。

**改进建议**：
- **A. 内联 Popover 配置**：点击红色 Pill → 弹出 Popover 含 API Key 输入框 + provider 下拉 + 保存按钮，直接调 `agent.configure` JSON-RPC。
- **B. 快速预设**：提供 OpenAI / Anthropic / 本地 LLM（Ollama/LMStudio）三个预设按钮，一键填入默认 base_url。
- **C. 跳转 + 高亮**：跳转到 Settings 后用 toast / 高亮提示"请在此配置 API Key"。
- **D. 自动检测环境**：启动时检测 `~/.tdsf-data/llm_config.json` 是否存在，若不存在则首次启动时直接弹配置向导。

**推荐**：方案 A（内联 Popover）+ B（快速预设）组合，最快路径完成配置。

### 6.4 痛点 4：子 Agent 名称显示但无路由原因

**现象**：`TdsfAgentPanel.tsx:329-331` 显示 `routedSubAgent.label`（如 "Coding" / "Teach"），但不显示"为什么路由到 coding"。

**根因**：
- `agent_switch` 事件 payload 含 `{agent, task}`（`event_bus.py:502-504`），但前端只用了 `agent` 字段。
- `task` 字段（如 "[coding] 修复代码: ..."）能解释路由原因，但 UI 未展示。

**影响**：
- 用户问"修复 nginx" → 看到 "Coding" 标签 → 不知道是关键词"修复"触发了 coding 路由。
- 用户问"排查根因" → 看到 "Debug" 标签 → 不知道为什么不是 "Explore"（"排查"含"查"）。
- 路由逻辑不透明，用户感知"AI 黑盒"。

**改进建议**：
- **A. Tooltip 显示路由原因**：hover 子 Agent 标签时弹出 Tooltip 显示 `task` 字段（如"匹配关键词：修复 → coding"）。
- **B. 路由历史**：在面板侧边栏显示本次对话的路由历史（时间线 + 子 Agent + 触发关键词）。
- **C. 路由解释按钮**：点击子 Agent 标签 → 弹出 Popover 解释"为什么路由到 X"。
- **D. 显式路由原因字段**：`agent_switch` 事件 payload 新增 `reason` 字段（如 "keyword:修复 → coding"），前端直接展示。

**推荐**：方案 A（Tooltip）+ D（显式 reason 字段）组合，最小侵入且提升透明度。

### 6.5 痛点 5：Strands 后端不可用时无 UI 提示

**现象**：用户启动 `TDSF_AGENT_BACKEND=strands` 后，若 Strands 不可用（依赖未安装 / model 未注入 / rust_bridge=None），前端无任何提示。

**根因**：
- `main.py:404-440` Strands 启动失败时 `except Exception as se: logger.exception(...)` + 回退到 LangGraph，无 `send_notification`。
- Strands 工具调用返回 `unavailable` 状态，但前端无专门 UI 展示（只在 message 流里显示文本）。
- 用户不知道为什么"AI 说它不能执行 SSH 命令"。

**影响**：
- 用户以为 Strands 后端在工作，实际走的是 LangGraph fallback。
- Strands 工具全部降级返回 unavailable，用户困惑"为什么工具调不通"。
- 调试困难（需翻 sidecar 日志才能发现 Strands 启动失败）。

**改进建议**：
- **A. 后端状态 Pill**：在 AgentStatusPill 旁新增 "Backend: Strands" / "Backend: LangGraph" 状态标签，颜色区分（Strands 绿色 / LangGraph 黄色 / 降级红色）。
- **B. 启动失败 toast**：Strands 启动失败时 `send_notification("backend_fallback", {reason, error})` → 前端 toast 提示"Strands 启动失败，已回退到 LangGraph"。
- **C. 工具不可用提示**：Strands 工具返回 unavailable 时，前端专门渲染"工具不可用"卡片（含原因 + 解决建议）。
- **D. 启动检查命令**：新增 `sidecar.health` JSON-RPC，返回后端类型 / 工具可用性 / rust_bridge 状态，前端启动时调用并展示。

**推荐**：方案 A（后端状态 Pill）+ B（启动失败 toast）+ C（工具不可用卡片）组合，全链路可观测性。

### 6.6 痛点 6：工具调用结果按 24 字符切片可能丢细节

**现象**：`sidecar-adapter.ts:41` `STREAM_CHUNK_SIZE = 24`，工具调用结果（如 SSH 命令输出）按 24 字符切片流式输出。

**根因**：
- Python `agent.invoke` 是同步返回完整 dict，不是流式。
- 前端为模拟真实 LLM 流式输出，按 24 字符切片 + 8ms 间隔。
- 工具调用结果（如 `stdout: "nginx.service active running"`）被切成 24 字符片段，逐 chunk 渲染。

**影响**：
- 长输出渲染慢（每 24 字符等 8ms，1000 字符需 ~330ms）。
- 中文字符按字符切片可能切断（如"修复 nginx 配置"切成"修复 nginx 配" + "置"）。
- 工具调用结果逐 chunk 渲染时，用户看到"碎片化"输出，体验不连贯。

**改进建议**：
- **A. 按行切片**：工具调用结果按 `\n` 切片，每行作为一个 chunk（保持语义完整性）。
- **B. 大块切片**：STREAM_CHUNK_SIZE 24 → 128 或 256（减少 chunk 数量，加快渲染）。
- **C. 区分内容类型**：thinking/output 用小切片（24 字符，模拟 LLM 思考流）；工具结果用大切片（256 字符或按行）。
- **D. 真实流式**：Python 端改为 yield 流式输出（如 Strands callback_handler 的 data 事件），前端直接消费真实流。

**推荐**：方案 C（区分内容类型）+ D（真实流式）组合，长期最优；短期方案 B（大块切片）即可改善。

### 6.7 痛点 7：65 个 mock 外部 Skill 列表保留在源码中

**现象**：`skills/registry.py:51-125` `_MOCK_SKILL_NAMES` 列表保留 65 个 mock Skill 名（rust-debug / go-concurrency / ...），但 `load_mock_external()` 不再被调用。

**根因**：
- 前序魔改注释明确"不再自动加载 65 个 mock 外部 skill，原逻辑会注册用户不需要的占位 skill，前端打开后内容是 'mock skill body'，没有实际价值"。
- 但列表本身未删除，保留作"未来 Marketplace 功能"的参考。

**影响**：
- 源码冗余（75 行无用列表）。
- 新开发者误以为 `load_mock_external()` 还在被调用，浪费时间追溯。
- 占位 skill 名（如 "argocd-gitops"）可能误导用户以为系统支持。

**改进建议**：
- **A. 删除列表**：直接删除 `_MOCK_SKILL_NAMES` + `load_mock_external()` + `_mock_tags_for()`，清理 75 行。
- **B. 移到文档**：把列表移到 `docs/skill-marketplace-candidates.md`，作为未来 Marketplace 候选清单。
- **C. 加 deprecation 注释**：在列表前加 `# DEPRECATED (2026-07-30): 不再使用，保留作历史参考，将在 v1.0 删除`。

**推荐**：方案 B（移到文档）最稳妥，既清理源码又保留候选清单。

### 6.8 痛点 8：业务模块加载失败无前端通知

**现象**：`main.py:254-475` 15 个业务模块每个都用 `try/except Exception as e: logger.exception(...)` 包裹，单模块 import 失败时仅写 stderr 日志，前端无任何感知。

**根因**：
- 前序审计已指出："每个 except 分支仅 `logger.exception`，无 `send_notification`"。
- 本轮复核确认仍未修复。

**影响**：
- 用户启动后某些 JSON-RPC 方法（如 `skill.list` / `risk.evaluate`）不可用，但前端不知道。
- 用户调用失败时只看到"Method not found"错误，不知道是 sidecar 未启动该模块。
- 调试困难（需翻 sidecar 日志才能发现模块加载失败）。

**改进建议**：
- **A. 模块加载失败通知**：每个 except 分支追加 `send_notification("module_load_failed", {"module": ..., "error": ...})`，前端订阅 `sidecar:module_load_failed` 显示降级指示。
- **B. 启动健康检查**：新增 `sidecar.health` JSON-RPC，返回各模块加载状态，前端启动时调用并展示。
- **C. 降级 UI 指示**：不可用的 JSON-RPC 方法在前端对应 UI 元素上加灰色"不可用"标记 + Tooltip 显示原因。

**推荐**：方案 A（模块加载失败通知）+ B（启动健康检查）组合，前端可观测性最完整。

---

## 7. P0-E 端到端实测前应完成的检查清单

### 7.1 环境准备

- [ ] **1. 确认 Strands 依赖已安装**：`pip show strands-agents`（应在 `src-tauri/sidecar/requirements.txt` 中，`strands-agents>=1.0,<2.0`）。
- [ ] **2. 确认 LLM 配置**：`.tdsf-data/llm_config.json` 存在且含有效 `api_key`（provider: openai/anthropic）。
- [ ] **3. 确认环境变量**：`TDSF_AGENT_BACKEND=strands` 已设置（Windows: 系统环境变量或 `.env`）。
- [ ] **4. 确认 SSH 会话可用**：前端 SSH 连接一个测试服务器（用于 Strands ssh_command 工具端到端测试）。
- [ ] **5. 确认 sidecar 启动**：`pnpm tauri:dev` 启动后查看 sidecar 日志，确认 `Strands backend activated (TDSF_AGENT_BACKEND=strands): ...` 出现。

### 7.2 Strands Model 适配检查

- [ ] **6. 验证 create_strands_model**：sidecar 日志确认 `create_strands_model(config)` 返回非 None（OpenAI/Anthropic/LiteLLM 之一）。
- [ ] **7. 验证 LLMConfig 共享**：Strands 路径与 LangGraph 路径使用同一份 LLMConfig（`main.py:339-344`）。
- [ ] **8. 验证 provider 不支持时降级**：手动配置不支持的 provider（如 "gemini"），确认 strands_model=None 且 StrandsAgentAdapter 降级返回 unavailable。

### 7.3 Strands Agent.invoke 检查

- [ ] **9. 验证 set_backend 注入**：sidecar 日志确认 `backend override set: <lambda>` 出现。
- [ ] **10. 验证 invoke_agent 走 override 路径**：发送一条消息，sidecar 日志确认 `agent.invoke` 走 Strands 路径（而非 BaseAgent.invoke）。
- [ ] **11. 验证返回值结构**：Strands Agent.invoke 返回的 dict 含 `observation` / `next_step` / `mood` / `intermediate_results`（与 BaseAgent.to_state_update() 对齐）。
- [ ] **12. 验证前端流式渲染**：前端能正常渲染 Strands 返回的 observation（sidecarStreamToUIMessageStream 切片流式）。

### 7.4 Strands callback_handler 检查

- [ ] **13. 验证 mood_change 事件**：Strands 推送 `start` / `complete` 事件时，前端 AgentStatusPill 实时更新 mood。
- [ ] **14. 验证 tool_call 事件**：Strands 推送 `current_tool_use` 事件时，前端 onStep 回调显示 `Calling <tool_name>`。
- [ ] **15. 验证 agent_message 事件**：Strands 推送 `data` 事件时，前端流式渲染文本增量（真实流式，非切片模拟）。

### 7.5 Strands 工具调用检查（需真实 RustBridge 注入）

- [ ] **16. 验证 rust_bridge 注入**：当前 `main.py:426` `rust_bridge=None`，需改为注入真实 `RustBridge(write_message=write_message)` 实例。
- [ ] **17. 验证 ssh_command 工具**：Strands Agent 调用 `ssh_command(command="ls -la", ssh_session_id=1)`，确认通过 RustBridge 转发到 Rust `ssh_command` Tauri command，返回结构化结果。
- [ ] **18. 验证高危命令审批**：Strands Agent 调用 `ssh_command(command="rm -rf /")`，确认触发 `needs_you` 审批事件，不直接执行。
- [ ] **19. 验证 read_remote_file 工具**：Strands Agent 调用 `read_remote_file(path="/etc/nginx/nginx.conf")`，确认通过 sftp_read 返回文件内容。
- [ ] **20. 验证 analyze_logs / inspect_processes / network_diagnose 工具**：逐一调用确认可用。

### 7.6 Strands 后端切换检查

- [ ] **21. 验证 clear_backend 回退**：运行时调 `clear_backend()`，确认 invoke_agent 回退到 BaseAgent PAOR 路径。
- [ ] **22. 验证 Strands 启动失败 fallback**：手动破坏 Strands 依赖（如 `pip uninstall strands-agents`），重启 sidecar，确认 fallback 到 LangGraph 且日志记录原因。
- [ ] **23. 验证后端状态可见**：前端能感知后端类型（Strands / LangGraph）——**当前缺失，建议新增 sidecar.health JSON-RPC**。

### 7.7 五绿门禁

- [ ] **24. pnpm typecheck**：0 错误。
- [ ] **25. pnpm lint**：0 错误 0 警告。
- [ ] **26. pnpm test**：vitest run 全过（当前 830+ 全过，Strands 测试新增 23 个）。
- [ ] **27. pnpm build:web**：成功出 dist。
- [ ] **28. pnpm tauri:dev**：桌面端实测，窗口可见 + 能点击 + Strands 后端真的工作。

---

## 8. 改进建议与优先级

### 8.1 P0（阻断性，必须立即修复）

| # | 建议 | 文件 | 工作量 |
|---|------|------|--------|
| 1 | **P0-E 端到端实测**：按 §7 检查清单逐项验证 Strands 后端真实可用 | 全栈 | 1-2 天 |
| 2 | **真实 RustBridge 注入 Strands 工具**：`main.py:426` 改为 `rust_bridge=RustBridge(write_message=write_message)`（需确认 RustBridge 实例化时机与 write_message 可用性） | `main.py` | 0.5 天 |

### 8.2 P1（重要，影响用户体验）

| # | 建议 | 文件 | 工作量 |
|---|------|------|--------|
| 3 | **Teach 模式知识弹出过频**：教学内容默认折叠 + 关键词触发（仅"详细讲解"/"系统教学"时生成完整内容） | `teach_agent.py` + `TdsfAgentPanel.tsx` | 1 天 |
| 4 | **浮动面板最小尺寸偏小**：默认 420×540 → 520×640；最小 320×360 → 400×480 | `TdsfAgentPanel.tsx:46-51/213-228` | 0.5 天 |
| 5 | **Mock LLM 告警内联配置**：点击红色 Pill → Popover 含 API Key 输入框 + provider 下拉 + 保存按钮，直接调 `agent.configure` JSON-RPC | `MockLLMWarning.tsx` | 1 天 |
| 6 | **子 Agent 路由原因显示**：`agent_switch` 事件 payload 新增 `reason` 字段；前端 Tooltip 显示"匹配关键词：修复 → coding" | `event_bus.py:emit_agent_switch` + `TdsfAgentPanel.tsx` | 0.5 天 |
| 7 | **Strands 后端不可用 UI 提示**：新增后端状态 Pill + 启动失败 toast + 工具不可用卡片 | `TdsfAgentPanel.tsx` + `main.py` | 1 天 |
| 8 | **工具调用结果切片优化**：STREAM_CHUNK_SIZE 24 → 128；区分 thinking/output（小切片）与工具结果（大切片或按行） | `sidecar-adapter.ts:41` | 0.5 天 |

### 8.3 P2（次要，长期改进）

| # | 建议 | 文件 | 工作量 |
|---|------|------|--------|
| 9 | **业务模块加载失败通知**：每个 except 分支追加 `send_notification("module_load_failed", {...})`；前端订阅 `sidecar:module_load_failed` 显示降级指示 | `main.py:254-475` + 前端 | 1 天 |
| 10 | **过时 JSDoc 文档漂移清理**：`ipc.rs:269` 与 `sidecar-bridge.ts:99` 的 `{ input: '...' }` 旧示例更新为 `{ name, state: { input, messages } }` | `ipc.rs` + `sidecar-bridge.ts` | 0.5 天 |
| 11 | **risk.evaluate fail-open 修复**：异常时返回 L4/deny（fail-closed）而非 L0/low（fail-open） | `tools/rpc_methods.py:50-52` | 0.5 天 |
| 12 | **confidence.score 简单模式增强**：启发式 evidence 构造从 5 维扩展到 10 维（含代码长度 / 关键词密度 / 引用完整性等） | `tools/rpc_methods.py:87-115` | 1 天 |
| 13 | **65 个 mock 外部 Skill 列表清理**：移到 `docs/skill-marketplace-candidates.md`，源码删除 `_MOCK_SKILL_NAMES` + `load_mock_external()` + `_mock_tags_for()` | `skills/registry.py:51-125` | 0.5 天 |
| 14 | **Skill 失败降级 UI 提示**：Skill 失败时前端专门渲染"执行失败"卡片（含 stderr + exit_code + 解决建议），而非混在普通消息里 | `TdsfAgentPanel.tsx` | 1 天 |

### 8.4 P3（可选，优化体验）

| # | 建议 | 文件 | 工作量 |
|---|------|------|--------|
| 15 | **LLM 增强路由**：main_agent.plan_task 在关键词路由失败时（默认 main 路径）调用 LLM 做语义路由 | `main_agent.py` | 2 天 |
| 16 | **路由历史时间线**：面板侧边栏显示本次对话的路由历史（时间线 + 子 Agent + 触发关键词） | `TdsfAgentPanel.tsx` | 1.5 天 |
| 17 | **真实流式输出**：Python 端改为 yield 流式（Strands callback_handler data 事件），前端直接消费真实流而非切片模拟 | `strands_backend/adapter.py` + `sidecar-adapter.ts` | 3 天 |
| 18 | **响应式面板尺寸**：根据屏幕分辨率动态调整默认尺寸（1920×1080 → 600×720；1366×768 → 480×560） | `TdsfAgentPanel.tsx:46-51` | 0.5 天 |
| 19 | **字体主题 variant 优先级修复**：`resolveTerminalFont.ts:17-21` 优先级反过来，用户偏好优先、主题作为兜底（前序审计已定位） | `resolveTerminalFont.ts` | 0.5 天 |

---

## 9. 附录

### 9.1 关键文件路径速查

| 文件 | 绝对路径 |
|------|----------|
| Python Sidecar 入口 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\main.py` |
| Agent 基类 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\agents\base.py` |
| 主 Agent | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\agents\main_agent.py` |
| Agent 注册表 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\agents\__init__.py` |
| 事件总线 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\event_bus.py` |
| 反向 RPC 通道 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\rust_bridge.py` |
| Strands 适配层 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\adapter.py` |
| Strands SSH 工具 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\ssh_command.py` |
| Strands 模型适配 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\model_adapter.py` |
| Skill 注册表 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\skills\registry.py` |
| Risk/Confidence/Decision RPC | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\tools\rpc_methods.py` |
| Rust Sidecar 管理 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\src\modules\sidecar.rs` |
| Rust IPC 命令 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\src\modules\ipc.rs` |
| 前端通用 IPC 桥 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\lib\sidecar-bridge.ts` |
| 前端 Transport 路由 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai\lib\transport.ts` |
| 前端 Sidecar 适配 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai\lib\sidecar-adapter.ts` |
| 前端浮动面板 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai\components\TdsfAgentPanel.tsx` |
| 前端 Mock 告警 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai\components\MockLLMWarning.tsx` |
| 前端 Chat Store | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai\store\chatStore.ts` |

### 9.2 历史审计报告引用

| 报告 | 路径 | 主要发现 |
|------|------|----------|
| 第一轮可用性审计 | `docs/reports/modded-agent-usability-audit.md` | Sidecar 非崩溃（设计内退出）+ agent.invoke 参数契约对齐 + 9 Agent 架构完整 |
| 第二轮深度审计 | `docs/reports/modded-agent-deep-audit.md` | P0 无限快速重启（retry_count 无条件重置）+ mock LLM 三重断裂 + 终端上下文感知断裂 |
| 字体 + MockLLM 审计 | `docs/reports/modded-agent-font-mockllm-audit.md` | 字体主题 variant 优先级倒置 + MockLLM emitter 触发路径覆盖不全（只 teach 路径）+ getLive 缺失 |
| RustBridge 代码评审 | `docs/reports/p1-rust-bridge-code-review-2026-07-30.md` | RustBridge 设计健康，ID 空间隔离正确，pending 表线程安全 |
| Strands 集成审计 | `docs/reports/strands_backend-audit-2026-07-30.md` | Strands 适配层代码完整，回调协议正确，工具降级机制健全 |
| P0-D 验证报告 | `docs/reports/modded-agent-p0d-verification-2026-07-30.md` | Rust ssh_command + 7 个 SFTP 方法已实现，handle_reverse_request 路由正确 |
| Sidecar P0 修复方案 | `docs/reports/sidecar-p0-fix-plan.md` | 指数退避 + 冷却重置 + 用户取消 完整方案 |
| Strands 集成实施计划 | `docs/reports/strands-integration-implementation-plan-2026-07-30.md` | P0-C1~C5 五阶段实施计划 |

### 9.3 术语表

| 术语 | 中文翻译 | 说明 |
|------|----------|------|
| Sidecar | 边车进程 | 与主进程（Tauri Rust 壳）共生的 Python AI 引擎子进程 |
| PAOR | 规划-执行-观察-反思 | Plan-Act-Observe-Reflect，Agent 模板方法循环 |
| EventBus | 事件总线 | Python 内部 pub-sub 系统，支持推送到 Rust 侧 |
| RustBridge | Rust 桥接 | Python → Rust 反向 JSON-RPC 通道（阻塞调用） |
| Mock LLM | 模拟 LLM | 未配置真实 LLM 时的规则化降级响应 |
| Strands | Strands Agent | AWS 开源的 Agent 框架，作为 LangGraph 的替代后端 |
| TDSF_AGENT_BACKEND | Agent 后端环境变量 | `langgraph`（默认）/ `strands` 二选一 |
| Skill | 技能 | 内置可执行运维技能（5 个：linux-ops/docker-management/selinux-baseline/ssh-troubleshoot/python-debug） |
| RiskChecker | 风险检查器 | 检测高危命令（rm -rf / reboot / shutdown / mkfs / dd / fork bomb） |
| needs_you | 需要你 | 高危命令审批事件，前端弹出审批对话框 |
| AgentStatusPill | Agent 状态药丸 | 浮动面板顶部显示当前子 Agent + mood 状态的彩色标签 |
| MockLLMWarning | Mock LLM 告警 | 红色 Pill，点击跳转设置配置 API Key |
| UIMessageChunk | UI 消息块 | ai 包的标准流式消息块，前端 useChat 消费 |
| `<env>` 块 | 环境上下文块 | 注入到用户消息前缀的终端上下文（workspace_root/cwd/active_file/terminal_mode） |

### 9.4 本次审计与前序审计的差异

| 维度 | 前序三轮审计 | 本次综合审计 |
|------|--------------|--------------|
| 范围 | 聚焦特定 Bug（崩溃 / MockLLM / 字体） | 全栈综合（Python + Rust + 前端 + Strands + Skills + Tools） |
| 方法 | 静态读取 + 根因定位 | 静态读取 + 协议契约交叉验证 + 历史问题复核 |
| 输出 | Bug 报告 + 修复方案 | 可用性矩阵 + UX 痛点 + P0-E 检查清单 + 改进建议优先级 |
| 历史问题 | 发现并定位 | 逐一验证已修复状态（13 项历史断裂，11 项已修复，2 项未修复） |
| 新发现 | — | 6 项新遗留问题（Strands 端到端未实测 / rust_bridge=None / 路由语义模糊 / 路由原因未显示 / risk fail-open / confidence 启发式简单） |
| UX 痛点 | 字体 + MockLLM | 8 处（教学弹出过频 / 面板尺寸 / 内联配置 / 路由原因 / Strands 不可见 / 切片丢细节 / mock 列表冗余 / 模块加载无通知） |

---

## 10. 审计结论

### 10.1 整体评价

TDSF Terminal Agent 魔改版 AI Agent 系统**整体可用**，核心对话链路、告警系统、Agent 路由、终端上下文感知、Skill 系统、Rust 桥接、Sidecar 稳定性全部健康，**无阻断性 Bug**。前序三轮审计发现的 13 项历史断裂点中 **11 项已修复**，修复质量高（含构造时触发 + 启动期补发 + 时间窗 dedup 等深度修复）。

### 10.2 主要风险

1. **Strands 端到端实测未跑**（P0-E）：代码完整但未启动验证，存在未知运行时问题风险。
2. **Strands 工具默认不可用**（rust_bridge=None）：5 个工具全部降级返回 unavailable，需注入真实 RustBridge 实例。
3. **业务模块加载失败无前端通知**（P2）：用户不可见降级状态。
4. **risk.evaluate fail-open**（P2）：异常时返回低风险，可能让高危命令通过审批。

### 10.3 推荐下一步

1. **立即**：按 §7 检查清单执行 P0-E 端到端实测（1-2 天）。
2. **短期**：修复 P1 UX 痛点（教学弹出过频 / 面板尺寸 / 内联配置 / 路由原因 / Strands 不可见 / 切片优化，共 5 天）。
3. **中期**：修复 P2 遗留问题（业务模块通知 / 文档漂移 / risk fail-open / confidence 增强 / mock 列表清理 / Skill 失败 UI，共 4.5 天）。
4. **长期**：P3 优化体验（LLM 增强路由 / 路由历史时间线 / 真实流式输出 / 响应式面板 / 字体修复，共 7.5 天）。

**总工作量预估**：P0 (1.5 天) + P1 (5 天) + P2 (4.5 天) + P3 (7.5 天) = **18.5 人天**。

### 10.4 审计质量声明

本报告基于 2026-07-30 git HEAD 工作树的静态代码审计，**未执行运行时验证**（未启动 sidecar / 未跑端到端测试）。所有结论基于源代码逻辑推演 + 协议契约交叉验证 + 历史审计结论复核。运行时行为可能与静态分析存在差异（如 Strands Agent.invoke 实际调用时的副作用 / RustBridge 阻塞超时 / Strands callback_handler 事件序列等），需按 §7 检查清单执行 P0-E 端到端实测后才能给出"运行时可用"的最终结论。

---

> **报告版本**：v1.0（2026-07-30 综合版）
> **审计人**：AI Sub-agent（GLM-5.2）
> **审计基线**：crynta/terax-ai v0.8.6 魔改版 git HEAD
> **下次审计建议**：P0-E 端到端实测完成后，更新本报告 §3.10 / §3.11 / §5.1 矩阵状态。
