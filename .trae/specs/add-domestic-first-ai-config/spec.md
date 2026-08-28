# AI 配置国产化与现代化 Spec

## Why
用户要求 AI 配置以国产模型为主、模型目录跟上 2026-08 现状：当前默认对话模型是 `gpt-5.4-mini`（OpenAI 旧款，最新已是 GPT-5.6 家族），GLM/Qwen 官方/Kimi 没有独立 provider（只能绕 OpenRouter），语音输入默认走 OpenAI（本地 whisper.cpp 方案已存在却非默认），"自动补全模型"语义无说明易误解。

## What Changes
- **默认对话模型国产化**：`DEFAULT_MODEL_ID` 从 `gpt-5.4-mini` 改为 `deepseek-v4-flash`（性价比最高、Agent 工具调用兼容好、MIT 开源背书）；`chatStore.selectedModelId` 初始值同步
- **新增 3 个国产 provider**（均走 OpenAI 兼容端点，Strands OpenAIModel 天然支持）：
  - `zhipu` 智谱：GLM-5.3 / GLM-5.3-Flash（baseURL `https://open.bigmodel.cn/api/paas/v4`）
  - `dashscope` 阿里百炼：Qwen3.8-Flash / Qwen3.7-Max（baseURL `https://dashscope.aliyuncs.com/compatible-mode/v1`）
  - `moonshot` 月之暗面：Kimi K3 / K2.6（baseURL `https://api.moonshot.cn/v1`）
- **模型目录现代化**：新增上述国产条目（含中文描述/上下文窗口/定价），OpenAI 区补 `gpt-5.6-sol`；过时条目（gpt-5.4-mini/nano、gpt-4.1-mini、gemini-2.5 等）保留但标注 legacy（老用户 localStorage 已选它们仍有效）
- **provider 列表国产优先**：设置页顺序调整为 DeepSeek → 智谱 → 百炼 → Kimi → Ollama → LM Studio → OpenAI Compatible → OpenRouter → OpenAI → Anthropic → Google → xAI → Cerebras → Groq → Mistral → MLX
- **语音输入本地优先**：`DEFAULT_STT_PROVIDER` 从 `openai` 改为 `whispercpp`（现有实现已强制 loopback 地址）；设置页语音区补 whisper.cpp 本地服务启动引导文案
- **"自动补全模型"语义澄清**：设置页该区块加说明——它只用于**编辑器内联 AI 代码补全**（快速小模型）；**终端命令预测不使用大模型**（本地词典 + carapace）
- **Python 侧对齐**：`llm_config.py` baseURL 映射补 zhipu/dashscope/moonshot 三家
- 每家 provider 补 `providerDefaultModel` 条目（openai 升为 gpt-5.6-luna）

**BREAKING**：无（默认值仅影响未做过选择的全新用户；已存 preferences 的老用户不受影响；gpt-5.4-mini 条目保留）

## Impact
- Affected specs: 无既有 spec；本 spec 独立
- Affected code:
  - `src/modules/ai/config.ts`（PROVIDERS/MODELS/DEFAULT_MODEL_ID/DEFAULT_STT_PROVIDER/providerDefaultModel/MODEL_CONTEXT_LIMITS/MODEL_PRICING）
  - `src/modules/settings/store.ts`（默认值引用不变，迁移逻辑核对）
  - `src/modules/ai/store/chatStore.ts`（selectedModelId 初始值引用 DEFAULT_MODEL_ID，自动跟随）
  - `src/settings/sections/ModelsSection.tsx`（provider 顺序跟随 PROVIDERS、语音区引导文案、自动补全区说明文案）
  - `src-tauri/sidecar/core/llm_config.py`（baseURL 映射 +3 家）
  - 测试：config/store 相关单测

## ADDED Requirements

### Requirement: 默认模型国产优先
全新安装（无本地 preferences）时，对话模型默认 SHALL 为 DeepSeek v4-flash；STT 默认 SHALL 为 whisper.cpp 本地服务。

#### Scenario: 全新用户首次打开设置
- **WHEN** 无 localStorage/preferences 的用户打开 设置 → 模型
- **THEN** 默认对话模型显示 deepseek-v4-flash，语音输入显示 whisper.cpp（本地）

#### Scenario: 老用户不受影响
- **WHEN** 用户此前已选择 defaultModelId=gpt-5.4-mini
- **THEN** 该选择保持有效（gpt-5.4-mini 条目仍存在于目录）

### Requirement: 国产 provider 一等公民
系统 SHALL 提供智谱/百炼/Kimi 三个官方 provider 预设（预填 baseURL、keyring 账号、keyPrefix），用户填 API key 即可对话。

#### Scenario: 用智谱 key 对话
- **WHEN** 用户在设置中选择智谱 provider 并填入 key，选择 GLM-5.3 后发起对话
- **THEN** 请求经 OpenAI 兼容端点发往 open.bigmodel.cn 且正常流式返回（Python Strands 侧 OpenAIModel 路径）

### Requirement: 本地部署链路可用
Ollama / LM Studio 本地模型 SHALL 保持可对话（OpenAIModel 兼容端点），设置页 Ollama hint 列出推荐模型名（qwen3:8b、glm4:9b、deepseek-r1:8b 等）。

#### Scenario: Ollama 本地模型对话
- **WHEN** 用户本机 Ollama 已拉取 qwen3:8b 并选择 ollama provider
- **THEN** AI 对话/Agent 面板正常流式返回

### Requirement: 语义说明文案
设置页"自动补全模型"区块 SHALL 说明其作用域（仅编辑器内联 AI 补全）；语音输入区块 SHALL 提供 whisper.cpp 启动引导（一句命令 + 模型文件说明）。

#### Scenario: 用户理解自动补全模型
- **WHEN** 用户查看"自动补全模型"设置项
- **THEN** 可见说明：该模型用于编辑器内联代码补全；终端命令预测不消耗大模型

## MODIFIED Requirements

### Requirement: 默认 STT 提供商
`DEFAULT_STT_PROVIDER` SHALL 为 `whispercpp`（原 `openai`）。whisper.cpp URL 仍强制 loopback（隐私红线保留）。Groq/OpenAI 选项保留供云端用户选择。

## REMOVED Requirements
（无移除——过时模型条目仅标注 legacy，不删除）
