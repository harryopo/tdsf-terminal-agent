/**
 * Explorer.tsx — 资源管理器 (T-P2-05 + T-P2-06 一体化)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 远程文件树渲染 (递归 + 懒加载 + UTF-8 中文文件名)
 *   2. 路径导航栏 (面包屑 + 上级目录 + 刷新)
 *   3. 节点交互: 双击文件 → SFTP 读取 → 打开 Monaco Editor tab
 *   4. 多 tab 管理 (集成 EditorTabs + MonacoEditor)
 *   5. 右键菜单 (新建/删除/重命名/新建目录)
 *
 * 与 store 的关系:
 *   - 读取 state.sshSessions (找当前激活的 SSH 会话)
 *   - 读写 state.explorerPath (当前路径)
 *   - 读写 state.openFiles (已打开文件列表)
 *   - 读写 state.activeFilepath (当前激活文件)
 *
 * 与 SFTP 桥接的关系:
 *   - sftpList(sessionId, path) → 列目录
 *   - sftpRead(sessionId, path) → 读取文件内容
 *   - sftpMkdir / sftpRemove / sftpRename → 右键菜单操作
 *
 * 性能:
 *   - 文件树懒加载: 点击目录才请求 SFTP list_dir
 *   - 文件内容缓存: 同一文件不重复读取 (除非用户主动刷新)
 *   - 大文件拦截: MonacoEditor 内部已处理 (>1MB 不加载)
 *
 * 错误处理:
 *   - SFTP 操作失败 → toast 显示错误信息
 *   - 不阻塞其他文件操作
 *
 * 设计参考: VS Code Explorer + Remote-SSH 扩展
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRuntime } from '../store/runtime';
import type { ExplorerTreeNode, OpenFileItem } from '../store/runtime';
import {
  sftpList,
  sftpRead,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  decodeUtf8,
  type SftpEntry as SftpEntryBridge,
} from '../lib/sftp-bridge';
import { EditorTabs } from './EditorTabs';
import { MonacoEditor, detectLanguage } from './MonacoEditor';

interface ExplorerProps {
  /** 是否显示 (由父组件控制) */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

