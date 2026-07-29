/**
 * ThemePreviewPanel.tsx — 终端主题预览面板
 * -----------------------------------------------------------------------------
 * 职责:
 *   - 网格布局展示所有主题缩略图 (mini 终端预览)
 *   - 搜索框 + 标签筛选 (Light/Dark/Colorful/Minimal)
 *   - 点击切换主题 (实时应用到 Terminal, 通过 applyTheme)
 *   - "导入主题"按钮 (接受 tabby JSON)
 *
 * 设计:
 *   - 不使用 CSS 变量 (主题色块直接用 hex, 因主题本身就是颜色定义)
 *   - 缩略图模拟终端: 显示 prompt + 命令行 + 几行输出
 *   - 当前主题高亮显示
 */
import { useState, useMemo, useRef, useCallback } from 'react';
import { Search, Upload, X, Check } from 'lucide-react';
import {
  listThemes,
  applyTheme,
  getCurrentThemeName,
  saveCustomTheme,
} from '../lib/terminal-theme';
import { parseTabbyTheme, validateTheme } from '../lib/theme-importer';
import type { ThemeMeta, ThemeCategory } from '../lib/themes';

interface ThemePreviewPanelProps {
  /** 面板是否打开 */
  readonly open: boolean;
  /** 关闭面板回调 */
  readonly onClose: () => void;
}

/** 分类筛选标签 */
const CATEGORIES: ReadonlyArray<{ readonly value: 'all' | ThemeCategory; readonly label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'colorful', label: 'Colorful' },
  { value: 'minimal', label: 'Minimal' },
] as const;

