// TDSF 魔改 (P4-T4.1): SSH 远程资源管理器模块入口
// -----------------------------------------------------------------------------
// 通过此入口导出所有 SSH Explorer 组件 + store, 供 sidebar 集成使用
export { SshExplorer } from './SshExplorer';
export { SshStatusDot, stateLabel } from './SshStatusDot';
export { SshConnectDialog } from './SshConnectDialog';
export { SshFileTree } from './SshFileTree';
export { SshFileEditor } from './SshFileEditor';
export { SshFileTransfer } from './SshFileTransfer';
// TDSF 魔改 (#19): SshTerminalPane（裸 xterm）已删除, 改用 SshTerminalHost
// 走本地 rendererPool, 与本地终端同一套主题/字体/字号/保活。
export { SshTerminalHost } from './SshTerminalHost';
export {
  useSshStore,
  selectActiveSession,
  selectActiveSessionCurrentPath,
  isSessionConnected,
  type SshSessionInfo,
  type SshEditingFile,
  type SshTransferTask,
} from './sshStore';
