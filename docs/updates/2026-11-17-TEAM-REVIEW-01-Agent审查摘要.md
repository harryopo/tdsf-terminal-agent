# TEAM-REVIEW-01：Agent 安全与稳定性审查摘要

日期：2026-11-17。任务编号：TEAM-REVIEW-01。负责人：EchoSinklair。
状态：首轮审查完成，待队长与 ROOT 评审；本文不是产品修复、模型接入或真实环境验收记录。

## 1. 基线与范围

| 项 | 内容 |
|---|---|
| 目标仓库 | `harryopo/tdsf-terminal-agent` |
| 审查分支 | `codex/2026-11-13-root-shared-review` |
| 指定产品基线 | `210c7874951ddd2ca4572401225ed7decc7a5966` |
| 实际 clone HEAD | `4ae3ae1792d3d1f03e5d387d597c72439365d0a3` |
| 基线关系 | `210c787` 是 HEAD 的祖先（`git merge-base --is-ancestor` 退出码 0） |
| 基线后差异 | 仅 `.gitignore`、`AGENTS.md`、`competitions/**`、`docs/**` 等治理与材料文档；未修改 `src/`、`src-tauri/` 产品源码 |

因此本报告的行号对应 HEAD 工作树；产品源码事实与 `210c787` 相同。未把后续文档提交当成产品改动，也未把旧 main 或本地未提交内容当成本次基线。

沿当前生产入口审查，覆盖：

- 前端：`src/modules/ai/lib/sidecar-adapter.ts`、`src/modules/ai/store/`、`src/modules/terminal/`、工具卡 `src/components/ai-elements/tool.tsx`。
- 门面与适配层：`src-tauri/sidecar/agent_facade.py`、`src-tauri/sidecar/strands_backend/adapter.py`。
- 工具与执行链：`src-tauri/sidecar/strands_backend/tools/`（注册表、`execute_via_ssh`、各工具）、`src-tauri/sidecar/tools/risk.py`、`src-tauri/sidecar/core/risk_engine.py`。
- Rust 执行与回显：`src-tauri/src/modules/ssh/mod.rs`、`src-tauri/src/modules/sidecar.rs`。
- 审批、证据、日志：`needs_you.py`、`evidence.py`、`audit_chain.py`、`agent_log.py`、`diagnostics.py`、`tools/_redact.py`。

不在本轮范围：真实 SSH 服务器、真实付费模型、Tauri 桌面端到端、安装包、macOS/Linux 实机、删除或修改产品策略。

## 2. 验证环境与结果

| 项 | 内容 |
|---|---|
| 系统 | Windows（PowerShell 宿主） |
| Python | 3.12.8（本机可用的 CodeArts 内置解释器；项目要求 `>=3.11`） |
| pytest | 9.2.0（安装到临时 target 目录，未改动项目依赖或系统环境） |
| 网络 | 仅用于获取仓库与下载临时测试工具；未连接任何真实服务器，未调用付费模型 |
| 前端/Rust | 本机无 `node`、`pnpm`、`cargo`、`rustc`，未运行前端与 Rust 测试；这是环境阻断，不是通过 |

运行结果（均为离线、合成输入）：

| 批次 | 命令目标 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `tests/test_command_impact.py`、`tests/test_modes.py`、`tests/test_risk_engine.py`、`tests/test_risk_engine_p5.py`、`strands_backend/tests/test_redact.py`、`strands_backend/tests/test_redact_single_owner.py` | 252 passed | 0 |
| 2 | `tests/test_approval_policy_precedence.py`、`tests/test_approval_budget_ordering.py`、`strands_backend/tests/test_agent_log_privacy.py`、`strands_backend/tests/test_command_log_privacy.py`、`strands_backend/tests/test_diagnostic_privacy_integration.py`、`tests/test_remote_read_approval.py` | 186 passed | 0 |

合计 438 passed。pytest 提示 `pyproject.toml` 中的 `asyncio_mode` 未被识别（临时环境未安装 `pytest-asyncio`），不影响上述同步用例；该警告不作为任何通过结论。

