# 技术栈开发参考（含注意事项/最佳实践/避坑点）

> 用途：本项目魔改与后期开发的技术栈参考，配套上游架构分析报告
> 调研依据：基于魔改版 `package.json` + `src-tauri/Cargo.toml` 实际依赖版本
> 生成时间：2026-07-30
> 调研方法：WebSearch + WebFetch 实际抓取官方文档（docs.rs / 官方站点），非凭记忆

---

## 0. 实际依赖版本清单

### 0.1 前端（package.json）

| 类别 | 依赖 | 实际版本 |
|------|------|---------|
| 桌面壳 API | `@tauri-apps/api` | `^2.1.1` |
| Tauri 插件 | `@tauri-apps/plugin-{shell,opener,os,store,notification,process,clipboard-manager,updater}` | `^2.x` |
| 框架 | `react` / `react-dom` | `^19.0.0` |
| 构建 | `vite` | `^6.0.0` |
| 类型 | `typescript` | `^5.7.2` |
| 测试 | `vitest` | `^2.1.8` |
| 状态 | `zustand` | `^5.0.14` |
| 终端 | `@xterm/xterm` | `^6.0.0` |
| 终端 addons | `@xterm/addon-{fit,search,serialize,unicode11,web-links,webgl}` | `^0.9–0.19` |
| 编辑器 | `@uiw/react-codemirror` + `@codemirror/*` | `^4.25.11` / `^6.x` |
| 编辑器（备用） | `@monaco-editor/react` + `monaco-editor` | `^4.7.0` / `^0.56.0` |
| LSP | `codemirror-languageserver` | `^1.22.0` |
| Vim 模式 | `@replit/codemirror-vim` | `^6.3.0` |
| AI SDK | `ai` | `^7.0.37` |
| AI Provider | `@ai-sdk/{anthropic,openai,google,groq,xai,cerebras,openai-compatible,react}` | `^3.x / ^4.x` |
| UI 原语 | `radix-ui` | `^1.6.7` |
| 样式 | `tailwindcss` + `@tailwindcss/vite` | `^4.1.0` |
| 样式辅助 | `tw-animate-css` / `tailwind-merge` / `clsx` / `class-variance-authority` | `^1.4.0` / `^3.6.0` / `^2.1.1` / `^0.7.1` |
| UI 工具 | `shadcn` / `cmdk` / `lucide-react` / `sonner` | `^4.16.0` / `^1.1.1` / `^0.460.0` / `^2.0.7` |
| Markdown | `streamdown` | `^2.5.0` |
| 虚拟列表 | `@tanstack/react-virtual` | `^3.14.8` |
| Schema | `zod` | `^4.4.3` |
| 其他 | `use-stick-to-bottom` / `react-resizable-panels` | `^1.1.6` / `^4.12.2` |

### 0.2 Rust（src-tauri/Cargo.toml）

| 类别 | 依赖 | 实际版本 | 备注 |
|------|------|---------|------|
| 桌面壳 | `tauri` | `2` | feature `protocol-asset` |
| Tauri 插件 | `tauri-plugin-{shell,opener,os,store,notification,log,process,clipboard-manager,autostart,updater,window-state}` | `2` | 按平台条件启用 |
| PTY | `portable-pty` | `0.9` | wezterm 维护 |
| 进程 | `shared_child` | `1` | 子进程信号 |
| 异步 | `tokio` | `1` | features `rt-multi-thread,process,io-util,sync,time,macros,fs` |
| 序列化 | `serde` / `serde_json` | `1` | — |
| SSH | `russh` | `0.61` | `default-features=false, features=["ring"]`（禁 aws-lc-rs 避免 Windows MSVC 编译失败） |
| SFTP | `russh-sftp` | `2.1` | 与 `channel.into_stream()` 集成 |
| HTTP | `reqwest` | `0.12` | `rustls-tls,stream` |
| 凭据 | `keyring` | `3.6` | 平台条件：`windows-native` / `apple-native`（Linux 未启用，见避坑） |
| Git | `git2` | `0.19` | libgit2 1.8 绑定 |
| Docker | `bollard` | `0.17` | feature `ssl` |
| 时间/UUID | `chrono` / `uuid` | `0.4` / `1` | — |
| 错误 | `anyhow` / `thiserror` | `1` / `1` | — |
| 文件监听 | `notify` | `8.2.0` | — |
| 搜索 | `ignore` / `grep-{regex,searcher,matcher}` / `nucleo-matcher` / `globset` | 各自最新 | — |
| 系统 | `windows-sys` (Windows) / `libc` (Unix) / `objc2-*` (macOS) | — | 平台条件 |

---

## 1. Tauri 2

### 1.1 核心 API 与架构

Tauri 2 采用「Rust 壳 + WebView 前端 + IPC 命令」架构。前端通过 `@tauri-apps/api` 的 `invoke()` 调用 Rust 端 `#[tauri::command]` 注册的命令；事件系统通过 `emit/listen` 双向通信。窗口由 `WebviewWindow`（v2 把 v1 的 `Window` 重命名）管理，标签（label）是唯一标识，仅允许 `a-zA-Z-/:_` 字符。

关键破坏性变更（v1 → v2）：
- 配置结构按 RFC#5 重组：`tauri.bundle` 提到顶层 `bundle`，`build.devPath` 改名 `devUrl`（只接受 URL，不再接受路径），`build.distDir` 改名 `frontendDist`。
- `Window` → `WebviewWindow`，`Manager::windows` → `Manager::webview_windows`。
- 引入 ACL（访问控制列表）权限系统：所有插件命令默认被阻止，必须在 `capabilities/*.json` 显式声明。
- 事件系统重构：新增 `EventTarget` 枚举，`emit_to` 按 label 过滤，`listen_global` 改名 `listen_any`。

### 1.2 与本项目相关的关键配置

**窗口 visible:false + 首帧后 show 模式**（本项目启动链核心）：
- `tauri.conf.json` 中窗口 `visible:false`，避免首帧空白闪烁。
- 前端 `main.tsx` 在 `ReactDOM.createRoot().render()` 后用 `setTimeout(() => getCurrentWindow().show(), 50/500)` 显示窗口。
- 必须配套 `src-tauri/tauri.windows.conf.json` 的无边框配置：`decorations:false, transparent:true, shadow:false`。
- `window-state` 插件文档明确推荐：窗口创建时 `visible:false`，由插件恢复状态后再 show，可避免窗口闪烁（与本项目模式一致）。

**capabilities 必备项**（缺一就被 ACL 拦截）：
```json
{
  "permissions": [
    "core:window:default",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-center",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close"
  ]
}
```
- `core:window:default` 不含 `allow-show`，必须单独追加。
- capabilities 文件放在 `src-tauri/capabilities/` 目录，按 `identifier` 引用；目录内所有 capability 默认启用，但 `tauri.conf.json` 一旦显式列出 `capabilities` 数组，只有列出的生效。
- capability 按 `windows: ["main"]` 绑定到具体窗口标签；多窗口共享时合并权限边界。

**dev vs build 行为差异**：
- dev：`devUrl` 指向 Vite dev server（本项目 9300 端口，strictPort），Tauri 直连 HTTP。
- build：`frontendDist` 指向 `dist/`，Tauri 把静态资源打包进二进制。
- 很多首屏 bug 只在 Tauri 桌面端暴露（浏览器 dev 看不到），因为 WebView2 与 Chromium 行为有差异。

**CDP 远程调试（9222）**：`tauri.conf.json` 的 `additionalBrowserArgs` 加 `--remote-debugging-port=9222`，启动后 `curl http://127.0.0.1:9222/json` 拿 `webSocketDebuggerUrl` 即可 CDP 连接。主线程卡死时常规 evaluate 超时，但 `Page.captureScreenshot`（合成线程）和 `Profiler.start/stop`（采样线程）仍可用——这是本项目诊断方法论的基础。

### 1.3 注意事项与避坑点

