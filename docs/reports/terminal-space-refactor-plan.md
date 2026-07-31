# TDSF Terminal Agent —— 终端 / Space / SSH 重构方案

> 文档状态：调研完成，方案待评审  
> 上游基线：`crynta/terax-ai` v0.8.6  
> 调研产物：
> - `opensource-reference/terax-ai/ANALYSIS-terminal-space-architecture.md`
> - `docs/reports/terminal-problem-analysis.md`

---

## 1. 当前 AI 对话进度识别（避免冲突）

- 当前仓库最新 commit：`9ede372 fix(ai/theme/translate): P1-P4 全面修复 AI 流式+深度思考+Skill 调用+主题浅色+翻译深浅色`
- `git status` 仅有未跟踪文件：`docs/竞赛/*`、竞赛脚本、以及一个 `scripts/cdp-trigger-ai.py`。
- 没有处于修改状态的 `.ts/.tsx/.rs` 源文件，因此**当前 AI 对话大概率正在做 AI/agent 侧的功能验证或文档整理**，尚未写入代码。
- 本方案涉及范围为 **终端 / Space / SSH / 资源管理器 / 状态栏**，与 AI/agent 模块（`src/modules/ai/*`、`src/components/ai-elements/*`、`src-tauri/sidecar/*`）基本解耦，可并行开发。

---

## 2. 用户反馈问题汇总

| # | 问题 | 优先级 |
|---|------|--------|
| 1 | 新建 terminal 默认就是本地 Windows 终端 | P0 |
| 2 | 左侧资源管理器不会随 `cd` 目录自动刷新 | P0 |
| 3 | SSH 连接后返回 shell 终端不显示 hostname | P1 |
| 4 | 退出 SSH 重连后终端仍显示本地桌面终端 | P1 |
| 5 | SSH 会话连接会弹出卡片（第四张照片） | P1 |
| 6 | 最左上层一栏显示地址 | P1 |
| 7 | "Main" 标签 / 入口 | P1 |
| 8 | 期望：创建 Space 时选择本地/SSH，在 Space 下新建多个终端，切换 Space 时资源管理器和底部目录同步切换 | P0 |

---

## 3. Terax 开源方案核心结论

### 3.1 Space 是第一级状态实体

Terax 将 **Space** 作为工作区第一级实体，Tab 归属于 Space：

```typescript
// terax-ai/src/modules/spaces/lib/store.ts
export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  env: WorkspaceEnv;      // local | wsl
  color?: number;
  createdAt: number;
  updatedAt: number;
};
```

- 每个 Space 独立保存 `space-state-<id>.json`（tabs + activeTabIndex）。
- `useSpaces` zustand store 管理创建、切换、删除、重命名、排序。
- `SpaceSwitcher` 组件以 Popover 形式展示所有 Space 及其 Tab 列表。

### 3.2 WorkspaceEnv 决定文件系统 / Shell 环境

```typescript
// terax-ai/src/modules/workspace/env.ts
export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string };
```

- FS 命令（`fs_read_dir` 等）统一接收 `workspace: currentWorkspaceEnv()`。
- PTY 启动时传入 `workspace`，`shell_init.rs` 根据环境构建启动命令。
- **SSH 可天然作为第三种 `WorkspaceEnv` 接入**，复用同一套 FS/PTY/Explorer 链路。

### 3.3 Tab 级 cwd 驱动左侧资源管理器

```typescript
// terax-ai/src/modules/tabs/lib/useWorkspaceCwd.ts
const explorerRoot = useMemo<string | null>(() => {
  if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
  if (lastTerminalCwd.current) return lastTerminalCwd.current;
  const anyTerm = tabs.find((t) => t.kind === "terminal" && t.cwd);
  if (anyTerm?.kind === "terminal" && anyTerm.cwd) return anyTerm.cwd;
  return home;
}, [activeTab, tabs, home]);
```

- 终端通过 **shell integration 输出 OSC 7** 上报 cwd。
- `useTabs.setLeafCwd(leafId, cwd)` 更新对应 leaf 的 cwd。
- `FileExplorer` 接收 `rootPath = explorerRoot`，`rootPath` 变化即自动刷新。

### 3.4 组件布局

```text
App.tsx
└── AppShell
    ├── Sidebar（Space 列表 + FileExplorer）
    ├── MainArea
    │   ├── TabBar
    │   ├── WorkspaceSurface（按 activeTab.kind 切换 TerminalStack/EditorStack/...）
    │   └── StatusBar（CwdBreadcrumb + WorkspaceEnvSelector）
```

