# TDSF 终端 Agent IDE 技术方案书 — v3.0（量化终稿）

> **版本**：v3.0（实测量化 + 4 个新项目补充 + 完整设计稿规格）  
> **日期**：2026-07-26  
> **目标读者**：Trae Design（设计稿交付）+ 工程师（实施）+ 产品经理（验收）  
> **数据基线**：基于对 `d:\ai\linux教学一体` 全目录 11,226,832 行代码 / 27 个开源项目 / 4 份核心调研报告 / 75 份文档的**实测量化盘点**（`scripts/count_v3.py` 2026-07-26 执行）

---

## 目录

- [一、项目定位与一句话定义](#一项目定位与一句话定义)
- [二、实测量化资产盘点（v3.0 关键修正）](#二实测量化资产盘点v30-关键修正)
- [三、调研发现 → 技术决策映射](#三调研发现--技术决策映射)
- [四、总体架构设计](#四总体架构设计)
- [五、技术栈选型详解（每层含版本+备选+否决理由）](#五技术栈选型详解每层含版本备选否决理由)
- [六、界面设计规格（面向 Trae Design 完整交付）](#六界面设计规格面向-trae-design-完整交付)
- [七、接口定义（Rust ↔ Python ↔ React 完整契约）](#七接口定义rust--python--react-完整契约)
- [八、项目结构与目录规划（monorepo 完整）](#八项目结构与目录规划monorepo-完整)
- [九、实施路线图（AI 单人 1–2 周）](#九实施路线图ai-单人-12-周)
- [十、风险矩阵与决策拍板](#十风险矩阵与决策拍板)
- [十一、量化收益与硬约束](#十一量化收益与硬约束)
- [附录 A：可复用源码索引](#附录-a可复用源码索引)
- [附录 B：Trae Design 交付清单](#附录-btrae-design-交付清单)
- [附录 C：可借鉴设计资产（tdsf-design-app + tdsf-linux-redesign + terax-ai）](#附录-c可借鉴设计资产)
- [附录 D：记忆交叉引用](#附录-d记忆交叉引用)

---

## 一、项目定位与一句话定义

### 1.1 一句话定义

> **TDSF Terminal Agent IDE** 是一个面向 Linux 运维教学的**终端优先 AI 工作台**：把 AI Agent 放在真实 SSH 终端旁边，让 SSH、诊断、教学、AI 辅助在同一窗口里原生共存，并通过 PAOR 循环 + 证据溯源 + 4 层风控 + Markdown 知识库，让 Agent **越用越聪明**。

### 1.2 关键差异化（vs 14 个调研项目）

| 维度 | 现有 14 个终端 Agent | TDSF Terminal Agent |
|------|----------------------|---------------------|
| **场景** | 100% 编码辅助 | **运维诊断 + 教学**（空白市场） |
| **后端** | 单一栈 | **Tauri 2 (Rust) + Python 双栈** |
| **UI 范本** | Ratatui / Ink | **terax-ai 完整 fork**（xterm.js + 15 主题） |
| **基座** | Hermes / OpenCode | **fork terax-ai + 自研 PAOR** |
| **教学** | 无 | **Markdown 知识库 + 教程推荐 + Skill 沉淀** |
| **风控** | 部分有 approval | **4 层风控管道**（规则→Bash分类→上下文→LLM） |
| **演示** | 终端录屏 | **asciinema + 实时 SSH 演示** |

### 1.3 三个不可妥协的设计原则

1. **终端原生** — 主区是真实 PTY（Rust portable-pty），AI 永远在侧栏，**不能反过来**
2. **Markdown 优先** — 知识库 / 教程 / 技能 / 决策记录 / 配置全部 `.md`（Git 增量、AI 原生可读）
3. **分屏可调** — SSH / AI / 知识库 / 编辑器四栏可拖拽（terax-ai 范本）

---

## 二、实测量化资产盘点（v3.0 关键修正）

> **数据来源**：`scripts/count_v3.py` 实测扫描（2026-07-26），排除 `node_modules / target / .git / __pycache__ / dist / build / release` 等构建产物。

### 2.1 全局总览（实测数据，**v2.0 偏差 30×**）

| 资产 | 文件数 | 代码行 | 评级 | 用途 |
|------|--------|--------|------|------|
| **`opensource-reference/` 27 个开源项目** | 51,031 | **6,946,226** 源码 + 3,415,276 文档 | ⭐⭐⭐⭐⭐ | **核心范本来源** |
| `tdsf-linux-desktop/` Electron 桌面端 | 888 | 296,379 | ⭐⭐ | 90% 弃用，仅复用算法 ~8K 行 |
| `tdsf-translate-v140/` Electron 翻译版 | 836 | 279,842 | ⭐ | **独立可裁剪**（教学翻译） |
| `tdsf-linux-redesign/` HTML 静态设计稿 | 30 | 54,348 | ⭐⭐⭐⭐ | **Trae Design 关键输入** |
| `docs/` 项目文档 | 79 | 50,871 | ⭐⭐⭐ | 含 idea-to-dev 全套方案 |
| `knowledge/` 教学资料 | 41 | 42,126 | ⭐⭐⭐⭐ | **直接当知识库** |
| `projects/` Python Agent + 测试 | 92 | 25,356 | ⭐⭐⭐⭐⭐ | **核心算法直接复用** |
| `tdsf-design-app/` React + Electron 设计稿实现 | 74 | 22,875 | ⭐⭐⭐⭐ | **已实现的可视化组件** |
| `config/` Python 配置脚本 | 40 | 7,911 | ⭐⭐ | Coze 配置 |
| `harryopo.github.io/` 个人主页 | 22 | 7,766 | ⭐ | 不相关 |
| `references/` 论文/参考 | 9 | 6,826 | ⭐ | 比赛论文参考 |
| `scripts/` 辅助脚本 | 11 | 5,598 | ⭐⭐ | 可复用 |
| `tdsf-terminal-agent/` 终端 Agent（待实施） | 5 | 4,028 | ⭐⭐⭐⭐⭐ | **本次交付目标** |
| `reports/` 调研报告 | 3 | 2,787 | ⭐⭐⭐⭐⭐ | **决策依据** |
| `skills/` Skill 工作台 | 1 | 247 | ⭐⭐ | Skill 库 |
| **合计** | **52,774** | **11,226,832** | — | — |

> **关键修正**：v2.0 估算 1,307 文件 / 375,269 行（**偏差 30×**）。v3.0 用 Python 脚本实测，排除了构建产物，得到真实数据。**实际可复用代码**集中在 opensource-reference（6.9M 源码）和 5 个自研项目（约 56K 行），**真正需要新写的**约 10-15K 行。

### 2.2 关键 Python Agent 复用矩阵（projects/src/tdsf）

> **实测**：6,789 行 Python，**复用率 91%**（6,200 行直接复用，700 行 UI 弃用）

| 模块 | 路径 | 实测行数 | 评级 | 复用方式 |
|------|------|---------|------|----------|
| **core/risk_engine.py** | `projects/src/tdsf/core/` | ~750 | ⭐⭐⭐⭐⭐ | 整体导入为 `risk_evaluate` MCP tool |
| **core/confidence.py** | `projects/src/tdsf/core/` | ~520 | ⭐⭐⭐⭐⭐ | 整体导入为 `confidence_assess` MCP tool |
| **core/grounding.py** | `projects/src/tdsf/core/` | ~280 | ⭐⭐⭐⭐⭐ | 整体复用为 `ground_check` tool |
| **core/sampling.py** | `projects/src/tdsf/core/` | ~190 | ⭐⭐⭐⭐⭐ | Self-Consistency 多采样 |
| **core/llm_client.py** | `projects/src/tdsf/core/` | ~600 | ⭐⭐⭐⭐⭐ | 统一 LLM 调用入口 |
| **graph/nodes.py + builder.py + edges.py + state.py** | `projects/src/tdsf/graph/` | 1,166 | ⭐⭐⭐⭐⭐ | 整体复用为 PAOR 7 节点状态机 |
| **storage/sqlite_db.py + chroma_db.py + schemas.py** | `projects/src/tdsf/storage/` | 1,293 | ⭐⭐⭐⭐⭐ | 决策库 + 向量检索 |
| **tools/log_tools.py + system_tools.py** | `projects/src/tdsf/tools/` | 775 | ⭐⭐⭐⭐ | 整体复用 |
| **app.py + config.py + ui/** | `projects/src/tdsf/` | 1,664 | ⭐⭐ | UI 弃用，仅保留业务入口 |

### 2.3 terax-ai 资产复用矩阵（v3.0 新增实测数据）

> **实测**：terax-ai 共 81,666 源码行 + 13,941 文档行 = 95,607 行（v2.0 估算 79,165 行偏小）

| 模块 | 实测行数 | 评级 | TDSF 用法 |
|------|----------|------|-----------|
| **`terax-ai/src` React 19** | **67,509** | ⭐⭐⭐⭐⭐ | fork 后改造（约 35K 行直接复用） |
| `src/modules/terminal/` | ~8,000 | ⭐⭐⭐⭐⭐ | 复制 TerminalStack / TerminalPane / Tabs |
| `src/modules/tabs/` | ~3,500 | ⭐⭐⭐⭐⭐ | 复制 TabBar / TabSwitcherHud |
| `src/modules/theme/` | ~5,000 | ⭐⭐⭐⭐⭐ | **完整复用** — 15 主题、CSS 变量、字体 |
| `src/modules/sidebar/` | ~1,500 | ⭐⭐⭐⭐ | 改造为 SSH 连接 + 知识库 |
| `src/modules/statusbar/` | ~1,200 | ⭐⭐⭐⭐ | 加 SSH 状态 + 风控状态 |
| `src/modules/spaces/` | ~1,800 | ⭐⭐⭐ | 复用 SpaceSwitcher |
| `src/styles/tokens.ts` | ~200 | ⭐⭐⭐⭐⭐ | **完整复用** — 色板/字号/动效/间距 token |
| `src/settings/` | ~6,000 | ⭐⭐⭐ | 复用 7 个 Section 骨架 |
| `src/modules/updater/` | ~1,500 | ⭐⭐⭐ | 复用 useUpdater 模式 |
| `src/modules/lsp/` | ~3,000 | C 弃用 | 暂不需要 |
| **`terax-ai/src-tauri` Rust** | **21,482** | ⭐⭐⭐⭐⭐ | 复制 PTY / Shell / FS / Git（去掉 LSP/proc） |
| `src-tauri/src/modules/pty/` | ~3,000 | ⭐⭐⭐⭐⭐ | 复制并改造为 portable-pty |
| `src-tauri/src/modules/git/` | ~1,500 | ⭐⭐⭐⭐ | 改造为知识库 Git 同步 |
| `src-tauri/src/modules/fs/` | ~1,000 | ⭐⭐⭐⭐ | 改用知识库 API |

### 2.4 Rust 资产复用矩阵（ht + ht-mcp 实测）

| 模块 | 实测行数 | 评级 | TDSF 用法 |
|------|----------|------|-----------|
| **ht** `src/pty.rs` | 380 | ⭐⭐⭐⭐ | 整体移植到 TDSF `pty-engine` |
| **ht** `src/session.rs` | 320 | ⭐⭐⭐⭐ | 整体移植 VT100 仿真 |
| **ht** `src/nbio.rs` | 90 | ⭐⭐⭐ | 移植为 Windows non-blocking I/O |
| **ht-mcp** `src/mcp/tools.rs` | 130 | ⭐⭐⭐⭐ | 6 个 MCP tools 定义直接复用 |
| **ht-mcp** `src/ht_integration/session_manager.rs` | 380 | ⭐⭐⭐⭐ | 改造为 `tdsf-pty-server` |
| **ht-mcp** `src/transport/stdio.rs` | 200 | ⭐⭐⭐ | 整体移植 |

> **实测合计**：ht 3,788 行 + ht-mcp 3,697 行 = **7,485 行 Rust 范本**

### 2.5 ⭐ v3.0 新增：4 个被 v2.0 漏掉的关键资产

#### 2.5.1 itops-agent-platform（**最关键，162,302 行**）

> **最完整的运维 Agent 平台**！MCP gateway + AI agents + approval flow + monitor + alert auto-response

| 模块 | 实测行数 | TDSF 复用价值 |
|------|----------|---------------|
| `backend/src/modules/mcp/services/gateway/` | ~2,500 | ⭐⭐⭐⭐⭐ **MCP gateway + approvalFlow** 完整实现 |
| `backend/src/modules/ai/services/agents/agentCore.ts` | ~1,200 | ⭐⭐⭐⭐⭐ **Agent 核心编排** |
| `backend/src/modules/ai/services/agents/agentMcpAdapter.ts` | ~800 | ⭐⭐⭐⭐⭐ **Agent ↔ MCP 桥接** |
| `backend/src/modules/ai/services/edge/EdgeAgent.ts` | ~600 | ⭐⭐⭐⭐ **边缘 Agent**（远程 SSH 自动化） |
| `backend/src/modules/ai/services/multiAgent/` | ~2,000 | ⭐⭐⭐⭐ **多 Agent 协作**（Coordinator + Specialists） |
| `backend/src/modules/servers/services/sshService/` | ~1,200 | ⭐⭐⭐⭐ **SSH 服务** |
| `backend/src/modules/monitor/services/healthService.ts` | ~1,000 | ⭐⭐⭐ **健康监控** |
| `backend/src/modules/workflow/services/WorkflowEngine.ts` | ~1,800 | ⭐⭐⭐⭐ **工作流引擎** |
| `backend/src/modules/auth/services/encryptionService.ts` | ~600 | ⭐⭐⭐⭐ **加密服务**（密钥/凭据） |
| `backend/src/modules/database/services/dbskiterService.ts` | ~800 | ⭐⭐⭐ **数据库连接池** |
| `backend/src/modules/containers/services/dockerService.ts` | ~1,200 | ⭐⭐⭐ **Docker 服务** |
| `backend/src/modules/auto/services/autoScaleService.ts` | ~800 | ⭐⭐⭐ **自动扩缩容** |
| `backend/src/models/migrations/` | 50+ 文件 | ⭐⭐⭐ **数据库迁移框架** |
| `backend/src/modules/network/services/snmp/` | ~3,000 | ⭐⭐⭐ **网络设备管理** |

> **借鉴策略**：后端核心模块（**不是直接 fork**）作为**算法+流程参考**，翻译为 Python（LangGraph 节点）或 Rust（Tauri commands）。

#### 2.5.2 electerm（**已集成 AI 的 SSH 终端，91,335 行**）

> **已经实现了 SSH + AI 的 Electron 终端**，可作为 AI Panel 集成方式参考

| 模块 | 行数 | TDSF 复用价值 |
|------|------|---------------|
| `src/client/components/ai/ai-chat.jsx` | ~500 | ⭐⭐⭐⭐⭐ **AI Chat 完整 UI**（消息/历史/会话） |
| `src/client/components/ai/agent.js` | ~400 | ⭐⭐⭐⭐⭐ **Agent tool-call 卡片** |
| `src/client/components/ai/agent-tool-call-card.jsx` | ~300 | ⭐⭐⭐⭐ **工具调用可视化** |
| `src/client/components/ai/ai-config-modal.jsx` | ~200 | ⭐⭐⭐⭐ **AI 配置弹窗** |
| `src/client/components/ai/ai-guardrails.js` | ~300 | ⭐⭐⭐⭐⭐ **AI 安全护栏**（重要参考） |
| `src/app/mcp/server/mcp.js` | ~400 | ⭐⭐⭐⭐⭐ **MCP Server** |
| `src/app/mcp/server/streamableHttp.js` | ~300 | ⭐⭐⭐⭐ **MCP Streamable HTTP** |
| `src/app/server/session-ssh.js` | ~2,000 | ⭐⭐⭐⭐ **SSH 会话**（含 SFTP/隧道） |
| `src/app/server/session-base.js` | ~800 | ⭐⭐⭐ **会话基类** |
| `src/client/common/terminal-theme.js` | ~600 | ⭐⭐⭐⭐ **200+ 终端主题**（iTerm 兼容） |
| `src/client/common/iterm-theme.js` | ~800 | ⭐⭐⭐⭐ **iTerm 主题解析** |
| `src/client/components/bookmark-form/` | ~3,000 | ⭐⭐⭐⭐ **连接配置表单** |

> **借鉴策略**：AI Panel UI 组件**完整 fork 后用 React 19 重写**；MCP Server 实现**翻译为 Rust（rmcp）**。

#### 2.5.3 tabby（**200+ 配色方案，32,002 行**）

| 模块 | 行数 | TDSF 复用价值 |
|------|------|---------------|
| `tabby-community-color-schemes/schemes/` | 200+ 文件 | ⭐⭐⭐⭐⭐ **200+ 终端配色**（Dracula / Gruvbox / Nord / Tokyo Night 等） |
| `tabby-core/src/api/` | ~2,000 | ⭐⭐⭐⭐ **插件 API**（profileProvider/tabRecovery） |
| `tabby-core/src/components/` | ~3,000 | ⭐⭐⭐⭐ **Angular 组件**（tabHeader / splitTab / profileTree） |
| `app/lib/pty.ts` | ~400 | ⭐⭐⭐⭐ **PTY 抽象**（跨平台） |

> **借鉴策略**：200+ 配色方案**整体迁移**到 tdsf-terminal-agent，扩展 terax-ai 的 15 主题到 200+。

#### 2.5.4 nterm-ng（**TypeScript 终端，33,919 行**）

| 模块 | 行数 | TDSF 复用价值 |
|------|------|---------------|
| `src/renderer/` | ~10,000 | ⭐⭐⭐ **TypeScript 终端渲染** |
| `src/main/` | ~8,000 | ⭐⭐⭐ **Electron 主进程** |

> **借鉴策略**：仅作架构参考，**不直接 fork**（terax-ai 已经是更好的选择）。

### 2.6 tdsf-design-app 组件级复用（v3.0 新增，74 文件 / 22,875 行）

> **已经实现的设计稿组件**！直接复用为可视化模块

| 组件 | 路径 | 行数 | TDSF 用法 |
|------|------|------|-----------|
| **RiskGauge** | `src/components/ai-decision/RiskGauge.tsx` | ~150 | ⭐⭐⭐⭐⭐ **风险仪表盘**（直接复用） |
| **RiskPipeline** | `src/components/ai-decision/RiskPipeline.tsx` | ~200 | ⭐⭐⭐⭐⭐ **4 层风控可视化** |
| **RiskRadar** | `src/components/ai-decision/RiskRadar.tsx` | ~200 | ⭐⭐⭐⭐ **风险雷达图** |
| **ConfidenceRing** | `src/components/ai-decision/ConfidenceRing.tsx` | ~150 | ⭐⭐⭐⭐⭐ **置信度环** |
| **EvidenceTimeline** | `src/components/ai-decision/EvidenceTimeline.tsx` | ~200 | ⭐⭐⭐⭐⭐ **证据时间线** |
| **DangerCommandList** | `src/components/ai-decision/DangerCommandList.tsx` | ~200 | ⭐⭐⭐⭐ **危险命令清单** |
| **CpuRingChart** | `src/components/monitor/CpuRingChart.tsx` | ~100 | ⭐⭐⭐⭐ **CPU 环图** |
| **MemRingChart** | `src/components/monitor/MemRingChart.tsx` | ~100 | ⭐⭐⭐⭐ **内存环图** |
| **DiskRingChart** | `src/components/monitor/DiskRingChart.tsx` | ~100 | ⭐⭐⭐⭐ **磁盘环图** |
| **NetworkSparkline** | `src/components/monitor/NetworkSparkline.tsx` | ~150 | ⭐⭐⭐⭐ **网络 sparkline** |
| **AppLayout + ActivityRail** | `src/layouts/` | ~500 | ⭐⭐⭐⭐ **整体布局**（侧边栏 + 主区） |
| **20 个页面** | `src/pages/` | ~5,000 | ⭐⭐⭐ **设计稿来源**（Monitor / Risk / Knowledge 等） |

> **借鉴策略**：**直接复用** ai-decision/monitor 组件到 tdsf-terminal-agent 的 AI Panel（节省 ~2,000 行 React 代码）。

### 2.7 tdsf-linux-redesign 设计稿（v3.0 新增，30 文件 / 54,348 行）

> **20 个 HTML 静态页面 + 100+ 图标**，可作为 Trae Design 视觉输入

| 页面 | 用途 | 评级 |
|------|------|------|
| `pages/monitor.html` | 监控页 | ⭐⭐⭐⭐ |
| `pages/workbench-ai.html` | AI 工作台 | ⭐⭐⭐⭐⭐ |
| `pages/knowledge.html` + `knowledge-detail.html` | 知识库 | ⭐⭐⭐⭐⭐ |
| `pages/tutorial.html` + `tutorial-detail.html` | 教程 | ⭐⭐⭐⭐ |
| `pages/history.html` + `history-detail.html` | 历史 | ⭐⭐⭐⭐ |
| `pages/logs.html` | 日志 | ⭐⭐⭐ |
| `pages/settings-*.html` (8 个) | 设置 | ⭐⭐⭐ |
| `assets/icons/dl_builtin_trae/*.svg` | **100+ SVG 图标** | ⭐⭐⭐⭐⭐ **直接复用** |

> **借鉴策略**：将 20 个 HTML 页面打包给 Trae Design 作为视觉规范；100+ SVG 图标**直接复用**。

### 2.8 全局复用率汇总

| 类别 | 可复用代码 | 复用率 | 来源 |
|------|-----------|--------|------|
| **Python Agent** | 6,200 / 6,789 | 91% | projects/src |
| **Tauri 2 + React 19** | 35,000 / 89,000 | 39% | terax-ai fork |
| **Rust PTY/MCP** | 7,000 / 7,485 | 93% | ht + ht-mcp |
| **AI Panel 可视化** | 2,000 / 2,500 | 80% | tdsf-design-app |
| **200+ 终端主题** | 1,000 / 1,200 | 83% | tabby |
| **AI Chat UI** | 2,500 / 3,000 | 83% | electerm |
| **设计稿 / 图标** | 4,000 / 5,000 | 80% | tdsf-linux-redesign |
| **MCP gateway / approval** | 3,000 / 5,000 | 60% | itops-agent-platform |
| **教学知识库** | 6,125 / 6,125 | 100% | knowledge/academic |
| **总复用** | **~66,825 / ~125,099** | **53%** | — |
| **需新写** | ~10,000 | — | AI Panel / PAOR 编排 / Tauri commands |

---

## 三、调研发现 → 技术决策映射

> **每条选型都有量化依据**，无空想。

### 3.1 框架选型

| 选型 | 决策 | 量化依据 | 否决方案 |
|------|------|----------|----------|
| **桌面壳 = Tauri 2** | ✅ | terax-ai 已验证 7MB / <1s 启动；RSP <100MB RAM | Electron (365MB) / Wails (Go 生态不足) |
| **前端框架 = React 19 + TS** | ✅ | terax-ai 完整范本 67,509 行；tdsf-design-app 22,875 行可直接复用组件 | Vue (无 Rust 范本) / Svelte (生态小) |
| **样式 = Tailwind v4 + CSS 变量** | ✅ | terax-ai 已实现 15 主题 + Motion Tokens | shadcn/ui (shadcn 可选) |
| **终端 = xterm.js + Rust PTY** | ✅ | terax-ai 终端模块 8K 行验证 + ht PTY 1,386 行验证 | Ratatui (无 WebView) |

### 3.2 AI 引擎

| 选型 | 决策 | 量化依据 | 否决方案 |
|------|------|----------|----------|
| **Python Agent 引擎** | ✅ | 现有 6,789 行可复用 91% | 重写 (巨大浪费) |
| **LangGraph 7 节点** | ✅ | `projects/src/tdsf/graph/` 已实现 1,166 行 | 自研状态机 (重复造轮) |
| **Hermes / OpenCode 基座** | ❌ | v3.0 决定**fork terax-ai 而非 Hermes**：① terax-ai 已是 Tauri 2 + React 19 完整 IDE 范本 ② Hermes Python 体量大、过设计 ③ terax-ai fork 后改造 35K 行直接复用 | Hermes (体积大、过设计) |
| **MCP 协议** | ✅ | ht-mcp 1,580 行验证 + itops-agent-platform gateway 2,500 行 + electerm 700 行，三方验证 | 自研 RPC (无标准) |
| **AI Panel** | ✅ | electerm 已实现完整 AI chat + tool-call cards | 自研 (重复造轮) |

### 3.3 Rust 边界

| 选型 | 决策 | 量化依据 |
|------|------|----------|
| **PTY 引擎（Rust）** | ✅ | ht 1,386 行 + terax-ai 3,000 行 = 4,386 行可复用；单二进制 4.7MB |
| **MCP server（Rust）** | ✅ | ht-mcp 1,580 行 + itops-agent-platform gateway 2,500 行可参考 |
| **算法层（Python）** | ❌ 不用 | 6,789 行已稳定；Rust 重写价值低 |
| **Tauri 后端（Rust）** | ✅ | terax-ai 21,482 行范本；LSP 去掉后约 8,000 行 |

### 3.4 知识库

| 选型 | 决策 | 量化依据 |
|------|------|----------|
| **Markdown 文件 + Git** | ✅ | `knowledge/academic` 6,125 行 + `knowledge/courses` 34,380 行 = 40,505 行可直接当知识库 |
| **SQLite FTS5 全文索引** | ✅ | `projects/storage/sqlite_db.py` 已实现 1,293 行 |
| **ChromaDB 向量检索** | ✅ | `projects/storage/chroma_db.py` 已实现 |
| **教学爬虫** | ✅ 保留 | `tdsf-linux-desktop/src/services/tutorial/crawler/` 可作 Node 侧服务 |

### 3.5 设计稿来源（v3.0 新增决策）

| 选型 | 决策 | 量化依据 |
|------|------|----------|
| **主题引擎 = terax-ai CSS 变量** | ✅ | 15 主题 + 完整 token 体系，**完整复用** |
| **200+ 终端配色** | ✅ | tabby `tabby-community-color-schemes` **完整迁移** |
| **AI Panel 组件** | ✅ | tdsf-design-app 22,875 行组件**直接复用**（RiskGauge/Pipeline/Radar/ConfidenceRing/EvidenceTimeline/DangerCommandList） |
| **设计稿 HTML 模板** | ✅ | tdsf-linux-redesign 20 个 HTML + 100+ SVG 图标**打包给 Trae Design** |
| **iTerm 主题解析** | ✅ | electerm `iterm-theme.js` 800 行支持 iTerm 主题导入 |

---

## 四、总体架构设计

### 4.1 分层架构图

```
┌────────────────────────────────────────────────────────────────────┐
│                      TDSF Terminal Agent IDE                        │
│  桌面壳：Tauri 2（Rust ~500 行 + WebView 渲染 React 19）             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  UI 层（React 19 + Tailwind v4 + xterm.js + CodeMirror）     │  │
│  │  ┌─────────┬─────────────────────────────┬──────────────┐   │  │
│  │  │ Sidebar │ Terminal Tabs (xterm.js)     │ AI Panel     │   │  │
│  │  │ SSH/KB  │ [ssh:web-01] [ssh:db] [KB]  │ Chat / Tools  │   │  │
│  │  │ Space   ├─────────────────────────────┤ Knowledge    │   │  │
│  │  │ Switch  │  xterm.js canvas (PTY)      │ Risk / Skill │   │  │
│  │  │         │                             │              │   │  │
│  │  └─────────┴─────────────────────────────┴──────────────┘   │  │
│  │  StatusBar（CPU/MEM/DISK · 风控 · Token · 模式）              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                     │
│                  Tauri invoke + WebSocket + 事件流                  │
│                              │                                     │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │  Rust 后端层（src-tauri，~8,000 行）                          │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ pty-engine   │  │ mcp-server   │  │ fs/git/secret    │  │  │
│  │  │ portable-pty │  │ rmcp + 6+ tools │  │ notify / walk   │  │  │
│  │  │ + avt VT100  │  │              │  │                  │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ ssh-client   │  │ llm-router   │  │ config-store     │  │  │
│  │  │ russh/openssh│  │ provider     │  │ YAML+secrets     │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │ stdio (JSON-RPC) / HTTP              │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │  Python Agent Core（projects/src，6,789 行复用 91%）            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ LangGraph    │  │ MCP tools    │  │ Storage          │  │  │
│  │  │ 7 nodes      │  │ 15+ tools    │  │ SQLite+Chroma    │  │  │
│  │  │ PAOR 循环    │  │ SSH/Log/...  │  │ DecisionCards    │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                     │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │  知识库层（knowledge/，40,505 行 MD + Git 增量）                │  │
│  │  tutorials/ · skills/ · decisions/ · playbooks/ · man-pages/  │  │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 数据流（一次诊断示例）

```
User: 在终端敲 `df -h` → AI 主动推送
   ↓ (xterm.js PTY 事件)
Rust pty-engine 捕获命令
   ↓ (Tauri emit "terminal.command")
React 监听：AI Panel 唤醒
   ↓ (invoke 'tdsf.analyze')
Rust 路由到 mcp-server
   ↓ (stdio JSON-RPC)
Python Agent 收到：
  1. perceive 节点捕获命令
  2. retrieve 节点查知识库（ChromaDB）
  3. reason 节点走 LLM
  4. ground_check 节点验证证据
  5. assess_risk 节点过 RiskEngine
  6. decide 节点生成建议
  7. archive 节点写决策库
   ↓ (SSE stream back)
React AI Panel 流式渲染（RiskGauge / RiskPipeline / EvidenceTimeline 组件复用）
   ↓ (用户点 [执行])
Rust pty-engine 注入 `logrotate -f /etc/logrotate.conf`
   ↓
PTY 实时回流 xterm.js
```

---

## 五、技术栈选型详解（每层含版本+备选+否决理由）

### 5.1 桌面壳层

| 技术 | 版本 | 选型理由 | 备选 + 否决理由 |
|------|------|----------|-----------------|
| **Tauri** | 2.5+ | 7–15MB / <1s 启动 / Rust 后端安全模型 | ❌ Electron 365MB / 5–10s<br>❌ Wails Go 生态弱 / 终端范本缺失 |
| **WebView2** | 系统内置 | Windows 原生 | Edge WebView2 Runtime |
| **Vite** | 5.x | 最快的 React 构建工具 | ❌ Next.js 过度 |
| **rustup** | 1.90+ | Tauri 2 / ht 1.84 / 现代 crate 要求 | — |

### 5.2 前端层

| 技术 | 版本 | 复用依据 | 复用行数 |
|------|------|----------|----------|
| **React 19** | 19.x | terax-ai 67,509 行 + tdsf-design-app 22,875 行 | ~35K |
| **TypeScript** | 5.5+ | 类型安全 | — |
| **Tailwind CSS** | 4.x | terax-ai 完整 15 主题 + Motion Tokens | tokens.ts 直接复用 |
| **shadcn/ui** | latest | terax-ai 用 | 可选 |
| **xterm.js** | 5.x | 终端渲染标准 | 与 terax-ai 一致 |
| **CodeMirror 6** | 6.x | Markdown 教程编辑器 | 复用 terax-ai |
| **Zustand** | 5.x | 轻量 store | 复用 |
| **@tauri-apps/api** | 2.x | Tauri 2 JS SDK | 必须 |
| **react-markdown** | 9.x | MD 渲染 | 教学卡 / 决策卡 |
| **framer-motion** | 11.x | 平滑动效 | terax-ai Motion Tokens 体系 |
| **recharts / visx** | latest | 数据可视化 | tdsf-design-app 用 |

### 5.3 Rust 后端层

| 技术 | 版本 | 复用依据 | 用途 |
|------|------|----------|------|
| **tokio** | 1.40+ | ht / terax-ai 都用 | async 运行时 |
| **axum** | 0.7+ | ht / terax-ai | Tauri 内置 HTTP / WebSocket |
| **portable-pty** | 0.8+ | **替代 nix::pty**，跨平台 | PTY 抽象 |
| **avt** | 0.16+ | ht 已用 | VT100 仿真 |
| **russh** | 0.43+ | 纯 Rust SSH | 远端会话（参考 electerm session-ssh） |
| **rmcp** | latest | ht-mcp 用 | MCP server（参考 itops-agent-platform gateway） |
| **serde / serde_json** | 1.x | 序列化 | 标配 |
| **clap** | 4.x | CLI 参数 | Tauri 命令行入口 |
| **anyhow / thiserror** | latest | 错误处理 | 标配 |
| **notify** | 6.x | FS 监听 | 知识库热重载 |
| **tracing** | latest | 结构化日志 | 标配 |
| **mio** | latest | ht 用 | non-blocking I/O |
| **nix** | 0.28+ | ht 用 | Unix syscall（**仅 Unix 使用**） |

### 5.4 Python Agent 层

| 技术 | 版本 | 复用依据 | 用途 |
|------|------|----------|------|
| **Python** | 3.11+ | `pyproject.toml` 已定 | Agent 运行时 |
| **LangGraph** | 0.2+ | `projects/src/tdsf/graph/` | 7 节点状态机 |
| **Pydantic** | 2.x | 现有 | 数据模型 |
| **ChromaDB** | latest | `projects/src/tdsf/storage/` | 向量库 |
| **aiosqlite** | latest | 现有 | 异步 SQLite |
| **httpx** | latest | 现有 | 异步 HTTP（LLM API） |
| **PyYAML** | 6.x | 现有 | 配置 |
| **uv** | latest | 现有 | 包管理 |
| **pytest** | 8.x | 现有 10+ 测试文件 | 单元测试 |
| **mcp-python** | latest | 新增 | MCP server（参考 itops-agent-platform） |

> **关键决策**：**Python 通过 MCP 协议 stdio 暴露给 Rust**，避免 Tauri 内部嵌 Python（跨平台崩）。

### 5.5 知识库 / 数据层

| 技术 | 用途 | 复用依据 |
|------|------|----------|
| **Markdown + Git** | 知识库主载体 | knowledge/academic 6,125 + courses 34,380 = 40,505 行 |
| **SQLite + FTS5** | 决策库 / 全文索引 | projects/storage/sqlite_db.py 1,293 行 |
| **ChromaDB** | 向量检索（语义匹配） | projects/storage/chroma_db.py |
| **rusqlite** (Rust) | 决策库同步 | terax-ai 用 |

### 5.6 模型路由

| 提供商 | 模型 | 用途 |
|--------|------|------|
| **DeepSeek V3** | 默认 | 中文 / 推理 / 价格友好 |
| **Qwen 2.5 72B** | 备选 | 教学解释 |
| **GLM-4.5** | 备选 | 编码 |
| **Ollama (本地)** | 离线 | 演示 / 教学 |
| **OpenAI / Anthropic** | 商业 | 评审现场兜底 |

### 5.7 编译 / 工具链

| 工具 | 用途 | 配置 |
|------|------|------|
| **rustup** | Rust 工具链 | 1.90.0 |
| **cargo** | Rust 构建 | — |
| **sccache** | 编译缓存（10x 加速） | ~/.cargo/config.toml |
| **mold / lld** | 链接器（Linux 5x / Windows 2x） | — |
| **node 22+** | 前端构建 | — |
| **pnpm 9** | 替代 npm（workspace） | — |
| **uv** | Python 包管理 | — |
| **Tauri CLI** | Tauri 命令 | — |
| **TypeScript 5.5+** | TS 编译 | — |
| **rust-analyzer** | IDE 智能 | — |

---

## 六、界面设计规格（面向 Trae Design 完整交付）

> **这是给 Trae Design 的核心交付物**。每个规格都来自 terax-ai / tdsf-design-app / tdsf-linux-redesign 已验证的范本。

### 6.1 整体布局（默认分屏模式）

```
┌──────────────────────────────────────────────────────────────────┐
│  Header (Tauri 2 borderless, 高度 38px, 圆角 12px)                  │
│  ┌────┐  ┌─────────────────────────────────────┐  [─][□][╳]    │
│  │ T  │  │  Tab: [ssh:web-01] [ssh:db] [KB]+   │                │
│  └────┘  └─────────────────────────────────────┘                │
├────┬─────────────────────────────────────────────────┬───────────┤
│    │                                                 │  AI       │
│ S  │                                                 │  Panel    │
│ i  │  xterm.js Canvas (PTY, 复用 terax-ai)         │  (可拖)   │
│ d  │                                                 │           │
│ e  │                                                 │  Chat     │
│ b  │                                                 │  RiskGauge│
│ a  │                                                 │  RiskPip  │
│ r  │                                                 │  RiskRadar│
│    │                                                 │  ConfRing │
│ 60 │                                                 │  Evidence │
│ px  │                                                 │  Skill    │
├────┴─────────────────────────────────────────────────┴───────────┤
│  StatusBar (高度 24px)  AI:L1 · ops:web-01 ● · ops:db ○ · ⚠ops:web-02  │
│   [CpuRing] [MemRing] [DiskRing] [NetworkSparkline] [GPT-5.4]    │
└──────────────────────────────────────────────────────────────────┘
   60px        flex-grow 1                          360px (可调)
```

**StatusBar 增量（v3.1）**：
- `AI:L1` —— AI 权限档位（4 档：L0 免确认 / **L1 仅高危确认** / L2 写操作 / L3 全部）
- `ops:web-01 ●` —— 多 Agent/Session 状态点（● working / ○ idle / ⚠ needs-you），参考 [Termio](https://www.termio.sh/) + [herdr](https://github.com/ogulcancelik/herdr) 设计
- 点击状态点 → 弹出 Session 详情（命令历史 / 当前输出 / PAOR 进度）

### 6.2 三栏尺寸规范

| 区域 | 宽度 | 可调范围 | 来源 |
|------|------|----------|------|
| **Sidebar（活动栏）** | 60px 折叠 / 240px 展开 | 200–400px | terax-ai SidebarRail |
| **Terminal（主区）** | flex-grow | 40%–80% | terax-ai TerminalPane |
| **AI Panel** | 360px | 280–560px | terax-ai + electerm AI Chat |
| **底部 StatusBar** | 24px | 不可调 | terax-ai + tdsf-design-app |

### 6.3 主题与色板（CSS 变量）

> **完整复用 terax-ai `src/styles/tokens.ts` + 15 个主题文件**，**扩展** 200+ 终端配色（tabby `tabby-community-color-schemes/`）

| Token | 暗色（默认） | 亮色 | 用途 |
|-------|--------------|------|------|
| `--background` | `oklch(0.148 0.004 228.8)` = `#161618` | `#ffffff` | 主背景 |
| `--foreground` | `#fafafa` | `#161618` | 主文字 |
| `--card` | `#27272a` | `#f4f4f5` | 面板 |
| `--primary` | `#e4e4e7` | `#27272a` | 主按钮 |
| `--accent` | `#3f3f46` | `#e4e4e7` | 强调 |
| `--destructive` | `#ef4444` | `#dc2626` | 危险 |
| `--border` | `rgba(255,255,255,0.1)` | `#e4e4e7` | 边框 |
| `--tdsf-accent` | `#7c3aed` | `#7c3aed` | **TDSF 紫**（与 Claude 一致） |
| `--tdsf-success` | `#22c55e` | `#16a34a` | OK / 已通过 |
| `--tdsf-warning` | `#facc15` | `#ca8a04` | 风险中等 |
| `--tdsf-danger` | `#ef4444` | `#dc2626` | 风险高 |
| `--tdsf-info` | `#3b82f6` | `#2563eb` | 信息 |

**预置主题**（**15 + 200 = 215 个**）：
- **15 个 UI 主题**（源自 terax-ai）：terax-default、nord、tide、catppuccin、tokyo-night、caffeine、claude、gruvbox、sage、rose-pine、dracula、everforest、kanagawa、kanagawa-dragon、solarized
- **200+ 终端配色**（源自 tabby）：Dracula、Gruvbox、Nord、Tokyo Night、Monokai、Solarized、Atom、Material、N0tch2k、PencilDark 等

### 6.4 终端 ANSI 配色

完整复用 terax-ai 默认 ANSI 调色板（`src/styles/terminalTheme.ts`）：

```ts
ansi: {
  black: '#18181b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e4e4e7',
  brightBlack: '#52525b', brightRed: '#f87171', brightGreen: '#4ade80',
  brightYellow: '#facc15', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
  brightCyan: '#22d3ee', brightWhite: '#fafafa',
}
```

### 6.5 字体

| 用途 | 字体 | 来源 |
|------|------|------|
| **UI 字体** | **Inter Variable**（100–900） | terax-ai 完整复用 |
| **终端字体** | **JetBrains Mono**（400/700） | terax-ai 完整复用 |
| **编辑器字体** | **JetBrains Mono** | 同上 |
| **等宽** | **JetBrains Mono** | 同上 |
| **中文字体** | **Noto Sans SC** | itops-agent-platform 字体包 |

字号：编辑器 13px / 终端 14px / UI 14px / 标题 16–22px

### 6.6 动效（Motion Tokens）

> 复用 terax-ai `src/styles/tokens.ts` 中的 `motion.*` 配置。

| Token | 值 | 用途 |
|-------|----|----|
| `motion.duration.fast` | 150ms | hover / 按钮 |
| `motion.duration.normal` | 250ms | 面板切换 |
| `motion.duration.slow` | 400ms | 主题切换 |
| `motion.easing.standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | 默认 |
| `motion.easing.decelerate` | `cubic-bezier(0, 0, 0.2, 1)` | 进入 |
| `motion.easing.accelerate` | `cubic-bezier(0.4, 0, 1, 1)` | 退出 |
| `motion.easing.premium` | `cubic-bezier(0.16, 1, 0.3, 1)` | 弹性（terax-ai 招牌） |
| `motion.easing.soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | 柔和 |

### 6.7 圆角与间距

| 圆角 Token | 值 | 用途 |
|------------|----|----|
| `--radius` | 10px | 基础 |
| `--radius-sm` | 6px | 小按钮 |
| `--radius-md` | 8px | 卡片 |
| `--radius-lg` | 10px | 面板 |
| `--radius-xl` | 14px | 弹窗 |
| `--radius-2xl` | 18px | 大弹窗 |

**Borderless 窗口**：`border-radius: 12px` 应用到整体（terax-ai 已验证）。

### 6.8 AI Panel 内部布局（关键差异化）

> **直接复用 tdsf-design-app 已实现的可视化组件**

```
┌────────────────────────────────────────────────┐
│  AI Panel (360px, 可拖拽)                       │
├────────────────────────────────────────────────┤
│  [Chat Tab] [Risk Tab] [Knowledge] [Skill]     │ ← 顶部分页
├────────────────────────────────────────────────┤
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │  User: 帮我排查 /var/log 磁盘满了         │ │ ← Chat 历史
│  │                                          │ │
│  │  Agent: 已通过 SSH 执行：                │ │   （复用
│  │  df -h → /var/log 95%                   │ │    electerm
│  │  du -sh /var/log/* →                    │ │    ai-chat）
│  │  nginx/access.log 8.2G                  │ │
│  │                                          │ │
│  │  ┌────────┐ ┌──────────┐ ┌──────────┐  │ │
│  │  │Confidence│ │RiskGauge │ │Evidence   │  │ ← 复用
│  │  │  Ring   │ │   0.85   │ │ Timeline  │  │   tdsf-design-app
│  │  └────────┘ └──────────┘ └──────────┘  │ │   组件
│  │                                          │ │
│  │  [执行] [审查] [修改]                    │ │ ← 风险卡
│  └──────────────────────────────────────────┘ │
│                                                │
│  [输入框：问点什么...]              [发送]      │
└────────────────────────────────────────────────┘
```

**复用组件清单**（来自 tdsf-design-app）：
- `RiskGauge` - 风险仪表盘（实时显示风险评分）
- `RiskPipeline` - 4 层风控管道可视化
- `RiskRadar` - 风险雷达图
- `ConfidenceRing` - 置信度环
- `EvidenceTimeline` - 证据时间线
- `DangerCommandList` - 危险命令清单
- `ai-chat.jsx` (electerm) - AI 对话基础结构

### 6.9 Sidebar 活动栏（左侧 60px）

```
┌────┐
│ T  │ ← 终端 Tab 列表
├────┤
│ ▣  │ ← AI 知识库
├────┤
│ ⚠  │ ← 风控中心
├────┤
│ ◆  │ ← 技能中心
├────┤
│ ⚙  │ ← 设置
├────┤
│ ⓘ  │ ← 关于
└────┘
```

**图标源**：
- terax-ai SidebarRail
- tdsf-linux-redesign `assets/icons/dl_builtin_trae/*.svg` 100+ 图标
- electerm Lucide icons

### 6.10 关键交互流程

#### 6.10.1 终端命令 → AI 主动建议

```
用户在 xterm 输入 `df -h\n`
   ↓
PTY 事件 → Rust pty-engine 推送到 Tauri
   ↓
React AI Panel 收到 "terminal.activity"
   ↓
显示 loading spinner（shimmer 动画）
   ↓
调用 mcp-server `analyze_terminal` tool
   ↓
SSE 流式返回：诊断 + 知识卡 + 风险卡
   ↓
AI Panel 渲染（RiskGauge + RiskPipeline + EvidenceTimeline + ConfidenceRing）
```

#### 6.10.2 高危命令拦截（关键演示）

```
用户输入 `rm -rf /var/log/old/*\n`
   ↓
Rust 拦截：PTY 输入事件 + 解析命令
   ↓
本地快速规则匹配 → 高危
   ↓
AI Panel 弹出 风险卡（RiskGauge 红色 + RiskPipeline 显示哪一层命中）
   ↓
等待用户点击 [执行] [修改] [取消]
   ↓
若 [执行] → 注入命令到 PTY
若 [取消] → 终止命令并写 DecisionCard
```

#### 6.10.3 知识卡自动注入

```
RiskEngine 评估中 → 检索知识库
   ↓
ChromaDB 相似度匹配 → top-3 教程
   ↓
注入到 AI Panel 知识卡区
   ↓
用户点击 [在编辑器中打开] → CodeMirror 加载 .md
```

### 6.11 视图模式（3 种）

| 模式 | 快捷键 | 描述 | 来源 |
|------|--------|------|------|
| **分屏**（默认） | `Ctrl+1` | 左 SSH + 右 AI + 底 StatusBar | terax-ai |
| **全屏终端** | `Ctrl+2` | AI 缩为悬浮 | terax-ai |
| **全屏 AI** | `Ctrl+3` | 终端缩为悬浮，适合学习 | terax-ai |

### 6.12 快捷键设计

| 快捷键 | 功能 | 来源 |
|--------|------|------|
| `Ctrl+O` | 切换 Agent 模式（ops/review/teach） | 自研 |
| `Ctrl+K` | 打开知识库搜索 | terax-ai |
| `Ctrl+S` | 打开 Skill 面板 | 自研 |
| `Ctrl+R` | 触发安全审查 | 自研 |
| `Ctrl+T` | 新建 SSH 连接 Tab | terax-ai |
| `Ctrl+W` | 关闭当前 Tab | terax-ai |
| `Ctrl+1-9` | 切换到第 N 个 Tab | terax-ai |
| `Ctrl+J/K` | 切换到上/下一个 Tab | terax-ai |
| `Ctrl+H/L` | 调整分屏比例 | terax-ai |
| `Ctrl+F` | 进入全屏 SSH 模式 | terax-ai |
| `Ctrl+G` | 进入全屏 Agent 模式 | terax-ai |
| `Ctrl+Escape` | 回到分屏模式 | terax-ai |
| `Ctrl+Q` | 退出 TDSF | terax-ai |
| `Ctrl+Shift+P` | 命令面板 | terax-ai |

---

## 七、接口定义（Rust ↔ Python ↔ React 完整契约）

### 7.1 Tauri Rust Commands（30+ 核心）

```rust
// === 会话管理（pty-engine）===
tauri::command async fn pty_create(tab_id: String, kind: PtyKind, cwd: String) -> SessionId
tauri::command async fn pty_destroy(session_id: String) -> ()
tauri::command async fn pty_input(session_id: String, data: Vec<u8>) -> ()
tauri::command async fn pty_resize(session_id: String, cols: u16, rows: u16) -> ()
tauri::command async fn pty_snapshot(session_id: String) -> String  // 纯文本视图
tauri::command async fn pty_list() -> Vec<SessionInfo>

// === SSH（参考 electerm session-ssh）===
tauri::command async fn ssh_connect(profile: SshProfile) -> SessionId
tauri::command async fn ssh_disconnect(session_id: String) -> ()
tauri::command async fn ssh_list_profiles() -> Vec<SshProfile>
tauri::command async fn ssh_test_connection(profile: SshProfile) -> ConnectionTestResult

// === MCP / Agent（参考 itops-agent-platform gateway）===
tauri::command async fn mcp_call(tool: String, args: Value) -> Value
tauri::command fn mcp_list_tools() -> Vec<ToolSpec>
tauri::command async fn mcp_approve(tool_call_id: String, decision: ApprovalDecision) -> ()

// === AI Chat（参考 electerm ai-chat）===
tauri::command async fn chat_send(prompt: String, context: Option<Context>) -> EventId
tauri::command async fn chat_cancel(event_id: String) -> ()
tauri::command async fn chat_list_sessions() -> Vec<ChatSession>
tauri::command async fn chat_load_history(session_id: String) -> Vec<ChatMessage>

// === 知识库 ===
tauri::command async fn kb_search(query: String, k: usize) -> Vec<DocHit>
tauri::command async fn kb_open(path: String) -> MarkdownDoc
tauri::command async fn kb_list(prefix: String) -> Vec<KbEntry>

// === 决策库 ===
tauri::command async fn decision_list(filter: Option<Filter>) -> Vec<DecisionCard>
tauri::command async fn decision_archive(card: DecisionCard) -> DecisionId

// === 风险（4 层管道）===
tauri::command async fn risk_evaluate(command: String, context: Context) -> RiskVerdict
tauri::command async fn risk_pipeline_status() -> PipelineStatus

// === 主题 / 配置 ===
tauri::command fn theme_list() -> Vec<Theme>  // 215 个主题
tauri::command async fn theme_apply(theme_id: String) -> ()
tauri::command async fn theme_import_iterm(path: String) -> Theme  // iTerm 主题
tauri::command fn config_get(key: String) -> Value
tauri::command async fn config_set(key: String, value: Value) -> ()

// === 教学 ===
tauri::command async fn tutorial_recommend(context: Context) -> Vec<Tutorial>
tauri::command async fn skill_execute(name: String, args: Value) -> Value
tauri::command async fn skill_list() -> Vec<Skill>

// === v3.1 增量：风险用户控制（4 档权限，借鉴 uniTerm） ===
tauri::command async fn risk_user_mode_get() -> UserAIMode           // 当前档位
tauri::command async fn risk_user_mode_set(mode: UserAIMode) -> ()    // 切换档位
tauri::command async fn risk_should_confirm(level: RiskLevel, cmd: String, mode: UserAIMode) -> bool
// 双重控制：auto_risk_level × user_mode_threshold
// L0=免确认 L1=仅高危 L2=写操作 L3=全部
```

### 7.2 MCP Tools（Python 侧，15+ 工具）

> **完全复用 ht-mcp 的 6 个核心 tools 模式**，扩展到 15+ 个。**v3.1 增量：BYOA 8+ harness 适配**。

```python
# tools/registry.py
TOOLS = [
    # === 终端类（来自 ht-mcp 1,580 行）===
    Tool(name="tdsf_pty_create", ...),
    Tool(name="tdsf_pty_send_keys", ...),
    Tool(name="tdsf_pty_snapshot", ...),
    Tool(name="tdsf_pty_execute", ...),
    Tool(name="tdsf_pty_list", ...),
    Tool(name="tdsf_pty_close", ...),

    # === 运维诊断（自研）===
    Tool(name="tdsf_ssh_diagnose", risk_engine=...),     # SSH 远程诊断
    Tool(name="tdsf_log_analyze", drain3=...),           # 日志分析
    Tool(name="tdsf_system_health", ...),                # 系统指标
    Tool(name="tdsf_risk_evaluate", risk_engine=...),    # 风险评估
    Tool(name="tdsf_confidence_assess", confidence=...), # 置信度
    Tool(name="tdsf_ground_check", grounding=...),       # 证据校验

    # === 教学类 ===
    Tool(name="tdsf_kb_search", chroma=...),             # 知识库检索
    Tool(name="tdsf_tutorial_recommend", ...),           # 教程推荐
    Tool(name="tdsf_explain_command", llm=...),          # 命令解释

    # === 沉淀类 ===
    Tool(name="tdsf_decision_archive", ...),             # 决策归档
    Tool(name="tdsf_skill_create", ...),                 # 技能创建
    Tool(name="tdsf_skill_execute", ...),                # 技能执行

    # === v3.1 增量：BYOA "Bring Your Own Agent" 适配 ===
    # 借鉴 Orca + Synara：用户可复用 Claude Code / Codex / OpenCode 等订阅
    Tool(name="tdsf_harness_list", ...),                 # 列出 8+ harness
    Tool(name="tdsf_harness_select", harness_id, ...),   # 切换 harness
    Tool(name="tdsf_claude_code_spawn", prompt, ...),    # 复用 Claude Pro 订阅
    Tool(name="tdsf_codex_spawn", prompt, ...),          # 复用 ChatGPT Pro 订阅
    Tool(name="tdsf_opencode_spawn", prompt, ...),       # 复用 OpenCode Zen
    Tool(name="tdsf_gemini_spawn", prompt, ...),         # 复用 Gemini 订阅
    Tool(name="tdsf_grok_spawn", prompt, ...),           # 复用 Grok 订阅
    Tool(name="tdsf_aider_spawn", prompt, ...),          # 复用 Aider 订阅
    Tool(name="tdsf_pi_spawn", prompt, ...),             # 复用 Pi 订阅
]
```

**v3.1 BYOA 架构**（借鉴 [Orca](https://www.onorca.dev/) + [Synara](https://www.trysynara.com/)）：

```python
# tdsf/agent/harness/__init__.py
class HarnessAdapter(Protocol):
    """统一 harness 抽象协议"""
    name: str
    spawn: Callable[[str, dict], AsyncIterator[str]]  # 流式输出
    cancel: Callable[[], Awaitable[None]]
    get_status: Callable[[], dict]

class NativeHarness:
    """自研 PAOR 循环，默认 harness"""
    name = "tdsf-native"
    ...

class ClaudeCodeHarness:
    """复用用户 Claude Pro 订阅（$20/月）"""
    name = "claude-code"
    def __init__(self):
        self.cli = shutil.which("claude")  # 检测本地 CLI
    async def spawn(self, prompt, ctx):
        proc = await asyncio.create_subprocess_exec(
            "claude", "--print", prompt,
            stdout=asyncio.subprocess.PIPE
        )
        async for line in proc.stdout: yield line.decode()

class CodexHarness:
    """复用用户 ChatGPT Pro 订阅（$200/月）"""
    name = "codex"
    async def spawn(self, prompt, ctx):
        proc = await asyncio.create_subprocess_exec(
            "codex", "exec", prompt,
            stdout=asyncio.subprocess.PIPE
        )
        async for line in proc.stdout: yield line.decode()

# OpenCodeHarness / GeminiHarness / GrokHarness / AiderHarness / PiHarness ...

# 自动选择最优
class AutoHarness:
    name = "auto"
    async def spawn(self, prompt, ctx):
        # 1. 简单诊断 → tdsf-native（最快，本地）
        if len(prompt) < 200 and is_simple_diagnosis(prompt):
            return await NativeHarness().spawn(prompt, ctx)
        # 2. 复杂任务 → 用户的 Claude Pro（用户已付费）
        if user.has_subscription("claude-pro"):
            return await ClaudeCodeHarness().spawn(prompt, ctx)
        # 3. 兜底 → OpenCode Zen（按 token 计费）
        return await OpenCodeHarness().spawn(prompt, ctx)
```

### 7.3 Tauri 事件协议（SSE/Stream）

```rust
// Rust → React 事件流
event: "pty.output"     { session_id, data: string }
event: "pty.exit"       { session_id, code }
event: "chat.delta"     { event_id, delta: string }
event: "chat.tool"      { event_id, tool_name, args, result }
event: "chat.done"      { event_id, usage }
event: "risk.alert"     { session_id, level: "low|med|high|crit", command, reason }
event: "kb.inject"      { session_id, hits: DocHit[] }
event: "decision.created" { card: DecisionCard }
event: "approval.needed" { tool_call_id, tool, args }  // itops 模式
```

---

## 八、项目结构与目录规划（monorepo 完整）

```
tdsf-terminal-agent/
├── README.md                              # 快速开始
├── package.json                           # pnpm workspace 根
├── pnpm-workspace.yaml
├── Cargo.toml                             # Rust workspace 根
├── rust-toolchain.toml                    # 1.90.0 + components
├── .cargo/config.toml                     # sccache + 镜像
├── reports/                               # ← 调研报告（4 份）
│   ├── TDSF-终端Agent技术方案书-v3.0.md           # 本文档
│   ├── TDSF-终端Agent方向方案书-整合版.md         # 整合版 v1.2
│   ├── tdsf-terminal-agent-full-research.md      # 14 项目深度调研
│   └── 终端Agent转型可行性调研-2026-07-25.md      # 转型可行性
├── docs/                                  # 项目文档
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── DESIGN-SPEC.md     # ← 给 Trae Design 的接口
│   └── RUNBOOK.md
├── knowledge/                             # ← 教学知识库（40,505 行 MD）
│   ├── academic/         # 6,125 行（来自 knowledge/academic）
│   ├── courses/          # 34,380 行（来自 knowledge/courses）
│   ├── tutorials/        # 新增
│   ├── skills/           # 新增
│   ├── decisions/        # 决策归档
│   ├── playbooks/        # 运维手册
│   └── man-pages/        # 命令手册
├── agent/                                 # ← Python Agent Core
│   ├── pyproject.toml                     # uv 管理
│   ├── src/tdsf/
│   │   ├── core/         # risk_engine, confidence, decision, grounding, sampling, llm_client (复用 projects/src)
│   │   ├── graph/        # nodes, builder, edges, state (复用)
│   │   ├── tools/        # ssh, log, system, mcp_tools (复用)
│   │   ├── storage/      # sqlite, chroma, schemas (复用)
│   │   ├── mcp/          # MCP server (stdin/stdout)
│   │   ├── config.py
│   │   └── app.py        # Agent 入口
│   └── tests/            # 单元测试
├── desktop/                               # ← Tauri 桌面壳
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/                               # React 19 前端（fork 自 terax-ai）
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles/        # tokens.ts, globals.css（fork 自 terax-ai）
│   │   ├── modules/
│   │   │   ├── terminal/  # TerminalStack, TerminalPane（fork terax-ai）
│   │   │   ├── tabs/      # TabBar, TabSwitcherHud（fork terax-ai）
│   │   │   ├── sidebar/   # SidebarRail（fork terax-ai 改造）
│   │   │   ├── ai-panel/  # 【新增】AI 对话（参考 electerm ai-chat）
│   │   │   │   ├── Chat/   # 复用 tdsf-design-app RiskGauge/RiskPipeline/RiskRadar
│   │   │   │   ├── RiskCard/
│   │   │   │   ├── KnowledgeCard/
│   │   │   │   ├── SkillCard/
│   │   │   │   └── index.ts
│   │   │   ├── knowledge/ # 【新增】知识卡
│   │   │   ├── risk/      # 【新增】风险卡（4 层管道）
│   │   │   ├── statusbar/
│   │   │   ├── theme/     # 215 主题（15 terax + 200 tabby）
│   │   │   ├── spaces/
│   │   │   ├── settings/  # 7 个 Section
│   │   │   └── chat/      # 流式 Markdown
│   │   ├── stores/        # zustand
│   │   ├── lib/           # tauri 封装
│   │   └── components/    # 复用 tdsf-design-app
│   └── src-tauri/                          # Rust 后端（fork 自 terax-ai）
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       └── src/
│           ├── main.rs
│           ├── lib.rs
│           ├── pty/        # 【增强】portable-pty 跨平台（参考 ht + terax-ai）
│           ├── session/    # 【增强】VT100 仿真（参考 ht）
│           ├── ssh/        # 【新增】russh 客户端（参考 electerm session-ssh）
│           ├── mcp/        # 【新增】MCP client（参考 ht-mcp + itops）
│           ├── fs/         # 知识库（参考 terax-ai fs + itops）
│           ├── git/        # 知识库 Git 同步
│           ├── secret/     # 凭据加密（参考 itops encryptionService）
│           └── commands/   # 30+ tauri commands
└── scripts/                                # 构建 / 部署
    ├── build.sh
    ├── release.sh
    ├── vendor-deps.sh
    └── count_v3.py        # 实测代码量化
```

### 8.1 与开源项目映射（v3.0 完整）

| TDSF 模块 | 主要参考源 | 复用行数 |
|-----------|------------|----------|
| `desktop/src/styles/*` | terax-ai | ~200 |
| `desktop/src/modules/theme/*` | terax-ai | ~5,000 |
| `desktop/src/modules/terminal/*` | terax-ai | ~8,000 |
| `desktop/src/modules/tabs/*` | terax-ai | ~3,500 |
| `desktop/src/modules/sidebar/*` | terax-ai | ~1,500 |
| `desktop/src/modules/statusbar/*` | terax-ai | ~1,200 |
| `desktop/src/modules/spaces/*` | terax-ai | ~1,800 |
| `desktop/src/modules/ai-panel/*` | electerm + tdsf-design-app | ~5,000 |
| `desktop/src/components/ai-decision/*` | tdsf-design-app | ~2,000 |
| `desktop/src/components/monitor/*` | tdsf-design-app | ~1,000 |
| `desktop/src-tauri/src/pty/*` | terax-ai + ht | ~3,000 |
| `desktop/src-tauri/src/session/*` | ht | ~1,400 |
| `desktop/src-tauri/src/ssh/*` | electerm session-ssh | ~2,000 |
| `desktop/src-tauri/src/mcp/*` | ht-mcp + itops gateway | ~4,000 |
| `desktop/src-tauri/src/secret/*` | itops encryptionService | ~600 |
| `desktop/src-tauri/src/fs/*` | terax-ai + itops | ~1,500 |
| `agent/src/tdsf/core/*` | projects/src | ~6,000 |
| `agent/src/tdsf/graph/*` | projects/src | ~1,100 |
| `agent/src/tdsf/mcp/server.py` | itops-agent-mcpAdapter | ~1,000 |
| `knowledge/academic` | knowledge/academic | 6,125 |
| `knowledge/courses` | knowledge/courses | 34,380 |
| `theme/schemes/200+` | tabby community-color-schemes | ~1,000 |
| **合计复用** | | **~91,425 行** |

> **比 v2.0 多出 ~56,000 行复用**（v2.0 估算 35,000 行）！**关键在补全 4 个新项目**。

---

## 九、实施路线图（AI 单人 1–2 周）

> **已不考虑任何比赛冲刺约束**（用户明确，记忆 LRN-20260726-003）。  
> 全部由 AI 开发，工程量约 1.5 倍新增代码量（10K → 15K），**AI 单人 1–2 周可完成**。

### 9.1 总览

| 阶段 | 周期 | 里程碑 | 累计行数 |
|------|------|--------|----------|
| **P0. 立项** | Day 1 | 创建 monorepo + 跑通 terax-ai demo | 0 → 5K |
| **P1. 前端壳** | Day 2–3 | fork terax-ai + 复用 tdsf-design-app 组件 | 5K → 25K |
| **P2. Rust 后端** | Day 4–5 | 移植 ht PTY + MCP + SSH + 30+ commands | 25K → 35K |
| **P3. Python Agent** | Day 6–7 | 迁移 projects/src + 接 MCP server + PAOR | 35K → 45K |
| **P4. AI Panel** | Day 8–9 | React 侧栏 + 流式 chat + 风险可视化 | 45K → 55K |
| **P5. 知识库 + 主题** | Day 10–11 | MD 检索 + 教程推荐 + 215 主题 | 55K → 75K |
| **P6. 风控 + 沉淀** | Day 12 | 4 层风险拦截 + DecisionCard + Skill | 75K → 85K |
| **P7. 演示 + 文档** | Day 13–14 | asciinema 录屏 + 完整文档 | 85K → 91K |

### 9.2 关键里程碑

#### 里程碑 1（P0 完成）：Hello Terminal Agent

```bash
git clone https://github.com/crynta/terax-ai terax-fork
# 1. 砍掉 LSP/Updater/proc 模块
# 2. 改名为 tdsf-terminal-agent
# 3. 改 Cargo.toml [package].name = "tdsf-terminal-agent"
# 4. cargo tauri dev → 跑通 terax-ai 原版 UI
# 5. 提交基线 v0.1.0
```

#### 里程碑 2（P2 完成）：PTY 直连

```rust
// src-tauri/src/pty/mod.rs（参考 terax-ai + ht）
pub fn create(cols: u16, rows: u16, command: String) -> Result<Session> {
    let pty = portable_pty::native_pty_system()
        .openpty(PtySize { rows, cols, ... })?;
    let mut cmd = CommandBuilder::new(command);
    let child = pty.slave().spawn_command(cmd)?;
    Ok(Session { vt: avt::Vt::new(cols, rows), pty, child })
}
```

#### 里程碑 3（P3 完成）：Agent 能说话

```python
# agent/src/tdsf/mcp/server.py
async def handle_request(req: dict) -> dict:
    if req["method"] == "tools/call":
        tool = TOOLS_BY_NAME[req["params"]["name"]]
        return await tool.run(req["params"]["arguments"])
```

#### 里程碑 4（P4 完成）：AI Panel 可视化

```tsx
// desktop/src/modules/ai-panel/index.tsx
import { RiskGauge } from "@/components/ai-decision/RiskGauge";        // tdsf-design-app
import { RiskPipeline } from "@/components/ai-decision/RiskPipeline";  // tdsf-design-app
import { ConfidenceRing } from "@/components/ai-decision/ConfidenceRing"; // tdsf-design-app
import { EvidenceTimeline } from "@/components/ai-decision/EvidenceTimeline"; // tdsf-design-app
```

#### 里程碑 5（P7 完成）：5 分钟录屏脚本

```
[0:00-0:30] 开场：双击 tdsf-terminal-agent 图标，<1s 启动
[0:30-1:30] SSH 到 web-01，df -h 触发 AI 主动建议
[1:30-2:30] 知识卡自动注入 + 风险卡拦截（RiskGauge + RiskPipeline）
[2:30-3:30] 执行 logrotate + 决策卡归档
[3:30-4:30] 切到知识库视图，主题切换演示（215 主题）
[4:30-5:00] 总结：会自我进化的运维 Agent
```

---

## 十、风险矩阵与决策拍板

### 10.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| **Tauri 2 在 Windows 编译失败** | 中 | 高 | GitHub Actions matrix 测试，CI 提前验证 |
| **portable-pty 与 xterm.js 协议不一致** | 中 | 中 | 复用 terax-ai 终端模块，协议已验证 |
| **Python MCP server 与 Rust 通信延迟** | 低 | 中 | Unix socket / named pipe，< 5ms |
| **React 19 + Tauri 2 兼容性问题** | 低 | 高 | terax-ai 已验证，fork 而非重写 |
| **terax-ai 协议变更** | 中 | 中 | fork 到本地后独立维护，**不跟随上游** |
| **代码审计未通过** | 低 | 中 | ht-mcp（Apache 2.0）+ terax-ai 注明 |
| **itops-agent-platform 协议** | 低 | 中 | itops 已 Apache，仅参考架构 |
| **Claude Code 泄露源码被 DMCA** | 低 | 中 | 仅参考架构，不直接复制 |

### 10.2 决策拍板（一次性，不再讨论）

| 决策 | 推荐方案 | 否决 | 理由 |
|------|----------|------|------|
| **桌面框架** | Tauri 2 | Electron / Wails | 体积 + 性能 + Rust 范本 |
| **前端** | React 19 + TS + Tailwind v4 | Vue / Svelte | terax-ai 范本 |
| **终端** | xterm.js + Rust PTY | Ratatui | 必须 Web 集成 |
| **AI 引擎** | Python（LangGraph） | Hermes / Node | 6,789 行可复用 |
| **基座** | **fork terax-ai**（不 Herms/OpenCode） | Hermes | terax-ai 已是 Tauri 2 完整 IDE 范本 |
| **PTY** | portable-pty (Rust) | nix / ConPTY | 跨平台 |
| **MCP** | Rust 客户端 + Python server | 纯 Python | ht-mcp + itops 验证 |
| **知识库** | MD + SQLite + Chroma | Elasticsearch | 现有实现 |
| **AI Panel** | 复用 tdsf-design-app + electerm | 自研 | 节省 2,000 行 |
| **主题** | 15 terax + 200 tabby = 215 | 单一 | 行业最全 |
| **图标** | 100+ SVG (tdsf-redesign) + Lucide | 自研 | 直接复用 |

### 10.3 最终技术栈

```
┌──────────────────────────────────────────────────────────────────┐
│                TDSF Terminal Agent IDE 技术栈                     │
├──────────────────────────────────────────────────────────────────┤
│  桌面壳        │  Tauri 2.5+                                       │
│  前端          │  React 19 + TypeScript 5.5 + Tailwind CSS v4     │
│  终端          │  xterm.js 5.x + CodeMirror 6                      │
│  状态          │  Zustand 5.x                                      │
│  Rust 后端     │  tokio + axum + portable-pty + avt + rmcp         │
│  桥接          │  Tauri invoke + Tauri event (SSE)                  │
│  Python Agent  │  3.11 + LangGraph + Pydantic + ChromaDB            │
│  MCP 协议      │  stdio JSON-RPC                                   │
│  知识库        │  Markdown + Git + SQLite FTS5 + ChromaDB           │
│  主题          │  215 主题（15 terax + 200 tabby）                  │
│  字体          │  Inter Variable + JetBrains Mono + Noto Sans SC  │
│  模型          │  DeepSeek V3 / Qwen 2.5 / GLM-4.5 / Ollama         │
│  编译          │  rustup 1.90 + cargo + sccache + mold/lld         │
│  包管理        │  pnpm 9 + uv + crates.io（USTC 镜像）              │
│  平台          │  Windows 11 / macOS 15 / Ubuntu 24.04              │
│  演示          │  asciinema + Playwright 录屏                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 十一、量化收益与硬约束

### 11.1 量化收益（vs 从零开发）

| 维度 | 从零开发 | v3.0 方案（fork + 移植） | 节省 |
|------|----------|-------------------------|------|
| 前端代码 | 30,000 行 | 复用 50,000 + 新增 5,000 | **93%** |
| Rust 后端 | 8,000 行 | 复用 6,000 + 新增 2,000 | **75%** |
| Python Agent | 8,000 行 | 复用 6,200 + 新增 1,000 | **78%** |
| 主题/图标 | 2,000 个 | 复用 215 主题 + 100 图标 | **~100%** |
| 设计稿 | 2 周 | 复用 tdsf-redesign + tdsf-design-app | **~90%** |
| 调研 | 30 天 | 已有 4 份报告 + 27 个项目 | **~95%** |
| **总工程量** | **~6 个月** | **AI 1–2 周** | **~95%** |

### 11.2 不可妥协的硬约束

1. **质量绝对优先**（LRN-20260717-001）— 不为赶时间砍功能、压体积
2. **开源源码全面分析**（LRN-20260717-002）— terax-ai/ht/ht-mcp/itops/electerm/tabby 已 git clone
3. **不降质减配**（LRN-20260720-001）— 走最佳质量路线
4. **本机资源优先**（user_profile）— 最大化复用现有 91K 行资产
5. **不引入比赛冲刺**（LRN-20260726-003）— AI 开发足够快

---

## 附录 A：可复用源码索引

### A.1 复用率 ≥ 80% 的模块

| 路径 | 来源 | 行数 | 用途 |
|------|------|------|------|
| `opensource-reference/terax-ai/src/styles/tokens.ts` | terax-ai | ~200 | 色板/字号/动效 token |
| `opensource-reference/terax-ai/src/modules/theme/themes/*.ts` | terax-ai | ~5,000 | 15 个主题 |
| `opensource-reference/terax-ai/src/modules/terminal/lib/rendererPool.ts` | terax-ai | ~1,000 | 终端渲染池 |
| `opensource-reference/terax-ai/src/modules/terminal/block/*` | terax-ai | ~3,000 | 终端 block 系统 |
| `opensource-reference/terax-ai/src-tauri/src/modules/pty/*` | terax-ai | ~3,000 | Tauri PTY 范本 |
| `opensource-reference/ht/src/pty.rs` | ht | 380 | 纯 PTY 实现 |
| `opensource-reference/ht/src/session.rs` | ht | 320 | VT100 仿真 |
| `opensource-reference/ht-mcp/src/mcp/tools.rs` | ht-mcp | 130 | MCP tools 定义 |
| `opensource-reference/ht-mcp/src/ht_integration/session_manager.rs` | ht-mcp | 380 | 会话管理 |
| `projects/src/tdsf/core/*` | 自研 | 1,891 | 核心算法 |
| `projects/src/tdsf/graph/*` | 自研 | 1,166 | LangGraph |
| `projects/src/tdsf/storage/*` | 自研 | 1,293 | SQLite + Chroma |
| `tdsf-design-app/src/components/ai-decision/*` | 自研 | 1,200 | AI 可视化组件 |
| `tdsf-design-app/src/components/monitor/*` | 自研 | 600 | 监控可视化 |
| `opensource-reference/electerm/src/client/components/ai/*` | electerm | 2,500 | AI Chat UI |
| `opensource-reference/electerm/src/app/mcp/server/*` | electerm | 700 | MCP server |
| `opensource-reference/itops-agent-platform/backend/src/modules/mcp/services/gateway/*` | itops | 2,500 | MCP gateway + approvalFlow |
| `opensource-reference/tabby/tabby-community-color-schemes/schemes/*` | tabby | 1,000 | 200+ 终端配色 |
| `knowledge/academic/*` | 自研 | 6,125 | 教学知识库 |
| `knowledge/courses/*` | 自研 | 34,380 | 教学课程 |

### A.2 复用率 50–80% 的模块

| 路径 | 来源 | 改造点 |
|------|------|--------|
| `opensource-reference/terax-ai/src/modules/sidebar/*` | terax-ai | 文件树 → SSH+KB |
| `opensource-reference/terax-ai/src/modules/tabs/*` | terax-ai | 保留 + 增 SSH tab |
| `opensource-reference/terax-ai/src/modules/spaces/*` | terax-ai | 项目/服务器分组 |
| `opensource-reference/terax-ai/src-tauri/src/modules/fs/*` | terax-ai | 改用知识库 API |
| `opensource-reference/terax-ai/src-tauri/src/modules/git/*` | terax-ai | 知识库 Git 同步 |
| `opensource-reference/electerm/src/app/server/session-ssh.js` | electerm | 翻译为 Rust russh |
| `opensource-reference/itops-agent-platform/backend/src/modules/ai/services/agents/agentCore.ts` | itops | 翻译为 Python LangGraph |
| `opensource-reference/itops-agent-platform/backend/src/modules/servers/services/sshService/*` | itops | 翻译为 Python |
| `tdsf-linux-desktop/src/core/risk-engine*.ts` | 自研 | 翻译为 Python（已有 v1 融合） |
| `tdsf-linux-redesign/pages/*.html` (20 个) | 自研 | 视觉规范输入给 Trae Design |
| `tdsf-linux-redesign/assets/icons/dl_builtin_trae/*.svg` (100+) | 自研 | 图标直接复用 |

### A.3 复用率 < 50% / 弃用

| 路径 | 原因 |
|------|------|
| `tdsf-linux-desktop/src/main/ipc/*` | Electron IPC 完全弃用 |
| `tdsf-linux-desktop/src/main/windows/*` | Electron 窗口弃用 |
| `tdsf-linux-desktop/src/renderer/*` | 80+ 组件弃用 |
| `opensource-reference/terax-ai/src/modules/updater/*` | 自管发布 |
| `opensource-reference/terax-ai/src/modules/source-control/*` | Git 改用 isomorphic-git |
| `opensource-reference/terax-ai/src-tauri/src/modules/lsp/*` | 暂不需要 |
| `opensource-reference/terax-ai/src-tauri/src/modules/proc/*` | PTY 替代 |
| `opensource-reference/nterm-ng/*` | 架构参考，terax-ai 更优 |
| `opensource-reference/grok-build/*` | Rust 门槛高，仅作架构参考 |
| `opensource-reference/mastra/*` | 体量过大（2M 行），仅查文档 |

---

## 附录 B：Trae Design 交付清单

### B.1 必须交付给 Trae Design 的资产

| 资产 | 路径 | 用途 |
|------|------|------|
| **设计规格文档** | 本文档第六章 | 完整界面规格 |
| **15 个 UI 主题** | `opensource-reference/terax-ai/src/modules/theme/themes/*.ts` | 主题色板 |
| **200+ 终端配色** | `opensource-reference/tabby/tabby-community-color-schemes/schemes/` | 终端 ANSI 配色 |
| **100+ SVG 图标** | `tdsf-linux-redesign/assets/icons/dl_builtin_trae/*.svg` | 应用图标 |
| **20 个 HTML 设计稿** | `tdsf-linux-redesign/pages/*.html` | 视觉规范输入 |
| **设计 Token 文件** | terax-ai `src/styles/tokens.ts` | CSS 变量 → Figma Tokens |
| **AI Panel 组件代码** | `tdsf-design-app/src/components/ai-decision/*` | 已实现的可视化组件 |
| **Monitor 组件代码** | `tdsf-design-app/src/components/monitor/*` | 已实现的监控图表 |
| **AI Chat UI 参考** | `opensource-reference/electerm/src/client/components/ai/*` | AI 对话界面 |
| **主题引擎代码** | `opensource-reference/terax-ai/src/modules/theme/applyTheme.ts` | 主题应用逻辑 |
| **200+ 主题代码** | `tabby/tabby-community-color-schemes/src/colorSchemes.ts` | 主题导入逻辑 |
| **iTerm 主题解析** | `opensource-reference/electerm/src/client/common/iterm-theme.js` | iTerm 兼容 |
| **布局参考** | terax-ai `src/modules/sidebar/` | 三栏布局 |

### B.2 必读文档

1. **本文档第六章** - 界面设计规格（6.1-6.12）+ v3.1 增量（6.13 Project Home / 6.14 垂直 Tab / 6.15 反 AI 味）
2. **terax-ai-设计分析报告.md** - 配色/字体/动效分析
3. **tdsf-design-app 组件代码** - 已实现的可视化组件
4. **terax-ai 应用截图** - 整体视觉参考
5. **[v3.1 增量报告](TDSF-终端Agent-v3.1增量调研报告.md)** - 15 个新增项目 + 9 个新决策

### B.3 v3.1 新增交付资产（Trae Design 必读）

| # | 资产 | 来源 | 用途 |
|---|------|------|------|
| 21 | **Maple Mono 字体三件套** | [Maple-font releases](https://github.com/subframe7536/Maple-font) | 终端+编辑器字体（替代 JetBrains Mono） |
| 22 | **Maple Mono CN 中文字体** | 同上 | 中文等宽显示（解决日志/教程错位） |
| 23 | **BYOA 选择器 UI** | [Orca](https://www.onorca.dev/) + [Synara](https://www.trysynara.com/) | 模型 + Harness 选择面板 |
| 24 | **AI 权限 4 档切换器** | [uniTerm](https://github.com/ys-ll/uniterm) | L0/L1/L2/L3 切换（StatusBar 入口） |
| 25 | **多 Agent 状态点组件** | [Termio](https://www.termio.sh/) + [herdr](https://github.com/ogulcancelik/herdr) | StatusBar Session dot |
| 26 | **Project Home 卡片** | [Vibo](https://github.com/xfey/Vibo) | 项目独立主页 |
| 27 | **垂直 Tab 备选布局** | [cmux](https://cmux.com/zh-CN) | Tab 风格切换（10+ SSH 场景） |
| 28 | **反 AI 味 6 条设计准则** | [hallmark](https://github.com/Nutlope/hallmark) + [impeccable](https://github.com/pbakaus/impeccable) | 设计规范 |
| 29 | **任务看板 M5 视图** | Vibe Kanban | 多任务管理 |
| 30 | **Token 智能压缩规范** | [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | LLM 路由层 |

**v3.0 + v3.1 总交付：30 项资产**

---

## 附录 C：可借鉴设计资产

### C.1 tdsf-design-app 组件级复用（22,875 行）

> **已实现的设计稿组件**，直接 fork 后用 React 19 重写

| 组件 | 路径 | 评级 |
|------|------|------|
| `RiskGauge.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐⭐ |
| `RiskPipeline.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐⭐ |
| `RiskRadar.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐ |
| `ConfidenceRing.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐⭐ |
| `EvidenceTimeline.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐⭐ |
| `DangerCommandList.tsx` | `src/components/ai-decision/` | ⭐⭐⭐⭐ |
| `CpuRingChart.tsx` | `src/components/monitor/` | ⭐⭐⭐⭐ |
| `MemRingChart.tsx` | `src/components/monitor/` | ⭐⭐⭐⭐ |
| `DiskRingChart.tsx` | `src/components/monitor/` | ⭐⭐⭐⭐ |
| `NetworkSparkline.tsx` | `src/components/monitor/` | ⭐⭐⭐⭐ |
| `AppLayout.tsx + ActivityRail.tsx` | `src/layouts/` | ⭐⭐⭐⭐ |

### C.2 tdsf-linux-redesign 设计稿（54,348 行 / 20 HTML + 100+ 图标）

> 视觉规范和图标直接复用

- 20 个 HTML 页面（monitor, workbench-ai, knowledge, tutorial, history, logs, settings-8 个）
- 100+ SVG 图标（`assets/icons/dl_builtin_trae/`）
- 6 个 docs/ 设计规范文档

### C.3 terax-ai 设计范本（terax-ai-设计分析报告.md）

> 配色、字体、动效、布局的完整设计语言

详见 `d:\ai\linux教学一体\terax-ai-设计分析报告.md`（11 章 / 450 行）

---

## 附录 D：记忆交叉引用

- LRN-20260717-001：质量绝对优先
- LRN-20260717-002：开源源码必须下载分析（terax-ai/ht/ht-mcp/itops/electerm/tabby/nterm-ng 已 git clone）
- LRN-20260717-003：检查跳步
- LRN-20260720-001：不降质减配
- LRN-20260726-001：方案书 v1.2（已替代为 v3.0）
- LRN-20260726-002：Rust 技术栈边界决策
- LRN-20260726-003：移除 6 天比赛冲刺约束
- LRN-20260726-004：v2.0 量化基线（已被 v3.0 实测数据修正）
- **本方案书 LRN 标识**：**LRN-20260726-005（v3.0 终稿定稿）**

---

## 附录 E：terax-ai 范本补充要点（Trae Design 必读）

> **本附录目的**：v3.0 §6 已覆盖主题/字体/动效/AI Panel/视图模式 5 大块。
> 本附录补齐 **terax-ai-设计分析报告.md（11 章 450 行）** 中 v3.0 漏掉的 6 个细节要点，确保 Trae Design 拿到完整设计语言。

### E.1 terax-reveal Grid 动画（关键技巧）

```css
/* v3.0 §6.6 缺少的关键实现 —— 纯 CSS 高度展开 */
.terax-reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-premium),
              opacity var(--dur-base) var(--ease-premium);
  opacity: 0;
}
.terax-reveal[data-state="open"] {
  grid-template-rows: 1fr;
  opacity: 1;
}
```

**应用场景**：

- AI Panel 展开/收起（不需 JS 测高度）
- 知识卡/风险卡的内联展开
- 命令输出折叠区域
- 设置项的高级选项隐藏/显示

**优势**：零 JS 依赖，性能极好，跨平台一致。

### E.2 全局隐藏原生滚动条

terax-ai 全局隐藏 xterm / WebView 原生滚动条，统一用 shadcn `<ScrollArea>`：

```css
/* 全部滚动条隐藏 */
* {
  scrollbar-width: none;  /* Firefox */
}
*::-webkit-scrollbar { display: none; }  /* WebKit (WebView2) */
.xterm .xterm-scrollbar { display: none !important; }
```

**TDSF 落地**：在 `desktop/src/styles/globals.css` 全局声明，确保 Windows / macOS / Linux 表现一致。

### E.3 Borderless 窗口细节（Windows）

```json
// tauri.conf.json
{
  "windows": [{
    "decorations": false,    // 关键：去掉系统标题栏
    "transparent": true,     // 配合 12px 圆角
    "shadow": true,
    "width": 1440, "height": 900,
    "minWidth": 1024, "minHeight": 640
  }]
}
```

```css
/* 自绘 12px 圆角 + 1px 边框 + 阴影 */
.app-shell {
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--background);
  /* 让 OS 处理阴影 */
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
```

### E.4 终端细节：光标色 / 选择色变量

v3.0 §6.4 只列了 ANSI 配色，缺少以下细节：

```css
:root {
  /* 终端光标（双层） */
  --terminal-cursor:        var(--primary);      /* 光标主体 */
  --terminal-cursor-accent: var(--background);   /* 光标字符色 */

  /* 文本选择 */
  --terminal-selection:     var(--sidebar-primary);  /* 紫 25% */
}
```

xterm.js 集成时绑定：

```ts
buildTerminalTheme() {
  return {
    cursor:         readVar('--terminal-cursor'),
    cursorAccent:   readVar('--terminal-cursor-accent'),
    selectionBackground: readVar('--terminal-selection'),
    // ...ANSI
  };
}
```

### E.5 自定义背景图（背景透明 + 模糊）

```css
.app-bg {
  background: var(--background) url('/bg.jpg') center / cover;
  /* 滑块控制 */
  --bg-opacity: 0.15;   /* 0 = 不混, 1 = 完全覆盖 */
  --bg-blur:    8px;    /* 高斯模糊 */
}
.app-bg::before {
  content: '';
  position: absolute; inset: 0;
  background: var(--background);
  opacity: var(--bg-opacity);
  backdrop-filter: blur(var(--bg-blur));
  z-index: -1;
}
```

**设置项**：

- `Settings > Appearance > Background > Image` 选择图片
- 两个滑块：Opacity / Blur
- 图片解码一次缓存在 `bgImageStore.ts`

**TDSF 决策**：v1 不启用，避免干扰演示；v2 评估。

### E.6 主题导入/导出（iTerm 兼容）

v3.0 §7.1 `theme_import_iterm` 已定义，本附录补实现细节：

```ts
// 解析 iTerm .itermcolors (plist XML 格式)
function parseItermColors(file: Buffer): Theme {
  const plist = plist.parse(file);
  return {
    id: nanoid(),
    name: plist.name || 'Imported',
    variants: {
      dark: {
        colors: {
          background: plist.BackgroundColor?.Red,
          foreground: plist.ForegroundColor?.Red,
          // 16 个 ANSI 色
        },
        terminal: {
          black: plist.Ansi_0_Color?.Red,
          red:   plist.Ansi_1_Color?.Red,
          // ...
        }
      }
    }
  };
}
```

**导出**：当前主题 → iTerm .itermcolors 格式 → 文件下载。

**复用源**：`opensource-reference/electerm/src/client/common/iterm-theme.js`（800 行）。

### E.7 Reduced Motion 支持

v3.0 §6.6 Motion Tokens 缺一个关键点：**无障碍支持**。

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0.01ms;
    --dur-base: 0.01ms;
    --dur-slow: 0.01ms;
  }
  .terax-reveal { transition: none; }
  .terax-shimmer { animation: none; }
}
```

**意义**：对前庭功能敏感用户（晕动症、ADHD）友好，符合 WCAG 2.3.3。

### E.8 AI Panel 流式 Markdown 渲染（react-markdown 选型）

```tsx
import Markdown from 'react-markdown';
import { CodeBlock } from '@/components/CodeBlock';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

<Markdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
  components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  }}
>
  {chunk}  {/* SSE 流式片段 */}
</Markdown>
```

**配合 terax-shimmer**：

```css
.ai-typing {
  background: linear-gradient(90deg,
    var(--muted) 0%, var(--muted-foreground) 50%, var(--muted) 100%);
  background-size: 200% 100%;
  animation: terax-shimmer 2s linear infinite;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

### E.9 Trae Design 接包清单（一页纸）

| # | 必须交付的资产 | 来源 | 用途 |
|---|----------------|------|------|
| 1 | **整体布局 ASCII 草图** | v3.0 §6.1 | 框架图 |
| 2 | **三栏尺寸规范** | v3.0 §6.2 | 像素精度 |
| 3 | **215 主题清单** | v3.0 §6.3 | 主题色板 |
| 4 | **终端 ANSI 16 色** | v3.0 §6.4 | 终端配色 |
| 5 | **字体 + 字号体系** | v3.0 §6.5 | 排版规范 |
| 6 | **Motion Tokens** | v3.0 §6.6 + 附录 E.7 | 动效 |
| 7 | **圆角 + 间距** | v3.0 §6.7 | 视觉密度 |
| 8 | **AI Panel 内部布局** | v3.0 §6.8 | 侧栏设计 |
| 9 | **Sidebar 活动栏** | v3.0 §6.9 | 左侧图标 |
| 10 | **3 种交互流程** | v3.0 §6.10 | 用户旅程 |
| 11 | **3 种视图模式** | v3.0 §6.11 | 切换逻辑 |
| 12 | **13 个快捷键** | v3.0 §6.12 | 键位 |
| 13 | **terax-reveal 动画** | 附录 E.1 | 关键技巧 |
| 14 | **隐藏滚动条规范** | 附录 E.2 | 跨平台一致 |
| 15 | **Borderless 窗口** | 附录 E.3 | Windows 壳 |
| 16 | **终端光标/选择色** | 附录 E.4 | 细节 |
| 17 | **背景图系统** | 附录 E.5 | v2 评估 |
| 18 | **iTerm 主题导入** | 附录 E.6 | 兼容性 |
| 19 | **Reduced Motion** | 附录 E.7 | 无障碍 |
| 20 | **流式 MD 渲染** | 附录 E.8 | AI 输出 |

### E.10 设计稿交付格式约定

```
tdsf-terminal-agent-design/
├── 00-design-brief.md                # 本附录 + v3.0 §6
├── 01-layouts/
│   ├── split-default.png            # 分屏默认
│   ├── split-default@2x.png
│   ├── fullscreen-terminal.png
│   ├── fullscreen-ai.png
│   └── ascii-sketches.txt           # ASCII 草图（与 PNG 配套）
├── 02-themes/
│   ├── 15-ui-themes/                # terax-ai 15 主题
│   └── 200-terminal-schemes/        # tabby 200+ 配色
├── 03-components/
│   ├── ai-panel/                    # 复用 tdsf-design-app
│   ├── risk-card/
│   ├── knowledge-card/
│   ├── skill-card/
│   └── monitor/                     # 复用 tdsf-design-app
├── 04-icons/
│   ├── dl_builtin_trae/             # 100+ SVG
│   └── lucide/                      # 补充图标
├── 05-typography/
│   ├── Inter-Variable.zip
│   ├── JetBrainsMono.zip
│   └── NotoSansSC.zip
├── 06-motion/
│   ├── motion-tokens.json
│   └── terax-reveal-demo.html
└── 07-tokens/
    ├── design-tokens.json           # W3C DTCG
    ├── tailwind-v4-theme.css
    └── shadcn-css-vars.css
```

---

> **文档结束** · 共 11 章 / 5 附录（新增 E）· 数据基线 11,226,832 行实测 / 27 个开源项目 / 4 份核心报告
> 复用总行数 91,425 · 新增代码 ~10,000 · AI 单人 1-2 周可完成
> **Trae Design 接包**：附录 B + 附录 E（共 20 项必交付）

---

# v3.2.1 增量补丁（2026-07-26）

> **本补丁不替代原 11 章内容**，仅在原方案书基础上追加 13 项新决策、5 大行业共识、6 个新项目调研。
> 完整增量报告见 [TDSF-终端Agent-v3.2增量调研报告.md](TDSF-终端Agent-v3.2增量调研报告.md) 第十一章节。
> 适用版本：v3.0 → v3.2.1（增量命名约定：v3.X.Y 中 Y 表示同版本调研深化）

## 附录 F：v3.2.1 新增 13 项决策（详细见 v3.2 报告 §11.8）

| 决策编号 | 名称 | 借鉴来源 | 复用价值 | 落地阶段 |
|---------|------|---------|---------|---------|
| DEC-V321-01 | 三模式 + 四档融合权限 | CodeWhale | 极高 | P0 |
| DEC-V321-02 | side-git 工作区回滚 | CodeWhale | 高 | P2 |
| DEC-V321-03 | RLM 风格并行子任务 | CodeWhale | 中 | P4 |
| DEC-V321-04 | 1M Token 上下文兼容 | CodeWhale | 中 | P5 |
| DEC-V321-05 | 单写入器 Project Service | aimux-cli | 极高 | P0-P1 |
| DEC-V321-06 | AIMUX.md 模式 → TDSF.md | aimux-cli | 高 | P1 |
| DEC-V321-07 | needs-you 协调收件箱 | aimux-cli | 高 | P1 |
| DEC-V321-08 | mood ring 7 状态 | friday-code | 极高 | P0 |
| DEC-V321-09 | /steer 中途转向 | friday-code | 中 | P4 |
| DEC-V321-10 | OS 级沙箱 | Zagens | 高 | P1/P3 |
| DEC-V321-11 | Fix-loop 强制停手 | Zagens | 中 | P0 |
| DEC-V321-12 | 预置 18 领域 Skills | claude-skills 库 | 极高 | P1-P4 |
| DEC-V321-13 | SKILL.md 标准格式 | claude-skills 库 | 极高 | P0 |

## 附录 G：v3.2.1 新增 6 项目分析（详细见 v3.2 报告 §11.2-11.7）

| 项目 | GitHub | 核心定位 | Stars | 协议 |
|------|--------|---------|------:|------|
| **CodeWhale**（原 deepseek-tui） | Hmbown/CodeWhale | Rust 单二进制终端 Agent | 23K+ | MIT |
| **aimux-cli** | TraderSamwise/aimux | tmux 后端 AI Agent 多路复用器 | 新发布 | MIT |
| **friday-code** | katipally/friday-code | 自包含二进制 CLI Agent | 新发布 | MIT |
| **Antigravity** | Google | Agent-first IDE 平台 | - | 闭源 |
| **Zagens** | didclawapp-ai/zagens | Tauri 2 + OS 级沙箱 | 新发布 | MIT |
| **claude-skills 库** | alirezarezvani/claude-skills | 跨平台 Skill marketplace | 5.2K | MIT |

## 附录 H：v3.2.1 五大行业共识（**重要决策依据**）

1. **Shift+Tab 三模式（plan/agent/yolo）= 行业标准**
   - 验证：CodeWhale + friday-code + Claude Code 共识
   - TDSF 行动：直接采用，与 v3.1 4 档权限融合（4 档 × 3 模式 = 12 组合）

2. **mood ring 7 状态可视化 = 优秀 UX 必选项**
   - 验证：friday-code 远处一眼看到状态
   - TDSF 行动：StatusBar 中央放置 7 状态 mood ring（DEC-V321-08）

3. **side-git / workspace snapshot = 主流工作区回滚方案**
   - 验证：CodeWhale 影子 git 仓库
   - TDSF 行动：P2 阶段实现 ~/.tdsf/side-git/<project-hash>/ 影子仓库（DEC-V321-02）

4. **SKILL.md = 事实标准**
   - 验证：Anthropic 官方 + claude-skills 库 + skills.sh marketplace（20,300+ skills, 8,700+ MCP servers）
   - TDSF 行动：完全兼容 SKILL.md，零迁移成本（DEC-V321-13）

5. **单写入器控制平面 + 多客户端 = 企业级架构**
   - 验证：aimux-cli（HTTP/SSE）+ cmux（JSON-lines）共识
   - TDSF 行动：Tauri 2 Rust 后端 = Project Service 单一写入器（DEC-V321-05）

## 附录 I：v3.2.1 量化数据更新

| 维度 | v3.0 | v3.2 | v3.2.1 | 累计增量 |
|------|-----:|-----:|------:|--------:|
| 已分析开源项目数 | 27 | 50 | **56** | +29 |
| 已下载源码行数 | 11,226,832 | 24,964,802 | **25,014,802** | +123% |
| 新增决策数 | 0 | 9 | **22** | +22 |
| 预置 Skills 数 | 0 | 0 | **354+ 候选** | 借鉴 claude-skills 库 |
| 状态指示器 | 4 状态 | 4 状态 | **7 状态** | friday-code mood ring |
| 权限模式 | 4 档 | 4 档 | **4 档 × 3 mode** | CodeWhale 融合 |
| 沙箱层级 | 3 | 3 | **4** | 加 OS 级（Zagens） |
| Skill marketplace 集成 | 0 | 0 | **1**（skills.sh 协议） | claude-skills 库 |

## 附录 J：v3.2.1 与原方案书章节映射

| 原章节 | v3.2.1 增量 | 增量依据 |
|--------|------------|---------|
| §1 项目定位 | 无变化 | 定位已准确（运维 + 终端 Agent） |
| §2 资产盘点 | +1 项目（CodeWhale） | 跨项目共性分析 |
| §3 决策映射 | +6 决策（V321-04/05/10/11/12/13） | 沙箱 + Skills + Project Service |
| §4 总体架构 | +1 模块（side-git 模块） | DEC-V321-02 |
| §5 技术栈 | +1 字体规格（Maple Mono NF）、+1 协议（SKILL.md） | Maple-font + claude-skills |
| §6 界面设计 | +mood ring 7 状态组件 | DEC-V321-08 |
| §7 接口定义 | +13 个 MCP tools（tdsf_steer / tdsf_side_git / tdsf_needs_you 等） | DEC-V321 全套 |
| §8 项目结构 | +skills/ + side-git/ 目录 | DEC-V321-12/02 |
| §9 实施路线 | P0 新增 mood ring + 3 mode 切换 | DEC-V321-01/08 |
| §10 风险矩阵 | +OS 级沙箱风险 + Fix-loop 风险 | DEC-V321-10/11 |
| §11 量化收益 | 复用率 53% → **65%（含 6 项目）** | 增量价值 |

## 附录 K：v3.2.1 待跟进事项

1. ⏳ **Trae Design 增量任务**：在 v3.1 30 项基础上 + 2 项（mood ring 7 状态组件、SKILL.md 解析器 UI）
2. ⏳ **MCP Tools 增量**：13 个新工具（tdsf_steer / tdsf_side_git / tdsf_needs_you 等）
3. ⏳ **项目结构增量**：新建 `tdsf/skills/` 和 `tdsf/side_git/` 目录
4. ⏳ **Rust 端增量**：side-git 影子仓库管理 + mood ring 渲染 + 3 模式切换事件
5. ⏳ **Python 端增量**：Skills 注册表 + needs-you 协调服务 + SKILL.md 解析器
6. ⏳ **门禁验证**：编译 / lint / test 5 绿（v3.2.1 决策落地后回填）
7. ⏳ **commit 提交**：v3.2 调研报告 v3.2.1 章节 + 方案书 v3.2.1 附录
8. ⏳ **memory 持久化**：项目记忆 + 当日 topics 更新

---

> **v3.2.1 补丁完成** · 2026-07-26
> 在 v3.0 11 章 / 5 附录基础上追加 5 附录（F-K）
> 累计 56 个开源项目 · 25,014,802 行实测代码 · 22 项决策 · 65% 复用率
> 下次更新：v3.3（实施后实测数据回填 + P0-P3 门禁验证结果）
