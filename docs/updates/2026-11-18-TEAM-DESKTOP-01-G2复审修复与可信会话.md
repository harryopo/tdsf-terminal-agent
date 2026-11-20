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

当前仍未覆盖：产品内键鼠完整操作、中文 IME、缩放/全屏、断线恢复、失败/超时全路径与 VNC。

## 下一步

- 验证产品内键鼠、中文输入、缩放与断线恢复；
- 补证书指纹首次确认与保存；
- 进入 VNC/RFB 与稳定性阶段。