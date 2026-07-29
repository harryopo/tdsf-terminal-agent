# TDSF Terminal Agent 魔改版 AI Agent 深度可用性审查报告（深化版）

> 审计时间：2026-07-30（深化版，第二轮）
> 审计范围：`src-tauri/sidecar/` Python 引擎 + `src-tauri/src/modules/sidecar.rs` / `ipc.rs` Rust 桥 + `src/modules/ai/` 前端面板 + 终端集成链路
> 审计方法：全量读取源文件（非 README/目录结构），交叉验证前后端协议契约 + 终端集成缺口 + 重启循环逐行推演
> 严守约束：未修改魔改版任何业务文件（仅本报告 + `sidecar-p0-fix-plan.md` 两个文档）；所有引用为 `file:///` 绝对路径 + file:line 证据
> 前置基线：本报告在第一轮审计（同文件 v1）基础上深化，复用其 §3 结论，本次新增重点为 **P0 重启循环真实行为纠正**、**mock LLM 告警三重断裂（非双重）**、**P0 完整修复方案独立成文**

---

## 0. 执行摘要

| 维度 | 结论 |
|------|------|
| Sidecar 是否"崩溃" | **否**。`main.py:530` 的 `stdin closed, exiting` 是设计内退出路径（与第一轮审计一致） |
| **P0 真实行为（纠正）** | 前轮称"毫秒级空转 3 次后 Crashed"**不准确**。逐行推演证实：`start():307` 无条件 `retry_count.store(0)` 抵消 `exit_watcher:980` 的 `fetch_add`，"发 ready 后即崩"场景下 `MAX_RETRY` **永不触发**，形成**无限快速重启循环**（CPU/日志双爆）。详见 §2.0 + 独立方案 `sidecar-p0-fix-plan.md` |
| **P1-a mock LLM 告警三重断裂（深化）** | 前轮只发现"双重断裂"（EventType 未注册 + 前端缺前缀）。本轮新发现**第三重**：`base.py:550` 调用 `event_bus.publish("mock_llm_active", {...}, source=...)` 传 3 参数，但 `event_bus.py:225` 的 `publish(self, event: Event)` 只接受单个 Event 对象 → **TypeError 被静默吞掉**，事件连 EventBus 都进不去，根本到不了 VALID_EVENT_TYPES 校验。详见 §2.3 |
| **P1-b Python agent 终端上下文感知（复核）** | `transport.ts:122` 从 `options.messages`（裸文本）取 `input` 而非 `messagesForRun`（含 `<env>` 块），`main_agent.py:310` 用裸 `input` 做关键词路由——确认与第一轮一致，仍未修复。详见 §4.1 |
| 前后端 agent.invoke 参数契约 | **正确对齐**（第一轮已纠错）。`{name, state: {input, messages}}` 在运行时路径中传递正确 |
| 过时 JSDoc 文档漂移 | `ipc.rs:269` 与 `sidecar-bridge.ts:99` 仍写着 `{ input: '...' }` 旧示例，**仍未清理**（P2） |
| 业务模块加载失败通知 | `main.py:266-475` 各 except 分支仅 `logger.exception`，无 `send_notification`，前端无感知（P2，与前轮一致） |
| 推荐动作 | P0 按 `sidecar-p0-fix-plan.md` 实施指数退避 + 冷却重置 + 用户取消；P1 修 mock 三重断裂 + 终端上下文注入；P2 清理文档漂移 + 模块加载通知 |

---

## 1. 审计的文件清单（本轮复核 + 新增核实）

