# Agent 开发文档中心（docs/agent/）

> **建立时间**：2026-08-28
> **目的**：把散落在上级目录的 agent 调研/方案书/源码分析文档集中收纳，并索引项目内现存 agent 文档与上级目录开源源码，形成 agent 开发的**单一资料入口**。
> **配套**：下一步开发方向见同目录《方案书-v3.0-Agent能力升级.md》；当前架构事实见《../Agent架构说明书.md》。

---

## 一、目录结构

```
docs/agent/
├── INDEX.md                                    ← 本文件（资料索引）
├── 方案书-v3.0-Agent能力升级.md                  ← 下一步 agent 开发方案（本目录产出）
├── 调研报告-2026-Agent架构能力全景与DeepSeekHarness.md ← 2026-08-28 联网深度调研
├── 外部资料/                                    ← 上级目录散落的方案书/调研（已复制归档）
│   ├── TDSF高质量做大方案-终稿.md                （项目总方案终稿）
│   ├── TDSF-Linux-技术方案书.md                 （早期技术方案书）
│   ├── terax-ai-设计分析报告.md                  （上游 terax 架构分析）
│   ├── AI辅助开发-调研报告.md                    （AI 辅助开发模式调研）
│   ├── 开源项目复用清单.md                       （开源项目复用评估清单）
│   ├── 运维AI决策可信度调研方案.md                （可信度模块调研）
│   ├── 开发方向优化报告.md                       （开发方向复盘）
│   ├── 项目救援盘点.md                           （历史资产盘点）
│   ├── 千问参考.md / 豆包参考.md                 （国产模型 agent 能力参考）
│   └── SKILL.md                                （references/technical 技能文档）
└── idea-to-dev/                                ← idea-to-dev skill 全量输出（46 份，历史演进完整档案）
```

## 二、idea-to-dev/ 索引（46 份，按主题分组）

### 方案书迭代链（v0.9 → v9.0，看架构决策演进）
- 06/08/13/14/17：《最终开发方案书》→ v4.0 → v7.0 → v8.0 课程一体化 → v9.0 AI 原生运维 IDE
- 23/26：《方案书 v0.9 Agent架构与AI集成》及修订版（质量优先实施）
- 45：《后端与Agent架构规划 v2.0》
- 37：《工业级方案全量集成路线图》
- 27：《豆包方案评估 + 9条红线调整 + 开源Agent整合方案》

### 开源 Agent 源码分析（每份 = 一家框架拆解）
| 文档 | 主题 | 对本项目最大借鉴点 |
|------|------|--------------------|
| 20 | Claude Code 源码与集成可行性 | agent loop、工具审批、subagent |
| 28 | Cline（VSCode 扩展型） | 计划/执行分离、人工审批 UI |
| 29 | KiloCode 多模式 Subagent | 多模式（code/architect/ask）切换 |
| 30 | ContinueDev 多模型调度 | 多模型路由、代码库索引 |
| 31 | Aider 终端优先与 git 沙箱回滚 | 终端优先交互、git 安全回滚 |
| 24/25 | Mastra 框架 / OpenHands 沙箱 | 工作流编排 / 沙箱执行 |
| 33/34 | claw-code / grok-build | 轻量 agent 实现 |
| 19/21 | Grok-Code 架构 / 高新 Agent 架构选型 | 选型方法论 |
| 16/18 | AI Agent 编码架构 / AI 编程沙箱方案 | 编码 agent 通用结构 |

### 专项调研
- 07 系列：AI Agent 生态 / AIOps 2025 / SSH 远程操控 / databuff / itops-agent-platform / yanlong-ai
- 15/18：WebIDE 与 SSH 文件管理集成 / AI 编程沙箱
- 22/35/40：可信度算法论文支撑 / 可信度开发进度 / CoT-shape 熵轨迹置信度（→ 已落地为 confidence_tool + evidence）
- 27：《Bash 命令解析库选型-危险命令识别》（→ RiskChecker 前身）
- 43：《Trace 收集架构设计》
- 32：《补充运维 Agent 深度调研-第二期》

