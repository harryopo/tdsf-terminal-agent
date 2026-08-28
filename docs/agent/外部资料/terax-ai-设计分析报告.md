# Terax-AI 设计分析报告

> 分析日期：2026-07-26  
> 仓库：https://github.com/crynta/terax-ai  
> 官网：https://terax.app/  
> 文档：https://terax.app/docs  

---

## 一、项目概览

Terax 是一个 **Terminal-first AI-native dev workspace**，使用 Tauri (Rust + React/TypeScript) 构建，安装包仅 7MB。定位为 VS Code Terminal + Cursor/Windsurf AI 的融合体，强调轻量、快速、以终端为核心。

技术栈：
- **桌面框架**：Tauri 2 (Rust backend)
- **前端**：React 19 + TypeScript + Vite
- **UI 框架**：Tailwind CSS v4 + shadcn/ui
- **终端引擎**：xterm.js
- **编辑器**：CodeMirror 6
- **文档站**：Next.js + fumadocs

---

## 二、配色方案

### 2.1 默认主题 (Terax Default)

默认主题完全由 CSS 变量驱动，定义在 `src/styles/globals.css` 中。**Terax Default 不硬编码任何颜色值**，完全依赖 shadcn/ui 标准 light/dark 变量。

#### Dark Mode（默认，也是核心审美方向）

| Token | 值 (oklch) | Hex 近似 | 用途 |
|-------|-----------|---------|------|
| `--background` | `oklch(0.148 0.004 228.8)` | `#161618` | 主背景 |
| `--foreground` | `oklch(0.987 0.002 197.1)` | `#fafafa` | 主文字 |
| `--card` | `oklch(0.218 0.008 223.9)` | `#27272a` | 卡片/面板 |
| `--popover` | `oklch(0.218 0.008 223.9)` | `#27272a` | 弹出层 |
| `--primary` | `oklch(0.925 0.005 214.3)` | `#e4e4e7` | 主色 |
| `--secondary` | `oklch(0.275 0.011 216.9)` | `#3f3f46` | 次要色 |
| `--muted` | `oklch(0.275 0.011 216.9)` | `#3f3f46` | 弱化背景 |
| `--muted-foreground` | `oklch(0.723 0.014 214.4)` | `#a1a1aa` | 弱化文字 |
| `--accent` | `oklch(0.275 0.011 216.9)` | `#3f3f46` | 强调色 |
| `--destructive` | `oklch(0.704 0.191 22.216)` | `#ef4444` | 危险/删除 |
| `--border` | `oklch(1 0 0 / 10%)` | `rgba(255,255,255,0.1)` | 边框 |
| `--input` | `oklch(1 0 0 / 15%)` | `rgba(255,255,255,0.15)` | 输入框边框 |
| `--ring` | `oklch(0.56 0.021 213.5)` | `#71717b` | 聚焦环 |
| `--sidebar` | `oklch(0.218 0.008 223.9)` | `#27272a` | 侧边栏 |
| `--sidebar-primary` | `oklch(0.488 0.243 264.376)` | `#7c3aed` | 侧边栏主色（紫色强调） |

#### Light Mode

| Token | 值 (oklch) | Hex 近似 |
|-------|-----------|---------|
| `--background` | `oklch(1 0 0)` | `#ffffff` |
| `--foreground` | `oklch(0.148 0.004 228.8)` | `#161618` |
| `--primary` | `oklch(0.218 0.008 223.9)` | `#27272a` |
| `--border` | `oklch(0.925 0.005 214.3)` | `#e4e4e7` |

### 2.2 终端 ANSI 配色

终端配色为全局默认（不受主题切换影响，但主题可以覆盖）：

