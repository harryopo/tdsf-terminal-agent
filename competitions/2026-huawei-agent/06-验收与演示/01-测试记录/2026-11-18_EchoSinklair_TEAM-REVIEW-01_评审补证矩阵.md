# TEAM-REVIEW-01 评审补证矩阵（测试设计，未执行）

| 字段 | 内容 |
|---|---|
| 负责人 | EchoSinklair |
| 日期 | 2026-11-18 |
| 任务 | TEAM-REVIEW-01 首轮审查评审响应 |
| 评审来源 | PR #56 `harryopo` CHANGES_REQUESTED（2026-11-17） |
| 关联报告 | `docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md` |
| 关联 Issue | Issue #55 完整回归包（后续主 PR 选择） |
| 证据ID | `TR01-M1` |
| 状态 | 测试设计/补证矩阵；**未执行**项标 RED/未测，交 ROOT，不补造 |

## 1. 边界

- 本文件只列补证设计与矩阵，不声称已执行、不声称测试通过。
- 未连接真实 SSH、未调用付费模型、未运行 Tauri 桌面端。
- 不修改产品源码、依赖、审批策略；生产风险/脱敏/审批/信任修复由 ROOT 负责。
- 允许保留 RED 交 ROOT；不降断言凑绿。

## 2. D8 可控时序反例

| 场景 | 触发方式 | 预期不变量 | 当前源码事实 | 状态 |
|---|---|---|---|---|
| 批准后立即取消 | 审批返回 APPROVED 后、派发前触发 cancel | 不再派发该命令 | `request_approval_and_wait` 返回后直接进入 host 校验/派发，未再检查取消 | 未执行；源码可证明风险，RED 交 ROOT |
| watchdog 超时与 worker 完成同刻 | 让 worker 在 watchdog 超时瞬间完成 | 迟到结果不冒泡、不重复写回 | watchdog 超时不取 outcome（源码）；前端按 `rpc_request_id`/session 过滤 | 需时序反例；未执行 |
| 审批超时与取消唤醒竞争 | 审批 300s 超时与 session cancel 同时发生 | fail-closed，且不重复结算 | `needs_you` 超时按拒绝；取消唤醒队列 waiter（源码） | 需并发测试；未执行 |
| 迟到工具卡事件 | 取消后模拟旧流事件到达前端 | 旧事件不写入新会话/新流 | `belongsToInvocation` 校验 session 与 `rpc_request_id`（源码） | 需乱序事件测试；未执行 |

## 3. D9 路径/误报矩阵

| 路径 | 类型 | 当前分级事实 | 预期 | 误报风险 | 状态 |
|---|---|---|---|---|---|
| `~/.ssh/id_rsa` | 凭据 | L3（名单已覆盖） | 审批 | 低 | 源码/用例可证 |
| `/etc/shadow` | 凭据 | L3（名单已覆盖） | 审批 | 低 | 源码/用例可证 |
| `~/.bash_history` | 凭据 | L3（离线已验证） | 审批 | 低 | 已验证 |
| `.env` | 项目配置/可能含密钥 | L0（离线已验证） | 待定：是否提级 | 中 | 待矩阵确认 |
| `.env.example` | 非敏感模板 | 预期不扩 | 不误报 | 高（若整目录通配） | 对照组 |
| `credentials.json` | 凭据 | 未覆盖 | 待定 | 中 | 未执行 |
| `.netrc` | 凭据 | 未覆盖 | 待定 | 中 | 未执行 |
| `.pypirc` | 凭据 | 未覆盖 | 待定 | 中 | 未执行 |
| `.docker/config.json` | 凭据 | 未覆盖 | 待定 | 中 | 未执行 |
| `kubeconfig` | 凭据 | 未覆盖 | 待定 | 中 | 未执行 |

说明：先做矩阵再决定是否扩名单；不以集合差异直接改产品名单，避免误报。

## 4. D10 防回归检查

| 检查项 | 预期 | 当前事实 | 状态 |
|---|---|---|---|
| `skill_invoke` 只读参考 | 不执行 executor/shell/python/http | 调用 `registry.get_reference`（源码可证） | 当前安全 |
| `save_skill` 用户数据 | 不擅自剥离用户 SKILL 数据 | 只写用户技能目录，slug 校验；不剥离 | 保留现状 |
| executor 未来路径 | 必须接 `assess_command`/`decide` + 审批链 | 当前生产不使用 `registry.invoke` | 防回归项，Issue #55 |
| 防回归测试/注释 | 钉住“只参考不执行” | 待补 | 未执行 |

## 5. D5 持久化/导出验证计划

| 验证项 | 方法 | 状态 |
|---|---|---|
| 实时 stdout/stderr 是否进入前端持久化 | 检查 chatStore/IndexedDB 与导出路径 | 未执行 |
| 实时回显渲染是否脱敏 | 检查 `tool.tsx`/`sshCommandOutputStore` 渲染链 | 源码可证未过 `redactSensitive` |
| 导出/复制是否带原文 | 导出会话记录并检查 | 未执行 |

结论：D5 的“工具卡原文路径”可由源码确认；持久化/导出影响仍未验证，不据此断言已发生落盘泄露。

## 6. D11 分层事实

- Agent 执行链使用 `command_impact.analyze` + `RiskChecker` + `modes.decide`。
- YAML `RiskEngine` 只服务前端 `risk.evaluate`，不是执行链门禁。
- 保留该分层事实，避免把 YAML 规则误当执行链保护。

## 7. 后续

- 本矩阵随 PR #56 提交，保留首轮历史；不另开每条修订 PR。
- 后续接续 Issue #55 完整回归包；若已有 #55 独立分支则保留并给链接，选择一个后续主 PR。
- 未执行项由授权测试/fixtures/既有辅助器范围补真实缺口；RED 交 ROOT。
