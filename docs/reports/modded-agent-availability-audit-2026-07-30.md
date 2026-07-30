# 魔改 Agent 实际可用性深度审计报告（2026-07-30）

> **位置**：`docs/reports/modded-agent-availability-audit-2026-07-30.md`
> **审计时间**：2026-07-30
> **审计范围**：前端 AI 模块（`src/modules/ai/`）+ Python sidecar（`src-tauri/sidecar/`）+ Strands_backend（`src-tauri/sidecar/strands_backend/`）
> **审计方法**：只读静态审计（Read / Grep / SearchCodebase），未修改任何源文件
> **审计约束**：所有发现标注 `file:line` 证据；诚实知止，发现问题直说
> **配套文档**：
> - `docs/reports/modded-agent-deep-audit.md`（前轮深化版，P0 重启循环 + mock 三重断裂）
> - `docs/reports/modded-agent-p0d-verification-2026-07-30.md`（P0-D 三 Bug 修复验证）
> - `docs/reports/strands_backend-audit-2026-07-30.md`（Strands 骨架 4 处 CRITICAL 审计）
> - `docs/reports/ops-agent-survey-2026-07-30.md`（任务 A 输出，开源生态调研）

---

## 1. 执行摘要

| 维度 | 评级 | 结论 |
|------|------|------|
| 前后端链路完整性 | ✅ B+ | `agent.invoke` 参数契约对齐；MockLLMWarning 三重断裂已修复；终端上下文感知已修复 |
| MockLLMWarning 事件链 | ✅ A- | 三重断裂修复有效（EventType 注册 + 前端前缀 + emit_mock_warning）；残留 llm_call_failed 无 dedup + 启动期告警丢失 |
| agent_switch 订阅 | ❌ F | EventBus 已注册 `AGENT_SWITCH` 事件，**前端无监听者**，AgentStatusPill 永远显示 "Main" |
| llm_call_failed dedup | ❌ D | 无去重机制，LLM 失败时可能洪水推送告警 |
| Strands_backend 接线状态 | ❌ F | 4 处 CRITICAL 断裂未修复，整套骨架悬空（即使装好依赖也无法激活） |
| 终端上下文感知 | ✅ A- | `transport.ts:127` 已从 `messagesForRun` 取 input，`<env>` 块正确注入 |
| RiskEngine | ✅ B+ | 4 层风控管道完备；Strands_backend 的 RiskChecker 10 条正则规则覆盖广但与方案偏离 |
| 流式响应 | ⚠️ C+ | 前端 `sidecar-adapter.ts` 切片模拟流式工作；Strands_backend 的 callback_handler 转发设计正确但未激活 |

**总体结论**：魔改 agent 的**核心链路已通**（前端 → transport → sidecar → BaseAgent PAOR → EventBus → 前端），MockLLMWarning 和终端上下文感知两大 P1 问题已修复。**但存在 3 个阻断性问题**：(1) `agent_switch` 事件前端无监听者导致子 Agent 路由状态不显示；(2) Strands_backend 骨架 4 处 CRITICAL 断裂导致首选后端无法激活；(3) llm_call_failed 无去重可能引发告警洪水。建议按 P0→P1→P2 顺序修复。

---

## 2. 前后端链路完整性表

### 2.1 agent.invoke 调用链

| 链路节点 | 文件:行 | 状态 | 说明 |
|----------|---------|------|------|
| 前端 sendMessage | `src/modules/ai/store/chatRuntime.ts` | ✅ | 用户输入入口 |
| transport 路由 | `src/modules/ai/lib/transport.ts:127` | ✅ 修复 | 从 `messagesForRun` 取 input（含 `<env>` 块） |
| sidecar-adapter | `src/modules/ai/lib/sidecar-adapter.ts` | ✅ | JSON-RPC 流式适配 |
| Rust ipc.rs | `src-tauri/src/modules/ipc.rs` | ✅ | JSON-RPC dispatcher |
| Python main.py | `src-tauri/sidecar/main.py:335-358` | ✅ | agents 注册 |
| agents/__init__.py | `src-tauri/sidecar/agents/__init__.py:100-156` | ✅ | AGENT_REGISTRY + get_agent |
| BaseAgent.invoke | `src-tauri/sidecar/agents/base.py:177-367` | ✅ | PAOR 模板方法 |
| EventBus.publish | `src-tauri/sidecar/event_bus.py:230` | ✅ | pub-sub + Rust 推送 |

