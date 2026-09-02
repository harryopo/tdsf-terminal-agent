# Checklist

## P0 闭环修复
- [ ] T1: 模式/教学切换后对话历史保留（实测切 observe→confirm→auto 连续追问）
- [ ] T1: 实例缓存 key 不再含 mode/teach（代码审查确认）
- [ ] T1: SDK conversation_manager="auto" 已启用，超长对话自动压缩无报错
- [x] T2: ToolCallLimitHook 已挂载（hooks 非空），连续失败 3 次熔断并输出失败摘要
  - 2026-09-02 T8 回放实测曾发现熔断**失效**（ops 工具 dict 被 strands JSON 序列化进 `content[].text`，外层 `status=success`；`ToolResult` 是 TypedDict，`getattr` 取不到键）→ 当时仅总上限 50 有效，以 `xfail(strict=True)` 锁定并挂 ROADMAP #44。
  - 2026-09-02 同日晚已修复（adapter 新增 `_tool_payload`/`_result_status` 还原工具自报状态，error/command_blocked/rejected/needs_approval/unavailable 均计失败），xfail 摘除转常规断言 `test_consecutive_failure_breaker_trips`，并补 `TestRealStrandsResultShape` 4 条真实事件形状用例。详 DEV-JOURNAL §37.103。
- [ ] T2: 工具总上限 50，长任务不被 12 上限误杀
- [ ] T2: 循环进度写入 agent_log（loop_progress 事件）且前端状态条可见
- [ ] T3: ≥3 步任务系统提示要求先建 todo 清单
- [ ] T3: 收尾校验——存在未完成 todo 时追加一轮续做提示（仅一次）
- [ ] T3: TodoStrip 显示每项完成时间戳
- [ ] T4: 每轮检索 top-3 案例注入 <recalled-memory>（区别于首轮会话摘要）
- [ ] T4: 检索超时 3s 静默跳过不阻塞对话
- [ ] P0 门禁：pytest/vitest/tsc/lint 全绿

## P1 真实能力
- [ ] T5: python_run 工具可用（进程级受控：超时 30s/输出截断 10KB/cwd 锁定）
- [ ] T5: observe 模式不可见（schema 裁剪）、confirm 需审批、auto 免审
- [ ] T5: 实测"统计 /etc 下 .conf 含 bind 的行"由 python 一次完成
- [ ] T6: SKILL.md 支持 steps 段且 skill_invoke 注入剧本
- [ ] T6: systemd-troubleshoot 五步剧本实测走通（每步有工具证据）
- [ ] T6: selinux-baseline 四步剧本实测走通
- [ ] T6: 剧本步骤进度同步 TodoStrip
- [ ] T7: 写操作后必须只读验证才宣告完成（实测改 nginx 配置自动 nginx -t）
- [ ] T7: 收尾检测"有写无验证"触发补验证提示
- [ ] P1 门禁：pytest/vitest/tsc/lint 全绿 + agent_log 自测一轮

## P2 稳定性与测试
- [x] T8: replay 测试工具可读 agent_log 重放断言行为
  - 2026-09-02 实测：`tests/replay/replay.py` 以 agent_log 风格 JSONL 场景（`meta`/`turn`/`expect`）驱动真实 `StrandsAgentAdapter.invoke()`；断言源 = `hook.tool_log` + `agent_log.tail()` + 模型实收 messages/tool schema。14 类声明式 check（`tool_sequence`/`schema_has`/`history_contains`/`breaker_tripped`/`verify_followup_not_needed`/`log_event` …）。
- [x] T8: 5 个回放场景集沉淀并接入 pytest
  - 2026-09-02 实测：s1 模式连续性 / s2 总上限熔断 / s3 todo 长任务 / s4 验证回环 / s5 记忆召回（+ s2b 连续失败熔断）。`pytest strands_backend/tests/replay -m replay` → **6 passed**，无网络无真实 SSH。（s2b 首版以 `xfail(strict=True)` 锁定 #44 缺陷，同日修复后转常规断言。）
- [ ] T9: LLM 调用显式超时 + invoke watchdog（10 分钟）生效
- [ ] T9: LLM 不可用时降级为只读问答提示（非报错卡）
- [ ] T9: 提示词含并行工具指引（独立信息收集一次多工具）
- [ ] T10: 置信度三档标准落地（高档展示依据来源）
- [ ] T10: 证据区按收集→执行→验证分组
- [x] P2 门禁：全量 pytest/vitest/tsc/lint/build 全绿
  - 2026-09-02 实测：pytest（sidecar 全量）**2068 passed / 1 xfailed**（679.6s）/ tsc 0 / lint 0 / vitest 1274 passed + 1 负载抖动（`sidecar-adapter.test.ts` 单跑 16/16，本轮不碰 TS，判非回归）/ `pnpm build:web` ✓。注：本轮未跑 `pnpm tauri:dev` 桌面实测（P2 无 UI 改动），该项仍挂在"用户桌面实测验收"。
  - 2026-09-02 #44 修复轮复测：pytest（sidecar 全量）**2073 passed / 0 xfailed**（596.7s，exit 0）= 上轮 2069 条 + 新增 4 条真实事件形状用例，**xfail 清零、既有用例零被动过**；本轮无前端改动。
- [ ] 用户桌面实测验收（P0/P1/P2 各一轮）
