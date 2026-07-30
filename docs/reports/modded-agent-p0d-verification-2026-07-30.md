# 魔改 Agent P0-D 三 Bug 修复验证 + 残留隐患审计报告

> **审计时间**：2026-07-30
> **审计范围**：前一个 AI 完成的 P0-D 三个 Bug 修复（尚未 commit）的实际效果验证 + 残留隐患定位
> **审计方式**：只读静态审查（Read / Grep / SearchCodebase），未修改任何源文件
> **审计约束**：所有发现标注 `file:line` 证据；诚实知止，发现问题直说
> **三个修复**：
> - Bug 1: 字体优先级倒置（`resolveTerminalFont.ts` 改 `??` 为 `||`）
> - Bug 2: MockLLMWarning 触发点不全（`base.py` `__init__` 加 `_publish_mock_warning`）
> - Bug 3: getLive 未暴露（`App.tsx` 暴露 `window.__TDSF_DBG__.getLive/getEnvBlock`）

---

## 0. 概览：三个修复的总体评价

| Bug | 修复评价 | 验证结论 | 残留隐患 |
|-----|----------|----------|----------|
| Bug 1 字体优先级 | ✅ **修复有效** | `||` 让用户偏好优先，链路下游 `applyTerminalFont` 会拿到正确字体 | P2：测试缺 mode 不匹配 + variants 空的场景；`fontSize: 0` 被当 falsy 跳过（实际无影响） |
| Bug 2 MockLLMWarning 触发点 | ✅ **修复有效，但有残留风险** | `__init__` 构造时推送覆盖 9 个 Agent；链路通畅能到前端 | P1：llm_call_failed 无 dedup；P1：MockLLMWarning 无补发机制（启动期告警丢失） |
| Bug 3 getLive/getEnvBlock 暴露 | ✅ **修复有效** | CDP 可读取；逻辑与 transport.ts 一致 | P2：内联实现有漂移风险；formatEnvBlock 导出多余 |

**总体结论**：三个修复的**核心逻辑均正确有效**，前一个 AI 的根因定位准确，修复方案最小侵入。但 Bug 2 修复引入了新的边界风险（启动期告警丢失、llm_call_failed 洪水），且审计过程中发现一个**前 AI 报告未提及的 P1 残留隐患**：`agent_switch` 事件前端无监听者，`AgentStatusPill` 永远显示 "Main"。

---

## 1. Bug 1 字体优先级修复验证

### 1.1 修复正确性

**修复点**：`src/modules/theme/resolveTerminalFont.ts:22-26`

```typescript
return {
  fontFamily: preferences.fontFamily || terminal?.fontFamily || "",
  fontWeight: preferences.fontWeight || terminal?.fontWeight || "normal",
  fontSize: preferences.fontSize || terminal?.fontSize || 14,
};
```

- `||`（falsy OR）让空字符串 `""` / `0` 走右侧，用户偏好非空时优先。
- 优先级链：`用户偏好 > 主题 variant > 默认值（"" / "normal" / 14）`，符合预期。
- variant 选择逻辑 `theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light`（行 14-15）未改动，dark/light fallback 顺序保持。

### 1.2 边界场景验证

| 场景 | 输入 | 输出 | 是否正确 |
|------|------|------|----------|
| 用户设了字体 | `preferences.fontFamily="JetBrains Mono"`, theme=Iosevka | "JetBrains Mono" | ✅ |
| 用户未设（空串） | `preferences.fontFamily=""`, theme=Iosevka | "Iosevka" | ✅ 回退到主题 |
| 主题无字体值 | `preferences.fontFamily="JetBrains Mono"`, theme 仅 foreground | "JetBrains Mono" | ✅ |
| 主题 variant 缺失 | mode="light", theme 仅 dark variant | 走 `theme.variants.dark` | ✅（行 15 `??` 链） |
| fontSize=0 | `preferences.fontSize=0`, theme=16 | 16 | ✅ 0 当 falsy 跳过（0 字号无意义） |
| 全空 | `preferences={fontFamily:"",fontWeight:"",fontSize:0}`, theme 无值 | `{"", "normal", 14}` | ✅ 走默认值 |

