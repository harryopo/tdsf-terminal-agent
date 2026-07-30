# TDSF Agent 可用性审计报告

> **审计日期**：2026-07-30
> **审计范围**：魔改 agent 实际使用情况 + 功能可用性（前端 AI 模块 / 后端 sidecar agents / Strands adapter / 前端 AI 入口）
> **审计模式**：纯只读代码审计，未运行 typecheck/lint/test/build/tauri:dev
> **基线**：crynta/terax-ai v0.8.6 魔改版，dev-state.md §十五 Strands 1.50.2 端到端 4/4 测试通过

---

## 执行摘要

本次审计识别出 **3 个 Critical、7 个 Major、4 个 Minor** 共 14 个问题（另 1 条 §3.5 经复核降级为 Non-issue）。最严重的三点：

1. **Strands 运维工具链是"空壳"**：5 个运维工具（ssh_command 等）全部依赖 RustBridge 调 Rust 后端，但 `DefaultRustBridge` 未注入 `send_request`，且 Rust 侧 `ssh_command` 命令尚未实现。Strands 后端启动成功但所有工具调用返回 `unavailable`，agent 降级为只读模式。
2. **Strands 运行时失败不回退 LangGraph**：`adapter.py:378-403` invoke 异常时只返回 error + emit_needs_you，不自动回退。仅"激活失败"才回退（`main.py` except 块），运行时失败=单点故障。
3. **前后端 agent 数量不一致（5 vs 9）**：前端 `registry.ts` 只注册 5 个 agent，后端 9 个。debug/refactor/test/deploy 这 4 个后端 agent 前端不可直接选择，完全依赖 main_agent 关键词自动路由。

测试盲区集中在：TdsfAgentPanel/AiToolApproval/MockLLMWarning/transport 四个前端文件无对应测试，Strands adapter 无端到端测试，agent_switch 事件链路无测试。

---

## 1. 9 Agent Registry 审计

### 1.1 前后端 agent 注册数量不一致 [Critical]

**证据**：
- 前端 `src/modules/ai/agents/registry.ts`：注册 `main/coder/explore/history/teach` 共 5 个（`TdsfAgentId` 类型仅这 5 个）。
- 后端 `src-tauri/sidecar/agents/__init__.py`：`AGENT_REGISTRY` 注册 `main/coding/explore/history/teach/debug/refactor/test/deploy` 共 9 个。
- 前端 `src/modules/ai/agents/registry.test.ts:65-69` 明确断言 `isTdsfAgent("debug")` / `"refactor"` / `"test"` / `"deploy"` 均返回 `false`。

**影响**：debug/refactor/test/deploy 这 4 个后端 agent 前端无法直接选择，只能靠 `main_agent.plan_task` 关键词路由触发。用户无法强制指定 agent（例如"我一定要用 debug agent"），完全依赖关键词匹配的准确性。

**严重性**：Critical — 4 个 agent 对前端不可达，功能可用性受限。

### 1.2 Main Agent 路由是"伪切换" [Major]

**证据**：
- `src/modules/ai/lib/transport.ts:129-130`：`const tdsfAgent = deps.getTdsfAgentId?.() ?? null; if (tdsfAgent)` —— 只要 tdsfAgent 非 null 就走 sidecar，且 `DEFAULT_TDSF_AGENT = "main"`。
- `src-tauri/sidecar/agents/main_agent.py`：`plan_task` 通过关键词（"排查"/"根因"→debug，"重构"→refactor 等）路由，调用子 agent 的 invoke。
- `src/modules/ai/lib/sidecar-adapter.ts:274-288`：listen `sidecar:agent_switch` 事件，仅更新 `chatStore.currentSubAgent` 用于 UI 显示，**不切换 system_prompt 或 tools**。
- 真正的 system_prompt + tools 切换发生在 Python 侧 main_agent.invoke 内部调用子 agent 时（每个子 agent 的 `build_system_prompt_base()` + `tools` 列表）。

