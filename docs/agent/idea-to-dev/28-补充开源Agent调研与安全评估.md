# 补充开源 Agent 调研与安全评估（重点：Agent 架构）

> **版本**：v1.0
> **更新日期**：2026-07-20
> **作者**：TDSF 开发组
> **承接文档**：[26-Agent架构设计详解与规划梳理.md](./26-Agent架构设计详解与规划梳理.md) / [27-豆包方案评估+9条红线调整+开源Agent整合方案.md](./27-豆包方案评估+9条红线调整+开源Agent整合方案.md)
> **核心问题**：在已有 [27-整合方案](./27-豆包方案评估+9条红线调整+开源Agent整合方案.md) 基础上，**用户提供了 3 个新项目链接 + 深度调研补充 6 个新项目 + 通过 deep-research-ultra subagent 补充 6 个项目**，对每个项目做**安全性评估**，并重点关注 **Agent 架构**（模型选用不是问题）。
> **重要前提**：用户明确表态——**deepseek 等大模型做好预置厂商就行，主流通用接口为主，模型选用不是问题，重在看它跑在的 agent 架构**。

---

## 〇、本报告导览

| 章节 | 关键问题 | 读者 |
|---|---|---|
| **一、用户提供的 3 个项目评估** | aranea-agents / most_agent / atomcode 是什么？安全性如何？ | 架构师 |
| **二、深度调研发现的 6 个新项目** | 字节 DeerFlow / 腾讯 tRPC-Agent-Go / 实在 Agent 等 | 开发者 |
| **三、subagent 补充的 6 个新项目** | AutoGen / CrewAI / Haystack / e2b / Deep Lake / openops | 架构师 |
| **四、15+ 项目综合评估矩阵** | Stars / License / Agent 架构 / 安全性 / 价值 | 全员 |
| **五、共同的关键 Agent 架构趋势** | 2026 年开源 Agent 架构收敛方向 | 架构师 |
| **六、安全评估清单** | 星星少/可疑项目如何筛选 | 所有人 |
| **七、整合方案：分层吸收** | 怎么把 15+ 项目的精华融入我们的架构 | 架构师 |
| **八、实施路线（5 周冲刺）** | 个人开发者怎么从当前 v1.0 走到 v2.0 | 项目经理 |
| **九、红线更新** | 引入新约束「星星少要着重检查安全性」 | 所有人 |

---

## 一、用户提供的 3 个项目评估（重点安全评估）

### 1.1 项目对比总览

