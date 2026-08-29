# Agent 三模式信任体系与教学特色增强 Spec（方案书 v3.1.2）

> change-id: `add-agent-trust-modes`
> 上游准绳：`docs/agent/方案书-v3.1-三模式信任体系与Agent收敛.md`（v3.1.2，七项决策 D1-D7 已拍板）
> 本 spec 把方案书转为可实施验收的需求规格；实现细节以方案书为准，冲突时以方案书为裁决。

## Why

当前 agent 采用"main + 4 静态子 agent（teach/coding/explore/history）"委派模式，意图路由靠 LLM 猜测、信任边界在模型手里而非用户手里、三个子 agent 能力是 main 的真子集（鸡肋委派开销）。同时教学场景缺少两大特色：agent 感知不到终端历史与系统环境（无法因地制宜），agent 执行命令对用户不可见（无法教学演示）。本 spec 落地方案书 v3.1.2：**观察/确认/自动三模式信任体系 + 教学皮肤 + 终端感知 + 可视教学打字机**。

## What Changes

- **新增 AgentMode 三模式**（observe/confirm/auto）随 `agent.invoke` 传参；模式 × RiskChecker 风险分级映射矩阵控制执行放行/审批/拒绝
- **新增教学皮肤**（Teach 开关叠加：教学 prompt + TeachCard 输出契约，不占独立档位）
- **BREAKING：移除 4 子 agent 委派机制**（`_SUB_AGENT_SPECS`/agent-as-tool/子 agent 缓存；前端 5 agent 入口收敛为 main + 模式切换器；teach 契约迁教学皮肤）
- **新增审批卡四层信息架构**（动作语义描述 → 命令原文 → LLM 用途解释 → 影响预测）+ 三按钮组（拒绝可附言 / ⚡本会话只读免审 / 执行）+ 双轨反馈（用户拒绝可协商 vs 引擎拦截 command_blocked 如实报告）+ host 校验 + 5 分钟超时 fail-closed
- **新增影响预测引擎**（Sidecar 复合命令拆解逐段判定 → 影响类别/对象/L0-L4 色带；解析不了显式"影响未知"）
- **新增免确认记忆三级**（会话级只读免审不落盘 / 项目白名单 allow-ask-deny 前缀规则可管理 / deny 硬底线任何模式不可绕）
- **新增终端感知上下文**（SSH 注入脚本补齐 OSC 133 全套 + 633;E/P；前端 block 流水账 command/cwd/exit/duration/author；上下文注入升级为 `<environment>` + `<terminal-history>` XML 分区模板）
- **新增可视教学打字机**（Rust 写入端 human_type pump，expect send_human Weibull 算法；速度滑杆 0.2×~5×；逐字/整段开关；8 项安全注意事项落地）

## Impact

- Affected specs: `add-b1-agent-safety-baseline`（防伪造条款被双轨反馈复用与强化，无冲突）
- Affected code:
  - Python Sidecar：`strands_backend/adapter.py`（委派移除+模式层）、`strands_backend/tools/registry.py`（policy 消费）、`core/decision_engine.py`（decide 映射）、`needs_you.py`（审批卡载荷/超时）、新增 `strands_backend/tools/command_impact.py`（影响预测）、`main.py`（invoke 传参）
  - Rust：`modules/ssh/session.rs`（方案 A 脚本补 133/633）、`modules/pty/`（human_type pump + agent_detect 扩展 633）、新增 `modules/agent_exec/` 或 pty 内 human_type 模块
  - 前端：`modules/ai/agents/registry.ts`（收敛）、`store/chatStore.ts` 或 composer（模式切换器）、`components/ai-elements/tool.tsx`（审批卡）、`lib/transport.ts`（上下文注入升级）、新增 block 流水账 store
  - 测试：`test_e2e_strands.py`、`test_registry.py`、transport.test.ts、registry.ts 相关测试同步

## ADDED Requirements

### Requirement: 三模式状态与传参
系统 SHALL 定义 `AgentMode = observe | confirm | auto`，随 `agent.invoke` JSON-RPC 传参下发 sidecar；缺省缺字段时默认 `confirm`（中间态最安全）。模式为会话级状态，前端可随时切换即时生效。

#### Scenario: 老会话兼容
- **WHEN** 前端发起 invoke 未携带 mode 字段
- **THEN** sidecar 按 confirm 模式执行且记录一次降级日志

#### Scenario: 模式即时切换
- **WHEN** 用户在 AI 面板切换模式后发送新消息
- **THEN** 本次 invoke 使用新模式，无需重启或新建会话

