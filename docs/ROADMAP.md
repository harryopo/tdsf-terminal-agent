# TDSF Terminal Agent · 路线图（短/长期规划）

> **用途**：确保开发按方案书执行——长期规划对齐 `docs/方案书-v1.0.md` 的 P0-P4 路线图；短期规划 = 当前任务 + 下一步清单。
> **更新时机**：每次任务收尾（任务完成 / 方向变化 / 新决策）时更新本节，并在 `docs/DEV-JOURNAL.md` 追加复盘。

---

## 一、长期规划（方案书路线图跟踪）

| 阶段 | 内容 | 状态 | 完成记录 |
|------|------|------|---------|
| **P0** | Strands 多 agent（B 方案）/ 真流式 / 超时可配置 / 降级 UI / 补测试 | ✅ 完成 | dev-state §37.17 |
| **P0-6** | Agent 全链路：main 统一入口 + 自主委派 + 调用可视化 | ✅ 完成 | dev-state §37.18 |
| **P1** | HITL 真实审批闭环 / 会话证据链 / hash 审计链 | ✅ 完成 | dev-state §37.19 |
| **P2** | 教学闭环：Teach 结构化输出、asciicast 回放 UI、工具集扩展、决策库、资源管理器性能债 | ✅ 完成 | 翻译重构 + 知识库 + 工具集（本轮核实全部落地） |
| **P3** | 生态：Headroom MCP（需确认外部依赖）、实训沙箱（Docker）、Profile 教学配置 | ⏳ 未开始 | 需用户确认外部依赖 |
| **P4** | 单框架收敛：删除 LangGraph 遗产代码与 graph/ 目录 | ✅ 完成 | 69ec9c0（2184 行死代码删除） |

**P2 子任务核实（2026-08-01 全量工程中逐一确认）**：
- [x] Teach 结构化输出（teaching_content）→ TeachCard 渲染（TeachCard.tsx + teachParser.ts + 测试）
- [x] asciicast 录制 → 回放面板（AsciicastPanel.tsx + asciicast.ts，CastEvent 解构 bug 已修）
- [x] 工具集扩展：service_manage / package_manage / firewall_manage / security_audit / performance_analyze（strands_backend/tools/ops_extended.py）+ ssh_command / suggest_command 等共 9+ 工具
- [x] 决策库：knowledge.add_case 自动沉淀（排障成功自动入库）+ hybrid 检索（knowledge.search）+ 前端浏览（KnowledgeBrowser）
- [x] 知识库管理 UI（左侧栏浏览/搜索/详情弹窗，knowledge.list/search/get；2026-08-15 修复详情空内容：list/get 数据源割裂，统一走 rag.db）
- [x] 资源管理器性能债：上游 terax 已按目录缓存（expansionCache），无需重做

**P1 剩余核实**：
- [x] D-S 证据融合引擎（core/confidence.py：DSPCR5ConfidenceCalculator + PCR5ConflictResolver 完整实现）

---

## 二、短期规划（当前与下一步）

