# Agent 与工具链路

生产 Agent 使用 Strands 单运行时。前端对话的主要定位路径为 [transport](../../src/modules/ai/lib/transport.ts)、[sidecar adapter](../../src/modules/ai/lib/sidecar-adapter.ts)、Rust IPC/sidecar 桥，再到 [Python 门面](../../src-tauri/sidecar/agent_facade.py) 与 [Strands 实现](../../src-tauri/sidecar/strands_backend/)。

模型请求、工具启动、等待审批、执行、输出可用、业务结果与回合结束是不同阶段。输出已经可读不自动等于命令成功；没有可靠退出状态时保留未知，而不是生成成功结论。

工具说明、注册 schema 和策略需要一致，新增工具要有统一事件展示、审批与证据归属。测试应经过实际 SDK 注册对象；只模拟一个总会通过的 registry 无法证明模型可见的工具正确。

可见执行必须绑定当前目标终端，并将真实输出归到对应调用；后台执行同样要保留目标身份与结果状态。修改重试、超时或取消时，检查是否存在多层重复退避，以及是否真正释放等待审批的调用。

不恢复已移除的旧 Agent/DecisionEngine 或第二运行时。新的专用候选模型只在 [已确定的显式请求边界](../plans/terminal-prediction/2026-11-13-v1.0-输入与建议边界.md)内评测，不自动介入按键链路。