**潜在误伤**：`fontWeight: "0"`（字符串）不会被 `||` 跳过（非空字符串是 truthy），无影响。`fontSize: 0` 被跳过是合理行为（0 字号无意义）。

### 1.3 测试覆盖度

**测试文件**：`src/modules/theme/resolveTerminalFont.test.ts`（5 个用例）

| 用例 | 覆盖场景 |
|------|----------|
| `user preferences take priority` | 用户偏好优先于主题 |
| `falls back to theme variant when empty` | 空串回退到主题 |
| `restores global preferences when theme has no font` | 主题无字体值 |
| `uses same variant fallback order` | variant 顺序（dark-only + light mode） |
| `theme fontWeight applies when user empty` | fontWeight 空时用主题 |

**缺失场景**（建议补充）：
1. `mode="light"` 但 theme 只有 `dark` variant → 应走 dark（行 15 `?? theme.variants.dark`）。
2. `theme.variants = {}`（完全空）→ `variant` 为 undefined，`terminal?.fontFamily` 为 undefined，应走默认值。
3. `preferences.fontSize=0` 单独场景（虽然用例 2 包含，但未单独断言）。

**评估**：当前测试覆盖关键路径，边界场景基本够用，但 mode 不匹配 + variants 空的场景建议补一个用例防回归。

---

## 2. Bug 2 MockLLMWarning 触发点修复验证

### 2.1 修复正确性

**修复点**：`src-tauri/sidecar/agents/base.py:158-171`

```python
# TDSF 修复 2026-07-30 (Bug 2): 构造时立即推送 mock LLM 告警
if llm_call is None and self.event_bus is not None:
    self._publish_mock_warning(
        "no_llm_config",
        f"Agent '{self.name}' 构造时未注入 llm_call, "
        f"请检查 .tdsf-data/llm_config.json 或 TDSF_LLM_API_KEY",
    )
    self._mock_warning_emitted = True
```

- 9 个 Agent（main + 8 子：coding/explore/history/teach/debug/refactor/test/deploy）在 `agents/__init__.py:125-129` 循环实例化时都会走 `__init__`，全部覆盖。
- `_publish_mock_warning`（base.py:552-577）调用 `event_bus.emit_mock_warning(...)`，签名正确。
- `emit_mock_warning`（event_bus.py:514-551）构造 `Event` 对象调用 `publish`，`publish`（event_bus.py:230-289）转发到 `_rust_notifier`。

### 2.2 链路追踪（端到端）

```
main.py:273-282   event_bus.register_methods + set_rust_notifier(lambda ...)
                   ↓ _rust_notifier 已注入
main.py:349-352   agents.configure_agents(event_bus=get_global_bus(), llm_call=llm_call)
                   ↓
agents/__init__.py:125-129   for name, cls in AGENT_REGISTRY.items():
                               _agent_instances[name] = cls(event_bus=..., llm_call=...)
                   ↓ llm_call=None 时
base.py:165-171   if llm_call is None and self.event_bus is not None:
                     self._publish_mock_warning("no_llm_config", ...)
                   ↓
base.py:570       self.event_bus.emit_mock_warning(agent=..., reason=..., detail=..., source=...)
                   ↓
event_bus.py:544  self.publish(Event(event_type=MOCK_LLM_ACTIVE.value, payload=..., ...))
                   ↓
event_bus.py:280  self._rust_notifier(event.event_type, event.to_dict())
                   ↓ main.py:280 lambda
main.py:280       send_notification("mock_llm_active", payload)
                   ↓ Rust reader_task
sidecar.rs:886    let event_name = format!("sidecar:{}", method);  // "sidecar:mock_llm_active"
sidecar.rs:887    handle.emit(&event_name, &params)
                   ↓ Tauri event
MockLLMWarning.tsx:62   listen<MockLLMEvent>("sidecar:mock_llm_active", (event) => { setWarning(event.payload); })
```