离线分级/脱敏验证使用三个本地脚本（不提交、不含真实凭据）：`verify_risk.py`、`verify_risk2.py`、`verify_redact.py`。它们只调用纯函数 `command_impact.analyze`、`modes.decide`、`diagnostics.sanitize_diagnostic`、`redact_sensitive`，不执行 shell、不读取真实文件。

## 3. 发现汇总

状态口径：可复现缺陷 / 源码可证明 / 待验证推测 / 环境或依赖阻断 / 本次未覆盖。优先级按实际影响，不按数量。

| 编号 | 主题 | 状态 | 优先级 | 摘要 |
|---|---|---|---|---|
| D1 | 只读白名单未按参数区分 | 可复现缺陷 | 高 | `date -s`、`hostname`、`dmesg -C`、`journalctl --vacuum-*`、`ss -K` 被判 L0，confirm/auto 免审批 |
| D2 | auto 模式关键系统写入仍为 L2 | 源码可证明 | 高 | `sed -i /etc/ssh/sshd_config`、`mv ... /etc/passwd` 在 auto 免审批；关键路径分级不完整 |
| D3 | 注册显示名与真实工具名不一致 | 源码可证明 | 中 | `agent.info` 的 4 个工具名与 `TOOL_REGISTRY` 实际名不一致 |
| D4 | 后台通道终端归属放宽 | 源码可证明 | 中 | 任意 connected SSH 会话可被后台执行；auto 无审批；可见终端有 gate，后台通道无对应 gate |
| D5 | 实时 SSH 回显未脱敏 | 源码可证明 | 中低 | Rust 原始 chunk 进入前端 store 并直接渲染，未过 `redactSensitive`；最终结果已脱敏 |
| D6 | 日志脱敏覆盖不全 | 可复现缺陷 | 中 | `mysql -p<密码>` 在 `agent_log` 明文；`sshpass -p <密码>` 在日志/审计链均未脱敏 |
| D7 | 审批描述/审计副本脱敏不完整 | 源码可证明 | 低 | 审批 description 保留命令原文；`_audit_append` 只脱敏 command，reason 未脱敏 |
| D8 | 取消/超时与批准竞态 | 待验证推测/已声明边界 | 低 | watchdog 不杀 worker；批准后未再检查取消；文案已声明已派发命令不可撤销 |
| D9 | 凭据路径名单覆盖不足 | 源码可证明 | 中低 | `.env`、`credentials.json`、`.netrc`、`.pypirc`、`.docker/config.json` 等不在名单；`cat .env` 判 L0 |
| D10 | skill 持久化与 executor 防回归 | 当前安全/防回归 | 观察 | `skill_invoke` 当前只用 `get_reference`，不执行 executor；`save_skill` 无审批写技能目录 |
| D11 | RiskEngine 与执行链判据分离 | 架构观察 | 观察 | 执行链用 `command_impact`，YAML RiskEngine 只服务前端 `risk.evaluate`；不能把 YAML 当执行链门禁 |

## 4. 发现详情

### D1 只读白名单未按参数区分（高，可复现缺陷）

- 位置：`src-tauri/sidecar/strands_backend/tools/command_impact.py:343-363`（`_READONLY_CMDS`）、`:663-704`（`_readonly_veto_hit` 只覆盖 `env/find/awk/sort/tar/gzip/uniq/cut`）。
- 预期：命令名只读不代表带写参数仍只读；有写副作用的调用至少 L2/L3，在 confirm 模式逐条审批。
- 实际：以下命令被分类为 `readonly`、`risk_l=0`，`decide` 在 confirm 与 auto 都返回 `allow`：
  - `date -s '...'`（修改系统时间）
  - `hostname <name>`（修改主机名）
  - `dmesg -C`（清空内核环缓冲）
  - `journalctl --vacuum-time=...`（删除系统日志）
  - `ss -K ...`（强制关闭套接字/连接）