### 当前任务

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 1 | P2 翻译模块重构（统一选中浮层） | ✅ 已完成 | 本地/SSH 终端选词翻译 + Ask TDSF，已提交 a2aa150 |
| 2 | 审查架构项收尾（Py-H1 调研 + Rust-C3 热路径锁迁移） | ✅ 已完成 | §37.29，commit 见 git log；审查报告 41 项全部有处置结论 |
| 3 | **审查经验沉淀为开发规范**（CODE-REVIEW-LESSONS.md + CLAUDE.md v2.1 §3.5 质量红线） | ✅ 已完成 | §37.30，8 条红线 + 8 血泪案例速查表 |
| 4 | **SSH 终端输入改写修复**（方案 A：远端静默注入 OSC 7，取代前端 cd 拦截 hack） | ✅ 已完成 | §37.36，根因 = 行缓冲残留 + 元字符黑名单缺 `*`/`?`（`yum install httpd* -y` 被改写）；实测 192.168.45.130 原样透传 + 远端自动 OSC 7，commit 55dc6ce |
| 5 | **翻译卡片智能翻转定位**（底部划词 → 卡片翻转到选中点上方） | ✅ 已完成 | 根因 = 固定 `top=y+12` 底部溢出被遮；两阶段测量翻转，CDP 3 场景全过，commit cc631c1 |
| 6 | **终端中文字体无衬线化 + 主题设置合并明暗切换** | ✅ 已完成 | fonts.ts fallback 链插微软雅黑/苹方/思源黑体（英文仍 JetBrains Mono 等宽）；主题设置去分组合并 + 显示模式一键切换，commit 7323276 |
| 7 | **SSH 终端"异常输出"真相取证 + 清理 hack 残留垃圾文件** | ✅ 已完成 | §37.39，`';'`/`HTTP` 是 8月7日 hack 时代残留真文件（非渲染问题）；`ls'` 后 `>` 是 bash 正常续行；paramiko 远程 `rm -f -- '/root/;' /root/HTTP` 清理完毕，无代码改动 |
| 8 | **SSH 连接进度界面**（握手期间显示美观 5 步进度） | ✅ 已完成 | 调研真相：文件树不阻塞终端（兄弟节点并行），延迟源 = SSH connecting 数秒 + cold tab；新增 SshConnectingOverlay（TCP→握手→主机→认证→终端 5 步 amber 动画），commit ee43dde |
| 9 | **Agent 终端上下文自动注入**（每轮对话自动携带 scrollback 尾部） | ✅ 已完成 | 调研：Python Sidecar 路径 <env> 块缺终端输出 + SSH 终端不在 tabs 里→getTerminalContext 返回 null；新增 formatTerminalContextBlock(截尾部30行注入 <terminal-context>)+SSH 回退+system prompt 更新，commit 24fb81c |
| 10 | **Agent 深度进化（并发修复 + 教学 5 改进 + max_tokens + 终端执行模式 + session_id 隐藏）** | ✅ 已完成 | 并发 RLock（e1b64c2）/ 教学 UI 基于 agent id（3f562b3）/ max_tokens 2048→8192（d535e8f）/ 终端执行开关（cbc6c22）/ SSH cwd 优先（35c7377）/ session_id 移除（7816f3f）；方案文档 PLAN-AGENT-DEEP-EVOLUTION.md |

### 下一步（按优先级）

