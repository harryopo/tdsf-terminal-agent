# TDSF Terminal Agent — 开发规范与架构总纲（AI 接手必读）

> **位置**：`d:\ai\linux教学一体\tdsf-terminal-agent-clone\CLAUDE.md`
> **作用**：本文件是任何 AI（或人）接手本项目的**唯一入口规范**。定义项目身份、架构地图、防污染红线、五绿门禁、诊断方法论。
> **版本**：v2.2（2026-08-09 · 终端改动教训固化：新增 §3 红线 9 —— SSH 终端静默注入方案 A，取代前端 cd 拦截 hack）

---

## 0. 🚨 项目身份铁律（最高优先级，永久生效）

1. **本项目 = `crynta/terax-ai` v0.8.6 的魔改版**（"站在巨人肩膀上魔改"）。当前 git HEAD 的工作树就是**唯一正确的开发基线**。
2. **自研的 "tdsf-terminal-agent v4.0.0" 已被用户判定为垃圾并彻底废弃**——其 git 历史已于 2026-07-30 清理删除。**严禁**再从任何来源引入它的代码/配置/文档（防"污染"）。
3. **严禁**用 `git reset` / `git checkout -- <file>` / `git restore` 把**已跟踪文件**回退——历史上这样干过一次，把 terax 的 package.json 退回自研版、丢了 65 个依赖。撤销自己的改动请用 Edit 反向编辑。
4. 遇到**启动/窗口/架构类**问题，第一动作是**对照上游** `https://github.com/crynta/terax-ai`（同名文件逐行比对），不要自创方案。魔改要"有度"——只改必要处，保留上游架构与语言。
5. 当前进度、已知问题、本次恢复全过程见 `docs/dev-state.md`（第二必读）。

---

## 1. 这是什么项目（一句话架构）

**Tauri 2（Rust 壳）+ React 19 前端 + Python sidecar（AI 引擎）** 的桌面终端 IDE：终端优先、面向 Linux 运维教学，内置 SSH、远程文件资源管理器、代码编辑器、离线选词翻译、AI Agent 面板。

### 技术栈（实测确认，非臆想）

| 层 | 选型 |
|----|------|
| 桌面壳 | Tauri 2（Rust，`src-tauri/`） |
| 前端 | React 19 + TypeScript 5 strict + Vite 6 |
| 样式 | Tailwind v4 + `shadcn` + `tw-animate-css` + CSS 变量 |
| UI 库 | Radix UI（`radix-ui` 包）+ 自绘窗控 |
| 状态 | zustand v5 |
| 终端 | xterm.js 6 + FitAddon/WebGL/Unicode11 |
| 编辑器 | Monaco（本地加载，不走 CDN） |
| AI SDK | Vercel `ai` v7 + `@ai-sdk/*` |
| SSH | Rust `russh` 0.61 + `russh-sftp` 2.1 |
| PTY | Rust `portable-pty` 0.9 |
| 凭据 | Rust `keyring`（系统密钥库） |
| AI 引擎 | Python sidecar（`src-tauri/sidecar/`） |

### 端口约定
- Vite dev server：**9300**（`vite.config.ts` strictPort，与 `tauri.conf.json` devUrl 对齐）
- WebView2 远程调试（CDP）：**9222**（`tauri.conf.json` additionalBrowserArgs，调试排障用）

---

## 2. 架构地图（关键文件，改前先定位）

### 启动链（本次踩坑最深，务必理解）
```
src/main.tsx  ← 入口。按上游 terax 重写：
   ├─ import App from "./app/App"   ← 挂 terax 壳 (NOT 旧的 src/App.tsx!)
   ├─ invoke("pty_close_all")       ← 清理孤儿 PTY
   ├─ initLaunchDir()
   ├─ ReactDOM.createRoot(...).render(<App/>)
   └─ setTimeout(getCurrentWindow().show, 50/500)  ← 窗口 visible:false 创建, 首帧后由前端 show()
```
- 窗口配置：`src-tauri/tauri.conf.json`（`visible:false`）+ `src-tauri/tauri.windows.conf.json`（`decorations:false` `transparent:true` `shadow:false` 无边框透明）。
- 权限：`src-tauri/capabilities/default.json` **必须**含 `core:window:allow-show`/`allow-set-focus`/`allow-center` 等，否则 `show()` 被 Tauri 权限系统拦截、窗口永不可见。