export function ThemePreviewPanel({ open, onClose }: ThemePreviewPanelProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | ThemeCategory>('all');
  const [current, setCurrent] = useState<string>(getCurrentThemeName());
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** 加载主题列表 (每次面板打开时重新读取, 兼容导入后的新主题) */
  const themes = useMemo<ThemeMeta[]>(() => (open ? listThemes() : []), [open]);

  /** 过滤后的主题列表 */
  const filtered = useMemo<ThemeMeta[]>(() => {
    if (!themes.length) return [];
    const q = search.trim().toLowerCase();
    return themes.filter((t) => {
      if (filter !== 'all' && t.category !== filter) return false;
      if (q && !t.displayName.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [themes, search, filter]);

  /** 点击主题 → 切换 */
  const handleSelect = useCallback((name: string) => {
    if (applyTheme(name)) {
      setCurrent(name);
    }
  }, []);

  /** 导入 tabby JSON */
  const handleImportFile = useCallback(async (file: File) => {
    setImportError(null);
    setImportSuccess(null);
    try {
      const text = await file.text();
      const theme = parseTabbyTheme(text);
      const errors = validateTheme(theme);
      if (errors.length > 0) {
        setImportError(`验证失败: ${errors.join('; ')}`);
        return;
      }
      saveCustomTheme(theme);
      setImportSuccess(`已导入主题: ${theme.displayName}`);
      // 自动应用导入的主题
      if (applyTheme(theme.name)) {
        setCurrent(theme.name);
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 文件选择变化 */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        void handleImportFile(file);
      }
      // 重置 input 以允许重复选择同一文件
      e.target.value = '';
    },
    [handleImportFile],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: 'rgba(0, 0, 0, 0.5)' }}
      data-testid="tdsf-theme-panel-overlay"
      onClick={onClose}
    >
      <div
        className="flex flex-col"
        style={{
          width: 'min(90vw, 960px)',
          maxHeight: '85vh',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-panel)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="tdsf-theme-panel"
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
            终端主题
          </span>
          <span style={{ color: 'var(--color-text-faint)', fontSize: '11px' }}>
            ({filtered.length}/{themes.length})
          </span>
          <div className="flex-1" />
          {/* 导入按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors"
            style={{
              background: 'var(--color-primary)',
              color: 'var(--color-text-on-primary)',
              fontSize: '11px',
            }}
            title="导入 tabby 主题 JSON"
          >
            <Upload className="w-3 h-3" />
            导入主题
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            data-testid="tdsf-theme-import-input"
          />
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="关闭"
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* === 搜索 + 筛选 === */}
        <div
          className="flex items-center gap-2 px-4 py-2 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div
            className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md"
            style={{
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
            }}
          >
            <Search
              className="w-3.5 h-3.5"
              style={{ color: 'var(--color-text-faint)' }}
            />
            <input
              type="text"
              placeholder="搜索主题..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="tdsf-theme-search"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--color-text)',
                fontSize: '12px',
              }}
            />
          </div>
          <div className="flex items-center gap-0.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => setFilter(cat.value)}
                className="px-2.5 py-1 rounded-md text-xs transition-colors"
                style={{
                  background:
                    filter === cat.value
                      ? 'var(--color-primary)'
                      : 'var(--color-surface)',
                  color:
                    filter === cat.value
                      ? 'var(--color-text-on-primary)'
                      : 'var(--color-text-muted)',
                  fontSize: '11px',
                  fontWeight: filter === cat.value ? 600 : 400,
                }}
                data-testid={`tdsf-theme-filter-${cat.value}`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* === 导入错误/成功提示 === */}
        {importError && (
          <div
            className="mx-4 mt-2 px-3 py-2 rounded-md text-xs"
            style={{
              background: 'var(--color-error-bg)',
              border: '1px solid var(--color-error)',
              color: 'var(--color-error)',
              fontSize: '11px',
            }}
            data-testid="tdsf-theme-import-error"
          >
            {importError}
          </div>
        )}
        {importSuccess && (
          <div
            className="mx-4 mt-2 px-3 py-2 rounded-md text-xs"
            style={{
              background: 'var(--color-success-bg)',
              border: '1px solid var(--color-success)',
              color: 'var(--color-success)',
              fontSize: '11px',
            }}
            data-testid="tdsf-theme-import-success"
          >
            {importSuccess}
          </div>
        )}

        {/* === 主题网格 === */}
        <div
          className="flex-1 overflow-y-auto p-4"
          style={{ minHeight: '0' }}
          data-testid="tdsf-theme-grid"
        >
          {filtered.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                color: 'var(--color-text-faint)',
                padding: '40px 0',
                fontSize: '12px',
              }}
            >
              未找到匹配的主题
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              }}
            >
              {filtered.map((theme) => (
                <ThemeCard
                  key={theme.name}
                  theme={theme}
                  active={current === theme.name}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 子组件: ThemeCard — 单个主题缩略图
// ============================================================================
interface ThemeCardProps {
  readonly theme: ThemeMeta;
  readonly active: boolean;
  readonly onSelect: (name: string) => void;
}

function ThemeCard({ theme, active, onSelect }: ThemeCardProps) {
  // 缩略图取主题的 4 个代表色: background + green(命令) + cyan(输出) + yellow(字符串)
  // 由于 ThemeMeta 只有 bg/fg, 我们需要从 getTheme 获取完整色板
  // 但为保持 ThemeCard 轻量, 直接用 bg/fg 渲染 mock 终端
  return (
    <button
      onClick={() => onSelect(theme.name)}
      className="rounded-lg overflow-hidden transition-all"
      style={{
        background: 'var(--color-surface)',
        border: active
          ? '2px solid var(--color-primary)'
          : '1px solid var(--color-border)',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      data-testid={`tdsf-theme-card-${theme.name}`}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.borderColor = 'var(--color-primary)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.borderColor = 'var(--color-border)';
      }}
    >
      {/* === Mini 终端预览 === */}
      <div
        className="px-3 py-2 font-mono"
        style={{
          background: theme.background,
          color: theme.foreground,
          fontSize: '10px',
          lineHeight: 1.5,
          minHeight: '80px',
        }}
      >
        <div>
          <span style={{ color: theme.foreground }}>$</span>{' '}
          <span>ls -la</span>
        </div>
        <div style={{ opacity: 0.7 }}>
          drwxr-xr-x 2 user user 4096
        </div>
        <div style={{ opacity: 0.7 }}>
          -rw-r--r-- 1 user user  512
        </div>
        <div>
          <span style={{ color: theme.foreground }}>$</span>{' '}
          <span style={{ display: 'inline-block', width: '6px', height: '10px', background: theme.foreground, verticalAlign: 'middle', marginLeft: '2px' }} />
        </div>
      </div>
      {/* === 主题信息 === */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        style={{
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-bg-elevated)',
        }}
      >
        <span
          className="font-medium truncate"
          style={{
            color: 'var(--color-text)',
            fontSize: '11px',
            flex: 1,
          }}
        >
          {theme.displayName}
        </span>
        {theme.custom && (
          <span
            className="px-1 rounded"
            style={{
              background: 'var(--color-primary-soft)',
              color: 'var(--color-primary)',
              fontSize: '9px',
            }}
          >
            自定义
          </span>
        )}
        <span
          className="px-1 rounded"
          style={{
            background: 'var(--color-surface-hover)',
            color: 'var(--color-text-muted)',
            fontSize: '9px',
          }}
        >
          {theme.category}
        </span>
        {active && (
          <Check
            className="w-3 h-3"
            style={{ color: 'var(--color-primary)' }}
          />
        )}
      </div>
    </button>
  );
}
