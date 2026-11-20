# TEAM-REVIEW-01 首轮离线测试记录

| 字段 | 内容 |
|---|---|
| 工作包 / 负责人 / Draft PR | TEAM-REVIEW-01 / EchoSinklair / #56 |
| 起始SHA / 当前HEAD / 最近同步主线 | 产品基线 `210c7874951ddd2ca4572401225ed7decc7a5966`；共享分支 HEAD `81e7793f8471a5d843a198bdda2cc1572782b7af` |
| 完成的用户路径/改动文件 | 只读审查；未改产品源码；新增 `docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md` |
| 验证命令、版本、退出码、唯一用例数 | Python 3.12.8；pytest 9.2.0；原报告两批 438 passed；本轮新增 21 项（13 xfail + 8 正向），文件级 121 项：108 passed、13 xfailed；exit 0 |
| 原生截图/码道记录/原始输出的证据ID | `TR01-T1`；本轮无原生桌面/SSH 截图；原始输出保存在本地，未提交 |
| 失败、环境受阻、旧缺陷与新增缺陷 | 未运行 pnpm/cargo（本机无工具链）；未连接真实 SSH/模型；无失败用例 |
| 后续步骤 / 文件冲突 / 待决定 | 接续 Issue #55 完整回归包；产品修复由 ROOT 负责；等待队长与 ROOT 验收 |
| 评审状态 | PR #56 于 2026-11-17 收到 CHANGES_REQUESTED；438 项为原报告结果，不重复计 ROOT 新验收；2026-11-18 新增补证矩阵（设计/未执行）与 D1/D6/D7/D9 反例 21 项（13 xfail，RED 交 ROOT） |
| 是否整包就绪 | 未就绪 / 待队长与 ROOT 验收；不预填已合并 |

## 环境

- Windows 11；PowerShell。
- Python 3.12.8（本机可用的 CodeArts 内置解释器；项目要求 `>=3.11`）。
- pytest 9.2.0（安装到临时 target 目录，未改动项目依赖或系统环境）。
- 未安装项目全量依赖（`strands`、`chromadb` 等）；本记录中的定向用例不依赖这些包。
- 本机无 `node`、`pnpm`、`cargo`、`rustc`，未运行前端与 Rust 测试。

## 命令与结果

| 批次 | 测试目标 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `test_command_impact.py`、`test_modes.py`、`test_risk_engine.py`、`test_risk_engine_p5.py`、`test_redact.py`、`test_redact_single_owner.py` | 252 passed | 0 |
| 2 | `test_approval_policy_precedence.py`、`test_approval_budget_ordering.py`、`test_agent_log_privacy.py`、`test_command_log_privacy.py`、`test_diagnostic_privacy_integration.py`、`test_remote_read_approval.py` | 186 passed | 0 |
| 3 | 新增反例与正向控制：D1/D6/D7/D9（`test_command_impact.py`、`test_agent_log_privacy.py`、`test_audit_reason_redaction.py`、`test_credential_path_single_owner.py`） | 108 passed、13 xfailed（121 collected） | 0 |

合计 438 passed。pytest 提示 `pyproject.toml` 的 `asyncio_mode` 未被识别（临时环境未安装 `pytest-asyncio`），不影响上述同步用例。

## 边界与未测

- 前端 Vitest、Rust `cargo test`、Tauri 桌面端到端未运行：本机无对应工具链。
- 未连接真实 SSH 服务器，未调用付费模型。
- 离线用例通过只说明这些用例覆盖的路径当前通过，不代表产品安全全绿；未测项见报告 D1-D11 的“未验证”行。
- 未新增产品测试文件；产品修复由 ROOT 负责；后续只在授权测试/fixtures/既有辅助器范围补真实缺口。
- 未降断言凑绿；允许保留 RED 交 ROOT。

## 证据关联

- 报告：`docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md`
- 更新说明：`docs/updates/2026-11-18-TEAM-REVIEW-01-离线回归补证.md`
- 补证矩阵：`competitions/2026-huawei-agent/06-验收与演示/01-测试记录/2026-11-18_EchoSinklair_TEAM-REVIEW-01_评审补证矩阵.md`（设计/未执行，RED 交 ROOT）
- 覆盖表：`competitions/2026-huawei-agent/06-验收与演示/01-测试记录/2026-11-18_EchoSinklair_TEAM-REVIEW-01_覆盖表.md`
- 链路图：`competitions/2026-huawei-agent/05-作品材料/03-架构与图表/EchoSinklair/2026-11-18_EchoSinklair_TEAM-REVIEW-01_Agent链路图.md`
- 演示步骤：`competitions/2026-huawei-agent/06-验收与演示/02-演示脚本/2026-11-18_EchoSinklair_TEAM-REVIEW-01_离线演示步骤.md`
- 该报告的 D1-D11 含代码位置、影响、证据、建议与未测部分。