| # | 文件 | 角色 | 本轮动作 |
|---|------|------|----------|
| 1 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py` | Python Sidecar 入口（596 行） | 全量复读 |
| 2 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/event_bus.py` | 事件总线 pub-sub（563 行） | **全量复读**（核实 publish 签名） |
| 3 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py` | BaseAgent PAOR 模板方法（896 行） | 复读 `_publish_mock_warning`（:537-561） |
| 4 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/main_agent.py` | 主 Agent PAOR 监督 + 8 子 Agent 路由（641 行） | 复读 `plan_task`/`select_tool`（:120-248） |
| 5 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/sidecar.rs` | Rust 进程管理 + 重启循环（1232 行） | **全量复读**（推演重启链） |
| 6 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/ipc.rs` | Rust JSON-RPC 协议层 | 复读 :240-300（文档漂移） |
| 7 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/lib.rs` | Tauri 入口 | Grep `start_restart_loop`/`manage`（:235-258） |
| 8 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/lib/sidecar-bridge.ts` | 前端通用 IPC 桥 | 复读 :80-120（文档漂移） |
| 9 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/transport.ts` | 前端上下文感知 transport 路由（256 行） | **全量复读** |
| 10 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts` | 前端 sidecar 流式适配层（531 行） | 复读 :200-300（事件监听 + agent.invoke） |
| 11 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/components/MockLLMWarning.tsx` | Mock LLM 告警 UI（109 行） | **全量复读** |
| 12 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/components/TdsfAgentPanel.tsx` | 浮动 Agent 面板 | 沿用第一轮结论 |
| 13 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/agents/registry.ts` | 前端 Agent 元数据 | 沿用第一轮结论 |
| 14 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/store/chatRuntime.ts` | 前端 sendMessage 入口 | 沿用第一轮结论 |
| 15 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/tools/terminal.ts` + `tools/context.ts` | 前端终端工具 + ToolContext | 沿用第一轮结论 |
| 16 | `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/docs/dev-state.md` | 项目状态记忆 | 全量复读（确认 P2-5 描述） |

> 其余文件（risk_engine.py / rpc_methods.py 等）沿用第一轮审计结论，本轮未复读。

---

## 2. P0：Sidecar 重启循环真实行为（深化 + 纠正）

### 2.0 纠正前轮"毫秒级空转 3 次后 Crashed"

前轮报告（§0 / §5 P0 行）称：
> "Rust `sidecar.rs:1006-1031` 重启循环无退避——Python 启动期失败时毫秒级空转 3 次后 Crashed"

**逐行核实后，该描述不准确**。真实行为按场景分如下（file:line 证据）：

```
重启链：
lib.rs:235   SidecarManager::new(script)
lib.rs:245   start_restart_loop().await     ← 启动 restart_loop task（在 start() 之前）
lib.rs:249+  sidecar_manager.start()        ← 首次启动 Python

sidecar.rs:256-340   start()
  ├─ :271   spawn_python() → (child, stdin, stdout)
  ├─ :298   存 child 到 self.child
  ├─ :304   wait_for_ready()  ← Python 崩溃时 reader_task 标 Crashed(:767)，此处立即返回 Err(:674-678)
  ├─ :307   retry_count.store(0)  ← ⚠️ 无条件重置（无限重启根因）
  └─ :331   spawn(exit_watcher_task)  ← 仅 start() 成功才 spawn

sidecar.rs:348-393   start_restart_loop()
  └─ :373   match manager.start().await { ... }  ← ⚠️ 收到信号立即 start，无 sleep

sidecar.rs:943-1038  exit_watcher_task()
  ├─ :980   retry = retry_count.fetch_add(1)  ← 返回旧值并自增
  ├─ :981   if retry >= MAX_RETRY(3) { Crashed + return }
  └─ :1019  restart_tx.send(())  ← 发信号给 restart_loop