- 影响：默认 confirm 模式下，Agent 无需审批即可执行上述写操作；实际生效取决于远端账号权限（root 或具备 CAP_SYS_TIME/CAP_SYS_ADMIN 时直接生效）。`observe` 仍为 deny，`declared denylist` 不覆盖这些命令。
- 证据：离线脚本输出 `category=readonly, max_risk_l=0, decisions={confirm:allow, auto:allow}`；现有 `test_command_impact.py` 的 252 项用例未覆盖这些参数组合。
- 建议：为上述命令增加参数级 veto（只允许明确查询形式），或将其移出 `_READONLY_CMDS`，按 unknown L3 fail-closed；补最小反例测试（成功/拒绝两条路径都要有）。
- 未验证：真实 SSH root 环境下的实际系统影响；不同发行版 `dmesg`/`journalctl`/`ss` 参数差异。

### D2 auto 模式关键系统写入仍为 L2（高，源码可证明）

- 位置：`src-tauri/sidecar/strands_backend/modes.py:99-110`（auto：L0-L2 allow）；`command_impact.py:635-637`（只读命令带重定向才抬 file_write）、`:492-540`（对象提取不看系统关键路径）；`_credential_paths.py:19-37`（仅少数路径抬级）。
- 预期：修改 SSH 配置、账户/认证文件、系统启动路径等关键写入，至少 L3 或独立审批，即使 auto 模式。
- 实际（离线分级）：
  - `sed -i '...' /etc/ssh/sshd_config` → `config` L2，auto `allow`。
  - `mv /tmp/x /etc/passwd` → `file_write` L2，auto `allow`。
  - `cp /tmp/x /etc/sudoers` → 因 `/etc/sudoers` 命中凭据名单抬到 L3，auto `confirm`；说明名单机制有效，但覆盖不完整。
- 影响：auto 模式下无需审批即可修改 SSH 服务配置或覆盖账户文件；这与“写操作需审批”的安全预期冲突，属于产品策略边界，不是静默绕过 denylist。用户在 auto 下应知道 L2 包含这些写入。
- 证据：离线脚本输出（见上）；`_credential_paths` 的命中抬级逻辑可反证“关键路径应分级”的可行性。
- 建议：增加关键路径分级（`/etc`、`/boot`、`/usr`、`/bin`、`/sbin`、`/lib`、`/var/lib` 等，或至少 `/etc/passwd`、`/etc/group`、`/etc/ssh/**`、`/etc/sudoers.d/**`）；在 auto 下对 `config`/`file_write` 命中关键路径仍要求审批。是否调整 auto 的产品定义需队长与 ROOT 决定，本报告不擅自改策略。
- 未验证：真实 auto 模式的用户预期；不同命令的目标路径提取准确性；误报对只读排查的影响。

### D3 注册显示名与真实工具名不一致（中，源码可证明）

- 位置：`src-tauri/sidecar/strands_backend/tools/registry.py:394-399`（`OPS_TOOL_ALIASES`）；`src-tauri/sidecar/strands_backend/tools/__init__.py:2115-2117`（`OPS_TOOL_NAMES`）；`src-tauri/sidecar/agent_facade.py:157-159`（`agent.info` 使用 `OPS_TOOL_NAMES`）。
- 预期：`agent.info` 暴露的工具名与实际注册到 Strands 的 `@tool` 名一致，便于诊断、前端映射和能力核对。
- 实际：4 个显示名与注册名不一致：
  - `remote_file` ↔ `read_remote_file`
  - `log_analyzer` ↔ `analyze_logs`
  - `process_inspector` ↔ `inspect_processes`
  - `network_diagnostic` ↔ `network_diagnose`
  - 离线核对：`registry_count=25`、`ops_count=25`，`only_registry` 与 `only_ops` 各 4 个。
- 影响：`agent.info`/工具目录展示与实际 schema 名不一致，前端按显示名做映射或诊断时可能错配；不影响实际执行（`make_all_ops_tools` 用 `spec.name`）。
- 证据：离线脚本输出；`registry.py` 注释也承认“注册显示名与 `@tool` 函数名不同”。
- 建议：`agent.info` 返回真实注册名，或统一别名映射并在展示/过滤/诊断处只消费一个真源；补一条“显示名集合 == 注册名集合”的静态测试。
- 未验证：前端是否存在按 `OPS_TOOL_NAMES` 匹配图标/分类的逻辑（需检索前端）。

