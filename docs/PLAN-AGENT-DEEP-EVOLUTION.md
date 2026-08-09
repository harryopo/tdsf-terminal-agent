# Agent 深度进化方案书（2026-08-09）

> **触发**：用户反馈教学 agent 多个问题——工具上限、max_tokens 截断、命令不显示在终端、缺少任务规划 UI、缺少对话压缩、SSH 工具前后台双模式。
> **调研**：三路并行 search agent 取证（开源资料 + SSH 工具机制 + terax 任务规划/对话压缩/max_tokens）。
> **状态**：调研完成，方案待用户确认后实施。

---

## 0. 用户核心诉求

> "max_tokens 应该设置无上限吧，可以跑到任务结束，但是要设置感知层，任务完成了就停止，或者去向用户提问，要有对话压缩的功能，就是把这个 agent 做大做通用，比如说通用的 agent 是有工具使用的，有任务规划的，任务的规划要显示出来 UI；我了解到当前的 SSH 工具似乎是调用的时候在后台运行，我开启这个在终端显示的模式后，agent 如果要输入命令就要显示在终端，是否是要设置俩 SSH 工具，一个是后台的，一个是显示在前端的？"

归纳为 **6 个子方向**：

| # | 方向 | 当前状态 | 目标 |
|---|------|----------|------|
| A | max_tokens 无上限 | 默认 8192（刚从 2048 提高） | 模型自行决定停止（感知层控制） |
| B | 任务完成感知 / 提问 | 无 | Agent 完成后主动提问或停止 |
| C | 对话压缩 | 前端 5 级分级压缩（Vercel SDK）/ Sidecar 截断 20 条 | Sidecar 路径也需要真正的压缩 |
| D | 任务规划 UI | 前端已有 TodoStrip（只 Vercel SDK 路径生效） | Sidecar 路径也驱动 TodoStrip |
| E | SSH 工具前台/后台双模式 | ssh_command 后台 exec channel / suggest_command 前端 xterm | 开关控制 ssh_command 走前台或后台 |
| F | 参考开源架构 | 调研了 VS Code/Warp/Tabby 的注入方案 | 已复用（PROMPT_COMMAND 方案 A） |

---

## 1. SSH 工具双模式（核心架构决策）

### 1.1 现状（两条并行链路，互不相通）

| 维度 | `ssh_command`（Python sidecar） | `suggest_command`（前端 Vercel SDK） |
|------|----------------------------------|---------------------------------------|
| 执行路径 | Rust `exec_command` 独立 exec channel | 前端 `injectIntoActivePty` → xterm.write |
| 用户可见？ | **否**（后台静默执行） | **是**（直接写在终端，含回显） |
| 输出去向 | 返回 LLM（结构化 JSON） | 前端终端屏幕 |
| 受 `autoExecuteInTerminal` 影响？ | **否** | 是 |
| 审批机制 | 有（RiskChecker + needs_you HITL） | 无（直接注入） |
| 协议 | SSH exec（RFC 4254 6.4） | 复用已有 PTY shell |

**调用链**（ssh_command）：
```
ssh_command.py:61 → __init__.py:602 ipc_invoke("ssh_command")
  → rust_bridge.py:164 反向 JSON-RPC → sidecar.rs:1126 路由
  → mod.rs:693 session.exec_command() → session.rs:646
  → channel_open_session + channel.exec() → collect_exec_output
```

**关键约束**：Python sidecar 无法直接持有前端 xterm 引用——要让它"前台可见"需要一个 **sidecar→前端→xterm 的新通道**。

### 1.2 方案：双模式 ssh_command（推荐）

**不新增第二个 SSH 工具**，而是在现有 `ssh_command` 增加 `visible` 参数：

```python
# ssh_command.py 工具 schema 增加：
visible: bool = False  # 默认后台执行（现有行为）
# visible=True 时走前端终端（新路径）
```

**实现路径**（三步）：

#### Step 1: Sidecar 发"注入终端"事件

`visible=True` 时，不调 `ipc_invoke("ssh_command")`，而是发一个新事件：

```python
# rust_bridge.py 新增方法
def inject_terminal(self, session_id: str, command: str) -> None:
    """通知前端把命令注入终端（不等待结果）"""
    self.send_notification("inject_terminal", {
        "session_id": session_id,
        "command": command,
    })
```

#### Step 2: Rust 转发事件到前端

`sidecar.rs` 的 `handle_reverse_request` 或新增 notification handler 收到 `inject_terminal` 后，emit Tauri 事件：

```rust
app_handle.emit("ai_inject_terminal", { command, session_id })?;
```

#### Step 3: 前端监听注入终端

`useAiLiveBridge.ts` 或 `SshTerminalHost.tsx` 监听 `ai_inject_terminal` 事件：

```typescript
listen("ai_inject_terminal", ({ payload }) => {
  // 如果 autoExecuteInTerminal 开启，加换行符执行
  const text = autoExec ? payload.command + "\n" : payload.command;
  injectIntoActivePty(text);
});
```

### 1.3 为什么不直接两个工具

- LLM 看到 `ssh_command` 和 `ssh_command_visible` 两个工具会困惑（选哪个？）
- system prompt 描述复杂度翻倍
- 用户开关状态由前端传给 sidecar（通过 `visible` 参数），LLM 不需要决策

---

