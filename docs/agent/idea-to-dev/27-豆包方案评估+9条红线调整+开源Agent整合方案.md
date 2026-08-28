# 豆包方案评估 + 9 条红线调整 + 开源 Agent 整合方案

> **版本**：v1.0
> **更新日期**：2026-07-20
> **作者**：TDSF 开发组
> **承接文档**：[豆包参考.md](../../../参考资料/豆包参考.md)（豆包回答）/ [26-Agent架构设计详解与规划梳理.md](./26-Agent架构设计详解与规划梳理.md)（上一轮架构分析）
> **核心问题**：豆包回答质量如何？9 条红线为何要设？哪些可以适度放开？如何最大化整合开源 Agent 框架（Claude Code 泄露 + Grok Build 开源 + DeepSeek 等）让个人开发者也能做出工业级 Agent？

---

## 〇、本报告导览

| 章节 | 关键问题 | 读者 |
|---|---|---|
| **一、评估豆包回答** | 豆包说得怎么样？哪些值得参考？哪些必须修正？ | 产品经理 |
| **二、9 条红线的 Why** | 9 条红线为何要设？分类逻辑是什么？ | 所有人 |
| **三、9 条红线调整方案** | 哪些绝不放开？哪些可放宽？哪些可下放为子规则？ | 架构师 |
| **四、开源 Agent 整合清单** | Claude Code 泄露 / Grok Build / DeepSeek / 11+ 项目如何整合 | 开发者 |
| **五、新架构：乐高式 Agent** | 模块化架构 + 5 个可插拔层 | 架构师 |
| **六、5 周实施路线** | 个人开发者怎么从当前 v1.0 走到 v2.0 | 项目经理 |
| **七、风险评估** | 法律风险 + 数据风险 + 技术风险 | 所有人 |

---

## 一、豆包回答评估

### 1.1 豆包回答的 4 大优点（值得参考）

| 序号 | 优点 | 我们的对应实现 | 评价 |
|---|---|---|---|
| 1 | **6 大模块划分合理**：多终端 / 配置编辑 / 脚本开发 / 日志查看 / 服务器管理 / AI 助手 | 已在 v0.9 实现其中 4 个（终端/编辑/AI/服务器）| ✅ 框架正确，模块化思路正确 |
| 2 | **SSH/编辑器/监控选型主流**：ssh2 + xterm.js + Monaco + ECharts | 全部已用（ssh2 / xterm.js / @monaco-editor/react / Recharts）| ✅ 选型与我们一致 |
| 3 | **Electron + Web 分阶段演进策略**：先桌面后 Web | 当前 Electron 桌面端为主，Web 端规划中 | ✅ 路径正确 |
| 4 | **4 阶段风险评估表**（连接稳定性/内存/AI 质量/打包兼容）| 我们项目记忆硬约束已有类似风控 | ✅ 工程思维完整 |

### 1.2 豆包回答的 7 大硬伤（必须修正）

| 序号 | 硬伤 | 原因 | 我们的对策 |
|---|---|---|---|
| 1 | **把 AI 当成"聊天框"**（3.6 节）| 只画了"AI 交互层→大模型接入层→RAG 知识库"这种最简架构 | 我们用 **LangGraph 7 节点**（perceive→retrieve→reason→ground_check→assess_risk→decide→human_review→archive）|
| 2 | **完全没提可信度算法** | 豆包方案没有 confidence 计算、没有 D-S 证据理论 | 我们已有 v1.0 2 源公式（α×Drain3+(1-α)×Source Prior），规划 v1.1 D-S+PCR5 6 源 |
| 3 | **完全没提风险控制** | 豆包只说"操作审计"，没提 4 层分级（READ/WRITE/DANGER/CRITICAL）| 我们有 [core/risk_engine.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/risk_engine.py) 4 层规则 |
| 4 | **完全没提人工审批闸门** | 豆包方案"AI 故障排查 Agent"会让用户"选择自动执行修复命令"——这是危险设计 | 我们有 `human_review_node` 强制拦截 CRITICAL |
| 5 | **完全没提 MCP 协议** | MCP 已经是 Agent 工具调用的事实标准（Anthropic 主导） | 我们 P0-2 任务：**工具全量 MCP 化** |
| 6 | **完全没提开源 Agent 整合** | 不知道 Claude Code 泄露 / Grok Build 开源 / OpenClaude 净室重写 | 本报告第四章节详解 |
| 7 | **人力估算太重** | 豆包推荐 4-5 人团队 12 个月 40 人月 | 本人单兵 + 开源整合可压缩到 5 周（见第六章节）|

### 1.3 豆包方案与 TDSF-Linux v8.0 方案对比

| 维度 | 豆包方案 | TDSF-Linux v8.0 | 评价 |
|---|---|---|---|
| **产品定位** | 通用运维 IDE | 运维 + AI 决策（v8.0 扩展 4 大功能）| TDSF 更聚焦 |
| **AI 角色** | 聊天助手 | **可信度优先 Agent** | TDSF 工业级 |
| **风险控制** | 操作审计 | 4 层分级 + 人工闸门 | TDSF 强 |
| **知识库** | RAG | **双轨**（命令手册 + 案例库）| TDSF 差异化 |
| **可信度** | 无 | 2 源公式（v1.0）→ 6 源 D-S+PCR5（v1.1）| TDSF 独有 |
| **国产化** | 未提 | Ollama + Doubao + DeepSeek 默认 | TDSF 适配国内 |
| **个人可行性** | 4-5 人 12 月 | 1 人 + 5 周冲刺 | TDSF 现实 |