```

| 场景 | 触发条件 | 实际行为 | 是否循环 |
|------|----------|----------|----------|
| A. spawn 失败 | python 解释器/脚本不存在 | `start()` 在 `spawn_python` 返回 `Err`（`:271`），`exit_watcher` 未 spawn，**不自动重启** | ❌ 单次 |
| B. ready 前崩溃 | Python import 阶段失败 | `spawn_python` 成功但 Python 立即退出 → `reader_task` 标 Crashed（`:767`）→ `wait_for_ready` 立即返回 `Err`（`:674-678`）→ `start()` 返回 `Err` → `exit_watcher` **未 spawn**（`:331` 未到达）→ **不自动重启**；child 句柄泄漏在 `self.child`（`:298` 存入但无人 `wait`） | ❌ 单次 |
| C. ready 后崩溃 | 运行时崩溃 | `start()` 成功 → `:307` **retry_count 重置为 0** → `:331` spawn `exit_watcher` → Python 崩溃 → `:980` retry=0 fetch_add→1，0<3 发信号 → `restart_loop` **立即** `start()` → 若新 Python 又发 ready 后崩溃 → `:307` **又重置为 0** → 永远 0→1→0→1… | ✅ **无限快速重启** |
| C→B 混合 | 第1次 ready 后崩，第2次 ready 前崩 | 第1次触发 exit_watcher 发信号 → restart_loop start() 第2次失败 → exit_watcher 未 spawn → 不再重启 | ❌ 重启 1 次后停 |

**核心结论（三处纠正/深化）**：
1. **前轮"3 次后 Crashed"几乎不会发生**——场景 B/C→B 下 `exit_watcher` 不 spawn（`start()` 在 `:331` 之前 return Err），发不出 3 次信号。
2. **真正的 P0 Bug 是场景 C 的"无限快速重启"**：`start():307` 无条件 `retry_count.store(0)` 抵消 `exit_watcher:980` 的 `fetch_add`，`MAX_RETRY` 永不触发，`restart_loop:373` 无退避立即 `start()`，Python 反复 spawn→ready→崩溃→再 spawn，CPU 与日志双爆。这是比"3 次空转"严重得多的故障模式。
3. **次要缺陷**：场景 B 下 child 句柄泄漏（`self.child` 被下次 `start():298` 覆盖前未 `wait`），tokio `Child` drop 不自动 reap。

### 2.1 前轮修复方案为何不完整

前轮建议"`sidecar.rs:1006` 前插入指数退避（1s/2s/4s，上限 10s）"，4 行代码。该方案：
- ❌ 未触及 `:307` 的 `retry_count` 无条件重置——即便加退避，场景 C 下 `retry_count` 永远是 0/1，退避永远是 `2^0=1s`，**不会递增**，且永不达 `MAX_RETRY`，仍是无限重启（只是每次间隔 1s）。
- ❌ 未提供用户取消机制——退避 sleep 期间用户点"停止 Sidecar"不会中断。
- ❌ 未处理场景 B 的 child 句柄泄漏。

### 2.2 完整修复方案（独立成文）

见 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/docs/reports/sidecar-p0-fix-plan.md`。

方案要点（治本）：
- `MAX_RETRY` 3 → 5
- 指数退避 `2^(retry-1)` 秒：1 / 2 / 4 / 8 / 16 / 32 / 60（上限 60s）
- **移除 `start():307` 无条件重置**；改为 `exit_watcher` 的"运行冷却"机制：运行 ≥60s 后崩溃才重置 retry_count（偶发不累积），快速崩溃持续递增
- 新增 `cancel_tx` channel，`stop()` 发送，`restart_loop` 退避 sleep 期间 `select!` 监听，用户可中断
- `start()` 失败路径补 `child.kill()+wait()` 修复句柄泄漏
- 并发安全：`SidecarManager` 已 `#[derive(Clone)]` 全 Arc，新增字段同模式；分段持锁无死锁

---

## 3. Python Sidecar 审查

### 3.1 启动流程与退出语义（结论：设计正确，无 Bug）

**证据**：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py:524-531`

```python
while not _shutdown_flag:
    try:
        line = sys.stdin.readline()
        if not line:
            logger.info("stdin closed, exiting")  # ← 设计内退出
            break
```

- `main.py:489-496` 在业务模块 import 前安装 `log_capture` handler
- `main.py:511-520` 通过 `send_notification("ready", {...})` 主动握手，与 Rust `READY_TIMEOUT=10s` 对齐
- `main.py:584-588` 退出时 `needs_you.stop_global_service()` 清理线程

**结论**：`docs/dev-state.md` P2-5 仍把 "stdout closed 退出" 标记为"崩溃未动"，描述误导。实际是 Rust 关闭 stdin 后 Python 的优雅退出。建议更新 dev-state 文案。

### 3.2 业务模块注册（结论：架构完整，静默降级有可观测性缺口，与前轮一致）

**证据**：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py:254-475`

15 个业务模块每个都用 `try/except Exception as e: logger.exception(...)` 包裹。单模块 import 失败时仅写 stderr 日志，**前端无任何感知**。本轮复读确认仍未修复。

