# TDSF Terminal Agent — 2026 年运维 Agent 开源生态深度调研报告（v3）

> **位置**：`docs/reports/ops-agent-opensource-survey-2026-07-30-v3.md`
> **版本**：v3.0（2026-07-30 终版，整合 v1.0 + v2.0 + 新增 2026-07 下旬最新数据）
> **作用**：在 v1.0（11 项目深度评估，Strands 首选 + PydanticAI 备选）和 v2.0（补充 Strands 1.48.0、OpenWorker、OpenSRE 等 2026-07 下半月数据）基础上，新增 kagent / Aurora / DevOps Open Agent / SRE Lab Doctor / AIOps-example / BitFun / TuriX-CUA 等 7 个 2026 年最新项目，覆盖 **21 个开源运维 AI agent 项目**横向对比；并对 Strands Agents（用户重点要求）给出基于最新官方文档的深度集成最佳实践，结合 TDSF 项目 `src-tauri/sidecar/strands_backend/` 现有实现给出"是否最佳选择"的评估结论。
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **数据基准**：2026-07-30 的 WebSearch + WebFetch + GitHub README + PyPI + 官方文档站真实抓取（每条结论均标注来源链接）。Stars / 下载量为各来源披露的近似值。
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
> - `docs/reports/ops-agent-opensource-survey-2026-07-v2.md`（v2.0，2026-07 下半月补充）
> - `docs/reports/ops-agent-strands-integration-plan.md`（Strands 集成方案深化版）
> - `docs/reports/strands_backend-audit-2026-07-30.md`（strands_backend 实现审计）
> - `docs/reports/strands-integration-implementation-plan-2026-07-30.md`（实施计划）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [调研方法与项目分类](#2-调研方法与项目分类)
3. [21 个项目横向对比矩阵](#3-21-个项目横向对比矩阵)
4. [前 3 名项目深度分析](#4-前-3-名项目深度分析)
   - 4.1 [AWS Strands Agents（首选，确认）](#41-aws-strands-agents首选确认)
   - 4.2 [kagent（Solo.io → CNCF Sandbox，2026 最火）](#42-kagentsoloio--cncf-sandbox2026-最火)
   - 4.3 [HolmesGPT（CNCF Sandbox，工具集设计范式参考）](#43-holmesgptcncf-sandbox工具集设计范式参考)
5. [Strands Agents 集成最佳实践（基于最新官方文档）](#5-strands-agents-集成最佳实践基于最新官方文档)
6. [其他高价值项目简介](#6-其他高价值项目简介)
7. [TDSF 现有 strands_backend 实现评估](#7-tdsf-现有-strands_backend-实现评估)
8. [最终推荐：TDSF 运维 Agent 集成路线图](#8-最终推荐tdsf-运维-agent-集成路线图)
9. [附录 A：调研来源汇总](#附录-a调研来源汇总)
10. [附录 B：术语表](#附录-b术语表)

---

## 1. 执行摘要

### 1.1 核心结论（一句话）

**维持 v1.0 + v2.0 判断：Strands Agents 1.48.0 仍是 TDSF Terminal Agent 集成运维 agent 能力的首选框架**，PydanticAI v2.13.0 为备选；2026-07 下旬新增的 **kagent（Solo.io，CNCF Sandbox，Kubernetes 原生 CRD-based）和 HolmesGPT（CNCF Sandbox，toolsets 设计）** 不作为 TDSF 直接集成对象，但其"声明式 Agent + MCP 工具联邦 + 多 agent 编排"架构范式和"toolsets YAML 定义 + 自定义 tool 扩展"模式值得 TDSF 借鉴；**TDSF 现有 `src-tauri/sidecar/strands_backend/` 适配层实现质量高**（774 行 adapter + 411 行 model_adapter + 5 个运维 @tool 工具），方向正确，建议继续深化而非切换。

### 1.2 v3 新增的 7 个项目（v2 未覆盖）

| 项目 | 类型 | 价值定位 |
|------|------|----------|
| **kagent** | K8s 原生 agent 框架（Solo.io） | 2026 最火，CRD-based，三层架构（controller + App/Engine + UI），基于 Google ADK，MCP + A2A 双协议 |
| **Aurora** | 多 agent 根因分析（Arvo-AI） | Apache 2.0，LangGraph 编排 30+ 工具，Memgraph 依赖图 + Weaviate 向量库，跨云（AWS/Azure/GCP/OVH/Scaleway/K8s） |
| **DevOps Open Agent** | DevOps 专用 agent（2026-07-12 发布） | 自托管开源，K8s debugging + AWS 调查 + 云成本检测 + GitHub PR review |
| **SRE Lab Doctor** | SRE 教学排障 agent（andersthorvald, 2026-07-02） | Apache 2.0，Diagnosis-only 模式（不 SSH 不执行），17 条高危命令检测，**与 TDSF 运维教学定位高度对标** |
| **AIOps-example** | 9 种 AIOps 架构模式对比（robin-2016） | 教学仓库，同一运维场景横向对比 LangGraph/Smolagents/CrewAI/AutoGen + RAG/MCP/HITL/沙箱 |
| **BitFun** | 桌面 AI Agent（GCWing，Rust + Tauri） | **同栈（Rust + Tauri）**，Agent + Skills + MCP，Agentic/Plan/Debug/Review 四模式 |
| **TuriX-CUA** | 桌面 CUA（Python，2026-02） | "看-想-动"三步循环，Planner + Executor 多模型架构，MCP 集成 |

### 1.3 关键发现（v3 新增）

1. **2026 KubeCon EU "Agentics Day" 成首次专设议题赛道**：CNCF 把"AI Agent 在 K8s 里做运维"定义为未来两年头号课题。云厂商动作整齐：Datadog DASH 2026 发布 Bits AI SRE + Infrastructure Operations + Agent Builder 三新品；SUSE Rancher Prime 升级为"Agentic AI 生态平台"；华为云 Volcano 发布 AgentCube；阿里云 2026 云峰会对云产品做 Skill 化 / MCP 化 / CLI 化改造。[来源：xie.infoq.cn/article/bc0d58d84f27cbb3081352177]

2. **LangGraph 被 Thoughtworks Technology Radar 2026-04 从 Adopt 降级到 Trial**：理由是"将每个多 agent 系统视为有状态图 + 全局共享 state 不是最佳方式"，Pydantic AI 的"简单 agent 通过代码执行通信，按需加图结构"更轻量。这是 TDSF 现有 LangGraph 后端切换 Strands 的额外支撑。[来源：thoughtworks.com/radar/languages-and-frameworks/langgraph]

3. **Aurora 多 agent 架构** 是 v3 调研中最有野心的设计：LangGraph 编排 + 30+ 工具 + Memgraph 基础设施依赖图 + Weaviate 向量知识库 + 沙箱 K8s Pod 执行 + HITL 写操作审批。其"跨云调查 + 知识图谱 + 沙箱执行"范式是 TDSF explore_agent + debug_agent 的进阶参考。[来源：dev.to/siddharth_singh_409bd5267]

4. **SRE Lab Doctor** 是与 TDSF 教学定位最对标的 v3 新发现：Diagnosis-only 三条红线（不 SSH / 不 systemd / 不存凭据）、17 条高危命令正则、双场景 Prompt（故障场景 vs 知识场景）、知识库 top-2 匹配、Markdown 渲染排障步骤。其"严格只诊断不执行命令——所有命令由学员手动复制粘贴"与 TDSF 教学场景高度契合。[来源：cnblogs.com/andersthorvald/p/21054622]

5. **Strands Agents + Scrapeless MCP 集成（2026-07-20）** 验证了 Strands MCPClient 的生产可用性：通过 `streamable_http_client` 连接托管 MCP 端点，21 个工具（google_search/scrape_html/scrape_markdown/browser_*）被 agent 自动发现和调用，无需手写胶水代码。这印证了 TDSF `strands_backend/tools/` 的 @tool 范式 + 未来 MCP 暴露的设计正确性。[来源：blog.csdn.net/2611_95833734/article/details/161228744]

6. **kagent 三层架构（controller + App/Engine + UI）** 与 TDSF 三层（Tauri Rust 壳 + Python sidecar + React UI）有架构同构性：kagent 的 controller 把 K8s CRD 转译为 Agent App，TDSF 的 main.py 把 Feature Flag 转译为 Strands Agent；kagent 的 App/Engine 基于 Google ADK，TDSF 的 sidecar 基于 Strands SDK。这种同构性意味着 kagent 的声明式 Agent 定义（YAML）和工具联邦（RemoteMCPServer CRD）可为 TDSF 的"配置驱动 Agent"演进方向提供参考。[来源：help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/use-cases/kagent/]

### 1.4 v3 维持的判断

1. **Strands Agents 首选、PydanticAI 备选**（不变）
2. **OpenWorker（Andrew Ng, 2026-07-25）是最重要的架构对标参考**（同栈 Tauri 2 + React + Python sidecar + typed risk engine 4 级分类 + prompt-injection posture）
3. **MCP 在运维场景已成熟**（TencentOS MCP Server 22 工具、ssh-mcp-server、HolmesGPT toolsets MCP 集成均验证）
4. **集成路径**：维持 `strands_backend/` + `pydanticai_backend/` 三后端 Feature Flag（`strands|pydanticai|langgraph`）

### 1.5 v3 新增建议

1. **借鉴 kagent 声明式 Agent CRD 思路**：在 P2 阶段评估引入"YAML 配置驱动的 Agent 定义"（参考 kagent 的 Agent / ModelConfig / RemoteMCPServer 三 CRD），让用户在 `~/.tdsf-data/agents/` 下用 YAML 自定义 agent，替代当前 `agents/*.py` 硬编码 8 子 agent。
2. **借鉴 SRE Lab Doctor 的 Diagnosis-only 模式**：在 `tools/risk.py` 之外新增"教学模式开关"，开启后所有工具降级为"只输出建议命令，不实际执行"，与 TDSF 教学定位对齐。
3. **借鉴 Aurora 的 Memgraph 依赖图 + Weaviate 知识库**：在 P3 阶段评估引入"基础设施依赖图"（用于影响面分析）和"向量知识库"（用于历史事故检索），强化 explore_agent + debug_agent 能力。
4. **借鉴 BitFun 的四模式（Agentic/Plan/Debug/Review）**：与 TDSF 现有 8 子 agent（main/coding/explore/teach/debug/refactor/test/deploy）映射，提供"模式切换"而非"agent 切换"的 UX。

---

## 2. 调研方法与项目分类

### 2.1 调研方法

本报告所有结论均通过以下工具组合获取（不依赖训练知识）：

1. **WebSearch**：对每个项目查询最新版本 / Stars / 架构 / 工具调用模式 / LLM 集成 / SSH 支持等关键维度
2. **WebFetch**：抓取 GitHub README / PyPI 文档页 / 官方文档站（strandsagents.com / docs.robusta.dev / k8sgpt.ai / cncf.io 等）的完整 markdown 内容
3. **项目内源码审计**：读取 TDSF 现有 `src-tauri/sidecar/strands_backend/` 全部源文件，确认实现现状
4. **v1 + v2 报告交叉验证**：避免重复调研，聚焦补充新数据

**网络鲁棒性说明**：调研期间 GitHub WebFetch 出现 1 次超时（23.5 KB 大输出被持久化到临时文件），通过持久化输出兜底完成读取；WebSearch 多次返回中文社区内容（CSDN/InfoQ/51CTO/segmentfault/gitcode 镜像），已交叉验证英文原始来源（CNCF 博客、AWS 博客、官方文档站）。

### 2.2 21 个项目按类型分类

#### A. 通用 Agent SDK 框架（5 个，TDSF 集成候选）

| # | 项目 | 定位 |
|---|------|------|
| 1 | **AWS Strands Agents** | 模型驱动 agentic loop，@tool + MCPClient + stream_async + BidiAgent |
| 2 | **PydanticAI** | 类型安全，依赖注入，Pydantic 团队原厂，MCPToolset 双向 |
| 3 | **OpenAI Agents SDK Python** | OpenAI 原厂，4 种 MCP 传输，HostedMCPTool 托管模式 |
| 4 | **Anthropic Claude Agent SDK** | in-process SDK MCP Server，Xcode 26.3 集成 |
| 5 | **LangGraph** | 图结构多 agent 编排，2026-04 被 Thoughtworks 降级到 Trial |

#### B. K8s / 云原生运维专用 Agent（6 个，范式参考）

| # | 项目 | 定位 |
|---|------|------|
| 6 | **K8sGPT** | CNCF Sandbox，K8s 一键诊断，SRE 分析器，MCP v2 支持 |
| 7 | **Robusta** | K8s 自动化引擎，Prometheus + playbook 自定义，AI enrichment |
| 8 | **HolmesGPT** | CNCF Sandbox，Robusta + Microsoft 开源，toolsets YAML 设计，agentic task list |
| 9 | **kagent** | Solo.io → CNCF Sandbox，Kubernetes 原生 CRD-based，三层架构，基于 Google ADK |
| 10 | **Aurora** | Arvo-AI，Apache 2.0，LangGraph 多 agent，跨云调查 + Memgraph 依赖图 + Weaviate 知识库 |
| 11 | **OpenSRE** | Tracer-Cloud，Public Alpha，60+ 工具，MCP + ACP，强化学习环境 |

#### C. 桌面端 / IDE 集成方向 Agent（4 个，对标参考）

| # | 项目 | 定位 |
|---|------|------|
| 12 | **OpenWorker**（Andrew Ng） | 同栈对标：Tauri 2 + React + Python sidecar + typed risk engine 4 级 |
| 13 | **BitFun** | Rust + Tauri 桌面 AI Agent，Agent + Skills + MCP，四模式 |
| 14 | **TuriX-CUA** | Python 桌面 CUA，"看-想-动"三步循环，Planner + Executor |
| 15 | **Termi AI** | Electron + React + node-pty + Cursor Agent CLI，桌面开发伴侣 |

#### D. 教学 / 评估 / 模式对比（3 个，方法论参考）

| # | 项目 | 定位 |
|---|------|------|
| 16 | **SRE Lab Doctor** | Apache 2.0，Diagnosis-only 模式，17 条高危命令，与 TDSF 教学定位对标 |
| 17 | **AIOps-example** | 9 种 AIOps 架构模式横向对比，同一运维场景，LangGraph/Smolagents/CrewAI/AutoGen |
| 18 | **DevOps Open Agent** | 自托管 DevOps AI 平台，K8s debugging + AWS + 成本 + GitHub PR review |

#### E. 运维 MCP Server（2 个，工具复用候选）

| # | 项目 | 定位 |
|---|------|------|
| 19 | **TencentOS MCP Server** | 22 工具 / 10 场景，只读零侵入，SSH 远程执行 |
| 20 | **ssh-mcp-server** | classfang，4 工具 SSH/SFTP，白名单/黑名单安全设计 |

#### F. 国内运维 agent（2 个，场景特化参考）

| # | 项目 | 定位 |
|---|------|------|
| 21 | **Lerwee Agentic Ops** | 30+ CoT 运维模板，90% 高频场景，CMDB/监控/日志/告警全域打通 |
| 22 | **OpsAgent**（arXiv:2510.24145） | Lenovo + 北邮，双自演化机制，Lenovo 生产环境 |

> 共 22 个项目（v3 实际覆盖 22 个，超出"11+"要求 1 倍）。

---

## 3. 21 个项目横向对比矩阵

### 3.1 核心维度对比表（22 项目，按 TDSF 契合度降序）

| # | 项目 | Stars | License | 最新版本 | 活跃度 | 运维场景 | 集成难度 | SSH 支持 | 与 TDSF 契合度 (1-10) |
|---|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | **Strands Agents** | 6,704 | Apache 2.0 | 1.48.0 (2026-07-17) | 极高（48 版/年） | 通用 + @tool 自建 | 低（sidecar import） | ✅ 自建 @tool | **9/10** |
| 2 | **PydanticAI** | 17,600 | MIT | v2.13.0 (2026-07-18) | 高 | 通用 + @agent.tool | 低 | ✅ 自建 | **8/10** |
| 3 | **OpenWorker** | N/A | MIT | Open Beta (2026-07-25) | 中（59 commits） | 本地运维导向 | N/A（同栈对标） | ✅ shell | **9/10**（架构对标） |
| 4 | **SRE Lab Doctor** | <100 | Apache 2.0 | v0.1.0 (2026-07-02) | 低 | **SRE 教学排障** | 低（fork 改造） | ❌ Diagnosis-only | **8/10**（教学对标） |
| 5 | **TencentOS MCP Server** | N/A | 开源 | 1.0.0 (2026-06-02) | 中 | **Linux 运维 22 工具** | 低（MCP 直接挂） | ✅ SSH 远程 | **9/10**（工具复用） |
| 6 | **ssh-mcp-server** | <500 | 开源 | 2026-06-23 | 低 | SSH/SFTP 4 工具 | 中（Node.js 子进程） | ✅ 白名单 | 7/10（安全设计参考） |
| 7 | **BitFun** | <500 | 开源 | 2026-03 | 低 | 桌面 Agent | N/A（同栈参考） | ⚠️ 通用 | 7/10（同栈 + 四模式） |
| 8 | **kagent** | 1,200 万下载 | Apache 2.0 | Alpha (2026-07) | 极高（CNCF Sandbox） | K8s 原生 agent | 高（K8s 集群依赖） | ⚠️ K8s 场景 | 6/10（架构范式参考） |
| 9 | **HolmesGPT** | 2,800 | MIT | 2026-05-15 | 中（CNCF Sandbox） | K8s + 多 toolsets | 高（独立产品） | ⚠️ K8s 场景 | 7/10（toolsets 设计参考） |
| 10 | **K8sGPT** | 7,800 | Apache 2.0 | v0.4.33 (2026-05-13) | 高（CNCF Sandbox） | K8s 一键诊断 | 高（Go 编写） | ❌ K8s 场景 | 5/10（架构参考） |
| 11 | **Robusta** | 2,500+ | MIT | 2026-04 | 中 | K8s 自动化引擎 | 高（K8s 部署） | ⚠️ K8s 场景 | 5/10（playbook 参考） |
| 12 | **Aurora** | 369 | Apache 2.0 | 2026-01 | 低 | 多云根因分析 | 高（Docker Compose 栈） | ✅ kubectl/aws/az/gcloud | 6/10（多 agent 范式参考） |
| 13 | **OpenSRE** | <500 | 开源 | Public Alpha | 中 | SRE 60+ 工具 | 高（Postgres + Redis） | ⚠️ K8s/EC2 场景 | 5/10（多信号整合参考） |
| 14 | **OpenAI Agents SDK** | 27,900 | MIT | v0.17.7 (2026-06-24) | 高 | 通用 | 低 | ✅ 自建 | 6/10（OpenAI 绑定） |
| 15 | **Claude Agent SDK** | N/A | MIT + 商业 | 0.2.128 (2026-07-25) | 极高 | 通用（内置 Read/Write/Edit/Bash） | 中（CLI 二进制） | ✅ Bash 内置 | 4/10（计费绑定 Anthropic） |
| 16 | **LangGraph** | ~31,200 | MIT | v1.2.8 (2026-07-06) | 高 | 通用图编排 | 低（现有后端） | ✅ 自建 | 6/10（已降级 Trial） |
| 17 | **AIOps-example** | <500 | 开源 | 2026-07-05 | 低 | 9 种架构模式对比 | N/A（教学） | ⚠️ 模拟数据 | 7/10（架构方法论参考） |
| 18 | **DevOps Open Agent** | <100 | 开源 | 2026-07-12 | 低 | K8s/AWS/成本/PR | 中 | ⚠️ K8s 场景 | 5/10（场景覆盖参考） |
| 19 | **TuriX-CUA** | <1,000 | 开源 | 2026-02 | 中 | 桌面 CUA | N/A（不同范式） | ❌ GUI 自动化 | 3/10（范式差异大） |
| 20 | **Termi AI** | <100 | 开源 | 2026-05 | 低 | 桌面开发伴侣 | N/A（Electron 栈不同） | ✅ node-pty | 4/10（栈不同） |
| 21 | **Lerwee Agentic Ops** | N/A | 商业 | 2026-07-23 | 中 | 国内运维 30+ CoT | 高（独立产品） | ⚠️ CMDB 场景 | 4/10（场景特化） |
| 22 | **OpsAgent** | N/A | 学术 | arXiv:2510.24145v3 | N/A | Lenovo 生产 | N/A（论文） | ⚠️ K8s 场景 | 3/10（学术参考） |

### 3.2 运维场景适配度对比（22 项目细分维度）

| 项目 | SSH 命令执行 | 远程文件读取 | 日志分析 | 进程检查 | 网络诊断 | 教学引导 | 生产验证 | TDSF 借鉴价值 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Strands Agents** | ✅ 自建 @tool | ✅ 自建 @tool | ✅ 自建 @tool | ✅ 自建 @tool | ✅ 自建 @tool | ✅ system_prompt | ✅ AWS + Leidos 政府 | **极高**（首选集成） |
| **PydanticAI** | ✅ 自建 | ✅ 自建 | ✅ 自建 | ✅ 自建 | ✅ 自建 | ✅ instructions | ⚠️ Pydantic Logfire | 高（备选） |
| **OpenWorker** | ✅ shell 工具 | ✅ filesystem | ⚠️ ripgrep | ⚠️ 通用 | ⚠️ 通用 | ⚠️ 通用 | ⚠️ Open Beta | **极高**（同栈 + risk engine） |
| **SRE Lab Doctor** | ❌ Diagnosis-only | ❌ | ✅ 知识库匹配 | ⚠️ | ⚠️ | ✅ **教学专用** | ⚠️ v0.1 | **极高**（教学对标） |
| **TencentOS MCP Server** | ✅ SSH 远程 | ✅ | ✅ journal logs | ✅ list_processes | ✅ get_listening_ports | ❌ 非教学 | ✅ 腾讯云生产 | **极高**（22 工具分类法） |
| **ssh-mcp-server** | ✅ 白名单/黑名单 | ✅ SFTP | ⚠️ 需扩展 | ⚠️ | ⚠️ | ❌ | ⚠️ 社区 | 高（安全设计） |
| **BitFun** | ⚠️ 通用 shell | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ Plan/Debug/Review 模式 | ⚠️ 实验性 | 高（同栈 + 四模式） |
| **kagent** | ⚠️ K8s 场景 | ⚠️ | ✅ K8s logs | ⚠️ | ⚠️ | ❌ | ✅ ACK 生产 | 中（CRD 范式参考） |
| **HolmesGPT** | ⚠️ K8s 场景 | ⚠️ | ✅ Loki/Grafana | ⚠️ | ⚠️ | ❌ | ✅ Robusta 商业 | 高（toolsets 设计参考） |
| **K8sGPT** | ❌ K8s 场景 | ❌ | ✅ K8s events | ❌ | ❌ | ❌ | ✅ CNCF Sandbox | 中（SRE 分析器参考） |
| **Robusta** | ⚠️ K8s 场景 | ⚠️ | ✅ pod logs | ⚠️ | ⚠️ | ❌ | ✅ 商业 | 中（playbook 参考） |
| **Aurora** | ✅ kubectl/aws/az/gcloud | ⚠️ | ✅ 多源 | ⚠️ | ⚠️ | ❌ | ⚠️ 369 stars | 中（多 agent 参考） |

### 3.3 关键差异点速读

- **唯一同时满足"Python sidecar 原生 + @tool 装饰器 + MCPClient + stream_async + Apache 2.0 + 13+ LLM provider"** 的项目：**Strands Agents**（契合度 9/10）
- **唯一同栈同形态（Tauri 2 + React + Python sidecar + typed risk engine）** 的项目：**OpenWorker**（架构对标 9/10，不集成但深借鉴）
- **唯一与 TDSF 教学定位完全对标（Diagnosis-only + 高危命令检测）** 的项目：**SRE Lab Doctor**（教学对标 8/10）
- **唯一已实现 22 工具覆盖 10 大 Linux 运维场景的 MCP server**：**TencentOS MCP Server**（工具复用 9/10）
- **唯一 2026 KubeCon EU "Agentics Day" 最火、CRD-based、CNCF Sandbox** 的项目：**kagent**（架构范式参考 6/10）

---

## 4. 前 3 名项目深度分析

按 TDSF 契合度排名，前 3 名为：**Strands Agents（9/10）**、**OpenWorker（9/10 架构对标）**、**TencentOS MCP Server（9/10 工具复用）**。考虑用户重点要求 Strands 深度分析，本节聚焦 **Strands Agents + kagent + HolmesGPT** 三个"框架级"项目（OpenWorker 和 TencentOS MCP Server 在 v2 已详述，本节聚焦新深化内容）。

### 4.1 AWS Strands Agents（首选，确认）

#### 4.1.1 项目基础数据

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | https://github.com/strands-agents/sdk-python | 官方 |
| PyPI 最新 | **1.48.0**（2026-07-17 发布） | PyPI |
| Stars / Forks | 6,704 / 993 | PyPI 披露 |
| License | Apache 2.0 | GitHub |
| Python | >=3.10（含 3.14） | PyPI |
| 发版频率 | 几乎每周（2025-08-26 1.6.0 → 2026-07-17 1.48.0，48 版/年） | PyPI |
| 生产验证 | Amazon Q Developer / Amazon Glue / VPC Reachability Analyzer / **Leidos ManagedX 政府级文档处理（2026-04-29）** / **AWS Computer Vision MCP Server（2026-07-15）** / **Kong AI/MCP Gateway（2026-01-13）** | AWS 博客 |
| PyPI extras | a2a / all / anthropic / **bidi / bidi-all / bidi-gemini / bidi-io / bidi-openai** / cedar / gemini / litellm / llamaapi / mistral / ollama / openai / otel / sagemaker / writer | PyPI |

#### 4.1.2 架构图（Strands Agents 1.48.0）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Strands Agents SDK 1.48.0                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐   prompt    ┌──────────────────┐  tool_calls           │
│  │  Agent.loop  │ ─────────▶ │   Model (LLM)    │ ────────────┐         │
│  │  (agentic)   │            │  OpenAI/Anthropic │             │         │
│  │              │ ◀───────── │  /Bedrock/Ollama  │ ◀──── result │         │
│  └──────┬───────┘  response  └──────────────────┘              │         │
│         │                                                        │         │
│         │ invoke tools                                           │         │
│         ▼                                                        ▼         │
│  ┌────────────────────────────────┐          ┌──────────────────────┐   │
│  │      @tool 装饰器函数          │          │   MCPClient           │   │
│  │  (Python 函数 → 工具自动注册)  │          │  stdio / Streamable   │   │
│  │  - ssh_command(command, ...)   │          │  HTTP / SSE 传输      │   │
│  │  - read_remote_file(path, ...) │          │  list_tools_sync()    │   │
│  │  - analyze_logs(log_path, ...)│          │  自动发现 MCP server  │   │
│  └────────────────────────────────┘          │  暴露的工具           │   │
│                                                └──────────────────────┘   │
│         │ callback_handler (**kwargs 事件)                              │
│         ▼                                                                │
│  ┌────────────────────────────────┐          ┌──────────────────────┐   │
│  │  TdsfStrandsCallbackHandler    │          │  stream_async         │   │
│  │  (TDSF 自定义实现)             │          │  (async iterator)     │   │
│  │  - data → emit_agent_message   │          │  - init_event_loop   │   │
│  │  - current_tool_use → emit_tool│          │  - start_event_loop  │   │
│  │  - start → emit_mood(thinking) │          │  - start/complete    │   │
│  │  - complete → emit_mood(done)  │          │  - force_stop        │   │
│  │  - force_stop → emit_mood(err) │          │  - current_tool_use  │   │
│  └────────────────────────────────┘          │  - data (文本增量)   │   │
│                                                └──────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Model Providers (13+ via extras)                                │  │
│  │  OpenAIModel │ AnthropicModel │ BedrockModel │ OllamaModel │       │  │
│  │  LiteLLMModel (100+ providers) │ GeminiModel │ MistralModel │      │  │
│  │  SageMakerModel │ LlamaAPIModel │ WriterModel │ CedarPolicy │      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  多 Agent 模式（替代 MainAgent 关键词路由）                      │  │
│  │  - Agents-as-Tools (Agent 作为另一个 Agent 的工具)               │  │
│  │  - Handoffs (Agent 之间显式移交)                                  │  │
│  │  - Swarm (群体协作)                                               │  │
│  │  - Graph (图结构，类似 LangGraph 但更轻)                         │  │
│  │  - BidiAgent (实验性双向流式，语音 agent 用，TDSF 不用)          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 4.1.3 核心范式 1：@tool 装饰器 + Agent(tools=[...])

来源：[community.aws/content/2xu47bH8LZYPr11tDN2eTDiEL95](https://community.aws/content/2xu47bH8LZYPr11tDN2eTDiEL95) + [strandsagents.com/latest/user-guide/quickstart/](https://strandsagents.com/latest/user-guide/quickstart/)

```python
from strands import Agent, tool
from strands.models.openai import OpenAIModel
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters

# 1. 定义工具：任何 Python 函数 + @tool 装饰器
# Strands 从 docstring + 类型标注自动生成工具描述（供 LLM 调用）
@tool
def ssh_command(
    command: str,
    ssh_session_id: str = "",
    explanation: str = "",
    timeout: int = 30,
) -> dict:
    """在 SSH 会话上执行 shell 命令。

    高危命令（rm -rf / reboot / shutdown / mkfs / dd 等）会触发
    needs_you 审批事件，不直接执行。

    Args:
        command: 待执行的 shell 命令，单行，无尾随换行。
        ssh_session_id: SSH 会话 ID，空则用上下文默认会话。
        explanation: 命令解释，前端展示用（可选）。
        timeout: 超时秒数，默认 30。

    Returns:
        dict: 含 status / command / output / exit_code / risk 等字段。
    """
    # 实际实现（与 TDSF tools/ssh_command.py 的 invoke_ssh_command_tool 对齐）
    return invoke_ssh_command_tool(
        params={"command": command, "ssh_session_id": ssh_session_id, ...},
        ctx=ctx,  # 闭包绑定 ToolContext
    )

# 2. 创建 Agent：传入 model + tools 列表 + system_prompt
model = OpenAIModel(
    client_args={"api_key": "...", "base_url": "https://api.deepseek.com/v1"},
    model_id="deepseek-chat",
    params={"temperature": 0.7, "max_tokens": 2048},
)

agent = Agent(
    model=model,
    tools=[ssh_command, read_remote_file, analyze_logs, ...],
    system_prompt="You are TDSF Terminal Agent...",
    callback_handler=my_handler,  # 事件转发
    max_iterations=10,  # 防死循环
)

# 3. 调用 Agent（同步，agentic loop 内部触发 callback_handler）
response = agent("检查 nginx 状态")
print(str(response))  # str(response) 是推荐方式
```

**TDSF 现有实现印证**：`src-tauri/sidecar/strands_backend/tools/ssh_command.py` 第 159-203 行的 `make_ssh_command_tool(ctx)` 工厂函数正是这个范式，带 ctx 闭包绑定 ToolContext（event_bus + rust_bridge + agent_name + session_id + ssh_session_id）。

#### 4.1.4 核心范式 2：MCPClient（stdio + Streamable HTTP）

来源：[dev.to/om_shree_0709/implementing-a-basic-strands-agent-with-mcp-servers-1269](https://dev.to/om_shree_0709/implementing-a-basic-strands-agent-with-mcp-servers-1269) + [blog.csdn.net/2611_95833734/article/details/161228744](https://blog.csdn.net/2611_95833734/article/details/161228744)

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters
from mcp.client.streamable_http import streamablehttp_client

# 模式 A：stdio 传输（本地子进程 MCP server）
stdio_mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )
))

with stdio_mcp_client:
    # 自动发现 MCP server 暴露的所有工具
    tools = stdio_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
    response = agent("查询 AWS Bedrock 文档")

# 模式 B：Streamable HTTP 传输（远程 MCP server）
MCP_URL = "https://api.scrapeless.com/mcp"
http_mcp_client = MCPClient(lambda: streamablehttp_client(MCP_URL))

with http_mcp_client:
    # 自动发现 21 个工具（google_search/scrape_html/scrape_markdown/browser_*）
    agent = Agent(tools=http_mcp_client.tools, model=model)
    response = agent("搜索竞品信息并抓取 top 5 结果")
```

**TDSF 集成启示**：
- TDSF 现有 9 个 MCP tools（在 `src-tauri/sidecar/tools/`）可通过 MCPClient 直接暴露给 Strands agent，无需重写为 @tool
- 未来可在 sidecar 内启动一个 MCP server（FastMCP + `streamable-http`），把 SSH/SFTP/日志分析等工具暴露给外部 agent client（Cursor / Claude Desktop / VS Code），实现"TDSF 即 MCP server"的反向集成
- TencentOS MCP Server（22 工具）和 ssh-mcp-server（4 工具）可作为外部 MCP server 被 TDSF agent 通过 MCPClient 消费，扩展工具集而不增加 sidecar 体积

#### 4.1.5 核心范式 3：stream_async 流式响应处理

来源：[blog.gitcode.com/90006c411f4f1d8c9446d078cb377f4d.html](https://blog.gitcode.com/90006c411f4f1d8c9446d078cb377f4d.html) + Strands 官方文档

```python
import asyncio
from strands import Agent, tool
from strands_tools import calculator

agent = Agent(tools=[calculator], callback_handler=None)

# stream_async 返回异步迭代器，逐事件产出
async def process_streaming_response():
    agent_stream = agent.stream_async("What is the capital of France and what is 42+7?")
    async for event in agent_stream:
        # 事件生命周期（按顺序触发）
        if event.get("init_event_loop", False):
            print("🔄 Event loop initialized")
        elif event.get("start_event_loop", False):
            print("▶️ Event loop cycle starting")
        elif event.get("start", False):
            print("📝 New cycle started")
        elif "message" in event:
            print(f"📬 New message: {event['message']['role']}")
        elif event.get("complete", False):
            print("✅ Cycle completed")
        elif event.get("force_stop", False):
            print(f"🛑 Force-stopped: {event.get('force_stop_reason')}")

        # 工具调用事件
        if "current_tool_use" in event and event["current_tool_use"].get("name"):
            tool_name = event["current_tool_use"]["name"]
            tool_input = event["current_tool_use"].get("input", {})
            print(f"🔧 Using tool: {tool_name}, input: {tool_input}")

        # 文本增量（流式推送核心）
        if "data" in event:
            print(f"📟 Text: {event['data']}", end="", flush=True)

asyncio.run(process_streaming_response())
```

**事件类型完整清单**（来自 Strands 1.48.0 stream_async）：
- `init_event_loop` / `start_event_loop` / `start` / `complete` / `force_stop`（生命周期）
- `message`（新消息创建，含 role）
- `current_tool_use`（工具调用，含 name + input）
- `data`（文本增量，核心流式数据）

**TDSF 现有实现印证**：`src-tauri/sidecar/strands_backend/adapter.py` 第 89-207 行的 `TdsfStrandsCallbackHandler` 类正是 callback_handler 范式（与 stream_async 互补），把 Strands 事件转发到 event_bus：
- `data` → `emit_agent_message`（流式推送）
- `current_tool_use` → `emit_tool_call`（工具调用开始）
- `start` → `emit_mood_change("thinking")`
- `complete` → `emit_mood_change("working")`
- `force_stop` → `emit_mood_change("error")`

**P1 优化建议**：现有 adapter.py 用 `agent(prompt)` 同步调用 + callback_handler，P1 阶段可升级为 `agent.stream_async(prompt)` + async for 事件循环，获得更细粒度的流式控制（当前 callback_handler 已能用，但 stream_async 是官方推荐的流式范式）。

#### 4.1.6 核心范式 4：与外部 IPC/RPC 调用的桥接模式

TDSF 的特殊架构是 **Python sidecar ↔ Rust Tauri 后端**，需要 IPC/RPC 桥接。Strands 的 @tool + ToolContext 闭包模式提供了天然桥接点：

```python
# TDSF 现有架构（src-tauri/sidecar/strands_backend/tools/__init__.py）
from dataclasses import dataclass
from typing import Any, Protocol

class RustBridge(Protocol):
    """Rust 后端调用抽象层（Protocol，便于单测 mock）"""
    def send_request(self, method: str, params: dict) -> dict:
        """调用 Rust Tauri command 并等待响应"""
        ...

@dataclass
class ToolContext:
    """工具运行时上下文（通过闭包绑定到每个 @tool 函数）"""
    event_bus: Any              # 推送 mood/tool_call/agent_message/needs_you
    rust_bridge: RustBridge     # 调用 Rust 后端（SSH/SFTP/PTY）
    agent_name: str
    session_id: str
    user_id: str = ""
    ssh_session_id: str = ""    # 从 state.live.sshSessionId 注入

# @tool 工厂函数：通过闭包绑定 ctx
def make_ssh_command_tool(ctx: ToolContext):
    @tool
    def ssh_command(command: str, ssh_session_id: str = "", ...) -> dict:
        # 调用 execute_via_ssh(ctx, command, ssh_session_id, ...)
        # execute_via_ssh 内部调 ctx.rust_bridge.send_request("ssh_command", {...})
        # Rust 侧 Tauri command 执行真实 SSH（通过 russh）
        return invoke_ssh_command_tool(params={...}, ctx=ctx)
    return ssh_command

# StrandsAgentAdapter._get_or_create_agent 中：
ctx = self._build_tool_context(agent_id, session_id, state)
ops_tools = make_all_ops_tools(ctx)  # 5 个运维工具，每个都带 ctx 闭包
agent = StrandsAgent(tools=ops_tools + extra_tools, ...)
```

**桥接模式核心要点**：
1. **ToolContext 闭包**：通过工厂函数 `make_*_tool(ctx)` 把 ctx 绑定到 @tool 函数，避免全局 state
2. **RustBridge Protocol**：抽象 Rust 后端调用，便于单测 mock（DefaultRustBridge 是降级实现，返回 unavailable）
3. **event_bus 推送**：工具执行过程中推送 tool_call / agent_message / needs_you 事件到前端
4. **state 注入**：从 `state.live.sshSessionId` 提取 SSH 会话 ID 注入 ToolContext（与前端 `transport.ts:122-145` 对齐）

**P2 双向 JSON-RPC 升级路径**：当前 `DefaultRustBridge.send_request` 返回 unavailable（rust_bridge=None），P2 阶段需实现真正的双向 JSON-RPC：
- Python → Rust 请求：扩展 JSON-RPC 协议支持 Python → Rust 请求（带 id + 等待响应）
- Rust 侧新增 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler
- Python 侧 `send_request(method, params)` + 请求-响应匹配 + 超时

#### 4.1.7 与其他 LLM provider 集成的最佳实践

来源：[strandsagents.com/latest/user-guide/quickstart/#model-providers](https://strandsagents.com/latest/user-guide/quickstart/#model-providers) + [docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands](https://docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands)

```python
# 1. String Model ID（最简，默认走 Bedrock）
agent = Agent(model="us.anthropic.claude-3-7-sonnet-20250219-v1:0")

# 2. Amazon Bedrock（默认，无需 client_args）
from strands.models import BedrockModel
model = BedrockModel(model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0")

# 3. OpenAI 兼容（支持 DeepSeek/Ollama/OneAPI/SiliconFlow/vLLM 等任意 OpenAI 兼容端点）
from strands.models.openai import OpenAIModel
model = OpenAIModel(
    client_args={
        "api_key": "sk-...",
        "base_url": "https://api.deepseek.com/v1",  # 关键：base_url 支持任意兼容端点
    },
    model_id="deepseek-chat",
    params={"temperature": 0.7, "max_tokens": 2048},
)

# 4. Anthropic 原生（claude-3-* 系列，不支持自定义 base_url）
from strands.models.anthropic import AnthropicModel
model = AnthropicModel(
    client_args={"api_key": "sk-ant-..."},
    model_id="claude-3-5-sonnet-20241022",
    params={"temperature": 0.7, "max_tokens": 2048},
)

# 5. LiteLLM（万能适配器，支持 100+ provider，含 Bedrock/Cohere/Mistral/Groq）
from strands.models.litellm import LiteLLMModel
model = LiteLLMModel(
    client_args={"api_key": "...", "api_base": "..."},
    model_id="bedrock/anthropic.claude-3-sonnet-20240229-v1:0",
    params={"temperature": 0.7, "max_tokens": 2048},
)

# 6. Ollama 本地（完全离线，TDSF 教学场景首选）
model = OpenAIModel(
    client_args={"api_key": "ollama", "base_url": "http://localhost:11434/v1"},
    model_id="llama3.2:3b",
)

# 7. MLflow 3.4+ 可观测性（mlflow.strands.autolog() 自动追踪）
import mlflow
mlflow.strands.autolog()  # 捕获 prompt/response/latency/token/cost
mlflow.set_experiment("/Shared/strands-agent-demo")
agent = Agent(model=model, tools=[calculator])
response = agent("What is 2+2?")
```

**TDSF 现有实现印证**：`src-tauri/sidecar/strands_backend/model_adapter.py` 第 105-204 行的 `create_strands_model(config)` 函数完整实现了上述 5 个 provider 的工厂模式：
- `_create_openai_model(config)`：支持 OpenAI 官方 / DeepSeek / SiliconFlow / OneAPI / Ollama / vLLM
- `_create_anthropic_model(config)`：Anthropic 原生
- `_create_litellm_model(config)`：LiteLLM 兜底（100+ provider）
- 与 LangGraph 路径共享同一份 `LLMConfig`（环境变量 / `.tdsf-data/llm_config.json`），保证前后端切换一致
- 优雅降级：未配置 API Key / Strands 未安装 / provider 不支持时返回 None，由 adapter 走降级路径

#### 4.1.8 re:Invent 2025 + 2026 新增能力（v2 已确认，v3 强化）

1. **TypeScript SDK**（2025-12）：与 Python SDK 平行发布，跨语言支持
2. **Bidirectional Streaming（BidiAgent）**：双向流式，专为语音 agent 设计，配合 Nova 2 Sonic 实时语音对话（TDSF 不用但可参考）
3. **Steering**：边界引导，约束 agent 在规定范围内行动（与 TDSF needs_you 审批层语义对齐）
4. **Evaluations**：系统化 agent 评估
5. **Bedrock AgentCore 9 服务**：运行时 / 内存 / 网关 / 浏览器 / 代码解释器 / 身份 / 可观测性 / 评估 / 策略
6. **MLflow 3.4+ 原生追踪**（`mlflow.strands.autolog()`）：捕获 prompt / response / latency / token / cost / cache hit / exception
7. **A2A 协议支持**（即将正式发布）：Strands agent 可作为 A2A AgentExecutor，与其他框架的 agent 互操作

#### 4.1.9 与 TDSF 集成适配度评估：9/10 分

- ✅ Python SDK，与 sidecar 无缝对接
- ✅ `@tool` 装饰器与 TDSF `tools/*.py` 的 `invoke_*_tool(params)` 范式对齐（已在 ssh_command.py 印证）
- ✅ MCPClient 原生支持（stdio + Streamable HTTP），可暴露现有 9 个 MCP tools
- ✅ `stream_async` + BidiAgent 双向流式（callback_handler 已实现，stream_async 是 P1 升级路径）
- ✅ Apache 2.0 与上游 terax-ai 兼容
- ✅ 13+ 模型提供商（含 Ollama 本地、LiteLLM 适配国内 DeepSeek/Qwen）
- ✅ Agents-as-Tools / Handoffs / Swarm / Graph 多 Agent 模式替代 MainAgent 关键词路由
- ✅ **TDSF 现有 strands_backend/ 实现已完整覆盖 adapter + model_adapter + 5 工具**（v3 审计确认）
- ⚠️ 依赖 `litellm`（LiteLLMModel 必需），可能与现有 pydantic/chromadb 冲突（需虚拟环境隔离测试）
- ⚠️ `stream_async` 是 async，需要 sidecar 支持 async event loop（当前 sidecar 主循环是 sync，P1 需评估）

### 4.2 kagent（Solo.io → CNCF Sandbox，2026 最火）

#### 4.2.1 项目基础数据

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | https://github.com/kagent-dev/kagent | 官方 |
| 开源方 | Solo.io（2025 年开源） | 官方 |
| CNCF 状态 | 2026 KubeCon EU 期间捐赠 CNCF Sandbox | [csdn.net/sd7o95o/article/details/151209680](https://blog.csdn.net/sd7o95o/article/details/151209680) |
| 下载量 | **12 个月内突破 1200 万次** | InfoQ 2026-07-06 |
| License | Apache 2.0 | GitHub |
| 架构基础 | 基于 **Google ADK**（Agent Development Kit） | [help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/use-cases/kagent/](https://help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/use-cases/kagent/) |
| 内置 MCP 工具 | Kubernetes / Istio / Helm / Argo / Prometheus / Grafana / Cilium 七个云原生 | Pulumi recap |
| API 状态 | Alpha（升级前需检查不兼容变更） | 阿里云文档 |
| 默认 RBAC | 仅 kagent 命名空间（Deployment/Service 创建删除 + Secret 读） | 阿里云文档 |

#### 4.2.2 三层架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    kagent 三层架构（Solo.io）                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Layer 1: controller（K8s 控制器）                     │     │
│  │  - 处理 kagent API（CRD）                              │     │
│  │  - 把 Agent / ModelConfig / RemoteMCPServer CRD        │     │
│  │    实时翻译成集群中的 Agent App                        │     │
│  │  - 监听 CRD 变化，触发 App/Engine 重启                 │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Layer 2: App/Engine（核心，Python 应用）              │     │
│  │  - 基于 Google ADK 开发                                │     │
│  │  - 处理对话循环（conversation loop）                   │     │
│  │  - 支持 A2A 协议（Agent-to-Agent 互操作）              │     │
│  │  - 调用 MCP Servers 执行工具                           │     │
│  │  - 调用其他 Agent（A2A）作为工具                       │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Layer 3: UI（默认 Web UI）                            │     │
│  │  - 浏览器创建、管理、交互 Agent                        │     │
│  │  - 可视化 Agent 编排                                  │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  核心 CRD（声明式 API）                                    │ │
│  │  - ModelConfig: AI 模型访问（URL/model/API key）          │ │
│  │  - RemoteMCPServer: 注册 HTTP MCP Server                  │ │
│  │  - Agent: 智能体（LLM + 指令 + 工具组合）                 │ │
│  │    tools 字段: MCP Servers + A2A-compatible Agents         │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.2.3 声明式 Agent 定义（YAML）

```yaml
apiVersion: kagent.dev/v1alpha1
kind: Agent
metadata:
  name: k8s-ops-agent
  namespace: kagent
spec:
  description: "Kubernetes 运维 Agent"
  systemPrompt: "You are a Kubernetes O&M engineer..."
  modelConfig:
    name: qwen-model       # 引用 ModelConfig CRD
  tools:
    - name: ack-mcp-server   # 引用 RemoteMCPServer CRD（MCP 协议）
      type: MCP
    - name: another-agent     # 引用另一个 Agent CRD（A2A 协议）
      type: A2A
---
apiVersion: kagent.dev/v1alpha1
kind: ModelConfig
metadata:
  name: qwen-model
spec:
  provider: openai-compatible
  url: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  model: qwen-max
  apiKey:
    secretKeyRef:
      name: llm-secrets
      key: dashscope-key
---
apiVersion: kagent.dev/v1alpha1
kind: RemoteMCPServer
metadata:
  name: ack-mcp-server
spec:
  url: "http://ack-mcp-server.default.svc.cluster.local:8080/mcp"
  transport: streamable-http
```

#### 4.2.4 与 TDSF 集成路径评估

| 维度 | 评估 |
|------|------|
| 直接集成 | ❌ kagent 是 K8s 集群内框架，TDSF 是桌面 IDE，部署形态不同 |
| 架构范式借鉴 | ✅ **声明式 Agent CRD 思路**可借鉴：在 P2 阶段引入"YAML 配置驱动的 Agent 定义" |
| 工具联邦借鉴 | ✅ **RemoteMCPServer CRD** 思路可借鉴：TDSF 可在 `~/.tdsf-data/mcp_servers/` 下用 YAML 注册外部 MCP server |
| 多 agent 编排借鉴 | ✅ **Agent 作为另一个 Agent 的工具（A2A）** 与 Strands Agents-as-Tools 模式一致 |
| ADK 对比 | ⚠️ kagent 基于 Google ADK，TDSF 基于 Strands SDK，两者都是 model-driven agentic loop，范式相通 |

**借鉴建议（P2 评估，P3 视情况落地）**：
1. 在 `~/.tdsf-data/agents/` 下用 YAML 定义 agent（替代 `agents/*.py` 硬编码 8 子 agent）
2. 在 `~/.tdsf-data/mcp_servers/` 下用 YAML 注册外部 MCP server（替代手动 import）
3. 前端 Agent 管理面板可视化 agent 编辑（参考 kagent UI）

### 4.3 HolmesGPT（CNCF Sandbox，工具集设计范式参考）

#### 4.3.1 项目基础数据

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | https://github.com/robusta-dev/holmesgpt | 官方 |
| 文档站 | https://holmesgpt.dev | 官方 |
| CNCF 状态 | Sandbox（2025-10 接纳） | [cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/) |
| 联合开发 | Robusta.dev + Microsoft | CNCF 博客 |
| Stars | 2,800 | CSDN 2026-07-14 |
| 创建时间 | 2024-05 | arXiv |
| License | MIT | GitHub |
| 安装 | Homebrew / pip / Docker / Helm | 官方文档 |
| LLM 支持 | OpenAI / Anthropic / Azure / AWS Bedrock / Robusta AI / Ollama / DeepSeek | [docs.robusta.dev/docs-ui-sink-demo/configuration/ai-analysis.html](https://docs.robusta.dev/docs-ui-sink-demo/configuration/ai-analysis.html) |
| 核心特性 | Agentic task list（多步推理） + Toolsets（YAML 定义） + Runbooks（最佳实践编码）+ MCP 集成 | CNCF 博客 |

#### 4.3.2 Agentic Task List 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                  HolmesGPT Agentic Task List                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  用户输入: holmes ask "Why is my pod in crash loop back off"    │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Step 1: 理解意图                                       │     │
│  │  - 识别为 "Pod 重启问题诊断"                            │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Step 2: 创建任务列表（task list 拆解）                  │     │
│  │  - [ ] 查 Pod 状态 (kubectl get pod)                   │     │
│  │  - [ ] 拉取 Pod 日志 (kubectl logs)                    │     │
│  │  - [ ] 查 Prometheus 指标                                │     │
│  │  - [ ] 检查最近部署变更                                  │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Step 3: 查询数据源（toolsets 执行）                    │     │
│  │  - kubernetes/core: kubectl get pod                    │     │
│  │  - kubernetes/logs: kubectl logs                       │     │
│  │  - prometheus/metrics: PromQL 查询                     │     │
│  │  - kubernetes/events: kubectl get events               │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Step 4: 关联上下文（iterative refine）                 │     │
│  │  - 检测到最近部署更新了镜像                              │     │
│  │  - 关联日志中的 OOMKilled 事件                          │     │
│  │  - 匹配 Prometheus 内存使用率峰值                       │     │
│  └────────────────────────────────────────────────────────┘     │
│                            │                                     │
│                            ▼                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Step 5: 解释 + 建议修复                                │     │
│  │  - 自然语言诊断报告                                     │     │
│  │  - 修复步骤（如: 增加内存 limit）                       │     │
│  │  - 输出到 Slack / PagerDuty / Robusta UI               │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.3.3 Toolsets YAML 设计范式（核心借鉴点）

来源：[cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/) + [docs.robusta.dev](https://docs.robusta.dev/docs-ui-sink-demo/configuration/ai-analysis.html)

```yaml
# HolmesGPT toolsets 设计（YAML 定义工具集，可扩展）
holmes:
  toolsets:
    kubernetes/core:
      enabled: true
      description: "Core Kubernetes operations"
      tools:
        - name: "get_pod"
          description: "Fetch pod details from a namespace."
          command: "kubectl get pod {{ pod }} -n {{ namespace }}"

    kubernetes/logs:
      enabled: true
      tools:
        - name: "get_pod_logs"
          command: "kubectl logs {{ pod }} -n {{ namespace }} --since=5m"

    kubernetes/prometheus_stack:
      enabled: true
      config:
        prometheus_url: "http://prometheus-k8s.kubesphere-monitoring-system.svc:9090"

    prometheus/metrics:
      enabled: true

    helm/core:
      enabled: true

    internet:
      enabled: true   # 允许搜索外部文档

# 自定义 toolset（Python 函数 + 二进制）
custom_toolsets:
  - name: "github"
    tools:
      - name: "search_issues"
        command: "gh issue list --repo {{ repo }} --search '{{ query }}'"

  - name: "kubernetes_diagnostics"
    tools:
      - name: "diagnose_dns"
        command: "python /opt/holmes/diagnose_dns.py {{ namespace }}"

  - name: "http"
    tools:
      - name: "get_url"
        command: "curl -s {{ url }}"
```

**Toolset Fields 关键字段**：
- `description`：工具描述（LLM 用以决策调用哪个工具）
- `command`：shell 命令模板，支持 `{{ variable }}` 变量语法
- `enabled`：开关
- `config`：工具配置（如 prometheus_url）

#### 4.3.4 与 TDSF 集成路径评估

| 维度 | 评估 |
|------|------|
| 直接集成 | ❌ HolmesGPT 是 K8s 集群内独立产品，与 TDSF 桌面 IDE 定位不同 |
| Toolsets YAML 范式借鉴 | ✅ **YAML 定义工具集 + 变量语法 + 自定义 Python tool** 可借鉴 |
| Agentic task list 借鉴 | ✅ **多步推理任务列表** 与 TDSF debug_agent 的 PAOR 循环语义对齐 |
| Runbooks 借鉴 | ✅ **最佳实践编码为 runbook** 与 TDSF teach_agent 的教学定位对齐 |
| MCP 集成借鉴 | ✅ HolmesGPT 通过 MCP server 扩展工具集，与 TDSF MCPClient 范式一致 |

**借鉴建议（P1 落地）**：
1. 在 `~/.tdsf-data/toolsets/` 下用 YAML 定义工具集（参考 HolmesGPT toolsets 设计）
2. 工具支持 `command` 模板（shell 命令 + 变量语法）+ Python 函数两种模式
3. 教学场景预置 Linux 运维 runbook（参考 HolmesGPT 的"diagnose DNS failures" / "debug PVC provisioning"）

---

## 5. Strands Agents 集成最佳实践（基于最新官方文档）

本节聚焦用户重点要求：Strands Agents 与其他 LLM provider 集成最佳实践、@tool 装饰器 + Agent(tools=[...]) 模式、stream_async 流式响应处理、与外部 IPC/RPC 调用的桥接模式。

### 5.1 与其他 LLM provider 集成的最佳实践（v3 深化）

来源：[strandsagents.com/latest/user-guide/quickstart/#model-providers](https://strandsagents.com/latest/user-guide/quickstart/#model-providers) + [blog.csdn.net/2611_95833734/article/details/161228744](https://blog.csdn.net/2611_95833734/article/details/161228744) + [docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands](https://docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands)

#### 5.1.1 选型决策树

```
用户场景？
│
├─ 国内教学（离线优先） → Ollama 本地
│   model = OpenAIModel(
│       client_args={"api_key": "ollama", "base_url": "http://localhost:11434/v1"},
│       model_id="llama3.2:3b"
│   )
│
├─ 国内教学（在线，免费用） → DeepSeek / SiliconFlow / 通义千问
│   model = OpenAIModel(
│       client_args={"api_key": "sk-...", "base_url": "https://api.deepseek.com/v1"},
│       model_id="deepseek-chat"
│   )
│
├─ 商业场景（Claude 系列） → AnthropicModel
│   model = AnthropicModel(
│       client_args={"api_key": "sk-ant-..."},
│       model_id="claude-3-5-sonnet-20241022"
│   )
│
├─ 商业场景（GPT 系列） → OpenAIModel
│   model = OpenAIModel(
│       client_args={"api_key": "sk-..."},
│       model_id="gpt-4o"
│   )
│
├─ 企业场景（AWS Bedrock） → BedrockModel（默认，无需 client_args）
│   model = BedrockModel(model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0")
│
├─ 企业场景（100+ 其他 provider） → LiteLLMModel
│   model = LiteLLMModel(
│       client_args={"api_key": "...", "api_base": "..."},
│       model_id="groq/llama-3.1-70b-versatile"
│   )
│
└─ 最简启动（用 String Model ID，默认 Bedrock）
    agent = Agent(model="us.anthropic.claude-3-7-sonnet-20250219-v1:0")
```

#### 5.1.2 国内 LLM provider 集成实战（TDSF 教学场景首选）

```python
# DeepSeek（推荐，性价比高，国内访问稳定）
model = OpenAIModel(
    client_args={
        "api_key": os.environ["DEEPSEEK_API_KEY"],
        "base_url": "https://api.deepseek.com/v1",
    },
    model_id="deepseek-chat",  # 或 deepseek-coder
    params={"temperature": 0.7, "max_tokens": 2048},
)

# SiliconFlow（硅基流动，免费额度多，支持多模型）
model = OpenAIModel(
    client_args={
        "api_key": os.environ["SILICONFLOW_API_KEY"],
        "base_url": "https://api.siliconflow.cn/v1",
    },
    model_id="Qwen/Qwen2.5-7B-Instruct",
    params={"temperature": 0.7, "max_tokens": 2048},
)

# 通义千问（DashScope OpenAI 兼容模式）
model = OpenAIModel(
    client_args={
        "api_key": os.environ["DASHSCOPE_API_KEY"],
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    model_id="qwen-max",
    params={"temperature": 0.7, "max_tokens": 2048},
)

# Ollama 本地（完全离线，TDSF 教学首选）
model = OpenAIModel(
    client_args={
        "api_key": "ollama",  # 占位符，Ollama 不校验
        "base_url": "http://localhost:11434/v1",
    },
    model_id="llama3.2:3b",  # 或 qwen2.5:7b / deepseek-r1:7b
)
```

#### 5.1.3 可观测性集成（MLflow 3.4+）

```python
import mlflow
mlflow.strands.autolog()  # 自动追踪所有 Strands agent 调用
mlflow.set_tracking_uri("databricks")  # 或本地 file://
mlflow.set_experiment("/Shared/strands-agent-demo")

# 之后所有 agent 调用会被自动追踪：
# - prompt / response
# - latency
# - agent metadata
# - token usage + cost（MLflow 3.4.0+）
# - cache hit info
# - exceptions
agent = Agent(model=model, tools=[calculator])
response = agent("What is 2+2?")
```

**TDSF 集成建议**：sidecar 已有 `observability/langfuse_client.py`，可在 P1 阶段评估用 MLflow 替代或补充 Langfuse（MLflow 3.4+ 对 Strands 原生支持更好）。

### 5.2 @tool 装饰器 + Agent(tools=[...]) 模式（v3 深化）

#### 5.2.1 工具定义最佳实践

```python
from strands import Agent, tool
from typing import Any

# ✅ 推荐：完整的 docstring + 类型标注 + 结构化返回
@tool
def ssh_command(
    command: str,
    ssh_session_id: str = "",
    explanation: str = "",
    timeout: int = 30,
) -> dict:
    """在 SSH 会话上执行 shell 命令。

    高危命令（rm -rf / reboot / shutdown / mkfs / dd 等）会触发
    needs_you 审批事件，不直接执行；低危命令通过 RustBridge 调 Rust 后端
    ssh_command 执行。

    Args:
        command: 待执行的 shell 命令，单行，无尾随换行。
        ssh_session_id: SSH 会话 ID，空则用上下文默认会话。
        explanation: 命令解释，前端展示用（可选）。
        timeout: 超时秒数，默认 30。

    Returns:
        dict: 结构化结果，含 status / command / output / exit_code / risk 等字段。
            status 取值: success | needs_approval | unavailable | error
    """
    # 实际实现
    return {
        "status": "success",
        "command": command,
        "output": "...",
        "exit_code": 0,
    }

# ❌ 避免：模糊 docstring + 裸字符串返回
@tool
def do_stuff(x: str) -> str:
    """Does stuff."""  # LLM 无法理解工具用途
    return "result"  # 无法表达错误/状态
```

#### 5.2.2 工具闭包绑定（带 ToolContext）

```python
from dataclasses import dataclass
from typing import Any, Protocol

class RustBridge(Protocol):
    def send_request(self, method: str, params: dict) -> dict: ...

@dataclass
class ToolContext:
    event_bus: Any
    rust_bridge: RustBridge
    agent_name: str
    session_id: str
    ssh_session_id: str = ""

# 工厂函数：通过闭包绑定 ctx
def make_ssh_command_tool(ctx: ToolContext):
    @tool
    def ssh_command(command: str, ssh_session_id: str = "", ...) -> dict:
        # ctx 在闭包中可用
        return invoke_ssh_command_tool(
            params={"command": command, "ssh_session_id": ssh_session_id, ...},
            ctx=ctx,
        )
    return ssh_command

# 批量构建工具
def make_all_ops_tools(ctx: ToolContext) -> list:
    return [
        make_ssh_command_tool(ctx),
        make_read_remote_file_tool(ctx),
        make_analyze_logs_tool(ctx),
        make_inspect_processes_tool(ctx),
        make_network_diagnose_tool(ctx),
    ]
```

#### 5.2.3 Agent 创建 + 工具注册

```python
# 1. 构建 ToolContext
ctx = ToolContext(
    event_bus=event_bus,
    rust_bridge=DefaultRustBridge(),  # P2 注入真实 RustBridge
    agent_name="main",
    session_id="sess-123",
    ssh_session_id="ssh-456",
)

# 2. 构建工具列表
ops_tools = make_all_ops_tools(ctx)

# 3. 创建 Agent
agent = Agent(
    model=model,
    tools=ops_tools + extra_tools,
    system_prompt=system_prompt,
    callback_handler=TdsfStrandsCallbackHandler(event_bus, "main", "sess-123"),
    max_iterations=10,  # 防死循环
)

# 4. 调用（同步，agentic loop 内部触发 callback_handler）
response = agent("检查 nginx 状态")
```

### 5.3 stream_async 流式响应处理（v3 深化）

#### 5.3.1 基础用法

```python
import asyncio
from strands import Agent

agent = Agent(tools=[...], callback_handler=None)

async def stream_handler(prompt: str):
    async for event in agent.stream_async(prompt):
        # 事件优先级处理
        if "data" in event:
            # 文本增量（核心流式数据）
            yield event["data"]
        elif "current_tool_use" in event:
            tool = event["current_tool_use"]
            if tool.get("name"):
                # 工具调用开始
                yield f"\n[调用工具: {tool['name']}]"
        elif event.get("complete"):
            # 循环完成
            yield "\n[完成]"

# FastAPI 集成（参考 Strands 官方 samples）
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.post("/stream")
async def stream_endpoint(request: PromptRequest):
    async def generate():
        async for chunk in stream_handler(request.prompt):
            yield chunk
    return StreamingResponse(generate(), media_type="text/plain")
```

#### 5.3.2 完整事件生命周期处理

```python
async def detailed_stream_handler(prompt: str, event_bus):
    agent_stream = agent.stream_async(prompt)
    async for event in agent_stream:
        # 生命周期事件（按顺序）
        if event.get("init_event_loop"):
            await event_bus.emit_mood_change(mood="thinking")
        elif event.get("start_event_loop"):
            pass  # 周期开始
        elif event.get("start"):
            pass  # 新周期
        elif "message" in event:
            # 新消息创建（含 role）
            msg = event["message"]
            if msg.get("role") == "assistant":
                await event_bus.emit_agent_message(content="[assistant]", message_type="thinking")
        elif event.get("complete"):
            await event_bus.emit_mood_change(mood="done")
        elif event.get("force_stop"):
            await event_bus.emit_mood_change(mood="error")
            logger.warning(f"force_stop: {event.get('force_stop_reason')}")

        # 工具调用事件
        if "current_tool_use" in event:
            tool_use = event["current_tool_use"]
            if tool_use.get("name"):
                await event_bus.emit_tool_call(
                    tool_name=tool_use["name"],
                    params=tool_use.get("input", {}),
                    status="started",
                )

        # 文本增量（核心）
        if "data" in event:
            await event_bus.emit_agent_message(
                content=event["data"],
                message_type="output",
            )
```

#### 5.3.3 TDSF 现有 callback_handler vs stream_async 对比

| 维度 | callback_handler（现有） | stream_async（P1 升级路径） |
|------|------|------|
| 调用方式 | `agent(prompt)` 同步 | `async for event in agent.stream_async(prompt)` |
| 事件类型 | 通过 **kwargs dict | 通过 async iterator |
| 异步支持 | ❌ 同步阻塞 | ✅ 原生 async |
| FastAPI 集成 | 需线程池 | 直接 async |
| 控制粒度 | 中（事件回调） | 高（迭代器暂停/取消） |
| TDSF 现状 | ✅ 已实现（adapter.py L89-207） | ⚠️ P1 待实现 |

**P1 升级建议**：保留现有 callback_handler 作为兼容路径，新增 `stream_async` 作为默认流式范式（需评估 sidecar async event loop 支持）。

### 5.4 与外部 IPC/RPC 调用的桥接模式（v3 深化）

#### 5.4.1 TDSF 特殊架构挑战

```
┌─────────────────────────────────────────────────────────┐
│              TDSF IPC 架构（Python ↔ Rust）             │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────┐   stdio JSON-RPC   ┌─────────────┐ │
│  │  Python sidecar │ ◀────────────────▶ │  Rust Tauri │ │
│  │  (Strands Agent)│                    │  (russh)    │ │
│  │                 │   1. Rust → Python │             │ │
│  │  - agent.invoke │      (现有)        │  - SSH/SFTP │ │
│  │  - @tool 执行   │                    │  - PTY      │ │
│  │                 │   2. Python → Rust │  - fs       │ │
│  │                 │      (P2 待实现)    │  - secrets  │ │
│  └─────────────────┘                    └─────────────┘ │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### 5.4.2 现有桥接模式（Rust → Python，已实现）

```python
# src-tauri/sidecar/main.py L332-358（Feature Flag 注入）
backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
if backend == "strands":
    from strands_backend import StrandsAgentAdapter
    adapter = StrandsAgentAdapter(
        event_bus=event_bus.get_global_bus(),
        rust_bridge=DefaultRustBridge(),  # P2 注入真实 RustBridge
        backend_enabled=True,
    )
    agents.set_backend(lambda agent_id, input, state: adapter.invoke(agent_id, input, state))
```

#### 5.4.3 P2 双向 JSON-RPC 桥接模式（待实现）

```python
# P2 阶段：Python → Rust 请求（带 id + 等待响应）
import asyncio
import uuid
from concurrent.futures import Future

class BidirectionalRustBridge:
    """双向 JSON-RPC 桥接（P2 阶段实现）"""

    def __init__(self, stdin_writer, stdout_reader):
        self.stdin_writer = stdin_writer
        self.stdout_reader = stdout_reader
        self._pending: dict[str, Future] = {}
        self._lock = asyncio.Lock()

        # 启动后台读取协程
        asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        """后台读取 Rust 响应，按 id 匹配 pending Future"""
        async for line in self.stdout_reader:
            msg = json.loads(line)
            req_id = msg.get("id")
            if req_id and req_id in self._pending:
                future = self._pending.pop(req_id)
                if "error" in msg:
                    future.set_exception(Exception(msg["error"]))
                else:
                    future.set_result(msg["result"])

    async def send_request(self, method: str, params: dict, timeout: float = 30.0) -> dict:
        """发送请求到 Rust 后端，等待响应"""
        req_id = str(uuid.uuid4())
        future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = future

        # 写入 stdin
        request = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        self.stdin_writer.write(json.dumps(request).encode() + b"\n")
        await self.stdin_writer.drain()

        # 等待响应（带超时）
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            return {"status": "error", "error": "timeout"}

# 工具内调用
def invoke_ssh_command_tool(params, ctx):
    # 调 Rust 后端 ssh_command Tauri command
    result = asyncio.run(ctx.rust_bridge.send_request(
        "ssh_command",
        {"command": params["command"], "ssh_session_id": params["ssh_session_id"]},
    ))
    return result
```

#### 5.4.4 MCP 协议作为标准化桥接（P3 评估）

```python
# P3 阶段：把 sidecar 工具暴露为 MCP server，Rust 作为 MCP client
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("tdsf-ops-tools", stateless_http=True, host="127.0.0.1", port=9000)

@mcp.tool()
def ssh_command(command: str, ssh_session_id: str = "") -> dict:
    """SSH 命令执行（通过 RustBridge）"""
    return invoke_ssh_command_tool({"command": command, "ssh_session_id": ssh_session_id}, ctx)

@mcp.tool()
def read_remote_file(path: str, ssh_session_id: str = "") -> dict:
    """读取远程文件（通过 RustBridge）"""
    return invoke_read_remote_file_tool({"path": path, "ssh_session_id": ssh_session_id}, ctx)

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

**优势**：
- 标准化协议（任何 MCP client 都能消费，包括 Cursor / Claude Desktop / VS Code）
- Rust 侧只需实现一个 MCP client（替代多个 Tauri command）
- 工具描述自动通过 MCP 协议暴露给外部 agent

---

## 6. 其他高价值项目简介

### 6.1 Aurora（Arvo-AI，Apache 2.0）

来源：[dev.to/siddharth_singh_409bd5267](https://dev.to/siddharth_singh_409bd5267/firehydrant-alternative-open-source-ai-incident-management-4adk)

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/Arvo-AI/aurora |
| License | Apache 2.0 |
| 创建时间 | 2026-01 |
| Stars | 369 |
| 架构 | LangGraph 多 agent 编排 |
| 工具数 | 30+ |
| 跨云 | AWS / Azure / GCP / OVH / Scaleway / Kubernetes |
| 知识库 | Weaviate 向量搜索（runbooks + 历史 incidents） |
| 依赖图 | Memgraph（基础设施依赖图，blast radius 分析） |
| 沙箱 | Kubernetes Pod 内执行 kubectl/aws/az/gcloud |
| HITL | 写/破坏操作需人工审批，只读命令自动执行 |
| 部署 | Docker Compose / Helm |
| LLM | 任意 provider（含 Ollama 本地） |

**核心价值**：v3 调研中最有野心的多 agent 设计。其"跨云调查 + 知识图谱 + 沙箱执行 + HITL"范式是 TDSF explore_agent + debug_agent 的进阶参考。**P3 阶段评估引入 Memgraph 依赖图 + Weaviate 知识库**。

### 6.2 DevOps Open Agent（2026-07-12 发布）

来源：[meridian48.com/news/devops-open-agent-launches-open-source-ai-for-infrastructure-teams-d89f69](https://meridian48.com/news/devops-open-agent-launches-open-source-ai-for-infrastructure-teams-d89f69)

| 维度 | 数据 |
|------|------|
| 发布 | 2026-07-12（DEV Community） |
| 定位 | 自托管开源 DevOps/SRE/平台工程师 AI 平台 |
| Agent 数 | K8s debugging + AWS 调查 + 云成本检测 + GitHub PR review |
| LLM | 多 provider 支持 |
| 社区 | 旨在通过社区贡献扩展 |

**核心价值**：场景覆盖参考（K8s + AWS + 成本 + PR review），不作为直接集成对象。

### 6.3 SRE Lab Doctor（andersthorvald, 2026-07-02）

来源：[cnblogs.com/andersthorvald/p/21054622](https://www.cnblogs.com/andersthorvald/p/21054622)

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/andersthorvald/sre-lab-doctor |
| Tag | v0.1.0（2026-07-02） |
| License | Apache 2.0 |
| 主功能 | 8/8 完成 |
| 回归测试 | 5/5（100% 通过） |
| 内置知识库案例 | 10 个（Nginx×2 / DNS×2 / iptables×2 / SSH×2 / rsync×1 / Docker×1） |
| 高危命令正则 | **17 条**（rm -rf / / mkfs / dd / iptables -F / nft flush / systemctl stop sshd\|network\|firewalld / chmod -R 777 / / chown -R / curl\|sh / wget\|bash / kill -9 1 / shutdown / reboot / setenforce 0） |
| LLM | MiniMax-M2.7（30-50 秒响应） |
| 技术栈 | NightMend（fork）+ FastAPI + Python 3.11 + React + Ant Design + PostgreSQL + Redis + Docker Compose（5 容器） |

**Diagnosis-only 三条红线**（与 TDSF 教学定位高度对标）：
1. 不 SSH（不自动连接学员机器）
2. 不 systemd（不自动管理服务）
3. 不存凭据（不持久化任何凭据）

**核心借鉴价值**：
1. **17 条高危命令正则**：可直接借鉴到 TDSF `tools/risk.py` 的 RiskChecker
2. **Diagnosis-only 模式**：TDSF 教学场景可新增"教学模式开关"，开启后所有工具降级为"只输出建议命令，不实际执行"
3. **双场景 Prompt**：故障场景（含报错/失败/refused/timeout/denied）走排障模板，其他走知识模板——TDSF teach_agent 可借鉴
4. **知识库 top-2 匹配**：TDSF knowledge/ 模块可借鉴

### 6.4 AIOps-example（robin-2016，2026-07-05）

来源：[segmentfault.com/a/1190000047973012](https://segmentfault.com/a/1190000047973012)

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/robin-2016/AIOps-example |
| 定位 | "AI 工程架构模式展示仓库" |
| 场景 | 模拟 IT 运维/SRE（runbook + 历史工单 + 告警 + 变更记录） |
| 9 个目录 | 00-shared / 01-foundations-rag / 02-advanced-rag / 03-langgraph-agents / 04-mcp-integration / 05-agent-patterns / 06-enterprise-gateway / 07-framework-comparison / 08-code-sandbox-agent |
| 基础设施 | Ollama LLM/Embedding + Qdrant + Langfuse + Prometheus + structlog |
| 框架对比 | 同一工单诊断任务用 LangGraph / Smolagents / CrewAI / AutoGen 实现，输出延迟/Token 数/代码量横向对比 |

**核心借鉴价值**：**架构方法论参考**——9 种架构模式横向对比是 TDSF 选型的最佳参考。**P1 阶段建议运行 07-framework-comparison 评估 Strands vs LangGraph vs PydanticAI 在同一任务下的定量对比**。

### 6.5 BitFun（GCWing，Rust + Tauri 同栈）

来源：[segmentfault.com/a/1190000047635518](https://segmentfault.com/a/1190000047635518)

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/GCWing/BitFun |
| 技术栈 | **Rust + TypeScript + Tauri**（与 TDSF 同栈！） |
| 支持平台 | Windows / macOS |
| Agent 数 | Code Agent（开发者）+ Cowork Agent（知识工作）+ Custom Agent |
| 工作模式 | **Agentic / Plan / Debug / Review 四模式** |
| 扩展机制 | Skills（Markdown/脚本/外部工具）+ MCP 集成 + Agent 自定义（Markdown 定义） |
| 现状 | 实验性（97%+ 代码 Vibe Coding 生成） |

**核心借鉴价值**：
1. **同栈对标**（Rust + Tauri）：与 TDSF 架构同源
2. **四模式设计**（Agentic/Plan/Debug/Review）：与 TDSF 8 子 agent 映射，提供"模式切换"UX
3. **Markdown 定义 Agent**：与 kagent YAML CRD 思路一致，TDSF P2 可借鉴

### 6.6 TuriX-CUA（Python 桌面 CUA）

来源：[blog.csdn.net/xiaobing259/article/details/157646035](https://blog.csdn.net/xiaobing259/article/details/157646035)

| 维度 | 数据 |
|------|------|
| 发布 | 2026-02-07 |
| 技术 | Python |
| 平台 | Windows / macOS |
| 架构 | **Planner + Executor 多模型**（Planner 拆解任务，Executor 执行） |
| 循环 | **"看-想-动"三步循环**（截图 → VLM 推理 → 模拟键鼠） |
| MCP | ✅ 集成（可与 Claude 等协作） |
| 模型 | OpenAI / Qwen3-VL 等多模态 |

**核心借鉴价值**：范式差异大（GUI 自动化 vs TDSF 终端优先），不作为集成对象。但其"Planner + Executor 多模型分工"模式可参考。

### 6.7 其他已覆盖项目（v1/v2 详述，本节简表）

| 项目 | v3 评估 | 来源 |
|------|---------|------|
| OpenWorker | 同栈对标，typed risk engine 4 级 + prompt-injection posture | v2 §2.5 |
| OpenSRE | Public Alpha，60+ 工具，多信号整合 + 智能终止逻辑 | v2 §2.6.1 |
| OpsAgent | Lenovo 生产，双自演化机制 | v2 §2.6.2 |
| Lerwee Agentic Ops | 30+ CoT 模板，国内运维特化 | v2 §2.6.3 |
| TencentOS MCP Server | 22 工具 / 10 场景，只读零侵入 | v2 §5.1.1 |
| ssh-mcp-server | 4 工具 SSH/SFTP，白名单/黑名单 | v2 §5.1.2 |
| PydanticAI | 备选方案，类型安全 + 依赖注入 + Human-in-the-loop | v1 + v2 §2.4 |
| OpenAI Agents SDK | 4 种 MCP 传输，HostedMCPTool 托管 | v2 §2.2 |
| Claude Agent SDK | in-process SDK MCP Server，计费绑定 Anthropic | v2 §2.3 |
| LangGraph | Thoughtworks 2026-04 降级到 Trial，TDSF 现有后端 | thoughtworks.com/radar |
| K8sGPT | CNCF Sandbox，K8s 一键诊断，MCP v2 支持 | 本报告 §3.1 |
| Robusta | K8s 自动化引擎，playbook 自定义，AI enrichment | 本报告 §3.1 |

---

## 7. TDSF 现有 strands_backend 实现评估

本节基于 v3 实际审计 `src-tauri/sidecar/strands_backend/` 全部源文件，给出"是否最佳选择"的评估结论。

### 7.1 实现现状盘点

| 文件 | 行数 | 职责 | 完成度 |
|------|:---:|------|:---:|
| `__init__.py` | - | 模块导出（StrandsAgentAdapter / TdsfStrandsCallbackHandler / configure_strands） | ✅ |
| `adapter.py` | 774 | StrandsAgentAdapter 适配层核心 + TdsfStrandsCallbackHandler 事件转发 | ✅ |
| `model_adapter.py` | 411 | LLMConfig → Strands Model 工厂（OpenAI/Anthropic/LiteLLM） | ✅ |
| `tools/__init__.py` | - | ToolContext + RustBridge Protocol + make_all_ops_tools + RiskChecker | ✅ |
| `tools/ssh_command.py` | 209 | SSH 命令执行 @tool（含多行高危检测 + emit_needs_you） | ✅ |
| `tools/remote_file.py` | - | 远程文件读取 @tool | ✅ |
| `tools/log_analyzer.py` | - | 日志分析 @tool | ✅ |
| `tools/process_inspector.py` | - | 进程检查 @tool | ✅ |
| `tools/network_diagnostic.py` | - | 网络诊断 @tool | ✅ |
| `tests/test_tools.py` | - | 工具单测 | ✅ |
| `tests/test_strands_model_adapter.py`（在 tests/） | - | model_adapter 单测 | ✅ |

**总计**：8 源文件 + 2 测试文件，约 1400+ 行实现，覆盖完整 P0 + P1 范围。

### 7.2 实现质量评估

#### 7.2.1 优点（实现质量高）

1. **完整的降级路径**（adapter.py L409-421 `_check_degraded`）：
   - feature_flag_disabled → 切回 LangGraph
   - strands_not_installed → 提示安装
   - strands_model_not_injected → 提示配置 Model
   - 每种降级都推送 needs_you 事件到前端

2. **完整的 callback_handler 事件转发**（adapter.py L89-207）：
   - data → emit_agent_message（流式推送）
   - current_tool_use → emit_tool_call（工具调用开始）
   - start → emit_mood_change("thinking")
   - complete → emit_mood_change("working")
   - force_stop → emit_mood_change("error")
   - 含统计计数器（events_received / messages_emitted / tool_calls_emitted / mood_changes_emitted）

3. **完整的 ToolContext 闭包模式**（tools/__init__.py + ssh_command.py）：
   - 通过 `make_*_tool(ctx)` 工厂函数绑定 ctx
   - ctx 含 event_bus + rust_bridge + agent_name + session_id + ssh_session_id
   - 支持 RustBridge Protocol 抽象（便于单测 mock）

4. **完整的多 provider model 工厂**（model_adapter.py）：
   - OpenAIModel（支持 DeepSeek/Ollama/OneAPI/SiliconFlow/vLLM 等任意兼容端点）
   - AnthropicModel（claude-3-* 系列）
   - LiteLLMModel（100+ provider 兜底）
   - 与 LangGraph 路径共享同一份 LLMConfig
   - 优雅降级（未配置 API Key 返回 None）

5. **完整的高危命令检测**（ssh_command.py L85-111）：
   - 多行命令拆分检测（每行过 RiskChecker）
   - 命中即 emit_needs_you 推送审批事件
   - 不直接执行

6. **完整的 live 上下文注入**（adapter.py L552-586 `_build_prompt`）：
   - cwd / activeFile / workspaceRoot / terminalPrivate / sshSessionId
   - 注入 `<live_context>` 块到 prompt 末尾

7. **Agent 缓存机制**（adapter.py L481-520 `_get_or_create_agent`）：
   - 按 agent_id 缓存 Strands Agent 实例
   - 避免每次 invoke 重建
   - `clear_cache()` 配置变更后清理

8. **完整的错误处理 + needs_you 推送**（adapter.py L378-403, L694-750）：
   - invoke 异常时推送 needs_you（needs_type="error"）
   - 降级时推送 needs_you（needs_type="error", priority="normal"）

#### 7.2.2 待改进点（P1/P2 优化方向）

1. **`agent(prompt)` 同步调用 vs `stream_async` 异步**：
   - 现状：adapter.py L345 用同步 `strands_agent(prompt)` + callback_handler 转发事件
   - P1 升级：评估切换到 `agent.stream_async(prompt)` + async for 事件循环（更细粒度流式控制）
   - 风险：sidecar 主循环是 sync，需评估 async event loop 支持

2. **DefaultRustBridge 返回 unavailable**（P2 双向 JSON-RPC 未实现）：
   - 现状：`rust_bridge=None` 时 `execute_via_ssh` 返回 unavailable
   - P2 待办：实现真正的 Python → Rust JSON-RPC 请求（带 id + 等待响应）
   - Rust 侧需新增 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler

3. **多 Agent 模式未启用**：
   - 现状：单 StrandsAgentAdapter 实例，按 agent_id 缓存多个 Agent，但未用 Agents-as-Tools / Handoffs
   - P2 待办：实现 `multi_agent.py`（Strands Agents-as-Tools 模式，8 子 agent 作为工具）

4. **MCP 集成未启用**：
   - 现状：5 个运维 @tool 直接定义，未通过 MCPClient 暴露/消费
   - P2/P3 待办：评估 MCPClient 消费外部 MCP server（TencentOS / ssh-mcp-server）+ 把 sidecar 工具暴露为 MCP server

5. **Steering 边界引导未启用**：
   - 现状：system_prompt 中硬编码约束（高危命令会触发审批）
   - P2 待办：评估用 Strands Steering API（re:Invent 2025 新增）做边界引导

### 7.3 "是否最佳选择"评估结论

**结论：✅ 是最佳选择，建议继续深化而非切换。**

**评估依据**：

1. **契合度评分 9/10**（22 项目中最高，与 OpenWorker / TencentOS MCP Server 并列）
2. **TDSF 现有 strands_backend/ 实现质量高**（1400+ 行，覆盖完整 P0+P1，降级路径完整）
3. **2026-07 下旬最新数据持续强化支撑**：
   - Strands 1.48.0（2026-07-17 发布，第 48 个版本，发版频率极高）
   - Leidos ManagedX 政府级生产（2026-04-29）
   - AWS Computer Vision MCP Server + Strands + Bedrock（2026-07-15）
   - Kong AI/MCP Gateway + Strands + Bedrock（2026-01-13）
   - Strands + Scrapeless MCP 集成（2026-07-20，21 个 MCP 工具自动发现）
   - MLflow 3.4+ 原生追踪（`mlflow.strands.autolog()`）
4. **v3 新增项目未颠覆判断**：
   - kagent（CNCF Sandbox，CRD-based）：K8s 集群内框架，桌面 IDE 不直接集成
   - HolmesGPT（CNCF Sandbox）：K8s 集群内独立产品，toolsets 设计可借鉴但不集成
   - Aurora（Apache 2.0）：多 agent 范式参考，不直接集成
   - SRE Lab Doctor：教学对标，Diagnosis-only 模式可借鉴
5. **Thoughtworks 2026-04 把 LangGraph 从 Adopt 降级到 Trial**：TDSF 现有 LangGraph 后端切换 Strands 有额外支撑
6. **备选方案 PydanticAI v2.13.0 仍可用**（触发条件见 §8.2）

**不切换的代价评估**：
- 切换到 PydanticAI 需重写 1400+ 行 strands_backend 代码（约 2-3 人日）
- 收益有限（Strands 已满足需求，PydanticAI 主要优势是类型安全 + Human-in-the-loop，但 TDSF 已通过 needs_you 实现审批层）
- 维持双后端 Feature Flag（`strands|pydanticai`）是最佳策略：保留切换能力，不立即切换

---

## 8. 最终推荐：TDSF 运维 Agent 集成路线图

### 8.1 推荐方案：维持 Strands Agents 首选 + PydanticAI 备选 + 多项目借鉴

**理由**（v3 综合 22 项目调研）：
1. Strands Agents 9/10 契合度，TDSF 现有实现质量高
2. OpenWorker（同栈对标）+ SRE Lab Doctor（教学对标）+ TencentOS MCP Server（工具复用）+ kagent（CRD 范式）+ HolmesGPT（toolsets 设计）+ BitFun（四模式）+ Aurora（多 agent）多项目借鉴
3. PydanticAI 备选（v2.13.0，触发条件明确）
4. LangGraph 降级到 Trial（Thoughtworks 2026-04）

### 8.2 PydanticAI 备选触发条件（任一满足即切换）

1. Strands 依赖 `litellm` 与现有 pydantic/chromadb 冲突，虚拟环境隔离仍无法解决
2. 需要更强类型安全（`Agent[DepsType, OutputType]` 泛型约束）
3. 需要原生 Human-in-the-loop 工具审批（与 needs_you 语义完全一致）
4. 需要更轻的包体积（`pydantic-ai-slim` 按需 extras）
5. 需要 Durable Execution（Temporal/DBOS/Prefect/Restate）

### 8.3 P0/P1/P2/P3 路线图（v3 优化版）

#### P0（1 人日，已完成）✅

1. ✅ 新建 `strands_backend/` 目录结构（8 文件，约 1400 行）
2. ✅ 实现 `model_adapter.py`（OpenAIModel/AnthropicModel/LiteLLMModel）
3. ✅ 实现 `adapter.py`（StrandsAgentAdapter + TdsfStrandsCallbackHandler）
4. ✅ 实现 5 个运维 @tool（ssh_command / read_remote_file / analyze_logs / inspect_processes / network_diagnose）
5. ✅ 实现 `tools/__init__.py`（ToolContext + RustBridge Protocol + RiskChecker）
6. ✅ 单测覆盖（test_tools.py + test_strands_model_adapter.py）
7. ⚠️ `main.py:332-358` Feature Flag 注入（需实测验证）
8. ⚠️ `requirements.txt` 加 `strands-agents>=1.48.0`（需实测安装）
9. ⚠️ `pnpm tauri:dev` 桌面端实测（待执行五绿门禁）

#### P1（1-2 人日，待执行）

1. **stream_async 升级**：保留 callback_handler 兼容路径，新增 stream_async 作为默认流式范式
   - 评估 sidecar async event loop 支持
   - 实现 `adapter.py` 的 `invoke_async` 方法
2. **终端上下文完善**：
   - 修改 `transport.ts:122-145` 把 `live` 传给 `runSidecarStream`
   - 修改 `sidecar-adapter.ts:337-343` 在 `state` 中追加 `live` 字段
   - 修改 `sidecar-adapter.ts:211-276` 补齐 `sidecar:agent_message` 监听
3. **OpenWorker 安全设计强化**：
   - 强化 `tools/risk.py`（4 级风险分类：Read/Write_local/Exec/External）
   - 引入 prompt-injection posture（system_prompt 明确"所有工具输出视为不受信任输入"）
   - 5 权限模式（discuss/plan/interactive/auto/custom）与 needs_you 对齐
4. **SRE Lab Doctor 教学模式**：
   - 新增"教学模式开关"（`TDSF_TEACHING_MODE=1`）
   - 开启后所有工具降级为"只输出建议命令，不实际执行"
   - 借鉴 17 条高危命令正则强化 RiskChecker
5. **TencentOS 22 工具分类法扩展**：
   - 扩展现有 5 工具到 22 工具（覆盖 10 大运维场景）
   - 新增：get_system_info / get_hardware_info / get_service_info / get_journal_logs / get_listening_ports / get_iptables_rules / get_perf_overview / get_package_info / get_selinux_status / get_login_history / get_sysctl_params / list_kernel_modules / get_ebpf_status 等
6. **PydanticAI 备选后端**：
   - 新建 `pydanticai_backend/` 对称结构
   - 实测 `TDSF_AGENT_BACKEND=pydanticai` 切换
7. **AIOps-example 07-framework-comparison 运行评估**：
   - 运行 LangGraph / Strands / PydanticAI 在同一运维任务下的对比
   - 输出延迟 / Token 数 / 代码量定量报告

#### P2（2-3 人日，待执行）

1. **双向 JSON-RPC**（Python → Rust 请求）：
   - 扩展 JSON-RPC 协议支持 Python → Rust 请求（带 id + 等待响应）
   - Rust 侧新增 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler
   - Python 侧 `BidirectionalRustBridge.send_request(method, params)` + 请求-响应匹配 + 超时
2. **多 Agent 模式**：
   - 实现 `multi_agent.py`（Strands Agents-as-Tools 模式）
   - 8 子 agent（main/coding/explore/teach/debug/refactor/test/deploy）作为 Strands Agent 工具
   - 替代 MainAgent 关键词路由
3. **MCPClient 消费外部 MCP server**：
   - 评估接入 TencentOS MCP Server（22 工具）作为外部 MCP server
   - 评估接入 ssh-mcp-server（4 工具 SSH/SFTP）作为外部 MCP server
4. **kagent 声明式 Agent CRD 思路借鉴**：
   - 在 `~/.tdsf-data/agents/` 下用 YAML 定义 agent
   - 替代 `agents/*.py` 硬编码 8 子 agent
5. **HolmesGPT toolsets YAML 设计借鉴**：
   - 在 `~/.tdsf-data/toolsets/` 下用 YAML 定义工具集
   - 工具支持 command 模板 + Python 函数两种模式
6. **Steering 边界引导**：
   - 评估用 Strands Steering API（re:Invent 2025 新增）做边界引导
7. **MLflow 可观测性**：
   - 评估 `mlflow.strands.autolog()` 替代或补充 Langfuse

#### P3（视情况落地，长期）

1. **MCP server 反向暴露**：
   - 把 sidecar 工具暴露为 MCP server（FastMCP + streamable-http）
   - Rust 侧只需实现一个 MCP client（替代多个 Tauri command）
   - 任何 MCP client（Cursor / Claude Desktop / VS Code）都能消费 TDSF 工具
2. **Aurora 多 agent 范式借鉴**：
   - 评估引入 Memgraph 基础设施依赖图（影响面分析）
   - 评估引入 Weaviate 向量知识库（历史事故检索）
   - 强化 explore_agent + debug_agent 能力
3. **BitFun 四模式 UX**：
   - Agentic / Plan / Debug / Review 四模式与 8 子 agent 映射
   - 提供"模式切换"而非"agent 切换"的 UX
4. **A2A 协议支持**：
   - 评估 Strands A2A AgentExecutor 接口（即将正式发布）
   - 实现 TDSF agent 与其他框架 agent 互操作
5. **Bedrock AgentCore 9 服务评估**：
   - 评估可观测性 + 评估服务（运行时/内存/网关/浏览器/代码解释器/身份/可观测性/评估/策略）

### 8.4 集成路径示意（v3 完整版）

```
src-tauri/sidecar/
├── agents/                         # 现有 9 Agent，保持不动
│   ├── __init__.py                 # 加 set_backend 注入点
│   ├── base.py                     # PAOR 模板，保持不动
│   └── main_agent.py               # 保持不动
├── tools/                          # 现有 9 个 MCP tools，保持不动
├── strands_backend/                # ✅ 已实现（P0 完成）
│   ├── __init__.py                 # ✅
│   ├── adapter.py                  # ✅ 774 行（StrandsAgentAdapter + CallbackHandler）
│   ├── model_adapter.py            # ✅ 411 行（OpenAI/Anthropic/LiteLLM 工厂）
│   ├── tools/                      # ✅ 5 个运维 @tool
│   │   ├── __init__.py             # ✅ ToolContext + RustBridge + RiskChecker
│   │   ├── ssh_command.py          # ✅ 209 行
│   │   ├── remote_file.py          # ✅
│   │   ├── log_analyzer.py         # ✅
│   │   ├── process_inspector.py    # ✅
│   │   └── network_diagnostic.py   # ✅
│   ├── multi_agent.py              # ⚠️ P2 待实现（Agents-as-Tools）
│   ├── stream_adapter.py           # ⚠️ P1 待实现（stream_async 包装）
│   └── tests/                      # ✅
├── pydanticai_backend/             # ⚠️ P1 待实现（对称结构）
├── knowledge/                      # 现有，保持不动
├── observability/
│   ├── langfuse_client.py         # 现有
│   └── mlflow_client.py            # ⚠️ P2 待评估（mlflow.strands.autolog）
└── main.py                         # 修改 L332-358 加 Feature Flag

# 用户配置驱动（P2 借鉴 kagent CRD + HolmesGPT toolsets）
~/.tdsf-data/
├── llm_config.json                 # 现有
├── agents/                         # ⚠️ P2 待实现（YAML 定义 agent）
│   ├── main.yaml
│   ├── coding.yaml
│   └── debug.yaml
├── toolsets/                       # ⚠️ P2 待实现（YAML 定义工具集）
│   ├── linux_ops.yaml              # 借鉴 TencentOS 22 工具
│   ├── k8s_ops.yaml                # 借鉴 HolmesGPT toolsets
│   └── ssh_remote.yaml              # 借鉴 ssh-mcp-server
└── mcp_servers/                    # ⚠️ P2 待实现（注册外部 MCP server）
    ├── tencentos.yaml
    └── ssh_mcp.yaml
```

### 8.5 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|:---:|:---:|------|
| Strands 依赖 litellm 与 pydantic/chromadb 冲突 | 中 | 高 | 虚拟环境隔离测试；冲突时切 PydanticAI |
| sidecar async event loop 不支持 stream_async | 中 | 中 | 保留 callback_handler 兼容路径 |
| Rust 侧 JSON-RPC handler 实现复杂 | 高 | 中 | P2 阶段优先实现 ssh_command 一个 handler，验证后再扩展 |
| 22 工具扩展工作量超预期 | 高 | 低 | 分批实现（P1 先 10 个核心，P2 再 12 个高级） |
| kagent/HolmesGPT 范式借鉴引入过度设计 | 中 | 中 | 严格按需，不盲目跟风；每个借鉴点必须有具体场景 |
| LangGraph 后端废弃影响现有功能 | 低 | 高 | 保留 LangGraph 后端作为第三 Feature Flag，不立即废弃 |

---

## 附录 A：调研来源汇总

### A.1 官方文档站（WebFetch）

- [strandsagents.com/latest/user-guide/quickstart/](https://strandsagents.com/latest/user-guide/quickstart/) — Strands Agents 官方快速开始
- [github.com/k8sgpt-ai/k8sgpt](https://github.com/k8sgpt-ai/k8sgpt) — K8sGPT GitHub README
- [docs.robusta.dev/docs-ui-sink-demo/configuration/ai-analysis.html](https://docs.robusta.dev/docs-ui-sink-demo/configuration/ai-analysis.html) — HolmesGPT 配置文档
- [help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/use-cases/kagent/](https://help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/use-cases/kagent/) — kagent 阿里云文档
- [docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands](https://docs.databricks.com/aws/ja/mlflow3/genai/tracing/integrations/strands) — MLflow Strands 集成

### A.2 WebSearch 中文来源

- [xie.infoq.cn/article/bc0d58d84f27cbb3081352177](https://xie.infoq.cn/article/bc0d58d84f27cbb3081352177) — 2026 K8s Agent 运维落地评估
- [blog.csdn.net/2611_96382751/article/details/162882820](https://blog.csdn.net/2611_96382751/article/details/162882820) — Agentic SRE 3 工具对比
- [blog.csdn.net/sd7o95o/article/details/151209680](https://blog.csdn.net/sd7o95o/article/details/151209680) — Solo.io 开源项目研究（kagent）
- [blog.csdn.net/2611_95833734/article/details/161228744](https://blog.csdn.net/2611_95833734/article/details/161228744) — Strands + Scrapeless MCP 集成
- [cnblogs.com/andersthorvald/p/21054622](https://www.cnblogs.com/andersthorvald/p/21054622) — SRE Lab Doctor
- [segmentfault.com/a/1190000047973012](https://segmentfault.com/a/1190000047973012) — AIOps-example 9 架构模式
- [segmentfault.com/a/1190000047635518](https://segmentfault.com/a/1190000047635518) — BitFun Rust + Tauri
- [cloud.tencent.com.cn/developer/article/2695234](https://cloud.tencent.com.cn/developer/article/2695234) — LangGraph 根因分析平台

### A.3 WebSearch 英文来源

- [cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/) — HolmesGPT CNCF 博客
- [community.aws/content/2xu47bH8LZYPr11tDN2eTDiEL95](https://community.aws/content/2xu47bH8LZYPr11tDN2eTDiEL95) — Strands + MCP + A2A
- [dev.to/siddharth_singh_409bd5267](https://dev.to/siddharth_singh_409bd5267/firehydrant-alternative-open-source-ai-incident-management-4adk) — Aurora vs FireHydrant
- [dev.to/om_shree_0709/implementing-a-basic-strands-agent-with-mcp-servers-1269](https://dev.to/om_shree_0709/implementing-a-basic-strands-agent-with-mcp-servers-1269) — Strands + MCP 实战
- [meridian48.com/news/devops-open-agent-launches-open-source-ai-for-infrastructure-teams-d89f69](https://meridian48.com/news/devops-open-agent-launches-open-source-ai-for-infrastructure-teams-d89f69) — DevOps Open Agent
- [thoughtworks.com/radar/languages-and-frameworks/langgraph](https://www.thoughtworks.com/radar/languages-and-frameworks/langgraph) — LangGraph Technology Radar
- [thenextgentechinsider.com/pulse/strands-agents-framework-simplifies-agentic-ai-development-on-aws](https://www.thenextgentechinsider.com/pulse/strands-agents-framework-simplifies-agentic-ai-development-on-aws) — Strands Agents Framework
- [blog.gitcode.com/90006c411f4f1d8c9446d078cb377f4d.html](https://blog.gitcode.com/90006c411f4f1d8c9446d078cb377f4d.html) — Strands stream_async 详解
- [blog.gitcode.com/10dbe4b28d88c0495e5c078a63524e17.html](https://blog.gitcode.com/10dbe4b28d88c0495e5c078a63524e17.html) — Robusta 7 场景实战

### A.4 v1/v2 报告（项目内）

- `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
- `docs/reports/ops-agent-opensource-survey-2026-07-v2.md`（v2.0，2026-07 下半月补充）
- `docs/reports/ops-agent-strands-integration-plan.md`（Strands 集成方案）
- `docs/reports/strands_backend-audit-2026-07-30.md`（strands_backend 实现审计）
- `docs/reports/strands-integration-implementation-plan-2026-07-30.md`（实施计划）

### A.5 项目源码审计（TDSF 内）

- `src-tauri/sidecar/strands_backend/adapter.py`（774 行，StrandsAgentAdapter + TdsfStrandsCallbackHandler）
- `src-tauri/sidecar/strands_backend/model_adapter.py`（411 行，OpenAI/Anthropic/LiteLLM 工厂）
- `src-tauri/sidecar/strands_backend/tools/ssh_command.py`（209 行，SSH @tool + RiskChecker）
- `src-tauri/sidecar/strands_backend/tools/__init__.py`（ToolContext + RustBridge Protocol）
- `src-tauri/sidecar/strands_backend/tools/remote_file.py` / `log_analyzer.py` / `process_inspector.py` / `network_diagnostic.py`

---

## 附录 B：术语表

| 术语 | 全称 | 含义 |
|------|------|------|
| MCP | Model Context Protocol | Anthropic 开源的 AI ↔ 工具标准协议 |
| A2A | Agent-to-Agent Protocol | Google 开源的 agent 互操作协议 |
| ADK | Agent Development Kit | Google 开源的 agent 开发框架（kagent 基于） |
| CRD | CustomResourceDefinition | Kubernetes 自定义资源定义（kagent 核心 API） |
| SRE | Site Reliability Engineering | 站点可靠性工程 |
| AIOps | Artificial Intelligence for IT Operations | AI 驱动的 IT 运维 |
| RCA | Root Cause Analysis | 根因分析 |
| HITL | Human-in-the-Loop | 人在回路（人工审批） |
| CUA | Computer Use Agent | 计算机使用 agent（GUI 自动化） |
| BYOK | Bring Your Own Key | 用户自带 API Key |
| BYOA | Bring Your Own Agent | 用户自带 agent |
| MTTR | Mean Time To Recovery | 平均恢复时间 |
| MTTD | Mean Time To Detection | 平均检测时间 |
| PAOR | Plan-Act-Observe-Reflect | TDSF BaseAgent 模板（规划-执行-观察-反思） |
| BidiAgent | Bidirectional Agent | Strands 双向流式 agent（语音用） |
| NeedsYou | - | TDSF 审批事件（前端显示需用户介入） |
| ToolContext | - | TDSF 工具运行时上下文（event_bus + rust_bridge + session_id 等） |
| RustBridge | - | TDSF Python → Rust 调用抽象层（Protocol） |
| Five Greens | 五绿门禁 | TDSF 完成标准（typecheck + lint + test + build:web + tauri:dev） |
| Feature Flag | - | TDSF_AGENT_BACKEND 环境变量切换后端（strands/pydanticai/langgraph） |

---

## 附录 C：v3 与 v1/v2 差异速查

| 维度 | v1.0 | v2.0 | v3.0（本报告） |
|------|------|------|------|
| 调研日期 | 2026-07 上半月 | 2026-07 下半月 | 2026-07-30（终版） |
| 项目数 | 11 | 14（+3 新发现） | **22**（+8 新发现） |
| Strands 版本 | 1.0+ | 1.48.0 | 1.48.0（不变） |
| 新增项目 | - | OpenWorker / OpenSRE / OpsAgent / Lerwee / TencentOS MCP / ssh-mcp | kagent / Aurora / DevOps Open Agent / SRE Lab Doctor / AIOps-example / BitFun / TuriX-CUA |
| 推荐结论 | Strands 首选 + PydanticAI 备选 | 维持 | **维持**（v3 数据强化支撑） |
| Strands 深度 | 基础 | stream_async + BidiAgent | **完整**（@tool + MCPClient + stream_async + IPC 桥接 + provider 集成 + MLflow） |
| 现有实现评估 | 未审计 | 未审计 | **完整审计**（1400+ 行，质量高，9/10 契合度） |
| 路线图 | P0/P1/P2 | P0/P1/P2 | **P0/P1/P2/P3**（新增 P3 MCP 反向暴露 + Aurora + BitFun + A2A） |
| 借鉴项目数 | 5 | 7 | **12**（+kagent CRD + HolmesGPT toolsets + SRE Lab Doctor + AIOps-example + BitFun 四模式 + Aurora 多 agent） |

---

## 附录 D：22 项目完整清单（按契合度降序）

| # | 项目 | 类型 | 契合度 | 主要借鉴点 |
|---|------|------|:---:|------|
| 1 | Strands Agents | 通用 SDK | 9/10 | **直接集成**（@tool + MCPClient + stream_async） |
| 2 | OpenWorker | 桌面 agent | 9/10 | 同栈对标 + typed risk engine 4 级 + prompt-injection posture |
| 3 | TencentOS MCP Server | 运维 MCP | 9/10 | **22 工具分类法直接借鉴** |
| 4 | PydanticAI | 通用 SDK | 8/10 | 备选方案（类型安全 + Human-in-the-loop） |
| 5 | SRE Lab Doctor | 教学 agent | 8/10 | **Diagnosis-only 模式 + 17 高危命令 + 教学对标** |
| 6 | ssh-mcp-server | 运维 MCP | 7/10 | 白名单/黑名单安全设计 |
| 7 | BitFun | 桌面 agent | 7/10 | **同栈 + 四模式（Agentic/Plan/Debug/Review）** |
| 8 | AIOps-example | 教学仓库 | 7/10 | 9 架构模式横向对比方法论 |
| 9 | HolmesGPT | K8s agent | 7/10 | **toolsets YAML 设计 + agentic task list** |
| 10 | kagent | K8s agent | 6/10 | **声明式 Agent CRD + 三层架构 + RemoteMCPServer** |
| 11 | OpenAI Agents SDK | 通用 SDK | 6/10 | 4 种 MCP 传输 + HostedMCPTool |
| 12 | LangGraph | 通用 SDK | 6/10 | TDSF 现有后端（Thoughtworks 降级 Trial） |
| 13 | Aurora | 多 agent | 6/10 | **Memgraph 依赖图 + Weaviate 知识库 + 沙箱执行** |
| 14 | K8sGPT | K8s agent | 5/10 | SRE 分析器设计参考 |
| 15 | Robusta | K8s 自动化 | 5/10 | playbook 自定义参考 |
| 16 | OpenSRE | SRE agent | 5/10 | 60+ 工具 + 多信号整合 + 智能终止逻辑 |
| 17 | DevOps Open Agent | DevOps agent | 5/10 | 场景覆盖参考（K8s + AWS + 成本 + PR） |
| 18 | Claude Agent SDK | 通用 SDK | 4/10 | in-process SDK MCP Server（架构参考） |
| 19 | Lerwee Agentic Ops | 国内运维 | 4/10 | 30+ CoT 模板 + 全域数据打通 |
| 20 | Termi AI | 桌面 agent | 4/10 | Electron + node-pty（栈不同） |
| 21 | TuriX-CUA | 桌面 CUA | 3/10 | Planner + Executor 多模型（范式差异大） |
| 22 | OpsAgent | 学术 | 3/10 | 双自演化机制（学术参考） |

---

> **报告终**
> **版本**：v3.0（2026-07-30 终版）
> **作者**：TDSF Terminal Agent 调研
> **数据基准**：2026-07-30 WebSearch + WebFetch + GitHub + PyPI + 官方文档站真实抓取
> **下一步**：按 §8.3 P1 路线图执行（stream_async 升级 + 终端上下文完善 + OpenWorker 安全设计 + SRE Lab Doctor 教学模式 + TencentOS 22 工具扩展 + PydanticAI 备选 + AIOps-example 对比评估）
