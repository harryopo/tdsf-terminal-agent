# 调研报告 — 阿里 open-code-review 与代码审查 Agent 设计

> **日期**：2026-08-29 ｜ **目的**：为方案书 v3.1.2 提供 agent 编排与上下文工程的设计输入（用户指定调研对象：alibaba/open-code-review）
> **关联**：`docs/agent/方案书-v3.1-三模式信任体系与Agent收敛.md` §4.7 / §5-B 线
> **姐妹报告**：`docs/调研-agent终端感知与打字机教学演示-20260829.md`（终端感知 + 打字机教学）

---

## 一、项目基本事实

| 项目 | 事实 |
|---|---|
| 仓库 | github.com/alibaba/open-code-review（官方 alibaba 组织，601 commits） |
| Star | 13,214+ / Fork 899（2026-07 快照；2026-05-18 创建，约 70 天破万星） |
| 许可证 | Apache-2.0 |
| 形态 | **CLI 工具（`ocr` 命令）**，多入口：CLI、GitHub Actions、GitLab CI、Gerrit、Claude Code/Codex/Cursor 插件、Agent Skill、MCP Server、本地 Session Viewer（Web UI） |
| 技术栈 | **Go 65.6%**（核心）+ TypeScript 19.2%；**不依赖 LangGraph/AutoGen——编排层完全自研** |
| 基准 | 自建 AACR-Bench（50 仓库/200 PR/10 语言/1505 缺陷标注，HuggingFace 开放）；同模型下 F1 25.10% vs Claude Code /code-review 11.57%，**官方承认 Recall 更低**——"精度优先、有意牺牲召回" |

## 二、Agent 设计深度解析

### 2.1 编排架构：确定性工程 × Agent 混合（非多角色对话式多 Agent）

- 自研 Go 编排（`internal/agent` + `internal/llmloop` 工具循环）；"多 agent" = **任务级专用 LLM 调用 + 子任务扇出**
- 流水线：`Bootstrap → Git Diff Provider → 确定性门禁（二进制排除/扩展名白名单/噪声过滤）→ per-file Agent Fan-out（并发 8；≥50 行先 PLAN_TASK 只读规划再 MAIN_TASK 工具循环 ≤30 轮；<50 行直接 MAIN_TASK）→ 评论后处理（滑窗行号解析 → 失败 RE_LOCATION 重定位 → REVIEW_FILTER 反思去误报）→ 输出 + JSONL 持久化`
- 编排参数全部硬编码在 `task_template.json`：**6 类任务 × (system.md + user.md) prompt 模板注册表 + 数值常量**（MAX_TOOL_REQUEST_TIMES=100、PLAN_MODE_LINE_THRESHOLD=50、MAX_REVIEW_ROUNDS=2 等）

### 2.2 上下文构建与注入（最有含金量）

**① XML 分区式 user prompt 模板**（`main_task_user.md` 全文取证），7 个注入槽位：

```
<other_changed_files>{{change_files}}</other_changed_files>   ← 非本组但同批变更（全局视野不撑爆上下文）
<review_files>{{diffs}}</review_files>                        ← 本组 Unified Diff（初始只给 diff 不给全文件）
{{current_system_date_time}}                                  ← 真实时间锚定
<user_task>
  {{requirement_background}}   ← 用户注入的业务背景（区分"有意变化 vs 意外回归"）
  {{system_rule}}              ← 按文件类型 glob 匹配的审查规则
  {{plan_guidance}}            ← PLAN_TASK 输出被程序解析后回注（计划是结构化中间产物，不是对话）
  {{confirmed_comments}}       ← 已确认发现（防重复报告）
</user_task>
```

**无 RAG/向量库**——上下文获取靠"**确定性预注入 + 工具按需拉取**"双通道。

**② 规则四层优先级链**：`--rule 文件` → repo `.opencodereview/rule.json` → 全局 `~/.opencodereview/rule.json` → 内置 `system_rules.json`；按 glob 匹配，第一个命中生效。**规则不是静态分析器，而是"按文件类型决定给模型看什么审查准则"——从源头收窄模型注意力。**

**③ 6 类场景化工具**：code_search / file_find / file_read / file_read_diff / code_comment（唯一"写"通道）/ task_done。

**④ Token 预算与三段式记忆压缩**：预算 58,888 Token；60% 异步压缩 / 80% 同步压缩；超预算停发保留已完成。**三段式**：冻结区（system+初始 user 不动）/ 老轮次压缩为 `<previous_review_summary>`（**五维结构**：已确认问题 / 工具结论 / 已完成 / 待办 / 当前焦点）/ 活跃区保留。

### 2.3 输出结构：schema 校验 + 非法值降级（`code_comment.go` 源码级）

- 每条评论：`path/content/start_line/end_line/category/severity/suggestion_code/existing_code/thinking`
- category 8 类枚举 / severity 4 级；**非法值降级不崩**（category→other、severity→low）；path/content 空直接丢弃
- **定位失败显式降级协议**：`start_line/end_line` 双 0 = 定位失败，下游降级为普通摘要评论，**绝不强行贴到错误代码行**