**修复建议**：每个 except 分支追加 `send_notification("module_load_failed", {"module": ..., "error": ...})`，前端订阅 `sidecar:module_load_failed` 显示降级指示。

### 3.3 LLM 配置与 mock 降级 —— 告警链路【三重断裂】（深化）

**证据链**：

1. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py:339-344`：未配置时 `llm_call=None`
2. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py:510-535`：未配置走 `_mock_llm()`，返回 `"[mock-llm] {name} received: {last_user[:200]}"`
3. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py:537-561`：`_publish_mock_warning` 试图推送告警

**【第三重断裂·本轮新发现】base.py 调用 publish 签名错误（P1）**

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/event_bus.py:225`：

```python
def publish(self, event: Event) -> int:
    """发布事件"""
    # 校验 event_type
    if event.event_type not in VALID_EVENT_TYPES:
        logger.warning(f"unknown event_type: {event.event_type}, skipping")
        return 0
```

`publish` **只接受单个 `Event` 对象**，无重载（Python 同名方法后者覆盖前者；event_bus.py 提供 `emit_mood_change`/`emit_agent_message`/`emit_tool_call`/`emit_needs_you`/`emit_agent_switch` 等便捷方法，但**没有** `emit_mock_warning`）。

而 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py:550-559`：

```python
self.event_bus.publish(
    "mock_llm_active",          # ← 位置参数 1：字符串，但 publish 期望 Event 对象
    {                           # ← 位置参数 2：dict，publish 不接受
        "agent": self.name,
        "reason": reason,
        "detail": detail[:200],
        "timestamp": time.time(),
    },
    source=f"{self.name}_agent",  # ← 关键字参数：publish 不接受
)
```

传了 3 个参数（2 位置 + 1 关键字），与 `publish(self, event: Event)` 签名不符 → 抛 `TypeError: publish() got an unexpected keyword argument 'source'`（或位置参数错误）→ 被 `base.py:560-561` 的 `except Exception as e: logger.debug(...)` **静默吞掉**。

**净效果**：`mock_llm_active` 事件**连 EventBus 的 publish 入口都进不去**，根本到不了 `event_bus.py:240` 的 `VALID_EVENT_TYPES` 校验，更别说到达 Rust/前端。前轮说的"双重断裂"里的第一重（EventType 未注册）实际上**不会触发**——因为事件在 publish 调用阶段就 TypeError 了。

**【第一重断裂·复确认】EventType 未注册（P1，但被第三重短路）**

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/event_bus.py:48-59`：

```python
class EventType(str, Enum):
    MOOD_CHANGE = "mood_change"
    AGENT_MESSAGE = "agent_message"
    TOOL_CALL = "tool_call"
    NEEDS_YOU = "needs_you"
    PROJECT_UPDATE = "project_update"
    SIDECAR_EVENT = "sidecar_event"
    AGENT_SWITCH = "agent_switch"
    # ⚠️ 没有 MOCK_LLM_ACTIVE
```

即便修复第三重（改用 Event 对象调用 publish），事件仍会被 `event_bus.py:240-242` 静默丢弃（`return 0`，不调 `_rust_notifier`）。

**【第二重断裂·复确认】前端监听事件名缺 `sidecar:` 前缀（P1）**

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/sidecar.rs:805-806`：

```rust
let event_name = format!("sidecar:{}", method);
handle.emit(&event_name, &params)
```

Python 推 `"mock_llm_active"` → Rust emit `"sidecar:mock_llm_active"`。

但 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/components/MockLLMWarning.tsx:58`：

```typescript
const un = await listen<MockLLMEvent>("mock_llm_active", (event) => {
  // ⚠️ 缺 sidecar: 前缀，永远监听不到
```

**三重断裂的综合后果**：用户未配置 LLM 时，Agent 输出 `[mock-llm] main received: ...` 模板文本，但 UI 上红色告警 Pill **永远不显示**，用户误以为 AI 在工作。直接违反用户记忆硬约束"不允许跳步降级"。

**完整修复（三处都要改）**：

