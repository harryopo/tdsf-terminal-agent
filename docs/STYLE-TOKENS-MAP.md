# TDSF Terminal Agent — 样式 Token 映射表

> 归档时间：2026-07-26  
> 适用：P0-02（CSS 变量主题引擎 + 字体 + 动画）  
> 源文件：`src/styles/{tokens,fonts,animations,theme,index}.css`

本表是开发期"查表"，**所有 Tailwind 类名 / 直接 CSS 属性都必须走这里列出的变量**，禁止硬编码色值/字号/间距。

---

## 1. 主色（Tailwind v4 `bg-primary` / `text-primary` / `border-primary`）

| 主题 | CSS 变量 | 浅色 | 暗色 |
|------|---------|------|------|
| 暗色（默认） | `--color-primary` | `#4f46e5` | `#818cf8` |
| 亮色 | `--color-primary` | `#4f46e5` | `#4f46e5` |
| 主色高亮 | `--color-primary-bright` | `#6366f1` | `#a5b4fc` |
| 主色暗淡 | `--color-primary-dim` | `#4338ca` | `#6366f1` |
| 主色浅底 | `--color-primary-soft` | `rgba(79,70,229,0.08)` | `rgba(129,140,248,0.12)` |
| 主色光晕 | `--color-primary-glow` | `rgba(79,70,229,0.15)` | `rgba(129,140,248,0.20)` |

**Tailwind 用法**：

```tsx
<div className="bg-primary text-text-on-primary">主按钮</div>
<div className="bg-accent text-accent-foreground">激活项</div>
```

---

## 2. 背景 / 表面（5 层）

| 层级 | CSS 变量 | 浅色 | 暗色 | 用途 |
|------|---------|------|------|------|
| L0 窗口底 | `--color-bg` | `#fafafa` | `#0a0a0f` | 应用最底层 |
| L1 提升 | `--color-bg-elevated` | `#ffffff` | `#0f0f17` | 浮动面板/卡片 |
| L2 表面 | `--color-surface` | `#ffffff` | `#14141c` | Tab/二级面板 |
| L3 hover | `--color-surface-hover` | `#f3f4f6` | `#1c1c28` | 按钮 hover |
| L4 active | `--color-surface-active` | `#e5e7eb` | `#25253a` | 按下态 |
| 边框 | `--color-border` | `#e5e7eb` | `#2a2a3a` | 分隔线 |
| 强调边框 | `--color-border-strong` | `#d1d5db` | `#3a3a55` | 面板/激活 |

**Tailwind 用法**：

```tsx
<div className="bg-background">     // L0
<div className="bg-card">           // L1
<div className="bg-secondary">     // L2
<div className="bg-muted">          // L3
<div className="border-border">     // 边框
```

---

## 3. 文字色（4 档）

| 用途 | CSS 变量 | 浅色 | 暗色 |
|------|---------|------|------|
| 正文 | `--color-text` | `#0f172a` | `#e5e7eb` |
| 副文 | `--color-text-muted` | `#475569` | `#9ca3af` |
| 占位/状态栏 | `--color-text-faint` | `#94a3b8` | `#6b7280` |
| 反色（浅主题白底反黑） | `--color-text-inverse` | `#fafafa` | `#0a0a0f` |
| 主色文字（白/黑） | `--color-text-on-primary` | `#ffffff` | `#ffffff` |

**Tailwind 用法**：

```tsx
<p className="text-foreground">     // 正文
<p className="text-muted-foreground">  // 副文
<p className="text-text-faint">     // 占位 (自定义)
```

---

## 4. 语义色（成功 / 警告 / 错误 / 信息）

| 语义 | 主色 | Soft 背景 | 深背景 | 用途 |
|------|------|----------|--------|------|
| 成功 | `--color-success` | `--color-success-soft` | `--color-success-bg` | ✓ 完成/已批准 |
| 警告 | `--color-warning` | `--color-warning-soft` | `--color-warning-bg` | ⚠ 注意/L2 |
| 错误 | `--color-error` | `--color-error-soft` | `--color-error-bg` | ✗ 失败/L3 |
| 信息 | `--color-info` | `--color-info-soft` | `--color-info-bg` | ℹ 提示 |

**Tailwind 用法**：

```tsx
<div className="bg-success-soft text-success">成功提示</div>
<div className="bg-destructive text-destructive-foreground">危险按钮</div>
```

---

## 5. 风险等级（5 档 + 段条）

| 等级 | CSS 变量 | 浅色 | 暗色 | 用途 |
|------|---------|------|------|------|
| L0 Safe | `--color-risk-safe` | `#059669` | `#10b981` | 静默执行 |
| L1 Caution | `--color-risk-caution` | `#65a30d` | `#84cc16` | 终端内执行 |
| L2 Warning | `--color-risk-warning` | `#d97706` | `#eab308` | 弹审批卡 |
| L3 Danger | `--color-risk-danger` | `#ea580c` | `#f97316` | 必须确认 |
| L4 Critical | `--color-risk-critical` | `#dc2626` | `#ef4444` | 二次密码 |