### Requirement: 模式 × 风险映射矩阵
系统 SHALL 实现 `decide(risk: L0-L4, mode: AgentMode) → allow | confirm | deny`：
- 观察：只读工具 allow；一切写/执行类（含 L0-L1）deny（fail-closed + 如实报告）
- 确认：只读 allow；L0-L1 allow；L2-L4 confirm（逐条审批）
- 自动：L0-L2 allow；L3 confirm；L4 confirm（永远确认）

#### Scenario: 观察模式拒绝写操作
- **WHEN** 观察模式下 agent 尝试调用执行类工具
- **THEN** 调用被拒绝，agent 收到 command_blocked 语义反馈并向用户如实报告"只读模式下未执行"

#### Scenario: 自动模式 L3 升级
- **WHEN** 自动模式下 agent 执行 `systemctl restart nginx`（L3）
- **THEN** 弹出审批卡等待人工确认，不静默执行

#### Scenario: L4 永远确认
- **WHEN** 自动模式下 agent 执行 `rm -rf /tmp/x`（L4）
- **THEN** 仍弹出审批卡；无任何模式/白名单可绕过

#### Scenario: 观察模式 schema 级隔离
- **WHEN** 观察模式构建 main agent 工具 schema
- **THEN** schema 中不存在任何 readonly=False 的工具（LLM 无法调用不存在的工具）

### Requirement: 教学皮肤
系统 SHALL 提供 Teach 布尔开关叠加在任意模式上：开启时 main 的 system prompt 拼入教学契约（结构化输出"概念→示例→易错点→练习"），前端按 TeachCard 契约渲染。教学皮肤不改变权限矩阵。

#### Scenario: 教学皮肤输出
- **WHEN** Teach 开启 + 观察模式下用户问"讲讲 systemd"
- **THEN** 输出为 TeachCard 结构化教学内容，且 agent 保持只读能力

### Requirement: 审批卡四层信息架构
确认/自动升级弹出的审批卡 SHALL 自上而下展示：①动作语义描述（三态文案：想运行/正在运行/已运行）②命令原文（代码块，永不改写）③LLM 用途解释（一两句；缺失时降级"（无解释）"不阻塞）④影响预测（类别标签 + 对象 + L0-L4 风险色带，来自规则引擎解析）。

#### Scenario: 完整审批卡
- **WHEN** 确认模式下 agent 请求执行 `systemctl restart nginx`
- **THEN** 卡面同时含语义描述、命令原文、解释（如"会短暂中断 HTTP"）、影响预测（服务重启·L3）

### Requirement: 审批三按钮与双轨反馈
审批卡 SHALL 提供三按钮：【拒绝】（可附言 feedback，agent 收到"用户拒绝"+附言，可给替代方案）/【⚡批准且本会话只读免审】（仅 ≤L1 命令显示，会话内存不落盘）/【▶执行】。L3/L4 命令不显示任何"批量/永久/本会话"选项。引擎拦截（deny）与用户拒绝 SHALL 双轨：拦截走 command_blocked 如实报告禁替代方案（对齐 B1 防伪造）。

#### Scenario: 拒绝附言换方案
- **WHEN** 用户拒绝并附言"太危险，用 reload"
- **THEN** agent 收到拒绝+附言，提出 `nginx -s reload` 替代方案

#### Scenario: 引擎拦截如实报告
- **WHEN** deny 规则命中 `rm -rf /`
- **THEN** agent 收到 command_blocked 反馈，必须如实报告未执行且不得编造结果

### Requirement: host 校验与超时
执行前 SHALL 校验命令目标主机与当前激活终端会话主机一致，不一致拦截提示。审批请求 SHALL 有 5 分钟显式超时：超时 = fail-closed 拒绝 + 通知 + 留待办记录。

#### Scenario: 超时保护
- **WHEN** 审批卡 5 分钟无响应
- **THEN** 该次调用按拒绝处理，agent 如实报告，用户收到通知

### Requirement: 影响预测引擎
Sidecar SHALL 新增命令拆解器：复合命令（`;`/`&&`/`||`/管道）逐段判定影响类别（装包/改配置/重启服务/删除/网络外联/未知）+ 提取对象（包名/路径/服务名）+ 输出 L0-L4。判定必须来自规则解析而非 LLM；无法解析的段落显式标注"影响未知——请人工审查"。

#### Scenario: 复合命令拆解
- **WHEN** 审批卡收到 `echo x; rm -rf /tmp/a`
- **THEN** 拆解为两段，第二段判定删除类并标注 L4

### Requirement: 免确认记忆三级
系统 SHALL 实现：①会话级（⚡只读免审 + 相似命令免批，内存不落盘）；②项目白名单（allow/ask/deny 三元 + 前缀/通配规则，持久化，设置 UI 可查看/增删/撤销）；③deny 硬底线（内置 denylist 永远最高优先，任何模式/白名单不可绕）。匹配规则：最后匹配优先；按解析后命令前缀匹配；危险构造（`$()`、反引号、`&&` 链、重定向、eval）永不自动放行。