```python
# 1. event_bus.py:48-59 EventType 追加：
class EventType(str, Enum):
    # ... 现有 7 个
    MOCK_LLM_ACTIVE = "mock_llm_active"  # 新增

# 2. base.py:550-559 改用 Event 对象调用 publish（或新增 emit_mock_warning 便捷方法）：
from event_bus import Event, EventType  # 若未导入
self.event_bus.publish(
    Event(
        event_type="mock_llm_active",
        payload={
            "agent": self.name,
            "reason": reason,
            "detail": detail[:200],
            "timestamp": time.time(),
        },
        source=f"{self.name}_agent",
    )
)
# 或更优雅：在 event_bus.EventBus 新增 emit_mock_warning 便捷方法，与 emit_mood_change 同模式
```

```typescript
// 3. MockLLMWarning.tsx:58 改为：
const un = await listen<MockLLMEvent>("sidecar:mock_llm_active", (event) => {
```

### 3.4 RiskEngine 4 层管道（结论：A级，完整可用，沿用前轮）

详见第一轮报告 §2.4。缺口：risk 工具仅在被 agent 显式调用时生效，`main_agent.select_tool` 只在 task 含"风险"/"risk"时才调（`main_agent.py:221`），且 `command = state.get("input", task)`（`:219`）取的是用户原始问题而非实际命令——风险评估流于形式（P2，沿用前轮）。

### 3.5 事件总线 EventType 缺项汇总

| 推送方 | event_type | 在 EventType 中 | 状态 |
|--------|-----------|-----------------|------|
| `base.py:635` | `mood_change` | ✅ | 正常 |
| `base.py:709` | `agent_message` | ✅ | 正常 |
| `base.py:674` | `agent_switch` | ✅ | 正常 |
| `base.py:551` | `mock_llm_active` | ❌ | **被丢弃**（且第三重断裂使其根本到不了校验） |
| 其他工具 | `tool_call`/`needs_you`/`project_update`/`sidecar_event` | ✅ | 正常 |

---

## 4. 前端 AI 模块 + 终端集成审查

### 4.1 Python agent 完全感知不到终端实时上下文（P1，复确认）

**证据链（本轮全量复读 transport.ts 核实）**：

1. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/transport.ts:104-145`：

```typescript
const live = deps.getLive();                  // {cwd, terminalPrivate, workspaceRoot, activeFile}
const envBlock = formatEnvBlock(live);        // 拼成 <env>...</env> 文本块
const messagesForRun = envBlock
  ? injectEnvIntoLastUser(options.messages, envBlock)  // 注入到 user message 文本前
  : options.messages;

