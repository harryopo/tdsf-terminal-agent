# TEAM-REVIEW-01 覆盖表（生产入口 → 已有测试 → 缺口）

| 字段 | 内容 |
|---|---|
| 负责人 | EchoSinklair |
| 日期 | 2026-11-18 |
| 产品基线 | `210c7874951ddd2ca4572401225ed7decc7a5966` |
| 共享分支 HEAD | `81e7793f8471a5d843a198bdda2cc1572782b7af` |
| 关联 PR | #56 |
| 证据ID | `TR01-M2` |

## 覆盖矩阵

| 场景 | 生产入口 | 已有测试 | 本轮证据 | 状态 |
|---|---|---|---|---|
| 工具注册/schema | `agent_facade`、`tools/registry` | `test_agent_facade.py`、`test_prompt_tool_parity.py` | 未新增 | 主路径可读；D3 仅观察 |
| 命令风险分类 | `assess_command`、`command_impact.analyze` | `test_command_impact.py`、`test_risk_engine*.py`、`test_modes.py` | D1 新增 5 反例 + 5 正向 | D1 RED；正向通过 |
| 审批/超时 | `needs_you`、`request_approval_and_wait` | `test_needs_you.py`、`test_approval_budget_ordering.py` | 未新增 | 主路径通过；D8 未执行 |
| 取消/队列 | `request_cancel`、`cancel_entry` | `test_agent_cancel.py`、`test_agent_queue_cancel.py`、`test_cancel_entry.py` | 未新增 | 取消主路径覆盖；D8 竞态待屏障 |
| 迟到/归属 | `rpc_request_context`、stream identity | `test_rpc_stream_identity.py`、`test_human_wait_watchdog.py` | 未新增 | 已有身份/迟到过滤；D4 待多会话验证 |
| 多主机归属 | `execute_via_ssh` host 校验 | `test_approval_call_identity.py` | 未新增 | D4 设计边界，未实测 |
| 日志脱敏 | `agent_log`、`diagnostics` | `test_agent_log_privacy.py`、`test_command_log_privacy.py` | D6 新增 2 反例 + 1 正向 | D6 RED；正向通过 |
| 审计附言 | `audit_chain._audit_append` | `test_command_log_privacy.py` | D7 新增 1 反例 + 1 正向 | D7 RED；command 正向通过 |
| 凭据路径 | `command_impact`、`_credential_paths` | `test_credential_path_single_owner.py`、`test_remote_read_approval.py` | D9 新增 5 反例 + 1 正向 | D9 RED；`.env.example` 不误报 |
| Skill 参考 | `skill_invoke`、`skills/registry` | `test_skill_registry.py` | 未新增 | 当前参考不执行；D10 防回归 |
| 风险分层 | `command_impact` vs `RiskEngine` | `test_risk_engine.py` | 未新增 | D11 事实保留 |
| 前端实时回显 | `sshCommandOutputStore`、`tool.tsx` | 无 Python 用例 | 未新增 | D5 源码可证，持久化未测 |
| 真实 SDK/回放 | `test_e2e_strands`、`replay` | 依赖 strands | 未运行 | 环境阻断；不冒称真实 SSH |

## 本轮新增与结果

- 新增 21 项：13 项 `xfail(strict=True)`、8 项正向控制通过。
- 文件级运行 121 项：108 passed、13 xfailed、exit 0。
- 438 项为原报告结果，不重复累计。

## 缺口与归属

| 缺口 | 归属 |
|---|---|
| D1 参数级写操作误分 L0 | ROOT 修复分类；本分支保留 RED |
| D6/D7 日志与审计副本脱敏 | ROOT 修复脱敏；本分支保留 RED |
| D9 凭据路径矩阵 | ROOT 决定是否扩名单；先矩阵不直接通配 |
| D8 批准/派发竞态 | 需授权测试/可控屏障；Issue #55 |
| D5 持久化/导出 | 需桌面端实测；Issue #55 |
| D4 多主机目标来源/回退 | 产品策略待定；Issue #55 |

## 边界

- 离线测试不证明真实 SSH/模型/Tauri 通过。
- 未改生产 registry/风险分类/审批/脱敏实现。
- 不降断言、不改期望凑绿；RED 交 ROOT。