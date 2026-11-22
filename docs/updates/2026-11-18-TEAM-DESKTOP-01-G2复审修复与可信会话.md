# TEAM-DESKTOP-01：G2 复审修复与可信会话

- 日期：2026-11-18
- 责任人：Yan-0914
- 任务：Issue #57 / TEAM-DESKTOP-01（RDP/VNC 远程桌面长任务）
- 状态：按 ROOT 对 PR58 的 6 条行评审完成修复与定向测试；保持 Draft，未合并

## 本轮修复（对应 ROOT 六条意见）

1. **显式可信 TLS**：`ConfigBuilder.with_certificate_validation(Strict)`，可选证书指纹回调（SHA-256 指纹匹配才放行自签），未配置指纹时拒绝不可信证书；不再默认 accept-all。
2. **owner/generation**：`owner + generation + sessionId` 绑定；`desktop_input` / `desktop_close` / `desktop_status` 均校验，跨窗口/旧代次拒绝。
3. **定向帧传输**：`desktop-frame` 改为调用方 `Channel<DesktopFrameEvent>` 推送，不再全局 `app.emit`；`desktop_status` 由后端事件驱动（Pending/Connected/Failed/Closed），connect 返回 id 不再当作已连接。
4. **连接取消与回收**：Pending 可取消，迟到 connect 立即回收；失败/关闭使旧画面与输入失效。
5. **输入释放与背压**：`mouseup` 按 `event.button` 释放；`pointer capture`、失焦释放修饰键/鼠标按钮、hover、滚轮；输入队列容量 32，`send` 超时/满队列显式失败，不静默丢 key-up；非 BMP 字符用 UTF-16 code units。
6. **异步退订**：前端关闭/卸载时取消会话与 Channel；`listen` 不再被全局事件替代，改状态轮询。

## 验证（真实命令与退出码）

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 编译 | `cargo +1.94.0 check`（src-tauri） | exit 0，`Finished dev profile in 15.92s`（仅既有 `env_logger` warning） |
| Rust 单测 | `cargo +1.94.0 test --lib desktop` | **5 passed / 0 failed**（TEST_EXIT=0） |
| 前端类型 | `npm run typecheck` | exit 0 |
| 前端 lint | `npx eslint src/modules/desktop src/modules/command-palette/commands.ts src/app/App.tsx --max-warnings 0` | exit 0 |
| 前端定向 | `npx vitest run src/modules/desktop/desktopInput.test.ts` | **4 passed / 0 failed** |

覆盖：鼠标释放保留 button 身份、非 BMP UTF-16、owner/generation 校验、满队列显式失败、指纹归一化、React/RDP button 映射、失焦释放集合。

## 未测（不冒充已实现）

- TDSF 内嵌远程桌面真实连接画面、键鼠/中文输入、缩放/全屏、断线恢复、VNC；
- 证书链/名称错误的线上拒绝路径（仅代码路径与单元测试，未连真实服务器）；
- 高并发帧率/背压下的用户体验。

## 依赖与边界

- 新增 `ironrdp-tls` 直接依赖（与 client/pdu 同一 git rev `abfc97b`）；`rust-version` 1.94。
- 未改 SSH/Agent/审批/信任/公共协议；未引入云依赖；密码仅内存，不落盘。
- 合并权在队长；本 PR 继续 Draft。

## 2026-11-19 真实窗口排错追加

- 在 Tauri 命令注册表补入 `desktop_status`，修复运行时报 `desktop_status not found`。
- 连接失败时后端保留 `Failed` 与真实错误，由 `desktop_close` 清理，避免失败会话被提前删除后只剩 `session not found`。
- 前端读取到 `failed` / `closed` 后保留原始错误展示，并按相同 `sessionId + owner + generation` 调用 `desktop_close`，避免失败会话无法回收。
- 新增组件回归，先复现未调用 `desktop_close` 的失败，再修复为通过。

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 定向回归 | `cargo test --locked --lib desktop`（src-tauri） | exit 0，5 passed / 0 failed，482 filtered out |
| 前端红→绿回归 | `pnpm exec vitest run src/modules/desktop/RemoteDesktopDialog.test.tsx` | 修复前 1 failed（未调用 `desktop_close`）；修复后与 `desktopInput.test.ts` 合计 5 passed / 0 failed |
| 前端类型 | `pnpm typecheck` | exit 0 |
| 定向规范 | `pnpm exec eslint src/modules/desktop/RemoteDesktopDialog.tsx src/modules/desktop/RemoteDesktopDialog.test.tsx src/modules/desktop/desktopInput.ts src/modules/desktop/desktopInput.test.ts --max-warnings 0` | exit 0 |

## 2026-11-19 产品内真实连接收口