1. **`core:window:allow-show` 缺失 = 窗口永不可见**（本项目血泪坑）。`show()` 调用被 ACL 静默拦截，不报错但窗口不显示。启动前对照上游 capabilities 逐项核对。
2. **sidecar 重启无退避 = 重启风暴**。本项目 `modules/sidecar.rs` 的 restart 无指数退避，sidecar 反复崩溃时会形成重启风暴。生产级实现应有：失败计数 + 指数退避（如 1s/2s/4s/8s/上限 30s）+ 连续 N 次失败后弹窗而不是继续重启。
3. **`data-tauri-drag-region` 只对直接应用的元素生效**，不会冒泡到子元素；自定义标题栏的每个子交互元素都要单独处理。
4. **Linux/Android 上 Tauri 无法区分 iframe 请求与窗口本身请求**，远程 URL capability（`remote.urls`）需极其谨慎。
5. **`AppHandle::exit/restart` 在 v2 触发 `RunEvent::ExitRequested`**，不能在事件循环 handler 内同步调用。

### 1.4 最佳实践

1. **窗口配置分离**：`tauri.conf.json` 放基础配置，`tauri.windows.conf.json` 放平台特定的无边框/透明配置，通过 `--config` 叠加。修改窗口行为时优先改配置而非 Rust 代码。
2. **sidecar 健康检查 + 优雅退出**：spawn 后轮询 `/health`（每 500ms，超时 30s）；关闭主窗口时先 `POST /shutdown` 让 sidecar 优雅退出，10s 超时后强制 kill。日志通过 Tauri 接管 sidecar 的 stdout 写到文件，避免丢早期启动失败信息。
3. **CDP 9222 仅 dev 启用**，生产构建移除 `additionalBrowserArgs`，避免暴露调试端口。

### 1.5 官方文档链接

