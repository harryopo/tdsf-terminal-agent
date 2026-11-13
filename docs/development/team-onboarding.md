# 新组员入门与阅读路线

日期：2026-11-13。面向 EchoSinklair 和 Yan-0914。队长已选择“各自 Fork → 任务分支 → 向主库提 PR”；两人首轮先审查安全性和稳定性，后续修复和功能各开任务。本文及新任务卡仍待随共同基线提交，不能假设远端 main 已包含队长本机的候选。

## 先理解项目

TDSF Terminal Agent 是围绕本地、WSL 和 SSH 终端的桌面工作台，组合文件浏览编辑、AI 协作、运维教学、知识检索与运行追溯。产品源码只有一份，比赛使用它的具体版本，不复制出另一套长期“参赛源码”。

主要分层是 React/TypeScript 界面、负责终端与系统能力的 Tauri/Rust，以及通过 stdio JSON-RPC 连接的 Python sidecar。生产 Agent 保持 Strands 单入口；可见执行、审批、回显和日志需要沿真实会话归属核对。命令审批不构成操作系统沙箱，置信度面板也不是校准后的正确概率。

项目已有生产链路和较多开发历史，但“源码存在、自动测试、真实桌面/SSH、安装包验收”分别成立。新预测/纠错仍有本地候选，专用端侧模型未作为已完成生产能力。先读状态，再选择审查对象，不从宣传稿推导安全结论。

## 第一遍只读这五份

| 顺序 | 文档 | 要建立的认知 |
|---|---|---|
| 1 | [项目 README](../../README.md) | 产品用途、主要界面和演示入口；其中描述仍需结合当前状态 |
| 2 | [项目状态](../STATUS.md) | 哪些已有实现，哪些待审、待实测或仅是研究 |
| 3 | [系统架构](../architecture/README.md) | 前端、Rust、sidecar、Agent 和工具如何相连 |
| 4 | [安全边界](../architecture/safety.md) | 审批、身份、数据可信度、日志与凭据的边界 |
| 5 | [团队固定流程](team-workflow.md) | 同步 main、任务分支、更新说明、PR 待审和队长合并 |

开始检查源码前，再读 [AGENTS](../../AGENTS.md)、[安全报告政策](../../SECURITY.md)、[开发准备](setup.md)和[验证分层](testing.md)。总体入口是 [docs/README](../README.md)，不需要先通读所有历史文件。

## 按自己的方向深入

| 成员 | 建议继续阅读 | 第一轮任务 |
|---|---|---|
| EchoSinklair：AI Agent | [Agent 链路](../architecture/agent.md)、[模块地图](../architecture/modules.md)、[输入与建议边界](../plans/terminal-prediction/2026-11-13-v1.0-输入与建议边界.md) | [TEAM-REVIEW-01：Agent 安全与稳定性](../../competitions/2026-huawei-agent/04-AI协作与交接/2026-11-13-EchoSinklair-首轮审查任务.md) |
| Yan-0914：运维 | [终端与工作区](../architecture/terminal-workspace.md)、[知识与日志](../architecture/knowledge-observability.md)、[模块地图](../architecture/modules.md) | [TEAM-REVIEW-02：连接、文件与知识链路](../../competitions/2026-huawei-agent/04-AI协作与交接/2026-11-13-Yan-0914-首轮审查任务.md) |

## 比赛与旧 Wiki 在哪里

当前比赛资料从 [比赛总入口](../../competitions/README.md) → [华为赛事目录](../../competitions/2026-huawei-agent/README.md)进入。先看 [三人分工](../../competitions/2026-huawei-agent/04-AI协作与交接/三人分工与开发说明.md)和[当前协作备赛计划](../../competitions/2026-huawei-agent/03-方案书/2026-11-13-v1.1-审查优先与成员分工.md)，技术事实以现行架构和代码为准。赛事资格、既有项目增量参赛和工具证明要求仍待组织方规则核验，不把作品计划当已参赛结果。

旧 Repo Wiki、Qoder Wiki、火山杯与其它比赛介绍已保留在队长本机的历史资料区，未随公开源码整体分发。它们有旧能力描述、路径和部分私人资料；需要某一专题时由队长选出并核验/脱敏后提供。现行 Wiki 的阅读作用由 `docs/architecture` 承担，不要求新成员重新恢复旧目录。

## 收到任务后怎样开工

1. 阅读可以先开始；依赖新代码的审查与开发，等待队长公布可获取的完整基线 SHA。记录起始基线、最近同步 main 和当前 HEAD，不以截图或队长本机路径代替源码。
2. Fork 主库，在自己的 Fork 建任务分支；无需为这一模式取得主库写权限。按固定流程每日开工、PR 前和 main 更新后同步。
3. 第一轮交付是审查摘要与必要的安全合成复现，不混入产品重构、数据库整理或模型接入；确认问题后再拆修复。
4. 发现可利用安全问题，完整细节按安全政策私下报告；公开 PR 只保留合适的脱敏摘要。自己的 Fork 同样不能上传凭据和私人日志。
5. 两人提交各自 PR 后保持待审，由队长与 ROOT 检查对应提交；成员不自行合并或开启自动合并。

本地阅读包只包含说明文档，不是可运行源码包，也不证明共同基线已发布。阅读包中的源码链接供之后完整克隆时定位使用。
