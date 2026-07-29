# TDSF 超级运维 Agent — 开源调研全景总结

> 生成时间：2026-07-28
> 用途：供所有 AI 对话接手时阅读，了解调研全貌、整合蓝图、开发检验结果
> 数据来源：v3.1~v3.7 增量调研报告（11 份）+ P2 技术调研 + 转型可行性报告

---

## 一、调研规模总览

| 维度 | 数据 |
|------|------|
| **累计调研开源项目** | **79 个**（v3.7 终版） |
| **累计代码参考量** | **~28M 行** |
| **提炼决策点** | **88 个**（D-V33-01 ~ D-V37-20） |
| **行业新共识** | **21 项** |
| **直接复用/借鉴项目** | **18 个**（P7 部署清单） |
| **已 clone 到本地** | **40+ 个**（`opensource-reference/` 目录） |
| **调研报告** | **11 份**（v3.1~v3.7 增量 + P2 技术调研 + 转型可行性） |

---

## 二、开源项目分层矩阵

### 第一层：5 大基座项目（直接 fork + 改造）

| 项目 | 协议 | 行数 | 复用率 | TDSF 集成位置 |
|------|------|-----:|-------:|---------------|
| **terax-ai** | Apache-2.0 | 94.8K | 80% | 主题引擎 + 终端 + CSS 变量系统 |
| **CodeWhale** | MIT | 23K+ | 75% | side-git 影子仓库 + RLM 回顾 |
| **aimux-cli** | MIT | — | 85% | Project Service 单写入器 |
| **Zagens** | MIT | — | 70% | OS 级沙箱（Restricted Token） |
| **claude-skills** | MIT | 5.2K | 90% | SKILL.md 标准 + 70+ Skills |

### 第二层：8 个架构借鉴项目

| 项目 | 核心借鉴 |
|------|----------|
| **opensquilla** | SquillaRouter 4 档模型路由 + 微内核 |
| **Maple-font** | 中英等宽终端字体（OFL-1.1） |
| **cmux** | JSON-lines 控制协议（AGPL 仅参考） |
| **synara** | BYOA 5 适配器 + handoff 交接 |
| **BitFun** | 5 形态 Agent 分层架构 |
| **Vibo** | "terminal as center" 哲学 |
| **orca** | 多 Agent 并行 + worktree 隔离 |
| **herdr** | 多 Agent 状态总览 |

### 第三层：v3.3~v3.7 深度调研（79 项目核心）

| 版本 | 新增项目 | 核心决策点 |
|------|----------|-----------|
| **v3.3** | Kimi Code / Qoder CLI / Codex CLI / Headroom / Kilo Code / Claw Code | D-V33-01~09：多模式前端、Wire 事件协议、TdsfFs、CCR 可逆压缩 |
| **v3.4** | Aider / Cline / OpenCode / Goose / Qwen Code / OpenHands | D-V34-01~12：LSP 集成、Client/Server 架构、Quest 委派 |
| **v3.5** | Mastra / Superpowers / MetaGPT / 二次调研 | D-V35-01~16：CCR 可逆压缩、suspend/resume、tdsf doctor |
| **v3.6** | Kimi Code / Crush / Qwen Code / DeepSeek TUI | D-V36-01~18：TdsfFs 抽象层、Wire 事件、Subagent Registry |
| **v3.7** | OpenHarness / claw-code / cube-shell | D-V37-01~20：4 类 Hook、10+ Channel、MCP 11 阶段、9 crate |

---

## 三、21 项行业新共识

| # | 共识 | 验证来源 |
|---|------|---------|
| 1 | Shift+Tab 三模式 = 行业标准 | Kimi / Qoder / Codex |
| 2 | mood ring 状态可视化 = 优秀 UX 必选 | friday-code / Qoder / Codex |
| 3 | side-git / workspace snapshot = 主流回滚 | CodeWhale / Qoder / Codex |
| 4 | SKILL.md = 事实标准 | Kimi / Qoder / Codex |
| 5 | 单写入器控制平面 = 企业级 | aimux-cli / cmux / Qoder |
| 6 | **可逆上下文压缩（CCR）= 长会话必选** | Headroom + Kimi |
| 7 | **OS 级沙箱 = 安全底线** | Codex + Zagens + Kimi |
| 8 | **多模式前端（TUI/Print/ACP/IDE）= 全场景** | Kimi 4 + Codex 2 |
| 9 | **环境变量统一前缀 = 工程最佳实践** | QODER_*/KIMI_*/CODEX_* |
| 10 | **AGENTS.md 自动发现 = 项目记忆标准** | Kimi + Qoder /init |
| 11 | **LSP 集成 = 大幅降低 LLM 幻觉** | OpenCode 验证 |
| 12 | **Client/Server 架构 = 终端 Agent 标配** | OpenCode/Qoder/Cline |
| 13 | **可逆压缩 = 上下文管理圣杯** | Headroom CCR |
| 14 | **HITL Suspend/Resume = 运维 Agent 标配** | Mastra + Superpowers |
| 15 | **Plugin Marketplace = Skill 生态护城河** | Superpowers |
| 16 | **FS 抽象层 = AI Agent 必须设计** | Kimi KAOS |
| 17 | **Wire 事件协议 = 多端 UI 共享** | Kimi 4 consumer |
| 18 | **Subagent Registry = 持久化复用** | Kimi LaborMarket |
| 19 | **Hook 引擎必须 4 类组合** | OpenHarness + claw-code |
| 20 | **MCP 生命周期必须 11 阶段精细化** | claw-code |
| 21 | **Mock Parity Harness = Agent 框架必备** | claw-code 12 场景 |

