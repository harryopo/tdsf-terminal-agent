# TDSF Terminal Agent 终端模块现状与问题根因分析报告

> 报告日期：2026-07-31  
> 分析对象：`d:\ai\linux教学一体\tdsf-terminal-agent-clone` 终端、SSH、资源管理器、状态栏相关源码  
> 上游基线：`crynta/terax-ai` v0.8.6（Tauri 2 + React 19 + Python sidecar）

---

## 1. 摘要

本报告基于对项目核心源码的完整阅读，系统梳理了当前 **Space / Tab / Terminal** 三层状态模型、本地终端与 SSH 终端的创建流程、文件资源管理器的数据来源、以及状态栏/地址栏的渲染链路。针对用户反馈的 8 项问题，逐项给出根因定位，并提出最小化、可落地的重构建议。

**核心结论**：

- 当前状态模型是 **“Tab 中心”** 而非 **“Space 中心”**：`Space` 概念在前端状态里基本缺位，Tab 直接承载 `kind`、`cwd`、`sshSessionId` 等全部运行时信息。
- SSH 与本地终端在 UI 层被**硬分叉**：本地终端走 `TerminalStack` + `TerminalPane` + PTY；SSH 终端走 `SshTerminalHost` + `sshStore` 订阅。两者生命周期、标题、目录状态未统一。
- 文件资源管理器**未与终端当前工作目录（cwd）联动**：Terax 原生通过 shell integration 将 `cwd` 推送到前端并驱动 explorer path，TDSF 魔改后该链路断裂或仅局部生效。
- 大量 UI 元素（SSH 连接卡片、左上角地址栏、Main 标签）属于 TDSF 旧版残留或上游未使用的实验性代码，需要清理。

---

## 2. Space / Tab / Terminal 现状状态模型

### 2.1 缺失的 Space 层

在 `src/store/runtime.tsx` 与 `src/modules/tabs/lib/useTabs.ts` 中，**不存在独立的 Space 实体**。前端状态以 `Tab` 为原子：

```typescript
// src/modules/tabs/lib/useTabs.ts
export type TerminalTab = TabBase & {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;                 // 当前工作目录
  paneTree: PaneNode;           // 分屏树
  activeLeafId: number;
  blocks?: boolean;
  private?: boolean;
  customTitle?: string;
  /**
   * TDSF 魔改 2026-07-30: 绑定到 SSH 会话的前端 UUID。
   */
  sshSessionId?: string | null;
};
```

`Space` 仅作为 `sidebarView` 或“左侧切换按钮”存在，没有持久化 ID、没有独立状态、不能与 Tab 形成一对多关系。因此用户期望的“**一个 Space 下多个终端，切换 Space 同步目录**”当前无法表达。

### 2.2 Tab 状态机的实际形态

| 维度 | 现状 | 问题 |
|------|------|------|
| 类型 | `kind: "terminal" \| "editor" \| ...` | 终端与其他工作区并列，没有 Space 分组 |
| 本地/SSH 区分 | `sshSessionId` 字段 | 用 `null/undefined` 表示本地，耦合过深 |
| cwd | `tab.cwd` | 由 `shell-integration` 推送，但仅在本地 PTY 生效 |
| 标题 | `title` + `customTitle` | SSH 连接后强制覆盖 `customTitle`，没有 Hostname 模板 |
| 激活 | `activeId` | 切 Tab 时只切换 UI，不触发 Space 级目录同步 |

### 2.3 运行时全局状态

```typescript
// src/store/runtime.tsx（节选）
interface RuntimeState {
  sshSessions: SshSessionItem[];          // SSH 会话 9 状态机
  activeSshFrontendKey: string | null;    // 当前激活的 SSH 会话
  explorerPath: string;                   // 文件资源管理器当前路径
  openFiles: OpenFileItem[];
  activeFilepath: string | null;
}
```

`explorerPath` 是**全局单值**，无法按 Space / Tab / SSH Session 隔离。当用户在不同 Tab 间切换时，左侧资源管理器不会自动跟随 `tab.cwd` 变化，这就是问题 2 的根因之一。

