# 模块与改动影响

| 入口 | 用途与需要一起检查的范围 |
|---|---|
| [前端 App](../../src/app/App.tsx) | 工作区与界面装配；检查活动标签页、连接、文件树和聊天作用域 |
| [终端模块](../../src/modules/terminal/) | 渲染池、会话、命令块和输入；同时检查 OSC、编辑/粘贴、取消和真实回显 |
| [预测模块](../../src/modules/prediction/) | 新候选的上下文、状态与规则；属于候选开发，不冒充成熟生产合同 |
| [AI 模块](../../src/modules/ai/) | 对话状态、传输、工具卡、审批与置信度浮窗 |
| [Rust 入口](../../src-tauri/src/lib.rs) | 命令注册、插件、进程与应用生命周期；前端调用名要与注册点匹配 |
| [Rust 模块](../../src-tauri/src/modules/) | PTY、SSH、文件后端、sidecar 等系统能力 |
| [Sidecar 主程序](../../src-tauri/sidecar/main.py) | stdio 协议、调度与就绪；检查 Rust 进程和健康状态 |
| [Agent 门面](../../src-tauri/sidecar/agent_facade.py) | 稳定的 Agent RPC 门面与 Strands 入口 |
| [Strands 实现](../../src-tauri/sidecar/strands_backend/) | 模型适配、钩子、限制、重试与执行调度 |
| [工具](../../src-tauri/sidecar/tools/) | 工具实现与策略；检查真实注册、审批和单次证据归属 |
| [实验](../../experiments/) | 隔离回放/原型；未整合的实验不等于生产能力 |
| [官网](../../website/) | 宣传站点；产品演示、版本与能力描述需与事实一致 |

删除或修改接口前先找调用者、字符串注册、测试和配置，不以“没搜到一个函数名”证明代码无用。
