/**
 * autoTypeLedger — 命令卡自动打字去重闸门
 * -----------------------------------------------------------------------------
 * 命令卡渲染即自动把命令打字到活动终端（2026-09-18 用户钦定），但这条路径
 * 会在三种场景下失控：
 *
 *  1. **重挂重放**：关掉 AI 小窗会让 AiMiniWindow 卸载（usePresence 的 mounted
 *     在 exitMs 后置 false），重开时整条历史消息重新挂载，每张命令卡的
 *     autoFiredRef 都是全新的 → 会把历史上所有命令重新打字一遍；auto 模式下
 *     还会**重新执行**它们。
 *  2. **同批互踩**：一条回复里有多个代码块时，它们在同一次宏任务内挂载，
 *     effect 同步依次跑完。整段注入路径会把多条命令**拼接成同一行输入**
 *     （`ls -la` + `cd /tmp` → `ls -lacd /tmp`），逐字路径则每条先 `\x03\r`
 *     清掉上一条，用户看到的是闪烁且只剩最后一条。
 *  3. **注入失败也被记账**（代码审查 H2）：原先 claim 时就写死"这条命令已打字"，
 *     而注入可能返回 false（冷标签没有渲染槽 / 终端已关）。结果常见命令
 *     （`git status`）在整个应用生命周期里**再也不会自动打字**，且没有任何提示
 *     —— 功能静默失效。所以"永久记账"必须等到注入真的成功。
 *
 * 记账按 **会话** 分域：新会话可以重新自动打字同一条命令（这是用户想要的），
 * 同一会话内重挂仍然不重放。
 *
 * ⚠️ 本账本管不到「应用重启 / 冷启动后打开历史对话」：账本是模块级内存，重启即
 * 清空，第一次挂载也没有记录。那条路径由 autoTypeProvenance（消息出身闸门）拦住
 * ——只有本次运行生成的消息才自动打字。两道闸门各管一段，不要拿掉任何一道。
 */

/** `${会话}\u0000${命令}` → 已成功自动打字过。 */
const typed = new Set<string>();

/** 当前宏任务批次是否已有卡占用自动打字权。 */
let claimedThisBatch = false;

const scopeKey = (command: string, scope: string | null): string =>
  `${scope ?? "-"}\u0000${command.trim()}`;

/**
 * 申请自动打字。返回 true 才允许注入。
 * 同一批次（同一次宏任务，即同一批 effect 刷新）内只有第一个调用者成功。
 * ⚠️ 这里**只占批次、不记账**：注入成功后必须调 `markAutoTyped`。
 */
export function claimAutoType(
  command: string,
  scope: string | null = null,
): boolean {
  if (!command.trim()) return false;
  if (typed.has(scopeKey(command, scope))) return false;
  if (claimedThisBatch) return false;
  claimedThisBatch = true;
  // 宏任务边界：同一批 effect（含同一任务内多次 commit）只放行第一张卡，
  // 下一条流式增量在新的宏任务里可以正常打字。微任务太窄，会让同一条回复里
  // 分属两个 commit 的两张卡同时注入并互相拼接。
  setTimeout(() => {
    claimedThisBatch = false;
  }, 0);
  return true;
}

/** 注入成功后记账：这条命令在这个会话里不再自动打字（防重挂重放）。 */
export function markAutoTyped(
  command: string,
  scope: string | null = null,
): void {
  typed.add(scopeKey(command, scope));
}

/** 仅供测试重置模块级状态。 */
export function __resetAutoTypeLedger(): void {
  typed.clear();
  claimedThisBatch = false;
}
