# Agent 架构闭环升级（感知→思考→行动→记忆）Spec

> 来源：`docs/agent/方案书-v4.0-Agent架构闭环升级.md`（用户已审批，唯一调整：
> **暂不做沙箱相关内容**——T5 python_run 不接 SDK sandbox，改为纯进程级超时/输出限制/工作目录锁定的受控执行；沙箱化列 P3 后续）。

## Why

Agent 四层闭环存在四个物理断点：切模式丢对话历史（实例缓存 key 卷入 mode/teach）、任务清单不驱动执行、工具失败无熔断护栏（ToolCallLimitHook 写了没挂）、记忆无主动召回。同时存在多个"写了没接线"的现成资产（SDK conversation_manager="auto"、fix_loop）。本变更把断点接上、资产接线、补齐真实能力（PTC/剧本/验证回环）与测试基建（回放测试）。

## What Changes

- **T1 上下文连续性**：messages 与 Agent 实例解耦（per-session 存储，实例重建时迁移）；模式/教学只影响系统提示词与工具集，不再影响历史；启用 SDK `conversation_manager="auto"` 自动压缩。
- **T2 循环护栏**：重新挂载 ToolCallLimitHook（连续失败 ≥3 熔断报告；总上限放开 50）；循环进度（第 N 轮/已用工具 M 次）写 agent_log + 前端状态条。
- **T3 规划-执行回环**：系统提示要求 ≥3 步任务先 todo_write 建清单；invoke 收尾校验未完成项 → 追加一轮提示（一次机会）；TodoStrip 补 per-item 完成时间。
- **T4 记忆主动召回**：每轮检索 top-3 相关案例注入 `<recalled-memory>` 区（3s 超时静默跳过；区别于首轮会话级摘要注入）。
- **T5 PTC python_run 工具**：新工具，进程级受控执行（subprocess 超时 30s/输出截断 10KB/cwd 锁 workspace），**无沙箱**；observe 模式 schema 裁剪、confirm 需审批、auto 免审。
- **T6 Skill 剧本化**：SKILL.md 扩展 `steps:` 段（有序步骤+成功判据）；skill_invoke 注入剧本驱动工具序列；先改造 systemd-troubleshoot 与 selinux-baseline 两个样板。
- **T7 执行后验证回环**：凡写操作必须只读工具验证才宣告完成；收尾检测"有写无验证"追加提示。
- **T8 回放测试**：读 agent_log JSONL 重放断言行为的 replay 测试工具 + 5 个真实场景回放集。
- **T9 稳定性**：LLM 调用显式超时 + invoke watchdog（10 分钟）；LLM 不可用降级只读问答；提示词鼓励独立信息收集并行发多工具。
- **T10 置信度深化**：三档标准（高=工具证据+知识库佐证；中=其一；低=纯推理附原因）；证据区按"收集→执行→验证"分组。

**不做**：Cordis 迁移、MCP（T13 顺延）、子 Agent、agent_log 前端 UI、RAG 引擎升级、**沙箱（用户明确暂缓）**。

## Impact

- Affected code：`src-tauri/sidecar/strands_backend/adapter.py`（T1/T2/T3/T4/T7/T9 核心）、`strands_backend/tools/registry.py`（T5 新工具注册）、新文件 `tools/python_run.py`、`skills/builtin/systemd-troubleshoot/SKILL.md` 与 `selinux-baseline/SKILL.md`（T6）、`strands_backend/agent_log.py`（T2 进度事件）、新 `tests/test_replay.py`（T8）、`src/modules/ai/components/`（TodoStrip 时间戳、状态条进度、证据区分组）、`src/lib/confidence/`（T10）。
- Affected specs：add-agent-trust-modes（工具集/模式交互不变，hooks 变更）；无 BREAKING（python_run 为新增工具，observe 不可见）。

## ADDED Requirements

### Requirement: 上下文连续性（T1）
系统 SHALL 在 Agent 实例因模式/教学切换而重建时保留完整对话历史；长对话 SHALL 经 SDK auto 压缩（阈值 0.85）不报错。

#### Scenario: 模式切换历史保留
- **WHEN** 用户在对话中途切换 observe→confirm→auto
- **THEN** agent 记得此前对话内容，无历史丢失

### Requirement: 循环护栏（T2）
系统 SHALL 在连续工具失败 ≥3 次时熔断停止并向用户报告原因；单任务工具调用上限 50；每轮进度 SHALL 写入 agent_log 并在前端状态条可见。

#### Scenario: 失败熔断
- **WHEN** 工具连续失败 3 次
- **THEN** 循环停止，输出熔断解释（含失败摘要）

### Requirement: 规划-执行回环（T3）
系统 SHALL 要求 ≥3 步任务先建 todo 清单；invoke 收尾 SHALL 校验未完成项并追加一轮续做提示（限一次）。

### Requirement: 记忆主动召回（T4）
系统 SHALL 在每轮上下文组装时检索 top-3 相关历史案例注入 `<recalled-memory>`；检索超时 3s 静默跳过不阻塞。

### Requirement: PTC python_run 工具（T5）
系统 SHALL 提供 python_run 工具：进程级执行（超时 30s、输出截断 10KB、cwd=workspace），observe 模式不可见，confirm 模式需审批，auto 模式免审。

#### Scenario: 多文件交叉统计
- **WHEN** 用户要求"统计 /etc 下 .conf 文件含 bind 的行并汇总"
- **THEN** agent 生成一段 python 一次完成（而非逐工具往返）

### Requirement: Skill 剧本化（T6）
SKILL.md SHALL 支持 `steps:` 有序步骤（每步含工具意图+成功判据）；skill_invoke 命中带 steps 的技能时把剧本注入对话驱动分步执行；步骤进度同步 TodoStrip。

### Requirement: 执行后验证回环（T7）
系统 SHALL 要求写操作后必须只读验证才宣告完成；收尾检测"有写无验证"时追加补验证提示。

### Requirement: 回放测试（T8）
系统 SHALL 提供 replay 测试工具：读 agent_log JSONL 重放并断言行为；沉淀 5 个真实场景回放集。

### Requirement: 稳定性（T9）
LLM 调用 SHALL 有显式超时；invoke 10 分钟无输出触发 watchdog 报告；LLM 不可用时降级为只读问答提示（不中断对话报错卡）。

### Requirement: 置信度三档标准（T10）
置信度 SHALL 按三档判定（高=工具证据+知识库佐证，中=其一，低=纯推理附原因）；证据区 SHALL 按收集→执行→验证分组。

## MODIFIED Requirements

### Requirement: ToolCallLimitHook 挂载
原实现（adapter.py ToolCallLimitHook）存在但 `hooks=[]` 未挂载——MODIFIED 为：挂载并调整参数（连续失败 3 熔断保留，总上限 12→50）。

## REMOVED Requirements

### Requirement: 沙箱化 python 执行
**Reason**: 用户明确暂缓（"沙箱安全这个有点困难，暂且不考虑"）。
**Migration**: T5 采用进程级受控（超时/截断/cwd 锁定）+ 审批门禁替代；沙箱化（SDK sandbox/容器隔离）列 P3 后续。