### 历史冲刺归档
- 38/41：v1.0 / v1.5 一周冲刺交付物归档
- 39：RTL 组件测试调研
- 42/44：问答归档 v1.5 / v1.6
- 36/46：约束审计 / v2.1 功能修复循环工程规划

## 三、项目内现存 agent 文档（docs/ 下，未移动，引用链保持）

| 文档 | 内容 |
|------|------|
| `docs/Agent架构说明书.md` | **当前架构事实**：Strands 单框架 / main+4 子 agent / 事件协议 / 四层安全 |
| `docs/方案书-v2.0.md` | **唯一开发方向准绳**：里程碑 M0-M4 |
| `docs/PLAN-AGENT-DEEP-EVOLUTION.md` | Agent 深度进化方案（P0-P3 已全部完成） |
| `docs/开源AI运维终端-竞品对比与借鉴规划.md` | Chaterm/nyaterm/Netcatty 全量源码分析 + B1-B4 借鉴分期（B1 已落地） |
| `docs/reports/ops-agent-opensource-survey-2026-07*.md`（v1-v5） | 运维 agent 开源调研系列（5 轮迭代） |
| `docs/reports/terax-agent-architecture-analysis.md` / `-research.md` | 上游 terax agent 架构分析 |
| `docs/reports/tdsf-ai-agent-gap-analysis.md` | 能力差距分析 |
| `docs/reports/strands-*`（3 份） | Strands 集成方案 / 后端审计 / 实施计划 |
| `docs/reports/modded-agent-*.md`（8 份） | 魔改后 agent 代码审查/可用性审计/深度审计 |
| `docs/reports/ops-agent-deep-research.md` 等 | 运维 agent 深度调研 |

## 四、上级目录开源源码地图（源码不复制，按位置引用）

### `../opensource-reference/`（开源项目全量 clone）
| 项目 | 与本项目关系 | 借鉴重点 |
|------|-------------|---------|
| `terax-ai` | **上游基线**（本项目 = 其魔改版） | 架构对照基准 |
| `cline` / `kilo-code` / `qwen-code` / `aider` / `crush` / `kimi-cli` | 编码 agent 参考 | 工具审批 / subagent / 终端交互 |
| `OpenHands` / `MetaGPT` / `crewAI` / `mastra` | 通用 agent 框架 | 编排 / 沙箱 / 角色分工 |
| `Chaterm` / `Netcatty` / `nyaterm` / `electerm` / `tabby` | SSH 终端竞品（B1-B4 借鉴分期来源） | AI 终端融合、AgentRuntime token 治理 |
| `russh` / `ssh2-rs` / `bollard` | Rust 基础库 | 已在用 |
| `wezterm` / `theia` / `cmux` / `ht` / `ht-mcp` | 终端/IDE 参考 | PTY 处理、MCP 桥 |
| `headroom` | token 上下文优化 | compaction 参考 |
| `bohay` / `synara` / `orca` / `Vibo` / `BitFun` / `databuff` | 其他参考 | 见各项目 README |

### `../projects/`（运维决策 agent 独立项目，LangGraph 版）
- `src/tdsf/graph/`（builder/edges/nodes/state）：7 节点 PAOR 图编排
- `src/tdsf/core/`：confidence（置信度）/ grounding（事实接地）/ llm_client / sampling
- `src/tdsf/tools/`：log_tools
- **状态**：已被 strands_backend 取代（主路径不执行），但 confidence/grounding 思想已移植为 `strands_backend/tools/confidence_tool.py` + `evidence.py`

### `../config/projects/`（coze agent 项目）
- `src/agents/agent.py`：Coze 平台 agent 配置参考

## 五、使用约定

1. **找当前架构** → `docs/Agent架构说明书.md`（唯一事实源）
2. **找下一步做什么** → 本目录《方案书-v3.0-Agent能力升级.md》+ `docs/ROADMAP.md`
3. **找某框架怎么实现的** → idea-to-dev/ 源码分析编号文档 → 需要更深再看 `../opensource-reference/` 源码
4. **找历史决策为什么这么定** → idea-to-dev/ 方案书迭代链 + docs/reports/ 系列
5. 本目录文档为**归档副本**，以各文档内标注的原始位置为准；`../opensource-reference/` 源码更新状态不受本目录跟踪
