// TDSF (P4-T4.1): SSH 会话/凭据/审批模块入口
// -----------------------------------------------------------------------------
// 远程文件树、远程编辑器与传输任务面板已在 #91②（2026-09-22）整片删除：
// 它们从 2026-08 起就没有挂载点（活着的远程树走 FileExplorer + fsb_*），
// 回归门禁见 ./retired-remote-tree.test.ts。
// 侧栏那片"SSH 连接"面板与它的连接弹窗已在 #109（2026-09-25）整片删除：
// 视图枚举 2026-08-01 就不认 ssh 视图，连接一律走「新建工作区 → SSH 服务器」，
// 回归门禁见 ./retired-ssh-panel.test.ts。
export {
  useSshStore,
  selectActiveSession,
  selectSessionById,
  selectSessionCurrentPath,
  isSessionConnected,
  isSessionConnecting,
  type SshSessionInfo,
} from './sshStore';