**链路通畅**：从 Python `__init__` 到前端 Pill 显示，无断裂。前一个 AI 报告中提到的"三重断裂"（EventType 缺失 + publish 签名错误 + 前缀缺失）均已修复。

### 2.3 装配顺序验证

`main.py` 装配顺序（已核实）：
1. 行 273-282：`event_bus.register_methods` + `set_rust_notifier`（EventBus 单例初始化 + Rust 通知器注入）
2. 行 286-298：`needs_you.register_methods` + `set_event_bus`
3. 行 300-313：`fix_loop.register_methods` + `set_event_bus`
4. 行 315-330：`tdsf_loader.register_methods` + `initialize_on_startup`
5. 行 334-355：`agents.register_methods` + `configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)`

**关键**：`event_bus` 在 `agents.configure_agents` 之前已完整初始化（`_rust_notifier` 已注入），所以 `__init__` 中的 `_publish_mock_warning` 能安全调用 `event_bus.emit_mock_warning`。前 AI 报告中"需确认 main.py 装配顺序"的担心已排除。

### 2.4 重复推送风险评估

| 触发点 | dedup 守卫 | 风险 |
|--------|------------|------|
| `__init__`（base.py:165-171） | `_mock_warning_emitted = True`（行 171） | ✅ 每个 Agent 进程生命周期内只发一次 |
| `call_llm` no_llm_config（base.py:536-542） | `if not self._mock_warning_emitted:`（行 536） | ✅ 不会重复（`__init__` 已设 True） |
| `call_llm` llm_call_failed（base.py:532） | **无 dedup** | ⚠️ 每次 LLM 调用失败都推送一次 |

**llm_call_failed 洪水场景**：
- 用户配置了 LLM 但 API Key 失效（如过期/额度耗尽）。
- 每次 `teach_agent.call_llm()` 抛异常 → base.py:532 推送 `llm_call_failed`。
- 前端 `MockLLMWarning.tsx:63` `setWarning(event.payload)` 是覆盖语义，Pill 会持续显示（不闪烁，但事件流会被刷屏）。
- `event_bus._history`（默认 1000 条）会被 llm_call_failed 事件挤满，可能挤掉其他重要事件（如 mood_change / agent_message）。

**评估**：llm_call_failed 无 dedup 是 P1 隐患。建议加 30 秒时间窗去重（同一 reason + detail 摘要 30 秒内只发一次）。

### 2.5 启动期告警丢失风险（P1）

**场景**：
1. sidecar 启动时 `configure_agents` 实例化 9 个 Agent，每个都推送 `mock_llm_active` 事件。
2. 此时前端 `MockLLMWarning.tsx` 可能尚未挂载（用户还没打开 AI 面板 / StatusBar 未渲染）。
3. Tauri `listen` 是即时订阅，**无补发机制**——事件发出时无人监听则丢失。

**证据**：
- `MockLLMWarning.tsx:48-74` `useEffect` 在组件 mount 时才 `listen`。
- `event_bus.py` 有 `get_history` 方法（行 322-346），但 `MockLLMWarning.tsx` 未调用 `invokeRpc('event.history', ...)` 补发。

**影响**：如果用户启动应用后未打开 AI 面板，sidecar 构造时推送的 9 条 `no_llm_config` 告警全部丢失，用户看不到红色 Pill。只有后续 `call_llm` 触发的 `llm_call_failed` 才可能被捕获（前提是 MockLLMWarning 已挂载）。

**修复方向**：`MockLLMWarning.tsx` mount 时主动调用 `invokeRpc('event.history', { event_type: 'mock_llm_active', limit: 1 })`，取最新一条告警补发到 state。

---

## 3. Bug 3 getLive/getEnvBlock 暴露修复验证

### 3.1 修复正确性

**修复点**：`src/app/App.tsx:401-428`