### 2.2 事件监听链

| 事件类型 | 后端 emit | 前端 listen | 状态 |
|----------|-----------|-------------|------|
| mood_change | `event_bus.emit_mood_change` | `sidecar-bridge.ts` onMood | ✅ 通 |
| agent_message | `event_bus.emit_agent_message` | `sidecar-bridge.ts` onMessage | ✅ 通 |
| tool_call | `event_bus.emit_tool_call` | `sidecar-bridge.ts` onToolCall | ✅ 通 |
| needs_you | `event_bus.emit_needs_you` | `sidecar-bridge.ts` onNeedsYou | ✅ 通 |
| **mock_llm_active** | `event_bus.emit_mock_warning` | `MockLLMWarning.tsx:58` listen `"sidecar:mock_llm_active"` | ✅ 修复 |
| **agent_switch** | `event_bus.emit_agent_switch` | **❌ 无监听者** | 🔴 断裂 |
| sidecar_event | `event_bus.publish` | `sidecar-bridge.ts` onSidecarEvent | ✅ 通 |
| project_update | `event_bus.publish` | `sidecar-bridge.ts` onProjectUpdate | ✅ 通 |

---

## 3. MockLLMWarning 事件链状态（三重断裂修复验证）

### 3.1 三重断裂修复确认

| 断裂点 | 位置 | 修复前 | 修复后 | 验证 |
|--------|------|--------|--------|------|
| **断裂 1** EventType 未注册 | `event_bus.py:48-64` | `EventType` 无 `MOCK_LLM_ACTIVE` | ✅ 已加 `MOCK_LLM_ACTIVE = "mock_llm_active"` (行 64) | 通过 |
| **断裂 2** 前端缺前缀 | `MockLLMWarning.tsx:58-65` | listen `"mock_llm_active"` | ✅ 改为 `"sidecar:mock_llm_active"` | 通过 |
| **断裂 3** publish 签名错误 | `base.py:570-575` | `event_bus.publish("mock_llm_active", {...}, source=...)` 传 3 参数 | ✅ 改用 `event_bus.emit_mock_warning(agent, reason, detail, source=...)` | 通过 |

### 3.2 emit_mock_warning 实现验证

`event_bus.py:514-551`（新增方法）：
```python
def emit_mock_warning(self, agent, reason, detail, session_id=None, source=None):
    payload = {"agent": agent, "reason": reason, "detail": detail[:200], "timestamp": time.time()}
    return self.publish(Event(
        event_type=EventType.MOCK_LLM_ACTIVE.value,
        payload=payload,
        session_id=session_id,
        source=source,
    ))
```
- ✅ 正确构造 `Event` 对象（单参数）传入 `publish`
- ✅ `event_type` 用枚举值 `"mock_llm_active"`，在 `VALID_EVENT_TYPES` 中
- ✅ payload 含 agent/reason/detail/timestamp，前端可渲染

### 3.3 触发点覆盖验证

`base.py:165-171`（`__init__` 构造时触发）：
```python
if llm_call is None and self.event_bus is not None:
    self._publish_mock_warning(
        "no_llm_config",
        f"Agent '{self.name}' 构造时未注入 llm_call, ...",
    )
    self._mock_warning_emitted = True
```
- ✅ 覆盖所有 9 个 Agent 路径（main/coding/explore/history/debug/refactor/test/deploy/teach）
- ✅ 构造时立即推送，不依赖 `call_llm()` 调用

### 3.4 残留隐患

| 隐患 | 严重度 | 位置 | 说明 |
|------|--------|------|------|
| llm_call_failed 无 dedup | 🟠 P1 | `base.py` call_llm 失败分支 | LLM 失败时每次调用都推送告警，可能洪水；需加 dedup（同 agent + 同 reason 60 秒内只推一次） |
| 启动期告警丢失 | 🟠 P1 | `MockLLMWarning.tsx:58` | 前端 `listen` 是异步操作，sidecar 启动期推送的告警可能在监听注册前发出，前端补发机制缺失；建议读取 EventBus 历史事件补发 |

