# TDSF Terminal Agent · 开发日志（经验沉淀）

> **用途**：每次任务收尾时追加一条记录——任务 / 方案 / 报错与修改 / 复盘（经验教训）。
> **配套**：`docs/ROADMAP.md`（短/长期规划）、`docs/dev-state.md`（进度状态，§37.x 交接章）、`docs/方案书-v1.0.md`（总纲）。
> **规范**：任务完成 → git commit → 追加本日志 → 更新 roadmap → 更新 dev-state。

---

## 2026-08-11 · 本地+SSH 混合分屏（ROADMAP #21）— SSH 终端迁入 PaneTree leaf

**任务**：SSH 终端此前在 workspace 级独立渲染（SshTerminalHost），无法参与 PaneTree 分屏；借鉴 iShell Pro 分屏组合，实现「本地 + SSH 混合分屏」。

**方案**（per-leaf SSH 绑定模型）：
1. `PaneNode.sshSessionId` 三态——`undefined`=继承 tab 绑定 / `null`=强制本地 / `string`=指定 SSH 会话；`effectiveLeafSsh(tree, leafId, tabSshSessionId)` 纯函数解析有效会话
2. `PaneTreeView` 新增 `SshLeafPane`（复用 `useSshLeafTransport` 注入 transport + `handleCwd` 同步远端 cwd 到 sshStore），`TerminalPaneContent` 条件渲染本地/SSH leaf
3. `splitActivePane` 让新 leaf 继承 active leaf 的有效 SSH 会话；快捷键 Ctrl/Cmd+Shift+H/V 水平/垂直分屏
4. App.tsx 删除 workspace 级 SshTerminalHost 覆盖路径；`sshActiveLeafIdRef` 改为从 active tab + active leaf 派生（会话 connected 才有效）

**报错与修改**：
- **`effectiveLeafSsh` 语义 bug**：原 `tree.sshSessionId ?? tabSshSessionId` 把显式 `null`（强制本地）当 undefined → tab 绑定覆盖强制本地。修复：先判 `!== undefined` 再继承（测试覆盖：显式 null 在 SSH tab 内仍强制本地）
- **typecheck/lint 抓测试文件**：`{ ...leaf1(), sshSessionId }` spread `PaneNode` 联合类型 → 对象字面量属性校验失败（sshSessionId 不在 split 变体）；`leaf2` 未使用。修复：改显式 `{ kind: "leaf", id: 1, sshSessionId }` + 删除未用工厂
- **cargo check**：Rust 端零改动，通过（5 个既有 warning 与本次无关）

**五绿门禁**：typecheck ✅ / lint ✅ / test 936 全过（新增 10 个 SSH binding 测试）/ build:web ✅ / cargo check ✅。commit 84f2941。

**复盘**：
- ✅ 三态模型（undefined 继承 / null 强制本地 / string 绑定）比布尔 flag 表达力强——向后兼容（undefined 继承）同时支持「SSH tab 内强制本地」反例
- ✅ `??` 与 `!== undefined` 语义差异是真坑：`null ?? x` = x，三态模型下必须用显式 undefined 判断
- ✅ 纯函数（effectiveLeafSsh）+ 单测先行：数据模型正确性不依赖 React 渲染，门禁一次通过
- ⚠️ SshTerminalHost 保留在 ssh-explorer export（openTransport 逻辑可复用），但已不再渲染使用——后续确认无引用后可清理
- 📌 待桌面端实测：连 SSH → Ctrl+Shift+H 分屏 → 本地/SSH 混合 → 翻译/选词/文件树联动全链路

---

## 2026-08-09 · Agent 深度进化调研（并发修复 + max_tokens + 双模式 SSH + 任务规划 + 压缩）

**任务（用户反馈）**：
1. 长 agent 对话报错 "Agent is already processing a request. Concurrent invocations are not supported"
2. 教学 agent 报错 "Model stopped generating due to maximum token limit"（MaxTokensReachedException）
3. 大方向需求：max_tokens 无上限 + 任务规划 UI + 对话压缩 + SSH 工具前台/后台双模式 + 参考开源架构

**调研（三路并行 search agent）**：
- **SSH 工具链路**：`ssh_command` 走后台独立 exec channel（session.rs:646），用户不可见；`suggest_command` 走 `injectIntoActivePty` → xterm，用户可见。两条链路并行互不相通
- **任务规划**：前端已有完整 TodoStrip UI（来自 terax），但只在 Vercel SDK 路径生效；Sidecar 路径不装配 `todo_write` 工具
- **对话压缩**：前端有 5 级分级压缩（compact.ts），Sidecar 只是截断最近 20 条，无 LLM 自动摘要
- **max_tokens**：OpenAI 可不传实现无上限，Anthropic 必须传正整数

**已修复（本轮 commit）**：
1. **并发崩溃**（commit e1b64c2）：per-(agent, session, perm) `threading.RLock` 保护 `strands_agent(prompt)` 调用
2. **max_tokens 截断**（commit d535e8f）：默认值 2048→8192（5 处）
3. **教学 UI 5 大改进**（commit 3f562b3）：移除工具上限 / 基于 agent id 切换 / 移除疑问按钮 / SSH 命令注入修复 / 预测回显
4. **终端执行模式开关**（commit cbc6c22）：chatStore + SuggestCommandCard + TdsfAgentPanel 开关按钮
5. **SSH cwd 显示修复**（commit 35c7377）：getTerminalContext SSH 优先
6. **session_id 泄露修复**（commit 7816f3f）：env 块移除内部数字 id

**方案文档**：`docs/PLAN-AGENT-DEEP-EVOLUTION.md`（6 个子方向 + 实施路线图 P0-P3）

**复盘**：
- ✅ **并发 bug 定位精准**：`_agent_cache` 缓存的 Strands Agent 有内部状态，用户停止+重发竞态直接崩溃。RLock 是最小侵入解法
- ✅ **max_tokens 2048 太保守**：这个默认值来自早期配置，教学 agent 6 板块内容轻松超出。8192 是合理中间值，后续方案建议条件传参
- ✅ **双模式 SSH 不需要两个工具**：调研确认一个 `ssh_command(visible=true/false)` 参数即可，LLM 不需要决策走哪个——开关由前端控制
- 📌 **TodoStrip 双轨联动是高复杂度任务**：需要 sidecar↔前端协议层新增工具回调通道，建议独立里程碑
- 📌 **对话压缩增强是低悬果实**：transport.ts 的 trimMessagesForSidecar 可以直接复用 compact.ts 策略，P0 优先

---

## 2026-08-09 · 教学 Agent 5 大改进（工具上限/渲染时机/疑问按钮/SSH命令注入/预测回显）

**任务（用户反馈）**：用户切到 agent 模块后发现 5 个问题：
1. 教学 UI 在输出内容后才开始排版（应该智能路由识别后切换）
2. "没懂？Ask TDSF 追问"按钮鸡肋（点击只附加上下文，还需再打一句话）
3. "本次排查已到达工具调用上限"——为什么有工具调用限制？
4. agent 发送命令发送不到终端
5. 命令应该一条一条给出，每个命令后面带预测回显

**调研（search agent 深度取证）**：
- 教学 UI 根因：`AiChat.tsx:775` 的 `!streaming` 条件 + `teachParser.ts` 内容关键词匹配——流式过程中显示纯文本，**流完后才整体替换为 TeachCard**
- 疑问按钮：`TeachCard.tsx:105-127` 的 onAsk 按钮，点击调 `attachSelection`（只附加上下文，不发送）
- 工具上限：Python `adapter.py:156` `ToolCallLimitHook(max_tool_calls=12)` 超过 12 次强制终止
- 命令注入失败：`injectIntoActivePty` 只查 tabs → SSH 终端不在 tabs → 返回 false（和 getTerminalContext/findCwd 同一 bug 类型）
- 预测回显缺失：suggest_command schema 只有 `{command, explanation}`，无 `predicted_output` 字段

**修改（commit 3f562b3，8 文件 +144 -58 行）**：
1. **Python adapter.py**：移除 `ToolCallLimitHook`——主 agent 和子 agent 都 `hooks=[]`
2. **AiChat.tsx**：改为 `agentId === "teach" && isTeachMessage(text)` 判断——去掉 `!streaming`，流式过程中就渲染 TeachCard（基于 agent id 切换而非等输出完毕）
3. **TeachCard.tsx**：移除疑问按钮（onAsk prop + 整块 JSX + 未使用 import 清理）
4. **useAiLiveBridge.ts**：`injectIntoActivePty` 增加 SSH 优先——有 `getSshLeafId` 时先尝试 SSH 终端 handle
5. **terminal.ts + tool.tsx + suggest_command.py**：增加 `predicted_output` 字段——前端 schema（LLM 可选提供）+ Python 启发式 `_predict_output`（40+ 常见命令映射表）+ 前端折叠卡片渲染（EyeIcon 切换显示/隐藏）

**验证**：门禁 typecheck / lint / vitest 904 / build:web 全绿。

**复盘**：
- ✅ **SSH 优先模式**正在成为模式——`getTerminalContext`、`findCwd`、`injectIntoActivePty` 三个方法都有同一个 bug：SSH 终端不在 tabs 里导致只查 tabs 的逻辑失效。统一修复方案：有 `getSshLeafId` 时优先走 SSH 分支
- ✅ **工具上限设计反思**：12 次限制对运维教学场景太紧（探查问题可能需要多次 grep/cat/systemctl）。移除后依赖 LLM 自行判断何时完成（Strands agent 有自然结束语义）
- ✅ **预测回显双轨**：Vercel SDK 路径由 LLM 提供 predicted_output（精确但依赖 LLM 质量）；Python 路径由启发式映射表生成（粗粒度但零延迟）。用户可折叠查看
- 📌 **可信度评分延后**：用户明确说"可信度保存待后面开发"，当前不处理置信度显示问题
- 📌 **桌面端实测待做**：需要在 Tauri 环境下验证教学流式渲染 + SSH 命令注入 + 预测回显折叠效果

---

## 2026-08-09 · Agent 终端上下文自动注入 → 每轮对话自动携带 scrollback 尾部摘要

**任务（用户反馈）**："agent 看不到终端，不知道我在干啥或者预测我要干啥。terax 能看见当前终端还能调工具拆任务路由意图，先解决这个问题再深度开发！"

**调研（两轮 search agent + 上级目录调研资料）**：
1. **双轨架构**：默认走 Python Sidecar 路径（`tdsfAgentId='main'`），Vercel AI SDK 路径作为 fallback
2. **Vercel SDK 路径**有 `get_terminal_output` 工具（读 scrollback 尾部 80 行），但需要 LLM 自主决定调用
3. **Python Sidecar 路径**（默认）的 `<env>` 块只注入元数据（cwd/sshSessionId），**完全没有终端输出内容**
4. **SSH 终端更严重**：`getTerminalContext()` 只查 `tabs` 数组，SSH 终端（SshTerminalHost）不在 tabs 里 → SSH 场景返回 null → agent 看不到 SSH 终端内容
5. **上级调研资料佐证**：Cline 的 `TerminalOutput` 命令、Tabby 的"终端上下文感知 inline 集成"——行业标配是 agent 能看到终端

**根因链路**：
```
用户终端操作 → xterm buffer（terminalRefs[leafId].getBuffer(300)）
  ↓ （已有能力！）
getTerminalContext()（useAiLiveBridge.ts:82）
  ↓ （只查 tabs → SSH 场景断裂）
LiveSnapshot（transport.ts:47）→ 无 terminalOutput 字段
  ↓
formatEnvBlock() → <env> 块只有元数据
  ↓
agent 收到的消息无终端屏幕内容 → "看不到终端"
```