---

## 4. 当前 TDSF 问题根因（来自 `docs/reports/terminal-problem-analysis.md`）

1. **缺少 Space 层**：`Space` 只是 UI 概念，没有持久化 ID，Tab 直接携带 `sshSessionId`，导致本地/SSH 混用。
2. **`explorerPath` 全局单值**：无法按 Space/Tab/SSH Session 隔离，切换 Tab 不会自动刷新资源管理器。
3. **SSH 绑定逻辑隐式且易错**：`App.tsx` 通过 `sshStore.subscribe` 把新连接“抢绑”到当前 active terminal tab，目标不可控。
4. **SSH 终端未注入 shell integration**：无法捕获远端 cwd。
5. **UI 残留**：左下角 SSH 卡片、左上角地址栏、`Main` 标签属于旧 TDSF 占位 UI。

---

## 5. 重构方案设计

### 5.1 总体思路

**把 SSH 从“特殊 Tab 属性”提升为“Space 环境”**，完全对齐 Terax 的 `WorkspaceEnv` 模型：

```typescript
export type WorkspaceEnv =
  | { kind: "local"; cwd?: string }
  | { kind: "wsl"; distro: string }
  | { kind: "ssh"; host: string; user: string; port: number; label: string; sessionId?: string };
```

- 创建 Space 时选择 **本地工作区** 或 **SSH 连接服务器**。
- 每个 Space 持有唯一 `WorkspaceEnv`。
- 在该 Space 下新建的 Terminal Tab，自动使用该 Space 的 env。
- 本地 Space 的 Terminal = 本地 PTY；SSH Space 的 Terminal = 远端 shell（通过 `russh` PTY channel）。
- 切换 Space 时，左侧 Explorer 与底部 CwdBreadcrumb 跟随当前 active Tab 的 cwd 变化。

### 5.2 Space 数据模型（最小可行）

新增 `src/modules/spaces/types.ts`：

```typescript
export interface Space {
  id: string;
  name: string;
  env: WorkspaceEnv;
  root: string | null;       // 本地/SSH 初始目录
  color?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceState {
  tabs: SerializedTab[];
  activeTabIndex: number;
}
```

扩展 `TerminalTab`：

```typescript
export type TerminalTab = TabBase & {
  id: number;
  kind: "terminal";
  spaceId: string;           // 归属 Space
  cwd?: string;
  // 删除 sshSessionId，改由 Space.env 决定
};
```

### 5.3 前端状态管理

引入 `useSpaces` zustand store（参考 Terax）：

```typescript
// src/modules/spaces/useSpaces.ts
export const useSpaces = create<SpacesState>((set, get) => ({
  spaces: [],
  activeId: null,
  hydrated: false,

  create: (input) => {
    const space: Space = { id: crypto.randomUUID(), ...input };
    set((s) => ({ spaces: [...s.spaces, space], activeId: space.id }));
    // 持久化 spaces.json
  },
  remove: (id) => { /* 清理 space-state-<id>.json */ },
  setActive: (id) => set({ activeId: id }),
  rename: (id, name) => { /* ... */ },
}));
```

`useTabs` 改造：
- Tab 新增 `spaceId`。
- `addTab` 必须传入 `spaceId`。
- `setLeafCwd` 保留，通过 `leafId` 更新对应 Tab 的 cwd。
- 删除 `sshSessionId` 相关逻辑。

### 5.4 Rust 后端：WorkspaceEnv 增加 SSH 变体

```rust
// src-tauri/src/modules/workspace.rs
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum WorkspaceEnv {
    Local,
    Wsl { distro: String },
    Ssh { host: String, user: String, port: u16, session_id: Option<String> },
}
```

改造点：
- `user_spawn_cwd_or_home`：根据 `WorkspaceEnv::Ssh` 返回远端初始目录（如 `/home/user`）。
- `path_authorize`：对 SSH env 不再做本地路径授权，而是校验 SFTP 可访问性。
- FS 命令（`fs_read_dir` / `fs_read_file` / `fs_write_file` / `fs_tree`）：按 `WorkspaceEnv` 路由到本地 `std::fs` 或远程 SFTP。

### 5.5 SSH PTY 生命周期改造

