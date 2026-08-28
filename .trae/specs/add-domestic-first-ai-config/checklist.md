# Checklist — AI 配置国产化与现代化

> 2026-08-28 核对：P0/P1/P2 自动化项全过；桌面端验收待用户

## P0：默认值国产化 + provider 预设

- [x] `DEFAULT_MODEL_ID` 为 `deepseek-v4-flash`，`DEFAULT_STT_PROVIDER` 为 `whispercpp`
- [x] PROVIDERS 含 zhipu/qwen(百炼)/moonshot/doubao，且数组顺序国产/本地优先
- [x] 三家国产 baseURL 正确：open.bigmodel.cn/api/paas/v4、dashscope.aliyuncs.com/compatible-mode/v1、api.moonshot.cn/v1（前端 PROVIDER_BASE_URLS + Python PROVIDER_DEFAULT_BASE_URLS 双侧一致）
- [x] MODELS 含 GLM-5.3(-Flash)/Kimi K3 条目（中文描述与定价齐全）；Qwen3.8-flash 条目已在（qwen provider 区）；gpt-5.6-sol 已存在（id `gpt-5.6`）
- [x] gpt-5.4-mini 等旧条目仍可被 resolveModel 解析（[legacy] 标注，老用户选择不受影响）
- [x] per-provider 默认（DEFAULT_AUTOCOMPLETE_MODEL + providerDefault 落点）：openai → gpt-5.6-luna；deepseek/zhipu/moonshot/ollama 各有条目
- [x] Python llm_config.py 映射含三家新 baseURL；model_adapter 新 id 显式命中 OpenAIModel 兼容分支（不再误报 unknown provider）

## P1：UI 文案与引导

- [x] 语音区有 whisper.cpp 启动引导文案（含启动命令与"完全本地"说明）
- [x] 自动补全模型区有作用域说明（仅编辑器内联补全；终端预测不用大模型）
- [x] Ollama hint 列推荐模型名（qwen3:8b / glm4:9b / deepseek-r1:8b）

## P2：测试与门禁

- [x] config/store 单测全过（新默认/迁移/baseURL/legacy 可解析，52+5 用例）
- [x] pnpm typecheck / lint / vitest 全绿（1125 用例/113 文件）；pytest llm_config + model_adapter 55 passed
- [ ] 桌面端验收：全新偏好默认 DeepSeek+whisper.cpp；智谱 key 对话通；Ollama 对话通 —— **待用户实测**
