# iShell Pro 竞品调研与 TDSF 方案书更新

> **调研日期**：2026-08-09
> **来源**：https://ishell.cc/zh-CN + CSDN 深度分析文 + 官网更新日志
> **目的**：分析 iShell Pro 亮点功能，找出 TDSF 可借鉴点，更新方案书

---

## 一、iShell Pro 核心功能速览

### 1.1 基本信息

| 项目 | 内容 |
|------|------|
| 官网 | https://ishell.cc/zh-CN |
| 最新版本 | 3.1.54（2026-08-09） |
| 安装包 | < 30MB（原生编译，非 Electron） |
| 用户量 | 10万+ |
| 覆盖平台 | Windows / macOS(M+Intel) / Linux / Android / iOS |
| 协议支持 | SSH / SFTP / RDP / VNC / Telnet / Serial（六大协议） |
| 架构 | 原生编译（自家框架，非 Electron） |
| 开源 | **闭源商业产品**（无公开源码） |

### 1.2 核心功能模块

#### ① SSH 终端管理
- 多标签无限开启，水平/垂直自由分屏，最多同屏 **16 面板**
- 会话录制回放 + GIF 导出
- 本地终端集成（终端底部可直接切本地 Shell）
- 命令智能补全（历史 + 常用命令库 + AI 建议）

#### ② 实时服务器监控（免 Agent）⭐
- **CPU**：总使用率 + 每核进度条 + 趋势折线图
- **内存**：已用/总量 + buffer/cache 分离视图
- **磁盘**：各分区使用率 + 进度条
- **网络**：实时 rx/tx 速度 + 流量图
- **GPU**：显存/温度（Linux 服务器）
- **进程**：实时 Top 进程列表
- **关键**：通过 SSH 通道轻量采集（`cat /proc/stat`、`free`、`df`、`cat /proc/net/dev`），**无需安装 Agent**

#### ③ SFTP 文件管理
- 可视化树形目录 + 拖拽批量上传下载
- 远程文件在线编辑
- 远程压缩解压

#### ④ AI 智能助手
- 内置 70B 大模型通道（开箱即用）
- 自然语言 → 命令生成（直接插入终端）
- 命令解释（选中终端内容右键唤起 AI）
- 日志智能分析（粘贴错误 → 自动诊断）
- 支持自有 API / 本地 Ollama / 内网私有化模型

#### ⑤ SSH 隧道 & 端口转发
- 本地转发 / 远程转发 / SOCKS5 动态代理
- 一键启停 + 实时流量监控

#### ⑥ 云同步 & 代码片段
- 主机配置/代码片段跨设备同步（AES-256 加密）
- 分组标签管理 + 全文检索

#### ⑦ 安全特性
- AES-256-GCM 认证加密 + 硬件指纹绑定密钥
- 凭据不出本机
- 政企版：纯离线部署，零遥测

---

## 二、与 TDSF Terminal Agent 功能对比

| 功能模块 | iShell Pro | TDSF 当前状态 | 差距 | 优先级 |
|----------|-----------|--------------|------|--------|
| SSH 终端 | ✅ 多标签/分屏/16面板 | ✅ 多标签/PaneTreeView | 分屏支持有限 | — |
| 本地终端 | ✅ 底部集成 | ✅ 已有 | 无差距 | — |
| SFTP 文件管理 | ✅ 可视化树+拖拽 | ✅ WorkspaceFs 重构完成 | 无差距 | — |
| 远程文件编辑 | ✅ 在线编辑 | ✅ SshFileEditor | 无差距 | — |
| **服务器实时监控** | ✅ 免 Agent 仪表盘 | ❌ **缺失** | 重大功能缺口 | **P2 高** |
| AI 命令助手 | ✅ 自然语言→命令 | ✅ Strands agent | 有差距（iShell 更开箱即用） | P3 |
| AI 日志分析 | ✅ 粘贴→诊断 | ✅ log_analyzer 工具 | 无差距 | — |
| SSH 隧道 | ✅ 一键启停 | ❌ 缺失 | 功能缺口 | P3 |
| 会话录制 | ✅ 回放+GIF导出 | ✅ asciicast v2 | 无差距 | — |
| 命令补全 | ✅ 历史+AI | ✅ 已有（completion.ts） | 无差距 | — |
| 分屏（本地+SSH） | ✅ 可同屏 | ⚠️ 有空间概念但未联动 | 体验差距 | P2 中 |
| 代码片段 | ✅ 云同步 | ❌ 缺失 | 功能缺口 | P3 |
| 凭证库 | ✅ 统一管理 | ✅ keyring（基础） | 有待加强 | P3 |

