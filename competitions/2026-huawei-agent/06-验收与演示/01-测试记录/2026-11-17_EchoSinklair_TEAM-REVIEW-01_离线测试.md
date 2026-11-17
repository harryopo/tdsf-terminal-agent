# TEAM-REVIEW-01 首轮离线测试记录

| 字段 | 内容 |
|---|---|
| 工作包 / 负责人 / Draft PR | TEAM-REVIEW-01 / EchoSinklair / #56 |
| 起始SHA / 当前HEAD / 最近同步主线 | 产品基线 `210c7874951ddd2ca4572401225ed7decc7a5966`；审查分支 HEAD `06ed9e530c5370d08989f65d3d7d3890ad19b040` |
| 完成的用户路径/改动文件 | 只读审查；未改产品源码；新增 `docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md` |
| 验证命令、版本、退出码、唯一用例数 | Python 3.12.8；pytest 9.2.0；两批共 438 passed；exit 0 |
| 原生截图/码道记录/原始输出的证据ID | `TR01-T1`；本轮无原生桌面/SSH 截图；原始输出保存在本地，未提交 |
| 失败、环境受阻、旧缺陷与新增缺陷 | 未运行 pnpm/cargo（本机无工具链）；未连接真实 SSH/模型；无失败用例 |
| 后续步骤 / 文件冲突 / 待决定 | 产品修复另分配；等待队长与 ROOT 验收 |
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

合计 438 passed。pytest 提示 `pyproject.toml` 的 `asyncio_mode` 未被识别（临时环境未安装 `pytest-asyncio`），不影响上述同步用例。

## 边界与未测

- 前端 Vitest、Rust `cargo test`、Tauri 桌面端到端未运行：本机无对应工具链。
- 未连接真实 SSH 服务器，未调用付费模型。
- 离线用例通过只说明这些用例覆盖的路径当前通过，不代表产品安全全绿；未测项见报告 D1-D11 的“未验证”行。
- 未新增产品测试文件；D1/D2/D6 等产品修复另分配。

## 证据关联

- 报告：`docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md`
- 该报告的 D1-D11 含代码位置、影响、证据、建议与未测部分。