---

## 四、两个项目目录的定位与关系

| 维度 | `tdsf-terminal-agent/`（主项目） | `tdsf-terminal-agent-clone/`（clone 项目） |
|------|------|------|
| **定位** | 全量自研 MVP（v4.0.0） | terax-ai 视觉魔改路线 |
| **状态** | P0-P7 全部 83 任务完成，1575 测试零失败 | P1-C 端到端验证完成 |
| **技术栈** | Tauri 2 + React 19 + Python Sidecar | terax-ai fork + 自研模块移植 |
| **策略** | 从零搭建，复用算法层 | 复用 terax-ai UI，移植自研模块 |
| **优势** | 完全自主可控 | UI 质量高（8.9MB portable） |
| **问题** | UI 与设计稿偏离 | PowerShell 注入/端口/Tailwind v4 兼容 |

---

## 五、超级运维 Agent 整合蓝图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    TDSF Super OpsAgent v5.0                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Layer 5 · 多端 UI（4 模式前端，共识 #8）                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │ TUI 模式  │ │ IDE 模式  │ │ Web 模式  │ │ ACP 模式  │             │
│  │(终端原生) │ │(Tauri 2) │ │(React)   │ │(API)     │             │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘             │
│       ▲            ▲            ▲            ▲                     │
│  ─────┴────────────┴────────────┴────────────┴─────────────────   │
│  Wire 事件协议（D-V36-02，共识 #17）                                │
│  ──────────────────────────────────────────────────────────────── │
│                                                                     │
│  Layer 4 · 4 类 Hook 引擎（D-V37-01，共识 #19）                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │Command   │ │Http      │ │Prompt    │ │Agent     │             │
│  │Hook      │ │Hook      │ │Hook      │ │Hook      │             │
│  │(shell)   │ │(webhook) │ │(LLM)     │ │(递归)    │             │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘             │
│                                                                     │
│  Layer 3 · 10+ Channel 适配器（D-V37-02）                           │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐         │
│  │飞书    │ │钉钉    │ │企微    │ │微信    │ │Telegram│         │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘         │
│                                                                     │
│  Layer 2 · Agent 核心引擎                                           │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  PAOR 监督循环 + 14 步 Task Protocol                      │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │     │
│  │  │RiskEngine│ │Credibilit│ │Knowledge │ │Skill     │   │     │
│  │  │4 层管道  │ │y D-S+PCR5│ │FTS5+向量 │ │SKILL.md  │   │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │     │
│  │  │SquillaRou│ │LongContex│ │KEPA 自我 │ │Auto-Dream│   │     │
│  │  │ter 4 档  │ │t 1M Token│ │进化      │ │离线整合  │   │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                     │
│  Layer 1 · 安全沙箱 + 文件系统抽象                                  │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  OS 级沙箱（D-V33-07，共识 #7）                           │     │
│  │  Docker → Firecracker microVM → WASM（v1.0→v1.5→v2.0）   │     │
│  │  TdsfFs 抽象层（D-V36-01，共识 #16）                      │     │
│  │  local / ssh / acp 透明切换                               │     │
│  │  MCP 11 阶段生命周期（D-V37-11，共识 #20）                 │     │
│  └──────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 六、clone 项目开发检验

clone 项目走的是 **terax-ai 魔改路线**，当前状态 P1-C 端到端验证通过。

