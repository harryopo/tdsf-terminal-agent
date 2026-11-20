# 项目状态

整理于 2026-11-20。成员按工作包指定的 SHA 开工，从 [共享审查 PR #49](https://github.com/harryopo/tdsf-terminal-agent/pull/49) 核对实际分支头。团队分支已收录 Yan 的审查与 Skill 修复。产品是否进入 main 和安装包以对应 PR、标签及验收记录为准。参见 [当前工作包](../competitions/2026-huawei-agent/04-AI协作与交接/README.md)。

TDSF 是以终端为中心的桌面工作台，包含本地/WSL/SSH、文件浏览编辑与 AI 协作。技术基础为 Tauri 2、React/TypeScript、Rust 和 Python sidecar；批准的生产 Agent 边界是 Strands 唯一公开 `main` 入口，现存前端SDK fallback是待收口缺口。后续AI先读[架构与快速接手](architecture/README.md)，不必重新做全仓架构探索。

架构 Wiki 已复核。纠错与模型用量采用独立审查分支，维护者按实际候选复验。开发范围和裁决保留在 [连续开发方案](plans/product/2026-11-20-v1.1-ROOT评审与连续开发授权.md)。

## 实现与验收分开

| 范围 | 当前读法 |
|---|---|
| 终端、文件、工作区、设置和编辑器 | 已有源码实现；不同平台与连接场景仍须按受影响范围实测 |
| Agent 执行、审批、工具卡与回显 | 已有生产链路；修改时必须验证身份绑定、失败/取消和输出归属；前端SDK fallback与scrollback目标归属仍是已确认缺口 |
| 共享候选自动检查 | PR49 的 `f40e9d1a` 通过前端、Python、三平台 Rust、CodeQL 和 coverage。后续提交使用各自的运行记录 |
| 运维审查与 Skill 参考 | Yan 的 [PR #52](https://github.com/harryopo/tdsf-terminal-agent/pull/52) 和 [PR #54](https://github.com/harryopo/tdsf-terminal-agent/pull/54) 已经合入团队共享分支。Skill 的 `69c2cbb5` 通过 3383 项前端测试和类型检查 |
| Agent 安全 | CodeArts 与 ROOT 的安全补丁在共享组合树通过 579 项 Python 定向复核。Echo 的 [PR #56](https://github.com/harryopo/tdsf-terminal-agent/pull/56) 截至 `f881756d` 交付审查、材料及四个测试文件，生产实现仍在原工作包 |
| RDP/VNC | Yan 的 [PR #58](https://github.com/harryopo/tdsf-terminal-agent/pull/58) 已有应用内 RDP 连接反馈。跨平台检出、完整输入和会话清理仍待复验，VNC 仍在开发 |
| 知识浏览、中文整理与原始参考 | 保留来源和私人数据边界，不把原始抓取量当有效知识质量 |
| 命令建议与纠错扩展 | CORR-03 已完成严格捕获、失败反馈和显式词形召回。ROOT 独立复核发现焦点和输入版本问题，审查分支已补守卫。新快照需覆盖 WSL 和 SSH 生命周期 |
| Agent 模型行为与用量 | TEAM-AGENT-03 已实现参数、能力回执和用量面板。审查分支处理会话历史读取失败和用量计数边界，模型与统计仍按假服务及原生证据审核 |
| 专用端侧模型与学习存储 | 有研究和隔离实验；R4正式批判定无额外差分，优势来自已有早拒，证书为净负收益，原创性主张不成立；尚不能称已接入生产 |
| 安装包与发布 | 队长已确认安装包→真实SSH→真实模型端到端链路跑通且效果不错；具体新候选仍需绑定包SHA、环境、操作序列与原始结果，不因旧验收免测 |

当前优先顺序为：安全和稳定边界、真实输入与连接归属、无模型完整交互、再扩展模型与长期运维能力。完整桌面/SSH/安装测试与源码、假服务及离线实验结果分别标记。

## 下一步方向

- 共享 PR #49 继续跟踪新版组合检查、SSH 信任记录读取错误和依赖告警。代码审查结论以当前候选为准。
- 纠错按 [CORR-03 v1.2](plans/terminal-prediction/2026-11-20-v1.2-CORR-03失败反馈与原文采集连续开发.md) 补运维场景验证。Agent 模型与用量按独立分支继续测试实际 SDK 和持久化语义。
- Echo 继续 [安全工作包](https://github.com/harryopo/tdsf-terminal-agent/issues/55)。Yan 继续 [桌面工作包](https://github.com/harryopo/tdsf-terminal-agent/issues/57)，优先修复 Windows 路径后完成 RDP 输入与 VNC。
- 收口建议接受、异步过期、输入快照和真实owner合同，保留shell原始按键语义。
- 清理或严格隔离前端SDK第二执行分支，修复scrollback会话归属，不把审批描述为操作系统沙箱。
- 以来源、资源和无工具调用约束评测端侧模型，不让模型进入逐键自动链路。
- 持续维护SSH、资源管理器、知识内容与可追溯日志的真实使用路径。

详细设计见 [方案目录](plans/README.md)。研究建议不能直接当成产品已具备的功能；待批准事项不因文档整理而获批。
