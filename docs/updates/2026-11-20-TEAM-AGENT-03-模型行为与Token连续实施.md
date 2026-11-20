# TEAM-AGENT-03：模型行为与 Token 连续实施

日期：2026-11-20；状态：T0–T5 已实现，候选待 ROOT 验收；未提交/推送/合并。基线 `f40e9d1adb06050dcabb417bc4aaefa8da5fbfe5`。

## 实现内容

- 新增 `model_params.py`：温度、max tokens、thinking、reasoning effort 的校验、能力白名单、协议映射和 requested/effective 回执。显式 0 与 null 分开，Anthropic 应用默认 8192，未知兼容端点不发送高级 reasoning。
- `LLMConfig`、模型工厂与 `agent_facade.configure` 已接线。配置代次和回合快照绑定；发布失败恢复旧磁盘、模型和运行时。Anthropic 思考预算必须为正且小于输出上限。
- 新增 `turn_policy.py`：30 个合成场景、general/ops_report/diagnose/command/teach 纯规则路由。只追加输出 profile；格式失败保留真实正文和结果，不新增分类请求或隐藏思维链。
- 新增 `usage.py` 与 SQLite：规范化实报字段，未知为 null，支持 call/attempt/revision、cumulative/delta、聚合覆盖、重复/乱序/重启和取消状态。事件与摘要在事务内更新，不存正文、命令、密钥或主机信息，不自动删除账本。
- 注册 `usage.summary`/`usage.events`，与 Rust ready 快照 allowlist 兼容。当前 Strands 最终响应按 `invocation_aggregate` 入账，不虚构逐物理请求精度；没有 usage 时不记 0。
- 前端新增模型生成偏好、显式保存与失败回滚、能力回执、黑白灰设置与会话/全局用量面板。会话和设置查询同一 RPC，支持筛选、模型分组、CSS/SVG 趋势、空/部分/失败状态。
- `showReasoning` 只控制 AiChat 展示，不进入 RPC 或模型重建。部分 usage 不再被旧内存汇总伪写为 0。

## 验证摘要

| 验证 | 本批真实结果 |
|---|---|
| Python 纯模块与 30 场景 | 85/85 通过；model_params 99%、turn_policy 100%、usage 100% 行覆盖 |
| Python 受影响后端与真实 Strands 假 Model | 187/187 通过，含发布回滚、模型热更新隔离、最终 usage 入账 |
| 本地假 Provider RPC | `test_model_rpc_chain.py` 3/3 通过，无外部模型调用 |
| RPC 注册/前端调用一致性 | 26/26 通过，`usage.summary` 在真实 ready 注册表内 |
| 前端定向 | 18 文件、189/189 通过 |
| 前端全集 | 380 文件、3392/3392 通过，最终复跑通过 |
| TypeScript 纯模块覆盖 | 25/25；语句 98.57%、分支 91.89%、行 100% |
| 类型、lint、构建 | app/node typecheck 通过；ESLint 0 警告；Vite Web 构建成功 |
| Ruff | Ruff 0.17.6 独立目录运行，本包新增及核心文件全部通过 |
| Python 全集 | 3401 项中 3383 通过、5 失败、13 错误；共享未改基线同批复现完全相同失败，属于缺少 anthropic 和 Chroma SQLite 环境现状，见交接 |

证据：`.ai/test-runs/agent03-20261120-a1/` 至 `agent03-20261120-a4/`。中间失败和修复均保留；最终覆盖率为 a3/a4 结果。

## 独立复核与开源/官方资料校准（a11）

- Anthropic `max_tokens` 已改为真实 SDK 顶层 model_config，不再误放 `params`；budget 只用于 4.5 及更早模型，4.6 起优先 adaptive。Fable/Mythos/Opus 5.5 不发送关闭，Sonnet 5.5 使用 `between_tools`，SDK 不支持 adaptive 时明确回退且不缺包崩溃。
- OpenAI 关闭思考会同时阻止显式 effort 残留，GPT-6 纳入 reasoning 前缀；Anthropic budget thinking 省略自定义温度并返回原因。配置 facade 串行发布，client_generation 拒绝过期发布，快照包含端点指纹、真实 resolvedModel 和配置代次。
- 设置页按当前默认模型做保守能力预览，未知兼容端点禁用高级 reasoning；恢复旧偏好后会再次同步，恢复失败也形成可读错误，不让回滚流程自身抛出未处理异常。
- usage 优先累计 `agent_invocations`/`accumulated_usage`，补主轮、续跑、todo/verify、取消/失败/超时事件及 unknown/取消/失败计数；支持旧汇总表无破坏补列和响应时间戳，不虚构流式中间值或逐物理请求精度。
- 真实 SDK 无网络 `format_request` 已验证：Anthropic budget 4095 和 adaptive/high 均正确，OpenAI off+high 无 reasoning_effort 残留。最终受影响后端 **174/174**、前端定向 **59/59**、Ruff 通过；此前前端全集 **3392/3392**、ESLint 和 Web 构建通过。

### 调研来源（2026-11-20）

- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)：effort 档位依模型而异，reasoning 属于输出 token 子集，原始 reasoning 不应索取；max output 同时约束可见与不可见生成。
- [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting)：字符÷4 不是可靠统计，工具/schema 也影响 input，实报应保留 Provider 语义。
- [Claude thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)：模型代际、adaptive/budget/disabled/between_tools 不可统一映射，thinking 与 max_tokens、缓存前缀有关。
- SDK 的 `EventLoopMetrics` 保留历史调用。每次入账选取该次 invocation 的用量，其中已经包含本次工具循环。不同调用分别入账。参见 [Strands 指标接口](https://strandsagents.com/docs/api/python/strands.telemetry.metrics/)。
- `farion1231/cc-switch@2a750c3f`（MIT）：统一 Token 口径、摘要到详情和事件刷新；不照搬多 CLI/计费/丢会话归档。
- `langfuse/langfuse`（许可证标为 Other）：公共 API 同时保留旧 prompt/completion 字段和新 input/output usage 映射，提示需要兼容别名而非多造统计真源。
- `Helicone/helicone`（Apache-2.0）：缓存读/写独立聚合、按模型/时间/会话维度分析；缓存子集不能盲加到总量，成本与 Token 用量分开。

## a11 原生验证

原生实例使用独立 Cargo target、TDSF_DATA_DIR 和 WebView2 用户目录，显式指定主树 venv Python 并设置 `TDSF_KB_AUTO_INIT=0`，不调用真实模型。Rust dev 构建与启动成功，IPC allowlist（130方法/未注册拒绝）和通用UI门禁（177元素、7类违规0）通过。AI模型设置各控件与空状态已核；隔离 synthetic 事件驱动面板显示2事件、1实报、1 unknown、1取消，证明UsageStore→RPC→原生设置读路径。3张实现截图及SHA已归档，后台实例已关闭。详见 `.ai/test-runs/agent03-20261120-a11-review/summary.md`。真实模型、SSH、安装包和Cargo test仍未做。

## 未做与风险

- 未调用真实付费模型，未评价温度对答案质量的影响，未宣称真实 Provider 全兼容。
- 未做 Tauri 原生窗口、真实 SSH、安装包验收；未改 Rust 源码，未运行 Cargo。
- 当前生产接线以最终聚合 usage 为主；存储支持 revision/delta/聚合覆盖，但没有把 Strands 不提供的逐物理请求 ID 或流式中间值编造出来。
- 真实模型质量、原生视觉/键盘、不同 Provider 代际和付费 capability 探测留待 ROOT/队长另行验收。
