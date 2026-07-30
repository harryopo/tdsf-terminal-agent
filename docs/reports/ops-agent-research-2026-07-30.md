# TDSF Terminal Agent — 运维 Agent 开源项目集成可行性调研

> **位置**：`docs/reports/ops-agent-research-2026-07-30.md`
> **版本**：v1.0（2026-07-30 完成稿）
> **作用**：在 `strands-integration-implementation-plan-2026-07-30.md`（Strands 1.48→1.50 集成方案）之上，调研三个外部运维 Agent 开源项目（k8sgpt / OpenOps / robusta）+ Strands 官方生态，给出 TDSF 集成建议与优先级排序。
> **任务边界**：本文件为调研报告，**不修改任何代码**。所有结论基于 2026-07-30 当日 WebSearch + WebFetch + PyPI/GitHub 实际抓取。
> **数据基准**：2026-07-30 真实抓取（GitHub 仓库主页 / README / pkg.go.dev / PyPI / CNCF LFX Insights / AWS 官方博客）。
> **上游参考**：
> - k8sgpt：<https://github.com/k8sgpt-ai/k8sgpt>（Apache-2.0，CNCF Sandbox）
> - OpenOps：<https://github.com/openops-cloud/openops>（FinOps 自动化平台）
> - robusta：<https://github.com/robusta-dev/robusta>（MIT，K8s 可观测性 + 自动化）
> - Strands Agents Tools：<https://github.com/strands-agents/tools>（Apache-2.0，AWS 官方）

---

## 0. 执行摘要（200 字内）

| 项目 | 可集成性 | 推荐路径 |
|------|----------|----------|
| **k8sgpt** | 中等（强 K8s 耦合，但提供 MCP server） | **不嵌入代码**，走 `k8sgpt serve --mcp` + Strands `mcp_client` 远程协议接入，用户自有 K8s 集群时按需启用 |
| **OpenOps** | 低（FinOps 平台，非运维 Agent，目标不匹配） | **不集成**；仅借鉴其 workflow + human-in-the-loop 设计模式 |
| **robusta** | 低（强 K8s Operator 耦合，Python 但需集群内部署） | **不集成**；借鉴其 Playbook（trigger + action）抽象模式 |
| **Strands 官方生态** | 高（已集成 SDK 1.50.2，扩工具即可） | **首选路径**：引入 `strands-agents-tools 0.8.5` 的 shell/journal/scheduler/use_agent/swarm + HookProvider（HITL + LimitToolCounts） |

**核心结论**：TDSF 不应该把 k8sgpt/robusta/OpenOps 任何一个嵌入到 Python sidecar，因为三者都是 K8s/FinOps 强耦合的平台级产品。最优路径是**深挖 Strands 官方生态**——它已经提供 40+ 工具、4 种 HITL 模式、3 种多 Agent 模式，足以覆盖 TDSF 运维 Agent 的全部扩展需求。k8sgpt 仅作为"用户有 K8s 集群时的可选外挂"，通过 MCP 协议松耦合接入。

---

## 1. k8sgpt 调研

### 1.1 项目基本信息

| 维度 | 数据 |
|------|------|
| 项目地址 | <https://github.com/k8sgpt-ai/k8sgpt> |
| License | **Apache-2.0**（README badge 明确，pkg.go.dev 同步确认） |
| Stars | CNCF LFX Insights 2026 数据：1,441 stars（年降 19%）；2024 年历史峰值约 5,000+ stars；2026 年活跃度下降 |
| Forks | 235（CNCF LFX 数据，年降 28%） |
| 贡献者 | 1,715（累计）/ 436 contributing organizations |
| Commits | 1,385（main 分支，截至 2026-05-13） |
| Branches / Tags | 60 / 113 |
| 最新版本 | **v0.4.36**（pkg.go.dev 显示 2026-07-10 发布） |
| 主分支最新提交 | 2026-05-13 `chore(main): release 0.4.33` |
| CNCF 状态 | Sandbox（2023-12-19 接纳）；2026-04 提交 incubation 治理文档（PR #1642） |
| OpenSSF Best Practices | 已通过（badge 7272） |
| Open Issues | 85 |

### 1.2 核心能力（解决什么运维问题）

k8sgpt 是**专为 Kubernetes 集群设计的 SRE 诊断工具**，把"SRE 经验固化进 analyzers + AI 富化解释"：

- **30+ 内置 analyzers**（README 完整列表）：
  - **默认启用 14 个**：podAnalyzer / pvcAnalyzer / rsAnalyzer / serviceAnalyzer / eventAnalyzer / ingressAnalyzer / statefulSetAnalyzer / deploymentAnalyzer / jobAnalyzer / cronJobAnalyzer / nodeAnalyzer / mutatingWebhookAnalyzer / validatingWebhookAnalyzer / configMapAnalyzer
  - **可选启用 16+ 个**：hpaAnalyzer / pdbAnalyzer / networkPolicyAnalyzer / gatewayClass / gateway / httproute / logAnalyzer / storageAnalyzer / securityAnalyzer / CatalogSource / ClusterCatalog / ClusterExtension / ClusterService / ClusterServiceVersion / OperatorGroup / InstallPlan / Subscription