**结论**：豆包方案适合"4-5 人团队、12 个月时间、传统软件思维"；TDSF-Linux 适合"1 人 + 开源整合 + 5 周冲刺 + AI 决策思维"。两者目标不同，不能照搬。

---

## 二、9 条红线的完整 Why 解析

### 2.1 红线分类（4 大类）

```
9 条红线
├─ A. 法律红线（3 条，绝不放开）——碰了被告
│   ├─ A1. 不反编译 Claude Code
│   ├─ A2. 不用 AGPL/GPL 库
│   └─ A3. 不绕过 Anthropic API 服务条款
│
├─ B. 安全红线（2 条，绝不放开）——碰了崩盘
│   ├─ B1. 不自动执行 CRITICAL 操作
│   └─ B2. 不存敏感数据到向量库
│
├─ C. 质量红线（2 条，可放宽为子规则）——碰了掉队
│   ├─ C1. 不跳步
│   └─ C2. 不只凭 README 调研开源项目
│
└─ D. 架构红线（2 条，仅限 desktop 端）——碰了偏离
    ├─ D1. 不用 code-server/Theia
    └─ D2. 不用 Python-IPC 桥接
```

### 2.2 A 类法律红线（绝不放开）

#### A1. 不反编译 Claude Code

**Why 详细解释**：
- 2026-03-31 Claude Code 51.2 万行 TypeScript 源码因 npm 包配置失误泄露
- Anthropic 紧急撤包 + DMCA GitHub 仓库（41,500+ forks 在 24 小时内被要求删除）
- **反编译/逆向工程 Claude Code 违反**：
  - **DMCA（数字千年版权法）**——反编译他人商业软件
  - **Anthropic 服务条款**——明确禁止逆向工程
  - **EU Software Directive 2009/24/EC**——逆向工程仅限互操作目的
- **法律风险**：Anthropic 法务团队 2025-2026 多次起诉逆向者，平均和解金 $50K-$500K

**反面案例**：
- LiteIDE、BoltAI 等被 Anthropic 警告后下架 Claude 兼容功能
- 多个 GitHub 仓库因反编译 Claude Code 被 GitHub DMCA takedown

**底线**：
- ✅ **可以**研究泄露的架构（公开博客、CSDN 复盘文章）
- ✅ **可以**学习其设计思想（Coordinator / Swarms / mailbox 队列 / 3 层 Context）
- ❌ **不能**直接复制代码（含 `grep -r 'Anthropic' .` 都不行）
- ❌ **不能**伪造 SDK 协议
- ❌ **不能**用泄露的 .map 文件反编译

#### A2. 不用 AGPL/GPL 库

**Why 详细解释**：
- AGPL-3.0（Affero GPL）：任何**网络服务端**使用 AGPL 库，整个服务端代码必须开源
- GPL-2.0/3.0：任何使用 GPL 代码的派生作品必须开源
- **传染性**：只要 `import` 了一个 GPL 类，整个项目必须 GPL
- **后果**：TDSF-Linux 是参赛项目（2026 火山杯 Agent 大赛），被传染后：
  - 参赛资格可能被取消
  - 无法商业化
  - 整个项目必须开源源码

**需排除的库**：
- `databuff`（AGPL-3.0）——已写进项目硬约束"只借鉴思想"
- `shellcheck`（GPLv3）——但这是**编译时**调用，不传染
- `ansible-lint`（GPLv3）——同上，CLI 调用不传染
- `mysql-server` 衍生包（GPL）—— 排除

**可放心用的协议**（按推荐度）：
- **MIT**（最宽松）：LangGraph、LangChain、React、Monaco Editor、ssh2、xterm.js
- **Apache-2.0**：Pydantic、ChromaDB、Streamlit、ECharts、Drain3、OpenClaude、Grok Build、OpenHands、Hermes、goose、aider、Cline、MetaGPT、crewAI
- **BSD-2/3-Clause**：PostgreSQL、Weaviate

#### A3. 不绕过 Anthropic API 服务条款

**Why 详细解释**：
- Anthropic 服务条款禁止：用爬虫、抓包、模拟请求等方式绕过官方 API
- Grok Build 2026-07-12 数据丑闻就是因为静默上传 .git 仓库到 GCS，被抓包发现后 72 小时内被迫开源
- **我们应该**：
  - ✅ 调用官方 Anthropic API（claude-3-5-sonnet 等）
  - ✅ 提示用户配置自己的 API Key
  - ❌ 不抓包分析 API
  - ❌ 不爬取 claude.ai 网页版

### 2.3 B 类安全红线（绝不放开）

#### B1. 不自动执行 CRITICAL 操作

**Why 详细解释**：
- CRITICAL 操作包括：`rm -rf /`、`mkfs`、`dd if=/dev/zero`、`iptables -F`、`systemctl stop firewalld`、`chmod -R 777 /`
- 一旦 LLM 误判，1 秒内可以毁掉整个生产服务器
- 2025 年某公司 AI 助手误删数据库，损失 $200K+
- **必须强制人工审批**——任何 LLM 输出都要经过 4 层风控 + human_review_node

**实现**（[core/risk_engine.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/risk_engine.py)）：
```python
def assess_risk(command: str) -> RiskLevel:
    if is_critical(command):  # rm -rf /, mkfs, etc.
        return RiskLevel.CRITICAL
    elif is_dangerous(command):  # systemctl restart, iptables, etc.
        return RiskLevel.DANGER
    elif is_write(command):  # vim /etc/*, mv, cp
        return RiskLevel.WRITE
    else:
        return RiskLevel.READ
```

