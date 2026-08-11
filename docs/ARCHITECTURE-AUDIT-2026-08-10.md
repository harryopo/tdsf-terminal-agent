# TDSF Terminal Agent — 全系统深度架构审计报告

> **审计日期**：2026-08-10
> **审计范围**：全部核心模块（13 个子系统、70+ 文件）
> **审计方法**：静态代码深度审计（逐文件阅读 + grep 验证 + 调用链追踪 + 架构风险评估）
> **审计目的**：区分"真实落地"vs"应付展示"，识别补丁代码，为开源做准备

---

## 一、总览矩阵

| 模块 | 质量评分 | 落地判定 | 核心问题数 | 备注 |
|------|----------|----------|------------|------|
| **SSH 远程管理** | A− | ✅ 真实落地 | 3 中 + 5 低 | 全链路可用，非 UI 壳 |
| **AI Agent + Sidecar** | A− | ✅ 真实落地 | 2 中 + 3 低 | Strands 完整集成，20+ 工具 |
| **本地终端（PTY/xterm）** | A | ✅ 真实落地 | 1 低 | 5-slot 实例池 + OSC 7/133 |
| **文件资源管理器** | A− | ✅ 真实落地 | 1 低 | 本地 + SFTP 远程双路径 |
| **离线选词翻译** | A | ✅ 真实落地 | 0 | 2279 条词典 + 七级查询 |
| **主题系统** | A− | ✅ 真实落地 | 2 低 | 15 主题 + 无限渲染已修复 |
| **工作区/空间管理** | B+ | ✅ 真实落地 | 2 低 | LazyStore 持久化 |
| **窗口/启动链** | B+ | ✅ 真实落地 | 2 中 | 黑屏已根治，文档漂移 |
| **代码编辑器** | B+ | ✅ 真实落地 | 1 中 | CodeMirror（非文档说的 Monaco） |
| **服务器监控仪表盘** | B− | ⚠️ 基本落地，有应付痕迹 | 2 高 + 4 中 | 虚假声称有测试 |
| **终端命令预测** | C+ | ⚠️ 半落地，核心功能不可用 | 2 高 + 3 中 | 提示符污染致命 bug |

### 统计

- **真实落地模块**：9/11（82%）
- **有问题的模块**：2/11（18%）— 服务器监控 + 命令预测
- **致命 bug**：3 个（均在最新开发的两个模块中）
- **死代码文件**：5 个（命令预测模块遗留）

---

## 二、真实落地的模块（9 个）

### 2.1 SSH 远程管理 — A−

**证据链**：
- russh TCP→KEX→认证→PTY→SFTP→exec 全链路代码完整
- 锁选择正确（tokio::sync::Mutex 跨 await / std::sync::RwLock 原子读写）
- russh Handle 不可 Clone 问题用 `Arc<Mutex<Option<Handle>>>` + 锁最小化解决
- TOFU 主机验证完整（randomart 指纹 + 5min 审批超时 + known_hosts 兼容）
- 凭据持久化（JSON + keyring 双层）
- 无静默吞错，错误推送前端

**风险**：
| 问题 | 严重性 | 建议 |
|------|--------|------|
| `inactivity_timeout: 30s` 对交互式终端太短 | **高** | 改为 300s 或移除 |
| `SshSession.host/port/user` 空字符串占位 | 中 | 连接成功后填充 |
| 无 Rust 集成测试 | 中 | 用 mock SSH server 补测试 |

---

### 2.2 AI Agent + Sidecar — A−

**证据链**：
- Python sidecar ↔ Rust 双向 JSON-RPC 2.0 协议（非 stub）
- SidecarManager 指数退避重启（1s→2s→4s→…→60s）+ MAX_RETRY=5 + 60s 运行冷却
- Strands Agent 完整适配层（1549 行），5 个真实 Agent（main/explore/teach/coding/history）
- 20+ 运维工具（ssh_command 含风险检测 + 审批、sftp 系列、日志分析、进程检查等）
- 工具白名单 schema-level safety（explore agent 无 ssh_command 权限）
- agent-as-tool 子 agent 委派 + 事件转发
- LLM 支持 OpenAI/Anthropic/LiteLLM（兼容 DeepSeek/Ollama/OneAPI）

**风险**：
| 问题 | 严重性 | 建议 |
|------|--------|------|
| Sidecar 路径是"伪流式"（同步返回后切片） | **中** | 改为 generator/yield 真流式 |
| `_agent_locks` 字典无限增长 | 低 | clear_cache 时同步清理 |

---

### 2.3 本地终端 — A

