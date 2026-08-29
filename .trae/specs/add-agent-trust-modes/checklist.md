# Checklist — add-agent-trust-modes

## A 线：三模式核心

- [ ] `AgentMode` 枚举（observe/confirm/auto）随 agent.invoke 传参生效；缺 mode 字段默认 confirm 且留降级日志
- [ ] `decide(risk, mode)` 映射矩阵单测全格覆盖（观察只读allow/其余deny；确认L0-L1 allow、L2-L4 confirm；自动L0-L2 allow、L3/L4 confirm）
- [ ] 观察模式下 agent schema 中不存在任何 readonly=False 工具（schema 级隔离单测）
- [ ] 观察模式写操作被拒后 agent 如实报告"只读模式下未执行"（禁编造）
- [ ] 自动模式 L3（systemctl restart）升级弹确认；L4（rm -rf）永远确认
- [ ] Teach 开关叠加任意模式输出 TeachCard 结构化内容（概念→示例→易错点→练习）且不改变权限矩阵
- [ ] `_SUB_AGENT_SPECS`/Agent.as_tool/子 agent 缓存/委派 prompt 已删除，grep 无残留引用
- [ ] 前端 TdsfAgentId 收敛为 main；模式切换器三档 + Teach 开关可用；per-session 持久化重启恢复
- [ ] AgentStatusPill 显示模式状态（无 agent 切换动画）
- [ ] 审批卡四层卡面完整渲染（语义描述/命令原文/LLM 解释/影响预测含 L0-L4 色带）
- [ ] 三按钮行为正确：拒绝可附言（agent 收到并换方案）/ ⚡只读免审仅 ≤L1 显示且不落盘 / L3-L4 无批量永久选项
- [ ] 双轨反馈：用户拒绝="用户拒绝了此操作"+附言可协商；引擎拦截=command_blocked 如实报告禁替代方案
- [ ] host 校验：目标主机 ≠ 激活终端主机时拦截提示
- [ ] 审批 5 分钟超时 fail-closed：拒绝 + 通知 + 留待办
- [ ] 影响预测引擎：`echo x; rm -rf /tmp/a` 拆解逐段判定；未知脚本标注"影响未知——请人工审查"
- [ ] 会话级只读免审生效且重开会话恢复谨慎
- [ ] 白名单 `systemctl status *` 加规则后自动放行；UI 可删除规则后恢复审批；危险构造（$()/反引号/&&/重定向/eval）永不自动放行
- [ ] deny 硬底线：deny 规则压倒白名单与自动模式（单测）

## B 线：终端感知与可视教学

- [ ] SSH 注入脚本发 OSC 133 A/B/C/D + 633;E/P，幂等/交互检查/保序；SSH 终端 prompt 显示正常无污染
- [ ] 前端 block 流水账记录 command/cwd/exit_code/duration_ms/author/output_tail；visible 注入命令 author=agent
- [ ] `<environment>` 探测缓存（os-release/内核）注入；agent 按 CentOS→yum / Ubuntu→apt 因地制宜
- [ ] `<terminal-history>` 注入最近 N block（截断+脱敏+token 预算）；agent 能回答"刚才哪步失败了"
- [ ] 打字机逐字注入：Weibull 随机节奏（禁匀速）、首字符零延迟；速度滑杆 0.2×~5× 生效；逐字/整段开关生效
- [ ] 打字机 8 项注意事项落地：清行等 133;A / 只发可打印字符+\r / 含 `!` 告警 / 密码场景降级整段 / 用户按键停 pump / 等上条 133;D / 背压处理 / >200 字符建议整段
- [ ] 演示中任意按键打断并交还控制权（状态条提示）

## 全局门禁

- [ ] pytest 全绿（数量 ≥ 收敛后合理值，删除委派相关测试有说明）
- [ ] vitest 全绿 + tsc + lint 0 警告 + build:web 成功 + cargo check 通过
- [ ] tauri:dev 桌面实测：方案书 §7 验收清单 1-8 项逐条通过
- [ ] 红线 9 回归：SSH 终端 + 翻译选词 + 文件树联动全链路正常
- [ ] 任务收尾三件事：commit + DEV-JOURNAL 复盘 + ROADMAP/dev-state 更新