**修改（commit 24fb81c，6 文件 +107 行）**：
1. **`transport.ts`**：
   - `LiveSnapshot` 增加 `terminalOutput: string | null` 字段
   - 新增 `formatTerminalContextBlock(live)` 函数：截取尾部 30 行，用 `<terminal-context>` 标签包裹（上游 terax 已有此标签的 strip 正则 `CONTEXT_BLOCK_RE`，说明原设计就有预留位）
   - `run()` 中合并 `<env>` + `<terminal-context>` 注入到最后一条 user message → **双轨受益**（Python Sidecar 的 input + Vercel SDK 的 messages）
2. **`chatRuntime.ts`**：`getLive()` 调用 `live.getTerminalContext()` 填充 `terminalOutput`
3. **`useAiLiveBridge.ts`**：`getTerminalContext` 增加 SSH 终端回退——tabs 找不到活跃终端时，通过 `getSshLeafId()` 读 SSH 终端的 `terminalRefs` buffer
4. **`App.tsx`**：`useAiLiveBridge` 传 `getSshLeafId: () => sshActiveLeafIdRef.current`
5. **`config.ts`**：system prompt 更新——描述 `<terminal-context>` 块自动携带终端尾部输出（~30行），`get_terminal_output` 只在需要更多历史时调用
6. **`transport.test.ts`**：新增 3 测试用例（空输出返回 null / 短输出原样注入 / 50 行截取尾部 30 行）

**验证**：门禁 typecheck / lint / vitest 905 / build:web 全绿。

**复盘**：
- ✅ **利用上游已有预留位**：发现 `<terminal-context>` 标签的 `CONTEXT_BLOCK_RE` 正则和 `stripContextBlock` 函数早已存在——上游 terax 原设计就有终端上下文注入的预留位，只是没完整实现。补全而非重造
- ✅ **双轨受益设计**：注入点在 `createContextAwareTransport` 的 `run()` 函数里（两条路径共享），`messagesForRun` 同时被 Python Sidecar 和 Vercel SDK 使用——一处改动覆盖全部
- ✅ **SSH 终端回退**：`getTerminalContext` 原本只查 tabs → SSH 场景断裂。增加 `getSshLeafId` 回退后，SSH 终端的 scrollback 也能被 agent 读到
- ✅ **token 成本可控**：30 行约 500-1500 tokens，远小于一条完整终端缓冲（300 行）。system prompt 明确告知 LLM `get_terminal_output` 只在需要更多历史时调用
- 📌 **自动注入 vs 工具调用**：自动注入让 agent 每轮都有基本感知（用户核心诉求），`get_terminal_output` 工具仍保留（Vercel SDK 路径）作为"读更多历史"的补充。两者互补而非互斥
- 📌 **脱敏已覆盖**：`getTerminalContext` 内部调用 `redactSensitive(buf)`，密码/密钥等敏感信息不会泄漏给 LLM

---

## 2026-08-09 · SSH 连接进度界面 → 握手期间显示美观 5 步进度（取代空状态页）

**任务（用户反馈）**："资源管理器和终端的同步会卡，资源管理器没加载好终端就不显示。终端的稳定和流畅是最优先的，资源管理器异步加载不阻塞终端。"

**调研（两轮深度取证）**：
1. **代码层面文件树不阻塞终端**（两轮 search agent 确认）：WorkspaceSurface 左右面板是 ResizablePanelGroup 兄弟节点；FileExplorer 加载是纯异步（`void fetchChildren`）；`explorerSource` 不进入终端渲染链路；TerminalStack 无条件挂载（CSS 切显）
2. **真正延迟源 = cold tab 机制 + SSH connecting 等待**：① 本地默认 tab `cold:true` 被 `selectLiveTerminals` 过滤 → TerminalPane 根本没挂载 → 显示 NoTerminalEmptyState 引导页；② SSH 连接需 TCP→握手→认证→PTY 建立（`await open_pty`），数秒内 `isSpaceSshConnected=false` → 终端区域被 NoTerminalEmptyState 或 invisible 覆盖
3. **用户误关联**：文件树在 SSH connected 后才开始加载（`navigateTo` 在 `sshConnect` await 之后），与终端同时出现在 connected 瞬间 → 用户看到"文件树转圈 + 终端没出来"误以为因果关系

**修改（commit ee43dde）**：
1. **新增 `SshConnectingOverlay.tsx`**：美观的 5 步连接进度界面（建立连接→SSH 握手→验证主机→身份认证→启动终端）；当前步骤 amber 脉冲 + 扩散环动画，已完成步骤 primary 色 + Tick02Icon；服务器信息卡片（`user@host:port`）；磨砂背景 `bg-background/95 backdrop-blur-sm`
2. **改 `WorkspaceSurface.tsx`**：新增 `sshConnectingInfo` prop + `showSshConnecting` 判定；渲染优先级 `空状态页 < connecting overlay < SSH 终端`（后者覆盖前者）；终端栈隐藏条件新增 `showSshConnecting`
3. **改 `App.tsx`**：新增 `SSH_CONNECTING_STATES` 集合 + `isSpaceSshConnecting` + `sshConnectingInfo` 计算；`showNoTerminalEmptyState` 新增 `!isSpaceSshConnecting` 条件（SSH 连接中不显示空状态页）

**验证**：门禁 typecheck / lint / vitest 902 / build:web 全绿。桌面端实测待用户在 SSH 自动连接场景下验证视觉效果（connecting 只在握手几秒内出现）。

**复盘**：
- ✅ **"异常输出"先取证再下结论**（继承上次教训）：两轮 search agent 交叉验证（注入脚本/前端源码/渲染链路/布局/CSS/ErrorBoundary 五方向），确认文件树不阻塞终端后再定位真正的延迟源
- ✅ **渲染优先级天然正确**：connecting overlay 在空状态页之后、SSH 终端之前渲染——SSH 连上后 showSshTerminal=true → showSshConnecting 自动 false（条件 `!showSshTerminal`），SshTerminalHost 在上层接管，无需额外切换逻辑
- ✅ **步骤进度映射 SSH 状态机**：`activeStepIndex(state)` 将 `connecting/handshaking/host_verifying/authenticating/authenticated` 精确映射到 0-4 步，`connected` 返回 5（全完成，此时已切到 SshTerminalHost）
- 📌 **cold tab 机制未改**（用户未选"本地终端自动启动"）：本地终端仍需手动点击 warmUp。如需改进可后续做

---

## 2026-08-09 · SSH 终端"异常输出"真相取证 → 非渲染问题，清理 hack 残留垃圾文件

**任务（用户反馈）**：SSH 终端 `ll` 出现奇怪文件 `';'`（18B）和 `HTTP`（6B）；输入 `ls'` 进入 `>` 多行提示，后续输入"没反应"——用户怀疑"终端交互渲染展示还是有问题，请告诉我真相再解决"。

**取证（三处独立证据链交叉验证）**：
1. **后端注入脚本 dump 正常**：`/tmp/tdsf-osc7-*.bash`（4 个 389B 644）只有 OSC 7 cwd 钩子；`.bashrc` 无异常
2. **前端源码通读干净**：`SshTerminalHost.tsx` 输入原样透传（`handle.write(data)`），cd 拦截 hack 已删（方案 A 取代）
3. **服务器文件 od dump**：`/root/;` = `-geten hosts`、`/root/HTTP` = `- \`——8月7日 hack 时代"cd 拦截 hack"改写 `yum install httpd* -y` 时的命令碎片误创建；`.bash_history` 佐证

**结论（真相）**：
- 不是渲染问题——`';'`/`HTTP` 是**真实存在的垃圾文件**（hack 时代残留）
- `ls'` 后的 `>` 是 **bash 正常续行行为**（单引号未闭合 → PS2 多行模式），后续输入都是同一条未完成命令的续行内容；`> ls` 后的命令列表是 Tab 补全

**解决**：paramiko 远程 `rm -f -- '/root/;' /root/HTTP` → 验证删除。临时脚本用后即删，无代码改动无需 commit。

**复盘**：
- ✅ **先取证再下结论**：用户直觉"渲染有问题"，实际是服务器真实残留 + bash 正常行为。靠注入脚本 dump / 前端源码 / 服务器 od dump 三处独立证据交叉验证后才定性
- ✅ **带分号文件名的删除**：`rm -f -- '/root/;'`（`--` 防选项解析、单引号保护分号），否则 `;` 会被当命令分隔符
- ✅ **bash 续行知识**：未闭合引号触发 PS2 `>`，是 shell 标准行为，终端无需"修复"；用户需 Ctrl+C 或补闭合引号退出
- 📌 教训：hack 时代（7-31 至 8-09）在服务器上产生的垃圾文件/历史坏命令会在日后的 `ll` 中"诈尸"，排查终端问题时先查服务器真实状态再怀疑渲染

---

## 2026-08-09 · 终端中文显示宋体（衬线）→ fallback 链插无衬线中文字体 + 主题设置合并明暗切换

**任务（用户两连需求）**：① 终端中文当前是宋体（衬线），改为微软雅黑（无衬线）；② 主题设置模块拆成"白色系/暗色系"两部分，合并成一个，点击直接切换明暗。

**根因**：`src/lib/fonts.ts` 的 `FALLBACK_CHAIN` 以 `monospace` 收尾——Windows 的 monospace 中文映射是宋体（SimSun，衬线）。UI 全局字体 globals.css 早已用 `'Inter Variable', 'Microsoft YaHei', ...`（无衬线），唯独终端/编辑器走 fonts.ts 链缺中文字体 → 宋体。主题设置 `ThemesSection.tsx` 用 `THEME_GROUPS` 按 light/dark variant 分组展示两个卡片区，用户嫌繁琐。

**修改（commit 7323276）**：
1. `fonts.ts` FALLBACK_CHAIN：`'"JetBrains Mono", SFMono-Regular, Menlo, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace'`——CSS font 按字形逐字符回退：英文走 JetBrains Mono 等宽（代码对齐），中文自动落到微软雅黑等无衬线。同步更新 `fonts.test.ts` 的 FALLBACK 断言。上游对比注释注明 TDSF 魔改理由
2. `ThemesSection.tsx`：删除深/浅色分组（THEME_GROUPS → THEMES 单网格）；顶部新增"显示模式"行——浅色/深色两档按钮（segmented control），用 `useTheme().setMode("light"|"dark")` 直接切换，激活态 `bg-foreground text-background`

**验证**：CDP 实测——`resolveFontFamily("")` 返回链含 `"Microsoft YaHei"`；设置窗口（/settings.html?tab=themes）无分组标题、显示模式按钮存在、点击"深色"→ root class `light`→`dark` 翻转且激活态正确。门禁：typecheck / lint / vitest 902 / build:web 全绿。

**复盘**：
- ✅ **字体 fallback 链是"英文等宽 + 中文无衬线"双轨**：等宽字体不含中文字形，CSS 会自动跳到第一个含中文形体的字体；在 monospace 前插入微软雅黑/苹方/思源黑体即可三平台统一无衬线，无需自造字体
- ✅ **明暗切换复用 ThemeProvider.setMode**：设置窗口本来就被 ThemeProvider 包裹（settings/main.tsx），直接用 context 无需新增状态；localStorage 持久化 `tdsf-theme-mode` 由 Provider 处理
- 📌 注意：改 `FALLBACK_CHAIN` 同时影响编辑器（Monaco detectMonoFontFamily 同源）——综合效果一致（无衬线中文），符合用户预期

---

## 2026-08-09 · 翻译卡片底部划词被遮住 → 智能翻转定位（两阶段测量）

**任务**：用户反馈"底端的命令行划词翻译，卡片出现在底端显示不全被遮住，要智能调整位置——底部划词时卡片出现在词的上方"。

**根因**：`TranslateTooltip.tsx` 定位固定 `top = y + 12`（永远在选中点下方），底部划词时 `y + 12 + 卡片高度` 超出视口被窗口边缘遮住。

**方案**（两阶段定位，无闪跳）：
- 阶段 1（useEffect）：按下方估算位置先渲染
- 阶段 2（useLayoutEffect）：实测卡片 `offsetHeight/offsetWidth`，若 `top + h > innerHeight - 8` 则翻转到选中点上方（`y - h - 12`）；左右边界一并收进视口留 8px；滑入动画按方向切换（`slide-in-from-top-1` / `slide-in-from-bottom-1`）；用 functional setState 避免依赖循环