```typescript
// TDSF 修复 2026-07-30 (Bug 3): 暴露 getLive / getEnvBlock
getLive: () => {
  const live = useChatStore.getState().live;
  return {
    cwd: live.getCwd(),
    terminalPrivate: live.isActiveTerminalPrivate(),
    workspaceRoot: live.getWorkspaceRoot(),
    activeFile: live.getActiveFile(),
  };
},
getEnvBlock: () => {
  const live = useChatStore.getState().live;
  const lines: string[] = [];
  const workspaceRoot = live.getWorkspaceRoot();
  const cwd = live.getCwd();
  const activeFile = live.getActiveFile();
  const terminalPrivate = live.isActiveTerminalPrivate();
  if (workspaceRoot) lines.push(`workspace_root: ${workspaceRoot}`);
  if (cwd) lines.push(`active_terminal_cwd: ${cwd}`);
  if (activeFile) lines.push(`active_file: ${activeFile}`);
  if (terminalPrivate) lines.push("active_terminal_mode: private");
  return lines.length === 0 ? null : `<env>\n${lines.join("\n")}\n</env>`;
},
```

### 3.2 与 transport.ts 逻辑一致性

逐行比对 `App.tsx:414-428`（内联）与 `transport.ts:249-257`（导出）：

| 字段 | transport.ts | App.tsx | 一致 |
|------|--------------|---------|------|
| workspaceRoot | `if (live.workspaceRoot) lines.push(\`workspace_root: ${live.workspaceRoot}\`)` | `if (workspaceRoot) lines.push(\`workspace_root: ${workspaceRoot}\`)` | ✅ |
| cwd | `if (live.cwd) lines.push(\`active_terminal_cwd: ${live.cwd}\`)` | `if (cwd) lines.push(\`active_terminal_cwd: ${cwd}\`)` | ✅ |
| activeFile | `if (live.activeFile) lines.push(\`active_file: ${live.activeFile}\`)` | `if (activeFile) lines.push(\`active_file: ${activeFile}\`)` | ✅ |
| terminalPrivate | `if (live.terminalPrivate) lines.push("active_terminal_mode: private")` | `if (terminalPrivate) lines.push("active_terminal_mode: private")` | ✅ |
| 返回值 | `if (lines.length === 0) return null; return \`<env>\n${lines.join("\n")}\n</env>\`` | `return lines.length === 0 ? null : \`<env>\n${lines.join("\n")}\n</env>\`` | ✅ |

**字段顺序、换行符、null 返回值完全一致**。

`getLive` 实现与 `chatRuntime.ts:89-97` 也一致（都从 `useChatStore.getState().live` 读取 4 个字段）。

### 3.3 启动包污染风险评估

**注释说明**（App.tsx:404）：
> 注意: formatEnvBlock 逻辑内联 (不静态 import transport.ts, 避免 @ai-sdk 污染启动包)

**评估**：
- `transport.ts:1` 顶部 `import type { UIMessage } from "@ai-sdk/react"`，如果 App.tsx 静态 import `formatEnvBlock`，会引入 `@ai-sdk/react` 到 App.tsx 的依赖图。
- App.tsx 是主壳，首屏必须加载，引入 `@ai-sdk/react` 会增加启动包体积 / 首屏解析时间。
- **内联实现是合理的权衡**，避免了对启动包的污染。

**但**：`transport.ts:249` 已经 `export function formatEnvBlock`，导出未被 App.tsx 使用。这个导出变得多余（除非其他地方用）。Grep 确认除 transport.ts 自身和测试外，无其他文件 import `formatEnvBlock`。

**漂移风险**：内联实现缺乏测试约束。如果未来 `transport.ts` 的 `formatEnvBlock` 逻辑变化（如增加新字段 `active_terminal_title`），App.tsx 的内联实现不会自动同步，CDP 验证结果会与实际注入的 `<env>` 块不一致。

### 3.4 CDP 可读性

