# TDSF 终端 Agent v4.0 — P0 阶段开发报告

> 阶段: **P0 脚手架 / 样式系统验收**
> 日期: 2026-07-26
> 状态: **6/6 门禁全绿, 验收通过**
> 下一步: P1 终端模块集成 (portable-pty + xterm.js)

---

## 1. P0 阶段目标

建立 TDSF 终端 Agent v4.0 的最小可运行壳, 验证三件事:

1. **样式系统**: 15 主题 + 7 状态 Mood Ring + 5 档风险等级 + 4 档圆角 + 3 档阴影
2. **技术栈贯通**: Tauri 2 + React 19 + TypeScript 5 + Vite 6 + Tailwind v4 + Rust 1.96
3. **工程门禁**: 6 门禁全绿 (typecheck:node + typecheck:web + lint + test + build:web + cargo build)

---

## 2. 实施清单

### 2.1 目录结构

```
tdsf-terminal-agent/
├── README.md                        # 项目入口
├── package.json                     # pnpm + scripts
├── pnpm-workspace.yaml              # pnpm 11 配置
├── pnpm-lock.yaml                   # 锁文件
├── .npmrc                           # 镜像
├── tsconfig.json / .app.json / .node.json   # TS 三套配置
├── vite.config.ts                   # Vite + React 插件
├── vitest.config.ts                 # Vitest 独立配置
├── eslint.config.js                 # ESLint 9 flat config
├── index.html                       # WebView 入口
├── src/                             # React 前端
│   ├── main.tsx                     # 入口
│   ├── App.tsx                      # 根组件 (P0 验收版)
│   ├── vite-env.d.ts
│   ├── components/
│   │   ├── ThemePreview.tsx         # 样式系统验收页
│   │   └── ThemePreview.test.tsx    # 5 个测试
│   └── styles/
│       ├── index.css                # 入口 (汇集所有 CSS)
│       ├── tokens.css               # 15 主题 CSS 变量
│       ├── theme.css                # Tailwind v4 桥接
│       ├── fonts.css                # 字体声明
│       └── animations.css           # 7 状态 mood ring 动画
├── src-tauri/                       # Rust 后端
│   ├── Cargo.toml                   # 依赖配置
│   ├── build.rs                     # 编译期注入 rustc 版本
│   ├── tauri.conf.json              # Tauri 应用配置
│   ├── capabilities/
│   │   └── default.json             # IPC 权限
│   ├── icons/                       # 全套图标 (Tauri CLI 生成)
│   └── src/
│       ├── main.rs                  # 二进制入口
│       ├── lib.rs                   # Tauri Builder
│       ├── logging.rs               # env_logger 初始化
│       ├── state.rs                 # AppState (启动时间)
│       ├── commands.rs              # 3 个最小 IPC 命令
│       └── error.rs                 # ApiError 类型
├── specs/                           # 6 文件模块化方案书
├── design/                          # 4 文件简约设计稿
├── docs/                            # 辅助文档
└── reports/                         # 调研/阶段报告
```

### 2.2 关键文件说明

| 文件 | 作用 |
|------|------|
| `src/styles/tokens.css` | 15 主题 CSS 变量 (dark/light/dracula/...) |
| `src/styles/theme.css` | 桥接 Tailwind v4 `@theme` 块 |
| `src/styles/animations.css` | 7 状态 mood ring + 面板入场 + 光标 |
| `src/components/ThemePreview.tsx` | 样式系统验收页 (15 主题切换 / 7 mood / 5 风险) |
| `src-tauri/src/lib.rs` | Tauri Builder + 3 个 IPC 命令 |
| `src-tauri/build.rs` | 编译期注入 `RUSTC_VERSION` 环境变量 |

---

## 3. 6 门禁验证结果

| # | 门禁 | 命令 | 状态 | 备注 |
|---|------|------|------|------|
| 1 | typecheck:node | `tsc --noEmit -p tsconfig.node.json` | ✅ | 0 错误 |
| 2 | typecheck:web | `tsc -b --noEmit` | ✅ | 0 错误 |
| 3 | lint | `eslint . --max-warnings 0` | ✅ | 0 警告 |
| 4 | test | `vitest run` | ✅ | **5/5 通过** (ThemePreview) |
| 5 | build:web | `vite build` | ✅ | dist/ 生成 (CSS 25.18kB, JS 209.94kB, gzip 65.12kB) |
| 6 | cargo build | `cargo build` (debug) | ✅ | tdsf-terminal-agent.exe 18 MB |

