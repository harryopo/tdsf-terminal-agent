# TDSF Terminal Agent · Agent 架构说明书

> **版本**：v1.1（2026-08-01，P0-6 全链路打通后）
> **基线**：以当前代码事实为准（`src-tauri/sidecar/strands_backend/adapter.py`、`src/modules/ai/`）
> **配套**：产品与技术方案书 `docs/方案书-v1.0.md`（总纲）、开发状态 `docs/dev-state.md` §37.17/37.18

---

## 1. 架构总览

三层进程分离架构，AI 编排采用 **Strands Agents 单框架**：

```
┌─────────────────────────────────────────────────────────────┐
│  React 19 前端（Tauri WebView）                              │
│  终端渲染池(xterm) │ Space/Tab 模型 │ 文件树 │ AI 面板        │
│  Vercel AI SDK 流式 │ 工具行渲染 │ AgentStatusPill           │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC（invoke + event）
┌──────────────────────────▼──────────────────────────────────┐
│  Rust 主进程（Tauri 2）                                      │
│  PTY 池 │ SSH 会话池(russh) │ SFTP │ keyring │ Sidecar 管理  │
│  双向 JSON-RPC 桥（Python→Rust 反向调用）                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdio JSON-RPC 2.0
┌──────────────────────────▼──────────────────────────────────┐
│  Python Sidecar（Strands Agents 单框架）                     │
│  main agent（统一入口，11 工具）                             │
│    ├─ 7 运维工具：ssh_command / read_remote_file /           │
│    │   analyze_logs / inspect_processes / network_diagnose / │
│    │   skill_invoke / suggest_command                        │
│    └─ 4 子 agent 工具：teach / coding / explore / history    │
│  子 agent（真实 Strands 实例，独立 prompt + 工具白名单）      │
│  安全：4 级权限 │ RiskChecker │ 脱敏 │ ToolCallLimitHook      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Agent 体系

### 2.1 主 Agent（main）— 统一对话入口

用户只需与 main 对话。main 的 system prompt 包含运维助手职责 + 委派原则，由 **LLM 自主识别意图**：

| 意图                                   | 行为                        |
| -------------------------------------- | --------------------------- |
| 普通运维操作（查日志、跑命令、读文件） | 直接用 7 个运维工具，不委派 |
| 教学讲解请求                           | 委派`teach` 子 agent      |
| 代码/配置定位修复                      | 委派`coding` 子 agent     |
| 只读探索（文件/日志/进程/网络）        | 委派`explore` 子 agent    |
| 过往操作/领域知识查询                  | 委派`history` 子 agent    |

### 2.2 子 Agent（4 个真实 Strands 实例）

| Agent       | 工具集（schema-level safety）                                                                                        | 定位                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `teach`   | read_remote_file / analyze_logs / skill_invoke / suggest_command（**无 ssh_command**）                         | 结构化教学：概念→示例→易错点→练习 |
| `coding`  | ssh_command / read_remote_file / suggest_command                                                                     | 远程代码/配置定位与修复方案          |
| `explore` | read_remote_file / analyze_logs / inspect_processes / network_diagnose / suggest_command（**无 ssh_command**） | 只读系统探索                         |
| `history` | suggest_command / skill_invoke                                                                                       | 基于上下文的过往操作复盘 + 知识卡    |

**schema-level safety**：子 agent 注册表中不存在执行工具（LLM 无法调用不存在于其 schema 的工具），从根源杜绝教学/探索场景误执行命令。

### 2.3 Agent 缓存

- 主缓存：`(agent_id, session_id, permission_level)` → Strands Agent 实例
- 子 agent 工具缓存：`(agent_id, session_id, permission_level)` → `Agent.as_tool()` 包装
- 权限级别变化 / LLM 配置变更 → `clear_cache()` 全量重建

---

## 3. 委派流程图

```mermaid
flowchart TB
    A["用户输入 main"] --> B["main LLM 意图识别<br/>(_MAIN_SUB_AGENT_PROMPT)"]
    B -->|"普通运维"| C["直接用 7 运维工具<br/>RustBridge → SSH/SFTP"]
    B -->|"教学"| D["委派 teach"]
    B -->|"代码修复"| E["委派 coding"]
    B -->|"只读探索"| F["委派 explore"]
    B -->|"历史/知识"| G["委派 history"]
    D --> H["子 agent 独立 agentic loop<br/>(静默 handler 防污染)"]
    E --> H
    F --> H
    G --> H
    H -->|"内部工具调用"| I["RustBridge → SSH/SFTP"]
    H -->|"toolResult 回填"| J["main 整合子 agent 结果"]
    J --> K["最终回答流式输出"]
```

---

## 4. 委派时序（可视化链路）

一次"帮我讲一下 nginx"的完整事件流：

```
用户 ──agent.invoke(main)──▶ Sidecar
                               │