**证据链**：
- portable-pty PTY 创建 + Channel<T> 双向数据流
- rendererPool 5-slot xterm 实例池（复用 + 序列化快照 + WebGL canvas 回收）
- ResizeObserver 防抖 fit（8ms）+ PTY resize 防抖（256ms）
- OSC 7（cwd 同步）+ OSC 133（shell prompt 标记）完整解析
- 基于 OSC 133 的命令块划分（block 子模块）
- 教学触发（teach-trigger）联动

**风险**：无显著风险。

---

### 2.4 文件资源管理器 — A−

**证据链**：
- 本地：完整 CRUD + 懒加载 + fs watcher + Git 状态 + 拖放
- 远程（SFTP）：与本地 API 完全一致，FileExplorer 无缝切换
- 展开缓存 LRU（8 个根目录）+ sameDirListing 去抖

---

### 2.5 离线选词翻译 — A

**证据链**：
- 2279 条词典（1911 command + 250 option + 33 error + 85 term）
- 七级查询策略链（路径→选项→短语→命令→短语贪心→单词→复合词拆分）
- ECDICT 词形还原（复数→单数、过去式→原形）
- 零网络依赖，纯本地
- 测试齐全（4 个测试文件）

---

### 2.6 主题系统 — A−

**证据链**：
- 15 个内置主题完整注册
- 自定义主题保存/加载/变更监听
- useThemeFileEditing 无限渲染问题已修复
- 主题校验（validateTheme + 测试）

---

### 2.7 工作区/空间管理 — B+

**证据链**：
- Tauri LazyStore 持久化（autoSave 500ms）
- 序列化/反序列化 + 启动加载
- SpaceMeta（id/name/root/env/color）完整管理

---

### 2.8 窗口/启动链 — B+

**证据链**：
- 黑屏问题已根治（visible:true + Rust setup show + CSS 不透明兜底）
- 权限配置完整（show/focus/center/dragging/event 等，含历史教训注释）
- sidecar 启动 + PTY 清理 + settings 窗口僵尸标签处理

**风险**：
| 问题 | 严重性 | 建议 |
|------|--------|------|
| 文档与代码漂移（CLAUDE.md 说 visible:false + decorations:false） | **中** | 更新文档 |
| 主窗口缺少 decorations:false/transparent:true 配置 | 中 | 确认是否需要恢复无边框 |

---

### 2.9 代码编辑器 — B+

**证据链**：
- CodeMirror 6 完整集成（语法高亮 + Vim 模式 + LSP + AI diff + Git diff）
- 文件保存链路完整（外部写入/diff/watch 同步）

**风险**：
| 问题 | 严重性 | 建议 |
|------|--------|------|
| CLAUDE.md 说 Monaco 但实际用 CodeMirror | **中** | 更新文档 |
| Monaco 依赖仍留在 package.json | 中 | 验证是否可移除 |

---

## 三、有问题的模块（2 个）

### 3.1 服务器监控仪表盘 — B−（80% 落地 + 20% 应付痕迹）

#### 落地的部分 ✅
- 采集命令能在真实 Linux 运行（标准 POSIX 命令）
- CPU/网络差值法公式正确
- 6 条命令合并为一次 SSH 往返（真实优化）
- 失败 3 次停止 + 会话断开清理 + 间隔切换清理
- UI 卡片设计精致 + CSS 变量主题适配

#### 应付的部分 ❌
| # | 问题 | 严重性 | 详情 |
|---|------|--------|------|
| **P1** | parser.ts 注释虚假声称有 `parser.test.ts` | 🔴 高 | 实际零测试文件 |
| **U1** | `lastCollectTime` 死字段 | 🔴 高 | 接口定义了精确间隔但从未写入，网络速率偏低 ~40% |
| **U2** | 并发请求无锁 | 🔴 高 | SSH 慢时 setInterval 堆积多个并发命令 |
| **M1** | 无 React Error Boundary | 🟡 中 | 远端畸形数据导致面板白屏 |
| **T1** | `setServerMonitorInterval` 缺校验 | 🟡 中 | 同类 setter 都有 clamp |
| **T2** | `serverMonitorWidth` 设置无 UI 控件 | 🟡 中 | store 接了一半 |

---

### 3.2 终端命令预测 — C+（引擎真实但集成层致命缺陷）

#### 引擎层是真实的 ✅
- suggest-engine 三层算法正确（fish 历史 → 字典精确 → fuzzysort）
- fuzzysort v4.0.0 确认安装
- 127 条命令字典（含中文翻译）

