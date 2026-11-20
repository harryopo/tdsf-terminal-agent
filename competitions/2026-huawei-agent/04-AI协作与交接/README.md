# 成员任务与交接入口

① 确认自己负责的包 → ② 看允许文件/基线 → ③ 分阶段实现与验证 → ④ 当天留证 → ⑤ 同一PR整体提审

| 成员/事项 | 当前入口 | 交付节奏 |
|---|---|---|
| Echo | [安全修复与闭环长任务](2026-11-18-EchoSinklair-安全修复与闭环长任务.md) | ROOT定架构，自主做D1/D6/D7明确窄修复与完整回归；同一PR56，整包一次技术验收 |
| Yan主线 | [原生桌面闭环与双协议长任务](2026-11-18-Yan-0914-原生桌面闭环与双协议长任务.md) | 自主完成信任/生命周期/交互、原生RDP→VNC→稳定性；同一PR58，不等逐步签字 |
| Yan 已验收成果 | [运维审查 PR #52](https://github.com/harryopo/tdsf-terminal-agent/pull/52)、[Skill PR #54](https://github.com/harryopo/tdsf-terminal-agent/pull/54) | 已合入团队共享分支，Skill 前端全量 3383 项通过 |
| Echo 当前回执 | [安全 PR #56](https://github.com/harryopo/tdsf-terminal-agent/pull/56)、[码道材料 PR #59](https://github.com/harryopo/tdsf-terminal-agent/pull/59) | 已收到安全审查、回归与材料，安全实现继续按 Issue #55 整包推进。复现材料由队长确认 |
| Yan 当前回执 | [桌面 PR #58](https://github.com/harryopo/tdsf-terminal-agent/pull/58) | 记录了应用内 RDP 连接。先校正 Windows 路径并补输入与会话生命周期，再完成 VNC |
| 三人职责/共享数据 | [三人分工与开发说明](三人分工与开发说明.md) | 当阶段留证，当天共享清单和原件交付状态 |
| 材料归档 | [05材料总入口](../05-作品材料/README.md) | 源稿/截图/码道/贡献/许可分别放对应目录 |
| 最终导出 | [作品提交五目录](../07-提交清单/作品提交/README.md) | 队长统一核对/打包/提交 |

11-13的[Echo首轮任务](2026-11-13-EchoSinklair-首轮审查任务.md)和[Yan首轮任务](2026-11-13-Yan-0914-首轮审查任务.md)保留作历史起点；本批完整包调整交付粒度，不要求重复已完成审查，不解除F0/READY或真实资源前置。

GitHub Issue是同一工作包的执行/讨论台账，本目录任务卡解释架构与交付；范围变更同时留日期和差异，避免两份“最终任务”互相矛盾。