---

## 三、重点借鉴：服务器实时监控（免 Agent）

### 3.1 iShell Pro 实现推测（闭源产品，根据功能反推）

**数据采集层（SSH 通道，轻量，无需远程安装）**：

```bash
# CPU 使用率
top -bn1 | grep "Cpu(s)"
cat /proc/stat | head -5

# 内存
free -m | awk 'NR==2{printf "Memory Usage: %s/%sMB (%.2f%%)\n", $3,$2,$3*100/$2 }'

# 磁盘
df -h | awk '$NF!~ / Mounted on / { print $5" "$6 }'

# 网络
cat /proc/net/dev | tail -n +3
# 或 ifconfig eth0 | grep bytes
```

**后端（Rust）职责**：
1. 通过已有 SSH 连接（`russh`）执行监控命令
2. 解析输出，提取关键指标（CPU%、Mem%、磁盘%、rx/tx B/s）
3. 定时轮询（建议 2-5 秒间隔）
4. 通过 Tauri event 推送到前端

**前端职责**：
1. 右侧面板展示仪表盘（卡片式布局）
2. CPU：总使用率大数字 + 各核迷你条形图
3. 内存：柱状图 + 已用/总量
4. 磁盘：各分区进度条
5. 网络：实时速度 + 流量折线图（趋势）
6. 进程：Top 5 进程（按 CPU/内存排序）

### 3.2 TDSF 技术可行性分析

**技术栈匹配度**：
- ✅ 已有 Rust SSH 通道（`russh`）→ 可直接复用执行监控命令
- ✅ 已有 Tauri event 系统 → 可推送指标到前端
- ✅ 已有 Zustand store → 可存监控状态
- ✅ 已有 xterm.js 终端 → 可嵌入监控面板

**Rust 侧实现路径**：
```rust
// 新增 modules/server_monitor.rs
pub struct ServerMonitor {
    ssh_session: Arc<Mutex<SshSession>>,  // 复用现有 SSH 会话
    poll_interval: Duration,              // 默认 3s
}

impl ServerMonitor {
    pub async fn collect_metrics(&self) -> Result<ServerMetrics> {
        // 通过 SSH 执行 free/cat /proc/stat/df 等命令
        // 返回结构化 metrics 数据
    }
}

// Tauri 命令：get_server_metrics(session_id) -> ServerMetrics
// Tauri event：server:metrics_updated(session_id, metrics)
```

**前端实现路径**：
```
src/modules/server-monitor/
├── types.ts          # ServerMetrics 接口
├── useServerMetrics.ts  # Zustand store + SSH event 订阅
├── ServerMonitorPanel.tsx  # 右侧监控面板组件
├── MetricCard.tsx    # 单个指标卡片（CPU/内存/磁盘/网络）
└── MetricChart.tsx   # 趋势折线图（网络/CPU）
```

**性能考量**：
- 轮询间隔 3-5 秒（避免 SSH 通道过载）
- 前端使用 `requestAnimationFrame` 平滑更新折线图
- CPU 采集用 `/proc/stat` 差值计算（非 `top` 进程树，更轻量）
- 远程命令单次执行 < 100ms，无性能风险

---

## 四、重点借鉴：本地+SSH 分屏联动

### 4.1 iShell Pro 分屏设计

- 最多 16 面板，水平/垂直自由分割
- 每个面板可独立选择：本地 Shell / SSH 终端
- 面板间共享上下文（可选）

### 4.2 TDSF 当前能力

- 已有 `PaneTreeView`（`src/modules/terminal/PaneTreeView.tsx`）
- 已有 `TerminalStack` + `TerminalPane` 架构
- SSH 终端在 `SshTerminalPane.tsx`（`src/modules/ssh-explorer/`）
- **问题**：本地终端与 SSH 终端未做统一分屏管理

### 4.3 改进方向

**短期（P2 补充）**：
- 在 WorkspaceSurface 中统一本地/SSH 终端面板树
- 支持在同一 workspace 内水平/垂直分割出本地 Shell 面板
- 快捷键分屏（类似 iTerm2：Ctrl+Shift+H 水平 / Ctrl+Shift+V 垂直）

**中期（P3）**：
- 面板间共享 cwd（终端 cd → 文件树自动跟随，已有 OSC 7 基础）
- 广播模式（同一条命令发送到所有选中的面板）

---

## 五、方案书更新建议

### 5.1 新增 P2 功能：服务器实时监控仪表盘