---

## 3. 本地终端与 SSH 终端创建流程

### 3.1 本地终端创建流程

```text
用户点击 "+" 或快捷键
  └─ useTabs.addTab({ kind: "terminal" })      // 默认无 sshSessionId
        └─ App.tsx 渲染 WorkspaceSurface
              └─ TerminalStack
                    └─ TerminalPane
                          └─ useEffect 初始化 xterm + PTY
                                ├─ openPty(cols, rows, { onData, onExit })   // src/lib/pty-bridge.ts
                                │     └─ invoke("pty_open", ...)
                                │           └─ src-tauri/src/modules/pty/mod.rs
                                │                 └─ session::spawn(...)      // portable-pty
                                ├─ 加载 shell integration
                                │     └─ getShellIntegrationCommand('bash')  // 默认写死 bash
                                └─ CommandTrackerAddon 监听 CWD / 命令执行
```

关键代码：

```typescript
// src/components/Terminal.tsx（节选）
setTimeout(() => {
  const shellType = 'bash'; // Default for Windows
  const cmd = getShellIntegrationCommand(shellType);
  pty.write(cmd).catch((e) =>
    console.warn('[Terminal] shell integration inject failed', e)
  );
}, 300);
```

**根因 1**：本地终端创建时**没有 Space / 工作区选择**，`kind: "terminal"` 的默认分支就是本地 PTY，所以“新建 terminal 默认就是本地 Windows 终端”。

### 3.2 SSH 终端创建流程

```text
用户打开 SSH Explorer → 点击连接
  └─ sshStore.createSession(params)              // state = connecting
        └─ SshTerminalHost / SshTerminalPane 挂载
              └─ openTransport = 订阅 sshStore terminalData
                    └─ sshConnect(...)           // src/lib/ssh-bridge.ts
                          └─ invoke("ssh_connect", ...)
                                └─ src-tauri/src/modules/ssh/mod.rs
                                      ├─ client.rs: SshClient::connect()
                                      ├─ handler.rs: TOFU 主机验证
                                      └─ session.rs: SshSession::open_pty()
```

SSH 会话本身由 `sshStore` 管理，而 Tab 绑定通过 App.tsx 中的 subscribe 完成：

```typescript
// src/app/App.tsx（节选）
const connectedSessions = state.sessions.filter(
  (s) => s.state === "connected" && s.handle !== null,
);
for (const session of connectedSessions) {
  if (boundSshSessionsRef.current.has(session.id)) continue;
  boundSshSessionsRef.current.add(session.id);

  // 绑定当前 active terminal tab
  let targetTab = currentTabs.find(
    (t) =>
      t.id === currentActiveId &&
      t.kind === "terminal" &&
      (!t.sshSessionId || t.sshSessionId === session.id),
  );
  if (targetTab) {
    const sshHostLabel = `${session.params.user}@${session.params.host}`;
    updateTab(targetTab.id, {
      sshSessionId: session.id,
      customTitle: sshHostLabel,
      cwd: remoteCwd,
    });
  }
}
```

**该绑定逻辑存在以下问题**：

1. **绑定目标不可控**：总是优先找“当前 active 的本地 terminal tab”，如果用户当前在 editor 页，会 fallback 到任意本地 terminal tab。这意味着 SSH 连接可能“抢”错 Tab。
2. **目录不同步**：`remoteCwd` 取自 `currentPathBySession[session.id] ?? "/"`，但 `currentPathBySession` 的更新依赖远端 `pwd` 命令或 SFTP 操作，并非实时。
3. **标题只写一次**：SSH 连接成功后把 `customTitle` 设为 `user@host`，但用户后续 `cd` 或切换目录不会更新标题，因此“返回 shell 终端不显示 hostname”。

### 3.3 SSH 断开后重连仍显示本地桌面的根因

