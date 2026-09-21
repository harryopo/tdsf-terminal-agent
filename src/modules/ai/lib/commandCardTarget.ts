/**
 * 命令卡的「归属终端」守卫（#91 第⑤条）。
 *
 * 一张命令卡在 tab1 里生成，用户切到 tab2 再点 Run —— 旧行为是把命令打进 tab2，
 * 可卡片上的解释、预测回显、目标主机说的全是 tab1。#89 之后每个标签页各连一条
 * 远端 shell，打错终端的代价从"目录不对"升级成"命令跑到了另一台机器上"。
 *
 * 所以卡片在**首次渲染**时记下当时的活动终端，点击时只允许打进同一条；
 * 不是了就拒绝并说清该切回哪里 —— 而不是换个终端悄悄执行。
 */

export type TerminalTarget = {
  tabId: number;
  leafId: number;
  /**
   * 当时这条终端绑的 Rust 会话号（`getLeafSshSession` 的口径）；本地终端为 null。
   * 用它而不是前端的 sessionId 字符串：注入路径查的就是这一个，重连后它会变，
   * 于是"同一个标签页但已经换了一条连接"也能被认成漂移。
   */
  sshRustSessionId: number | null;
  /** 给人看的名字：SSH 用 user@host，本地用目录末段 */
  label: string;
};

export type TargetDrift = "no-terminal" | "other-terminal";

/**
 * 当前活动终端相对卡片当初记下的那条是否已经换人。
 * 返回 null 表示可以安全注入。
 *
 * `expected === null` 表示卡片生成时压根没有活动终端 —— 那时它没有归属可言，
 * 保持既有行为（打进当前终端），否则纯本地流程会被无谓地拦一道。
 */
export function targetDrift(
  expected: TerminalTarget | null,
  current: TerminalTarget | null,
): TargetDrift | null {
  if (!expected) return null;
  if (!current) return "no-terminal";
  if (
    current.tabId === expected.tabId &&
    current.leafId === expected.leafId &&
    current.sshRustSessionId === expected.sshRustSessionId
  )
    return null;
  return "other-terminal";
}

/** 拦截时给人看的说明。要说清"切回哪一条"，只说"终端不匹配"等于没说。 */
export function driftMessage(
  drift: Exclude<TargetDrift, null>,
  expected: TerminalTarget,
): string {
  return drift === "no-terminal"
    ? `这条命令是给终端「${expected.label}」生成的，但当前没有可用终端。切回那个标签页再点。`
    : `这条命令是给终端「${expected.label}」生成的，当前活动终端已经是另一个。切回那个标签页再点，命令不会打进别的终端。`;
}