**影响**：前端"切换 agent"的语义被破坏——用户看到的是 main agent，路由结果只是显示标签。session 级状态（messages/mood/tokens）在 main 与子 agent 间累积，无显式清理。

**严重性**：Major — 设计上可接受（统一入口），但与用户"浮动 agent 模块支持横向伸缩"的期望有差距，且状态清理未验证。

### 1.3 Main Agent 路由关键词重复 [Minor]

**证据**：`src-tauri/sidecar/agents/main_agent.py`（历史任务路由分支）：
```python
if any(kw in user_input for kw in ["历史", "上次", "之前", "之前"]) or \
```
"之前" 重复出现两次。

**影响**：无功能影响，但表明代码审查缺失。

**严重性**：Minor。

### 1.4 Agent 切换后状态清理未验证 [Major]

**证据**：审计未发现 agent 切换后显式清理前一个 agent 中间状态的代码。`main_agent.invoke` 的 PAOR 循环在调用子 agent 时，子 agent 状态是局部的，但 `state` dict 中的 `intermediate_results`、`mood`、`tokens` 会累积。

**影响**：多步复合任务（如"查找并修复代码错误"→explore+coding）的中间结果可能互相污染，token 统计可能重复计数。

**严重性**：Major — 需要阶段 B 实测验证。

---

## 2. Strands/LangGraph Fallback 审计

### 2.1 Strands 运维工具链实际不可用 [Critical]

**证据链**：
- `src-tauri/sidecar/strands_backend/tools/__init__.py:79-90`：注释明确"Rust 侧 ssh_command 当前未实现"。
- `src-tauri/sidecar/strands_backend/tools/__init__.py:109-136`：`DefaultRustBridge.ipc_invoke` 在 `_send_request is None` 时返回 `unavailable` 状态。
- `src-tauri/sidecar/strands_backend/tools/__init__.py:407-418`：`execute_via_ssh` 在 `ctx.rust_bridge is None` 时返回 unavailable；但即便 rust_bridge 非 None，`DefaultRustBridge` 默认也无 send_request。
- `src-tauri/sidecar/strands_backend/adapter.py:251`：`self.rust_bridge = rust_bridge or DefaultRustBridge()`。
- `main.py`（summary 第 372-405 行）：注入 `DefaultRustBridge()` 无 send_request。
- 5 个运维工具（ssh_command/remote_file/log_analyzer/process_inspector/network_diagnostic）全部依赖 `execute_via_ssh` 或 RustBridge。

**影响**：Strands 后端启动成功，但所有工具调用返回 `unavailable`/`error`，agent 降级为只读模式。Strands 1.50.2 端到端 4/4 测试通过是因为测试用的是 mock，未触达真实 RustBridge。

**严重性**：Critical — P0-E 阶段 B 桌面端实测会暴露此问题。

### 2.2 Strands 运行时失败不回退 LangGraph [Critical]

**证据**：
- `src-tauri/sidecar/strands_backend/adapter.py:378-403`：`invoke` 的 `except Exception` 块返回 error 状态 + `_emit_needs_you_for_error`，**不调用 LangGraph 回退**。
- `main.py`（summary 第 372-405 行）：仅在 Strands **激活失败**（import/构造异常）时 except 块回退到 `agents.configure_agents(...)`（LangGraph）。运行时 invoke 失败不回退。

**影响**：Strands 启动成功但 LLM 超时/工具异常/Model 异常时，用户看到"Agent 执行出错"，而不是自动降级到 LangGraph 继续工作。单点故障。

**严重性**：Critical — 可用性严重受损。

### 2.3 Strands 1.50.2 max_iterations 移除，死循环风险 [Minor]

**证据**：`src-tauri/sidecar/strands_backend/adapter.py:510-521`：已移除 `max_iterations` 参数（Strands 1.50.2 API 变更），注释说"未来用 LimitToolCounts hook 实现"，但当前未实现。`self.max_iterations` 字段保留但未生效。

