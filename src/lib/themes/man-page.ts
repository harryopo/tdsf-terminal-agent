/**
 * man-page.ts — Man Page 主题
 * man 手册页黄底黑字主题
 */

import type { TerminalTheme } from './types';

export const manPage: TerminalTheme = {
  name: 'man-page',
  displayName: 'Man Page',
  category: 'light',
  foreground: '#000000',
  background: '#fef4ca',
  cursor: '#000000',
  cursorAccent: '#fef4ca',
  selectionBackground: 'rgba(0, 0, 0, 0.2)',
  black: '#fef4ca',
  red: '#cc0000',
  green: '#008800',
  yellow: '#666600',
  blue: '#0000cc',
  magenta: '#880088',
  cyan: '#008888',
  white: '#000000',
  brightBlack: '#666666',
  brightRed: '#cc0000',
  brightGreen: '#008800',
  brightYellow: '#666600',
  brightBlue: '#0000cc',
  brightMagenta: '#880088',
  brightCyan: '#008888',
  brightWhite: '#000000',
};
