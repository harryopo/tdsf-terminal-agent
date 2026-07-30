# 多 Agent 并行开发规范 v2.0 审查报告

> **审查对象**：`docs/MULTI-AGENT-WORKFLOW.md`（v2.0，1284 行，2026-07-30）
> **审查依据**：`CLAUDE.md` v2.0、`AGENTS.md`、`docs/dev-state.md`（截至 §十五 / 2026-07-30 P0-E 阶段 A 完成）
> **审查日期**：2026-07-30
> **审查范围**：完整性 / 与实际项目状态对齐 / 实用性 / 与 CLAUDE.md 红线一致性
> **审查方法**：逐行 Read 被审查文档全文 + 交叉 Read 三份对照文档 + 漂移点比对

---

## 1. 摘要

规范整体**结构完整、可执行性较强**，A/B/C 三场景分层、文件锁矩阵、改动影响分析表、自检报告模板等核心内容可直接复制使用。但存在 **4 项 Critical 漂移**（AGENTS.md/CLAUDE.md 未承认本规范、测试数 830 vs 实际 832、规范禁止 subagent 改本规范但本身由 subagent 撰写的自相矛盾）、**7 项 Major 缺失**（Strands/rust_bridge/SSH 文件编辑器集成等近 6 个 session 的架构演进未纳入；回滚 / subagent 中途失败 / 集成顺序 / 场景切换判定等流程空白）、**9 项 Minor 改进点**。规范与项目实际状态存在系统性滞后，建议立即同步 CLAUDE.md/AGENTS.md 互引、刷新测试基线、补充近 7 个 session 沉淀的新模块与新场景。

**关键发现数**：Critical 4 / Major 7 / Minor 9，共 20 项。

---

## 2. 完整性审查结果

### A. 完整性审查

#### A.1 已覆盖方面（覆盖度高）

| 维度 | 覆盖位置 | 评价 |
|------|---------|------|
| 任务分配 | §9（含 §9.1 适合 / §9.2 不适合 / §9.3 派发模板 / §9.4 自检模板 / §9.5 实例） | 完整，模板可直接复制 |
| 文件锁 | §3（含 §3.1 互斥矩阵 23 行 / §3.2 锁文件机制 / §3.3 冲突处理） | 完整，互斥矩阵覆盖前端/Rust/配置/文档四类 |
| 冲突解决 | §10（文件冲突 / 设计冲突 / 依赖冲突 / 主工作树优先 4 类） | 完整，每类有步骤 |
| 交接协议 | §2（强制 9 步顺序 / 检查清单 9 项 / 失败回退 / 声明模板） | 完整，声明模板可复制 |
| 通信 | §6（进度同步 / 更新责任矩阵 / 更新时机表 / 交接章模板 / 数据契约 8 字段） | 完整 |
| 失败处理 | §2.3 接手失败 / §7.4 门禁失败 / §10 冲突解决 | 基本完整，但 subagent 中途失败缺失（见 Major-8） |
| 三场景分层 | §1 A/B/C + §1.4 速查表 | 优秀，风险分层清晰 |
| 模块依赖图 | §4.1 前端 23 模块 / §4.2 Rust 14 模块 / §4.3 可并行 / §4.4 不可并行 / §4.5 影响表 20+ 行 | 详尽，但未含 Strands 等新模块（见 Major-5） |
| 主工作树原则 | §5（含不用 worktree 的 5 条理由 + 协作方式 + 写权让渡） | 完整，决策有依据 |
| 五绿门禁责任 | §7（含 §7.5 场景门禁责任矩阵） | 完整，但缺 Python pytest（见 Minor-20） |
| CDP 与 dev server | §8（端口单实例 / 各场景实测责任 / CDP 临时让出 / 端口清理 / Rust 重编 / 日志抓取） | 详尽 |
| 提交规范 | §11（message 格式 / 何时提交 / 拆分策略 / 安全规则） | 完整 |
| 防污染红线 | §13（CLAUDE.md 8 条 + 多 agent 扩展 8 条 = 16 条） | 完整 |
| 接手检查脚本 | §12 PowerShell 脚本 | 实用 |
| 实际 session 案例 | §14（仅覆盖 2026-07-30 §九 一个案例） | 单一（见 Minor-14） |

#### A.2 缺失的必要场景

1. **回滚策略不完整**：§10.4 仅说"Edit 反向编辑撤销"，但**集成多个 commit 后**才发现问题如何回滚未规定。CLAUDE.md 禁 `git checkout/reset/restore`，但 `git revert` 是否允许未说，多 commit 回滚顺序未说。
2. **agent 间依赖的拓扑排序**：§4.3/4.4 给出可并行/不可并行模块对，但**有依赖关系的多任务该如何排序**（如先改 Rust ssh_command 再改 Python 工具调用）未规定。
3. **并行 agent 冲突的自动检测**：§3.2 明确"软约束，无 pre-commit hook"，但**主 agent 何时检查锁文件、用什么命令核对 git status 与锁文件一致性**未规定。
4. **subagent 中途失败/超时处理**：subagent 跑到一半挂了、已改部分文件，规范没说怎么处理（清理半成品？保留待续？回滚？超时阈值多少？）。
5. **多 subagent 同时返回的集成顺序规则**：§7.3 说"按 §11.3 拆分策略集成"，但 §11.3 是 commit 拆分而非集成顺序。多个 subagent 同时完成时按什么顺序集成（依赖倒序？风险等级？完成时间？）未规定。
6. **场景切换的判定与流程**：§6.3 把"场景切换"列为强制保存时机，但**怎么判定 A→B/B→C 切换发生**（任务边界变化？文件锁冲突？）、**切换时该做什么**（清空旧锁？重新声明？跑门禁？）未规定。
7. **subagent 数量超限处理**：§1 说场景 B 并行上限 ≤3，但**主 agent 派发了 4 个怎么办**（排队？拒绝？拆分？降级场景 A？）未规定。

#### A.3 未定义的术语

