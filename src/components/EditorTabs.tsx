/**
 * EditorTabs.tsx — Monaco Editor 多 tab 管理 (T-P2-06.4)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 渲染已打开文件的 tab 列表 (从 store.openFiles 读取)
 *   2. tab 切换: 点击 tab → dispatch set-active-file
 *   3. tab 关闭: 点击 × → dispatch close-file
 *   4. dirty 标记: content !== originalContent 时显示 ●
 *   5. 加载中状态: loading=true 时显示 spinner
 *   6. 错误状态: error 非 null 时显示红色边框
 *
 * 与 MonacoEditor 的关系:
 *   - EditorTabs 渲染 tab 列表 (顶部 28px)
 *   - 父组件 (Explorer) 根据 activeFilepath 渲染对应 MonacoEditor (主区)
 *   - 每个 tab 的文件内容存储在 store.openFiles[i].content
 *
 * 设计参考: VS Code tab bar
 */
import { useRuntime } from '../store/runtime';

interface EditorTabsProps {
  /** SSH 会话 ID (传递给 MonacoEditor 用于 sftpWrite) */
  sessionId: number | null;
}

export function EditorTabs({ sessionId: sessionIdProp }: EditorTabsProps) {
  const { state, dispatch } = useRuntime();
  const { openFiles, activeFilepath } = state;

  // 无文件打开时不渲染
  if (openFiles.length === 0) return null;

  // === tab 切换 ===
  const handleSelect = (path: string) => {
    dispatch({ type: 'set-active-file', path });
  };

  // === tab 关闭 (带 dirty 提示) ===
  const handleClose = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const file = openFiles.find((f) => f.path === path);
    if (file && file.content !== file.originalContent) {
      // dirty 文件需要确认 (避免误关闭丢失修改)
      const confirmed = window.confirm(
        `${file.name} 有未保存的修改,确定关闭吗?\n\n未保存的内容将丢失。`,
      );
      if (!confirmed) return;
    }
    dispatch({ type: 'close-file', path });
  };

  return (
    <div
      className="flex items-center shrink-0 overflow-x-auto"
      style={{
        height: '28px',
        background: 'var(--terminal-bg)',
        borderBottom: '1px solid rgba(91,140,255,0.08)',
      }}
      data-testid="tdsf-editor-tabs"
    >
      {openFiles.map((file) => {
        const isActive = file.path === activeFilepath;
        const isDirty = file.content !== file.originalContent;
        const hasError = file.error !== null;
        const isLoading = file.loading;

        return (
          <div
            key={file.path}
            className="flex items-center gap-1.5 cursor-pointer transition-colors select-none"
            style={{
              minWidth: '120px',
              maxWidth: '200px',
              height: '100%',
              padding: '0 8px',
              borderRight: '1px solid rgba(91,140,255,0.08)',
              background: isActive ? 'var(--color-bg)' : 'transparent',
              borderBottom: isActive
                ? '1.5px solid var(--color-primary)'
                : '1.5px solid transparent',
              color: isActive
                ? 'var(--color-text)'
                : 'var(--color-text-muted)',
            }}
            onClick={() => handleSelect(file.path)}
            title={file.path}
          >
            {/* 状态指示 (loading / error / dirty) */}
            <span
              className="flex-shrink-0"
              style={{
                width: '8px',
                height: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {isLoading ? (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    border: '1px solid var(--color-primary)',
                    borderTopColor: 'transparent',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              ) : hasError ? (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--color-error)',
                  }}
                />
              ) : isDirty ? (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--color-warning)',
                  }}
                />
              ) : null}
            </span>

            {/* 文件名 */}
            <span
              className="flex-1 truncate"
              style={{
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                fontWeight: isActive ? 500 : 400,
              }}
            >
              {file.name}
            </span>

            {/* 关闭按钮 (hover 显示) */}
            <button
              className="flex-shrink-0 transition-colors"
              style={{
                width: '16px',
                height: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-faint)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: '2px',
                fontSize: '14px',
                lineHeight: 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                e.currentTarget.style.color = 'var(--color-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--color-text-faint)';
              }}
              onClick={(e) => handleClose(e, file.path)}
              aria-label={`关闭 ${file.name}`}
            >
              ×
            </button>
          </div>
        );
      })}

      {/* 右侧填充区 (显示 sessionId 信息) */}
      <div
        className="flex-1 flex items-center justify-end pr-2"
        style={{
          color: 'var(--color-text-faint)',
          fontSize: '10px',
          fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
        }}
      >
        {sessionIdProp !== null ? `ssh#${sessionIdProp}` : 'local'}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