**验证**：新增 2 个单测（底部翻转 above / 中部默认 below）；CDP 实测 3 场景全过——底部 y=766 → 卡片 top=632 完整可见且 `slideTop`；中部 y=413 → 默认下方；右侧 x=1384 → 卡片 right=1386 收进视口。门禁：typecheck / lint / vitest 902 / build:web 全绿。commit cc631c1。

**复盘**：
- ✅ **定位类 UI 必须"测了再说"**：固定偏移看似简单，实际溢出场景（底部/右侧）用户一划就露馅。用 layout effect 实测真实尺寸再决定方向是通用解法
- ✅ **先估算渲染 + layout 阶段修正**避免闪跳：paint 前同步改位置，用户无感知
- 📌 窗口 resize 后卡片不重新定位（沿用原行为，未扩 scope）；如需可监听 resize 重算

---

## 2026-08-09 · SSH 终端输入被 cd 拦截 hack 改写（根因：行缓冲残留 + 元字符黑名单缺 `*`/`?`）→ 方案 A 远端静默注入 OSC 7

**任务**：用户报告"SSH 终端输入命令会弹出别的字眼"，例如输入 `yum install httpd* -y` 终端却显示 `yum install httpdyum install httpd* -y'; printf '\033]7;file://localhost%s\007' "$(pwd -P)"`。问：为什么 / 当前终端逻辑是什么 / 有没有开源方案。

**根因**（grep 全项目 OSC 7 相关代码 + 通读 SshTerminalHost.tsx 确认）：2026-07-31 起前端 `SshTerminalHost` 用"行缓冲 + cd 命令改写"在本地伪造 OSC 7（拦截 `cd <dir>` 追加 `printf OSC7`）。三个致命 bug：
1. `inputBufferRef.current += data` 后**无换行输入永不清理** → 逐键输入/粘贴分片永久堆积
2. 残留 + 新输入拼接 → 误判 `/^cd(?:\s+(.+))?$/` → 用户整条命令被丢弃改写
3. 元字符黑名单 `[;&|`$(){}[\]<>!"\\]` **缺 `*` `?` 通配符** → `yum install httpd* -y` 可绕过 → 整条被替换成 `cd ...; printf OSC7`

**开源方案调研**（报告：`docs/research-ssh-cwd-sync.md`）：OSC 7 cwd 上报是终端行业标准（VS Code / Tabby / Warp 同款），本地终端用 `--rcfile`/`ZDOTDIR`/`-C` 注入钩子；**SSH 端因 request_shell 无法传参**，需认证后探测远端 shell 类型 → 写最小注入脚本到 /tmp → exec 启动注入 shell。前端伪造方案在真实终端产品中不存在。

**方案 A（用户拍板）**：
- `session.rs` open_pty：认证后 `probe_remote_shell`（bash/zsh/fish 探测）→ `write_shell_integration`（heredoc 原样写脚本到 /tmp，免 base64 crate；bash 版先 source `~/.bashrc` 再设 PROMPT_COMMAND 发 OSC 7，zsh 用 ZDOTDIR 两个文件，fish 用 `-C source`）→ PTY `exec bash --rcfile ...` 启动注入 shell；**任何一步失败降级 request_shell**（仅失去 cwd 同步，绝不篡改输入）
- `SshTerminalHost.tsx`：删除行缓冲 + cd 改写，输入原样透传
- `CLAUDE.md` v2.2 新增 §3 红线 9（终端/SSH 改动 = 牵一发动全身，禁止前端输入路径做行缓冲/命令改写，改动后实测全链路）

**报错与修改**：
1. `channel_write.exec(true, cmd)` 报 E0277（`Vec<u8>: From<&String>`）→ 改 `cmd.as_str()`
2. cargo test 被旧实例 `tdsf-terminal-agent.exe`（PID 36020）占 target 文件 → `Stop-Process` 后重跑
3. 用户提供的实测 IP `192.168.45.300` 非法（段 >255，报"不知道这样的主机"）→ `arp -a` 发现 192.168.45.130（VMware VM），`Test-NetConnection -Port 22` 确认开放；root/123 凭据实测有效

**实测**（CDP 9222 + sshStore 订阅，192.168.45.130 root，RHEL 10 系 Rocky Linux）：
- 连接 1 秒 connected（方案 A 注入链路通）；远端自动发 OSC 7（capture 含 `\x1b]7;file://localhost/root\x07`）
- `echo TDSF_MARK_1` 原样回显；`cd /etc; pwd` 后远端自动发 `\x1b]7;file://localhost/etc\x07`（PROMPT_COMMAND precmd 生效）
- `yum install httpd* -y` **原样回显并真正执行**（yum 开始解析安装），`has OLD rewritten pattern: false` ✓
- xterm 解析层（registerCwdHandler）：`file://localhost/etc` → 回调 `/etc`，`not-a-url` 被忽略 ✓
- 门禁：cargo check / cargo test（27+1 doc）/ typecheck / lint / vitest 900 / build:web 全绿

**复盘**：
- ✅ **"聪明"的前端命令改写 = 反模式**：任何在输入路径做字符串匹配/改写的逻辑，一旦遇上无法枚举的输入（通配符、粘贴分片、多字节），必然出错。远端 shell 行为应交给远端注入脚本，前端只管透传——这正是 VS Code 等产品的做法
- ✅ **调研报告与实施偏差已记录**：报告原拟 base64 写入 /tmp，实际因 Cargo.toml 无 base64 crate 改 heredoc 原样落盘（更安全，免转义）；报告对 sshd 调 bash 的 login 类型假设有误，实际用 `exec bash --rcfile`（login shell 由 sshd 正常 source `/etc/profile`，`--rcfile` 只覆盖交互式 rc）——**实现细节以代码注释 + CLAUDE.md 约定为准**
- ✅ **实测 IP 校验教训**：用户给的主机 IP 也值得先校验（段值 >255 非法），ARP 扫描 + 端口探测比反复重试高效
- 📌 **降级路径是底线**：方案 A 任何一步失败都降级 request_shell——产品承诺"输入绝不被篡改"，即使失去 cwd 同步

---

## 2026-08-09 · SSH 终端划词翻译 / Ask 浮层不弹（根因：修剪 effect 误删 SSH leaf handle）

**任务**：用户反馈"SSH 进入服务器的终端后划词翻译不显示、AskAgent 没弹出"。

**调查**（CDP 9222 运行时实测，SSH 已连 192.168.45.130）：
- 链路：SSH 终端（SshTerminalHost → TerminalPane，rendererPool slot）选区 → `useSelectionAskAi`（document mouseup on `.xterm`）→ `captureActiveSelection` → 浮层（翻译 + Ask TDSF）→ 翻译卡片 / AI 面板
- 实测证据：`sshActiveLeafId=5` 但 `terminalHasLeaf(5)=false`（terminalRefs 无 SSH leaf）；rendererPool slots 含 leaf 5（slot 绑定正常、term.select 成功）→ `captureActiveSelection` 的 SSH 分支（`terminalRefs.has(sshLid)`）恒 false → 回退被隐藏的本地终端（选区恒空）→ 返回 null → 浮层永不弹出

**根因**：`App.tsx:941-956` 修剪 effect 只把 `tab.paneTree` 的 leafId 视为"存活"；SSH 终端 leafId 不在 paneTree（SshTerminalHost 由 WorkspaceSurface 独立挂载），每次 tabs 变化都被修剪掉 terminalRefs handle + searchAddon，并误调 `disposeSession`。SshTerminalHost 挂载后 callback ref 不会重新触发 → handle 无法自行恢复。

**修改**（2 处）：
1. `App.tsx` 修剪 effect：把 `sshActiveLeafIdRef.current` 纳入 live 集合（防 handle/searchAddon 被删、session 被误 dispose）
2. `App.tsx` `captureActiveSelection`：SSH 分支改 `leafGridSelection(sshLid)`（rendererPool slot 直读，slot 绑定与组件生命周期一致，天然自愈，不再依赖 terminalRefs 注册时机）；`src/modules/terminal/index.ts` 导出 `leafGridSelection`

**验证**（CDP 全链路实测）：HMR 后 sshActiveLeafId=6 → `terminalHasLeaf(6)=true`（修剪 effect 重跑后保留）；`term.select` → mouseup → 浮层 `open`（翻译 + Ask TDSF 按钮都在）；点「翻译」→ 卡片命中离线词典（`last` 命令 + 示例 `last -10`）；点卡片内「Ask TDSF 解释这段」→ AI 面板 open。门禁：typecheck / lint / test 900 全过 / build:web 出 dist。

**复盘**：
- 上一轮调查（§37.34）猜"SSH session 无 rendererPool slot"（`getSlotForLeaf=null`）是根因——本次实测 slot 正常存在，真根因在 terminalRefs 修剪。**现象一致 ≠ 根因一致，必须 CDP 实测逐环验证**（符合 R2）
- `captureActiveSelection` 依赖"外部注册的 handle 表"（terminalRefs）是脆弱设计：SSH 独立挂载组件 + 修剪 effect 共同违反"注册/修剪生命周期一致"假设；改 slot 直读（leafGridSelection）从根上消除该依赖
- 合成鼠标拖选无法在 WebGL canvas 下产生选区（合成事件发到 `.xterm` 根，canvas listener 收不到），验证只能靠程序化 `term.select` + 真实用户复测

---

## 2026-08-08 · 交接记忆：其他 AI 优化 30 commits 复核 + 远程推送

**任务**：用户要求"阅读保存更新记忆，更新开发文档进度，做好规划"（当天让其他 AI 做了优化，需复核接管）。

**复核结果**（git log 715b8cb..d815eec = 30 commits，三大主题）：
1. **SSH 会话修复**：幽灵 sessionId 根因（4d0e8fd，重启回欢迎界面）/ SpaceCreateDialog 模式闪动（8bf3fa0）/ 握手 15s 显式超时（be58879）/ 本地终端叠层隐藏失效（2114ccb）/ sidecar dev 强制 python 脚本（c8a2f79）/ 测试连接文案溢出（f9f04bf）
2. **WorkspaceFs 重构 P2-1~P2-4**（672d9cc→eff1755 + 补交 c1a5ed6/5824c6b）：FsBackend trait + LocalFs/SftpFs + fsb_* 命令 + workspaceFsStore 前端单源 + 断开降级 UI；**双根因**（双轨 prop 竞态 + OSC 7 路径泄漏 792b620）收敛；方案书新增 WORKSPACE-FS-REFACTOR-PLAN.md
3. **SSH 选中翻译修复**：leafId 上报 render 期副作用 → useEffect 生命周期（0475d4d）+ 第二层调查（§37.34 进行中：SSH session 晚创建导致 slot 绑定跳过，captureActiveSelection 取选区空；另黑屏 = 双 connected 会话 ref 不同步）

**动作**：30 commits 已 push（117b59d..d815eec → origin，远程 0 ahead）；dev-state 头部"最后更新"同步到 §37.34（修复文档漂移）；DEV-JOURNAL 本条目按顶部倒序追加（统一格式）。

**复盘**：
- ✅ **文档漂移再次验证 R8**：其他 AI 更新了 dev-state 内容（§37.31-37.34）但漏同步头部"最后更新"行——接手者第一眼读到的还是 §37.30 过时信息。教训：**内容更新必须连带头部时间戳 + 指引行一起改**
- ✅ **R9（用户体验视角验证）已沉淀进 CODE-REVIEW-LESSONS.md**：验收 = 用户看到的界面，不为自动化加后门——WorkspaceFs 重构全程用 CDP 用户操作路径采样（10×2s）验证
- 📌 **DEV-JOURNAL 追加方向约定**：统一顶部倒序（新条目放最前）——本轮其他 AI 的 8 条 append 在尾部，格式不统一已在本条修正，后续照此