**P0 阶段门禁全部通过**.

### 3.1 详细日志

#### 1-2. typecheck (node + web)

```
$ pnpm typecheck:node
$ tsc --noEmit -p tsconfig.node.json
(exit 0)

$ pnpm typecheck:web
$ tsc -b --noEmit
(exit 0)
```

#### 3. lint

```
$ pnpm lint
$ eslint . --max-warnings 0
(exit 0, 0 警告)
```

#### 4. test

```
$ pnpm test
$ vitest run

 ✓ src/components/ThemePreview.test.tsx (5 tests) 99ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  1.94s
```

#### 5. build:web

```
$ pnpm build:web
$ tsc -b && vite build
vite v6.4.3 building for production...
✓ 1575 modules transformed.
dist/index.html                   0.61 kB │ gzip:  0.40 kB
dist/assets/index-CrTjHGja.css   25.18 kB │ gzip:  5.72 kB
dist/assets/index-DCWmQL4P.js   209.94 kB │ gzip: 65.12 kB
✓ built in 2.08s
```

> 注: 字体文件未在 build 阶段解析, 仅运行时加载 (`public/fonts/*.woff2` 路径).
> 这是预期行为, 字体文件将在 P1 阶段下载到 `public/fonts/` 后消除警告.

#### 6. cargo build (Tauri 后端)

```
$ cd src-tauri && cargo build
   Compiling tdsf-terminal-agent v4.0.0 (.../src-tauri)
   Compiling tao v0.35.3
   Compiling webview2-com v0.38.2
   Compiling wry v0.55.1
   Compiling tauri-runtime v2.11.3
   Compiling tauri-runtime-wry v2.11.4
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 07s

可执行文件: src-tauri/target/debug/tdsf-terminal-agent.exe (18 MB)
```

---

## 4. 实施过程问题与修复

### 4.1 pnpm 11 依赖构建脚本白名单

**现象**: `pnpm install` 报 `[ERR_PNPM_IGNORED_BUILDS]`, esbuild / @tailwindcss/oxide 被拦截.

**根因**: pnpm v11 把 `onlyBuiltDependencies` 改名为 `allowBuilds` 且强制白名单.

**修复**: `pnpm-workspace.yaml` 配置:
```yaml
allowBuilds:
  esbuild: true
  '@tailwindcss/oxide': true
```

### 4.2 Tauri 协议特性缺失

**现象**: `cargo check` 报 "tauri dependency features do not match the allowlist".

**根因**: `tauri.conf.json` 启用了 `assetProtocol` (用于加载本地字体), 但 `tauri` 依赖未开 `protocol-asset` 特性.

**修复**: `Cargo.toml` 添加特性:
```toml
tauri = { version = "2.1", features = ["devtools", "protocol-asset"] }
```

### 4.3 缺少 Windows 图标

**现象**: cargo 报 `icons/icon.ico not found; required for generating a Windows Resource file`.

**修复**: 用 `pnpm exec tauri icon src-tauri/icons/32x32.png` 生成全套 (Windows / macOS / iOS / Android, 共 30+ 文件).

### 4.4 `env!` 宏语法错误

**现象**: `env!("RUSTC_VERSION", "unknown")` 编译失败.

**根因**: `env!` 宏只接受 1 个参数, 不支持 fallback. 应使用 `option_env!`.

**修复**:
1. `commands.rs` / `logging.rs` 改用 `option_env!("RUSTC_VERSION").unwrap_or("unknown")`
2. `build.rs` 通过 `cargo:rustc-env=RUSTC_VERSION=...` 注入编译期变量

### 4.5 main.rs inner attribute 位置错误

**现象**: `#![cfg_attr(...)]` 在 `/** */` 文档注释之后, 编译报 "not permitted following an outer doc comment".

**根因**: inner attribute (`#![...]`) 必须紧跟文件顶部, 不能在文档注释之后.

**修复**: 改用 `//` 行注释, 放在 inner attribute 之上.

---

