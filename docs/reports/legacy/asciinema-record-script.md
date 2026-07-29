# TDSF Terminal Agent v4.0 · asciinema 录屏脚本

> **阶段**：P7-01 评审验收  
> **日期**：2026-07-26  
> **目的**：5 分钟 6 段录屏脚本，每段 50 秒  
> **总时长**：5 分钟（300 秒）  
> **录屏命令**：`asciinema rec -t "TDSF Terminal Agent Demo" demo.cast`

---

## 1. 录屏概览

| 段号 | 标题 | 时长 | 重点 |
|------|------|------|------|
| 1 | 启动应用 + 主界面介绍 | 50s | Tauri 启动 / Titlebar / 5 区域布局 |
| 2 | 本地终端操作 + 命令补全 | 50s | PTY / 命令历史 / AI 补全 / 风险预评估 |
| 3 | SSH 连接 + 远程文件编辑 | 50s | SSH 弹窗 / known_hosts / SFTP / Monaco |
| 4 | Agent 故障排查（nginx 案例） | 50s | PAOR 循环 / 7 状态 mood ring / 工具卡 / 知识卡 |
| 5 | 知识库搜索 + Skill 安装 | 50s | FTS5 / ChromaDB / Skill 市场 / 18 领域 |
| 6 | 多 Agent 协作 + 审批流程 | 50s | 9 子 Agent / Worktree / needs-you / 风险 L3 拦截 |

---

## 2. 录屏环境准备

```bash
# 1. 安装 asciinema
pip install asciinema

# 2. 启动 TDSF Terminal Agent
pnpm tauri:dev

# 3. 另开终端启动录屏
asciinema rec -t "TDSF Terminal Agent Demo" demo.cast

# 4. 录制完成后转 gif（可选）
agg demo.cast demo.gif
```

---

## 3. 详细脚本（6 段 × 50s）

### 段 1: 启动应用 + 主界面介绍（0:00 - 0:50）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 0:00 | 终端黑屏 → 启动命令 `pnpm tauri:dev` | "现在演示 TDSF Terminal Agent v4.0..." | 输入启动命令 | 5s |
| 0:05 | Tauri 窗口淡入，显示主界面展开模式 | "应用基于 Tauri 2，安装包仅 7MB" | 等待窗口加载 | 5s |
| 0:10 | 鼠标悬停 Titlebar 32px | "顶部 Titlebar 32px，含应用名、项目切换、Mood Ring 状态" | 悬停 Titlebar 各段 | 8s |
| 0:18 | 鼠标移到 LeftSidebar 220px | "左侧 Sidebar 220px，含项目树、收藏、命令历史" | 点击项目树展开 | 8s |
| 0:26 | 鼠标移到 Terminal 主区 | "中间是真实 PTY 终端，xterm.js + WebGL 渲染" | 点击终端聚焦 | 6s |
| 0:32 | 鼠标移到 AgentPanel 380px | "右侧浮动 Agent 面板，可拖动调整位置" | 拖动 AgentPanel | 8s |
| 0:40 | 鼠标移到 StatusBar 24px | "底部 StatusBar 24px，含 Mood Ring / SSH / Mode / Perm / Tokens" | 悬停 StatusBar | 8s |
| 0:48 | 切换到折叠模式 (Ctrl+L) | "按 Ctrl+L 切换折叠模式" | 按 Ctrl+L | 2s |

### 段 2: 本地终端操作 + 命令补全（0:50 - 1:40）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 0:50 | 终端聚焦，输入 `ls -la` | "本地终端操作，真实 PTY 渲染" | 输入 `ls -la` + Enter | 5s |
| 0:55 | 显示文件列表，Maple Mono 字体 | "Maple Mono NF 字体，中英 2:1 等宽" | 等待输出 | 5s |
| 1:00 | 输入 `system` 出现补全弹窗 | "输入 system 触发补全弹窗" | 输入 `system` | 5s |
| 1:05 | 补全弹窗显示 6 个建议 + 风险标签 | "补全来源：历史 + AI + 知识库，含风险预评估" | 等待弹窗 | 8s |
| 1:13 | ↑ 选择 `systemctl status nginx` | "↑↓ 选择，每个命令显示 L0-L4 风险等级" | 按 ↑ 选择 | 5s |
| 1:18 | Tab 补全 + Enter 执行 | "Tab 补全，Enter 执行" | Tab + Enter | 5s |
| 1:23 | 显示 nginx 失败状态 | "nginx 服务失败，将触发 Agent 排查" | 等待输出 | 8s |
| 1:31 | Ctrl+R 搜索历史命令 | "Ctrl+R 反向搜索历史命令" | Ctrl+R | 5s |
| 1:36 | 输入 `vim` 找到 `vim nginx.conf` | "找到 vim nginx.conf 历史命令" | 输入 `vim` | 5s |
| 1:38 | Esc 取消，进入下一段 | "Esc 取消，进入下一段" | Esc | 2s |

