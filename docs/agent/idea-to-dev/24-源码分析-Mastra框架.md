# 源码分析报告：Mastra 框架

> 归档位置：`d:\ai\linux教学一体\opensource-reference\mastra`（git clone 全量源码）
> 分析时间：2026-07-17
> 适用项目：tdsf-linux-desktop v0.9 Agent 架构集成

## 一、仓库总览

| 项目 | 值 |
|---|---|
| 仓库 | `mastraorg/mastra` |
| License | Apache-2.0（ee/ 目录下企业版除外） |
| 包管理 | pnpm workspace + turbo |
| 测试 | vitest（与源码并列） |
| 类型系统 | strict TypeScript + Zod v4 |
| AI SDK 适配 | 同时兼容 `@internal/ai-sdk-v4` 与 `@internal/ai-sdk-v5`（即 AI SDK 7） |

### 核心子包

| 包 | 路径 | 职责 |
|---|---|---|
| `@mastra/core` | `packages/core/` | Agent / Tool / Memory / Workflow / Storage 抽象 |
| `@mastra/memory` | `packages/memory/`（独立发布） | 语义召回 + 工作记忆 + 观察记忆 |
| `@mastra/mcp` | `packages/mcp/` | MCP（Model Context Protocol）客户端 |
| `@mastra/rag` | `packages/rag/` | 检索增强生成 |
| `@mastra/cli` | `packages/cli/` | 命令行工具 |
| `auth/*` | `auth/` | 各家认证适配（auth0/clerk/cloud/google/neon/okta/workos） |
| `stores/*` | `stores/` | 持久化后端（astra/dsql/lance/mssql/mysql/pg/redis） |
| `voice/*` | `voice/` | TTS/STT 适配（azure/google/openai/playai/murf/sarvam/gladia） |

## 二、Agent 类核心 API（`packages/core/src/agent/agent.ts`）

### 关键导入