当前：`sshStore` 管理会话，前端订阅数据。  
目标：**Space 持有 session，TerminalPane 按 Space.env 决定使用本地 PTY 还是 SSH PTY。**

方案 A（推荐，改动较小）：
- 保留现有 `russh` 异步 SSH client/session 模块。
- 在 `pty_open` 命令中接收 `workspace: WorkspaceEnv`。
- 若 `WorkspaceEnv::Ssh`，调用 `SshSession::open_pty()` 打开远端 PTY channel，将 channel 输入/输出桥接到前端数据通道。
- 若 `WorkspaceEnv::Local`，保持现有 `portable-pty` 路径。

方案 B（MVP，复用本地 PTY）：
- 本地 PTY 中 spawn `ssh user@host` 子进程。
- 优点：复用 renderer pool / OSC 7 链路。
- 缺点：无法统一 FS 路由，Explorer 与终端目录难同步。

**本方案采用方案 A**，因为它能让 `fs_read_dir` 等命令统一按 `WorkspaceEnv` 路由到 SFTP，实现 Terax 式的目录联动。

### 5.6 cwd → Explorer 联动

1. **本地终端**：继续通过 shell integration + OSC 7 上报 cwd（Terax 同款机制）。
2. **SSH 终端**：在远端 shell 启动时注入同款 integration 脚本（bash/zsh），输出 OSC 7；前端解析后调用 `setLeafCwd`。
3. **Explorer Root 计算**：
   ```typescript
   const explorerRoot = useMemo(() => {
     const activeTab = tabs.find((t) => t.id === activeId);
     if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
     const anyTerm = tabs.find((t) => t.kind === "terminal" && t.cwd);
     if (anyTerm?.cwd) return anyTerm.cwd;
     return home;
   }, [activeId, tabs, home]);
   ```
4. **StatusBar CwdBreadcrumb**：同样接收 `explorerRoot`，显示当前目录；对 SSH Space 在首段显示 `user@host` 标识。

### 5.7 清理占位 UI

| 元素 | 操作 | 涉及文件 |
|------|------|----------|
| SSH 连接后左下角浮动卡片 | 删除 | `src/modules/ssh-explorer/SshExplorer.tsx` |
| 最左上层地址栏 | 删除 | `src/modules/header/Header.tsx` 或 `src/components/Titlebar.tsx` |
| "Main" 标签/入口 | 删除 | `src/app/App.tsx` 或 Tab 创建逻辑 |
| TDSF 主题 | 删除（已有计划） | `src/modules/theme/*` |

---

## 6. 实施阶段

### 阶段 0：清理占位 UI（P1，1 天）

- 删除 SSH 连接成功后的浮动卡片。
- 删除左上角地址栏。
- 删除 "Main" 入口。
- 通过五绿门禁 + CDP 9222 验证 UI 变化。

### 阶段 1：引入最小 Space 模型（P0，2-3 天）

- 新增 `src/modules/spaces/types.ts`、`useSpaces.ts`、`SpaceSwitcher.tsx`。
- 扩展 `TerminalTab` 加 `spaceId`。
- `useTabs.addTab` 改为必须传入 `spaceId`。
- App.tsx 中初始化 Space（默认一个 Local Space）。
- 持久化：`spaces.json` + `space-state-<id>.json`（可先用内存实现，后续补持久化）。

### 阶段 2：WorkspaceEnv 扩展为 SSH（P0，3-4 天）

- Rust：`WorkspaceEnv` 增加 `Ssh` 变体；FS 命令按 env 路由到本地或 SFTP。
- 前端：`WorkspaceEnvSelector` 增加 SSH 连接管理入口。
- SSH 连接弹窗改为“创建 SSH Space”向导。
- 将现有 `sshStore` 会话迁移为 Space 的 env session。

### 阶段 3：统一 Terminal/SSH 生命周期（P0，3-4 天）

- `TerminalPane` 根据 `space.env.kind` 决定调用 `pty_open`（本地）还是 `ssh_open_pty`（远程）。
- 删除 `App.tsx` 中的“抢绑”逻辑。
- SSH 断开/重连只更新 Space.env.sessionId，Tab 不解绑。
- 修复重连后旧 buffer 残留。

### 阶段 4：cwd → Explorer 联动（P0，2-3 天）

- 本地和 SSH 终端都注入 shell integration 脚本，输出 OSC 7。
- 前端 `setLeafCwd` → `useWorkspaceCwd` → `FileExplorer` / `CwdBreadcrumb`。
- 验证 cd 切换后 Explorer 自动刷新。