```typescript
// src/app/App.tsx（节选）
const disconnectedSessions = state.sessions.filter(
  (s) => s.state === "closed" || s.state === "failed",
);
for (const sessionId of Array.from(boundSshSessionsRef.current)) {
  if (!disconnectedIds.has(sessionId)) continue;
  boundSshSessionsRef.current.delete(sessionId);
  for (const tab of currentTabs) {
    if (tab.kind === "terminal" && tab.sshSessionId === sessionId) {
      updateTab(tab.id, {
        sshSessionId: null,
        customTitle: "",
      });
    }
  }
}
```

断开时把 `sshSessionId` 置为 `null`，Tab 退化为本地终端。如果用户再次连接，新 session 的 `id` 已变化，但 App.tsx 的绑定逻辑**只处理 newly connected 的 session**，当用户复用同一个 Tab 重连时，新 session 会被绑定到该 Tab；然而：

- 若 Tab 之前已被解绑且未重新聚焦，fallback 逻辑可能找不到它；
- `WorkspaceSurface` 中 `showSshTerminal = !!sshSessionId && isTerminalTab`，一旦 `sshSessionId` 存在就渲染 `SshTerminalHost`，但 `SshTerminalHost` 内部的 `leafId` 是 `useRef` 持久化的，旧 leaf 的 xterm buffer 可能残留；
- 更致命的是，如果重连速度较慢，`sshStore.subscribeTerminalData` 会先 flush pending buffer，里面可能包含上一次连接的旧数据，导致“仍显示本地桌面终端”的错觉。

---

## 4. 文件资源管理器实现现状

### 4.1 本地文件树

本地文件树通过 `src/modules/explorer/` 实现，核心 hook 为 `useFileTree.ts`。数据源为 Rust `fs` 命令：`fs_read_dir`、`fs_tree` 等。

### 4.2 远程文件树

远程文件树通过 `src/modules/explorer/lib/useRemoteFileTree.ts` + `src/lib/sftp-bridge.ts` 实现，调用 Rust `sftpList`、`sftpRead`、`sftpWrite` 等命令。

### 4.3 目录同步链路断裂点

Terax 原生的设计是：

```text
shell integration 解析 PS1/OSC 7
  └─ onCwdChanged(cwd)
        └─ 更新 tab.cwd
              └─ 如果 tab 是 active，更新 explorerPath
                    └─ 资源管理器刷新到 cwd
```

TDSF 魔改后的现状：

1. **本地终端**：`Terminal.tsx` 中 `cmdTracker.onCwdChanged(onCwdChanged)` 被保留，但 `onCwdChanged` 是否真正驱动 `explorerPath` 更新需要 App.tsx 中处理。
2. **SSH 终端**：`SshTerminalHost` 使用 `TerminalPane` 渲染，但 `TerminalPane` 的 `onCwd` 回调在 SSH 场景下**未接入 shell integration**（远端 shell 通常没有注入 TDSF 的 integration 脚本），因此无法拿到远端 cwd。
3. **explorerPath 是全局单值**：即使本地 cwd 更新了，SSH 切回本地时，explorer 无法记住 SSH 所在目录，反之亦然。

**问题 2 根因**：没有“Tab 级 cwd → explorerPath”的同步机制，SSH 侧甚至无法获得 cwd。

---

## 5. 状态栏 / 地址栏实现现状

### 5.1 状态栏

`src/components/StatusBar.tsx` 显示当前目录、SSH 连接状态、分支等信息。数据来自：

- `tab.cwd`（本地）
- `sshStore.currentPathBySession[sessionId]`（远程）
- `sshStore` 中 session 的 state

### 5.2 地址栏

左上角地址栏（问题 6）来自 Header 组件，显示当前路径或主机信息。根据用户反馈和项目记忆，该地址栏属于 TDSF 早期自定义 UI，与 Terax 的顶部标题栏设计冲突，且占用空间。

### 5.3 “Main” 标签

`Main` 标签（问题 7）是早期 TDSF 设计的入口标签，当前已并入 `Ctrl+I` AI 对话入口，属于可清理的死 UI。

---

## 6. 用户反馈问题根因分析

### 6.1 新建 terminal 默认就是本地 Windows 终端