- 首次真实连接进入 TLS 后因同时启用 `aws-lc-rs` 与 `ring`，Rustls 无法自动选择进程级 `CryptoProvider`，`tdsf-rdp-1` panic，界面停在连接中。
- 显式安装 IronRDP 已启用的 `aws_lc_rs` provider，不改变 Strict TLS 与指纹信任策略；RDP 线程 panic 统一转为 `Failed`，避免状态永久停在 Pending。
- 修复后日志出现第二轮 `connect_finalize`，未再次 panic；用户在 `.local/src` 开发版 TDSF 窗口中输入证书指纹，确认可以登录远程图形界面。此项是产品内真实 RDP 登录验收，不是外部 mstsc 或 PoC 结果。
- 本轮再次执行 `cargo test --locked --lib desktop`：exit 0，5 passed / 0 failed，482 filtered out。

## 2026-11-20 全屏与显示优化

- 连接页改为分组表单与 Strict TLS 状态提示；连接后增加深色桌面工作区、连接状态、分辨率/缩放比例和工具栏。
- 新增“适应窗口 / 原始尺寸”：按远端像素与视口尺寸计算显示大小，保持宽高比；原始尺寸超出视口时可滚动查看，鼠标仍按画布实际 rect 映射。
- 新增原生 Fullscreen API 全屏/退出，提供窗口内最大化回退；断开或关闭时退出全屏并保留既有会话清理。
- 自动化：桌面 2 个测试文件共 **8 passed / 0 failed**；`pnpm typecheck`、定向 ESLint、`pnpm build:web` 均 exit 0。构建仅有既有 chunk/循环重导出警告。
- 原生窗口实测：全屏弹窗 **1440×900**，1280×720 远端画面按比例放大到 **1356×763（106%）**；退出全屏后原始尺寸为 1280×720，视口宽 1142、滚动宽 1280；切回适应窗口为 979×551（76%）。
- 证据截图：`.local/screenshots/rdp-ui-webview.png`、`.local/screenshots/rdp-ui-fullscreen.png`；截图直接来自开发版 WebView，不代替完整键鼠验收。

当前仍未覆盖：产品内键鼠完整操作、中文 IME、断线恢复、失败/超时全路径与 VNC。

## 2026-11-21 键鼠/IME、迟到连接回收与 VNC 回环

- RDP 真实窗口普通键验证：远端终端 `echo RDP_OK` 输出正确，普通键与 Enter 通过；合成 composition 事件未上屏，中文不判通过（以此区分“RDP 中文传输失败”与“合成事件未触发 React 处理器”）。
- 修复源码证实的确定性缺陷：迟到 `connect` 遗留会话；拖动时 `mousemove.button=-1` 误映射成中键；补齐扩展键 scancode 表（方向/功能/Meta/小键盘等）、滚轮方向与累积、连接后断线监测。
- 中文 IME：可聚焦 textarea 宿主承接 WebView2 真实 composition 路径，`compositionEnd` 提交 Unicode 键并提供候选预览；不用合成事件冒充真实 OS IME。
- VNC：新增 `vnc_connect` 本机回环 WebSocket 桥（ticket 路径 + Host/Origin 白名单 + binary 子协议，accept 15s / 握手 10s / 连接 10s 超时，不解析 RFB 仅双向中继）；前端新增 `@novnc/novnc` 1.7.0 `VncDesktopView`（scaleViewport、Ctrl+Alt+Del、keysym/Unicode 映射、失焦释放、composition 预览）；`RemoteDesktopDialog` 接线 RDP/VNC 双协议。授权 VM 配置 TigerVNC 仅本机监听 `:0` 会话，密码从本机私有 env 写入，未入库。
- 新增依赖：`@novnc/novnc` 1.7.0（pnpm-lock 同步）；Rust 侧复用已有 `tokio-tungstenite`/`uuid`/`futures-util`（Cargo.lock 同步）。

### 验证（2026-11-22 复跑，真实命令与退出码）

| 检查 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `pnpm typecheck` | exit 0 |
| 前端定向 | `pnpm exec vitest run src/modules/desktop` | 2 文件 **8 passed / 0 failed** |
| 定向规范 | `pnpm exec eslint src/modules/desktop --max-warnings 0` | exit 0 |
| Rust 定向 | `cargo +1.94.0 test --locked --lib desktop`（src-tauri） | exit 0，**9 passed / 0 failed**，482 filtered out；含 VNC 回环 4 项（握手 ticket/Host/Origin/binary 校验、双向二进制中继、等待中关闭回收、10 次 pending connect/close 全回收） |

### 未测（不冒充已实现）

- 真实 VNC 桌面产品内完整键鼠与中文 IME 人工验收（仅回环桥与前端单测）；
- RDP 真实 OS IME 中文上屏（合成 composition 未上屏，不判通过）；
- 断线恢复、失败/超时全路径、高帧率稳定性。

## 下一步

- 真实 VNC 桌面连接与完整键鼠/中文 IME 人工验收；
- 断线恢复与稳定性阶段；
- 补证书指纹首次确认与保存。