/**
 * sshCarapaceEvents.ts — 设置窗 → 主窗的「远端补全组件已变更」通道
 * -----------------------------------------------------------------------------
 * 存在性检测结果缓存在 `param-complete-client` 的模块级 Map 里，而设置窗与主窗
 * 是两个 JS context（同 PREDICTION_CLEAR_EVENT 那条实测），各拿一份缓存。所以在
 * 设置页装完服务器上的组件，主窗那份缓存仍写着"未安装"，SSH 终端右下角的图标
 * 会继续喊你去装 —— 界面在报过期事实。装成功这件事必须发回主窗重查。
 *
 * 单独成模块的硬约束（照 predictionEvents.ts 的口径）：本文件不得引入任何
 * SSH / 终端 / 设置逻辑，两侧只为对齐一个事件名而 import 它。
 */
export const CARAPACE_CHANGED_EVENT = "tdsf:ssh-carapace-changed";

/** 事件载荷：变更的是哪条 Rust 会话号 */
export interface CarapaceChangedPayload {
  sessionId: number;
}
