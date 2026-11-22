# 接口文档入口

接口以当前注册代码、类型与协议测试为准，文档不维护第二份易漂移的方法总数。

| 边界 | 核对入口 |
|---|---|
| 前端到 Rust | [lib.rs 注册](../../src-tauri/src/lib.rs)及对应调用方 |
| Rust 到 Python | [sidecar 进程桥](../../src-tauri/src/modules/sidecar.rs)、[JSON-RPC](../../src-tauri/sidecar/jsonrpc.py) |
| Agent 稳定门面 | [agent_facade.py](../../src-tauri/sidecar/agent_facade.py) |
| 前端流与工具状态 | [sidecar adapter](../../src/modules/ai/lib/sidecar-adapter.ts)与对应测试 |

新增/变更方法需同时核注册、允许调用范围、参数转换、取消、错误、事件归属和前端生命周期。候选 DTO、实验脚本或旧报告不是已部署接口。
