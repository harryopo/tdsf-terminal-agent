/**
 * #118（2026-09-23）：可见终端执行被拒时，**为什么**和**怎么办**都要说清。
 *
 * 实测现场：用户在偏好里选了"可见终端执行"，人停在欢迎页（没进入任何工作区）。
 * 此时 SSH 在后台是连着的（store 里 connected、rust 会话号也在），所以 agent 认为
 * 有目标；但一块终端都没挂载（terminalRefs 为空），前端只能回 unavailable。
 * 旧写法把"会话不匹配""没有标签页""终端没挂载"全塞进同一句
 * 「当前没有与该 SSH 会话匹配的可见终端」——用户看不出该做什么，agent 连着撞三次
 * 同一个墙然后汇报失败。
 *
 * 这里只拆**原因与文案**，外加一条事实标注：哪一种拒绝等于"命令一个字都没写进终端"。
 *
 * 2026-09-25 #118 后半（用户拍板）修订了最后一句旧口径：**没有可见终端**这一档
 * 不再等于"这条命令今天执行不了"——只读/低风险可以改道后台 SSH 拿真结果。
 * 标注叫 `reroutableToBackground` 而不是直接改道，因为风险级不归这里判：
 * 前端只担保"没有二次执行风险"，**写操作（L2 以上）要不要改道由 sidecar 决定**，
 * 那里一寸不松（没有可见终端就是不执行写操作）。改道也不静默：载荷里会写明换了通道。
 */

export type VisibleTerminalGateInput = {
  hasRequestId: boolean;
  hasCommand: boolean;
  /** 当前可见终端所属的 Rust 会话号；没有可见终端时为 null */
  currentSessionId: number | null;
  /** sidecar 要求执行的目标会话号 */
  requestedSessionId: number | null | undefined;
  /** 可见 SSH 终端的 leaf 号 */
  leafId: number | null | undefined;
  /** 这块 leaf 是否真的挂载了渲染器（xterm 实例存在才能注入字节） */
  terminalMounted: boolean;
};

export type VisibleTerminalReject = {
  reason: string;
  message: string;
  /**
   * true = 这条拒绝担保"命令没有写进任何终端"，因此允许 sidecar 在只读/低风险时
   * 把同一条命令改派到后台通道，不可能造成二次执行。
   */
  reroutableToBackground: boolean;
};

/**
 * 「界面上没有可写的终端」这一档的拒绝回执。
 *
 * 单独导出是因为调用方在判据之后还要做一次**类型收窄**（`leafId` 与 xterm 实例
 * 在 TS 眼里仍是 optional）：那条兜底分支正常到不了，一旦到了就是判据被改坏，
 * 必须 fail-closed 回绝 —— 文案必须与这里同源，否则同一个原因会出现两种说法
 * （#118 立这个模块的唯一理由就是一个原因只有一句话）。
 */
export const NO_VISIBLE_TERMINAL_REJECT: VisibleTerminalReject = {
  reason: "no_visible_terminal",
  message:
    "这台服务器已连接，但界面上没有打开的终端可以写（还停在欢迎页／当前标签页是本地壳），" +
    "命令未执行。请先在顶栏打开这个工作区、切到它的终端标签页，再让我执行。",
  reroutableToBackground: true,
};

/**
 * 改道回执的**载荷形状**（唯一主人）。
 *
 * sidecar 读的是 `status == "reroute" && channel == "background"` 两个字面量
 * （`strands_backend/tools/__init__.py`）；写错一个字符不会有任何报错，只会让
 * 只读命令退回"白撞三次"——所以这里收成一处，配一条 toEqual 用例钉住四个键。
 */
export function rerouteToBackground(
  reason: string,
  message: string,
): Record<string, string> {
  return { status: "reroute", channel: "background", reason, message };
}

export function rejectForVisibleTerminal(
  input: VisibleTerminalGateInput,
): VisibleTerminalReject | null {
  if (!input.hasRequestId || !input.hasCommand) {
    return {
      reason: "malformed_request",
      message: "这条执行请求缺少请求号或命令内容，命令未执行。",
      // 连命令都没有，后台通道也没东西可执行。
      reroutableToBackground: false,
    };
  }
  if (
    input.currentSessionId === null ||
    input.leafId === null ||
    input.leafId === undefined ||
    !input.terminalMounted
  ) {
    // 顺序很重要：没有可见终端时 currentSessionId 必然也是 null，
    // 先判会话号就会把"界面上没终端"说成"切错标签页"（2026-09-23 真机复现）。
    return NO_VISIBLE_TERMINAL_REJECT;
  }
  if (input.currentSessionId !== input.requestedSessionId) {
    return {
      reason: "session_mismatch",
      message:
        "当前看着的终端不是这条 SSH 会话（可能切了标签页或换了服务器），命令未执行。" +
        "请切回该服务器对应的终端标签页再试。",
      // 那块终端确实存在、只是另一台机器：悄悄打到另一台是更糟的"所见非所跑"。
      reroutableToBackground: false,
    };
  }
  return null;
}