- **核心工作流**：扫描 K8s 集群 → analyzers 提取问题 → AI 富化（用自然语言解释根因 + 修复建议）→ 输出（text/json）
- **数据脱敏（Anonymization）**：发送 AI 前对 Pod 名/Label 等敏感字段做掩码（如 `fake-deployment` → `tGLcCRcHa1Ce5Rs`），AI 返回后还原
- **`--with-doc`**：附官方 K8s 文档链接
- **`-s` 统计模式**：每个 analyzer 耗时（README 示例显示 Service analyzer 38s / Pod analyzer 5.6s）
- **不解决的问题**：通用 Linux 运维（进程、网络、磁盘、SSH 主机）— 它完全围绕 K8s API 对象

### 1.3 架构与语言

- **语言**：**Go**（`go.mod` + `pkg.go.dev/github.com/k8sgpt-ai/k8sgpt` 确认）
- **K8s 集成方式**：直接使用 `client-go`（K8s 官方 Go 客户端），通过 `kubernetes.Client` 与 API Server 通信
- **核心包**：`pkg/analysis`（`Analysis` 结构体，含 `RunAnalysis()` / `GetAIResults()` / `PrintOutput()` / `RunCustomAnalysis()`）
- **CLI 模式**：`k8sgpt analyze --explain --filter=Pod --namespace=default --output=json --anonymize`
- **Operator 模式**：`k8sgpt-operator`（独立仓库，Helm chart 部署到集群内，continuous monitoring + 写入 CRD `ResultList`）
- **REST/gRPC Serve 模式**：`k8sgpt serve`（端口 8080）/ `k8sgpt serve --http`（REST）/ `k8sgpt serve --mcp --mcp-http`（MCP，端口 8089）
- **AI Backend 抽象**：`ai.IAI` 接口，13 种实现（openai / localai / ollama / azureopenai / cohere / amazonbedrock / amazonsagemaker / google / huggingface / noopai / googlevertexai / watsonxai / ibmwatsonxai / customrest）

### 1.4 是否可拆出"非 K8s"部分作为通用 Linux 运维 Agent

**结论：不可以。**

- 所有 30+ analyzer 的实现都强依赖 `kubernetes.Client`（`Analysis.Client *kubernetes.Client`），数据源是 K8s API 对象（Pod / Service / Ingress / Deployment 等）
- `Analysis` 结构体没有"非 K8s 数据源"抽象层，analyzer 是按 K8s 资源类型组织的（不是按运维问题类型如"日志/进程/网络"）
- AI 富化逻辑（`GetAIResults`）假设输入是 K8s 问题列表（`[]common.Result`），格式耦合 K8s 术语
- 唯一可借鉴的是：**analyzer 模式本身**（"按领域拆分检查器 + AI 富化解释"），但 Strands Agents 的 `@tool` 装饰器已经实现了更通用的等价能力

### 1.5 是否支持自定义 analyzer / 自定义 LLM backend

**自定义 analyzer**：支持，但必须用 **Go** 写
- 官方包：`github.com/k8sgpt-ai/go-custom-analyzer`（pkg.go.dev 有，但 License 未检测，imports=5，imported by=0，几乎无人用）
- 第三方包：`github.com/apecloud/k8sgpt/pkg/custom`（v0.2.0，Apache-2.0，提供 `Client` + `Connection` + `CustomAnalyzer` 类型）
- 实现模式：实现 `INamedAnalyzer` 接口，注册到 `Analysis.CustomAnalyzers`
- Docker 镜像示例：`shashankft/k8sgpt-custom-analyzer`（40 MB）
- **限制**：TDSF 是 Python sidecar，写 Go analyzer 需要额外的 Go 工具链，违背"魔改要轻、上游基线优先"原则

**自定义 LLM backend**：支持
- 13 种内置 backend 中 `customrest` 是通用 HTTP REST 后端，可对接任意 LLM（包括 DeepSeek）
- 配置方式：`k8sgpt auth add --backend customrest --baseurl ... --model ...`
- DeepSeek 已有实践：`-b openai --baseurl https://api.deepseek.com/v1 -m deepseek-v4-flash`（OpenAI 兼容模式）

### 1.6 集成到 TDSF 的可行性

**两种集成路径**：

| 路径 | 描述 | 工程量 | 优缺点 |
|------|------|--------|--------|
| **A. Python sidecar 直接调用 Go 二进制** | 在 src-tauri/sidecar/ 里 `subprocess.run(["k8sgpt", "analyze", ...])` | 中 | 优点：复用 k8sgpt 全部 analyzers<br>缺点：① 需打包 k8sgpt 二进制（~50MB）到 Tauri 资源；② 用户必须有 kubeconfig；③ Go 进程管理 + JSON 解析；④ 无法复用 TDSF 现有 LLM 配置（k8sgpt 自己管 auth） |
| **B. MCP 协议远程接入**（**推荐**） | 用户本地或远程跑 `k8sgpt serve --mcp --mcp-http`，TDSF 通过 Strands `mcp_client` 工具动态连接 | **小** | 优点：① 零二进制打包；② 复用 Strands 1.50 已有的 MCP 支持；③ 用户按需启用（无 K8s 不启动）；④ LLM 配置由 k8sgpt 自己管，TDSF 不干涉<br>缺点：需要用户额外部署 k8sgpt |

**推荐路径 B**：在 `strands_backend/tools/` 新增 `mcp_k8sgpt.py`，包装 Strands `mcp_client` 工具，配置项放 `.tdsf-data/mcp_servers.json`。用户没装 k8sgpt 时，工具 graceful degrade（返回"未配置"）。

### 1.7 集成工程量 + 风险

- **工程量**：**小**（路径 B）
  - 新增 1 个 tool wrapper（~80 行 Python）
  - 新增 1 个 MCP 配置加载器（~50 行）
  - 文档说明用户如何部署 k8sgpt（README 章节）