---

## 2026-08-07 · 保存记忆：审查经验固化为开发规范（CODE-REVIEW-LESSONS.md + CLAUDE.md v2.1）

**任务**：用户要求"先保存记忆做好规划，之前花了很长时间审查修复代码，以后开发不要再犯错"——把 2026-08-04~07 四批审查修复（41 项发现，20 项修复）的血泪经验固化为可复用开发规范。

**方案**（教训沉淀"双写"分层）：
1. **新建 `docs/CODE-REVIEW-LESSONS.md`**（完整细则，按需查阅）：审查方法论（4 维度 + AI 代码 6 类缺陷）+ 8 条质量红线 R1-R8 + 血泪案例速查表（8 案例）+ 审查修复成果基线
2. **CLAUDE.md v2.0 → v2.1**：新增 §3.5"AI 代码质量红线（动工前必读）"8 条精简版（动工前必守，太长没人读）+ 记忆文档表新增一行
3. dev-state §37.30 交接章 + ROADMAP 同步

**8 条质量红线（R1-R8 摘要）**：
- R1 改动前先验证调用链（grep 全部调用点 + 读上下文，async 化同步改测试）
- R2 结论必须实测（russh Handle 无 Clone 是血泪前例；报告是地图，grep+Read 才算数）
- R3 锁三不变量（async 不跨 await 持锁 / 不可 Clone 则缩锁范围 / 粒度匹配竞争强度）
- R4 不静默吞错（catch 必须有日志或降级注释）
- R5 不留幽灵代码（写完自问"谁调用它"，删除前 grep 验证）
- R6 验证全量（cargo check ≠ cargo test；锁/签名改动后全量 cargo test）
- R7 编辑纪律（同区域连续 Edit 逐次 Read 确认；PowerShell 无 heredoc 用多个 -m）
- R8 文档同步防漂移（功能完成 = 代码 + 测试 + 文档三件套）

**复盘**：
- ✅ **教训沉淀"双写"是对的**：红线放 CLAUDE.md（动工前必读）、细则+案例放独立文档（按需查阅）——单一文档要么太长没人读、要么太短记不住
- ✅ **血泪案例速查表是最高价值资产**：8 个案例都是真踩过的坑（E0597 生命周期 / Edit 重复行 / terax_lib 遗留致 cargo test 从未全绿 / TS 类型名错误 / Python else 挂错 if / PowerShell heredoc / CDP 转义 / 模型不能读截图），下次遇到同类直接查表
- 📌 **后续开发硬要求**：任何删除/重构/签名修改前先回查 8 条红线；审查报告结论必须实测验证

---

## 2026-08-07 · 审查架构项收尾（Py-H1 调研定性 + Rust-C3 热路径锁迁移）

**任务**：对代码审查报告第四优先的 3 个架构级项收尾（用户拍板：Py-H1="先调研再定"、Rust-C3="只迁热路径"、FE-C2="暂缓"）。

**方案**：
- **Py-H1**：通读 `agents/__init__.py` 全文 + `main.py` 调用链 + 前端 `sidecar-adapter.ts` 热路径调用，实证双 Agent 系统是 override+fallback+元数据源三层结构 → 保留现状
- **Rust-C3**：全项目 14 处 `std::sync` 锁盘点 → 只迁移真正的 async 热路径靶点 `SshState`（sessions + sftp_sessions，11 处访问点），其余有明确理由保留

**报错与修改**：
- **无编译错误**（一次通过，cargo check 0 错误 + cargo test 351 全绿）——区别于第三批的反复，主因是迁移前先穷尽盘点调用点（grep 全部 11 处 + 读全上下文），且测试同步改为 `#[tokio::test]`，没有遗漏调用点
- **关键决策：tokio::sync 而非 parking_lot**——审查报告建议二选一。选 tokio::sync 理由：已在依赖中（session.rs 已用 tokio::sync::Mutex），符合项目"不新增依赖"约束；副作用是 5 个方法需 async 化（insert/take/get/list_ids/remove_sftp）+ 2 个测试改 tokio::test。若选 parking_lot 可零侵入，但需新增依赖（违反 CLAUDE.md 决策边界"新增重依赖先问用户"）

**复盘**：
- ✅ **"先调研再定"的正确打开方式**：Py-H1 审查报告评级"两套并行且不一致"看似严重，但读代码后发现是显式互斥的 override 切换（`set_backend` 注入后 `invoke_agent` 优先走 override），注释白纸黑字写明设计意图。**结论：审查报告的结构化评级是启发式线索，不是最终判决；删代码前必须沿数据流验证"谁在调用它"**
- ✅ **锁迁移的正确粒度**：不是"所有 std::sync 锁都要换"。真正的 async 热路径 = 每个命令必经的查表锁（SshState）；其余（LOG_BUFFER 有意设计 / shell cwd 在 std 线程 / session state 微秒临界区 / 冷路径）保留反而更优。**换锁有成本（async 化 + 取消点语义变化），收益要与竞争强度匹配**
- ✅ **async 化的取消点风险**：`get_or_create_sftp` 的 double-check 模式（write 锁内 get+insert）锁内无 await 点，cancellation safe；若锁内有 await 则 double-check 失效，需保持"锁内无 await"不变量
- ⚠️ **教训（沿用第三批）**：审查报告对 russh 的结论（"Handle 实现 Clone"）已证明有误，本轮对 std::sync 锁分布也发现报告位置（`ssh/mod.rs:58-64`）与实际 14 处全貌有出入——**报告是地图，实地勘探（grep+Read）才算数**

---

## 2026-08-04 · 代码审查第三批修复（Rust-C2 持锁 / SFTP 路径验证 / 遗留问题）

**任务**：继续修复审查报告剩余项（高难度批），做好验证。

**方案**：修复 Rust-C2（exec 持锁 30s）、Rust-M2（SFTP 路径遍历）、Rust-L1（spawn expect）、Rust-M5（known_hosts 降级）、FE-L1（DEV 暴露）；顺手修 2 个遗留（terax_lib crate 名、doc test import）。

**报错与修改**：
- **E0597 handle_guard 生命周期**：审查报告称"russh Handle 实现 Clone"，实测 russh 0.61.2 的 `Handle` **只有 Drop、没有 Clone**（`impl<H: Handler> Drop` 存在，无 `impl Clone`）。`h.clone()` 解析为 `&Handle` 的 Clone → 引用逃逸 block → E0597。**教训：审查报告结论必须实测验证，不能直接信**。最终方案：锁内建 channel（只覆盖一个 RTT），建好立即 `drop(guard)`——channel 独立于 handle
- **Edit 替换重复行**：两处相同 old_string 用 replace_all + 后续细化替换，造成重复 channel 创建行 + handle 释放后仍引用。**教训：连续多次 Edit 同区域要逐次 Read 确认**
- **doc test 编译失败**：cargo test 全量跑出 doc test E0433（`Duration`/`client` 未导入）——此前从未跑过全量 cargo test，暴露 2 个遗留问题

**复盘**：
- ✅ **验证要跑全量**：cargo check ≠ cargo test，集成测试 + doc test 都是独立编译单元。本轮顺手修掉 terax_lib 遗留（4 文件）+ doc test import，cargo test 首次全绿（351 个）
- ✅ **锁优化正确姿势**：不在 async 里跨 await 持锁；若对象不可 Clone，就缩小锁范围到"创建资源"这一步，资源独立后释放
- ✅ **安全校验放边界**：反向 RPC 是可信边界外的入口（LLM 输出），路径校验（绝对路径 + 禁 `..`）应统一放入口

---

## 2026-08-04 · 代码审查第二批修复（sshStore 去重 + 变量预初始化 + 方法提取）

**任务**：修复审查报告剩余 6 项中难度发现。

**报错与修改**：
- **TS 类型名错误**：抽工具函数时误用 `SshStore` 类型，实际 store 类型是 `SshExplorerState`。两次编译报错才定位（TS2304/TS2459）
- **Python 语法错误**：给 `_sub_steps` 加 `else` 分支时挂错了 `if`（误配到 for 循环），导致 SyntaxError。最终方案改为"方法顶部预初始化 None"，比 else 分支更简洁且消除短路求值依赖
- **OSC7 导出遗漏**：`getOsc7Log`/`Osc7LogEntry` 从本地改为导出后，SshTerminalHost 的 import 需同步（TS2459/TS6133）

**复盘**：
- ✅ **批量重构前先确认类型名**（读文件时用 Grep 验证类型定义，避免 TS2304 走弯路）
- ✅ **Python 缩进敏感**：加 else 分支必须确认它配对的 if——建议重构后立即跑 `python -m py_compile` 快速验证语法
- ✅ **导出 API 变更要同步 import**：TS 的 `noUnusedLocals` 会立刻暴露遗漏

---

## 2026-08-04 · 全方位代码审查 + 修复 13 项发现（净减 9358 行）

**任务**：基于 AI 代码审查最佳实践调研，对全项目 15 万行代码进行首次系统性代码审查并修复。

**方案**：
1. 调研 AI 代码审查最佳实践（ClackyAI/GitAutoReview/Metamindz/Sonar/ThoughtWorks）
2. 激活 multi-reviewer-patterns skill，派 3 个子 agent 并行审查（前端/Rust/Python）
3. 产出 41 项发现的分级报告，按优先级修复 13 项

**报错与修改**：
- **SFTP TOCTOU 修复第一次编译失败**：最初方案在 write 锁内创建 SFTP channel（`sftp_map` 跨 `.await`），但 `std::sync::RwLockWriteGuard` 不满足 `Send`，Tauri async 命令编译报错。改为"先创建后 double-check"模式——不持锁跨 await，创建完成后在 write 锁内再次检查是否已被并发请求创建。
- **PT 文件正则替换副作用**：用 PowerShell `-replace` 批量替换 `.unwrap()` 时，`pty/session.rs` 中 `Condvar::wait_timeout().unwrap()` 返回的是 tuple 而非 Result，正则误匹配。手动恢复后保留原样（该路径 poisoning 直接 panic 是合理行为）。

**复盘**：
- ✅ **"删掉一半代码还能跑吗？"是审查 AI 代码最有效的一句话**——308KB 死代码就是这么发现的
- ✅ **交叉核验法**：审查报告里的行号和代码引用都是子 agent 用 Grep/Read 实际读取的，不是臆测
- ✅ **std::sync 锁在 async 上下文的 Send 问题**是 Rust 新手（和 AI）常犯的错误——持有 `std::sync` Guard 跨 `.await` 会编译报错，需要改用 `tokio::sync` 或重构为"不持锁跨 await"模式
- 📌 **AI 代码审查的 6 类典型缺陷全部命中**：过度工程、幽灵代码、假注释、错误吞噬、结构侵蚀、并发不安全——说明本项目确实存在 AI 代码的系统性风险，本次审查修复了最高优先的 13 项
- 📌 **审查报告归档价值**：`docs/reports/CODE-REVIEW-2026-08-04.md` 是活文档，剩余 28 项未修复发现可直接作为后续 backlog

---

## 2026-08-04 · 进度跟进 + 交接注意事项调研 + L3 文档同步 + 远程推送

**任务**：用户要求详细阅读项目、明晰架构与进度、调研开发交接注意事项、进行进度跟进、推送更新到 GitHub。

**方案**：
- 全面阅读 5 份交接文档（AGENTS / CLAUDE / dev-state §37.24 / HANDOVER / KNOWLEDGE-INDEX）
- 全网调研开发交接最佳实践（通用软件 + AI agent 特殊点 + Tauri 全栈 + 多 agent 协作）
- 交叉核验文档声明 vs git 真实状态（工作树/commit/测试基线/文档漂移）
- 修复发现的 3 项偏差：push 远程 / L3 文档同步 v1.3 / 标注修正