| 术语 | 首次出现位置 | 问题 |
|------|------------|------|
| 「主工作树」 | §5 标题 | 首次出现无定义，读者需自行理解为主仓库工作目录 |
| 「集成」 | §7.3 | "主 agent 集成"具体动作是什么（git merge？Edit 复制？rebase？）未说 |
| 「反向编辑」 | §10.4 | 知道是不用 git checkout，但具体操作（按 diff 反向 Edit？手写逆操作？）未示范 |
| 「让渡」 | §5.3 | "写权让渡"在协作工具中如何体现（锁文件登记？口头声明？）未说 |
| 「软约束」 | §3.2 | 知道是无 hook，但软约束失效时（agent 不自律）的兜底未说 |

---

### B. 与实际项目状态对齐审查

#### B.1 实际开发流程吻合度

规范描述的"多 agent 并行"模式**与项目实际开发流程高度吻合**。dev-state.md 显示项目已多次实践：

- **§九.233-241**（2026-07-30）：主 agent + 3 个并行 subagent（运维 agent 调研 / 魔改 agent 审计 / 多 agent 规范撰写），"3 个 subagent 文件路径独占，与主线代码改动完全隔离，零冲突"——**这正是规范 §14 引用的案例**。
- **§十.289-291**（2026-07-30）：2 个并行 subagent 产出 `ops-agent-opensource-survey-2026-07.md`（870 行）+ `ssh-editor-integration-plan.md`（824 行）。
- **§十一**（2026-07-30）：主 agent 完成 SSH 文件编辑器集成 EditorStack（commit a4e6084），2 个并行 subagent 产出调研报告。
- **§十二 / §十三 / §十四 / §十五**：Strands 集成 / 双向 JSON-RPC 桥 / Critical Bug 修复 / P0-E 阶段 A 实测，均有 subagent 协作痕迹（调研报告产出）。

**规范 §14 仅引用 §九 一个案例**，未沉淀 §十~§十五 共 6 个 session 的多 agent 协作经验（见 Minor-14）。

#### B.2 关键文件引用正确性

| 规范引用 | 实际存在 | 评价 |
|---------|---------|------|
| `AGENTS.md`（§0 行 15） | ✅ 存在（9 行） | 但 AGENTS.md 实际内容**未提 MULTI-AGENT-WORKFLOW.md**（见 Critical-1） |
| `CLAUDE.md`（§0 行 16） | ✅ 存在（160 行） | 但 CLAUDE.md §6 记忆文档表**未列本规范**（见 Critical-2） |
| `docs/dev-state.md`（§0 行 18） | ✅ 存在（1142 行，截至 §十五） | 引用正确 |
| `docs/MULTI-AGENT-WORKFLOW.md`（§0 行 17） | ✅ 存在（1284 行，本文件） | 自指正确 |
| `docs/OPEN-SOURCE-AND-MODIFICATIONS.md`（§6.4 行 595） | ✅ 存在 | 引用正确 |
| `opensource-reference/terax-ai/`（§0 行 20） | ✅ 存在（.gitignore 排除） | 引用正确 |
| `docs/.agent-locks.md`（§3.2 行 261） | ⚠️ 运行时生成，git 不跟踪 | 路径约定正确 |
| `C:\Users\Lenovo\.qoder\plans\still-crest-linnet.md`（§9.5 行 944） | ⚠️ 该 plan 任务 #15-#20 已完成（dev-state §九.142-150） | 路径有效但案例过时（见 Minor-12） |
| `C:\Users\Lenovo\AppData\Local\Temp\cdp-read.mjs`（§8.3 行 758） | ✅ dev-state 多处引用 | 引用正确 |

#### B.3 与 dev-state.md 实际进度的漂移点

| 漂移项 | 规范描述 | 实际状态（dev-state.md） | 严重度 |
|--------|---------|------------------------|--------|
| 测试数量 | "830 全过"（§7.1 行 658 / §7.2 行 668 / §9.3 行 863 / §9.4 行 911 / §13 行 1198） | **832/832 全过**（§十一.369 / §十二.510 / §十三.813 / §十四.915 / §十五.1100） | Critical-3 |
| Strands 集成 | 未提及 `strands_backend/` / `rust_bridge.py` / `ssh_command` 等新模块 | 已完成 P0-C5 / P0-D / P1-2~P1-8 / Critical Bug 全链路修复 / P0-E 阶段 A（§十二~§十五） | Major-5 |
| SSH 文件编辑器 | §4.5 行 457 仍提 `SshFileEditor` | `SshFileEditor.tsx` **已删除**，远程编辑走 `EditorStack`（§十一.349-398，commit a4e6084） | Major-6 |
| Python sidecar 状态 | §4.2 行 387 仅说"sidecar（魔改独有，Python 进程管理）" | sidecar P0 已修（指数退避 + cancel_tx，commit 2091e2f，§十.268-274） | Minor-18 |
| plan 文件路径 | §9.5 行 944 实例引用 `still-crest-linnet.md` | 该 plan #15-#20 已完成，应补充新案例 | Minor-12 |
| 多 agent 实践案例 | §14 仅覆盖 §九 一个 session | §十~§十五 共 6 个 session 未纳入 | Minor-14 |

---

### C. 实用性审查

#### C.1 优点（可直接执行的部分）

1. **§2.4 接手声明模板**（行 167-212）：填空式模板，AI 直接复制即可。
2. **§3.1 互斥矩阵**（行 224-249）：23 行覆盖前端/Rust/配置/文档四类，每行有"违反后果"列，AI 一眼看出风险。
3. **§4.5 改动影响分析表**（行 443-496）：20+ 行"改 X 影响 Y"具体化，主 agent 派发前查表即可判定边界。
4. **§9.3 派发模板**（行 834-892）：完整含任务背景/必读/声明/步骤/影响预判/验证/约束/回滚点/完成标准 9 段。
5. **§9.4 自检报告模板**（行 896-936）：7 段（声明回执/文件/门禁/依赖/互斥/影响/Rust/阻塞），强制必填。
6. **§7.5 场景门禁责任矩阵**（行 718-724）：5 行 × 6 列，谁跑哪几项一目了然。
7. **§11.3 commit 拆分策略**（行 1109-1121）：4 场景 × 拆分策略 × commit 数，含 5 条拆分原则。
8. **§12 接手检查脚本**（行 1139-1181）：PowerShell 一键跑，8 段检查。

#### C.2 抽象但无落地的概念

