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
- [x] T9: LLM 调用显式超时 + invoke watchdog（10 分钟）生效
  - ✅ 2026-09-02 核销（#45 清零轮，原 2026-09-02 逐行复核曾判不核销）：① `model_adapter.py` OpenAI **与 Anthropic** 两分支均带 `timeout=300.0 / max_retries=2`，并在 `tests/test_strands_model_adapter.py` 两条用例上真断言 `client_args` 携带二者；② watchdog 阈值改为 `_watchdog_thresholds()`（下限 0.05s，非法值回退 600s/5s），"有事件续期 / 无事件超时"首次可被真验证；③ `invoke()` 超时全链路新增断言：调用方线程提前返回（elapsed < worker 挂起时长）+ `degraded_reason=invoke_watchdog_timeout` + 文案随阈值推导（含"0.3 秒"、不含硬编码"10 分钟"）+ `_stalled_sessions` 标记 + `agent_log` 收到 `watchdog_timeout` 事件 + worker 结束后标记自动解除；④ 活跃信号缺失时记 WARNING 并有界兜底。实测：`strands_backend/tests/test_watchdog.py` 14 例全过。详 DEV-JOURNAL §37.105。
- [x] T9: LLM 不可用时降级为只读问答提示（非报错卡）
  - ✅ 2026-09-02 核销（#45 清零轮）：假绿用例（只断言分类函数、从不进 invoke）已删除，换成两条真链路测试——① 模型抛 `Connection error.` 经 worker 传播 → `degraded_reason=llm_transport_error` + `next_step=done` + 友好文案（"AI 服务暂时不可用""稍后重试"），并断言 `_emit_needs_you_for_error` **零调用**；② 抛非传输类 `ValueError` → `degraded_reason=invoke_error` + `next_step=error` + needs_you 恰好一次（真实故障不被误吞）。11 个传输特征改为驱动 `_LLM_TRANSPORT_ERROR_MARKERS` 本身逐个验证（含数量断言 + 大写变形证大小写不敏感），另保留 7 条 SDK 真实文案。详 DEV-JOURNAL §37.105。
- [x] T9: 提示词含并行工具指引（独立信息收集一次多工具）
  - 2026-09-02 复核确认：`adapter.py:194`（Task planning 段内）+ 断言 `test_watchdog.py:144-155`。
- [ ] T10: 置信度三档标准落地（高档展示依据来源）
  - ⚠ 2026-09-02 逐行复核**不核销**：前端阈值在 `AiChat.tsx:534-540`（`<0.5` / `<0.3` / 无 reason 不显示），但 `ConfidenceMarker` 未导出、无组件测试；后端 `core/confidence.py:457` DSPCR5 **分档权重未固化**（全仓 grep `分档|tier` 零命中）；且"高档展示依据来源"实质未满足——≥0.5 时什么都不显示。
- [x] T10: 证据区按收集→执行→验证分组
  - 2026-09-02 复核确认：`src/modules/ai/lib/evidence.ts:73-129` + `AiChat.tsx:371-390` 渲染 + `evidence.test.ts` 17 例。**同轮已修的遗留**：TS 的 VERIFY 清单曾缺 `suggest_command`（Python `registry.py:305-315` 有）且被 `evidence.test.ts` 固化成期望——现补齐 9 项并新增"清单钉死"测试（错误示例改用 `skill_invoke`）。**刻意保留的非对称**（已在代码注释成文）：Python 对 `ssh_command` 按命令内容细分只读/写（`adapter.py:258-287`），前端只有 `tool_name` 可依据，故同一工具两侧归组可以不同。详 DEV-JOURNAL §37.105。
- [x] P2 门禁：全量 pytest/vitest/tsc/lint/build 全绿
  - 2026-09-02 实测：pytest（sidecar 全量）**2068 passed / 1 xfailed**（679.6s）/ tsc 0 / lint 0 / vitest 1274 passed + 1 负载抖动（`sidecar-adapter.test.ts` 单跑 16/16，本轮不碰 TS，判非回归）/ `pnpm build:web` ✓。注：本轮未跑 `pnpm tauri:dev` 桌面实测（P2 无 UI 改动），该项仍挂在"用户桌面实测验收"。
  - 2026-09-02 #44 修复轮复测：pytest（sidecar 全量）**2073 passed / 0 xfailed**（596.7s，exit 0）= 上轮 2069 条 + 新增 4 条真实事件形状用例，**xfail 清零、既有用例零被动过**；本轮无前端改动。
- [ ] 用户桌面实测验收（P0/P1/P2 各一轮）
