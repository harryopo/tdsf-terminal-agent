# TDSF 终端 Agent 方向方案书 — 整合版 v1.2

> **版本**：v1.2（参照 `终端Agent转型可行性调研-2026-07-25.md` 深度优化）  
> **日期**：2026-07-26  
> **整合范围**：桌面 Agent 源码（16,000 行）+ 60+ 调研报告 + 14 个开源终端 Agent + terax-ai 源码级设计分析 + 新转型调研  
> **核心议题**：桌面端 vs 终端 Agent IDE 双轨并行战略决策

---

## 目录

1. [战略判断：为什么必须做终端 Agent](#一战略判断为什么必须做终端-agent)
2. [开源项目全景与基座选型](#二开源项目全景与基座选型)
3. [可行性评估](#三可行性评估)
4. [桌面端现状：16,000 行代码的资产盘点](#四桌面端现状16000-行代码的资产盘点)
5. [终端 Agent 架构：Hermes 基座 + TDSF 算法](#五终端-agent-架构hermes-基座--tdsf-算法)
6. [PAOR 运维循环设计](#六paor-运维循环设计)
7. [知识库 = 文件系统](#七知识库--文件系统)
8. [terax-ai 技术栈、可复用设计与当前资产对接](#八terax-ai-技术栈可复用设计与当前资产对接)
9. [Rust 技术栈调研与 Tauri 2 角色定位](#九rust-技术栈调研与-tauri-2-角色定位)
10. [双支并行方案：架构与分工](#十双支并行方案架构与分工)
11. [代码复用矩阵：桌面 → 终端 Agent 迁移路径](#十一代码复用矩阵桌面--终端-agent-迁移路径)
12. [参赛叙事与演示场景](#十二参赛叙事与演示场景)
13. [实施路线图：6 天冲刺 + 4 周 MVP](#十三实施路线图6-天冲刺--4-周-mvp)
14. [风险与决策建议](#十四风险与决策建议)

---

## 一、战略判断：为什么必须做终端 Agent

### 1.1 核心结论

**终端 Agent 不是"退而求其次"，而是"回到本质"。**

运维的主战场就是终端。SSH + 命令行是运维人员的原生环境，Electron GUI 反而是在"对抗"用户习惯。把 AI Agent 放在 SSH 旁边，比把 SSH 塞进 Electron 窗口自然得多。

| 维度 | Electron 桌面端（现状） | 终端 Agent（新方案） |
|------|------------------------|---------------------|
| 开发复杂度 | 极高（IPC/打包/签名/前端） | 低（CLI + tools） |
| 与运维场景契合度 | 中（GUI 里嵌终端，别扭） | 极高（终端就是运维） |
| Agent 创新赛契合度 | 中（像个运维面板） | 极高（自我进化的运维 Agent） |
| 教学一体实现 | 需要前端页面渲染 | Markdown 原生，零成本 |
| 演示冲击力 | 中（又一个 Electron app） | 高（终端里 AI 实时诊断） |
| 6 天内可完成度 | 低（gap 太多） | 高（核心功能 3 天可跑通） |
| 后续维护成本 | 高 | 低 |

### 1.2 参赛叙事重构

**旧叙事（Electron）**："我们做了一个带 AI 的 Linux 运维桌面软件"

**新叙事（终端 Agent）**：
> "我们构建了一个会自我进化的 Linux 运维 Agent——它活在终端里，因为运维的主战场就是终端。它不只是回答问题，而是通过 PAOR 循环主动诊断、通过 Ground-Check 确保每条建议都有证据支撑、通过 Drain3 量化置信度、通过 4 层风控拦截危险操作。更重要的是，它会从每次诊断中学习，自动沉淀为可复用技能，越用越聪明。"

**关键词命中**：
- ✅ Agent 创新（自我进化学习循环）
- ✅ 可信决策（证据溯源 + 置信度量化）
- ✅ 人机协同（风控拦截 + 审批闸门）
- ✅ 教学一体（知识库原生 + 技能沉淀）
- ✅ 开源生态（基于 Hermes/OpenCode，回馈社区）

### 1.3 差异化定位：运维 + 终端 Agent 的空白市场

参照《终端Agent转型可行性调研-2026-07-25.md》的市场扫描结论：

- **现有终端 Agent 全部面向编码场景**（Claude Code / Codex CLI / Grok Build / OpenCode / aider 等），没有面向"Linux 运维诊断 + 教学"的专用 Agent。
- GitHub 上搜索 `linux ops AI agent terminal ssh` 的结果极少（仅 1-2 个 0 star 项目），说明**运维 + 终端 Agent 的交叉领域几乎是空白**。
- 我们的差异化定位因此非常清晰：**不是 coding agent，是 ops agent**。

这意味着：
1. **参赛叙事更独特**：不做"又一个编码 Agent"，做"第一个面向 Linux 运维教学的自我进化终端 Agent"。
2. **评审更容易理解**：运维人员天然在终端工作，产品形态不需要教育市场。
3. **技术壁垒更明确**：通用编码 Agent 做不出 PAOR 运维循环、Drain3 日志模板、4 层风控这些垂直能力。

### 1.4 资产总览

经过全面搜索 `d:\ai\linux教学一体` 下的所有子项目，当前项目簇拥有：

| 资产类别 | 数量 | 核心价值 |
|----------|------|----------|
| **Agent 源码（TS）** | ~16,000 行 | DecisionEngine / RiskEngine / Credibility(D-S+PCR5) / Task Protocol(14步) / MCP(25工具) / Supervisor(PAOR) / Claude SDK |
| **Agent 源码（Python）** | ~1,500 行 | 4层风险控制 / 置信度 / LangGraph 状态图 |
| **调研报告** | 60+ 份 | 涵盖开源Agent架构 / 大厂整合 / Skill中台 / Token优化 |
| **内置 Skill** | 5 个 | diagnose-oom-killer / service-failure / permission-denied / disk-full / network-issue |
| **开源项目源码** | 15+ 仓库 | MetaGPT / OpenHands / aider / claw-code / cline / kilo-code / mastra / grok-build 等 |
| **终端 Agent 调研** | 14+ 个项目 | Grok Build / Claude Code / Codex CLI / Aider / Cline / jcode / OpenCode / OpenSquilla / Hermes / uniTerm / terax-ai / DeepSeek-TUI 等 |

---

## 二、开源项目全景与基座选型

### 2.1 头部终端 Agent 项目对比

| 项目 | Stars | 语言 | 许可证 | 核心特征 | 与 TDSF 关系 |
|------|-------|------|--------|----------|-------------|
| **Hermes Agent** | 220k | Python | MIT | 自我进化学习循环、技能自动创建、持久记忆、6种终端后端(含SSH)、cron调度、多平台网关、子Agent并行 | **最推荐基座** |
| **OpenCode** | 189k | TypeScript | MIT | 终端原生 TUI、75+ 模型提供商、LSP 集成、build/plan 双Agent、子Agent | TS 生态备选 |
| **Claw Code** | 195k | Python/Rust | MIT | Claude Code 架构净室重写 | 架构参考 |
| **Gemini CLI** | 106k | TypeScript | Apache-2.0 | Google 官方终端 Agent | 参考 |
| **Codex CLI** | 99.9k | TypeScript | Apache-2.0 | OpenAI 官方本地编码 Agent | OS 级沙箱参考 |
| **Grok Build** | 22.5k | Rust | Apache-2.0 | 全屏 TUI、鼠标交互、skills/plugins/hooks、headless 模式、MCP、ACP 协议 | TUI 参考 |
| **terax-ai** | 8.6k | TypeScript (Tauri 2) | Apache-2.0 | 轻量终端优先 AI 开发工作台（7MB），含终端/编辑器/AI侧栏/Git/文件管理 | **UI 设计参考** |
| **OpenSquilla** | 6.3k | Python | Apache-2.0 | Token 高效微内核 Agent，CLI + Web UI + 聊天通道统一循环 | 模型路由参考 |
| **jcode** | 11.4k | Rust | MIT | 极致性能的 Agent harness，多会话工作流 | 性能标杆 |

### 2.2 运维方向专项结论

搜索 "linux ops AI agent terminal ssh" 结果极少（仅 1-2 个 0 star 项目），说明：

- **运维 + 终端 Agent 的交叉领域几乎是空白** — 这是明确的机会窗口
- 现有终端 Agent 全部面向"编码"场景，没有面向"运维诊断/教学"的
- 我们的差异化定位非常清晰：**不是 coding agent，是 ops agent**

### 2.3 Hermes Agent 深度分析（首选基座）

Hermes 是当前最适合作为运维 Agent 基座的项目：

| 能力 | 描述 | 与 TDSF 的映射 |
|------|------|---------------|
| **SSH 终端后端** | 6 种后端之一，原生支持远程服务器操作 | 直接替代我们的 SSH 连接模块 |
| **技能系统** | 自动从经验中创建 skill，使用中自我改进，兼容 agentskills.io 标准 | 替代我们的"经验沉淀"模块，且更成熟 |
| **持久记忆** | FTS5 全文搜索 + LLM 摘要，跨会话召回 | 替代我们的 Decision Library |
| **Cron 调度** | 自然语言定义定时任务，多平台投递 | 替代我们的 scheduler 占位模块 |
| **子 Agent** | 隔离并行工作流 | 替代我们的 PAOR 并行采样 |
| **多平台网关** | Telegram/Discord/Slack/WhatsApp/Signal/CLI | 教学场景：学生在 Telegram 问运维问题 |
| **学习循环** | 唯一内置"学习-改进-记忆"闭环的 Agent | 完美契合"AI 让运维可解释"叙事 |
| **模型无关** | 300+ 模型，`hermes model` 一键切换 | 支持国产模型（Qwen/DeepSeek/GLM） |

### 2.4 技术选型建议

```
┌─────────────────────────────────────────────────────┐
│           TDSF-OpsAgent 技术栈（推荐）               │
├─────────────────────────────────────────────────────┤
│  Agent 基座      │  Hermes Agent (Python, MIT)       │
│  运维 Tools      │  自研 Python/TS（封装现有算法）   │
│  终端 UI 层      │  Hermes CLI + 可选 Tauri 2 外壳   │
│  知识库          │  Markdown + Git                   │
│  教学系统        │  Markdown 教程 + Agent 引导       │
│  演示录制        │  asciinema / terminal GIF         │
│  辅助 GUI        │  hermes-workspace Web UI          │
│  模型            │  DeepSeek/Qwen + Ollama 离线备选  │
└─────────────────────────────────────────────────────┘
```

> **关键决策**：Hermes 是 Agent 引擎，terax-ai 是 UI 设计参考。  
> 短期（比赛）：用 Hermes CLI 直接跑通核心能力。  
> 中期（产品化）：可给 Hermes 套一个 Tauri 2 的 GUI 外壳，复用 terax 的 CSS 变量主题系统。

---

## 三、可行性评估

（本节参照 `终端Agent转型可行性调研-2026-07-25.md` 补充）

### 3.1 技术可行性：高

| 维度 | 评估 | 说明 |
|------|------|------|
| 核心算法迁移 | ✅ 直接可行 | PAOR/Ground-Check/Drain3/风控引擎是纯逻辑，封装为 tool/skill 即可 |
| SSH 连接 | ✅ 框架原生 | Hermes 原生 SSH 后端；OpenCode 通过 bash tool 也可 |
| 知识库/教程 | ✅ 更简单 | Markdown 文件 = AI 原生可读 + 人类原生可读，零前端成本 |
| 人机协同审批 | ✅ 框架支持 | Hermes/OpenCode/Grok 都有 approval gating 机制 |
| 置信度/证据链 | ✅ 封装为 tool | Drain3 匹配 + 来源先验 → 封装为 `confidence_score` tool |
| 教学沙箱 | ✅ Docker 后端 | Hermes 支持 Docker 终端后端，天然隔离 |
| 演示效果 | ✅ 终端录屏 | asciinema/terminal 录屏比 Electron 截图更有"运维味" |

### 3.2 时间可行性：紧但可行（6 天）

| 天数 | 里程碑 |
|------|--------|
| D1 (7/25) | 确定基座框架 + 环境搭建 + 跑通 hello world |
| D2 (7/26) | 迁移核心 tools（SSH 诊断、日志分析、风控引擎） |
| D3 (7/27) | 实现 PAOR 运维循环 + Ground-Check 证据链 |
| D4 (7/28) | 知识库 markdown 体系 + 技能系统 + 教学场景 |
| D5 (7/29) | 端到端演示流程打磨 + 录屏 |
| D6 (7/30) | PPT/视频/提交材料 |

### 3.3 风险与对策

| 风险 | 概率 | 对策 |
|------|------|------|
| 框架学习曲线 | 中 | 选 Hermes（Python，文档完善，社区活跃） |
| 已有代码废弃感 | 低 | 核心算法 100% 复用，只是换了载体 |
| 评委不接受终端形态 | 低 | "运维就该在终端"是强叙事；且可加 hermes-workspace Web UI 做辅助展示 |
| 演示环境网络问题 | 中 | 支持本地模型（Ollama），离线可演示 |

### 3.4 与 Electron 方案的对比

| 维度 | Electron 桌面端（现状） | 终端 Agent（新方案） |
|------|------------------------|---------------------|
| 开发复杂度 | 极高（IPC/打包/签名/前端） | 低（CLI + tools） |
| 与运维场景契合度 | 中（GUI 里嵌终端，别扭） | 极高（终端就是运维） |
| Agent 创新赛契合度 | 中（像个运维面板） | 极高（自我进化的运维 Agent） |
| 教学一体实现 | 需要前端页面渲染 | Markdown 原生，零成本 |
| 演示冲击力 | 中（又一个 Electron app） | 高（终端里 AI 实时诊断） |
| 6天内可完成度 | 低（gap 太多） | 高（核心功能 3 天可跑通） |
| 后续维护成本 | 高 | 低 |

---

## 四、桌面端现状：16,000 行代码的资产盘点

### 4.1 Agent 核心模块（可直接复用为 Hermes Tools）

| 模块 | 文件 | 行数 | 终端 Agent 映射 |
|------|------|------|----------------|
| **PAOR 循环** | `agent-workflow.ts` | ~1,146 | `paor_loop` tool |
| **Ground-Check 证据溯源** | `agent/core/grounding.ts` | ~126 | `ground_check` tool |
| **Drain3 置信度** | `agent/credibility/` 相关 | ~600 | `log_analyze` tool 内部 |
| **RiskEngine（4层风控）** | `agent/core/risk-engine.ts` | ~440 | `risk_evaluate` tool |
| **Credibility (D-S+PCR5)** | `agent/credibility/*.ts` | ~2,000 | `confidence_assess` tool |
| **Task Protocol (14步)** | `agent/subagents/task-protocol-*.ts` | ~1,920 | 任务编排参考 |
| **MCP Tools (25个)** | `agent/tools/` + `agent/mcp-gateway.ts` | ~1,500 | 直接/改写为 Hermes tools |
| **Supervisor** | `agent/supervisor.ts` | ~1,146 | Agent 调度参考 |
| **Provider 工厂** | `agent/providers/*.ts` | ~1,500 | 模型路由参考 |
| **@指令系统** | `agent/at-commands/*.ts` | ~900 | 用户输入解析参考 |

### 4.2 Python 后端资产（可直接集成）

| 模块 | 文件 | 核心价值 | 复用方式 |
|------|------|----------|----------|
| **RiskEngine** | `projects/src/tdsf/core/risk_engine.py` | 4层风控、YAML规则库、资产关键性 | 直接作为 `risk_evaluate` tool 核心 |
| **ConfidenceCalculator** | `projects/src/tdsf/core/confidence.py` | `α×drainMatch + (1-α)×sourcePrior` | 直接作为 `confidence_assess` tool |
| **LangGraph 节点** | `projects/src/tdsf/graph/nodes.py` | perceive/retrieve/reason/ground_check/assess_risk/decide/archive | 作为 PAOR 循环的参考实现 |
| **Sidecar-A** | `tdsf-linux-desktop/sidecar-a/main.py` | Drain3 日志解析、E2B 沙箱、SRE 诊断 | 作为 `log_analyze` 服务 |

### 4.3 桌面端独有资产（终端 Agent 不需要）

| 模块 | 行数 | 说明 |
|------|------|------|
| 前端 UI 组件 | ~5,000 | React 18 + Ant Design 5 |
| IPC 桥接层 | ~3,000 | 55+ 通道，Electron contextBridge |
| Electron 壳 | ~2,000 | main/renderer/preload 三进程 |
| Monaco Editor | ~500 | 代码编辑器 |
| 文件管理器 UI | ~800 | 文件树、拖拽 |
| 设置面板 UI | ~1,000 | 配置界面 |

### 4.4 桌面端当前赛跑状态

- 比赛交付截止：**2026-07-30**（剩 4 天）
- Day 1-6 冲刺路线：基线 → Demo → 打包 → Bug修复 → 冻结 → 比赛
- 五绿门禁：typecheck:node + typecheck:web + lint + test + build:win

---

## 五、终端 Agent 架构：Hermes 基座 + TDSF 算法

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    TDSF-OpsAgent 架构                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐     │
│  │  SSH 终端    │  │  AI Agent   │  │  知识库 (MD)    │     │
│  │  (左面板)    │  │  (右面板)   │  │  (文件系统)     │     │
│  │             │  │             │  │                 │     │
│  │  真实服务器  │◄─┤  诊断/建议  │─►│  tutorials/     │     │
│  │  命令执行    │  │  命令补全   │  │  knowledge/     │     │
│  │  日志流      │  │  风险拦截   │  │  skills/        │     │
│  │             │  │  经验沉淀   │  │  decisions/     │     │
│  └─────────────┘  └──────┬──────┘  └─────────────────┘     │
│                          │                                   │
│  ┌───────────────────────┼───────────────────────────────┐  │
│  │              TDSF Agent 核心引擎层                      │  │
│  ├───────────────────────┼───────────────────────────────┤  │
│  │                       │                               │  │
│  │  ┌─────────┐  ┌──────┴──────┐  ┌──────────────┐     │  │
│  │  │ PAOR    │  │ Ground-Check│  │ 风控引擎     │     │  │
│  │  │ 循环    │  │ 证据溯源    │  │ (4层)        │     │  │
│  │  └─────────┘  └─────────────┘  └──────────────┘     │  │
│  │                                                     │  │
│  │  ┌─────────┐  ┌─────────────┐  ┌──────────────┐     │  │
│  │  │ Drain3  │  │ Self-       │  │ 置信度融合   │     │  │
│  │  │ 模板匹配│  │ Consistency │  │ D-S + PCR5   │     │  │
│  │  └─────────┘  └─────────────┘  └──────────────┘     │  │
│  │                                                     │  │
│  └─────────────────────────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┼───────────────────────────────┐  │
│  │              Hermes 基座层                              │  │
│  ├───────────────────────┼───────────────────────────────┤  │
│  │  终端后端(SSH/Docker/Local) │ 记忆系统 │ 技能系统      │  │
│  │  Cron调度 │ 子Agent │ 多平台网关 │ 模型路由          │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 核心 Tools 设计

将现有 Electron 端的核心能力封装为 Hermes tools：

```yaml
tools:
  # === 诊断类 ===
  ssh_diagnose:
    description: "SSH 连接远程服务器执行诊断命令"
    params: [host, command, timeout]
    risk_level: depends_on_command  # 由风控引擎动态判定

  log_analyze:
    description: "分析系统日志，提取异常模式"
    params: [log_source, time_range, pattern]
    uses: [drain3_template_matching]

  system_health:
    description: "采集系统健康指标（CPU/内存/磁盘/网络）"
    params: [host, metrics]

  # === 决策类 ===
  confidence_assess:
    description: "基于 Drain3 匹配度 + 来源先验计算置信度"
    formula: "0.7 × drainMatch + 0.3 × sourcePrior"
    threshold: 0.7  # <0.7 触发 Self-Consistency 3次采样

  risk_evaluate:
    description: "4层风控评估（命令分类/参数检测/上下文/历史）"
    levels: [LOW, MEDIUM, HIGH, CRITICAL]
    action: "LOW→直通, MEDIUM+HIGH→interrupt人审"

  ground_check:
    description: "证据溯源验证，拒绝标记'仅供参考'，最多1次重采"
    params: [evidence_list, source_type]

  # === 教学类 ===
  explain_command:
    description: "解释 Linux 命令的含义、参数、风险"
    params: [command, detail_level]

  tutorial_guide:
    description: "根据当前操作推荐相关教程"
    source: "knowledge/tutorials/*.md"

  # === 沉淀类 ===
  save_decision:
    description: "将本次诊断决策存入决策库"
    params: [problem, evidence, decision, confidence, outcome]

  create_skill:
    description: "从成功的诊断经验中自动创建可复用技能"
    trigger: "复杂任务成功完成后"
```

---

## 六、PAOR 运维循环设计

### 6.1 PAOR 循环定义

TDSF 的核心工作流，从桌面端迁移到终端 Agent：

| 阶段 | 含义 | Agent 行为 |
|------|------|-----------|
| **P - Plan** | 规划 | 根据用户问题，生成诊断路径，等待用户确认 |
| **A - Act** | 执行 | 经风控引擎过滤后，执行 SSH 诊断命令 |
| **O - Observe** | 观察 | Ground-Check 证据溯源 + Drain3 模板匹配 |
| **R - Reflect** | 反思 | 置信度评估，给出结论/建议，沉淀决策 |

### 6.2 PAOR 循环示例

```
用户描述问题: "服务器响应变慢，用户反馈页面加载超时"
         │
         ▼
┌─── Plan ───────────────────────────────────────────┐
│  Agent 规划诊断路径:                                │
│  1. 检查系统负载 (top/htop)                        │
│  2. 检查网络连接 (ss/netstat)                      │
│  3. 检查磁盘 I/O (iostat)                         │
│  4. 检查应用日志 (journalctl/tail)                 │
│  5. 检查数据库连接 (mysql status)                  │
│  [展示计划，等待用户确认]                           │
└────────────────────────────────────────────────────┘
         │ 用户确认 / 修改
         ▼
┌─── Act ────────────────────────────────────────────┐
│  执行诊断命令（经风控引擎过滤）:                     │
│  $ ssh user@server "top -bn1 | head -20"           │
│  $ ssh user@server "ss -tulnp"                     │
│  $ ssh user@server "iostat -x 1 3"                 │
│  [HIGH 风险命令 → 中断等待人审]                     │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─── Observe ────────────────────────────────────────┐
│  Ground-Check 证据溯源:                            │
│  ✓ CPU 85% (来源: top, 可信)                       │
│  ✓ 磁盘 await 200ms (来源: iostat, 可信)           │
│  ✗ "可能是内存泄漏" (无证据, 标记"仅供参考")        │
│  Drain3 模板匹配: "high_cpu_io_wait" conf=0.82    │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─── Reflect ────────────────────────────────────────┐
│  置信度 0.82 > 0.7 → 单次推理                      │
│  结论: "磁盘 I/O 瓶颈导致响应延迟"                  │
│  建议: "1. 检查大文件写入 2. 考虑 SSD 升级"         │
│  [存入决策库，置信度 0.82]                          │
│  [触发技能创建: "io_bottleneck_diagnosis"]          │
└────────────────────────────────────────────────────┘
```

---

## 七、知识库 = 文件系统

### 7.1 目录结构

```
tdsf-ops-knowledge/
├── tutorials/              # 教学教程（Markdown）
│   ├── 01-linux-basics/
│   │   ├── 01-filesystem.md
│   │   ├── 02-permissions.md
│   │   └── 03-processes.md
│   ├── 02-networking/
│   ├── 03-security/
│   └── 04-troubleshooting/
├── skills/                 # Agent 自动沉淀的技能
│   ├── io_bottleneck_diagnosis.md
│   ├── memory_leak_detection.md
│   └── network_latency_trace.md
├── decisions/              # 决策记录（可审计）
│   ├── 2026-07-25-disk-io.json
│   └── 2026-07-24-oom-kill.json
├── runbooks/               # 运维手册
│   ├── nginx-troubleshooting.md
│   └── mysql-recovery.md
└── AGENT.md                # Agent 系统提示词 + 项目约定
```

### 7.2 为什么知识库=文件系统是最佳方案

| 优势 | 说明 |
|------|------|
| **AI 原生可读** | 直接 `cat` / `grep` / 向量检索 |
| **人类原生可读** | 任何编辑器/终端 `less` |
| **Git 版本控制** | 每次技能进化都有 diff |
| **零前端渲染成本** | 不需要 React 组件解析 |
| **学生可编辑** | 直接用 `vim` 补充知识 |

---

## 八、terax-ai 技术栈、可复用设计与当前资产对接

### 8.1 terax-ai 精确技术栈

通过源码级分析（`package.json`、`src-tauri/Cargo.toml`、`src/modules/theme/applyTheme.ts`、`src/modules/terminal/lib/useTerminalSession.ts` 等），terax-ai 的技术栈如下：

| 层次 | 技术 | 版本/说明 |
|------|------|----------|
| **桌面壳** | Tauri 2 | Rust 后端 + Web 前端，包体 7MB 级 |
| **Rust 后端** | `portable-pty` + `tokio` + `reqwest` + `notify` + `nucleo-matcher` | PTY 本地终端、异步 IO、文件监听、模糊匹配 |
| **前端框架** | React 19 | 配合 React Compiler / babel-plugin-react-compiler |
| **构建工具** | Vite 8 + TypeScript 6.0 + Tailwind CSS v4 | 现代前端工程化 |
| **终端引擎** | xterm.js 6 + `@xterm/addon-fit/search/serialize/web-links/webgl` | WebGL 渲染、搜索、链接识别 |
| **编辑器** | CodeMirror 6 + `@uiw/react-codemirror` | 多语言语法高亮、Vim 模式、LSP |
| **状态管理** | Zustand 5 | 轻量全局状态 |
| **UI 组件** | shadcn/ui + Radix UI + `class-variance-authority` | 无样式组件 + 变体系统 |
| **图标** | Hugeicons + Iconify (Catppuccin) | 现代图标体系 |
| **字体** | Inter Variable + JetBrains Mono | UI 字体 + 等宽终端字体 |
| **AI SDK** | Vercel AI SDK (`ai` + `@ai-sdk/*`) | 统一多模型调用 |
| **包体积优化** | `size-limit` + `knip` + LTO/fat + `opt-level = "s"` + `strip = true` | Rust 侧极致裁剪 |

> **关键发现**：terax-ai 的终端不是模拟的，而是通过 Rust 侧的 `portable-pty` 在本机启动真实 PTY，前端 xterm.js 通过 Tauri Command 与 Rust 通信。其性能优势来自 Rust 侧的资源池化（rendererPool）和 WebGL 渲染。

### 8.2 terax-ai 核心设计要素

| 设计要素 | 实现位置 | 具体做法 | TDSF 借鉴方式 |
|----------|----------|----------|--------------|
| **CSS 变量主题引擎** | `src/modules/theme/applyTheme.ts` | 将主题配色写入 `:root` CSS 变量，包括 UI 色 (`--background`, `--primary`…) 和终端色 (`--terminal-ansi-*`) | 中期 Tauri GUI 外壳直接复用该模式 |
| **终端主题同步** | `src/styles/tokens.ts` + `terminalTheme.ts` | 创建临时 div probe 读取 CSS 变量，生成 xterm.js `ITheme` | 保证 UI 主题与终端 ANSI 色完全一致 |
| **Motion Tokens** | `src/styles/globals.css` | `--dur-fast/base/slow` + `--ease-premium/soft` | 统一动画节奏 |
| **Grid 动画** | 组件 CSS | `grid-template-rows: 0fr → 1fr` 展开/收起 | Agent 卡片展开收起 |
| **Borderless 窗口** | Tauri 配置 + CSS | 12px 圆角 + 半透明边框 + 玻璃质感 | GUI 外壳视觉风格 |
| **Renderer Pool** | `src/modules/terminal/lib/rendererPool.ts` | xterm.js 实例池化，Tab 切换时复用 | 多 SSH Tab 场景降低内存 |
| **Dormant Ring** | `src/modules/terminal/lib/useTerminalSession.ts` | 隐藏 Tab 的输出先写入 ring buffer，恢复后再 flush | 后台 SSH 会话不丢输出 |
| **Shell Integration** | `src/modules/terminal/lib/osc-handlers.ts` | OSC 133 识别 prompt/command/output 边界 | AI 能精确知道"当前命令是否执行完" |

### 8.3 terax-ai 主题引擎源码解析

```typescript
// src/modules/theme/applyTheme.ts 核心流程
export function applyTheme(theme: Theme, mode: ThemeMode): void {
  const root = document.documentElement;
  const variant = theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
  if (!variant) { clearTheme(); return; }
  const colors = variant.colors;
  const terminal = variant.terminal;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  if (colors) writeColors(root, colors);        // UI 变量
  if (terminal) writeTerminal(root, terminal);  // 终端变量
  lastApplied = theme.id;
}
```

```typescript
// src/styles/tokens.ts + terminalTheme.ts：CSS 变量 → xterm.js ITheme
export function readTerminalTokens(): TerminalTokens {
  const el = getProbe();
  const out = {} as TerminalTokens;
  for (const k of KEYS) out[k] = resolve(el, VAR_BY_KEY[k]);
  return out;
}

export function buildTerminalTheme(): ITheme {
  const t = readTerminalTokens();
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    selectionBackground: t.selection,
    black: t.ansiBlack,
    // ... 16 色 ANSI
  };
}
```

### 8.4 TDSF 终端 Agent 的 UI 形态

终端 Agent 有两种 UI 形态：

| 形态 | 技术 | 适用场景 | 时间 |
|------|------|----------|------|
| **CLI/TUI** | Hermes 原生 | 比赛演示、极客用户 | D1-D6 |
| **GUI 外壳** | Tauri 2 + React 19 + Tailwind | 普通用户、教学场景 | 4 周 MVP |

> terax-ai 的设计语言用于第二种形态（GUI 外壳），第一种形态直接用 Hermes CLI。

### 8.5 中期 Tauri GUI 外壳可复用的 terax 资产

如果中期要给 Hermes 套 GUI 外壳，以下 terax 模块可直接迁移/改写：

| terax 文件 | TDSF 对应位置 | 借鉴内容 |
|------------|-------------|----------|
| `src/styles/globals.css` | `terminal/src/styles/globals.css` | CSS 变量、动画、xterm 覆盖 |
| `src/styles/tokens.ts` | `terminal/src/styles/tokens.ts` | 终端令牌读取 |
| `src/styles/terminalTheme.ts` | `terminal/src/styles/terminalTheme.ts` | xterm ITheme 构建 |
| `src/modules/theme/applyTheme.ts` | `terminal/src/theme/applyTheme.ts` | 主题应用核心 |
| `src/modules/theme/ThemeProvider.tsx` | `terminal/src/theme/ThemeProvider.tsx` | React Context |
| `src/modules/terminal/lib/useTerminalSession.ts` | `terminal/src/terminal/useTerminalSession.ts` | PTY 生命周期管理 |
| `src/modules/terminal/lib/rendererPool.ts` | `terminal/src/terminal/rendererPool.ts` | xterm 实例池化 |

### 8.6 与当前目录已开发资产的对接方式

terax-ai 是**UI 设计参考和中期 GUI 外壳**，真正的运维 Agent 大脑应复用当前目录已沉淀的算法资产。对接方式分三层：

#### 1) 算法层：整体迁移为 Hermes tools

| 当前资产 | 路径 | 对接方式 | 目标 tool |
|----------|------|----------|-----------|
| **4 层风控引擎** | `tdsf-linux-desktop/src/main/core/risk-engine.ts` | TS→Python 重写或子进程调用 | `risk_evaluate` |
| **Python 版风控引擎** | `projects/src/tdsf/core/risk_engine.py` | 直接导入，零改写 | `risk_evaluate` |
| **证据置信度** | `projects/src/tdsf/core/confidence.py` | 直接导入 | `confidence_assess` |
| **Ground-Check 溯源** | `tdsf-linux-desktop/src/main/core/grounding.ts` | TS→Python 翻译 | `ground_check` |
| **LangGraph 七节点** | `projects/src/tdsf/graph/nodes.py` | 逻辑复用，改写为 Hermes workflow | PAOR 编排参考 |
| **Drain3 日志解析** | `tdsf-linux-desktop/sidecar-a/main.py` | 作为 `log_analyze` 子服务 | `log_analyze` |

> **首选策略**：Python 后端资产直接作为 Hermes tool 的核心库；TS 资产翻译成 Python，保持算法不变。

#### 2) 连接层：SSH 由 Hermes 原生后端替代

当前桌面端的 `src/main/services/ssh/` 和 IPC 层在终端 Agent 中不再需要：

- Hermes 内置 SSH 终端后端，支持 `hermes ssh user@host`。
- 本地开发可用 Docker/Local 后端做沙箱演示。
- 复杂网络场景可保留现有 SSH 配置解析逻辑，仅读取 `~/.ssh/config`。

#### 3) UI 层：terax-ai 的设计语言用于 Tauri GUI 外壳

当前桌面端 React UI 不直接复用，但以下设计资产可直接迁移到中期 GUI：

- **深色主题配色**：复用 terax-ai 的 zinc 暗色 + 紫色强调，符合用户"深渊暗系 UI"偏好。
- **Motion Tokens**：`--dur-fast/base/slow` + `--ease-premium/soft` 直接写入 CSS。
- **字体体系**：Inter Variable + JetBrains Mono。
- **Borderless 窗口 + 大圆角**：Tauri 2 支持，可做出比 Electron 更轻量的壳。

---

## 九、Rust 技术栈调研与 Tauri 2 角色定位

> 调研范围：Rust 官方生态（crates.io / Cargo / rustup）、Tauri 2 官方文档、桌面框架对比（Electron / Tauri / Wails）、Rust 终端参考项目 ht/ht-mcp 源码级分析。

### 9.1 为什么方案书中出现大量 Rust

当前已调研的终端 Agent/IDE 项目中：

| 项目 | Rust 用途 |
|------|----------|
| **terax-ai** | Tauri 2 桌面壳 + Rust 后端（`portable-pty` 终端、`tokio` 异步） |
| **ht** | 无头终端引擎（PTY + VT100 仿真） |
| **ht-mcp** | MCP server 封装，让 Agent 通过 MCP tools 控制终端 |
| **Warp** | 完整 GPU 加速终端（60+ crates，~2000 文件） |
| **jcode** | 14ms 首帧优化，依赖 Rust 级别内存分配器和 KV Cache 热保持 |

**结论**：Rust 在"终端执行引擎"和"轻量桌面壳"两个领域已成为事实标准，不是因为算法用 Rust 写，而是因为**边界系统能力（PTY、进程、内存、渲染）用 Rust 最安全高效**。

### 9.2 Rust 核心优势（对应 TDSF 场景）

| 优势 | 在终端 Agent 中的价值 |
|------|----------------------|
| **内存安全** | PTY/子进程/文件句柄生命周期由编译器保证，避免 Electron 常见的句柄泄漏和崩溃 |
| **零成本抽象** | 高级抽象（泛型、trait、async）不牺牲性能，适合低延迟终端 I/O |
| **单二进制分发** | `cargo build --release` 生成 4-20MB 独立 exe，比赛演示无需装 Node/Python |
| **异步高性能** | `tokio` + `AsyncFd` 实现非阻塞 PTY 读写，比 Python subprocess 快一个数量级 |
| **跨平台编译** | 一套 Rust 代码编译 Windows/Linux/macOS，Tauri 2 还支持 iOS/Android |
| **MCP 原生** | 官方 Rust MCP SDK（`rmcp`）让 Rust 成为 MCP server 的一等公民 |

### 9.3 Rust 工具链与前置环境

#### 官方文档与学习资源

| 资源 | 链接 | 用途 |
|------|------|------|
| The Rust Programming Language（官方教程） | https://doc.rust-lang.org/book/ | 入门必读，覆盖所有权、生命周期、并发、异步 |
| The Cargo Book | https://doc.rust-lang.org/cargo/ | Cargo 包管理、Workspace、Profile、发布流程 |
| Rust By Example | https://doc.rust-lang.org/rust-by-example/ | 通过示例快速查语法 |
| Tauri 2 官方文档 | https://v2.tauri.app/ | Tauri 2 前置条件、API、权限、分发 |
| crates.io | https://crates.io | Rust 包注册中心 |
| Rust 标准库 API | https://doc.rust-lang.org/std/ | 标准库速查 |

> 当前 Rust 稳定版（2026-07）已默认使用 **Edition 2024**，要求 `rustc >= 1.90.0`。Tauri 2 要求 `rustc >= 1.77.2`，Hermes/终端引擎相关 crate 通常要求 `>= 1.84`。

#### 安装方式：rustup

rustup 是官方工具链管理器，同时安装 `rustc`（编译器）、`cargo`（包管理器）、`clippy`（代码检查）、`rustfmt`（格式化）。

```bash
# Linux/macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Windows（推荐 PowerShell）
winget install --id Rustlang.Rustup
# 或下载 rustup-init.exe 后选择默认 MSVC 工具链
```

验证安装：
```bash
rustc --version    # 例：rustc 1.90.0 (...
cargo --version    # 例：cargo 1.90.0
rustup show        # 查看当前工具链与目标平台
```

#### 平台前置依赖

| 平台 | 必须依赖 | 说明 |
|------|----------|------|
| **Windows** | MSVC C++ 生成工具 + Windows SDK | Rust on Windows 默认使用 MSVC 链接器；Visual Studio Community 2022 免费可用 |
| **Windows (Tauri)** | WebView2 运行时 | Win10 1803+/Win11 已内置，低版本需手动安装 |
| **Linux** | `build-essential` / `gcc` / `clang` / `libssl-dev` | 基础 C 编译工具链 |
| **Linux (Tauri)** | `libwebkit2gtk-4.1-dev` / `libayatana-appindicator3-dev` / `librsvg2-dev` | Debian/Ubuntu 示例，不同发行版包名不同 |
| **macOS** | Xcode Command Line Tools | `xcode-select --install` |
| **macOS (Tauri iOS)** | 完整 Xcode | 仅桌面开发可只用 Command Line Tools |

#### 包管理：Cargo + crates.io

Cargo 同时管理依赖、构建、测试、文档和发布。`Cargo.toml` 声明依赖，`Cargo.lock` 锁定精确版本。

`Cargo.toml` 示例（来自 ht）：

```toml
[package]
name = "ht"
version = "0.4.0"
edition = "2021"
rust-version = "1.84"

[dependencies]
avt = "0.16.0"
nix = { version = "0.28.0", features = ["term", "process", "fs", "signal"] }
tokio = { version = "1.38.0", features = ["full"] }
axum = { version = "0.7.5", default-features = false, features = ["http1", "ws", "query"] }
clap = { version = "4.5.4", features = ["derive"] }
serde_json = "1.0.140"

[profile.release]
strip = true
```

**国内网络加速**： crates.io 在国内可能下载慢，建议配置镜像（USTC / 清华 / 字节）：

```toml
# ~/.cargo/config.toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"

# 或使用清华镜像
# registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
```

常用命令：
- `cargo new project_name --bin`：创建可执行项目
- `cargo init`：在当前目录初始化
- `cargo build`：调试构建
- `cargo build --release`：发布构建（优化 + strip）
- `cargo run`：构建并运行
- `cargo test`：运行测试
- `cargo add crate_name`：添加依赖
- `cargo clippy`：代码检查（Lint）
- `cargo fmt`：格式化
- `cargo doc --open`：生成本地文档
- `cargo install crate_name`：安装全局二进制工具
- `cargo tree`：查看依赖树

#### 关键 crates（库）

| Crate | 用途 | TDSF 场景 |
|-------|------|-----------|
| `tokio` | 异步运行时 | PTY I/O、WebSocket、MCP server |
| `portable-pty` / `rust-pty` / `nix::pty` | 跨平台 PTY | 终端执行引擎 |
| `axum` | HTTP/WebSocket 服务 | 终端状态 API、WebSocket 流 |
| `serde` / `serde_json` | JSON 序列化 | MCP 消息、配置文件 |
| `clap` | CLI 参数解析 | 命令行入口 |
| `anyhow` / `thiserror` | 错误处理 | 快速错误传播 vs 结构化错误 |
| `rmcp` | MCP SDK（Rust 官方） | 将终端能力暴露为 MCP tools |
| `avt` | VT100 虚拟终端仿真 | 解析 ANSI 序列，生成文本视图 |
| `notify` | 文件系统监听 | 知识库文件变更热重载 |
| `tracing` / `tracing-subscriber` | 结构化日志 | 可观测性 |
| `tower` / `tower-http` | 中间件生态 | 与 axum 配合做限流、CORS、日志 |

#### IDE / 编辑器支持

| 工具 | 推荐度 | 说明 |
|------|--------|------|
| **VS Code + rust-analyzer** | 首选 | 实时类型推断、内联错误、跳转定义、重构 |
| **JetBrains RustRover / CLion** | 次选 | 更重的 IDE，调试体验好 |
| **Helix / Neovim + LSP** | 高级用户 | 轻量，rust-analyzer 提供同等能力 |

> rust-analyzer 是官方语言服务器，与 VS Code 扩展配合使用；Trae IDE 也已内置对 Rust 的支持。

#### 工具链版本管理

```bash
rustup update stable                  # 更新到最新稳定版
rustup default stable-msvc            # Windows 设置默认 MSVC 工具链
rustup target add x86_64-unknown-linux-gnu   # 添加交叉编译目标
rustup component add clippy rustfmt   # 安装组件
rustup toolchain install 1.84.0       # 安装指定版本
```

建议项目根目录放置 `rust-toolchain.toml` 锁定版本，避免不同开发者编译器差异：

```toml
[toolchain]
channel = "1.90.0"
components = ["rustfmt", "clippy"]
targets = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]
```

#### Tauri 2 额外前置环境

```bash
# 安装 Tauri CLI
cargo install tauri-cli --version "^2"
# 或使用 npm
npm install -g @tauri-apps/cli@^2

# 验证
cargo tauri --version
```

Tauri 2 初始化推荐方式：
```bash
npm create tauri-app@latest
# 选择：React + TypeScript + Vite（与 terax-ai 一致）
```

Tauri 2 项目结构：
```
tdsf-terminal-gui/
├── src/                    # React 19 + Tailwind v4 前端
├── src-tauri/
│   ├── Cargo.toml          # Rust 后端依赖
│   ├── tauri.conf.json     # 权限、窗口、构建配置
│   └── src/lib.rs          # Rust command handler（通常 <500 行）
└── package.json
```

### 9.4 Tauri 2：我们需要多少 Rust？

Tauri 2 官方定位："用 Web 技术写 UI，用 Rust/Swift/Kotlin 写后端逻辑"。

**关键结论**：
- **Tauri 2 的 Rust 后端通常 <500 行**，只需写 command handler。
- 不需要深入所有权/生命周期/宏系统，常规 TypeScript 开发者 1-2 天可上手。
- 90% 的业务逻辑仍在前端（React/TS）或 Python 后端。

Tauri 2 调用 Rust command 示例：

```rust
// src-tauri/src/lib.rs
#[tauri::command]
fn execute_ssh_command(host: String, command: String) -> Result<String, String> {
    // 调用 Rust 终端引擎或转发给 Python 子进程
    Ok("output".to_string())
}
```

```typescript
// React 前端
import { invoke } from '@tauri-apps/api/core'
const output = await invoke('execute_ssh_command', { host: 'server1', command: 'df -h' })
```

### 9.5 桌面框架对比：Electron vs Tauri 2 vs Wails

| 维度 | Electron | Tauri 2 | Wails |
|------|----------|---------|-------|
| 后端语言 | Node.js | Rust | Go |
| 渲染引擎 | 内嵌 Chromium | 系统 WebView | 系统 WebView |
| 最小包体积 | ~120-180MB | ~5-15MB | ~15-25MB |
| 内存占用（Windows） | ~90-120MB | ~70-110MB | ~80-100MB |
| 启动速度 | 慢 | 快 | 快 |
| 跨平台一致性 | 最强（自带 Chromium） | 依赖系统 WebView | 依赖系统 WebView |
| 原生 API 丰富度 | 最丰富 | 中等，成长中 | 中等 |
| 团队学习成本 | 低（纯 JS/TS） | 中（需基础 Rust） | 中（需基础 Go） |
| 适合场景 | 大型复杂桌面应用 | 轻量安全桌面应用 | Go 后端团队桌面应用 |

**对 TDSF 的判断**：
- 比赛交付的桌面端已用 Electron，继续完成交付即可，**不迁移**。
- 终端 Agent 的中期 GUI 外壳首选 **Tauri 2**：轻量、Rust 终端引擎原生集成、符合用户对"深渊暗系 UI + 流畅"的偏好。
- 如果团队 Rust 经验不足，可先保持 **Hermes CLI + 网页预览**，延迟 GUI 外壳。

### 9.6 Rust 在 TDSF 中的明确边界

```
┌─────────────────────────────────────────────────────────────┐
│                    TDSF 终端 Agent                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  AI 决策层：Python（Hermes + RiskEngine + LangGraph）   │  │
│  │  - PAOR 循环、风控、证据溯源、知识库、Skill 系统        │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                              │
│  ┌───────────────────────────┼───────────────────────────┐  │
│  │      工具层：MCP Tools    │   可选 GUI 层：Tauri 2     │  │
│  │  - ssh_diagnose           │   - React 19 + Tailwind v4 │  │
│  │  - log_analyze            │   - 复用 terax-ai 设计语言  │  │
│  │  - risk_evaluate          │   - Rust backend <500 行    │  │
│  └───────────────────────────┘                            │  │
│                              │                              │
│  ┌───────────────────────────▼───────────────────────────┐  │
│  │         终端执行引擎：Rust（可选但推荐）                │  │
│  │  - PTY 管理（portable-pty / rust-pty）                  │  │
│  │  - VT100 仿真（avt / xterm.js）                         │  │
│  │  - MCP server（rmcp）                                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**：
- **算法不用 Rust**：继续用 Python，生态成熟，开发快。
- **边界能力可用 Rust**：终端执行引擎、MCP server、Tauri GUI 外壳。
- **6 天比赛冲刺不引入 Rust**：先用 Hermes CLI 跑通 PAOR 循环；Rust 终端引擎放到 4 周 MVP 阶段。

### 9.7 风险与注意事项

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| 学习曲线 | 所有权/生命周期/async 新概念 | 仅让 1 人负责 Rust 边界层，其他人继续 Python/TS |
| 编译时间 | 首次构建慢，release 模式几分钟 | 使用 `sccache`、CI 缓存、增量编译、更快链接器 |
| Windows PTY | `nix` 不支持 Windows，需 `portable-pty` | 优先 Linux/macOS 演示，Windows 用 WSL/ConPTY |
| 生态成熟度 | 某些 GUI 组件/调试工具不如 Electron | 中期 GUI 阶段再评估，短期 CLI 不受影响 |
| 双栈维护 | Python + Rust + TS 三套语言 | 明确边界：Python 决策、Rust 执行、TS UI |
| 国内网络 | crates.io 下载慢、GitHub 超时 | 配置 USTC/清华 sparse 镜像、GitHub 镜像或 vendor 依赖 |

#### 编译加速实战配置

```toml
# ~/.cargo/config.toml
[build]
rustc-wrapper = "sccache"          # 共享编译缓存

# Windows: 使用 lld 链接器（需安装 LLVM）
[target.x86_64-pc-windows-msvc]
linker = "lld-link"

# Linux: 使用 mold 链接器
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```

安装 sccache：
```bash
# Linux/macOS
sudo apt install sccache            # Debian/Ubuntu
brew install sccache                # macOS

# Windows
choco install sccache
# 或 cargo install sccache
```

构建优化建议：
- 开发迭代：`cargo check` 替代 `cargo build`（跳过链接，快 3-5 倍）
- 增量编译：开发模式默认开启；release 模式如需可设 `incremental = true`
- 分析瓶颈：`cargo build --timings` 生成 HTML 时间线，定位慢 crate
- 精简依赖：用 `cargo tree` 和 `cargo-machete` 移除未使用依赖
- 锁定工具链：`rust-toolchain.toml` 固定 channel，避免 CI 版本漂移

#### Windows PTY 特殊说明

ht 项目使用 `nix::pty`，仅支持 Unix（Linux/macOS）。Windows 方案：
1. **portable-pty** crate：跨平台 PTY，Windows 基于 ConPTY，推荐。
2. **Windows 子系统 for Linux（WSL）**：演示时启动 WSL 实例，ht/nix 直接可用。
3. **Tauri 2 + xterm.js**：前端用 xterm.js 连接 Rust 后端，Rust 后端用 `portable-pty` 或转发到远端 SSH。

#### 国内网络与离线部署

```toml
# ~/.cargo/config.toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"

[net]
git-fetch-with-cli = true    # 某些 git 依赖用系统 git 拉取更稳定
```

离线/比赛环境可提前执行 `cargo vendor` 将依赖源码打包到 `vendor/` 目录，配合 `.cargo/config.toml` 指向本地源，实现完全离线构建。

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
```

### 9.8 结论：TDSF 需要 Rust 吗？

**直接回答：需要，但只在“边界能力”层需要，且不是现在。**

| 层面 | 是否需要 Rust | 理由 |
|------|--------------|------|
| **AI 决策算法** | ❌ 不需要 | PAOR、Ground-Check、Drain3、风控、LangGraph 继续用 Python，生态成熟、开发快 |
| **终端执行引擎** | ✅ 强烈推荐 | PTY/VT100/MCP server 用 Rust 写可获得最佳性能、最小体积、最强安全保证 |
| **MCP server** | ✅ 推荐 | `rmcp` 是官方 SDK，ht-mcp 已验证比 TS 版本快 40 倍、内存低 70% |
| **Tauri 2 GUI 外壳** | ✅ 中期使用 | 后端只需 <500 行 Rust，前端复用 React 19 + terax-ai 设计语言 |
| **6 天比赛冲刺** | ❌ 不引入 | 时间窗口不够，先用 Hermes CLI + Python tools 跑通核心流程 |
| **4 周产品化 MVP** | ✅ 逐步引入 | 第一周搭 Rust PTY 原型；第二周接 MCP；第三周套 Tauri 2 外壳 |

**最佳实践路径**：
1. **短期（比赛）**：Python only（Hermes + 现有 RiskEngine/Confidence/LangGraph）。
2. **中期（MVP）**：Python 决策 + Rust 终端执行引擎（`portable-pty` + `avt` + `rmcp`）。
3. **长期（产品）**：在 Rust 终端引擎基础上，可选 Tauri 2 GUI 外壳，复用 terax-ai 设计资产。

**一句话**：Rust 不是来替代 Python 的，是来替代 Electron/Node 做“重边界、轻 UI”的终端执行层。

---

## 十、双支并行方案：架构与分工

### 10.1 双支并行架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    TDSF Agent 共享核心                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  PAOR 循环 │ Ground-Check │ 4层风控 │ Drain3 │ D-S+PCR5  │    │
│  │  Task Protocol(14步) │ MCP Tools(25个) │ Supervisor    │    │
│  │  Provider 工厂  │ Claude SDK  │ @指令系统  │ 模式注册   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐              │
│         ▼                    ▼                    ▼              │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐        │
│  │ 桌面端       │    │ 终端 Agent   │    │ Web API      │        │
│  │ (Electron)  │    │ (Hermes CLI) │    │ (FastAPI)    │        │
│  │             │    │ + Tauri GUI  │    │              │        │
│  │ 比赛交付     │    │ 新赛道开发   │    │ 远程服务     │        │
│  │ 2026-07-30  │    │ 2026 Q3-Q4   │    │ 2027+        │        │
│  └─────────────┘    └──────────────┘    └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 双支分工

| 分支 | 定位 | 目标用户 | 交付时间 | 团队侧重 |
|------|------|----------|----------|----------|
| **桌面端** | 比赛交付 + 教学场景 | 学生、教师 | 2026-07-30（冻结） | 稳（Bug修复 + 打包） |
| **终端 Agent** | 专业运维 + 开发者 | 运维工程师、高级学生 | 2026-07-31（6天冲刺）→ Q4（v1.0） | 快（新架构 + 体验） |

---

## 十一、代码复用矩阵：桌面 → 终端 Agent 迁移路径

### 11.1 Hermes Tools 映射

| 桌面端模块 | 路径 | 终端 Agent 映射 |
|------------|------|----------------|
| PAOR 循环 | `src/main/core/agent-workflow.ts` | `paor_loop` tool |
| Ground-Check | `src/main/core/grounding.ts` | `ground_check` tool |
| Drain3 模板匹配 | `src/main/core/agent/credibility/` | `log_analyze` tool 内部 |
| RiskEngine | `src/main/core/risk-engine.ts` | `risk_evaluate` tool |
| Credibility (D-S+PCR5) | `src/main/core/agent/credibility/*.ts` | `confidence_assess` tool |
| SSH 连接管理 | `src/main/services/ssh/` | 由 Hermes SSH 后端替代 |
| MCP Tools | `src/main/core/agent/tools/` | 改写为 Hermes tools |
| 内置 Skill | `src/main/services/skills/builtin/` | 迁移为 `.md` skill |
| 前端 UI | `src/renderer/` | 废弃，终端 TUI 替代 |
| IPC 层 | `src/main/ipc/` | 废弃，同进程调用 |

### 11.2 Python 后端直接复用映射

| 当前 Python 模块 | 路径 | 终端 Agent 角色 | 复用方式 |
|-----------------|------|----------------|----------|
| RiskEngine | `projects/src/tdsf/core/risk_engine.py` | `risk_evaluate` tool | 整体导入，封装为 Hermes tool |
| ConfidenceCalculator | `projects/src/tdsf/core/confidence.py` | `confidence_assess` tool | 整体导入 |
| LangGraph nodes | `projects/src/tdsf/graph/nodes.py` | PAOR 编排参考 | 逻辑复用，改写为 Hermes 工作流 |
| Sidecar-A | `tdsf-linux-desktop/sidecar-a/main.py` | `log_analyze` 服务 | 作为子进程/HTTP 服务 |

### 11.3 代码迁移策略

```
现有代码库                    新方案中的角色
─────────────────────────────────────────────────
tdsf-linux-desktop/
├── src/main/core/agent/
│   ├── paor-loop.ts         → 迁移为 Hermes tool (Python 重写或 TS 子进程)
│   ├── ground-check.ts      → 迁移为 ground_check tool
│   ├── drain3/              → 迁移为 log_analyze tool 的内部模块
│   ├── risk-engine.ts       → 迁移为 risk_evaluate tool
│   └── credibility/         → 迁移为 confidence_assess tool
├── src/main/core/ssh/       → 不再需要（Hermes SSH 后端替代）
├── src/renderer/            → 不再需要（终端 TUI 替代）
└── tests/                   → 核心算法测试可复用

projects/
├── src/tdsf/core/risk_engine.py    → 直接作为 risk_evaluate tool
├── src/tdsf/core/confidence.py     → 直接作为 confidence_assess tool
└── src/tdsf/graph/nodes.py         → PAOR 循环编排参考

linux_teaching_system/       → 教程内容迁移为 markdown 知识库
tdsf-linux/ (Streamlit MVP)  → 保留作为 Web 演示备选
```

### 11.4 具体迁移示例：RiskEngine → Hermes Tool

**当前 Python 实现**（`projects/src/tdsf/core/risk_engine.py`）：

```python
class RiskEngine:
    def assess(self, command: str, target_asset: str = "") -> RiskAssessment:
        # 4 层风控：语法检查 → 风险等级 → 确认/审计 → 环境关键性
        ...
```

**Hermes Tool 封装**：

```python
# tdsf-opsagent/tools/risk_evaluate.py
from tdsf.core.risk_engine import RiskEngine

engine = RiskEngine("config/risk_rules.yaml", "config/assets.yaml")

async def risk_evaluate(command: str, target_asset: str = "") -> dict:
    result = engine.assess(command, target_asset)
    return {
        "risk_level": result.risk_level.value,
        "requires_confirmation": result.requires_confirmation,
        "requires_audit_log": result.requires_audit_log,
        "is_irreversible": result.is_irreversible,
        "matched_rule": result.matched_rule_name,
    }
```

### 11.5 具体迁移示例：Ground-Check → Hermes Tool

**当前 TS 实现**（`tdsf-linux-desktop/src/main/core/grounding.ts`）：

```typescript
export function verifyEvidence(evidence: Evidence, toolCallLog: ToolCallRecord[]): boolean {
  if (evidence.source === 'knowledge') return true
  if (toolCallLog.length === 0) return false
  for (const record of toolCallLog) {
    if (isEvidenceFromToolCall(evidence, record)) return true
  }
  return false
}
```

**迁移方式**：
- 方案 A（推荐）：改写为 Python，作为 Hermes `ground_check` tool
- 方案 B：保持 TS，通过子进程/HTTP 供 Hermes 调用
- 核心逻辑不变：内容匹配 + 来源匹配 + 时序合理

---

## 十二、参赛叙事与演示场景

### 12.1 演示场景编排

**场景 1: 实时诊断（3 分钟）**

```
$ tdsf-ops connect root@192.168.1.100
[已连接] 正在采集系统基线...

> 服务器最近总是卡顿，帮我看看怎么回事

🤔 规划诊断路径...
   1. 系统负载概览
   2. 磁盘 I/O 分析
   3. 网络连接状态
   4. 应用日志扫描
   确认执行? [Y/n]

> y

⚡ 执行中...
   ✓ top: CPU 85%, load average 4.2
   ✓ iostat: /dev/sda await=180ms ⚠️
   ✓ ss: 连接数正常
   ✓ journalctl: 发现 OOM killer 记录

🔍 证据分析:
   [高置信 0.85] 磁盘 I/O 瓶颈 + 历史 OOM 事件
   证据链: iostat → 高await → 进程阻塞 → 内存堆积 → OOM

💡 建议:
   1. 检查 /var/log 是否有异常大文件写入
   2. 考虑增加 swap 或升级 SSD
   3. 设置 cgroup 限制单进程内存

> 帮我看看是什么在写磁盘

⚡ iotop -o ...
   PID 1234 (backup.sh) 写入 45MB/s

🎯 根因定位: 定时备份脚本在业务高峰期运行
   建议: 调整 crontab 到凌晨执行
   风险: LOW（仅修改 cron 时间）
   执行? [Y/n]
```

**场景 2: 教学模式（2 分钟）**

```
> /learn 进程管理

📚 找到教程: tutorials/01-linux-basics/03-processes.md
   正在为你讲解...

   Linux 进程管理核心概念:
   - 每个进程有唯一 PID，由 init(PID=1) 派生
   - 状态: R(运行) S(睡眠) D(不可中断) Z(僵尸) T(停止)

   实践: 试试输入 `ps aux | grep nginx` 看看当前 nginx 进程

> ps aux | grep nginx
   root  1234  0.5  2.1  nginx: master process
   www   1235  0.3  1.8  nginx: worker process

   很好! 你看到了 master-worker 模型...
   [自动记录学习进度到 skills/linux-basics-progress.md]
```

**场景 3: 经验进化（1 分钟）**

```
> /skills

📋 已沉淀技能 (12):
   ★ io_bottleneck_diagnosis    [使用 8 次, 成功率 87%]
   ★ memory_leak_detection      [使用 5 次, 成功率 80%]
   ★ network_latency_trace      [使用 3 次, 成功率 100%]
   ...

> /memory search "磁盘"

🔍 找到 3 条相关决策记录:
   2026-07-25: 磁盘I/O瓶颈 → 备份脚本调整 [conf=0.85]
   2026-07-20: 磁盘空间不足 → 日志轮转 [conf=0.92]
   2026-07-18: 磁盘坏道 → 更换硬盘 [conf=0.78]
```

---

## 十三、实施路线图：6 天冲刺 + 4 周 MVP

### 13.1 6 天比赛冲刺（终端 Agent 方向，2026-07-25 → 07-30）

| 天数 | 里程碑 | 关键任务 |
|------|--------|----------|
| D1 (7/25) | 基座搭建 | 安装 Hermes Agent，跑通基本对话；配置 SSH 终端后端；创建 AGENT.md |
| D2 (7/26) | 核心 Tools | 实现 `ssh_diagnose` / `log_analyze` / `risk_evaluate` |
| D3 (7/27) | PAOR + Ground-Check | 实现 PAOR 循环编排 + Ground-Check 证据溯源 |
| D4 (7/28) | 知识库 + 教学 | 迁移教程为 markdown；实现 `explain_command` / `tutorial_guide` |
| D5 (7/29) | 演示打磨 | 编排 3 个演示场景；asciinema 录屏；离线演示方案（Ollama） |
| D6 (7/30) | 提交材料 | PPT / 技术方案书 / 代码仓库整理 / 提交 |

### 13.2 4 周产品化 MVP（比赛后，2026-08-01 → 08-28）

**Week 1：基座 + 核心**
```
[ ] 确定 Hermes 为 Agent 基座，跑通 SSH 后端
[ ] 迁移 PAOR / Ground-Check / RiskEngine 为 Hermes tools
[ ] 实现 Markdown 知识库索引
[ ] （可选）Tauri 2 项目初始化
```

**Week 2：能力完善**
```
[ ] 实现 Drain3 日志分析 tool
[ ] 实现置信度融合 tool
[ ] 实现 Skill 自动沉淀
[ ] 实现多模型路由（国产模型 + Ollama）
```

**Week 3：UI 与教学**
```
[ ] （可选）Tauri 2 GUI 外壳：分屏 SSH + Agent 面板
[ ] 迁移 5 个内置 Skill 为 markdown
[ ] 实现教学模式（/learn 命令）
[ ] 实现 /skills /memory 命令
```

**Week 4：打包与发布**
```
[ ] E2E 测试
[ ] asciinema 演示视频
[ ] Windows 安装包（Hermes CLI 或 Tauri）
[ ] v0.1.0 内测发布
```

---

## 十四、风险与决策建议

### 14.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 比赛交付延期 | 低 | 高 | 桌面端已有 16,000 行代码，仅需 Bug 修复 |
| Hermes 学习曲线 | 中 | 中 | Python 文档完善，社区活跃；已有源码可分析 |
| 已有代码废弃感 | 低 | 中 | 核心算法 100% 复用，只是换了载体 |
| 评委不接受终端形态 | 低 | 中 | "运维就该在终端"是强叙事；可加 hermes-workspace Web UI 辅助 |
| 演示环境网络问题 | 中 | 高 | 支持本地模型（Ollama），离线可演示 |
| 代码同步分裂 | 中 | 中 | 共享 Agent 核心算法，两端 tools 保持一致接口 |
| 双支并行资源分散 | 中 | 高 | 桌面端仅限 Bug 修复；终端 Agent 由专人冲刺，每日同步 15 分钟 |
| 开源协议风险 | 低 | 中 | Hermes/OpenCode 均为 MIT/Apache-2.0；terax-ai 许可证未标注，仅借鉴设计不 fork |

### 14.2 关键决策建议

| 决策点 | 建议 | 理由 |
|--------|------|------|
| **桌面端是否继续维护？** | ✅ 比赛后冻结，Bug 修复级别 | 16,000 行代码资产，教学场景仍然需要 |
| **终端 Agent 基座？** | ✅ **Hermes Agent** | 自我进化 + SSH 原生 + 技能系统 + 220k stars |
| **终端 UI 形态？** | ✅ 先用 Hermes CLI，中期套 Tauri 2 GUI | CLI 跑得快，GUI 产品化 |
| **知识库形态？** | ✅ Markdown + Git | AI 原生可读 + 人类原生可读 |
| **共享核心怎么管理？** | ✅ Python/TS 算法库，两端 tools 一致接口 | 一份算法，多种形态 |
| **是否 fork Hermes？** | ❌ 不 fork | 封装为 tools/skills 接入，保持上游更新能力 |
| **是否 fork terax-ai？** | ❌ 不 fork | 仅借鉴设计模式（CSS变量、Motion Tokens），不依赖其代码 |

### 14.3 备选方案（如果 Hermes 不合适）

| 方案 | 适用条件 | 优劣 |
|------|----------|------|
| **OpenCode + 自定义 tools** | 想保持 TypeScript 生态 | 复用现有代码更容易，但缺少 Hermes 的学习循环 |
| **Grok Build fork** | 想要最极致的 TUI 体验 | Rust 门槛高，6 天内难以深度定制 |
| **Terax 作为 IDE 壳** | 想要"终端 IDE"而非纯 Agent | 有编辑器/文件管理，但 Agent 能力需自建 |
| **OpenSquilla 微内核** | 想要最灵活的架构 | Python，微内核设计优雅，但社区较小 |
| **自建轻量 Agent** | 完全掌控 | 用 Ink (React for CLI) + ssh2 + 现有算法，最灵活但工作量最大 |

### 14.4 一句话总结

> **桌面端守住比赛 + 终端 Agent 开启新赛道。以 Hermes Agent 为基座，把 TDSF 的 PAOR 循环、Ground-Check、4 层风控、Drain3 置信度封装为 tools，Markdown 作为知识库载体。6 天可做出比赛 Demo，4 周可出产品化 MVP。**

---

## 附录 A：全项目 Agent 资产索引

### A.1 源码资产

| 路径 | 说明 |
|------|------|
| `tdsf-linux-desktop/src/main/core/agent/` | ~80 文件，Agent 核心全部 |
| `tdsf-linux-desktop/src/main/services/skills/builtin/` | 5 个内置 Skill |
| `tdsf-linux-desktop/src/main/services/ssh/` | SSH 连接管理器 |
| `projects/src/tdsf/core/` | Python 版决策/风险/置信度/LangGraph |
| `projects/local-linux-agent/` | Linux 教学 Agent + 7 个知识库 |

### A.2 调研报告资产

| 路径 | 说明 |
|------|------|
| `reports/tdsf-terminal-agent-full-research.md` | 14 个终端 Agent 深度调研 |
| `reports/终端Agent转型可行性调研-2026-07-25.md` | 本优化参考文档 |
| `terax-ai-设计分析报告.md` | terax 设计全分析 |
| `tdsf-translate-v140/docs/skill-research/00-05` | 5 份运维 Skill 调研 |
| `docs/idea-to-dev-output/` | 30+ 份开发方案/调研报告 |

### A.3 开源项目源码（已下载）

| 目录 | 项目 |
|------|------|
| `opensource-reference/terax-ai/` | terax-ai（Tauri 2 终端 IDE） |
| `opensource-reference/grok-build/` | Grok Build |
| `opensource-reference/cline/` | Cline |
| `opensource-reference/aider/` | Aider |
| `opensource-reference/mastra/` | Mastra |
| `opensource-reference/OpenHands/` | OpenHands |

---

## 附录 B：terax-ai 关键文件参照

| terax 文件 | TDSF 对应位置 | 借鉴内容 |
|------------|-------------|----------|
| `src/styles/globals.css` | `terminal/src/styles/globals.css` | CSS 变量、动画、xterm 覆盖 |
| `src/styles/tokens.ts` | `terminal/src/styles/tokens.ts` | 终端令牌读取 |
| `src/styles/terminalTheme.ts` | `terminal/src/styles/terminalTheme.ts` | xterm ITheme 构建 |
| `src/modules/theme/applyTheme.ts` | `terminal/src/theme/applyTheme.ts` | 主题应用核心 |
| `src/modules/theme/ThemeProvider.tsx` | `terminal/src/theme/ThemeProvider.tsx` | React Context |
| `src/modules/terminal/lib/useTerminalSession.ts` | `terminal/src/terminal/useTerminalSession.ts` | PTY 生命周期 |
| `src/modules/terminal/lib/rendererPool.ts` | `terminal/src/terminal/rendererPool.ts` | xterm 实例池化 |
| `src/modules/terminal/lib/osc-handlers.ts` | `terminal/src/terminal/osc-handlers.ts` | Shell 集成 |
| `src-tauri/Cargo.toml` | `src-tauri/Cargo.toml` | Rust 依赖与构建优化 |

---

> **下一步**：评审本方案书 → 确认 Hermes 基座 + 6 天冲刺路线 → 比赛结束后开始产品化 MVP
