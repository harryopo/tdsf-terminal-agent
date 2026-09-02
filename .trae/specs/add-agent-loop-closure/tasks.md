# Tasks

> 来源：方案书 v4.0（用户审批，沙箱暂缓）。P0→P1→P2 顺序执行；同阶段内无依赖任务可并行。

## P0 闭环修复

- [x] Task 1: T1 上下文连续性——messages 与 Agent 实例解耦
  - [x] 1.1 会话消息历史 per-session 独立存储；实例重建（模式/教学切换）时迁移 messages 到新实例
  - [x] 1.2 实例缓存 key 移除 mode/teach（perm 保留——权限影响工具集合法性）
  - [x] 1.3 启用 SDK `conversation_manager="auto"`（压缩阈值 0.85）——实测 SDK 参数名为 context_manager="auto"
  - [x] 1.4 单测：切模式后历史保留；超长对话自动压缩
- [x] Task 2: T2 循环护栏——挂载 ToolCallLimitHook + 进度上报
  - [x] 2.1 挂载 ToolCallLimitHook（连续失败 ≥3 熔断并向用户报告含失败摘要；总上限 50）
  - [x] 2.2 每轮进度（轮次/工具计数）写 agent_log（新事件类型 loop_progress）
  - [x] 2.3 前端状态条显示循环进度（AgentStatusPill 扩展）
  - [x] 2.4 单测：连续失败熔断触发；50 上限不误杀长任务
    - 注：2.1 的"连续失败 ≥3 熔断"在 T8 回放实测中一度被证实在真实 strands 事件流下失效（ROADMAP #44），2026-09-02 已修复并补 `TestRealStrandsResultShape`（用真实事件 dict 而非 MagicMock 构造）+ 回放场景 `s2b` 双保险。详 DEV-JOURNAL §37.103。
- [x] Task 3: T3 规划-执行回环——todo 驱动执行
  - [x] 3.1 系统提示规划段：≥3 步任务必须先 todo_write 建清单、完成即更新
  - [x] 3.2 invoke 收尾校验：存在未完成 todo → 追加一轮续做提示（限一次，防死循环）
  - [x] 3.3 TodoStrip 补 per-item 完成时间戳
  - [x] 3.4 单测：收尾校验逻辑（有未完成项触发提示；已完成不触发；追加仅一次）
- [x] Task 4: T4 记忆主动召回——每轮 RAG 注入
  - [x] 4.1 每轮上下文组装时检索 top-3 相关案例（query=当前用户消息，source 过滤 session-memory/session-case）注入 `<recalled-memory>` 区
  - [x] 4.2 3s 超时静默跳过（Promise.race 模式，参照首轮注入）
  - [x] 4.3 与首轮会话级摘要注入区分（命名/注释明确两者职责）
  - [x] 4.4 单测：召回注入格式；超时跳过

## P1 真实能力

- [x] Task 5: T5 python_run PTC 工具（无沙箱，进程级受控）
  - [x] 5.1 新建 tools/python_run.py：subprocess 执行（timeout 30s、输出截断 10KB、cwd 锁定 workspace、失败返回 exit_code+stderr）；fail-closed 四路（code 缺失/SSH 会话拒绝/workspace 不可得/OSError）
  - [x] 5.2 registry 注册：ToolPolicy(readonly=False, needs_approval=False, sanitize_output=False)——审批走三模式管控（observe 模式写类工具被 schema 级裁剪）
  - [x] 5.3 系统提示：明确用途（多文件交叉统计/复杂解析/批量操作优先 python_run 一次完成）+ Post-change verification 指引
  - [x] 5.4 单测：超时 kill、输出截断、cwd 锁定、三模式可见性（test_python_run.py，17 例）
- [x] Task 6: T6 Skill 剧本化
  - [x] 6.1 SKILL.md 解析器支持 `steps:` 段（有序步骤：description+tool_hint+success_criteria；容错跳过缺 description 项）
  - [x] 6.2 skill_invoke 命中带 steps 技能 → 返回 playbook + playbook_text 注入对话，自动调 todo_write 写入步骤（`[skill名] i/N 描述`，按 title 去重合并）
  - [x] 6.3 改造样板：systemd-troubleshoot（五步）、selinux-baseline（四步）
  - [x] 6.4 步骤进度同步 TodoStrip（经 todo_write 走 T3 链路）
  - [x] 6.5 单测：steps 解析、注入格式、样板技能结构（test_skill_playbook.py，20 例）
- [x] Task 7: T7 执行后验证回环
  - [x] 7.1 系统提示行动段：凡写操作（写文件/执行命令/改配置）必须只读工具验证（status/cat/test）才宣告完成；写类/验证类常量入 registry；ssh_command 按命令级细分（RiskChecker：只读命令算验证而非写操作）
  - [x] 7.2 收尾检测（与 T3.2 共用钩子 `_maybe_verify_followup`）：有写无验证 → 追加补验证提示（会话级 flag 限一次）
  - [x] 7.3 单测：写后未验证触发提示；已验证不触发（test_verify_followup.py，26 例）