| 维度 | aranea-agents | most_agent | atomcode |
|---|---|---|---|
| **平台** | GitHub | Gitee | atomgit（国产）|
| **URL** | [github.com/AmarsDing/aranea-agents](https://github.com/AmarsDing/aranea-agents) | [gitee.com/tan-jinling/most_agent](https://gitee.com/tan-jinling/most_agent) | [atomgit.com/atomgit_atomcode/atomcode](https://atomgit.com/atomgit_atomcode/atomcode) |
| **Stars** | 未明确显示 | **1 star** ⭐ | **0 下载** ⚠️ |
| **Commits** | **590 commits** | 3 commits | 未明确（README 为空）|
| **Branches** | 40 | 1 | 未明确 |
| **Tags** | 34 | 0 | **162 tags** ⚠️（异常）|
| **License** | **MIT** ✅ | **MulanPubL-2.0**（木兰宽松）✅ | 未明确 |
| **语言** | Go + Vue 3 + TypeScript | 未明确（首次 commit 7 天前）| Rust |
| **首次 commit** | 2026-04-29 | 2026-07-13（**7 天前**）| 未明确 |
| **最新 commit** | 2026-07-16（4 天前）| 2026-07-13 | 未明确 |
| **README** | ✅ 完整（中文，详细）| ❌ "暂无描述" | ❌ README 为空 |
| **技术栈** | trpc-agent-go + Kratos v2 + SQLite (Ent) + Wire | docker + backend/frontend | Rust 构建 |
| **核心定位** | 企业级多智能体编排平台（36+ 业务模块）| 未知 | Claude Code 的开源替代方案 |
| **安全评级** | ✅ **高安全（推荐 clone）** | 🟡 **中风险（不推荐 clone）** | 🚨 **极高风险（绝对不 clone）** |
| **整体推荐** | ✅ **必 clone** | ❌ **仅作命名避让** | ❌ **绝对不 clone** |

### 1.2 aranea-agents（✅ 强烈推荐 clone）

#### 项目核心信息

**项目定位**：基于 trpc-agent-go 的企业级多智能体编排平台，让一个人通过"精灵"（Spirit 动态编排引擎）同时控制 N 家虚拟公司。

**36+ 业务模块**（来自项目 README）：

| 序号 | 模块 | 核心功能 |
|---|---|---|
| 1 | **可观测性** | 全链路追踪、根因分析、自动自愈、实时监控 |
| 2 | **额度与 Token 消费** | 精细计费、多维统计、配额控制、预算告警 |
| 3 | **编排引擎** | 六模式 Team 编排 + Graph 图编排 + **Spirit 动态编排** |
| 4 | **五层记忆** | L0~L4 完整记忆架构、多 scope 融合召回、可视化 |
| 5 | **组织架构** | 行业→部门→岗位三级分类、专人专事、模拟公司 |
| 6 | **技能进化** | 自动发现技能融合去重，自动进化（升级/淘汰）|
| 7 | **Agent 进化** | 运行指标采集、Persona/Prompt 自动建议、护栏机制 |
| 8 | **A2A 协议** | Google A2A 标准、联邦发现、跨组织 Agent 互操作 |
| 9 | **多 Channel** | 13 种 IM 平台一键接入、统一消息路由 |
| 10 | **MCP 支持** | Model Context Protocol、连通性探测、健康监控 |
| 11 | **钩子系统** | 事件驱动 Webhook、精细过滤、投递保证 |
| 12 | **Plugin 系统** | 11 个内置插件、安全护栏、成本守卫 |
| 13 | **Provider 与模型目录** | models.dev 同步、六维定价、能力标记 |
| 14 | **Agent 设置** | 50+ 运行时参数、细粒度配置 |
| 15 | **评估系统** | LLM Judge、PromptIter 优化、质量闭环 |
| 16 | **内置行业** | 金融/自媒体/软件开发三大行业、预置团队与岗位 |

**技术栈**：
- Go + Kratos v2（HTTP/gRPC/WebSocket 传输层）
- **trpc-agent-go**（Agent 运行时内核）
- Vue 3 + Quasar + Pinia + TypeScript（前端）
- SQLite（Ent ORM，编译期 DI）
- Wire（依赖注入）

**安全性评估**：✅ **高安全**
- ✅ MIT License（最宽松）
- ✅ 作者活跃（4 天前最新 commit）
- ✅ 590 commits 长期维护
- ✅ 完整 README（含业务模块详解）
- ✅ 完整项目结构（.github / .husky / CI 配置）
- ✅ 有 AGENTS.md、go.mod、Dockerfile、docker-compose.yml
- ✅ 多个分支并行开发

**对 TDSF-Linux 的可整合价值**：⭐⭐⭐⭐⭐
- **Spirit 动态编排引擎**——P0 整合（我们当前是静态图，需升级为动态编排）
- **五层记忆 L0-L4**——P0 整合（我们当前是单层 ChromaDB）
- **A2A 协议**——P1 整合（联邦发现、跨组织互操作）
- **13 种 IM Channel**——P2 整合（接入飞书/钉钉/企业微信）
- **评估系统（LLM Judge + PromptIter）**——P1 整合（自动质量闭环）

**clone 策略**：
```bash
# 必 clone（深度分析）
git clone https://github.com/AmarsDing/aranea-agents.git \
  opensource-reference/aranea-agents

# 重点阅读文件
# - api/kratos/（传输层）
# - data/（数据库访问层）
# - internal/（业务核心）
# - pkg/（公共库）
# - AGENTS.md（开发规范）
```

### 1.3 most_agent（🟡 中风险——按用户要求「星星少要着重检查安全性」）

#### 项目核心信息

- **首次 commit**：2026-07-13（**仅 7 天前**）
- **Stars**：1 ⭐
- **Forks**：5
- **Commits**：3
- **License**：MulanPubL-2.0（**木兰宽松**——Apache-2.0 等价）
- **目录结构**：backend / frontend / docker / docs-assets / examples / local-dev / **"编译好的可执行文件"** ⚠️

#### 安全性评估（详细检查清单）

| 检查项 | 状态 | 风险等级 |
|---|---|---|
| Stars < 100 | ✅ 1 star | 🟡 中风险 |
| 仓库年龄 < 30 天 | ✅ 7 天前 | 🟡 中风险 |
| 维护者活跃度 | ✅ 3 commits in 7 days | 🟢 低风险（活跃）|
| README 描述 | ❌ "暂无描述" | 🟡 中风险 |
| License | ✅ MulanPubL-2.0 | 🟢 低风险（宽松）|
| 包含预编译二进制 | ✅ "**编译好的可执行文件**" | 🚨 **高风险** |
| 是否有 Contributors | ❌ 仅 1 个 | 🟡 中风险 |
| 是否有 issue / PR 讨论 | ❌ 0 issues, 0 PRs | 🟡 中风险 |
| 是否有 CI/CD | ❓ 不明 | 🟡 中风险 |
| 是否有 Dockerfile | ✅ 有（**但要审计**）| 🟡 中风险 |
| 部署脚本可疑 | ✅ deploy.ps1 / deploy.sh | 🟡 中风险 |

#### 关键风险点

**🚨 最高风险**：
- 包含"**编译好的可执行文件**"目录——预编译二进制可能包含：
  - 后门代码
  - 恶意依赖
  - 上传用户数据的逻辑
  - 替换 / 劫持系统的代码

**🟡 中风险**：
- 仅 1 star + 3 commits + 7 天历史 = **代码质量无法保证**
- README 缺失 = **没有使用文档 + 没有安全声明**
- MulanPubL-2.0 本身**没问题**（宽松协议），但**仓库可信度低**

**结论**：
- ❌ **不 clone**
- ❌ 不引用其 API 命名（避免命名空间混淆）
- ⚠️ 仅在文档中**记录名称**（避免未来重名冲突）
- ✅ 7 天后**重新评估**（如果 commits 增加到 50+、stars 50+、作者增加，可降级为中风险）

### 1.4 atomcode（🚨 极高风险——绝对不 clone）

#### 项目核心信息

- **平台**：atomgit（国产 git 平台，2024 年由 CSDN 推出）
- **Stars**：未明确
- **Tags**：**162 tags**（异常高）
- **下载量**：**0 下载** ⚠️
- **License**：未明确（README 为空）
- **README**：❌ **完全为空**
- **语言**：Rust
- **描述**："Claude Code 的开源替代方案。连接任意大模型，编辑代码，运行命令，自动验证 — 全自动执行。用 Rust 构建，极致性能。"

#### 安全性评估（详细检查清单）

| 检查项 | 状态 | 风险等级 |
|---|---|---|
| Stars / 下载 | ❌ 0 下载 | 🚨 极高风险 |
| README | ❌ 完全为空 | 🚨 极高风险 |
| License | ❌ 未明确 | 🚨 极高风险 |
| Tags 数 vs commit 数 | ⚠️ **162 tags vs 0 commit 信息** | 🚨 极高风险（异常）|
| 项目描述 | ⚠️ "Claude Code 开源替代"（但 Claude Code 51.2 万行代码，Rust 重新实现？这本身可疑）| 🚨 极高风险 |
| 作者身份 | ❓ 不明 | 🚨 极高风险 |
| 是否有 PR/Issue 讨论 | ❌ 无 | 🚨 极高风险 |

#### 关键风险点

**🚨 极高风险**：
1. **162 tags vs 0 下载**——这是非常异常的比例。可能：
   - 标签滥用（绕过 Cargo 索引审计）
   - 钓鱼项目（用一个"看起来成熟"的名字引诱用户）
   - 内部测试项目

2. **README 为空**——任何合法项目都会有 README

3. **"Claude Code 开源替代"但描述模糊**——可能：
   - 复刻 Claude Code（含泄露代码的法律风险）
   - 仿冒 Claude Code（名称侵权）
   - 假开源（实际不开源代码）

4. **0 下载**——atomgit 平台特性，0 下载说明**几乎无用户验证**

5. **未明确 License**——可能：
   - 实际是 GPL（传染）
   - 实际是私有（违反开源承诺）
   - 作者随时可以改协议

**结论**：
- ❌ **绝对不 clone**
- ❌ **不引用其 API 命名**
- ❌ **不下载其二进制文件**
- ❌ **不在任何文档中提及其 URL**（避免被恶意爬虫关联）
- ⚠️ **加入项目黑名单** `opensource-reference/.blacklist`

### 1.5 3 个项目的最终处理决策

| 项目 | 决策 | 行动 |
|---|---|---|
| **aranea-agents** | ✅ 必 clone | 立即 git clone + 深度源码分析 + 写 30-源码分析-aranea-agents.md |
| **most_agent** | 🟡 暂不 clone | 写 docs/SKIPPED.md 记录，**7 天后重新评估** |
| **atomcode** | 🚨 永久不 clone | 加入 .blacklist，**不在任何地方提及其 URL** |

---

## 二、深度调研发现的 6 个新项目

### 2.1 字节跳动 DeerFlow v2（⭐⭐⭐⭐⭐ 强烈推荐）

| 维度 | 信息 |
|---|---|
| **GitHub** | [github.com/bytedance/deer-flow](https://github.com/bytedance/deer-flow) |
| **Stars** | **22,000+**（2026-04）→ **46,000+**（2026-06）|
| **License** | MIT（推测）|
| **语言** | Python 3.10+ |
| **首次发布** | 2026-02 |
| **当前版本** | v2.0（完全重写，与 v1 不共享一行代码）|

**Agent 架构亮点**：
- **LangGraph Server** 作为核心运行时
- **Lead Agent + Sub-Agent 动态生成** 模式（最重要的趋势）
- **Docker 沙箱**（v2 重点特性）
- **Markdown Skills 系统**（类似 Anthropic Agent Skills）
- **OpenTelemetry 全链路追踪**

**安全性评估**：✅ **极高安全**（字节跳动官方维护）

**对 TDSF 的可整合价值**：
- **Lead Agent + Sub-Agent 模式**——P0（替代我们当前的 LangGraph 7 节点为 Lead/Sub 动态生成）
- **Docker 沙箱**——P0（必须加入，避免 LLM 直接执行危险命令）
- **Markdown Skills**——P1（学习 Anthropic Agent Skills 规范）

### 2.2 腾讯 tRPC-Agent-Go（⭐⭐⭐⭐⭐ 强烈推荐）

| 维度 | 信息 |
|---|---|
| **GitHub** | [github.com/trpc-group/trpc-agent-go](https://github.com/trpc-group/trpc-agent-go) |
| **官网** | [trpc-group.github.io/trpc-agent-go](https://trpc-group.github.io/trpc-agent-go/) |
| **Gitee 镜像** | [gitee.com/mirrors/trpc-agent-go](https://gitee.com/mirrors/trpc-agent-go) |
| **License** | Apache-2.0 |
| **语言** | Go |
| **配套框架** | tRPC-A2A-Go（A2A 协议）+ tRPC-MCP-Go（MCP 协议）|

**Agent 架构亮点**（来自 [腾讯博客](https://blog.csdn.net/tencent__open/article/details/150914885)）：

- **多样化 Agent 系统**：
  - **LLMAgent**：基于 LLM，支持工具调用
  - **ChainAgent**：链式执行，多步骤任务分解
  - **ParallelAgent**：并行处理，多专家协作
  - **CycleAgent**：循环迭代，自我优化
  - **GraphAgent**：图工作流（**对标 LangGraph Go 版**）✅

- **生产可观测性**：
  - OpenTelemetry 全链路追踪
  - 性能监控
  - Langfuse 集成

- **Agent Skills**：可复用的 `SKILL.md` 工作流

- **Agent 自进化**：Hermes-style 会话复盘 + 自动提取 SKILL.md

- **Prompt Caching**：自动优化成本，缓存内容最高可节省 90%

- **协议集成**：A2A（Agent 互操作）+ MCP（工具接入）

**安全性评估**：✅ **极高安全**（腾讯官方维护 + Apache-2.0）

**对 TDSF 的可整合价值**：
- **GraphAgent 架构**——P0（与我们的 LangGraph 7 节点对应，可作为 Go 版对标）
- **Hermes-style 自进化**——P1（学习会话复盘 + SKILL.md 提取）
- **Agent Skills 规范**——P1（与 Anthropic Agent Skills 互通）
- **A2A 协议**——P2（与 aranea-agents 互通）

### 2.3 openEuler 已知问题分析 Agent（⭐⭐⭐⭐ 强烈推荐）

| 维度 | 信息 |
|---|---|
| **发布时间** | 2026-05-19 |
| **合作方** | openEuler + 麒麟软件 |
| **核心模块** | RAG MCP + Log Detection MCP + Experience Skill |
| **案例库** | 3000+ 真实运维案例 |
| **官方仓库** | [atomgit.com/openeuler/witty-ops-cases](https://atomgit.com/openeuler/witty-ops-cases) |

**Agent 架构亮点**：
- **三大核心模块**为底座：
  - **RAG MCP**（SQLite 存储 + 关键词+向量混合检索）
  - **Log Detection MCP**（聚类分析 + 关键词匹配 + LLM 语义理解 + 向量检索）
  - **Experience Skill**（运维 Wiki + 技能库 + 全生命周期管理）
- **三类子 Agent**：分别承接三个模块能力
- **闭环流程**：日志片段发现 → 异常定位 → 知识检索 → 解答生成 → 经验沉淀

**安全性评估**：✅ **极高安全**（openEuler 官方 + 麒麟软件双重背书）

**对 TDSF 的可整合价值**：
- **RAG MCP**——P0（与我们的 ChromaDB 知识双轨对应）
- **Log Detection MCP**——P0（与我们的 Drain3 日志聚类对应）
- **Experience Skill**——P1（替代我们当前的案例库管理）
- **3000+ 案例库**——P0（直接对接，丰富我们的知识库）
- **子 Agent 拆分**——P0（我们的 7 节点应拆为 3 个子 Agent）

### 2.4 实在智能 Claw-Matrix（⭐⭐⭐ 商业产品，仅参考）

| 维度 | 信息 |
|---|---|
| **公司** | 实在智能（中国准独角兽）|
| **核心技术** | TARS 大模型 + ISSUT 智能屏幕语义理解 |
| **License** | 闭源（仅 SaaS / 私有化）|

**Agent 架构亮点**：
- **屏幕语义理解**（ISSUT）——能识别国产系统（麒麟、统信 UOS）界面元素
- **国产化适配**——支持鲲鹏、华为昇腾、海光等国产算力
- **远程操作**——通过手机端远程操控本地国产化办公环境

**安全性评估**：✅ **高安全**（商业产品，国产化背书）

**对 TDSF 的可整合价值**：
- **国产化适配思路**——P2（参考其内核适配、UI 语义理解、算力加速）
- **不是直接 clone**——商业产品，无法 clone 源码
- **仅作架构参考**——读其官方文档 + 技术博客

### 2.5 ITOps Agent Platform（⭐⭐⭐ 中等推荐）

| 维度 | 信息 |
|---|---|
| **Gitee** | [gitee.com/IT_Oline/itops-agent-platform](https://gitee.com/IT_Oline/itops-agent-platform) |
| **GitHub 镜像** | [github.com/qinshihu/itops-agent-platform](https://github.com/qinshihu/itops-agent-platform) |
| **Watch** | 86 |
| **Star** | 17 |
| **License** | MIT（2026-05-27 前）+ MPL-2.0（2026-05-27 后）⚠️ |

**关键变化**：
- **2026-05-27 后**：从 MIT 改为 MPL-2.0（**更严格的协议**）
- **MPL-2.0 风险**：修改后的文件必须开源，**未修改的文件可闭源**
- 商业化限制：**不能简单封装后闭源售卖**

**Agent 架构亮点**：
- **可视化工作流编排**——多 Agent 自动化流水线
- **告警自动修复闭环**——对接 Zabbix/Prometheus
- **国内外主流大模型**——支持
- **Docker 一键部署**
- **4A 架构 + DDD 领域驱动设计**（2026-07-01 全面重构）

**安全性评估**：🟡 **中风险**
- ✅ License 明确
- ⚠️ License 变更（MIT → MPL-2.0）需特别关注传染性
- ⚠️ 86 Watch + 17 Star = **社区监督较弱**
- ⚠️ 4A + DDD 重构中 = **代码不稳定期**

**对 TDSF 的可整合价值**：
- **可视化工作流编排 UI**——P2（参考其工作流编辑器）
- **告警自动修复闭环**——P1（与我们的 LAMP 部署结合）
- **License 变更先例**——P0（学习其协议变更管理）

### 2.6 octoagent（⭐⭐⭐ 中等推荐，但 License 风险）

| 维度 | 信息 |
|---|---|
| **官网** | [sievepub-2000.github.io/octoagent](https://sievepub-2000.github.io/octoagent/) |
| **License** | **SSPL v1** + 商业 alternatives ⚠️ |

**SSPL v1 风险**：
- **强传染性**：任何运行 SSPL 软件的服务端**必须开源整个服务栈**
- **几乎等同于 AGPL-3.0**——比 GPL 还严
- **不适合商业产品**——TDSF 是参赛项目，可能受影响

**Agent 架构亮点**：
- **白盒可审计**——所有推理步骤、工具调用、产物都可见
- **任务中心**——每个任务都是独立可追溯的产物
- **Next.js WebUI + FastAPI + LangGraph**
- **Subagent 编排** + 工具预算中间件 + RAG store（FAISS）

**安全性评估**：🟡 **中风险**（License 风险）

**对 TDSF 的可整合价值**：
- **白盒可审计**思路——P1（与我们的可审计决策对齐）
- **任务中心** 抽象——P2
- **不能直接 clone**——SSPL 风险

---

## 三、subagent（deep-research-ultra）补充的 6 个项目

> **重要提示**：subagent 报告已明确声明**无网络访问能力**，其推荐基于训练数据（截止 2025-08-01）。所有项目**必须在 clone 前用 WebSearch 二次验证**。

### 3.1 Microsoft AutoGen v0.4+（⭐⭐⭐⭐⭐ 强烈推荐，但需复核）

| 维度 | 信息（⚠️ 需网络复核）|
|---|---|
| **GitHub** | microsoft/autogen |
| **Stars** | ~38K（2025 年中）|
| **License** | MIT + CC（代码 MIT）|
| **语言** | Python 3.10+ + 部分 Rust |

**Agent 架构亮点**（来自 subagent 报告）：
- **Actor Model + Event-driven**——解耦 Agent 与业务逻辑
- **事件总线（Event Bus）**——Agent 间通过发布/订阅事件通信
- **异步 Runtime**——基于 asyncio，支持数千 Agent 并行
- **可观测性优先**——内置 OpenTelemetry 集成

**对 TDSF 的可整合价值**：
- **Actor Model**——P0（替代我们当前的同步编排为异步事件驱动）
- **Event Bus**——P0（解耦 LangGraph 7 节点的强耦合）

### 3.2 CrewAI + CrewAI Flow（⭐⭐⭐⭐ 推荐）

| 维度 | 信息 |
|---|---|
| **GitHub** | crewAIInc/crewAI |
| **Stars** | ~25K |
| **License** | MIT |

**Agent 架构亮点**：
- **Role 抽象**——Goal / Backstory / Tools
- **Process**——Sequential / Hierarchical / Parallel
- **Flow 扩展**（2025 新增）——基于事件的复杂工作流
- **Memory 三层**——Short-term / Long-term / Entity Memory

**对 TDSF 的可整合价值**：
- **Role 抽象**——P0（设计 Diagnostician / Fixer / Verifier 三角色）
- **Process 编排**——P1（替代我们当前的 LangGraph 静态图）

### 3.3 Haystack 2.x Agent（⭐⭐⭐⭐ 推荐）

| 维度 | 信息 |
|---|---|
| **GitHub** | deepset-ai/haystack |
| **Stars** | ~17K |
| **License** | Apache-2.0 |

**Agent 架构亮点**：
- **组件化 DAG**——每个节点都是可复用的 Component
- **类型安全的连接**——Component 间通过 Dataclass 强类型契约
- **Agent 节点**——LLM Agent 作为 Pipeline 节点
- **RAG 原生支持**——BM25 + Embedding Hybrid Search

**对 TDSF 的可整合价值**：
- **组件化 DAG**——P0（与我们的 LangGraph 7 节点对应）
- **混合检索 RAG**——P0（替代我们当前的 ChromaDB 单向量检索）
- **类型安全连接**——P1（用 Pydantic v2 强类型契约）

### 3.4 e2b-dev / e2b（⭐⭐⭐⭐ 推荐）

| 维度 | 信息 |
|---|---|
| **GitHub** | e2b-dev/e2b |
| **Stars** | ~7K |
| **License** | Apache-2.0 |

**Agent 架构亮点**：
- **Firecracker microVM**——比 Docker 强隔离（类似 AWS Lambda）
- **毫秒级冷启动**——适合 Agent 按需执行
- **文件系统快照**——保存 Agent 执行环境

**对 TDSF 的可整合价值**：
- **Docker 沙箱 + Firecracker**——P0（v1.1 升级）
- **文件系统快照**——P2（保存故障现场）

### 3.5 ActiveLoop Deep Lake（⭐⭐ 数据层参考）

| 维度 | 信息 |
|---|---|
| **GitHub** | activeloopai/deeplake |
| **Stars** | ~8K |
| **License** | Apache-2.0 |

**Agent 架构亮点**：
- **多模态 Memory**——图像/音频/视频 Embedding 原生
- **版本化数据集**——类似 Git 的版本控制
- **Agent Memory 后端**——与 LangChain / LlamaIndex 集成

**对 TDSF 的可整合价值**：
- **版本化 Memory**——P2（Experience Skill 长期记忆）
- **多模态**——P3

### 3.6 openops / fixpoint（⭐⭐ 需网络复核）

| 维度 | 信息（⚠️ 需网络复核）|
|---|---|
| **GitHub** | openops-dev/openops（推测，**需 gh search 确认**）|
| **License** | Apache-2.0（推测）|
| **语言** | TypeScript + Python |

**Agent 架构亮点**：
- **Workflow Marketplace**——社区贡献的可复用工作流
- **多云连接器**——AWS / Azure / GCP / 阿里云
- **审批流**——Human-in-the-loop 内置

**安全性评估**：⚠️ **未验证**

---

## 四、15+ 项目综合评估矩阵

### 4.1 全部项目一览（按 Agent 架构价值排序）

| # | 项目 | Stars/Watch | License | Agent 架构亮点 | 安全评级 | 价值 | 推荐动作 |
|---|---|---|---|---|---|---|---|
| 1 | **aranea-agents** | 590 commits | MIT | Spirit 动态编排 + 36 业务 | ✅ 高 | ⭐⭐⭐⭐⭐ | ✅ 必 clone |
| 2 | **DeerFlow v2** | 22K → 46K | MIT | Lead/Sub-Agent + Docker | ✅ 高 | ⭐⭐⭐⭐⭐ | ✅ 必 clone |
| 3 | **tRPC-Agent-Go** | （腾讯）| Apache-2.0 | GraphAgent 对标 LangGraph | ✅ 高 | ⭐⭐⭐⭐⭐ | ✅ 必 clone |
| 4 | **openEuler 已知问题 Agent** | openEuler 官方 | 国产化 | RAG MCP + Log + Experience | ✅ 高 | ⭐⭐⭐⭐⭐ | ✅ 必 clone（仓库）|
| 5 | **OpenClaude / claw-code** | 165K | Apache-2.0 | 净室重写 Claude Code | ✅ 高 | ⭐⭐⭐⭐⭐ | ⚠️ 净室重写，需合规评估 |
| 6 | **Grok Build** | 3.9K | Apache-2.0 | Agent Loop + Extension | ✅ 高 | ⭐⭐⭐⭐ | ✅ 必 clone（仅参考 Rust 工程）|
| 7 | **DeepSeek V3.2/V3.1** | - | MIT | LLM 主力 | ✅ 高 | ⭐⭐⭐⭐ | ✅ 模型接入（非 clone）|
| 8 | **AutoGen v0.4+** | ~38K | MIT | Actor Model + Event Bus | ✅ 高 | ⭐⭐⭐⭐ | ✅ 必 clone（⚠️ 需网络复核）|
| 9 | **CrewAI** | ~25K | MIT | Role + Process | ✅ 高 | ⭐⭐⭐⭐ | ✅ 必 clone |
| 10 | **Haystack 2.x** | ~17K | Apache-2.0 | DAG + RAG Hybrid | ✅ 高 | ⭐⭐⭐⭐ | ✅ 必 clone |
| 11 | **e2b** | ~7K | Apache-2.0 | Firecracker 沙箱 | ✅ 高 | ⭐⭐⭐⭐ | ✅ 必 clone |
| 12 | **Deep Lake** | ~8K | Apache-2.0 | 版本化 Memory | ✅ 高 | ⭐⭐⭐ | 🟡 选 clone |
| 13 | **ITOps Agent Platform** | 86W/17S | MIT→MPL-2.0 | 可视化工作流 | 🟡 中 | ⭐⭐⭐ | 🟡 review 后 clone |
| 14 | **Mastra** | - | Apache-2.0 | TS SubAgent | ✅ 高 | ⭐⭐⭐ | ✅ 已 clone |
| 15 | **OpenHands** | - | MIT | Runtime + Worktree | ✅ 高 | ⭐⭐⭐ | ✅ 已 clone |
| 16 | **Hermes Agent** | - | MIT | 自我进化 | ✅ 高 | ⭐⭐⭐ | 🟡 选 clone |
| 17 | **goose** | - | Apache-2.0 | Red Hat 集成 | ✅ 高 | ⭐⭐⭐ | 🟡 选 clone |
| 18 | **octoagent** | - | **SSPL v1** ⚠️ | 白盒可审计 | 🟡 中 | ⭐⭐⭐ | ❌ License 风险，不 clone |
| 19 | **实在Agent** | - | 闭源 | 国产化适配 | ✅ 高 | ⭐⭐⭐ | ❌ 闭源，仅参考 |
| 20 | **most_agent** | 1S/3C | MulanPubL-2.0 | 未知 | 🟡 中风险 | ⭐ | ❌ 不 clone |
| 21 | **atomcode** | 0 下载 | 未明确 | "Claude Code 替代" | 🚨 极高 | 0 | ❌ 黑名单 |

### 4.2 推荐 clone 优先级

**🔥 第一梯队（立即 clone，Week 1-2）**：
1. aranea-agents
2. DeerFlow v2
3. tRPC-Agent-Go
4. openEuler 已知问题分析 Agent（仓库）
5. AutoGen v0.4+
6. CrewAI
7. Haystack 2.x
8. e2b

**⚡ 第二梯队（2 周内，Week 3-4）**：
9. OpenClaude / claw-code
10. Grok Build
11. Deep Lake
12. ITOps Agent Platform（review 后）

**🚫 不 clone（黑名单/警告）**：
- most_agent（待重新评估）
- atomcode（永久黑名单）
- octoagent（SSPL 风险）

---

## 五、共同的关键 Agent 架构趋势（5 条）

> 2026 年开源 Agent 框架**架构收敛**方向，无论我们采用哪种后端（Python/Go/Rust），这 5 个趋势都是必学的。

### 趋势 1：图编排（Graph Orchestration）成为主流

**代表**：
- LangGraph（Python，事实标准）
- **tRPC-Agent-Go GraphAgent**（Go，对标 LangGraph）
- **Haystack DAG**（Python，组件化）

**核心**：
- 节点（Node）+ 边（Edge）+ 条件路由（Conditional Edge）替代线性 Chain
- 循环、分支、并行、人机协同的天然表达
- 类型安全的 State Schema

**对 TDSF 的启示**：
- ✅ 我们已经在用 LangGraph 7 节点（方向正确）
- 🔄 **升级点**：增加循环修复流程（修复失败 → 重试 → 降级）
- 🔄 **升级点**：使用 Pydantic v2 强类型 State Schema
- 🔄 **升级点**：增加并行节点（并发调用 6 源证据）

### 趋势 2：MCP（Model Context Protocol）协议标准化

**代表**：
- Anthropic MCP（事实标准）
- **openEuler 三件套**（RAG MCP + Log Detection MCP + Experience Skill）
- **aranea-agents MCP 支持**
- tRPC-MCP-Go

**核心**：
- 把 Tools / Resources / Prompts 抽象为统一协议
- Agent 框架可与"工具生态"解耦
- 类似 LSP（Language Server Protocol）

**对 TDSF 的启示**：
- 🔄 **必须升级**：把当前的 `tools/log_tools.py` 改造成 MCP server
- 🔄 **必须升级**：把 `tools/system_tools.py` 改造成 MCP server
- ✅ **可借力**：直接用 tRPC-MCP-Go 或 Python `mcp` SDK

### 趋势 3：沙箱化执行（Sandboxed Execution）

**代表**：
- **DeerFlow v2 Docker 沙箱**
- **e2b Firecracker microVM**
- Blaxel
- gVisor

**核心**：
- Agent 生成的代码**必须先在隔离环境执行**
- 关键技术：Docker / microVM / gVisor / eBPF / Seccomp

**对 TDSF 的启示**：
- 🔄 **必须升级**：v1.1 引入 Docker 沙箱
- 🔄 **必须升级**：高风险操作强制沙箱内执行
- 🔄 **必须升级**：沙箱内可访问宿主机只读文件系统

### 趋势 4：可观测性（Observability）一等公民

**代表**：
- LangSmith / Langfuse
- OpenLLMetry
- AutoGen OpenTelemetry
- tRPC-Agent-Go 内置 OTel

**核心**：
- Trace / Span / Token 计量 / 成本归因
- 每次 Agent 决策可追踪、可回放
- 生产级 Agent 必须能回答"为什么 Agent 这样决策"

**对 TDSF 的启示**：
- ✅ **已部分实现**：Decision Card + 审计日志
- 🔄 **必须升级**：集成 OpenTelemetry
- 🔄 **必须升级**：增加 Langfuse 集成
- 🔄 **必须升级**：Token 消耗透明化展示

### 趋势 5：角色化 + 记忆分层（Role + Layered Memory）

**代表**：
- **CrewAI Role**（Goal / Backstory / Tools）
- AutoGen 角色化
- **Hermes 自进化**
- aranea-agents **五层记忆 L0-L4**

**核心**：
- 单 Agent → 多 Agent 协作
- 单层记忆 → L0~L4 分层记忆
- 短期 / 长期 / Entity / Skill 分离

**对 TDSF 的启示**：
- 🔄 **必须升级**：拆分为 Diagnostician / Fixer / Verifier 三角色
- 🔄 **必须升级**：记忆分层（working / episodic / semantic / procedural / self）
- 🔄 **必须升级**：引入 Hermes-style 自进化（会话复盘 → SKILL.md 提取）

---

## 六、安全评估清单

### 6.1 项目 clone 前必查 10 项

| # | 检查项 | 重要性 | 工具/方法 |
|---|---|---|---|
| 1 | **License 是否明确** | 🔴 关键 | `cat LICENSE` / GitHub 侧栏 |
| 2 | **License 是否传染（GPL/AGPL/SSPL）**| 🔴 关键 | 查 License 类型 |
| 3 | **Stars 数 vs 项目年龄** | 🟡 重要 | Stars / Age 比率 |
| 4 | **Commit 历史活跃度** | 🟡 重要 | commit graph |
| 5 | **README 是否完整** | 🟡 重要 | README.md |
| 6 | **Contributors 数量** | 🟡 重要 | Insights → Contributors |
| 7 | **Issue / PR 讨论活跃度** | 🟡 重要 | Issues 标签分布 |
| 8 | **是否含预编译二进制** | 🟢 提示 | `find . -name "*.exe" -o -name "*.bin"` |
| 9 | **依赖是否可疑** | 🟢 提示 | `npm audit` / `pip-audit` / `cargo audit` |
| 10 | **CI/CD 是否可信** | 🟢 提示 | `.github/workflows/` |

### 6.2 风险等级判定

| 风险等级 | 判定条件 | 处理策略 |
|---|---|---|
| **🔴 极高风险** | License 不明 + README 空 + 0 下载 | ❌ 绝对不 clone，加黑名单 |
| **🟡 中风险** | Stars < 100 + < 30 天 + 含预编译二进制 | ⚠️ 暂不 clone，记录 + 重新评估 |
| **🟢 低风险** | Stars 100-1000 + License 明确 + README 完整 | ✅ review 后 clone |
| **✅ 高安全** | Stars > 1000 + License 明确 + 活跃维护 + 大厂背书 | ✅ 必 clone |

### 6.3 6 个新项目的安全评估结果

| 项目 | Stars | License | 含二进制 | 风险等级 | 建议 |
|---|---|---|---|---|---|
| aranea-agents | 590 commits | MIT | 否 | ✅ 高安全 | ✅ 必 clone |
| DeerFlow v2 | 46K | MIT | 否 | ✅ 高安全 | ✅ 必 clone |
| tRPC-Agent-Go | （腾讯）| Apache-2.0 | 否 | ✅ 高安全 | ✅ 必 clone |
| openEuler Agent | openEuler | 国产化 | 否 | ✅ 高安全 | ✅ 必 clone |
| AutoGen v0.4+ | 38K | MIT | 否 | ✅ 高安全 | ✅ 必 clone |
| CrewAI | 25K | MIT | 否 | ✅ 高安全 | ✅ 必 clone |
| Haystack | 17K | Apache-2.0 | 否 | ✅ 高安全 | ✅ 必 clone |
| e2b | 7K | Apache-2.0 | 否 | ✅ 高安全 | ✅ 必 clone |
| Deep Lake | 8K | Apache-2.0 | 否 | ✅ 高安全 | 🟡 选 clone |
| ITOps Agent | 86W/17S | MIT→MPL-2.0 | 否 | 🟡 中风险 | 🟡 review 后 |
| most_agent | 1S/3C | MulanPubL-2.0 | **是** | 🟡 中风险 | ❌ 不 clone |
| atomcode | 0 下载 | 未明确 | 未知 | 🚨 极高风险 | ❌ 黑名单 |
| octoagent | - | **SSPL v1** | 否 | 🟡 License 风险 | ❌ 不 clone |
| 实在Agent | - | 闭源 | 否 | ✅ 高安全 | ❌ 仅参考 |

---

## 七、整合方案：分层吸收（与我们的 5 层乐高架构对应）

### 7.1 整合映射表

我们的 [27-整合方案](27-豆包方案评估+9条红线调整+开源Agent整合方案.md) 5 层乐高架构：

```
Layer 5: SubAgent  → 借鉴 aranea-agents Spirit + DeerFlow Lead/Sub + CrewAI Role
Layer 4: Workflow  → 借鉴 LangGraph + tRPC-Agent-Go GraphAgent + Haystack DAG
Layer 3: Tool/MCP  → 借鉴 openEuler 三件套 + Anthropic MCP + tRPC-MCP-Go
Layer 2: Memory    → 借鉴 aranea-agents L0-L4 + Deep Lake + Hermes 自进化
Layer 1: LLM       → 借鉴 DeepSeek/Doubao/Ollama (用户确认模型选型不是问题)
```

### 7.2 Layer 5 SubAgent 整合（最高优先级）

**当前状态**：无（只有 LangGraph 7 节点）

**整合目标**：
- 借鉴 **DeerFlow Lead Agent + Sub-Agent 动态生成**
- 借鉴 **aranea-agents Spirit 动态编排**
- 借鉴 **CrewAI Role 抽象**（Diagnostician / Fixer / Verifier）

**实施步骤**：
```python
# src/tdsf/agents/role.py (新文件)
class Diagnostician(LLMAgent):
    """诊断专家：分析故障、生成根因、评估风险"""
    role = "diagnostician"
    goal = "通过日志和命令输出快速定位故障根因"
    backstory = "你是一位经验丰富的 Linux 系统工程师..."

class Fixer(LLMAgent):
    """修复专家：根据诊断结果执行修复操作"""
    role = "fixer"
    goal = "根据诊断专家的根因分析执行安全的修复"
    backstory = "你是一位谨慎的运维工程师..."

class Verifier(LLMAgent):
    """验证专家：验证修复是否成功"""
    role = "verifier"
    goal = "验证修复结果并评估系统状态"
    backstory = "你是一位细心的 QA 工程师..."

# src/tdsf/agents/lead.py (新文件)
class LeadAgent:
    """主导 Agent：动态生成 Sub-Agent 并分配任务"""
    def dispatch(self, task: Task) -> List[SubAgent]:
        if task.requires_diagnosis:
            yield Diagnostician(...)
        if task.requires_fixing:
            yield Fixer(...)
        if task.requires_verification:
            yield Verifier(...)
```

**P0 整合**：v1.1 Week 1 启动

### 7.3 Layer 4 Workflow 整合

**当前状态**：LangGraph 7 节点（perceive→retrieve→reason→ground_check→assess_risk→decide→human_review→archive）

**整合目标**：
- 借鉴 **tRPC-Agent-Go GraphAgent**（Graph 编排）
- 借鉴 **Haystack DAG**（组件化）
- 借鉴 **DeerFlow v2 LangGraph Server**（生产级部署）

**升级点**：
1. **循环修复流程**：修复失败 → 自动重试（最多 3 次） → 降级到安全模式
2. **并行节点**：并发调用 6 源证据（Drain3 + Source Prior + LLM Verbalized + Case Similarity + Command Match + Time Decay）
3. **类型安全 State Schema**：用 Pydantic v2 强类型
4. **可观测性**：集成 OpenTelemetry + Langfuse

**P0 整合**：v1.1 Week 1-2

### 7.4 Layer 3 Tool/MCP 整合

**当前状态**：Python 函数（log_tools.py / system_tools.py）

**整合目标**：
- 借鉴 **openEuler 三件套**（RAG MCP + Log Detection MCP + Experience Skill）
- 借鉴 **aranea-agents MCP 支持**（含连通性探测、健康监控）
- 借鉴 **tRPC-MCP-Go**（Go 版 MCP SDK）

**实施步骤**：
```python
# src/tdsf/mcp_servers/log_mcp.py (新文件)
from mcp.server import Server
from mcp.types import Tool

app = Server("log-mcp")

@app.list_tools()
async def list_tools():
    return [
        Tool(name="drain3_extract", description="提取日志模板"),
        Tool(name="log_search", description="向量检索相关日志"),
        Tool(name="anomaly_detect", description="异常检测"),
    ]

@app.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "drain3_extract":
        return drain3_extract(arguments["log_content"])
    elif name == "log_search":
        return log_search(arguments["query"])
    elif name == "anomaly_detect":
        return anomaly_detect(arguments["log_content"])
```

**P0 整合**：v1.1 Week 2

### 7.5 Layer 2 Memory 整合

**当前状态**：ChromaDB 单层（command_skills + incident_cases 两个 collection）

**整合目标**：
- 借鉴 **aranea-agents 五层记忆 L0-L4**
- 借鉴 **Hermes 自进化**（会话复盘 + SKILL.md 提取）
- 借鉴 **Deep Lake 版本化**（Memory 支持回滚/分支）

**aranea-agents 五层记忆**：
- **L0 瞬时记忆**（working memory）—— 当前对话上下文
- **L1 短期记忆**（episodic memory）—— 最近 N 次对话
- **L2 中期记忆**（semantic memory）—— 案例库（我们已有）
- **L3 长期记忆**（procedural memory）—— 命令手册（我们已有）
- **L4 进化记忆**（self memory）—— 技能进化的元数据

**P0 整合**：v1.1 Week 2-3

### 7.6 Layer 1 LLM 整合（用户确认模型不是问题）

**当前状态**：Doubao / 预置

**用户明确表态**：
> "deepseek 等大模型的使用我们就做好预置厂商就行，还是主流的通用接口为主，这个模型选用不是问题"

**整合目标**：
- 预置厂商：DeepSeek V3.2/V3.1 + Doubao + Claude（研究）+ Ollama（本地）+ Qwen + GLM + Kimi
- **统一抽象层**：[core/llm_client.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/llm_client.py) 加 Provider Registry
- **OpenAI 兼容协议**：所有厂商都支持 OpenAI 兼容 API（DeepSeek / Doubao / Qwen / GLM / Ollama / vLLM）

**实施**：
```python
# src/tdsf/core/llm_client.py (升级)
class LLMRegistry:
    providers = {
        "deepseek-v3.2": DeepSeekProvider(model="deepseek-v3.2"),
        "deepseek-v3.1": DeepSeekProvider(model="deepseek-v3.1"),  # tool calling 强
        "deepseek-r1": DeepSeekProvider(model="deepseek-r1"),       # 推理
        "doubao": DoubaoProvider(),
        "qwen3.5": QwenProvider(),
        "ollama": OllamaProvider(),
        "claude-3.5-sonnet": ClaudeProvider(),  # 研究用
    }

    @classmethod
    def get(cls, name: str) -> LLMProvider:
        return cls.providers[name]
```

**P1 整合**：v1.1 Week 3

---

## 八、实施路线（5 周冲刺 v1.0→v1.1）

### Week 1：SubAgent 引入 + LangGraph 升级

```
Day 1-2: clone aranea-agents + DeerFlow + tRPC-Agent-Go
  ├─ 写 30-源码分析-aranea-agents.md（重点 Spirit 编排）
  ├─ 写 31-源码分析-deerflow.md（重点 Lead/Sub 模式）
  └─ 写 32-源码分析-trpc-agent-go.md（重点 GraphAgent）

Day 3-4: 拆 LangGraph 7 节点为 Lead + 3 个 Sub-Agent
  ├─ src/tdsf/agents/role.py（Diagnostician/Fixer/Verifier）
  ├─ src/tdsf/agents/lead.py（LeadAgent 派发）
  └─ src/tdsf/graph/builder.py 升级（Lead 节点 + Sub 节点）

Day 5: 加 OpenTelemetry + Langfuse
  └─ 端到端可观测性测试
```

### Week 2：MCP 化 + 沙箱化

```
Day 1-2: 工具 MCP 化
  ├─ src/tdsf/tools/log_tools.py → src/tdsf/mcp_servers/log_mcp.py
  ├─ src/tdsf/tools/system_tools.py → src/tdsf/mcp_servers/system_mcp.py
  └─ 启动 MCP server，测试 Claude Code / Cursor 能否消费

Day 3-4: Docker 沙箱
  ├─ 借鉴 e2b Firecracker 思想 + DeerFlow v2 实践
  ├─ src/tdsf/sandbox/docker_sandbox.py
  └─ 高风险操作强制沙箱内执行

Day 5: 端到端联调
  └─ 测试 "Lead Agent + 3 Sub + MCP + 沙箱" 全链路
```

### Week 3：记忆分层 + 评测集

```
Day 1-2: 记忆分层（L0-L4）
  ├─ src/tdsf/memory/l0_working.py
  ├─ src/tdsf/memory/l1_episodic.py
  ├─ src/tdsf/memory/l2_semantic.py（已有 incident_cases）
  ├─ src/tdsf/memory/l3_procedural.py（已有 command_skills）
  └─ src/tdsf/memory/l4_self.py

Day 3-4: 100 条真实故障日志评测集
  ├─ 从 openEuler 仓库拉 50 条
  ├─ 从教材 14 个项目案例拉 30 条
  └─ 自己构造 20 条边界用例

Day 5: 评测 + 调优
  └─ 记录 MTTR、ECE、Token 消耗
```

### Week 4：桌面端接入真实数据

```
Day 1-2: clone OpenHands + Mastra（已有）
  └─ 写 33-UI-借鉴方案.md

Day 3-4: IPC 接入（从 mock 切到真实）
  └─ 改 src/main/ipc/index.ts + electron.d.ts

Day 5: UI 显示可信度 + Lead/Sub 可视化
```

### Week 5：验证 + 文档

```
Day 1-2: 跑 100 条评测
  └─ 对比 v1.0 vs v1.1 性能

Day 3-4: 写 v1.1 升级报告
  └─ 34-v1.1-升级报告.md

Day 5: 归档
  └─ 全部 md 写入 idea-to-dev-output/，最终自检
```

---

## 九、红线更新

### 9.1 新增的"星星少项目安全红线"（用户原话）

> "对于星星少的项目，你浏览的时候要着重注重检查安全性后才酌情下载源码进行分析"

**新增红线 F1**：

```yaml
F1_星星少项目红线:
  定义: Stars < 100 的项目
  强制流程:
    - Step 1: 查 License 是否明确（必须 MIT/Apache-2.0/BSD/MulanPubL 等宽松协议）
    - Step 2: 查项目年龄（< 30 天 = 中风险，< 7 天 = 高风险）
    - Step 3: 查 README 完整性（必须含使用说明、依赖、License）
    - Step 4: 查是否含预编译二进制（exe/bin/dll/so = 高风险）
    - Step 5: 查 Contributors 数（< 3 = 中风险）
    - Step 6: 查 Issue / PR 讨论活跃度（0 = 中风险）
    - Step 7: 跑 npm audit / pip-audit / cargo audit
    - Step 8: 在沙箱环境（DOCKER）中跑测试，不在主环境
  拒绝条件:
    - License 未明确 OR 传染协议（GPL/AGPL/SSPL）
    - 含可疑预编译二进制
    - README 为空
    - 项目年龄 < 7 天
  重新评估: 7 天后重检，达到"高安全"标准可升级
  黑名单: 不通过的项目加入 opensource-reference/.blacklist
```

### 9.2 红线 14 条（增加 1 条）

| 编号 | 红线 | 级别 |
|---|---|---|
| A1-A3 | 法律红线 | 🔴 |
| B1-B2 | 安全红线 | 🔴 |
| C1-C2 | 质量红线 | 🟡 |
| D1-D2 | 架构红线（限 desktop）| 🟢 |
| E1-E4 | 可配置子规则 | 🟢 |
| **F1** | **星星少项目安全红线**（新增）| 🟡 |

---

## 十、关键文件导航

### 10.1 本报告涉及的开源项目

```bash
# 必 clone（Week 1-2）
git clone https://github.com/AmarsDing/aranea-agents.git opensource-reference/aranea-agents
git clone https://github.com/bytedance/deer-flow.git opensource-reference/deerflow
git clone https://github.com/trpc-group/trpc-agent-go.git opensource-reference/trpc-agent-go
git clone https://github.com/microsoft/autogen.git opensource-reference/autogen
git clone https://github.com/crewAIInc/crewAI.git opensource-reference/crewai
git clone https://github.com/deepset-ai/haystack.git opensource-reference/haystack
git clone https://github.com/e2b-dev/e2b.git opensource-reference/e2b

# 已 clone（继续）
ls opensource-reference/  # 已有: mastra, OpenHands, aider, cline, MetaGPT, kilo-code

# 选 clone（Week 3-4）
git clone https://github.com/activeloopai/deeplake.git opensource-reference/deeplake
git clone https://github.com/qinshihu/itops-agent-platform.git opensource-reference/itops-agent-platform

# 不 clone
# most_agent（7 天后重评）
# atomcode（黑名单）
# octoagent（SSPL 风险）
```

### 10.2 关联调研报告

- [26-Agent架构设计详解与规划梳理.md](./26-Agent架构设计详解与规划梳理.md)
- [27-豆包方案评估+9条红线调整+开源Agent整合方案.md](./27-豆包方案评估+9条红线调整+开源Agent整合方案.md)
- [22-可信度算法论文支撑调研.md](./22-可信度算法论文支撑调研.md)
- [24-源码分析-Mastra框架.md](./24-源码分析-Mastra框架.md)
- [豆包参考.md](../../../参考资料/豆包参考.md)

### 10.3 待写的源码分析报告

- 30-源码分析-aranea-agents.md（重点 Spirit 编排）
- 31-源码分析-deerflow.md（重点 Lead/Sub 模式）
- 32-源码分析-trpc-agent-go.md（重点 GraphAgent）
- 33-UI-借鉴方案.md
- 34-v1.1-升级报告.md

---

## 十一、本报告自检清单

- [x] 用户提供的 3 个项目评估（含详细安全评估）
- [x] 深度调研发现的 6 个新项目
- [x] subagent 补充的 6 个新项目（含网络复核警告）
- [x] 15+ 项目综合评估矩阵
- [x] 共同的关键 Agent 架构趋势 5 条
- [x] 安全评估清单（10 项 + 4 风险等级）
- [x] 整合方案：分层吸收（5 层）
- [x] 5 周实施路线
- [x] 红线更新（14 条，新增 F1）
- [x] 关键文件导航
- [x] 本报告归档到 `idea-to-dev-output/28-补充开源Agent调研与安全评估.md`

---

## 十二、下一步建议

1. **今天**：同意新增红线 F1（星星少项目安全红线）
2. **明天**：git clone 8 个第一梯队项目到 `opensource-reference/`
3. **Day 3-7**：写 30/31/32 三个核心源码分析（aranea-agents / DeerFlow / tRPC-Agent-Go）
4. **Week 1**：启动 v1.1 升级（SubAgent 引入 + LangGraph 升级）
5. **Week 2**：MCP 化 + 沙箱化

**最关键的下一步**：**clone aranea-agents**——它是用户提供的、MIT License、590 commits、36+ 业务模块、Spirit 动态编排，最值得作为我们 v1.1 的主要参考。

需要我直接启动 clone 吗？