### D4 后台通道终端归属放宽（中，源码可证明）

- 位置：`src-tauri/sidecar/strands_backend/tools/__init__.py:1374-1436`（目标只需是 Rust `SshState` 中 `connected` 的会话）、`:1538-1646`（`background` 通道直接 `ipc_invoke("ssh_command")`）；前端 `src/modules/ai/lib/visibleTerminalGate.ts:73-104` 只保护可见终端通道。
- 预期：执行目标应与当前对话/当前终端绑定；跨服务器执行至少需要显式选择或审批。
- 实际：只要 `ssh_session_id` 在 `ssh_status` 的 live 列表中 `connected` 就放行，不再要求等于 `ctx.ssh_session_id`（`ctx.ssh_host` 为空时旧严格校验也会跳过）。visible-terminal 通道有前端 `currentSessionId === requestedSessionId` gate；background 通道没有对应的归属 gate。auto 模式 L0-L2 无需审批。
- 影响：Agent 可以向用户当前没在看的另一台已连接服务器执行命令；审批卡带 `ssh_session_id`、结果带 `target_endpoint`，但 auto 无卡，用户可能误以为只作用于当前终端。这是多主机运维特性与“终端归属”要求之间的边界。
- 证据：源码；`test_approval_call_identity.py` 验证审批请求携带调用身份，但不验证 background 的归属范围。
- 建议：background 通道也校验目标是否属于当前对话绑定的服务器（或当前 active 会话），或要求用户显式开启多主机执行；UI/结果显著展示 `target_endpoint`；为“目标不等于当前终端”补拒绝/允许两条路径测试。
- 未验证：真实多会话 UI 行为；产品对多主机后台执行的定义。

### D5 实时 SSH 回显未脱敏（中低，源码可证明）

- 位置：`src-tauri/src/modules/ssh/mod.rs:1048-1133`（每个原生 chunk 原样 `emit`）；`src/modules/ai/store/sshCommandOutputStore.ts:61-121`（原样累积 stdout/stderr）；`src/components/ai-elements/tool.tsx:595-639`（直接渲染 `live.stdout`/`live.stderr`）。
- 预期：进入 UI/可持久化区域的输出应至少与应用最终结果同等脱敏。
- 实际：Python 最终结果在 `execute_via_ssh` 内经过 `redact_sensitive`（`tools/__init__.py:1786-1792`），但 Rust 实时事件先到达前端并被 store 保存；实时渲染函数未调用 `redactSensitive`。
- 影响：命令输出中的密码/密钥会在“实时回显”阶段原样出现，并可能留在前端内存或随会话记录导出；完成后切换到已脱敏的最终结果，但实时阶段已暴露。
- 证据：源码；未运行真实 SSH 生成含敏感串的输出。
- 建议：在 store 层累积后脱敏再渲染，或在 Rust emit 前缓冲脱敏；注意流式分段可能切断 token，不能只对单个 chunk 做正则。
- 未验证：前端会话持久化是否保存 live 输出；真实输出样本与脱敏覆盖率。

### D6 日志脱敏覆盖不全（中，可复现缺陷）

- 位置：`src-tauri/sidecar/strands_backend/diagnostics.py:74-84`（`sanitize_diagnostic` 的规则集）；`src-tauri/sidecar/strands_backend/tools/__init__.py:1997-2017`（`redact_sensitive` 含 `-p` 规则）；`agent_log.py:152-175`、`:318-363`（会话流水使用 `sanitize_diagnostic`）；`audit_chain.py` 由 `_audit_append` 先脱敏。
- 预期：命令参数中的密码不进入会话日志/审计链。
- 实际（离线对比）：
  - `mysql -uroot -pS3cretPw`：`sanitize_diagnostic` 原样返回（agent_log 明文）；`redact_sensitive` 返回 `-p***`（审计链会脱敏）。
  - `sshpass -p Hunter2 ssh ...`：`sanitize_diagnostic`、`redact_sensitive_text`、`redact_sensitive` 均未脱敏（三种通路都可能明文）。
  - `DB_PASSWORD=hunter2`、PEM 私钥块、`Authorization` 可正确脱敏，说明缺口集中在“短选项密码”形式。
