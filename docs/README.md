# docs/ 文档索引

本目录存放 TDSF Terminal Agent 的长文档（记忆 / 架构 / 方案 / 报告 / 日志）。

> **开发规范唯一入口是根目录 [`CLAUDE.md`](../CLAUDE.md)**（取代上游 terax 的 `TERAX.md`）。
> 本目录文档是对特定领域的展开；与 `CLAUDE.md` 冲突时以 `CLAUDE.md` 为准。

---

## 核心记忆文档（接手必读，勿移动——被 AGENTS.md/CLAUDE.md 引用）

| 文档 | 内容 |
|------|------|
| [dev-state.md](dev-state.md) | ⭐ 唯一进度记忆源：当前状态 + 已知问题 + §37.x 交接章 |
| [ROADMAP.md](ROADMAP.md) | ⭐ 规划唯一准绳：短/长期路线 + 任务清单 + 待决策项 |
| [DEV-JOURNAL.md](DEV-JOURNAL.md) | ⭐ 经验沉淀：每次任务收尾追加（任务/方案/报错根因/复盘） |
| [方案书-v2.0.md](方案书-v2.0.md) | 开发方案书最终版（里程碑 M0-M4 + 专项设计） |
| [MULTI-AGENT-WORKFLOW.md](MULTI-AGENT-WORKFLOW.md) | 多 agent 协作规范（A/B/C 场景 + 文件锁矩阵 + 接手声明模板） |
| [CODE-REVIEW-LESSONS.md](CODE-REVIEW-LESSONS.md) | AI 代码质量红线 + 血泪案例速查 |
| [KNOWLEDGE-INDEX.md](KNOWLEDGE-INDEX.md) | 知识库索引 |
| [HANDOVER.md](HANDOVER.md) | 交接文档 |
| [OPEN-SOURCE-AND-MODIFICATIONS.md](OPEN-SOURCE-AND-MODIFICATIONS.md) | 上游 Apache-2.0 义务 + 本项目原创贡献 |

## 专题方案（近期）

- [教学模式工具终端化方案-2026-09-04.md](教学模式工具终端化方案-2026-09-04.md) — 教学模式工具调用终端化 + 步步确认（交接方案）
- [agent架构优化建议-开源借鉴-2026-09-03.md](agent架构优化建议-开源借鉴-2026-09-03.md) — 开源 agent 架构调研 + P0-P3 优化路线
- [B4-B5-安全可见执行与服务器实测清单.md](B4-B5-安全可见执行与服务器实测清单.md) — 安全可见执行重构方案 + 服务器实测清单

## 架构指南（architecture/）

- [two-process-model.md](architecture/two-process-model.md) — 双进程模型 + IPC 命令参考
- [pty-shell-integration.md](architecture/pty-shell-integration.md) — PTY / OSC 7·133 / ConPTY / WSL
- [security-model.md](architecture/security-model.md) — 安全模型（denylist / SSRF / 工作区授权 / AI 工具审批）
- [ai-subsystem.md](architecture/ai-subsystem.md) — AI 子系统（⚠️ 部分为上游 terax 旧路径；现役链路见 dev-state §37.106）

## 子目录概览

| 目录 | 内容 |
|------|------|
| `architecture/` | 架构指南（双进程/PTY/安全/AI 子系统） |
| `reports/` | 调研 / 审计 / 规划报告（76 篇） |
| `agent/` | agent 相关设计文档（75 篇） |
| `决赛/` | 火山杯决赛素材（架构图 HTML/PNG + 讲述文稿） |
| `方案/` | 产品 / 开发方案 |
| `guide/` `教程/` | 使用指南 / 教学教程 |
| `api/` | API 文档 |
| `合规/` | 合规文档 |
| `contributing/` | 贡献指南（[testing.md](contributing/testing.md) 等） |
| `archive/` | 归档（旧版方案书 v1.0/v1.1 等过时文档） |

---

> 上游 terax 的英文 contributor 文档已随魔改调整为中文索引；原 `TERAX.md` 架构真源已由根目录 `CLAUDE.md` 取代。