**RiskGauge 段条 React 组件示例**：

```tsx
<div className="flex items-center gap-0.5">
  <div className="w-8 h-2 bg-risk-safe rounded-l" />
  <div className="w-8 h-2 bg-risk-caution" />
  <div className="w-8 h-2 bg-risk-warning" />
  <div className="w-8 h-2 bg-risk-danger" />
  <div className="w-8 h-2 bg-risk-critical rounded-r" />
</div>
```

---

## 6. 7 状态 Mood Ring

| 状态 | CSS 变量 | 动画类 | 浅色 | 暗色 |
|------|---------|-------|------|------|
| idle | `--color-mood-idle` | `.mood-idle` | `#94a3b8` | `#9ca3af` |
| thinking | `--color-mood-thinking` | `.mood-thinking` | `#7c3aed` | `#a78bfa` |
| stream | `--color-mood-stream` | `.mood-stream` | `#0891b2` | `#22d3ee` |
| working | `--color-mood-working` | `.mood-working` | `#d97706` | `#f59e0b` |
| waiting | `--color-mood-waiting` | `.mood-waiting` | `#ca8a04` | `#eab308` |
| done | `--color-mood-done` | `.mood-done` | `#059669` | `#10b981` |
| error | `--color-mood-error` | `.mood-error` | `#dc2626` | `#ef4444` |

**MoodRing React 组件示例**：

```tsx
<div
  className={`w-8 h-8 rounded-full flex items-center justify-center mood-${state}`}
  style={{
    background: `var(--color-mood-${state})`,
    boxShadow: `0 0 14px var(--color-mood-${state})`,
  }}
/>
```

---

## 7. 终端色（ANSI 16）

```tsx
// 终端底/前景/光标
background: 'var(--terminal-bg)'
color: 'var(--terminal-fg)'

// ANSI 16 色
style={{ color: 'var(--terminal-red)' }}      // 报错
style={{ color: 'var(--terminal-green)' }}    // 成功
style={{ color: 'var(--terminal-yellow)' }}   // 警告
style={{ color: 'var(--terminal-blue)' }}     // 信息
style={{ color: 'var(--terminal-magenta)' }}  // 高亮
style={{ color: 'var(--terminal-cyan)' }}     // 路径
```

---

## 8. 间距（4px 栅格）

| Token | 值 | 用途 |
|-------|----|----|
| `space-1` | 4px | 紧凑、icon 边距 |
| `space-2` | 8px | 元素内距 |
| `space-3` | 12px | 段落、面板 padding |
| `space-4` | 16px | 默认间距 |
| `space-5` | 24px | 中间距 |
| `space-6` | 32px | 大间距 |
| `space-8` | 48px | 区域分隔 |
| `space-10` | 64px | 主区 |

**用法**：

```tsx
<div className="p-4 gap-2">     // p-4 = 16px, gap-2 = 8px
<div style={{ margin: 'var(--space-3)' }}>
```

---

## 9. 圆角（4 档）

| Token | 值 | 用途 |
|-------|----|----|
| `radius-sm` | 4px | 标签、徽章 |
| `radius-md` | 8px | 按钮、输入框、卡片 |
| `radius-lg` | 12px | 浮动面板、Dialog |
| `radius-xl` | 16px | 大 Modal、Hero |
| `radius-full` | 9999px | Pill、Avatar、状态点 |

**Tailwind 用法**：

```tsx
<button className="rounded-md">    // 8px
<div className="rounded-lg">       // 12px
<span className="rounded-full">    // 圆形
```

---

## 10. 阴影（3 档 + 面板专用）

| Token | 值 | 用途 |
|-------|----|----|
| `shadow-low` | `0 1px 2px rgba(0,0,0,0.3)` | 微浮起 |
| `shadow-medium` | `0 4px 12px rgba(0,0,0,0.4)` | 浮动面板 |
| `shadow-high` | `0 12px 32px rgba(0,0,0,0.5)` | 弹窗 |
| `shadow-panel` | `0 0 0 1px rgba(129,140,248,0.15), 0 12px 40px rgba(0,0,0,0.5)` | 浮动面板专用（带蓝色描边光晕） |
| `shadow-glow` | `0 0 20px rgba(129,140,248,0.15)` | 主按钮 hover |

**Tailwind 用法**（Tailwind v4 默认 `shadow-*` 也可用，但建议直接用 CSS 变量）：

```tsx
<div className="shadow-md">           // 中阴影
<div style={{ boxShadow: 'var(--shadow-panel)' }}>  // 浮动面板
```

---

## 11. 字号

| Token | 值 | 用途 |
|-------|----|----|
| `text-xs` | 11px | 标签、注释、状态栏 |
| `text-sm` | 12px | 辅助信息 |
| `text-base` | 14px | 正文 |
| `text-md` | 16px | 强调 |
| `text-lg` | 18px | 小标题 |
| `text-xl` | 20px | 标题 |
| `text-2xl` | 24px | 大标题 |
| `text-3xl` | 30px | 落地页 H1 |