1. **§3.2 锁文件 `docs/.agent-locks.md`**（行 261-272）：声明是软约束，但**主 agent 何时检查锁文件**未规定（每次派发前？集成时？commit 前？）。无检查时机 = 锁文件形同虚设。
2. **§6.5 数据契约 8 字段**（行 632-645）：列出字段，但**这些字段要写到哪**（dev-state.md 交接章？单独 JSON 文件？对话回执？）未说。
3. **§8.3 CDP 临时让出**（行 763-767）：4 步流程（subagent 报告 → 主 agent 暂停 → subagent 连接 → 归还），但**每步的验证标准**（怎么知道暂停成功？怎么知道归还完成？）未说。
4. **§10.2 设计冲突**（行 990-997）：说"主 agent 用 AskUserQuestion 询问用户"，但**怎么判定"设计冲突"vs"实现差异"**未说，主 agent 缺乏操作标准。

#### C.3 错误处理 / 失败恢复流程

| 流程 | 位置 | 评价 |
|------|------|------|
| 接手失败回退 | §2.3（行 150-161） | 清晰：3 条触发条件 + 3 步回退动作 |
| 门禁失败回退 | §7.4（行 708-714） | 清晰：4 步（git diff 定位 / Edit 修复 / 重跑 / 报告用户） |
| 文件冲突解决 | §10.1（行 980-988） | 清晰：5 步（停止 / git diff / 手动合并 / 五绿 / 记录） |
| 设计冲突解决 | §10.2（行 990-997） | 清晰：4 步（报告 / AskUserQuestion / 撤销 / 记录） |
| 依赖冲突解决 | §10.3（行 999-1006） | 清晰：4 步（评估 / 主 agent 独占改 / 撤销 / 红线重申） |
| **subagent 中途崩溃/超时** | **缺失** | 未规定（见 Major-8） |
| **dev server 端口清理失败** | §8.4（行 769-780）仅给命令 | 清理失败（taskkill 拒绝访问？PID 不存在？）的回退未说 |

---

### D. 与 CLAUDE.md 红线一致性审查

#### D.1 一致点

1. **§13 红线表**（行 1189-1209）：重申 CLAUDE.md §3 的 8 条红线并扩展为多 agent 场景，每条对应关系正确。
2. **§11.4 提交安全规则**（行 1123-1131）：重申 CLAUDE.md §0 铁律 3（禁 git checkout/reset/restore 已跟踪文件），6 条禁令一致。
3. **§7.1 五绿门禁**（行 651-664）：与 CLAUDE.md §4 一致，含豁免规则与 per-project -p 检查方式。
4. **§5.1 不用 git worktree**（行 502-512）：5 条理由与 CLAUDE.md §0 铁律 3（不 git checkout）精神一致。
5. **§10.4 撤销规则**（行 1019-1022）：明确禁 git checkout/reset/restore/stash，与 CLAUDE.md 一致。

#### D.2 冲突或矛盾

1. **文档优先级冲突**（Critical-2）：规范 §0 行 7 自称"本规范与 CLAUDE.md 同级，是 AI 接手必读第二文档"，但 **CLAUDE.md §6 记忆文档位置表（行 137-142）只列了 4 个文档（AGENTS.md / CLAUDE.md / dev-state.md / OPEN-SOURCE-AND-MODIFICATIONS.md），未包含本规范**。规范自抬身价但未让 CLAUDE.md 承认。
2. **阅读顺序冲突**（Major-11）：规范 §0 行 13-20 阅读顺序把 MULTI-AGENT-WORKFLOW.md 排第 3 位（在 dev-state.md 之前），但 **CLAUDE.md §0 铁律 5（行 15）说"当前进度、已知问题、本次恢复全过程见 docs/dev-state.md（第二必读）"**。规范把 dev-state.md 降为第 4 位，与 CLAUDE.md "第二必读"的定位冲突。
3. **测试数量不一致**（Critical-3）：规范多处写"830 全过"，CLAUDE.md §4 行 108 也写"当前 830 全过"。但 dev-state.md §十一.369 显示已 832/832。CLAUDE.md 也漂移了，规范跟随 CLAUDE.md 的旧数据。
4. **规范自相矛盾**（Critical-4）：§13 红线 13（行 1206）"subagent 不改 docs/MULTI-AGENT-WORKFLOW.md（规范由主 agent 独占）"，但 §9.5 行 944-948 派发实例与 §14.1 行 1224 表格都说"subagent-C 撰写本规范文档（v2.0 覆盖更新）"。**规范本身的存在就是 subagent 撰写的反例**，红线 13 与实际操作矛盾。

---

## 3. 发现的问题清单（按严重度排序）

### Critical（4 项，会误导 AI 接手）

#### Critical-1：AGENTS.md 未引用本规范，与规范 §0 阅读顺序漂移

- **位置**：`AGENTS.md` 行 5-7 vs 规范 §0 行 13-20
- **现象**：AGENTS.md 实际只列"1. CLAUDE.md → 2. docs/dev-state.md"两步阅读顺序，**未提到 `docs/MULTI-AGENT-WORKFLOW.md`**。规范 §0 自称阅读链第 3 位，但入口文件 AGENTS.md 不引导 AI 去读。
- **影响**：AI 接手时按 AGENTS.md 顺序读会跳过多 agent 规范，所有协作规则失效。
- **修复建议**：在 AGENTS.md 接手前必读列表追加第 3 项 `docs/MULTI-AGENT-WORKFLOW.md`。

#### Critical-2：CLAUDE.md 记忆文档表未列本规范，规范自称"同级"无依据

- **位置**：`CLAUDE.md` §6 行 137-142 vs 规范 §0 行 7
- **现象**：CLAUDE.md §6 记忆文档位置表只列 4 个文档（AGENTS.md / CLAUDE.md / dev-state.md / OPEN-SOURCE-AND-MODIFICATIONS.md），**未列 `docs/MULTI-AGENT-WORKFLOW.md`**。规范 §0 行 7 自称"本规范与 CLAUDE.md 同级，是 AI 接手必读第二文档"。
- **影响**：规范自抬身价但 CLAUDE.md 不承认，两份规范对自身定位不一致，AI 不知该信哪个。
- **修复建议**：CLAUDE.md §6 记忆文档表追加一行 `docs/MULTI-AGENT-WORKFLOW.md`（多 agent 协作规范），与规范 §0 自称一致。

#### Critical-3：测试数量基线漂移（830 vs 实际 832）

