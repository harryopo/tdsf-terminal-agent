# TDSF Terminal Agent 使用手册

> **版本**：v4.0 · **更新日期**：2026-07-29  
> **项目定位**：终端优先的 Linux 运维 AI 工作台桌面应用  
> **上游基础**：crynta/terax-ai v0.8.6（TDSF 深度定制优化版）

---

## 目录

1. [产品简介](#1-产品简介)
2. [环境准备与安装](#2-环境准备与安装)
3. [界面总览](#3-界面总览)
4. [核心功能使用](#4-核心功能使用)
5. [AI 配置指南](#5-ai-配置指南)
6. [快捷键参考](#6-快捷键参考)
7. [最佳实践](#7-最佳实践)

---

## 1. 产品简介

### 1.1 TDSF Terminal Agent 是什么

TDSF Terminal Agent 是一款基于 Tauri 2 (Rust) 构建的桌面应用，以**终端**为核心交互方式，集成了 AI Agent、SSH 远程管理、文件浏览、代码编辑、知识库等功能的 **Linux 运维 AI 工作台**。

技术栈概览：

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS + xterm.js + Monaco Editor |
| 后端 | Tauri 2 (Rust) + portable-pty + russh |
| AI | Python Sidecar + LangGraph + ChromaDB |
| 包管理 | pnpm |

### 1.2 适用场景

- **Linux 运维教学**：通过 Teach Agent 结合知识库，讲解命令原理、易错点与考点
- **远程服务器管理**：SSH 连接管理 + SFTP 远程文件浏览，一站式管理多台服务器
- **AI 辅助运维**：9 个 AI Agent 协同工作，覆盖代码生成、故障排查、历史回放等场景
- **日常终端开发**：本地终端 + 代码编辑器 + Git 源码控制，满足日常开发需求

---

## 2. 环境准备与安装

### 2.1 系统要求

| 操作系统 | 最低版本 |
|---------|---------|
| Windows | 10 (21H2) / 11 / 25H2 |
| Linux | Ubuntu 22.04+ / Fedora 38+ 等主流发行版 |
| macOS | 13 Ventura+ |

### 2.2 依赖安装

#### Node.js（前端构建）

推荐 LTS 版本（20.x 或更新）。从 [https://nodejs.org](https://nodejs.org) 下载安装。

#### Rust 1.85+（Tauri 后端）

```bash
# 使用 rustup 安装
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
```

Windows 用户需额外安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。

#### Python 3.11+（AI Sidecar）

推荐 Python 3.13。从 [https://www.python.org](https://www.python.org) 下载安装，确保勾选 "Add to PATH"。

#### pnpm（包管理）

```bash
npm install -g pnpm
```

### 2.3 项目构建步骤

```bash
# 1. 克隆项目
git clone <仓库地址>
cd tdsf-terminal-agent-clone

# 2. 安装前端依赖
pnpm install

# 3. 启动开发模式（自动编译 Rust 后端 + 启动前端热更新）
pnpm tauri:dev
```

如需构建生产版本：

```bash
pnpm tauri:build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录。

### 2.4 Python Sidecar 配置

AI 功能依赖 Python Sidecar 进程。首次启动前需确保：

1. Python 3.11+ 已安装并加入 PATH
2. 进入 sidecar 目录安装依赖：

```bash
cd src-tauri/sidecar
pip install -r requirements.txt
```

3. 应用启动时会自动拉起 Sidecar 进程，可在 **设置 → TDSF Panel** 中查看 Sidecar 日志确认运行状态。

---

## 3. 界面总览

### 3.1 主界面布局

```
┌──────────────────────────────────────────────────┐
│  标题栏 (Titlebar / Header)                       │
│  [项目名] [Agent 切换] [主题切换] [搜索]           │
├──────┬───────────────────────────────────────────┤
│      │  标签页 (Tabs)                             │
│ 侧   │  ┌─────────┬─────────┬─────────┐          │
│ 边   │  │ Terminal│ Editor  │   ...   │          │
│ 栏   │  ├─────────┴─────────┴─────────┤          │
│      │  │                             │          │
│ 文件 │  │     工作区 (Workspace)       │          │
│ 资源 │  │     终端 / 编辑器 / AI 面板   │          │
│ 管理 │  │                             │          │
│ 器   │  │                             │          │
│      │  ├─────────────────────────────┤          │
│      │  │  状态栏 (Statusbar)          │          │
├──────┴───────────────────────────────────────────┤
│  状态栏：AI 模型选择 · 分支信息 · 编码 · 行号      │
└──────────────────────────────────────────────────┘
```

- **标题栏 / Header**：显示项目名、Agent 切换下拉框、主题切换、搜索入口
- **侧边栏**：文件资源管理器（本地 / 远程）、源码控制、设置入口
- **工作区**：标签页形式，支持终端、编辑器、预览等多种面板
- **状态栏**：底部信息栏，含 AI 模型选择器、Git 分支等

### 3.2 标签页系统

- 支持多标签页，可拖拽排序
- 每个标签页可以是终端、编辑器、Web 预览等类型
- `Ctrl+T` / `⌘T` 新建标签页
- `Ctrl+W` / `⌘W` 关闭当前标签页
- `Ctrl+1~9` / `⌘1~9` 跳转到指定标签页
- 支持分屏：`Ctrl+D` 左右分屏，`Ctrl+Shift+D` 上下分屏

### 3.3 命令面板

按 `Ctrl+P` / `⌘P` 打开命令面板（基于 cmdk），可快速执行：

- 切换主题
- 打开设置
- 切换 Agent
- 执行各类命令

按 `Ctrl+Shift+P` / `⌘⇧P` 打开文件内容搜索。

---

## 4. 核心功能使用

### 4.1 本地终端

#### 打开终端

应用启动后默认即显示一个本地终端标签页。也可通过以下方式新建：

- 快捷键 `Ctrl+T` / `⌘T` → 选择 "New terminal"
- 命令面板搜索 "New tab"

#### 切换 Shell

在 Windows 上支持 PowerShell、Bash、WSL 等 Shell。新建终端时可选择 Shell 类型。

#### 终端交互

- 直接在终端区域输入命令即可
- `Ctrl+U` / `⌘U` 切换 Shell 输入与 AI 输入模式
- `Ctrl+Shift+T` / `⌘⇧T` 开关终端翻译浮层
- `Ctrl+↑` / `⌘↑` 和 `Ctrl+↓` / `⌘↓` 在命令块之间跳转

### 4.2 SSH 远程连接

#### 新建连接

1. 点击侧边栏 **SSH Explorer** 图标
2. 点击 **"+ New Connection"** 按钮
3. 填写连接信息：
   - **Host**：远程服务器地址
   - **Port**：SSH 端口（默认 22）
   - **Username**：用户名
   - **认证方式**：密码 / 密钥文件
4. 点击 **Connect**

#### 主机密钥审批

首次连接未知主机时，会弹出主机密钥确认对话框，显示指纹信息。确认无误后点击 **Accept** 即可。

#### 远程文件浏览（SFTP）

连接成功后，SSH Explorer 面板会展示远程文件树，支持：

- 展开/折叠目录
- 点击文件在编辑器中打开
- 右键菜单操作

#### SSH 终端

在 SSH Explorer 中右键选择 "Open Terminal" 或在标签页中新建 SSH 终端，即可获得远程 Shell。

### 4.3 文件资源管理器

#### 本地文件树

侧边栏的 **Explorer** 面板显示当前工作目录的文件树：

- 点击文件 → 在编辑器标签页中打开
- 右键菜单 → 新建文件/文件夹、重命名、删除
- 拖拽文件到工作区

#### 远程文件树

通过 SSH 连接后，远程文件树自动显示在 SSH Explorer 中，操作方式与本地一致。

### 4.4 代码编辑器

基于 Monaco Editor（VS Code 同款编辑器内核）。

- **打开文件**：在文件资源管理器中点击文件
- **编辑**：支持语法高亮、代码折叠、查找替换
- **保存**：`Ctrl+S` / `⌘S`
- **语法高亮**：自动根据文件扩展名识别语言
- **AI 补全**：`Alt+\` 触发 AI 代码补全，`Ctrl+Space` 触发代码补全

> **注意**：文件编辑保存功能目前仍在调试中，部分场景可能不稳定。

### 4.5 AI Agent 面板

#### 打开 AI 面板

- 快捷键 `Ctrl+I` / `⌘I` 切换 AI Agent 面板
- 快捷键 `Ctrl+Shift+I` / `⌘⇧I` 切换 AI 迷你窗口
- 点击侧边栏 AI 图标

#### Agent 说明

TDSF Terminal Agent 提供 **5 个前端 Tab Agent**，统一由 **Main Agent** 作为入口，Main Agent 内部通过 PAOR 监督循环自动路由到 8 个子 Agent：

| Agent | 标识 | 用途 |
|-------|------|------|
| **Main** | `main` | 统一入口，PAOR 监督 + 智能路由到子 Agent |
| **Coder** | `coder` | 代码生成、修改、Bug 修复 |
| **Explore** | `explore` | 只读分析代码库架构、追踪调用链、生成文档 |
| **History** | `history` | 检索过往会话、命令历史、错误模式，辅助复盘 |
| **Teach** | `teach` | 基于知识库 + tldr-pages 解释命令原理、易错点与考点 |

Main Agent 后端还可路由到以下子 Agent（无需手动切换）：

| 子 Agent | 用途 |
|---------|------|
| coding | 代码生成与修改 |
| debug | 调试与故障排查 |
| refactor | 代码重构 |
| test | 测试生成与执行 |
| deploy | 部署与运维 |

#### 对话交互

1. 在 AI 面板底部输入框输入问题
2. 选择要使用的 Agent Tab（默认 Main）
3. 按 Enter 发送
4. AI 回复以流式方式展示
5. `Ctrl+J` / `⌘J` 可快速将选中内容发送给 AI

### 4.6 知识库与技能

#### 知识库检索

知识库采用 **离线向量检索（ChromaDB）+ FTS5 全文检索** 双路方案：

- AI Agent 回答问题时自动检索知识库相关内容
- 可在 **设置 → TDSF Panel** 中配置知识库路径

#### 技能系统

内置 **5 个技能卡片**，可在 Skills 面板中查看和使用：

| 技能名称 | 分类 | 用途 |
|---------|------|------|
| **Docker Management** | Docker | 容器/镜像/网络/卷/Compose 管理 |
| **Linux Ops** | Linux | Nginx/systemd/journalctl/iptables 运维 |
| **Python Debug** | Python | 异常追踪、pdb 调试、性能分析、虚拟环境 |
| **SELinux Baseline** | Linux | SELinux 模式切换、AVC denied 排查 |
| **SSH Troubleshoot** | SSH | 连接超时/认证失败/known_hosts 排查 |

使用方式：

1. 打开 Skills 面板
2. 找到目标技能卡片
3. 点击 **"查看内容"** 预览 SKILL.md 详细内容
4. 点击 **"让 Agent 调用"** 将技能交给 AI Agent 执行

### 4.7 源码控制

集成 Git 功能，在侧边栏 **Source Control** 面板中操作：

- **查看状态**：显示已修改/新增/删除的文件列表
- **暂存文件**：点击文件旁的 `+` 号暂存（stage）
- **提交**：输入 commit message 后点击提交按钮
- **查看 Diff**：点击文件查看行级差异
- **Fetch / Push**：面板顶部操作按钮
- **查看日志**：Git History 面板显示提交历史

快捷键 `Ctrl+G` / `⌘G` 可快速切换源码控制面板。

### 4.8 离线翻译

内置 Linux 运维 + 编程术语离线词典：

- 在终端中选中文本
- 按 `Ctrl+Shift+T` / `⌘⇧T` 开关翻译浮层
- 翻译结果即时显示，无需联网

### 4.9 主题切换

#### UI 主题（16 个内置）

通过命令面板或设置切换，支持亮色/暗色/跟随系统：

| 主题名称 | 风格 |
|---------|------|
| TDSF Default | 中性灰 · 简约专业 |
| Tokyo Night | 沉稳蓝色调暗色 |
| Nord | 北极蓝 · 简洁优雅 |
| Dracula | 经典高对比紫色暗色 |
| Catppuccin | 柔和暖色 pastel |
| Solarized | 精密低眩光 |
| Gruvbox | 暖色复古 |
| Kanagawa | 水墨暗色 + Lotus 亮色 |
| Kanagawa Dragon | 近黑 muted 变体 |
| Everforest | 柔和绿色森林 |
| Claude | 暖色陶土 |
| Sage | 柔和森林绿 |
| Rosé Pine | Soho 自然松木玫瑰 |
| Tide | 深岩蓝绿 |
| Caffeine | 暖色咖啡 |
| Terax Default | 原生暗色/亮色 |

#### 终端主题（40 个内置）

终端区域独立于 UI 主题，可在设置中单独选择终端配色方案，分为 Dark / Light / Colorful / Minimal 四大分类。

---

## 5. AI 配置指南

### 5.1 配置 AI 提供商

1. 点击状态栏的 AI 模型按钮，或进入 **设置 → AI**
2. 选择 AI 提供商
3. 输入 API Key（存储在系统密钥环中，安全加密）
4. 选择模型

### 5.2 支持的提供商列表

| 提供商 | 需要 API Key | 说明 |
|-------|:----------:|------|
| OpenAI | ✅ | GPT-4o、GPT-4 等 |
| Anthropic | ✅ | Claude 系列 |
| Google | ✅ | Gemini 系列 |
| xAI | ✅ | Grok 系列 |
| Cerebras | ✅ | 高速推理 |
| Groq | ✅ | 超快推理速度 |
| DeepSeek | ✅ | 高性价比国产模型 |
| Mistral | ✅ | 欧洲开源模型 |
| OpenRouter | ✅ | 多模型聚合网关 |
| OpenAI Compatible | 可选 | 兼容 OpenAI API 的自定义端点 |
| LM Studio | ❌ | 本地模型服务器 |
| MLX | ❌ | Apple Silicon 本地推理 |
| Ollama | ❌ | 本地模型运行 |

### 5.3 本地模型接入

#### Ollama

1. 安装 Ollama：[https://ollama.com/download](https://ollama.com/download)
2. 拉取模型：`ollama pull llama3`
3. 在 TDSF 中选择 **Ollama** 提供商（无需 API Key）
4. 选择已拉取的模型即可使用

#### LM Studio

1. 安装 LM Studio：[https://lmstudio.ai](https://lmstudio.ai)
2. 下载并启动本地模型
3. 开启 LM Studio 的 Local Server
4. 在 TDSF 中选择 **LM Studio** 提供商（无需 API Key）

#### MLX（仅 macOS Apple Silicon）

1. 安装 mlx-lm：`pip install mlx-lm`
2. 启动 MLX Server
3. 在 TDSF 中选择 **MLX** 提供商

---

## 6. 快捷键参考

> 以下快捷键以 Windows/Linux 为准，macOS 上 `Ctrl` → `⌘`，`Alt` → `⌥`。

### 通用

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+P` | 打开命令面板 |
| `Ctrl+Shift+P` | 文件内容搜索 |
| `Ctrl+,` | 打开设置 |

### 标签页

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+T` | 新建标签页 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+R` | 新建私有终端 |
| `Ctrl+E` | 新建编辑器标签页 |
| `Ctrl+Shift+O` | 新建 Web 预览 |
| `Ctrl+Tab` | 下一个标签页 |
| `Ctrl+Shift+Tab` | 上一个标签页 |
| `Ctrl+1~9` | 跳转到第 N 个标签页 |

### 分屏

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+D` | 向右分屏 |
| `Ctrl+Shift+D` | 向下分屏 |
| `Ctrl+]` | 聚焦下一个面板 |
| `Ctrl+[` | 聚焦上一个面板 |
| `Ctrl+Alt+←/→/↑/↓` | 交换面板位置 |

### 终端

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+U` | 切换 Shell / AI 输入模式 |
| `Ctrl+Shift+T` | 开关终端翻译 |
| `Ctrl+↑` / `Ctrl+↓` | 上/下一个命令块 |

### AI

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+I` | 切换 AI Agent 面板 |
| `Ctrl+Shift+I` | 切换 AI 迷你窗口 |
| `Ctrl+J` | 将选中内容发送给 AI |
| `Ctrl+Shift+A` | 跳转到需要关注的 Agent |

### 视图

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+B` | 切换侧边栏 |
| `Ctrl+Shift+E` | 聚焦文件资源管理器 |
| `Ctrl+Shift+F` | 搜索文件 |
| `Ctrl+F` | 在标签页中查找 |
| `Ctrl+G` | 切换源码控制面板 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置缩放 |
| `Ctrl+Shift+'` | 禅模式 |

### 编辑器

| 快捷键 | 功能 |
|-------|------|
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Alt+\` | AI 代码补全 |
| `Ctrl+Space` | 代码补全 |

---

## 7. 最佳实践

### 7.1 运维教学场景使用建议

1. **善用 Teach Agent**：在 AI 面板切换到 Teach Tab，输入如 "解释 systemd 服务管理" 即可获得详细教学
2. **结合知识库**：Teach Agent 会自动检索知识库中的相关内容，确保回答准确
3. **技能辅助**：遇到特定运维问题（如 Docker、SELinux），先在 Skills 面板查看对应技能卡片
4. **终端翻译**：阅读英文命令输出时，使用 `Ctrl+Shift+T` 开启实时翻译

### 7.2 远程服务器管理流程

1. **建立连接**：在 SSH Explorer 中创建连接配置
2. **文件浏览**：连接后通过 SFTP 浏览远程文件
3. **远程终端**：打开 SSH 终端执行命令
4. **AI 辅助**：遇到问题时让 AI Agent 分析日志、提供解决方案
5. **Git 管理**：通过源码控制面板管理远程仓库

### 7.3 日常开发工作流

1. 左侧文件资源管理器浏览项目
2. 点击文件在编辑器中打开和编辑
3. 下方终端运行构建和测试命令
4. 源码控制面板随时查看和提交代码变更
5. AI Agent 辅助代码审查和 Bug 排查

---

> **提示**：如遇问题，请参阅 [TDSF Terminal Agent 常见问题FAQ](./TDSF%20Terminal%20Agent%20常见问题FAQ.md)。