**根因**：`useTabs.addTab` 的默认分支未提供“工作区类型”选择，直接创建 `kind: "terminal"` 且无 `sshSessionId` 的 Tab；`TerminalPane` 随后挂载本地 PTY。

**相关代码**：`src/modules/tabs/lib/useTabs.ts` 中 `addTab` 默认构造；`src/components/Terminal.tsx` 中 `openPty` 调用。

### 6.2 左侧资源管理器不会随 cd 目录自动刷新

**根因**：

1. `explorerPath` 是全局状态，未按 Tab/Space 隔离；
2. SSH 终端没有注入 shell integration，无法捕获远端 cwd；
3. `App.tsx` 未将 `tab.cwd` 变化实时同步到 `explorerPath`。

**相关代码**：`src/store/runtime.tsx`、`src/app/App.tsx` 的 cwd 监听、`src/modules/ssh-explorer/SshTerminalHost.tsx` 的回调配置。

### 6.3 SSH 连接后返回 shell 终端不显示 hostname

**根因**：

1. SSH 连接成功后，App.tsx 将 Tab 的 `customTitle` 设为 `user@host`，但只是**一次性设置**；
2. 返回本地 shell 终端时，`customTitle` 被清空，而本地终端的标题逻辑未保留 hostname 信息；
3. 状态栏/标题栏没有“当前连接主机”的独立显示字段。

**相关代码**：`src/app/App.tsx` 中 SSH 绑定逻辑；`src/modules/tabs/lib/useTabs.ts` 中 `customTitle` 处理。

### 6.4 退出 SSH 重连后终端仍显示本地桌面终端

**根因**：

1. 断开 SSH 时 `sshSessionId` 被置 `null`，Tab 退化为本地终端；
2. 重连时新 session id 不同，绑定逻辑可能因当前 active tab 类型而选错目标；
3. `SshTerminalHost` 的 `leafId` 是持久 ref，xterm 实例复用池可能残留旧 buffer；
4. `sshStore` 的 pending buffer 在 subscribe 时 flush，可能混入旧数据。

**相关代码**：`src/app/App.tsx` 断开处理；`src/modules/ssh-explorer/SshTerminalHost.tsx`；`src/modules/ssh-explorer/sshStore.ts` 中 `subscribeTerminalData`。

### 6.5 SSH 会话连接会弹出卡片

**根因**：`src/modules/ssh-explorer/SshExplorer.tsx` 或相关组件在 SSH 连接成功后渲染了一个连接状态浮层/卡片。根据用户偏好，SSH 连接后不应再显示左下角状态卡片。

**相关代码**：`src/modules/ssh-explorer/SshExplorer.tsx` 中的连接成功 UI。

### 6.6 最左上层一栏显示地址要删除

**根因**：Header 组件中保留了早期 TDSF 的地址栏/面包屑 UI，与 Terax 的极简标题栏冲突。

**相关代码**：`src/modules/header/Header.tsx`。

### 6.7 “Main” 要删除

**根因**：Tab 栏或侧边栏保留了 `Main` 标签，当前已计划将 AI 入口统一为 `Ctrl+I`。

**相关代码**：Tab 创建逻辑或 Header 中的导航标签。

### 6.8 期望的 Space 架构

**根因**：当前状态模型没有 Space 层，导致：

- 无法为 Space 选择“本地工作区 / SSH 服务器”；
- 无法在 Space 下创建多个终端；
- 切换 Space 时无法联动左侧资源管理器和底部目录。

---

## 7. 重构建议

### 7.1 引入 Space 数据模型（最小改造）

在不彻底推翻现有 Tab 状态的前提下，增加轻量 Space 层：

```typescript
// 建议新增：src/modules/spaces/types.ts
interface Space {
  id: string;
  name: string;
  type: 'local' | 'ssh';
  // local
  cwd?: string;
  // ssh
  sshSessionId?: string | null;
  sshParams?: SshConnectParams;
}

interface TerminalTab {
  // ...现有字段
  spaceId: string;   // 归属 Space
}
```