/** 从路径提取父目录 */
function dirname(path: string): string {
  // 移除末尾 / (除非是根路径 /)
  const normalized = path.endsWith('/') && path.length > 1
    ? path.slice(0, -1)
    : path;
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

/** 拼接父子路径 */
function joinPath(parent: string, child: string): string {
  if (parent === '/') return `/${child}`;
  return `${parent}/${child}`;
}

/** SftpEntry → ExplorerTreeNode (默认折叠,空 children) */
function sftpEntryToNode(entry: SftpEntryBridge, parentPath: string): ExplorerTreeNode {
  return {
    path: joinPath(parentPath, entry.name),
    name: entry.name,
    isDir: entry.isDir,
    expanded: false,
    loading: false,
    children: [],
  };
}

export function Explorer({ open, onClose }: ExplorerProps) {
  const { state, dispatch } = useRuntime();
  const [tree, setTree] = useState<ExplorerTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: ExplorerTreeNode | null;
  } | null>(null);
  // 新建/重命名输入框状态
  const [inputBox, setInputBox] = useState<{
    type: 'new-file' | 'new-dir' | 'rename';
    node: ExplorerTreeNode | null;
    value: string;
  } | null>(null);

  // === 获取当前激活的 SSH 会话 ===
  const activeSession = useMemo(() => {
    if (state.activeSshFrontendKey === null) return null;
    return (
      state.sshSessions.find((s) => s.frontendKey === state.activeSshFrontendKey) ??
      null
    );
  }, [state.sshSessions, state.activeSshFrontendKey]);

  const sessionId = activeSession?.id ?? null;

  // === 加载目录内容 ===
  const loadDirectory = useCallback(
    async (path: string): Promise<ExplorerTreeNode[]> => {
      if (sessionId === null) {
        throw new Error('SSH 会话未连接');
      }
      const entries = await sftpList(sessionId, path);
      return entries.map((e: SftpEntryBridge) => sftpEntryToNode(e, path));
    },
    [sessionId],
  );

  // === 初始化: open 变 true 时加载根目录 ===
  useEffect(() => {
    if (!open) return;
    if (sessionId === null) {
      setError('请先连接 SSH 会话');
      setTree([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDirectory(state.explorerPath)
      .then((nodes) => {
        if (cancelled) return;
        setTree(nodes);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`加载目录失败: ${msg}`);
        setTree([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, state.explorerPath, loadDirectory]);

  // === 切换目录 ===
  const handleNavigate = useCallback(
    (newPath: string) => {
      dispatch({ type: 'set-explorer-path', path: newPath });
    },
    [dispatch],
  );

  // === 展开/折叠目录节点 ===
  const toggleNode = useCallback(
    async (targetPath: string) => {
      // 在 tree 中查找并更新节点 (递归查找)
      const updateNodes = (nodes: ExplorerTreeNode[]): ExplorerTreeNode[] => {
        return nodes.map((node) => {
          if (node.path === targetPath) {
            if (!node.expanded && node.children.length === 0) {
              // 需要懒加载子节点
              if (sessionId === null) return node;
              setLoading(true);
              sftpList(sessionId, node.path)
                .then((entries: SftpEntryBridge[]) => {
                  const children = entries.map((e) =>
                    sftpEntryToNode(e, node.path),
                  );
                  setTree((prev) => {
                    const update = (nodes: ExplorerTreeNode[]): ExplorerTreeNode[] =>
                      nodes.map((n) => {
                        if (n.path === targetPath) {
                          return {
                            ...n,
                            expanded: true,
                            loading: false,
                            children,
                          };
                        }
                        if (n.children.length > 0) {
                          return { ...n, children: update(n.children) };
                        }
                        return n;
                      });
                    return update(prev);
                  });
                })
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  setError(`加载子目录失败: ${msg}`);
                })
                .finally(() => setLoading(false));
              return { ...node, expanded: true, loading: true };
            }
            // 已加载,直接切换展开状态
            return { ...node, expanded: !node.expanded };
          }
          if (node.children.length > 0) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });
      };
      setTree((prev) => updateNodes(prev));
    },
    [sessionId],
  );

  // === 双击文件 → SFTP 读取 → 打开 Monaco Editor ===
  const handleOpenFile = useCallback(
    async (node: ExplorerTreeNode) => {
      if (sessionId === null) {
        setError('SSH 会话未连接');
        return;
      }
      // 已打开则直接激活
      const existing = state.openFiles.find((f) => f.path === node.path);
      if (existing) {
        dispatch({ type: 'set-active-file', path: node.path });
        return;
      }

      // 创建 loading 状态的 OpenFileItem
      const fileItem: OpenFileItem = {
        path: node.path,
        name: node.name,
        content: '',
        originalContent: '',
        language: detectLanguage(node.path),
        size: 0,
        modified: 0,
        loading: true,
        error: null,
      };
      dispatch({ type: 'open-file', file: fileItem });

      try {
        const bytes = await sftpRead(sessionId, node.path);
        const text = decodeUtf8(bytes);
        dispatch({
          type: 'update-file',
          path: node.path,
          updates: {
            content: text,
            originalContent: text,
            size: bytes.length,
            modified: Date.now() / 1000 | 0,
            loading: false,
            error: null,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({
          type: 'update-file',
          path: node.path,
          updates: { loading: false, error: msg },
        });
      }
    },
    [sessionId, state.openFiles, dispatch],
  );

  // === 节点点击处理 ===
  const handleNodeClick = useCallback(
    (node: ExplorerTreeNode) => {
      if (node.isDir) {
        void toggleNode(node.path);
      } else {
        void handleOpenFile(node);
      }
    },
    [toggleNode, handleOpenFile],
  );

  // === 刷新当前目录 ===
  const handleRefresh = useCallback(() => {
    // 重新加载根节点 (清空所有 expanded 状态)
    if (sessionId === null) return;
    setLoading(true);
    loadDirectory(state.explorerPath)
      .then((nodes) => setTree(nodes))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`刷新失败: ${msg}`);
      })
      .finally(() => setLoading(false));
  }, [sessionId, state.explorerPath, loadDirectory]);

  // === 上级目录 ===
  const handleGoUp = useCallback(() => {
    const parent = dirname(state.explorerPath);
    if (parent !== state.explorerPath) {
      handleNavigate(parent);
    }
  }, [state.explorerPath, handleNavigate]);

  // === 右键菜单 ===
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: ExplorerTreeNode | null) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    [],
  );

  // === 关闭右键菜单 (点击任意位置) ===
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [contextMenu]);

  // === 新建目录 ===
  const handleMkdir = useCallback(
    async (parentPath: string, name: string) => {
      if (sessionId === null || !name.trim()) return;
      const newPath = joinPath(parentPath, name.trim());
      try {
        await sftpMkdir(sessionId, newPath);
        handleRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`新建目录失败: ${msg}`);
      }
    },
    [sessionId, handleRefresh],
  );

  // === 删除文件 ===
  const handleDelete = useCallback(
    async (node: ExplorerTreeNode) => {
      if (sessionId === null) return;
      const confirmed = window.confirm(
        `确定删除 ${node.isDir ? '目录' : '文件'} "${node.name}" 吗?\n\n此操作不可恢复。`,
      );
      if (!confirmed) return;
      try {
        await sftpRemove(sessionId, node.path);
        handleRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`删除失败: ${msg}`);
      }
    },
    [sessionId, handleRefresh],
  );

  // === 重命名 ===
  const handleRename = useCallback(
    async (node: ExplorerTreeNode, newName: string) => {
      if (sessionId === null || !newName.trim()) return;
      const parent = dirname(node.path);
      const newPath = joinPath(parent, newName.trim());
      if (newPath === node.path) return;
      try {
        await sftpRename(sessionId, node.path, newPath);
        handleRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`重命名失败: ${msg}`);
      }
    },
    [sessionId, handleRefresh],
  );

  // === ESC 关闭 ===
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // === 渲染文件树节点 (递归) ===
  const renderNode = (node: ExplorerTreeNode, depth: number = 0): React.ReactNode => {
    const isActive = state.activeFilepath === node.path;
    return (
      <div key={node.path}>
        <div
          className="flex items-center gap-1 cursor-pointer transition-colors select-none"
          style={{
            paddingLeft: `${8 + depth * 12}px`,
            paddingRight: '8px',
            paddingTop: '3px',
            paddingBottom: '3px',
            background: isActive ? 'var(--color-primary-soft)' : 'transparent',
            color: isActive
              ? 'var(--color-primary)'
              : node.isDir
                ? 'var(--color-text-muted)'
                : 'var(--color-text)',
            fontSize: '11px',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            lineHeight: 1.6,
          }}
          onClick={() => handleNodeClick(node)}
          onDoubleClick={() => {
            if (!node.isDir) void handleOpenFile(node);
          }}
          onContextMenu={(e) => handleContextMenu(e, node)}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'rgba(91,140,255,0.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'transparent';
            }
          }}
          title={node.path}
        >
          {/* 展开/折叠箭头 */}
          {node.isDir ? (
            <span
              className="flex-shrink-0"
              style={{
                width: '10px',
                color: 'var(--color-primary)',
                display: 'inline-block',
                transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.1s ease-out',
              }}
            >
              ▸
            </span>
          ) : (
            <span style={{ width: '10px', display: 'inline-block' }} />
          )}

          {/* 文件名 (UTF-8 中文自然支持) */}
          <span className="flex-1 truncate">{node.name}</span>

          {/* 加载中 spinner */}
          {node.loading && (
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                border: '1px solid var(--color-primary)',
                borderTopColor: 'transparent',
                animation: 'explorer-spin 0.8s linear infinite',
              }}
            />
          )}
        </div>

        {/* 递归子节点 (仅展开时) */}
        {node.isDir && node.expanded && node.children.length > 0 && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}

        {/* 输入框 (新建/重命名) */}
        {inputBox &&
          ((inputBox.type === 'new-dir' && inputBox.node === node) ||
            (inputBox.type === 'new-file' && inputBox.node === node) ||
            (inputBox.type === 'rename' && inputBox.node === node)) && (
            <div style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}>
              <input
                autoFocus
                value={inputBox.value}
                onChange={(e) =>
                  setInputBox({ ...inputBox, value: e.target.value })
                }
                onBlur={() => {
                  if (inputBox.type === 'rename' && inputBox.node) {
                    void handleRename(inputBox.node, inputBox.value);
                  }
                  setInputBox(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (inputBox.type === 'rename' && inputBox.node) {
                      void handleRename(inputBox.node, inputBox.value);
                    } else if (
                      inputBox.type === 'new-dir' &&
                      inputBox.node
                    ) {
                      void handleMkdir(inputBox.node.path, inputBox.value);
                    }
                    setInputBox(null);
                  } else if (e.key === 'Escape') {
                    setInputBox(null);
                  }
                }}
                style={{
                  width: 'calc(100% - 24px)',
                  padding: '2px 6px',
                  fontSize: '11px',
                  fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-primary)',
                  borderRadius: '2px',
                  color: 'var(--color-text)',
                  outline: 'none',
                }}
              />
            </div>
          )}
      </div>
    );
  };

  // === 渲染面包屑路径 ===
  const breadcrumbs = useMemo(() => {
    const parts = state.explorerPath.split('/').filter(Boolean);
    const crumbs: { name: string; path: string }[] = [
      { name: '~', path: '/' },
    ];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : `/${part}`;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }, [state.explorerPath]);

  // === 当前激活的文件内容 (传给 MonacoEditor) ===
  const activeFile = useMemo(() => {
    if (!state.activeFilepath) return null;
    return state.openFiles.find((f) => f.path === state.activeFilepath) ?? null;
  }, [state.activeFilepath, state.openFiles]);

  if (!open) return null;

  return (
    <div
      className="fixed flex"
      style={{
        top: '44px',
        bottom: '44px',
        left: '12px',
        right: '12px',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-panel)',
        zIndex: 60,
        overflow: 'hidden',
        animation: 'panelIn 0.2s ease-out',
      }}
      data-testid="tdsf-explorer"
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      {/* ===== 左侧: 文件树 ===== */}
      <aside
        className="flex flex-col shrink-0"
        style={{
          width: '280px',
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-border)',
        }}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between px-3 py-2 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <span
            className="font-semibold tracking-wider uppercase"
            style={{
              fontSize: '11px',
              color: 'var(--color-text-faint)',
              letterSpacing: '0.8px',
            }}
          >
            Explorer
          </span>
          <div className="flex items-center gap-1">
            {/* 新建文件按钮 */}
            <button
              className="transition-colors"
              style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: sessionId === null ? 'not-allowed' : 'pointer',
                borderRadius: '2px',
                opacity: sessionId === null ? 0.4 : 1,
              }}
              disabled={sessionId === null}
              onClick={() => {
                if (sessionId === null) return;
                setInputBox({
                  type: 'new-file',
                  node: { path: state.explorerPath, name: '', isDir: true, expanded: true, loading: false, children: [] },
                  value: 'untitled.txt',
                });
              }}
              title="新建文件"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </button>

            {/* 新建目录按钮 */}
            <button
              className="transition-colors"
              style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: sessionId === null ? 'not-allowed' : 'pointer',
                borderRadius: '2px',
                opacity: sessionId === null ? 0.4 : 1,
              }}
              disabled={sessionId === null}
              onClick={() => {
                if (sessionId === null) return;
                setInputBox({
                  type: 'new-dir',
                  node: { path: state.explorerPath, name: '', isDir: true, expanded: true, loading: false, children: [] },
                  value: 'new-folder',
                });
              }}
              title="新建目录"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/>
                <line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </button>

            {/* 刷新按钮 */}
            <button
              className="transition-colors"
              style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: '2px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--color-primary)';
                e.currentTarget.style.background = 'rgba(91,140,255,0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--color-text-faint)';
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={handleRefresh}
              title="刷新"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>

            {/* 关闭按钮 */}
            <button
              className="transition-colors"
              style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: '2px',
                marginLeft: '4px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--color-error)';
                e.currentTarget.style.background = 'rgba(248,113,113,0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--color-text-faint)';
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={onClose}
              title="关闭 (ESC)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* 面包屑路径导航 */}
        <div
          className="flex items-center gap-1 px-2 py-1.5 shrink-0 overflow-x-auto"
          style={{
            borderBottom: '1px solid var(--color-border)',
            background: 'var(--color-surface-active)',
          }}
        >
          {/* 上级目录按钮 */}
          <button
            className="flex-shrink-0 transition-colors"
            style={{
              width: '20px',
              height: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-faint)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            onClick={handleGoUp}
            title="上级目录"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
          </button>

          {/* 面包屑 */}
          {breadcrumbs.map((crumb, idx) => (
            <span key={crumb.path} className="flex items-center gap-1 flex-shrink-0">
              {idx > 0 && (
                <span style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}>
                  /
                </span>
              )}
              <button
                className="transition-colors"
                style={{
                  padding: '1px 4px',
                  fontSize: '10px',
                  fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                  color:
                    idx === breadcrumbs.length - 1
                      ? 'var(--color-primary)'
                      : 'var(--color-text-muted)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: '2px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(91,140,255,0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => handleNavigate(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {/* 文件树 */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ paddingTop: '4px', paddingBottom: '4px' }}
        >
          {sessionId === null ? (
            <div
              className="flex flex-col items-center justify-center h-full px-4 text-center"
              style={{ color: 'var(--color-text-faint)' }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ marginBottom: '8px', opacity: 0.5 }}
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              </svg>
              <div style={{ fontSize: '12px', marginBottom: '4px' }}>
                未连接 SSH
              </div>
              <div style={{ fontSize: '10px', opacity: 0.7 }}>
                请先建立 SSH 连接
              </div>
            </div>
          ) : loading && tree.length === 0 ? (
            <div
              className="flex items-center justify-center h-full"
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              加载中...
            </div>
          ) : tree.length === 0 ? (
            <div
              className="flex items-center justify-center h-full"
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              (空目录)
            </div>
          ) : (
            tree.map((node) => renderNode(node))
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            className="shrink-0 px-3 py-2"
            style={{
              background: 'rgba(248,113,113,0.08)',
              borderTop: '1px solid var(--color-error)',
              color: 'var(--color-error)',
              fontSize: '11px',
              fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              lineHeight: 1.4,
            }}
          >
            {error}
            <button
              className="ml-2 transition-colors"
              style={{
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: '11px',
              }}
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        )}
      </aside>

      {/* ===== 右侧: Monaco Editor (多 tab) ===== */}
      <main className="flex-1 flex flex-col min-w-0">
        <EditorTabs sessionId={sessionId} />

        <div className="flex-1 min-h-0">
          {activeFile ? (
            <MonacoEditor
              path={activeFile.path}
              content={activeFile.content}
              language={activeFile.language}
              size={activeFile.size}
              sessionId={sessionId}
            />
          ) : (
            <div
              className="flex flex-col items-center justify-center h-full"
              style={{
                color: 'var(--color-text-faint)',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              <div style={{ fontSize: '13px', marginBottom: '6px', opacity: 0.7 }}>
                选择文件以编辑
              </div>
              <div style={{ fontSize: '10px', opacity: 0.5 }}>
                双击左侧文件树节点
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ===== 右键菜单 ===== */}
      {contextMenu && (
        <div
          className="fixed"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm, 4px)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            zIndex: 100,
            minWidth: '140px',
            padding: '4px',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {/* 新建文件 */}
          <button
            className="block w-full text-left transition-colors"
            style={{
              padding: '6px 10px',
              color: 'var(--color-text)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              borderRadius: '2px',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-primary-soft)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={() => {
              const targetPath = contextMenu.node?.isDir
                ? contextMenu.node.path
                : state.explorerPath;
              setInputBox({
                type: 'new-file',
                node: { path: targetPath, name: '', isDir: true, expanded: true, loading: false, children: [] },
                value: 'untitled.txt',
              });
              setContextMenu(null);
            }}
          >
            新建文件
          </button>

          {/* 新建目录 */}
          <button
            className="block w-full text-left transition-colors"
            style={{
              padding: '6px 10px',
              color: 'var(--color-text)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              borderRadius: '2px',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-primary-soft)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={() => {
              const targetPath = contextMenu.node?.isDir
                ? contextMenu.node.path
                : state.explorerPath;
              setInputBox({
                type: 'new-dir',
                node: { path: targetPath, name: '', isDir: true, expanded: true, loading: false, children: [] },
                value: 'new-folder',
              });
              setContextMenu(null);
            }}
          >
            新建目录
          </button>

          {/* 重命名 (仅选中节点时) */}
          {contextMenu.node && (
            <>
              <div
                style={{
                  height: '1px',
                  background: 'var(--color-border)',
                  margin: '4px 0',
                }}
              />
              <button
                className="block w-full text-left transition-colors"
                style={{
                  padding: '6px 10px',
                  color: 'var(--color-text)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  borderRadius: '2px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-primary-soft)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => {
                  if (!contextMenu.node) return;
                  setInputBox({
                    type: 'rename',
                    node: contextMenu.node,
                    value: contextMenu.node.name,
                  });
                  setContextMenu(null);
                }}
              >
                重命名
              </button>

              <button
                className="block w-full text-left transition-colors"
                style={{
                  padding: '6px 10px',
                  color: 'var(--color-error)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  borderRadius: '2px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(248,113,113,0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => {
                  if (!contextMenu.node) return;
                  void handleDelete(contextMenu.node);
                  setContextMenu(null);
                }}
              >
                删除
              </button>
            </>
          )}
        </div>
      )}

      {/* ===== 输入框 (新建文件/新建目录) 在根目录时显示 ===== */}
      {inputBox &&
        (inputBox.type === 'new-file' || inputBox.type === 'new-dir') &&
        inputBox.node?.path === state.explorerPath && (
          <div
            style={{
              position: 'fixed',
              left: '12px',
              bottom: '44px',
              width: '260px',
              padding: '8px',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-primary)',
              borderRadius: '4px',
              zIndex: 110,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                color: 'var(--color-text-muted)',
                marginBottom: '6px',
              }}
            >
              {inputBox.type === 'new-dir' ? '新建目录' : '新建文件'}
            </div>
            <input
              autoFocus
              value={inputBox.value}
              onChange={(e) =>
                setInputBox({ ...inputBox, value: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (inputBox.type === 'new-dir' && inputBox.node) {
                    void handleMkdir(inputBox.node.path, inputBox.value);
                  }
                  // 新建文件: 实际就是 sftp_write 空内容
                  // 当前简化为新建目录,新建文件由 MonacoEditor 保存时自动创建
                  setInputBox(null);
                } else if (e.key === 'Escape') {
                  setInputBox(null);
                }
              }}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: '2px',
                color: 'var(--color-text)',
                outline: 'none',
              }}
              placeholder={inputBox.type === 'new-dir' ? '目录名' : '文件名'}
            />
          </div>
        )}

      <style>{`
        @keyframes panelIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes explorer-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
