// TDSF 魔改 (P4-T4.1): SSH 远程资源管理器模块入口
// -----------------------------------------------------------------------------
// 通过此入口导出所有 SSH Explorer 组件 + store, 供 sidebar 集成使用
export { SshExplorer } from './SshExplorer';
export { SshStatusDot, stateLabel } from './SshStatusDot';
export { SshConnectDialog } from './SshConnectDialog';
export { SshFileTree } from './SshFileTree';
export { SshFileEditor } from './SshFileEditor';
export { SshFileTransfer } from './SshFileTransfer';
export { SshTerminalPane } from './SshTerminalPane';
export {
  useSshStore,
  selectActiveSession,
  selectActiveSessionCurrentPath,
  isSessionConnected,
  type SshSessionInfo,
  type SshEditingFile,
  type SshTransferTask,
} from './sshStore';
