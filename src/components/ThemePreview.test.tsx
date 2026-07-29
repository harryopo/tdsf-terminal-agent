/**
 * ThemePreview.test.tsx — P0 阶段样式系统 smoke test
 * -----------------------------------------------------------------------------
 * 验证目标:
 *   1. 组件正常挂载
 *   2. 15 主题按钮全部渲染
 *   3. 7 Mood Ring 状态块存在
 *   4. 5 档风险段条存在
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemePreview } from './ThemePreview';

const THEMES = [
  'dark', 'light', 'dracula', 'gruvbox-dark', 'gruvbox-light',
  'nord', 'tokyo-night', 'solarized-dark', 'monokai', 'catppuccin',
  'one-dark', 'ayu-dark', 'cobalt', 'material', 'vesper',
];

describe('ThemePreview', () => {
  it('mounts and renders TDSF header', () => {
    render(
      <ThemePreview
        themes={THEMES}
        currentTheme="dark"
        onThemeChange={() => {}}
      />,
    );
    // TDSF 文本在 header 和 footer 都出现, 用 getAllByText
    expect(screen.getAllByText(/TDSF/).length).toBeGreaterThan(0);
    // v4.0 标签在 header 中
    expect(screen.getAllByText('v4.0').length).toBeGreaterThan(0);
  });

  it('renders 15 theme buttons (clickable)', () => {
    render(
      <ThemePreview
        themes={THEMES}
        currentTheme="dark"
        onThemeChange={() => {}}
      />,
    );
    const buttons = screen.getAllByRole('button');
    // 15 主题按钮 + 4 个组件示例按钮 = 至少 19
    expect(buttons.length).toBeGreaterThanOrEqual(THEMES.length);
  });

  it('renders 7 mood ring states (label text)', () => {
    render(
      <ThemePreview
        themes={THEMES}
        currentTheme="dark"
        onThemeChange={() => {}}
      />,
    );
    expect(screen.getByText('Idle 闲置')).toBeTruthy();
    expect(screen.getByText('Thinking 思考')).toBeTruthy();
    expect(screen.getByText('Stream 流式')).toBeTruthy();
    expect(screen.getByText('Working 执行')).toBeTruthy();
    expect(screen.getByText('Waiting 等待')).toBeTruthy();
    expect(screen.getByText('Done 完成')).toBeTruthy();
    expect(screen.getByText('Error 错误')).toBeTruthy();
  });

  it('renders 5 risk levels L0-L4', () => {
    render(
      <ThemePreview
        themes={THEMES}
        currentTheme="dark"
        onThemeChange={() => {}}
      />,
    );
    for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
      expect(screen.getByText(level)).toBeTruthy();
    }
  });

  it('renders terminal mock with prompt', () => {
    render(
      <ThemePreview
        themes={THEMES}
        currentTheme="dark"
        onThemeChange={() => {}}
      />,
    );
    expect(screen.getByText(/sudo nginx -t/)).toBeTruthy();
    expect(screen.getByText(/syntax is ok/)).toBeTruthy();
  });
});