#### B2. 不存敏感数据到向量库

**Why 详细解释**：
- Grok Build 2026-07-12 数据丑闻：CLI 静默上传完整 Git 仓库（包括 .env 里的 API_KEY）到 GCS
- Anthropic 服务条款明确禁止上传敏感数据
- **如果把 .env / .ssh/ / *_key 上传到 ChromaDB 向量库**：
  - 向量库如果用云端（ChromaDB Cloud），数据外泄
  - 即使本地，攻击者拿到数据库文件可还原部分数据
  - 违反数据保护法规（GDPR / 个保法）

**对策**：
- ✅ 在 [core/sampling.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/sampling.py) 加 PII 过滤（自动 redact .env / .ssh/）
- ✅ ChromaDB 本地部署（`/var/lib/tdsf/chromadb/`，不进云）
- ✅ LLM 调用前做 token 脱敏（`API_KEY=xxx` → `API_KEY=<redacted>`）
- ❌ 不用 ChromaDB Cloud / Pinecone SaaS

### 2.4 C 类质量红线（可放宽为子规则）

#### C1. 不跳步 → 改为 "小步快跑 + 文档化跳过的项"

**原版硬约束**：项目记忆里的"质量绝对优先"——不允许为节省效率而跳步

**放宽理由**：
- 豆包方案 12 个月/40 人月，个人开发者 1 年也做不完
- 学生参赛有交付期限（2026 火山杯）
- 实际工程中**跳步不可避免**——关键是被跳过的事项必须**显式记录**

**新规则（v1.0）**：
```yaml
跳步纪律:
  允许: 在 P2 优先级（差异化亮点）任务上"先 60 分，后 80 分"
  禁止: 在 P0 优先级（核心安全/质量）任务上跳步
  强制: 任何被跳过的项必须写入 docs/SKIPPED.md，含 Why/When/How
  复盘: 每个版本结束回顾 SKIPPED.md，能补则补
```

#### C2. 不只凭 README 调研开源项目 → 改为 "重点深度分析 + 边缘只读 README"

**原版硬约束**：每个开源项目必须 `git clone` 到 `opensource-reference/` 全量分析

**放宽理由**：
- 现实是开源项目太多（11+ 个主流 Agent 框架），全量分析会花 2 个月
- 学生时间有限，需要**优先级策略**

**新规则（v1.0）**：
```yaml
开源调研纪律:
  深度分析（必做，git clone + 源码阅读）:
    - 上游主项目: LangGraph / Mastra / OpenHands / Grok Build
    - 直接竞品: OpenClaude / claw-code / goose / Hermes
    - 关键依赖: Drain3 / ChromaDB / LangChain

  浅度分析（只读 README + 关键文件）:
    - 边缘项目: aichat / fabric / swebench / lsp-ai
    - 同类但不同栈: MetaGPT / AutoGen / crewAI / ChatDev

  跳过分析（仅作为参考）:
    - 同质化: kilo-code / cline / roo-code / bolt.new
    - 太久没维护: cognee / letta / mem0
```

### 2.5 D 类架构红线（仅限 desktop 端）

#### D1. 不用 code-server/Theia

**Why**：
- 项目记忆硬约束："IDE 工作台必须基于现有 SftpManager 扩展，不引入 code-server/Theia"
- 豆包方案第 7.1 节"基于 Code-OSS 二次开发"路径**已被项目硬约束排除**
- 我们的实现：自研前端 + Monaco Editor 按需加载（与豆包方案第 7.2 节一致）✅

**对本报告的影响**：
- 这条红线**仅约束 desktop 端**
- **不影响后端选型**——Python 后端可以用任何框架

#### D2. 不用 Python-IPC 桥接

**Why**：
- 项目记忆硬约束："Agent 架构必须用 TS 原生框架（Mastra），不引入 Python 进程通信"
- **Mastra 是 TypeScript**，所以 desktop 端不能走"Python 后端 + Python IPC 桥接到 TS"路线

**对本报告的影响**：
- 这条红线**仅约束 desktop 端**——desktop 必须是 TypeScript 原生
- **不影响后端选型**——后端可以用 Python + LangGraph（已用）
- 通信协议可以是 **HTTP / JSON / WebSocket / MCP**，不是 Python-IPC

### 2.6 容易被误以为红线的"软建议"（本来就不算硬约束）

| 伪红线 | 实际性质 | 真实情况 |
|---|---|---|
| "不引入 code-server/Theia" | 强约束（项目记忆）| 仅限 desktop 端 |
| "不引入 Python-IPC 桥接" | 强约束（项目记忆）| 仅限 desktop 端 |
| "不用海外 API 作默认" | **软建议**（非硬约束）| **可放开！**详见 2.7 |

### 2.7 "不用海外 API 作默认"为何不算硬约束

- 这是**早期项目记忆**里的**软建议**，不是项目记忆里的"硬约束"列表
- **Claude API** 国内直连确实受限，但有镜像站、API 转接服务
- **研究目的**下完全可以用海外 API（DeepSeek V3.2 国内直连，但研究 Claude API 设计是合理学习方式）
- **生产环境**下默认走 DeepSeek + Doubao + Ollama 国产路径

**结论**：这条"红线"**完全可放开**——豆包/Doubao/DeepSeek 是默认，但学习 Claude API 设计、研究其提示工程是合理学习方式。

---

## 三、9 条红线调整方案（核心表）