### 2.4 工具治理

- 注册后 `Freeze()` 运行期不可变；**分阶段能力收紧**（Plan 阶段工具只是文本占位符不得实际调用，Main 阶段才开放真实 Tool Use）
- 防空转：一轮无有效工具调用→提示重试，连续 3 轮无效退出；每文件 30 轮 + 100 LLM 请求硬上限 + 10 分钟超时

### 2.5 人机协作

`--preview` 干跑（确定性门禁透明化）/ Token 预算预告与 WARNING / **修复需确认**（SKILL.md 明文：用户只说 review 就先征询许可再改代码）/ `--no-filter` 关反思 / 会话 JSONL 持久化 + 按文件指纹 resume / **委托模式**（OCR 只做文件选择+规则解析，LLM 推理交还宿主 agent——脚手架与推理分离）

### 2.6 质量兜底哲学（最值得学）

1. **不信模型给的行号**：`existing_code` 与真实 diff 滑窗匹配，程序计算行号；失败触发独立 RE_LOCATION_TASK；主循环后再全局二次解析
2. **反思过滤的非对称错误观**（review_filter_task_system.md 原文）："保留错误评论花审查者几秒；删掉正确评论永久毁掉一个真实发现……**证据不足即放行（approve）**"——fact-checker 只删"能被证明为错"的
3. **Plan 产出程序可解析**：纯文本格式（Summary + 编号 Issues + [severity] + → 工具调用计划），规定"无风险时输出 (none)，**不得编造问题凑数**"

## 三、对 TDSF 运维教学 Agent 的借鉴点（按优先级）

| # | 借鉴点 | 适配运维教学场景的理由 |
|---|---|---|
| 1 | **确定性工程 × Agent 混合：把"绝不能错"的事从模型手里拿走**（文件过滤/定位/校验全代码保证，模型只做理解与判断） | 直接呼应 CLAUDE.md 红线 9（cd 拦截 hack 事故的业界正解）；命令白名单校验/审计日志/环境探测由代码完成，模型只解释现象与规划方案 |
| 2 | **XML 分区式上下文注入模板**（7 槽位占位符工程） | 运维版直接映射：`<environment>`（发行版/内核/cwd/最近命令）+ `<terminal-history>`（block 流水账）+ `<task>`（学生目标）+ `<previous_findings>`；prompt 组装代码化可测试 |
| 3 | **Plan-then-Act + 计划作为结构化中间产物回注**；小任务跳过 Plan | 复杂运维任务先产出"风险点 + 工具调用计划"纯文本，程序校验后注入执行阶段并**在 UI 展示给学生确认**——天然教学人机协作点，也控制危险操作执行面 |
| 4 | **非对称错误观的过滤**："证据不足即放行" | 运维建议过滤同理：只有"能被证明有害"才拦截，避免把教学 agent 变成什么都不让做的摆设 |
| 5 | **结构化输出 schema + 非法值降级协议** | 运维 agent 输出 schema 化：`{command, risk_level, rationale, verify_steps}`；非法枚举降级不崩；定位失败显式降级为摘要而非编造——**反幻觉的结构化兜底** |
| 6 | **三段式记忆压缩 + 五维摘要** | 教学 SSH 长会话（装环境→排障→验证）终端输出远超上下文；五维直接移植运维版：已执行命令/已排除原因/待验证项/当前焦点 |
| 7 | **引用可验证**（滑窗匹配重定位，失败降级） | agent 解释报错时引用的"原始输出行/路径/版本号"做程序化回验（在终端 buffer 滑窗匹配），引用不实则降级——反幻觉从 prompt 层到架构层 |
| 8 | **会话 JSONL + 指纹 resume + 预算熔断** | 教学复盘刚需（教师回放/评分）；断线续跑不从头再来；学生操作设预算上限防失控 |

**一句话总结**：open-code-review 最值得抄的不是某个 prompt，而是它的**权力划分**——"流程正确性交给代码，语义理解交给模型，且对模型输出的每一项关键属性都有一条程序化校验/降级链路"。

## 四、主要来源

- 仓库：github.com/alibaba/open-code-review（README、LICENSE）
- 源码直读（raw main 分支）：`internal/agent/agent.go`、`internal/tool/code_comment.go`、`internal/config/template/task_template.json`、`prompts/main_task_system.md`、`prompts/main_task_user.md`、`prompts/plan_task_system.md`、`prompts/memory_compression_task_system.md`、`prompts/review_filter_task_system.md`、`skills/open-code-review/SKILL.md`
- 掘金深度解析：juejin.cn/post/7666731827277119494（架构图、基准核验、README 与实现口径差异）
- CSDN：blog.csdn.net/qq_25112523/article/details/163760594；jianggujin.com/post/41
- 同类对照：Qodo PR-Agent（yigitkonur.com/atlas/spec-driven-development/frameworks/qodo）、Qodo 2.0（qodo.ai/blog/introducing-qodo-2-0-agentic-code-review）
