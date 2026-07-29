/**
 * workspace-env.ts — 最小化工作区环境桩
 * -----------------------------------------------------------------------------
 * pty-bridge.ts 依赖此模块获取当前工作区环境 (local / wsl)。
 * 当前阶段仅支持 local, WSL 后续从 terax-ai 搬运。
 */
export type WorkspaceEnv =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string };

/** 默认本地工作区 */
export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: 'local' };

/** 当前工作区环境 (后续集成 zustand store) */
export function currentWorkspaceEnv(): WorkspaceEnv {
  return LOCAL_WORKSPACE;
}