| ANSI 色 | Hex | 描述 |
|---------|-----|------|
| Black | `#18181b` | zinc-900 |
| Red | `#ef4444` | red-500 |
| Green | `#22c55e` | green-500 |
| Yellow | `#eab308` | yellow-500 |
| Blue | `#3b82f6` | blue-500 |
| Magenta | `#a855f7` | purple-500 |
| Cyan | `#06b6d4` | cyan-500 |
| White | `#e4e4e7` | zinc-200 |
| Bright Black | `#52525b` | zinc-600 |
| Bright Red | `#f87171` | red-400 |
| Bright Green | `#4ade80` | green-400 |
| Bright Yellow | `#facc15` | yellow-400 |
| Bright Blue | `#60a5fa` | blue-400 |
| Bright Magenta | `#c084fc` | purple-400 |
| Bright Cyan | `#22d3ee` | cyan-400 |
| Bright White | `#fafafa` | zinc-50 |

### 2.3 内置主题列表

Terax 内置 15 个主题（实际文件中的主题比文档列出的更多）：

**文档列出的 10 个**：terax-default、nord、tide、catppuccin、tokyo-night、caffeine、claude、gruvbox、sage、rose-pine

**代码中还有**：dracula、everforest、kanagawa、kanagawa-dragon、solarized

### 2.4 东京之夜（Tokyo Night）配色示例

代表性第三方主题，展示了 Terax 主题引擎的能力：

- 背景 `#1a1b26`（深蓝黑）
- 前景 `#c0caf5`（柔和蓝白）
- 强调 `#7aa2f7`（蓝色高亮）
- 侧边栏主色：蓝色
- 终端选择色：蓝色 25% 透明

### 2.5 官网配色

官网使用的是 fumadocs 文档框架，配色与默认 dark mode 一致，但额外使用了：
- **Info**: `#3080ff`（蓝色）
- **Warning**: `#f99c00`（琥珀色）
- **Error**: `#fb2c36`（红色）
- **Success**: `#00c758`（绿色）
- **Idea**: `#ee7e00`（橙色）

---

## 三、布局结构

### 3.1 整体布局

Terax 采用经典的 IDE 式多面板布局，与 VS Code 高度相似：

```
┌──────────────────────────────────────────────┐
│  Header (标题栏/菜单)                         │
├──────┬───────────────────────┬───────────────┤
│      │                       │               │
│ Side │   Main Content        │  AI Panel     │
│ bar  │   (Terminal/Editor/   │  (可收起)     │
│      │    Preview/Source     │               │
│      │    Control Tabs)      │               │
│      │                       │               │
├──────┴───────────────────────┴───────────────┤
│  Status Bar (状态栏)                          │
└──────────────────────────────────────────────┘
```

### 3.2 核心面板

| 面板 | 位置 | 描述 |
|------|------|------|
| **Header** | 顶部 | 最小化标题栏，窗口控制按钮 |
| **Sidebar** | 左侧 | 文件浏览器、Git 面板切换 |
| **Terminal** | 中央主体 | xterm.js 渲染，分屏支持 |
| **Editor** | 中央主体 | CodeMirror 6 编辑器标签页 |
| **AI Panel** | 右侧可收起 | AI 对话窗口 |
| **Status Bar** | 底部 | 状态信息条 |
| **Command Palette** | 浮动 | 类 VS Code 命令面板 |
| **Web Preview** | 标签页 | 内嵌浏览器预览 |

### 3.3 圆角与间距

- 默认圆角：`--radius: 0.625rem` (10px)
- 派生圆角：sm(6px)、md(8px)、lg(10px)、xl(14px)、2xl(18px)、3xl(22px)、4xl(26px)
- Borderless 窗口模式：`border-radius: 12px` 应用到整个应用表面

---

## 四、字体选择

### 4.1 UI 字体

| 用途 | 字体 | 格式 |
|------|------|------|
| **Sans-serif UI** | **Inter Variable** | woff2-variations, 100-900 weight |
| **Monospace（终端）** | **JetBrains Mono** | woff2, 400 + 700 weight |
| **Monospace（编辑器）** | **JetBrains Mono** | 同上 |

### 4.2 官网字体

| 用途 | 字体 |
|------|------|
| **Sans-serif** | Inter (variable) |
| **Monospace** | Geist Mono (variable) |