#### Scenario: 白名单放行与撤销
- **WHEN** 白名单加入 `systemctl status *` 后 agent 执行 `systemctl status nginx`
- **THEN** 确认模式下自动放行；用户在设置 UI 删除该规则后恢复逐条审批

### Requirement: 终端感知上下文
系统 SHALL 让 agent 感知当前 shell：①SSH 方案 A 注入脚本补齐 OSC 133 A/B/C/D + OSC 633;E（命令行文本）/633;P（cwd），含幂等 guard/交互检查/保序（健壮性清单逐条落）；②前端 block 流水账：每命令生命周期 `{command, cwd, exit_code, duration_ms, author: user|agent, output_tail}`（agent 注入的命令打 author=agent）；③上下文注入升级：`<environment>`（os-release/内核一次性探测+会话级缓存）+ `<terminal-history>`（最近 N 个 block，截断+脱敏，token 预算上限）。

#### Scenario: agent 感知刚失败的命令
- **WHEN** 用户 SSH 手动执行 `systemctl status nginx` 失败后问 agent"刚才怎么了"
- **THEN** agent 回答引用该 block 的命令与 exit code，并给出对应发行版（如 CentOS→yum）的修复方案

#### Scenario: 因地制宜
- **WHEN** agent 在 CentOS 7 会话中被要求装包
- **THEN** 使用 yum 而非 apt（依据 `<environment>` 探测缓存）

### Requirement: 可视教学打字机
Rust 写入端 SHALL 新增 human_type pump（pty + ssh channel 双端）：expect send_human Weibull 算法（`t = alpha·(-ln U)^(1/shape)` + 词尾 alpha_eow + min/max 截断 + 首字符零延迟）；远端 echo 自然形成逐字视觉，前端 xterm.js 零改动。提供逐字/整段开关 + 速度滑杆（0.2×~5×）。8 项注意事项 SHALL 逐条落地：打字前清行并等 prompt（OSC 133;A）就绪 / 只发可打印字符+`\r`（禁 `\t`、禁 bracketed-paste）/ 随机延迟禁匀速 / 含 `!` 告警、密码场景降级整段 / 用户任意按键=停 pump 交给用户 / 等上条 133;D 再注入下条 / 整段注意 russh 背压 / 超长命令（>200 字符）自动建议整段。

#### Scenario: 教学演示逐字执行
- **WHEN** 确认模式批准 `yum install httpd -y` 且开关为逐字
- **THEN** 终端中命令以随机人速逐字出现，学生全程可见；中途任意按键 agent 停止输入并交接控制权

#### Scenario: 密码场景降级
- **WHEN** 命令执行进入 sudo 密码提示（echo 关闭）
- **THEN** 打字机自动降级整段注入或交还用户，不产生视觉错乱

## MODIFIED Requirements

### Requirement: main agent 统一入口（原 4 子 agent 委派）
main SHALL 成为唯一 agent 实例：模式感知 system prompt（基础指令 + 按 mode 拼接模式指令 + 可选教学契约）；工具集 = TOOL_REGISTRY 全量 20 工具 × 模式过滤。teach 的结构化教学契约迁入教学皮肤资源；coding/explore/history 职能并入 main（工具集天然覆盖）+ T14 记忆注入。

### Requirement: 前端 agent 入口（原 5 入口注册表）
前端 SHALL 收敛为 main 常驻 + 模式切换器（三档 segmented control）+ Teach 开关 + AgentStatusPill 改造（模式指示，无 agent 切换动画）；模式 per-session 持久化。

## REMOVED Requirements

### Requirement: 4 子 agent 委派机制
**Reason**: 意图路由靠 LLM 猜不可控；coding/explore/history 工具集是 main 真子集（委派纯开销）；history 职能已被 T14 记忆注入取代；teach 契约由教学皮肤承接。
**Migration**: 删除 `adapter.py` `_SUB_AGENT_SPECS`、`Agent.as_tool()` 包装、子 agent 双缓存、委派 prompt（`_MAIN_SUB_AGENT_PROMPT` 委派部分）；删除前端 `TDSF_AGENTS` 4 个子入口与切换 UI；相关测试（test_e2e_strands 工具集断言、agents registry 测试）删除/改写。**BREAKING**：依赖子 agent 入口的 UI 与 RPC 调用一次性收敛。

## 验收门禁（全局）

pytest / vitest / tsc / lint / build:web / cargo check 全绿 + `pnpm tauri:dev` 桌面实测；B 线改动触碰 SSH/PTY 链路，须实测 SSH 终端 + 翻译选词 + 文件树联动（红线 9）。