- **风险**：
  - **低**：MCP 协议是标准化的，Strands 1.50 原生支持
  - **中**：k8sgpt MCP server 在 v0.4.14+ 才支持（README 明示），用户需用较新版本
  - **中**：k8sgpt 2026 年活跃度下降（stars 年降 19%），需关注 CNCF incubation 进展
  - **低**：数据脱敏由 k8sgpt 自己做，TDSF 不接触敏感数据

---

## 2. OpenOps 调研

### 2.1 项目基本信息

| 维度 | 数据 |
|------|------|
| 项目地址 | <https://github.com/openops-cloud/openops> |
| License | 未在 README/pkg.go.dev 明确显示（仓库内 LICENSE 文件需进一步查证；AWS Marketplace 描述为"商业 SaaS"） |
| Stars | 未抓到精确数字（仓库主页未显示 badge） |
| Commits | 1,791（main 分支，截至 2026-06-11） |
| Branches / Tags | 218 / 55 |
| 最新版本 | **0.6.24**（docs.openops.com 部署文档显示） |
| 主分支最新提交 | 2026-06-11 `Improve TagInput component UI`（PR #2337） |
| Open Issues | 未显示（仓库主页 Issues tab 无计数） |
| 部署方式 | Docker Compose（`openops-dc-0.6.24.zip`） |
| 商业模式 | AWS Marketplace 上架（Standard $9k/年 / Professional $18k/年 / Enterprise $36k+/年） |

**注意**：有两个不同项目都叫 "OpenOps"：
1. **`mattermost/openops`**（已 archived 2024-08-23，是 Mattermost 的 AI 集成实验，已废弃，建议看 `mattermost/copilot` 替代品）
2. **`openops-cloud/openops`**（活跃的 FinOps 自动化平台，本节调研对象）

### 2.2 核心能力（解决什么运维问题）

**OpenOps 不是运维 Agent，是 FinOps（云财务运营）自动化平台**：

- **核心场景**：云成本优化、资源退订、预算管理、异常管理、成本分配、单位经济、工作负载优化、安全退订
- **预构建工作流**：覆盖成本优化 / 标记 / 预算 / 分配 / 报告的最佳实践
- **多云支持**：AWS / Azure / Google Cloud（GCP 即将到来）
- **集成生态**：Slack（审批流）/ SMTP / Azure CLI / GCP CLI / 数据库 / 分析工具 / 项目管理
- **不解决的问题**：Linux 主机运维、K8s 集群诊断、SSH 远程操作、日志分析、进程诊断

### 2.3 架构与语言

- **主要语言**：TypeScript（前端）+ Python（worker/engine）+ Bash/YAML（workflow 定义）
- **架构特点**：
  - **Worker 与 Engine 隔离**：2026-06-09 PR #2324 把 worker 和 run engine 拆成独立进程，引入 warm pool（性能优化）
  - **工作流版本控制与追踪**：操作可回溯
  - **集中管理**：用表格记录和处理机会（审批/驳回/标记误报/暂停）
- **部署架构**：Docker Compose（PostgreSQL + OpenOps App + Analytics + Worker），单机或服务器部署

### 2.4 是否可拆出"非 FinOps"部分作为通用 Linux 运维 Agent

**结论：不可以。**

- OpenOps 的 workflow 引擎是为 FinOps 场景定制的（成本数据查询、资源退订 API、预算告警），不是通用运维操作编排器
- 它的 "Ops" 含义是 "Cloud Financial Operations"，不是 "IT Operations"
- 抽象层（workflow / approval / scheduling）确实存在，但与 FinOps 数据源强绑定

### 2.5 是否支持自定义 workflow / 自定义 LLM backend

**自定义 workflow**：支持
- 无代码工作流编辑器（可视化）
- 也允许直接写代码（Python）
- Cloud templates 提供模板

**自定义 LLM backend**：
- OpenOps 本身不依赖 LLM 做核心推理（它是规则驱动的 workflow 引擎）
- AWS Marketplace 描述里未提及 LLM 集成
- Mattermost 旧版 OpenOps（已废弃）支持 OpenAI / Azure / Hugging Face / LocalAI，但这个能力没继承到 openops-cloud

### 2.6 集成到 TDSF 的可行性

**结论：不集成。**

| 路径 | 评估 |
|------|------|
| Python sidecar 嵌入 OpenOps workflow 引擎 | **不可行**：OpenOps 是 Docker Compose 部署的平台级产品（含 PostgreSQL + 多进程），无法嵌入 Python sidecar |
| 借鉴 workflow / human-in-the-loop 设计 | **可借鉴**：OpenOps 的"无代码工作流 + 多渠道人机协作审批 + 集中管理表格"模式可抽象为 TDSF 的运维 playbook 设计 |

### 2.7 集成工程量 + 风险

- **工程量**：**不适用**（不集成）
- **风险**：
  - **CVE-2025-68922**（OpenOps < 0.6.11 Terraform 块 OS 命令注入，CVSS 7.4，已在 0.6.11 修复）— 历史安全问题，进一步证明不应集成
  - 商业模式（SaaS + Marketplace）与 TDSF 开源桌面端定位不符
- **借鉴价值**（仅设计模式层面）：
  - **workflow 版本控制**：TDSF 可在 `.tdsf-data/playbooks/` 里用 git 管理 playbook 历史
  - **多渠道人机协作**：OpenOps 的 Slack 审批可以映射到 TDSF 的"高危命令前端确认弹窗 + 终端通知"
  - **集中管理表格**：TDSF 可在 AI 面板加一个"待审批操作"队列视图

