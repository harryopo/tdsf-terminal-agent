# TDSF Terminal Agent · 路线图（短/长期规划）

> **用途**：确保开发按方案书执行——长期规划对齐 `docs/方案书-v2.0.md`（最终版唯一准绳，M0-M4 里程碑）；短期规划 = 当前任务 + 下一步清单。
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
| 11 | **应用图标重绘**（用户拍板魔改 terax 图标：灰底 + 箭头缩小 + 光标加大 + 清晰度锐化） | ✅ 已完成 | §37.71，commit 7ea738b；源图脚本化 `scripts/make-app-icon.py`（4x 超采样），`pnpm tauri icon` 重生成全套，删除未用 ios/android 产物 |

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
| 29 | **第三轮全面审查 + P0/P1/功能缺陷 14 项修复**（4 并行代理审查：前端/Rust/Python/功能对照）：P0 tunnel select! panic + project_service 部分更新清空 metadata；P1 僵尸重连/restart_loop 一次性/health task 泄漏/凭据竞态/**DefaultRustBridge 缺 send_notification（TodoStrip+终端注入静默失效）**/config_diff 恒真/backup_restore 注入+假成功/重 IO 阻塞主循环/AiComposerProvider 重渲染；功能 server-monitor 失败不停 + Teach 契约对齐；P2×13 未修留档 | ✅ 已完成 | 2026-08-28；门禁：cargo test 327+25+27+1 ✓ / pytest 1455 ✓ / vitest 994 + tsc + lint + build ✓；误报澄清：add_case 自动沉淀已接线（_auto_sink_case）；详见 dev-state §37.68 |
| 30 | **命令预测四修 + shell 别名数据集**（2026-08-28 用户实测反馈：英文描述/模糊排最前/无效命令/不分 Win-Linux + `ll` 预测成 ollama）：① windows/linux 环境分流（setLeafEnvironment 按 s.remote 注册，命令集+历史双隔离）；② tldr-pages 中文数据集成（tldr-zh.ts 生成器）；③ 精确匹配收集全命中按长度差升序（取代 startsWith 短路）；④ fuzzy 阈值 0.6 + 首字符一致约束；⑤ 新建 shell-aliases.ts 47 条别名（ll/gs/gst 等，中文解释含展开命令）并入预测集 | ✅ 已完成 | 2026-08-28；commits 32a6f79 + be6d54c + a060e9e；详见 DEV-JOURNAL §37.69/§37.70；**待用户实测**：本地终端输 `get-c`（应弹 Get-ChildItem）+ SSH 输 `lsb`（应弹 lsblk 中文）+ `ll`（应弹别名） |
| 31 | **竞品源码分析 + 开源生态全景调研**（用户指定 Chaterm/nyaterm/Netcatty 三项目 clone 全量分析 + 30+ 项目联网调研）：Chaterm=GPL-3.0 AI 内核改编 Cline（ghost text/CMD 卡片/交互检测器/防伪造提示）；nyaterm=MIT **同栈 Tauri2+React19+Rust**（AI 脱敏/三壳命令捕获/搜索/高亮）；Netcatty=GPL-3.0 工程化最强（AgentRuntime token 治理/known-hosts 转正/ssh_config 导入）；全景 30+（sshx 教学广播/Girus 实训校验/shell_gpt 三选一范式等） | ✅ 已完成 | 2026-08-28；源码+分析报告在 opensource-reference/（ANALYSIS-Chaterm.md、ANALYSIS-nyaterm-Netcatty.md）；综合对比+借鉴规划+分期提议见 `docs/开源AI运维终端-竞品对比与借鉴规划.md`；方案书新增 §8；**功能差距 20 项按 B1-B4 分期待拍板** |
| 32 | **carapace 参数预测全链路**（spec `.trae/specs/add-carapace-param-completion/` 批准后实施）：①Rust `param_complete`（spawn carapace export JSON，500ms kill_on_drop，控制字符防注入，永不 Err）+ `carapace_linux_path`/`sftp_upload_file`（80MB 不经 IPC）；②前端环境分流（windows→本地 carapace / linux→远端 exec→回退 Fig specs）+ **cwd 上下文**（本地 OSC7 注册表 + 远端 `cd '<cwd>' &&` 前缀——git 分支按目录取数据）；③SSH 一键安装（mkdir→sftp 上传→chmod+验证，无弹窗设计：连接后静默检测+工具栏图标+设置开关）；④tldr-zh 选项级中文（168 命令/1291 选项，`{{[-a|--all]}}` 占位符解析） | ✅ 已完成 | 2026-08-28；commits 0f66a72+7fd79a3+ad2b6f6+bbed100；门禁：tsc/lint 0 + vitest **1046**(+58) + build:web + cargo 全量（target-test 隔离）；二进制 155MB 不入 git，`scripts/fetch-carapace.ps1` 一键恢复；**待实测**：本地 `git checkout t` 弹分支 / SSH 装远端后弹远端分支 / 未装回退静态中文 |
| 33 | **预测第一轮：假预测根治 + 尾部弹参数 + 缩写表**（用户实测反馈：ag/adb/ansible-doc 假预测 / ls 没有 -l / 输完 ls 不弹参数 / ip a 没预测）：①fetchRemoteCommands——SSH 连接后 `compgen -c` 拉远端命令全集（会话级缓存），命令名候选过滤（history 豁免、降级无损）；②tldr-params.ts——TLDR_ZH_OPTIONS 接入参数层补基础命令缺口（**实测 Fig specs 和 carapace 都不含 ls/ip/systemctl**）；③尾部触发——单 token 已知命令无空格也并行走参数层（命令候选先展示+参数异步追加）；④command-abbrevs.ts 24 条缩写（ip a=address/systemctl s=status）；⑤修 addHistory env 泄漏 bug。**补丁（§37.74，用户二轮实测：输 ag 弹 -l 且 → 覆盖命令 / 历史污染还在）**：参数层加远端存在性门禁（tldr/Fig 源受 gate）+ 尾部触发抽 shouldTriggerTailParams 双门禁（linux=远端命令集 / windows=词典）+ **历史止血**（停 Enter 即记+接受即记，收敛到 windows shell history 文件注入）。**第二轮（已拍板）**：历史换集成方式——session.rs 注入扩展发 OSC 133;D;exit+命令行，只记执行成功的命令 | ✅ 已完成（用户确认"预测模块没有大问题"） | 2026-08-28；commits 8d18f33 + 083feba（+761/+96 行）；tsc/lint 0 + vitest **1088**；关键事实：Fig specs 与 carapace 均无基础命令 completer，tldr-zh-options 是唯一覆盖源；详见 DEV-JOURNAL §37.73/§37.74 |
| 34 | **AI 配置国产化与现代化**（spec `.trae/specs/add-domestic-first-ai-config/`，用户诉求：国产为主/默认非旧 GPT/自动补全语义/语音本地）：①默认 deepseek-v4-flash + provider 扩 zhipu/qwen(百炼)/moonshot/doubao 四家国产优先排序（zhipu keyPrefix null 修 key 校验误拒）；②GLM-5.3(-Flash)/Kimi K3 条目（2026-08 快照定价）+ 旧条目 [legacy] 保留；③Python PROVIDER_DEFAULT_BASE_URLS + _OPENAI_COMPATIBLE_PROVIDERS（新 id 静默走 OpenAIModel）；④UI：自动补全作用域说明（编辑器专用，终端预测零大模型）+ Ollama 推荐模型名 | ✅ 已完成 | 2026-08-28；commit 06edce5（+1767 行）；门禁：tsc/lint 0 + vitest **1125** + pytest 55；**待实测**：设置页默认 DeepSeek / 智谱 key 对话 / Ollama 对话 |
| 35 | **语音输入整体移除 + 自动补全默认 DeepSeek**（用户钦定三连：补全用 DeepSeek / 作用域=仅编辑器内联 / 砍语音）：①删 useWhisperRecording.ts + stt.ts + composer 麦克风按钮 + 转录状态行 + ModelsSection VoiceBlock + Preferences 三 STT 偏好 + SttProvider 类型（-625 行，含两处测试同步删）；②autocompleteProvider 默认 cerebras→deepseek（deepseek-v4-flash），调用链 provider.ts→buildLanguageModel→case "deepseek" 实测存在；③DeepSeek 不在"添加供应商"菜单 = 已配置过 key 转「已配置区」展示，非 bug | ✅ 已完成 | 2026-08-28；commit 6205311；门禁：tsc/lint 0 + vitest 1122 + build:web；**待实测**：编辑器内联补全走 DeepSeek（需 DeepSeek key）/ 全应用无麦克风与语音设置残留 |
| 36 | **B1 Agent 安全基座**（spec `.trae/specs/add-b1-agent-safety-baseline/`，竞品借鉴分期 B1 落地）：①T1 防伪造——main_agent/strands 系统提示 Security honesty 条款 + lastBlockedCommand 注入上下文（AI 如实报告命令未执行）；②T2 脱敏强化——前端 redact.ts + Python _redact.py 双侧同源新增 3 组正则（私钥块/Authorization 头/数据库连接串）；③T3 终端搜索——terminal-search-store + TerminalSearchBar（SearchAddon：大小写/上下查找/高亮）+ terminal.find 快捷键 Ctrl+Shift+F；④T4 失败块"AI 解释"——errorExplainStore + ErrorExplainCard（手动触发 teach agent 轻量模式流式解释）+ teach_agent explain-error 指令（纯文本禁 6 板块格式）；⑤T5 F0 断链修复——get_terminal_scrollback Rust oneshot 往返通道（emit 事件→前端 getTerminalContext→sidecar_scrollback_response 回传） | ✅ 已完成 | 2026-08-28；门禁全绿：tsc/lint 0 + vitest **1136**(+14) + build:web + pytest **1480**(+1 修复 test_long_context 环境隔离) + cargo test（target-test 隔离）；详见 DEV-JOURNAL §37.77；**待实测**：Ctrl+Shift+F 搜索 / 拦截后问 AI 如实回答 / 失败块 AI 解释 |
| 37 | **用户实测四修**（2026-08-28 用户反馈：预测回车/tab 命名/SSH 入口/WSL 工作区）：①P1 预测回车透传——Enter 永远原样执行已敲入内容（推翻 P0-3"弹窗可见时 Enter 接受预测"），仅 → / 鼠标点击接受预测（completionInjection.ts 一处改，本地+SSH 双端生效）；②P2 tab 命名——terminalTitleForSpace：本地新建=terminal / SSH=shell / WSL=shell，bindTabToSshSpace customTitle 改固定 "shell"（防 cd 漂移）；③P3 SSH 入口收敛——NewTabMenu showLocalExtras 隐 Blocks/Privacy/Editor/GitGraph + 命令面板 5 条目 hidden；④P4 远程新建文件——SftpFs ensure_parent_dirs（mkdir -p 语义）+ 失败 toast + SSH 判定同源；⑤P5 WSL 工作区——左下角下拉加 SSH Server... + pending 态，欢迎页/新建工作区对话框加 WSL（发行版下拉+root=null 落 WSL home），WSL leaf 预测按 linux 命令集，Rust cached_wsl_probe（home+login shell 合并一次 wsl.exe 往返 + per-distro 缓存）流畅化 | ✅ 已完成 | 2026-08-28；门禁全绿：tsc/lint 0 + vitest **1137** + build:web + cargo test（隔离）；terax-icon.png 旧素材删除（103d77d）；详见 DEV-JOURNAL §37.78；**待实测**：Enter 透传/→ 接受、tab 命名、SSH 菜单只剩 Terminal/Agents、SSH 新建多级路径文件、WSL 二次切换变快 |
| 38 | **Agent 能力升级（方案书 v3.0，`docs/agent/方案书-v3.0-Agent能力升级.md`）**：P0=SKILL.md 技能包体系（T1）+ 工具三角色解耦（T2）+ fail-closed 审批门禁（T3）+ 债务清理（T4）；P1=事件源会话日志（T5）+ 回放 UI（T6）+ token 计量（T7）；P2=task 动态 subagent（T9）+ SSH pty_session 受控交互（T10，⚠️红线 9）+ 可视化三件套（T11）+ 双路径收敛第一步（T12）；P3=MCP 客户端（T13）+ 会话记忆沉淀（T14，与 B3 /summary-to-skill 合并设计）。配套：`docs/agent/` 资料归档中心（INDEX + 调研报告 + 外部资料 11 份 + idea-to-dev 46 份） | ✅ **P0 全四项 + P3-T14 完成 + v3.1 三模式信任体系完成**（P1/P2 待启动；T13 需 MCPClient 调研） | 2026-08-28 拍板：P0 起步 T1 先行 / 删遗产 / P3 纳入近期。**P0 落地**：T1=triggers/allowed-tools 解析+7 内置技能+热重载；T2=TOOL_REGISTRY 19 工具单一真源+make_all_ops_tools 注册表驱动；T3=fail-closed 核实+回归测试；T4=byoa/+3 脚本/runtime.tsx 已删。**T14 落地**（2026-08-29，commit a2ecb2a）：session_memory.py 幂等写 RAG + save_skill 入 TOOL_REGISTRY + chatStore 收尾钩子 + transport.ts `<session-memory>` 注入。**v3.1 三模式落地**（2026-08-29，spec `add-agent-trust-modes`，commit c671fef，69 文件 +8234）：观察/确认/自动三模式（decide 矩阵 + observe schema 级隔离）+ **BREAKING 删 4 子 agent 委派**（工具集 24→20）+ 教学皮肤 + 审批卡四层/三按钮/双轨反馈/host 校验/5min 超时 + command_impact 拆解器 + 免确认记忆三级（deny 硬底线不可绕）+ SSH OSC133/633 终端感知 block 流水账 + `<environment>`/`<terminal-history>` + human_type Weibull 打字机（0.2-5×+打断）；门禁：pytest **1651** / vitest **1187** / cargo test 407 / tsc / lint / build:web / cargo check 全绿；spec+checklist 在 `.trae/specs/add-agent-trust-modes/`（⏳ 桌面交互实测待用户）；详见 DEV-JOURNAL §37.81 |
| 39 | **UI 三修（两轮）**（2026-08-31 用户反馈，细节见 DEV-JOURNAL §37.87）：**一轮**（a990289）=①BackendPill Strands 弹窗改 `bg-popover` 跟随明暗主题（根因=shadcn tooltip 默认反色）+ 描述精简；②AgentModeSwitcher 改折叠面板；③WorkspaceEnvSelector 删 SSH 齿轮 + 删 Refresh（打开菜单自动刷新 WSL 列表补功能）。**二轮**（e7cde62，用户实测四问）=①模式显示去重（删 AiComposerInput 并列 AgentStatusPill）；②弹层改 **Portal+fixed** 根治遮盖；③**移除假 agents_count**（sidecar.health 该字段来自 LangGraph fallback AGENT_REGISTRY，Strands 激活时是误导数据，用户质疑属实）；④tooltip flex-col 修标题/副行基线错位；⑤模式卡片复刻用户参考图（✓勾+彩色图标+名称+右侧灰色 brief 简短说明，registry META 加 brief 字段）；⑥StatusBar [Agent 模式][Strands] 位置互换 | ✅ 已完成 | 2026-08-31；门禁：tsc/lint 0 + vitest 117 files 全过 + build:web；**待用户桌面实测**：模式抽屉卡片交互 / Strands 弹窗黑底两行纵排 / 状态栏顺序 / 工作区菜单三项 |
| 41 | **资源管理器四合一增强**（进行中·WIP，explorer 线，详 dev-state §37.88）：①SSH 连接后进家目录（✅ 已修：sshStore `echo $HOME` 解析替代硬编码 `/`，随 d8260e2 入库）②可编辑路径栏+子目录建议下拉（自定义加载目录）③上传=选择文件（input[type=file]+sftpWrite）+拖拽（复用 Rust `sftp_upload_file`）④文件拖进 agent 对话框/@ 引用（explorer 拖拽源+新事件 `tdsf:ai-attach-remote-file`+composer 最小接收端）。**关键事实**：远程树真数据源=useFileTree fsb_* 分支，useRemoteFileTree 是死代码勿加功能 | ⏳ 进行中（WIP b0cdd20，前三绿过） | 2026-08-31；剩余：FileExplorer 路径栏/上传/拖拽源接线 → composer 最小接收端（需与 agent 线协调领地）→ 全量门禁+拆分 commit |
| 40 | **Agent 架构闭环升级（方案书 v4.0，`docs/agent/方案书-v4.0-Agent架构闭环升级.md`，spec `.trae/specs/add-agent-loop-closure/`）**：参考 DeepSeek Harness（Model + Harness = Agent）实现感知→思考→行动→记忆闭环。**P0 完成（T1-T4，commit 375903d）**=上下文连续性（实例缓存 key 收窄+_session_messages 单一真源+context_manager="auto" 0.85 压缩）/ 循环护栏（ToolCallLimitHook 50 上限+失败 3 熔断+loop_progress+AgentStatusPill 进度）/ 规划回环（todo 驱动+_maybe_todo_followup 收尾校验+TodoStrip 时间戳）/ 记忆主动召回（每轮 `<recalled-memory>` top-3）；**P1 完成（T5-T7，commit f2db89f）**=python_run PTC（无沙箱进程级受控，22 工具，SSH 会话拒绝）/ Skill 剧本化（steps frontmatter+todo 同步+两样板）/ 验证回环（写后必只读验证+ssh 命令级细分+`_maybe_verify_followup`）；**P2 待做（T8-T10）**=回放测试（agent_log 重放 5 场景）/ 稳定性（LLM 超时 watchdog+降级只读+并行工具提示词）/ 置信度深化（三档标准+证据区收集→执行→验证分组）；**沙箱经用户拍板剔除（P3 未来项）** | 🔶 P0+P1 已完成，P2 待做 | 2026-09-01；门禁：pytest **2029** / vitest ai 354 / tsc / lint 全绿；详见 DEV-JOURNAL §37.86 + dev-state §37.89 |