### 前端（`src/`）
| 路径 | 职责 |
|------|------|
| `src/app/App.tsx` | **主壳**（`App` + `AppShell`），Provider 树、顶层 useEffect、布局。**约 1600 行，改前通读相关 effect** |
| `src/app/components/WorkspaceSurface.tsx` | 右侧工作区（终端/编辑器/预览/SSH终端 切换，含 invisible 挂载逻辑） |
| `src/modules/terminal/` | 本地终端。`lib/rendererPool.ts` = xterm 实例复用池（含 ResizeObserver 防抖 fit） |
| `src/modules/ssh-explorer/` | SSH 连接管理 + 远程文件树。`sshStore.ts`（zustand + 终端数据 fan-out）、`SshTerminalPane.tsx`（SSH 终端 xterm）、`SshExplorer.tsx`、`SshConnectDialog.tsx` |
| `src/modules/explorer/` | 本地/远程文件资源管理器（`FileExplorer.tsx` + `lib/useFileTree.ts`/`useRemoteFileTree.ts`） |
| `src/modules/editor/` | Monaco 代码编辑器 |
| `src/modules/theme/` | 主题系统。`ThemeProvider.tsx`（顶层 context + customThemes）、`themes/index.ts`（16 内置主题注册）、`useThemeFileEditing.ts`（背景图，**曾是卡死根因**）、`types.ts` |
| `src/modules/translate/` | 离线选词翻译。`linuxDictionary.ts`+`programmingDictionary.ts`（词典数据）、`translateApi.ts`、`translateStore.ts`、`TranslateTooltip.tsx` |
| `src/modules/shortcuts/` | 快捷键。`shortcuts.ts`（从上游恢复的单一真源 SHORTCUTS） |
| `src/modules/ai/` | AI 面板/工具/agent。`components/TdsfAgentPanel.tsx`、`tools/`、`agents/registry.ts`、`lib/composer.tsx`（AiComposerProvider 最外层） |
| `src/lib/ssh-bridge.ts` | SSH invoke 桥（sshConnect/凭据/主机验证事件） |
| `src/lib/sftp-bridge.ts` | SFTP invoke 桥（sftpList/Read/Write/joinRemotePath） |
| `src/store/runtime.tsx` | 运行时类型（SshSessionStateValue 等）|

### Rust 后端（`src-tauri/src/`）
| 路径 | 职责 |
|------|------|
| `main.rs` → `lib.rs` | Tauri 入口，`run()` 注册所有命令 + 插件 + 窗口 + sidecar 启动 |
| `modules/pty/` | 伪终端（portable-pty，spawn pwsh/bash） |
| `modules/ssh/` | SSH 客户端（`client.rs` russh、`credentials.rs` 凭据持久化、`handler.rs` 主机验证 emit `ssh:host_verify`/`ssh:host_key_mismatch`） |
| `modules/sidecar.rs` | Python sidecar 进程管理（spawn/health/restart，**restart 无退避，见已知问题**） |
| `modules/fs/` | 文件系统（tree/search/grep/mutate/watch） |
| `modules/secrets.rs` | 系统密钥库读写（keyring） |
| `sidecar/` | **运行时使用的 Python AI 引擎**（`main.py` + agents/）。注意：顶层 `python-sidecar/` 是自研旧目录，运行时不用 |

---

## 3. 防污染红线（每条都是血泪教训，违反=前功尽弃）

