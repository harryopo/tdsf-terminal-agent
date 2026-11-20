# TEAM-AGENT-03：运维 Agent 模型行为与 Token 规划

- 日期：2026-11-20
- 状态：待评审、未实施、未提交、未推送、未合并
- 基线：`codex/2026-11-20-codearts-agent-model-ux@f40e9d1adb06050dcabb417bc4aaefa8da5fbfe5`
- 范围：PRD、技术方案、实施任务卡、索引和一张真实 CodeArts 规划截图；不含产品代码

## 问题与规划结果

现有正常 UI 配置链未把温度/max tokens 传给后端，思考只有展示链而没有请求控制，Token 只有局部展示和全局内存累计。用户要求运维输出稳定直接、Provider 能力驱动思考配置，并采用会话摘要与设置汇总。

本次形成三份配套文档：PRD定义需求和验收，技术方案定义纯函数路由、参数映射、配置快照、usage合同和UI，任务卡定义T0–T6与AI分工。默认低温但不承诺逐字确定；首选方案优先，备选按安全/稳定/直接排序；不输出隐藏思维链、不恢复双运行时、不先做生产微调。

## cc-switch参考

只读浅克隆 `farion1231/cc-switch`，commit `2a750c3fcbbefa9550047d7dd3363d9120e545ed`，MIT。参考真实usage归一化、缓存口径、设置行、摘要/趋势/明细和事件刷新；不照搬多CLI账号、代理路由、计费中心或丢失会话的归档。未复制实质代码。

## 与PR56边界

不修改D1/D6/D7风险、脱敏、审计和其已改测试。意图路由不得改变权限，usage不得复用日志/审计副本，前端fallback不得获得新执行能力。

## 截图

真实截图已归档到 `competitions/2026-huawei-agent/05-作品材料/05-码道使用证明/harryopo/`，证据ID为EV-AGENT-03-01。源图与入库副本SHA256均为 `0722a1985520bb73e79e831195d9723af226cb958092d1f1d87d81bb57db13d5`。截图只证明规划过程，不证明功能实现或测试通过。

## 独立评审后的合同校准

- MVP直接纳入独立最小usage事件store，保证日期/Provider/模型/会话筛选、短期趋势和跨重启幂等，不再只依赖会话总计与最近请求。
- maxTokens区分requested/effective；Anthropic null使用应用默认8192并明确回执，思考预算小于effectiveMaxTokens。
- 发送能力只来自代码验证映射；用户声明不能把未知兼容端点提升为发送白名单。
- showReasoning仅为前端展示偏好，不进入模型RPC或触发重建。
- 隐藏思维链措辞改为“不主动诱导或新增保存”；Provider已返回reasoning的既有展示/日志策略不由本需求改变。

## 验证与未做

文档、图片、链接、Git可见性和隐私检查结果见 `.ai/test-runs/agent-model-ux-plan-20261120-a1/`。历史失败已保留；最终退出0，12/12检查通过，117个相对链接有效，截图SHA/PNG、cc-switch commit/MIT、PRD十章节和合同守卫均通过。独立评审5项合同问题已修，复审5/5解决。未写产品代码，未运行Vitest/pytest/Rust/原生/真实模型/SSH/安装验收，未提交或建PR。

## 下一步

GPT主代理/ROOT先审PRD、技术方案和任务卡，确认T0合同与文件分工后再授权实施；队长决定是否将本规划形成Draft PR。实施必须先从T0反例和离线评测开始，不直接跳到UI或微调。