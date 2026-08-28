# TDSF-Linux Agent 架构设计详解与规划梳理

> **版本**：v1.0
> **更新日期**：2026-07-20
> **作者**：TDSF 开发组
> **承接文档**：[08-最终方案书-v4.0.md](./08-最终方案书-v4.0.md) / [14-方案书-v8.0-课程一体化.md](./14-方案书-v8.0-课程一体化.md) / [22-可信度算法论文支撑调研.md](./22-可信度算法论文支撑调研.md) / [24-源码分析-Mastra框架.md](./24-源码分析-Mastra框架.md)
> **核心问题**：本项目中的 **Agent 是怎么设计的？当前的 Agent 架构是什么？下一步如何规划？**

---

## 〇、本报告导览

| 章节 | 关键问题 | 读者 |
|---|---|---|
| **一、设计哲学** | 为什么要这样设计？设计原则是什么？ | 架构师 |
| **二、当前架构详解** | 7 节点分别做什么？数据如何流动？ | 开发者 |
| **三、关键设计决策** | 为什么用 LangGraph 而不 Mastra？为什么 v1.0 还在用 2 源？ | 评审者 |
| **四、与开源主流的对比** | 与 goose / Hermes / OpenHands / Mastra 差在哪？ | 决策者 |
| **五、规划梳理 v1.0→v2.0** | 下一步该做什么？优先级如何？ | 项目经理 |
| **六、风险与红线** | 哪些绝对不能做？ | 全员 |

---

## 一、Agent 设计哲学

### 1.1 一句话定位

> **TDSF-Linux Agent = 面向 Linux 运维场景的「可信度优先 + 风险可控」诊断智能体**

它不追求"最强 LLM"，也不追求"完全自治"，而是追求**「在生产服务器上敢不敢用」**——这是和 goose/OpenHands 最大的设计分歧。

### 1.2 五条核心设计原则

| 编号 | 原则 | 含义 | 反例（不该怎么做） |
|---|---|---|---|
| **P1** | **可信度优先**（Confidence First） | 每个决策必须给出量化可信度（0-1），UI 透明展示 | 盲信 LLM 输出，不告诉用户"我有多确定" |
| **P2** | **风险分级 + 人工闸门**（Human-in-the-Loop on Risk） | 高风险操作必须人工确认，绝不自动执行 | 自主跑 `rm -rf /` 或 `iptables -F` |
| **P3** | **可审计 + 可回放**（Audit & Replay） | 每个决策都落 SQLite，可重新加载状态 | 用 in-memory dict 存决策历史 |
| **P4** | **知识双轨**（Dual-Track Knowledge） | 一轨命令手册（确定性），一轨案例库（经验性） | 全部塞进一个向量库 |
| **P5** | **拒绝反编译 + License 红线** | 只用合法 SDK，不用逆向方案 | 抄 Claude Code 内部协议 |

### 1.3 设计哲学与开源主流的差异

| 项目 | 核心哲学 | 风险偏好 | 可信度算法 | License |
|---|---|---|---|---|
| **TDSF-Linux（本项目）** | 可信度优先 + 风险分级 | 保守（强制人工） | α×Drain3 + (1-α)×Source Prior（v1.0）→ D-S+PCR5（v1.1） | 学生自有 |
| **goose（Red Hat）** | 通用本地 Agent | 较激进（可自动执行） | 简单 LLM 直出 | Apache-2.0 |
| **OpenHands** | 软件工程 Agent | 激进（自动 PR） | 几乎不用量化置信度 | MIT |
| **Hermes Agent** | 自我进化 | 激进（自动调优） | 无 | MIT |
| **Mastra** | 多 Agent 编排框架 | 由应用决定 | 由应用决定 | Apache-2.0 |
| **Cline** | IDE 辅助编程 | 激进（自动 diff） | 几乎不用 | Apache-2.0 |

**结论**：TDSF-Linux 与通用 Agent（goose/OpenHands/Hermes）的根本差异在于**「在生产服务器上敢用」**。这迫使我们必须做量化可信度、强制风险分级、人工闸门——这是差异化竞争力。

---

## 二、当前 Agent 架构详解