**影响**：Strands Agent 无迭代次数限制，依赖 LLM 自行停止。极端场景（LLM 循环调用工具）可能死循环。

**严重性**：Minor — 当前 Strands 工具不可用（2.1），死循环风险暂不暴露；但 P2 补 RustBridge 后需立即处理。

### 2.4 Strands 降级提示 UX 不佳 [Major]

**证据**：`src-tauri/sidecar/strands_backend/adapter.py:448-475`：降级时返回 `[strands-backend-degraded] {message}` 文本。前端 `sidecar-adapter.ts:424` 直接作为 `observation` 流式输出，无专门降级 UI。

**影响**：用户看到的是一长串技术性文本（"Strands 后端 feature flag 未启用..."），而非友好的状态卡片。

**严重性**：Major — UX 降级。

---

## 3. TdsfAgentPanel UX 审计

### 3.1 无手动 agent 切换 UI [Major]

**证据**：`src/modules/ai/components/TdsfAgentPanel.tsx:99-115`：注释"旧版：让用户手动切换 4 Agent Tab / 新版：所有消息统一走 'main' 入口"。`SUB_AGENT_META` 是只读显示元数据，顶部 `<span data-testid="tdsf-agent-current">` 只显示当前路由到的子 agent，`title="主 Agent 当前路由到的子 Agent（不可手动切换）"`。

**影响**：用户无法强制使用某个子 agent（如必须用 debug 而非 main 自动路由）。关键词路由准确性不足时，用户无救济手段。

**严重性**：Major — 与用户期望的"浮动 agent 模块支持横向伸缩"有差距。

### 3.2 流式输出是切片模拟，非真实流式 [Major]

**证据**：`src/modules/ai/lib/sidecar-adapter.ts:205-219`：`streamText` 函数按 `STREAM_CHUNK_SIZE = 24` 字符切片，每 chunk 间 `await STREAM_CHUNK_DELAY_MS = 8`。注释明确"Python 端 agent.invoke 是同步返回完整 dict，不是流式"。

**影响**：
- 长输出（如 2000 字）额外延迟 672ms（84 chunk × 8ms）。
- 用户看到的"流式"是假象，无法体现 Agent 真实思考进度。
- Strands 后端虽有 `TdsfStrandsCallbackHandler`（`adapter.py:89-207`）推送真实 `emit_agent_message` 流式事件，但前端 `sidecar-adapter.ts` 未消费这些事件做实时渲染，仍走 dict 切片。

**严重性**：Major — UX 不真实，Strands 真实流式能力被浪费。

### 3.3 AiToolApproval 不支持 Strands 工具 [Major]

**证据**：`src/modules/ai/components/AiToolApproval.tsx`（summary）：`TOOL_META` 仅含 `write_file/edit/multi_edit/create_directory/bash_run/bash_background`，**不含** `ssh_command/remote_file/log_analyzer/process_inspector/network_diagnostic`。

**影响**：Strands 工具触发审批时（如高危 ssh_command），走 generic JSON fallback，审批弹窗显示原始 JSON 而非友好图标+标签。

**严重性**：Major — 审批 UX 降级，高危命令审批场景尤其需要清晰展示。

### 3.4 错误处理 hint 静态，不区分错误类型 [Major]

**证据**：`src/modules/ai/lib/sidecar-adapter.ts:389-395`：
```typescript
const hint = `Sidecar Agent 调用失败: ${invokeError}\n\n可能原因：\n1) LLM 未配置\n2) Sidecar 未启动\n3) Agent 名称错误`;
```
hint 是静态文本，不根据 `invokeError` 内容区分（超时 vs LLM 未配置 vs agent 名称错误）。

**影响**：用户需手动判断错误原因，排障成本高。

**严重性**：Major。

### 3.5 MockLLMWarning 同毫秒事件丢弃 [Minor]