| 检验项 | 状态 | 评价 |
|--------|------|------|
| terax-ai UI 复用 | ✅ 可行 | 8.9MB portable，UI 质量远超自研 |
| PowerShell 注入问题 | ⚠️ 已发现 | electerm 搬运的 shell-integration 未做平台分流 |
| Tailwind v4 工具类丢失 | ⚠️ 已发现 | `@theme inline` 覆盖默认主题 |
| 端口冲突 | ✅ 已解决 | 改用 9200 避开 Windows 保留段 |
| Python Sidecar 移植 | ⏳ 未完成 | 需要把 RiskEngine/Confidence 引擎接入 |
| SSH 自动登录 | ✅ 已修复 | 提升到 App.tsx 顶层 |
| Skill executor 上下文 | ⚠️ 待修复 | shell executor 在 Windows 本地执行 Linux 命令失败 |

### clone 项目待解决问题

1. **Shell 集成平台分流**：bash vs PowerShell 需要条件判断
2. **Skill executor 执行上下文**：SSH 会话 vs 本地 OS 需要明确
3. **Python Sidecar 完整移植**：RiskEngine + LangGraph 需要接入

---

## 七、下一步建议

### 比赛交付冲刺（7/30 截止）

- **主项目**：录屏材料 + 真实数据校验 + README 打磨
- **clone 项目**：修复 Skill executor + 完成 Sidecar 移植

### 超级运维 Agent 整合（赛后）

- 优先实现 12 项 P0 决策（D-V37 系列）
- 4 类 Hook 引擎 + Channel 抽象层 + MCP 11 阶段
- TdsfFs 文件系统抽象 + Wire 事件协议

### 开源项目深度复用

- **OpenHarness** 的 43+ 工具集可直接用于运维场景
- **claw-code** 的 Mock Parity Harness 用于离线 CI
- **cube-shell** 的 5 Backend 抽象用于 SSH/RDP 统一管理

---

## 八、关键调研报告索引

| 报告 | 路径 | 核心内容 |
|------|------|----------|
| v3.7 增量调研 | `reports/TDSF-终端Agent-v3.7增量调研报告.md` | 79 项目 + 88 决策 + 21 共识 |
| v3.6 增量调研 | `reports/TDSF-终端Agent-v3.6增量调研报告.md` | Kimi/Crush/Qwen/DeepSeek TUI |
| v3.5 增量调研 | `reports/TDSF-终端Agent-v3.5增量调研报告.md` | Mastra/Superpowers/MetaGPT |
| v3.4 增量调研 | `reports/TDSF-终端Agent-v3.4增量调研报告.md` | Aider/Cline/OpenCode/Goose |
| v3.3 增量调研 | `reports/TDSF-终端Agent-v3.3增量调研报告.md` | Kimi Code/Qoder/Codex/Headroom |
| P2 SSH 技术调研 | `reports/P2-SSH技术调研报告.md` | SSH 协议 + 密钥管理 + 跳板机 |
| P2 Docker 沙箱调研 | `reports/P2-Docker沙箱技术调研报告.md` | Docker/Firecracker/WASM 沙箱 |
| P7 开源模板部署清单 | `reports/P7-18开源模板部署清单.md` | 18 个直接复用项目 |
| 转型可行性报告 | `reports/TDSF-终端Agent-转型可行性报告.md` | 从 SSH 终端到 IDE Agent 转型分析 |
| 方向方案书整合版 | `reports/TDSF-终端Agent方向方案书-整合版.md` | v3.0 终稿 11 章 + 5 附录 |
| 技术方案书 v3.0 | `reports/TDSF-终端Agent技术方案书-v3.0.md` | 完整技术方案 |

---

## 九、决策点快速索引

### D-V37 系列（最新，P0 优先）

| ID | 决策 | 来源项目 |
|----|------|---------|
| D-V37-01 | 4 类 Hook 引擎（Command/Http/Prompt/Agent） | OpenHarness + claw-code |
| D-V37-02 | 10+ Channel 适配器（飞书/钉钉/企微/微信/Telegram） | cube-shell |
| D-V37-11 | MCP 11 阶段生命周期 | claw-code |
| D-V37-15 | 9 crate Rust 架构 | cube-shell |

### D-V36 系列

| ID | 决策 | 来源项目 |
|----|------|---------|
| D-V36-01 | TdsfFs 文件系统抽象层 | Kimi KAOS |
| D-V36-02 | Wire 事件协议 | Kimi 4 |
| D-V36-18 | Subagent Registry 持久化 | Kimi LaborMarket |

### D-V35 系列

| ID | 决策 | 来源项目 |
|----|------|---------|
| D-V35-01 | CCR 可逆上下文压缩 | Headroom |
| D-V35-14 | HITL Suspend/Resume | Mastra + Superpowers |
| D-V35-15 | Plugin Marketplace | Superpowers |

---

*本报告由 AI 调研整理，供所有对话接手时阅读。详细决策点请查阅对应的增量调研报告。*
