# TEAM-DESKTOP-01：产品内远程桌面（G2 最小闭环）

- 日期：2026-11-18
- 责任人：Yan-0914
- 任务：Issue #57 / TEAM-DESKTOP-01
- 状态：代码已接入；静态检查进行中，Tauri 原生窗口与真实键鼠待验证

## 目标

在 **TDSF Terminal Agent 应用内**打开远程图形桌面（不是外部 mstsc）：
前端命令面板入口 → Rust IronRDP 会话 → Tauri 事件推帧 → Canvas 渲染 → 键鼠转发。

## 变更

### Rust（`src-tauri`）

- `Cargo.toml`
  - `rust-version` 1.89 → **1.94**（IronRDP 要求；本机 rustc 1.100 已实测）。
  - 新增 `ironrdp-client` / `ironrdp-pdu`（git rev `abfc97b299f04622cb7860f344a35bbea9bd4361`，`rustls`）、`smallvec`、`base64`。
  - `Cargo.lock` 已随依赖更新（`http-body-util` 0.1.3 → 0.1.5，解决 IronRDP 的 `^0.1.4` 冲突）。
- `modules/desktop/mod.rs`（新增）
  - `DesktopState` 会话注册表；
  - `desktop_connect`：专用线程 + current-thread runtime（64MB 栈），IronRDP 连接，`desktop-frame` 推 RGBA(base64)；
  - `desktop_input`：Unicode/按键 scancode/鼠标移动与按键；
  - `desktop_close`；
  - `desktop-error` 事件。
- `modules/mod.rs`、`lib.rs`：模块声明、State 注入、命令注册。

### 前端（`src`）

- `modules/desktop/RemoteDesktopDialog.tsx`（新增）
  - 主机/端口/用户名/密码表单（密码仅内存）；
  - `listen('desktop-frame')` → Canvas `putImageData`；
  - 键盘（字符/Enter/方向键等）与鼠标（移动/左中右键）转发；
  - 关闭时 `desktop_close`。
- `modules/desktop/index.ts`；
- `command-palette/commands.ts`：新增“远程桌面（RDP）...”命令；
- `app/App.tsx`：命令面板入口 + Dialog 渲染。

## 验证

- `npm run typecheck`：**exit 0**。
- 定向 `eslint src/modules/desktop src/modules/command-palette/commands.ts src/app/App.tsx --max-warnings 0`：**exit 0**。
- `cargo check`（`src-tauri`）：**exit 0**，`Finished dev profile in 1m 06s`；仅有既有 `env_logger` unused warning。
  - 本地 Tauri build script 要求 `sidecar/tdsf-sidecar` 资源；为静态检查临时放空占位文件（不入库）。原生运行仍需构建 sidecar。
- 未运行 `tauri dev` 原生窗口；未做真实键鼠/中文输入/性能/断线验证。

## 依赖与工具链影响

- 新增 IronRDP 依赖（git pin），团队环境需 **Rust ≥1.94**；本机 1.100 已验证依赖解析。
- 未新增云服务/网关；未改 SSH/Agent/审批/信任策略。
- 凭据仍由前端表单传入，后续应改为现有 secrets 引用。

## 未测 / 下一步

1. `cargo check` 通过后，`pnpm tauri:dev` 启动应用，从命令面板打开“远程桌面”，连接测试 VM，验证首帧/键鼠。
2. 中文 IME、缩放/全屏、断线恢复、剪贴板/音频。
3. 将密码改为 secrets 引用；会话归属绑定窗口。
4. 处理 1 vCPU soft lockup 与 xrdp/xorgxrdp 版本不一致。