- 影响：本地会话流水（默认开启、落盘 JSONL）可能明文保存数据库/SSH 密码；审计链对 `mysql -p...` 可脱敏，但对 `sshpass -p <值>` 仍会明文。
- 证据：离线脱敏对比输出；`test_agent_log_privacy.py`/`test_command_log_privacy.py` 的 186 项通过用例未覆盖这两种形式。
- 建议：统一脱敏入口，让 `sanitize_diagnostic` 也消费 `redact_sensitive` 的规则（或至少增加 `-p`/`--password`/`sshpass -p` 形式）；补反例测试，覆盖“空格值”和“紧贴值”两种写法。
- 未验证：真实日志文件内容（未生成敏感样本）；不同 shell 工具的密码参数形式。

### D7 审批描述/审计副本脱敏不完整（低，源码可证明）

- 位置：`tools/__init__.py:834-846`（description 含 `command[:200]`）；`:1942-1948`（`_audit_append` 只把 `command` 过 `redact_sensitive`）；`needs_you.py:344-378`（`command` 原文作为审批卡第 2 层设计保留）；`agent_log.py:329-338`（needs_you description 落盘）。
- 预期：UI 审批卡可以保留命令原文供用户判断；但事件副本、审计 reason、落盘日志应脱敏。
- 实际：审批 description 保留命令原文；审计链的 `reason`（用户拒绝附言）未脱敏；needs_you 事件副本进入 agent_log 时只过 `sanitize_diagnostic`（见 D6 缺口）。
- 影响：命令或用户附言中的凭据可能进入日志/审计副本；UI 展示本身是产品需要，但副本应最小化。
- 证据：源码路径。
- 建议：事件/审计/落盘副本统一脱敏，UI 展示层按需保留原文；`_audit_append` 对 `reason`、`message` 也应用脱敏。
- 未验证：审计链实际落盘内容。

### D8 取消/超时与批准竞态（低，待验证推测/已声明边界）

- 位置：`adapter.py:1984-2043`（watchdog 轮询）、`:2456-2491`（超时只调用 `request_cancel`，不取迟到结果）、`:2951-2992`（按 session 置取消、结掉待答请求）；`tools/__init__.py:1232-1281`（审批返回 APPROVED 后直接进入 host 校验/派发，未再检查本轮取消）。
- 预期：用户停止后不再派发新工具调用；已派发命令如无法撤销，应保留未知状态并如实告知。
- 实际：`request_cancel` 会设置取消事件、熔断后续工具、取消挂起的审批；但 watchdog 不杀 worker，已派发命令继续运行。审批返回 APPROVED 后、派发前没有再次检查取消，存在“批准瞬间取消仍执行”的窄竞态。产品文案已明确“正在执行的命令不会自动撤销”。
- 影响：用户停止后可能仍发生一次已批准执行；不是静默重放，也不是成功伪报。现有 `cancelled`/`indeterminate` 状态区分较好。
- 证据：源码；现有 `test_agent_cancel.py`、`test_cancel_entry.py` 覆盖取消主路径，但未覆盖“批准与取消同刻”的竞态。
- 建议：审批返回后、派发前检查本轮 cancellation token；为竞态补可控测试；在 UI 再次明确已派发命令不可撤销。
- 未验证：真实并发时序；worker 自然结束与 stalled 标记的窗口。

### D9 凭据路径名单覆盖不足（中低，源码可证明）

