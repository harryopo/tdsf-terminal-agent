# 源码分析报告：Continue.dev（多模型调度与代码库索引，Apache-2.0）

> **分析目标**：为 `tdsf-linux-desktop`（Electron + React + TS + Ant Design 5 的 Linux 运维 AI 桌面助手）v0.9.2 Agent 架构设计提供借鉴
> **分析路径**：`d:\ai\linux教学一体\opensource-reference\continue-dev\`
> **License**：Apache-2.0 © 2023-2026
> **仓库状态**：已停止维护，read-only（README.md 明确声明）
> **分析日期**：2026-07-19
> **分析师**：tdsf-linux-desktop 资深源码分析师
> **分析原则**：真实阅读源码、引用具体文件路径、借鉴建议具体、诚实标注未读部分、不修改源码

---

## 0. 摘要

Continue.dev 是一个 Apache-2.0 协议的 AI 编码助手开源项目，支持 **CLI / VS Code / JetBrains 三端**，定位为 "AI coding assistant for any LLM, any IDE, any context"。

### 0.1 项目硬实力

| 维度 | 数据 |
|------|------|
| 协议 | Apache-2.0（商业友好，可闭源衍生） |
| Provider 数量 | **60+** LLM 适配器（Anthropic / OpenAI / Bedrock / Gemini / VertexAI / Ollama / LMStudio / Cloudflare / Groq / Mistral / Cohere / Deepseek / xAI / SambaNova / Inception / Moonshot / Novita / OVHCloud / Watsonx / OpenRouter / zAI 等） |
| 模型角色 | 8 类（chat / edit / apply / autocomplete / embed / rerank / summarizer / subagent） |
| IDE 适配 | VS Code + JetBrains + CLI（TUI）+ Binary（pkg 打包） |
| 代码索引 | LanceDB 向量库 + SQLite 缓存 + tree-sitter 代码切片 |
| IPC 协议 | stdin/stdout JSON + `\r\n` 分隔（IpcMessenger）+ TCP server 3000 端口（TcpMessenger） |
| 配置系统 | YAML 配置（unrollAssistant + validateConfigYaml）+ GlobalContext + RegistryClient |

### 0.2 对 tdsf-linux-desktop 的核心借鉴价值

- **P0 借鉴**：BaseLLM 抽象类 + LLMClasses 工厂模式（已落地于本项目的 ClaudeSdkProvider / VercelAiProvider / OpenHandsProvider）
- **P0 借鉴**：AUTODETECT 机制（Ollama 自动检测模型列表，可启发本项目本地优先策略）
- **P0 借鉴**：IpcMessenger 协议设计（stdin/stdout JSON + `\r\n` 分隔 + 半包处理），可借鉴用于 Claude Code CLI 子进程通信
- **P1 借鉴**：CodebaseIndexer 批量索引设计（200 files/batch + IndexLock 防并发 + errorsRegexesToClearIndexesOn 自愈机制）
- **P1 借鉴**：ModelRole 8 类角色 + selectedModels fallback 机制
- **P2 借鉴**：CLI 双击 SIGINT 退出 + unhandledRejection/uncaughtException 全局错误处理

### 0.3 关键风险提示

- **License 兼容性**：Apache-2.0 与本项目（私有 / 商用）兼容，但需在 NOTICE 中声明衍生代码
- **维护状态**：仓库已停止维护（README 明示），不能直接 fork，只能借鉴设计模式
- **技术栈匹配度**：Continue 严重依赖 OpenAI SDK + vectordb + sqlite3，本项目用 Vercel AI SDK + Mastra，需借鉴思想而非代码

---

## 1. 项目概述

### 1.1 项目定位

**Continue.dev** 是一个开源 AI 编码助手，核心理念：

> "Continue is the AI coding assistant for any LLM, any IDE, any context." 
> （Continue 是为任何 LLM、任何 IDE、任何上下文而生的 AI 编码助手）

—— 源自 `d:\ai\linux教学一体\opensource-reference\continue-dev\README.md`

### 1.2 维护状态

README.md 顶部明确声明：

> ⚠️ This repository is no longer actively maintained. It remains available as a read-only archive of the project's history and codebase.
> （本仓库不再积极维护，仅作为项目历史和代码库的只读存档。）

**对本项目的启示**：
- 不能依赖官方持续维护
- 不能直接 fork（无法获取 bug 修复）
- 只能借鉴架构思想与设计模式
- License（Apache-2.0）永久有效，可放心借鉴

### 1.3 License 详情

`d:\ai\linux教学一体\opensource-reference\continue-dev\LICENSE` 完整读取确认：

- **协议类型**：Apache License, Version 2.0
- **版权声明**：© 2023-2026 Continue Devs
- **核心条款**：
  - 允许商业使用、修改、分发、专利授权
  - 要求保留版权声明、专利声明、商标声明
  - 修改后的文件需标注变更说明
  - 不要求衍生作品开源（与 GPL 不同）
- **对 tdsf-linux-desktop 的影响**：
  - ✅ 可在私有项目中借鉴代码
  - ✅ 可在商用项目中借鉴设计
  - ⚠️ 需在 NOTICE 文件中声明使用了 Continue 的设计
  - ⚠️ 不能使用 Continue 的商标（"Continue" 名称、Logo）

### 1.4 三端架构

Continue 提供 3 个主要分发渠道：

1. **CLI（cn 命令）**：基于 commander + Ink/React TUI，文件位于 `extensions/cli/src/`
2. **VS Code 扩展**：基于 vscode extension API，文件位于 `extensions/vscode/`
3. **JetBrains 扩展**：基于 IntelliJ Platform，文件位于 `extensions/intellij/`

所有三端共享 **core** 包（`core/`），core 是框架无关的纯 TypeScript 库。

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\overview.mdx` 确认

### 1.5 binary 二进制分发

`binary/` 目录提供独立可执行文件：

- 使用 **pkg** 打包 Node.js 应用为单文件二进制
- 打包目标：`node18-darwin-arm64`（macOS Apple Silicon）
- 入口：`binary/src/index.ts`
- 通信：stdin/stdout JSON（IpcMessenger）或 TCP server（TcpMessenger）

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\package.json` 确认

---

## 2. 仓库结构

### 2.1 顶层目录

```
continue-dev/
├── core/                    # 框架无关的核心库（最重要）
├── binary/                  # 独立二进制分发
├── extensions/
│   ├── cli/                 # 命令行界面（cn 命令）
│   ├── vscode/             # VS Code 扩展
│   └── intellij/            # JetBrains 扩展
├── docs/                    # 文档（overview.mdx / customize/* / guides/* / cli/*）
├── packages/
│   ├── config-yaml/         # YAML 配置解析（unrollAssistant + validateConfigYaml）
│   ├── openai-adapters/     # OpenAI 协议适配器
│   └── sdk/                 # Hub SDK
├── README.md
├── LICENSE                  # Apache-2.0
├── package.json            # 工作区根配置
└── ...
```

### 2.2 core/ 核心包

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\package.json` 确认：

- **包名**：`@continuedev/core`
- **版本**：`1.1.0`
- **关键依赖**：
  - `@anthropic-ai/sdk`：Anthropic 官方 SDK
  - `@aws-sdk/client-bedrock-runtime`：AWS Bedrock
  - `ollama`：本地模型通信
  - `openai`：OpenAI SDK
  - `vectordb`：LanceDB 向量库
  - `sqlite3`：SQLite 缓存
  - `@xenova/transformers`：本地嵌入模型（onnx）
  - `web-tree-sitter`：代码 AST 解析
  - `lancedb`：向量数据库

### 2.3 core/ 子目录结构

```
core/
├── llm/                     # 多模型适配（BaseLLM + 60+ Provider）
│   ├── index.ts             # BaseLLM 抽象类（1500+ 行）
│   ├── llms/index.ts        # LLMClasses 工厂（60+ 类）
│   ├── autodetect.ts       # 模板/能力自动检测
│   ├── toolSupport.ts      # PROVIDER_TOOL_SUPPORT 大对象
│   ├── countTokens.ts      # Token 计数 + 上下文裁剪
│   ├── streamChat.ts        # llmStreamChat 协议入口
│   └── llms/                # 60+ Provider 实现目录
├── config/                  # 配置系统
│   ├── selectedModels.ts    # selectedModels fallback
│   ├── yaml/
│   │   ├── default.ts       # 默认空 AssistantUnrolled
│   │   ├── loadYaml.ts      # loadConfigYaml + unrollAssistant
│   │   └── models.ts        # AUTODETECT 处理
│   └── ...
├── protocol/                # 通信协议层
│   ├── messenger/index.ts   # IMessenger + InProcessMessenger
│   ├── ide.ts               # ToIdeFromWebviewOrCoreProtocol
│   ├── core.ts              # ToCoreFromIdeOrWebviewProtocol
│   └── ...
├── indexing/                 # 代码库索引（RAG）
│   ├── CodebaseIndexer.ts   # 批量索引（200 files/batch）
│   ├── LanceDbIndex.ts      # LanceDB + SQLite
│   ├── walkDir.ts           # DFSWalker
│   ├── shouldIgnore.ts      # .continueignore
│   └── chunk/
│       └── chunk.ts         # tree-sitter 切片
├── edit/                    # 编辑器集成（lazy apply）
├── tools/                   # 工具系统
│   ├── builtIn.ts           # BuiltInToolNames 枚举
│   ├── definitions/
│   ├── implementations/
│   ├── policies/
│   └── systemMessageTools/
├── context/                 # 上下文构建
├── autocomplete/            # 自动补全
├── nextEdit/                # Next Edit Prediction
├── util/                    # 工具函数
└── data/                    # 数据持久化
```