---

## 4. agent_switch 订阅状态（🔴 断裂）

### 4.1 后端 emit 链

`event_bus.py:57-59`：
```python
# v2026-07-29: 主 Agent 路由子 Agent 事件
AGENT_SWITCH = "agent_switch"
```

`agents/main_agent.py` 在 PAOR 循环中路由到子 Agent 时推送 `agent_switch` 事件（如 main → coding → explore）。

### 4.2 前端 listen 链

**问题**：搜索前端代码（`src/modules/ai/`）未找到任何 `listen("sidecar:agent_switch"` 或 `onAgentSwitch` 调用。

**影响**：
- `AgentStatusPill` 永远显示 "Main"，用户无法感知当前活跃子 Agent
- 子 Agent 路由状态对用户不可见，影响教学场景的可观测性

**修复建议**：
1. 在 `sidecar-bridge.ts` 新增 `onAgentSwitch(callback)` 方法
2. 在 `TdsfAgentPanel.tsx` 或 `AgentStatusPill` 中订阅，更新显示的 agent 名称
3. 参考 `MockLLMWarning.tsx:58-65` 的 listen 模式

---

## 5. Strands_backend 接线状态（❌ 4 处 CRITICAL 断裂）

> 详见 `docs/reports/strands_backend-audit-2026-07-30.md`，此处仅摘要

### 5.1 CRITICAL 断裂清单

| # | 断裂点 | 位置 | 影响 | 修复优先级 |
|---|--------|------|------|-----------|
| **C1** | `main.py` 无 feature flag 注入点 | `main.py:335-358` | 即使 `TDSF_AGENT_BACKEND=strands` 也不会激活 Strands | 🔴 P0 |
| **C2** | `agents/__init__.py` 无 `set_backend` 接口 | `agents/__init__.py:100-156` | adapter 无法注入到现有 Agent 系统 | 🔴 P0 |
| **C3** | `requirements.txt` 未声明 `strands-agents` | `requirements*.txt` | pip 不会装 Strands，永远走降级路径 | 🔴 P0 |
| **C4** | Rust method 名不匹配 | `tools/__init__.py:409` 调 `ssh_exec_in_session`，Rust 侧实际是 `ssh_command` | 即使双向 JSON-RPC 实现也调不通 | 🔴 P0 |

### 5.2 Strands_backend 工具实现状态

| 工具 | 文件 | 行数 | 实现质量 | RustBridge 状态 |
|------|------|------|----------|-----------------|
| ssh_command | `tools/ssh_command.py` | 201 | ✅ A（含多行命令拆分检测） | ❌ 未接线（C4） |
| remote_file | `tools/remote_file.py` | 243 | ✅ A | ❌ 未接线（C4） |
| log_analyzer | `tools/log_analyzer.py` | 281 | ✅ A（tail/grep/regex） | ❌ 未接线 |
| process_inspector | `tools/process_inspector.py` | - | ✅ A（list/top/detail） | ❌ 未接线 |
| network_diagnostic | `tools/network_diagnostic.py` | - | ✅ A（ping/ss/netstat） | ❌ 未接线 |
| RiskChecker | `tools/__init__.py:215-326` | - | ✅ A-（10 条正则规则） | N/A（纯静态） |

### 5.3 适配层状态

`adapter.py`（778 行）：
- ✅ `StrandsAgentAdapter.invoke` 返回值与 `BaseAgent.invoke` 对齐（observation/next_step/mood/intermediate_results）
- ✅ `TdsfStrandsCallbackHandler` 把 Strands 事件转发到 EventBus（data→emit_agent_message, current_tool_use→emit_tool_call, start→emit_mood_change）
- ✅ 降级完备（Strands 未装 / model 未注入 / feature flag 关闭时返回 degraded 状态）
- ⚠️ mood 值集合与 BaseAgent 不一致（adapter 推送 `"thinking"`，BaseAgent 只用 `{"done","error","working"}`）

---

## 6. 终端上下文感知状态（✅ 修复）

### 6.1 修复验证

