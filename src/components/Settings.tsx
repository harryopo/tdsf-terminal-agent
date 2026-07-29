/**
 * Settings.tsx — 设置面板
 * -----------------------------------------------------------------------------
 * 职责:
 *   - 提供应用设置入口 (主题、字体、快捷键等)
 *   - "终端主题"项点击打开 ThemePreviewPanel
 *   - 当前态: 仅实现主题切换入口, 其他设置项作为后续扩展占位
 *
 * 设计:
 *   - 浮动面板 (与 AgentPanel 同层级 z-40)
 *   - 关闭: 点击遮罩 / X 按钮 / Esc 键
 */
import { useEffect, useState } from 'react';
import { X, Palette, Type, Keyboard, Info } from 'lucide-react';
import { ThemePreviewPanel } from './ThemePreviewPanel';
import { getCurrentThemeName, getTheme } from '../lib/terminal-theme';

interface SettingsProps {
  /** 面板是否打开 */
  readonly open: boolean;
  /** 关闭面板回调 */
  readonly onClose: () => void;
}

export function Settings({ open, onClose }: SettingsProps) {
  const [themePanelOpen, setThemePanelOpen] = useState(false);
  const [currentThemeName, setCurrentThemeName] = useState<string>(getCurrentThemeName());

  // 打开设置面板时刷新当前主题名
  useEffect(() => {
    if (open) {
      setCurrentThemeName(getCurrentThemeName());
    }
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (themePanelOpen) {
          setThemePanelOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, themePanelOpen, onClose]);

  // 主题面板关闭后刷新当前主题名
  const handleThemePanelClose = () => {
    setThemePanelOpen(false);
    setCurrentThemeName(getCurrentThemeName());
  };

  if (!open) return null;

  const currentTheme = getTheme(currentThemeName);

  return (
    <>
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{ zIndex: 150, background: 'rgba(0, 0, 0, 0.4)' }}
        onClick={onClose}
        data-testid="tdsf-settings-overlay"
      >
        <div
          className="flex flex-col"
          style={{
            width: 'min(90vw, 520px)',
            maxHeight: '80vh',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-xl)',
            boxShadow: 'var(--shadow-panel)',
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
          data-testid="tdsf-settings-panel"
        >
          {/* === Header === */}
          <div
            className="flex items-center gap-3 px-4 shrink-0"
            style={{
              height: '48px',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <span
              className="font-semibold"
              style={{ color: 'var(--color-text)', fontSize: '14px' }}
            >
              设置
            </span>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              title="关闭 (Esc)"
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* === 设置项列表 === */}
          <div className="flex-1 overflow-y-auto p-2">
            {/* 终端主题 */}
            <button
              onClick={() => setThemePanelOpen(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors text-left"
              style={{ color: 'var(--color-text)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              data-testid="tdsf-settings-theme"
            >
              <Palette
                className="w-4 h-4"
                style={{ color: 'var(--color-primary)' }}
              />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: '13px', fontWeight: 500 }}>终端主题</div>
                <div
                  className="truncate"
                  style={{ color: 'var(--color-text-faint)', fontSize: '11px' }}
                >
                  {currentTheme?.displayName ?? currentThemeName}
                  {' · '}
                  {currentTheme?.category ?? 'unknown'}
                </div>
              </div>
              {/* 主题预览色块 */}
              {currentTheme && (
                <div className="flex items-center gap-1">
                  <div
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      background: currentTheme.background,
                      border: '1px solid var(--color-border)',
                    }}
                    title="背景色"
                  />
                  <div
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      background: currentTheme.foreground,
                      border: '1px solid var(--color-border)',
                    }}
                    title="前景色"
                  />
                </div>
              )}
            </button>

            {/* 字体 (占位, 后续实现) */}
            <div
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left"
              style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}
            >
              <Type className="w-4 h-4" />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: '13px', fontWeight: 500 }}>字体</div>
                <div style={{ color: 'var(--color-text-faint)', fontSize: '11px' }}>
                  即将推出
                </div>
              </div>
            </div>

            {/* 快捷键 (占位, 后续实现) */}
            <div
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left"
              style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}
            >
              <Keyboard className="w-4 h-4" />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: '13px', fontWeight: 500 }}>快捷键</div>
                <div style={{ color: 'var(--color-text-faint)', fontSize: '11px' }}>
                  即将推出
                </div>
              </div>
            </div>

            {/* 关于 (占位, 后续实现) */}
            <div
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left"
              style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}
            >
              <Info className="w-4 h-4" />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: '13px', fontWeight: 500 }}>关于</div>
                <div style={{ color: 'var(--color-text-faint)', fontSize: '11px' }}>
                  TDSF Terminal Agent v4.0
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* === 主题预览面板 === */}
      <ThemePreviewPanel
        open={themePanelOpen}
        onClose={handleThemePanelClose}
      />
    </>
  );
}