**证据**：`src/modules/ai/components/MockLLMWarning.tsx:70-76`：
```typescript
const applyEvent = (evt) => {
  const ts = typeof evt.timestamp === "number" ? evt.timestamp : 0;
  if (ts < latestTsRef.current) return;  // 同毫秒 ts == latestTsRef.current 不会被丢弃
  ...
};
```
实际上 `ts < latestTsRef.current` 用严格小于，同毫秒（ts == latest）不会被丢弃。但若 history 补发与实时事件同毫秒且 history 先到，实时事件 ts == latest 仍会覆盖（符合预期）。**重新审视：此问题不成立**，逻辑正确。

**修正**：此条降级为 Non-issue，不计入问题数。

### 3.6 流式输出额外延迟 [Minor]

见 3.2，长输出 672ms 额外延迟。

**严重性**：Minor。

---

## 4. 测试盲区清单

### 4.1 前端测试盲区

| 文件 | 测试文件 | 盲区严重性 |
|------|---------|-----------|
| `src/modules/ai/components/TdsfAgentPanel.tsx` | **无** | Major — 主交互面板无测试 |
| `src/modules/ai/components/AiToolApproval.tsx` | **无** | Major — 审批弹窗无测试 |
| `src/modules/ai/components/MockLLMWarning.tsx` | **无** | Major — 告警组件无测试 |
| `src/modules/ai/lib/transport.ts` | **无** | Major — 上下文感知 transport 无测试 |
| `src/modules/ai/agents/registry.test.ts` | 存在但不完整 | Minor — 注释"4 个 agent"过时，未覆盖 main agent 路由逻辑 |

`registry.test.ts:17` 注释"4 个 agent 都有 pythonName"，但实际 `DEFAULT_TDSF_AGENT = "main"` 共 5 个。`registry.test.ts:50-52` 验证了 main，但其余测试用例（第 17-25 行）仍只遍历 `["coder", "explore", "history", "teach"]` 4 个，未覆盖 main 的 pythonName 映射。

### 4.2 后端测试盲区

| 文件 | 测试文件 | 盲区严重性 |
|------|---------|-----------|
| `strands_backend/adapter.py` | **无 test_strands_adapter.py** | Critical — Strands 适配层无端到端测试 |
| `strands_backend/tools/__init__.py`（execute_via_ssh/RustBridge 集成） | `strands_backend/tests/test_tools.py` 仅测 RiskChecker 纯函数 | Major — RustBridge 集成未测 |
| `agents/main_agent.py`（agent_switch 事件链路） | `test_agents.py` 测 plan_task 路由，未测 event 推送 | Major — 事件链路未测 |
| Strands fallback 链路 | **无** | Critical — Strands 失败回退 LangGraph 场景无测试（代码层也不回退，见 2.2） |

### 4.3 关键未测路径

1. **agent_switch 事件完整链路**：Python `main_agent.invoke` → `event_bus.publish("agent_switch")` → Rust `sidecar.rs` emit → 前端 `sidecar-adapter.ts:274-288` listen → `chatStore.setCurrentSubAgent` → TdsfAgentPanel UI 更新。全链路无测试。
2. **Strands invoke 异常时 emit_needs_you 推送**：`adapter.py:702-729` `_emit_needs_you_for_error` 是否真的推送到前端未测。
3. **MockLLMWarning event.history 补发降级**：`MockLLMWarning.tsx:101-122` sidecar 未就绪时 catch 块静默降级，未测。
4. **sidecar-adapter 30s 超时 + abortSignal 联动**：`sidecar-adapter.ts:343-357` 超时与 abortSignal 联动逻辑未测。
5. **ssh_command 多行命令 RiskChecker 逐行检测**：`strands_backend/tools/ssh_command.py:86-111` 多行命令逐行过 RiskChecker 的逻辑未测。

---

## 5. P0-E 阶段 B 桌面端验证建议