`src/modules/ai/lib/transport.ts:127`：
```typescript
// 修复后：从 messagesForRun（含 <env> 块）取 input
const input = extractLastUserText(messagesForRun);
const sidecarStream = runSidecarStream({
    agentId: tdsfAgent,
    messages: messagesForRun,
    input,  // ← 含 <env> 块，Python agent 可感知 cwd/activeFile
    ...
});
```

- ✅ `messagesForRun` 已注入 `<env>` 块（含 cwd/activeFile/activeTerminal 等）
- ✅ Python `main_agent.py` 收到的 input 包含终端上下文
- ✅ 关键词路由（main → coding/explore/history/...）可基于终端上下文

### 6.2 残留优化点

- 🟡 `formatEnvBlock` 可考虑结构化（当前是文本拼接），便于 Python agent 解析
- 🟡 可参考 NyaTerm 的"终端上下文绑定"设计（选中输出即解释）

---

## 7. RiskEngine 状态

### 7.1 现有 risk 工具

`src-tauri/sidecar/tools/risk.py`（4 层风控管道）：
1. YAML 规则匹配
2. 资产分类
3. 语法分析
4. 命令调整建议

### 7.2 Strands_backend RiskChecker

`strands_backend/tools/__init__.py:161-326`（10 条正则规则）：
- rm_rf_root / rm_rf / reboot / mkfs / dd_to_disk / fork_bomb / chmod_777_root / killall_system / iptables_flush / drop_database

**与现有 risk.py 的关系**：
- RiskChecker 是纯静态快速拦截（同步、无依赖）
- invoke_risk_tool 是 4 层精评（YAML + 资产 + 语法 + 调整）
- 推荐：适配层叠加使用（先 RiskChecker 快速拦，再 risk_tool 精评）

---

## 8. 流式响应状态

### 8.1 当前实现（前端切片模拟流式）

`src/modules/ai/lib/sidecar-adapter.ts:200-300`：
- Python sidecar 返回完整 dict
- 前端按字符切片模拟流式推送
- ⚠️ 非真实流式，延迟较高

### 8.2 Strands_backend 流式设计（未激活）

`adapter.py:89-208`（`TdsfStrandsCallbackHandler`）：
- ✅ 设计正确：Strands `callback_handler` 事件 → EventBus emit
- ✅ data 事件 → `emit_agent_message`（流式推送）
- ✅ current_tool_use → `emit_tool_call`
- ❌ 未激活（受 C1-C4 阻断）

### 8.3 真实流式路径（修复后）

```
Strands Agent stream_async → callback_handler → EventBus.emit_agent_message
  → Rust notification → 前端 onMessage → UI 流式渲染
```

---

## 9. 已知 Bug 清单（按优先级）

| # | Bug | 严重度 | 位置 | 状态 | 修复建议 |
|---|-----|--------|------|------|----------|
| 1 | Strands_backend 4 处 CRITICAL 断裂 | 🔴 P0 | `main.py` / `agents/__init__.py` / `requirements.txt` / Rust method 名 | ❌ 未修复 | 详见 `strands_backend-audit-2026-07-30.md` §5 |
| 2 | agent_switch 前端无监听者 | 🔴 P1 | 前端缺 `listen("sidecar:agent_switch")` | ❌ 未修复 | 在 `sidecar-bridge.ts` + `TdsfAgentPanel.tsx` 新增订阅 |
| 3 | llm_call_failed 无 dedup | 🟠 P1 | `base.py` call_llm 失败分支 | ❌ 未修复 | 同 agent + 同 reason 60 秒内只推一次 |
| 4 | MockLLMWarning 启动期告警丢失 | 🟠 P1 | `MockLLMWarning.tsx:58` | ❌ 未修复 | 读取 EventBus 历史事件补发 |
| 5 | mood 值集合不一致 | 🟡 P2 | `adapter.py:322` 推 `"thinking"`，BaseAgent 不含 | ❌ 未修复 | 统一 mood 枚举 |
| 6 | 过时 JSDoc 文档漂移 | 🟡 P2 | `ipc.rs:269` + `sidecar-bridge.ts:99` | ❌ 未修复 | 清理旧示例 |
| 7 | 业务模块加载失败无通知 | 🟡 P2 | `main.py:266-475` except 分支 | ❌ 未修复 | 加 `send_notification` |
| 8 | `pnpm test:python` 指向废弃目录 | 🟡 P2 | `package.json:19` | ❌ 未修复 | 改指向 `src-tauri/sidecar` |

