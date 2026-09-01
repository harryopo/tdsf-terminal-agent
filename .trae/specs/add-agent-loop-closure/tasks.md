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

- [ ] Task 8: T8 回放测试
  - [ ] 8.1 replay 测试工具：读 agent_log JSONL 重放 user_msg/tool_result 序列，断言行为（工具选择/顺序/验证）
  - [ ] 8.2 沉淀 5 个场景回放集：模式切换连续性/熔断/todo 长任务/验证回环/记忆召回
  - [ ] 8.3 接入 pytest（mark replay，CI 可跑）
- [ ] Task 9: T9 稳定性补强
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
