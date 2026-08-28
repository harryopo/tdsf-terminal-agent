# Tasks — AI 配置国产化与现代化

> ✅ T1-T5 完成（2026-08-28）；T6 桌面端验收待用户实测

## P0：默认值国产化 + provider 预设

- [x] T1: config.ts 目录与默认值改造
  - [x] T1.1: PROVIDERS 增加 zhipu/dashscope/qwen/moonshot（**实施偏差**：工作树已有先行改动采用 provider id `qwen` 指向百炼兼容端点——语义等价于任务书 `dashscope`，为一致性沿用 `qwen`；另含 doubao 条目），数组重排为国产优先
  - [x] T1.2: MODELS 增加 glm-5.3/glm-5.3-flash/kimi-k3 条目（中文描述/上下文/定价）；OpenAI 区 gpt-5.6-sol 已存在（id `gpt-5.6` label Sol，数值与调研吻合）；gpt-5.4 家族/gpt-4.1-mini/gemini-2.5 等标 [legacy]
  - [x] T1.3: DEFAULT_MODEL_ID → "deepseek-v4-flash"；DEFAULT_STT_PROVIDER → "whispercpp"；DEFAULT_AUTOCOMPLETE_MODEL（即 per-provider 默认落点）：openai→gpt-5.6-luna、zhipu→glm-5.3-flash、moonshot→kimi-k3、新增 ollama→qwen3:8b；zhipu keyPrefix 修为 null（其真实 key 为 "id.secret" 格式，"sk-" 前缀校验会误拒）
  - [x] T1.4: MODEL_CONTEXT_LIMITS/MODEL_PRICING 补 glm-5.3(-flash)/kimi-k3/qwen3.8-flash（2026-08 快照注释，以官网为准）
- [x] T2: settings store / chatStore 核对
  - [x] T2.1: defaultModelId 读取逻辑确认（未设置→新默认；已设置→保留；脏值→isKnownModelId 回退），新增 preferences.test.ts 5 用例覆盖三条迁移路径
  - [x] T2.2: chatStore.selectedModelId 引用 DEFAULT_MODEL_ID 常量确认，无硬编码
- [x] T3: Python 侧对齐
  - [x] T3.1: llm_config.py 新增 PROVIDER_DEFAULT_BASE_URLS（zhipu/dashscope/moonshot）+ _resolve_base_url() 回退（显式 base_url 优先；未知 provider 行为不变）
  - [x] T3.2: model_adapter.py 新增 _OPENAI_COMPATIBLE_PROVIDERS frozenset，三分发结构未动，新 id 静默命中 OpenAIModel 分支（修复原 else 兜底的 "unknown provider" 误报警告）
- [x] T3 附带修复（主线）：AiStatusBarControls.tsx 本地 PROVIDER_ICON 表补 qwen/zhipu/moonshot/doubao 4 个图标映射（既存 typecheck 红，非本次引入但阻断门禁）

## P1：UI 文案与引导

- [x] T4: ModelsSection.tsx 文案
  - [x] T4.1: 语音区 whisper.cpp 引导（完全本地 + whisper-server 启动命令 + 模型下载来源 + 未启动失败属预期）
  - [x] T4.2: 自动补全区作用域说明（仅编辑器内联补全；终端命令预测不用大模型，无需 API key）
  - [x] T4.3: Ollama hint 推荐 qwen3:8b / glm4:9b / deepseek-r1:8b（7B-9B，8GB 显存可跑）

## P2：测试与门禁

- [x] T5: 测试
  - [x] T5.1: config.test.ts 扩展至 52 用例（新默认/PROVIDERS 顺序/legacy 可解析/新模型 provider 归属/国产定价）+ preferences.test.ts 新建 5 用例（迁移三路径）
  - [x] T5.2: 迁移测试：无存储→deepseek-v4-flash；已存 gpt-5.4-mini→保留；脏值→回退
  - [x] T5.3: 全量门禁：tsc 0 / eslint 0 / vitest **1125 全过**（113 文件）/ pytest llm_config+model_adapter **55 passed**
- [ ] T6: 桌面端验收（用户实测）
  - [ ] T6.1: 全新偏好下设置页默认显示 DeepSeek + whisper.cpp 本地
  - [ ] T6.2: 填智谱 key 对话通 / Ollama 本地对话通

# Task Dependencies
- T1 → T2 → T5 已按序完成；T3/T4 并行完成
- T6 依赖 T1-T4（已满足），等用户实测
