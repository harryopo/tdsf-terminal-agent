# TDSF Terminal Agent · 开发日志（经验沉淀）

> **用途**：每次任务收尾时追加一条记录——任务 / 方案 / 报错与修改 / 复盘（经验教训）。
> **配套**：`docs/ROADMAP.md`（短/长期规划）、`docs/dev-state.md`（进度状态，§37.x 交接章）、`docs/方案书-v1.0.md`（总纲）。
> **规范**：任务完成 → git commit → 追加本日志 → 更新 roadmap → 更新 dev-state。

---

## 2026-08-01 · P2 翻译模块重构：统一选中浮层（翻译 + Ask TDSF）

**任务**：完善翻译模块——本地/SSH 终端选词均可翻译；选中单词或代码片段可 ask agent；适配 Space 重构后的终端交互。

**方案**：
- 选中浮层（SelectionAskAi）从"仅 Ask 按钮"改为双按钮 [翻译 | Ask TDSF]，翻译按钮按开关显示
- 翻译卡片（TranslateTooltip）升级：词典 tag 徽标 + 底部「Ask TDSF 解释这段」操作
- 删除旧"退让"协调（translate-enabled/disabled/hit/miss 事件互相压制），两动作共存由用户选择
- 删除 useTranslateSelection 自动翻译 hook，翻译由浮层按钮触发（App.onTranslateSelection 查离线词典）
- 本地/SSH 终端统一走 captureActiveSelection（按 tab/leafId/sshActiveLeafId 取文本）

**报错与修改**：
- LookupResult 无 `dict` 字段 → 改用 `tag` 字段显示词典徽标
- useSelectionAskAi 残留 useRef 未用 → 移除 import（eslint）

**复盘**：
- ✅ 旧协调逻辑（事件互相压制）是"两个功能打架"的产物，合并为一个浮层后整体删除，复杂度显著下降
- ✅ 翻译与 Ask 是同一交互场景的两个动作，应共存于一个 UI 而非互相抢占
- ⚠️ SSH 终端选词的真实链路（SSH 会话中选中→浮层→翻译→Ask）待用户实测
- 📌 词典未命中是常态（代码片段），Ask 按钮是自然的兜底路径——"词典查不到就问 AI"成为产品闭环

---

## 2026-08-01 · P1 可信与安全三件套（真实落地）

**任务**：方案书 P1——HITL 审批闭环、证据链可视化、hash 审计链。用户强调"不看理想代码，要真实落地"。

**方案**：
1. **P1-1 真实审批闭环**：needs_you 加 threading.Event 等待-唤醒 + wait_for_response；高危命令 → 发审批 → 阻塞等用户 → 批准真正执行 / 拒绝返回 rejected / 30s 超时兜底；前端按钮调 needs_you.approve/reject RPC
2. **P1-2 会话证据链**：EvidenceTracker 记录真实工具调用（会话隔离、脱敏截断）；前端 AiChat 底部"证据"折叠区
3. **P1-3 hash 审计链**：sha256 前后链（prev_hash + canonical entry → hash）JSONL 落盘，verify() 检测篡改

**报错与修改（重要）**：
- **发现原审批是"显示层摆设"**：工具返回 needs_approval 后命令永不执行；前端"批准"按钮只消除本地卡片（无 RPC 回传）；事件字段名不匹配（needs_type vs type）导致卡片可能不显示——**假功能比没功能更危险**
- 测试 30s 真实等待：TestFourLevelPermission 3 用例走真实审批等待（90s）→ mock 审批等待（0.8s）
- needs_you.list_all 返回 dict 列表（非请求对象）→ 测试取 `["id"]` 而非 `.id`
- 审计链 verify 的 seq 检查误用字符串.get → 独立 expect_seq 变量
- 证据归属错误：用了 SSH session id 而非对话 session id（ctx.session_id）→ 修正

**复盘**：
- ✅ 真实落地 = 先审计现状（前端按钮是否真回传、事件字段是否对齐），再实现——"看起来有"的功能要先验证
- ✅ 审批闭环测试用真实服务 + 线程模拟用户（0.9s 完成），比全 mock 更有说服力
- ✅ 测试提速（90s→0.8s）与功能落地同等重要——慢测试会掩盖回归
- 📌 hash chain 固有限制：截断尾部不可检测（删最后记录），篡改中间可检测——文档记录边界
- 📌 审计链/证据表/事件流三者职责分离：防篡改日志 / 会话 UI 数据 / 实时推送

