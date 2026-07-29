# TDSF Terminal Agent 常见问题FAQ

> **版本**：v4.0 · **更新日期**：2026-07-29  
> 本文档收录 TDSF Terminal Agent 在安装、配置和使用过程中的常见问题与解答。

---

## 目录

1. [安装与构建](#1-安装与构建)
2. [终端相关](#2-终端相关)
3. [SSH 相关](#3-ssh-相关)
4. [AI Agent 相关](#4-ai-agent-相关)
5. [编辑器相关](#5-编辑器相关)
6. [主题与界面](#6-主题与界面)
7. [性能与稳定性](#7-性能与稳定性)
8. [数据安全](#8-数据安全)

---

## 1. 安装与构建

### Q: 构建时报 Rust 工具链缺失？

**A:** TDSF Terminal Agent 的桌面端基于 Tauri 2 (Rust)，构建时需要 Rust 工具链。

**解决步骤：**

```bash
# 安装 rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装 stable 工具链
rustup default stable

# 验证安装
rustc --version
```

**Windows 用户**还需安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，安装时勾选 "Desktop development with C++"。

确保 Rust 版本 ≥ 1.85：

```bash
rustup update stable
```

---

### Q: pnpm install 失败？

**A:** 常见原因及解决方案：

1. **Node.js 版本过低**：确保 Node.js ≥ 18（推荐 20.x LTS）
   ```bash
   node --version
   ```

2. **网络问题**：尝试切换镜像源
   ```bash
   pnpm config set registry https://registry.npmmirror.com
   pnpm install
   ```

3. **权限问题（Linux/macOS）**：不要使用 `sudo`，修复 npm 全局目录权限
   ```bash
   mkdir -p ~/.npm-global
   npm config set prefix '~/.npm-global'
   echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
   source ~/.bashrc
   npm install -g pnpm
   ```

4. **缓存损坏**：清除缓存后重试
   ```bash
   pnpm store prune
   pnpm install
   ```

---

### Q: Python Sidecar 启动失败？

**A:** AI 功能依赖 Python Sidecar 进程，启动失败通常由以下原因导致：

1. **Python 版本不满足要求**：需要 Python 3.11+（推荐 3.13）
   ```bash
   python --version
   ```

2. **依赖未安装**：
   ```bash
   cd src-tauri/sidecar
   pip install -r requirements.txt
   ```

3. **查看 Sidecar 日志**：在 **设置 → TDSF Panel** 中可查看 Sidecar 日志输出，定位具体错误。

4. **端口被占用**：Sidecar 使用本地端口通信，确保对应端口未被其他程序占用。

---

### Q: Windows 上构建报错？

**A:** Windows 构建常见问题：

1. **缺少 C++ 编译工具**：安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 "Desktop development with C++" 工作负载。

2. **WebView2 缺失**：Windows 10 早期版本可能缺少 WebView2 运行时，从 [Microsoft 官网](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) 下载安装 Evergreen Bootstrapper。

3. **长路径问题**：启用 Windows 长路径支持，或将项目放在较短的路径下（如 `D:\proj\`）。

4. **杀毒软件干扰**：部分杀毒软件可能阻止 Rust 编译过程中的文件操作，临时排除项目目录。

---

## 2. 终端相关

### Q: 终端无法显示内容？

**A:** 终端无内容可能由以下原因导致：

1. **Shell 进程未启动**：检查终端标签页是否正确初始化。尝试关闭当前标签页，重新新建终端（`Ctrl+T`）。

2. **xterm.js 渲染异常**：尝试刷新窗口（`Ctrl+Shift+R` 或菜单 Reload）。

3. **字体缺失**：终端需要等宽字体（如 Cascadia Code、Fira Code）。如系统缺少等宽字体可能导致渲染异常。

4. **GPU 加速问题**：部分显卡驱动可能导致 xterm.js WebGL 渲染异常，可在设置中切换渲染模式。

---

### Q: 如何切换 Shell（PowerShell/Bash/WSL）？

**A:** 在 Windows 上：

- 新建终端标签页时，可在弹出的选项中选择 Shell 类型
- 支持 PowerShell（默认）、Bash（需安装 Git Bash 或 MSYS2）、WSL（需启用 Windows Subsystem for Linux）
- 也可通过命令面板搜索 "New terminal" 选择不同类型

在 Linux/macOS 上默认使用系统 Shell（bash/zsh）。

---

### Q: SSH 连接后终端空白？

**A:** 这是已知问题之一。SSH 连接建立后 Shell 终端可能不显示内容。

**尝试以下方法：**

1. **重新连接**：断开 SSH 连接后重新连接
2. **调整终端大小**：拖拽窗口边缘改变尺寸，触发 xterm.js 重新渲染
3. **手动刷新**：在 SSH 终端中输入 `reset` 命令重置终端
4. **检查远程 Shell**：确认远程服务器的默认 Shell 配置正确（`/etc/passwd` 中的 login shell）

---

## 3. SSH 相关

### Q: SSH 连接超时？

**A:** 连接超时通常由网络问题导致：

1. **检查网络连通性**：
   ```bash
   ping <服务器地址>
   ```

2. **检查端口是否开放**：
   ```bash
   # Linux/macOS
   nc -zv <服务器地址> 22

   # Windows PowerShell
   Test-NetConnection -ComputerName <服务器地址> -Port 22
   ```

3. **防火墙规则**：确认本地防火墙和服务器端防火墙均允许 22 端口（或自定义 SSH 端口）通信。

4. **代理设置**：如果处于公司网络，可能需要配置 SSH 代理。

5. **增加超时时间**：在连接配置中适当增加连接超时时间。

---

### Q: 主机密钥未知如何验证？

**A:** 首次连接 SSH 服务器时，TDSF 会弹出主机密钥确认对话框。

**验证方法：**

1. **对比指纹**：对话框中显示服务器主机密钥的指纹（SHA256 格式），通过其他安全渠道（如登录服务器控制台）获取指纹进行对比。

2. **首次连接信任**：如果是你自己管理的服务器且确认地址无误，通常可以直接 Accept。

3. **询问管理员**：向服务器管理员确认主机密钥指纹。

> **安全提示**：如果指纹不匹配或你无法确认来源，请点击 **Reject**，可能存在中间人攻击。

---

### Q: SFTP 文件列表为空？

**A:** SSH 连接成功但 SFTP 文件列表为空：

1. **检查用户权限**：确认 SSH 用户有权限访问目标目录
2. **检查 home 目录**：SFTP 默认显示用户 home 目录，确认 home 目录存在且非空
3. **重新连接**：断开后重新建立 SSH 连接
4. **检查 SFTP 子系统**：确认远程服务器的 `sshd_config` 中启用了 SFTP 子系统
   ```
   # /etc/ssh/sshd_config
   Subsystem sftp /usr/lib/openssh/sftp-server
   ```

---

## 4. AI Agent 相关

### Q: AI 面板无响应？

**A:** AI 面板无响应可能由以下原因导致：

1. **未配置 API Key**：检查是否已配置 AI 提供商的 API Key
   - 点击状态栏 AI 模型按钮 → 选择提供商 → 输入 API Key
   - 或使用本地模型（Ollama/LM Studio），无需 API Key

2. **Python Sidecar 未运行**：AI 功能依赖 Python Sidecar
   - 在 **设置 → TDSF Panel** 中检查 Sidecar 状态
   - 尝试重启 Sidecar 或重启应用

3. **网络问题**：使用云端 AI 提供商时需要网络连接
   - 检查网络是否正常
   - 尝试切换到本地模型（Ollama/LM Studio）

4. **模型选择错误**：确认已选择有效的模型

---

### Q: 如何配置 API Key？

**A:** 配置步骤：

1. 点击应用底部**状态栏**的 AI 模型按钮
2. 或进入 **设置 → AI** 页面
3. 选择 AI 提供商（如 OpenAI、Anthropic 等）
4. 输入 API Key
   - API Key 存储在操作系统密钥环中（Windows Credential Manager / macOS Keychain / Linux Secret Service），安全加密
   - Key 不会以明文形式存储在配置文件中

各提供商获取 API Key 的地址：

| 提供商 | 获取地址 |
|-------|---------|
| OpenAI | https://platform.openai.com/api-keys |
| Anthropic | https://console.anthropic.com/settings/keys |
| Google | https://aistudio.google.com/apikey |
| DeepSeek | https://platform.deepseek.com/api_keys |
| Groq | https://console.groq.com/keys |

---

### Q: 支持哪些 AI 提供商？

**A:** TDSF Terminal Agent 支持 **13 个 AI 提供商**：

**云端（需要 API Key）：**
- OpenAI（GPT-4o、GPT-4 等）
- Anthropic（Claude 系列）
- Google（Gemini 系列）
- xAI（Grok 系列）
- Cerebras（高速推理）
- Groq（超快推理）
- DeepSeek（高性价比国产模型）
- Mistral（欧洲开源模型）
- OpenRouter（多模型聚合网关）

**本地 / 自定义（无需或可选 API Key）：**
- OpenAI Compatible（兼容 OpenAI API 的自定义端点）
- LM Studio（本地模型服务器）
- MLX（Apple Silicon 本地推理）
- Ollama（本地模型运行）

---

### Q: 如何使用本地模型（离线）？

**A:** 推荐使用 Ollama 或 LM Studio：

**Ollama（推荐）：**

```bash
# 1. 安装 Ollama（访问 https://ollama.com/download）
# 2. 拉取模型
ollama pull llama3
ollama pull qwen2    # 推荐中文场景使用

# 3. 在 TDSF 中选择 Ollama 提供商，选择已拉取的模型
```

**LM Studio：**

1. 安装 LM Studio 并下载模型
2. 启动 Local Server（默认端口 1234）
3. 在 TDSF 中选择 LM Studio 提供商

**MLX（仅 macOS Apple Silicon）：**

```bash
pip install mlx-lm
# 启动 MLX Server 后在 TDSF 中选择 MLX 提供商
```

---

### Q: Agent 回复中断怎么办？

**A:** AI Agent 回复可能因以下原因中断：

1. **网络波动**：云端 API 调用过程中网络中断
   - 重新发送问题即可

2. **Token 限制**：回复超过模型最大输出长度
   - 尝试将问题拆分为更小的部分

3. **Sidecar 崩溃**：Python Sidecar 进程异常退出
   - 在 **设置 → TDSF Panel** 中重启 Sidecar
   - 或重启应用

4. **API 限流**：部分提供商有速率限制
   - 等待一段时间后重试
   - 或切换到其他提供商

---

## 5. 编辑器相关

### Q: 文件点击后无法打开？

**A:** 文件点击后无法在编辑器中打开：

1. **检查文件类型**：某些二进制文件（如图片、编译产物）不支持在文本编辑器中打开
2. **权限问题**：确认对目标文件有读取权限
3. **文件被锁定**：某些文件可能被其他进程锁定
4. **重试**：关闭标签页后重新点击文件打开

---

### Q: 编辑后无法保存？

**A:** 这是当前已知问题之一，文件编辑保存功能尚在调试中。

**临时解决方案：**

1. **通过终端保存**：如果是远程文件，可通过 SSH 终端使用 `vim` / `nano` 等命令编辑
2. **检查文件权限**：确认对目标文件有写入权限
3. **检查磁盘空间**：确认磁盘有足够空间
4. **重新打开**：关闭文件后重新打开，检查修改是否已生效

> **注意**：此问题正在积极修复中，请关注后续版本更新。

---

## 6. 主题与界面

### Q: 如何切换主题？

**A:** 有三种方式切换主题：

1. **命令面板**：`Ctrl+P` → 搜索 "theme" → 选择目标主题
2. **设置页面**：进入 **设置 → 主题** → 点击选择
3. **标题栏**：点击标题栏中的主题切换按钮

支持 16 个 UI 主题 + 40 个终端主题，可分别独立设置。

还支持亮色/暗色/跟随系统三种模式切换。

---

### Q: 界面布局如何调整？

**A:** TDSF Terminal Agent 支持灵活的布局调整：

- **侧边栏**：`Ctrl+B` 切换显示/隐藏
- **分屏**：`Ctrl+D` 左右分屏，`Ctrl+Shift+D` 上下分屏
- **面板切换**：`Ctrl+]` / `Ctrl+[` 在分屏面板间切换
- **面板交换**：`Ctrl+Alt+方向键` 交换面板位置
- **缩放**：`Ctrl+=` / `Ctrl+-` 放大/缩小，`Ctrl+0` 重置
- **禅模式**：`Ctrl+Shift+'` 进入专注模式（隐藏侧边栏和状态栏）

---

## 7. 性能与稳定性

### Q: 资源管理器卡顿？

**A:** 文件资源管理器在以下场景可能卡顿：

1. **大型目录**：包含大量文件/子目录的文件夹（如 `node_modules`）加载较慢
   - 建议在工作区中排除不需要的大型目录

2. **多点文件夹同时展开**：已知问题——同时展开多个深层嵌套的文件夹可能导致卡死
   - 建议逐个展开目录，避免一次性展开多个大目录

3. **远程文件浏览**：SFTP 浏览远程文件时受网络延迟影响
   - 耐心等待加载，避免频繁点击展开

4. **内存不足**：关闭不必要的标签页和面板释放资源

---

### Q: 内存占用过高？

**A:** 降低内存占用的建议：

1. **关闭不需要的标签页**：每个终端标签页和编辑器标签页都占用内存
2. **减少分屏数量**：多个面板同时显示会增加渲染开销
3. **限制终端滚动缓冲区**：在设置中减小终端历史行数
4. **重启应用**：长期使用后内存可能累积，定期重启可释放资源
5. **检查 AI 模型**：本地模型（Ollama/LM Studio）会占用大量内存，不用时可关闭

---

## 8. 数据安全

### Q: 我的密钥/密码如何存储？

**A:** TDSF Terminal Agent 使用操作系统原生密钥环服务存储敏感信息：

| 操作系统 | 存储位置 |
|---------|---------|
| Windows | Windows Credential Manager |
| macOS | Keychain |
| Linux | Secret Service (libsecret) |

- API Key 等敏感信息**不会**以明文形式存储在配置文件中
- SSH 密钥文件路径由用户指定，应用不复制密钥文件本身
- 设置文件（`tdsf-settings.json`）中仅存储非敏感配置

---

### Q: AI 对话数据存在哪里？

**A:** AI 对话数据的存储位置：

- **本地历史数据库**：对话记录存储在本地 `.tdsf-data/history.db`（SQLite 数据库）
- **知识库数据**：向量数据存储在 `.tdsf-data/chroma/` 目录，全文索引在 `.tdsf-data/kb.db`
- **云端 API**：使用云端 AI 提供商时，对话内容会发送到对应提供商的 API 端点
- **本地模型**：使用 Ollama/LM Studio/MLX 时，所有数据完全在本地处理，不经过网络

---

### Q: 是否会发送数据到第三方？

**A:** TDSF Terminal Agent 的数据发送策略：

**不会发送的数据：**
- API Key 仅发送到对应提供商的认证端点
- 终端内容、文件内容不会主动发送到任何第三方
- SSH 连接信息仅在你的本地机器和远程服务器之间

**可能发送的数据：**
- 使用**云端 AI 提供商**时，你输入的对话内容会发送到对应提供商的 API（如 OpenAI、Anthropic 等），受其隐私政策约束
- 使用**本地模型**（Ollama/LM Studio/MLX）时，所有 AI 对话完全在本地处理

**建议：**
- 如果对数据隐私有严格要求，推荐使用本地模型
- 避免在对话中发送敏感的生产环境密码或密钥
- 查阅各 AI 提供商的隐私政策了解其数据处理方式

---

> **更多帮助**：详细使用指南请参阅 [TDSF Terminal Agent 使用手册](./TDSF%20Terminal%20Agent%20使用手册.md)。