1. **0 字节源文件 = 被污染清空的信号**。发现 `.ts/.tsx/.rs` 是 0 字节，先从 `.bak`、上游 terax、或 git 历史恢复，切勿当新文件从零写。
2. **禁止 `git checkout/reset/restore` 已跟踪文件**（见铁律 3）。
3. **改依赖只用 `pnpm add/remove`**，改完 `pnpm install` 保持 lock 一致；绝不 `git checkout package.json`。
4. **useEffect 依赖数组禁止包含"effect 自身 setState 会替换的值"**（本次 50 万次/秒卡死的根因：`useThemeFileEditing` 的 effect 依赖 `availableImages` 而 effect 又 `setAvailableImages(新数组)`）。用 ref 存需要 cleanup 的资源，别把 state 塞进依赖形成自反循环。
5. **Context Provider 的 value 用 `useMemo`**，回调用 `useCallback`；顶层 Provider（AiComposerProvider/ThemeProvider）尤其重要，否则整树重渲染。
6. **zustand selector 别返回新引用**（`s => s.arr.filter()` / `s => ({...})`），必要时用 `useShallow`。
7. **启动/窗口/无边框/权限问题先比对上游 terax**，不自创。
8. **五绿门禁全过才算完成**，且必须 `pnpm tauri:dev` 桌面端实测（浏览器 dev 不等于 Tauri，很多 bug 只在 Tauri 首屏暴露）。
9. **终端/SSH 改动 = 牵一发动全身**（2026-08-09 教训固化：SSH 终端 cd 拦截 hack 把用户 `yum install httpd* -y` 改写成了 `cd...; printf OSC7`）：终端链路横跨本地 PTY、SSH PTY、xterm 解析、OSC 7/133、翻译选词、Teach 触发、cwd 同步、SFTP 联动等模块，改任何一处前必须 grep 全部调用点 + 通读相关 effect，**综合优化**而非局部补丁；**禁止**在前端输入路径做行缓冲/命令改写等"聪明"逻辑（远端 shell 行为交给远端注入脚本，见 `session.rs` 方案 A 静默注入 PROMPT_COMMAND/precmd）；改动后必须实测 SSH 终端 + 翻译 + 选词 + 文件树联动全链路。

---

## 3.5 AI 代码质量红线（2026-08-07 审查经验固化，动工前必读）

> 完整细则 + 血泪案例速查见 **`docs/CODE-REVIEW-LESSONS.md`**。以下为动工前必守的精简版：

1. **改动前先验证调用链**（最高优先）：任何删除/重构/签名修改，先 grep 找全部调用点 + 读上下文；方法 async 化时同步测试同步改 `#[tokio::test]`。
2. **结论必须实测**：不轻信审查报告/JSDoc/竞品 README/上游声称——russh Handle 实测无 Clone（报告说有）、agents/ 实测是三层结构（报告说冗余）。
3. **锁三不变量**：async 不跨 await 持锁（锁内无 await = double-check 安全）；对象不可 Clone 则缩锁到"建资源"一步立即释放；锁迁移粒度匹配竞争强度（真热路径迁 tokio::sync，std 线程/微秒临界区/冷路径保留并注释理由）。
4. **不静默吞错**：catch 必须有日志或降级注释；降级策略显式 `logger.warning(f"... fallback: {e}")`。
5. **不留幽灵代码**：写完自问"谁调用它"；删疑似死代码前 grep 验证（含 import/测试/字符串引用）。
6. **验证全量**：cargo check ≠ cargo test（集成 + doc test 是独立编译单元）；锁/签名改动后必须全量 `cargo test`。
7. **编辑纪律**：连续多次 Edit 同区域逐次 Read 确认；PowerShell 无 heredoc，git commit 用多个 `-m`。
8. **文档同步防漂移**：功能完成 = 代码 + 测试 + 文档三件套；回查方案书对应章节是否过时。

---

## 4. 五绿门禁（完成的唯一标准）

