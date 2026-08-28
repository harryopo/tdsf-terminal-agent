# Spec: B1 Agent 安全基座（竞品借鉴第一批）

> **来源**：`docs/开源AI运维终端-竞品对比与借鉴规划.md` §5 分期 B1（差距表 #5 #6 #3 #9）。
> **背景**：carapace 参数预测已完成（§37.72-74），按规划进入 B1。用户钦定：报错解释=**手动点击按钮**触发；内网 IP **不脱敏**。
> **竞品参考**（源码已 clone 至 opensource-reference/，2026-08-28 重新拉取）：
> - nyaterm（MIT）`src-tauri/src/core/ai/redaction.rs` —— 脱敏正则参考
> - Chaterm（GPL-3.0）`src/main/agent/core/prompts/switch-prompts.ts:44` —— "Do NOT fabricate command output" 防伪造条款参考

---

## 1. 问题陈述

1. **脱敏有缺口**（#5）：前端 `redact.ts` 已有 11 模式且 3 处调用点覆盖，但缺 PEM 私钥块 / 数据库连接串凭据 / Authorization 头形式；sidecar 的 `get_terminal_output` 工具（Strands 路径）完全无 redact。
2. **防伪造无约束**（#6）：RiskGuard deny/取消后命令静默不执行，**无任何事件回传 sidecar**，主 agent system prompt 也没有"被拦截时如实报告"条款——LLM 只能靠 `get_terminal_output` 猜测，可能编造"已执行成功"。
3. **报错无解释**（#3）：BlockOverlay 已捕获 OSC 133 exitCode 并显示红标 "exit 1"，但学生看到失败标后仍需自己去问 AI——无一键解释。
4. **终端搜索无 UI**（#9）：SearchAddon 常驻 rendererPool slot 且 `onSearchReady` 已回传，但 `Session.searchQuery` 恒为 null——全应用没有任何入口能触发 xterm 内搜索。
5. **（相邻断链）** sidecar `get_terminal_output`（Strands 工具）调用 `rust_bridge.ipc_invoke("get_terminal_scrollback")`，而 `src-tauri/src` **未实现该方法**，恒返回 fail-closed——AI 面板走 Strands 路径时拿不到终端输出。

## 2. 目标与非目标

**目标（本批交付）**：
- G1 脱敏补模式（前端 + Python 双侧），私钥块/连接串/Authorization 全覆盖；**IP 不脱敏**（用户钦定）
- G2 主 agent system prompt 追加防伪造条款 + deny 事件可见化（lastBlockedCommand 注入 live 上下文）
- G3 失败块"AI 解释"按钮（手动触发）+ 流式解释卡片；Teach 开关控制
- G4 终端内搜索：Ctrl+Shift+F 面板（大小写开关 + Enter/Shift+Enter + Esc）

**非目标**：
- ghost text 补全 / CMD 卡片 / 交互检测器（B2）
- known-hosts 转正 / ssh_config 导入（B3）
- IPv4 内网段脱敏（用户钦定不做）
- 不改动 carapace 预测链路、翻译选词链路（CLAUDE.md 红线 9）

## 3. 设计

### 3.1 G1 脱敏强化

**前端**（`src/modules/ai/lib/redact.ts` 追加 3 模式，语义对齐 nyaterm redaction.rs）：
```ts
// 1) PEM 私钥块（跨行）
{ kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g }
// 替换 → "<REDACTED:private-key>"

// 2) Authorization 头
{ kind: "authorization", re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi }
// 替换 → "Authorization: Bearer <REDACTED:authorization>"

// 3) 数据库连接串内嵌凭据 user:pass@
{ kind: "db-url", re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^@\/\s]+@/gi }
// 替换 → "$1://<REDACTED:db-url>@"
```

**Python**（新建 `src-tauri/sidecar/strands_backend/tools/_redact.py`）：与前端语义对齐的最小正则集（密钥类 + env-assign + 私钥块 + db-url），在 `get_terminal_output.py` 返回文本前跑一遍。单测对齐前端断言。

**接入点**：`get_terminal_output.py:20-58` execute 返回前 `redact_sensitive_text()`。

### 3.2 G2 防伪造提示

**a. System prompt 条款**（注入三处，同一份文案）：

注入点：
1. Strands 主 agent：`strands_backend/adapter.py` `_SUB_AGENT_SPECS` 主 agent 的 system_prompt 末尾
2. PAOR：`sidecar/agents/main_agent.py` `build_system_prompt_base()` Constraints 追加一条
3. PAOR 公共：`sidecar/agents/base.py` `build_system_prompt()`（若 2 已够则 3 跳过——实施时按实际 prompt 拼接链定，避免重复条款）

条款文案（中文，面向学生场景）：
```
安全拦截诚实条款：当你的工具调用被 RiskGuard 安全策略拦截、或用户在确认对话框中拒绝时：
1) 必须如实告知用户"该命令被安全拦截，未执行"；
2) 严禁编造执行结果或假装命令已运行；
3) 主动给出替代方案（如让用户手动执行、或拆分为更安全的步骤）。
参考（Chaterm）："Do NOT fabricate command output; wait for the user to run the command and provide results."
```