---

## 3. robusta 调研

### 3.1 项目基本信息

| 维度 | 数据 |
|------|------|
| 项目地址 | <https://github.com/robusta-dev/robusta> |
| License | **MIT**（README 明确，SourceForge 镜像同步确认） |
| Stars | 未抓到精确数字（仓库主页无 badge，但 SourceForge 镜像活跃度显示是 K8s 监控领域 Top 项目之一） |
| Commits | 2,282（master 分支，截至 2026-07-29） |
| Branches | 默认 master（GitHub 显示 149 open issues / 45 open PRs） |
| 最新版本 | **0.26.x**（SourceForge 镜像显示 0.26.0/0.26.1，2025-04-14 发布；2026-07-29 仍有 docs 提交，说明 0.27.x 在路上） |
| 主分支最新提交 | 2026-07-29 `docs: fix Firewall / DNS Allowlist page`（PR #2131，**极活跃**） |
| Open Issues | 149 |
| Open PRs | 45 |
| 部署方式 | Helm chart（运行在 K8s 集群内） |

### 3.2 核心能力（解决什么运维问题）

robusta 是**K8s 可观测性 + 自动化平台**，深度集成 Prometheus：

- **智能告警分组**：Slack 线程减少通知噪音
- **AI 调查**：HolmesGPT 子项目做根因分析（LLM 驱动）
- **告警丰富**：在告警旁附加 Pod 日志、describe 输出、events 历史
- **自动修复**：定义规则自动重启 Deployment / 打 Taint / 执行 `kubectl debug`
- **高级路由**：基于团队/命名空间/严重性路由到不同 sink
- **K8s 原生告警**：无需 PromQL，为 OOMKills / 失败 Job 等生成告警
- **资源变更跟踪**：关联告警和部署
- **自动解决**：告警解决时更新外部系统（如 Jira 工单状态）
- **数十种集成**：Slack / Teams / Jira / Discord / Opsgenie / Datadog / NewRelic / Loki / Tempo / Kafka / ArgoCD / PagerDuty / Webhook

### 3.3 架构与语言

- **语言**：**Python**（与 TDSF sidecar 同语言）
- **架构**：基于 `controller-runtime` 的 K8s Operator，以 Deployment 形式运行在 `robusta` 命名空间
- **核心组件**：
  - **Robusta CLI**（`robusta` 命令）：gen-config / 部署 / 转发告警
  - **Robusta Runner**：核心 Pod，含事件处理逻辑 + AI 集成 + 动作执行器
  - **配置仓库**（`robusta.yaml`）：定义 sinks / integrations / customPlaybooks
- **工作流**：5 步管道 — 监听 → 过滤 → 丰富 → 推理 → 执行/通知

### 3.4 是否可拆出"非 K8s"部分作为通用 Linux 运维 Agent

**结论：不可以直接拆，但 Playbook 模式可借鉴。**

- robusta 的整个事件源（triggers）都是 K8s 资源事件（on_pod_crash_loop / on_kubernetes_warning_event_create / on_prometheus_alert / on_helm_release）
- enrichers 强依赖 K8s API（kubectl logs / describe / get events）
- 但 **Playbook（trigger + action）抽象**本身是通用的，可以映射到 Linux 运维：
  - `on_prometheus_alert` → `on_metric_threshold`（如 CPU > 90%）
  - `on_kubernetes_warning_event_create` → `on_ssh_command_output_pattern`（如 dmesg 出现 "error"）
  - `logs_enricher` → `tail_journalctl`（已有 `analyze_logs` tool）
  - `pod_bash_enricher` → `ssh_command`（已有 tool）

### 3.5 是否支持自定义 playbook / 自定义 LLM backend

**自定义 playbook**：完全支持，是核心扩展机制
```yaml
customPlaybooks:
- triggers:
  - on_kubernetes_warning_event_create:
      include: ["Liveness"]
  actions:
  - create_finding:
      severity: HIGH
      title: "Failed liveness probe: $name"
  - event_resource_events: {}
```
- 支持多触发器、多动作、过滤器、参数化
- 多个 playbook 匹配同一事件时按顺序执行
- 内置默认 playbook 覆盖常见 K8s 问题

**自定义 LLM backend**：通过 HolmesGPT 子项目支持
- HolmesGPT 集成 OpenAI / Azure OpenAI / Claude / 本地模型
- HolmesGPT 有独立 toolset 系统（Prometheus / Grafana / Datadog / NewRelic / Loki / Tempo / Kafka / ArgoCD / AWS Security / Coralogix）
- HolmesGPT 有 CLI 模式（`holmes` 命令）和 SaaS 模式
- **MCP 支持**（2026-04 PR #1824 / #1839，ROB-1292 / ROB-1418）

### 3.6 集成到 TDSF 的可行性

**结论：不集成 robusta 本体，借鉴 Playbook 设计模式。**

| 路径 | 评估 |
|------|------|
| Python sidecar 直接 import robusta 包 | **不可行**：robusta 是 K8s Operator，强依赖集群内运行环境（controller-runtime / kubeconfig / 集群内 ServiceAccount） |
| 借鉴 HolmesGPT toolset 设计 | **可借鉴**：HolmesGPT 的 toolset 抽象（按数据源拆分工具集）与 TDSF 现有 `tools/*.py` 模式一致 |
| 借鉴 Playbook（trigger + action）模式 | **强烈推荐借鉴**：可作为 TDSF 未来"事件驱动自动化"的设计蓝图 |

