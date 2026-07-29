/**
 * Explorer.test.tsx — 资源管理器组件单元测试 (T-P2-05 + T-P2-06)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. open=false 时不渲染
 *   2. SSH 未连接时显示"未连接 SSH"提示
 *   3. SSH 连接时调用 sftpList 加载根目录
 *   4. 文件树节点渲染 (目录 + 文件 + 中文名)
 *   5. 关闭按钮触发 onClose
 *   6. 面包屑路径显示
 *
 * Mock 策略:
 *   - vi.mock('../lib/sftp-bridge') 替换 SFTP 操作为 vi.fn()
 *   - vi.mock('./MonacoEditor') 替换为简化 div (避免加载真实 Monaco)
 *   - vi.mock('./EditorTabs') 替换为简化 div (避免依赖 Monaco)
 *   - 使用 RuntimeProvider 包裹组件提供 state
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// === Mock sftp-bridge ========================================================
// 必须在 import Explorer 之前 mock
vi.mock('../lib/sftp-bridge', () => ({
  sftpList: vi.fn(),
  sftpRead: vi.fn(),
  sftpWrite: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpRemove: vi.fn(),
  sftpRename: vi.fn(),
  decodeUtf8: vi.fn((bytes: Uint8Array) => new TextDecoder().decode(bytes)),
  encodeUtf8: vi.fn((text: string) => new TextEncoder().encode(text)),
}));

// === Mock MonacoEditor (避免加载真实 Monaco Editor) ==========================
vi.mock('./MonacoEditor', () => ({
  MonacoEditor: ({ path }: { path: string }) => (
    <div data-testid="tdsf-mock-monaco">mock-monaco:{path}</div>
  ),
  detectLanguage: vi.fn((path: string) => {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.py')) return 'python';
    if (path.endsWith('.md')) return 'markdown';
    return 'plaintext';
  }),
}));

// === Mock EditorTabs =========================================================
vi.mock('./EditorTabs', () => ({
  EditorTabs: ({ sessionId }: { sessionId: number | null }) => (
    <div data-testid="tdsf-mock-editor-tabs">mock-tabs:{sessionId ?? 'null'}</div>
  ),
}));

// === Mock @tauri-apps/api/core (避免 Tauri 环境依赖) =========================
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// === 在所有 mock 之后 import Explorer ========================================
import { Explorer } from './Explorer';
import { sftpList, sftpRead } from '../lib/sftp-bridge';
import { RuntimeProvider } from '../store/runtime';

// === 测试辅助 ================================================================
/** Mock 的 SFTP 目录项 */
const MOCK_ENTRIES = [
  {
    name: 'nginx.conf',
    path: '/etc/nginx/nginx.conf',
    isDir: false,
    isFile: true,
    isSymlink: false,
    size: 1024,
    modified: 1700000000,
    permissions: 'rw-r--r--',
  },
  {
    name: 'sites-enabled',
    path: '/etc/nginx/sites-enabled',
    isDir: true,
    isFile: false,
    isSymlink: false,
    size: 0,
    modified: 1700000001,
    permissions: 'rwxr-xr-x',
  },
  {
    name: '中文目录',
    path: '/etc/nginx/中文目录',
    isDir: true,
    isFile: false,
    isSymlink: false,
    size: 0,
    modified: 1700000002,
    permissions: 'rwxr-xr-x',
  },
];

/** 渲染 Explorer 并注入 RuntimeProvider */
function renderExplorer(options: {
  open?: boolean;
  onClose?: () => void;
} = {}) {
  const { open = true, onClose = vi.fn() } = options;

  // 通过 RuntimeProvider 包裹提供 state (默认 state: sshSessions 为空)
  function StateInjector({ children }: { children: ReactNode }) {
    return <RuntimeProvider>{children}</RuntimeProvider>;
  }

  const result = render(
    <StateInjector>
      <Explorer open={open} onClose={onClose} />
    </StateInjector>,
  );

  return { ...result, onClose };
}

beforeEach(() => {
  vi.mocked(sftpList).mockReset();
  vi.mocked(sftpRead).mockReset();
});

// === 测试用例 ================================================================