| # | 任务 | 类型 | 预估 | 依赖 |
|---|------|------|------|------|
| 1 | ~~**黑屏修复**~~ ✅ 完成：根因=terax 残留 transparent 平台配置（§37.23）+ dev 启动残留修复（§37.24） | 修复 | 中 | 无 |
| 2 | ~~**L5 打包发布验证**~~ ✅ 完成：sidecar onedir 打包 + 安装冒烟全通过（安装包 402MB，0.1.0） | 验收 | 中 | 无 |
| 3 | **实测验证**：真实 LLM 委派行为 + SSH 终端翻译/审批全链路 | 验收 | 需用户 | API key + SSH 服务器 |
| 4 | **安装版用户体验**：用户机器安装 → 黑屏确认消失 → 全功能走查 | 验收 | 需用户 | 无 |
| 5 | **dev 启动规范**（§37.24 教训）：长期进程禁管道截断；dev 误用打包 exe 时删 target/debug/sidecar | 规范 | 无 | 无 |
| 6 | ~~**WorkspaceFs 文件系统视图重构**~~ ✅ 完成：FsBackend trait + LocalFs/SftpFs + 单 store（§37.33，双根因修复：双轨竞态 + OSC 7 泄漏，CDP 10/10 稳定） | 架构 | 大 | 无 |
| 7 | **用户实测 WorkspaceFs**：创建 SSH Space → 远程树稳定无闪跳 → 断开降级横幅 | 验收 | 需用户 | 无 |
| 8 | **命令行自动补全/预测**（用户 2026-08-08 意向）：xterm 输入补全 → 命令建议（历史 + 词典 + AI），先调研 yazi/terax 做法再规划 | ✅ 已完成 | completionInjection.ts 统一注入 rendererPool（本地+SSH 通吃）：按键追踪缓冲 + 三层引擎（history/dictionary/fuzzy）+ 弹窗跟随光标（P2 #13）；2026-08-15 修复 ipp bug + 去 emoji/绿箭头/压缩间距（commit 9ec99db）；2026-08-15 升级：**集成开源 withfig/autocomplete（707 唯一命令）取代手编词典为主数据源 + 参数预测**（options -n/-y/--long、subcommands、参数值）——spec-index 静态索引 + specs.json 11MB 懒加载，构建脚本 scripts/build-fig-specs.mjs |
| 8.5 | **SSH 选中翻译链路收尾**（§37.34/37.35）：✅ 已修复并 CDP 全链路实测（根因 = 修剪 effect 误删 SSH leaf handle → live 集合纳入 sshLid + captureActiveSelection 改 rendererPool slot 直读，见 §37.35） | ✅ 完成 | 中 | 2026-08-09 |
| 9 | **窗口标题跟随修复**（遗留）：SSH Space 下标题显示本地目录名（§37.32 后仍未验证） | ✅ 已完成 | 2026-08-12；useWindowTitle 加第三参数 sshLocation，SSH Space 时标题直接显示 user@host:path（随 cd 跟随）；详见 dev-state §37.56 |
| 10 | **方案书集成度补齐**（启动验证发现的差距）：~~P1 HITL 四决策（edit/respond/trust）~~ / ~~Strands teach 字段契约（teaching_content）~~ / ~~缺 3 工具（get_terminal_output·config_diff·backup_restore）~~ / ~~决策库完善（向量检索+history 检索）~~ / ~~可信度模块接入 Strands 主路径~~ | ✅ 已完成 | 全部完成（commit a5be217 + 784252c）；HITL 四决策 + teach 清理 + 3 工具 + 可信度 + 决策库接线 |
| 18 | **SSH 终端命令补全**：接入孤儿引擎 completion.ts 到 SSH xterm（130+ Linux 命令静态表 + Trie+Frecency + Tab 拦截弹窗） | ✅ 已完成 | commit 784252c；use-ssh-completion.ts + SshCompletionPopup.tsx |
| 19 | **iShell Pro 竞品调研 + 方案书更新**：服务器实时监控（免 Agent）/ 分屏联动 / 代码片段 | ✅ 已完成 | 2026-08-09；调研文档 `docs/iShell-Pro-竞品调研.md` |
| 11 | **方案书文档同步**：§1.1"7 个工具"过时（实际 13）、§4.3 扩展表状态、§4.8 asciicast"UI 待接"标注 | ✅ 已完成 | 全部方案书集成度补齐完成（2026-08-09） |
| 20 | **服务器实时监控仪表盘（P2 新增）**：右侧面板展示 CPU/内存/磁盘/网络/进程，通过 SSH 通道免 Agent 采集，轮询 3s，断开自动停止 | ✅ 已完成 | 2026-08-11；commit 7602c73（审计 P0-P2 修复，server-monitor 全量落地）：SSH 合并命令单次往返采集 + 3s 轮询 + 连续失败 3 次自动停止 + ErrorBoundary + 28 parser 测试 + App.tsx 集成；详见 dev-state §37.52 |
| 21 | **本地+SSH 分屏联动（P2 补充）**：WorkspaceSurface 统一本地/SSH 终端面板树，支持 Ctrl+Shift+H/V 分屏 | ✅ 已完成 | 2026-08-11；per-leaf SSH 绑定（sshSessionId 三态）+ SshLeafPane 渲染 + 分屏继承，commit 84f2941，详见 dev-state §37.48 |
| 12 | **SSH 终端 cwd 同步 UI 复验**（§37.36 方案 A + §37.39 清理后）：真实挂载终端 → `cd` 后文件树跟随 + 翻译/选词未破坏 + `ll` 无垃圾文件 | 验收 | 需用户 | 连 192.168.45.130（残留已清理，新建会话即可实测） |
| 13 | **SSH 终端"续行模式"用户提示优化**（可选调研）：bash 未闭合引号进入 PS2 `>` 时，终端能否给出可辨识提示（如提示栏闪烁/标题标记），降低用户误判"终端卡死" | 功能 | 需调研 | 先调研 xterm/上游做法再定 |
| 14 | **Agent 深度进化 P0**（方案文档 `PLAN-AGENT-DEEP-EVOLUTION.md`）：max_tokens 条件传参（OpenAI 不传=无上限）/ 对话压缩增强（Sidecar 复用 compact.ts 5 级策略）/ maxMessages 20→40 | ✅ 已完成 | commit 87175dd；model_adapter.py 3 处条件传参 + transport.ts 两阶段压缩（tool-result elide + 尾部截断 40） |
| 15 | **Agent 深度进化 P1**：SSH 工具 visible 模式（ssh_command 加 visible 参数 → sidecar→前端 injectTerminal 通道 → xterm 可见执行）/ 任务完成感知 system prompt 强化 | ✅ 已完成 | commit af32091；三步链路：Python send_notification + ssh_command visible + 前端 listen sidecar:inject_terminal → injectIntoActivePty |
| 16 | **Agent 深度进化 P2**：TodoStrip 双轨联动（Sidecar 路径驱动前端 TodoStrip UI） | ✅ 已完成 | commit 3e11abc；Python todo_write.py + adapter 挂载 + system_prompt 任务规划指令 + 前端 listen sidecar:update_todos |
| 17 | **Agent 深度进化 P3**：LLM 自动摘要（long_context.py 重写为真 LLM 摘要替代 hash 模拟） | ✅ 已完成 | commit a5be217；summarize 优先调 LLM（OpenAI 兼容接口），失败回退 hash 截断；输入预处理首尾各 40% |
| 22 | **P2 代码片段管理（Snippets）**：常用命令收藏一键插入终端，标签分组 + `{{var}}` 插值 + Frecency 排序（方案书 v1.1 §5） | ✅ 已完成 | 2026-08-11；LazyStore 持久化（tdsf-snippets.json）+ dev 降级 localStorage；`src/modules/snippets/`（store 11 + 组件 6 = 17 测试），详见 dev-state §37.49 |
| 23 | **P2 SSH 隧道与端口转发**：russh direct-tcpip 本地端口转发（方案书 v1.1 §4） | ✅ 已完成 | 2026-08-11；后端 `tunnel.rs`（SshTunnel 生命周期 + direct-tcpip 双向桥接 + 隧道 registry）+ 前端 `tunnels/` 模块（TunnelPanel/CreateTunnelDialog + store + 16 测试），详见 dev-state §37.50 |
| 24 | **架构审计 P0-P3 全部收尾**（ARCHITECTURE-AUDIT-2026-08-10 23 项复核处置；唯一缺口 P2 #13 弹窗跟随光标补实现） | ✅ 已完成 | 2026-08-11；审计报告新增"修复进度跟踪"节（23 项全有证据）；P2 #13 = measureCursorPx + computePopupPosition（13 测试），详见 dev-state §37.51 |
| 25 | **SSH 隧道 P3**：远程转发（`tcpip_forward`）+ SOCKS5 动态转发（参考 chisel-rs） | ✅ 已完成 | 2026-08-12；后端 `TunnelKind` 三模式 + handler `server_channel_open_forwarded_tcpip` 回调 + `REMOTE_TUNNEL_REGISTRY` + SOCKS5 纯函数实现；前端创建对话框三套表单 + 类型 badge；方案 `docs/P3-SSH隧道-远程转发与SOCKS5-实施方案.md`，详见 dev-state §37.55 |
| 26 | **全面代码审查修复**（2026-08-18 审查 §37.62：P0×2/P1×8/P2×6/P3×3）——修复项由用户选择：P0 知识库 _add 写旧库割裂 + steer 总线取错；P1 SSH 超时/占位事件/TOFU 断链/disconnect/fatalError/密码泄漏/预测缓冲；P2 prevToken/JSON-RPC 静默/exec 无上限/密钥锁/CSP | ✅ 已完成 | 2026-08-18；17 项全修 + 全绿门禁（clippy 0 警告 / cargo test / 168 pytest / 994 vitest / tsc / lint / build）；详见 dev-state §37.63；P2-15 CSP 验证为功能必需保持；P3-17 lint 豁免 19 处验证为合理保持 + TODO 已清零 + loader.ts 补加载断言 |
| 27 | **知识库 UI 三修**（2026-08-18 用户反馈）：① 详情弹窗完整 md 渲染（MessageResponse）；② 列表预览去 markdown 符号只显标题；③ 侧边栏视图标签英文化（知识库→Knowledge/片段→Snippets/隧道→Tunnels，与 Files 一致） | ✅ 已完成 | 2026-08-18；`KnowledgeBrowser.tsx`/`SidebarRail.tsx`/`TunnelPanel.tsx`/`SnippetsPanel.tsx`；全绿门禁（994 vitest + tsc + lint + build）；详见 dev-state §37.64 |
| 28 | **换机重装环境重建 + 全量门禁恢复**（新机器 d:\ai\linux教学一体\）：Rust 1.98 工具链 + sidecar 依赖补齐（langgraph/bs4）+ `启动.bat`（TDSF_SIDECAR_PYTHON 指向 .venv）+ pytest 环境变量三件套（TDSF_DATA_DIR=Temp 绕沙箱 chroma 拦截/CUDA_VISIBLE_DEVICES=-1/PYTHONPYCACHEPREFIX） | ✅ 已完成 | 2026-08-28；全量门禁：typecheck/lint/build/vitest 993 ✓ + cargo test 327 全绿 ✓ + **pytest 1433 passed in 60s** ✓；修复既有 5 失败（needs_you 6→8 / long_context 3 处语义 / toolset 17→23）；symlink 测试改运行时跳过（沙箱 hook CreateSymbolicLink）；tauri:dev 沙箱无法启动 GUI，须用户真实终端 `启动.bat`；详见 dev-state §37.65 |