#### 致命缺陷 ❌
| # | 问题 | 严重性 | 详情 |
|---|------|--------|------|
| **C1** | getCurrentPrefix 不剥离提示符 | 🔴 **致命** | 提取 `root@server:~$ ls` 而非 `ls` → 弹窗永不出现 |
| **C2** | loadHistoryIfNeeded 从未被调用 + Rust 命令未注册 | 🔴 **致命** | 历史匹配层(L1)永远为空 |
| **C3** | Enter 键不 acceptPrediction | 🟠 高 | 选中预测后按 Enter，预测被丢弃 |
| **C4** | fuzzysort threshold:0.3 语义存疑 | 🟠 中 | 若 v4 用负数分数，fuzzy 层永远返回空 |
| **C5** | suggest-engine 零测试 | 🟡 中 | 实际使用的引擎无测试保护 |
| **C6** | 5 个死代码文件（42% 文件率） | 🟡 中 | use-ssh-completion / SshCompletionPopup / completion / use-completion / shell-history 半孤儿 |

---

## 四、文档与代码漂移清单

| 文档位置 | 描述 | 实际 |
|----------|------|------|
| CLAUDE.md §1 技术栈 | 编辑器 = Monaco | CodeMirror 6 |
| CLAUDE.md §2 架构地图 | visible:false | visible:true |
| CLAUDE.md §2 架构地图 | windows.conf: decorations:false transparent:true | 不存在 |
| CLAUDE.md §1 技术栈 | 16 内置主题 | 15 个 |
| ThemeProvider.tsx 注释 | "不集成 CodeMirror" | 已集成且有 cmThemes.ts |
| dev-state.md §37.46 | SSH 补全"复用 completion.ts" | 实际用 suggest-engine |
| ROADMAP #18 | "接入孤儿引擎 completion.ts" | 实际用 suggest-engine |

---

## 五、改进路线图（按优先级）

### P0 — 致命修复（功能不可用）

| # | 任务 | 模块 | 预估 |
|---|------|------|------|
| 1 | **修复 getCurrentPrefix 提示符污染** — 用 OSC 133 标记或正则剥离提示符 | 命令预测 | 核心 |
| 2 | **注册 read_shell_history Rust 命令** + 调用 loadHistoryIfNeeded | 命令预测 | 核心 |
| 3 | **修复 Enter 键 acceptPrediction 逻辑** | 命令预测 | 小 |
| 4 | **验证 fuzzysort v4 threshold 语义** | 命令预测 | 调研 |

### P1 — 高优先级（精度 + 稳定性）

| # | 任务 | 模块 |
|---|------|------|
| 5 | 写 lastCollectTime 真实值，修复网络速率精度 | 服务器监控 |
| 6 | 加 isCollecting 锁防并发请求堆积 | 服务器监控 |
| 7 | 包裹 Error Boundary 防远端畸形数据白屏 | 服务器监控 |
| 8 | 补 parser.test.ts 单元测试（或删虚假注释） | 服务器监控 |
| 9 | 补 suggest-engine.test.ts 测试 | 命令预测 |
| 10 | 调大 SSH inactivity_timeout（30s → 300s） | SSH |

### P2 — 中优先级（打磨 + 清理）

| # | 任务 | 模块 |
|---|------|------|
| 11 | 清理 5 个死代码文件 | 命令预测 |
| 12 | 统一引擎（suggest-engine + completion.ts Frecency 合并） | 命令预测 |
| 13 | 弹窗跟随终端光标定位 | 命令预测 |
| 14 | setServerMonitorInterval 加 clamp | 服务器监控 |
| 15 | serverMonitorWidth 补 UI 控件或移除 | 服务器监控 |
| 16 | CPU 计算加 iowait 对齐 top/htop | 服务器监控 |
| 17 | Sidecar 改为真流式输出 | AI 引擎 |
| 18 | 更新 CLAUDE.md + ThemeProvider 文档 | 全局 |

### P3 — 低优先级

| # | 任务 | 模块 |
|---|------|------|
| 19 | 清理 Monaco 依赖（验证是否可移除） | 编辑器 |
| 20 | SSH 自动重连（SshSessionState::Reconnecting） | SSH |
| 21 | SSH Rust 集成测试（mock SSH server） | SSH |
| 22 | _agent_locks 字典清理 | AI 引擎 |
| 23 | collectOverview catch 加日志 | 服务器监控 |

---

### 修复进度跟踪（2026-08-11 复核）