- 位置：`src-tauri/sidecar/strands_backend/tools/_credential_paths.py:19-37`。
- 预期：常见凭据文件读取至少 L3，confirm/auto 都逐条审批。
- 实际：名单覆盖 `.ssh`、`id_*`、`.aws`、`.gnupg`、`/etc/shadow`、`/etc/sudoers`、`.npmrc`、history 等；未覆盖 `.env`、`.env.*`、`credentials.json`、`.netrc`、`.pypirc`、`.docker/config.json`、`kubeconfig`。离线分级：`cat .env` → readonly L0，confirm/auto `allow`；`cat ~/.bash_history` → credential L3。
- 影响：confirm 模式可免审批读取项目 `.env`（常含 API key）；输出脱敏只覆盖已知 key 形状，不能保证完整保密。
- 证据：源码 + 离线分级输出；`python_risk.py:171-180` 已对凭据路径抬到 L3，说明同一名单被两条通道共享，扩充可同时受益。
- 建议：扩充名单（优先 `.env*`、`credentials*`、`.netrc`、`.pypirc`、`.docker/config.json`、`kubeconfig`）；注意 `.env.example` 这类非敏感文件，按文件名精确匹配而非整目录通配；补读取/写入两条审批路径测试。
- 未验证：真实 `.env` 内容与脱敏覆盖；误报对正常配置查看的影响。

### D10 skill 持久化与 executor 防回归（观察，当前安全）

- 位置：`skill_invoke.py:190`（调用 `registry.get_reference`）；`skills/registry.py:319-360`（`get_reference` 明确不执行 executor）；`session_memory_tool.py:19-41`、`session_memory.py:256-336`（`save_skill` 写 `~/.tdsf/skills/<name>/SKILL.md`，slug 校验 `^[a-z0-9][a-z0-9-]{1,48}$`，无审批）；`registry.py:174-182`（`skill_invoke` policy：readonly=False、needs_approval=False）。
- 预期：参考类工具不执行 executor；持久化技能不能形成“无审批写入 + 后续执行”的链。
- 实际：当前生产 `skill_invoke` 只用 `get_reference`，只返回内容/剧本/executor 元数据，不执行 shell/python/http；`save_skill` 只写用户技能目录，name 有 slug 校验，无路径穿越。故当前没有可执行面。
- 影响：若未来把 `skill_invoke` 切回 `registry.invoke`，或在 `save_skill` 写入的 SKILL.md 中启用 executor，将形成“模型可无审批持久化脚本 + 后续执行”的回归风险。
- 证据：源码；`skill_invoke.py` 动态 docstring 明确“本工具绝不执行 shell/python/http”。
- 建议：在 `save_skill` 中剥离/拒绝 executor frontmatter；用测试钉住 `skill_invoke` 只调用 `get_reference`；若启用 executor，必须接入与 `ssh_command` 同一套 `assess_command`/`decide` 与审批链。
- 未验证：未来 executor 路径；用户技能目录现有内容。

### D11 RiskEngine 与执行链判据分离（观察，非缺陷）

- 位置：`src-tauri/sidecar/tools/risk.py:104-161`（`invoke_risk_tool`）、`core/risk_engine.py:421-450`（YAML 规则 `re.match`）、`strands_backend/tools/__init__.py:496-700`（`assess_command` 使用 `command_impact` + `RiskChecker` + `decide`）。
- 预期/实际：Agent 执行链的风险判据是 `command_impact.analyze`（组合拆分、denylist、危险构造）+ `RiskChecker` + `modes.decide`；YAML `RiskEngine` 只服务前端 `risk.evaluate`（候选命令评估），不在 `execute_via_ssh` 内。
- 影响：若文档或审查把 `risk_rules.yaml` 当成 Agent 执行门禁，会误判覆盖。YAML 的低风险前缀规则（如 `cat`、`ls`）不会直接作用于执行链；执行链的判定以 `command_impact` 为准。
- 证据：`execute_via_ssh` 调用 `assess_command`；`RiskEngine` 调用点仅 `tools/risk.py` 与前端 `risk.evaluate`。
- 建议：在架构文档/审批卡注明两套判据的职责；若希望统一，后续单独拆任务，不在本审查中改策略。
- 未验证：前端 `risk.evaluate` 的实际使用范围与候选展示逻辑。

## 5. 覆盖矩阵