## 5. 设计系统落地

### 5.1 主题色 (符合项目硬约束)

| 主题 | 主色 | 来源 |
|------|------|------|
| dark | `#818cf8` (Tailwind indigo-400) | 项目 06-design-tokens.md |
| light | `#4f46e5` (Tailwind indigo-600) | 项目 06-design-tokens.md |
| 其余 13 主题 | 各家经典色板 | 终端主色适配 |

> 注: 设计稿 (`tdsf-terminal-agent.design`) 主色 `#5B8CFF` 与项目硬约束 `#818cf8` 有偏差,
> 按项目硬约束优先 (低饱和靛蓝) 处理.

### 5.2 7 状态 Mood Ring

| 状态 | 动画 | 颜色 | 用途 |
|------|------|------|------|
| idle | 呼吸 (3s) | slate-400 | Agent 待命 |
| thinking | 紫罗兰三点波动 (1.4s) | violet-400 | LLM 思考 |
| stream | 青光标波动 (0.8s) | cyan-400 | 流式输出 |
| working | 琥珀旋转 (1s) | amber-500 | 工具执行 |
| waiting | 黄色脉冲环 (2s) | yellow-500 | 等待审批 |
| done | 翠绿闪烁 (300ms 一次性) | emerald-500 | 任务完成 |
| error | 红色摇晃 (500ms 一次性) | red-500 | 错误状态 |

### 5.3 5 档风险等级 (L0-L4)

| 等级 | 名称 | 颜色 | 行为 |
|------|------|------|------|
| L0 | Safe | emerald-500 | 静默执行 |
| L1 | Caution | blue-400 | 终端内执行 |
| L2 | Warning | amber-500 | 弹审批卡 |
| L3 | Danger | orange-500 | 必须确认 |
| L4 | Critical | red-500 | 二次密码 |

---

## 6. 已交付物清单

- [x] `src/` 完整 React 19 + TS 5 + Tailwind v4 前端
- [x] `src/styles/` 5 文件样式系统
- [x] `src/components/ThemePreview.tsx` 样式验收页
- [x] `src/components/ThemePreview.test.tsx` 5 个验收测试
- [x] `src-tauri/` 完整 Tauri 2 + Rust 后端
- [x] `src-tauri/src/{main,lib,logging,state,commands,error}.rs` 6 文件
- [x] `src-tauri/icons/` 30+ 图标 (全平台)
- [x] `specs/` 6 文件方案书 (从 v4.0 完整复用)
- [x] `design/` 4 文件设计稿
- [x] `reports/` 10+ 历史调研/方案书
- [x] 6 门禁全部通过
- [x] P0 阶段报告 (本文档)

---

## 7. P1 阶段准备

### 7.1 待办事项

- [ ] **P0-02 字体下载**: Inter Variable + Maple Mono NF + JetBrains Mono 到 `public/fonts/`
- [ ] **P1-01 终端核心**: 集成 xterm.js + portable-pty (Rust)
- [ ] **P1-02 终端 UI**: 终端主屏永真 PTY 原则
- [ ] **P1-03 ANSI 16 色**: xterm.js theme 适配 tokens.css
- [ ] **P1-04 字体回退**: Maple Mono NF → CN → JetBrains Mono 降级链
- [ ] **P1-05 终端交互**: 复制粘贴 / 选中 / 滚动 / 大小调整
- [ ] **P1-06 release 验证**: `pnpm tauri build` 完整流程 + 安装包

### 7.2 关键参考

- **方案书**: `specs/00-overview.md` / `01-feature-parity.md` / `02-architecture.md` / `03-ui-spec.md` / `04-api-contract.md` / `05-implementation-roadmap.md` / `06-design-tokens.md`
- **设计稿**: `design/README.md` / `mockup-expanded.md` / `mockup-collapsed.md` / `state-chain.md` / `DESIGN-PROMPT.md`
- **Token 映射**: `docs/STYLE-TOKENS-MAP.md`

---

## 8. 总结

P0 阶段严格遵循项目硬约束 (低饱和靛蓝主色 / CSS 变量驱动 / 不硬编码), 6 门禁全绿,
样式系统 100% 验收通过. 项目已具备进入 P1 阶段 (终端模块集成) 的所有前置条件.