- **位置**：规范 §7.1 行 658 / §7.2 行 668 / §9.3 行 863 / §9.4 行 911 / §13 行 1198 / §2.2 行 144
- **现象**：规范多处写"830 全过"，但 dev-state.md §十一.369 / §十二.510 / §十三.813 / §十四.915 / §十五.1100 均显示 **832/832 全过**（+2 测试，源于 SSH 文件编辑器集成新增测试）。CLAUDE.md §4 行 108 也仍写 830。
- **影响**：接手 AI 用错误基线（830）比对，会误判当前 832 为"新增 2 个失败"或"基线漂移"，触发不必要的回退。
- **修复建议**：全局替换"830 全过"为"832 全过"，并在 §16 演进章节加注"测试数阈值变化时务必同步更新 §7.1 / §7.5 / §12 脚本"（这条已在 §16 行 1274 提到，但未执行）。

#### Critical-4：规范自相矛盾——禁止 subagent 改本规范，但本身由 subagent 撰写

- **位置**：§13 红线 13（行 1206）+ §3.1 行 240 vs §9.5 行 944-948 + §14.1 行 1224
- **现象**：
  - §13 红线 13："subagent 不改 docs/MULTI-AGENT-WORKFLOW.md（规范由主 agent 独占）"
  - §3.1 行 240：本文件"协调互斥，改动需主 agent 独占 + 用户确认"
  - 但 §9.5 行 944-948 派发实例："subagent-C：撰写本规范文档（v2.0 覆盖更新）"
  - §14.1 行 1224 表格："subagent-C | A | 撰写本规范文档 | docs/MULTI-AGENT-WORKFLOW.md | 完成"
- **影响**：规范本身的存在就是红线 13 的反例。AI 接手时若严格按红线 13 执行，则任何规范更新都必须主 agent 亲自做；但实际本规范是 subagent 撰写的，红线 13 不具操作性。
- **修复建议**：将红线 13 改为"subagent 不**直接**改 docs/MULTI-AGENT-WORKFLOW.md，**经主 agent 派发授权 + 用户确认后可改**"，与场景 A 实践对齐。或在 §9.5 实例注明"本规范属例外，经用户授权 subagent 撰写"。

---

### Major（7 项，影响实用性）

#### Major-5：Strands / rust_bridge / ssh_command 等新模块未纳入规范

- **位置**：§4 模块依赖图（行 289-497）+ §3.1 互斥矩阵（行 224-249）
- **现象**：dev-state.md §十二~§十五 显示已完成 Strands 集成（P0-C5 LLM 模型适配 / P0-D ssh_command / P1-2~P1-8 双向 JSON-RPC 桥 / Critical Bug 全链路修复 / P0-E 阶段 A 端到端实测），新增模块：
  - `src-tauri/sidecar/strands_backend/`（adapter.py + tools/ + model_adapter.py，411+ 行）
  - `src-tauri/sidecar/rust_bridge.py`（280 行，RustBridge 类）
  - `src-tauri/src/modules/ssh/session.rs` 新增 `exec_command` + `SshCommandOutput`
  - `src-tauri/src/modules/ssh/mod.rs` 新增 `ssh_command` Tauri 命令 + `SshCommandResult`
  - `src/lib/ssh-bridge.ts` 新增 `sshCommand` 函数
  - `src-tauri/sidecar/main.py` 新增 `TDSF_AGENT_BACKEND` 环境变量注入 + 主循环反向响应路由
  - `src/modules/ai/lib/transport.ts` 新增 `LiveSnapshot.sshSessionId` + `<env>` 块注入
  - `src/modules/ai/lib/sidecar-adapter.ts` 新增 `SidecarStreamOptions.live` 必填字段
  - `src/modules/ai/store/chatRuntime.ts` 新增 `getSshRustSessionId`
  
  但规范 §4.1 前端模块图（行 295-358）未含 Strands 相关依赖；§4.2 Rust 模块图（行 364-406）未含 `ssh_command` 命令；§3.1 互斥矩阵未含 `src-tauri/sidecar/strands_backend/`、`src-tauri/sidecar/rust_bridge.py` 等新文件；§4.5 改动影响表未含这些新模块。
- **影响**：主 agent 派发涉及 Strands/rust_bridge 的任务时无互斥规则可循，可能误派两个 subagent 同时改 `strands_backend/` 与 `rust_bridge.py`（实际两者紧耦合）。
- **修复建议**：
  1. §4.1 模块图追加 `ai ←─ Strands backend（魔改独有，依赖 rust_bridge + LLM config）`
  2. §4.2 Rust 模块图追加 `ssh::ssh_command` 命令节点
  3. §3.1 互斥矩阵追加 `src-tauri/sidecar/strands_backend/`（模块互斥 + 高风险，紧耦合 rust_bridge）+ `src-tauri/sidecar/rust_bridge.py`（模块互斥）
  4. §4.5 改动影响表追加 Strands/rust_bridge/ssh_command 三行
  5. §4.4 不可并行模块对追加 `strands_backend` / `rust_bridge` / `ssh_command` 三对

#### Major-6：SSH 文件编辑器集成未更新，仍引用已删除的 SshFileEditor

- **位置**：§4.5 行 457 + §4.1 模块图（行 295-358）
- **现象**：dev-state.md §十一.349-398（commit a4e6084）显示 SSH 文件编辑器已集成到 EditorStack：
  - `SshFileEditor.tsx` **已删除**
  - 远程文件编辑走 `EditorStack` / `EditorPane`（CodeMirror）+ `useDocument` 3 处 fs 调用按 `tab.remote` 分流到 `sftpRead/sftpWrite/sftpStat`
  - `EditorTab` 加 `remote?: { sessionId: string } | null` 字段
  - `openFileTab` 加第三参 `remote`，去重 key 改 `path + sessionId`
  
  但规范 §4.5 行 457 仍写"`src/modules/ssh-explorer/sshStore.ts` 直接影响 `SshExplorer` / `SshFileTree` / `SshFileEditor` / `SshTerminalHost` / `useRemoteFileTree`"——**SshFileEditor 已不存在**。§4.1 模块图行 330-334 描述 `ssh-explorer` 依赖时也未体现 EditorStack 集成。