前端状态优先放在 `useTabs` / `runtime` 中，避免新建 zustand store。持久化可后续再做。

### 7.2 新建终端时增加 Space 选择入口

将“新建终端”改为两步：

1. 选择/创建 Space（本地 / SSH）；
2. 在该 Space 下新建终端 Tab。

如果 Space 类型为 SSH，则新 Tab 的 `sshSessionId` 直接指向该 Space 的 session，避免 App.tsx 里“抢 Tab”的模糊绑定。

### 7.3 统一 cwd → explorerPath 同步

```typescript
// 建议：在 App.tsx 或 WorkspaceSurface 中监听 activeTab
useEffect(() => {
  const activeTab = tabs.find((t) => t.id === activeId);
  if (!activeTab || activeTab.kind !== 'terminal') return;

  const nextPath = activeTab.sshSessionId
    ? sshStore.currentPathBySession[activeTab.sshSessionId] ?? '/'
    : activeTab.cwd ?? '/';

  setExplorerPath(nextPath);
}, [activeId, tabs, sshStore.currentPathBySession]);
```

对 SSH 侧，需要在远端注入与本地同款的 shell integration 脚本，或在用户执行 `cd` 后通过 SFTP 探测 `pwd`。

### 7.4 SSH 会话与 Tab 解耦

- 一个 SSH Space 持有一个 session；
- 该 Space 下的所有 terminal Tab 共享同一 session，但各自维护 `cwd`；
- 断开/重连时，只更新 Space 的 session id，Tab 不解绑，从而避免“重连后变本地终端”的问题。

### 7.5 清理冗余 UI

| 元素 | 建议操作 | 涉及文件 |
|------|----------|----------|
| 左下角 SSH 连接卡片 | 删除 | `src/modules/ssh-explorer/SshExplorer.tsx` |
| 左上角地址栏 | 删除 | `src/modules/header/Header.tsx` |
| Main 标签 | 删除 | Tab/Header 相关文件 |
| TDSF 主题 | 已计划删除，使用 Terax 预设主题 | `src/modules/theme/` |

### 7.6 修复 SSH 终端标题与目录显示

- 将状态栏/标题栏的 hostname 显示从 `customTitle` 改为独立字段；
- SSH 连接后，状态栏显示 `user@host:path`；
- 本地终端保留 `cwd` 显示。

### 7.7 修复 SSH 重连旧数据残留

- 在 `SshTerminalHost` 卸载或 session 切换时清空 xterm buffer；
- 在 `sshStore.subscribeTerminalData` 中，当 session 从 `closed` 重新变为 `connecting` 时清空 `pendingBuffer`；
- 重连后重新分配 `leafId` 或显式 reset 终端实例。

---

## 8. 风险与优先级

| 优先级 | 问题 | 改动范围 | 风险 |
|--------|------|----------|------|
| P0 | 引入 Space 模型 | `useTabs.ts`、`runtime.tsx`、相关 UI | 较大，但可渐进 |
| P0 | 资源管理器随 cwd 刷新 | `App.tsx`、shell integration、SshTerminalHost | 中等 |
| P1 | 删除地址栏 / Main / SSH 卡片 | Header、SshExplorer | 小 |
| P1 | SSH 重连后仍显示本地终端 | SshTerminalHost、sshStore | 中等 |
| P2 | 标题栏 hostname 显示 | StatusBar、Header | 小 |

---

## 9. 结论

当前 TDSF Terminal Agent 的终端/SSH/资源管理器模块存在**状态模型层级缺失**与**UI 层硬分叉**两类根本性问题。用户反馈的 8 项问题均可追溯到：

1. `Space` 概念未落地；
2. `explorerPath` 全局化且未与 `tab.cwd` 联动；
3. SSH 终端生命周期与 Tab 绑定逻辑过于隐式；
4. TDSF 旧 UI 残留未清理。

建议按“先模型、后联动、再清理”的顺序重构：先引入轻量 Space 层，再统一 cwd/explorer 同步，最后删除冗余 UI 元素。

---

*报告结束*