```bash
pnpm typecheck        # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint             # eslint . --max-warnings 0，0 错误 0 警告
pnpm test             # vitest run，当前 832 全过
pnpm build:web        # tsc -p app + vite build，成功出 dist
pnpm tauri:dev        # 桌面端实测：窗口可见 + 能点击 + 目标功能真的工作
```
- **豁免**只能在 `eslint.config.js` 显式配置并注明理由（如终端 ANSI 文件的 `no-control-regex`、best-effort 空 catch 的 `allowEmptyCatch`）。禁止散落 `// @ts-ignore`、大段 `eslint-disable`。
- tsconfig 用 **per-project `-p`** 检查（`incremental` 而非 `composite`）——composite 的声明可移植性检查在 pnpm 隔离布局下会误报 TS2742。

---

## 5. 诊断方法论（本次恢复沉淀，遇卡死/无限渲染照此做）

**现象：应用卡死、点击无响应、CPU 爆高。** 这几乎都是 React 无限重渲染。定位手段（主线程卡死时常规 evaluate 会超时，用以下绕过）：

1. **CDP 连 9222**（`curl http://127.0.0.1:9222/json` 拿 webSocketDebuggerUrl）。
2. **截图仍可用**（`Page.captureScreenshot` 走合成线程，不受主线程卡死影响）→ 先确认 UI 渲染了没。
3. **CPU Profiler**（`Profiler.start/stop`）→ 若热点全是 `measure`（React DEV 组件追踪 `logComponentRender`），且调用栈是 `flushPassiveEffects ← commitPassiveMountOnFiber` → **确认是 useEffect 无限循环**。
4. **`performance.measure` name 计数**（patch 它统计每个组件 render 次数）→ 定位哪些组件在重渲染；若全树 Radix 组件都高 → 顶层 state/context 每次变。
5. **无 "Maximum update depth exceeded" 报错** = setState 在 async 微任务里执行、逃过 React 守卫 = 典型"自反依赖"循环。
6. **`el.click()`（DOM 层）验证 onClick 逻辑**：CDP `Input.dispatchMouseEvent` 在 Tauri WebView2 里不等同真实鼠标，用 `el.click()` 才能真触发 React onClick。
7. 运行时受阻时，**派 general-purpose agent 静态通读顶层组件**（带上"passive effect 无限/全树/仅 Tauri 复现/无 max-depth 错误"这些证据），交叉验证锁定。

**验证修复**：patch 一个 `PerformanceObserver` 数 1 秒内 measure 次数，从 50 万降到 **0** 即为治愈。

---

## 6. 记忆保存机制（防止 AI 失忆 / 重复踩坑）

### 记忆文档位置（全部在项目仓库内，接手按顺序读）

| 文档 | 路径 | 内容 |
|------|------|------|
| **AI 入口** | `AGENTS.md` | 一句话指路（自动加载） |
| **开发规范总纲** | `CLAUDE.md`（本文件） | 身份铁律 + 架构地图 + 防污染红线 + 五绿门禁 + 诊断方法论 + 收尾规范 |
| **多 agent 协作规范** | `docs/MULTI-AGENT-WORKFLOW.md` | A/B/C 三场景分层 + 文件锁矩阵 + 改动影响分析表 + 接手声明模板 + 自检报告模板（接手必读第三文档）。⭐**协作规范唯一准绳**；早期 `.agent-collaboration/` 契约已废弃归档至 `docs/archive/agent-collaboration-20260728/` |
| **当前状态/进度/已知问题** | `docs/dev-state.md` | ⭐**唯一进度记忆源**：当前状态、已知问题及调研结论、本轮改动文件、恢复经验时间线、下一步 |
| **短/长期规划** | `docs/ROADMAP.md` | ⭐**规划唯一准绳**：方案书 P0-P4 路线图跟踪 + 短期任务清单 + 待用户决策项；任务收尾时更新 |
| **开发日志（经验沉淀）** | `docs/DEV-JOURNAL.md` | ⭐**经验沉淀**：每次任务收尾追加——任务/方案/报错与修改/复盘；报错根因与解法归档防重复踩坑 |
| **AI 代码质量红线** | `docs/CODE-REVIEW-LESSONS.md` | ⭐**防再犯错规范**：审查方法论 + 8 条质量红线 + 血泪案例速查（2026-08 审查 4 批修复经验固化） |
| **开源许可与魔改说明** | `docs/OPEN-SOURCE-AND-MODIFICATIONS.md` | 上游 Apache-2.0 义务 + 本项目原创贡献（比赛/合规用） |