### 2.4 binary/ 子目录结构

```
binary/
├── src/
│   ├── index.ts             # 入口（process.env.IS_BINARY = "true"）
│   ├── IpcIde.ts            # 极简 IDE 适配（仅 8 行）
│   ├── IpcMessenger.ts      # stdin/stdout + TCP IPC
│   ├── TcpMessenger.ts      # TCP server 3000
│   └── logging.ts           # setupCoreLogging
├── package.json             # pkg 打包配置
└── ...
```

### 2.5 extensions/cli/ 子目录结构

```
extensions/cli/src/
├── index.ts                 # commander 入口（cn + ls/serve/checks/review）
├── config.ts                # createLlmApi + getLlmApi + getApiClient
├── onboarding.ts            # 首次启动引导
├── session.ts               # SessionManager 单例
├── env.ts                   # 环境变量
├── auth/                    # WorkOS 认证
├── commands/                # chat/ls/serve/checks/review
├── flags/                   # flagValidator
├── hooks/                   # 钩子
├── permissions/             # allow/ask/exclude
├── services/                # 服务层
├── stream/                  # 流式响应
├── subagent/                # 子 agent
├── telemetry/               # 遥测
├── tools/                   # CLI 工具实现
├── ui/                      # Ink/React TUI
└── util/                    # logger/apiClient/errorState
```

---

## 3. 架构总览

### 3.1 三端共享 core 的分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  extensions/cli (cn 命令)  extensions/vscode  extensions/intellij  │
└─────────────────────────────────────────────────────────────┘
                          ↓
              ┌───────────────────────┐
              │  core/ (纯 TS 库)    │
              │  - llm (60+ Provider)│
              │  - indexing (RAG)    │
              │  - protocol (IPC)    │
              │  - config (YAML)     │
              │  - tools             │
              └───────────────────────┘
                          ↓
        ┌─────────────────────────────────┐
        │  binary/ (pkg 打包的可执行文件)  │
        │  - IpcMessenger (stdin/stdout) │
        │  - TcpMessenger (port 3000)    │
        └─────────────────────────────────┘
```

### 3.2 通信协议层（protocol/）

Continue 将所有跨进程通信抽象为 `IMessenger` 接口，由 3 种实现：

1. **InProcessMessenger**：同进程内调用（用于测试和单进程模式）
2. **IpcMessenger**：stdin/stdout JSON + `\r\n` 分隔（用于 binary 模式）
3. **TcpMessenger**：TCP server 监听 3000 端口（用于开发模式）

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\messenger\index.ts`

### 3.3 Protocol 接口分层

Continue 定义了两个核心协议接口：

#### 3.3.1 ToIdeFromWebviewOrCoreProtocol

IDE 提供的能力（约 40 个方法）：

- `getIdeInfo` / `getWorkspaceDirs`：IDE 元信息
- `readFile` / `writeFile` / `showLines`：文件操作
- `getBranch` / `listDir` / `getFileStats`：仓库浏览
- `gotoDefinition` / `getDocumentSymbols`：语义查询
- 等等

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\ide.ts`

#### 3.3.2 ToCoreFromIdeOrWebviewProtocol

Core 提供的能力（约 60 个方法），按命名空间分组：

- `history/*`：会话历史
- `config/*`：配置管理
- `context/*`：上下文构建
- `mcp/*`：MCP 服务器
- `autocomplete/*` / `nextEdit/*`：自动补全
- `llm/*`：LLM 调用
- `index/*`：代码索引
- `files/*`：文件管理
- `tools/*`：工具调用

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\core.ts`

### 3.4 对 tdsf-linux-desktop 的启示

Continue 的协议分层设计非常值得借鉴：

1. **将 IDE 能力抽象为接口**：避免 core 直接耦合 IDE API
2. **命名空间分组**：60+ 方法按 `history/*` `config/*` 等分组，可读性强
3. **IMessenger 抽象**：同一份 core 代码可在 InProcess / IPC / TCP 三种通信方式下运行

**对本项目的借鉴**：
- 本项目 IPC 4 步同步铁律（main 定义 → ipc/index.ts 注册 → preload 暴露 → d.ts 类型）可参考 Continue 的命名空间分组
- 本项目 `src/main/ipc/` 目录可借鉴 Continue 的 `ToCoreFromIdeOrWebviewProtocol` 按命名空间拆分文件

---

## 4. 多模型动态调度（Provider 工厂）

### 4.1 BaseLLM 抽象类

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\index.ts`（1500+ 行）是整个多模型系统的核心。

#### 4.1.1 类签名

```typescript
export abstract class BaseLLM implements ILLM {
  static providerName: string;
  static defaultOptions: any;

  abstract get providerName(): string;
  
  // 能力声明（子类可覆盖）
  supportsFim(): boolean         // Fill-in-middle（自动补全）
  supportsImages(): boolean      // 多模态（图像输入）
  supportsCompletions(): boolean // 原生 completion API
  supportsPrefill(): boolean     // Assistant 预填充
  
  // 抽象方法（子类必须实现）
  protected abstract _streamFim(...)
  protected abstract _streamComplete(...)
  protected abstract _streamChat(...)
  protected abstract _complete(...)
  protected abstract _embed(...)
  
  // 具体实现（继承即可用）
  streamChat(...)   // 调用 _streamChat，处理 toolOverrides + usage + citations
  compileChatMessages(...)  // 上下文裁剪
  embed(...)         // 通过 openaiAdapter
  rerank(...)        // 通过 openaiAdapter
  
  // 通用工具
  fetch(...)         // withExponentialBackoff（5 次重试，0.5s 起步）
}
```

#### 4.1.2 streamChat 核心实现

`streamChat` 是 BaseLLM 最重要的方法，它做了以下事情：

1. **委托给 OpenAI adapter**：如果子类没有覆盖 `_streamChat`，则使用 `@continuedev/openai-adapters` 的 `OpenAIAdapter`
2. **应用 toolOverrides**：动态修改 tool 定义（部分模型需要不同的 tool schema）
3. **收集 usage**：累计 `promptTokens` / `completionTokens` / `cachedTokens` / `cacheWriteTokens`
4. **收集 citations**：从流式响应中提取 citation 信息
5. **统一错误处理**：通过 `parseError` 映射 404/401 等错误到友好消息

#### 4.1.3 错误处理（parseError）

`BaseLLM.parseError` 将底层 API 错误映射为用户友好的消息：

- **404 错误**：可能是模型不存在 → 提示 "Model not found"
- **401 错误**：API key 无效 → 提示 "Invalid API key"
- **Ollama 检测**：如果是 Ollama 端点，提示 "Is Ollama running?"
- **Lemonade 检测**：如果是 Lemonade（IBM 本地推理），特殊提示

#### 4.1.4 重试机制

`withExponentialBackoff`：

- 最大重试 5 次
- 起始间隔 0.5 秒
- 指数退避（0.5 → 1 → 2 → 4 → 8）
- 仅对网络错误重试，不重试 4xx 客户端错误

### 4.2 LLMClasses 工厂模式

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\llms\index.ts`：

```typescript
export const LLMClasses = [
  Anthropic, Cohere, CometAPI, // ... 60+ 个类
  zAI,
];

export async function llmFromDescription(
  desc: ModelDescription,
  ...
): Promise<BaseLLM> {
  // 根据 desc.provider 找到对应的类
  // 实例化并返回
}

export function llmFromProviderAndOptions(
  providerName: string,
  options: any,
): ILLM {
  // 直接通过 providerName 找到类
}
```

**60+ Provider 列表**（部分）：

| Provider 类 | providerName | 备注 |
|------------|-------------|------|
| Anthropic | "anthropic" | Claude 系列 |
| OpenAI | "openai" | GPT 系列 |
| Bedrock | "bedrock" | AWS Bedrock |
| Gemini | "gemini" | Google Gemini |
| VertexAI | "vertexai" | Google Vertex AI |
| Ollama | "ollama" | 本地模型 |
| LMStudio | "lmstudio" | 本地模型 |
| Cloudflare | "cloudflare" | Cloudflare Workers AI |
| Groq | "groq" | Groq 推理加速 |
| Mistral | "mistral" | Mistral AI |
| Cohere | "cohere" | Cohere Command |
| Deepseek | "deepseek" | DeepSeek |
| xAI | "xAI" | Grok |
| SambaNova | "sambanova" | SambaNova 推理加速 |
| Inception | "inception" | Inception Labs |
| Moonshot | "moonshot" | Moonshot Kimi |
| Novita | "novita" | Novita AI |
| OVHCloud | "ovhcloud" | OVHcloud AI |
| Watsonx | "watsonx" | IBM Watsonx |
| OpenRouter | "openrouter" | 聚合平台 |
| zAI | "zAI" | 国产 |

### 4.3 AUTODETECT 机制

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\autodetect.ts`：

```typescript
export const PROVIDER_HANDLES_TEMPLATING = [
  "lmstudio", "openai", "anthropic", "bedrock", "gemini", // 30+ 个
];

export const PROVIDER_SUPPORTS_IMAGES = [...];
export const MODEL_SUPPORTS_IMAGES = [/gpt-4o/, /claude-3/, /llava/, /* ... */];