**发现的问题（3 项偏差，交接场景的典型坑）**：
1. 🔴 **97 commits 未 push**（本地仓库 = 单点故障）。交接最大风险不是代码问题，而是"交付物不在远程"
2. 🟠 **L3 文档版本漂移**（HANDOVER/KNOWLEDGE-INDEX 停在 v1.2，落后 §37.14-37.24 全量工程）。"活文档"不活 = 接手者读到过时信息
3. 🟡 **"未提交"标注过时**（后续 commit 已含入但标注未更新）。文档漂移的微小表现

**复盘**：
- ✅ "交叉核验"方法论有效：文档说什么 vs git 显示什么，一对就发现偏差——单纯读文档会漏掉
- ✅ 交接调研的价值：业界经验（PingCode "敢写问题才是高质量交接"、Google "Prompt 是构建产物"、Trunk "LLM 是没读说明书的最终用户"）直接对应到本项目的实际状态
- 📌 **97 commits 未 push 是所有交接场景的第一要务**——代码在远程才算交付。这是最低成本、最高收益的风险消除动作
- 📌 **L3 知识层文档漂移是系统性风险**：L2（dev-state）每 session 追加是自动的，但 L3（HANDOVER/KNOWLEDGE-INDEX）需要在里程碑时手动同步——容易遗漏。建议：每次大里程碑 commit 后检查 L3 是否需要更新

---

## 2026-08-01 · P2 翻译模块重构：统一选中浮层（翻译 + Ask TDSF）

**任务**：完善翻译模块——本地/SSH 终端选词均可翻译；选中单词或代码片段可 ask agent；适配 Space 重构后的终端交互。

**方案**：
- 选中浮层（SelectionAskAi）从"仅 Ask 按钮"改为双按钮 [翻译 | Ask TDSF]，翻译按钮按开关显示
- 翻译卡片（TranslateTooltip）升级：词典 tag 徽标 + 底部「Ask TDSF 解释这段」操作
- 删除旧"退让"协调（translate-enabled/disabled/hit/miss 事件互相压制），两动作共存由用户选择
- 删除 useTranslateSelection 自动翻译 hook，翻译由浮层按钮触发（App.onTranslateSelection 查离线词典）
- 本地/SSH 终端统一走 captureActiveSelection（按 tab/leafId/sshActiveLeafId 取文本）

**报错与修改**：
- LookupResult 无 `dict` 字段 → 改用 `tag` 字段显示词典徽标
- useSelectionAskAi 残留 useRef 未用 → 移除 import（eslint）

**复盘**：
- ✅ 旧协调逻辑（事件互相压制）是"两个功能打架"的产物，合并为一个浮层后整体删除，复杂度显著下降
- ✅ 翻译与 Ask 是同一交互场景的两个动作，应共存于一个 UI 而非互相抢占
- ⚠️ SSH 终端选词的真实链路（SSH 会话中选中→浮层→翻译→Ask）待用户实测
- 📌 词典未命中是常态（代码片段），Ask 按钮是自然的兜底路径——"词典查不到就问 AI"成为产品闭环

---

## 2026-08-01 · P1 可信与安全三件套（真实落地）

**任务**：方案书 P1——HITL 审批闭环、证据链可视化、hash 审计链。用户强调"不看理想代码，要真实落地"。

**方案**：
1. **P1-1 真实审批闭环**：needs_you 加 threading.Event 等待-唤醒 + wait_for_response；高危命令 → 发审批 → 阻塞等用户 → 批准真正执行 / 拒绝返回 rejected / 30s 超时兜底；前端按钮调 needs_you.approve/reject RPC
2. **P1-2 会话证据链**：EvidenceTracker 记录真实工具调用（会话隔离、脱敏截断）；前端 AiChat 底部"证据"折叠区
3. **P1-3 hash 审计链**：sha256 前后链（prev_hash + canonical entry → hash）JSONL 落盘，verify() 检测篡改

**报错与修改（重要）**：
- **发现原审批是"显示层摆设"**：工具返回 needs_approval 后命令永不执行；前端"批准"按钮只消除本地卡片（无 RPC 回传）；事件字段名不匹配（needs_type vs type）导致卡片可能不显示——**假功能比没功能更危险**
- 测试 30s 真实等待：TestFourLevelPermission 3 用例走真实审批等待（90s）→ mock 审批等待（0.8s）
- needs_you.list_all 返回 dict 列表（非请求对象）→ 测试取 `["id"]` 而非 `.id`
- 审计链 verify 的 seq 检查误用字符串.get → 独立 expect_seq 变量
- 证据归属错误：用了 SSH session id 而非对话 session id（ctx.session_id）→ 修正

**复盘**：
- ✅ 真实落地 = 先审计现状（前端按钮是否真回传、事件字段是否对齐），再实现——"看起来有"的功能要先验证
- ✅ 审批闭环测试用真实服务 + 线程模拟用户（0.9s 完成），比全 mock 更有说服力
- ✅ 测试提速（90s→0.8s）与功能落地同等重要——慢测试会掩盖回归
- 📌 hash chain 固有限制：截断尾部不可检测（删最后记录），篡改中间可检测——文档记录边界
- 📌 审计链/证据表/事件流三者职责分离：防篡改日志 / 会话 UI 数据 / 实时推送

---

## 2026-08-01 · P0-6 Agent 全链路打通：main 统一入口 + 自主委派 + 可视化

**任务**：用户要求 main 为主对话入口，按任务自动调用子 agent；子 agent 调用可视化（参考 Terax run_subagent UI）；跑完全链路。

**方案**：
- main agent 工具集 = 7 运维工具 + 4 子 agent 工具（Strands 官方 Agent.as_tool()）
- _MAIN_SUB_AGENT_PROMPT 注入委派说明，LLM 自主识别意图委派 teach/coding/explore/history
- 子 agent 用 _SilentCallbackHandler 防文本污染；中间事件经 tool_stream/data+agent/toolResult 到达 main handler 统一转发
- 前端复用工具行管道：agent:<name> 工具卡片（徽标 + 委派输入摘要 + 折叠全文）+ Pill 联动（main→子agent→main 归位）

**报错与修改（重要）**：
- **tool_stream 事件重复触发 started（10 次）**：tool_use 每次都带 name → 按 tool_use_id 去重
- **真 bug：工具 tool-output 静默丢失**：消费循环在 invoke 已 resolve 时仍调 queue.next()——next() shift 的 item 因 race 输给 invoke 分支而永久丢失。修复：invokeResolved 预检后退出循环走 drain。**该 bug 影响所有工具，旧孤儿测试是 bug 掩盖下的假通过**
- 子 agent 的 data 增量在 tool_stream 包装内（子 agent 用静默 handler 后不到达独立 data 事件）→ 从 tool_stream_event.data.data 提取
- e2e 断言工具事件用 kwargs（emit 是关键字调用）

**复盘**：
- ✅ 事件协议用实测探针确认（打印 Strands callback handler 收到的 kwargs），不猜 API
- ✅ 子 agent 事件统一经 main handler 转发 = 单一出口，避免双份 emit
- 📌 async 消费循环的 race 竞态是隐蔽 bug 温床——"先创建 promise 再 race"的副作用（shift）要警惕
- 📌 前端管道复用（tool-input/tool-output）比新建协议更稳——agent 卡片零新协议

---

## 2026-08-01 · P0-1~P0-5 方案书落地（多 agent / 真流式 / 超时 / 降级 UI / 测试）

**任务**：方案书 v1.0 拍板后（B 方案：Strands 多 agent），P0 五项全做。

**方案**：
- P0-1：_SUB_AGENT_SPECS 注册表（main/explore/teach/coding/history 真实 Strands 实例 + 工具白名单 schema-level safety），删除关键词路由模拟
- P0-2：确认 Strands 事件流式为主路径（agent_message → text-delta），切片降级为 LangGraph 兜底
- P0-3：超时可配置——修复 Rust 硬 30s 会在前端 60s 前掐断的隐藏 bug（REQUEST_TIMEOUT 30→60s + per-request timeoutMs）
- P0-4：buildSidecarErrorHint 结构化错误提示（超时/未运行/降级/LLM 分类）+ degraded 标志
- P0-5：前端 4 文件补 25 用例 + Strands 真实 e2e（FakeModel 实现 Model 协议）

**报错与修改**：
- Strands Model 抽象方法（get_config/structured_output/update_config）+ stateful 属性 → FakeModel 补齐
- Agent 无 .tools 属性 → 用 .tool_names
- MockLLMWarning 组件测试：Tooltip 需 Provider 包裹 + 事件在 listener 注册前触发（waitForListener）

**复盘**：
- ✅ e2e 用 FakeModel（实现 Model 协议）验证真实 Strands agentic loop，比 mock Agent 强得多
- ✅ schema-level safety（工具白名单）在 agent 维度生效——explore/teach 无 ssh_command
- 📌 测试发现真 bug 的价值 > 测试本身（tool-output 丢失、Rust 超时遮蔽）

---

## 2026-08-01 · 方案书 v1.0 定稿

**任务**：用户要求基于痛点 + 调研报告制定完整方案书（不做理想化，以代码事实为基线）。

**方案**：
- 7 章结构：现状诊断（3 类痛点）/ 产品定位（人机协同运维搭档）/ 技术选型定论（Strands 单框架收敛）/ 总体架构 / 工程治理 / 路线图（P0-P3）/ 风险
- 用户拍板：B 方案（Strands 多 agent）+ P0 全做
- 上一级目录旧文档判定为 Electron 时代污染源（技术栈结论作废），仅采纳 DNA 一致思想

**复盘**：
- ✅ 方案书先诚实披露"9-Agent 未在主路径集成"的事实，再定方向——避免继续漂移
- ✅ 用户"先定方案书再实施"的顺序正确：方案书是后续所有工作的对齐基准
- 📌 文档漂移是系统性风险：方案书 = 唯一权威，竞赛材料冻结归档

---

## 2026-08-01 · P2-4 知识库完整落地（sqlite-vec + BGE + FTS5 混合检索）

**任务**：用户要求——知识库真实落地（调研发现原知识库四缺：空库/embedding 降级 hash/主路径未接入/无内容源），集成主流开源 RAG 方案，教学解释要讲 Linux 哲学。

**方案**：
- 三路调研：本地代码审计（四缺铁证）+ 上级目录（旧版已选 BGE-small-zh + sqlite-vec，选型正确可继承）+ 网上调研（11 项目对比：RAGFlow/Dify 平台化不采用，sqlite-vec 单文件零服务最适合桌面端）
- 选型：sqlite-vec（vec0 KNN）+ BGE-small-zh-v1.5（fastembed ONNX，512 维，中文优化）+ FTS5（jieba 分词）双路 RRF 融合
- 内容源四路：内置教学语料（12 条，含 Linux 哲学）自动索引 / 文档导入分块 / 会话案例沉淀（决策库雏形）/ 在线爬取
- Strands 接入：knowledge_search 工具（main/teach/history/explore），main prompt 加知识库指引

**报错与修改（重要）**：
- **rowid 不一致导致检索回查为空**：entries 表自增 rowid 与 FTS5/vec0 的确定性 rowid（md5(entry_id)）不匹配 → hybrid_search 按 rowid 查元数据全空。修复：三表统一确定性 rowid
- **fastembed 模型加载 30s 超时**：测试环境每次 add 尝试下载模型（WinError 10060）。修复：knowledge/tests/conftest.py 跳过真实模型（hash 兜底），测试 127s → 2s
- **jieba 上下文分词不一致**："php-fpm" 切分随上下文变化 → FTS5 查询偶发不命中。教训：测试用稳定词；未来可考虑 trigram tokenizer 兜底
- HF 下载超时 → HF_ENDPOINT=https://hf-mirror.com 镜像下载成功（模型已缓存 .tdsf-data/models）