### 待用户决策/确认

- [ ] Headroom MCP 是否引入（外部依赖，P3）
- [ ] 实训沙箱（Docker 故障环境）是否纳入（P3）
- [ ] 真实 LLM 委派效果实测反馈（决定 _MAIN_SUB_AGENT_PROMPT 是否需要调优）
- [ ] AI 入口 3 优化点（用户暂缓，2026-08-11 调查闭环后遗留）：① 无 OpenAI key 时隐藏麦克风按钮（避免"语音已开启"误导）；② Ctrl+I 精简为单入口（当前 toggleMini + focusInput 同开小窗+底部输入条）；③ 启动首帧不聚焦输入框。改前先按 37.54 调查结论评估
- [x] ~~方案书集成度补齐的优先级~~（#6 已全部完成，2026-08-09）

---

## 三、原则（确保按方案执行）

1. 新任务先对照方案书：属于哪个阶段、对应哪条路线，不在路线图内的功能需用户确认再加
2. 任务收尾三件事（强制）：① git commit（全绿门禁）→ ② `docs/DEV-JOURNAL.md` 追加复盘（任务/方案/报错/修改/经验）→ ③ 更新本文件 + `docs/dev-state.md`
3. 报错与修改必须沉淀到 journal（根因 + 解法），防止重复踩坑
4. 门禁：后端 pytest / 前端 vitest / tsc / eslint / cargo check 全绿才算完成