### 段 3: SSH 连接 + 远程文件编辑（1:40 - 2:30）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 1:40 | 点击 Titlebar + 按钮 → SSH 弹窗 | "点击 SSH 连接按钮，弹出配置窗口" | 点击 SSH 按钮 | 5s |
| 1:45 | SSH 连接弹窗显示主机配置 | "SSH 连接弹窗，支持密码/密钥/Agent 三种认证" | 等待弹窗 | 5s |
| 1:50 | 输入主机 192.168.1.100 端口 22 | "输入主机地址和端口" | 输入主机信息 | 5s |
| 1:55 | 显示 known_hosts 指纹确认 | "首次连接显示 known_hosts 指纹" | 等待指纹 | 5s |
| 2:00 | 点击"连接"按钮 | "点击连接" | 点击连接 | 3s |
| 2:03 | 新标签页打开，显示 SSH 终端 | "新标签页打开远程 SSH 终端" | 等待连接 | 5s |
| 2:08 | 切换到 Explorer 文件树 | "切换到 SFTP 文件树" | 点击 Explorer 标签 | 5s |
| 2:13 | 浏览 /etc/nginx/ 目录 | "浏览远程目录 /etc/nginx/" | 双击目录展开 | 5s |
| 2:18 | 双击 nginx.conf 用 Monaco 编辑 | "双击文件，用 Monaco 编辑器打开" | 双击 nginx.conf | 5s |
| 2:23 | Monaco 编辑器显示 nginx 配置 | "Monaco 0.56 编辑器，含语法高亮和 side-git 跟踪" | 等待加载 | 5s |
| 2:28 | 修改一行配置，显示 diff | "修改一行配置，side-git 实时跟踪 diff" | 修改配置 | 2s |

### 段 4: Agent 故障排查（nginx 案例）（2:30 - 3:20）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 2:30 | 切到 AgentPanel 输入框 | "切到 Agent 面板" | 点击 AgentPanel | 3s |
| 2:33 | 输入 "nginx 启动失败" + Enter | "输入问题：nginx 启动失败" | 输入 + Enter | 5s |
| 2:38 | Mood Ring: idle → thinking（紫色脉动） | "Mood Ring 切到 thinking 紫色脉动" | 等待响应 | 5s |
| 2:43 | Mood Ring: thinking → stream（青色） | "首字节返回，切到 stream 青色流式" | 等待流式 | 5s |
| 2:48 | Agent 消息流式输出，显示分析 | "Agent 流式输出分析结果" | 等待输出 | 5s |
| 2:53 | 显示知识卡 "📚 nginx 失败排查" | "推送知识卡：5 步排查教程" | 等待知识卡 | 5s |
| 2:58 | Mood Ring: stream → working（琥珀） | "决定调用工具，切到 working 琥珀色旋转" | 等待工具卡 | 5s |
| 3:03 | 工具卡: journalctl -u nginx -n 50 | "工具调用卡：journalctl 命令" | 等待工具卡 | 5s |
| 3:08 | RiskGauge L1 OK + [运行]按钮 | "RiskGauge 显示 L1 低风险，可自动执行" | 等待审批 | 5s |
| 3:13 | 点击[运行]，工具执行 → done | "点击运行，工具执行完成" | 点击运行 | 5s |
| 3:18 | Mood Ring: done → idle（绿色微闪） | "Mood Ring 切到 done 绿色微闪，0.3s 后回 idle" | 等待完成 | 2s |

### 段 5: 知识库搜索 + Skill 安装（3:20 - 4:10）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 3:20 | Ctrl+K 打开知识库搜索 | "Ctrl+K 打开知识库搜索" | Ctrl+K | 3s |
| 3:23 | 输入 "nginx 端口占用" | "输入搜索关键词" | 输入关键词 | 5s |
| 3:28 | FTS5 + ChromaDB 返回 12 结果 | "SQLite FTS5 + ChromaDB 向量搜索，12 结果 0.034s" | 等待结果 | 8s |
| 3:36 | 显示 3 类知识卡：教程/命令/修复 | "3 类结果：教程卡、命令解释卡、修复建议卡" | 浏览结果 | 8s |
| 3:44 | 点击"在终端打开"插入命令 | "点击在终端打开，命令插入终端" | 点击按钮 | 5s |
| 3:49 | 切换到 Skill 市场界面 | "切换到 Skill 市场" | 点击 Skill 图标 | 5s |
| 3:54 | 显示 70+ Skills 网格 | "70+ Skills，覆盖 18 领域" | 浏览市场 | 5s |
| 3:59 | 点击 selinux-baseline "安装" | "点击 selinux-baseline 安装" | 点击安装 | 5s |
| 4:04 | 安装进度条 + 完成 toast | "SKILL.md 解析 + 安装完成" | 等待完成 | 5s |
| 4:09 | 显示已安装 Skills 列表 | "已安装 5 个 Skills" | 等待列表 | 1s |