**b. deny 事件可见化**（LLM 侧通道，不碰终端输入路径）：
- `useTerminalSession.ts` `cancelPendingRiskCommand()`（299-304 行）与 deny 分支处：写模块级 `lastBlockedCommand = { command, reason, ts }`
- `useAiLiveBridge.ts` `getTerminalContext()` 输出尾部追加一行（有值时）：
  `[TDSF] 最近被拦截命令（未执行）: <command>（原因: <reason>）`
- 单测：注入格式 + 过期淘汰（仅保留最近 1 条，超过 10 分钟丢弃）

### 3.3 G3 报错解释（手动触发）

**UI**：
- `BlockOverlay.tsx` `Toolbar`（191-214 行）：`failed && teachEnabled` 时渲染"AI 解释"图标按钮（新 prop 回调 `onExplainError(block)`，BlockOverlay 保持纯展示受控）
- 新组件 `ErrorExplainCard.tsx`（挂 block 工具条下方浮层）：loading → 流式文本 → 完成态（复制 / 关闭 / "在 AI 面板继续问"）

**链路**：
1. 点击 → `runSidecarStream({ agentId: "teach", input: "explain-error: ..." })`（复用 teach-trigger.ts:221-236 的调用模式）
2. 输入构造：`explain-error: <命令>\n退出码: <exitCode>\n<块文本尾部 2KB，过 redactSensitive>`
3. prompt 语义（teach agent 已有 system prompt 承接）：中文、面向学生、≤150 字、给 1-3 条修复建议

**节流与开关**：
- 同一块（block id）只解释一次，重复点击直接复用已有结果
- 全局单飞行（正在流式时其他块按钮禁用）
- `teachAgentEnabled === false` → 按钮不渲染

### 3.4 G4 终端搜索

**快捷键**：`shortcuts.ts` 新增
```ts
{ id: "terminal.find", label: "Find in terminal", group: "Terminal",
  defaultBindings: [{ [MOD_SHIFT]: true, key: "f" }] }
```
- **Ctrl+Shift+F**（Ctrl+F 已被 `search.focus` 占用且语义是文件/tab 搜索；Windows Terminal 同款惯例）

**组件**：新 `src/modules/terminal/TerminalSearchBar.tsx`
- 位置：终端 pane 顶部右侧 absolute 浮层
- 控件：输入框 / 上一处 ↑ / 下一处 ↓（Enter/Shift+Enter）/ 大小写开关 / 关闭（Esc）
- 无结果时显示"无匹配"提示（SearchAddon 0.16 无计数事件，不做序号统计）

**接线**：
- addon 获取：`useTerminalSession` 的 `callbacks.onSearchReady` 已回传 SearchAddon 实例（useTerminalSession.ts:901）→ 存 lid→addon 模块级注册表（或 leaf 状态），TerminalSearchBar 持当前 leaf 的 addon 直接调 `findNext/findPrevious`（带 `{ caseSensitive, incremental: false }`）
- 关闭时 `clearDecorations()` 清高亮
- `Session.searchQuery` 字段维持不动（仅 bind 时初值，动态搜索全走 addon 直调——避免重挂 slot）

**与 BlockOverlay SearchBar 共存**：块内查找（blockDecorations.searchBlock）与 xterm 全文搜索是两套体系，视觉位置不同（块工具条 vs pane 顶部），本批不做合并。

## 4. 顺手修复（F0，尽力修）

**get_terminal_scrollback 断链**：sidecar `get_terminal_output` → `rust_bridge.ipc_invoke("get_terminal_scrollback")` → Rust 无此方法。

- **实施步骤**：先调研 DefaultRustBridge 是否具备 sidecar→前端 请求-响应 往返能力（现有 send_notification 是单向）。
- **能则修**：前端注册 handler（listen 请求事件 → 读 getTerminalContext → 回发结果），Python 端 request_id + 2s 超时。
- **不能/成本过高则降级**：工具返回明确文案"终端上下文暂不可用，请让用户粘贴输出或使用 AI 面板"，并在 DEV-JOURNAL 留档 P2。

## 5. 验收标准（桌面端 tauri:dev 实测）

| # | 场景 | 期望 |
|---|------|------|
| A1 | `echo "password=hunter2 token=abc123"` 后问 AI"刚才输出了什么" | AI 复述中凭据为 REDACTED |
| A2 | RiskGuard deny 高危命令后问 AI"刚才执行了吗" | AI 如实回答"被拦截未执行"，不编造 |
| A3 | 失败块（exit≠0）点击"AI 解释" | 卡片流式中文解释 + 修复建议 |
| A4 | Teach 开关关闭 | "AI 解释"按钮不显示 |
| A5 | 终端 Ctrl+Shift+F | 搜索面板弹出、高亮、Enter 跳下一处、Esc 关闭 |
| A6 | 编辑器 Ctrl+F | 行为不变（编辑器/tab 搜索） |
| A7 | SSH 终端全链路 | 搜索/解释/脱敏在 SSH 会话同样工作，预测与翻译不回归 |

## 6. 风险与红线

- **红线 9（终端改动牵一发动全身）**：G3/G4 只加 UI 按钮与浮层，不碰终端输入路径、不改命令改写逻辑；G2 的 lastBlockedCommand 只进 AI 上下文，不写终端。
- **B2 预留**：报错解释卡片与 TeachCard 渲染体系并存；ghost text 与本批无耦合。
- **Provider 兼容**：条款是中文 system prompt 追加，对国产模型（DeepSeek/GLM/Kimi）均适用；不改变工具协议。