### 2.1 架构全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                    TDSF-Linux Agent 整体架构                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│   │  TIER 1      │    │  TIER 2      │    │  TIER 3      │    │
│   │  证据层      │    │  决策层      │    │  记忆层      │    │
│   │  (Evidence)  │    │  (Decision)  │    │  (Memory)    │    │
│   └──────────────┘    └──────────────┘    └──────────────┘    │
│         │                    │                    │             │
│   ┌─────▼─────┐       ┌─────▼─────┐       ┌─────▼─────┐      │
│   │ Drain3    │       │ LangGraph │       │ ChromaDB  │      │
│   │ 日志聚类  │       │ 7 节点图  │       │ 向量库    │      │
│   │ sampling  │       │ nodes.py  │       │ 案例+命令 │      │
│   │ confidence│       │           │       │           │      │
│   └─────┬─────┘       └─────┬─────┘       └─────┬─────┘      │
│         │                    │                    │             │
│   ┌─────▼──────────────────▼──────────────────▼─────┐        │
│   │  状态总线：LangGraph State (TypedDict)          │        │
│   │  confidence, risk_level, evidence, decision     │        │
│   └─────────────────────┬────────────────────────────┘        │
│                         │                                     │
│   ┌─────────────────────▼────────────────────────────┐        │
│   │  4 层风险控制 + 人工审批闸门                      │        │
│   │  risk_engine.py → human_review_node              │        │
│   └─────────────────────┬────────────────────────────┘        │
│                         │                                     │
│   ┌─────────────────────▼────────────────────────────┐        │
│   │  持久化：SQLite (Decision Card + 审计)            │        │
│   │  ChromaDB (知识双轨)                              │        │
│   └──────────────────────────────────────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 三层 Tier 模型（[tdsf-linux/AGENTS.md](file:///d:/ai/linux教学一体/tdsf-linux/AGENTS.md) 已规定）

| Tier | 职责 | 关键模块 | 文件 |
|---|---|---|---|
| **TIER 1：证据层** | 把非结构化日志/命令输出转成结构化证据 | Drain3 聚类 + 可信度计算 | [core/sampling.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/sampling.py) / [core/confidence.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/confidence.py) |
| **TIER 2：决策层** | 用 LangGraph 编排 7 节点推理流程 | 状态机 + 条件边 | [graph/builder.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/builder.py) / [graph/nodes.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/nodes.py) |
| **TIER 3：记忆层** | 持久化知识（双轨）+ 决策历史 | ChromaDB + SQLite | [core/storage/chroma_db.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/storage/chroma_db.py) / [core/storage/sqlite.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/storage/sqlite.py) |

### 2.3 LangGraph 7 节点详解（核心架构）

```
START
  │
  ▼
[1] perceive（感知）────────── 收集环境信息：主机状态、日志、命令历史
  │
  ▼
[2] retrieve（检索）────────── ChromaDB 双轨检索：命令手册 + 案例库
  │
  ▼
[3] reason（推理）──────────── LLM 生成假设（hypotheses + confidence）
  │
  ▼
[4] ground_check（溯源校验）── 验证 LLM 输出是否"接地"于证据
  │  ├─ 通过 → 继续
  │  └─ 不通过 → 回到 reason（最多 3 次）后放弃
  ▼
[5] assess_risk（风险评估）─── 4 层规则匹配（READ/WRITE/DANGER/CRITICAL）
  │
  ▼
[6] decide（决策）───────────── 输出最终 decision card
  │  ├─ risk=CRITICAL 或 need_approval=true → 走 [7]
  │  └─ 其他 → 直接 archive
  ▼
[7] human_review（人工审批）─  暂停图，UI 弹出审批界面
  │  ├─ 批准 → archive
  │  └─ 拒绝 → archive(rejected)
  ▼
[8] archive（归档）─────────── 写入 SQLite（Decision Card + 审计日志）
  │
  ▼
END
```

### 2.4 关键状态字段（State Schema）

```python
# graph/state.py 概念定义（v1.0 阶段）
class AgentState(TypedDict):
    # 输入
    user_query: str
    host_info: dict
    log_sample: str

    # 证据
    drained_templates: list[dict]   # Drain3 聚类结果
    retrieved_commands: list[dict]   # ChromaDB 命令手册
    retrieved_cases: list[dict]      # ChromaDB 案例库

    # 推理
    hypotheses: list[dict]           # LLM 假设（含 verbalized confidence）
    confidence: float                # 最终可信度（0-1）

    # 校验
    grounding_result: dict           # ground_check 输出
    grounded: bool                   # 是否接地

    # 风险
    risk_level: str                  # READ/WRITE/DANGER/CRITICAL
    needs_approval: bool             # 是否需要人工审批

    # 决策
    final_decision: dict             # 最终 decision card
    human_approved: bool             # 人工是否批准

    # 审计
    audit_log: list[dict]            # 全流程审计
```

### 2.5 4 层风险控制规则（[core/risk_engine.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/risk_engine.py)）

| Level | 含义 | 触发条件示例 | Agent 行为 |
|---|---|---|---|
| **READ** | 只读操作 | `cat /var/log/messages` | 自动执行 |
| **WRITE** | 写配置 | `vim /etc/nginx.conf` | 自动执行 + 备份原文件 |
| **DANGER** | 危险操作 | `systemctl restart nginx` | 自动执行 + 强制审计 |
| **CRITICAL** | 不可逆操作 | `rm -rf /`、`iptables -F`、`mkfs` | **强制人工审批** |

---

## 三、关键设计决策（Why 决定 What）

### 3.1 决策树：为什么用 LangGraph 而不是 Mastra？

| 维度 | LangGraph（✅ 选） | Mastra（❌ 暂不选） |
|---|---|---|
| **语言** | Python（后端主流） | TypeScript（前端为主） |
| **状态机** | 原生 TypedDict State | 需要 Zod schema |
| **条件边** | `add_conditional_edges` 原生 | 需在 workflow 中间件实现 |
| **Checkpointer** | SqliteSaver/PostgresSaver 原生 | 需自己接 Postgres |
| **Human-in-the-Loop** | `interrupt()` 原生支持 | 需 SubAgent 协议 |
| **与 Python 生态集成** | 完美（Drain3/ChromaDB/SQLite） | 需走 IPC/TypeScript-Python 桥接 |
| **项目记忆硬约束** | - | "**Agent 架构必须用 TS 原生框架（Mastra），不引入 Python 进程通信**"——指的是 desktop 端，**但后端可自由用 Python** |

**结论**：后端用 **Python + LangGraph**，桌面端用 **TypeScript + React Flow 可视化 + Electron**。两边不互通进程，靠 HTTP/JSON 通信（**不是 Python-IPC 桥接，符合硬约束**）。

### 3.2 决策树：为什么 v1.0 还在用 2 源可信度公式？

```
confidence = α × drain3_match_score + (1-α) × source_prior
            α = 0.7
```

| 方案 | 优点 | 缺点 | 是否采用 |
|---|---|---|---|
| **v1.0 简化公式** | 上手快、解释简单、可解释性强 | 只用 2 个证据源，ECE 高 | ✅ v1.0 采用 |
| **v1.1 D-S + PCR5 6 源** | 顶会前沿、ECE 低、论文支撑完整 | 调参复杂、需要训练数据 | 🔜 v1.1 升级（已规划） |
| **v2.0 Verbalized + Self-Consistency** | 适合闭源 LLM（无 logprobs） | 成本高 3-5 倍 | 🟡 v2.0 兜底 |
| **v2.0 Temperature Scaling** | ECE 最低 | 需要 logprobs（Anthropic API 不暴露） | ❌ 弃用（兜底到 Verbalized） |

**论文支撑**（[22-可信度算法论文支撑调研.md](file:///d:/ai/linux教学一体/idea-to-dev-output/22-可信度算法论文支撑调研.md)）：
- **Dempster 1967 + Shafer 1976**：D-S 理论基石
- **Smarandache & Dezert 2004**：PCR5 冲突处理
- **Guo 2017 ICML**：闭源 LLM 过度自信问题
- **SaySelf EMNLP 2024** + **ConfTuner 2025**：LLM 校准前沿

### 3.3 决策树：为什么用 ChromaDB 而不是 Pinecone/Weaviate？

| 维度 | ChromaDB（✅ 选） | Pinecone（❌ 弃） | Weaviate（🟡 备选） |
|---|---|---|---|
| **部署** | 嵌入式，零运维 | 需 SaaS 账号 | 需 Docker 部署 |
| **License** | Apache-2.0 | 商业 | BSD-3 |
| **本地化** | 完全本地（符合"本地优先"硬约束） | 需海外 API | 可本地 |
| **Metadata 过滤** | 支持 | 支持 | 支持 |
| **混合检索** | 不支持原生 | 不支持 | 支持 |
| **性能** | 中（小数据集足够） | 高 | 高 |
| **项目规模** | < 10 万条命令/案例 | - | - |

**结论**：ChromaDB 满足「本地优先 + Apache-2.0 + 零运维」三重硬约束，**当前够用**。等到 v2.0 知识库突破 10 万条时，**再考虑迁移到 Weaviate**（混合检索更强）。

### 3.4 决策树：为什么"知识双轨"而不是单一向量库？

```
知识双轨
├─ 轨 1：命令手册（确定性知识）
│   来源：教材（14 个项目）、官方 man page
│   特征：可执行、有明确语法
│   检索：精确匹配 + 模糊匹配
│
└─ 轨 2：案例库（经验性知识）
    来源：历史 Decision Card、人工标记的真实故障
    特征：场景化、有上下文
    检索：向量相似度 + 时间衰减
```

**为什么必须分开**：
- 单一向量库会把 `systemctl restart nginx`（命令手册）和"上次 nginx 502 是因为 ulimit"（案例）混淆
- 命令手册需要**精确度优先**（错了就执行失败），案例库需要**召回率优先**（相似即可）
- 两者的 metadata schema 完全不同，分开建表更清晰

---

## 四、与开源主流的对比（验证我们是否走对路）

### 4.1 横向能力对比（2026-07 最新数据）

| 能力 | TDSF-Linux | goose（Red Hat） | OpenHands | Hermes | Mastra |
|---|---|---|---|---|---|
| **状态机编排** | ✅ LangGraph 7 节点 | ❌ 单循环 | ⚠️ Runtime Agent | ⚠️ 单循环 | ✅ Workflow |
| **量化可信度** | ✅ α×Drain3 | ❌ | ❌ | ❌ | 由应用决定 |
| **D-S 证据理论** | 🔜 v1.1 | ❌ | ❌ | ❌ | ❌ |
| **人工审批闸门** | ✅ Human-in-the-Loop | ⚠️ 提示确认 | ⚠️ PR Review | ❌ | ✅ Suspend/Resume |
| **持久化** | ✅ SQLite | ⚠️ 文件 | ⚠️ 文件 | ⚠️ 文件 | ✅ Postgres 可选 |
| **知识双轨** | ✅ ChromaDB 双 collection | ❌ | ❌ | ⚠️ 单轨 | ❌ |
| **MCP 协议** | ❌ v1.0 / 🔜 v1.1 | ✅ 原生 | ⚠️ 部分 | ✅ 原生 | ✅ 原生 |
| **开源 License** | 学生自有 | Apache-2.0 | MIT | MIT | Apache-2.0 |
| **生产可用性** | 🟡 MVP | 🟢 RHEL 9.8/10.2 内置 | 🟡 早期 | 🟡 早期 | 🟡 早期 |

### 4.2 我们的护城河

1. **可信度量化**——goose/OpenHands/Hermes 都没做，这是 **Linux 运维场景刚需**
2. **风险分级 + 人工闸门**——goose 只能提示确认，**TDSF-Linux 强制拦截 CRITICAL**
3. **知识双轨**——通用 Agent 都塞一个向量库，**TDSF-Linux 拆命令手册/案例库**
4. **可解释性**——Drain3 模板 + 6 源证据可视化，**用户能看到"我为什么这么判断"**
5. **国产化 + 本地优先**——Ollama/DeepSeek/Doubao，**不依赖海外 API**

### 4.3 我们的短板（必须补）

1. **MCP 化未完成**——goose/Mastra/Hermes 都支持 MCP，TDSF-Linux 工具还是裸 Python 函数
2. **MTTR 基准**——没有与 baseline（如纯 LLM、纯规则引擎）对比的客观数据
3. **多用户协作**——SQLite 单文件，并发差
4. **回放工具**——决策有归档但缺 replay CLI

---

## 五、规划梳理 v1.0 → v2.0

### 5.1 路线图（Roadmap）

```
v1.0（当前）          v1.1              v1.5                v2.0
─────────────────────────────────────────────────────────────────────
✅ 7 节点图        🔜 工具 MCP 化    🔜 多用户协作        🔜 Postgres
✅ 2 源可信度       🔜 6 源 D-S+PCR5  🔜 回放 CLI          🔜 真实 MTTR
✅ 4 层风险         🔜 遥测/指标      🔜 麒麟 OS 适配      🔜 教学证据链
✅ ChromaDB 双轨    🔜 ConfTuner      🔜 案例库 10 万条    🔜 完整 Verbalized
✅ SQLite 持久化    🔜 ECE 评测集
✅ Streamlit UI     🔜 README+Demo
✅ Electron 桌面端
   ✅ 20 页面 1:1
   ✅ IPC 主进程就绪
   🔜 接入真实数据
```

### 5.2 优先级矩阵（ROI 排序）

| 优先级 | 任务 | 工作量 | 影响 | 备注 |
|---|---|---|---|---|
| **P0-1** | 可信度公式升级 v1.0→v1.1（D-S+PCR5 6 源） | 2 周 | 🔴 高 | [22-调研报告](file:///d:/ai/linux教学一体/idea-to-dev-output/22-可信度算法论文支撑调研.md) 已规划 |
| **P0-2** | 工具全量 MCP 化 | 1 周 | 🔴 高 | goose/Mastra 都做了，不做会掉队 |
| **P0-3** | ground_check 模糊匹配升级（加 sentence-transformers） | 3 天 | 🔴 高 | 解决长 output 稀释问题 |
| **P1-1** | LangGraph SqliteSaver 持久化 | 3 天 | 🟡 中 | 断点恢复必备 |
| **P1-2** | ECE 评测集 + 校准曲线 | 1 周 | 🟡 中 | 可信度升级的客观验证 |
| **P1-3** | 接入 14 个 Linux 项目（项目 1-14）的真实故障日志 | 1 周 | 🟡 中 | 把"课程一体化"真正落地 |
| **P2-1** | 教学证据链可视化（React Flow） | 1 周 | 🟢 低 | 差异化亮点 |
| **P2-2** | LAMP 一键部署（v8.0 已有规划） | 1 周 | 🟢 低 | 商业化路径 |
| **P2-3** | 多用户协作（Postgres + WebSocket） | 2 周 | 🟢 低 | 团队版基础 |
| **P2-4** | 麒麟 OS 适配 | 1 周 | 🟢 低 | 国产化加分 |

### 5.3 5 周冲刺计划（v1.0 → v1.1）

```
第 1 周：可信度公式升级
  ├─ Day 1-2: 把 6 源证据（Drain3、Source Prior、LLM Verbalized、
  │          Case Similarity、Command Match、Time Decay）
  │          全部接入 state
  ├─ Day 3-4: 实现 D-S 组合公式 + PCR5 冲突处理
  └─ Day 5: 跑 ECE 评测集

第 2 周：MCP 化 + ground_check 升级
  ├─ Day 1-3: 把 log_tools / system_tools 改造成 MCP server
  ├─ Day 4: ground_check 加 sentence-transformers
  └─ Day 5: 端到端联调

第 3 周：评测集 + 持久化
  ├─ Day 1-3: 构造 100 条真实故障日志评测集
  ├─ Day 4: SqliteSaver 接入 LangGraph
  └─ Day 5: 端到端回归

第 4 周：桌面端接入真实数据
  ├─ Day 1-3: IPC 接入（从 mock 切到真实）
  ├─ Day 4: UI 显示可信度
  └─ Day 5: 录 demo 视频

第 5 周：ECE 验证 + 文档归档
  ├─ Day 1-3: 跑 100 条评测，生成校准曲线
  ├─ Day 4: 写 v1.1 升级报告
  └─ Day 5: 归档到 idea-to-dev-output/
```

---

## 六、风险与红线（绝对不能碰）

### 6.1 技术红线

| 红线 | 原因 | 违反后果 |
|---|---|---|
| **不反编译 Claude Code** | 法律风险高 | 整个项目被 DMCA |
| **不用 code-server / Theia** | 项目记忆硬约束 | 偏离差异化定位 |
| **不用 Python-IPC 桥接（Mastra）** | 项目记忆硬约束 | 架构混乱 |
| **不用 AGPL/GPL 库** | 传染性协议 | 整个项目必须开源 |
| **不用海外 API 作默认** | 国内网络 + 硬约束 | 用户用不了 |
| **不存 token/敏感数据到向量库** | 数据丑闻 | 用户信任崩盘 |
| **不自动执行 CRITICAL 操作** | 数据安全 | 删库跑路 |
| **不绕过人工审批** | 4 层风控失效 | Agent 不再可信 |

### 6.2 工程红线

| 红线 | 原因 | 违反后果 |
|---|---|---|
| **不跳步** | 项目记忆硬约束 | 质量失控 |
| **不只凭 README 调研开源项目** | 项目记忆硬约束 | 误判 |
| **不用 `#ffffff` / `#fafafa` 等硬编码颜色** | 项目记忆硬约束 | 设计语言混乱 |
| **不删除现有测试** | 回归保障 | 隐藏 bug |
| **不引入未经 Code Review 的大依赖** | 依赖治理 | 供应链风险 |

### 6.3 学术红线

| 红线 | 原因 |
|---|---|
| **不抄袭他人论文/代码** | 学术诚信 |
| **不伪造 ECE 评测数据** | 学术诚信 |
| **不夸大可信度算法效果** | 评审被发现会撤稿 |

---

## 七、关键文件导航

### 7.1 核心代码（必须读）

| 文件 | 行数 | 必读理由 |
|---|---|---|
| [core/sampling.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/sampling.py) | 400+ | Drain3 集成 + 假设生成 |
| [core/confidence.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/confidence.py) | 200+ | 2 源可信度公式 |
| [core/grounding.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/grounding.py) | 280+ | 模糊匹配算法 |
| [core/risk_engine.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/core/risk_engine.py) | 200+ | 4 层风险规则 |
| [graph/builder.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/builder.py) | 60 | 图结构（7 节点） |
| [graph/nodes.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/nodes.py) | 500+ | 7 节点实现 |
| [graph/state.py](file:///d:/ai/linux教学一体/tdsf-linux/src/tdsf/graph/state.py) | 50+ | State schema |

### 7.2 调研报告（必读）

| 文档 | 行数 | 必读理由 |
|---|---|---|
| [22-可信度算法论文支撑调研.md](file:///d:/ai/linux教学一体/idea-to-dev-output/22-可信度算法论文支撑调研.md) | 800+ | D-S + PCR5 完整论文链 |
| [24-源码分析-Mastra框架.md](file:///d:/ai/linux教学一体/idea-to-dev-output/24-源码分析-Mastra框架.md) | 500+ | 对比框架 |
| [14-方案书-v8.0-课程一体化.md](file:///d:/ai/linux教学一体/idea-to-dev-output/14-方案书-v8.0-课程一体化.md) | 600+ | 4 大扩展模块 |
| [08-最终方案书-v4.0.md](file:///d:/ai/linux教学一体/idea-to-dev-output/08-最终方案书-v4.0.md) | 500+ | 核心定位 |

### 7.3 项目硬约束（必背）

| 文档 | 行数 | 必背理由 |
|---|---|---|
| [tdsf-linux/AGENTS.md](file:///d:/ai/linux教学一体/tdsf-linux/AGENTS.md) | - | 后端架构硬约束 |
| [tdsf-linux/CLAUDE.md](file:///d:/ai/linux教学一体/tdsf-linux/CLAUDE.md) | - | 后端开发规范 |
| [tdsf-linux-desktop/CLAUDE.md](file:///d:/ai/linux教学一体/tdsf-linux-desktop/CLAUDE.md) | - | 前端开发规范 |
| [memory/projects/.../project_memory.md](file:///c:/Users/Lenovo/.trae-cn/memory/projects/-d-ai-linux----/project_memory.md) | 100+ | 跨会话硬约束 |

---

## 八、本报告自检清单

- [x] Agent 设计哲学清晰（P1-P5 五原则）
- [x] 当前架构 7 节点详解完整
- [x] 关键设计决策有 Why
- [x] 与开源主流横向对比
- [x] 规划梳理 v1.0→v2.0 路线图
- [x] 风险与红线明确
- [x] 关键文件导航
- [x] 本报告归档到 `idea-to-dev-output/26-Agent架构设计详解与规划梳理.md`

---

## 九、下一步建议

> 如果你看完本报告，建议下一步：

1. **精读 [22-可信度算法论文支撑调研.md](file:///d:/ai/linux教学一体/idea-to-dev-output/22-可信度算法论文支撑调研.md)**（800+ 行，1-2 小时）
2. **跑通 `pytest -v` + `streamlit run src/tdsf/app.py`**，亲自体验 7 节点流程
3. **git clone `aaif-goose/goose` 到 `opensource-reference/goose`**，按 [24-源码分析-Mastra框架.md](file:///d:/ai/linux教学一体/idea-to-dev-output/24-源码分析-Mastra框架.md) 模板写一份 `25-源码分析-goose.md`
4. **5 周冲刺 v1.1**：从 P0-1「可信度公式升级」开始

需要我直接开始哪个？推荐 **P0-2 工具 MCP 化**（最容易出成果、风险最小），或是 **P0-1 可信度升级**（最能体现差异化）？