| 主题 | 已查入口 | 已有用例/证据 | 本轮结果 | 缺口 |
|---|---|---|---|---|
| 工具注册与 schema | `TOOL_REGISTRY`、`make_all_ops_tools`、`resolve_runtime_toolset`、`agent.info` | `test_prompt_tool_parity.py`、`test_command_impact.py` | 注册/裁剪主路径可读；发现 D3 显示名不一致 | 未验证前端按显示名的映射 |
| 审批与风险 | `assess_command`、`modes.decide`、`needs_you` 队列/超时、`request_approval_and_wait` | 批次 2 的审批策略/预算/读取审批用例 | 主路径通过；发现 D1、D2、D9 | 未跑真实 UI 审批；未覆盖参数级白名单 |
| 取消/超时 | `request_cancel`、watchdog、`_ExecutionGate`、`wait_for_response` | `test_agent_cancel.py`、`test_human_wait_watchdog.py`（未运行，依赖多） | 取消路径可读，状态区分清晰 | D8 竞态未实测 |
| 终端归属 | `ToolContext`、`execute_via_ssh` host 校验、`visibleTerminalGate.ts`、`sshScopeTarget.ts` | `test_approval_call_identity.py`、前端 gate 测试（未运行） | 可见终端有 gate；后台通道放宽 | D4 未实测多会话 |
| 回显 | Rust `ssh_command`/`visible_terminal_execute`、`sshCommandOutputStore`、`tool.tsx` | `test_ssh_command_result_*`（Rust 未运行） | 归属键匹配严格；实时输出未脱敏 | D5 未实测 |
| 日志/证据脱敏 | `agent_log`、`diagnostics`、`_redact`、`audit_chain`、`evidence` | `test_agent_log_privacy.py`、`test_command_log_privacy.py`、`test_diagnostic_privacy_integration.py`、`test_redact*.py` | 438 passed；发现 D6、D7 | 未验证真实日志落盘 |

## 6. 结论与建议拆分

1. 先修 D1、D2、D6：三者都能在离线合成输入下复现或直接由源码证明，且影响默认 confirm/auto 的执行边界与凭据落盘。建议由 ROOT 分配有界修复，不在本审查分支改产品代码。
2. D3、D4、D5、D9 需要产品/前端/安全共同确认范围：D3 是展示与诊断一致性；D4 涉及多主机产品语义；D5 涉及前端回显与持久化；D9 是名单扩充与误报权衡。
3. D8、D10 作为防回归项：审批后派发前检查取消、skill executor 不回到生产路径；不改现有策略。
4. D11 是文档/架构说明项，避免把 YAML 规则误当执行链门禁。
5. 本轮未发现“可绕过 denylist 直接自动执行 `rm -rf /`”的路径：`split_compound` 会拆出 `rm -rf /` 并命中 denylist；`bash -c`/`python -c` 包装落 unknown L3，confirm/auto 都要求审批。该结论仅覆盖本轮合成输入，不代表所有 shell 语义。

## 7. 限制与未验证

- 未连接真实 SSH 服务器、未调用任何付费模型、未运行 Tauri 桌面端到端、未验证安装包。
- 本机无 `node`/`pnpm`/`cargo`/`rustc`，前端 Vitest、Rust 编译与测试未运行；不能称为产品门禁全绿。
- 未验证前端会话是否持久化实时 SSH 输出（影响 D5 的实际暴露范围）。
- 未查看真实审计链文件内容；D6/D7 的落盘影响由函数输出推断，未用真实敏感样本验证。
- 未覆盖 macOS/Linux 实机、WSL、真实多会话并发。
- 现有用例通过只说明这些用例覆盖的路径当前通过，不代表上述缺口不存在。

## 8. 交付与后续

- 本报告放在 `docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md`，与首轮审查 PR 同交。
- 计划分支：`docs/2026-11-17-echosinklair-agent-review`（任务卡指定的 `docs/` 命名，日期按实际开工日更新）。后续完整工作包如另开 `codex/2026-11-17-echosinklair-agent-replay`，不在本 PR 内混入。
- PR 目标：`codex/2026-11-13-root-shared-review`；等待队长与 ROOT 验收，不合并 PR #49，不合并 main，不自行宣布验收。
- 完整复现命令、原始输出与未脱敏证据只在本地保留，按 `SECURITY.md` 私下交队长；公开 PR 只保留本报告的脱敏摘要。
- 产品修复、测试补充与策略调整另行分配；本报告不修改产品源码、依赖、审批策略或既有断言。