**模块命名**：`ServerMonitor`（P2 新增，区别于已有 `server` 概念）

**验收标准**：
1. 连接 SSH 后，右侧面板显示服务器基本信息（IP/OS/运行时间）
2. CPU 卡片：总使用率（大数字）+ 各核迷你条形图 + 趋势折线图（最近 30 秒）
3. 内存卡片：已用/总量 + buffer/cache 分离
4. 磁盘卡片：各分区使用率进度条
5. 网络卡片：实时 rx/tx 速度 + 流量趋势图
6. 进程卡片：Top 5 进程（按 CPU 或内存排序）
7. 刷新间隔可配置（2-10 秒，默认 3 秒）
8. 断开 SSH 后自动停止轮询，面板显示"未连接"

**实现计划**：
- ① Rust `server_monitor.rs`（4h）
- ② Tauri 命令 + event（1h）
- ③ 前端 `useServerMetrics.ts` store（2h）
- ④ 前端 `ServerMonitorPanel.tsx` + 卡片组件（4h）
- ⑤ 集成到 WorkspaceSurface 右侧（1h）
- ⑥ 测试 + 文档（2h）
- **合计**：约 2 天

### 5.2 新增 P3 功能：SSH 隧道管理

**背景**：iShell Pro 有 SSH 隧道一键启停 + 实时流量监控，TDSF 缺失。

**实现计划**（待用户决策是否纳入 P3）：
- Rust 侧：复用 `russh` 端口转发能力（`Channel::direct_tcpip`）
- 前端：隧道列表 UI + 启停控制

### 5.3 已有功能强化

| 功能 | 现状 | 改进建议 |
|------|------|---------|
| AI 命令生成 | Strands agent | 增加"自然语言→命令"快捷入口（类似 iShell Pro 的命令面板） |
| 代码片段 | 缺失 | P3 加入，SQLite 本地存储 + 分组标签 |
| 会话共享 | 缺失 | 参考 YourSSH 的会话共享（实时协作） |

---

## 六、技术选型参考：Tauri + sysinfo 体系

调研到以下 Tauri 系统监控开源项目可参考：

| 项目 | 技术栈 | 可借鉴点 |
|------|--------|---------|
| [sysmonitor](https://github.com/saqibzahoor-dev/sysmonitor) | Tauri 2 + Rust + sysinfo | CPU/内存/GPU 实时采集 |
| [Simple_Monitor](https://github.com/CheRongtian/Simple_Monitor) | Tauri v2 + Rust + sysinfo | 轻量监控 UI |
| [tauri2-system-monitor](https://github.com/CoderrsHandbook/tauri2-system-monitor) | Tauri 2 + React | 光晕玻璃效果 UI |
| [monitor-rs](https://juejin.cn/post/7561631375843131435) | Rust + sysinfo + ratatui | TUI 监控仪表盘 |

**关键依赖建议**：
- `sysinfo` crate：跨平台系统信息采集（CPU/内存/磁盘/网络/进程）
- `tokio` 定时轮询：`tokio::time::interval`
- 前端图表：`recharts` 或 `chart.js`（轻量，与 Tailwind 兼容）

---

## 七、总结与下一步

### 7.1 可立即采纳的改进

1. **服务器实时监控仪表盘** → P2 新增，技术可行，需 2 天
2. **本地+SSH 分屏联动** → 优化 WorkspaceSurface 布局，需 1 天
3. **命令面板增强**（Ctrl+K）→ 已有部分，可对齐 iShell Pro 体验

### 7.2 方案书更新

- 在方案书 §4.8 教学能力章节后，新增 §4.9 服务器实时监控
- 在 ROADMAP P2 中新增「服务器实时监控仪表盘」任务
- 在 ROADMAP P3 中新增「SSH 隧道管理」「代码片段」任务

### 7.3 待用户决策

- [ ] 是否立即启动 P2「服务器实时监控」？（预计 2 天）
- [ ] SSH 隧道管理是否纳入 P3？
- [ ] 代码片段功能是否纳入 P3？
- [ ] 分屏联动（本地+SSH）是否纳入 P2？

---

**参考链接**：
- iShell Pro 官网：https://ishell.cc/zh-CN
- iShell Pro 更新日志：https://www.ishell.cc/en-US/updatelog/104
- sysmonitor (Tauri 监控参考)：https://github.com/saqibzahoor-dev/sysmonitor
- Simple_Monitor (Tauri 监控参考)：https://github.com/CheRongtian/Simple_Monitor