### 4.3 字号

- 编辑器默认字号：`13px`（`--editor-font-size`）
- 应用整体缩放：`--app-zoom: 1`
- 缩放通过 CSS zoom 实现，`zoom-exempt` 类反向补偿

---

## 五、UI 组件风格

### 5.1 基础框架

Terax 使用 **shadcn/ui** 组件库 + **Tailwind CSS v4** 作为 UI 基础，所有组件风格与 shadcn/ui 默认风格一致：
- 扁平化设计
- 微妙的边框（rgba 半透明）
- focus ring 使用 `--ring` 变量
- 所有组件颜色由 CSS 变量驱动

### 5.2 窗口 Chrome

- 在 Linux/Windows 上使用 **borderless 窗口**（`data-chrome="borderless"`）
- 应用自绘 12px 圆角、1px 边框、阴影
- 背景设为 `transparent`，让 OS 窗口管理器处理阴影

### 5.3 终端组件

- **xterm.js** 渲染，自定义 CSS 变量管道注入配色
- 隐藏 xterm 原生滚动条（`display: none !important`）
- 终端选择色由 `--terminal-selection` 变量控制
- 终端光标色由 `--terminal-cursor` / `--terminal-cursor-accent` 控制
- **全局隐藏所有原生滚动条**，改用 shadcn `<ScrollArea>` 组件

### 5.4 编辑器

- CodeMirror 6 编辑器
- 独立的编辑器主题选择（与 UI 主题分离）
- 10 个编辑器主题：Atom One, Aura, Copilot, GitHub Dark/Light, Gruvbox Dark, Nord, Tokyo Night, Xcode Dark/Light

### 5.5 状态栏

- `src/modules/statusbar/` 独立模块
- 窄条状底栏，类似 VS Code

### 5.6 侧边栏

- 左侧活动栏（图标）+ 可展开面板
- 包含：文件浏览器、源代码控制、Git 历史

### 5.7 AI 面板

- 右侧可收起的对话面板
- 支持 Composer、Agent 模式
- 终端内也有 AI 编码代理

---

## 六、动画/过渡效果

### 6.1 动效时长令牌

| Token | 值 | 用途 |
|-------|-----|------|
| `--dur-fast` | `160ms` | 快速过渡（hover、focus） |
| `--dur-base` | `240ms` | 标准过渡 |
| `--dur-slow` | `320ms` | 慢速过渡（面板滑入） |

### 6.2 缓动函数

