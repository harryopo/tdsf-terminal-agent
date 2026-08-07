# TDSF Terminal Agent · 路线图（短/长期规划）

> **用途**：确保开发按方案书执行——长期规划对齐 `docs/方案书-v1.0.md` 的 P0-P4 路线图；短期规划 = 当前任务 + 下一步清单。
> **更新时机**：每次任务收尾（任务完成 / 方向变化 / 新决策）时更新本节，并在 `docs/DEV-JOURNAL.md` 追加复盘。

---

## 一、长期规划（方案书路线图跟踪）

| 阶段 | 内容 | 状态 | 完成记录 |
|------|------|------|---------|
| **P0** | Strands 多 agent（B 方案）/ 真流式 / 超时可配置 / 降级 UI / 补测试 | ✅ 完成 | dev-state §37.17 |
| **P0-6** | Agent 全链路：main 统一入口 + 自主委派 + 调用可视化 | ✅ 完成 | dev-state §37.18 |
| **P1** | HITL 真实审批闭环 / 会话证据链 / hash 审计链 | ✅ 完成 | dev-state §37.19 |
| **P2** | 教学闭环：Teach 结构化输出、asciicast 回放 UI、工具集扩展、决策库、资源管理器性能债 | ✅ 完成 | 翻译重构 + 知识库 + 工具集（本轮核实全部落地） |
| **P3** | 生态：Headroom MCP（需确认外部依赖）、实训沙箱（Docker）、Profile 教学配置 | ⏳ 未开始 | 需用户确认外部依赖 |
| **P4** | 单框架收敛：删除 LangGraph 遗产代码与 graph/ 目录 | ✅ 完成 | 69ec9c0（2184 行死代码删除） |

**P2 子任务核实（2026-08-01 全量工程中逐一确认）**：
- [x] Teach 结构化输出（teaching_content）→ TeachCard 渲染（TeachCard.tsx + teachParser.ts + 测试）
- [x] asciicast 录制 → 回放面板（AsciicastPanel.tsx + asciicast.ts，CastEvent 解构 bug 已修）
- [x] 工具集扩展：service_manage / package_manage / firewall_manage / security_audit / performance_analyze（strands_backend/tools/ops_extended.py）+ ssh_command / suggest_command 等共 9+ 工具
- [x] 决策库：knowledge.add_case 自动沉淀（排障成功自动入库）+ hybrid 检索（knowledge.search）+ 前端浏览（KnowledgeBrowser）
- [x] 知识库管理 UI（左侧栏浏览/搜索/详情弹窗，knowledge.list/search/get）
- [x] 资源管理器性能债：上游 terax 已按目录缓存（expansionCache），无需重做

**P1 剩余核实**：
- [x] D-S 证据融合引擎（core/confidence.py：DSPCR5ConfidenceCalculator + PCR5ConflictResolver 完整实现）

---

## 二、短期规划（当前与下一步）

### 当前任务

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 1 | P2 翻译模块重构（统一选中浮层） | ✅ 已完成 | 本地/SSH 终端选词翻译 + Ask TDSF，已提交 a2aa150 |
| 2 | 审查架构项收尾（Py-H1 调研 + Rust-C3 热路径锁迁移） | ✅ 已完成 | §37.29，commit 见 git log；审查报告 41 项全部有处置结论 |

### 下一步（按优先级）

| # | 任务 | 类型 | 预估 | 依赖 |
|---|------|------|------|------|
| 1 | ~~**黑屏修复**~~ ✅ 完成：根因=terax 残留 transparent 平台配置（§37.23）+ dev 启动残留修复（§37.24） | 修复 | 中 | 无 |
| 2 | ~~**L5 打包发布验证**~~ ✅ 完成：sidecar onedir 打包 + 安装冒烟全通过（安装包 402MB，0.1.0） | 验收 | 中 | 无 |
| 3 | **实测验证**：真实 LLM 委派行为 + SSH 终端翻译/审批全链路 | 验收 | 需用户 | API key + SSH 服务器 |
| 4 | **安装版用户体验**：用户机器安装 → 黑屏确认消失 → 全功能走查 | 验收 | 需用户 | 无 |
| 5 | **dev 启动规范**（§37.24 教训）：长期进程禁管道截断；dev 误用打包 exe 时删 target/debug/sidecar | 规范 | 无 | 无 |

### 待用户决策/确认

- [ ] Headroom MCP 是否引入（外部依赖，P3）
- [ ] 实训沙箱（Docker 故障环境）是否纳入（P3）
- [ ] 真实 LLM 委派效果实测反馈（决定 _MAIN_SUB_AGENT_PROMPT 是否需要调优）

---

## 三、原则（确保按方案执行）

1. 新任务先对照方案书：属于哪个阶段、对应哪条路线，不在路线图内的功能需用户确认再加
2. 任务收尾三件事（强制）：① git commit（全绿门禁）→ ② `docs/DEV-JOURNAL.md` 追加复盘（任务/方案/报错/修改/经验）→ ③ 更新本文件 + `docs/dev-state.md`
3. 报错与修改必须沉淀到 journal（根因 + 解法），防止重复踩坑
4. 门禁：后端 pytest / 前端 vitest / tsc / eslint / cargo check 全绿才算完成