### 待用户决策/确认

- [x] ~~**黑屏修复 + 发行版感知预测方案书拍板**~~ ✅ 已拍板（2026-08-28）：收敛为 **`docs/方案书-v2.0.md` 最终版**（唯一开发方向准绳，M0-M4 里程碑）——P0 dev 启动预检做 / P1→P3 按序 / rhel+debian 先行 / 状态栏跟随左下角；K2 sidecar ready 超时已修（30s→60s）
- [x] ~~**Agent 能力升级方案书 v3.0 拍板**~~ ✅ 已拍板（2026-08-28，#38）：① P0 起步、T1 技能包先行 ✅（P0 全四项已完成）② D3 部分执行（byoa/+3 脚本已删；agents/tools/core 为生产 fallback 保留）③ D4 runtime.tsx 已删 ✅ ④ P3（MCP/长期记忆）**纳入近期** ✅（T14 先行 ✅ 已完成，T13 需 MCPClient 调研）
- [x] ~~**方案书 v3.1 三模式信任体系开工确认**~~ ✅ 已完成（2026-08-29，spec `add-agent-trust-modes`，见 DEV-JOURNAL §37.81；后续用户实测把"教学"从叠加开关改为**第四档**——AgentMode = observe/confirm/auto/teach，教学档 = 只读+教学 prompt 预置组合，`toSidecarMode()` 展开下发 sidecar 零改动）
- [x] ~~**UI 精简五删**~~ ✅ 已拍板并执行（2026-08-29 用户钦定，产品形态收敛）：①智能体启动命令设置区 + 「启动智能体」卡片（外部 CLI 启动器与 TDSF agent 无关，AgentLauncherPanel 删除，NewTabMenu 菜单收敛）；②后端日志设置 tab（正常用户看不懂，开发时看 sidecar stdout 即可，LogsSection/SidecarLogPanel 删除）；③录制终端会话（asciicast 录制/回放，无必要，recorder/ 模块整删）；④设置页长段技术注释移除（打字机原理/白名单语义——**改放官方文档 `docs/guide/`**：三模式/可视执行演示/审批白名单三份，后续使用教程/注意事项/详细注释统一入该文件夹）；⑤桌面交互精简方向延续（界面只留一句话提示，详细文档进 docs/guide/）
- [x] ~~**知识库爬取质量治理二期**~~ ✅ 已完成（2026-08-30，§37.83）：zh_TW 语言后缀补漏+转简放行、Arch Wiki 命名空间/meta 页过滤、<500 质量门槛、12000 整页合并、语言导航行清洗、epub 二进制防护；rag.db 781→623 条零残留、均值 6254 字；knowledge-preview/ 623 个 md 人工预览导出 + 中文摘要 623/623（详情弹窗摘要条）
- [x] ~~**知识库 6+1 分类 + LLM 全量中文翻译 + Linux 哲学专属分类**~~ ✅ 已完成（2026-08-30，§37.84，commit ffddb47）：①category_for 17 源映射（archwiki 按 title 分流）+ rag 全链路 category + list_files(group) 过滤；②繁体改直接丢弃（用户钦定推翻 §37.83 C1 转简，623→621 条）；③translate_knowledge.py 断点/合批/校验翻译（619 条后台长跑中 ~10 小时量级，content_zh 进 FTS 中文 query 直接命中译文）；④philosophy/ 4 篇随源码教学语料（第 7 分类 linux-philosophy，corpus_personal 12 文件清洗重组 106 块）；⑤前端 KnowledgeBrowser 6+1 中文分组（来源名降副行）+ 导出 <分类>/<源>/ 两级层级；**翻译完成后需重导 knowledge-preview**
- [x] ~~**知识库大整合（7 分类 × ≤5 合并 md）**~~ ✅ 已完成（2026-08-31，§37.85）：consolidate_knowledge.py（23 合并文件映射表 + fail-closed 全覆盖校验 + 标题降级/去重/空行压缩格式整理 + 中文标题撞车英文消歧）→ rebuild_from_consolidated.py（合并 md 按 _chunk_markdown 标题边界分块入库 4777 块，块 title=「合并标题 · 章节标题」、url=consolidated/ 逻辑 id，get_doc 按 url 聚合还原）→ export_knowledge_md.py 适配一级目录导出 27 文件；philosophy 4 篇保持独立；前端零改动（vitest 321 绿）；⚠️ 运维铁律：rag 全清重建前必须关闭 TDSF 应用（KB auto-init 清库窗口会并发重爬污染）；遗留：doc_titles_zh 坏标题 LLM 重生成、content_zh 译文管线适配合并结构
- [ ] **竞品借鉴 B2-B4 分期拍板**（见 `docs/开源AI运维终端-竞品对比与借鉴规划.md` §5；**B1 已落地**=AI 脱敏+防伪造提示+报错解释+终端搜索，见 #36/§37.77）：B2=ghost text 补全+CMD 命令卡片+交互检测器；B3=known-hosts 转正+ssh_config 导入+/summary-to-skill（✅ 已随 T14 落地）；B4=教学围观广播+关键词高亮+透明执行强化（⚠️ 与方案书 v3.0 T5 会话日志共用事件源）；顺序与取舍由用户定
- [ ] **carapace 参数预测实测反馈**（#32 已完成，待用户 `启动.bat` 实测）：本地 `git checkout t` 弹分支 / `git checkout -` 弹选项；SSH 工具栏图标一键装远端 → `git checkout ` 弹**远端**分支；未装回退静态层中文。若 B2 ghost text AI 兜底被选入借鉴分期，此项合并评估
- [ ] Headroom MCP 是否引入（外部依赖，P3）
- [ ] 实训沙箱（Docker 故障环境）是否纳入（P3）
- [ ] 真实 LLM 委派效果实测反馈（决定 _MAIN_SUB_AGENT_PROMPT 是否需要调优）
- [ ] AI 入口优化点（2026-08-11 调查遗留，2026-08-28 更新）：~~① 无 key 时隐藏麦克风按钮~~ ✅ 已随语音输入整体移除关闭（§37.76）；② Ctrl+I 精简为单入口（当前 toggleMini + focusInput 同开小窗+底部输入条）；③ 启动首帧不聚焦输入框。改前先按 37.54 调查结论评估
- [x] ~~方案书集成度补齐的优先级~~（#6 已全部完成，2026-08-09）

---

## 三、原则（确保按方案执行）

1. 新任务先对照方案书：属于哪个阶段、对应哪条路线，不在路线图内的功能需用户确认再加
2. 任务收尾三件事（强制）：① git commit（全绿门禁）→ ② `docs/DEV-JOURNAL.md` 追加复盘（任务/方案/报错/修改/经验）→ ③ 更新本文件 + `docs/dev-state.md`
3. 报错与修改必须沉淀到 journal（根因 + 解法），防止重复踩坑
4. 门禁：后端 pytest / 前端 vitest / tsc / eslint / cargo check 全绿才算完成