- `window.__TDSF_DBG__` 在 `App.tsx:388-430` 渲染时赋值（每次 App 重渲染都会刷新引用）。
- CDP 执行 `window.__TDSF_DBG__.getLive()` 返回 `{ cwd, terminalPrivate, workspaceRoot, activeFile }` 对象。
- CDP 执行 `window.__TDSF_DBG__.getEnvBlock()` 返回 `<env>\n...\n</env>` 字符串或 `null`。
- 函数是懒执行，只有 CDP 主动调用时才读取 `useChatStore.getState().live`，不存在初始化时序问题。
- **可读性良好**。

---

## 4. 残留隐患清单

### P0 级（阻断功能，必须修）
无。三个修复的核心逻辑均正确有效。

### P1 级（影响体验，建议修）

#### P1-1: `agent_switch` 事件前端无监听者，AgentStatusPill 永远显示 "Main"

**证据**：
- `src/modules/ai/components/AgentStatusPill.tsx:79` 注释说"前端通过订阅 agent_switch 事件实时更新 currentSubAgent"。
- `src/modules/ai/components/AgentStatusPill.tsx:91` 实际代码 `const currentSubAgent = useChatStore((s) => s.currentSubAgent);` 只从 zustand store 读 `currentSubAgent` 字段。
- `src/modules/ai/store/chatStore.ts:276-277` `currentSubAgent: null, setCurrentSubAgent: (name) => set({ currentSubAgent: name })` —— **没有任何地方调用 `setCurrentSubAgent`**！
- Grep `subscribe('agent_switch'|listen.*agent_switch` 在 `src/` 下**零命中**（只有注释提及）。
- Python 端 `base.py:663-697` `_emit_agent_switch` 会推送 `agent_switch` 事件到 event_bus → Rust emit `sidecar:agent_switch`，但前端无人 listen。

**影响**：
- `chatStore.currentSubAgent` 永远是初始值 `null`。
- `AgentStatusPill` 永远显示 "Main"，用户看不到 main_agent 实际路由到了哪个子 Agent（coding/teach/debug/...）。
- `main_agent.py` 的智能路由对用户不可见，违背 v2026-07-29 改造的设计目标（注释 registry.ts:9-10）。

**修复方向**：
在 `TdsfAgentPanel.tsx` 或 `App.tsx` 顶层 useEffect 中订阅 `agent_switch` 事件：
```typescript
useEffect(() => {
  const un = subscribe('agent_switch', (payload) => {
    const p = payload as { agent?: string };
    if (p.agent) useChatStore.getState().setCurrentSubAgent(p.agent);
  });
  return () => { void un.then(fn => fn()); };
}, []);
```

#### P1-2: MockLLMWarning 无补发机制，启动期告警丢失

**证据**：见 §2.5。

**修复方向**：`MockLLMWarning.tsx` mount 时调用 `invokeRpc('event.history', { event_type: 'mock_llm_active', limit: 1 })` 补发最新告警。

#### P1-3: llm_call_failed 无 dedup，可能事件洪水

**证据**：见 §2.4。

**修复方向**：`base.py:532` 加时间窗去重，或改用 `_llm_failed_warning_emitted` 标志（首次失败后只发一次，配置变更后重置）。

### P2 级（文档/死代码，可延后）

#### P2-1: `src/App.tsx` 是自研 v4.0.0 残留死代码，subscribe 了未注册的事件类型

**证据**：
- `src/App.tsx:23` `import { AgentPanel } from './components/AgentPanel'` —— 不在启动链（`src/main.tsx` import `./app/App`）。
- `src/components/AgentPanel.tsx:141` `subscribe('tool_call_result', ...)` —— `tool_call_result` 不在 `event_bus.py:48-64` 的 EventType 枚举。
- `src/components/AgentPanel.tsx:193` `subscribe('knowledge_cards', ...)` —— `knowledge_cards` 同样不在 EventType 枚举。
- `event_bus.py:245-247` `if event.event_type not in VALID_EVENT_TYPES: ... return 0` —— 这些事件会被静默丢弃。

**影响**：虽不在启动链，但容易误导后续开发者复制其 subscribe 模式。建议按 CLAUDE.md 防污染红线删除（需用户确认）。

