import type { Theme } from "../types";

// TDSF 魔改: 中性灰色 9 档主色（简约大气，对齐用户偏好）
// 色板来源: Tailwind CSS neutral 50-950
//   50:  #fafafa   100: #f5f5f5   200: #e5e5e5   300: #d4d4d4   400: #a3a3a3
//   500: #737373   600: #525252   700: #404040   800: #262626   900: #171717
//   950: #0a0a0a
// 设计原则:
//   - 简约大气，避免暗绿色
//   - 亮/暗模式均使用中性灰色系
//   - 终端配色保持标准 ANSI 16 色（不主题化 ANSI，确保命令输出可读性）
//   - 层次清晰：background → card → secondary → accent → border 递进
//   - 暗色模式 primary 用 #909090（柔和不刺眼），亮色模式用 #404040（沉稳）
//
// TDSF 魔改: terax-default → tdsf-default（与全局 Terax→TDSF 清洗对齐）
//   - id: "terax-default" → "tdsf-default"
//   - 变量名: teraxDefault → tdsfDefault
//   - 旧主题 id "terax-default" 通过 themes/index.ts 的兼容层映射到本主题
export const tdsfDefault: Theme = {
  id: "tdsf-default",
  name: "TDSF Default",
  description: "中性灰色 9 档色板 · 简约专业",
  editorTheme: { dark: "atomone", light: "atomone" },
  variants: {
    light: {
      colors: {
        background: "#ffffff",
        foreground: "#1a1a1a",
        card: "#fafafa",
        cardForeground: "#1a1a1a",
        popover: "#ffffff",
        popoverForeground: "#1a1a1a",
        primary: "#404040",
        primaryForeground: "#ffffff",
        secondary: "#f5f5f5",
        secondaryForeground: "#1a1a1a",
        muted: "#f5f5f5",
        mutedForeground: "#737373",
        accent: "#ededed",
        accentForeground: "#1a1a1a",
        destructive: "#ef4444",
        border: "#e5e5e5",
        input: "#e5e5e5",
        ring: "#404040",
        sidebar: "#fafafa",
        sidebarForeground: "#1a1a1a",
        sidebarPrimary: "#404040",
        sidebarPrimaryForeground: "#ffffff",
        sidebarAccent: "#ededed",
        sidebarAccentForeground: "#1a1a1a",
        sidebarBorder: "#e5e5e5",
        sidebarRing: "#404040",
        radius: "0.5rem",
      },
      terminal: {
        background: "#ffffff",
        foreground: "#1a1a1a",
        cursor: "#404040",
        cursorAccent: "#ffffff",
        selection: "#e5e5e5",
        // 标准 ANSI 16 色（保持命令输出可读性，不主题化）
        ansi: [
          "#18181b",
          "#ef4444",
          "#22c55e",
          "#eab308",
          "#3b82f6",
          "#a855f7",
          "#06b6d4",
          "#e4e4e7",
          "#52525b",
          "#f87171",
          "#4ade80",
          "#facc15",
          "#60a5fa",
          "#c084fc",
          "#22d3ee",
          "#fafafa",
        ],
      },
    },
    dark: {
      colors: {
        background: "#1a1a1a",
        foreground: "#e4e4e4",
        card: "#1f1f1f",
        cardForeground: "#e4e4e4",
        popover: "#1f1f1f",
        popoverForeground: "#e4e4e4",
        primary: "#909090",
        primaryForeground: "#1a1a1a",
        secondary: "#262626",
        secondaryForeground: "#e4e4e4",
        muted: "#262626",
        mutedForeground: "#909090",
        accent: "#2d2d2d",
        accentForeground: "#e4e4e4",
        destructive: "#f87171",
        border: "#2d2d2d",
        input: "#2d2d2d",
        ring: "#6b7280",
        sidebar: "#1a1a1a",
        sidebarForeground: "#e4e4e4",
        sidebarPrimary: "#909090",
        sidebarPrimaryForeground: "#1a1a1a",
        sidebarAccent: "#2d2d2d",
        sidebarAccentForeground: "#e4e4e4",
        sidebarBorder: "#2d2d2d",
        sidebarRing: "#6b7280",
        radius: "0.5rem",
      },
      terminal: {
        background: "#1a1a1a",
        foreground: "#e4e4e4",
        cursor: "#909090",
        cursorAccent: "#1a1a1a",
        selection: "#2d2d2d",
        // 标准 ANSI 16 色（保持命令输出可读性，不主题化）
        ansi: [
          "#1a1a1a",
          "#f87171",
          "#4ade80",
          "#facc15",
          "#60a5fa",
          "#c084fc",
          "#22d3ee",
          "#a3a3a3",
          "#404040",
          "#ef4444",
          "#22c55e",
          "#eab308",
          "#3b82f6",
          "#a855f7",
          "#06b6d4",
          "#e4e4e4",
        ],
      },
    },
  },
};