| Token | 值 | 风格 |
|-------|-----|------|
| `--ease-premium` | `cubic-bezier(0.16, 1, 0.3, 1)` | 弹性缓出（类似 spring） |
| `--ease-soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | 标准缓出 |

### 6.3 命名动画

| 类名 | 动画 | 时长 | 效果 |
|------|------|------|------|
| `terax-panel-in` | panel-in | 320ms | 从左侧 -40px 滑入 + 淡入 |
| `terax-tab-in` | tab-in | 240ms | 从 scale(0.86) 缩放入 + 淡入 |
| `terax-pill-in` | pill-in | 240ms | 从下方 2px 上浮 + 微缩放入 |
| `terax-collapsible` | collapsible-down/up | 240ms | 折叠面板开合 |
| `terax-reveal` | grid 0fr→1fr | 240ms | 内联内容揭示（grid 动画） |
| `terax-shimmer` | shimmer | 2s | 文本闪烁骨架屏循环 |

### 6.4 Grid 动画技巧

`terax-reveal` 类使用了精巧的 CSS Grid 动画：
```css
.terax-reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-premium),
              opacity var(--dur-base) var(--ease-premium);
  opacity: 0;
}
.terax-reveal[data-state="open"] {
  grid-template-rows: 1fr;
  opacity: 1;
}
```
这避免了 JS 测量高度的需要，纯 CSS 实现平滑的高度展开。

### 6.5 Reduced Motion 支持

当用户系统开启 `prefers-reduced-motion: reduce` 时：
- 所有动画时长设为 `0.01ms`
- `terax-reveal` transition 设为 `none`
- shimmer 动画停止

---

## 七、主题引擎架构

### 7.1 架构特点

Terax 有一个**自研主题引擎**（非 next-themes），核心设计：

1. **CSS 变量驱动**：`ThemeProvider` 将主题配置写入 `document.documentElement.style` 的 CSS 变量
2. **xterm.js 集成**：通过 `readTerminalTokens()` 读取 CSS 变量，构建 `ITheme` 对象传给 xterm
3. **主题与编辑器分离**：UI 主题和编辑器主题独立选择
4. **自定义主题**：用户可在应用内基于任一预设创建自定义主题，保存为 `terax-custom-themes.json`
5. **主题导出**：支持 JSON 格式导出/分享

### 7.2 主题文件结构

每个主题是一个 TypeScript 文件，导出 `Theme` 对象：
```typescript
export type Theme = {
  id: string;
  name: string;
  variants: {
    light?: ThemeVariant;  // UI 颜色 + 终端调色板
    dark?: ThemeVariant;
  };
  editorTheme?: {
    light?: string;  // 编辑器主题名称
    dark?: string;
  };
};
```

### 7.3 背景图片

支持自定义背景图片，两个滑块控制：
- **Opacity**：与背景的混合强度
- **Blur**：高斯模糊（仅作用于图片，不影响前景内容）
- 图片解码一次并缓存在 `bgImageStore.ts`

---

## 八、整体美学风格描述

### 8.1 风格定性

**Dark-First Minimalist IDE Aesthetic（暗色优先、极简 IDE 美学）**

- **极简克制**：没有多余的装饰，每个元素都有明确的目的
- **暗色为主**：深色背景 + 微妙的层级区分
- **玻璃质感**：borderless 窗口 + 半透明边框营造「玻璃」感
- **开发者工具美学**：继承 VS Code 的设计语言，终端优先
- **排版精致**：Inter Variable 提供清晰的无衬线排版，JetBrains Mono 提供专业的等宽终端体验
- **动效克制**：动画快而精准，不拖沓，不过度
- **无缝滚动**：全局隐藏原生滚动条，使用 shadcn ScrollArea 统一滚动体验

### 8.2 与竞品对比

| 特性 | Terax | VS Code | Warp | Cursor |
|------|-------|---------|------|--------|
| UI 框架 | shadcn/ui + Tailwind | 自研 | 自研 | VS Code fork |
| 终端引擎 | xterm.js | xterm.js | 自研 GPU | xterm.js |
| 主题系统 | CSS 变量 + 自研引擎 | JSON 主题 | 预设主题 | VS Code 主题 |
| 动画 | 自定义 Motion Tokens | 基本 | 丰富 | 基本 |
| 圆角 | 10-12px 大圆角 | 小圆角 | 中等 | 小圆角 |
| 滚动条 | 全局隐藏 | 原生 | 自定义 | 原生 |

---

## 九、TDSF 可借鉴的设计元素

### 9.1 ⭐⭐⭐ 强烈推荐借鉴

1. **CSS 变量驱动的主题引擎**
   - Terax 的 `ThemeProvider` + `applyTheme()` 模式非常简洁高效
   - TDSF 目前如果使用 dark mode，可以完全照搬这套 CSS 变量体系
   - 关键文件：`applyTheme.ts`、`types.ts`、`globals.css`

2. **终端配色通过 CSS 变量同步**
   - `readTerminalTokens()` 从 CSS 变量读取终端配色 → 构建 xterm ITheme
   - 保证 UI 主题和终端配色一致
   - 关键文件：`tokens.ts`、`terminalTheme.ts`

3. **Motion Tokens 体系**
   - `--dur-fast/base/slow` + `--ease-premium/soft` 的组合非常实用
   - 统一管理动画时长和缓动函数，配合 `prefers-reduced-motion` 支持
   - TDSF 可以直接复制这套体系

4. **全局隐藏原生滚动条**
   - 桌面应用中 Chrome/WebView 的滚动条在不同平台表现不一致
   - 统一用 ScrollArea 组件替代，体验更加一致

5. **terax-reveal Grid 动画**
   - 纯 CSS 实现高度展开/收起动画（`grid-template-rows: 0fr → 1fr`）
   - 零 JS 依赖，性能极好
   - 非常适合 AI 面板展开、命令输出折叠等场景

### 9.2 ⭐⭐ 推荐借鉴

6. **Borderless 自定义窗口 Chrome**
   - Tauri 桌面应用可以画自己的标题栏和圆角
   - Terax 的 12px border-radius + 1px border 方案很精致
   - 注意：TDSF 是 Electron，但同样支持 frameless 窗口

7. **字体选择**
   - Inter Variable 作为 UI 字体（清晰、现代、多字重）
   - JetBrains Mono 作为终端字体（开发者标准选择）
   - 两者都是开源免费字体，可直接使用

8. **主题与编辑器主题分离**
   - 允许用户分别选择 UI 外观和代码/终端的配色
   - 对于 TDSF 这样一个 SSH 终端 + 编辑器的工具很有价值

9. **配色方案的 shadcn 兼容性**
   - Terax 默认主题完全兼容 shadcn/ui 的 CSS 变量命名
   - TDSF 如果也使用 shadcn/ui，可以无缝复用

### 9.3 ⭐ 可选借鉴

10. **自定义主题 JSON 导出/导入**
    - 用户可创建、保存、分享主题
    - 作为高级功能后期加入

11. **背景图片 + 模糊 + 透明度**
    - 对于个性化需求较强的用户群体很友好
    - 实现简单（`backdrop-filter: blur()`）

12. **Shimmer 骨架屏动画**
    - CSS-only 的文本加载效果，比传统骨架屏更轻量
    - 适合 AI 流式输出的加载状态

---

## 十、技术实现要点

### 10.1 主题应用流程

```
ThemeProvider (React Context)
  └→ applyTheme(theme, mode)
       └→ 遍历 ALL_VARS，清除旧值
       └→ writeColors(root, colors) → root.style.setProperty(COLOR_VAR[k], v)
       └→ writeTerminal(root, terminal) → root.style.setProperty(ANSI_VARS[i], v)
            └→ xterm.js 调用 buildTerminalTheme()
                 └→ readTerminalTokens() → 创建临时 div 读取 CSS 变量