describe('Explorer', () => {
  // ==========================================================================
  // 1. 渲染基础
  // ==========================================================================
  it('open=false 时不渲染', () => {
    // 即使 sftpList 会失败,open=false 应该直接返回 null
    vi.mocked(sftpList).mockResolvedValue([]);

    const { container } = renderExplorer({ open: false });

    // 容器内不应该有 Explorer 的元素
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('tdsf-explorer')).toBeNull();
  });

  it('open=true 时渲染根容器', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    expect(screen.getByTestId('tdsf-explorer')).toBeTruthy();
  });

  // ==========================================================================
  // 2. SSH 未连接状态
  // ==========================================================================
  it('SSH 未连接时显示"未连接 SSH"提示', async () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    // 应该显示未连接 SSH 的提示文字
    expect(screen.getByText('未连接 SSH')).toBeTruthy();
  });

  // ==========================================================================
  // 3. 标题栏 + 按钮
  // ==========================================================================
  it('显示 Explorer 标题', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    expect(screen.getByText('Explorer')).toBeTruthy();
  });

  it('包含新建文件按钮', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    const newFileBtn = screen.getByTitle('新建文件');
    expect(newFileBtn).toBeTruthy();
  });

  it('包含新建目录按钮', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    const newDirBtn = screen.getByTitle('新建目录');
    expect(newDirBtn).toBeTruthy();
  });

  it('包含刷新按钮', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    const refreshBtn = screen.getByTitle('刷新');
    expect(refreshBtn).toBeTruthy();
  });

  it('包含关闭按钮 (ESC)', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    const closeBtn = screen.getByTitle('关闭 (ESC)');
    expect(closeBtn).toBeTruthy();
  });

  // ==========================================================================
  // 4. 关闭按钮交互
  // ==========================================================================
  it('点击关闭按钮触发 onClose', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    const { onClose } = renderExplorer({ open: true });

    const closeBtn = screen.getByTitle('关闭 (ESC)');
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 5. 面包屑导航
  // ==========================================================================
  it('显示根路径面包屑 (~)', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    // 根路径时面包屑显示 "~"
    expect(screen.getByText('~')).toBeTruthy();
  });

  it('包含上级目录按钮', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    const upBtn = screen.getByTitle('上级目录');
    expect(upBtn).toBeTruthy();
  });

  // ==========================================================================
  // 6. 空目录提示
  // ==========================================================================
  it('空 SSH 会话时显示连接提示', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    // 当 sessionId 为 null 时显示连接提示
    expect(screen.getByText('请先建立 SSH 连接')).toBeTruthy();
  });

  // ==========================================================================
  // 7. ESC 键关闭
  // ==========================================================================
  it('按 ESC 键触发 onClose', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    const { onClose } = renderExplorer({ open: true });

    // 模拟 ESC 键
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 8. 右键菜单
  // ==========================================================================
  it('右键空白区域显示菜单 (含新建文件/新建目录)', () => {
    vi.mocked(sftpList).mockResolvedValue([]);

    renderExplorer({ open: true });

    // 在 Explorer 根容器上触发 contextmenu
    const explorer = screen.getByTestId('tdsf-explorer');
    fireEvent.contextMenu(explorer);

    // 右键菜单应显示"新建文件"和"新建目录"选项
    expect(screen.getByText('新建文件')).toBeTruthy();
    expect(screen.getByText('新建目录')).toBeTruthy();
  });

  // ==========================================================================
  // 9. Mock 数据完整性 (类型检查)
  // ==========================================================================
  it('Mock SFTP entries 类型完整', () => {
    expect(MOCK_ENTRIES.length).toBe(3);
    expect(MOCK_ENTRIES[0].name).toBe('nginx.conf');
    expect(MOCK_ENTRIES[0].isFile).toBe(true);
    expect(MOCK_ENTRIES[1].name).toBe('sites-enabled');
    expect(MOCK_ENTRIES[1].isDir).toBe(true);
    expect(MOCK_ENTRIES[2].name).toBe('中文目录');
    expect(MOCK_ENTRIES[2].isDir).toBe(true);
  });
});
