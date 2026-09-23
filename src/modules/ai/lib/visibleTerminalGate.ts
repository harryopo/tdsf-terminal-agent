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
 * 这里只拆**原因与文案**，不改安全口径：命令没写进终端就是不执行，
 * 也不悄悄换成后台通道（那是用户明确选掉的执行方式）。
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

export type VisibleTerminalReject = {reason: string; message: string};

export function rejectForVisibleTerminal(
  input: VisibleTerminalGateInput,
): VisibleTerminalReject | null {
  if (!input.hasRequestId || !input.hasCommand) {
    return {
      reason: "malformed_request",
      message: "这条执行请求缺少请求号或命令内容，命令未执行。",
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
    return {
      reason: "no_visible_terminal",
      message:
        "这台服务器已连接，但界面上没有打开的终端可以写（还停在欢迎页／当前标签页是本地壳），" +
        "命令未执行。请先在顶栏打开这个工作区、切到它的终端标签页，再让我执行。",
    };
  }
  if (input.currentSessionId !== input.requestedSessionId) {
    return {
      reason: "session_mismatch",
      message:
        "当前看着的终端不是这条 SSH 会话（可能切了标签页或换了服务器），命令未执行。" +
        "请切回该服务器对应的终端标签页再试。",
    };
  }
  return null;
}