dev-state.md §十五 backlog：阶段 B 需 `tauri:dev + CDP 9222` 验证 SSH 会话 + Strands 调 ssh_command。基于本审计识别的盲区，CDP 实测脚本应包含以下断言点：

### 5.1 CDP 实测断言点

1. **Strands 工具 unavailable 降级验证**（对应 §2.1 Critical）
   - 前置：`TDSF_AGENT_BACKEND=strands`，SSH 会话已连接
   - 操作：发送"检查 nginx 状态"触发 Strands 调 ssh_command
   - 断言：Agent 输出含"unavailable"或"RustBridge 未配置"，不崩溃

2. **agent_switch 事件 UI 实时显示**（对应 §1.2 Major）
   - 操作：发送"排查 nginx 启动失败根因"触发 debug agent 路由
   - 断言：`[data-testid="tdsf-agent-current"]` 文本变为 "Debug"

3. **Strands 降级场景 UI 提示**（对应 §2.4 Major）
   - 前置：`TDSF_AGENT_BACKEND=strands` 但 strands-agents 未安装
   - 断言：Agent 输出含"[strands-backend-degraded]"，needs_you 事件推送

4. **MockLLMWarning 启动期补发**（对应 §4.3）
   - 前置：未配置 LLM，启动应用
   - 断言：`[data-testid="mock-llm-warning"]` 在首屏可见（无需手动触发 agent）

5. **高危命令 needs_you 审批弹窗**（对应 §3.3 Major）
   - 操作：通过 Strands 发送"rm -rf /"触发 RiskChecker
   - 断言：AiToolApproval 弹窗显示（即便走 generic JSON fallback 也要验证弹窗出现）

6. **复合任务状态累积验证**（对应 §1.4 Major）
   - 操作：发送"查找并修复代码错误"触发 explore+coding 复合任务
   - 断言：token 统计不重复计数，intermediate_results 不互相污染

### 5.2 与阶段 B 的协作建议

1. **先补 Rust ssh_command 命令**：阶段 B 前应先实现 Rust 侧 `ssh_command` Tauri command（基于 russh channel exec），否则 Strands 工具链全程 unavailable，无法验证真实运维场景。建议提升为 P0-E 阶段 B 前置阻塞项。
2. **先补 test_strands_adapter.py**：阶段 B 实测前应先补 Strands adapter 的单元测试（降级路径/invoke 异常/缓存管理），用 mock RustBridge 覆盖主路径，减少 CDP 实测的调试成本。
3. **CDP 脚本复用现有模式**：参考 `cdp-ssh-editor-test.mjs`（dev-state.md §十一提到）的 CDP 连接 + el.click() + 截图模式，本审计的 6 个断言点可直接套用。

---

## 6. 优先级排序修复建议

### P0 (Critical) — 阻塞 Strands 真实可用

| # | 问题 | 文件:line | 修复建议 |
|---|------|-----------|----------|
| 1 | Strands 运维工具链空壳 | `strands_backend/tools/__init__.py:79-90,109-136,407-418` + `adapter.py:251` + `main.py` DefaultRustBridge 注入 | (1) P2 补 Rust ssh_command Tauri command；(2) main.py 注入真实 send_request（双向 JSON-RPC）；(3) 阶段 B 前至少补 mock send_request 让工具可测 |
| 2 | Strands 运行时失败不回退 | `strands_backend/adapter.py:378-403` | invoke except 块增加 LangGraph 回退调用（通过 `agents.invoke_agent` 调原 LangGraph 路径），而非只返回 error |
| 3 | 前后端 agent 数量不一致 | `src/modules/ai/agents/registry.ts` vs `agents/__init__.py` | (1) 前端补 debug/refactor/test/deploy 4 个 agent 注册；(2) 或后端移除这 4 个（若不打算暴露）；(3) 同步更新 registry.test.ts |

### P1 (Major) — UX 与测试覆盖

