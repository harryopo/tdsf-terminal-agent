# 调研报告：2025-2026 年最新 AI Agent 架构能力全景 + DeepSeek Harness 深度解析

> **调研日期**：2026-08-28
> **调研目的**：为本项目（TDSF Terminal Agent，Tauri 2 + React 19 + Python sidecar 的桌面终端 IDE）的 agent 模块演进提供架构参考。每项能力附"成熟度"与"是否适合桌面终端 IDE 场景借鉴"判断。
> **方法**：全网搜索 + 上游 GitHub 仓库/文档交叉验证；信息来源 URL 与发布时间随文标注。

---

## 目录

- [第一部分：DeepSeek Harness（DSH）深度解析](#第一部分)
- [第二部分：2026 现代Agent 所需能力清单（10 项）](#第二部分)
- [第三部分：对本项目 agent 模块的综合建议](#第三部分)

---

<a name="第一部分"></a>
# 第一部分：DeepSeek Harness（DSH）深度解析

## A1. 项目确认：真实存在

| 项目 | 结论 |
|------|------|
| **是否真实存在** | ✅ 真实存在，是 DeepSeek 官方开源项目 |
| **GitHub 仓库** | `deepseek-ai/deepseek-harness`（npm 包：`@deepseek-ai/dsh`） |
| **发布时间** | 2026-08-13（Developer Preview） |
| **许可证** | MIT |
| **当前版本** | 0.1.0-rc.5（官方明确提示后续会有破坏性兼容变更） |
| **伴随发布** | DeepSeek-V4-Pro GA 同期发布（官方基准：DeepSWE +49.9 分、Cybergym +30.6 分） |
| **启动方式** | `npx @deepseek-ai/dsh web` → `http://127.0.0.1:3080`（Web UI 含 Session 创建、工具调用轨迹查看、模型/权限/Agent Preset 配置） |

**来源**：
- AI Tools Review《DeepSeek Harness: Open-Source Claude Code Rival》，2026-08-15：https://aitoolsreview.co.uk/insights（含 V4-Pro 定价结构分析——峰谷定价实为变相涨价）
- DataLearner《DeepSeek Harness 深度解析》，2026-08-15：https://www.datalearner.com/blog_list（基于 2026-08-15 公开仓库分析）
- CSDN《Everything is a Plugin 如何重构 Agent 运行时》，2026-08-18：https://blog.csdn.net/weixin_44262492/article/details/163862955

**业界反响**：评价两极——有人认为易用性差、实用价值有限；但 Flask 作者 / Pi 开发主导者 Armin Ronacher 公开表示"这是第一次在该领域看到新东西，有必要回头重新审视自己团队的一些选择"。说明 DSH 的价值主要在**架构思想**而非即用性。

## A2. 定位：不是又一个 Coding Agent，而是 Agent Runtime Framework

业界产品（Claude Code、Codex、OpenCode、Pi）的共同形态是：先有一个固定的 Agent Runtime，再向外暴露 Tool/MCP/Skill/Plugin 扩展点。DSH 往下再退一层：**它不预设 Agent 应该长什么样，而是提供"组合和运行 Agent Runtime 本身"的框架**。

```
DeepSeek Harness
 │
 Runtime Composition（运行时组合）
 │
 ┌─────────────┼─────────────┐
 Model       Session       Tools
 │             │             │
 Agent Loop  Persistence   Sandbox
 │
 Subagent
```

一个运行中的 DSH 是**从空插件树开始**，由 Bundle、Profile、用户 Patch、命令行 Overlay 逐层组合出来的；`dsh --profile web --dump-config` 可在启动前直接看到最终生成的完整 Plugin Tree。Coding Agent 只是这种组合能得到的一种结果，不是唯一预设。

## A3. 四大核心架构设计

### 3.1 Everything is a Plugin：插件化的是 Runtime 本身（基于 Cordis 微内核）

- 别家也有插件，但都是"Agent Core 固定 + Tool/MCP/Plugin 挂载"模式；DSH 基于 **Cordis**（Koishi 生态的微内核依赖注入框架）做到了**无特权内核**——包括 Model Adapter、Tool Registry、Session Log、Agent Loop 本身在内，"产品的每个部分都是插件"。
- 组装机制三层：**Profile**（预设组合，如 `web`/`cli`）→ **Bundle**（功能包）→ **Patch/Overlay**（用户覆写），层层叠加成最终插件树。
- **判断**：思想极具前瞻性（Codex 0.146.0 的 Agent Plugins 1.0 是同方向但更保守的实现），但对本项目——保留 terax 的固定 App 架构、插件化只做到"agent 工具/技能层"即可，Runtime 全插件化收益低、复杂度极高。**架构思想值得借鉴，实现形态不适合照搬。**

### 3.2 Model-visible means logged：模型请求必须可重建（事件源会话）

- 不只是"保存历史"，而是强约束：**任何进入模型上下文的内容必须可从持久化日志重建**。Session Log 是事件源（event-sourced），Turn → Step → Tool Call 层层记录，事后可完整回放、diff、审计"模型当时到底看到了什么"。
- 上下文压缩（compaction）不是删历史：压缩产物本身也是事件，原事件保留，压缩只改变"下一轮采样时注入的视图"。
- **判断**：⭐ 对本项目**高度适用**——AI 面板的会话日志若按事件源设计，可同时支撑：调试（复现幻觉/错误工具调用）、回放（教学场景"复盘 AI 操作过程"正是教学终端 IDE 的卖点）、审计与 token 统计。实现成本低（append-only JSONL 即可起步）。

### 3.3 Capability Seam（能力缝）：一个能力拆成三个角色

DSH 把每个"能力"拆为三个可独立替换的角色（Seam = 接缝）：
1. **Provider**（提供实现，如某个沙箱引擎）；
2. **Policy**（决策是否允许，权限层）;
3. **Interface**（暴露给模型/用户的入口）。

好处：沙箱换实现不改权限逻辑；权限收紧不碰工具代码；模型入口与底层实现解耦。
- **判断**：⭐ 对本项目 agent 工具层**直接适用**——本项目已有 `src/modules/ai/tools/`，把"工具实现 / 是否允许执行（审批） / 模型可见的 schema"三层解耦，是低改动量、高回报的重构方向。

### 3.4 Subagent 被提升为正式 Runtime Capability

- Subagent 不是硬编码分支，而是一种 Provider：主 agent 通过统一调用接口派生子 agent（独立上下文窗口、独立工具集、可并发），结果结构化回灌。
- 另有 **Workflow** 概念：模型生成的"受限编排程序"——模型写一个确定性的执行计划（有类型、有校验），harness 负责执行，兼顾灵活与可控。
- **判断**：Subagent 派生模式已是 2026 年全行业标配（见 B1）；Workflow-as-generated-program 是 DSH 特色但文档尚薄，观察即可。

### 3.5 安全与沙箱：失败即关闭（fail-closed）

- 工具执行流水线：模型调用不直达系统，中间有 Policy 检查与沙箱层；**沙箱不可用时默认拒绝执行**（fail-closed），而非降级直跑。
- 明确指出插件化本身引入**供应链风险**（恶意插件），要求记录插件来源（provenance）。
- **判断**：fail-closed 原则 + 插件来源审计是权威最佳实践，本项目 agent 执行命令的审批链路应遵循（见 B7）。

### 3.6 与 Claude Code / Codex / OpenCode / Pi 的差异总结

| 维度 | Claude Code / Codex | OpenCode / Pi | **DSH** |
|------|--------------------|--------------|---------|
| Runtime | 固定核心 + 扩展点 | 固定核心 + 强扩展 | **Runtime 本身可组合** |
| 模型绑定 | 各自生态 | 模型无关 | 模型无关（Model Adapter 是插件） |
| 会话 | 保存历史 | 保存历史 | **事件源、可重建、可回放** |
| 权限/工具/实现 | 耦合 | 部分解耦 | **Capability Seam 三角色** |
| 成熟度 | 生产级 | 生产级 | **Developer Preview（0.1.0-rc）** |

---

<a name="第二部分"></a>
# 第二部分：2026 现代 Agent 所需能力清单（10 项）

## B1. Agent Loop 与编排模式

**2026 年共识模式清单**：

| 模式 | 说明 | 代表实现 |
|------|------|---------|
| **ReAct 循环** | 思考→行动→观察的基础闭环 | 所有框架的基本盘，已完全成熟 |
| **Planner-Executor** | Plan 模式（只读规划产出可编辑计划文件）+ 执行分离 | Claude Code Plan Mode（2025 年中起）、OpenCode Plan/Build Agent（tab 切换）、Gemini CLI v0.34.0（2026-03-17）将 Plan 设为**默认** |
| **Subagent 派生** | 主 agent 派生带独立上下文的子 agent，防主上下文污染 | Claude Code 2025-07 首创（`~/.claude/agents/` 自定义 Markdown agent 定义成为行业抄的格式）；Codex CLI 2026-03-16 GA 线程分叉 subagent；Gemini CLI 2026-04 跟进 |
| **Agent-as-Tool** | 把另一个 agent 当工具调用 | LangGraph subgraph、Mastra agents-as-tools |
| **Supervisor-Workers** | 协调者路由任务给专家，消息全经协调者 | `langgraph-supervisor`（token 成本高、控制强） |
| **Swarm/Peer-to-Peer** | agent 间直接握手移交控制权 | `langgraph-swarm`（token 省、需清晰专长边界） |
| **并行 Fan-out** | git worktree 并行会话 | Claude Code（worktree sessions）、Cursor Composer（最多 8 个）、Codex（goal mode） |

**重要行业事实（2026-05 横评结论）**：四大编码 CLI（Claude Code / Codex / Gemini CLI / OpenCode）已**趋同到相同的基本原语**——子 Agent + 上下文隔离、Plan 模式、ask-user 工具、并行执行、沙盒、记忆与技能、MCP、审批门禁。看发布新闻时，正确问题不再是"是不是新东西"，而是"**这个实现与其他家相比如何**"。
来源：wangjun.dev《Claude Code vs Codex CLI vs Gemini CLI vs OpenCode：趋同后的真实差异》，2026-05-12：https://www.wangjun.dev/2026/05/claude-code-vs-codex-vs-gemini-vs-opencode/

**判断**：ReAct + Plan/Execute + Subagent 派生 = 成熟度 ★★★★★，是 2026 年 agent 的"底盘三件套"。
**桌面终端 IDE 适配**：⭐⭐⭐⭐⭐ Subagent（如"日志分析 subagent""巡检 subagent"）+ Plan 模式（先只读收集终端/文件树信息再动手）非常适合本项目的运维教学场景；多 agent 编排框架（LangGraph 级别）对本项目过度，**自研轻量 loop + subagent 派生即可**（DSH 与 Claude Code 都证明这不需要重型框架）。

## B2. 上下文工程（Context Engineering）

2025-2026 年从"提示词技巧"升级为**工程学科**，Anthropic 总结的五大策略成为事实标准：

| 策略 | 做法 | 成熟度 |
|------|------|--------|
| **Offload（外置）** | 中间结果写文件/外部存储，上下文只留引用 | ★★★★★ |
| **Reduce（压缩/Compaction）** | 接近窗口上限时把旧对话摘要折叠（Codex 在每轮 turn 前预压缩；DSH 压缩产物也是可回放事件） | ★★★★★ |
| **Retrieve（按需检索）** | 不预塞全部知识，工具化检索 | ★★★★★ |
| **Isolate（隔离）** | Subagent 独立上下文，结果摘要回灌 | ★★★★★ |
| **Cache（缓存）** | Prompt 前缀缓存降本提速（各家 API 原生支持） | ★★★★☆ |

**结构化记忆**：CLAUDE.md / AGENTS.md **层级指令**已成跨工具标准（Codex `project_doc.rs` 实现了 Global → Project → Directory → 显式指令四级，向上找 `.git` 定根、从根向 CWD 逐级拼接、深层覆盖浅层；DSH 的 Skills 也是按需注入上下文的过程知识）。

**Session 持久化**：LangGraph checkpoint（每 superstep 存档，v1.2 alpha 引入 DeltaChannel 增量存储降开销）代表"崩溃可恢复、可暂停等人、可 time-travel"的方向。

**来源**：Anthropic 工程博客（context engineering五大策略，2025 下半年起）；Codex 架构解析（leo-li-opus/coding-agent research.md，2026-03-06：https://github.com/leo-li-opus/coding-agent/blob/main/research.md）；ChatForest LangGraph 评测（v1.1.10，2026-05-06：https://chatforest.com/reviews/langgraph-python-agent-framework/）

**判断**：★★★★★ 全部成熟。
**桌面终端 IDE 适配**：⭐⭐⭐⭐⭐ 直接可用——① 会话 compaction（本项目 sidecar 已有对话历史，加摘要折叠即可）；② 把"当前终端画面摘要 / cwd / SSH 主机信息"作为结构化上下文注入（而非全量终端滚动缓冲）；③ AGENTS.md 式项目说明可兼容。

## B3. 工具体系：MCP 生态

**2026 年现状**：
- MCP 从"有趣的标准"变成"**入场级集成层**"（wangjun.dev 评语）——四大 CLI、LangGraph、Codex、Gemini CLI 全部原生支持；工具集成不再是瓶颈后，行业差异化转移到了编排层。
- **工具注册/审批/沙箱**成为标配语义：工具调用前经 policy 审批（approval gates），高危操作（写文件、执行命令）必须过门禁；DSH 的 Capability Seam 把这一层显式化。
- **Parallel tool calls**：主流 API 原生支持一次返回多个工具调用并行执行（Claude/GPT 系均支持），多工具并发已是默认预期。
- **MCP 之外的边界协议分化**（DSH 文档观点）：**MCP 管工具**（模型↔工具）、**ACP 管进程间 agent 通信**、**LSP 管语言智能**——三者解决不同边界，不要混为一谈。
- **新兴标准 Agent Plugins 1.0**（agent-plugins.org）：Codex CLI 0.146.0（2026-07-29）开始解析该 manifest，标准化 skills + MCP 配置的可移植打包；hooks/权限/子 agent 仍是各 host 私有扩展层。
  来源：rohitai.com《Codex CLI 0.146.0 Moves the Agent Boundary Out of the Terminal》，2026-07-29：https://rohitai.com/blog/openai-codex-cli-agent-plugins-remote-code-mode

**判断**：★★★★★ 生态成熟。
**桌面终端 IDE 适配**：⭐⭐⭐⭐ 本项目 sidecar 层可做 **MCP Client**（接入生态工具），自研工具（终端执行、SFTP、翻译）保持原生并套"审批+沙箱"语义；MCP Server 暴露本项目能力给别人用 = 可选项，非必需。

## B4. 知识库与 RAG

- **Agentic RAG** 已取代朴素 RAG 成为 2026 主流：检索不再是固定管线，而是 agent 在多步推理中**动态决定**查不查、查什么、查几轮、够不够答（LangGraph 官方教程已内置 agentic RAG 模板：https://langgraph.com.cn/tutorials/rag/langgraph_agentic_rag/）。
- **技术栈现状**：embedding 模型（OpenAI text-embedding 系列 / 开源 BGE、Qwen-Embedding 国产可用）+ 向量库（pgvector/Qdrant/Milvus/本地 sqlite-vec）+ **混合检索**（BM25 关键词 + 向量语义 + RRF 融合 + rerank）。
- 混合检索 + rerank 对专有名词/命令名/短查询（终端场景典型 query）收益显著——纯向量检索对 `systemctl status sshd` 这类精确 token 查询容易失手。

**判断**：★★★★☆ 成熟但工程细节仍需打磨（切块、rerank、评测）。
**桌面终端 IDE 适配**：⭐⭐⭐⭐ 本项目 Linux 教学词典/教材知识库适用：**关键词+向量混合检索**是正确选择（命令名是精确 token）；本地 sqlite-vec 起步即可，避免引入向量库服务。教材/词典这类小规模知识库甚至 BM25 就够，**勿过度工程**。

## B5. Skill / 技能包模式

- **Claude Code Skills（SKILL.md 标准）** 已成事实标准：一个文件夹 + `SKILL.md`（YAML frontmatter：name/description + Markdown 正文），agent 按 description **按需加载**——平时只占一行触发描述，触发后才把完整过程知识注入上下文（"渐进披露"，progressive disclosure）。
- **跨工具兼容**：Codex（`CODEX_HOME/skills/.system/`，每 skill 含 SKILL.md + agents/openai.yaml + scripts）、OpenCode（`.opencode/skills/`）、AgentSSH（仓库直接发 SKILL.md 让任何 agent 获得 SSH 能力）均已支持该格式。
- 本质：**Skill = 按需加载的过程知识**（如何做某类任务的 SOP），区别于 Tool（原子能力）与 Memory（个体事实）。DSH 同样内置 Skills。

**判断**：★★★★★ 格式成熟、生态爆发中。
**桌面终端 IDE 适配**：⭐⭐⭐⭐⭐ **最高性价比借鉴项**——本项目面向 Linux 运维教学，"教学技能包"天然契合：如 `skill:排障-ssh连不上`（含检查步骤 SOP）、`skill: SELinux 排查`（sealert/audit2allow 流程）、`skill: samba 配置`。实现一个 SKILL.md 读取器 + 按需注入即得全套生态兼容。

## B6. 记忆系统

| 模式 | 代表 | 说明 |
|------|------|------|
| **分层记忆** | **Letta（原 MemGPT）** | 核心记忆（对话窗口内）+ 归档记忆（向量库）+ 前期把记忆管理本身做成 agent 可调用的工具（self-editing memory），跨会话持久 |
| **文件即记忆** | Claude Code（CLAUDE.md/MEMORY.md）、Codex（AGENTS.md） | 人类可读可编辑的记忆文件，按层级加载 |
| **会话记忆** | LangGraph checkpoint / 各家 session store | 线程内持久 + 跨线程 store（长期事实） |
| **用户画像** | Letta / ChatGPT memory | 从交互中提炼的偏好/画像条目 |

**判断**：★★★★☆ Letta 模式成熟但偏重；文件式记忆最轻最实用。
**桌面终端 IDE 适配**：⭐⭐⭐⭐ 建议路线：**文件式记忆起步**（用户偏好/常用命令/主机清单 → 本地 md/json），叠加"历史命令成功记录统计"（本项目已有此规划，属运行记忆）。Letta 式向量化归档在记忆量大后再考虑。

## B7. 安全护栏

2026 年生产级 agent 的四层防线（各家实现趋同）：

1. **权限分级**：只读操作默认放行（读文件/grep/glob）；写操作分级审批（Plan 模式先只读产出计划文件 → 人类编辑确认 → 再执行）。
2. **人工审批（Approval Gates）**：高危工具调用前暂停等人确认；ask-user 工具成标配。企业场景"谁批准了每一步"是审计刚需。
3. **沙箱执行**：命令在沙箱跑（Codex `sandbox` 子命令、Claude Code 沙箱、Muse Code 默认 fail-closed OS 沙箱）；**DSH 原则：沙箱不可用 → 拒绝执行（fail-closed），绝不静默降级直跑**。
4. **审计**：全量工具调用日志 + 模型可见内容可重建（DSH 事件源会话是天花板实现）。

补充：插件/MCP 供应链安全（记录来源 provenance、能力声明需验证——Codex 0.146.0 发布分析反复强调）。

**来源**：同 B1/B3 各源；CSDN DSH 解析 §5（2026-08-18）；codersera（Muse Code fail-closed 默认沙箱，2026-08 更新：https://codersera.com/blog/cursor-composer-vs-claude-code-vs-codex-vs-gemini-cli-2026/）

**判断**：★★★★★ 模式成熟，四大 CLI 已趋同。
**桌面终端 IDE 适配**：⭐⭐⭐⭐⭐ **运维教学场景更该从严**（用户是学生、目标是教学服务器）：只读放行 / 命令执行必须审批 / 高危命令（rm、dd、systemctl stop）二次确认 / 命令白名单分级。fail-closed 原则直接采纳。

## B8. 可观测性

- **Tracing**：OpenTelemetry 成为默认集成目标（LangSmith/Langfuse/Arize Phoenix 等均走 OTel 协议）；LangGraph 原生 LangSmith、Mastra 原生 playground + telemetry。
- **Token 统计**：逐调用 token 计量 + 成本聚合是各家标配（codersera 横评已把 per-task cost 当对比维度）。
- **回放（Replay）**：DSH 事件源会话 = 完整回放天花板；LangGraph time-travel（从任意 checkpoint 分支重跑）是编排层回放代表。
- **评测**：SWE-bench Verified / Terminal-Bench 2.0 成为 agent 能力基准（Codex GPT-5.5：SWE-bench 88.7%、Terminal-Bench 2.0 82.0%；Claude Opus 4.7：87.6%/69.4%——见 codersera 2026-05-26 表）。

**判断**：★★★★★ 工具链成熟。
**桌面终端 IDE 适配**：⭐⭐⭐⭐ ① token 统计 UI（用户已有此需求记忆：总消耗界面要大要醒目）→ sidecar 逐请求计量即可；② 工具调用 trace 面板（展示 agent 每步"看到什么/调了什么/结果"）——教学场景"看懂 AI 怎么思考"本身就是教学价值；③ OTel 导出可缓，本地 JSONL 先行。

## B9. 代表性开源项目 2026 动态

| 项目 | 2026 动态与架构亮点 | 来源 |
|------|--------------------|------|
| **Claude Code** | 生态最深（MCP/Plugin/Skill/Subagent 齐备，`~/.claude/agents/` 格式成行业模板）；Opus 4.7 1M 上下文；`/agent-view` 会话管理；Subagent 自 2025-07 起 | wangjun.dev 2026-05-12；codersera 2026-05-26 |
| **OpenAI Codex CLI** | Rust 重写（codex-rs 50+ crates workspace，`core/src/codex.rs` ~6900 行）；GPT-5.5 默认（2026-04-23），SWE-bench 88.7% 领先；**0.146.0（2026-07-29）Agent Plugins 1.0 + Remote Code Mode（WebSocket 远程执行面）+ executor-owned skills**，从终端工具走向 agent runtime；400 万周活开发者；Chat Completions 弃用全迁 Responses API | leo-li-opus research.md 2026-03-06；rohitai.com 2026-07-29；codegateway.dev 2026-05-16 |
| **Gemini CLI** | v0.38.1（2026-04）：Plan 模式默认化（v0.34 起）+ subagent；**2026-06-18 起并入 Antigravity CLI**（Go 重写、异步多 agent、共享 Antigravity 2.0 桌面架构）；免费额度最大（1000 req/日） | wangjun.dev 2026-05-12；codersera 2026-05-26 |
| **OpenHands** | "沙箱即执行器"（sandbox-as-executor）模型被广泛引用为最佳实践；事件流架构、浏览器交互 | leo-li-opus research.md 2026-03-06 |
| **cline** | VS Code 内 agent 代表，MCP 最早支持者之一；Plan/Act 双模式 | 综合 |
| **kimi-cli** | 国产轻量终端 agent（月之暗面），Composer 2.5 即基于 Kimi K2.5 后训练 | codersera 2026-05-26 |
| **strands-agents** | AWS 开源 agent SDK，model-driven agent loop，工具生态简单 | 综合（AWS 2025 开源，2026 持续迭代） |
| **LangGraph 1.x** | 2025-10-22 v1.0 GA（与 LangChain 1.0 同发）；2026-04 v1.1.10、v1.2 alpha（DeltaChannel 增量 checkpoint）；31k+ star、34.5M 月下载；supervisor/swarm 官方包；LangChain 团队 2026-03 推出 **Fleet**（多 agent 部署） | chatforest 2026-05-06；51cto 2026-05-06；juejin 2026-06-18 |
| **Mastra** | TypeScript 原生 agent 框架（workflow/agent-as-tools/memory 内建），playground 可视化调试 | 综合 |
| **DeepSeek Harness** | 见第一部分；DSH + V4-Pro 同发，MIT 开源 | 2026-08-13/15 各源 |
| **新变量：Muse Code（Meta）** | 2026-08-05 发布，第四大终端 agent，Muse Spark 1.2（$1.25/$4.25 每 M token），**默认 fail-closed OS 沙箱** | codersera 2026-08 更新 |

## B10. 终端/SSH 运维场景的 Agent 特有能力（最佳实践）

这是与本项目最直接相关的部分。2026 年出现的"AI-native 终端基础设施"四个代表性方案：

### 10.1 AgentSSH（Rust，MIT）—— 为 agent 而非人设计 SSH
- 核心洞察：**"AI-native SSH toolkit. Not a human terminal."** 直接用 `russh`（纯 Rust async SSH）说话，单二进制 client+daemon+proxy，无 C 依赖；**所有输出结构化 JSON**（`{"ok":true,"status":"completed","exit_code":0,"stdout":"...","stderr":""}`），彻底消灭"屏幕刮取"（screen-scraping）。
- daemon 池化连接复用；SFTP 上传下载、端口转发、SOCKS5 全 daemon 托管；auth 走 JSON profile；自带 SKILL.md（agent 放进 skill 目录即获得全部 SSH 能力）。
- **对本项目**：本项目 Rust 侧已用 russh 0.61 + russh-sftp——AgentSSH 验证了这条技术路线是 2026 年公认正解；其 **"给 agent 的 SSH 调用应是结构化 JSON API 而非刮终端屏"** 的原则，直接适用于本项目 agent 的远程执行工具设计（agent 走 invoke 通道拿结构化结果，不要去解析 xterm 缓冲）。
- 来源：https://github.com/trtyr/AgentSSH（README，2026 年）

### 10.2 pTTY / tmux 会话持久化 —— 长会话抗断线
- 问题定义精确命中运维场景痛点：SSH 断线/WiFi 抖动/合盖 = Claude Code 等 agent 会话上下文全丢，重建要 15-20 分钟。
- 方案：tmux 作为服务端进程跑在**远端**，agent CLI 是其子进程；断线重连 `tmux attach` 后上下文/滚动缓冲/运行进程原样还在；Ctrl+F1~F10 十个常驻控制台。
- **对本项目**：本项目 SSH 终端若要在远端跑长任务（yum install 等），"远端 tmux 包裹"是标准解法；可作为 agent 工具（"把该命令放到远端 tmux 会话里跑"）而非改用户终端。
- 来源：https://github.com/zentala/pTTY（README，2026 年）

### 10.3 pty-mcp —— 给 agent 真 PTY 交互而非一次性 shell
- 问题：agent 在非交互 shell 里跑命令，无法处理交互式进程（需要 yes/no 确认、密码输入、进度观察、等待重启完成）。agent 只能 `sleep 30 && check` 死循环烧 token。
- 方案：MCP server 提供**真 PTY 会话**——本地 shell / SSH（密码+密钥）/ 串口（网络设备、IoT）三类；会话经 ai-tmux daemon 持久化，可 detach 后重连收结果；agent 可以"写日志、等特定事件出现再行动"。
- 定位明确写给 **sysadmin/网络工程师**——"让 AI 帮忙做真实的服务器与设备管理，而不只是生成代码"。
- **对本项目**：证明了"agent 需要交互式 PTY 而非 exec 一次性调用"这一运维刚需；本项目 agent 工具层可提供双模式：`exec`（结构化一次调用）+ `pty_session`（交互式，可发输入、可等待 pattern）。
- 来源：https://github.com/raychao-oao/pty-mcp（README，2026 年）

### 10.4 agent-ops —— 远程终端控制的 MCP + Bridge 架构
- Rust 实现：远端部署 rmux daemon，本地 MCP server + bridge，v0.4.1（2026-07-20）；PTY passthrough 支持 SGR 鼠标协议；事件驱动 exec；自带 OpenCode skill 集成；AGENTS.md 中文文档。
- **对本项目**：架构参考——"远端常驻 daemon + 本地 agent 桥"分层与本项目"Rust russh 客户端 + sidecar agent"可类比。
- 来源：https://github.com/tddh/agent-ops（2026-07）

### 10.5 团队级 agent runtime 成熟度模型（运维视角）
- habr 文章（2026-05-28）给出团队 agent runtime 五级成熟度：0 本地/个人服务器（tmux+Eternal Terminal 活连接）→ 1 小团队（OS 级权限分离：每个 agent 跑在**独立 linux 用户**下）→ 2 容器/VM 隔离 → 3 enterprise（PII/DLP/合规/可观测）。
- **对本项目**：教学场景只需 0-1 级，但"**agent 命令不要用 root 直跑、限制可写目录**"是底线建议。
- 来源：https://habr.com/en/articles/1040668/（2026-05-28）

### 10.6 终端 agent 能力清单汇总（运维场景必备）

| 能力 | 必要性 | 本项目现状映射 |
|------|--------|---------------|
| exec 一次性调用（结构化返回 exit/stdout/stderr） | ★★★★★ 必备 | 已有 invoke 通道基础 |
| 交互式 PTY 会话（可发输入/等 pattern/detach 重连） | ★★★★☆ 运维刚需 | SSH PTY 已有，需给 agent 暴露受控接口 |
| 远端会话持久化（tmux 包裹长任务） | ★★★★☆ | 可作为 agent 工具新增 |
| cwd/环境感知（agent 知道"现在在哪台主机哪个目录"） | ★★★★★ | OSC 7 cwd 同步已有，需喂给 agent |
| 输出结构化（不刮屏） | ★★★★★ | agent 走独立通道，勿解析 xterm |
| 审批门禁（高危命令拦截确认） | ★★★★★ | 待建（B7） |
| 会话日志可回放 | ★★★★☆ | 待建（B2/B8） |

---

<a name="第三部分"></a>
# 第三部分：对本项目 agent 模块的综合建议（按性价比排序）

结合项目现状（terax-ai v0.8.6 魔改基线、Python sidecar、russh SSH、教学运维场景）：

1. **Skill 模式（B5）**——实现 SKILL.md 读取器 + 按需注入，直接兼容 2026 事实标准生态；教学 SOP 技能包（排障/配置/安全）是产品差异化核心。⭐ 最高优先
2. **Agent 工具三角色解耦（B1/B7/DSH Capability Seam）**——工具实现 / 审批策略 / 模型 schema 分离；命令执行类工具强制审批门禁 + fail-closed。⭐ 安全底线
3. **事件源会话日志（B2/B8/DSH）**——append-only 记录每轮模型可见上下文与工具调用，一步到位支撑调试/回放/审计/教学复盘。⭐ 低成本高回报
4. **SSH 双模式执行工具（B10）**——`exec` 结构化调用（复用 russh）+ 受控 `pty_session`（复用现有 SSH PTY）；agent 结果走 invoke 通道不刮屏。⭐ 与现有架构天然契合
5. **Subagent 派生（B1）**——轻量实现（独立上下文 + 工具子集 + 摘要回灌），用于日志分析/巡检/批量检查。
6. **Compaction + token 计量（B2/B8）**——会话摘要折叠 + 逐请求 token 统计进 UI。
7. **混合检索知识库（B4）**——教材/词典 BM25 起步，规模大后加向量。
8. **暂不做**：Runtime 全插件化（DSH 形态）、重型编排框架（LangGraph 级）、MCP Server 暴露、Letta 式向量化记忆——观察即可，避免过度工程。

---

## 附：主要信息来源汇总（URL + 时间）

| 来源 | 时间 | 主题 |
|------|------|------|
| https://aitoolsreview.co.uk/insights | 2026-08-15 | DSH 发布事实（MIT/0.1.0-rc.5/V4-Pro） |
| https://www.datalearner.com/blog_list（DSH 深度解析） | 2026-08-15 | DSH 四大架构设计 |
| https://blog.csdn.net/weixin_44262492/article/details/163862955 | 2026-08-18 | DSH Cordis/事件源/沙箱/Workflow |
| https://www.wangjun.dev/2026/05/claude-code-vs-codex-vs-gemini-vs-opencode/ | 2026-05-12 | 四大 CLI 能力趋同事实 |
| https://github.com/leo-li-opus/coding-agent/blob/main/research.md | 2026-03-06 | Codex rust 架构/OpenHands/DeepAgents 深评 |
| https://www.codegateway.dev/en/blog/openai-codex-cli-complete-guide-2026 | 2026-05-16 | Codex 2026 全貌（GPT-5.5/4M 周活） |
| https://rohitai.com/blog/openai-codex-cli-agent-plugins-remote-code-mode | 2026-07-29 | Codex 0.146.0 Agent Plugins 1.0 |
| https://codersera.com/blog/cursor-composer-vs-claude-code-vs-codex-vs-gemini-cli-2026/ | 2026-05-26（8 月更新） | 基准分数/Antigravity/Muse Code |
| https://chatforest.com/reviews/langgraph-python-agent-framework/ | 2026-05-06 | LangGraph 1.x 架构/版本 |
| https://blog.51cto.com/u_12902/14582439 | 2026-05-06 | 2026 框架选型格局（含 Fleet） |
| https://juejin.cn/post/7652023427512287282 | 2026-06-18 | LangChain/LangGraph 1.0 双发布溯源 |
| https://langgraph.com.cn/（官方中文文档） | 持续 | agentic RAG 模板/持久化/记忆 |
| https://github.com/trtyr/AgentSSH | 2026 年 | AI-native SSH 工具包 |
| https://github.com/zentala/pTTY | 2026 年 | tmux 持久会话抗断线 |
| https://github.com/raychao-oao/pty-mcp | 2026 年 | agent 交互式 PTY MCP |
| https://github.com/tddh/agent-ops | 2026-07 | 远程终端 MCP+Bridge（v0.4.1） |
| https://habr.com/en/articles/1040668/ | 2026-05-28 | 团队 agent runtime 成熟度 |
| https://agent-plugins.org/specification | 2026 年 | Agent Plugins 1.0 规范 |

> **报告完** · 调研执行：Trae 子代理 · 2026-08-28