---

## 2026-08-01 · P0-6 Agent 全链路打通：main 统一入口 + 自主委派 + 可视化

**任务**：用户要求 main 为主对话入口，按任务自动调用子 agent；子 agent 调用可视化（参考 Terax run_subagent UI）；跑完全链路。

**方案**：
- main agent 工具集 = 7 运维工具 + 4 子 agent 工具（Strands 官方 Agent.as_tool()）
- _MAIN_SUB_AGENT_PROMPT 注入委派说明，LLM 自主识别意图委派 teach/coding/explore/history
- 子 agent 用 _SilentCallbackHandler 防文本污染；中间事件经 tool_stream/data+agent/toolResult 到达 main handler 统一转发
- 前端复用工具行管道：agent:<name> 工具卡片（徽标 + 委派输入摘要 + 折叠全文）+ Pill 联动（main→子agent→main 归位）

**报错与修改（重要）**：
- **tool_stream 事件重复触发 started（10 次）**：tool_use 每次都带 name → 按 tool_use_id 去重
- **真 bug：工具 tool-output 静默丢失**：消费循环在 invoke 已 resolve 时仍调 queue.next()——next() shift 的 item 因 race 输给 invoke 分支而永久丢失。修复：invokeResolved 预检后退出循环走 drain。**该 bug 影响所有工具，旧孤儿测试是 bug 掩盖下的假通过**
- 子 agent 的 data 增量在 tool_stream 包装内（子 agent 用静默 handler 后不到达独立 data 事件）→ 从 tool_stream_event.data.data 提取
- e2e 断言工具事件用 kwargs（emit 是关键字调用）

**复盘**：
- ✅ 事件协议用实测探针确认（打印 Strands callback handler 收到的 kwargs），不猜 API
- ✅ 子 agent 事件统一经 main handler 转发 = 单一出口，避免双份 emit
- 📌 async 消费循环的 race 竞态是隐蔽 bug 温床——"先创建 promise 再 race"的副作用（shift）要警惕
- 📌 前端管道复用（tool-input/tool-output）比新建协议更稳——agent 卡片零新协议

---

## 2026-08-01 · P0-1~P0-5 方案书落地（多 agent / 真流式 / 超时 / 降级 UI / 测试）

**任务**：方案书 v1.0 拍板后（B 方案：Strands 多 agent），P0 五项全做。

**方案**：
- P0-1：_SUB_AGENT_SPECS 注册表（main/explore/teach/coding/history 真实 Strands 实例 + 工具白名单 schema-level safety），删除关键词路由模拟
- P0-2：确认 Strands 事件流式为主路径（agent_message → text-delta），切片降级为 LangGraph 兜底
- P0-3：超时可配置——修复 Rust 硬 30s 会在前端 60s 前掐断的隐藏 bug（REQUEST_TIMEOUT 30→60s + per-request timeoutMs）
- P0-4：buildSidecarErrorHint 结构化错误提示（超时/未运行/降级/LLM 分类）+ degraded 标志
- P0-5：前端 4 文件补 25 用例 + Strands 真实 e2e（FakeModel 实现 Model 协议）

**报错与修改**：
- Strands Model 抽象方法（get_config/structured_output/update_config）+ stateful 属性 → FakeModel 补齐
- Agent 无 .tools 属性 → 用 .tool_names
- MockLLMWarning 组件测试：Tooltip 需 Provider 包裹 + 事件在 listener 注册前触发（waitForListener）

**复盘**：
- ✅ e2e 用 FakeModel（实现 Model 协议）验证真实 Strands agentic loop，比 mock Agent 强得多
- ✅ schema-level safety（工具白名单）在 agent 维度生效——explore/teach 无 ssh_command
- 📌 测试发现真 bug 的价值 > 测试本身（tool-output 丢失、Rust 超时遮蔽）

---

## 2026-08-01 · 方案书 v1.0 定稿

**任务**：用户要求基于痛点 + 调研报告制定完整方案书（不做理想化，以代码事实为基线）。