## P2 稳定性与测试

- [x] Task 8: T8 回放测试（2026-09-02 ✅ 全量门禁绿，详 DEV-JOURNAL §37.102）
  - [x] 8.1 replay 测试工具：读 agent_log JSONL 重放 user_msg/tool_result 序列，断言行为（工具选择/顺序/验证）
    - 落地：`strands_backend/tests/replay/replay.py`。场景文件沿用 agent_log 的 JSONL 行协议（`meta`/`turn`/`expect`），但重放的是**脚本化的模型轮次**（fake `ReplayModel` + `RecordingBridge` 喂录制返回值）驱动真实 `StrandsAgentAdapter.invoke()`，而非回放历史 `tool_result` 日志行。
    - 断言源为 `hook.tool_log`、`agent_log.tail()`、模型实际收到的 messages 与 tool schema（`ReplayModel.received/schemas`）。**不能**断言 `tool_call`/`tool_result` 日志行——那两类事件由全局 EventBus 订阅写入，测试里 event_bus 是 MagicMock 时不产生。
  - [x] 8.2 沉淀 5 个场景回放集：模式切换连续性/熔断/todo 长任务/验证回环/记忆召回
    - 落地：`scenarios/s1_mode_continuity` / `s2_tool_cap_breaker` / `s3_todo_longtask` / `s4_verify_followup` / `s5_memory_recall`，另加 `s2b_consecutive_failure_breaker`（连续失败熔断，见下）。
    - **曾发现的缺陷（T2 相关，已于 2026-09-02 同晚修复，ROADMAP #44 已核销）**：「同一工具连续失败 3 次熔断」在真实 strands 事件流下失效——ops 工具返回的 dict 被 strands JSON 序列化进 `content[].text`，外层 `status` 恒为 `success`；且 `ToolResult` 是 TypedDict（运行时 dict）而 adapter 用 `getattr(result, "status")` 取值恒为默认值。当时仅「总调用数超上限 50」有效，该行为以 `xfail(strict=True)` 锁定。修复=adapter 新增 `_tool_payload`/`_result_status` 还原工具自报状态（error/command_blocked/rejected/needs_approval/unavailable 均计失败），xfail 摘除转常规断言 `test_consecutive_failure_breaker_trips`，另补 `TestRealStrandsResultShape` 4 条真实事件形状用例。详 DEV-JOURNAL §37.103。
  - [x] 8.3 接入 pytest（mark replay，CI 可跑）
    - 落地：`replay/conftest.py` 注册 `replay` marker + 环境隔离 fixture（`TDSF_DATA_DIR`→tmp_path、`reset_for_test`/`reset_session_todos`、审批门 `request_approval_and_wait` 打桩为 APPROVED，否则真实 human-in-the-loop 会挂住 CI）。
    - 实测：`python -m pytest strands_backend/tests/replay -m replay` → 首轮 5 passed / 1 xfailed（s2b 锁缺陷）→ #44 修复后 **6 passed**（5.9s）；无网络、无真实 SSH。
- [ ] Task 9: T9 稳定性补强
  > 注（2026-09-02 复核轮已完成）：T9/T10 代码在 commit 7e87946（§37.100）。逐行复核结果——**9.3 与 10.2 已在 checklist.md 核销**；**9.1 / 9.2 / 10.1 保持未勾**：9.1 的 timeout 只覆盖 OpenAI 分支且 `invoke()` 超时链零断言、9.2 唯一那条 invoke 用例是假绿（只测分类函数）、10.1 后端 DSPCR5 分档未固化且"高档展示依据"未满足。缺陷清单见 ROADMAP **#45** + DEV-JOURNAL §37.104。
  - [ ] 9.1 model_adapter 显式超时 + invoke watchdog（10 分钟无输出超时报告）
  - [ ] 9.2 LLM 不可用降级：只读问答提示（不中断对话报错卡）
  - [ ] 9.3 提示词鼓励独立信息收集并行多工具（吃 SDK ConcurrentToolExecutor 红利）
  - [ ] 9.4 单测：watchdog 触发；降级文案
- [ ] Task 10: T10 置信度与证据链深化
  - [ ] 10.1 置信度三档标准固化（高=工具证据+知识库佐证；中=其一；低=纯推理附原因）
  - [ ] 10.2 证据区 UI 按"收集→执行→验证"分组
  - [ ] 10.3 单测/组件测试同步

## Task Dependencies

- Task 2/3/4 无相互依赖（P0 内可并行）
- Task 3.2 与 Task 7.2 共用收尾钩子 → Task 7 依赖 Task 3
- Task 5 独立（P1 内可与 6 并行）
- Task 6.4 依赖 Task 3（TodoStrip 联动）
- Task 8 依赖 Task 2（loop_progress 事件）/ Task 3 / Task 7（回放场景）
- Task 10 独立