main LLM 决策: 调用 teach      │
                               │
  main handler 收到 tool_stream 事件
  ├─ emit tool_call("agent:teach", started, params={input})
  │    └─▶ 前端: 工具卡片出现 "Teach Agent" 徽标 + 委派输入摘要
  ├─ 子 agent 运行 (独立 loop, 静默 handler)
  │    ├─ 内部工具经 RustBridge 执行 (SSH/SFTP)
  │    └─ 文本增量 → tool_stream(data) → main handler
  │         └─ emit agent_message(msg_type=agent_call)  [调试/日志]
  ├─ emit agent_switch("teach")      └─▶ 前端 Pill: main → teach
  ├─ 子 agent 完成 → toolResult 回填
  │    └─ emit tool_call("agent:teach", completed, result=全文)
  │         └─▶ 前端: 工具卡片折叠展开子 agent 全文
  │
main 整合教学结果 ──▶ 最终回答
  ├─ emit agent_switch("main")       └─▶ 前端 Pill: teach → main (归位)
  └─ observation 流式输出 (text-delta)
```

### 事件协议

| 事件                      | 载荷                                                        | 用途                                         |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `sidecar:tool_call`     | `tool_name="agent:<name>"`, started(输入)/completed(全文) | 子 agent 调用卡片（复用工具行管道）          |
| `sidecar:agent_switch`  | `agent`                                                   | Pill 联动显示当前活跃 agent                  |
| `sidecar:agent_message` | `msg_type="agent_call"`                                   | 子 agent 增量（调试/日志，前端不渲染防污染） |
| `sidecar:mood_change`   | thinking/working/done/error                                 | 状态点与动画                                 |

---

## 5. 安全体系（四层护栏）

| 层           | 机制                   | 说明                                                                     |
| ------------ | ---------------------- | ------------------------------------------------------------------------ |
| 1. Schema 层 | 工具白名单             | 子 agent 注册表按角色裁剪；L1 权限再叠加只读过滤                         |
| 2. 工具层    | RiskChecker + 4 级权限 | 高危命令（rm -rf/reboot/mkfs/fork bomb 等）逐行检测，L1-L4 分级审批      |
| 3. 循环层    | ToolCallLimitHook      | 单次 invoke 工具调用上限 12 次；单工具连续失败 3 次熔断（fix-loop 保护） |
| 4. 输出层    | redact_sensitive       | 私钥/密码/AKIA/URL 凭据/Bearer 等 7 类模式脱敏                           |

**防递归**：子 agent 工具集不嵌套 agent 工具（main 是唯一委派入口）。

---

## 6. 演进对照（历史 → 当前）

| 维度            | 历史（LangGraph 时代）                         | 当前（P0-6 后）                                   |
| --------------- | ---------------------------------------------- | ------------------------------------------------- |
| 编排框架        | LangGraph 7 节点 PAOR 图（遗产，主路径不执行） | Strands Agents 单框架                             |
| 意图识别        | 关键词正则路由（plan_task）                    | LLM 自主决策（agent-as-tool）                     |
| 子 agent        | 9 个 BaseAgent 类，被 override 绕过            | 4 个真实 Strands 实例，main 委派                  |
| 子 agent 可视化 | agent_switch 事件（Pill 仅显示）               | 工具卡片（输入/状态/全文）+ Pill 联动             |
| 流式            | 24 字符/8ms 伪流式切片                         | Strands 事件真流式（agent_message → text-delta） |

---

## 7. 关键文件索引

| 文件                                                    | 职责                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `src-tauri/sidecar/strands_backend/adapter.py`        | 适配层核心：`_SUB_AGENT_SPECS` 注册表、main 委派、事件转发 |
| `src-tauri/sidecar/strands_backend/tools/__init__.py` | 7 运维工具工厂 + 工具白名单 + 脱敏 + 4 级权限                |
| `src-tauri/sidecar/strands_backend/tools/*.py`        | 各工具实现（ssh_command/remote_file/log_analyzer 等）        |
| `src/modules/ai/agents/registry.ts`                   | 前端 5 个 agent 入口注册表（与后端一一对应）                 |
| `src/modules/ai/lib/sidecar-adapter.ts`               | 事件→流式 part 转换、工具行管道、错误提示                   |
| `src/components/ai-elements/tool.tsx`                 | 工具行/子 agent 卡片渲染（`agent:` 前缀识别）              |
| `src/modules/ai/components/AgentStatusPill.tsx`       | 当前活跃 agent 指示器                                        |

---

## 8. 已知边界

- 真实 LLM 的委派行为依赖模型对委派 prompt 的理解（机制已通，e2e 用 FakeModel 脚本验证；真实效果待实测）
- 子 agent 增量流式展示（tool-input-delta）为增强项，当前 completed 一次性展示全文
- 长期记忆（决策库）与证据链可视化在方案书 P1/P2 规划中
