/* nord.ts — Nord 主题 (源自 terax-ai, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: terax-ai/src/modules/theme/themes/nord.ts
 * License: Apache-2.0, Copyright 2026 Crynta
 *
 * Arctic, north-bluish clean and elegant
 */

import type { Theme } from "../types";

export const nord: Theme = {
  id: "nord",
  name: "Nord",
  description: "Arctic, north-bluish clean and elegant",
  variants: {
    dark: {
      colors: {
        background: "#2e3440",
        foreground: "#d8dee9",
        card: "#3b4252",
        cardForeground: "#d8dee9",
        popover: "#3b4252",
        popoverForeground: "#d8dee9",
        primary: "#88c0d0",
        primaryForeground: "#2e3440",
        secondary: "#434c5e",
        secondaryForeground: "#d8dee9",
        muted: "#434c5e",
        mutedForeground: "#81a1c1",
        accent: "#434c5e",
        accentForeground: "#d8dee9",
        destructive: "#bf616a",
        border: "rgba(216,222,233,0.10)",
        input: "rgba(216,222,233,0.14)",
        ring: "#88c0d0",
        sidebar: "#3b4252",
        sidebarForeground: "#d8dee9",
        sidebarPrimary: "#88c0d0",
        sidebarPrimaryForeground: "#2e3440",
        sidebarAccent: "#434c5e",
        sidebarAccentForeground: "#d8dee9",
        sidebarBorder: "rgba(216,222,233,0.10)",
        sidebarRing: "#88c0d0",
      },
      terminal: {
        cursor: "#d8dee9",
        cursorAccent: "#2e3440",
        selection: "rgba(136,192,208,0.25)",
        ansi: [
          "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
          "#81a1c1", "#b48ead", "#8fbcbb", "#e5e9f0",
          "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
          "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
        ],
      },
    },
  },
};