| # | 状态 | 证据 |
|---|------|------|
| P0 #1-#4 | ✅ 已修复 | `completionInjection.ts` P0 重写（按键追踪缓冲区替代 getCurrentPrefix；Enter 接受选中项；threshold 0.3）+ `shell_history.rs` 注册 `read_shell_history`（lib.rs:397） |
| P1 #5-#9 | ✅ 已修复 | `useServerMetrics.ts` lastCollectTime 真实值（:225）+ isCollectingRef 锁（:193）+ `MonitorErrorBoundary`；`parser.test.ts`、`suggest-engine.test.ts` 已存在 |
| P1 #10 | ✅ 已修复 | `client.rs:155` `inactivity_timeout: 300s` |
| P2 #11 | ✅ 已修复 | use-ssh-completion / SshCompletionPopup / use-completion / 独立 completion.ts 已删除（grep 无引用） |
| P2 #12 | ✅ 已修复 | 统一走 suggest-engine（completionInjection 单一入口） |
| P2 #13 | ✅ 已修复 | `measureCursorPx`（.xterm-screen ÷ cols/rows 换算像素，不用私有 API）+ `computePopupPosition`（视口边界/上下翻转），TerminalCompletionPopup 光标模式 + 面板回退；13 个单测 |
| P2 #14 | ✅ 已修复 | `store.ts` `coerceServerMonitorInterval` 白名单 clamp |
| P2 #15 | ✅ 已修复 | serverMonitorWidth 已移除（grep 无命中） |
| P2 #16 | ✅ 已修复 | `parser.ts` idle + iowait 视为非忙碌（对齐 top/htop/node_exporter）+ 单测 |
| P2 #17 | ✅ 已覆盖 | P0-2 真流式（Strands event_bus 事件流主路径，dev-state §37.17） |
| P2 #18 | ✅ 已修复 | CLAUDE.md §1 技术栈已改 CodeMirror 6；ThemeProvider 注释已更新 |
| P3 #19 | ✅ 已修复 | package.json 无 monaco 依赖（仅 @uiw/react-codemirror） |
| P3 #20 | ✅ 已修复 | `session.rs` SshSessionState::Reconnecting + 单测（:1512） |
| P3 #21 | ✅ 已修复 | `tests/ssh_integration.rs` mock SSH server 全链路（connect→open_pty→exec→write_data→close + 认证失败） |
| P3 #22 | ✅ 已修复 | `adapter.py:1496` clear_cache 一并 `_agent_locks.clear()` |
| P3 #23 | ✅ 已修复 | `useServerMetrics.ts:273` collectOverview catch 加 console.warn |

> **结论**：审计报告 P0-P3 全部 23 项均有处置结论与落地证据，无剩余未修复项。

---

## 六、开源准备评估

### 可开源的模块（质量达标）

- SSH 远程管理（A−）
- AI Agent + Sidecar（A−）
- 本地终端（A）
- 文件资源管理器（A−）
- 离线选词翻译（A）
- 主题系统（A−）
- 工作区管理（B+）

### 需修复后才可开源的模块

| 模块 | 必须修复的问题 | 工作量 |
|------|---------------|--------|
| 服务器监控 | 补测试 / 修死字段 / 加 Error Boundary | P1 级 |
| 命令预测 | 修提示符污染 / 修历史加载 / 修 Enter / 清死代码 | P0 级 |
| 窗口启动 | 文档同步 | P2 级 |
| 代码编辑器 | 文档同步（Monaco → CodeMirror） | P2 级 |

### 开源前必须完成

1. 修复 P0 全部（命令预测功能不可用）
2. 修复 P1 #5-#9（服务器监控精度 + 测试）
3. 文档全面同步（CLAUDE.md + dev-state + ROADMAP）
4. 清理死代码（5 个文件）
5. 全量五绿门禁通过

---

## 七、方法论总结

### 什么是"真实落地"的判定标准

1. **有完整的调用链**（从 UI 到 Rust/Python 后端闭环）
2. **有错误处理**（不是静默吞错）
3. **有测试保护**（至少核心逻辑有单元测试）
4. **能在真实环境运行**（不是只适配 mock 数据）
5. **文档与代码一致**

### 什么是"应付展示"的特征

1. 注释声称有测试但实际不存在
2. 定义了接口/字段但从未写入实际值（死字段）
3. 有 UI 但后端链路断裂（如 Rust 命令未注册）
4. 核心逻辑有致命 bug 导致功能不可用（如提示符污染）
5. 大量死代码未清理

---

> **文档归档位置**：`docs/ARCHITECTURE-AUDIT-2026-08-10.md`
> **下次审计建议**：每次大版本发布前重新审计，重点关注 P0/P1 修复完成情况