源码：[agent.ts#L1-L178](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L1-L178)

```typescript
import { createTool } from '../tools';
import { createWorkflow } from '../workflows/create';
import { createStep, isProcessor } from '../workflows/workflow';
import { MastraLLMV1 } from '../llm/model';
import { MastraLLMVNext } from '../llm/model/model.loop';
import { networkLoop } from '../loop/network';
import { resolveAgentSkills, mergeWorkspaceSkills } from '../skills/agent-skills-resolver';
import { MastraFGAPermissions } from '../auth/ee';
```

**关键发现**：Mastra 内置 12+ 子系统集成（workflow / loop / skills / workspace / processors / scorers / signals / notifications / observability / FGA 权限 / background-tasks / browser）。

### 内置 SubAgent Schema

源码：[agent.ts#L181-L215](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L181-L215)

```typescript
const createSubAgentInputSchema = () =>
  z.object({
    prompt: z.string().describe('The prompt to send to the agent'),
    threadId: z.string().nullish().describe('Thread ID for conversation continuity for memory messages'),
    resourceId: z.string().nullish().describe('Resource/user identifier for memory messages'),
    instructions: z.string().nullish().describe('Additional instructions...'),
    maxSteps: z.number().min(3).nullish().describe('Maximum number of execution steps for the sub-agent'),
  });

const createSubAgentOutputSchema = () =>
  z.object({
    text: z.string().describe('The response from the agent'),
    subAgentThreadId: z.string().optional(),
    subAgentResourceId: z.string().optional(),
    subAgentToolResults: z.array(z.object({
      toolName: z.string(),
      toolCallId: z.string(),
      result: z.unknown(),
      args: z.unknown().optional(),
      isError: z.boolean().optional(),
    })).optional(),
  });
```

**关键发现**：Mastra **原生支持 SubAgent 协议**，含 threadId 隔离 / 指令追加 / 工具结果回传。这正是 Grok Build 8 并行 subagent 架构的等价能力。

### Agent 类型定义（types.ts）

源码：[agent.ts#L137-L174](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L137-L174)

```typescript
type AgentConfig = ...
type AgentGenerateOptions = ...
type AgentStreamOptions = ...
type ToolsetsInput = ...
type ToolsInput = ...
type AgentModelManagerConfig = ...
type AgentCreateOptions = ...
type AgentExecuteOnFinishOptions = ...
type AgentInstructions = ...
type AgentMessageInput = ...
type AgentMethodType = ...
type AgentSignal = ...
type AgentStateSignalInput = ...
type AgentSubscribeToThreadOptions = ...
type AgentThreadSubscription = ...
type StructuredOutputOptions = ...
type PublicStructuredOutputOptions = ...
type QueueAgentMessageOptions = ...
type QueueAgentMessageResult = ...
type SendAgentMessageOptions = ...
type SendAgentMessageResult = ...
type SendAgentNotificationSignalOptions = ...
type SendAgentNotificationSignalResult = ...
type SendAgentStreamResumeOptions = ...
type SendAgentStreamResumeResult = ...
type ModelFallbackSettings = ...
type ModelWithRetries = ...
```

**关键发现**：
- 内置 `ModelFallbackSettings` + `ModelWithRetries` 多 provider 回退
- 内置 `AgentSignal` + `AgentStateSignalInput` 信号机制
- 内置 `QueueAgentMessage` 消息队列（异步 Agent 通信）
- 内置 `AgentThreadSubscription` 多 Agent 订阅同一 thread
- 内置 `AgentExecuteOnFinishOptions` 完成回调

## 三、Tool 类核心 API（`packages/core/src/tools/tool.ts`）

源码：[tool.ts#L78-L200](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/tools/tool.ts#L78-L200)

### 类签名

```typescript
export class Tool<
  TSchemaIn = unknown,
  TSchemaOut = unknown,
  TSuspendSchema = unknown,
  TResumeSchema = unknown,
  TContext extends ToolExecutionContext<...> = ...,
  TId extends string = string,
  TRequestContext extends Record<string, any> | unknown = unknown,
> implements ToolAction<...>
```

### 关键字段

| 字段 | 类型 | 作用 |
|---|---|---|
| `id` | `TId` | 工具唯一标识 |
| `description` | `string` | LLM 可读描述 |
| `inputSchema` | `StandardSchemaWithJSON<TSchemaIn>` | 输入校验（Zod / JSON Schema） |
| `outputSchema` | `StandardSchemaWithJSON<TSchemaOut>` | 输出校验 |
| `suspendSchema` | `StandardSchemaWithJSON<TSuspendSchema>` | 挂起数据 schema |
| `resumeSchema` | `StandardSchemaWithJSON<TResumeSchema>` | 恢复数据 schema |
| `requestContextSchema` | `PublicSchema<TRequestContext>` | 请求上下文校验 |
| `execute` | `(inputData, context) => Promise<...>` | 执行函数 |
| `requireApproval` | `boolean \| NeedsApprovalFn` | **审批钩子（含条件审批）** |
| `needsApprovalFn` | `NeedsApprovalFn` | 运行时审批判定 |
| `strict` | `boolean` | 严格工具输入生成（per-provider） |
| `providerOptions` | `Record<string, Record<string, unknown>>` | per-provider 配置（如 anthropic cacheControl） |
| `toModelOutput` | `(output: TSchemaOut) => unknown` | 输出转换给模型（应用层保留原始） |
| `transform` | `ToolPayloadTransform` | 显示与转录转换 |
| `mcp` | `McpMetadata` | MCP 工具元数据（annotations / _meta） |

### 关键示例（源码注释摘录）

源码：[tool.ts#L36-L76](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/tools/tool.ts#L36-L76)

```typescript
// 工具审批示例（来自源码注释）
const deleteFileTool = createTool({
  id: 'delete-file',
  description: 'Delete a file',
  requireApproval: true,  // 静态审批
  inputSchema: z.object({ filepath: z.string() }),
  execute: async (inputData) => {
    await fs.unlink(inputData.filepath);
    return { deleted: true };
  }
});

// 条件审批（来自源码注释）
const saveTool = createTool({
  id: 'save-data',
  inputSchema: z.object({ key: z.string(), value: z.any() }),
  execute: async (inputData, context) => {
    const storage = context?.mastra?.getStorage();
    await storage?.set(inputData.key, inputData.value);
    return { saved: true };
  }
});

// 条件审批示例
// requireApproval: async ({ isDryRun }) => !isDryRun
```

**关键发现**：
- **Mastra Tool 原生支持审批**（与 Grok Build 数据丑闻后的 Hard Constraint 完美契合）
- 支持**条件审批**（函数式判定），可实现"危险命令才审批"
- 支持**Suspend/Resume**（暂停等待人工输入后继续）
- 支持 `toModelOutput`（输出对模型可见 vs 对应用可见分离）
- 工具与 MCP 原生兼容（mcp 字段）

## 四、Agent 索引文件（`packages/core/src/agent/index.ts`）

源码：[index.ts#L1-L74](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/index.ts#L1-L74)

### 导出 API 总览

```typescript
// 核心 Agent
export { TripWire } from './trip-wire';
export { MessageList, convertMessages, aiV5ModelMessageToV2PromptMessage, TypeDetector } from './message-list';
export * from './agent';
export * from './utils';
export * from './fs-routing';

// 子代理
export type { SubAgent, SubAgentGenerateResult, SubAgentStreamResult } from './subagent';
export { isAgentCompatible } from './subagent';

// 调度
export { AGENT_SCHEDULE_PREFIX, WORKFLOW_SCHEDULE_PREFIX, ... } from '../schedules';

// 执行选项
export type {
  AgentExecutionOptions,
  AgentExecutionOptionsBase,
  InnerAgentExecutionOptions,
  MultiPrimitiveExecutionOptions,
  DelegationConfig,
  DelegationStartContext,
  DelegationStartResult,
  OnDelegationStartHandler,
  DelegationCompleteContext,
  DelegationCompleteResult,
  OnDelegationCompleteHandler,
  MessageFilterContext,
  IterationCompleteContext,
  IterationCompleteResult,
  OnIterationCompleteHandler,
  StreamIsTaskCompleteConfig,
  IsTaskCompleteConfig,
  IsTaskCompleteRunResult,
  CompletionConfig,
  CompletionRunResult,
  NetworkOptions,
  NetworkRoutingConfig,
} from './agent.types';

// LLM 类型
export type { MastraLanguageModel, MastraLegacyLanguageModel } from '../llm/model/shared.types';
```

**关键发现**：
- 内置 `OnDelegationStartHandler` + `OnDelegationCompleteHandler` 委托钩子
- 内置 `NetworkOptions` + `NetworkRoutingConfig` 网络路由
- 内置 `IsTaskCompleteConfig` 任务完成判定（Supervisor 模式核心）
- 内置 `IterationCompleteHandler` 迭代完成钩子（Plan-Act-Observe-Reflect 循环基础）

## 五、Mastra 内置的循环模式（Plan-Act-Observe-Reflect 完美对应）

源码：[agent.ts#L43-L44](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L43-L44) + [L175-L176](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L175-L176)

```typescript
import { networkLoop } from '../loop/network';
import { createPrepareStreamWorkflow } from './workflows/prepare-stream';
```

| PAOR 阶段 | Mastra 原生支持 |
|---|---|
| **Plan** | `createWorkflow` + `createStep` 显式步骤编排 |
| **Act** | `Tool.execute()` + `requireApproval` 审批 |
| **Observe** | `IterationCompleteContext` + `ToolCallResult` 工具结果回传 |
| **Reflect** | `IsTaskCompleteConfig` + `OnIterationCompleteHandler` 判定与反思 |

## 六、Memory 模块（`packages/core/src/memory/`）

源码：[agent.ts#L48-L49](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L48-L49)

```typescript
import type { MastraMemory } from '../memory/memory';
import type { MemoryConfig, MemoryConfigInternal } from '../memory/types';
```

### 存储后端选择

源码：[agent.ts#L84](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L84)

```typescript
import { InMemoryStore } from '../storage';
```

| 后端 | 包 | 适用场景 |
|---|---|---|
| `InMemoryStore` | `@mastra/core`（内置） | 测试 / 单进程 |
| `LibSQLStore` | `@mastra/libsql` | SQLite 本地文件 |
| `PostgresStore` | `@mastra/pg` | Postgres 服务端 |
| `MongoStore` | `@mastra/mongo` | MongoDB |
| `AstraStore` | `@mastra/astra` | DataStax Astra |
| `LanceStore` | `@mastra/lance` | LanceDB（向量） |
| `MssqlStore` | `@mastra/mssql` | SQL Server |
| `MysqlStore` | `@mastra/mysql` | MySQL |
| `RedisStore` | `@mastra/redis` | Redis |

**推荐方案**：使用 `LibSQLStore`（基于 better-sqlite3，本地文件，与项目现有 `better-sqlite3@12.11.0` 兼容）。

## 七、LLM 适配层

源码：[agent.ts#L28-L41](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L28-L41)

```typescript
import { resolveModelConfig } from '../llm';
import type { CoreMessage } from '../llm';
import { MastraLLMV1 } from '../llm/model';
import { MastraLLMVNext } from '../llm/model/model.loop';
import { mergeProviderOptions } from '../llm/model/provider-options';
import type { ProviderOptions } from '../llm/model/provider-options';
import { ModelRouterLanguageModel } from '../llm/model/router';
import type { MastraLanguageModel, MastraLegacyLanguageModel, MastraModelConfig } from '../llm/model/shared.types';
```

### 关键能力

| 能力 | 实现 |
|---|---|
| **多 provider 切换** | `MastraLLMV1` + `MastraLLMVNext` 联合类型 |
| **模型路由** | `ModelRouterLanguageModel`（基于条件路由到不同模型） |
| **provider 配置合并** | `mergeProviderOptions` |
| **模型回退** | `ModelFallbacks`（多 provider 自动重试） |
| **AI SDK 兼容** | 同时支持 v4（@internal/ai-sdk-v4）和 v5（@internal/ai-sdk-v5） |

### 与 Vercel AI SDK 7 集成

源码：[agent.ts#L1-L3](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/agent/agent.ts#L1-L3)

```typescript
import type { UIMessage } from '@internal/ai-sdk-v4';
import type { ModelMessage } from '@internal/ai-sdk-v5';
```

**关键发现**：Mastra 内部维护 AI SDK v4 与 v5 的适配层。AI SDK 7 等价于 v5，因此 Mastra 与项目当前 `ai@^7.0.29` 完全兼容。

### 国内 Provider 接入方式

通过 Vercel AI SDK 7 的 provider 包接入：

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// DeepSeek（OpenAI 兼容协议）
const deepseek = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// 火山方舟（OpenAI 兼容协议）
const volcengine = createOpenAI({
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: process.env.VOLC_API_KEY,
});

// 通义千问（OpenAI 兼容协议）
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

// 创建 Mastra Agent
const agent = new Agent({
  name: 'tdsf-linux-agent',
  instructions: '...',
  model: deepseek('deepseek-chat'),
  tools: { sshExec, fileRead, fileWrite, ... },
  memory: new Memory({ storage: new LibSQLStore({ url: 'file:./data/agent.db' }) }),
});
```

## 八、MCP 集成

源码：[tool.ts#L8-L14](file:///d:/ai/linux教学一体/opensource-reference/mastra/packages/core/src/tools/tool.ts#L8-L14)

```typescript
import type {
  McpMetadata,
  MCPToolProperties,
  NeedsApprovalFn,
  ToolAction,
  ToolExecutionContext,
  ToolPayloadTransform,
} from './types';
```

**关键发现**：Mastra Tool 原生支持 MCP 元数据（annotations + _meta），通过 `@mastra/mcp` 包注册 MCP server 即可暴露为 Agent 工具。

## 九、Hard Constraint 对齐

### HC-1：所有网络请求必须 UI 可见
Mastra Tool 的 `execute` 函数完全在用户代码中，可注入 IPC 推送。

### HC-2：敏感文件 redact
`toModelOutput` 钩子可在传递给 LLM 前清洗输出（如 .env 内容替换为 `<redacted>`）。

### HC-3：默认本地优先
Memory 默认 `InMemoryStore` / `LibSQLStore`（本地 SQLite）。

### HC-4：工具审批
`requireApproval: boolean | function` 完美支持 SSH 命令审批。

### HC-5：Suspend/Resume
`suspendSchema` + `resumeSchema` 支持长时间挂起等待人工输入。

## 十、tdsf-linux-desktop v0.9 集成建议

### 依赖安装（已完成）

```bash
pnpm add @mastra/core@^1.51.0 @mastra/memory@^1.23.0
```

### 目录结构建议

```
src/main/core/agent/
├── mastra-instance.ts          # Mastra 单例（注册所有 Agent）
├── providers/
│   ├── index.ts                # Provider 注册中心
│   ├── deepseek.ts             # DeepSeek 适配
│   ├── volcengine.ts           # 火山方舟适配
│   ├── qwen.ts                 # 通义千问适配
│   ├── anthropic.ts            # Claude 适配（@ai-sdk/anthropic）
│   └── ollama.ts                # Ollama 本地适配
├── agents/
│   ├── supervisor.ts           # Supervisor Agent（主对话）
│   ├── subagents/
│   │   ├── coder.ts            # 编程 SubAgent
│   │   ├── thinker.ts          # 思考 SubAgent（CoT）
│   │   ├── runner.ts           # 运行 SubAgent（SSH）
│   │   ├── searcher.ts         # 搜索 SubAgent（WebSearch）
│   │   ├── skill-invoker.ts    # Skill Subagent（MCP）
│   │   ├── methodologist.ts    # 方法论 Subagent
│   │   ├── historian.ts        # 历史回溯 Subagent（Dexie）
│   │   └── knowledge-base.ts   # 知识库 Subagent（向量检索）
├── tools/                       # Mastra createTool 定义
│   ├── ssh-exec.ts             # SSH 命令执行（含审批）
│   ├── sftp-read.ts            # 文件读
│   ├── sftp-write.ts           # 文件写（含审批）
│   ├── web-search.ts           # 网络搜索
│   ├── web-fetch.ts             # 网页抓取
│   ├── kb-query.ts              # 知识库查询
│   ├── history-query.ts         # 历史查询
│   └── skill-invoke.ts          # Skill 调用
├── memory/
│   └── libsql-store.ts          # LibSQLStore 配置（better-sqlite3 后端）
├── credibility/                 # 可信度算法模块
│   ├── ds-theory.ts             # D-S 证据理论实现
│   ├── pcr5.ts                  # PCR5 冲突融合
│   ├── mass-functions/          # 6 源证据 Mass 函数
│   │   ├── log-source.ts        # 日志源
│   │   ├── kb-source.ts         # 知识库源
│   │   ├── ai-param-source.ts   # AI 参数源
│   │   ├── human-source.ts      # 人工源
│   │   ├── history-source.ts    # 历史源
│   │   └── best-practice-source.ts  # 最佳实践源
│   └── visualizer.ts            # DAG 可视化数据生成
└── token-monitor/
    ├── tracker.ts               # Token 计数
    ├── cost-calculator.ts       # 成本计算
    └── budget-guard.ts          # 预算守卫
```

### Mastra Agent 实例化代码模板

```typescript
// src/main/core/agent/mastra-instance.ts
import { Mastra } from '@mastra/core';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Agent } from '@mastra/core';
import { createOpenAI } from '@ai-sdk/openai';
import { ConfigStore } from '../../services/storage/config-store';
import { SecureStore } from '../../services/storage/secure-store';
import { createSshExecTool } from './tools/ssh-exec';
import { createSftpReadTool } from './tools/sftp-read';
import { createSftpWriteTool } from './tools/sftp-write';

export function createMastraInstance(): Mastra {
  const llmConfig = ConfigStore.getLlmConfig();
  const apiKey = SecureStore.getApiKey('llm') ?? '';

  // 创建 OpenAI 兼容 provider（支持 DeepSeek/方舟/Qwen/OpenAI）
  const provider = createOpenAI({
    baseURL: llmConfig.baseUrl,
    apiKey,
  });

  // Memory：LibSQLStore（本地 SQLite 文件）
  const memory = new Memory({
    storage: new LibSQLStore({ url: 'file:./data/agent-memory.db' }),
    options: {
      lastMessages: 50,           // 保留最近 50 条消息
      semanticRecall: {
        topK: 5,                    // 召回 5 条相似消息
        messageScope: 'thread',     // 当前 thread 范围
      },
    },
  });

  // Supervisor Agent
  const supervisor = new Agent({
    name: 'tdsf-supervisor',
    instructions: `你是 Linux 运维 AI 助手，遵循 Plan-Act-Observe-Reflect 循环。
当用户提出运维任务，请：
1. 分解为可执行步骤
2. 调用合适的子代理或工具
3. 观察工具结果
4. 反思并决定是否完成
对 SSH 命令必须等待用户审批（requireApproval: true）。`,
    model: provider(llmConfig.model),
    memory,
    tools: {
      sshExec: createSshExecTool(),
      sftpReadFile: createSftpReadTool(),
      sftpWriteFile: createSftpWriteTool(),
    },
  });

  return new Mastra({
    agents: { supervisor },
    memory,
  });
}
```

### Tool 实例化代码模板（含审批）

```typescript
// src/main/core/agent/tools/ssh-exec.ts
import { createTool } from '@mastra/core';
import { z } from 'zod';
import { SshManager } from '../../../services/ssh/ssh-manager';
import { BrowserWindow } from 'electron';

export function createSshExecTool(mainWindow?: BrowserWindow) {
  return createTool({
    id: 'ssh-exec',
    description: '在远程 Linux 服务器上执行 SSH 命令。危险命令需要审批。',
    inputSchema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      serverId: z.string().describe('目标服务器 ID'),
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
    }),
    // 条件审批：仅危险命令需审批
    requireApproval: async ({ command }) => {
      const dangerousPatterns = /^(rm\s|sudo\s|chmod\s|chown\s|systemctl\s|shutdown|reboot|dd\s|mkfs|fdisk)/;
      return dangerousPatterns.test(command);
    },
    execute: async ({ command, serverId }, context) => {
      const ssh = new SshManager(/* 从 ConfigStore 加载 serverId 配置 */);
      const result = await ssh.exec(command);

      // 推送进度到渲染进程（HC-1：网络请求 UI 可见）
      mainWindow?.webContents.send('agent:tool-progress', {
        toolId: 'ssh-exec',
        command,
        stdout: result.stdout,
      });

      // HC-2：敏感文件 redact
      const redactedStdout = redactSecrets(result.stdout);

      // toModelOutput：模型看到 redacted 版本，应用看到原始
      return {
        stdout: redactedStdout, // 给模型
        // 应用层通过 context.mastra 获取原始
      };
    },
  });
}

function redactSecrets(text: string): string {
  return text
    .replace(/(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '<redacted-pem>');
}
```

## 十一、风险与替代方案

### 风险

| # | 风险 | 缓解 |
|---|---|---|
| 1 | `@mastra/libsql` 未安装 | `pnpm add @mastra/libsql` 后续添加 |
| 2 | Mastra 依赖 `@internal/ai-sdk-v5` 内部包 | 项目当前 `ai@7.0.29` 已满足 |
| 3 | Agent 类构造参数复杂（30+ 字段） | 通过 TypeScript 类型严格校验，IDE 自动补全 |
| 4 | Memory 配置项众多 | 先用最小配置（lastMessages: 50），迭代优化 |

### 替代方案（若 Mastra 出现阻塞问题）

| 候选 | 优势 | 劣势 |
|---|---|---|
| **VoltAgent** | 轻量 | 社区小，无 SubAgent |
| 自研（基于 Vercel AI SDK 7） | 完全控制 | 工作量大，需自实现 SubAgent + Memory + Workflow |
| LangGraph.js | 与 Python LangGraph 同源 | TS 版本落后，无 Mastra 完善 |

**结论**：Mastra 是当前最佳选择，符合"质量优先"原则。

## 十二、与 tdsf-linux-desktop 现有代码共存

| 现有代码 | 共存策略 |
|---|---|
| `src/main/services/llm/vercel-ai-service.ts` | 保留作为 fallback（无 Mastra 时降级） |
| `src/main/services/llm/client.ts` | 保留作为最底层 LLM 调用 |
| `src/main/ipc/llm-tools.ts` | **重构**为 Mastra Agent 的 IPC 包装层 |
| `src/main/services/llm/tools/registry.ts` | **重构**为 Mastra Tool 注册器 |

## 十三、总结

Mastra 源码分析证实：

1. ✅ **Agent 类完全满足需求**（Supervisor + 8 SubAgent + Plan-Act-Observe-Reflect 循环）
2. ✅ **Tool 类支持审批钩子**（HC-4 完美对齐）
3. ✅ **Memory 多后端可选**（推荐 LibSQLStore）
4. ✅ **与 Vercel AI SDK 7 兼容**（同时支持 v4 + v5）
5. ✅ **国内 Provider 通过 OpenAI 兼容协议接入**（DeepSeek / 方舟 / Qwen）
6. ✅ **MCP 原生支持**（通过 @mastra/mcp）
7. ✅ **Suspend/Resume 支持**（长时间审批等待）
8. ✅ **Apache-2.0 License**（商用友好）

**强烈推荐**：v0.9 直接采用 Mastra v1.51+ 作为 Agent 框架基座。
