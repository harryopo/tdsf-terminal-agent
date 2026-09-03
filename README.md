# TDSF Terminal Agent

> AI 原生的 Linux 运维教学终端 —— 一个会"动手"的 AI 助手：四档信任模式，命令像真人一样打字机敲进终端，思考/置信度/证据全程可见。

基于 [crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6 深度魔改（Tauri 2 + React 19 + Python Strands AI 引擎）。

---

## 这是什么

TDSF Terminal Agent 是一个**终端优先**的桌面 IDE，把 AI Agent 深度集成进 Linux 运维工作流。它不只是聊天机器人——能真正在你的服务器（本地 / SSH / WSL）上执行命令、读写文件、诊断网络，而且**像真人一样逐字敲进终端**，让每一步都看得见。面向 Linux 运维教学，内置四档信任模式、知识库 RAG、安全护栏。

## 核心特性

- 🤖 **AI Agent（Strands 引擎）**：感知 → 思考 → 行动 → 验证 → 记忆 五步闭环，23 个运维工具
- 🎚️ **四档信任模式**：一个滑杆决定 AI 能动手到什么程度（观察 / 确认 / 自动 / 教学）
- ⌨️ **打字机执行**：命令用 Weibull 分布逐字敲进终端（移植自 expect `send -h`），人味节奏 + 随时按键接管
- 📚 **知识库 RAG**：内置 Linux 运维文档，FTS5 关键词 + 向量语义混合检索
- 🔒 **安全护栏**：影响预测（命令风险分级 L0-L4）+ denylist 硬底线 + HITL 人工审批 + 50 次工具熔断
- 🎓 **教学模式**：只读 + 6 板块结构化讲解（概念/原理/示例/易错点/练习），专为课堂设计
- 🖥️ **终端优先**：本地 PTY / SSH / WSL + 远程文件资源管理器 + CodeMirror 编辑器 + 离线选词翻译

## 技术栈

| 层 | 选型 |
|----|------|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | React 19 + TypeScript 5 + Vite 6 + Tailwind v4 + zustand v5 |
| 终端 | xterm.js 6（WebGL 渲染） |
| AI 引擎 | Python sidecar（Strands AI 框架 + DeepSeek/智谱/Kimi 等） |
| SSH / PTY | Rust russh 0.61 + portable-pty 0.9 |

## 快速开始

**环境要求**：Node.js ≥ 20、pnpm ≥ 9、Rust stable、Python ≥ 3.12（sidecar）

```bash
pnpm install                 # 安装前端依赖
# sidecar Python 依赖见 src-tauri/sidecar/（venv）
pnpm tauri:dev               # 启动桌面应用（首次编译 2-5 分钟）
```

Windows 用户可直接双击 **`启动.bat`**（或 `启动-日志版.bat`，日志写入 `.tdsf-data/dev-run.log`）。

开发服务器端口 **9300**（Vite strictPort）。

## 四档信任模式

| 档位 | 名字 | 能做什么 | 适合谁 |
|------|------|---------|--------|
| T4 | 教学 | 只读 + 6 板块结构化讲解 | 学生跟学 |
| T3 | 观察 | 只读分析（写操作物理隔离） | 生产巡检 |
| T2 | **确认**（默认） | 全量工具，写操作逐条审批 | 日常运维（人在回路） |
| T1 | 自动 | 低危自动放行，L3/L4 高危仍确认 | 可信沙箱 |

## 架构（三层）

```
React 19 前端（AI 对话窗 / 终端 / 模式切换）
   ↓ Tauri invoke / event
Rust 壳（转发 / PTY / SSH / 打字机引擎 human_type）
   ↓ JSON-RPC (stdio)
Python sidecar（Strands Agent / 工具调度 / 审批 / 知识检索 / 记忆）
```

## 项目文档

| 文档 | 内容 |
|------|------|
| [`CLAUDE.md`](CLAUDE.md) | 开发规范总纲：项目身份 + 架构地图 + 防污染红线 + 五绿门禁 + 诊断方法论 |
| [`AGENTS.md`](AGENTS.md) | AI 接手入口（必读清单 + 收尾三件事） |
| [`docs/dev-state.md`](docs/dev-state.md) | 当前状态 + 已知问题 + §37.x 交接章（唯一进度记忆源） |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 短/长期规划 + 任务清单 |
| [`docs/DEV-JOURNAL.md`](docs/DEV-JOURNAL.md) | 开发日志（经验沉淀：任务/方案/报错/复盘） |
| [`docs/方案书-v2.0.md`](docs/方案书-v2.0.md) | 开发方案书最终版（里程碑 M0-M4） |
| [`docs/MULTI-AGENT-WORKFLOW.md`](docs/MULTI-AGENT-WORKFLOW.md) | 多 agent 协作规范 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南 + 项目布局 |

## 开发规范（摘要）

- **五绿门禁**（完成的唯一标准）：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build:web` / `pnpm tauri:dev` 桌面实测
- **任务收尾三件事**：① git commit（全绿）② DEV-JOURNAL 追加复盘 ③ 更新 ROADMAP + dev-state
- **防污染红线**：详见 [`CLAUDE.md`](CLAUDE.md) §3（0字节文件=污染信号 / 禁 git checkout 回退 / 依赖只用 pnpm add / useEffect 自反循环 …）

## 许可与上游

- 本项目原创贡献：Apache-2.0（详见 [`LICENSE`](LICENSE) 与 [`docs/OPEN-SOURCE-AND-MODIFICATIONS.md`](docs/OPEN-SOURCE-AND-MODIFICATIONS.md)）
- 上游：[crynta/terax-ai](https://github.com/crynta/terax-ai)（Apache-2.0）