---

## 10. 下一步行动建议

### 10.1 P0（必须，阻断 Strands 激活）

1. **修复 Strands_backend 4 处 CRITICAL 断裂**（详见 `strands_backend-audit-2026-07-30.md` §5）
   - `main.py` 加 `TDSF_AGENT_BACKEND` feature flag 注入点
   - `agents/__init__.py` 加 `set_backend` / `clear_backend` 接口
   - `requirements.txt` 加 `strands-agents>=1.48.0,<2.0`
   - 工具 Rust method 名对齐（`ssh_exec_in_session` → `ssh_command`，`sftp_read_file` → `sftp_read`）

### 10.2 P1（高，影响可观测性）

2. **修复 agent_switch 前端监听**：在 `sidecar-bridge.ts` 加 `onAgentSwitch`，在 `AgentStatusPill` 订阅
3. **加 llm_call_failed dedup**：同 agent + 同 reason 60 秒内只推一次
4. **加 MockLLMWarning 启动期补发**：读取 EventBus 历史事件

### 10.3 P2（中，清理与优化）

5. 统一 mood 枚举（`thinking` 加入 BaseAgent 或从 adapter 移除）
6. 清理过时 JSDoc 文档漂移
7. 业务模块加载失败加 `send_notification`
8. `pnpm test:python` 改指向 `src-tauri/sidecar`

### 10.4 P3（低，增强）

9. 引入 MCP 协议作为 sidecar JSON-RPC 标准化补充
10. 参考 NyaTerm/Sageport 优化终端上下文绑定 UX
11. 真实流式响应（Strands `stream_async` + callback_handler）

---

## 11. 审计文件清单

| # | 文件 | 角色 | 审计动作 |
|---|------|------|----------|
| 1 | `src/modules/ai/lib/transport.ts` | 前端上下文注入 + sidecar 路由 | 全量复读（验证 P1-b 修复） |
| 2 | `src/modules/ai/components/MockLLMWarning.tsx` | Mock LLM 告警 UI | 全量复读（验证三重断裂修复） |
| 3 | `src/modules/ai/tools/terminal.ts` | 前端终端工具 | 全量复读 |
| 4 | `src-tauri/sidecar/event_bus.py` | 事件总线 | 全量复读（验证 emit_mock_warning） |
| 5 | `src-tauri/sidecar/agents/base.py` | BaseAgent PAOR 模板 | 全量复读（验证 _publish_mock_warning） |
| 6 | `src-tauri/sidecar/strands_backend/adapter.py` | Strands 适配层 | 全量复读（验证对接对齐） |
| 7 | `src-tauri/sidecar/strands_backend/tools/__init__.py` | 工具基础设施 | 全量复读（验证 RustBridge + RiskChecker） |
| 8 | `src-tauri/sidecar/strands_backend/tools/ssh_command.py` | SSH 命令工具 | 全量复读 |
| 9 | `docs/reports/strands_backend-audit-2026-07-30.md` | Strands 骨架审计 | 复用结论 |
| 10 | `docs/reports/modded-agent-deep-audit.md` | 前轮深化审计 | 复用结论 |
| 11 | `docs/reports/modded-agent-p0d-verification-2026-07-30.md` | P0-D 修复验证 | 复用结论 |

---

## 12. 诚实知止声明

1. **未运行代码**：本次为纯静态审计，未执行 `pnpm tauri:dev`，未启动 sidecar，未跑 `pnpm test`。运行验证留待修复 P0 后执行。
2. **未覆盖文件**：`main_agent.py` / `rpc_methods.py` / `risk_engine.py` / `needs_you.py` 等沿用前轮审计结论，本轮未复读。
3. **Strands 集成测试缺失**：因 4 处 CRITICAL 未修复，无法验证 Strands Agent 真实运行行为。
4. **数据基准**：所有结论基于 2026-07-30 工作树状态，后续若有改动需重新审计。

---

> **最后更新**：2026-07-30
> **审计性质**：只读静态审计（未修改任何源文件）
> **任务边界**：本文件仅为审计报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件