> 不再使用任何项目外的记忆（如旧的 `.trae-cn` project_memory）；那属于已废弃的自研 v4.0.0。**唯一记忆源就是上表这几个仓库内文档**。

- **强制保存时机**：用户说"保存记忆/接手/今天到此"、完成一个可运行里程碑、遇到无法自解的阻塞、发现新的污染/踩坑。
- **保存内容**：做了什么（文件级）、遇到什么问题+根因+解法、用户确认的决策、下一步。
- **任务收尾三件事（每次任务完成强制执行）**：
  1. **git commit 固化**（全绿门禁：pytest/vitest/tsc/eslint/cargo check）
  2. **`docs/DEV-JOURNAL.md` 追加复盘**：任务目标 → 方案 → 报错与修改（根因+解法）→ 复盘（做对/做错/下次改进）
  3. **更新 `docs/ROADMAP.md` + `docs/dev-state.md`**：勾选完成项、更新下一步清单、写 §37.x 交接章
- 全绿且可运行的里程碑要**立即 git commit** 固化（安全回滚点）。
- 已废弃：自研的 7 步接手协议、方案书对齐检查、`.trae/specs` spec 驱动、CodeGraph、project_memory.md（这些属于被删的自研 v4.0.0，别再执行）。

---

## 6.5 工作准则（用户钦定 16 条，2026-08-01，最高优先级遵守）

1. **Skill 优先**：动工前先查全局 skill，有相关 skill 必须激活使用；无相关 skill 则全网搜索
2. **环境前置**：动工前先完成全量环境依赖校验，配置不通过则先配置好环境
3. **保质保量**：准确按照规划方案完成任务，禁止直接降质减配，不用最小可行方案；敲定了方案就按方案来
4. **遇阻即报**：环境问题无法闭环时及时反馈，不强行带病开发
5. **中文思考**：所有思考以中文格式输出
6. **本地资源优先**：全面查找分析本地现有资源（含上级目录/旧项目/历史资产），确保充分利用
7. **开发前调研**：开发前先全网搜集调研、查找开源项目及最佳实践，深入调研前置环境/注意事项/官方文档
8. **报错先查**：配置报错优先全网调研根因与最佳修复方案，不盲目猜测
9. **自动记忆**：完成任务后自动保存记忆、梳理当前与规划下一步
10. **自动沉淀**：完成后自动记录问题与方案，梳理优化方向（DEV-JOURNAL）
11. **方案归档**：调研、给出方案后自动保存为 md 文件（docs/ 下归档）
12. **上下文压缩**：对话过多时自动压缩上下文，降低幻觉
13. **规划先行**：大任务前先规划算法和架构，质量优先不盲目
14. **完整输出**：不因节省资源而省略任何信息
15. **真实质疑**：客观分析，用户说的觉得有问题要停下来确认清楚，不盲目开发
16. **诚实知止**：不知道就问清楚、做好调研再动工，不盲目开发

---

## 7. 决策边界

- **可自行决定**：代码实现细节、命名、注释、性能优化、bug 修复方式。
- **必须先问用户**（AskUserQuestion）：删文件/删 git 历史等不可逆操作、更换框架/新增重依赖、改动功能范围、UI 设计方向、"删还是保留"存量代码。

---

> **最后更新**：2026-08-09 · v2.2 · 终端改动教训固化（新增 §3 红线 9：SSH 终端静默注入方案 A，禁止前端命令改写）。上游参考：https://github.com/crynta/terax-ai