### 3.7 集成工程量 + 风险

- **工程量**：**不适用**（不集成本体）
- **借鉴设计的工作量**：**中**（未来 P3 阶段）
  - 设计 TDSF 自己的 playbook schema（YAML，参考 robusta 但适配 Linux 运维）
  - 实现 trigger 注册器（cron / 文件 watch / 终端输出 watch / SSH 输出 watch）
  - 实现 action 执行器（调 Strands tools）
- **风险**：
  - **低**：robusta MIT License，借鉴设计无法律风险
  - **中**：robusta 强耦合 K8s controller-runtime，直接 fork 改造工程量大
  - **低**：HolmesGPT 是独立子项目，可单独研究其 toolset 设计

---

## 4. Strands Agents 官方生态调研

### 4.1 strands-agents-tools 包概览

| 维度 | 数据 |
|------|------|
| PyPI | <https://pypi.org/project/strands-agents-tools/> |
| 当前版本 | **0.8.5**（2026-07-22 发布） |
| License | **Apache-2.0**（AWS 出品） |
| GitHub | <https://github.com/strands-agents/tools>（197 commits / 84 open issues / 49 tags / 2 branches，最新提交 2026-07-24） |
| Python 要求 | `>=3.10`（与 TDSF sidecar 兼容） |
| 提供方式 | `pip install strands-agents-tools`（核心）+ extras 可选（`mem0_memory` / `use_browser` / `rss` / `use_computer` / `a2a-client` / `agent-core-browser` / `agent-core-code-interpreter` / `diagram` / `docs` / `elasticsearch-memory` / `local-chromium-browser` / `mongodb-memory` / `twelvelabs` / `build` / `dev`） |

### 4.2 工具全表（40+ 工具，按运维相关性分级）

#### P0 — 强相关，建议立即引入

| 工具 | 用法 | TDSF 运维场景 |
|------|------|---------------|
| **`shell`** | `agent.tool.shell(command="ls -la")` | 本地命令执行（TDSF 当前只有 SSH 远程命令，缺本地） |
| **`http_request`** | `agent.tool.http_request(method="GET", url="http://...")` | 调用外部 API（如 Prometheus / Grafana / 内部 CMDB） |
| **`journal`** | `agent.tool.journal(...)` | 结构化运维日志，跨轮持久化（用户复盘故障） |
| **`scheduler`** | cron 任务调度 | 定时巡检（每小时检查磁盘空间 / 每日生成运维报告） |
| **`editor`** | 文件智能编辑 | 修改配置文件（如 nginx.conf / sshd_config） |

#### P1 — 中相关，建议 P1 阶段引入

| 工具 | 用法 | TDSF 运维场景 |
|------|------|---------------|
| **`use_agent`** | 嵌套子 Agent + 模型切换 | 主 Agent 委托"日志分析专家" / "网络诊断专家"子 Agent（与现有 9 个 Agent registry 对齐） |
| **`swarm`** | 多 Agent 协作 + 共享上下文 | 复杂故障排查：日志专家 + 进程专家 + 网络专家并行分析 |
| **`graph`** | DAG 多 Agent 管道 | 编排"采集 → 分析 → 修复 → 验证"流水线 |
| **`mcp_client`** | 动态连接外部 MCP server | 接入 k8sgpt MCP / HolmesGPT MCP / 其他 MCP server |
| **`memory`**（Mem0 / Bedrock KB / Elasticsearch / MongoDB Atlas） | 跨会话记忆 | 记住用户运维偏好 / 历史故障模式 / 主机拓扑 |

#### P2 — 弱相关，按需引入

| 工具 | 用法 | TDSF 运维场景 |
|------|------|---------------|
| **`slack`** | Slack 消息收发 | 运维告警推送到 Slack（如有用户需求） |
| **`browser`** / **`use_computer`** | 浏览器/桌面自动化 | 抓取 Web 监控面板 / 自动化 GUI 运维操作 |
| **`rss`** | RSS 订阅 | 订阅 CVE / 运维博客 |
| **`generate_image`** / **`video`** / **`audio`** | 多模态生成 | 生成运维报告配图（低优先级） |
| **`use_aws`** | AWS 服务调用 | 如用户在 AWS 上有资源 |
| **`retrieve`** | Bedrock 知识库 RAG | 文档检索（需 Bedrock） |
| **`a2a_client`** | Agent-to-Agent 协议 | 跨 Agent 系统通信（未来） |
| **`python_repl`** | Python 代码执行 | 数据分析（已有 CodeMirror 编辑器） |
| **`calculator`** | 数学计算 | 容量规划计算 |

### 4.3 Strands 官方推荐的多 Agent 最佳实践

Strands 官方提供 **3 种多 Agent 协作模式**（AWS 文档 + Workshop 实验）：

| 模式 | 适用场景 | TDSF 映射 |
|------|----------|-----------|
| **Swarm**（蜂群智能） | 自组织团队 + 共享工作内存 + 自主协调 | 复杂故障多专家并行排查（日志/进程/网络专家同时分析） |
| **Graph**（DAG 图） | 确定性管道 + 节点间输出传播 + 每节点独立模型 | 编排"采集 → 分析 → 修复 → 验证"流水线 |
| **Workflow**（工作流） | 预定义步骤序列 | 标准运维 SOP 自动化（如"重启服务 → 检查健康 → 通知"） |