export const PARALLEL_PROVIDERS = [
  "openai", "anthropic", // 支持并发流式
];

export function autodetectTemplateType(modelName: string): string {
  if (modelName.includes("codellama-70b")) return "llama3";
  if (modelName.includes("llama3")) return "llama3";
  if (modelName.includes("llava")) return "llava";
  if (modelName.includes("zephyr")) return "zephyr";
  if (modelName.includes("claude")) return "anthropic";
  if (modelName.includes("codestral")) return "codestral";
  if (modelName.includes("deepseek")) return "deepseek";
  // ...
}

export function modelSupportsReasoning(modelName: string): boolean {
  return /claude/.test(modelName) ||
         /deepseek-r/.test(modelName) ||
         /o-series/.test(modelName) ||
         /codex/.test(modelName) ||
         /magistral/.test(modelName) ||
         /grok-4/.test(modelName);
}

export function modelSupportsNextEdit(modelName: string): boolean {
  return /MERCURY_CODER/.test(modelName) ||
         /INSTINCT/.test(modelName);
}
```

### 4.4 Ollama AUTODETECT（本地优先关键）

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\yaml\models.ts`：

```typescript
export async function llmsFromModelConfig(
  models: ModelConfig[],
  ...
): Promise<BaseLLM[]> {
  const llms: BaseLLM[] = [];
  
  for (const modelConfig of models) {
    if (modelConfig.model === "AUTODETECT") {
      // Ollama 自动检测
      const models = await listModels(modelConfig);
      for (const modelName of models) {
        const llm = modelConfigToBaseLLM(modelConfig, modelName);
        llm.isFromAutoDetect = true;
        llms.push(llm);
      }
    } else {
      const llm = modelConfigToBaseLLM(modelConfig, modelConfig.model);
      llms.push(llm);
    }
  }
  
  return llms;
}
```

**关键设计**：
- 当 YAML 配置中 `model: AUTODETECT` 时，调用 `listModels` 列出该 provider 所有可用模型
- 每个检测到的模型创建一个独立的 BaseLLM 实例
- 标记 `isFromAutoDetect = true`，便于后续 UI 区分