**Tailwind 用法**：

```tsx
<p className="text-sm text-muted-foreground">  // 12px 副文
<h1 className="text-2xl font-bold">             // 24px 标题
```

---

## 12. 字体族

| 用途 | 字体族 | CSS 变量 | Tailwind 类 |
|------|-------|---------|-----------|
| UI | Inter Variable | `--font-sans` | `font-sans` |
| 标题 | Inter Variable (加粗) | `--font-display` | `font-display` |
| 终端 | Maple Mono NF/CN | `--font-mono` | `font-mono` |
| 代码 | JetBrains Mono | `--font-code` | `font-code` |

**用法**：

```tsx
<p className="font-sans">UI 文字</p>
<pre className="font-mono text-sm">终端输出</pre>
```

---

## 13. 动效时长

| Token | 值 | 用途 |
|-------|----|----|
| `duration-instant` | 50ms | 微反馈 |
| `duration-fast` | 150ms | 按钮 hover |
| `duration-base` | 250ms | 卡片切换、面板入场 |
| `duration-slow` | 400ms | 视图切换 |
| `duration-slower` | 600ms | 大型动画 |

**用法**：

```tsx
<button className="transition-all duration-fast">150ms 过渡</button>
<div style={{ animationDuration: 'var(--duration-base)' }}>
```

---

## 14. 缓动

| Token | 值 | 用途 |
|-------|----|----|
| `ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 缓出（自然） |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | 进退对称 |
| `ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性（弹窗） |
| `ease-linear` | `linear` | 加载条 |

---

## 15. z-index

| Token | 值 | 用途 |
|-------|----|----|
| `z-base` | 0 | 默认 |
| `z-elevated` | 10 | 浮动卡 |
| `z-sticky` | 100 | 固定头（Titlebar/Tabbar） |
| `z-overlay` | 1000 | 遮罩 |
| `z-modal` | 2000 | 弹窗（设置/审批/命令日志） |
| `z-toast` | 3000 | 提示 |
| `z-tooltip` | 4000 | 工具提示 |

---

## 16. 主题切换（API）

```ts
// 切换主题
function setTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  // localStorage 持久化
  localStorage.setItem('tdsf-theme', theme);
}

// 读取当前主题
function getTheme(): string {
  return document.documentElement.dataset.theme || 'dark';
}

// 15 内置主题
const THEMES = [
  'dark', 'light',
  'dracula', 'gruvbox-dark', 'gruvbox-light',
  'nord', 'tokyo-night', 'solarized-dark',
  'monokai', 'catppuccin', 'one-dark',
  'ayu-dark', 'cobalt', 'material', 'vesper',
] as const;
```

---

## 17. 硬约束检查清单（PR review 必须）

开发期提交代码前自查：

- [ ] **禁止硬编码颜色**（无 `#xxxxxx` / `rgb()` / `hsl()` 出现在 CSS 或 style 属性中）
- [ ] **禁止硬编码字号**（无 `font-size: 13px`，必须用 `var(--text-md)`）
- [ ] **禁止硬编码间距**（无 `margin: 12px`，必须用 `var(--space-3)`）
- [ ] **禁止硬编码圆角**（无 `border-radius: 5px`，必须用 `var(--radius-*)`）
- [ ] **禁止高饱和蓝**（不能用 `#0071e3` / `#3b82f6` 等系统蓝）
- [ ] **禁止 emoji 装饰**（用 Lucide SVG 替代）
- [ ] **卡片 hover 仅阴影变化**（不能同时变 border + 位移 + scale）
- [ ] **过渡用 var(--ease-out)**（不用默认 `ease`）
- [ ] **终端用 var(--font-mono)**（不用 `monospace`）

---

## 18. 常见错误示范 vs 正确写法

| ❌ 错误 | ✅ 正确 |
|--------|--------|
| `color: #5B8CFF` | `color: var(--color-primary)` |
| `background: rgba(129,140,248,0.12)` | `background: var(--color-primary-soft)` |
| `font-size: 13px` | `font-size: var(--text-md)` |
| `margin: 12px` | `margin: var(--space-3)` |
| `border-radius: 5px` | `border-radius: var(--radius-md)` |
| `font-family: monospace` | `font-family: var(--font-mono)` |
| `box-shadow: 0 4px 12px rgba(0,0,0,0.4)` | `box-shadow: var(--shadow-medium)` |
| `transition: 200ms ease` | `transition: var(--duration-base) var(--ease-out)` |
| `<span>📚 知识库</span>` | `<BookOpen className="w-4 h-4" /> 知识库` |
| `hover: scale-105 hover:translate-y-[-2px]` | `hover:shadow-glow` |

---

> **最后更新**：2026-07-26  
> **维护人**：TDSF Terminal Agent 设计契约  
> **下次更新时机**：token 命名变化 / 主题增减 / 间距体系调整