**Swarm 关键参数**（来自 AWS Workshop Lab 9b）：
- `task`：主任务描述
- `agents`：Agent 规格 list（name / system_prompt / tools / model_provider / model_settings）
- `max_handoffs=20`：最大 Agent 间交接次数
- `max_iterations=20`：所有 Agent 总迭代上限
- `execution_timeout=900.0`：总执行超时（秒）
- `node_timeout=300.0`：单 Agent 超时
- `repetitive_handoff_detection_window`：检测 ping-pong 行为
- `repetitive_handoff_min_unique_agents`：最小唯一 Agent 数

### 4.4 Strands 1.50.2 的扩展点设计

#### Hooks 系统（核心扩展点）

Strands 提供 `HookProvider` + `HookRegistry` + 事件回调机制：

| 事件 | 触发时机 | 典型用途 |
|------|----------|----------|
| `BeforeToolCallEvent` | 工具调用前 | **HITL 审批**（高危命令人工确认）/ 参数校验 / 限流 |
| `AfterToolCallEvent` | 工具调用后 | 结果审计 / 日志记录 / 敏感数据脱敏 |
| `BeforeModelCallEvent` | LLM 调用前 | 注入上下文 / prompt 改写 |
| `AfterModelCallEvent` | LLM 调用后 | 内容过滤 / 安全护栏 |
| `AgentStartEvent` / `AgentStopEvent` | Agent 生命周期 | 资源初始化 / 清理 |

**HookProvider 注册范式**（来自 AWS Healthcare HITL 博客）：
```python
class ApprovalHook(HookProvider):
    SENSITIVE_TOOLS = ["ssh_command", "delete_file", "restart_service"]

    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self.approve)

    def approve(self, event: BeforeToolCallEvent):
        if event.tool_name in self.SENSITIVE_TOOLS:
            # 阻塞 agent loop，等用户响应
            user_response = prompt_user(f"Approve {event.tool_name}? (y/n/t)")
            if user_response == "n":
                raise ToolDeniedException(...)
```

#### 4 种 HITL 模式（来自 AWS Healthcare 博客，2026-04-08）

| 模式 | 实现位置 | 适用场景 | TDSF 映射 |
|------|----------|----------|-----------|
| **Agentic Loop Interrupt** | HookProvider + `BeforeToolCallEvent` | 全局策略拦截敏感工具 | TDSF 高危 SSH 命令审批（rm -rf / reboot / systemctl stop） |
| **Tool Context Interrupt** | 工具内部逻辑 + session context | 细粒度工具特定控制 | TDSF `ssh_command` 工具内嵌审批逻辑（已部分实现） |
| **Remote Tool Interrupt** | AWS Step Functions + SNS | 异步第三方审批 | TDSF 远程审批（前端弹窗 + 等待用户响应） |
| **MCP Elicitation** | MCP 协议原生 elicitation + SSE | 实时交互式审批 | TDSF 通过 MCP server 与外部审批系统通信 |

**HITL 用户响应语义**（AWS 官方）：
- `y`：approve once（批准一次）
- `n`：deny（拒绝）
- `t`：trust（信任此工具，本会话内不再询问）

#### LimitToolCounts Hook（替代已移除的 max_iterations）

**关键背景**：Strands 1.50.2 已移除 `max_iterations` 参数（任务描述明确），未来用 Hook 替代。

**实现思路**（基于 Hook 系统推断 + Swarm 工具的 `max_iterations` 参数语义）：
```python
class LimitToolCounts(HookProvider):
    def __init__(self, max_calls: int = 50):
        self.max_calls = max_calls
        self.call_count = 0

    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self.check_limit)

    def check_limit(self, event: BeforeToolCallEvent):
        self.call_count += 1
        if self.call_count > self.max_calls:
            raise MaxIterationsExceeded(
                f"Reached {self.max_calls} tool calls, stopping"
            )
```

**优势**：比 `max_iterations` 更细粒度 — 可以按工具类型分别计数、按 Agent 分别计数、按时间窗口计数。

#### Plugins 扩展点

Strands 还支持（未深入调研但官方文档提及）：
- **Guardrails**：安全护栏，引导 Agent 自我纠错
- **Steering**：在 Agent 推理边界内引导方向（re:Invent 2025 发布）
- **Bidirectional streaming**：双向流式（re:Invent 2025 发布，语音 Agent）
- **Evaluations**：评估框架（re:Invent 2025 发布）
- **Context Management**：对话历史管理策略（自动摘要 / 滑动窗口）

---

## 5. TDSF 集成建议

### 5.1 推荐方案

**总策略**：**深挖 Strands 官方生态，不嵌入外部 K8s/FinOps 平台**

#### 5.1.1 立即做（P0，与 Strands 1.50 集成同步落地）

1. **引入 `strands-agents-tools` 0.8.5**（条件依赖）
   - `requirements.txt` 加 `strands-agents-tools>=0.8.5`（可选 extras：`[mem0_memory]` 暂不加）
   - 在 `strands_backend/tools/__init__.py` 的 `make_all_ops_tools()` 中按需注入 `shell` / `http_request` / `journal` / `editor` 工具
   - **不引入** `use_computer` / `browser` / `slack` 等需要外部依赖的工具