#### P2-2: MockLLMWarning.tsx:56 注释行号错误

**证据**：
- `MockLLMWarning.tsx:56` 注释 `// Rust sidecar.rs:805 format!("sidecar:{}", method)`。
- 实际位置 `sidecar.rs:886`（已 Grep 确认）。

**影响**：仅文档错误，不影响业务。建议改为 `sidecar.rs:886`。

#### P2-3: base.py:161 注释表述不准确

**证据**：
- `base.py:161` 注释 `(main/coding/explore/history/debug/refactor/test/deploy)` 列了 8 个，漏了 `teach`。
- 实际 9 个 Agent（`agents/__init__.py:83-94` AGENT_REGISTRY 含 teach）。

**影响**：仅注释错误。建议改为 `(main + 8 子: coding/explore/history/teach/debug/refactor/test/deploy)`。

#### P2-4: formatEnvBlock 导出多余

**证据**：
- `transport.ts:249` `export function formatEnvBlock` 已导出。
- App.tsx 未 import 它（内联实现）。
- Grep 确认无其他文件 import `formatEnvBlock`。

**影响**：导出未被使用，但保留也无害（未来可能有其他消费者）。建议保留导出 + 在 App.tsx 改为 import 以消除漂移风险（需评估 @ai-sdk 启动包影响）。

#### P2-5: resolveTerminalFont 测试缺边界场景

**证据**：见 §1.3。

**修复方向**：补充 mode 不匹配 variants + variants 完全为空的测试用例。

#### P2-6: input 与 messages 双重 `<env>` 感知风险

**证据**：
- `transport.ts:127` `const input = extractLastUserText(messagesForRun);` —— input 含 `<env>` 块。
- `transport.ts:130` `messages: messagesForRun` —— messages 也含 `<env>` 块。
- Python `agent.invoke` 同时收到 input 和 messages，如果 Python 端既用 input 做关键词路由又从 messages 提取 user text，会双重感知 `<env>`。

**影响**：取决于 Python 端实现。需核实 `main_agent.py` 是否同时处理 input 和 messages。前端层面无 bug，但协议契约模糊。

---

## 5. 修复建议汇总

| 隐患 | 优先级 | 修复方向 | 改动文件 |
|------|--------|----------|----------|
| agent_switch 无监听者 | P1 | 在 TdsfAgentPanel 或 App 顶层 useEffect 订阅 `agent_switch` 事件，调用 `setCurrentSubAgent` | `TdsfAgentPanel.tsx` 或 `App.tsx` |
| MockLLMWarning 无补发 | P1 | mount 时调用 `invokeRpc('event.history', { event_type: 'mock_llm_active', limit: 1 })` 补发 | `MockLLMWarning.tsx` |
| llm_call_failed 无 dedup | P1 | base.py:532 加 30 秒时间窗去重 或 `_llm_failed_warning_emitted` 标志 | `base.py` |
| src/App.tsx 死代码 | P2 | 按 CLAUDE.md 防污染红线删除（需用户确认） | `src/App.tsx`, `src/components/AgentPanel.tsx` 等 |
| MockLLMWarning 注释行号 | P2 | 改 `sidecar.rs:805` → `sidecar.rs:886` | `MockLLMWarning.tsx:56` |
| base.py 注释漏 teach | P2 | 改注释为 `main + 8 子` | `base.py:161` |
| formatEnvBlock 导出多余 | P2 | 保留导出 + App.tsx 改 import（评估启动包影响后决定） | `App.tsx` |
| 测试缺边界场景 | P2 | 补 mode 不匹配 + variants 空用例 | `resolveTerminalFont.test.ts` |
| input/messages 双重 `<env>` | P2 | 核实 Python 端处理逻辑，明确协议契约 | `main_agent.py`（需进一步审计） |

---

## 6. 实测验证清单（必须 tauri:dev 实测）

以下项目必须通过 `pnpm tauri:dev` 桌面端实测确认（浏览器 dev 不等于 Tauri）：