- [Tauri 2 官方文档](https://v2.tauri.app/)
- [Capabilities 权限系统](https://v2.tauri.app/security/capabilities/)
- [窗口自定义](https://v2.tauri.app/learn/window-customization/)
- [Window State 插件](https://tauri.app/plugin/window-state/)
- [Sidecar 指南](https://v2.tauri.app/develop/sidecar/)
- [Core Permissions 参考](https://v2.tauri.app/reference/acl/core-permissions/)

---

## 2. React 19

### 2.1 核心 API 与架构

React 19 的核心新特性：
- **Actions**：表单 action prop 直接接异步函数，自动管理 pending/error 状态。
- **`useActionState`**：替代 `useFormState`，配合 Actions 使用。
- **`useOptimistic`**：乐观更新，UI 先按预期值渲染，失败回滚。
- **`use`**：可在条件/循环中读取资源（Promise/Context），比 `useContext` 更灵活。
- **`useEffectEvent`**（实验性，19.2+）：返回稳定引用但始终访问最新闭包值的"事件"函数，专治 effect 依赖数组与最新值矛盾。
- **React Compiler 1.0**（19.2+）：自动 memo，减少手动 `useMemo/useCallback`。
- **`<Activity>`**（19.2+）：状态保持 + 性能优化，替代 `display:none` 保活方案。

### 2.2 与本项目相关的关键配置

**useEffect 自反依赖循环**（本项目 50 万次/秒卡死根因）：
- React 用 `Object.is` 浅比较依赖数组。如果 effect 依赖了"effect 自身 setState 会替换的值"，且该值是引用类型（对象/数组），就会形成自反循环：state 变 → effect 重跑 → setState 新引用 → state 变 → ...
- 典型反例（本项目 `useThemeFileEditing`）：effect 依赖 `availableImages`，effect 内又 `setAvailableImages(新数组)`，每次新数组引用都触发 effect 重跑。
- **关键陷阱**：这种循环**不会**抛 "Maximum update depth exceeded" 错误，因为 setState 在 async 微任务（如 `await` 后）里执行，逃过了 React 的同步守卫。所以排查时不能依赖报错，必须用 CPU Profiler 或 `performance.measure` 计数定位。

**Context Provider 性能**：
- 顶层 Provider（`AiComposerProvider` / `ThemeProvider`）的 `value` 必须 `useMemo`，回调必须 `useCallback`，否则每次父渲染都生成新 value，整树重渲染。
- React 19 的 Context 支持嵌套 Provider 部分更新，但仍需手动 memo。

**StrictMode 双调**：开发模式下 effect 会执行 setup → cleanup → setup 两次，用于压力测试 cleanup 是否镜像 setup。如果 cleanup 写得不对（如未取消订阅、未清定时器），生产环境会泄漏。

### 2.3 注意事项与避坑点

1. **async setState 逃过 max-depth 守卫**：`fetch().then(setX)` 或 `await setX` 形式的 setState 在微任务里执行，React 的同步循环检测抓不到，无限循环时不报错只卡死。必须用 `PerformanceObserver` 数 1 秒内 `measure` 次数定位（50 万 → 0 即治愈）。
2. **effect 依赖数组只放"外部输入"**，绝不放 effect 自身 setState 替换的值；需要 cleanup 的资源用 `useRef` 存，别把 state 塞进依赖形成自反。
3. **`useEffectEvent` 不是 `useCallback` 替代品**：它返回的函数只能在 effect/事件处理中调用，不能在渲染期间调用，也不能作为其他 Hook 的依赖。

### 2.4 最佳实践

1. **自反循环识别三步法**：① CPU Profiler 看热点是否全是 `measure`/`flushPassiveEffects`；② patch `performance.measure` 数 1 秒内调用次数；③ 定位全树高 render 次数的组件 → 检查其 effect 依赖是否含 setState 替换的值。
2. **顶层 Provider value 用 `useMemo`，回调用 `useCallback`**；这是性能底线，违反会导致整树重渲染。
3. **`useEffectEvent` 优先于 `useRef` 同步模式**：React 19.2+ 项目用它处理"需要最新值但不驱动 effect"的场景，代码更直观。

### 2.5 官方文档链接

- [React 官方文档](https://react.dev/)
- [useEffect 参考](https://react.dev/reference/react/useEffect)
- [React 19.2 useEffectEvent 解析](https://developer.cloud.tencent.com/article/2591350)
- [useEffect 依赖与闭包深入](https://juejin.cn/post/7665594862280982554)

---

## 3. russh 0.61 + russh-sftp 2.1

### 3.1 核心 API 与架构

russh 是纯 Rust + tokio 的 SSH2 客户端/服务端库（Thrussh 的 fork）。本项目用 `default-features=false, features=["ring"]`，禁用默认的 `aws-lc-rs`（Windows MSVC 编译需 NASM + alignas 支持，会失败），用 `ring` 作为预编译 crypto backend，Windows 零系统依赖。

**客户端连接流程**：
1. 实现 `russh::client::Handler` trait（至少覆写 `check_server_key`，默认实现拒绝所有 key）。
2. `russh::client::connect(config, addr, handler).await` → 返回 `Handle<H>`。
3. `handle.channel_open_session().await?` → 返回 `Channel<Msg>`。
4. `channel.request_pty(...)` → `channel.request_shell(true)` → 主循环读 `channel.wait()`。
5. SFTP：`channel.request_subsystem(true, "sftp")` 后 `channel.into_stream()` → `russh_sftp::client::SftpSession::new(stream).await?`。

**`Handler` trait 关键方法**（来自 docs.rs/0.61.2）：
- `check_server_key(&mut self, server_public_key: &PublicKey)` → 必须实现，返回 `bool` 决定是否接受主机密钥（TOFU 流程在此）。
- `disconnected(&mut self, reason: DisconnectReason<Self::Error>)` → 服务器断开时回调，覆写用于清理状态。
- `data(&mut self, channel: ChannelId, data: &[u8])` → 服务器发来数据（若不用 `into_stream` 走 channel 主循环，则在此处理）。
- `exit_status(&mut self, channel, exit_status: u32)` → 远程命令退出码。
- `channel_eof` / `channel_close` → channel 生命周期事件。

### 3.2 与本项目相关的关键配置

**`request_pty` 精确签名**（来自 docs.rs/0.61.2）：
```rust
pub fn request_pty(
    &mut self,
    channel: ChannelId,
    want_reply: bool,
    term: &str,              // 如 "xterm-256color"
    col_width: u32,
    row_height: u32,
    pix_width: u32,
    pix_height: u32,
    terminal_modes: &[(Pty, u32)],
) -> Result<(), Error>
```

**terminal_modes 真相**（本项目血泪坑）：
- SSH 协议（RFC 4254 §8）的 terminal modes 编码为 `(op_code, op_value)` 序列，以 `TTY_OP_END`（值 0）作为**终止符**，且 TTY_OP_END **后面不带 value**。
- russh 0.61 的 API 把 `terminal_modes` 类型设为 `&[(Pty, u32)]`，即每个元素必须是 `(Pty, u32)` 元组。
- **错误用法**：手动塞 `(Pty::TTY_OP_END, 0)` 当普通 op。服务器端会把 0 当 op code 解析（= TTY_OP_END），但 russh 仍按协议追加 op 后面的 u32 value，导致协议畸形；OpenSSH 检测到畸形后**硬关 TCP 连接**（不是返回错误，是直接断连）。
- **正确用法**：传空 `&[]`，让 russh 内部自动追加正确的 TTY_OP_END 终止符（不带 value）。让库用默认 modes，避免手撸协议。
- 如果确实需要自定义 modes（如关闭 ECHO），只放真正的 mode op（如 `[(Pty::ECHO, 0)]`），不要塞 TTY_OP_END。

**wait() vs into_stream() 的 receiver 共享**：
- `channel.wait()` 是消费式的 `Future<Output = Option<Msg>>`，每次取一条消息；多任务共享 channel 时不能多个 `wait()` 并发。
- `channel.into_stream()` 把 channel 转成 `AsyncRead/AsyncWrite` 的 stream，可与 `SftpSession` 配合；转换后原 `Channel` 不可再用。
- 多任务场景：主循环 `wait()` 接收数据 → 通过 `tokio::sync::mpsc` fan-out 到多个消费者（本项目 `sshStore.ts` 的 fan-out 模式）。

**channel 退出与主循环退出**：
- `exit_status` 回调或 `channel_eof` 表示远程命令结束。
- 主循环应在收到 `None`（channel 关闭）或 `exit_status` 后退出，避免泄漏。
- `Handler::disconnected` 是 session 级断开（非 channel 级），用于整体清理。

**known_hosts TOFU**：
- `check_server_key` 是 TOFU（Trust On First Use）的入口：首次连接记录指纹，后续连接比对。
- 指纹计算：`russh::keys::ssh_key::HashAlg::Sha256`（russh 重新导出 ssh-key crate）。
- randomart 显示：用指纹的 SHA256 base64 生成 BubbleBabble 或随机艺术图（参考 OpenSSH 的 `ssh-keygen -l -E sha256 -f` 输出格式）。

### 3.3 注意事项与避坑点

1. **`terminal_modes` 必须传空 `&[]`**，让库追加正确的 TTY_OP_END；手动塞 `(Pty::TTY_OP_END, 0)` 会让 OpenSSH 硬关 TCP（不报错直接断连，极难排查）。
2. **`check_server_key` 默认实现拒绝所有 key**，不实现就连不上任何服务器；TOFU 逻辑必须自己写。
3. **`ring` feature 在 Windows 零依赖**，`aws-lc-rs` 默认 feature 在 Windows MSVC 编译失败（需 NASM + alignas）；本项目已正确禁用默认 feature。
4. **`channel.into_stream()` 消费 channel**，转换后原 `Channel` 不能再用 `wait()`；SFTP 子系统走 stream，普通 shell 走 `wait()`，二者不能混用同一 channel。
5. **`Session` 不是 `Sync`**（docs.rs 明确 `impl !Sync for Session`），跨线程共享必须用 `Mutex` 或 `Arc<Mutex<Handle<H>>>`。

### 3.4 最佳实践

1. **PTY 请求统一用空 modes**：`session.request_pty(channel, false, "xterm-256color", cols, rows, 0, 0, &[])?`，让库处理 TTY_OP_END。需要自定义 modes 时只放真实 op，绝不放 TTY_OP_END。
2. **TOFU 流程**：首次连接 → 计算指纹 → 存到 `known_hosts` 文件；后续连接 → 比对指纹 → 不匹配时 emit `ssh:host_key_mismatch` 事件让前端弹窗确认（本项目 `handler.rs` 已实现）。
3. **SFTP 与 shell 分离**：用独立 channel 跑 SFTP 子系统（`request_subsystem("sftp")` + `into_stream()`），不与交互 shell 共享 channel；SftpSession 内部多路复用，单个 session 足够。

### 3.5 官方文档链接

- [russh 0.61 crates.io](https://crates.io/crates/russh/)
- [russh 0.61 Handler trait](https://docs.rs/russh/0.61/russh/client/trait.Handler.html)
- [russh 0.61 Session struct](https://docs.rs/russh/0.61/russh/client/struct.Session.html)
- [russh-sftp 2.1 文档](https://docs.rs/russh-sftp/2.1/russh_sftp/)
- [russh GitHub](https://github.com/Hoverbear/russh)

---

## 4. xterm.js 6 + addons

### 4.1 核心 API 与架构

xterm.js 6 是 TypeScript 编写的前端终端组件，采用「核心逻辑 + 渲染层 + 插件」分层架构。核心包零外部依赖（gzip 后 35KB），渲染层可选 DOM/Canvas/WebGL。被 VS Code、Hyper、Theia 等采用。

核心 API：
- `new Terminal(options)` 创建实例，`term.open(container)` 挂载。
- `term.write(data)` 写入数据（注意大输出要分块，避免阻塞主线程）。
- `term.onData(cb)` 接收用户输入。
- `term.resize(cols, rows)` 手动调整尺寸。
- `term.dispose()` 销毁实例，释放 WebGL 纹理等资源。

Addon 体系：每个 addon 是 `{ activate(term), dispose() }` 对象，通过 `term.loadAddon(addon)` 加载，`addon.dispose()` 卸载。

### 4.2 与本项目相关的关键配置

**渲染实例复用池（rendererPool）**（本项目 `lib/rendererPool.ts`）：
- 切 tab 时用 `visibility:hidden` 保活而非卸载重建，避免重复创建 Terminal 实例（创建成本高，WebGL 上下文有限）。
- 池化 xterm 实例 + addon 实例，按需 attach/detach 到不同 DOM 容器。
- detach 时不能 `dispose()`，只是把 `term.element` 从 DOM 移除；attach 时重新 `open()` 到新容器。

**ResizeObserver 防抖 fit**：
- 容器尺寸变化时 `FitAddon.fit()` 重新计算 cols/rows，但高频触发会卡顿。
- 用 `ResizeObserver` + 防抖（100-200ms）限制 fit 频率。
- 防抖实现：`setTimeout` + `clearTimeout`，或用 xterm 内置的 `TimeBasedDebouncer`。

**addon 全家桶**：
- `FitAddon`（`@xterm/addon-fit`）：自适应容器尺寸，核心方法 `fit()`。
- `WebglAddon`（`@xterm/addon-webgl`）：GPU 加速渲染，处理 10 万行日志比 DOM 快 6.67 倍；低端设备回退到 Canvas。
- `Unicode11Addon`（`@xterm/addon-unicode11`）：Unicode 11 宽字符支持，正确处理 CJK/emoji 宽度。
- `SerializeAddon`（`@xterm/addon-serialize`）：序列化终端缓冲区，用于恢复会话。
- `WebLinksAddon`（`@xterm/addon-web-links`）：自动识别 URL/IP 并可点击。
- `SearchAddon`（`@xterm/addon-search`）：终端内容搜索。

### 4.3 注意事项与避坑点

1. **`dispose()` 不调用 = 内存泄漏**：WebGL 纹理、ResizeObserver、事件监听都不会自动释放；切 tab 重建时必须 `addon.dispose()` + `term.dispose()`，且 ResizeObserver 要 `disconnect()`。
2. **大输出一次性 `write(hugeLogData)` 会阻塞主线程**：必须分块写入 + `requestAnimationFrame` 让出主线程。
3. **`rendererType` 配置在 6.x 中被 addon 模式取代**：不要在 `Terminal` options 里设 `rendererType:'webgl'`，而是 `term.loadAddon(new WebglAddon())`；WebGL 上下文失败时 catch 并回退到默认渲染器。
4. **`FitAddon` 计算依赖父容器无 padding/margin**，否则 cols/rows 计算错位。

### 4.4 最佳实践

1. **渲染实例复用池 + visibility:hidden 保活**：切 tab 不销毁 xterm，只 detach DOM；新建 tab 时从池里取空闲实例或创建新实例。池上限避免 WebGL 上下文耗尽（Chrome 上限 16 个）。
2. **ResizeObserver 防抖 fit**：`const debouncedFit = debounce(() => fitAddon.fit(), 150); observer = new ResizeObserver(debouncedFit); observer.observe(container);` 卸载时 `observer.disconnect()`。
3. **WebGL 优先 + 回退**：`try { term.loadAddon(new WebglAddon()); } catch { /* 回退默认 */ }`，低端设备或 WebGL 不可用时自动降级。

### 4.5 官方文档链接

- [xterm.js 官方文档](https://xtermjs.org/docs/)
- [Using addons 指南](https://xtermjs.org/docs/guides/using-addons/)
- [xterm.js GitHub](https://github.com/xtermjs/xterm.js)
- [FitAddon API](https://xtermjs.org/docs/api/addons/addon-fit/)

---

## 5. zustand v5

### 5.1 核心 API 与架构

zustand v5 是轻量级 React 状态管理库，核心 API：
- `create<T>((set, get) => ({...}))` 创建 store。
- `useStore(selector)` 订阅 store 切片。
- `useShallow(selector)` 浅比较 selector 返回值，避免引用变化触发重渲染。
- middleware：`persist`（持久化）、`immer`（不可变更新）、`subscribeWithSelector`（外部订阅）。

### 5.2 与本项目相关的关键配置

**selector 返回新引用 = 无限重渲染**（本项目血泪坑）：
- v5 对 selector 返回值用 `Object.is` 严格比较（v4 用浅比较）。
- 如果 selector 返回新引用（`s => s.arr.filter(...)` / `s => ({...})` / `s => [...s.items]`），每次 store 变化都返回新引用，触发重渲染；重渲染又执行 selector，又返回新引用……形成无限循环（"Maximum update depth exceeded"）。
- v5 比 v4 更严格：v4 只是性能差，v5 直接报错或卡死。

**`useShallow` 何时必须用**：
- selector 返回数组/对象字面量时必须用：`useStore(useShallow(s => [s.a, s.b]))` 或 `useStore(useShallow(s => ({a: s.a, b: s.b})))`。
- selector 返回原始值（string/number/boolean）或稳定引用（store 里已存在的对象）时**不需要** useShallow。
- useShallow 内部用 `useRef` 缓存上次值，浅比较后才决定是否返回新值。

**persist schema 迁移**：
- `persist(config, { name, version, migrate })` 中 `version` 是 schema 版本号。
- 升级 store 结构时，旧版本数据通过 `migrate(persistedState, version)` 转换到新结构。
- 不设 version + migrate，改 store 结构会导致旧数据反序列化失败。

### 5.3 注意事项与避坑点

1. **selector 绝不返回 `s.arr.filter/map` 或 `({...s.a, ...s.b})`**：每次新建引用 = 无限循环。改用 `useShallow` 或在组件内 `useMemo` 派生。
2. **store 里存函数/对象必须 memoize**：`create((set) => ({ fn: () => {...} }))` 中 `fn` 每次 create 调用都是新引用；如果 selector 返回 `s.fn`，应把它声明在 store 外或用 `useCallback` 包裹（v5 推荐拆分 selector：`const fn = useStore(s => s.fn)`）。
3. **全量解构 `const {a, b, c} = useStore()` 会让组件订阅整个 state**，任何字段变化都触发重渲染；必须用拆分 selector 或 `useShallow`。
4. **v5 与 React 18/19 并发渲染配合**：selector 必须是纯函数，不能有副作用，否则并发模式下会被多次调用导致状态不一致。

### 5.4 最佳实践

1. **拆分 selector 优先于 useShallow**：`const a = useStore(s => s.a); const b = useStore(s => s.b);` 比 `const {a, b} = useStore(useShallow(s => ({a: s.a, b: s.b})))` 更高效（少一层浅比较）。
2. **派生数据用 `useMemo` 而非 selector**：`const filtered = useMemo(() => items.filter(...), [items])`，不在 selector 里 filter。
3. **persist 加 version + migrate**：`persist(config, { name: 'store', version: 1, migrate: (state, v) => v < 1 ? {...state, newField: 'default'} : state })`。

### 5.5 官方文档链接

- [zustand 官方文档](https://zustand.docs.pmnd.rs/)
- [zustand v5 升级指南](https://github.com/pmndrs/zustand/blob/main/docs/guides/typescript.md)
- [useShallow 讨论](https://segmentfault.com/q/1010000045937149)

---

## 6. CodeMirror 6（@uiw/react-codemirror）

### 6.1 核心 API 与架构

CodeMirror 6 是 Marijn Haverbeke 重写的现代编辑器，核心特性：
- **不可变 state + 不可变 extension**：`EditorState.create({ doc, extensions: [...] })`，extensions 是不可变数组，修改需通过 `StateEffect` + `StateField` 重新 dispatch。
- **facet/slot 机制**：所有配置都是 extension，通过 facet 组合。
- **模块化**：核心包 `@codemirror/state` + `@codemirror/view`，语言/主题/功能都是独立包。

`@uiw/react-codemirror` 是 React 封装：
- `<CodeMirror value={...} extensions={[...]} onChange={...} theme="dark" basicSetup={{...}} />`
- `basicSetup` 是预配置 extension 集合（行号、折叠、补全、高亮等），可逐项开关。
- `extensions` 数组与 `basicSetup` 同时配置同功能时，`extensions` 覆盖 `basicSetup`。

### 6.2 与本项目相关的关键配置

**为什么用 CodeMirror 而非 Monaco**：
- CodeMirror 6 模块化、轻量（按需加载语言包，不像 Monaco 全量几 MB），扩展机制（extension）灵活。
- Monaco 适合复杂 IDE 场景（VS Code 同款），但体积大、加载慢、与 Tauri 集成需 `vite-plugin-monaco-editor` 处理 worker。
- 本项目主编辑器用 CodeMirror（`@uiw/react-codemirror`），Monaco 作为备用（`@monaco-editor/react` + `vite-plugin-monaco-editor`）。

**extension 不可变性**：
- extension 数组一旦传给 `CodeMirror`，修改 extensions prop 不会重建 editor，而是通过 `EditorView.dispatch({ effects: StateEffect.reconfigure.of(newExts) })` 重新配置。
- 动态切换语言/主题时，必须用 `StateEffect` 而非重建实例。
- `@uiw/react-codemirror` 内部处理了 reconfigure，但自定义 extension 切换时要注意引用稳定性。

**LSP 集成（codemirror-languageserver）**：
- `codemirror-languageserver` 通过 WebSocket 连 LSP server（如 pyright、rust-analyzer）。
- framing 协议：LSP over WebSocket 用 Content-Length header framing（与 LSP over stdio 相同），但需要 server 端把 stdio LSP 桥接到 WebSocket。
- 本项目 Rust 后端可作为 LSP proxy：启动 LSP server 子进程，把 stdio 桥接到前端 WebSocket。
- 多文档共用一个 editor 实例：用 `EditorState` 切换，每个文档独立 state，共享 extensions。

**多语言包**（本项目已安装）：`@codemirror/lang-{javascript,typescript,python,rust,go,html,css,json,markdown,php,vue}` + `@codemirror/legacy-modes`（旧模式兼容）。

**主题**：`@uiw/codemirror-theme-{atomone,aura,copilot,github,gruvbox-dark,nord,tokyo-night,xcode}` + `@uiw/codemirror-themes`（自定义主题工具）。

**Vim 模式**：`@replit/codemirror-vim` 提供 Vim 键位绑定，作为 extension 加载。

### 6.3 注意事项与避坑点

1. **extension 引用稳定性**：如果 extensions 数组每次渲染都新建（`extensions={[js(), theme, ...]}`），会触发不必要的 reconfigure；用 `useMemo` 缓存 extensions 数组。
2. **`basicSetup` 与 `extensions` 冲突时后者覆盖前者**：要关闭某项功能，不能只在 `extensions` 里加，还要在 `basicSetup` 里设 `false`。
3. **LSP framing 协议**：LSP over WebSocket 必须用 Content-Length header framing，不能用裸 JSON；server 端桥接要正确处理 `\r\n\r\n` 分隔。
4. **CodeMirror 6 与 Monaco 描述混淆**（本项目踩坑）：两者是不同编辑器，API/包名/配置完全不同，文档别搞混。

### 6.4 最佳实践

1. **extensions 用 `useMemo` 缓存**：`const extensions = useMemo(() => [javascript(), vim(), theme], [lang, theme])`，避免每次渲染 reconfigure。
2. **动态切换语言用 `StateEffect.reconfigure`** 而非重建 editor 实例；多文档用 `EditorState.create` 切换 state。
3. **LSP 集成走 Rust 后端 proxy**：Rust 启动 LSP server 子进程，桥接 stdio ↔ WebSocket，前端用 `codemirror-languageserver` 连 WebSocket。

### 6.5 官方文档链接

- [CodeMirror 6 官方文档](https://codemirror.net/docs/)
- [@uiw/react-codemirror](https://uiwjs.github.io/react-codemirror/)
- [codemirror-languageserver](https://www.npmjs.com/package/codemirror-languageserver)
- [CodeMirror 6 迁移指南](https://codemirror.net/docs/migration/)

---

## 7. Vercel AI SDK v7

### 7.1 核心 API 与架构

AI SDK 7（2026-06 发布）是 Vercel 的 TypeScript AI agent 平台，三层包结构：
- `ai`：核心包，提供 `generateText` / `streamText` / `tool` / `Output` / `stepCountIs` / `convertToModelMessages` / `ToolLoopAgent` / `WorkflowAgent`。
- `@ai-sdk/<provider>`：Provider 适配（OpenAI/Anthropic/Google/Groq/xAI/Cerebras/OpenAI-compatible）。
- `@ai-sdk/react`：前端 UI Hooks（`useChat` / `useObject` / `useCompletion`）。

### 7.2 与本项目相关的关键配置

**v6 → v7 破坏性变更**（基于 Vercel changelog）：
1. **Node.js 22 最低**：依赖原生 `fetch` 和改进的 `AsyncLocalStorage`，不向后移植。
2. **ESM only**：`package.json` 必须 `"type":"module"`，不支持 `require()`。
3. **`generateObject` / `streamObject` 弃用**：改用 `streamText` / `generateText` + `output: Output.object(schema)` 参数。
4. **`maxSteps` → `stopWhen`**：多步执行停止条件用 `stopWhen`（如 `stopWhen: stepCountIs(5)`）。
5. **`convertToCoreMessages` → `convertToModelMessages`**：且 v6 中后者变为异步函数。
6. **`streamText` 不再 `await`**：`const result = streamText({...})`（同步返回），用 `for await (const chunk of result.textStream)` 迭代；旧 `const { text } = await streamText(...)` 模式自 v4 起已无效。
7. **`StreamingTextResponse` 移除**：用 `result.toDataStreamResponse()` 返回流式响应。
8. **新增 `runtimeContext` / `toolsContext` / `contextSchema`**：工具可声明需要的 context，调用方通过 `toolsContext` 注入，第三方工具只收到所需 secret。
9. **新增 `reasoning` 顶层选项**：跨 provider 的推理控制（OpenAI/Anthropic/Google/Groq/xAI/Bedrock/Fireworks/DeepSeek 等）。
10. **新增 `uploadFile` / `uploadSkill`**：大文件上传一次后复用 provider reference。
11. **MCP Apps**：支持 model-visible vs app-only tools、沙箱 iframe 渲染、JSON-RPC 通信。
12. **`@ai-sdk/otel`**：OpenTelemetry 重设计遥测。

**Data Stream Protocol**（`useChat` 默认协议）：
- 基于 SSE，每帧 `data: {"type": "...", ...}`。
- 帧类型：`start` / `text-start` / `text-delta` / `text-end` / `reasoning-start/delta/end` / `tool-input-start/delta/available` / `tool-output-available` / `start-step` / `finish-step` / `finish` / `[DONE]`。
- 工具调用拆解细致：输入参数增量流式（`tool-input-delta`），输入完成（`tool-input-available`），输出结果（`tool-output-available`）。

**streamText 流式工具调用**：
```ts
const result = streamText({
  model: openai('gpt-4o'),
  messages: convertToModelMessages(messages),
  tools: {
    getWeather: {
      description: '获取天气',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 22 }),
    },
  },
  stopWhen: stepCountIs(5),
});
return result.toDataStreamResponse();
```

### 7.3 注意事项与避坑点

1. **`streamText` 不 `await`**：`const result = streamText({...})` 同步返回，旧 `await streamText` + 解构 `.text` 模式自 v4 起无效，TS 会报 `Property 'text' does not exist on type 'StreamTextResult'`。
2. **`generateObject` 弃用**：v7 用 `streamText({ ..., output: Output.object(schema) })` 替代；旧代码迁移必须改。
3. **`maxSteps` 无效**：v7 用 `stopWhen: stepCountIs(N)` 或 `stopWhen: hasToolCall('done')`。
4. **Node 22 最低**：CI/部署环境必须 Node 22+，否则依赖 API 报错。
5. **ESM only**：`require('ai')` 不工作，必须 `import`。

### 7.4 最佳实践

1. **流式工具调用用 Data Stream Protocol**：后端 `streamText` + `toDataStreamResponse()`，前端 `useChat` 自动解析工具调用帧，无需手写 SSE 解析。
2. **多 provider 切换只改 model 参数**：`const model = openai('gpt-4o')` → `const model = anthropic('claude-3-sonnet')`，其余代码不变。
3. **多步 agent 用 `ToolLoopAgent` + `stopWhen`**：v7 的 `ToolLoopAgent` 内置工具循环，配合 `stopWhen: stepCountIs(N)` 控制最大步数，避免无限循环。

### 7.5 官方文档链接

- [AI SDK 官方文档](https://ai-sdk.dev/)
- [AI SDK 7 发布说明](https://vercel.com/changelog/ai-sdk-7)
- [streamText 错误修复指南](https://markaicode.com/errors/vercel-ai-sdk-troubleshooting-vercel-ai-sdk-not-working/)
- [Data Stream Protocol 解析](https://juejin.cn/post/7606509656899403786)

---

## 8. Tailwind v4

### 8.1 核心 API 与架构

Tailwind v4 是 Oxide 引擎重写，核心变化：
- **CSS-first 配置**：`tailwind.config.js` 不再是主题/断点的主入口，改用 CSS 中的 `@theme` 块声明设计令牌。
- **`@import "tailwindcss"` 替代 `@tailwind base/components/utilities`**：单一 import 触发引擎。
- **Lightning CSS 集成**：内置 vendor prefixing、nesting、`@import` 处理，无需 PostCSS 插件。
- **原生 cascade layers**：用 `@layer` 规则解决 specificity 问题。
- **`@property` 显式定义**：内部 custom property 有类型和约束，可做 gradient transition。
- **`color-mix` for opacity**：opacity modifier 用 `color-mix`，支持 CSS 变量颜色。
- **容器查询在核心**：`@min-*` / `@max-*` 变体。
- **可组合变体**：`group-*` / `peer-*` / `has-*` / `not-*` 可任意组合。
- **零配置内容检测**：自动扫描模板文件（但 `.astro`/`.svelte`/动态字符串拼接 className 仍需显式 content）。

### 8.2 与本项目相关的关键配置

**`@theme` 块定义设计令牌**：
```css
@import "tailwindcss";

@theme {
  --color-neon-pink: oklch(71.7% 0.25 360);
  --font-family-display: "Satoshi", sans-serif;
  --breakpoint-3xl: 1920px;
}
```
- 变量名必须带标准前缀：`--color-*` / `--font-*` / `--breakpoint-*`，否则不识别。
- `@theme` 必须在 `@import "tailwindcss"` 之后、同一 CSS 文件内（跨文件不生效）。
- 值支持 HEX/RGB/HSL，但 OKLCH 才能自动推导明度阶梯（`primary-400` / `primary-600`）。
- `@theme inline` 选项：变量可被 JS 动态修改（`document.documentElement.style.setProperty(...)`），适合主题切换。

**与 CSS 变量协同**（shadcn v4 模式）：
```css
:root {
  --background: hsl(0 0% 100%);
  --foreground: hsl(0 0% 3.9%);
}
.dark {
  --background: hsl(0 0% 3.9%);
  --foreground: hsl(0 0% 98%);
}
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
}
```
- `:root` 和 `.dark` 移出 `@layer base`，颜色值用 `hsl()` 包裹。
- `@theme inline` 引用 CSS 变量，移除 `hsl()` wrapper，简化 JS 访问。

**shadcn 集成**（v4 兼容）：
- shadcn v4 全部组件更新，`forwardRef` 移除（React 19 不再需要），改用 `React.ComponentProps`。
- 每个_primitive 加 `data-slot` 属性，便于 Tailwind 选择器样式。
- `tailwindcss-animate` 弃用，改用 `tw-animate-css`。
- HSL → OKLCH 转换（非破坏性，旧 HSL 仍工作）。
- 默认 cursor 改为 `default`（button 不再 `pointer`）。
- 默认 style 改为 `new-york`，旧 `default` style 弃用。
- `toast` 弃用，改用 `sonner`。

### 8.3 注意事项与避坑点

1. **`@tailwind` 指令在 v4 完全失效**：必须改 `@import "tailwindcss"`；残留 `@tailwind base` 会导致重置样式丢失（`*`、`box-sizing` 全丢），排版崩溃且无报错。
2. **`tailwind.config.js` 中的 `theme.extend` 不再生成类**：v4 Oxide 引擎只扫描 CSS `@theme` 块；旧 JS 配置的 `colors.brand` 不会生成 `text-brand` 类。迁移时必须把颜色/字体/间距挪到 `@theme`。
3. **PostCSS 插件移到独立包**：`tailwindcss` 本身不再是 PostCSS 插件，必须改用 `@tailwindcss/postcss` 或 `@tailwindcss/vite`；旧 `postcss.config.js` 配 `tailwindcss()` 会报错。
4. **`dark:` 变体依赖 content 扫描**：v4 不再需要 `darkMode:'class'` 配置，但 `dark:bg-gray-800` 类必须出现在 content 路径下，否则不生成 `.dark .bg-gray-800` 规则。
5. **OKLCH 色阶推导**：`--color-brand-500` 必须是 OKLCH 格式（如 `oklch(65% 0.25 270)`），不能直接写 HEX，否则 `brand-400`/`brand-600` 色阶缺失。

### 8.4 最佳实践

1. **Vite 项目用 `@tailwindcss/vite` 而非 PostCSS**：Vite 插件更快，配置简单（`vite.config.ts` 加 `tailwindcss()` 插件即可）。
2. **主题切换用 `@theme inline` + CSS 变量**：`:root` / `.dark` 定义颜色变量，`@theme inline` 引用，JS 动态修改变量实时响应（v3 做不到）。
3. **shadcn v4 迁移**：运行 `@tailwindcss/upgrade@next` codemod 自动移除 deprecated 类、更新配置；手动把 CSS 变量挪到 `@theme inline`，移除 `forwardRef`，加 `data-slot`。

### 8.5 官方文档链接

- [Tailwind CSS v4 官方文档](https://tailwindcss.com/)
- [v4 升级指南](https://tailwindcss.com/docs/upgrade-guide)
- [shadcn/ui Tailwind v4 指南](https://ui.shadcn.com/docs/tailwind-v4)
- [v4 alpha 发布说明](https://tailwindcss.com/blog/tailwindcss-v4-alpha)

---

## 9. Radix UI

### 9.1 核心 API 与架构

Radix Primitives 是无样式、可访问性优先的 React UI 原语库，50+ 组件（Dialog/DropdownMenu/Popover/Tabs/Tooltip/Accordion/Select/Slider 等）。

**两种安装方式**：
- `radix-ui` 单包（推荐）：`import { Dialog, DropdownMenu } from "radix-ui"`，tree-shakeable，避免版本冲突和重复依赖。本项目用此方式（`radix-ui@^1.6.7`）。
- 单独包：`npm install @radix-ui/react-dialog` 等，需同步更新所有包避免共享依赖重复。

**核心特性**：
- **Accessible**：遵循 WAI-ARIA 设计模式，自动处理 aria/role 属性、焦点管理、键盘导航。
- **Unstyled**：无样式，用任何方案（Tailwind/CSS-in-JS）自定义。
- **Opened**：开放组件架构，`asChild` prop 把功能克隆到自定义元素/组件。
- **Uncontrolled**：默认非受控，也可受控。

**`asChild` 组合机制**：
- 设 `asChild` 时，Radix 不渲染默认 DOM 元素，而是克隆子元素并传递 props/事件。
- 自定义组件必须 `spread props` 且 `forwardRef`（React 19 的 Radix 已移除 forwardRef，改用 `React.ComponentProps`）。

### 9.2 与本项目相关的关键配置

**组合多个 primitive**：
```tsx
<Dialog.Root>
  <Tooltip.Root>
    <Tooltip.Trigger asChild>
      <Dialog.Trigger asChild>
        <MyButton>Open dialog</MyButton>
      </Dialog.Trigger>
    </Tooltip.Trigger>
  </Tooltip.Root>
</Dialog.Root>
```
- `asChild` 可任意深度嵌套，组合多个 primitive 行为到一个元素。

**键盘可访问性**：
- Dialog：Tab 在对话框内循环，Esc 关闭，打开时焦点移入，关闭时恢复到触发元素。
- DropdownMenu：上下键导航，Enter/Space 选择，Esc 关闭。
- Tabs：左右键切换，Home/End 跳首尾。
- Accordion：上下键切换面板，Home/End 跳首尾。
- Tooltip：聚焦时显示，悬停时显示，可配延迟。

### 9.3 注意事项与避坑点

1. **`asChild` 自定义组件必须 spread props + forward ref**（React 19 的 Radix 用 `ComponentProps`）：否则 Radix 传的 props/handlers 丢失，组件不工作。
2. **`radix-ui` 单包 vs 单独包混用**：会导致共享依赖（`react-remove-scroll`、`aria-hidden`）重复打包，bundle 变大；统一用一种方式。
3. **Tooltip provider 性能**：v1.1+ 改进了 Tooltip provider 渲染性能；旧版在大量 Tooltip 场景会卡顿。
4. **修改底层元素类型要保证可访问性**：如把 `Tooltip.Trigger`（默认 button）改成 `div`，会失去焦点和键盘响应，需手动加 `tabIndex` 和键盘事件。

### 9.4 最佳实践

1. **用 `radix-ui` 单包 + tree-shaking**：`import { Dialog, DropdownMenu } from "radix-ui"`，避免版本冲突，bundle 只含用到的组件。
2. **`asChild` 组合多个 primitive**：Tooltip + Dialog + 自定义 Button 通过 `asChild` 嵌套，单一元素承载多重行为。
3. **shadcn 模式**：Radix 原语 + Tailwind className + `data-slot` 属性，shadcn 已封装好，直接用 shadcn 组件而非裸 Radix。

### 9.5 官方文档链接

- [Radix Primitives 官方文档](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Composition 指南](https://www.radix-ui.com/primitives/docs/guides/composition)
- [Releases 更新日志](https://www.radix-ui.com/primitives/docs/overview/releases)

---

## 10. portable-pty 0.9

### 10.1 核心 API 与架构

portable-pty 是 wezterm 项目抽出的跨平台 PTY 库，提供 trait 抽象，运行时选择实现：
- `native_pty_system()`：返回平台原生实现（Unix 用 forkpty，Windows 用 ConPTY）。
- `PtySystem::openpty(PtySize)` → `PtyPair { master, slave }`。
- `SlavePty::spawn_command(CommandBuilder)` → `Box<dyn Child>`。
- `MasterPty::try_clone_reader()` → 读取子进程输出。
- `MasterPty::take_writer()` → 写入子进程输入。
- `MasterPty::resize(PtySize)` → 调整 PTY 尺寸。
- `Child::wait()` → 等待退出，返回 `ExitStatus`。
- `ChildKiller::kill(...)` → 终止子进程。

`PtySize`：`{ rows, cols, pixel_width, pixel_height }`，pixel 尺寸不是所有系统都支持，但建议设。

`CommandBuilder`：跨平台命令构造，支持 `cwd` / `env` / `args`。

### 10.2 与本项目相关的关键配置

**子进程 cleanup（pty_close_all）**：
- Tauri 启动时 `invoke("pty_close_all")` 清理孤儿 PTY（上次崩溃残留）。
- 用 `shared_child` crate 共享子进程句柄，便于多线程 kill。
- 主窗口关闭时遍历所有 child，先 `kill` 再 `wait`，避免僵尸进程。

**跨平台 shell 选择**：
- Windows：`pwsh.exe`（PowerShell 7+）或 `powershell.exe`（Windows PowerShell 5.1）。
- Linux/macOS：`bash` 或用户 `$SHELL`。
- 用 `which` crate 查找 shell 路径，避免硬编码。

**退出码处理**：
- `ExitStatus` 是枚举，需 match 处理 `Exited(code)` 和 `Signaled(signal)`。
- 退出码传递给前端，用于显示命令结果。

**与 xterm.js 数据流**：
- PTY stdout → Tauri emit 事件 → 前端 xterm.write。
- 前端 xterm.onData → Tauri invoke → PTY stdin。
- resize：前端 ResizeObserver → invoke pty_resize → MasterPty::resize。

### 10.3 注意事项与避坑点

1. **ConPTY 在 Windows 1809 之前不可用**：旧系统会回退到 winpty，行为有差异；建议要求 Windows 10 1809+。
2. **`MasterPty::take_writer()` 每次返回新 writer**，但底层是同一 PTY master；多次 take 不会创建多个写入通道。
3. **`Child::wait()` 阻塞**，必须在独立 tokio task 或线程中调用，否则阻塞 Tauri 主线程。
4. **`shared_child` 用于多线程 kill**：原生 `std::process::Child` 的 `kill()` 需要 `&mut`，多线程共享用 `shared_child::SharedChild`。

### 10.4 最佳实践

1. **启动时 `pty_close_all` 清理孤儿**：Tauri `setup` 钩子里遍历所有 PTY child，kill + wait，避免上次崩溃残留。
2. **resize 用防抖**：前端 ResizeObserver 防抖后 invoke pty_resize，避免高频 resize 卡 Tauri IPC。
3. **Windows 设 `CREATE_NO_WINDOW`**：spawn 时避免任务栏出现额外命令行窗口（ConPTY 默认不显示，但旧 winpty 需要）。

### 10.5 官方文档链接

- [portable-pty 0.9 docs.rs](https://docs.rs/portable-pty/0.9/portable_pty/)
- [portable-pty crates.io](https://crates.io/crates/portable-pty)
- [wezterm 项目](https://github.com/wezterm/wezterm)

---

## 11. keyring

### 11.1 核心 API 与架构

keyring 是跨平台凭据存储库，核心概念是 `Entry`，由 `<service_name, user_name>` 对（可选 `target`）标识。

**API**：
- `Entry::new(service, user)` / `Entry::new_with_target(target, service, user)` / `Entry::new_with_credential(credential)`。
- `entry.set_password(pwd)` / `entry.set_secret(bytes)`。
- `entry.get_password()` → `String` / `entry.get_secret()` → `Vec<u8>`（避免 UTF-8 校验失败，用 `get_secret` 取原始字节）。
- `entry.delete_password()` / `entry.delete_credential()`。
- `set_default_credential_builder(builder)`：自定义 credential builder。

### 11.2 与本项目相关的关键配置

**平台后端**（来自 docs.rs/3.6.3）：
- **macOS/iOS**：`apple-native` feature → Keychain。
- **Windows**：`windows-native` feature → Windows Credential Manager。
- **Linux**：多后端可选：
  - `linux-native`：`keyutils`（Linux 内核 key-management facility，不依赖 D-Bus）。
  - `sync-secret-service`：DBus Secret Service（同步，需 D-Bus + GNOME Keyring/KWallet）。
  - `async-secret-service`：DBus Secret Service（异步，必须配 `tokio` 或 `async-io` + `crypto-rust`/`crypto-openssl`）。
  - `linux-native-sync-persistent` / `linux-native-async-persistent`：keyutils + secret-service 组合（keyutils 缓存 + secret-service 持久化）。
- **无后端时用 mock store**（仅测试用，不安全）。

**Linux 无 D-Bus fallback**（本项目关注点）：
- 本项目 `Cargo.toml` 只在 Windows 和 macOS 启用 keyring（`keyring = { version = "3.6", default-features = false, features = ["windows-native"] }` / `["apple-native"]`），**Linux 未启用 keyring**。
- 这意味着 Linux 上 keyring 会用 mock store（不安全，凭据存内存）。
- 后期 Linux 支持应启用 `linux-native`（keyutils，无 D-Bus 依赖，适合服务器/无桌面环境）或 `async-secret-service`（需 D-Bus，桌面环境更安全）。
- `linux-native-sync-persistent` 是折中：keyutils 缓存 + secret-service 持久化，无 D-Bus 时降级到 keyutils（内存，进程退出丢失）。

**多条目命名约定**：
- `service` 通常是 app bundle identifier（如 `com.tdsf.terminal-agent`）。
- `user` 是凭据标识（如 `ssh:host:192.168.1.1:user` / `ai:provider:openai`）。
- `target` 可选，用于区分同 service+user 的多条目。

### 11.3 注意事项与避坑点

1. **Linux 未启用 keyring = mock store = 凭据存内存**（本项目当前状态）：Linux 上 SSH 密钥/AI API key 不持久化，进程退出丢失。后期 Linux 支持必须启用 `linux-native` 或 `async-secret-service`。
2. **多线程访问不安全**：docs.rs Caveats 明确，Windows 和 Linux 上同凭据多线程并发访问可能失败；DBus Secret Service 高频访问会导致 RPC 失败。需用 `Mutex` 串行化访问。
3. **第三方写入的字节串非 UTF-8**：`get_password` 会返回 `BadEncoding` 错误（带原始字节）；用 `get_secret` 取原始字节避免此问题。
4. **无默认 feature**：必须显式指定平台 feature，否则编译报错（"a crypto backend is required" 的类似错误）。

### 11.4 最佳实践

1. **Linux 启用 `linux-native`（keyutils）作为无 D-Bus fallback**：服务器/容器环境无 D-Bus，keyutils 是唯一选择（虽然进程退出丢失，但至少不报错）；桌面环境用 `async-secret-service` + `crypto-rust`。
2. **凭据访问串行化**：用 `Arc<Mutex<Entry>>` 或全局 `Mutex<HashMap<(service, user), Entry>>`，避免多线程并发访问失败。
3. **命名约定统一**：`service = bundle_id`，`user = "<category>:<key>"`（如 `ssh:host:1.2.3.4:user`），便于批量查询和清理。

### 11.5 官方文档链接

- [keyring 3.6 docs.rs](https://docs.rs/keyring/3.6/keyring/)
- [keyring crates.io](https://crates.io/crates/keyring)
- [keyring GitHub](https://github.com/hwchen/keyring-rs)

---

## 12. 综合避坑清单（按本项目踩过的坑反查）

| 坑 | 根因 | 预防规则 | 文档参考 |
|----|------|---------|---------|
| useEffect 自反依赖循环（50 万次/秒卡死） | effect 依赖 effect 自身 setState 替换的引用值 | 依赖数组只放外部输入；需要 cleanup 的资源用 `useRef` 存；用 `PerformanceObserver` 数 measure 次数定位 | §2.3 |
| async setState 逃过 max-depth 守卫 | setState 在 `await` 后微任务里执行，逃过 React 同步循环检测 | 不能依赖 "Maximum update depth exceeded" 报错；用 CPU Profiler + measure 计数定位 | §2.3 |
| russh `terminal_modes` 畸形致 OpenSSH 硬关 TCP | `TTY_OP_END` 是终止符却带 u32 value，协议畸形 | `request_pty` 传空 `&[]`，让库追加正确终止符；绝不手动塞 `(Pty::TTY_OP_END, 0)` | §3.3 |
| russh `check_server_key` 默认拒绝所有 key | 默认实现返回 false | 必须覆写 `check_server_key`，实现 TOFU 流程 | §3.3 |
| russh `aws-lc-rs` Windows MSVC 编译失败 | aws-lc-rs 需 NASM + alignas 支持 | `default-features=false, features=["ring"]`，用 ring 预编译 backend | §3.3 |
| zustand selector 返回新引用无限循环 | v5 用 `Object.is` 严格比较，`s => s.arr.filter()` 每次新数组 | 用 `useShallow` 或拆分 selector；派生数据用 `useMemo` | §5.3 |
| `git checkout package.json` 退回自研版丢 65 依赖 | 用 git 命令撤销已跟踪文件改动 | 撤销自己的改动用 `Edit` 反向编辑，绝不用 `git checkout/reset/restore` 已跟踪文件 | 开发规范 §0.3 |
| Tauri 缺 `core:window:allow-show` 窗口永不可见 | capabilities JSON 缺权限，ACL 静默拦截 `show()` | 启动前对照上游 capabilities 逐项核对；必备项见 §1.2 | §1.3 |
| sidecar 重启无退避 = 重启风暴 | `modules/sidecar.rs` restart 无指数退避 | 失败计数 + 指数退避（1s/2s/4s/8s/30s 上限）+ 连续 N 次失败弹窗 | §1.3 |
| CodeMirror vs Monaco 描述混淆 | 两者是不同编辑器，API/包名/配置完全不同 | 改前先确认是哪个编辑器，查对应文档；不混用 `@codemirror/*` 和 `monaco-editor` API | §6.3 |
| xterm.js dispose 不调用内存泄漏 | WebGL 纹理/ResizeObserver/事件监听不自动释放 | 切 tab 销毁时 `addon.dispose()` + `term.dispose()` + `observer.disconnect()` | §4.3 |
| Tailwind v4 `@tailwind` 指令失效 | v4 Oxide 引擎只认 `@import "tailwindcss"` | 删除所有 `@tailwind` 指令，改单一 `@import "tailwindcss"` | §8.3 |
| Tailwind v4 `theme.extend` 不生成类 | v4 只扫描 CSS `@theme` 块，忽略 JS 配置 | 颜色/字体/间距挪到 `@theme` 块，带标准前缀（`--color-*` 等） | §8.3 |
| AI SDK v7 `await streamText` + `.text` 报错 | v4 起 `streamText` 同步返回，无 `.text` 属性 | `const result = streamText({...})`（不 await），迭代 `result.textStream` | §7.3 |
| AI SDK v7 `generateObject` 弃用 | v7 改用 `streamText` + `output: Output.object(schema)` | 迁移时改用新 API | §7.3 |
| keyring Linux 未启用 = mock store 不持久化 | `Cargo.toml` 只在 Windows/macOS 启用 keyring | Linux 启用 `linux-native`（keyutils）或 `async-secret-service` | §11.3 |
| keyring 多线程并发访问失败 | Windows/Linux 凭据存储不串行化 | 用 `Arc<Mutex<Entry>>` 串行化访问 | §11.3 |
| `data-tauri-drag-region` 不冒泡到子元素 | 只对直接应用元素生效 | 自定义标题栏每个子交互元素单独处理 | §1.3 |
| portable-pty `Child::wait()` 阻塞主线程 | `wait()` 是阻塞调用 | 在独立 tokio task 或线程中调用 | §10.3 |
| Radix `asChild` 自定义组件不 spread props | Radix 传的 props/handlers 丢失 | 自定义组件必须 `spread props` + `forwardRef`（v19 用 `ComponentProps`） | §9.3 |

---

## 13. 后期开发优先调研清单

以下扩展点后期魔改可能用到，本次未深入，按优先级排序：

### 13.1 Tauri plugin-* 扩展
- **`tauri-plugin-sql`**：SQLite 集成，替代文件存储做结构化数据（会话历史、命令历史）。
- **`tauri-plugin-http`**：受控 HTTP 请求（绕过 CORS，sidecar 不可用时直连 API）。
- **`tauri-plugin-fs`**：受控文件系统访问（scope 限制路径）。
- **`tauri-plugin-dialog`**：原生文件对话框（保存/打开）。
- **`tauri-plugin-localhost`**：本地 HTTP server（sidecar 替代方案）。
- **`tauri-plugin-deep-link`**：自定义协议 URL（`tdsf://` 触发操作）。
- **`tauri-plugin-single-instance`**：单实例锁，避免多开冲突。

### 13.2 Monaco 备用编辑器深入
- `vite-plugin-monaco-editor` 的 worker 配置（避免 CDN 加载，全本地）。
- Monaco 多文档共用实例（`editor.createModel` + `editor.setModel`）。
- Monaco LSP 集成（`monaco-languageclient`）。
- Monaco 与 CodeMirror 的性能对比（大文件、长行、语法高亮）。

### 3.3 SSE / WebWorkers
- **SSE（Server-Sent Events）**：sidecar → 前端的单向流（替代 Tauri emit 事件），适合大流量日志。
- **Web Workers**：CPU 密集任务（语法解析、AST 处理）移出主线程，避免 UI 卡顿。
- **SharedArrayBuffer**：Worker 与主线程共享内存（需 COOP/COEP header）。

### 13.4 Rust tokio 深入
- **tokio::select!**：多 channel/定时器并发等待，sidecar 健康检查 + 退出信号。
- **tokio::sync::mpsc / broadcast / watch**：sidecar 输出 fan-out 到多个前端终端。
- **tokio::task::spawn_blocking**：CPU 密集 Rust 操作（如 git2 大仓库操作）避免阻塞 runtime。
- **tokio::net::TcpListener**：本地 HTTP server（sidecar 替代）。

### 13.5 Python asyncio（sidecar）
- **FastAPI + uvicorn**：sidecar HTTP server 框架（替代自研）。
- **asyncio.create_subprocess_exec**：sidecar 调用外部工具（如 ssh、scp）。
- **asyncio.Queue / Event**：sidecar 内部任务调度。
- **signal handling**：sidecar 优雅退出（SIGTERM/SIGINT）。

### 13.6 Docker 沙箱（bollard 0.17）
- bollard 容器生命周期管理（create/start/stop/remove）。
- 容器内执行命令（`exec` + attach）。
- 容器文件系统挂载（bind mount / volume）。
- 资源限制（CPU/memory limits）。
- 镜像拉取与缓存。

### 13.7 git2 影子仓库（git2 0.19）
- `init_bare` / `commit` / `reset` / `blob` / `tree` 全套 API。
- 影子仓库目录命名（SHA256 项目路径哈希）。
- 与前端 source-control 面板集成。

### 13.8 主题系统扩展
- 自定义主题 JSON schema（`types.ts`）。
- 背景图管理（`useThemeFileEditing.ts`，注意自反循环坑）。
- 主题导入/导出/分享。
- 16 内置主题注册（`themes/index.ts`）。

### 13.9 离线选词翻译扩展
- 词典数据格式（`linuxDictionary.ts` / `programmingDictionary.ts`）。
- 翻译 API（`translateApi.ts`）。
- 选词检测（`TranslateTooltip.tsx`）。
- 自定义词典导入。

### 13.10 快捷键系统
- `shortcuts.ts` 单一真源（从上游恢复）。
- 快捷键冲突检测。
- 自定义快捷键绑定。
- 与 Command Palette（`cmdk`）集成。

---

> 本报告所有信息均来自实际抓取的官方文档（docs.rs / 官方站点），非凭记忆。版本特性如有歧义，以官方最新文档为准。报告中标注的"本项目血泪坑"来自 `CLAUDE.md` 与 `docs/dev-state.md` 记录的实战经验。