```

### 10.2 关键文件清单

| 文件 | 用途 |
|------|------|
| `src/styles/globals.css` | CSS 变量定义、动画、xterm 覆盖 |
| `src/styles/tokens.ts` | 终端令牌类型 + CSS 变量读取器 |
| `src/styles/terminalTheme.ts` | xterm ITheme 构建器 |
| `src/styles/fonts.css` | 字体 @font-face 声明 |
| `src/modules/theme/types.ts` | Theme 类型定义 |
| `src/modules/theme/applyTheme.ts` | 主题应用核心逻辑 |
| `src/modules/theme/ThemeProvider.tsx` | React Context Provider |
| `src/modules/theme/themes/*.ts` | 15 个内置主题定义 |

---

## 十一、总结

Terax 的设计哲学可以概括为：

> **"像终端一样快，像现代编辑器一样美"**

它没有试图重新发明 IDE 的 UI，而是在 VS Code 的成熟设计语言基础上做了减法：去掉臃肿的扩展系统、精简到只保留开发最核心的终端+编辑器+AI，同时在细节上做到了极致（统一隐藏滚动条、CSS 变量驱动主题、动效令牌体系、grid 动画技巧）。

对于 TDSF 来说，最值得学习的是：
1. **CSS 变量主题系统**的简洁架构
2. **终端与 UI 主题同步**的管道设计
3. **动效令牌 + reduced-motion** 的专业做法
4. **全局滚动条处理**的跨平台一致性方案