### Bug 1 字体
1. [ ] Settings → Terminal 改 `terminalFontFamily` 为 "Cascadia Code"，确认 xterm DOM 的 `font-family` 实时变化。
2. [ ] CDP 执行 `window.__TDSF_DBG__.rendererPool().configuredFont.fontFamily` 应等于设置面板选的字体（而非主题字体）。
3. [ ] 清空 `terminalFontFamily`（设为空串），确认回退到主题字体。
4. [ ] 切换主题（含/不含 terminal.fontFamily），确认字体跟随主题或保持用户偏好。

### Bug 2 MockLLMWarning
5. [ ] 删除 `.tdsf-data/llm_config.json`（或 `TDSF_LLM_API_KEY=""`），重启应用。
6. [ ] 等待 sidecar 启动（~2 秒），确认状态栏右侧出现红色 `未配置 LLM · main` Pill（**注意：需先打开 AI 面板让 MockLLMWarning 挂载，否则启动期告警会丢失——这是 P1-2 隐患**）。
7. [ ] 发送任意消息（如"查找 foo"路由到 explore），确认 Pill 显示 `未配置 LLM · explore`（**注意：当前实现 Pill 只在 mock_llm_active 事件到达时更新，不会随 agent_switch 切换——这是 P1-1 隐患**）。
8. [ ] 点击 Pill，确认跳转 Settings → Models。
9. [ ] 配置好 API Key 重启 sidecar，确认 Pill 消失。
10. [ ] 配置无效 API Key，发送教学类消息（路由到 teach），确认 Pill 显示 `LLM 调用失败降级 · teach`（**注意：每次 LLM 调用失败都会推送，可能闪烁——这是 P1-3 隐患**）。

### Bug 3 getLive/getEnvBlock
11. [ ] 打开一个本地终端，`cd` 到某目录（如 `/tmp/foo`）。
12. [ ] CDP 执行 `window.__TDSF_DBG__.getLive()` 应返回 `{ cwd: "/tmp/foo", terminalPrivate: false, workspaceRoot: "...", activeFile: null }`。
13. [ ] CDP 执行 `window.__TDSF_DBG__.getEnvBlock()` 应返回 `<env>\nworkspace_root: ...\nactive_terminal_cwd: /tmp/foo\n</env>`。
14. [ ] 打开一个文件到编辑器，再次执行 `getLive()`，确认 `activeFile` 非空。
15. [ ] 发送一条消息给 sidecar，在 sidecar 日志里确认 `main_agent.invoke` 收到的 `state.input` 以 `<env>` 开头。

### 残留隐患实测
16. [ ] 发送"修复 nginx 配置"消息（应路由到 coding），观察 AgentStatusPill 是否显示 "Coding"——**预期：永远显示 "Main"（P1-1 隐患确认）**。
17. [ ] 启动应用后**不打开 AI 面板**，等待 5 秒后打开，观察 MockLLMWarning 是否显示——**预期：不显示（P1-2 启动期告警丢失确认）**。

---

## 7. 审计覆盖的文件清单