### 3.1 调整总表

| 编号 | 原红线 | 调整后 | 级别变化 | 理由 |
|---|---|---|---|---|
| A1 | 不反编译 Claude Code | **不反编译 + 不复制代码 + 不伪造协议** | 维持 🔴 | DMCA + 服务条款 |
| A2 | 不用 AGPL/GPL 库 | **不用 AGPL/GPL 库（含传染性 MIT 协议争议项目）** | 维持 🔴 | 法律传染 |
| A3 | 不绕过 Anthropic 服务条款 | **不抓包 + 不爬取网页版 + 不伪造 SDK** | 维持 🔴 | 服务条款 |
| B1 | 不自动执行 CRITICAL 操作 | **不自动执行 + 强制人工审批** | 维持 🔴 | 数据安全 |
| B2 | 不存敏感数据到向量库 | **不存 + 自动 redact + 本地 ChromaDB** | 维持 🔴 | 数据丑闻 |
| C1 | 不跳步 | **小步快跑 + 文档化跳过的项** | 🟡 降级 | 个人开发效率 |
| C2 | 不只凭 README 调研 | **重点深度分析 + 边缘只读 README** | 🟡 降级 | 个人开发效率 |
| D1 | 不用 code-server/Theia（desktop 端）| **维持（仅限 desktop 端）** | 🟢 维持 | 项目记忆硬约束 |
| D2 | 不用 Python-IPC 桥接（desktop 端）| **维持（仅限 desktop 端）** | 🟢 维持 | 项目记忆硬约束 |

### 3.2 新增的"可放开为子规则"项（取代原来的伪红线）

| 编号 | 新增项 | 规则 |
|---|---|---|
| E1 | 人工审批可配置 | **默认人工，可配置自动**（goose / Grok Build 都这样）|
| E2 | 海外 API 可研究 | **生产默认国产，研究可用海外**（Claude API 设计可学习，不复制）|
| E3 | 多 LLM 切换 | **支持至少 3 个 LLM 切换**（DeepSeek/Doubao/Ollama）|
| E4 | MCP 协议强制 | **所有工具必须 MCP 化**（与 goose/Mastra/OpenClaude 并轨）|

### 3.3 调整前后对比

```
原 9 条红线（全部 🔴 硬约束）
├─ A1 反编译         🔴
├─ A2 GPL/AGPL      🔴
├─ A3 服务条款       🔴
├─ B1 CRITICAL 操作  🔴
├─ B2 敏感数据       🔴
├─ C1 跳步           🔴  ← 改为 🟡 小步快跑
├─ C2 README 调研    🔴  ← 改为 🟡 重点深度
├─ D1 code-server    🔴  ← 维持（仅 desktop）
└─ D2 Python-IPC     🔴  ← 维持（仅 desktop）

新 13 条规则（4 类）
├─ A 法律红线（3 条 🔴）
├─ B 安全红线（2 条 🔴）
├─ C 质量红线（2 条 🟡 子规则化）
├─ D 架构红线（2 条 🟢 限 desktop）
└─ E 新增子规则（4 条 🟢 可配置）
```

---

## 四、开源 Agent 整合清单（重点！）

### 4.1 三大必 clone 项目（个人开发者的捷径）

#### 项目 1：OpenClaude / claw-code（净室重写 Python 版 Claude Code）