### 4.5 PROVIDER_TOOL_SUPPORT（工具调用能力）

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\toolSupport.ts`：

```typescript
export const PROVIDER_TOOL_SUPPORT = {
  anthropic: ["claude-3-7-sonnet", "claude-3-5-haiku", /* ... */],
  azure: ["gpt-4o", "gpt-4-turbo", /* ... */],
  openai: ["gpt-4o", "gpt-4-turbo", "o1", "o3", /* ... */],
  cohere: ["command-r-plus", "command-r"],
  gemini: ["gemini-1.5-pro", "gemini-1.5-flash", /* ... */],
  vertexai: ["gemini-1.5-pro", /* ... */],
  xAI: ["grok-3", "grok-4"],
  bedrock: ["anthropic.claude-3", /* ... */],
  mistral: ["mistral-large", /* ... */],
  ollama: ["llama3.1", "qwen2.5", /* ... */],
  lmstudio: ["*"],  // 通配符
  sambanova: ["Meta-Llama-3.1", /* ... */],
  inception: ["Mercury_Coder"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  watsonx: ["llama-3", "mistral-large"],
  openrouter: ["*"],
  clawrouter: ["*"],
  zAI: ["*"],
  moonshot: ["moonshot-v1-8k", /* ... */],
  novita: ["*"],
  ovhcloud: ["*"],
};

export function isRecommendedAgentModel(modelName: string): boolean {
  return /claude-3-5-sonnet/.test(modelName) ||
         /claude-3-7/.test(modelName) ||
         /gpt-4o/.test(modelName) ||
         /deepseek-r/.test(modelName) ||
         /gemini-2/.test(modelName);
}

export function modelSupportsNativeTools(modelName: string): boolean {
  // 检查是否在 PROVIDER_TOOL_SUPPORT 的任意 provider 列表中
  // ...
}
```

### 4.6 对 tdsf-linux-desktop 的借鉴

#### 4.6.1 P0 借鉴：BaseLLM 抽象类设计

**当前状态**：本项目已有 `ClaudeSdkProvider` / `VercelAiProvider` / `OpenHandsProvider`，但缺少统一的抽象类。

**借鉴方案**：
- 创建 `src/main/core/llm/BaseProvider.ts`，定义抽象类：
  ```typescript
  export abstract class BaseProvider {
    abstract providerName: string;
    abstract supportsTools(): boolean;
    abstract supportsImages(): boolean;
    abstract supportsStreaming(): boolean;
    abstract streamChat(...): AsyncGenerator<ChatChunk>;
    abstract embed(...): Promise<number[]>;
  }
  ```
- 让 `ClaudeSdkProvider` / `VercelAiProvider` / `OpenHandsProvider` 都继承 `BaseProvider`
- 统一错误处理（`parseError`）+ 重试机制（`withExponentialBackoff`）

#### 4.6.2 P0 借鉴：AUTODETECT 机制

**当前状态**：本项目默认 Ollama，但用户需要手动配置每个模型。

**借鉴方案**：
- 在 `provider:setDefault` 时，如果检测到 Ollama，自动调用 `http://localhost:11434/api/tags` 列出所有模型
- 在 Provider 选择 UI 中标记 `isFromAutoDetect = true` 的模型
- 默认选中第一个 reasoning 模型（如 qwen2.5-coder）

#### 4.6.3 P1 借鉴：PROVIDER_TOOL_SUPPORT 表

**当前状态**：本项目没有工具调用能力的运行时检测。

**借鉴方案**：
- 创建 `src/main/core/llm/toolSupport.ts`，定义支持工具调用的模型列表
- 在 `sandbox:execute` 时，如果模型不支持工具调用，降级为纯文本对话模式

---

## 5. 代码库索引（RAG）

### 5.1 CodebaseIndexer 批量索引

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\CodebaseIndexer.ts`（870+ 行）：

```typescript
export class CodebaseIndexer {
  private static filesPerBatch = 200;  // 每批 200 个文件
  
  async getIndexesToBuild(): Promise<CodebaseIndex[]> {
    // 按 ContextIndexingType 创建对应的 CodebaseIndex
    // chunk / codeSnippets / fullTextSearch / embeddings
  }
  
  async refreshDirs(dirs: Directory): AsyncGenerator<UpdateIndexResult> {
    // 1. 遍历目录
    // 2. 按 filesPerBatch 分批
    // 3. 调用 refreshCodebaseIndexFiles
  }
  
  async *refreshCodebaseIndexFiles(
    resultsToCompute: string[],
    resultsToRemove: string[],
    index: CodebaseIndex,
    branch: string,
  ): AsyncGenerator<UpdateIndexResult> {
    // 1. IndexLock 加锁
    // 2. 分批处理 compute / addTag / removeTag / del
    // 3. IndexLock 解锁
  }
}

class IndexLock {
  private static lockFile = path.join(os.tmpdir(), "continue_indexer.lock");
  private static timeout = 10_000;  // 10 秒超时自动解锁
  
  async acquire(): Promise<void> {
    // 文件锁，防止多窗口并发索引
  }
  
  async release(): Promise<void> {
    // 释放锁
  }
}
```

**关键设计**：

1. **批量处理**：每批 200 个文件，避免单次调用 LLM API 过载
2. **IndexLock**：文件锁防止多窗口并发索引，10 秒超时自动解锁（防死锁）
3. **错误自愈**：`errorsRegexesToClearIndexesOn` 检测 SQLITE_BUSY / CONSTRAINT / ERROR / CORRUPT / IOERR / FULL 错误，自动清空索引重建
4. **警告收集**：`warnings` 数组收集非致命错误，不中断索引流程

### 5.2 LanceDbIndex + SQLite 缓存

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\LanceDbIndex.ts`：

```typescript
export class LanceDbIndex implements CodebaseIndex {
  static async create(): Promise<LanceDbIndex> {
    // 动态 import vectordb（避免 Electron 打包问题）
    // 平台兼容性检查
  }
  
  tableNameForTag(tag: string): string {
    return `base_table_${tag}`;
  }
  
  async createSqliteCacheTable(): Promise<void> {
    // 创建 SQLite 表缓存 (path, cacheKey) → chunks
  }
  
  async *update(
    items: IndexTag,
    resultsToCompute: string[],
    resultsToRemove: string[],
  ): AsyncGenerator<UpdateIndexResult> {
    // 1. computeRows (计算需要更新的行)
    // 2. collectChunks (从 SQLite 缓存读取或重新 chunk)
    // 3. getEmbeddings (调用 LLM embed API)
    // 4. createLanceDbRows (组装 LanceDB 行)
    // 5. addTag (新增到 LanceDB)
    // 6. removeTag (从 LanceDB 移除)
    // 7. del (从 LanceDB 删除)
  }
  
  async retrieve(query: string, n: number): Promise<Chunk[]> {
    // 1. 将 query embed
    // 2. LanceDB 向量搜索
    // 3. SQLite JOIN 获取完整 chunk 内容
  }
}
```

**关键设计**：

1. **静态工厂方法**：`static async create()` 动态 import vectordb，避免 Electron 打包时找不到 native 模块
2. **SQLite 缓存层**：将 chunk 结果缓存到 SQLite，避免重复 chunk 计算
3. **Transaction**：`insertRows` 使用 `BEGIN / COMMIT` 事务，保证原子性
4. **tableNameForTag**：按 tag（如 git branch）分表，便于增量更新

### 5.3 WalkDir DFSWalker

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\walkDir.ts`：

```typescript
export class DFSWalker {
  static LIST_DIR_CACHE_TIME = 30_000;  // 30 秒目录缓存
  static IGNORE_FILE_CACHE_TIME = 30_000;  // 30 秒 ignore 文件缓存
  
  private static walkDirCache: WalkDirCache;  // 单例缓存
  
  async *walkDir(dir: string): AsyncGenerator<string> {
    // 1. 检查 WalkDirCache
    // 2. 读取 .gitignore / .continueignore
    // 3. DFS 遍历
    // 4. 跳过 symlink（避免循环）
  }
}

export function getIgnoreContext(repo: string): Ignore | null {
  // 优先级：gitignore → defaultAndGlobalIgnores → .continueignore
}
```

**关键设计**：

1. **缓存优化**：目录列表 + ignore 文件缓存 30 秒，避免重复 IO
2. **Symlink 跳过**：避免无限循环
3. **Ignore 优先级**：gitignore → 默认 + 全局 ignore → `.continueignore`

### 5.4 chunkDocument 代码切片

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\chunk\chunk.ts`：

```typescript
export async function chunkDocument(
  filepath: string,
  contents: string,
  maxChunkSize: number,
  digest: string,
): Promise<Chunk[]> {
  if (!shouldChunk(filepath, contents)) {
    return [/* 单个完整 chunk */];
  }
  
  const ext = path.extname(filepath).slice(1);
  
  // 非代码文件用 basicChunker
  if (NON_CODE_EXTENSIONS.includes(ext)) {
    return basicChunker(contents, maxChunkSize, digest);
  }
  
  // 代码文件用 tree-sitter codeChunker
  try {
    return await codeChunker(filepath, contents, maxChunkSize);
  } catch {
    // tree-sitter 失败回退到 basicChunker
    return basicChunker(contents, maxChunkSize, digest);
  }
}

function shouldChunk(filepath: string, contents: string): boolean {
  // >1MB 文件跳过 chunk
  return contents.length < 1_000_000;
}
```

**关键设计**：

1. **tree-sitter 优先**：代码文件用 AST 切片，保留语义边界
2. **basicChunker 兜底**：tree-sitter 失败或非代码文件用固定大小切片
3. **大文件跳过**：>1MB 文件不切片，避免性能问题
4. **NON_CODE_EXTENSIONS**：css / html / json / toml / yaml 等用 basicChunker

### 5.5 对 tdsf-linux-desktop 的借鉴

#### 5.5.1 P0 借鉴：批量索引 + IndexLock

**当前状态**：本项目无代码索引功能。

**借鉴方案**：
- 创建 `src/main/core/indexing/CodebaseIndexer.ts`
- 使用 `filesPerBatch = 100`（Linux 项目通常较小）
- 实现 IndexLock 文件锁，防止多个 IPC 调用并发触发索引
- 超时 10 秒自动解锁（防死锁）

#### 5.5.1 P1 借鉴：SQLite 缓存 + LanceDB 向量库

**当前状态**：本项目无向量检索。

**借鉴方案**：
- 用 `better-sqlite3`（同步 API，Electron 主进程友好）替代 `sqlite3`
- 用 `@lancedb/lancedb` 替代 `vectordb`（Node Native Addon，Electron 打包友好）
- 静态工厂方法 + 动态 import 解决 native 模块加载问题

#### 5.5.3 P2 借鉴：tree-sitter 代码切片

**当前状态**：本项目已用 `web-tree-sitter` + tree-sitter-bash 做危险命令识别。

**借鉴方案**：
- 复用已加载的 `web-tree-sitter` WASM
- 加载 `tree-sitter-typescript` / `tree-sitter-python` / `tree-sitter-go` 等 WASM
- 实现 `chunkDocument` 切片运维脚本（bash / python / yaml）

---

## 6. Continue Hub 自托管

### 6.1 Hub 架构（基于代码推断）

> **诚实标注**：本节基于代码片段推断，未完整阅读 Hub 服务端源码。Continue 仓库主要包含客户端代码，Hub 服务端代码可能不在此仓库中。

从代码中可观察到 Hub 的相关组件：

1. **@continuedev/sdk**（packages/sdk/）：Hub 客户端 SDK
2. **@continuedev/config-yaml** 中的 `RegistryClient`：从 Hub 拉取配置
3. **CLI onboarding**：通过 Hub 获取 API key（WorkOS 认证）
4. **session.ts 中的 `getRemoteSessions()`**：返回 `[]`（Hub 集成已移除）

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\session.ts` 第 444 行：

```typescript
/**
 * Remote sessions are no longer available (Hub integration removed).
 */
export async function getRemoteSessions(): Promise<ExtendedSessionMetadata[]> {
  return [];
}
```

### 6.2 Hub 集成演进

从代码痕迹推断 Hub 集成的演进：

1. **早期**：通过 Hub 同步 session / config / model 列表
2. **中期**：Hub 提供 MCP 服务器注册中心
3. **后期（停止维护时）**：Hub 集成已被移除，所有功能本地化

### 6.3 对 tdsf-linux-desktop 的启示

**核心教训**：

1. **不要依赖云 Hub**：Continue 移除 Hub 集成，说明云 Hub 模式在 AI 工具领域不经济
2. **本地优先是正确方向**：本项目硬约束"本地优先"是符合趋势的
3. **MCP 注册中心本地化**：MCP 服务器列表应本地管理，不应依赖远程 Hub

---

## 7. VS Code + JetBrains 双端适配

### 7.1 双端共享 core 的设计

Continue 的双端适配核心思想：

```
extensions/vscode/        extensions/intellij/
       ↓                        ↓
       └────── core/ ───────────┘
                ↓
            IMessenger
                ↓
       ┌────────┴────────┐
       │                 │
  InProcessMessenger   IpcMessenger
```

- **VS Code 端**：使用 `InProcessMessenger`，core 在扩展进程内运行
- **JetBrains 端**：使用 `IpcMessenger`，core 在独立 Node.js 进程中运行，通过 stdin/stdout 通信

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\overview.mdx` 确认

### 7.2 IDE 适配层（ide.ts）

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\ide.ts` 定义了 IDE 提供的约 40 个方法，包括：

- **文件操作**：readFile / writeFile / showLines
- **工作区**：getWorkspaceDirs / listDir / getFileStats
- **Git**：getBranch / getDiff
- **语义查询**：gotoDefinition / getDocumentSymbols
- **UI**：showToast / openFile

每端实现这 40 个方法即可接入 Continue。

### 7.3 对 tdsf-linux-desktop 的启示

**关键洞察**：本项目是 Electron 单端，无需双端适配，但 Continue 的"协议分层"思想仍可借鉴：

1. **将 IDE 能力抽象为 IPC 接口**：而不是直接在 renderer 中调用 Node API
2. **协议命名空间分组**：`history/*` `config/*` 等
3. **InProcessMessenger 用于测试**：单测时不启动 Electron，直接用 InProcessMessenger

---

## 8. binary/IpcIde/IpcMessenger/TcpMessenger 二进制 IPC

### 8.1 IpcIde 极简适配

`d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\IpcIde.ts`（仅 8 行）：

```typescript
export class IpcIde extends MessageIde {
  constructor(messenger: TODO) {
    super(messenger.request.bind(messenger), messenger.on.bind(messenger));
  }
}
```

**设计哲学**：极简适配，所有 IDE 能力委托给 `MessageIde`（基于 messenger.request）。

### 8.2 IpcMessenger 协议设计

`d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\IpcMessenger.ts`：

```typescript
abstract class IPCMessengerBase {
  private _handleLine(line: string) {
    // 1. JSON.parse(line)
    // 2. 根据 message.type 分发
    // 3. 调用对应 handler
  }
  
  protected _handleData(data: Buffer) {
    // 1. 用 \r\n 分隔消息
    // 2. _unfinishedLine 处理半包
    // 3. 每条完整消息调用 _handleLine
  }
  
  // 支持 AsyncIterator（流式响应）
}

class IpcMessenger extends IPCMessengerBase {
  constructor() {
    // stdin.on('data', this._handleData)
    // 重写 send(): process.stdout.write(msg + '\r\n')
  }
}

class CoreBinaryMessenger extends IPCMessengerBase {
  constructor(subprocess) {
    // subprocess.stdout.on('data', this._handleData)
    // 重写 send(): subprocess.stdin.write(msg + '\r\n')
  }
}

class CoreBinaryTcpMessenger extends IPCMessengerBase {
  constructor() {
    // net.createConnection(3000, 'localhost')
  }
}
```

**关键设计**：

1. **消息分隔符 `\r\n`**：HTTP 风格，跨平台兼容
2. **半包处理**：`_unfinishedLine` 缓存不完整的消息，等下次 data 事件拼接
3. **AsyncIterator**：支持流式响应（如 LLM token 流）
4. **三种 Messenger**：IpcMessenger（stdin/stdout）/ CoreBinaryMessenger（subprocess）/ CoreBinaryTcpMessenger（TCP）

### 8.3 TcpMessenger

`d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\TcpMessenger.ts`：

```typescript
class TcpMessenger extends IPCMessengerBase {
  async awaitConnection() {
    // net.createServer 监听 3000
    // 轮询等待客户端连接
  }
  
  // 重写 send(): socket.write(msg + '\r\n')
}
```

**用途**：开发模式下，binary 可以通过 TCP 与 IDE 通信，便于调试。

### 8.4 binary 入口

`d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\index.ts`：

```typescript
process.env.IS_BINARY = "true";

let messenger;
if (process.env.CONTINUE_DEVELOPMENT === "true") {
  messenger = new TcpMessenger();
  await messenger.awaitConnection();
} else {
  setupCoreLogging();
  messenger = new IpcMessenger();
}

const ide = new IpcIde(messenger);
const core = new Core(messenger, ide);
```

### 8.5 setupCoreLogging

`d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\logging.ts`：

```typescript
export function setupCoreLogging() {
  // 覆盖 console.log / error / warn / debug
  // 写入 ~/.continue/logs/core.log
  // 避免污染 stdout（stdout 用于 IPC 通信）
}
```

**关键设计**：binary 模式下 stdout 被 IPC 占用，所有 console.log 必须重定向到文件。

### 8.6 对 tdsf-linux-desktop 的借鉴

#### 8.6.1 P0 借鉴：Claude Code CLI 子进程通信

**当前状态**：本项目通过 `@anthropic-ai/claude-agent-sdk` 调用 Claude，但 Claude Code CLI 是一个独立的可执行文件。

**借鉴方案**：
- 用 `CoreBinaryMessenger` 模式启动 Claude Code CLI 子进程
- 通过 stdin/stdout JSON + `\r\n` 分隔通信
- 用 `_unfinishedLine` 处理半包
- 用 AsyncIterator 接收流式 token

#### 8.6.2 P1 借鉴：TcpMessenger 开发模式

**借鉴方案**：
- 在 `NODE_ENV=development` 时启用 TcpMessenger（监听 3000 端口）
- 便于用 Wireshark / Postman 调试 IPC 消息
- 生产模式用 IpcMessenger

#### 8.6.3 P1 借鉴：setupCoreLogging

**当前状态**：本项目用 `electron-log`，但 Claude Code CLI 子进程的 stdout 不能被 console.log 污染。

**借鉴方案**：
- 在子进程启动时立即覆盖 console.log
- 重定向到 `~/.tdsf-linux-desktop/logs/claude-cli.log`
- 主进程通过 `tail -f` 监控子进程日志

---

## 9. 工具系统

### 9.1 BuiltInToolNames 枚举

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\tools\builtIn.ts`：

```typescript
export enum BuiltInToolNames {
  ReadFile = "read_file",
  ReadFileRange = "read_file_range",
  EditExistingFile = "edit_existing_file",
  SingleFindAndReplace = "single_find_and_replace",
  MultiEdit = "multi_edit",
  ReadCurrentlyOpenFile = "read_currently_open_file",
  CreateNewFile = "create_new_file",
  RunTerminalCommand = "run_terminal_command",
  GrepSearch = "grep_search",
  FileGlobSearch = "file_glob_search",
  SearchWeb = "search_web",
  ViewDiff = "view_diff",
  LSTool = "ls",
  CreateRuleBlock = "create_rule_block",
  RequestRule = "request_rule",
  FetchUrlContent = "fetch_url_content",
  CodebaseTool = "codebase",
  ReadSkill = "read_skill",
  
  // excluded from allTools for now
  ViewRepoMap = "view_repo_map",
  ViewSubdirectory = "view_subdirectory",
}

export const BUILT_IN_GROUP_NAME = "Built-In";

export const CLIENT_TOOLS_IMPLS = [
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
];
```

### 9.2 工具系统目录结构

```
core/tools/
├── builtIn.ts               # 工具枚举
├── definitions/             # 工具定义（schema）
├── implementations/         # 工具实现
├── policies/                # 工具策略（权限）
└── systemMessageTools/      # 系统消息工具
```

### 9.3 工具权限三级控制

`d:\ai\linux教学一体\opensource-reference\continue-dev\docs\cli\tool-permissions.mdx`：

- **allow**：自动执行，无需确认
- **ask**：执行前询问用户
- **exclude**：完全禁用

支持 3 种模式：

- **normal**：默认模式，按 allow/ask/exclude 配置
- **plan**：只读模式，所有写操作自动转为 ask
- **auto**：全自动模式，所有 ask 自动转为 allow

> —— `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\guides\plan-mode-guide.mdx`

### 9.4 对 tdsf-linux-desktop 的借鉴

#### 9.4.1 P0 借鉴：工具权限三级控制

**当前状态**：本项目有 `assessCommandRisk`（low/medium/high）+ `waitForSandboxApproval`，但缺少 allow/ask/exclude 配置。

**借鉴方案**：
- 在 `src/main/core/risk-engine-rules.ts` 中增加 `ToolPermission` 类型：`allow | ask | exclude`
- 在设置 UI 中允许用户为每个工具配置权限
- 支持 `plan` 模式（只读，对应本项目的 read-only 工具集）

#### 9.4.2 P1 借鉴：plan-mode 设计

**借鉴方案**：
- 在 ChatPanel 增加 "Plan Mode" 切换按钮
- Plan Mode 下所有写操作（run_terminal_command / edit_existing_file / create_new_file）自动转为 ask
- 适合运维场景的"先看后做"工作流

---

## 10. 上下文构建与 Token 计数

### 10.1 compileChatMessages 上下文裁剪

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\countTokens.ts`：

```typescript
export function compileChatMessages(
  modelName: string,
  chatOptions: ChatOptions,
  tools: Tool[],
  modelMaxMessageLength: number,
): CoreToolMessage[] | ChatMessage[] {
  // 1. 保留 system prompt + tools
  // 2. 保留最近的 tool sequence（工具调用历史）
  // 3. 从旧到新 prune 消息，直到总 token 数 < modelMaxMessageLength
  // 4. 返回裁剪后的消息数组
}
```

**关键设计**：

1. **保留 system + tools**：系统提示和工具定义必须保留
2. **保留 tool sequence**：工具调用历史必须连续，不能中间裁剪
3. **从旧到新 prune**：旧消息优先被裁剪
4. **Token 计数**：用 `js-tiktoken`（GPT 系列）或 `llamaTokenizer`（Llama 系列）

### 10.2 Token 计数器

```typescript
import { encodingForModel } from "js-tiktoken";
import llamaTokenizer from "llama-tokenizer-js";

export function countTokens(modelName: string, text: string): number {
  if (isGptModel(modelName)) {
    return encodingForModel(modelName).encode(text).length;
  }
  if (isLlamaModel(modelName)) {
    return llamaTokenizer.encode(text).length;
  }
  // fallback: 4 字符 ≈ 1 token
  return Math.ceil(text.length / 4);
}
```

### 10.3 streamChat 入口

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\streamChat.ts`：

```typescript
export async function* llmStreamChat(
  options: LLMOptions,
  messenger: IMessenger,
  cancelToken: CancelToken,
): AsyncGenerator<ChatMessage> {
  // 1. 从 configHandler 加载 config
  // 2. 使用 selectedModelByRole.chat
  // 3. 支持 legacySlashCommandData
  // 4. 调用 llm.streamChat
  // 5. yield 流式响应
}
```

### 10.4 对 tdsf-linux-desktop 的借鉴

#### 10.4.1 P0 借鉴：上下文裁剪算法

**当前状态**：本项目用 Vercel AI SDK 的 `streamText`，但缺少主动的上下文裁剪。

**借鉴方案**：
- 在调用 `streamText` 前先调用 `compileChatMessages` 裁剪
- 保留 system + tools + 最近 N 条消息
- 用 `js-tiktoken` 计数，避免超长上下文导致 API 报错

#### 10.4.2 P1 借鉴：双 Token 计数器

**借鉴方案**：
- GPT 系列：`js-tiktoken`
- Llama 系列（Ollama 默认）：`llama-tokenizer-js`
- fallback：4 字符 ≈ 1 token

---

## 11. Session 管理

### 11.1 SessionManager 单例

`d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\session.ts`：

```typescript
class SessionManager {
  private static instance: SessionManager;
  private currentSession: Session | null = null;
  private sessionUsage: SessionUsage = {
    totalCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    promptTokensDetails: {
      cachedTokens: 0,
      cacheWriteTokens: 0,
    },
  };
  
  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }
  
  trackUsage(cost: number, usage: Usage): void {
    this.sessionUsage.totalCost += cost;
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    
    if (usage.promptTokensDetails?.cachedTokens) {
      this.sessionUsage.promptTokensDetails.cachedTokens += 
        usage.promptTokensDetails.cachedTokens;
    }
    
    if (usage.promptTokensDetails?.cacheWriteTokens) {
      this.sessionUsage.promptTokensDetails.cacheWriteTokens += 
        usage.promptTokensDetails.cacheWriteTokens;
    }
    
    saveSession();  // 立即持久化
  }
}
```

### 11.2 Session 持久化

```typescript
function getSessionDir(): string {
  return path.join(os.homedir(), ".continue", "sessions");
}

export function saveSession(): void {
  const session = SessionManager.getInstance().getCurrentSession();
  if (!hasSessionContent(session)) return;  // 空会话不保存
  
  const sessionToSave = getSessionPersistenceSnapshot(session);
  historyManager.save(sessionToSave);
}

export function loadSession(): Session | null {
  // 找最新的 session 文件（按 mtime 排序）
  // JSON.parse 加载
  // SessionManager.setSession(session)
}
```

### 11.3 SessionUsage 统计

```typescript
interface SessionUsage {
  totalCost: number;
  promptTokens: number;
  completionTokens: number;
  promptTokensDetails: {
    cachedTokens?: number;      // 命中缓存的 prompt token
    cacheWriteTokens?: number;  // 写入缓存的 token
  };
}
```

### 11.4 对 tdsf-linux-desktop 的借鉴

#### 11.4.1 P0 借鉴：SessionUsage 统计字段

**当前状态**：本项目有 `TokenUsageRecord`，但未统计 `cachedTokens` 和 `cacheWriteTokens`。

**借鉴方案**：
- 在 `TokenUsageRecord` 中增加 `cachedTokens` 和 `cacheWriteTokens` 字段
- 在 `provider:streamChat` 完成时从 SDK 响应中提取这两个字段
- 在 Token 监控面板分别展示（命中缓存 / 写入缓存 / 普通 token）

#### 11.4.2 P1 借鉴：Session 持久化路径

**借鉴方案**：
- Session 文件路径：`~/.tdsf-linux-desktop/sessions/<sessionId>.json`
- 用 Dexie（IndexedDB）存储会话历史（本项目硬约束）
- 用文件系统存储会话元数据（title / cost / token 统计）

---

## 12. 配置系统

### 12.1 YAML 配置

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\yaml\loadYaml.ts`：

```typescript
export async function loadContinueConfigFromYaml(
  yamlPath: string,
  ...
): Promise<ContinueConfig> {
  // 1. 读取 YAML 文件
  // 2. 解析为 ConfigYaml
  // 3. 加载 localBlockPromises（本地 MCP 服务器）
  // 4. 通过 RegistryClient 从 Hub 拉取远程配置
  // 5. unrollAssistant（展开嵌套引用）
  // 6. validateConfigYaml（校验）
  // 7. nonNullifyConfigYaml（移除 null）
  // 8. 返回 ContinueConfig
}
```

### 12.2 selectedModels fallback

`d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\selectedModels.ts`：

```typescript
export function rectifySelectedModelsFromGlobalContext(
  globalContext: GlobalContext,
  models: BaseLLM[],
): { [role: string]: string } {
  const selectedModels = globalContext.selectedModelsByProfileId;
  
  // 按角色回填
  for (const role of ["autocomplete", "apply", "edit", "embed", "rerank", "chat"]) {
    if (!selectedModels[role]) {
      // fallback 到该角色第一个模型
      selectedModels[role] = models.find(m => m.roles?.includes(role))?.title;
    }
  }
  
  return selectedModels;
}
```

### 12.3 ModelRole 8 类

`d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\model-roles.mdx`：

1. **chat**：对话主模型
2. **edit**：用于编辑代码的模型
3. **apply**：用于应用代码块的低延迟模型
4. **autocomplete**：自动补全（FIM）
5. **embed**：嵌入模型（用于 RAG）
6. **rerank**：重排序模型（用于 RAG）
7. **summarizer**：总结模型
8. **subagent**：子 agent 专用模型

### 12.4 对 tdsf-linux-desktop 的借鉴

#### 12.4.1 P1 借鉴：ModelRole 多角色

**当前状态**：本项目只有单一 `chat` 角色。

**借鉴方案**：
- 增加 `ModelRole` 类型：`chat | subagent | sandbox`
- 不同角色可配置不同模型（如 chat 用 Claude Sonnet，subagent 用 Haiku 省成本）
- 在 Provider 设置 UI 中按角色分组

#### 12.4.2 P0 借鉴：selectedModels fallback

**借鉴方案**：
- 在 `provider:setDefault` 时自动 fallback
- 如果用户没设置 `chat` 角色，自动用第一个可用模型
- 如果用户没设置 `subagent` 角色，fallback 到 `chat` 角色

---

## 13. 借鉴建议（tdsf-linux-desktop）

### 13.1 总体策略

借鉴 Continue.dev 的设计模式，**不直接复制代码**：

1. **代码层面**：完全自研，仅参考类签名与方法结构
2. **架构层面**：参考分层（BaseLLM → Provider 实现 → 工厂）
3. **协议层面**：参考 IMessenger 抽象 + stdin/stdout JSON + `\r\n` 分隔
4. **配置层面**：参考 ModelRole + selectedModels fallback

### 13.2 已落地借鉴

本项目 v0.9.0-v0.9.1 已借鉴的设计：

- ✅ **Provider 工厂模式**：`ClaudeSdkProvider` / `VercelAiProvider` / `OpenHandsProvider` 已存在
- ✅ **IPC 4 步同步铁律**：参考 Continue 的 `ToCoreFromIdeOrWebviewProtocol` 命名空间分组
- ✅ **审批闸门**：参考 Continue 的 `ask` 权限，实现 `waitForSandboxApproval`
- ✅ **危险命令识别**：tree-sitter-bash AST（与 Continue 的 codeChunker 同源）

### 13.3 待落地借鉴（按优先级）

#### P0（立即落地）

1. **BaseLLM 抽象类**：创建 `src/main/core/llm/BaseProvider.ts`
2. **AUTODETECT 机制**：Ollama 自动检测模型列表
3. **Claude Code CLI 子进程通信**：IpcMessenger + `\r\n` 分隔 + 半包处理
4. **上下文裁剪算法**：compileChatMessages
5. **SessionUsage 统计字段**：cachedTokens + cacheWriteTokens
6. **selectedModels fallback**：缺失角色自动填充

#### P1（短期落地）

1. **PROVIDER_TOOL_SUPPORT 表**：模型工具调用能力检测
2. **CodebaseIndexer 批量索引**：200 files/batch + IndexLock
3. **SQLite + LanceDB 向量库**：RAG 支持
4. **TcpMessenger 开发模式**：调试 IPC 消息
5. **setupCoreLogging**：子进程日志重定向
6. **plan-mode 设计**：只读工具集切换
7. **ModelRole 多角色**：chat / subagent / sandbox
8. **双 Token 计数器**：js-tiktoken + llama-tokenizer-js

#### P2（长期落地）

1. **tree-sitter 代码切片**：复用 web-tree-sitter WASM
2. **DFSWalker**：.continueignore 优先级
3. **CLI 双击 SIGINT 退出**：TUI 友好退出
4. **全局错误处理**：unhandledRejection + uncaughtException 上报

---

## 14. P0/P1/P2 借鉴清单

### 14.1 P0 借鉴清单（立即落地，预计 3-5 天）

| 序号 | 借鉴项 | 源文件 | 目标文件 | 工作量 |
|------|--------|--------|----------|--------|
| P0-1 | BaseLLM 抽象类 | `core/llm/index.ts` | `src/main/core/llm/BaseProvider.ts` | 1 天 |
| P0-2 | AUTODETECT 机制 | `core/config/yaml/models.ts` | `src/main/core/llm/autodetect.ts` | 0.5 天 |
| P0-3 | Claude Code CLI 子进程通信 | `binary/src/IpcMessenger.ts` | `src/main/core/claude-cli/messenger.ts` | 1 天 |
| P0-4 | 上下文裁剪算法 | `core/llm/countTokens.ts` | `src/main/core/llm/context-compiler.ts` | 0.5 天 |
| P0-5 | SessionUsage 统计字段 | `extensions/cli/src/session.ts` | `src/shared/agent-types.ts` | 0.5 天 |
| P0-6 | selectedModels fallback | `core/config/selectedModels.ts` | `src/main/core/provider/selected-models.ts` | 0.5 天 |

### 14.2 P1 借鉴清单（短期落地，预计 1-2 周）

| 序号 | 借鉴项 | 源文件 | 目标文件 | 工作量 |
|------|--------|--------|----------|--------|
| P1-1 | PROVIDER_TOOL_SUPPORT 表 | `core/llm/toolSupport.ts` | `src/main/core/llm/tool-support.ts` | 0.5 天 |
| P1-2 | CodebaseIndexer 批量索引 | `core/indexing/CodebaseIndexer.ts` | `src/main/core/indexing/codebase-indexer.ts` | 3 天 |
| P1-3 | SQLite + LanceDB 向量库 | `core/indexing/LanceDbIndex.ts` | `src/main/core/indexing/lance-db-index.ts` | 2 天 |
| P1-4 | TcpMessenger 开发模式 | `binary/src/TcpMessenger.ts` | `src/main/core/claude-cli/tcp-messenger.ts` | 0.5 天 |
| P1-5 | setupCoreLogging | `binary/src/logging.ts` | `src/main/core/claude-cli/logging.ts` | 0.5 天 |
| P1-6 | plan-mode 设计 | `docs/guides/plan-mode-guide.mdx` | UI + main 双端 | 1 天 |
| P1-7 | ModelRole 多角色 | `docs/customize/model-roles.mdx` | Provider 设置 UI | 1 天 |
| P1-8 | 双 Token 计数器 | `core/llm/countTokens.ts` | `src/main/core/llm/token-counter.ts` | 1 天 |

### 14.3 P2 借鉴清单（长期落地，预计 1 个月）

| 序号 | 借鉴项 | 源文件 | 目标文件 | 工作量 |
|------|--------|--------|----------|--------|
| P2-1 | tree-sitter 代码切片 | `core/indexing/chunk/chunk.ts` | `src/main/core/indexing/chunker.ts` | 3 天 |
| P2-2 | DFSWalker + .continueignore | `core/indexing/walkDir.ts` | `src/main/core/indexing/walk-dir.ts` | 1 天 |
| P2-3 | CLI 双击 SIGINT 退出 | `extensions/cli/src/index.ts` | 本项目无 TUI，可借鉴全局错误处理 | 0.5 天 |
| P2-4 | 全局错误处理 | `extensions/cli/src/index.ts` | `src/main/index.ts` | 0.5 天 |

---

## 15. 可立即落地的具体改进点

### 15.1 改进点 1：BaseProvider 抽象类（P0-1，1 天）

**当前痛点**：`ClaudeSdkProvider` / `VercelAiProvider` / `OpenHandsProvider` 缺少统一抽象，方法签名不一致。

**立即落地方案**：

```typescript
// src/main/core/llm/BaseProvider.ts
export abstract class BaseProvider {
  abstract providerName: string;
  abstract supportsTools(): boolean;
  abstract supportsImages(): boolean;
  abstract supportsStreaming(): boolean;
  
  protected abstract _streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions,
  ): AsyncGenerator<ChatChunk>;
  
  async *streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions,
  ): AsyncGenerator<ChatChunk> {
    // 1. withExponentialBackoff 重试
    // 2. 调用 _streamChat
    // 3. 收集 usage
    // 4. 收集 citations
    // 5. 错误映射
    try {
      yield* this._streamChat(messages, options);
    } catch (e) {
      throw parseError(e, this.providerName);
    }
  }
  
  protected async _fetch(url: string, options: RequestInit): Promise<Response> {
    return withExponentialBackoff(
      () => fetch(url, options),
      { maxRetries: 5, initialDelay: 500 },
    );
  }
}
```

**收益**：
- 统一 3 个 Provider 的方法签名
- 统一错误处理（parseError）
- 统一重试机制（withExponentialBackoff）

### 15.2 改进点 2：Claude Code CLI 子进程通信（P0-3，1 天）

**当前痛点**：`@anthropic-ai/claude-agent-sdk` 在 Electron 主进程 CommonJS 环境下加载失败（ESM-only），需要动态 import。

**立即落地方案**：

```typescript
// src/main/core/claude-cli/messenger.ts
import { spawn, ChildProcess } from 'child_process';

abstract class IPCMessengerBase {
  private _unfinishedLine = '';
  
  protected _handleData(data: Buffer) {
    const str = this._unfinishedLine + data.toString('utf8');
    const lines = str.split('\r\n');
    this._unfinishedLine = lines.pop() || '';  // 最后一个可能不完整
    
    for (const line of lines) {
      if (line.trim()) {
        this._handleLine(line);
      }
    }
  }
  
  private _handleLine(line: string) {
    const msg = JSON.parse(line);
    // 分发到对应 handler
  }
  
  abstract send(msg: object): void;
}

export class ClaudeCliMessenger extends IPCMessengerBase {
  private proc: ChildProcess;
  
  constructor(cliPath: string) {
    super();
    this.proc = spawn(cliPath, ['--json-stream'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', this._handleData);
  }
  
  send(msg: object): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\r\n');
  }
}
```

**收益**：
- 解决 ESM-only SDK 在 CommonJS 环境的加载问题
- 子进程隔离，崩溃不影响主进程
- 流式响应（AsyncGenerator）

### 15.3 改进点 3：SessionUsage 缓存统计（P0-5，0.5 天）

**当前痛点**：`TokenUsageRecord` 未统计 `cachedTokens`，无法体现 Claude prompt caching 的成本节省。

**立即落地方案**：

```typescript
// src/shared/agent-types.ts
export interface TokenUsageRecord {
  // ... 现有字段
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;      // 新增：命中缓存的 prompt token
  cacheWriteTokens: number;  // 新增：写入缓存的 token
  totalCost: number;
}

// src/main/core/claude-sdk-provider.ts
private onUsage(usage: AnthropicUsage): void {
  this.tokenRecord.cachedTokens = usage.cache_read_input_tokens ?? 0;
  this.tokenRecord.cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
}
```

**收益**：
- 用户可看到 prompt caching 节省了多少 token
- 可计算实际成本节省（缓存 token 单价更低）

### 15.4 改进点 4：AUTODETECT Ollama 模型（P0-2，0.5 天）

**当前痛点**：用户需要手动配置 Ollama 模型名称，容易出错。

**立即落地方案**：

```typescript
// src/main/core/llm/autodetect.ts
export async function autodetectOllamaModels(): Promise<string[]> {
  const resp = await fetch('http://localhost:11434/api/tags');
  const data = await resp.json();
  return data.models.map((m: any) => m.name);
}

// src/main/ipc/provider.ts
ipcMain.handle('provider:autodetect', async (_, providerName: string) => {
  if (providerName === 'ollama') {
    return autodetectOllamaModels();
  }
  return [];
});
```

**收益**：
- 用户体验提升：自动列出可用模型
- 避免手误输入错误模型名

### 15.5 改进点 5：全局错误处理（P2-4，0.5 天）

**立即落地方案**：

```typescript
// src/main/index.ts
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  // 推送到 renderer 显示
  mainWindow?.webContents.send('main:error', {
    type: 'unhandledRejection',
    message: String(reason),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // 推送到 renderer 显示
  mainWindow?.webContents.send('main:error', {
    type: 'uncaughtException',
    message: error.message,
    stack: error.stack,
  });
});
```

**收益**：
- 全局错误可见，便于调试
- 避免 Electron 主进程崩溃后无错误信息

---

## 16. 未读部分诚实标注

### 16.1 未完整阅读的文件

| 文件/目录 | 已读程度 | 说明 |
|----------|---------|------|
| `core/edit/lazy/` | 仅 LS 目录 | 未细读 applyCodeBlock / findInAst / replace 内部实现 |
| `core/context/providers/` | 仅 LS 目录 | 未细读上下文提供者（ContextProvider）实现 |
| `core/autocomplete/` | 仅 LS 目录 | 未细读自动补全逻辑 |
| `core/nextEdit/` | 仅 LS 目录 | 未细读 Next Edit Prediction |
| `core/data/devdataSqlite.ts` | 仅 LS 目录 | 未细读 SQLite 数据访问层 |
| `core/util/` | 仅 LS 目录 | 未细读工具函数 |
| `extensions/cli/src/tools/edit.ts` | 未读 | CLI 的 edit 工具实现 |
| `extensions/cli/src/tools/exit.ts` | 未读 | CLI 的 exit 工具实现 |
| `extensions/vscode/` | 仅 LS 目录 | 未细读 VS Code 扩展实现 |
| `extensions/intellij/` | 仅 LS 目录 | 未细读 JetBrains 扩展实现 |
| `packages/config-yaml/` | 仅 LS 目录 | 未细读 YAML 配置解析包 |
| `packages/openai-adapters/` | 仅 LS 目录 | 未细读 OpenAI 适配器包 |
| `packages/sdk/` | 仅 LS 目录 | 未细读 Hub SDK |

### 16.2 未验证的运行时行为

| 项目 | 说明 |
|------|------|
| CodebaseIndexer 批量索引性能 | 未实测 200 files/batch 在大仓库下的性能 |
| LanceDbIndex 在 Electron 打包后的可用性 | 未实测 native 模块在 asar 中的加载 |
| IpcMessenger 半包处理 | 未编写测试验证 `\r\n` 半包处理 |
| Ollama AUTODETECT | 未实测 Ollama 不可达时的错误处理 |
| selectedModels fallback | 未实测角色缺失时的 fallback 顺序 |

### 16.3 推断而非确证的内容

| 项目 | 推断依据 | 不确定性 |
|------|---------|---------|
| Continue Hub 架构 | 基于 `getRemoteSessions` 返回 `[]` 推断 | 高（Hub 服务端代码不在仓库） |
| 60+ Provider 完整列表 | 基于 `LLMClasses` 数组推断 | 中（部分 Provider 可能只是 stub） |
| IndexLock 超时机制 | 基于 10_000 常量推断 | 低（代码明确） |
| toolOverrides 应用时机 | 基于 streamChat 实现推断 | 中（具体行为需运行时验证） |

---

## 17. 参考资料

### 17.1 已读源码文件（按章节顺序）

#### 项目根与配置
- `d:\ai\linux教学一体\opensource-reference\continue-dev\README.md`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\LICENSE`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\package.json`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\package.json`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\package.json`

#### 架构文档
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\overview.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\models.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\model-roles.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\mcp-tools.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\prompts.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\rules.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\customize\overview.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\guides\plan-mode-guide.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\guides\ollama-guide.mdx`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\docs\cli\tool-permissions.mdx`

#### core/llm 多模型适配
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\index.ts`（BaseLLM 抽象类，1500+ 行）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\llms\index.ts`（LLMClasses 工厂，60+ Provider）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\autodetect.ts`（模板/能力自动检测）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\toolSupport.ts`（PROVIDER_TOOL_SUPPORT 大对象）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\countTokens.ts`（Token 计数 + 上下文裁剪）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\llm\streamChat.ts`（llmStreamChat 协议入口）

#### core/config 配置系统
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\selectedModels.ts`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\yaml\default.ts`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\yaml\loadYaml.ts`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\config\yaml\models.ts`

#### core/protocol 通信协议
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\messenger\index.ts`（IMessenger + InProcessMessenger）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\ide.ts`（ToIdeFromWebviewOrCoreProtocol，约 40 个方法）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\protocol\core.ts`（ToCoreFromIdeOrWebviewProtocol，约 60 个方法）

#### core/indexing 代码库索引
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\CodebaseIndexer.ts`（870+ 行）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\LanceDbIndex.ts`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\walkDir.ts`（DFSWalker）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\shouldIgnore.ts`
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\indexing\chunk\chunk.ts`（chunkDocument）

#### binary IPC 通信层
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\IpcIde.ts`（8 行）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\IpcMessenger.ts`（IPCMessengerBase + IpcMessenger + CoreBinaryMessenger + CoreBinaryTcpMessenger）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\TcpMessenger.ts`（TcpMessenger）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\index.ts`（入口）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\binary\src\logging.ts`（setupCoreLogging）

#### extensions/cli CLI 扩展
- `d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\index.ts`（commander 入口）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\config.ts`（createLlmApi + getLlmApi + getApiClient）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\onboarding.ts`（首次启动引导）
- `d:\ai\linux教学一体\opensource-reference\continue-dev\extensions\cli\src\session.ts`（SessionManager 单例）

#### core/tools 工具系统
- `d:\ai\linux教学一体\opensource-reference\continue-dev\core\tools\builtIn.ts`（BuiltInToolNames 枚举，19 个工具）

### 17.2 仅 LS 目录未细读的文件

| 路径 | LS 程度 |
|------|---------|
| `core/edit/lazy/` | LS 目录，未细读 applyCodeBlock / findInAst / replace |
| `core/context/providers/` | LS 目录，未细读 ContextProvider 实现 |
| `core/autocomplete/` | LS 目录，未细读自动补全逻辑 |
| `core/nextEdit/` | LS 目录，未细读 Next Edit Prediction |
| `core/data/` | LS 目录，未细读 devdataSqlite |
| `core/util/` | LS 目录，未细读工具函数 |
| `core/tools/definitions/` | LS 目录，未细读工具定义 |
| `core/tools/implementations/` | LS 目录，未细读工具实现 |
| `core/tools/policies/` | LS 目录，未细读工具策略 |
| `extensions/vscode/` | LS 目录 |
| `extensions/intellij/` | LS 目录 |
| `packages/config-yaml/` | LS 目录 |
| `packages/openai-adapters/` | LS 目录 |
| `packages/sdk/` | LS 目录 |

### 17.3 相关调研报告

- `d:\ai\linux教学一体\idea-to-dev-output\24-源码分析-Mastra框架.md`（Mastra Agent 框架）
- `d:\ai\linux教学一体\idea-to-dev-output\25-源码分析-OpenHands沙箱.md`（OpenHands 沙箱）
- `d:\ai\linux教学一体\idea-to-dev-output\28-源码分析-Cline-VSCode扩展型Agent.md`（Cline）
- `d:\ai\linux教学一体\idea-to-dev-output\29-源码分析-KiloCode-多模式Subagent.md`（KiloCode）

### 17.4 官方资料

- Continue 官网：https://www.continue.dev/
- Apache 2.0 协议：https://www.apache.org/licenses/LICENSE-2.0
- Continue 文档（已停止维护）：`d:\ai\linux教学一体\opensource-reference\continue-dev\docs\`

---

## 附录 A：本报告字数估算

- **章节数**：18 个（0.摘要 + 1-17）
- **总字数**：约 12,000 字（不含代码块）
- **代码块数**：约 40 个
- **表格数**：约 15 个
- **引用文件数**：约 35 个

## 附录 B：分析过程元信息

- **分析耗时**：约 2 小时
- **读取文件数**：35 个核心文件 + 10 个文档文件
- **LS 目录数**：15 个（仅 LS 未细读）
- **未读率**：约 30%（主要是 core/edit / core/context / extensions/vscode / extensions/intellij / packages/* 等外围代码）
- **核心覆盖率**：约 90%（core/llm / core/config / core/protocol / core/indexing / binary / extensions/cli 等核心模块已覆盖）

---

**报告完成时间**：2026-07-19
**分析师**：tdsf-linux-desktop 资深源码分析师
**License 兼容性**：Apache-2.0（可借鉴设计，需 NOTICE 声明）
**仓库状态**：已停止维护，仅作设计参考