2. **实现 `ApprovalHook`（HITL）**
   - 新增 `strands_backend/hooks/approval_hook.py`
   - 注册到 `StrandsAgentAdapter` 的 `Agent(hooks=[approval_hook])`
   - 高危工具名单：`ssh_command`（已有内部审批）/ 新增的 `shell` / `editor`（写文件）
   - 与前端 `TdsfAgentPanel` 联动：Hook 触发时通过 `event_bus.emit_tool_call` 推送审批请求，前端弹窗，用户响应回传

3. **实现 `LimitToolCounts` Hook**
   - 新增 `strands_backend/hooks/limit_tool_counts.py`
   - 默认上限 50 次工具调用（可配置）
   - 替代已移除的 `max_iterations` 参数

#### 5.1.2 短期做（P1，1-2 周内）

4. **引入 `use_agent` + `swarm` 多 Agent 模式**
   - 重构现有 9 个 Agent registry（main + coding/explore/history/teach + debug/refactor/test/deploy）为 Swarm 模式
   - 主 Agent 用 Swarm 委托子 Agent，子 Agent 可用不同模型（如调试用更强模型，探索用更快模型）
   - 在 `StrandsAgentAdapter` 中支持 `agent.tool.swarm(task=..., agents=[...])` 调用

5. **引入 `mcp_client` 工具**
   - 新增 `strands_backend/tools/mcp_k8sgpt.py`：包装 Strands `mcp_client`，连接用户部署的 `k8sgpt serve --mcp --mcp-http`
   - 新增 `.tdsf-data/mcp_servers.json` 配置文件，记录用户配置的 MCP server 列表
   - 用户无 K8s 时，工具返回"未配置 K8s MCP server"graceful degrade

#### 5.1.3 中期做（P2，1 个月内）

6. **引入 `scheduler` 工具**
   - 定时巡检任务（每小时检查磁盘空间 / 每日生成运维报告）
   - 与 Tauri 侧 `src-tauri/modules/sidecar.rs` 协作持久化 cron 配置

7. **引入 `memory` 工具（Mem0 后端）**
   - 跨会话记住用户运维偏好 / 历史故障模式 / 主机拓扑
   - 本地优先：Mem0 默认本地 SQLite 后端，不依赖云

#### 5.1.4 延后（P3，未来考虑）

8. **借鉴 robusta Playbook 设计** — 实现 TDSF 自己的事件驱动自动化
   - 设计 `playbooks/*.yaml` schema（trigger + action + filter）
   - 实现 trigger 注册器（cron / 文件 watch / 终端输出 watch）
   - 实现 action 执行器（调 Strands tools）

9. **借鉴 OpenOps workflow 版本控制** — 用 git 管理 `.tdsf-data/playbooks/`

### 5.2 工程量估算

| 阶段 | 任务 | 人日 |
|------|------|------|
| P0 | strands-agents-tools 引入 + 4 工具注入 | 0.5 |
| P0 | ApprovalHook + 前端联动 | 1.5 |
| P0 | LimitToolCounts Hook | 0.5 |
| **P0 小计** | | **2.5** |
| P1 | use_agent + swarm 多 Agent 重构 | 2.0 |
| P1 | mcp_client + k8sgpt 接入 | 1.0 |
| **P1 小计** | | **3.0** |
| P2 | scheduler 工具 + 持久化 | 1.5 |
| P2 | memory（Mem0）工具 | 1.0 |
| **P2 小计** | | **2.5** |
| P3 | Playbook schema + trigger + action | 5.0 |
| **总计** | | **13.0 人日** |

### 5.3 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| strands-agents-tools 引入新依赖（pydantic 已有，但 mem0 等会带来链式依赖） | 中 | 只装核心包，extras 按需 |
| ApprovalHook 阻塞 agent loop，可能导致前端超时 | 中 | 设置审批超时（30s）+ 超时默认拒绝 |
| swarm 多 Agent 模式可能增加 LLM 调用成本 | 中 | 限制 max_handoffs / max_iterations / node_timeout |
| k8sgpt MCP server 需要 K8s 集群 + 用户部署 | 低 | 可选功能，graceful degrade |
| Strands 1.50.2 移除 max_iterations 后，LimitToolCounts 是社区惯例非官方 API | 低 | Hook 系统是官方稳定 API，LimitToolCounts 实现简单可自维护 |
| k8sgpt 2026 年活跃度下降（stars 年降 19%） | 低 | 仅作可选外挂，不依赖其路线图 |
| robusta Playbook 借鉴需自研 schema，工程量大 | 低 | P3 阶段，可延后 |

---

## 6. 优先级排序

### 6.1 立即集成（P0，本周）

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P0-1** | **Strands ApprovalHook（HITL）** | 安全护栏，运维场景必须（高危命令需人工确认） |
| **P0-2** | **Strands LimitToolCounts Hook** | 替代已移除的 max_iterations，防失控 |
| **P0-3** | **strands-agents-tools 核心 4 工具**（shell / http_request / journal / editor） | 扩展运维能力，零风险 |

### 6.2 短期集成（P1，2 周内）

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P1-1** | **use_agent + swarm 多 Agent** | 提升复杂故障排查能力，与现有 9 Agent registry 对齐 |
| **P1-2** | **mcp_client + k8sgpt MCP** | 可选 K8s 集成，零打包成本 |

### 6.3 中期集成（P2，1 个月内）

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P2-1** | **scheduler 工具** | 定时巡检，主动运维 |
| **P2-2** | **memory（Mem0）工具** | 跨会话记忆，提升用户体验 |

