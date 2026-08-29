# Tasks — add-agent-trust-modes（三模式信任体系与教学特色）

> 对应方案书 v3.1.2 的 A1-A5 + B1-B2；顺序按依赖排列，标注可并行项。
> 每个任务完成后跑该任务相关测试；Task 1 完成后跑一次全量门禁。

## A 线：三模式核心

- [x] Task 1: 后端模式层（A1）——三模式状态机与权限映射
  - [x] 1.1 定义 `AgentMode = observe|confirm|auto` 枚举（sidecar 侧新模块 `strands_backend/modes.py`），`agent.invoke` 传参接入（main.py 参数透传 + 缺省 confirm 降级日志）
  - [x] 1.2 在 `core/decision_engine.py` 增加 `decide(risk, mode) → allow|confirm|deny` 纯函数（矩阵：观察=只读allow/其余deny；确认=L0-L1 allow、L2-L4 confirm；自动=L0-L2 allow、L3/L4 confirm），单元测试全格覆盖（含 L4 永远确认）
  - [x] 1.3 工具集过滤接入：观察模式下按 `ToolPolicy.readonly` 裁剪 schema（复用现有 L1 只读过滤路径），单测断言"观察模式 schema 无写工具"
  - [x] 1.4 模式感知 main prompt：`_MAIN_SYSTEM_PROMPT` 拆三段模式指令按 mode 拼接；teach 教学契约（结构化输出概念→示例→易错点→练习）迁为 `_TEACH_SKIN_PROMPT`，Teach 开关布尔经 invoke 传入拼装
  - [x] 1.5 **BREAKING** 删除委派机制：`_SUB_AGENT_SPECS`（adapter.py:525）、`Agent.as_tool()` 包装、子 agent 双缓存、`_MAIN_SUB_AGENT_PROMPT` 委派指令段；grep 全部引用清理；`test_e2e_strands.py`（工具集 24→收敛后数量）与相关测试删除/改写
- [x] Task 2: 前端模式 UI（A2）——依赖 Task 1
  - [x] 2.1 `agents/registry.ts` 收敛：`TdsfAgentId` 收窄为 `"main"`，`TDSF_AGENTS` 移除 4 子入口，`isTdsfAgent`/路由分支同步（相关测试改写）
  - [x] 2.2 模式切换器组件（三档 segmented control + Teach 开关）挂 AI 面板 composer；per-session 持久化（chatStore），重启恢复上次选择
  - [x] 2.3 `AgentStatusPill` 改造为模式指示（观察/确认/自动/教学四态视觉，无 agent 切换动画）；invoke 调用链透传 mode+teach
- [x] Task 3: 审批卡与双轨反馈（A3）——依赖 Task 1
  - [x] 3.1 审批卡四层卡面：`needs_you.py` request_approval 载荷扩展（semantic/explanation/impact/risk_level 字段）；前端 `tool.tsx` 审批卡渲染四层 + 三按钮（⚡本会话只读免审仅 ≤L1 显示；L3/L4 无批量/永久选项）
  - [x] 3.2 双轨反馈：用户拒绝→"用户拒绝了此操作"+附言回传（可替代方案）；引擎拦截→command_blocked 魔法关键字（复用 B1 防伪造条款，拦截类禁替代方案）；流式 partial 预览（命令生成中先渲染卡）
  - [x] 3.3 host 校验（执行目标主机 ≠ 激活终端主机时拦截提示）+ 5 分钟超时 fail-closed（超时拒绝+通知+留待办，复用/扩展 needs_you 现有回收机制）
- [x] Task 4: 影响预测引擎（A4）——依赖 Task 1（可与 Task 2/3 并行）
  - [x] 4.1 新增 `strands_backend/tools/command_impact.py`：复合命令拆解器（`;`/`&&`/`||`/管道逐段）+ 影响类别映射（装包/改配置/重启服务/删除/网络外联/未知）+ 对象提取 + L0-L4 输出；单测覆盖 `echo x; rm -rf /tmp/a` 拆解、未知脚本标注"影响未知"
  - [x] 4.2 拆解器接入审批卡 impact 字段（Task 3 卡面消费）与 `decide()` 输入（逐段取最高风险）