| # | 问题 | 文件:line | 修复建议 |
|---|------|-----------|----------|
| 4 | 无手动 agent 切换 UI | `TdsfAgentPanel.tsx:99-115` | 增加 agent 选择下拉/dropdown（即便默认 main，也允许强制指定） |
| 5 | AiToolApproval 不支持 Strands 工具 | `AiToolApproval.tsx` TOOL_META | 补 ssh_command/remote_file/log_analyzer/process_inspector/network_diagnostic 5 个工具的 label+icon |
| 6 | agent 切换后状态清理未验证 | `main_agent.py` invoke + `agents/base.py` | 阶段 B 实测复合任务 token 计数；必要时在 main_agent.invoke 调用子 agent 前清理 intermediate_results |
| 7 | 流式输出是切片模拟 | `sidecar-adapter.ts:205-219` | 消费 Strands `emit_agent_message` 真实流式事件；LangGraph 路径保留切片模拟 |
| 8 | 错误处理 hint 静态 | `sidecar-adapter.ts:389-395` | 根据 invokeError 内容区分（超时/LLM 未配置/agent 名称错误），给针对性 hint |
| 9 | 前端 4 文件无测试 | TdsfAgentPanel/AiToolApproval/MockLLMWarning/transport | 补 vitest 测试，至少覆盖渲染 + 事件监听 + 错误路径 |
| 10 | Strands 降级提示 UX 不佳 | `adapter.py:448-475` + `sidecar-adapter.ts:424` | 前端识别 `[strands-backend-degraded]` 前缀，渲染专门降级状态卡片而非纯文本 |

### P2 (Minor) — 代码质量

| # | 问题 | 文件:line | 修复建议 |
|---|------|-----------|----------|
| 11 | main_agent 重复关键词 | `main_agent.py` 历史任务路由 | 删除重复的"之前" |
| 12 | Strands max_iterations 未实现 | `adapter.py:510-521` | 用 LimitToolCounts hook 实现，防死循环 |
| 13 | 流式输出额外延迟 | `sidecar-adapter.ts:41-44` | 调大 STREAM_CHUNK_SIZE 或减小 STREAM_CHUNK_DELAY_MS |
| 14 | registry.test.ts 注释过时 | `registry.test.ts:17` | 更新注释为"5 个 agent"，测试用例覆盖 main |

---

## 附录：审计文件清单

### 已审计源文件（只读）

**前端**：
- `src/modules/ai/agents/registry.ts` + `registry.test.ts`
- `src/modules/ai/components/TdsfAgentPanel.tsx` / `AiToolApproval.tsx` / `AiChat.tsx` / `MockLLMWarning.tsx`
- `src/modules/ai/lib/transport.ts` / `sidecar-adapter.ts`

**后端**：
- `src-tauri/sidecar/agents/__init__.py` / `base.py` / `main_agent.py` / `coding_agent.py` / `debug_agent.py` / `deploy_agent.py` / `refactor_agent.py` / `test_agent.py` / `explore_agent.py` / `history_agent.py` / `teach_agent.py`
- `src-tauri/sidecar/strands_backend/adapter.py` / `model_adapter.py` / `tools/__init__.py` / `tools/ssh_command.py`
- `src-tauri/sidecar/main.py`
- `src-tauri/sidecar/tests/test_agents.py`

**文档**：
- `CLAUDE.md` / `docs/dev-state.md`（§九~§十五）/ `docs/MULTI-AGENT-WORKFLOW.md` / `docs/reports/ops-agent-research-2026-07-30.md`

### 未碰文件（严格遵守边界）

- 任何 .ts/.tsx/.py 源代码（未修改）
- docs/dev-state.md / docs/MULTI-AGENT-WORKFLOW.md / CLAUDE.md / AGENTS.md（未修改）
- 未运行 typecheck/lint/test/build/tauri:dev
- 未 commit

---

> **报告生成时间**：2026-07-30
> **审计人**：subagent-B（并行审计模式）
> **下一步**：交由 parent agent 汇总，P0 问题优先排入 P0-E 阶段 B 前置阻塞项
