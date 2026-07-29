/**
 * cga.ts — CGA 主题
 * IBM CGA 适配器经典配色
 */

import type { TerminalTheme } from './types';

export const cga: TerminalTheme = {
  name: 'cga',
  displayName: 'CGA',
  category: 'minimal',
  foreground: '#aaaaaa',
  background: '#000000',
  cursor: '#aaaaaa',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(170, 170, 170, 0.3)',
  black: '#000000',
  red: '#aa0000',
  green: '#00aa00',
  yellow: '#aa5500',
  blue: '#0000aa',
  magenta: '#aa00aa',
  cyan: '#00aaaa',
  white: '#aaaaaa',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};