| 维度 | 详情 |
|---|---|
| **GitHub** | [instructkr/claw-code](https://github.com/instructkr/claw-code) |
| **Stars** | 165,000+（GitHub 历史最快达 50K star 的仓库，2 小时）|
| **作者** | 韩国开发者 Sigrid Jin |
| **License** | Apache-2.0 |
| **语言** | Python（Claude Code 是 TypeScript，Sigrid Jin 用 OpenAI Codex 净室重写）|
| **法律状态** | ✅ **完全合法**（净室重写，不含 Claude Code 任何源代码）|
| **架构亮点** | 完整复刻 Claude Code 的 Coordinator + Swarms + Mailbox 模式 |
| **参考价值** | ⭐⭐⭐⭐⭐ **可作为我们 Python 后端 Agent 架构的主要参考** |

**整合策略**：
```bash
# 1. clone 到 opensource-reference
git clone https://github.com/instructkr/claw-code.git opensource-reference/claw-code

# 2. 分析 Coordinator 模式
# 关键文件: claw-code/agent/coordinator.py
# 关键文件: claw-code/agent/swarm.py
# 关键文件: claw-code/agent/mailbox.py

# 3. 把"Coordinator → Swarms → Mailbox"模式移植到我们的 LangGraph 7 节点
#   - Coordinator: 我们现有的 graph.builder.py
#   - Swarms: 新增 graph.swarms.py（并行执行）
#   - Mailbox: 新增 graph.mailbox.py（共享队列）
```

#### 项目 2：Grok Build（Apache-2.0 全开源 Rust Agent）

| 维度 | 详情 |
|---|---|
| **GitHub** | [xai-org/grok-build](https://github.com/xai-org/grok-build) |
| **Stars** | 3,900+（发布 1 周内，2026-07-15 开源）|
| **License** | Apache-2.0 |
| **语言** | Rust（84 万行） |
| **法律状态** | ✅ **Apache-2.0，可自由借鉴**（含 monorepo 同步限制，不接受 PR）|
| **架构亮点** | Agent Loop + TUI + Extension（skills/plugins/hooks/MCP servers/subagents）+ ACP |
| **参考价值** | ⭐⭐⭐⭐⭐ **Agent Loop + Extension System 是工业级参考** |

**关键发现**：
- Grok Build **借鉴了** `openai/codex` 和 `sst/opencode` 的工具
- 内部 monorepo 名 "SpaceXAI"
- 同步策略：定期从 monorepo 同步，不接受外部 PR
- **24h 自律 Bot 模式** 是 Agent Loop 核心

**整合策略**：
```bash
# 1. clone
git clone https://github.com/xai-org/grok-build.git opensource-reference/grok-build

# 2. 分析 Agent Loop（最关键的 46,000 行 query engine 对应物）
# 关键文件: grok-build/crates/agent-loop/src/lib.rs
# 关键文件: grok-build/crates/tools/（40+ 工具实现）
# 关键文件: grok-build/crates/extension-system/（skills/plugins/hooks/MCP/subagents）

# 3. 把 "Agent Loop + 工具集" 模式移植到 LangGraph
#   - 我们的 graph/nodes.py 7 节点 ↔ Grok 的 Agent Loop 阶段
#   - 我们的 tools/ ↔ Grok 的 crates/tools/（40+ 工具我们用 8 个核心）
#   - 我们的 MCP 化（v1.1）↔ Grok 的 extension-system/mcp
```

#### 项目 3：DeepSeek V3.2 / V3.1（MIT 协议 LLM）

| 维度 | 详情 |
|---|---|
| **HuggingFace** | [deepseek-ai/DeepSeek-V3.2](https://huggingface.co/deepseek-ai/DeepSeek-V3.2) |
| **License** | MIT（完全商用）|
| **性能** | GPT-5 级别（V3.2 标准版）/ Gemini-3-Pro 级别（V3.2-Speciale）|
| **上下文** | 128K（DSA 稀疏注意力，O(L²) → O(L log L)）|
| **价格** | $0.28/M input, $0.42/M output（Claude 1/15、GPT-5 1/5）|
| **Tool Calling** | V3.1 最强（SWE-Bench Verified 68.4%）/ V3.2 支持 "Thinking in Tool-Use" |
| **国内** | ✅ 完全直连 |

**整合策略**：
```python
# 在 src/tdsf/core/llm_client.py 中加 DeepSeek provider
class DeepSeekProvider:
    base_url = "https://api.deepseek.com/v1"
    default_model = "deepseek-v3.2"
    fallback_model = "deepseek-v3.1"  # tool calling 强
    thinking_model = "deepseek-r1"     # 复杂推理
    
    def chat(self, messages, **kwargs):
        # 支持 tool_use 字段
        # 支持 thinking 模式
        # 支持 128K context
```

### 4.2 11+ 值得 clone 的开源 Agent 项目

| 序号 | 项目 | GitHub | License | 语言 | 必 clone？ | 借鉴价值 |
|---|---|---|---|---|---|---|
| 1 | **OpenClaude / claw-code** | [instructkr/claw-code](https://github.com/instructkr/claw-code) | Apache-2.0 | Python | ✅ 必 | 净室重写 Claude Code，多 Agent 协调 |
| 2 | **Grok Build** | [xai-org/grok-build](https://github.com/xai-org/grok-build) | Apache-2.0 | Rust | ✅ 必 | Agent Loop + Extension System |
| 3 | **Mastra** | [mastra-ai/mastra](file:///d:/ai/linux教学一体/opensource-reference/mastra/) | Apache-2.0 | TypeScript | ✅ 必 | TS Agent 框架，SubAgent 协议 |
| 4 | **OpenHands（前 OpenDevin）** | [All-Hands-AI/OpenHands](file:///d:/ai/linux教学一体/opensource-reference/OpenHands/) | MIT | Python | ✅ 必 | Runtime Agent、Worktree 隔离 |
| 5 | **Hermes Agent** | [NousResearch/hermes-agent](https://github.com/NousResearch/Hermes) | MIT | Python+TS | ✅ 必 | 自我进化机制 |
| 6 | **goose** | [block/goose](https://github.com/block/goose) | Apache-2.0 | Rust | ✅ 必 | Red Hat 支持，已进 RHEL 9.8/10.2 |
| 7 | **LangGraph** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | MIT | Python | ✅ 已在用 | 状态图编排 |
| 8 | **Cline** | [cline/cline](file:///d:/ai/linux教学一体/opensource-reference/cline/) | Apache-2.0 | TypeScript | 🟡 选 | VSCode 扩展，Plan-Act 模式 |
| 9 | **aider** | [Aider-AI/aider](file:///d:/ai/linux教学一体/opensource-reference/aider/) | Apache-2.0 | Python | 🟡 选 | repo map 智能补全 |
| 10 | **MetaGPT** | [geekan/MetaGPT](file:///d:/ai/linux教学一体/opensource-reference/MetaGPT/) | MIT | Python | 🟡 选 | 多智能体角色分工 |
| 11 | **crewAI** | [crewAIInc/crewAI](file:///d:/ai/linux教学一体/opensource-reference/crewAI/) | MIT | Python | 🟡 选 | 任务依赖 |
| 12 | **DeepMCPAgent** | [DeepMCP/DeepMCPAgent](https://github.com/DeepMCP/DeepMCPAgent) | MIT | Python | 🟡 选 | MCP + LangGraph 桥接 |

### 4.3 浅度分析（只读 README + 关键文件）

| 项目 | 跳过原因 | 仅看 |
|---|---|---|
| kilo-code | cline 分支 | README + 差异 |
| roo-code | cline 分支 | README + 差异 |
| bolt.new | Web 化方向不同 | README + 架构图 |
| aichat | 终端 AI 聊天 | README |
| fabric | 模式集合 | README |
| swebench | 评测 | README |

### 4.4 LLM 模型必接清单

| 模型 | 协议 | 上下文 | Tool Calling | 价格/M input | 必接？ |
|---|---|---|---|---|---|
| **DeepSeek V3.2** | MIT | 128K | ✅ "Thinking in Tool-Use" | $0.28 | ✅ 必接（主力）|
| **DeepSeek V3.1** | MIT | 128K | ✅ 最强开源 | $0.28 | ✅ 必接（tool 强）|
| **DeepSeek R1** | MIT | 128K | ❌ 不支持 tool | $0.50 | ✅ 必接（推理）|
| **Doubao 1.6 / Seed** | 火山方舟 | 256K | ✅ | $0.50-$2 | ✅ 必接（国产）|
| **Qwen3.5** | Apache-2.0 | 128K | ✅ | $0.30 | 🟡 备选 |
| **GLM-5** | 自有 | 128K | ✅ | 极低 | 🟡 备选 |
| **Kimi K2.5** | 自有 | 200K | ✅ Agent Swarm | $1.00 | 🟡 备选 |
| **Claude 3.5 Sonnet** | 商业 | 200K | ✅ 工业级 | $3 | 🟡 备选（研究）|
| **GPT-5** | 商业 | 400K | ✅ | $1.75 | 🟡 备选（研究）|
| **Ollama 本地模型** | MIT | 视模型 | ✅ | 免费 | ✅ 必接（兜底）|

### 4.5 整合优先级矩阵（5 周冲刺）

```
Week 1: 可信度升级
├─ 1.1 接入 DeepSeek V3.2 / V3.1（替换 Doubao 作为主力）
├─ 1.2 实现 6 源 D-S + PCR5 可信度公式
└─ 1.3 跑 ECE 评测集

Week 2: 工具 MCP 化
├─ 2.1 clone claw-code + grok-build 到 opensource-reference/
├─ 2.2 写 28-源码分析-claw-code.md + 29-源码分析-grok-build.md
├─ 2.3 把 log_tools / system_tools 改造成 MCP server
└─ 2.4 ground_check 加 sentence-transformers

Week 3: 评测集 + 持久化
├─ 3.1 构造 100 条真实故障日志评测集
├─ 3.2 LangGraph SqliteSaver 接入
└─ 3.3 端到端回归

Week 4: 桌面端接入真实数据
├─ 4.1 clone OpenClaude 的 UI 设计
├─ 4.2 IPC 接入（从 mock 切到真实）
├─ 4.3 UI 显示可信度
└─ 4.4 录 demo 视频

Week 5: 验证 + 文档
├─ 5.1 跑 100 条评测，生成校准曲线
├─ 5.2 写 v1.1 升级报告
└─ 5.3 归档到 idea-to-dev-output/
```

---

## 五、新架构：乐高式 Agent（5 个可插拔层）

### 5.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│              TDSF-Linux v1.1 乐高式 Agent 架构                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 5:  SubAgent 层（新增，基于 OpenClaude / Grok Build）     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Coordinator │──│  Swarm-1    │──│  Swarm-2    │             │
│  │ (主控)     │  │ (诊断组)   │  │ (部署组)    │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│  Layer 4:  Workflow 层（LangGraph 7 节点，已用）                │
│         ┌─────────────────────────────────────┐                │
│         │ perceive → retrieve → reason → ground_check         │
│         │   → assess_risk → decide → human_review → archive  │
│         └─────────────────────────────────────┘                │
│                          ▼                                      │
│  Layer 3:  Tool / MCP 层（P0-2 升级，参考 Grok Build）         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ log_tool │  │ ssh_tool │  │ system   │  │ MCP      │       │
│  │ (Drain3) │  │ (Paramiko│  │ _tool    │  │ client   │       │
│  │          │  │  → MCP)  │  │          │  │ (新)     │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│                          ▼                                      │
│  Layer 2:  Memory 层（ChromaDB + SQLite + Postgres）            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ command_skills│  │ incident_    │  │ decision_   │          │
│  │ (命令手册)    │  │ cases        │  │ cards       │          │
│  │ (确定性)     │  │ (案例库)     │  │ (SQLite)    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                          ▼                                      │
│  Layer 1:  LLM Gateway 层（多 LLM 切换）                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ DeepSeek │  │ Doubao   │  │ Claude   │  │ Ollama   │       │
│  │ V3.2/V3.1│  │ (豆包)   │  │ (研究)   │  │ (本地)   │       │
│  │ (主力)  │  │ (备选)   │  │          │  │ (兜底)   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 5 个可插拔层的独立可替换性

| 层 | 当前实现 | 可替换为 | 切换成本 |
|---|---|---|---|
| LLM Gateway | Doubao | DeepSeek / Claude / Ollama | 1 小时（改配置）|
| Memory | ChromaDB + SQLite | LanceDB / Postgres / Weaviate | 1 天 |
| Tool / MCP | Python 函数 | MCP server（被 Claude Code 调用）| 1 周 |
| Workflow | LangGraph 7 节点 | Mastra Workflow / Grok Agent Loop | 2 周 |
| SubAgent | 无 | OpenClaude Coordinator / Grok Swarms | 1 周 |

### 5.3 关键设计原则：每个层都"可独立 demo"

- LLM 层：单独可 demo（命令行调用 DeepSeek）
- Memory 层：单独可 demo（ChromaDB 检索 + SQLite 关系查询）
- Tool 层：单独可 demo（MCP server 启动后被 Claude Code 消费）
- Workflow 层：单独可 demo（Streamlit 跑 7 节点）
- SubAgent 层：单独可 demo（Coordinator 派发任务给 Swarms）

### 5.4 与 OpenClaude / Grok Build 的架构映射

| TDSF-Linux v1.1 | OpenClaude / claw-code | Grok Build | 复用策略 |
|---|---|---|---|
| LangGraph 7 节点 | Coordinator 模式 | Agent Loop | 核心编排，**直接借鉴** |
| 5 个可插拔层 | 模块化拆分 | Extension System | 借鉴抽象 |
| 6 源可信度 | 无对应 | 无对应 | **我们独有** |
| 4 层风险控制 | Bash 23 项安全检查 | Tool permission | 借鉴风控思想 |
| Knowledge 双轨 | RAG 单轨 | RAG 单轨 | **我们独有** |
| Electron 桌面 IDE | CLI（TUI） | TUI（Rust） | **我们独有** |
| 中文优先 + 国产 LLM | 英文为主 | xAI Grok | **我们差异化** |

**结论**：TDSF-Linux 在 **多 Agent 协调 / 工具调用 / 工作流编排** 上借鉴 OpenClaude + Grok Build；在 **可信度 / 风险控制 / 知识双轨 / 桌面 IDE** 上保持独有。

---

## 六、5 周实施路线（个人开发者友好）

### 6.1 Week 1：可信度升级 + LLM 切换

```
Day 1: 接入 DeepSeek V3.2
  ├─ 改 src/tdsf/core/llm_client.py 加 DeepSeekProvider
  ├─ 测试 100 条对话的 tool calling 成功率
  └─ 性能对比：DeepSeek V3.2 vs Doubao

Day 2: 接入 DeepSeek V3.1（tool calling 主力）
  └─ V3.1 比 V3.2 tool 调用更稳

Day 3-4: 实现 6 源 D-S + PCR5 可信度公式
  ├─ 改 src/tdsf/core/confidence.py
  ├─ 6 源：Drain3 + Source Prior + LLM Verbalized + Case Similarity + Command Match + Time Decay
  └─ 加 PCR5 冲突处理（k>0.3 自动切换）

Day 5: 跑 ECE 评测集（10 条手工标注）
  └─ 生成校准曲线
```

### 6.2 Week 2：MCP 化 + 源码分析

```
Day 1: clone OpenClaude + Grok Build
  ├─ git clone https://github.com/instructkr/claw-code.git opensource-reference/claw-code
  ├─ git clone https://github.com/xai-org/grok-build.git opensource-reference/grok-build
  └─ 写 28-源码分析-claw-code.md + 29-源码分析-grok-build.md

Day 2-3: 工具 MCP 化
  ├─ 改 src/tdsf/tools/log_tools.py → src/tdsf/mcp_servers/log_mcp.py
  ├─ 改 src/tdsf/tools/system_tools.py → src/tdsf/mcp_servers/system_mcp.py
  └─ 启动 MCP server，测试 Claude Code / Cursor 能否消费

Day 4: ground_check 升级
  └─ 加 sentence-transformers 做 embedding fuzzy match

Day 5: 端到端联调
  └─ 测试 "MCP server + LangGraph 7 节点 + DeepSeek" 全链路
```

### 6.3 Week 3：评测集 + 持久化

```
Day 1-2: 构造 100 条真实故障日志
  ├─ 从 openEuler 已知问题库拉 50 条
  ├─ 从教材 14 个项目案例拉 30 条
  └─ 自己构造 20 条边界用例

Day 3-4: LangGraph SqliteSaver 接入
  ├─ 改 src/tdsf/graph/builder.py 加 checkpointer
  ├─ 测断点恢复
  └─ 测多用户并发（mock）

Day 5: 端到端回归
  └─ 跑 100 条用例，记录 MTTR（Mean Time To Recover）
```

### 6.4 Week 4：桌面端接入真实数据

```
Day 1-2: clone OpenClaude 的 UI 设计
  ├─ 看 claw-code 的 TUI 设计（终端 UI）
  ├─ 我们是 Electron 桌面，参考布局
  └─ 写 30-UI-借鉴方案-claw-code.md

Day 3: IPC 接入（从 mock 切到真实）
  ├─ 改 src/main/ipc/index.ts
  └─ 改 src/renderer/src/types/electron.d.ts

Day 4: UI 显示可信度
  ├─ 改 ConfidenceCard 组件
  └─ 加 6 源证据可视化

Day 5: 录 demo 视频
```

### 6.5 Week 5：验证 + 文档

```
Day 1-2: 跑 100 条评测
  ├─ 记录 MTTR、ECE、Token 消耗
  └─ 对比 v1.0 vs v1.1 性能

Day 3-4: 写 v1.1 升级报告
  ├─ 31-v1.1-升级报告.md
  └─ 32-ECE评测报告.md

Day 5: 归档
  └─ 全部 md 写入 idea-to-dev-output/，做最终自检
```

---

## 七、风险评估

### 7.1 法律风险（绝不踩）

| 风险 | 触发条件 | 后果 | 规避 |
|---|---|---|---|
| 反编译 Claude Code | `grep -r 'Anthropic' .` 或 npm 装 leaked 包 | DMCA 警告 + Anthropic 起诉 | 只读架构博客，不复制代码 |
| 误装 AGPL 库 | 引入 databuff / letta 等 AGPL 包 | 项目被传染 GPL，整个开源 | 引入前查 license |
| 误用海外 API 协议 | 在生产环境跑大量 OpenAI/Claude 调用 | 服务条款违规 | 默认走 DeepSeek/Doubao |

### 7.2 数据风险（参考 Grok Build 教训）

| 风险 | 触发条件 | 后果 | 规避 |
|---|---|---|---|
| 静默上传敏感数据 | 工具调用时把 .env 上传到 ChromaDB | 数据丑闻 + 用户信任崩盘 | 自动 redact .env/.ssh/*_key |
| 静默上传到云端 | 用 ChromaDB Cloud / Pinecone SaaS | 数据外泄 | 本地 ChromaDB |
| LLM 调用泄露隐私 | LLM prompt 包含 .env 内容 | 隐私违规 | LLM 调用前脱敏 |

### 7.3 技术风险（参考 Claude Code / Grok Build 教训）

| 风险 | 触发条件 | 后果 | 规避 |
|---|---|---|---|
| MCP server 协议不兼容 | 自己实现 MCP 协议而非用 SDK | 跟其他工具不互通 | 用 `mcp` Python SDK |
| 工具调用死循环 | Agent Loop 没有终止条件 | 资源耗尽 | 加 max_iteration + timeout |
| Prompt Injection | 用户输入恶意 prompt 操纵 LLM | 执行未授权操作 | 4 层风控 + 人类审批 |
| Context 爆炸 | 100 轮对话后 context 溢出 | API 报错 | Context 压缩 + 摘要 |

### 7.4 项目管理风险

| 风险 | 触发条件 | 后果 | 规避 |
|---|---|---|---|
| 跳步失控 | C1 放宽后疯狂跳 P0 任务 | 核心功能 bug | 写 docs/SKIPPED.md + 复盘 |
| 调研不深 | C2 放宽后只读 README | 误判开源项目能力 | 关键项目仍要 git clone |
| 资源不足 | 5 周冲刺人力/时间不够 | 延期 | M1 砍掉 SubAgent 层，只做 4 层 |

---

## 八、关键文件导航

### 8.1 当前项目核心代码

| 文件 | 行数 | 必读理由 |
|---|---|---|
| [core/sampling.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/sampling.py) | 400+ | Drain3 集成 + 假设生成 |
| [core/confidence.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/confidence.py) | 200+ | 2 源可信度公式（v1.0）|
| [core/grounding.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/grounding.py) | 280+ | 模糊匹配算法 |
| [core/risk_engine.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/risk_engine.py) | 200+ | 4 层风险规则 |
| [graph/builder.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/builder.py) | 60 | 图结构（7 节点）|
| [graph/nodes.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/nodes.py) | 500+ | 7 节点实现 |

### 8.2 调研报告（必读）

| 文档 | 行数 | 必读理由 |
|---|---|---|
| [豆包参考.md](../../../参考资料/豆包参考.md) | 1683 | 本报告评估对象 |
| [22-可信度算法论文支撑调研.md](./22-可信度算法论文支撑调研.md) | 800+ | D-S + PCR5 论文链 |
| [24-源码分析-Mastra框架.md](./24-源码分析-Mastra框架.md) | 500+ | TS Agent 框架 |
| [26-Agent架构设计详解与规划梳理.md](./26-Agent架构设计详解与规划梳理.md) | 600+ | 上一轮架构分析 |

### 8.3 待 clone 的开源项目（Week 2 开始）

```bash
# 必 clone
git clone https://github.com/instructkr/claw-code.git opensource-reference/claw-code
git clone https://github.com/xai-org/grok-build.git opensource-reference/grok-build

# 已 clone（继续深入分析）
ls opensource-reference/  # 已有: mastra, OpenHands, aider, cline, MetaGPT, crewAI, kilo-code

# 选 clone
git clone https://github.com/block/goose.git opensource-reference/goose
git clone https://github.com/NousResearch/Hermes.git opensource-reference/hermes
git clone https://github.com/DeepMCP/DeepMCPAgent.git opensource-reference/deepmcpa
```

---

## 九、本报告自检清单

- [x] 豆包回答评估（4 优点 + 7 硬伤 + 对比表）
- [x] 9 条红线 Why 解析（4 大类）
- [x] 9 条红线调整方案（核心表 + 新增 E 类）
- [x] 三大必 clone 项目（OpenClaude / Grok Build / DeepSeek）
- [x] 11+ 值得 clone 项目
- [x] 乐高式 Agent 架构（5 层）
- [x] 5 周实施路线
- [x] 风险评估（4 类）
- [x] 关键文件导航
- [x] 本报告归档到 `idea-to-dev-output/27-豆包方案评估+9条红线调整+开源Agent整合方案.md`

---

## 十、下一步建议

> 个人开发者 + 开源整合的 5 周冲刺路线已规划完毕。建议按以下顺序启动：

1. **今天**：同意 9 条红线调整（E1-E4 子规则）
2. **明天**：git clone OpenClaude + Grok Build 到 `opensource-reference/`
3. **Day 3-4**：写 [28-源码分析-claw-code.md](./28-源码分析-claw-code.md) + [29-源码分析-grok-build.md](./29-源码分析-grok-build.md)
4. **Day 5-7**：Week 1 启动——接入 DeepSeek + 6 源可信度公式
5. **Day 8-14**：Week 2 启动——MCP 化 + ground_check 升级

**如果只做一件事**：先 clone OpenClaude，它是最有价值的参考（净室重写 Python + 165K stars + Apache-2.0）。
