/**
 * autoTypeLedger — 命令卡自动打字去重闸门
 * -----------------------------------------------------------------------------
 * 命令卡渲染即自动把命令打字到活动终端（2026-09-18 用户钦定），但这条路径
 * 会在两种场景下失控：
 *
 *  1. **重挂重放**：关掉 AI 小窗会让 AiMiniWindow 卸载（usePresence 的 mounted
 *     在 exitMs 后置 false），重开时整条历史消息重新挂载，每张命令卡的
 *     autoFiredRef 都是全新的 → 会把历史上所有命令重新打字一遍；auto 模式下
 *     还会**重新执行**它们。
 *  2. **同批互踩**：一条回复里有多个代码块时，它们在同一个 React commit 内挂载，
 *     effect 同步依次跑完。整段注入路径会把多条命令**拼接成同一行输入**
 *     （`ls -la` + `cd /tmp` → `ls -lacd /tmp`），逐字路径则每条先 `\x03\r`
 *     清掉上一条，用户看到的是闪烁且只剩最后一条。
 *
 * 因此：同一条命令整个会话只自动打字一次；同一 commit 内只允许一张卡自动打字
 * （先到先得，其余卡仍保留手动 Run 按钮）。
 */

/** 本会话已自动打字过的命令原文。 */
const typed = new Set<string>();

/** 当前宏任务批次是否已有卡占用自动打字权。 */
let claimedThisBatch = false;

/**
 * 申请自动打字。返回 true 才允许注入。
 * 同一批次（同一次 React commit）内只有第一个调用者成功。
 */
export function claimAutoType(command: string): boolean {
  const key = command.trim();
  if (!key || typed.has(key)) return false;
  if (claimedThisBatch) return false;
  typed.add(key);
  claimedThisBatch = true;
  // 微任务在同步 effect 全部跑完后才排空 → 天然的"同一 commit 只放行一张"边界。
  queueMicrotask(() => {
    claimedThisBatch = false;
  });
  return true;
}

/** 仅供测试重置模块级状态。 */
export function __resetAutoTypeLedger(): void {
  typed.clear();
  claimedThisBatch = false;
}
