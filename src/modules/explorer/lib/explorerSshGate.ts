/**
 * 左侧文件树该渲染哪一侧的数据源。
 *
 * - `remote`：当前视图有一条活着的远端会话，照常走 SFTP。
 * - `local`：本地/WSL 工作区，或 SSH 工作区里**故意**开的本地壳标签页（#89 之后
 *   每个标签页可以各连一条，也可以就是本地壳）——这种情况下列出本地目录是对的。
 * - `offline`：服务器工作区，但工作区自己那条主会话已经不在了，而当前视图又不是
 *   别的活着的远端会话。这里**不能**回退成本地树：那等于在服务器工作区里静默显示
 *   本地 Windows 文件，用户看到的就是"资源管理器串台"（#102 收尾这条）。
 */
export type ExplorerSshGate = "remote" | "local" | "offline";

export function explorerSshGate(opts: {
  isSshSpace: boolean;
  /** 当前正在渲染的那条会话（活动标签页 / 回退到工作区主会话）是否活着 */
  remoteViewLive: boolean;
  /** 工作区自己绑定的那条主会话是否活着 */
  spaceSessionAlive: boolean;
}): ExplorerSshGate {
  if (opts.remoteViewLive) return "remote";
  if (!opts.isSshSpace) return "local";
  return opts.spaceSessionAlive ? "local" : "offline";
}