- **影响**：主 agent 派发 ssh-explorer 相关任务时，影响分析表指向不存在的文件，AI 困惑。
- **修复建议**：
  1. §4.5 行 457 把 `SshFileEditor` 改为 `EditorStack` / `EditorPane` / `useDocument`（按 remote 分流）
  2. §4.1 模块图 `ssh-explorer` 节点追加"远程文件编辑已并入 EditorStack（commit a4e6084）"
  3. §4.5 追加 `src/modules/editor/lib/useDocument.ts` 改动影响行（read/write/stat 按 remote 分流）

#### Major-7：回滚策略不完整，多 commit 集成后回滚未规定

- **位置**：§10.4（行 1019-1022）+ §7.4（行 708-714）
- **现象**：§10.4 撤销规则仅说"用 Edit 反向编辑撤销，禁 git checkout/reset/restore/stash"。但**集成多个 commit 后**才发现问题（如 subagent-A 改动 commit 了，subagent-B 改动 commit 了，集成层 commit 了，事后发现 subagent-A 引入 bug），如何回滚未规定：
  - 是否允许 `git revert <commit>`？（CLAUDE.md 禁 checkout/reset/restore，但 revert 是新 commit，应允许）
  - 多 commit 回滚顺序（后进先出？按依赖倒序？）
  - 回滚后是否要重跑五绿？
  - 回滚后 dev-state.md 怎么记录？
- **影响**：主 agent 集成后发现严重 bug 时无操作标准，可能误用 git reset 触发 CLAUDE.md 红线。
- **修复建议**：§10 追加 §10.5「多 commit 回滚策略」：
  1. 优先用 `git revert <commit>`（生成逆向 commit，不破坏历史，符合 CLAUDE.md 红线）
  2. 回滚顺序：后进先出（LIFO，先 revert 最新 commit）
  3. 回滚后重跑五绿 + tauri:dev 实测
  4. dev-state.md 追加「回滚记录」节，说明回滚的 commit hash + 原因 + 验证结果

#### Major-8：subagent 中途失败/超时处理缺失

- **位置**：§9 subagent 任务分配（行 802-974）+ §10 冲突解决
- **现象**：规范覆盖了"subagent 完成后返回自检报告"（§9.4）与"subagent 越界"（§10.4），但**subagent 跑到一半挂了/超时/主动放弃**的处理未规定：
  - subagent 已改了部分文件但未完成，主 agent 怎么清理半成品？（直接 Edit 反向？还是 git restore？后者禁用）
  - subagent 超时阈值是多少？（无规定）
  - subagent 主动报告"无法完成"时，已改文件保留还是撤销？
  - 主 agent 是否需要重新派发该任务给另一个 subagent？
- **影响**：subagent 中途失败时主 agent 无操作标准，可能误留半成品文件污染工作区。
- **修复建议**：§9 追加 §9.6「subagent 中途失败处理」：
  1. subagent 主动报告失败时，自检报告第 7 段「阻塞与遗留」必填（已改文件清单 + 阻塞原因）
  2. 主 agent 收到失败报告后，用 Edit 反向编辑撤销 subagent 已改文件（不 git checkout）
  3. subagent 超时阈值：场景 A 30 分钟 / 场景 B 60 分钟（主 agent 派发时明示）
  4. 撤销后主 agent 决定：重新派发 / 拆分任务 / 自行完成 / 报告用户

#### Major-9：多 subagent 同时返回的集成顺序无规则

- **位置**：§7.3 主 agent 集成验证（行 696-705）+ §11.3 commit 拆分策略
- **现象**：§7.3 行 699 说"按 §11.3 拆分策略集成（一个 subagent 接入一次 → 跑前三绿 → 通过才接下一个）"，但**多个 subagent 同时完成时按什么顺序集成**未规定：
  - 按依赖倒序（底层先行）？§11.3 行 1121 说"commit 顺序：底层先行（Rust → 前端桥 → 前端模块 → 集成层）"，但这是 commit 顺序不是集成顺序
  - 按风险等级（低风险先集成）？
  - 按完成时间（先完成先集成）？
  - 按文件锁释放顺序？
- **影响**：主 agent 集成时无标准顺序，可能先集成依赖方再集成被依赖方，导致前三绿失败但定位困难。
- **修复建议**：§7.3 追加集成顺序规则：
  1. 按依赖倒序集成（被依赖方先行：Rust → 前端桥 → 前端模块 → 集成层）
  2. 同层按风险等级（低风险先集成，高风险后集成）
  3. 同风险按完成时间（先完成先集成）
  4. 每接入一个 subagent 跑前三绿，失败则定位是哪个 subagent 引入（git diff）

#### Major-10：场景切换判定标准与流程缺失

- **位置**：§6.3 更新时机（行 567-580）+ §1 三场景
- **现象**：§6.3 行 579 把"场景切换 A→B / B→C / 单 agent → 多 agent"列为强制保存时机，但**怎么判定场景切换发生**未规定：
  - 任务边界变化（如主 agent 从只改 docs 到要改 src/）算场景切换吗？
  - 文件锁冲突（如 subagent-A 持有的文件主 agent 也要改）算场景切换吗？
  - 切换时该做什么（清空旧锁？重新声明？跑门禁？报告用户？）未说。
- **影响**：主 agent 不知何时触发"场景切换"保存时机，可能漏保存。
- **修复建议**：§6.3 追加场景切换判定标准：
  1. 判定标准：subagent 数量变化 / subagent 写权范围变化（docs → src）/ 主 agent 是否持有运行态变化
  2. 切换流程：① 清空旧锁文件 `docs/.agent-locks.md` → ② 重新声明新场景的锁 → ③ 跑门禁前三绿确认基线 → ④ dev-state.md 追加「场景切换」记录

#### Major-11：CLAUDE.md 与规范对 dev-state.md 优先级定位冲突

- **位置**：CLAUDE.md §0 铁律 5（行 15）vs 规范 §0 行 13-20
- **现象**：
  - CLAUDE.md §0 铁律 5："当前进度、已知问题、本次恢复全过程见 `docs/dev-state.md`（**第二必读**）"
  - 规范 §0 阅读顺序：1. AGENTS.md → 2. CLAUDE.md → 3. MULTI-AGENT-WORKFLOW.md → 4. dev-state.md → 5. plan → 6. 上游参考
  
  规范把 dev-state.md 降为第 4 位（在 MULTI-AGENT-WORKFLOW.md 之后），与 CLAUDE.md "第二必读"的定位冲突。