**方案**：
- 7 章结构：现状诊断（3 类痛点）/ 产品定位（人机协同运维搭档）/ 技术选型定论（Strands 单框架收敛）/ 总体架构 / 工程治理 / 路线图（P0-P3）/ 风险
- 用户拍板：B 方案（Strands 多 agent）+ P0 全做
- 上一级目录旧文档判定为 Electron 时代污染源（技术栈结论作废），仅采纳 DNA 一致思想

**复盘**：
- ✅ 方案书先诚实披露"9-Agent 未在主路径集成"的事实，再定方向——避免继续漂移
- ✅ 用户"先定方案书再实施"的顺序正确：方案书是后续所有工作的对齐基准
- 📌 文档漂移是系统性风险：方案书 = 唯一权威，竞赛材料冻结归档

---

## 2026-08-01 · P2-4 知识库完整落地（sqlite-vec + BGE + FTS5 混合检索）

**任务**：用户要求——知识库真实落地（调研发现原知识库四缺：空库/embedding 降级 hash/主路径未接入/无内容源），集成主流开源 RAG 方案，教学解释要讲 Linux 哲学。

**方案**：
- 三路调研：本地代码审计（四缺铁证）+ 上级目录（旧版已选 BGE-small-zh + sqlite-vec，选型正确可继承）+ 网上调研（11 项目对比：RAGFlow/Dify 平台化不采用，sqlite-vec 单文件零服务最适合桌面端）
- 选型：sqlite-vec（vec0 KNN）+ BGE-small-zh-v1.5（fastembed ONNX，512 维，中文优化）+ FTS5（jieba 分词）双路 RRF 融合
- 内容源四路：内置教学语料（12 条，含 Linux 哲学）自动索引 / 文档导入分块 / 会话案例沉淀（决策库雏形）/ 在线爬取
- Strands 接入：knowledge_search 工具（main/teach/history/explore），main prompt 加知识库指引

**报错与修改（重要）**：
- **rowid 不一致导致检索回查为空**：entries 表自增 rowid 与 FTS5/vec0 的确定性 rowid（md5(entry_id)）不匹配 → hybrid_search 按 rowid 查元数据全空。修复：三表统一确定性 rowid
- **fastembed 模型加载 30s 超时**：测试环境每次 add 尝试下载模型（WinError 10060）。修复：knowledge/tests/conftest.py 跳过真实模型（hash 兜底），测试 127s → 2s
- **jieba 上下文分词不一致**："php-fpm" 切分随上下文变化 → FTS5 查询偶发不命中。教训：测试用稳定词；未来可考虑 trigram tokenizer 兜底
- HF 下载超时 → HF_ENDPOINT=https://hf-mirror.com 镜像下载成功（模型已缓存 .tdsf-data/models）

**复盘**：
- ✅ 上级目录旧选型（BGE+sqlite-vec）与 2026 网上调研一致——历史调研结论可以继承，不必重复选型
- ✅ "先审计现状再实现"再次验证：空库/hash 降级这些事实不查代码永远不知道
- ✅ 三表 rowid 统一是 SQLite 混合检索的关键细节（FTS5/vec0 都要显式 rowid）
- 📌 测试隔离（conftest 跳过模型加载）是知识库测试的必备项——真实模型下载会让测试不可重复
- 📌 教学语料每条含"哲学"维度（一切皆文件/组合小工具/最小权限）——呼应"教学解释到 Linux 哲学"需求
- 📌 待办：知识库管理 UI（浏览/导入页面）、TeachCard 教学卡片渲染（P2-1）

---

## 2026-08-01 · 上级目录挖掘与继承（知识库为样例，系统性继承）

**任务**：用户指示"以知识库为例，充分挖掘上级目录内容，看能否被本项目继承优化"。