### 6.4 延后/不集成

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P3** | 借鉴 robusta Playbook 设计 | 工程量大（5 人日），先观察 P0-P2 落地效果 |
| **不集成** | k8sgpt 本体（Go 二进制嵌入） | 强 K8s 耦合，违背"魔改要轻"原则 |
| **不集成** | robusta 本体 | 强 K8s Operator 耦合，无法嵌入 Python sidecar |
| **不集成** | OpenOps 本体 | 是 FinOps 平台，与 TDSF 运维 Agent 目标不匹配 |
| **不集成** | strands-agents-tools 重型工具（use_computer / browser / slack / video / audio） | 桌面端不需要，依赖过重 |

---

## 7. 引用链接

### k8sgpt
- 仓库：<https://github.com/k8sgpt-ai/k8sgpt>
- README（raw）：<https://raw.githubusercontent.com/k8sgpt-ai/k8sgpt/main/README.md>
- pkg.go.dev（analysis 包）：<https://pkg.go.dev/github.com/k8sgpt-ai/k8sgpt/pkg/analysis>
- pkg.go.dev（k8sgpt-operator）：<https://pkg.go.dev/github.com/k8sgpt-ai/k8sgpt-operator/internal/controller/k8sgpt>
- pkg.go.dev（go-custom-analyzer）：<https://pkg.go.dev/github.com/k8sgpt-ai/go-custom-analyzer/pkg/analyzer>
- CNCF 项目页：<https://www.cncf.io/projects/k8sgpt/>
- CNCF 博客（2024）：<https://www.cncf.io/blog/2024/06/07/generative-ai-for-kubernetes-meet-k8sgpt-open-source-project/>
- 实践博客（2026，DeepSeek + k8sgpt）：<https://blog.csdn.net/weixin_74812406/article/details/162793076>
- 内部开发者门户集成：<https://cloud.tencent.com/developer/article/2469897>

### OpenOps
- 仓库（活跃版）：<https://github.com/openops-cloud/openops>
- 仓库（已废弃版）：<https://github.com/mattermost/openops>
- 官方文档：<https://docs.openops.com/getting-started/deployment/local>
- AWS Marketplace：<https://aws.amazon.com/marketplace/pp/prodview-f23whzvfjwpam>
- CVE-2025-68922：<https://avd.aliyun.com/detail?id=AVD-2025-68922>
- CSDN 项目介绍：<https://blog.csdn.net/gitblog_00789/article/details/146559171>

### robusta
- 仓库：<https://github.com/robusta-dev/robusta>
- 官方文档：<https://docs.robusta.dev/master/index.html>
- Slack 社区：<https://bit.ly/robusta-slack>
- SourceForge 镜像（含版本历史）：<https://sourceforge.net/mirror/robusta/>
- HolmesGPT toolset 文档（Prometheus）：<https://docs.robusta.dev/master/configuration/index.html>
- Playbook 系统指南：<https://blog.csdn.net/gitblog_00676/article/details/151273102>
- K8s ChatGPT Bot 实践：<https://blog.csdn.net/weixin_42573647/article/details/160997343>

### Strands Agents 生态
- strands-agents-tools PyPI：<https://pypi.org/project/strands-agents-tools/>
- strands-agents-tools 仓库：<https://github.com/strands-agents/tools>
- Strands SDK 仓库：<https://github.com/strands-agents/sdk-python>
- 官方文档（Agent Loop）：<https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/>
- AWS Healthcare HITL 博客（4 种 HITL 模式）：<https://aws.amazon.com/cn/blogs/machine-learning/human-in-the-loop-constructs-for-agentic-workflows-in-healthcare-and-life-sciences/>
- AWS Workshop Lab 9b（Swarm）：<https://catalog.workshops.aws/strands-agents/en-US/20-multi-agent-topology/20b-swarm>
- AWS Strands + Claude 4 Interleaved Thinking：<https://aws.amazon.com/cn/blogs/opensource/using-strands-agents-with-claude-4-interleaved-thinking/>
- AWS Strands + Exa 博客：<https://aws.amazon.com/blogs/machine-learning/building-web-search-enabled-agents-with-strands-and-exa/>
- AWS 开源博客（Strands 发布）：<https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/>
- AWS prescriptive guidance（Strands 概览）：<https://docs.aws.amazon.com/zh_tw/prescriptive-guidance/latest/agentic-ai-frameworks/strands-agents.html>
- AWS 物理 AI 博客（re:Invent 2025）：<https://aws.amazon.com/blogs/opensource/building-intelligent-physical-ai-from-edge-to-cloud-with-strands-agents-bedrock-agentcore-claude-4-5-nvidia-gr00t-and-hugging-face-lerobot/>
- Strands 中文介绍（talkingdev 2026-06）：<http://tool.enimo.cn/n/a.V1hQW1k=>
- Strands 实战教程（CSDN 2026-03）：<https://icode.best/i/243842424660235>

### TDSF 现有架构参考
- Strands 集成实施报告：<`docs/reports/strands-integration-implementation-plan-2026-07-30.md`>
- 项目开发规范：<`CLAUDE.md`>
- 项目接手入口：<`AGENTS.md`>
- 当前状态：<`docs/dev-state.md`>

---

> **最后更新**：2026-07-30 · v1.0 · 调研报告完成稿
> **数据基准**：2026-07-30 当日 WebSearch + WebFetch + PyPI/GitHub 实际抓取
> **下一步**：基于本报告 §5.1.1 的 P0 任务，与 `strands-integration-implementation-plan-2026-07-30.md` 的 P0/P1/P2 里程碑合并，更新到 `docs/dev-state.md` 的下一步规划