- **影响**：AI 不知该信哪个，可能跳过 dev-state.md 直接读规范，错过当前进度记忆。
- **修复建议**：两份规范对齐阅读顺序。建议规范 §0 调整为：1. AGENTS.md → 2. CLAUDE.md → 3. dev-state.md（第二必读，与 CLAUDE.md 一致）→ 4. MULTI-AGENT-WORKFLOW.md → 5. plan → 6. 上游参考。或 CLAUDE.md §0 铁律 5 改为"第三必读"以对齐规范。

---

### Minor（9 项，建议改进）

#### Minor-12：plan 文件路径过时，§9.5 实例引用已完成任务

- **位置**：§9.5 行 944
- **现象**：实例引用 `C:\Users\Lenovo\.qoder\plans\still-crest-linnet.md`，但 dev-state.md §九.142-150 显示该 plan 任务 #15-#20 已全部完成。
- **修复建议**：§9.5 实例改为引用更新的 plan（如 `docs/reports/strands-integration-implementation-plan-2026-07-30.md` 或 `docs/reports/ssh-editor-integration-plan.md`），或注明"本实例为 2026-07-30 §九 session 案例，plan 已完成"。

#### Minor-13：subagent 数量超限处理未规定

- **位置**：§1 三场景（行 26-117）
- **现象**：§1 说场景 B 并行上限 ≤3、场景 A ≤5、场景 C ≤3，但**主 agent 派发了超限数量怎么办**（排队？拒绝？拆分？降级场景 A？）未规定。
- **修复建议**：§1 追加超限处理规则：超限时主 agent 拆分为多轮派发（前 N 个先跑，完成的释放锁后接下一批），或降级为场景 A（只读调研）。

#### Minor-14：§14 实例只覆盖一个 session，未沉淀近 6 个 session 经验

- **位置**：§14（行 1213-1245）
- **现象**：dev-state.md §九~§十五 共 7 个 session 有多 agent 协作实践，规范 §14 仅引用 §九 一个案例（2026-07-30 主 agent + 3 subagent）。
- **修复建议**：§14 追加 §十~§十五 的多 agent 协作摘要（每个 session 一段，含场景/任务/持有文件/冲突/经验），形成"多 agent 协作案例库"。

#### Minor-15：§6.5 数据契约 8 字段落地位置未规定

- **位置**：§6.5（行 630-645）
- **现象**：列出 8 字段（task_description / completed_work / failed_approaches / next_steps / memory_artifacts / handoff_reason / lock_state / collaboration_scenario），但**这些字段写到哪**（dev-state.md 交接章？单独 JSON 文件？对话回执？）未说。
- **修复建议**：§6.5 追加字段落地位置：8 字段全部写入 `docs/dev-state.md` 交接章的「多 agent 协作情况」节（§6.4 行 606-614 模板已含部分字段，可扩展）。

#### Minor-16：§3.2 锁文件检查时机未规定

- **位置**：§3.2（行 257-278）
- **现象**：锁文件 `docs/.agent-locks.md` 是软约束，但**主 agent 何时检查锁文件**未规定（每次派发前？集成时？commit 前？）。
- **修复建议**：§3.2 追加检查时机：① 派发 subagent 前必读锁文件确认无冲突；② 集成 subagent 改动前必读锁文件确认该 subagent 持有的文件；③ commit 前必读锁文件确认所有 subagent 已释放锁。

#### Minor-17：未定义术语首次出现无定义

- **位置**：散见全文
- **现象**：「主工作树」（§5）「集成」（§7.3）「反向编辑」（§10.4）「让渡」（§5.3）「软约束」（§3.2）等术语首次出现无定义。
- **修复建议**：§0 或文末加「术语表」节，定义这 5 个术语。

#### Minor-18：Python sidecar 已修复未反映

- **位置**：§4.2 行 387
- **现象**：dev-state.md §十.268-274（commit 2091e2f）显示 sidecar P0 已修（MAX_RETRY 3→5 / 指数退避 1/2/4/8/16/32/60s / cancel_tx / start() 失败路径补 child.kill()+wait()）。但规范 §4.2 行 387 仍说"sidecar（魔改独有，Python 进程管理）"，未说明 P0 已修。
- **修复建议**：§4.2 行 387 追加"（P0 指数退避已修，commit 2091e2f）"。

#### Minor-19：§4.3 可并行模块对未含 Strands/rust_bridge

- **位置**：§4.3（行 408-422）
- **现象**：新增的 Python 模块（strands_backend / rust_bridge）与前端/Rust 的并行关系未分析。
- **修复建议**：§4.3 追加可并行对：`strands_backend` / `Rust ssh::ssh_command`（Python 适配层 vs Rust 命令实现，独立 crate/language）；§4.4 追加不可并行对：`strands_backend/adapter.py` / `rust_bridge.py`（紧耦合，adapter 直接调 rust_bridge.send_request）。

#### Minor-20：§7.5 门禁责任矩阵未含 Python pytest

- **位置**：§7.5（行 716-724）
- **现象**：dev-state.md 显示 Python pytest 是重要门禁（§十三.814：1325 passed；§十四.918：1276 passed；§十五.1102：1276 passed）。但规范 §7.5 矩阵只列 typecheck / lint / test / build:web / tauri:dev / cargo check **6 项**，**未含 pytest**。
- **影响**：改 Python sidecar 代码的 subagent 不知要跑 pytest，可能引入 Python 回归。
- **修复建议**：§7.5 矩阵追加 `pytest` 列，场景 B（改 Python 时）必跑，主 agent 集成时必跑。

---

## 4. 改进建议（可操作的具体修改）

### 4.1 立即修复（Critical 4 项）

