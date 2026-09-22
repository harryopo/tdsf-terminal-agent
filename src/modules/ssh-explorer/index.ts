// TDSF (P4-T4.1): SSH 会话/凭据/审批模块入口
// -----------------------------------------------------------------------------
// 远程文件树、远程编辑器与传输任务面板已在 #91②（2026-09-22）整片删除：
// 它们从 2026-08 起就没有挂载点（活着的远程树走 FileExplorer + fsb_*），
// 回归门禁见 ./retired-remote-tree.test.ts。
export { SshExplorer } from './SshExplorer';
export { SshStatusDot, stateLabel } from './SshStatusDot';
export { SshConnectDialog } from './SshConnectDialog';
export {
  useSshStore,
  selectActiveSession,
  selectSessionById,
  selectSessionCurrentPath,
  isSessionConnected,
  isSessionConnecting,
  type SshSessionInfo,
} from './sshStore';