const tdsfAgent = deps.getTdsfAgentId?.() ?? null;
if (tdsfAgent) {
  const input = extractLastUserText(options.messages);  // ⚠️ :122 从原 messages 取，不含 envBlock
  const sidecarStream = runSidecarStream({
    agentId: tdsfAgent,
    messages: messagesForRun,  // ← 注入了 envBlock
    input,                     // ← 但 input 是裸文本
```

2. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/transport.ts:241-249`：`formatEnvBlock` 生成 `<env>\nworkspace_root: ...\nactive_terminal_cwd: ...\nactive_file: ...\nactive_terminal_mode: private\n</env>`

3. Python `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/main_agent.py:132-207`：`plan_task` 用 `user_input` 做关键词路由（`input_lower = user_input.lower()`），看不到 cwd/activeFile/terminalPrivate。`state` 里有 `messages`（含 `<env>` 块），但 `main_agent` 不解析 messages 内容，只用 `input` 字段。

4. `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/main_agent.py:219`：`command = state.get("input", task)` 取裸 input 做风险评估。

**后果**（沿用前轮）：
- 用户在 `/etc/nginx` 问"这个目录下有什么配置文件"——Python agent 不知道 cwd
- 用户打开 `nginx.conf` 问"这个文件第 50 行什么意思"——Python agent 不知道 activeFile
- 终端 Privacy 模式时 Python agent 不感知

**修复建议（注入点设计，不实施）**：

**短期（1 行改动）**：`transport.ts:122` 改为 `extractLastUserText(messagesForRun)`，让 Python agent 在 `input` 字段看到 `<env>` 块。然后在 `main_agent.plan_task`/`select_tool` 中显式解析 `<env>` 块提取 `active_terminal_cwd`/`active_file`/`active_terminal_mode` 注入 state。

**长期（协议扩展）**：扩展 `agent.invoke` 的 `state` 参数 schema，新增 `live_context: {cwd, workspace_root, active_file, terminal_private, terminal_buffer_tail}` 结构化字段，Python agent 直接读取，不依赖文本解析。注入点在 `sidecar-adapter.ts:336-345` 的 `params.state` 构造处：

```typescript
params: {
  name: pythonName,
  state: {
    input,
    messages,
    live_context: {  // ← 新增结构化字段
      cwd: live.cwd,
      workspace_root: live.workspaceRoot,
      active_file: live.activeFile,
      terminal_private: live.terminalPrivate,
    },
  },
}
```

Python `main_agent.invoke` 从 `state.get("live_context", {})` 读取，注入 system prompt（`build_system_prompt_base` 追加 "用户当前 cwd: {cwd}，打开的文件: {active_file}"）。

### 4.2 sidecar 路径工具集与终端解耦（P2，沿用前轮）

前端 `buildTerminalTools`（suggest_command / get_terminal_output / open_preview / injectIntoActivePty）只在 Vercel SDK 路径生效（`chatRuntime.ts:153` 注入 `runAgentStream`）；Python sidecar 路径（`transport.ts:122-145`）调 `runSidecarStream` 不传 `toolContext`。Python sidecar 工具只有 risk/confidence/ground/decision，没有读取终端缓冲/注入命令/渲染卡片的工具。详见第一轮 §4.2-4.4。

### 4.3 sidecar-adapter.ts 事件监听缺口（P3，复确认）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts:211-276`：`registerSidecarListeners` 监听 `sidecar:mood_change`（:221）/ `sidecar:tool_call`（:235）/ `sidecar:agent_switch`（:253），**未监听** `sidecar:agent_message`（:205 注释"暂不处理，预留"）。Python `base.py:707-715` 推送的 PAOR 各阶段进度消息前端拿不到。

### 4.4 过时 JSDoc 文档漂移（P2，复确认）

- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/ipc.rs:269`：`params: { input: 'nginx 启动失败' }`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/lib/sidecar-bridge.ts:99`：`await invoke('agent.invoke', { input: 'nginx 启动失败' });`

实际运行时（`sidecar-adapter.ts:286` 注释 + `:336-345`）：`params: { name, state: { input, messages } }`。**仍未清理**，持续误导后续审计（第一轮正是被这两处误导得出"agent.invoke 参数错误"的错误结论）。

### 4.5 TdsfAgentPanel resize effect 隐患（P3，沿用前轮）

`TdsfAgentPanel.tsx:253` 依赖 `geometry.width`，拖动时频繁 add/removeEventListener。建议改用 ref。严重性 P3。

---

## 5. 优先级修复清单（深化版）

| 优先级 | 问题 | 文件:行 | 修复工作量 | 阻塞性 |
|--------|------|---------|------------|--------|
| **P0** | Sidecar 重启循环无退避 + retry_count 无条件重置致无限重启 | `sidecar.rs:307` + `:373` + `:980` | 中等（见 `sidecar-p0-fix-plan.md`，含退避+冷却+取消+child清理） | 阻塞 sidecar 稳定性，CPU/日志双爆 |
| **P1** | **【新】base.py publish 调用签名错误致 mock 告警连 EventBus 都进不去** | `base.py:550-559` | 1 处（改用 Event 对象 or 新增 emit_mock_warning） | 阻塞用户感知 LLM 未配置 |
| **P1** | mock_llm_active 事件类型未注册 | `event_bus.py:48-59` | 1 行（EventType 追加枚举） | 同上（三重断裂之一） |
| **P1** | MockLLMWarning 监听事件名缺前缀 | `MockLLMWarning.tsx:58` | 1 行（`"mock_llm_active"` → `"sidecar:mock_llm_active"`） | 同上（三重断裂之一） |
| **P1** | Python agent 感知不到终端实时上下文 | `transport.ts:122` + `main_agent.py:310` | 短期 1 行 + Python 解析 `<env>`；长期协议扩展 | 阻塞"AI 看到当前终端环境"硬约束 |
| **P2** | sidecar 路径无终端工具 | `src-tauri/sidecar/tools/`（新增 terminal.py） | 中等（3 个 JSON-RPC + 前端桥接） | 阻塞"AI 执行命令"硬约束 |
| **P2** | risk 工具评估用户问题文本而非实际命令 | `main_agent.py:219` | 中等（plan_task 拆出"待评估命令"字段） | 风险评估流于形式 |
| **P2** | 过时 JSDoc 文档漂移 | `ipc.rs:269` + `sidecar-bridge.ts:99` | 2 行 | 误导后续审计 |
| **P2** | 业务模块加载失败无前端通知 | `main.py:266-475` | 小（每个 except 追加 send_notification） | 静默降级用户无感 |
| **P2** | dev-state.md P2-5 文案误导 | `docs/dev-state.md:40-41` | 1 行（标记"设计内退出，非崩溃"） | 误导接手者 |
| **P3** | sidecar-adapter 未监听 agent_message 事件 | `sidecar-adapter.ts:211-276` | 小（追加 listen + onMessage） | 实时进度消息丢失 |
| **P3** | TdsfAgentPanel resize effect 依赖 geometry.width | `TdsfAgentPanel.tsx:253` | 小（改用 ref） | 拖动时频繁重订阅 |
| **P3** | 场景 B child 句柄泄漏 | `sidecar.rs:298`（start 失败路径） | 小（含在 P0 方案中） | 句柄泄漏 |

---

## 6. 集成路线建议（按依赖顺序）

### 阶段 1：稳定基线（P0 + P1 事件链路）
1. **修 P0 退避**：按 `sidecar-p0-fix-plan.md` 实施（指数退避 + 冷却重置 + 用户取消 + child 清理）
2. **修 P1 mock 三重断裂**：
   - `event_bus.py` EventType 追加 `MOCK_LLM_ACTIVE`
   - `base.py:550` 改用 Event 对象调用 publish（或新增 `emit_mock_warning` 便捷方法）
   - `MockLLMWarning.tsx:58` 改事件名为 `sidecar:mock_llm_active`
3. **清理 P2 文档漂移**：`ipc.rs:269` + `sidecar-bridge.ts:99` 更新示例为 `{name, state: {input, messages}}`
4. **更新 dev-state.md P2-5 文案**：标记"设计内退出，非崩溃"+ P0 退避已修
5. 五绿门禁 + tauri:dev 实测 + commit

### 阶段 2：终端上下文感知（P1 核心缺口）
1. **短期**：`transport.ts:122` 改 `extractLastUserText(messagesForRun)`，让 Python agent 在 `input` 看到 `<env>` 块
2. **Python 端**：`main_agent.plan_task`/`select_tool` 解析 `<env>` 块提取上下文注入 state
3. **Python 端**：`build_system_prompt_base` 追加 cwd/active_file 提示
4. 五绿 + 实测 + commit

### 阶段 3：sidecar 终端工具桥（P2）
1. 新增 `src-tauri/sidecar/tools/terminal.py`，注册 `terminal.get_output`/`suggest_command`/`inject`
2. Rust 侧新增 `terminal_get_output`/`terminal_inject` 命令转发
3. `sidecar-adapter.ts` 检测 `suggested_command` 字段渲染 Insert 卡片
4. 五绿 + 实测 + commit

### 阶段 4：风险评估真实化（P2）
1. `main_agent.plan_task` 运维分支拆出"待评估命令"字段
2. `select_tool` 用该字段作为 risk 工具 command 参数
3. risk 返回 `require_approval` 时通过 `needs_you` 推送审批
4. 五绿 + 实测 + commit

### 阶段 5：可观测性补强（P2-P3）
1. `main.py` 模块加载失败推送 `module_load_failed` 事件
2. `sidecar-adapter.ts` 追加 `sidecar:agent_message` 监听
3. `TdsfAgentPanel.tsx:253` resize effect 改用 ref
4. 五绿 + 实测 + commit

---

## 7. 关键发现（Top 6，深化版）

### 发现 1：P0 真正的故障是"无限快速重启"而非"3 次空转"

`start():307` 无条件 `retry_count.store(0)` 抵消 `exit_watcher:980` 的 `fetch_add`。场景 C（Python 发 ready 后即崩）下 retry_count 永远 0→1→0→1，`MAX_RETRY` 永不触发，`restart_loop:373` 无退避立即 `start()`，Python 反复 spawn→ready→崩溃→再 spawn。前轮"3 次后 Crashed"的描述基于对 `exit_watcher` retry 逻辑的解读，但漏了 `start()` 失败时 `exit_watcher` 不 spawn（`:331` 未到达）的细节，且完全没注意到 `:307` 的重置抵消效应。详见 §2.0 + `sidecar-p0-fix-plan.md`。

### 发现 2：mock LLM 告警链路【三重】断裂（前轮只发现双重）

第三重（本轮新发现）：`base.py:550` 调 `self.event_bus.publish("mock_llm_active", {...}, source=...)` 传 3 参数，但 `event_bus.py:225` 的 `publish(self, event: Event)` 只接受单个 Event 对象 → TypeError 被 `base.py:560` 静默吞掉。事件连 EventBus 都进不去，前轮说的"双重断裂"里的第一重（EventType 未注册）实际上被第三重短路——根本到不了 VALID_EVENT_TYPES 校验。完整修复需三处联动（EventType + base.py 调用方式 + 前端前缀），缺一不可。

### 发现 3：Python agent 完全感知不到终端实时上下文（复确认）

`transport.ts:122` 从 `options.messages`（裸文本）取 `input`，而非 `messagesForRun`（含 `<env>` 块）。Python `main_agent.py:310` 用裸 `input` 做关键词路由。直接违反用户硬约束"AI 需能看到当前终端环境"。短期修复 1 行（改 `extractLastUserText(messagesForRun)`），长期需扩展 `agent.invoke` 协议增加 `live_context` 结构化字段。

### 发现 4：sidecar 路径工具集与终端完全解耦（沿用前轮）

前端 `buildTerminalTools` 只在 Vercel SDK 路径生效；Python sidecar 路径走另一套工具（risk/confidence/ground/decision），没有读取终端缓冲/注入命令/渲染卡片的工具。

### 发现 5：risk 工具评估用户问题文本而非实际命令（沿用前轮）

`main_agent.select_tool`（`:219`）用 `state.get("input", task)` 取命令——input 是"nginx 启动失败"而非"systemctl restart nginx"。风险评估流于形式。

### 发现 6：过时 JSDoc 文档漂移持续误导审计（复确认）

`ipc.rs:269` + `sidecar-bridge.ts:99` 仍写 `{ input: '...' }` 旧示例，与运行时 `{name, state: {input, messages}}` 不一致。第一轮正是被其误导得出"agent.invoke 参数错误"的错误结论。**仍未清理**。

---

## 8. 附录：本轮审计验证清单

| 验证项 | 结果 |
|--------|------|
| 本轮全量复读的源文件 | 9 个（main.py / event_bus.py / base.py / main_agent.py / sidecar.rs / transport.ts / MockLLMWarning.tsx / sidecar-adapter.ts / dev-state.md） |
| 本轮 Grep/复读关键段落的文件 | 4 个（ipc.rs / sidecar-bridge.ts / lib.rs / event_bus.py 后半） |
| 纠正前轮结论数 | 2 个（P0"3次空转"→"无限重启"；P1"双重断裂"→"三重断裂"） |
| 新发现 Bug 数 | 2 个（base.py publish 签名错误；start() retry_count 无条件重置致无限重启） |
| 独立成文的修复方案 | 1 个（`sidecar-p0-fix-plan.md`，含完整 diff + 并发安全 + 五绿） |
| 优先级修复清单条数 | 13 条（§5，比前轮 +2：base.py 签名错误、child 句柄泄漏） |
| 是否修改业务文件 | 否（仅本报告 + `sidecar-p0-fix-plan.md` 两个文档） |

---

> 报告字数：约 6800 字（含代码块）
> 审计员：TRAE 子 Agent（GLM-5.2）
> 审计原则：客观、证据驱动、逐行推演、不乐观打分、纠正前轮遗漏
> 前置基线：第一轮报告（同文件 v1）+ `sidecar-p0-fix-plan.md`（P0 完整修复方案）