| 优先级 | 修改文件 | 修改内容 |
|--------|---------|---------|
| P0 | `AGENTS.md` | 接手前必读列表追加第 3 项 `docs/MULTI-AGENT-WORKFLOW.md`（多 agent 协作规范） |
| P0 | `CLAUDE.md` §6 行 137-142 | 记忆文档位置表追加一行 `docs/MULTI-AGENT-WORKFLOW.md`（多 agent 协作规范） |
| P0 | `docs/MULTI-AGENT-WORKFLOW.md` 全局 | "830 全过" 全局替换为 "832 全过"（§7.1 / §7.2 / §9.3 / §9.4 / §13 / §2.2 共 6 处） |
| P0 | `CLAUDE.md` §4 行 108 | "当前 830 全过" 改为 "当前 832 全过" |
| P0 | `docs/MULTI-AGENT-WORKFLOW.md` §13 行 1206 | 红线 13 改为"subagent 不**直接**改 docs/MULTI-AGENT-WORKFLOW.md，**经主 agent 派发授权 + 用户确认后可改**" |
| P0 | `docs/MULTI-AGENT-WORKFLOW.md` §9.5 行 944 | 实例注明"本规范属例外，经用户授权 subagent-C 撰写" |

### 4.2 短期补充（Major 7 项）

| 优先级 | 修改位置 | 修改内容 |
|--------|---------|---------|
| P1 | §4.1 / §4.2 / §3.1 / §4.5 / §4.4 | 补充 Strands / rust_bridge / ssh_command 等新模块（见 Major-5 修复建议） |
| P1 | §4.5 行 457 + §4.1 | SshFileEditor → EditorStack/EditorPane/useDocument（见 Major-6 修复建议） |
| P1 | §10 追加 §10.5 | 多 commit 回滚策略（见 Major-7 修复建议） |
| P1 | §9 追加 §9.6 | subagent 中途失败处理（见 Major-8 修复建议） |
| P1 | §7.3 追加集成顺序规则 | 依赖倒序 / 风险等级 / 完成时间三级排序（见 Major-9 修复建议） |
| P1 | §6.3 追加场景切换判定标准 | 判定标准 + 切换流程 4 步（见 Major-10 修复建议） |
| P1 | 规范 §0 或 CLAUDE.md §0 | 阅读顺序对齐：dev-state.md 应为"第二必读"（见 Major-11 修复建议） |

### 4.3 中期优化（Minor 9 项）

| 优先级 | 修改位置 | 修改内容 |
|--------|---------|---------|
| P2 | §9.5 行 944 | plan 文件路径更新或注明已完成（Minor-12） |
| P2 | §1 追加超限处理 | 数量超限时拆分多轮或降级场景 A（Minor-13） |
| P2 | §14 追加案例库 | 沉淀 §十~§十五 共 6 个 session 多 agent 经验（Minor-14） |
| P2 | §6.5 追加字段落地 | 8 字段写入 dev-state.md 交接章（Minor-15） |
| P2 | §3.2 追加检查时机 | 派发前 / 集成前 / commit 前三必读（Minor-16） |
| P2 | §0 或文末加术语表 | 定义 5 个术语（Minor-17） |
| P2 | §4.2 行 387 | sidecar P0 已修注记（Minor-18） |
| P2 | §4.3 / §4.4 追加 Strands 对 | 可并行 + 不可并行模块对补充（Minor-19） |
| P2 | §7.5 矩阵追加 pytest 列 | 改 Python 时必跑（Minor-20） |

---

## 5. 与实际项目状态对齐情况

### 5.1 已对齐项

- 多 agent 协作模式（主 + subagent / 文件路径独占 / 零冲突）与 dev-state.md §九~§十五 实践一致
- 五绿门禁、CDP 9222、端口 9300/9222 单实例、Windows 原子写不重编 Rust 等技术细节与 dev-state.md §八~§十五 一致
- 防污染红线 8 条与 CLAUDE.md §3 一致
- 主工作树不用 git worktree 决策与 dev-state.md §八 实测踩坑一致
- 文件锁机制（`docs/.agent-locks.md`）与 dev-state.md §九.233-241 实践一致

### 5.2 漂移项汇总

| 漂移类型 | 数量 | 严重度分布 |
|---------|------|----------|
| 入口文件未引用本规范 | 2（AGENTS.md / CLAUDE.md） | Critical |
| 测试数基线漂移 | 6 处 | Critical |
| 规范自相矛盾 | 1（红线 13 vs §9.5） | Critical |
| 新模块未纳入 | 9 个新文件/模块 | Major |
| 已删除文件仍引用 | 1（SshFileEditor） | Major |
| 流程缺失 | 4（回滚/中途失败/集成顺序/场景切换） | Major |
| 阅读顺序冲突 | 1（dev-state.md 优先级） | Major |
| 案例单一 | 6 个 session 未沉淀 | Minor |
| 术语未定义 | 5 个 | Minor |
| 门禁缺失 | 1（pytest） | Minor |

### 5.3 漂移根因分析

1. **规范一次撰写后未随项目演进同步更新**：规范 v2.0 于 2026-07-30 由 subagent-C 撰写，但撰写后项目又推进了 §十~§十五 共 6 个 session（SSH 文件编辑器集成 / Strands 集成 / 双向 JSON-RPC 桥 / Critical Bug 修复 / P0-E 阶段 A），规范未跟进。
2. **规范与 CLAUDE.md/AGENTS.md 双向引用未建立**：规范自称"必读第二文档"但 CLAUDE.md/AGENTS.md 未承认，缺乏双向同步机制。
3. **测试基线变更触发点未执行**：§16 行 1274 已提到"五绿门禁阈值变化时更新 §7.1 / §7.5 / §12 脚本"，但 §十一 引入 +2 测试后未执行更新。

---

## 6. 引用规范文件中的具体行号

### 6.1 Critical 问题行号