| 文件 | 角色 | 是否有问题 |
|------|------|------------|
| `src/modules/theme/resolveTerminalFont.ts` | Bug 1 修复点 | ✅ 修复有效，测试缺边界 |
| `src/modules/theme/resolveTerminalFont.test.ts` | Bug 1 测试 | ✅ 5 用例，缺 mode 不匹配场景 |
| `src/modules/ai/lib/transport.ts` | Bug 3 transport + formatEnvBlock 导出 | ✅ formatEnvBlock 导出多余 |
| `src/modules/ai/store/chatRuntime.ts` | Bug 3 getLive 闭包 | ❌ 实现正确 |
| `src/modules/ai/store/chatStore.ts` | currentSubAgent 状态 | ✅ P1-1: 无 setCurrentSubAgent 调用者 |
| `src/modules/ai/components/MockLLMWarning.tsx` | Bug 2 前端监听 | ✅ P1-2: 无补发；P2-2: 注释行号错 |
| `src/modules/ai/components/AgentStatusPill.tsx` | agent_switch 订阅 | ✅ P1-1: 注释说订阅但实际未订阅 |
| `src/modules/ai/components/TdsfAgentPanel.tsx` | AI 面板 | ❌ 未订阅 agent_switch |
| `src/modules/ai/agents/registry.ts` | TdsfAgentId 注册表 | ❌ 5 个 id 与 Python 9 个不一致（设计如此） |
| `src/modules/ai/lib/agents.ts` | BUILTIN_AGENTS | ❌ 与 TdsfAgentId 并存（设计如此） |
| `src/app/App.tsx` | Bug 3 __TDSF_DBG__ 暴露 | ✅ 修复有效，内联有漂移风险 |
| `src/lib/sidecar-bridge.ts` | 前端事件订阅桥 | ❌ subscribe 实现正确 |
| `src-tauri/sidecar/agents/base.py` | Bug 2 修复点 | ✅ 修复有效，llm_call_failed 无 dedup |
| `src-tauri/sidecar/agents/__init__.py` | AGENT_REGISTRY | ❌ 9 个 Agent 注册正确 |
| `src-tauri/sidecar/event_bus.py` | EventType 枚举 | ❌ 8 个事件类型完整 |
| `src-tauri/sidecar/main.py` | 装配顺序 | ❌ event_bus 先于 agents 初始化 |
| `src-tauri/src/modules/sidecar.rs` | Rust 事件转发 | ❌ sidecar.rs:886 实现正确 |
| `src/App.tsx`（旧版） | 死代码 | ✅ P2-1: subscribe 未注册事件 |
| `src/components/AgentPanel.tsx`（旧版） | 死代码 | ✅ P2-1: tool_call_result/knowledge_cards 不在 EventType |

---

## 8. 与前 AI 报告的交叉验证

| 前 AI 报告结论 | 本次审计结论 | 一致性 |
|----------------|--------------|--------|
| Bug 1 根因：`??` 让主题优先 | `||` 修复让用户优先，正确 | ✅ 一致 |
| Bug 2 根因：call_llm 是唯一入口，只 teach 路径触发 | `__init__` 构造时触发，覆盖 9 个 Agent | ✅ 一致 |
| Bug 2 需确认 main.py 装配顺序 | 已确认 event_bus 先于 agents | ✅ 已确认 |
| Bug 3 根因：formatEnvBlock 未导出 | 已导出，但 App.tsx 内联未用 | ⚠️ 部分：导出多余 |
| sidecar.rs:886 事件转发 | 已核实行号正确 | ✅ 一致 |
| MockLLMWarning.tsx:56 注释 sidecar.rs:805 | 实际 886，注释错误 | ✅ 新发现 |
| agent_switch 事件订阅 | **前 AI 报告未提及** | ⚠️ 新发现 P1-1 |

**本次审计新增发现**（前 AI 报告未覆盖）：
1. **P1-1**：agent_switch 事件前端无监听者，AgentStatusPill 永远显示 "Main"。
2. **P1-2**：MockLLMWarning 无补发机制，启动期告警丢失。
3. **P1-3**：llm_call_failed 无 dedup，可能事件洪水。
4. **P2-1**：src/App.tsx 死代码 subscribe 未注册事件类型。
5. **P2-3**：base.py:161 注释漏 teach。
6. Bug 3 内联实现与 formatEnvBlock 导出的漂移风险。

---

> **审查者声明**：本报告基于 2026-07-30 工作树状态静态审查得出，未修改任何源文件。所有引用行号均对应审查时点的文件内容。三个 P0-D 修复的核心逻辑均正确有效，但 Bug 2 修复引入了启动期告警丢失的边界风险，且发现一个前 AI 报告未提及的 P1 残留隐患（agent_switch 无监听者）。建议优先修 P1-1（agent_switch 订阅）和 P1-2（MockLLMWarning 补发），再处理 P1-3（llm_call_failed dedup）。
