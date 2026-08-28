# 开源项目调研报告：ITOps Agent Platform

> **调研对象**：[qinshihu/itops-agent-platform](https://github.com/qinshihu/itops-agent-platform)
> **调研日期**：2026-07-10
> **调研目的**：为 TDSF-Linux（人机协同可信决策智能体）项目寻找可借鉴的设计模式与可复用的代码结构
> **报告版本**：v1.0

---

## 一、项目概述

### 1.1 基本信息

| 维度 | 内容 |
|---|---|
| **项目名称** | ITOps Agent Platform |
| **定位** | 企业级 IT 运维多 Agent 自动化平台 |
| **作者** | 谭策（IT Online） |
| **许可证** | MPL-2.0（2026-05-27 后，商用需授权） |
| **当前版本** | v3.0.5 |
| **提交记录** | 69 commits（截至 2026-05-29） |
| **官网** | https://www.zjzwfw.cloud/ITOpsAgentinfo |

### 1.2 核心定位与目标用户

**一句话定位**：基于大语言模型的全开源多 Agent 智能运维解决方案，通过可视化工作流编排多个 AI Agent 协同工作，实现服务器巡检、告警处理、故障诊断、合规检查等运维任务的自动化。

**目标用户**：
- 中大型企业 IT 运维团队
- 需要多服务器统一管理的企业
- 对数据安全敏感、要求本地化部署的用户（支持 Ollama/vLLM 本地模型）
- 希望用 AI 驱动告警自动响应与根因分析的运维组织

**核心特性**：
- 9 个预设运维 Agent + 自定义 Agent
- 可视化拖拽式工作流编排（串行/并行/条件分支）
- Web SSH 终端（xterm.js）
- 告警中心（Prometheus/Zabbix Webhook 接入）
- AI 驱动根因分析 + 自动修复
- 知识库 + RAG 检索
- AES-256-GCM 加密 + JWT 双令牌认证
- Docker 一键部署

---

## 二、技术栈分析

### 2.1 技术栈对照表

| 层级 | ITOps Agent Platform | TDSF-Linux（我们） | 异同 |
|---|---|---|---|
| **后端语言** | TypeScript (Node.js) | Python | **完全不同** |
| **后端框架** | Express | Streamlit | 不同（前者重后者轻） |
| **前端框架** | React 18 + Vite | Streamlit 内置 | 不同（前者独立后者一体） |
| **状态管理** | Zustand + React Query | Streamlit session_state | 不同 |
| **工作流编辑器** | @xyflow/react（拖拽式） | LangGraph（代码式） | **理念差异大** |
| **Agent 编排** | 自研 Coordinator-Specialist 模式 | LangGraph StateGraph | **完全不同** |
| **数据库** | SQLite (better-sqlite3) | SQLite | **相同** |
| **向量库** | 无（用关键词+Jaccard） | ChromaDB | 不同（我们更先进） |
| **日志解析** | 无（依赖关键词规则） | Drain3 | 不同（我们更先进） |
| **LLM 接入** | 豆包/OpenAI/Ollama（自研 providers） | 火山方舟 API | 类似（都支持多模型） |
| **实时通信** | Socket.io（WebSocket） | Streamlit 原生 | 不同 |
| **远程连接** | SSH2 | 无（本地分析为主） | 不同 |
| **容器化** | Docker + Docker Compose + Nginx | 暂无 | 不同 |
| **测试框架** | Vitest + Supertest | 暂无 | 不同 |
| **架构约束** | dependency-cruiser + madge | 暂无 | 不同 |

### 2.2 后端关键依赖（package.json）

```
# 核心
express, better-sqlite3, socket.io, ssh2, jsonwebtoken, bcryptjs
# 工具
axios, uuid, zod, dotenv, helmet, morgan, multer
# 运维相关
dockerode, net-snmp, node-schedule, nodemailer, pdfkit, shell-quote
# 文档
swagger-jsdoc, swagger-ui-express
```

**值得注意**：
- **无 LangChain/LangGraph 依赖**——Agent 编排完全自研
- **无向量数据库依赖**——知识检索基于关键词 + Jaccard 相似度
- **无 Drain3 等日志解析库**——根因分析基于关键词规则匹配

---

## 三、系统架构解析

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器（用户）                            │
└────────────────────────┬────────────────────────────────────────┘
                         │ WebSocket 实时通信
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Nginx 反向代理                              │
└────────┬───────────────────────────────────────┬────────────────┘
         │                                       │
         ▼                                       ▼
┌─────────────────────┐                ┌─────────────────────────┐
│   React 前端        │                │   Express 后端          │
│  30+ 页面           │◄──────────────►│  31 路由 | 20+ 服务     │
│  Zustand            │                │  JWT 认证               │
│  @xyflow/react      │                │                         │
└─────────────────────┘                └──────────┬──────────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             │                             │
                    ▼                             ▼                             ▼
          ┌─────────────────┐         ┌─────────────────────┐        ┌──────────────────┐
          │  SQLite 数据库   │         │  🤖 LLM API         │        │  🖥️ SSH 远程     │
          │  39 张表         │         │  豆包|OpenAI|Ollama  │        │  服务器           │
          │  AES-256 加密    │         └─────────────────────┘        └──────────────────┘
          └─────────────────┘
                                                  │
                                                  ▼
                                    ┌──────────────────────────┐
                                    │  🚨 告警 Webhook         │
                                    │  Prometheus | Zabbix     │
                                    └──────────────────────────┘
                                                  │
                                                  ▼
                                    ┌──────────────────────────┐
                                    │  📬 通知渠道              │
                                    │  邮件 | 企微 | 钉钉       │
                                    └──────────────────────────┘
```

### 3.2 后端分层架构（重点）

项目采用**严格的分层 + 模块化**架构，有明确的依赖方向约束（通过 dependency-cruiser 强制）：

```
backend/src/
├── app.ts                    # 入口（HTTP/Socket.io 启动）
├── serviceRegistry.ts        # ⭐ 组装层（Composition Root）
├── swagger.ts                # API 文档
├── core/                     # 🔒 核心层（不依赖 modules）
│   └── serviceContainer.ts   #   DI 容器（register/resolve/initAll/shutdownAll）
├── modules/                  # 📦 业务模块层（18 个模块）
│   ├── _registry.ts          #   模块注册表
│   ├── ai/                   #   AI 模块（最核心）
│   ├── alerts/               #   告警模块
│   ├── auto/                 #   自动化（修复/扩缩容）
│   ├── auth/                 #   认证
│   ├── backup/               #   备份
│   ├── change-management/    #   变更管理
│   ├── config-management/    #   配置管理
│   ├── containers/           #   容器（Docker/VM）
│   ├── database/             #   数据库管理
│   ├── dc/                   #   数据中心
│   ├── infra/                #   基础设施（报表）
│   ├── kubernetes/           #   K8s
│   ├── mcp/                  #   MCP 协议工具
│   ├── monitor/              #   自监控
│   ├── network/              #   网络（SNMP）
│   ├── notification/         #   通知
│   ├── servers/              #   服务器管理
│   └── workflow/             #   工作流引擎
├── repositories/             # 🗃️ 数据访问层（18 个 Repository）
├── routes/                   # 🛣️ 路由层（31 个路由）
├── middleware/               # 🚦 中间件（认证/限流/审计）
├── models/                   # 📋 数据模型
├── types/                    # 📐 类型定义
├── utils/                    # 🔧 工具（logger 等）
├── shared/                   # 🤝 共享代码
├── constants/                # 📌 常量
└── data/                     # 💾 静态数据
```

**关键架构原则**（从 serviceRegistry.ts 注释提炼）：
> serviceRegistry 位于 src/ 根级别，不在 core/ 中。原因：它负责组装所有模块，按照架构约束规则，**组装层可以依赖所有模块，而 core/ 不能依赖 modules/**。参照 ongrid 的 cmd/ 层（assembly layer）模式。

### 3.3 DI 容器模式（serviceContainer.ts）

项目实现了轻量级 DI 容器，每个服务注册时声明依赖：

```typescript
// 注册示例（来自 serviceRegistry.ts）
container.register('alertProcessor', () => {
  alertProcessor.init();
  return alertProcessor;
}, ['alertAutoResponseService', 'remediationService', 'knowledgeEngine']);

container.register('remediationService', () => {
  remediationService.init();
  return remediationService;
}, ['notificationService', 'rootCauseAnalysisService'], {
  shutdown: () => remediationService.shutdown()
});
```

**三要素**：
1. 工厂函数（延迟创建）
2. 依赖列表（数组，按序初始化）
3. 可选 shutdown 钩子（优雅关闭）

---

## 四、核心模块清单

### 4.1 AI 模块（`modules/ai/services/`）— 最核心

```
ai/services/
├── KnowledgeEngine.ts        # ⭐ 统一知识引擎（13KB）
├── index.ts                  # 导出
├── agents/                   # Agent 执行器
│   ├── copilotService.ts     #   AI Copilot 对话助手
│   ├── agentExecutor.ts      #   Agent 节点执行
│   └── agentMcpAdapter.ts    #   MCP 工具适配器
├── edge/                     # 边缘计算
├── knowledge/                # 知识库子模块
├── llm/                      # LLM 服务
│   └── llmService.ts         #   generateCompletion + 熔断器
├── models/                   # 模型管理
├── multiAgent/               # ⭐⭐⭐ 多 Agent 系统（核心）
│   ├── Coordinator.ts        #   协调者（16KB）
│   ├── SpecialistBase.ts     #   专家基类（4KB）
│   ├── SpecialistRegistry.ts #   专家注册表（3.6KB）
│   ├── Specialists.ts        #   11 个具体专家（10.6KB）
│   ├── types.ts              #   类型定义
│   └── index.ts              #   入口
├── providers/                # LLM 提供商注册
├── rca/                      # ⭐⭐ 根因分析
│   ├── localRuleEngine.ts    #   本地规则引擎（18.8KB）
│   └── rootCauseAnalysisService/  # RCA 服务
└── remediation/              # AI 修复建议
```

### 4.2 告警模块（`modules/alerts/services/`）— 第二核心

```
alerts/services/
├── AlertProcessor.ts              # ⭐ 统一告警处理引擎（9.7KB）
├── alertService.ts                # 告警服务（14.8KB）
├── alertAutoAnalyzer/             # 告警自动分析
├── alertAutoResponse/             # ⭐⭐ AARS 自动告警响应系统
│   ├── alertAutoResponseService.ts #   核心服务（18.9KB）
│   ├── probeUnit.ts               #   探针单元（12.8KB）
│   ├── adaptive/                  #   自适应学习
│   ├── diagnosis/                 #   诊断
│   ├── remediation/               #   修复
│   ├── notification/              #   通知
│   ├── scheduler/                 #   调度
│   └── types.ts                   #   类型（6.8KB）
├── alertCorrelationService.ts     # 告警关联（16.4KB）
├── alertNoiseReductionService.ts  # 告警降噪（5.8KB）
├── alertNotificationService.ts    # 告警通知（12.7KB）
├── alertDeviceResolver.ts         # 设备解析
├── alertSourceAdapters.ts         # 告警源适配器（Prometheus/Zabbix）
├── alertWorkflowMappingService.ts # 告警-工作流映射
└── alertProviderRegistry.ts       # 提供商注册
```

### 4.3 工作流模块（`modules/workflow/services/`）

```
workflow/services/
├── WorkflowEngine.ts           # ⭐ 工作流执行引擎（11KB）
├── enhancedNodeExecutor.ts     # 增强节点执行器（24.4KB）
├── schedulerService.ts         # 调度服务
├── queueService.ts             # 队列服务
└── workflowExpressionEvaluator.ts # 表达式求值
```

### 4.4 其他重要模块

| 模块 | 核心服务 | 作用 |
|---|---|---|
| `auto/` | remediationService, autoScaleService | 自动修复 + 自动扩缩容 |
| `auth/` | credentialService, encryptionService, tokenBlacklist | AES-256 加密 + JWT |
| `mcp/` | registerAllPlatformTools | MCP 协议工具注册 |
| `containers/` | dockerService, multiHostDockerService | Docker 管理 |
| `backup/` | backupService | 数据库备份恢复 |
| `monitor/` | selfMonitorService | 系统自监控 |

---

## 五、Agent 编排方式深度解析

### 5.1 Coordinator-Specialist 模式

项目采用**自研的 Coordinator-Specialist 双层 Agent 架构**（非 LangGraph）：

```
┌─────────────────────────────────────────────────────────┐
│              Coordinator（协调者 Agent）                 │
│  - 任务分解（LLM 驱动，生成 JSON 子任务列表）            │
│  - 依赖管理（检查 dependencies 是否满足）                │
│  - 优先级排序（按 priority 字段）                       │
│  - 结果整合（LLM 生成最终报告）                         │
│  - 重试机制（指数退避，maxRetries=3）                   │
│  - 回退策略（LLM 失败 → 简单分解）                      │
└────────────────────────┬────────────────────────────────┘
                         │ 分配子任务
                         ▼
┌─────────────────────────────────────────────────────────┐
│           SpecialistRegistry（专家注册表）               │
│  selectBestSpecialistForTask(input) → 按技能关键词匹配   │
└────────────────────────┬────────────────────────────────┘
                         │ 选择最佳专家
                         ▼
┌─────────────────────────────────────────────────────────┐
│              11 个 Specialist（专家 Agent）              │
├─────────────────────────────────────────────────────────┤
│  1. AlertHandlingSpecialist      告警处理               │
│  2. FaultDiagnosisSpecialist     故障诊断               │
│  3. LogAnalysisSpecialist        日志分析               │
│  4. SystemInspectionSpecialist   系统巡检               │
│  5. ChangeExecutionSpecialist    变更执行               │
│  6. DocumentGenerationSpecialist 文档生成               │
│  7. ComplianceCheckSpecialist    合规检查               │
│  8. ServerOperationSpecialist    服务器操作             │
│  9. CommandGenerationSpecialist  命令生成               │
│ 10. NetworkInspectionSpecialist  网络巡检               │
│ 11. DatabaseOperationSpecialist  数据库运维             │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Coordinator 核心流程（Coordinator.ts）

```typescript
// 完整任务处理流程
async executeTask(input: string, userId?: string): Promise<AgentResponse> {
  // 1. LLM 驱动的任务分解
  const decomposition = await this.decomposeTask(input);
  
  // 2. 简单任务（1 个子任务）→ 直接分配
  if (decomposition.subtasks.length === 1) {
    return await this.handleSimpleTask(context, decomposition.subtasks[0]);
  }
  
  // 3. 复杂任务 → 按优先级排序 + 检查依赖 + 顺序执行 + 整合
  return await this.handleComplexTask(context, decomposition);
}

// 任务分解（LLM 生成 JSON）
private async decomposeTask(input: string): Promise<TaskDecomposition> {
  const prompt = `请分析以下运维任务，并将其分解为子任务...
  请以 JSON 格式返回：{ "mainTask": "...", "subtasks": [...], 
  "requiredDomains": [...], "estimatedComplexity": 1-10 }`;
  
  try {
    const llmResponse = await generateCompletion(prompt, this.systemPrompt, 0.3);
    return this.parseDecompositionResponse(llmResponse, input);
  } catch {
    return this.fallbackDecomposition(input);  // 回退：单任务
  }
}

// 带重试的专家执行（指数退避）
private async executeSpecialistWithRetry(specialist, context): Promise<ExecutionResult> {
  for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
    try {
      return await this.executeSpecialist(specialist, context);
    } catch (error) {
      const waitTime = Math.pow(2, attempt) * 1000;  // 2s, 4s, 8s
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}
```

### 5.3 Specialist 设计模式

每个 Specialist 包含 5 个核心属性：

```typescript
class AlertHandlingSpecialist extends SpecialistBase {
  constructor() {
    super(
      '告警处理专家',                          // name
      SpecialistDomain.ALERT_HANDLING,         // domain
      {
        domain: SpecialistDomain.ALERT_HANDLING,
        skills: ['告警', 'alert', '故障', 'severity', 'critical'],  // 技能关键词
        confidenceThreshold: 0.4               // 置信度阈值
      },
      `你是一个专业的告警处理专家...`,          // systemPrompt
      0.7                                      // temperature
    );
  }
  async execute(context: TaskContext): Promise<ExecutionResult> {
    return this.executeWithLLM(context);  // 或 executeAgentNode
  }
}
```

**两种执行模式**：
- `executeWithLLM` — 纯 LLM 对话（告警处理、故障诊断、日志分析等）
- `executeAgentNode` — 调用预设 Agent（系统巡检、服务器操作、数据库运维）

### 5.4 SpecialistDomain 枚举（11 个领域）

```typescript
enum SpecialistDomain {
  ALERT_HANDLING,        // 告警处理
  FAULT_DIAGNOSIS,       // 故障诊断
  LOG_ANALYSIS,          // 日志分析
  SYSTEM_INSPECTION,     // 系统巡检
  CHANGE_EXECUTION,      // 变更执行
  DOCUMENT_GENERATION,   // 文档生成
  COMPLIANCE_CHECK,      // 合规检查
  SERVER_OPERATION,      // 服务器操作
  COMMAND_GENERATION,    // 命令生成
  NETWORK_INSPECTION,    // 网络巡检
  DATABASE_OPERATION     // 数据库运维
}
```

**中英文领域映射**（normalizeDomain 方法）：支持"告警→ALERT_HANDLING"、"故障→FAULT_DIAGNOSIS"等中文关键词识别。

---

## 六、日志分析 / 根因分析算法

### 6.1 LocalRuleEngine（本地规则引擎）— 核心算法

项目**未使用 Drain3 等日志解析库**，而是自研了基于关键词匹配的规则引擎：

```typescript
// 9 种内置故障模式
private readonly failurePatterns: FailurePattern[] = [
  { id: 'CPU_HIGH',         keywords: ['cpu', '处理器', '负载', 'load'] },
  { id: 'MEMORY_LEAK',      keywords: ['memory', '内存', 'oom', 'out of memory'] },
  { id: 'DISK_FULL',        keywords: ['disk', '磁盘', 'no space left'] },
  { id: 'NETWORK_DOWN',     keywords: ['network', '网络', 'timeout', '断网'] },
  { id: 'SERVICE_DOWN',     keywords: ['service', '服务', 'down', '宕机', 'crash'] },
  { id: 'DATABASE_ISSUE',   keywords: ['database', 'mysql', 'postgres', 'deadlock'] },
  { id: 'SSL_CERT_EXPIRED', keywords: ['ssl', '证书', 'certificate', 'expired'] },
  { id: 'AUTH_FAILURE',     keywords: ['auth', '认证', '401', '403', 'token'] },
  { id: 'HIGH_LATENCY',     keywords: ['latency', '延迟', 'slow', 'performance'] }
];
```

**每个 FailurePattern 结构**：
```typescript
interface FailurePattern {
  id: string;              // CPU_HIGH
  name: string;            // CPU 使用率过高
  keywords: string[];      // 关键词列表
  rootCause: string;       // 根因描述
  symptoms: string[];      // 症状列表
  recommendations: string[]; // 修复建议
  scripts?: string[];      // 诊断脚本（如 'top -bn1 | head -20'）
}
```

### 6.2 根因分析流程

```typescript
analyzeByRules(alertTitle: string, alertContent: string): RuleAnalysisResult {
  const searchContent = `${alertTitle} ${alertContent}`.toLowerCase();
  
  // 1. 模式匹配（关键词命中计数排序）
  const matchedPatterns = this.matchPatterns(searchContent);
  if (matchedPatterns.length === 0) {
    return this.generateGenericAnalysis(alertTitle, alertContent);
  }
  
  // 2. 取最佳匹配
  const bestMatch = matchedPatterns[0];
  
  // 3. 计算置信度
  const confidence = this.calculateConfidence(bestMatch, searchContent);
  
  // 4. 生成结果（含 timeline 和 evidence）
  return {
    rootCause: bestMatch.rootCause,
    symptoms: bestMatch.symptoms,
    timeline: [...],  // 时间线事件
    evidence: [...],  // 证据（命中的关键词）
    recommendations: bestMatch.recommendations,
    matchedPatternId: bestMatch.id,
    confidence        // 0~1
  };
}

// 置信度计算算法
private calculateConfidence(pattern, content): number {
  const matchedCount = pattern.keywords.filter(k => content.includes(k)).length;
  const totalKeywords = pattern.keywords.length;
  const keywordMatchRatio = matchedCount / totalKeywords;  // 关键词命中率
  const lengthFactor = Math.min(content.length / 100, 1);  // 内容长度因子
  return Math.min(1, keywordMatchRatio * 0.7 + lengthFactor * 0.3);
}
```

### 6.3 知识推荐算法（recommendKnowledge）

```typescript
// 基于评分的知识推荐
recommendKnowledge(alertType, alertTitle) {
  for (const article of this.knowledgeBase) {
    let score = 0;
    // alertType 匹配 +0.5
    if (article.alertTypes.some(t => match(t, alertType))) score += 0.5;
    // tag 匹配 +0.2/个
    for (const tag of article.tags) {
      if (searchContent.includes(tag)) score += 0.2;
    }
    // 标题关键词匹配 +0.1/个
    for (const keyword of article.title.split(/\s+/)) {
      if (searchContent.includes(keyword)) score += 0.1;
    }
  }
  // 按 score 降序，返回 top 5
}
```

### 6.4 工作流降级执行（executeWorkflowFallback）

当工作流执行失败时，规则引擎提供降级脚本模板：

```typescript
private readonly workflowScripts: WorkflowScriptTemplate[] = [
  { workflowType: 'restart_service', scriptTemplate: 'systemctl restart {{service_name}}' },
  { workflowType: 'check_disk',      scriptTemplate: 'df -h && du -sh /var/log/*' },
  { workflowType: 'check_memory',    scriptTemplate: 'free -m && ps aux --sort=-%mem' },
  // ... 6 个模板
];

// 模板变量替换（{{server_ip}}, {{service_name}} 等）
```

---

## 七、人工确认 / HITL 机制

### 7.1 统一告警处理引擎（AlertProcessor.ts）— HITL 核心

项目实现了**策略驱动的告警处理决策**，其中包含 HITL 审批：

```typescript
const DEFAULT_CONFIG = {
  criticalSeverity: 'hybrid' as ProcessingStrategy,   // critical: 混合策略
  highSeverity: 'hybrid' as ProcessingStrategy,       // high: 混合策略
  mediumSeverity: 'aars' as ProcessingStrategy,       // medium: AARS 自动
  lowSeverity: 'workflow' as ProcessingStrategy,      // low: 工作流
  knowledgeThreshold: 0.8,                            // 知识库匹配阈值
  maxAarsFallback: true                               // AARS 失败回退到 workflow
};

// 四种处理策略
type ProcessingStrategy = 'aars' | 'workflow' | 'hybrid' | 'auto';
```

### 7.2 决策流程

```typescript
private makeDecision(context: AlertProcessingContext): ProcessingDecision {
  // 1. 先查历史知识库
  const knowledgeMatch = this.checkKnowledge(context);
  if (knowledgeMatch.found && knowledgeMatch.successRate >= 0.8) {
    return { strategy: 'workflow', workflowId: knowledgeMatch.workflowId };
  }
  
  // 2. 按严重程度分级决策
  if (context.severity === 'critical' || context.severity === 'high') {
    return { strategy: 'hybrid', aarsFallback: true };
  }
  if (context.severity === 'medium') {
    return { strategy: 'aars' };
  }
  return { strategy: 'workflow' };
}
```

### 7.3 审批模式（关键 HITL 实现）

在 `getOrCreatePolicy` 方法中，修复策略默认采用**审批模式**：

```typescript
private async getOrCreatePolicy(context, workflowId): Promise<RemediationPolicy> {
  // 查找已有策略
  const existing = remediationPolicyRepository.findBySourceSeverityWorkflow(...);
  if (existing) return existing;
  
  // 创建临时策略，关键：execution_mode = 'approval'
  remediationPolicyRepository.createMinimal({
    id,
    name: `临时策略: ${context.title.substring(0, 40)}`,
    execution_mode: 'approval',    // ⭐ 审批模式（HITL）
    workflow_id: workflowId,
  });
}
```

**执行状态机**包含 `waiting_approval` 状态：

```typescript
// processWithWorkflow 返回的 execution.status 可能是：
// - 'success'
// - 'pending'
// - 'waiting_approval'  ⭐ 等待人工审批
// - 'failed'
```

### 7.4 AARS（自动告警响应系统）完整组成

```
alertAutoResponse/
├── alertAutoResponseService.ts  # 核心调度
├── probeUnit.ts                 # 探针单元（数据采集）
├── adaptive/                    # 自适应学习
├── diagnosis/                   # 诊断子模块
├── remediation/                 # 修复子模块
├── notification/                # 通知子模块
├── scheduler/                   # 调度子模块
└── types.ts                     # 类型定义
```

**AARS 工作流**：探针采集 → 诊断分析 → 修复执行 → 通知推送 → 知识沉淀

---

## 八、决策库 / 知识库设计

### 8.1 KnowledgeEngine 统一知识引擎（最值得借鉴）

项目**合并了 AARS 的 knowledgeFeedbackLoop 和工作流的 knowledge 节点**，提供统一的知识管理：

```typescript
class KnowledgeEngine {
  // 存储（自动去重）
  store(entry: KnowledgeEntry): string
  
  // 从工作流执行存储
  storeFromWorkflow(params): string
  
  // 从 AARS 处理存储（含根因、修复命令、回滚命令）
  storeFromAARS(params): string
  
  // 检索
  query(params: KnowledgeQuery): KnowledgeEntry[]
  search(keyword: string, limit?): KnowledgeEntry[]
  
  // ⭐ 智能推荐（基于相似度）
  recommend(alertTitle: string, alertContent?: string, limit?): KnowledgeMatch[]
  
  // 统计
  getStats(): KnowledgeStats
}
```

### 8.2 KnowledgeEntry 数据结构（核心）

```typescript
interface KnowledgeEntry {
  id?: string;
  title: string;
  category: string;
  content: string;
  tags?: string[];
  solutions?: KnowledgeSolutions;  // ⭐ 结构化解决方案
  source: 'aars' | 'workflow' | 'manual';  // 来源
  alertId?: string;
  workflowId?: string;
  taskId?: string;
  serverId?: string;
  successRating: number;    // ⭐ 成功率 0~1
  durationMs?: number;      // 处理时长
  usageCount?: number;      // 使用次数
  createdAt?: string;
}

interface KnowledgeSolutions {
  rootCause?: string;           // 根因
  commands?: string[];          // 修复命令
  rollbackCommands?: string[];  // 回滚命令
  verificationResult?: string;  // 验证结果
  success?: boolean;
}
```

### 8.3 相似度计算算法（Jaccard + 标题加权）

```typescript
private computeSimilarity(queryWords: string[], title: string, content: string): number {
  const targetWords = this.tokenize(title + ' ' + content.substring(0, 500));
  
  // Jaccard 相似度
  const querySet = new Set(queryWords);
  const targetSet = new Set(targetWords);
  let intersection = 0;
  for (const w of querySet) {
    if (targetSet.has(w)) intersection++;
  }
  const union = new Set([...querySet, ...targetSet]);
  const jaccard = union.size === 0 ? 1 : intersection / union.size;
  
  // 标题命中加权（最多 +0.3）
  let titleBonus = 0;
  for (const w of queryWords) {
    if (title.toLowerCase().includes(w)) titleBonus += 0.15;
  }
  titleBonus = Math.min(titleBonus, 0.3);
  
  return Math.min(1.0, jaccard + titleBonus);
}

// 分词（支持中英文，过滤停用词）
private tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')  // 保留中英文
    .split(/\s+/)
    .filter(w => w.length > 1)
    .filter(w => !['the', 'and', 'for', 'are', ...].includes(w));  // 停用词
}
```

### 8.4 自动去重机制

```typescript
private findDuplicate(entry: KnowledgeEntry): string | null {
  const titlePrefix = entry.title.substring(0, 50);
  const existing = knowledgeRepository.findDuplicates(titlePrefix, entry.alertId);
  
  for (const row of existing) {
    const sim = this.computeSimilarity(this.tokenize(entry.title), row.title, row.content);
    if (sim > 0.6) {  // 相似度 > 0.6 视为重复
      return row.id;  // 返回已有条目 ID，调用方执行 mergeOnDuplicate
    }
  }
  return null;
}
```

### 8.5 知识库反馈循环（与告警处理联动）

```
告警发生
   │
   ▼
AlertProcessor.makeDecision()
   │
   ├──► knowledgeEngine.recommend() ──► 查历史案例
   │         │
   │         └──► 匹配 + successRate >= 0.8 ──► 直接用 workflow 策略
   │
   ▼
执行修复（AARS 或 workflow）
   │
   ▼
knowledgeEngine.storeFromAARS()  ──► 沉淀新知识
   │
   │  （包含 rootCause, commands, rollbackCommands, verificationResult）
   │
   ▼
下次同类告警 ──► 命中知识库 ──► 自动推荐修复方案
```

---

## 九、与 TDSF-Linux 方案的异同点

### 9.1 相同点

| 维度 | 共性 |
|---|---|
| **数据库** | 都用 SQLite（轻量、嵌入式） |
| **LLM 接入** | 都支持多模型（豆包/OpenAI），都支持本地部署 |
| **知识库理念** | 都有"经验沉淀"思想（他们叫 KnowledgeEngine，我们叫决策库） |
| **HITL 思想** | 都有人工确认机制（他们 approval 模式，我们可信决策） |
| **根因分析** | 都有 RCA 能力（他们规则引擎，我们 Drain3+LLM） |
| **多 Agent** | 都是多 Agent 协作（他们 Coordinator-Specialist，我们 LangGraph） |

### 9.2 差异点（重点）

| 维度 | ITOps Agent Platform | TDSF-Linux（我们） |
|---|---|---|
| **核心定位** | 运维自动化平台（执行导向） | 可信决策智能体（决策导向） |
| **技术栈** | TypeScript/Node.js（重） | Python/Streamlit（轻） |
| **Agent 编排** | 自研 Coordinator-Specialist | LangGraph StateGraph |
| **日志解析** | 关键词匹配（简单） | Drain3 模板提取（专业） |
| **知识检索** | Jaccard 相似度（关键词） | ChromaDB 向量检索（语义） |
| **可视化工作流** | @xyflow/react 拖拽式 | LangGraph 代码式 |
| **Web SSH** | 有（xterm.js + SSH2） | 无 |
| **告警接入** | 有（Prometheus/Zabbix Webhook） | 无（本地日志分析） |
| **容器化** | 完整 Docker 部署 | 暂无 |
| **企业安全** | AES-256 + JWT + 审计 | 暂无 |
| **可信度量化** | confidence（0~1） | 证据可核验 + 风险可感知 |
| **回滚机制** | rollbackCommands | 暂无显式回滚 |
| **架构约束** | dependency-cruiser 强制分层 | 暂无 |

### 9.3 定位差异本质

**他们**：**"让 Agent 替你干活"** — 强调自动化执行（Web SSH、自动修复、告警响应）
**我们**：**"让 Agent 帮你决策"** — 强调可信决策（证据可核验、风险可感知、经验可沉淀）

> 一句话：他们追求**自动化覆盖率**，我们追求**决策可信度**。

---

## 十、可借鉴点（对 TDSF-Linux 有用的部分）

### 10.1 ⭐⭐⭐ 高优先级借鉴

#### （1）KnowledgeEngine 统一知识引擎设计

**借鉴价值**：我们的"决策库"可以参考其数据结构和反馈循环。

**具体可借鉴**：
- `KnowledgeSolutions` 结构化解决方案（rootCause + commands + rollbackCommands + verificationResult）
- `successRating` 成功率追踪（0~1，用于决策权重）
- `source` 来源标记（aars/workflow/manual）
- 自动去重（Jaccard > 0.6 合并）
- `storeFromAARS` 从处理过程自动沉淀知识

**映射到 TDSF-Linux**：
```python
# 我们的决策库可设计为
class DecisionEntry:
    id: str
    title: str
    log_pattern: str          # Drain3 解析的日志模板
    root_cause: str           # 根因
    evidence: list[str]       # ⭐ 证据链（我们的差异化）
    commands: list[str]       # 修复命令
    rollback_commands: list[str]  # 回滚命令
    risk_level: str           # ⭐ 风险等级（我们的差异化）
    success_rate: float       # 成功率
    usage_count: int
    source: str               # hitl/auto/manual
```

#### （2）AlertProcessor 策略决策引擎

**借鉴价值**：其"知识库优先 + 严重程度分级"的决策逻辑非常实用。

**具体可借鉴**：
- 决策优先级：先查知识库（successRate >= 0.8 直接复用）→ 再按严重程度分级
- 四种策略模式（auto/aars/workflow/hybrid）可映射为我们的决策模式
- `knowledgeThreshold: 0.8` 阈值设计

**映射到 TDSF-Linux**：
```python
def make_decision(log_pattern, severity):
    # 1. 先查决策库
    match = decision_db.recommend(log_pattern)
    if match and match.success_rate >= 0.8:
        return Decision(strategy='reuse', evidence=match.evidence)
    
    # 2. 按风险分级
    if severity == 'critical':
        return Decision(strategy='hitl', reason='高风险需人工确认')
    elif severity == 'high':
        return Decision(strategy='hybrid', auto_execute=True, require_review=True)
    else:
        return Decision(strategy='auto', confidence_threshold=0.7)
```

#### （3）HITL 审批模式设计

**借鉴价值**：他们的 `execution_mode: 'approval'` + `waiting_approval` 状态机很清晰。

**映射到 TDSF-Linux**：
- 决策执行状态机：`pending → waiting_approval → approved/rejected → executing → success/failed`
- 高风险操作强制 approval 模式
- 审批记录可追溯

### 10.2 ⭐⭐ 中优先级借鉴

#### （4）LocalRuleEngine 故障模式库

**借鉴价值**：9 种故障模式的 keywords/rootCause/recommendations/scripts 结构可直接复用。

**注意**：我们已有 Drain3，可以做得更好——将 Drain3 解析的日志模板与故障模式库关联：

```python
# 结合 Drain3 + 规则引擎
drain3_template = "* * * * * Connection * refused"  # Drain3 解析结果
matched_pattern = rule_engine.match(drain3_template)  # 匹配故障模式
# 比 pure keyword matching 更精准
```

#### （5）DI 容器 + 组装层模式

**借鉴价值**：serviceRegistry.ts 的 Composition Root 模式让依赖关系一目了然。

**映射到 TDSF-Linux**（Python 版）：
```python
# core/container.py
class ServiceContainer:
    def register(self, name: str, factory, dependencies: list, shutdown=None)
    def resolve(self, name: str)
    async def init_all(self)
    async def shutdown_all(self)

# service_registry.py（组装层）
def register_all_services():
    container.register('decision_db', lambda: DecisionDB(), [])
    container.register('log_parser', lambda: Drain3Parser(), [])
    container.register('agent_graph', lambda: build_graph(), ['decision_db', 'log_parser'])
```

#### （6）Coordinator-Specialist 任务分解

**借鉴价值**：LLM 驱动的任务分解 + 依赖管理 + 优先级排序 + 结果整合的完整流程。

**注意**：我们用 LangGraph，可以将其映射为：
- Coordinator → LangGraph 的 supervisor 节点
- Specialist → LangGraph 的 worker 节点
- 任务分解 → LangGraph 的 conditional_edges

#### （7）置信度计算算法

**借鉴价值**：`keywordMatchRatio * 0.7 + lengthFactor * 0.3` 的加权方式。

**映射到 TDSF-Linux**：
```python
def calculate_confidence(log_pattern, match_score, evidence_count):
    pattern_match = match_score  # Drain3 匹配度
    evidence_factor = min(evidence_count / 5, 1.0)  # 证据数量因子
    return min(1.0, pattern_match * 0.6 + evidence_factor * 0.4)
```

### 10.3 ⭐ 低优先级参考

#### （8）架构约束工具（dependency-cruiser）

可参考其用 dependency-cruiser + madge 强制分层依赖约束。

#### （9）熔断器（CircuitBreaker）

LLM 调用的熔断器模式（llmService.ts 中的 startCircuitBreakerCleanup）。

#### （10）MCP 工具注册

`registerAllPlatformTools` 的工具注册模式可参考。

---

## 十一、建议整合到 TDSF-Linux 的具体内容

### 11.1 立即可整合（短期，1-2 周）

#### 任务 1：设计决策库数据结构

基于 KnowledgeEngine，设计 TDSF-Linux 的决策库 Schema：

```python
# db/decision_schema.py
DECISION_TABLE = """
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    log_pattern TEXT,              -- Drain3 解析的日志模板
    log_template_id TEXT,          -- Drain3 模板 ID
    root_cause TEXT,
    evidence TEXT,                 -- JSON: 证据链列表
    commands TEXT,                 -- JSON: 修复命令列表
    rollback_commands TEXT,        -- JSON: 回滚命令列表
    risk_level TEXT,               -- low/medium/high/critical
    risk_score REAL,               -- 0~1
    success_rate REAL DEFAULT 0.5, -- 成功率
    usage_count INTEGER DEFAULT 0,
    source TEXT,                   -- hitl/auto/manual
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""
```

#### 任务 2：实现决策推荐引擎

参考 KnowledgeEngine.recommend，用 ChromaDB 实现：

```python
# core/decision_engine.py
class DecisionEngine:
    def __init__(self, chroma_client, drain3_parser):
        self.collection = chroma_client.get_collection("decisions")
        self.parser = drain3_parser
    
    def recommend(self, log_content: str, top_k: int = 5):
        # 1. Drain3 解析日志模板
        template = self.parser.parse(log_content)
        
        # 2. ChromaDB 语义检索（比 Jaccard 更强）
        results = self.collection.query(
            query_texts=[log_content],
            n_results=top_k,
            where={"success_rate": {"$gte": 0.5}}  # 过滤低成功率
        )
        
        # 3. 计算综合置信度
        for r in results:
            r['confidence'] = self._calculate_confidence(r, template)
        
        return sorted(results, key=lambda x: -x['confidence'])
    
    def store_from_hitl(self, log_content, root_cause, commands, evidence, risk_level):
        """从人工确认结果沉淀决策"""
        template = self.parser.parse(log_content)
        self.collection.add(
            documents=[log_content],
            metadatas=[{
                'log_pattern': template,
                'root_cause': root_cause,
                'commands': json.dumps(commands),
                'evidence': json.dumps(evidence),
                'risk_level': risk_level,
                'success_rate': 1.0,
                'source': 'hitl'
            }],
            ids=[str(uuid4())]
        )
```

### 11.2 中期整合（2-4 周）

#### 任务 3：实现策略决策引擎

参考 AlertProcessor.makeDecision：

```python
# core/strategy_engine.py
class StrategyEngine:
    KNOWLEDGE_THRESHOLD = 0.8
    RISK_APPROVAL_MAP = {
        'critical': 'hitl',      # 必须人工
        'high': 'hybrid',        # 执行+审核
        'medium': 'auto_review', # 自动+记录
        'low': 'auto'            # 全自动
    }
    
    def decide(self, log_content: str, severity: str):
        # 1. 查决策库
        match = self.decision_db.recommend(log_content)
        if match and match[0]['success_rate'] >= self.KNOWLEDGE_THRESHOLD:
            return Decision(
                strategy='reuse',
                action=match[0]['commands'],
                evidence=match[0]['evidence'],
                confidence=match[0]['confidence']
            )
        
        # 2. 按风险分级
        strategy = self.RISK_APPROVAL_MAP.get(severity, 'auto')
        return Decision(strategy=strategy, require_approval=(strategy == 'hitl'))
```

#### 任务 4：实现 HITL 审批状态机

```python
# core/hitl.py
from enum import Enum

class DecisionStatus(Enum):
    PENDING = "pending"
    WAITING_APPROVAL = "waiting_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTING = "executing"
    SUCCESS = "success"
    FAILED = "failed"

class HITLManager:
    async def submit_for_review(self, decision: Decision):
        """提交决策供人工审核"""
        decision.status = DecisionStatus.WAITING_APPROVAL
        await self.db.save(decision)
        await self.notify_reviewers(decision)
    
    async def approve(self, decision_id: str, reviewer: str, comments: str):
        decision = await self.db.get(decision_id)
        decision.status = DecisionStatus.APPROVED
        decision.reviewer = reviewer
        decision.review_comments = comments
        await self.db.save(decision)
        return await self.execute(decision)
```

### 11.3 长期整合（1-2 月）

#### 任务 5：故障模式库 + Drain3 联动

将 ITOps 的 9 种故障模式库与 Drain3 模板关联：

```python
# core/fault_patterns.py
FAULT_PATTERNS = [
    {
        'id': 'CPU_HIGH',
        'drain3_templates': [  # 关联 Drain3 模板
            '* * * * * cpu usage * *',
            '* * * * * load average * * *'
        ],
        'keywords': ['cpu', '处理器', '负载'],
        'root_cause': '...',
        'commands': ['top -bn1 | head -20', 'ps aux --sort=-%cpu | head -10'],
        'risk_level': 'medium'
    },
    # ... 9 种模式
]
```

#### 任务 6：Coordinator 模式映射到 LangGraph

将 ITOps 的 Coordinator-Specialist 映射到 LangGraph：

```python
# graph/coordinator_graph.py
from langgraph.graph import StateGraph, END

def build_coordinator_graph():
    graph = StateGraph(AgentState)
    
    # Coordinator 节点（任务分解）
    graph.add_node("coordinator", coordinator_node)
    
    # Specialist 节点（11 个专家）
    graph.add_node("alert_handler", alert_specialist)
    graph.add_node("fault_diagnoser", fault_specialist)
    graph.add_node("log_analyzer", log_specialist)
    # ...
    
    # 结果整合节点
    graph.add_node("integrator", integrator_node)
    
    # 条件路由（对应 normalizeDomain）
    graph.add_conditional_edges(
        "coordinator",
        route_to_specialist,  # 根据 LLM 分解决定路由
        {
            "alert": "alert_handler",
            "fault": "fault_diagnoser",
            "log": "log_analyzer",
            # ...
        }
    )
    
    return graph.compile()
```

---

## 十二、总结与行动建议

### 12.1 核心结论

ITOps Agent Platform 是一个**工程化程度很高的运维自动化平台**，其最大价值在于：

1. **完整的告警处理闭环**：Webhook 接入 → 降噪 → 决策 → 执行 → 知识沉淀
2. **统一的告警处理引擎（AlertProcessor）**：策略驱动的决策逻辑非常成熟
3. **KnowledgeEngine 统一知识引擎**：合并多来源知识，自动去重，反馈循环
4. **Coordinator-Specialist 多 Agent 模式**：LLM 驱动任务分解 + 回退策略
5. **HITL 审批机制**：execution_mode='approval' + waiting_approval 状态机

### 12.2 对 TDSF-Linux 的核心启示

| 启示 | 我们的优势 | 我们的不足 | 行动 |
|---|---|---|---|
| 知识库反馈循环 | ChromaDB 向量检索更强 | 缺少结构化 solutions 字段 | 补充 KnowledgeSolutions 结构 |
| 策略决策引擎 | 有 LangGraph 灵活编排 | 缺少策略分级决策 | 实现 StrategyEngine |
| HITL 审批 | 有可信决策理念 | 缺少状态机实现 | 实现 DecisionStatus 状态机 |
| 故障模式库 | 有 Drain3 模板提取 | 缺少模式-模板关联 | 建立 fault_patterns 映射表 |
| 置信度计算 | 有证据链 | 缺少量化算法 | 实现 calculate_confidence |

### 12.3 优先级行动清单

| 优先级 | 任务 | 预估工时 | 价值 |
|---|---|---|---|
| P0 | 设计决策库 Schema（含 evidence, risk_level, rollback） | 4h | 基础 |
| P0 | 实现 DecisionEngine.recommend（ChromaDB 版） | 8h | 核心 |
| P1 | 实现 StrategyEngine 策略决策（参考 AlertProcessor） | 6h | 核心 |
| P1 | 实现 HITL 审批状态机（DecisionStatus） | 6h | 差异化 |
| P2 | 建立故障模式库（9 种 + Drain3 模板关联） | 8h | 增强 |
| P2 | 实现 calculate_confidence 量化算法 | 4h | 增强 |
| P3 | Coordinator 模式映射到 LangGraph | 12h | 架构 |

### 12.4 差异化坚守

在借鉴过程中，**必须坚守 TDSF-Linux 的三大差异化**：

1. **证据可核验** — 不学他们纯关键词，要用 Drain3 + 证据链
2. **风险可感知** — 不学他们纯 confidence，要加 risk_level + risk_score
3. **经验可沉淀** — 学他们的 KnowledgeEngine，但用 ChromaDB 做得更好

> **底线**：借鉴工程实践，不借鉴技术栈；借鉴设计模式，不借鉴实现细节；借鉴闭环思想，坚守可信定位。

---

## 附录 A：关键文件路径索引

| 文件 | 路径 | 大小 | 价值 |
|---|---|---|---|
| serviceRegistry.ts | backend/src/serviceRegistry.ts | 10KB | ⭐⭐⭐ DI 组装层 |
| serviceContainer.ts | backend/src/core/serviceContainer.ts | 7KB | ⭐⭐ DI 容器 |
| Coordinator.ts | backend/src/modules/ai/services/multiAgent/Coordinator.ts | 16KB | ⭐⭐⭐ Agent 协调者 |
| Specialists.ts | backend/src/modules/ai/services/multiAgent/Specialists.ts | 10.6KB | ⭐⭐ 11 个专家 |
| KnowledgeEngine.ts | backend/src/modules/ai/services/KnowledgeEngine.ts | 13KB | ⭐⭐⭐ 知识引擎 |
| localRuleEngine.ts | backend/src/modules/ai/services/rca/localRuleEngine.ts | 18.8KB | ⭐⭐ 根因规则 |
| AlertProcessor.ts | backend/src/modules/alerts/services/AlertProcessor.ts | 9.7KB | ⭐⭐⭐ 告警处理 |
| WorkflowEngine.ts | backend/src/modules/workflow/services/WorkflowEngine.ts | 11KB | ⭐⭐ 工作流引擎 |
| alertAutoResponseService.ts | backend/src/modules/alerts/services/alertAutoResponse/ | 18.9KB | ⭐⭐ AARS 核心 |

## 附录 B：调研信息来源

- GitHub 仓库主页：https://github.com/qinshihu/itops-agent-platform
- README.md（通过仓库主页获取）
- backend/package.json（依赖分析）
- backend/src/ 目录结构（GitHub API）
- 关键源码文件（raw.githubusercontent.com）：
  - serviceRegistry.ts, Coordinator.ts, Specialists.ts
  - KnowledgeEngine.ts, localRuleEngine.ts, AlertProcessor.ts
  - WorkflowEngine.ts

---

**报告完成日期**：2026-07-10
**报告作者**：TDSF-Linux 项目调研
**下一步**：基于本报告的"优先级行动清单"，在 TDSF-Linux 项目中实施 P0/P1 任务