## 2. 任务规划 UI（TodoStrip 双轨联动）

### 2.1 现状

- **Vercel SDK 路径**：完整的 `todo_write` 工具 + TodoStrip UI + zustand 持久化（来自上游 terax）
- **Python Sidecar 路径**：不装配 `todo_write` 工具，TodoStrip 收不到更新
- 关键路由分支：`transport.ts:162`——`tdsfAgentId` 非 null 走 sidecar，不经过 `buildTools`

### 2.2 方案：Sidecar 事件驱动 TodoStrip

**不改前端 TodoStrip 组件**，而是让 Python sidecar 通过事件驱动同一个 zustand store：

```python
# adapter.py agent 回调中检测 todo 相关输出
# 通过 rust_bridge 发 "update_todos" notification
```

或者更简单：**在 Sidecar 路径也装配前端 `todo_write` 工具**——让 LLM 通过工具调用驱动 TodoStrip，而不是通过 Python 内部 hook。

具体实现：
1. `transport.ts` 的 `runSidecarStream` 中，把 `todo_write` 工具也注入到 sidecar 的消息上下文
2. 或者：sidecar 路径在 `messagesForRun` 里追加 `todo_write` 的工具描述
3. LLM 调用 `todo_write` 时，前端拦截（类似 tool call streaming），更新 TodoStore

**评估**：这个方案复杂度中等，需要在 sidecar↔前端协议层新增工具回调通道。建议作为独立里程碑。

---

## 3. max_tokens 无上限 + 任务完成感知

### 3.1 OpenAI 兼容端点（可行）

`model_adapter.py` 的 `_create_openai_model` 和 `_create_litellm_model` 中，当 `max_tokens <= 0` 时不加入 params dict：

```python
params: dict[str, Any] = {
    "temperature": getattr(config, "temperature", 0.7),
}
max_tokens = getattr(config, "max_tokens", 8192)
if max_tokens > 0:
    params["max_tokens"] = max_tokens
# max_tokens <= 0 = 不传 = 模型自行决定停止
```

### 3.2 Anthropic（必须保留正整数）

Anthropic Messages API 的 `max_tokens` 是必填参数。兜底设为模型上下文窗口的上限（如 Claude Sonnet 4 = 8192 输出 / 200K 上下文）。

### 3.3 任务完成感知（Strands Agent 已内置）

Strands Agent 的 agentic loop 天然有完成感知——LLM 不再调工具时自动结束循环。我们已移除 `ToolCallLimitHook`（工具调用次数上限），现在 agent 可以跑到自然结束。

**感知层增强**：在 system prompt 中强化指令：
- "任务完成后简要总结，不要继续调用工具"
- "如果不确定下一步，向用户提问而不是自行假设"

---

## 4. 对话压缩（Sidecar 路径）

### 4.1 现状

| 路径 | 压缩策略 | 质量 |
|------|----------|------|
| Vercel SDK | compact.ts 5 级分级（dropSupersededReads → elide → prune → truncate） | 好（保护最新 read） |
| Sidecar | `trimMessagesForSidecar` 截断最近 20 条 | 差（粗暴截断） |
| Python long_context.py | hash 模拟摘要（默认关闭） | 无真 LLM 摘要 |

### 4.2 方案：Sidecar 路径复用 compact.ts 的策略

在 `transport.ts` 的 `trimMessagesForSidecar` 中，不只是简单 slice，而是先调 `compactModelMessagesDetailed` 做分级压缩：

```typescript
function trimMessagesForSidecar(messages: UIMessage[], maxMessages: number = 40): UIMessage[] {
  // 先分级压缩（elide 大 tool-result）
  const compacted = compactModelMessagesDetailed(messages, modelId, compatCtx);
  // 再截断到合理长度
  if (compacted.length <= maxMessages) return compacted;
  return compacted.slice(compacted.length - maxMessages);
}
```

同时把 maxMessages 从 20 提高到 40（给教学场景更多上下文）。

---

## 5. 实施路线图（按依赖排序）

| 优先 | 任务 | 复杂度 | 依赖 | 预计改动 |
|------|------|--------|------|----------|
| P0 | max_tokens 条件传参（OpenAI 路径） | 低 | 无 | model_adapter.py 3 处 |
| P0 | 对话压缩增强（Sidecar 复用 compact.ts） | 低 | 无 | transport.ts 1 处 |
| P1 | SSH 工具 visible 模式（3 步链路） | 中 | injectTerminal 通道 | ssh_command.py + rust_bridge.py + sidecar.rs + 前端 listen |
| P1 | 任务完成感知 system prompt 强化 | 低 | 无 | adapter.py _SUB_AGENT_SPECS |
| P2 | TodoStrip 双轨联动（Sidecar 驱动） | 高 | 协议层改动 | transport.ts + adapter.py |
| P3 | LLM 自动摘要（long_context 启用） | 高 | long_context.py 重写 | long_context.py + feature_flags |

---

## 6. 参考来源

- 上游 terax：`opensource-reference/terax-ai/`（TodoStrip / plan mode / compact.ts 原始实现）
- VS Code Remote SSH：PROMPT_COMMAND 注入方案（已复用）
- Warp Terminal：命令块 + 预测回显设计灵感
- Strands Agents 官方文档：[agent-loop max_tokens](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/#maxtokensreachedexception)