### 阶段 5：验收与回归（2 天）

- 五绿门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build:web`。
- 桌面实测：`pnpm tauri:dev`，验证窗口可见、Space 切换、本地/SSH 终端、多终端、目录联动。
- CDP 9222 截图验证清理后的 UI。

---

## 7. 关键文件改动清单

### 前端

| 文件 | 改动 |
|------|------|
| `src/modules/spaces/*` | 新增 Space 模型、store、UI |
| `src/modules/tabs/lib/useTabs.ts` | 加 `spaceId`，删 `sshSessionId` |
| `src/modules/tabs/lib/useWorkspaceCwd.ts` | 新增（参考 Terax） |
| `src/modules/workspace/env.ts` | 扩展 `WorkspaceEnv` |
| `src/modules/statusbar/WorkspaceEnvSelector.tsx` | 增加 SSH 入口 |
| `src/modules/statusbar/CwdBreadcrumb.tsx` | 显示 SSH 主机标识 |
| `src/modules/terminal/TerminalPane.tsx` | 根据 env 选择 PTY/SSH PTY |
| `src/modules/terminal/lib/osc-handlers.ts` | 复用 Terax OSC 7 处理 |
| `src/modules/explorer/FileExplorer.tsx` | 接收 `rootPath` |
| `src/app/App.tsx` | 初始化 Space、删除抢绑逻辑 |
| `src/app/components/WorkspaceSurface.tsx` | Space 感知的渲染 |
| `src/modules/ssh-explorer/*` | 改为 Space/Explorer 远程模式 |
| `src/modules/header/Header.tsx` | 删除地址栏 |
| `src/components/Titlebar.tsx` | 删除 Main 入口 |

### Rust 后端

| 文件 | 改动 |
|------|------|
| `src-tauri/src/modules/workspace.rs` | `WorkspaceEnv` 加 `Ssh`；路径解析路由 |
| `src-tauri/src/modules/pty/mod.rs` | `pty_open` 接收 workspace |
| `src-tauri/src/modules/pty/session.rs` | 支持 SSH PTY channel |
| `src-tauri/src/modules/pty/shell_init.rs` | 为 SSH env 构建远端 shell 命令 |
| `src-tauri/src/modules/fs/*.rs` | 按 workspace 路由本地/SFTP |
| `src-tauri/src/modules/ssh/*.rs` | session 管理对接 WorkspaceEnv |
| `src-tauri/src/commands.rs` | 注册新命令 |

---

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 重构范围大，与当前 AI agent 改动冲突 | 高 | 本方案不涉及 AI/agent 文件；阶段 0-1 先做低风险清理和模型引入 |
| Space 持久化实现复杂 | 中 | 阶段 1 先内存实现，阶段 2-3 稳定后再补持久化 |
| SSH PTY 与本地 PTY 行为不一致 | 中 | 复用现有 `russh` session；统一数据通道格式 |
| 远端 shell integration 注入失败 | 中 | 提供 fallback：通过 SFTP 探测 `pwd` 或在命令执行后主动查询 |
| 旧 `sshStore` 状态迁移 | 低 | 新 Space 创建时从 `sshStore` 导入已有连接 |

---

## 9. 验收标准

- [ ] 新建 Space 时可选择“本地工作区”或“SSH 服务器”。
- [ ] 在 SSH Space 下新建 Terminal 自动连接服务器 shell。
- [ ] 一个 Space 下可新建多个 Terminal Tab。
- [ ] 切换 Space 时，左侧资源管理器 root 目录同步切换。
- [ ] 终端中 `cd` 后，资源管理器自动刷新到对应目录（本地 + SSH）。
- [ ] SSH 断开后重连，当前 Terminal Tab 仍保持为服务器 shell，不回到本地桌面终端。
- [ ] 左下角 SSH 卡片、左上角地址栏、"Main" 入口已删除。
- [ ] 五绿门禁全过 + `pnpm tauri:dev` 桌面实测通过。

---

## 10. 下一步建议

1. 请用户确认本方案总体方向（特别是“SSH 作为 Space 的 WorkspaceEnv”这一核心设计）。
2. 若同意，优先执行 **阶段 0（清理占位 UI）**，可快速看到界面变化。
3. 阶段 1-4 按顺序推进，每阶段单独 commit 并通过五绿门禁。