| 问题 | 规范行号 | 内容摘要 |
|------|---------|---------|
| Critical-1 | AGENTS.md 行 5-7 | "接手前必读：1. CLAUDE.md 2. docs/dev-state.md"——缺 MULTI-AGENT-WORKFLOW.md |
| Critical-2 | CLAUDE.md §6 行 137-142 | 记忆文档位置表 4 行，未含本规范 |
| Critical-2 | 规范 §0 行 7 | "本规范与 CLAUDE.md 同级，是 AI 接手必读第二文档" |
| Critical-3 | 规范 §2.2 行 144 | "pnpm test 830 全过" |
| Critical-3 | 规范 §7.1 行 658 | "pnpm test # vitest run，当前 830 全过" |
| Critical-3 | 规范 §7.2 行 668 | "基线 830 全过" |
| Critical-3 | 规范 §9.3 行 863 | "pnpm test：必须 830 全过" |
| Critical-3 | 规范 §9.4 行 911 | "基线 830 全过，本次 <N> 全过" |
| Critical-3 | 规范 §13 行 1198 | "五绿门禁 + tauri:dev 实测，subagent 跑前三绿" |
| Critical-4 | 规范 §13 行 1206 | "subagent 不改 docs/MULTI-AGENT-WORKFLOW.md（规范由主 agent 独占）" |
| Critical-4 | 规范 §3.1 行 240 | "docs/MULTI-AGENT-WORKFLOW.md（本文件）协调互斥，改动需主 agent 独占 + 用户确认" |
| Critical-4 | 规范 §9.5 行 944-948 | "subagent-C：撰写本规范文档（v2.0 覆盖更新）" |
| Critical-4 | 规范 §14.1 行 1224 | "subagent-C \| A \| 撰写本规范文档 \| docs/MULTI-AGENT-WORKFLOW.md \| 完成" |

### 6.2 Major 问题行号

| 问题 | 规范行号 | 内容摘要 |
|------|---------|---------|
| Major-5 | 规范 §4.1 行 295-358 | 前端模块图 23 模块，未含 Strands 相关 |
| Major-5 | 规范 §4.2 行 364-406 | Rust 模块图 14 模块，未含 ssh_command |
| Major-5 | 规范 §3.1 行 224-249 | 互斥矩阵 23 行，未含 strands_backend / rust_bridge |
| Major-5 | 规范 §4.5 行 443-496 | 改动影响表 20+ 行，未含 Strands/rust_bridge/ssh_command |
| Major-6 | 规范 §4.5 行 457 | "SshFileEditor" 已删除仍引用 |
| Major-6 | 规范 §4.1 行 330-334 | ssh-explorer 模块图未体现 EditorStack 集成 |
| Major-7 | 规范 §10.4 行 1019-1022 | 撤销规则仅 Edit 反向编辑，多 commit 回滚缺失 |
| Major-8 | 规范 §9 行 802-974 | subagent 任务分配，无中途失败处理 |
| Major-9 | 规范 §7.3 行 696-705 | 集成验证，无多 subagent 集成顺序规则 |
| Major-10 | 规范 §6.3 行 567-580 | 更新时机表含"场景切换"，但无判定标准 |
| Major-11 | CLAUDE.md §0 行 15 | "docs/dev-state.md（第二必读）" |
| Major-11 | 规范 §0 行 13-20 | 阅读顺序 dev-state.md 排第 4 位 |

### 6.3 Minor 问题行号

| 问题 | 规范行号 | 内容摘要 |
|------|---------|---------|
| Minor-12 | 规范 §9.5 行 944 | 引用 still-crest-linnet.md（已完成） |
| Minor-13 | 规范 §1 行 42/64/116 | 并行上限 ≤5/≤3/≤3，超限处理未规定 |
| Minor-14 | 规范 §14 行 1213-1245 | 仅覆盖 §九 一个 session |
| Minor-15 | 规范 §6.5 行 630-645 | 8 字段落地位置未规定 |
| Minor-16 | 规范 §3.2 行 257-278 | 锁文件检查时机未规定 |
| Minor-17 | 规范 §5/§7.3/§10.4/§5.3/§3.2 | 5 个术语未定义 |
| Minor-18 | 规范 §4.2 行 387 | "sidecar（魔改独有，Python 进程管理）"未注 P0 已修 |
| Minor-19 | 规范 §4.3 行 408-422 | 可并行模块对未含 Strands |
| Minor-20 | 规范 §7.5 行 716-724 | 门禁责任矩阵未含 pytest |

---

## 7. 审查结论

### 7.1 整体评价

`docs/MULTI-AGENT-WORKFLOW.md` v2.0 是一份**结构完整、可执行性强**的多 agent 协作规范，A/B/C 三场景分层、文件锁矩阵、改动影响分析表、自检报告模板等核心内容可直接复制使用，体现了业界最佳实践（Anthropic subagents / OpenAI Handoffs / AWS AGENTOPS01-BP02 / GALDUR / dispatching-parallel-agents skill）与本项目实际踩坑（CLAUDE.md 红线 / dev-state.md 经验）的融合。

### 7.2 主要风险

规范的主要风险是**与项目实际状态系统性滞后**：撰写后项目又推进了 6 个 session（Strands 集成 / 双向 JSON-RPC 桥 / Critical Bug 修复 / SSH 文件编辑器集成 / P0-E 阶段 A），规范未跟进。这导致：

1. 新模块（strands_backend / rust_bridge / ssh_command）无互斥规则
2. 已删除文件（SshFileEditor）仍被引用
3. 测试基线（830 vs 832）漂移
4. 入口文件（AGENTS.md / CLAUDE.md）未互引本规范

### 7.3 建议优先级

1. **立即修复 Critical 4 项**（入口文件互引 / 测试基线刷新 / 红线 13 自洽）——这些会直接误导接手 AI
2. **短期补充 Major 7 项**（新模块纳入 / 流程缺失补充）——这些影响实用性
3. **中期优化 Minor 9 项**（案例库 / 术语表 / 门禁补充）——这些提升完整性

### 7.4 长期机制建议

为防止规范再次漂移，建议在 §16 演进章节追加**强制同步触发点**：

1. 每完成一个 session（dev-state.md 追加新交接章）时，主 agent 必须检查本规范是否需要同步更新（新模块 / 新文件 / 新场景）
2. 测试基线变化时（test 数变化）必须同步更新 §7.1 / §7.5 / §12 脚本
3. CLAUDE.md / AGENTS.md 改动时必须双向检查本规范引用是否仍一致
4. 每个新 session 开始时，主 agent 必读本规范 §14 案例库，追加上一 session 的多 agent 协作摘要

---

> **审查者**：代码审查子 agent（场景 A，只读代码 + 只写本报告）
> **审查日期**：2026-07-30
> **审查范围**：`docs/MULTI-AGENT-WORKFLOW.md` v2.0 全文 1284 行 + 交叉对照 `CLAUDE.md` / `AGENTS.md` / `docs/dev-state.md`（截至 §十五）
> **未修改被审查文档**：本报告仅审查，未修改 `docs/MULTI-AGENT-WORKFLOW.md` 本身（按任务约束）
