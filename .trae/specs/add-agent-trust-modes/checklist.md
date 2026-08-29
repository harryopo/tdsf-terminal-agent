# Checklist — add-agent-trust-modes

> ✅ = 已由测试/代码审查验证（2026-08-29）；⏳ = 需用户桌面交互实测（LLM key + SSH 目标机）。

## A 线：三模式核心

- [x] `AgentMode` 枚举（observe/confirm/auto）随 agent.invoke 传参生效；缺 mode 字段默认 confirm 且留降级日志
- [x] `decide(risk, mode)` 映射矩阵单测全格覆盖（test_modes.py 44 用例）
- [x] 观察模式下 agent schema 中不存在任何 readonly=False 工具（schema 级隔离单测）
- [x] 观察模式写操作被拒后 agent 如实报告"只读模式下未执行"（command_blocked 轨道，单测）
- [x] 自动模式 L3 升级弹确认；L4 永远确认（单测；白名单/前缀免审均带 risk_l≤3 上限锁定）
- [x] Teach 开关叠加任意模式输出 TeachCard 结构化内容且不改变权限矩阵（_TEACH_SKIN_PROMPT 迁移 + AiChat teach 开关驱动渲染）
- [x] `_SUB_AGENT_SPECS`/Agent.as_tool/子 agent 缓存/委派 prompt 已删除，grep 无残留引用（工具集 24→20）
- [x] 前端 TdsfAgentId 收敛为 main；模式切换器三档 + Teach 开关可用；per-session 持久化重启恢复（AgentModeSwitcher + sessions.ts SessionMeta）
- [x] AgentStatusPill 显示模式状态（无 agent 切换动画）
- [x] 审批卡四层卡面完整渲染（NeedsYouApprovalCards 四层 + tool.tsx ToolApprovalCard，30 用例）
- [x] 三按钮行为正确：拒绝可附言（reason+note 双字段回传）/ ⚡只读免审仅 ≤L1 显示且不落盘 / L3-L4 无批量永久选项
- [x] 双轨反馈：用户拒绝="用户拒绝了此操作"+附言可协商；引擎拦截=command_blocked 如实报告禁替代方案（ssh_command.py status 契约）
- [x] host 校验：目标主机 ≠ 激活终端主机时拦截提示（ssh_host 取 live.sshConnection；不可得时跳过已注释）
- [x] 审批 5 分钟超时 fail-closed：拒绝 + 通知 + 留待办（needs_you.py 30s→300s）
- [x] 影响预测引擎：`echo x; rm -rf /tmp/a` 拆解逐段判定；未知脚本标注"影响未知——请人工审查"（test_command_impact.py 54 用例）
- [x] 会话级只读免审生效且重开会话恢复谨慎（SessionTrustStore 内存态，切会话/新建重置）
- [x] 白名单 `systemctl status *` 加规则后自动放行；UI 可删除规则后恢复审批；危险构造永不自动放行（trust_store 评估顺序 + ApprovalWhitelistCard）
- [x] deny 硬底线：deny 规则压倒白名单与自动模式（`rm -rf /` 入白名单仍拦截，单测锁定）

## B 线：终端感知与可视教学

- [x] SSH 注入脚本发 OSC 133 A/B/C/D + 633;E/P，幂等/交互检查/保序（cargo 脚本断言 5 例；不碰 PS1 断言）；⏳ SSH 终端 prompt 显示无污染待实测
- [x] 前端 block 流水账记录 command/cwd/exit_code/duration_ms/author/output_tail；visible 注入命令 author=agent（terminalBlocks 16 用例 + markAgentPending）
- [x] `<environment>` 探测缓存注入（system.probe_env 会话级缓存 + 5min TTL，test_env_probe 17 用例）；⏳ agent 按 CentOS→yum 因地制宜待实测
- [x] `<terminal-history>` 注入最近 10 block（6000 字符预算超限丢最旧 + 脱敏）；⏳ agent 回答"刚才哪步失败了"待实测
- [x] 打字机逐字注入：Weibull 随机节奏（禁匀速）、首字符零延迟；速度滑杆 0.2×~5× 生效；逐字/整段开关生效（human_type.rs 10 单测 + AgentTypingCard/AgentModeSwitcher 快捷开关）
- [x] 打字机 8 项注意事项落地：清行等 prompt（\x03+300ms）/ 只发可打印字符+\r / 含 `!` 告警 / sudo 密码场景降级整段 / 用户按键停 pump（user_input_seq）/ 等上条 133;D（调用方串行注释）/ russh 背压注释 / >200 字符自动整段+toast
- [x] 演示中任意按键打断并交还控制权（"演示中"状态条 AgentTypingIndicator 挂 App.tsx）

## 全局门禁

- [x] pytest 全绿 **1651**（工具集 24→20 的委派测试删除/改写有说明：test_e2e_strands 重写 + test_modes 44 新增）
- [x] vitest 全绿 **1187**（118 文件）+ tsc 0 错误 + lint 0 警告 + build:web 成功 + cargo check 通过 + cargo test 407（隔离跑）
- [x] tauri:dev 桌面启动实测：sidecar ready 11.9s、**114 方法**注册（含 memory.whitelist.* ×3 + system.probe_env）、无 ERROR/panic
- [ ] ⏳ tauri:dev 桌面交互实测：方案书 §7 验收清单 1-8 项逐条通过（需用户 + LLM key + SSH 目标机）
- [ ] ⏳ 红线 9 回归实测：SSH 终端 + 翻译选词 + 文件树联动全链路（OSC 7 链路未动，风险低，仍需实测确认）
- [x] 任务收尾三件事：commit c671fef + DEV-JOURNAL §37.81 复盘 + ROADMAP/dev-state 更新