**挖掘成果**（2 个并行 agent 调研 projects/ + 旧版实现）：
- **projects/**（火山杯 TDSF-Linux 完整仓库）：decision_cards 表结构（8 态状态机/card_json 契约/FTS5/audit_logs）、risk_rules.yaml（4 级风险规则库 low19/medium10/high7/deny3）、grounding/confidence/sampling 算法、error_handler 8 类错误模式库、local-linux-agent knowledge_base 9 份教学 md、SKILL.md 6 大板块教学法、learned_commands 90 命令档案、rollback_manager 检查点回滚
- **旧版实现**（tdsf-linux-desktop）：触发器式 vec0/FTS5 自动同步、回填服务（断点续传/ETA）、FTS 查询转义、来源标记（fts/vec/both）、BGE 中英前缀切换、教程内容管线（质量过滤/稳定 ID）、UI 设计（knowledge-detail 教学分段/man-page 风格/置信度环）
- **防污染红线**：src/tdsf 整体代码不引入（自研 v4.0.0 已废弃），只继承数据资产/算法/设计思想

**已落地**（4 提交）：
1. 9 份教学素材 md 入库（90 命令档案/概念图谱/词源/FHS/哲学等）→ 内置语料 516 条
2. RAG 增强：FTS5 查询转义（引号包裹防注入）+ BGE 中英前缀自动切换 + RRF 来源标记（fts/vec/both + rrf_score 支撑 UI 匹配徽章）
3. Teach prompt 升级：继承 SKILL.md 6 大板块教学法（💡原理/📂路径拆解/🏛️哲学/📝示例/⚠️易错/✏️先想再敲）+ 强制先查知识库再讲解
4. 测试修正（hash 向量降级下 empty-kb 语义变化）

**待落地**（后续按方案书推进）：
- 决策库：decision_cards 表结构移植（add_case 升级为完整决策卡：根因/证据链/修复/回滚/成功率）
- risk_rules.yaml 迁移为 RiskChecker 规则源（4 级规则）
- 触发器式 vec0/FTS5 自动同步（替代手动三写）
- 知识库管理 UI（knowledge-detail 教学分段设计）

**复盘**：
- ✅ 上级目录是金矿：旧项目完整实现了方案书大部分蓝图（决策卡/可信度/风险引擎），代码不能引入但结构/算法/数据资产可直接继承——"继承优化"比"从零重造"快一个数量级
- ✅ 防污染红线与继承不矛盾：不引代码、引资产（表结构/规则/语料/教学法）
- ✅ 教学素材入库直接受益 Teach（词源/哲学/90 命令档案是分水平讲解的数据源）
- 📌 后续每个 P 阶段先查上级目录是否有现成资产，再动手

---

## 2026-08-01 · P2-1 Teach 教学卡片 + 16 条工作准则

**任务**：teach 教学卡片（Terax 风格 6 大板块分区渲染）；用户补充 16 条工作准则并要求用上前后端 skill。

**实现**（7aa2909）：
- TeachCard.tsx：教学卡片（头部 Teach 徽标 + 分区卡片 + 命令行复制/插入终端 + 追问）
- teachParser.ts：教学 markdown 解析（emoji 板块/## N. 标题 → 分节，代码块提取命令）——纯函数与 UI 分离（react-refresh 规范）
- AiChat：流式完成后 isTeachMessage 检测 → TeachCard
- frontend-ui skill 激活：按规则审查（组件 memo、语义 token、MessageResponse 复用、touch target 项目一致性）

**报错与修改（重要）**：
- **emoji 代理对正则问题**：`[💡📂...]` 字符类在 JS 按 UTF-16 单元匹配，replace 后残留低代理位（"\udca1 为什么"）→ 改 startsWith 逐 emoji 匹配
- **TerminalSquareIcon 不存在**：导入不存在的 icon → HugeiconsIcon 渲染崩溃（currentIcon is not iterable）→ 换 TerminalIcon（验证存在性再导入）
- **isTeachMessage 长度门槛挡住短教学标题**：`## 1. 概念与原理`（<20 字符）被误拦 → 标题正则优先，长度门槛只用于 emoji 检测
- **heredoc 转义写入真实换行**：python 写 TS 文件时 `\n` 被转成真实换行 → 用 Edit 工具逐处修复
- **detectSectionType 正则要求 # 前缀**：传入的 title 已剥离 # → 正则改为纯关键词

**复盘**：
- ✅ frontend-ui skill 的 react-refresh 规范（组件/函数分离）避免了热更新问题——skill 用上了
- ✅ 图标导入必须验证存在性（icon 拼写错误在运行时崩溃，测试才暴露）
- ✅ emoji 处理要小心代理对（startsWith 逐字匹配最稳）
- ✅ 测试驱动暴露了 3 个真实 bug（icon 缺失/长度门槛/类型判定）
- 📌 用户 16 条准则已固化 CLAUDE.md §6.5（skill 优先/环境前置/调研先行/自动记忆沉淀）

**下一步**：TeachCard 需真实 LLM 输出验证（teach agent 是否按 6 大板块输出）；知识库管理 UI；决策库移植。
