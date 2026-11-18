# TEAM-DESKTOP-01：G0 调研与环境阻断

- 日期：2026-11-18
- 责任人：Yan-0914
- 任务：Issue #57 / TEAM-DESKTOP-01
- 产品基线：`210c7874951ddd2ca4572401225ed7decc7a5966`
- 文档基线：`81e7793f8471a5d843a198bdda2cc1572782b7af`
- 状态：G0 静态初核完成；G1 原生 PoC 未执行（环境阻断）

## 已完成

1. 核对候选来源：IronRDP `abfc97b`（与 ROOT 初核一致）、FreeRDP `1e2422b`（较初核前移）、noVNC `e8b5024`、Guacamole `a8daafe`、RustDesk `54416dc`。
2. IronRDP 关键 manifest/许可/依赖静态核对：connector/graphics 的 MSRV `1.94`、sasn-I/O 架构、client 的 tokio/tls 特性、web crate 为 wasm 目标（不能直接当 Tauri 原生渲染）。
3. 形成接入建议：Rust `DesktopSessionManager` + IronRDP（RDP）；noVNC core + 127.0.0.1 短期桥接（VNC）；控制面小消息、画面走 Channel/二进制。
4. 报告：`docs/research/remote-desktop/2026-11-18-Yan-0914-远程桌面开源调研与可行性初核.md`。

## 环境探测（真实执行）

- rustup 下载 SHA256 校验通过；stable 重装后 `rustc 1.100.0` 可用。
- **`cargo.exe` 缺失**：`rustup component add cargo` 报 up to date、`rustup update stable` 报 unchanged，但 toolchain `bin/` 无 cargo。
- **无 MSVC/GCC**：`cl.exe`、Visual Studio 目录、`gcc` 均不存在。
- 最小 crate `cargo build` exit 1（cargo 不可用）。
- 无授权 RDP/VNC 测试服务端。

原始记录：本机 `.local/test-runs/2026-11-18-tef-desktop-env/`（不提交）。

## 未做与原因

- 未编译 IronRDP/FreeRDP，未做首帧、键鼠、证书事件、性能。
- 未运行 Tauri 原生窗口与 noVNC 桥接实测。
- 未伪造截图或把 README 能力写成已实现。

## 下一步（需环境恢复）

1. 安装 VS Build Tools（MSVC + Windows SDK），修复 cargo（完整 toolchain）；
2. 提供明示授权的隔离 RDP/VNC 测试服务端；
3. 在 `experiments/remote-desktop-poc` 做真实 PoC，记录命令/退出码/首帧/输入/失败，再进入 G2。

## 边界

- 未改原 SSH/Agent/审批/信任策略，未新增外部网关或云依赖。
- 未合并、未发布；Draft PR 持续更新。