### 段 6: 多 Agent 协作 + 审批流程（4:10 - 5:00）

| 时间 | 屏幕内容 | 旁白 | 交互 | 时长 |
|------|----------|------|------|------|
| 4:10 | 点击 "多 Agent 协作" 按钮 | "启动多 Agent 协作" | 点击按钮 | 3s |
| 4:13 | 显示 1 主 Agent + 9 子 Agent 网格 | "1 主 Agent + 9 子 Agent 并行" | 等待加载 | 8s |
| 4:21 | 各子 Agent 状态实时变化 | "各子 Agent 状态实时变化：thinking/working/done" | 等待变化 | 8s |
| 4:29 | Worktree 创建提示 | "Parallel Worktree 创建隔离工作区" | 等待提示 | 5s |
| 4:34 | 主 Agent Mood Ring: working | "主 Agent 协调所有子 Agent" | 等待 | 5s |
| 4:39 | needs-you 弹窗 + Titlebar ⚠ +1 | "needs-you 收件箱弹出待审批" | 等待弹窗 | 5s |
| 4:44 | 点击 ⚠ 显示风险拦截 L3 | "L3 危险：rm -rf /var/log 被拦截" | 点击 ⚠ | 5s |
| 4:49 | 显示 RiskGauge 5 等级 + 确认短语 | "RiskGauge 显示 5 等级，需输入确认短语" | 等待显示 | 5s |
| 4:54 | 点击 "取消" 拦截命令 | "点击取消，拦截危险命令" | 点击取消 | 4s |
| 4:58 | 主界面恢复 idle 状态 | "演示结束，应用回到 idle 状态" | 等待恢复 | 2s |

---

## 4. 录屏后处理

### 4.1 转 GIF

```bash
# 安装 agg
cargo install agg

# 转换 cast 为 gif
agg demo.cast demo.gif --speed 1.0 --theme monokai
```

### 4.2 上传 asciinema.org

```bash
asciinema upload demo.cast
# 输出: https://asciinema.org/a/xxxxx
```

### 4.3 嵌入 README

```html
<a href="https://asciinema.org/a/xxxxx">
  <img src="https://asciinema.org/a/xxxxx.svg" />
</a>
```

---

## 5. 录屏注意事项

### 5.1 环境要求

- ✅ Tauri 应用已编译 (`pnpm tauri:build`)
- ✅ 真实 SSH 服务器（host-01: 192.168.1.100）
- ✅ 真实 nginx 故障环境（停止 nginx + apache2 占用 80 端口）
- ✅ 真实 Python sidecar 运行（含 LangGraph + ChromaDB）
- ✅ 网络可用（LLM API 可访问）

### 5.2 录屏技巧

- ⏱️ 每段严格控制在 50s，总时长 5 分钟
- 📝 旁白用中文，语速适中（每分钟 200 字）
- 🖱️ 鼠标移动慢而清晰，避免跳跃
- ⌨️ 输入命令时可见按键反馈
- 🎨 Mood Ring 状态切换要清晰可见

### 5.3 失败重录

```bash
# 中途失败可重录单段
asciinema rec -t "TDSF Demo Segment 4" seg4.cast
# 后期用 asciinema-combine 合并
```

---

## 6. 验收标准

- [x] 6 段录屏脚本完整（每段 50 秒）
- [x] 每段含 4 列：屏幕内容 / 旁白 / 交互 / 时长
- [x] 总时长 5 分钟（300 秒）
- [x] 录屏命令 + 后处理 + 嵌入 README
- [x] 环境准备 + 注意事项 + 失败重录

---

## 7. 引用

- 项目 README：[../README.md](../README.md)
- 真实数据校验：[P7-真实数据校验报告.md](P7-真实数据校验报告.md)
- 5 绿门禁：[P7-五绿门禁验收报告.md](P7-五绿门禁验收报告.md)

> 完成：T-P7-01 asciinema 录屏脚本交付 ✅