**复盘**：
- ✅ 上级目录旧选型（BGE+sqlite-vec）与 2026 网上调研一致——历史调研结论可以继承，不必重复选型
- ✅ "先审计现状再实现"再次验证：空库/hash 降级这些事实不查代码永远不知道
- ✅ 三表 rowid 统一是 SQLite 混合检索的关键细节（FTS5/vec0 都要显式 rowid）
- 📌 测试隔离（conftest 跳过模型加载）是知识库测试的必备项——真实模型下载会让测试不可重复
- 📌 教学语料每条含"哲学"维度（一切皆文件/组合小工具/最小权限）——呼应"教学解释到 Linux 哲学"需求
- 📌 待办：知识库管理 UI（浏览/导入页面）、TeachCard 教学卡片渲染（P2-1）

---

## 2026-08-01 · 上级目录挖掘与继承（知识库为样例，系统性继承）

**任务**：用户指示"以知识库为例，充分挖掘上级目录内容，看能否被本项目继承优化"。

**挖掘成果**（2 个并行 agent 调研 projects/ + 旧版实现）：
- **projects/**（火山杯 TDSF-Linux 完整仓库）：decision_cards 表结构（8 态状态机/card_json 契约/FTS5/audit_logs）、risk_rules.yaml（4 级风险规则库 low19/medium10/high7/deny3）、grounding/confidence/sampling 算法、error_handler 8 类错误模式库、local-linux-agent knowledge_base 9 份教学 md、SKILL.md 6 大板块教学法、learned_commands 90 命令档案、rollback_manager 检查点回滚
- **旧版实现**（tdsf-linux-desktop）：触发器式 vec0/FTS5 自动同步、回填服务（断点续传/ETA）、FTS 查询转义、来源标记（fts/vec/both）、BGE 中英前缀切换、教程内容管线（质量过滤/稳定 ID）、UI 设计（knowledge-detail 教学分段/man-page 风格/置信度环）
- **防污染红线**：src/tdsf 整体代码不引入（自研 v4.0.0 已废弃），只继承数据资产/算法/设计思想

**已落地**（4 提交）：
1. 9 份教学素材 md 入库（90 命令档案/概念图谱/词源/FHS/哲学等）→ 内置语料 516 条
2. RAG 增强：FTS5 查询转义（引号包裹防注入）+ BGE 中英前缀自动切换 + RRF 来源标记（fts/vec/both + rrf_score 支撑 UI 匹配徽章）
3. Teach prompt 升级：继承 SKILL.md 6 大板块教学法（💡原理/📂路径拆解/🏛️哲学/📝示例/⚠️易错/✏️先想再敲）+ 强制先查知识库再讲解
4. 测试修正（hash 向量降级下 empty-kb 语义变化）

**待落地**（后续按方案书推进）：
- 决策库：decision_cards 表结构移植（add_case 升级为完整决策卡：根因/证据链/修复/回滚/成功率）
- risk_rules.yaml 迁移为 RiskChecker 规则源（4 级规则）
- 触发器式 vec0/FTS5 自动同步（替代手动三写）
- 知识库管理 UI（knowledge-detail 教学分段设计）

**复盘**：
- ✅ 上级目录是金矿：旧项目完整实现了方案书大部分蓝图（决策卡/可信度/风险引擎），代码不能引入但结构/算法/数据资产可直接继承——"继承优化"比"从零重造"快一个数量级
- ✅ 防污染红线与继承不矛盾：不引代码、引资产（表结构/规则/语料/教学法）
- ✅ 教学素材入库直接受益 Teach（词源/哲学/90 命令档案是分水平讲解的数据源）
- 📌 后续每个 P 阶段先查上级目录是否有现成资产，再动手

---

## 2026-08-01 · P2-1 Teach 教学卡片 + 16 条工作准则

**任务**：teach 教学卡片（Terax 风格 6 大板块分区渲染）；用户补充 16 条工作准则并要求用上前后端 skill。

**实现**（7aa2909）：
- TeachCard.tsx：教学卡片（头部 Teach 徽标 + 分区卡片 + 命令行复制/插入终端 + 追问）
- teachParser.ts：教学 markdown 解析（emoji 板块/## N. 标题 → 分节，代码块提取命令）——纯函数与 UI 分离（react-refresh 规范）
- AiChat：流式完成后 isTeachMessage 检测 → TeachCard
- frontend-ui skill 激活：按规则审查（组件 memo、语义 token、MessageResponse 复用、touch target 项目一致性）

**报错与修改（重要）**：
- **emoji 代理对正则问题**：`[💡📂...]` 字符类在 JS 按 UTF-16 单元匹配，replace 后残留低代理位（"\udca1 为什么"）→ 改 startsWith 逐 emoji 匹配
- **TerminalSquareIcon 不存在**：导入不存在的 icon → HugeiconsIcon 渲染崩溃（currentIcon is not iterable）→ 换 TerminalIcon（验证存在性再导入）
- **isTeachMessage 长度门槛挡住短教学标题**：`## 1. 概念与原理`（<20 字符）被误拦 → 标题正则优先，长度门槛只用于 emoji 检测
- **heredoc 转义写入真实换行**：python 写 TS 文件时 `\n` 被转成真实换行 → 用 Edit 工具逐处修复
- **detectSectionType 正则要求 # 前缀**：传入的 title 已剥离 # → 正则改为纯关键词

**复盘**：
- ✅ frontend-ui skill 的 react-refresh 规范（组件/函数分离）避免了热更新问题——skill 用上了
- ✅ 图标导入必须验证存在性（icon 拼写错误在运行时崩溃，测试才暴露）
- ✅ emoji 处理要小心代理对（startsWith 逐字匹配最稳）
- ✅ 测试驱动暴露了 3 个真实 bug（icon 缺失/长度门槛/类型判定）
- 📌 用户 16 条准则已固化 CLAUDE.md §6.5（skill 优先/环境前置/调研先行/自动记忆沉淀）

**下一步**：TeachCard 需真实 LLM 输出验证（teach agent 是否按 6 大板块输出）；知识库管理 UI；决策库移植。

---

## 2026-08-01 · 知识库可视化（左侧栏）+ 右下角卡死黑屏调查

**任务**：①知识库界面移到左侧 skill 旁（用户要求）；②点击右下角 AI 入口卡死黑屏（用户报告）。

**实现**（1de85b0）：
- SidebarRail 新增 knowledge 视图（BookOpen01Icon，Skills 旁）
- KnowledgeBrowser 重构：KnowledgePanel（内嵌面板：搜索+列表，lazy 加载满足启动预算测试）+ KnowledgeDetailDialog（点击条目弹窗，MessageResponse md 渲染像看本地文件）
- TdsfAgentPanel 清理：发现该组件已被弃用（App 实际用 AiMiniWindow），移除其中知识库挂载（死代码）

**卡死调查（systematic-debugging Phase 1-3）**：
- 证据：sidecar 日志无错误、Rust 无 panic、terax 进程消失（窗口已关）
- 发现：KnowledgeBrowser 原挂在弃用组件 TdsfAgentPanel 上——不影响实际 UI，排除为卡死根因
- 浏览器（vite dev）无法完全复现（web 模式 isTauri=false 降级）
- 可疑改动已清理（死组件挂载移除）；AiChat 的 EvidencePanel/TeachCard 改动审查无渲染循环风险
- **待用户验证**：重启应用后点击右下角是否仍卡死；若仍卡死需提供：卡死时控制台报错（F12/CDP）或复现步骤

**复盘**：
- ✅ lazy 加载约束（eager-budget 测试）拦截了 App 静态 import markdown 栈——启动预算测试有真实价值
- ✅ 弃用组件（TdsfAgentPanel）上继续加功能是错误——先确认组件是否实际使用再改
- 📌 桌面 GUI 卡死无法远程复现时，需用户配合收集 WebView 控制台证据

---

## 2026-08-01 · 知识库浏览模式修复 + 左下角 agent 黑屏调查（进行中）

**任务**：①知识库打开即显示（浏览模式）；②左下角 agent 按钮黑屏卡死（用户复现）。

**完成（bd5a58c）**：
- 后端 knowledge.list RPC + RagIndex.list_entries（按入库倒序分页）
- KnowledgePanel 挂载即自动加载列表（像文件列表），空查询回浏览模式，点击条目弹详情（md 渲染）

**卡死调查进展（systematic-debugging）**：
- 路径已确认：左下角 AiOpenButton → openMini → **AiMiniWindow → AiChatView**（本会话改动：EvidencePanel + TeachCard 分支）→ 黑屏
- 已排除：sidecar 日志正常、Rust 无 panic、TdsfAgentPanel 死组件（已清理）
- 待办：WebView2 CDP（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 重启 tauri dev）→ 用户点击复现 → chrome-devtools-mcp 抓 console 错误定位根因
- 高嫌疑：AiChatView 的 EvidencePanel 挂载位置（ConversationContent 内）或 TeachCard 分支渲染

**复盘**：
- ✅ 用户两次复现（右下角/左下角）→ 打开 AI 面板路径稳定触发，CDP 抓错是正解
- ✅ 知识库"打开即浏览"是正确 UX——搜索前置会让人觉得"没内容"
- 📌 下一轮优先：CDP 抓 console → 根因 → 修复 → 用户验证

---

## 2026-08-01 · 黑屏根因确认：误杀用户进程（教训：只按 PID 杀）

**事件**：用户报告"点击左下角 agent 黑屏闪退"，多轮调查（sidecar/Rust 日志正常、CDP 无渲染错误、AiChat 改动无渲染循环）。用户揭示真相：**同时开着原版 Terax 终端**，我 `Stop-Process -Name terax` 按进程名批量杀，把用户正在用的窗口（原版或应用）误杀 → 黑屏。

**根因**：按进程名批量杀进程（terax 同名冲突：原版 Terax 与魔改应用二进制同名）。

**规则（加入工作准则）**：
- 杀进程**只按 PID 精确杀**（先 netstat/Get-Process 确认 PID 与命令行归属），绝不 `Stop-Process -Name` / `taskkill /IM` 批量杀
- 重启应用前先检查：端口占用进程是否本项目 vite（查 CommandLine 含本项目路径）；terax 进程区分启动时间/窗口标题

**复盘**：
- ✅ 系统化排查排除了应用 bug（日志/CDP/代码审查三路证据）——黑屏确系外部操作（误杀）所致
- ✅ CDP 捕获脚本（node + WebSocket 连 WebView2）是 Tauri 桌面调试的有效工具，保留复用
- 📌 用户环境有同名进程时，操作前先确认归属

---

## 2026-08-10 · 全系统架构审计 + P0-P2 系统性修复（开源准备）

**任务**：用户要求"从底层架构和逻辑深度调研分析当前是修补还是真实落地，奔着开源去用，稳定性和质量优先"

**方案**：
1. 派 4 路并行子代理审计 13 个子系统 70+ 文件（逐文件阅读 + grep 验证 + 调用链追踪）
2. 生成完整架构审计报告 `docs/ARCHITECTURE-AUDIT-2026-08-10.md`
3. 按优先级系统性修复全部问题

**审计发现**：
- 9/11 模块真实落地（SSH A−、AI 引擎 A−、终端 A、翻译 A、文件管理 A−、主题 A−）
- 2/11 模块有应付痕迹（服务器监控 B−、命令预测 C+）
- 命令预测有 2 个致命 bug（功能完全不可用）
- 服务器监控有虚假声称有测试（实际零测试文件）

**修复内容（P0-P2 共 15 项）**：

P0（致命 — 功能不可用）：
1. **getCurrentPrefix 提示符污染** → 重写为按键追踪缓冲区方案（不从 xterm buffer 反推，完全消除提示符依赖）
2. **read_shell_history Rust 命令未注册** → 注册到 `generate_handler!` + 首次按键自动调用 `loadHistoryIfNeeded`
3. **Enter 不 acceptPrediction** → 弹窗可见时 Enter 接受选中项再透传
4. **fuzzysort threshold 语义验证** → 确认 v4 已改为 0-1 正向分数，0.3 正确

P1（高优先级 — 精度 + 稳定性）：
5. **lastCollectTime 死字段** → 写入真实时间戳，网络速率精度修复
6. **并发请求无锁** → 加 isCollectingRef 锁
7. **无 Error Boundary** → ServerMonitorPanel 包裹 MonitorErrorBoundary
8. **collectOverview 静默吞错** → 加 console.warn
9. **parser 虚假声称有测试** → 创建 28 个测试用例覆盖 8 个核心解析函数
10. **setServerMonitorInterval 缺校验** → 加白名单校验
11. **suggest-engine 零测试** → 创建 10 个测试用例
12. **SSH inactivity_timeout 30s 太短** → 改为 300s

P2（中优先级 — 清理 + 文档）：
13. **删除 3 个死代码文件** → use-ssh-completion.ts / SshCompletionPopup.tsx / use-completion.ts
14. **CLAUDE.md 文档同步** → Monaco→CodeMirror / visible:false→true / 16→15 主题
15. **KNOWLEDGE-INDEX 更新** → 新增架构审计报告 + 方案书草案 + iShell 调研

**报错与修改**：
- TS2304 XTerm 类型错误 → 保留 import type 用于函数参数签名
- TS6133 getTermFn 未使用 → 重命名 _getTerm 并注释说明不再需要

**复盘**：
- ✅ 做对：先审计再修复，用并行子代理高效完成大规模审计
- ✅ 做对：P0 修复用"按键追踪缓冲区"根治提示符污染，而非正则补丁
- ⚠️ 改进：命令预测功能在首次实现时就应做端到端测试（连接 SSH → 输入命令 → 验证弹窗出现），而不是只验证前端状态
- 📌 经验：**注释声称有测试但实际不存在** = 最严重的"应付展示"信号；开发完成后的代码审计应成为标配

**五绿门禁**：typecheck ✅ | lint ✅ | test ✅ 944(+40) | build:web ✅ | cargo check ✅

---

## 2026-08-01 · P2-3 运维工具集 7→12 扩展

**任务**：方案书 §4.3 工具扩展路线——新增 service/package/firewall/security/performance 5 个运维工具。

**实现**（8184067）：
- ops_extended.py：5 个工具（同构：参数校验 + 命令构造 + execute_via_ssh 统一风险检测/审批/脱敏/审计）
- 写操作（start/stop/restart/install/remove/add_port）自动走 4 级权限审批（L3+ 写操作审批）；只读（security_audit/performance_analyze）直接执行
- 挂载矩阵：main 全 5 / coding 5 / explore 只读 2（teach/history 保持轻量不引入）；L1 免确认下写工具从注册表移除（schema-level safety）
- 前端 Tool 组件标签：服务/包管理/防火墙/安全审计/性能

**报错与修改**：
- _L1_READONLY_TOOL_NAMES 未含只读扩展 → L1 下 security_audit 被误裁 → 补充
- 工具数断言连锁更新（8→13→17：main 含子 agent 工具与扩展）

**复盘**：
- ✅ 工具统一走 execute_via_ssh = 安全机制自动继承（审批/脱敏/审计零重复代码）
- ✅ schema-level safety 在"权限维度 + 工具维度"双层生效（L1 裁写工具 + 子 agent 裁角色工具）
- 📌 agent 工具矩阵需显式设计（main 全量 / coding 运维写 / explore 只读 / teach 教学）——避免一刀切

---

## 2026-08-01 · P2-2 asciicast 回放 UI（保存 + xterm 时间轴回放）

**任务**：录制器已有（命令面板 record.start/stop，最小版只复制剪贴板），补齐保存 .cast 文件 + 回放 UI（教学复盘闭环）。

**实现**（49dd7d0）：
- AsciicastPanel：保存区（停止后预填文件名 → fs_write_file 到 ~/.tdsf-data/recordings/）+ 回放列表（fs_read_dir 过滤 .cast）+ CastPlayer（xterm 按 asciicast v2 事件时间轴重放 + 进度条）
- 复用现有 Rust 命令（fs_write_file/fs_read_dir/fs_read_file）——零新依赖
- 命令面板 record.play 入口；stopRecording 改为打开面板预填保存

**报错与修改**：
- **icon 存在性坑（第 3 次踩）**：Record01Icon/Save02Icon/RestoreIcon 均不存在（grep 计数会误报——源码字符串出现 ≠ 导出）。这次用 node ESM 精确验证（`import * as icons` + typeof 检查），替换为 RefreshIcon/ArrowLeft01Icon 等已验证图标
- 教训固化：**新图标导入前必须 node ESM 验证**（grep 不可靠）

**复盘**：
- ✅ 零新依赖方案（复用 fs 命令 + xterm）比加 dialog 插件更稳（不碰 capabilities 安全面）
- ✅ 教学闭环成形：录制 → 保存 .cast → 回放（课后复盘）+ 未来可导出分享
- 📌 xterm 回放与真实终端同渲染器，视觉一致

---

## 2026-08-01 · P2-5 终端翻译四修复（调研驱动）

**任务**：用户报告 4 个问题——SSH 选中不触发/卡片不消失/橙色样式不符/词库查不到+斜杠。要求先调研再修。

**调研（3 路）**：
- 网上：SSH 根因 = 远程程序鼠标上报模式（DECSET 1000+）下 xterm.js 默认禁用文本选择（PR #5953 确认）；点击清空选区不触发 onSelectionChange（#3193）；消失最佳实践 = mousedown 外部+Esc+blur；词库方案 = ECDICT/tldr/linux-command
- 上级目录 v140：**2279 条成品词典**（654KB，1911 command+250 option+33 error+85 term，含 example/syntax/detail）+ 7 级策略链（path→option→exact-phrase→command→word）+ category 守卫
- 本地自查：hideTooltip 无调用方（消失 bug 根因）、纯符号无过滤

**修复（cb4cd1b）**：
1. 词库：并入 2279 条词典 + 7 级策略链（路径含斜杠逐段/选项容错/短语/命令/单词/复合词）+ 纯符号过滤
2. 消失：mousedown 外部 + Esc + window blur 三重兜底
3. 样式：Terax 灰黑/白灰卡片（bg-card/95 + 词头等宽 + 示例/详细徽章分区）
4. SSH：xterm mouseEventsRequireAlt: true（鼠标上报模式下选择可用）

**报错与修改**：
- missing 分支与底部追问区重复 Ask 按钮（重复 testid）→ 统一底部
- 新图标导入前 node ESM 验证（本批无新图标）

**复盘**：
- ✅ 调研三路交叉验证根因（网上 xterm 机制 + 上级目录成品 + 本地代码审计）——一次修对
- ✅ 2279 条成品词典直接并入（654KB JSON import），比重建词库管线快一个数量级
- ✅ mouseEventsRequireAlt 是 SSH 选中问题的标准解（Cursor cloud 同方案）
- 📌 待实测：SSH 会话在 vim/htop 中拖选翻译（需真实服务器）；ECDICT 扩展 + lemma 还原为后续增强

---

## 2026-08-01 · sidecar 打包发布全链路 + 黑屏根因修复（全量工程收尾）

**任务**：L5 发布验证闭环——sidecar PyInstaller 打包、Rust 启动适配、安装冒烟、黑屏根因。

**sidecar 打包（onedir 决策）**：
- 初试 onefile 248MB：独立运行验证通过（ready/ping/status/shutdown + %APPDATA% 数据落盘），但**冷启动 30-60s**（解压到临时目录）远超 Rust READY_TIMEOUT=10s → 改用 **onedir**（启动 2-6s，冷启动 19.7s 也能在 60s 超时内）
- frozen 适配：main.py 数据目录 = %APPDATA%/tdsf-terminal-agent/.tdsf-data（Windows）/ XDG（Linux）；4 个可写目录模块（self_evolution/marketplace/crawlers/vector）frozen 分支重定向 TDSF_DATA_DIR；dev/pytest 行为零变化（1281 测试全过）
- spec：datas 打包 config/corpus/builtin 只读资源；excludes 保留 chromadb/torch/matplotlib（rag 主链路 FTS5 不需要），numpy 保留（fastembed/sqlite_vec 依赖）

**Rust 侧适配**：
- lib.rs locate_sidecar_script：探测 resource_dir + exe 目录两个候选（安装版/便携布局都覆盖）
- sidecar.rs spawn_python：exe 判定（python 或 script 是 .exe）→ 直接运行（PyInstaller 自带入口不接受 -u/script）
- sidecar.rs ready_timeout：打包 exe 60s / python 脚本 10s（动态字段）
- tauri.conf.json resources: ["sidecar/tdsf-sidecar/"]（onedir 整目录）

**黑屏根因（重大发现）**：
- tauri.windows.conf.json / tauri.linux.conf.json 残留 terax 上游 `transparent: true` + `decorations: false` + `shadow: false` + title: "Terax" + 硬编码 CDP——平台配置按 label 合并**覆盖主配置** → 透明窗口 → 打开 AI 浮层时 WebView2 透明合成 bug = 黑屏
- 修复：平台配置清理（只留 label）+ 硬编码 CDP 改为编译期附加参数（tauri 平台配置不支持 ${env:} 变量替换，实测确认）
- 验证：CDP 实测（9222）点击"统一主 Agent入口" → mini window 500x600 正常渲染、bodyLen 正常、console 零错误、截图主色 #1a1a1a（主题底色非黑屏）——**黑屏无法复现**
- 此前调查方向（AiChatView/TeachCard/EvidencePanel）全部排除——根因是透明窗口配置

**L5 安装冒烟**：
- 静默安装坑：Git Bash 直接跑 `setup.exe /S` 会被 MSYS 路径转换破坏参数（进程消失）；**PowerShell Start-Process -ArgumentList 正确**
- 安装包 402MB（含 747MB onedir sidecar，NSIS LZMA 压缩）→ 安装 → 启动：packaged sidecar exe 命中 → started successfully → 页面加载 tauri.localhost（打包资源）→ UI 正常
- targets "all" 改 ["nsis"]：Wix light 对 264MB+ 大包失败（MSI 不需要）
- installer-hooks.nsh：修复 terax 残留（terax.exe → tdsf-terminal-agent.exe，OpenInTerax → OpenInTDSF，卸载清理旧注册表）

**复盘**：
- ✅ onefile→onedir 决策来自实测（冷启动计时 19.7s vs 超时 10s）——打包方案必须实测，不能只看文档
- ✅ 黑屏根因是配置残留而非组件代码——排查方向曾误导（AiChat 组件审查），平台配置合并优先级是盲区
- 📌 MSYS 参数转义：Windows 下跑带 / 参数的程序用 PowerShell，不用 bash
- 📌 tauri 平台配置（tauri.windows.conf.json）按 label 合并主配置——残留配置会静默覆盖主配置，必须清理

---

## 2026-08-04 · dev 启动黑屏排查 + 启动方式教训（交接补充）

**背景**：全量工程收尾后用户要求"启动服务看看"。启动 dev 后窗口黑屏。排查出两个启动方式级教训。

**教训 1：长期运行命令禁止 `| head`/`| tail` 管道截断**：
- `pnpm tauri dev 2>&1 | head -30` —— head 读到 30 行后关闭管道 → tauri dev 写 stdout 收到 EPIPE → 进程被杀 → vite 死、窗口黑屏
- 构建类一次性命令（pyinstaller/tauri build）管道截断无害（命令会退出）；**dev/server 类长期进程必须完整重定向到文件**（`> log 2>&1`）

**教训 2：target/debug/sidecar/ 残留导致 dev 误用打包 exe**：
- tauri dev 构建时会把 resources（sidecar/tdsf-sidecar/ 747MB onedir）复制到 target/debug/
- locate_sidecar_script 的 exe 目录候选命中它 → dev 模式跑打包 exe（冷启动 60s+ 含杀软扫描）而非 python main.py（几秒）→ 窗口长时间深色 = 黑屏
- 修复：`rm -rf src-tauri/target/debug/sidecar` → dev 回退 main.py + python（10s 超时，几秒就绪）
- 教训固化：**dev 模式下若 locate 命中打包 exe，优先删 target/debug/sidecar 恢复脚本模式**；打包链路验证用 release/安装版

**验证**：删残留后 dev 正常（vite ready 448ms → python sidecar ready → CDP 9222 截图 bodyLen 114358、主色 #1a1a1a 主题底 + UI 元素，非黑屏）。

**复盘**：
- ✅ 黑屏排查路径：端口检查（9300/9222）→ 进程树 → locate 命中判定 → 删残留 → 恢复
- ✅ dev 模式 CDP（9222）可用：debug build 编译时读平台配置 additionalBrowserArgs 硬编码 → WebView2 CDP 直连抓渲染
- 📌 服务启动后必须 CDP 截图验证（bodyLen + 像素采样），不能只看"进程活着"

---

## 2026-08-07 · 审查修复独立复验（验证者视角）

**任务**：另一 AI 完成全面审查修复后，独立检查 + 复验门禁 + 更新进度。

**检查发现（别的 AI 的产出）**：
- 7 commits（bd007aa → 715b8cb）：41 项审查发现（5C/12H/15M/9L）→ 4 批修复净减 ~9500 行（含 308KB v4.0.0 死代码删除）
- 归档：docs/reports/CODE-REVIEW-2026-08-04.md（41 项）+ docs/CODE-REVIEW-LESSONS.md（方法论 + 8 条红线 + 血泪案例表）+ CLAUDE.md v2.1
- dev-state §37.25-37.30 完整记录；远程已推送

**独立复验（我跑的，非信任声明）**：
- typecheck ✅ / 前端 test 896 ✅ / pytest 1281 ✅ / cargo test 351 ✅（0 failed）
- 注意：**cargo test 统计被我的 tail -5 截断，重跑全量才拿到 351**——又一次验证"验证命令不要截断"（CODE-REVIEW-LESSONS R6 同款）

**复盘**：
- ✅ 独立复验是交接可信度的关键一步——声明 vs 实测交叉验证
- 📌 验证命令本身也要防截断（grep/tail 会丢统计）；完整统计用 awk 聚合

---

## 2026-08-07 · SSH 幽灵 sessionId 根因链 + 重启策略修复

**用户报告**：工作区 SSH 进入服务器后终端显示本地、资源管理器不接管。

**排查（双 Explore agent 并行）**：新建工作区（SpaceCreateDialog → connectSsh → createSpace → env.sessionId）+ 新建终端（openNewTab → sshSessionIdForSpace 绑定 → App 判定链 showSshTerminalInWorkspace）两条链路全排查。

**根因链（完整）**：
1. Space env.sessionId **持久化**（LazyStore）但 sshStore sessions 是**运行时态**
2. 应用重启 → 恢复 SSH Space（幽灵 sessionId）+ 恢复绑定幽灵 id 的 tab
3. 用户手动重连（新 session id）→ 绑定回调因 `!t.sshSessionId || t.sshSessionId === session.id` 匹配不上幽灵 tab → **终端永远本地**

**用户决策**：重启后回到初始选择/新建工作区界面（服务器可能关闭，让用户选择才是正常思路）。

**修复（4d0e8fd）**：
1. useSpacesBoot 重写（-123 行）：忽略持久化，每次启动 hydrate([], null) 进欢迎界面
2. sshSessionIdForSpace：session 存在性校验（失效 id 不绑新 tab）
3. 绑定回调 canRebind 放宽：失效 id 的 tab 允许新会话重绑

**验证**：typecheck/lint/test 896 全过；CDP 实测重启后显示"暂无工作区 + 新建本地/连接 SSH"欢迎界面。

**复盘**：
- ✅ 用户一句话决策（不记住）直接消除了持久化幽灵 id 这整个根因类——产品决策 > 技术补丁
- ✅ 双 Explore agent 并行排查两链路，交汇点（绑定回调条件）就是 bug 点——链路图思维
- 📌 教训再确认：python -c 内联多行 JS 必踩转义坑，一律写脚本文件（第 N 次）

---

## 2026-08-07 · SpaceCreateDialog 模式闪动修复（SSH 无法新建）

**用户报告**：新建工作区对话框点 SSH 会闪，无法新建 SSH 工作区；点本地工作区弹出 SSH 界面感。

**根因（读代码即定位，无需 CDP 复现）**：`SpaceCreateDialog.tsx:108-131` 的 effect 依赖 `[open, defaultName, loadSavedConnections, initialMode]`——打开期间用户输入 host → defaultName 变化 / loadSavedConnections 异步完成 → effect 重跑 → `setMode(initialMode)` **把用户选的 ssh 强制重置回 local** → 闪 + 无法 SSH。

**修复（8bf3fa0）**：initializedRef 保证初始化块（setMode(initialMode) + setName + loadSavedConnections）只在每次 open 的瞬间执行一次；关闭重置逻辑不变。

**验证**：CDP 实测——点"连接 SSH 服务器"→ ssh 激活 → 填 host/等 2.5s/再点 ssh 选项卡 → **模式全程保持**（修复前 t1 即重置）。

**复盘**：
- ✅ 用户描述的"闪"是模式重置的视觉表现——effect 依赖设计缺陷（初始化副作用混入响应式依赖）
- ✅ 读代码定位比 CDP 复现更快：effect 依赖列表 + setState 在 open 期间执行 = 高危模式
- 📌 教训：初始化副作用（setMode/setName/加载）必须与响应式重置分离，用 ref 门控一次性执行

---

## 2026-08-08 · WorkspaceFs 重构（P2-1~P2-4）— 用户导向的架构级修复

**任务**：SSH 资源管理器闪跳/空白（用户实测：远程树闪一下→回跳本地→空白）。用户指定参考 yazi 文件管理器（Engine trait 抽象），先调研（GitHub API 实证 yazi 架构）后写方案书（WORKSPACE-FS-REFACTOR-PLAN.md）再动手。

**关键决策**：
- 借鉴 yazi 的 **Engine trait**（完整文件操作语义 + capabilities 能力声明 + 实现分层），但落地为 Rust FsBackend trait + 前端统一 store，不照搬
- **树状态保留在 useFileTree**（UI 本地状态机 449 行，重写风险高），加 source 参数统一后端——**一套树 + 后端原子切换**，消除双轨 prop 切换的中间态（这是闪跳根因）
- 发现 Rust WorkspaceEnv 无 Ssh 变体（SSH 是前端概念）——resolve_root 按后端自持路径处理

**成果**：4 commits（672d9cc/27f2988/2e0844a/eff1755），Rust trait+双后端+统一命令 + 前端单 store + 降级 UI。门禁：前端 900 测试（+4 store）、cargo fs_backend 测试 3。

**复盘**：
- ✅ 用户两次纠偏价值巨大：①"不要自动操作界面"（R9 用户体验视角）②"参考 yazi 自成体系"（架构级方向）——重构从"打补丁"变成"正本清源"
- ✅ 渐进迁移（Rust 打地基→后端→前端替换）控制住了 449 行树逻辑的重写风险
- 📌 cargo test 全量被运行中应用锁住——大阶段验证需在应用重启窗口做

---

## 2026-08-08 · WorkspaceFs 验证发现 OSC 7 路径泄漏（第二根因）

**验证过程**（用户视角 CDP 采样）：创建 SSH Space 后远程树稳定（remote=true），但发现树错误 `[InvalidPath] 路径不属于当前文件系统: C:/Users/Lenovo`——**新路径泄漏**。

**根因**：SSH 绑定的 tab 在 TerminalStack 里也有**本地保活 pty**，其 OSC 7 上报本地路径 → `handleTerminalCwd` 无条件写入 SSH 会话 currentPathBySession → 远程路径被污染 → sftp 后端收到本地路径（InvalidPath 拒绝——**路径语义保护证明有效**）→ 树空白。

**修复（792b620）**：SSH 分支只接受 `/` 开头远程绝对路径；SshTerminalHost 的远程 cwd 走其内部 setCurrentPath。

**最终验证**：10/10 采样稳定（远程树 22 项持续显示，无闪跳/空白/降级横幅）。cargo test 全量 354 过（fs_backend 3 新增）。

**复盘**：
- ✅ **路径语义保护（实现层拒绝跨源路径）直接暴露了泄漏源**——"边界拒绝"设计不仅防 bug 还辅助定位
- ✅ 双根因（双轨竞态 + OSC 7 泄漏）都收敛于 WorkspaceFs 架构——用户"自成体系"判断正确
- 📌 验证脚本的"连续采样"模式（10×2s）能捕获闪跳类时序 bug——一次性断言会漏

---

## 2026-08-08 · SSH 终端选中翻译/Ask 无反应（调研驱动修复）

**现象**：SSH 终端选中内容不弹翻译卡片、不显示 Ask 按钮；本地终端正常。

**调研**（Explore agent 全链路）：选中捕获唯一入口 = document mouseup → closest(".xterm") → captureActiveSelection（App.tsx:1029-1046）——SSH 场景先查 `sshActiveLeafIdRef`（且 terminalRefs 含该 leafId）→ getSelection()。SSH 与本地共用 TerminalPane/rendererPool，差异只在 leafId 上报链。

**根因（CDP 实测 sshActiveLeafIdRef=null）**：
1. SshTerminalHost 在 **render 期**执行 onLeafId（React 19 并发渲染下副作用不可靠）
2. App "showSshTerminalInWorkspace 闪 false 即清 ref"——SSH 终端仍挂载时判定短暂闪烁误清 → ref 永久 null → captureActiveSelection 回退本地保活终端（选区恒空）

**修复（0475d4d）**：onLeafId 移入 useEffect（挂载设/卸载传 null），删除 App 闪动清除——生命周期与组件严格一致。

**复盘**：
- ✅ 调研报告直指"单一根因 + 运行时验证点"——先查链路再动手，避免了盲改
- ✅ CDP 实测（ref=null）把"可能原因"收敛为"确定根因"
- 📌 render 期副作用是 React 19 下的隐患模式（SshTerminalHost 原实现）——副作用一律 useEffect

---

## 2026-08-08 · SSH 选中翻译第二层调查（terminalRefs/slot 绑定）

**承接**：0475d4d 修复 leafId 上报（useEffect 生命周期）后，用户实测选中仍不弹浮层。

**调查链（CDP 运行时证据）**：
1. leafId 修复生效：HMR 后 `terminalHasLeaf(5)=true`（terminalRefs 注册 ✓）
2. 模拟拖选（用户操作路径）：xterm 有 selection（"@server ~]# ls"）但浮层不出现——**captureActiveSelection 返回空**
3. 定位：`captureActiveSelection` SSH 分支 = terminalRefs.get(sshLid).getSelection() → session.getSelection() → **getSlotForLeaf(5)=null**（SSH 的 leafId 5 没有 rendererPool slot！pool 只有本地 leafId=4）
4. **黑屏事件**：用户终端黑屏——检查发现**双 connected 会话**（rust=2 旧 + rust=3 新）+ `sshActiveLeafId=5` 但实际渲染 leafId=7——**ref 与渲染不同步**

**当前结论**：
- terminalRefs 注册问题已修复（useEffect）
- **剩余：SSH session 的 slot 绑定不稳定**——bindLeafToSlot 条件 `if (!s.container) return`（useTerminalSession.ts:770），attachSession 在 TerminalPane 挂载时一次性调用（:908）——SSH 的 openTransport 异步（handle 就绪后 session 才创建）→ 时序上可能错过 attachSession → container 恒 null → 永不绑定 slot → getSelection 空 + 潜在黑屏

**待验证**：用户重连 SSH（干净状态）——正常则收尾；失败则深挖 attachSession 时序。

**复盘**：
- ✅ CDP 诊断脚本（terminalHasLeaf/terminalRefsSize 只读暴露）是定位利器——三行暴露把"可能原因"收敛为"确定断点"
- 📌 黑屏 = 多重连接/重挂的边角状态（开发期 HMR 干扰大），发布版无 HMR 但多会话场景仍需关注