- [x] Task 5: 免确认记忆（A5）——依赖 Task 1、3
  - [x] 5.1 会话级记忆：⚡只读免审标志（内存）+ 相似命令前缀免批（Warp 模式）
  - [x] 5.2 项目白名单：allow/ask/deny 规则存储（sidecar 配置持久化）+ 前缀/通配匹配器（最后匹配优先；危险构造 `$()`、反引号、`&&` 链、重定向、eval 永不自动放行）+ RPC（memory.whitelist.*）
  - [x] 5.3 设置 UI：白名单查看/增删/撤销界面；deny 硬底线内置 denylist 任何模式不可绕（单测：deny 压倒白名单与自动模式）

## B 线：终端感知与可视教学（教学特色，建议 Task 1 稳定后启动；B1 先于 B2）

> ⚠️ B 线触碰 SSH/PTY 链路：每步改动前 grep 全部调用点，完成后实测 SSH 终端 + 翻译选词 + 文件树联动（红线 9）。

- [x] Task 6: 终端感知上下文（B1，§4.7）
  - [x] 6.1 SSH 方案 A 注入脚本补齐：`session.rs` 注入扩展 OSC 133 A/B/C/D + 633;E/P（幂等 guard / `$- == *i*` 交互检查 / PROMPT_COMMAND 保序 / 孤儿 D 状态机 / rc 末尾），与本地 `agent_detect.rs` 解析统一
  - [x] 6.2 前端 block 流水账：`registerOscHandler(133/633)` + `registerMarker(0)` 建 block `{command, cwd, exit_code, duration_ms, author, output_tail}`（visible 注入的命令打 author=agent）；新 store + 单测
  - [x] 6.3 上下文注入升级（transport.ts + sidecar）：`<environment>`（os-release/内核一次性探测 + 会话级缓存 RPC）+ `<terminal-history>`（最近 N block，截断 + 脱敏 + token 预算）XML 分区模板；验证 agent 能答"刚才哪步失败了"与 apt/yum 因地制宜
- [x] Task 6.5: 审批卡前端接线闭环（Task 3 集成点）——把 ToolApprovalCard 接入 AiChat 实际渲染链路 + needs_you.respond RPC 回传 + ⚡→会话免审闭环
- [x] Task 7: 可视教学打字机（B2，§4.8）——依赖 Task 6（block 状态机做 133 门控）
  - [x] 7.1 Rust `human_type` pump（pty + ssh channel 双端）：Weibull 算法（alpha·(-ln U)^(1/shape) + alpha_eow + min/max 截断 + 首字符零延迟，~30 行）+ 8 项注意事项逐条落（清行等 133;A / 只发可打印字符+`\r` / 含 `!` 告警 / 密码场景降级整段 / 用户按键停 pump / 等上条 133;D / 背压处理 / >200 字符建议整段）；单测算法分布与过滤规则
  - [x] 7.2 开关与滑杆 UI：逐字/整段开关 + 速度滑杆（0.2×~5×，alpha 等比缩放）放设置页 + AI 面板快捷切换；确认模式批准后按开关走 human_type 或 write_all
  - [x] 7.3 打断与交接：演示中任意用户按键 → 停 pump 交还控制权（"演示中"状态条提示）

## 收尾

- [ ] Task 8: 全量门禁 + 收尾三件事
  - [ ] 8.1 pytest / vitest / tsc / lint / build:web / cargo check 全绿
  - [ ] 8.2 tauri:dev 桌面实测 spec §验收门禁 + 方案书 §7 验收清单 1-8 项
  - [ ] 8.3 git commit + DEV-JOURNAL 复盘 + ROADMAP/dev-state 更新

# Task Dependencies

- Task 2 依赖 Task 1（mode/teach 传参契约）
- Task 3 依赖 Task 1（decide 映射与审批触发点）
- Task 4 依赖 Task 1（判定挂点）；与 Task 2/3 可并行
- Task 5 依赖 Task 1、3
- Task 6 相对独立（可与 A 线 Task 2-5 并行）
- Task 7 依赖 Task 6（block 状态机做 133 门控）与 Task 1（模式批准触发）
- Task 8 最后
