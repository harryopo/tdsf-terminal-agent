# SSH 文件编辑器集成 EditorStack 实施方案

> **位置**：`docs/reports/ssh-editor-integration-plan.md`
> **作者**：subagent B（调研 + 方案输出，不动代码）
> **日期**：2026-07-30
> **目标**：让远程 SSH 文件点击后像本地文件一样在主区 `EditorStack` / CodeMirror 打开标签页，废弃侧栏内嵌的 `SshFileEditor`（`<textarea>` 实现）。
> **范围**：仅前端 TS/TSX 改造，不动 Rust、不动 SSH/SFTP 协议层。
> **基线**：crynta/terax-ai v0.8.6 魔改版（项目唯一基线，见 `CLAUDE.md` §0）。

---

## 1. 现状代码路径全图

### 1.1 入口分流（App.tsx）

本地 vs 远程文件点击走两条完全不同的链路：

| 触发点 | 入口函数 | 走向 |
|--------|---------|------|
| 本地文件双击 | `handleOpenFile` (`src/app/App.tsx:765-774`) | `openFileTab(path, pin)` → 主区 `EditorStack` |
| 远程文件双击 | `handleOpenRemoteFile` (`src/app/App.tsx:777-784`) | `useSshStore.openFile(sessionId, path, name)` → 侧栏 `SshFileEditor` |
| `FileExplorer.onOpenFile` 分流 | `src/app/App.tsx:1485-1489` | `explorerSource === "ssh" ? handleOpenRemoteFile : handleOpenFile` |
| `SshFileEditor` 侧栏挂载 | `src/app/App.tsx:86` (import) + `src/app/App.tsx:1517-1519` (挂载) | 仅 `explorerSource === "ssh"` 时挂载，`className="min-h-0 flex-1"` 与文件树二分 |

关键代码（`src/app/App.tsx:777-784`）：

```ts
const handleOpenRemoteFile = useCallback(
  (path: string) => {
    if (!activeSshSessionId) return;
    const name = path.slice(path.lastIndexOf("/") + 1) || path;
    void useSshStore.getState().openFile(activeSshSessionId, path, name);
  },
  [activeSshSessionId],
);
```

`activeSshSessionId` 来源：`src/app/App.tsx:360-361`，由 `useSshStore(selectActiveSession)` 取出 `activeSshSession?.id`，是前端 UUID（`crypto.randomUUID`）。

### 1.2 本地文件路径（治本参考）

`openFileTab` 实现（`src/modules/tabs/lib/useTabs.ts:620-693`）：
- 按 `path` 字符串去重（`:625-627` 持久 tab，`:653-655` preview tab）。
- 创建 `EditorTab` 对象（`:637-650` 持久 / `:676-684` preview），字段固定为 `id/kind/spaceId/title/path/dirty/preview`。
- 返回 `targetId`，`setActiveId(targetId)` 让主区切换。

`EditorTab` 类型（`src/modules/tabs/lib/useTabs.ts:47-60`）：

```ts
export type EditorTab = TabBase & {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  preview: boolean;
  overrideLanguage?: string | null;
};
```

**关键缺口**：`EditorTab` 没有 `remote` 字段，无法区分本地/远程 path，下游所有 fs 调用一律走本地 `invoke("fs_*")`。

### 1.3 主区编辑器挂载链

```
WorkspaceSurface.tsx:174  <EditorStack tabs/activeId/registerHandle/.../>
  └─ EditorStack.tsx:24-26   filter(t => t.kind === "editor" && !t.cold)
  └─ EditorStack.tsx:114-120 <EditorPane path/overrideLanguage/onDirtyChange/onClose />
  └─ EditorPane.tsx:109-113  useDocument({ path, onDirtyChange })
  └─ EditorPane.tsx:373      useLspExtension(path, langId, ready)
  └─ EditorPane.tsx:532      convertFileSrc(path)  // 本地图片/视频预览
  └─ EditorPane.tsx:217      runExternalFormatter(...)  // 本地 formatter 进程
```

### 1.4 useDocument 的 3 处 fs 调用（必须分流）

| 调用 | 位置 | 作用 | Rust 命令 |
|------|------|------|-----------|
| 写盘 | `src/modules/editor/lib/useDocument.ts:63-68` (`writeToDisk`) | 保存编辑内容 | `fs_write_file` |
| stat | `src/modules/editor/lib/useDocument.ts:81-84` (`saveNow`) | 保存前冲突检测（mtime 比较） | `fs_stat` |
| 读盘 | `src/modules/editor/lib/useDocument.ts:131-138` (`readFromDisk`) | 加载文件内容 | `fs_read_file` |

`FileStat` 类型：`{ size: number; mtime: number; kind: string }` (`useDocument.ts:14`)
`ReadResult` 三态：`text/binary/toolarge` (`useDocument.ts:9-12`)

### 1.5 useEditorFileSync 的本地 watch（必须跳过 remote）

文件位置：`src/modules/editor/useEditorFileSync.ts`（注意：**不是** `lib/` 子目录下）

| 行为 | 位置 | 是否适用 remote |
|------|------|----------------|
| `watchAdd(parentDir(path))` | `:75` | ❌ 本地 fs 监听，远程路径无意义 |
| `watchRemove(...)` | `:76` | ❌ 同上 |
| `listenFsChanged` 回调 | `:83-94` | ❌ 本地 fs:changed 事件，远程不会触发；且路径同名撞车时误 reload |
| `fs:file-written` 监听 | `:49-62` | ❌ 本地写入事件；远程 sftpWrite 不会触发；source==='editor' 跳过逻辑也不适用 |
| AI diff approved reload | `:30-42` | ✅ 路径匹配即可（远程 ai-diff 暂不支持，未来扩展另议） |

`parentDir` 实现：`src/modules/explorer/lib/watch.ts:49`（取最后一个 `/` 或 `\` 之前）。

### 1.6 当前 SshFileEditor（待废弃的侧栏 textarea）

文件：`src/modules/ssh-explorer/SshFileEditor.tsx`
- 组件：`:83-223`，原生 `<textarea>` + 行号槽 + 保存按钮。
- 状态来源：`useSshStore.editingFile`（`:84`），含 `path/name/content/originalContent/sessionId/dirty/saving/loading`。
- 保存：`useSshStore.saveFile()`（`:86`），内部调 `sftpWrite`。
- 关闭：`useSshStore.closeEditor()`（`:87`），`set({ editingFile: null })`。
- import：`src/app/App.tsx:86`；挂载：`src/app/App.tsx:1517-1519`。
- `sshStore` 中 `openFile` 实现：`src/modules/ssh-explorer/sshStore.ts:894-933`（`sftpRead` + `decodeUtf8`，单文件 singleton）。
- `SshEditingFile` 类型：`src/modules/ssh-explorer/sshStore.ts:61-78`。

### 1.7 sftp-bridge 远程 API

文件：`src/lib/sftp-bridge.ts`

| API | 位置 | 签名 / 返回 |
|-----|------|-------------|
| `sftpRead` | `:120-127` | `(sessionId: number, path: string) => Promise<Uint8Array>` |
| `sftpWrite` | `:136-147` | `(sessionId: number, path: string, content: Uint8Array) => Promise<void>` |
| `sftpStat` | `:105-110` | `(sessionId: number, path: string) => Promise<SftpAttrs>` |
| `decodeUtf8` | `:188-195` | `(bytes: Uint8Array) => string` |
| `encodeUtf8` | `:202-204` | `(text: string) => Uint8Array` |
| `SftpAttrs` | `:58-71` | `{ size, uid, gid, permissions, modified, accessed }`（modified **秒级** Unix timestamp） |

**关键差异**：
1. `SftpAttrs.modified` 是**秒级**，`FileStat.mtime` 是**毫秒级**，需 `* 1000` 转换。
2. `SftpAttrs` 无 `kind` 字段；远程编辑场景固定 `"file"` 即可。
3. `sftpRead` 返回原始 `Uint8Array`，需在前端做 binary 检测（含 NUL 字节）和大小限制判断（替代 `ReadResult` 三态）。
4. `sftpStat` 不返回 `kind`，binary 检测需从 `sftpRead` 的 bytes 内容判断。
5. `sessionId` 参数是 **Rust 端** `rustSessionId`（number），不是前端 UUID（string）。

### 1.8 SSH 会话/终端深度集成（已完成，需兼容）

| 模块 | 位置 | 说明 |
|------|------|------|
| `SshSessionInfo` | `src/modules/ssh-explorer/sshStore.ts:43-58` | `id`（前端 UUID）+ `rustSessionId`（Rust number）+ `handle`/`state` |
| `selectActiveSession` | `src/modules/ssh-explorer/sshStore.ts:1129-1132` | 取 `activeSessionId` 对应 session |
| `SshTerminalHost` | `src/modules/ssh-explorer/SshTerminalHost.tsx` | SSH 终端宿主，走本地 `rendererPool`，`remote={true}` 标记 TerminalPane（`:121`） |
| 共用 SSH 连接 | `src/modules/ssh-explorer/SshTerminalHost.tsx:92-95` | `close` 只 unsubscribe 前端订阅，不断底层 SSH（SFTP 共用） |
| `remote={true}` 护栏 | `src/modules/ssh-explorer/SshTerminalHost.tsx:23-28` | 跳过 `pty_has_foreground_job`、`kickPty` SIGWINCH、`respawnSession`、`blocks` |
| `WorkspaceSurface` 接管 | `src/app/App.tsx:380` (`showSshTerminalInWorkspace`) + `:1580` (`sshSessionId` prop) + `:1581` (`allocId` prop) | 终端 tab 内 SSH 终端替换本地 PTY |

**关键约束**：SSH 终端与 SFTP 文件树共用同一条 SSH 连接，编辑器改造**绝不能**调 `handle.close()`，所有远程 IO 走 `sftp_*` invoke。

---

## 2. 改造方案（治本方案，对齐 terax 原生架构）

### 2.1 设计原则

1. **对齐 terax 原生 EditorStack 架构**：远程文件走与本地完全相同的 `EditorTab` + `EditorStack` + `EditorPane` + `useDocument` 链路，只在 fs 调用层分流。
2. **remote 字段透传**：`EditorTab` 加 `remote?` 字段，由 `openFileTab` 注入，沿 `EditorStack` → `EditorPane` → `useDocument` 透传到底。
3. **参考 SshTerminalHost 模式**：`remote={true}` 标志位跳过本地专属逻辑（LSP / 外部 formatter / convertFileSrc / 本地 fs watch），与 `SshTerminalHost.tsx:121` 同构。
4. **path 去重带 session**：远程 path 可能与本地 path 撞车（如 `/etc/hosts`），去重 key 改为 `path + (remote ? sessionId : undefined)`。
5. **rustSessionId 实时查询**：tab 只存 `sessionId`（前端 UUID），`useDocument` 内通过 `useSshStore.getState().sessions.find(s => s.id === sessionId)?.rustSessionId` 实时取，应对连接中 → 已连接的状态迁移。
6. **单文件 singleton 退场**：`sshStore.editingFile` 单文件状态废弃，改为多 tab 并行编辑（与本地一致）。

### 2.2 EditorTab 类型扩展

`src/modules/tabs/lib/useTabs.ts:47-60`：

```ts
export type EditorTab = TabBase & {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  preview: boolean;
  overrideLanguage?: string | null;
  /**
   * TDSF 魔改 2026-07-30: 远程文件标记。
   * - undefined / false: 本地文件，走 fs_read_file/fs_write_file/fs_stat + 本地 watch + LSP。
   * - { sessionId }: SSH 远程文件，走 sftpRead/sftpWrite/sftpStat，跳过本地 watch / LSP / 外部 formatter。
   *   sessionId 是前端 UUID (sshStore.sessions[].id)，rustSessionId 在 useDocument 内实时查询。
   */
  remote?: { sessionId: string } | null;
};
```

**只存 sessionId，不存 rustSessionId**：避免 tab 打开后连接断开/重连导致 rustSessionId 失效。`useDocument` 调用 sftp API 时实时从 store 取最新 rustSessionId。

### 2.3 openFileTab 改造

`src/modules/tabs/lib/useTabs.ts:620-693`：

```ts
const openFileTab = useCallback(
  (path: string, pin = true, remote?: { sessionId: string }) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      // 去重 key: path + remote?.sessionId（避免本地/远程同名撞车）
      const matchRemote = (t: Tab) =>
        t.kind === "editor" &&
        t.path === path &&
        (remote ? t.remote?.sessionId === remote.sessionId : !t.remote);
      // ... persistent / preview 分支同原逻辑，把 `t.path === path` 替换为 matchRemote(t)
      // 新建 tab 时注入 remote 字段
      const tab: EditorTab = {
        id, kind: "editor", spaceId: activeSpaceIdRef.current,
        title: basename(path), path, dirty: false, preview: ...,
        remote: remote ?? null,
      };
      ...
    });
    ...
  },
  [],
);
```

### 2.4 handleOpenRemoteFile 改造

`src/app/App.tsx:777-784`：

```ts
const handleOpenRemoteFile = useCallback(
  (path: string) => {
    if (!activeSshSessionId) return;
    // 不再走 sshStore.openFile (单文件 singleton)，改走 openFileTab (多 tab 并行)
    openFileTab(path, false, { sessionId: activeSshSessionId });
  },
  [activeSshSessionId, openFileTab],
);
```

`pin = false` 与本地单击行为一致（preview tab，二次单击其他文件替换槽位）。

### 2.5 删侧栏 SshFileEditor 挂载

`src/app/App.tsx:86`（import）和 `src/app/App.tsx:1517-1519`（挂载）整体删除。`explorerSource === "ssh"` 分支只保留 `FileExplorer`（已通过 `source="ssh"` 切换为远程文件树）。

`src/modules/ssh-explorer/SshFileEditor.tsx` 文件本身可保留（标记 deprecated）或一并删除，建议**删除**以避免后续误用。`src/modules/ssh-explorer/index.ts:8` 的 `export { SshFileEditor }` 同步删除。

`sshStore` 中 `editingFile / openFile / saveFile / closeEditor / updateEditorContent` 五个成员可保留（避免一次性删太多破坏面），但**不再被任何组件引用**；后续清理 PR 再移除。

### 2.6 EditorStack 透传 remote

`src/modules/editor/EditorStack.tsx:114-120`：

```tsx
<EditorPane
  ref={getRefCallback(t.id)}
  path={t.path}
  overrideLanguage={t.overrideLanguage}
  remote={t.remote ?? null}   // 新增
  onDirtyChange={getDirtyCallback(t.id)}
  onClose={getCloseCallback(t.id)}
/>
```

`EditorStack` 的 `tabs` prop 已经是 `Tab[]`，`EditorTab.remote` 字段天然可用，无需改 filter 逻辑（`:24-26` 仍按 `kind === "editor" && !t.cold`）。

### 2.7 EditorPane 接受 remote 并向下透传

`src/modules/editor/EditorPane.tsx:85-91`（Props）：

```ts
type Props = {
  path: string;
  overrideLanguage?: string | null;
  remote?: { sessionId: string } | null;   // 新增
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};
```

`EditorPane.tsx:109-113`（useDocument 调用）：

```ts
const { doc, onChange, save, reload, adoptDiskText, openAnyway } = useDocument({
  path,
  remote,
  onDirtyChange,
});
```

`EditorPane.tsx:373`（LSP 跳过）：

```ts
const lspExt = useLspExtension(path, langId, doc.status === "ready");
useEffect(() => {
  if (remote) {
    // 远程文件不走 LSP（LSP 走本地 fs + workspace）
    lspActiveRef.current = false;
    view.dispatch({ effects: lspCompartment.reconfigure([]) });
    return;
  }
  // ... 原 LSP 逻辑
}, [lspExt, remote]);
```

`EditorPane.tsx:182-235`（`performSave` 内 format-on-save 跳过）：

```ts
const performSave = useCallback(async () => {
  const prefs = usePreferencesStore.getState();
  const formatter = resolveFormatter(languageRef.current, prefs);
  // 远程文件跳过 format-on-save（外部 formatter 走本地进程，无法处理远程文件）
  if (prefs.editorFormatOnSave && !remote && formatter === "lsp" && view) {
    // ... 原 LSP formatter 逻辑
  }
  // ...
  if (prefs.editorFormatOnSave && !remote && formatter !== "lsp") {
    // ... 原外部 formatter 逻辑
  }
  // ...
}, [remote]);
```

`EditorPane.tsx:516-575`（媒体预览跳过）：

```ts
if (doc.status === "binary" || doc.status === "toolarge") {
  // ... ext 判断
  if ((isImage || isVideo || isAudio || isPdf) && !remote) {
    const assetUrl = convertFileSrc(path);
    // ... 原本地媒体预览
  }
  // 远程 binary/toolarge 退化到 "Binary file / File too large" 文案 + Open anyway 按钮
  // ...
}
```

### 2.8 useDocument 分流 fs 调用（核心改造）

`src/modules/editor/lib/useDocument.ts`：

```ts
type Options = {
  path: string;
  remote?: { sessionId: string } | null;
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, remote, onDirtyChange }: Options) {
  // ...

  // 实时取 rustSessionId（应对连接状态迁移）
  const getRustSessionId = useCallback(() => {
    if (!remote) return null;
    const s = useSshStore.getState().sessions.find(
      (it) => it.id === remote.sessionId,
    );
    return s?.rustSessionId ?? null;
  }, [remote]);

  const writeToDisk = useCallback(async () => {
    const content = bufferRef.current;
    if (remote) {
      const sid = getRustSessionId();
      if (sid === null) throw new Error("SSH session not connected");
      await sftpWrite(sid, path, encodeUtf8(restoreEol(content, eolRef.current)));
      // sftpWrite 无返回 mtime，用 sftpStat 补
      const attrs = await sftpStat(sid, path);
      diskMtimeRef.current = attrs.modified * 1000;  // 秒 → 毫秒
      savedRef.current = content;
      setDirty(bufferRef.current !== content);
      notifyDocumentSaved(path);
      return;
    }
    const mtime = await invoke<number>("fs_write_file", { /* 原参数 */ });
    // ... 原逻辑
  }, [path, remote, getRustSessionId]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    const known = diskMtimeRef.current;
    if (known !== null) {
      if (remote) {
        const sid = getRustSessionId();
        if (sid === null) throw new Error("SSH session not connected");
        const attrs = await sftpStat(sid, path).catch(() => null);
        if (attrs && attrs.modified * 1000 !== known) {
          // ... 原冲突 toast
          return false;
        }
      } else {
        const stat = await invoke<FileStat>("fs_stat", { /* 原参数 */ }).catch(() => null);
        if (stat && stat.mtime !== known) {
          // ... 原冲突 toast
          return false;
        }
      }
    }
    await writeToDisk();
    return true;
  }, [path, remote, writeToDisk, getRustSessionId]);

  const readFromDisk = useCallback(
    (force: boolean) => {
      if (remote) {
        const sid = getRustSessionId();
        if (sid === null) return Promise.reject(new Error("SSH session not connected"));
        return sftpRead(sid, path).then((bytes) => {
          const size = bytes.length;
          // binary 检测：含 NUL 字节
          let isBinary = false;
          for (let i = 0; i < Math.min(size, 8192); i++) {
            if (bytes[i] === 0) { isBinary = true; break; }
          }
          if (isBinary) return { kind: "binary", size } as ReadResult;
          const limit = FORCE_READ_LIMIT;
          if (size > limit) return { kind: "toolarge", size, limit } as ReadResult;
          const content = decodeUtf8(bytes);
          // mtime 用 sftpStat 补（sftpRead 不返回）
          return sftpStat(sid, path).then(
            (attrs): ReadResult => ({
              kind: "text",
              content,
              size,
              mtime: attrs.modified * 1000,
            }),
          );
        });
      }
      return invoke<ReadResult>("fs_read_file", { /* 原参数 */ });
    },
    [path, remote, getRustSessionId],
  );

  // ... 其余逻辑不变
}
```

**关键点**：
1. `sftpRead` 不返回 mtime，需额外调 `sftpStat` 补 mtime（多一次往返，但保存冲突检测需要）。
2. binary 检测前端做（含 NUL 字节判定），替代 Rust 侧 `fs_read_file` 的二进制识别。
3. `sftpWrite` 无返回值，保存后用 `sftpStat` 补 mtime 作为 disk baseline。
4. `rustSessionId` 实时查询，不缓存到 ref（连接断开/重连后能取到新值）。

### 2.9 useEditorFileSync 跳过 remote tab

`src/modules/editor/useEditorFileSync.ts`：

```ts
// :69-78 watch 集合计算
useEffect(() => {
  const want = new Set<string>();
  for (const t of tabs) {
    if (t.kind !== "editor") continue;
    if (t.remote) continue;  // 远程 tab 不加本地 watch
    want.add(parentDir(t.path));
  }
  // ...
}, [tabs]);

// :49-62 fs:file-written 监听
(event) => {
  if (event.payload.source === "editor") return;
  const normalizedPath = event.payload.path.replace(/\\/g, "/");
  for (const t of tabsRef.current) {
    if (t.kind !== "editor") continue;
    if (t.remote) continue;  // 远程 tab 不响应本地 fs 事件
    if (t.path.replace(/\\/g, "/") === normalizedPath) {
      editorRefs.current.get(t.id)?.reload();
    }
  }
}

// :83-94 listenFsChanged 回调
void listenFsChanged((paths) => {
  const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  for (const t of tabsRef.current) {
    if (t.kind !== "editor") continue;
    if (t.remote) continue;  // 远程 tab 不响应本地 fs:changed
    if (changed.has(t.path.replace(/\\/g, "/"))) {
      editorRefs.current.get(t.id)?.reload();
    }
  }
})
```

### 2.10 handlePathRenamed / activeFilePath 兼容性

- `handlePathRenamed`（`src/app/App.tsx:804-823`）：远程 tab 当前不支持重命名（`FileExplorer.onPathRenamed` 在 `explorerSource === "ssh"` 时传 `undefined`，见 `src/app/App.tsx:1490-1493`），无需改。
- `activeFilePath`（`src/app/App.tsx:838-852`）：`activeTab.kind === "editor"` 取 `activeTab.path`，远程 tab 同样适用，无需改。
- `explorerActiveFilePath`（`src/app/App.tsx:853-856`）：用于本地 FileExplorer 高亮当前文件，远程 FileExplorer 可选高亮，建议透传（远程 path 比较即可）。

---

## 3. 分阶段实施步骤

每阶段独立可验证、可回滚。建议每阶段一个 commit，全绿后立即提交固化（CLAUDE.md §6）。

### 阶段 1：EditorTab 类型扩展 + openFileTab 支持 remote 参数

**改动文件**：
- `src/modules/tabs/lib/useTabs.ts`（EditorTab 类型 + openFileTab 实现）

**内容**：
1. `EditorTab` 加 `remote?: { sessionId: string } | null` 字段（§2.2）。
2. `openFileTab` 加第三参 `remote?: { sessionId: string }`，去重 key 改为 `path + remote?.sessionId`（§2.3）。
3. 新建 tab 时注入 `remote` 字段。

**验证**：
- `pnpm typecheck` 0 错误（类型扩展不破坏既有调用）。
- `pnpm test` 0 失败（既有 useTabs 测试不回归）。
- 手动验证：本地文件仍正常打开（`openFileTab(path)` 不传 remote，行为不变）。

**回滚**：单文件 revert，无下游依赖。

### 阶段 2：useDocument 分流 fs 调用

**改动文件**：
- `src/modules/editor/lib/useDocument.ts`

**内容**：
1. `Options` 加 `remote` 字段（§2.8）。
2. `writeToDisk` / `saveNow` / `readFromDisk` 三处分流到 sftp-bridge。
3. `getRustSessionId` 实时查询辅助函数。
4. `sftpRead` 后做 binary 检测 + sftpStat 补 mtime。

**验证**：
- `pnpm typecheck` 0 错误。
- `pnpm lint` 0 警告（注意 import 顺序：`@/lib/sftp-bridge`、`@/modules/ssh-explorer`）。
- `pnpm test` 0 失败（useDocument 若有单测需补 remote 分支 mock）。
- 单元测试可补：mock `sftpRead/sftpWrite/sftpStat`，验证 remote 分支调用正确。

**回滚**：单文件 revert，EditorPane 调用 useDocument 时 `remote` 默认 undefined，退化为本地行为。

### 阶段 3：EditorPane 接受 remote + 跳过 LSP/formatter/媒体预览

**改动文件**：
- `src/modules/editor/EditorPane.tsx`

**内容**：
1. Props 加 `remote` 字段（§2.7）。
2. `useDocument` 调用透传 `remote`。
3. `useLspExtension` effect 对 `remote` 跳过（reconfigure 为空）。
4. `performSave` 内 format-on-save 对 `remote` 跳过。
5. 媒体预览分支对 `remote` 退化到文案。

**验证**：
- `pnpm typecheck` 0 错误。
- `pnpm lint` 0 警告。
- `pnpm test` 0 失败。
- `pnpm build:web` 成功。
- 桌面端实测（`pnpm tauri:dev`）：本地文件编辑功能完全无回归（保存/LSP/格式化/图片预览）。

**回滚**：单文件 revert，EditorStack 传 `remote` 字段被忽略，本地行为不变。

### 阶段 4：EditorStack 透传 remote

**改动文件**：
- `src/modules/editor/EditorStack.tsx`

**内容**：
1. `EditorPane` 实例化加 `remote={t.remote ?? null}`（§2.6）。

**验证**：
- `pnpm typecheck` 0 错误。
- `pnpm lint` 0 警告。
- `pnpm test` 0 失败。
- `pnpm build:web` 成功。

**回滚**：单文件 revert。

### 阶段 5：handleOpenRemoteFile 改调 openFileTab + 删侧栏 SshFileEditor 挂载

**改动文件**：
- `src/app/App.tsx`
- `src/modules/ssh-explorer/SshFileEditor.tsx`（删除文件）
- `src/modules/ssh-explorer/index.ts`（移除 SshFileEditor export）

**内容**：
1. `handleOpenRemoteFile` 改调 `openFileTab(path, false, { sessionId: activeSshSessionId })`（§2.4）。
2. 删除 `src/app/App.tsx:86` 的 `SshFileEditor` import。
3. 删除 `src/app/App.tsx:1517-1519` 的 `<SshFileEditor>` 挂载。
4. 删除 `src/modules/ssh-explorer/SshFileEditor.tsx` 文件。
5. `src/modules/ssh-explorer/index.ts:8` 移除 `export { SshFileEditor }`。

**验证**：
- `pnpm typecheck` 0 错误。
- `pnpm lint` 0 警告（无 unused import）。
- `pnpm test` 0 失败。
- `pnpm build:web` 成功。
- `pnpm tauri:dev` 桌面端实测：
  - SSH 连接 → 左侧远程文件树 → 双击文件 → **主区出现 editor tab**（不再是侧栏 textarea）。
  - 编辑 → Ctrl+S 保存 → 远程文件确实更新（可用 `cat` 验证）。
  - 多文件并行编辑（开 3 个远程文件 tab，切换不丢失）。
  - dirty 圆点显示正确。
  - 关闭 tab 后 editorRefs 清理（无内存泄漏）。

**回滚**：保留阶段 5 之前的 commit，整体 revert 即可恢复 SshFileEditor。

### 阶段 6（可选）：清理 sshStore 遗留状态

**改动文件**：
- `src/modules/ssh-explorer/sshStore.ts`

**内容**：
1. 移除 `editingFile` state 字段（`:133`）。
2. 移除 `openFile` / `saveFile` / `closeEditor` / `updateEditorContent` 四个 action（`:202-205`、`:894-980`）。
3. 移除 `SshEditingFile` 类型（`:61-78`）。

**验证**：
- `pnpm typecheck` 0 错误（确认全项目无残留引用）。
- `pnpm lint` 0 警告。
- `pnpm test` 0 失败。
- `pnpm tauri:dev` 桌面端实测无回归。

**回滚**：单文件 revert。

**注意**：此阶段为可选清理，若担心破坏面过大可推迟到下一个迭代。阶段 5 完成后 `editingFile` 等成员已无引用，留着不影响功能。

---

## 4. 五绿门禁验证方法

按 `CLAUDE.md` §4 顺序执行：

```bash
pnpm typecheck        # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint             # eslint . --max-warnings 0，0 错误 0 警告
pnpm test             # vitest run，当前 830 全过（需补 useDocument remote 分支单测）
pnpm build:web        # tsc -p app + vite build，成功出 dist
pnpm tauri:dev        # 桌面端实测
```

### 4.1 typecheck 关注点

- `EditorTab.remote` 字段在所有 `Tab` 联合类型解构处不报 undefined（已是可选字段）。
- `useDocument` 的 `Options` 类型扩展后，EditorPane 调用处的类型推导正确。
- `sftpRead/sftpWrite/sftpStat` 的返回类型与 `ReadResult/FileStat` 兼容（注意 mtime 秒→毫秒转换）。

### 4.2 lint 关注点

- 新增 import 顺序（`@/lib/sftp-bridge`、`@/modules/ssh-explorer/sshStore`）符合现有 import 排序规则。
- 无 `// @ts-ignore`、无散落 `eslint-disable`。
- `useDocument` 内 if/else 分支无未使用变量。

### 4.3 test 关注点

- 既有 `useTabs` 测试不回归（openFileTab 新增第三参为可选，不破坏既有调用）。
- 既有 `useDocument` 若有单测，需补 remote 分支 mock。
- 既有 `useEditorFileSync` 若有单测，需补 remote tab 跳过 watch 的断言。
- 建议新增：`useDocument.remote.test.ts`，mock `sftpRead/sftpWrite/sftpStat` + `useSshStore.getState()`，验证远程读/写/冲突检测路径。

### 4.4 build:web 关注点

- Vite 6 + tsc strict 不报类型错误。
- 无 dynamic import 失败（sftp-bridge 是同步 import，无 lazy）。

### 4.5 tauri:dev 桌面端实测脚本

**前置**：启动应用，自动登录 SSH（`src/app/App.tsx:407-448` 自动登录最近会话），左侧 FileExplorer 切换为远程文件树。

**测试用例**：

| # | 操作 | 预期 |
|---|------|------|
| 1 | 双击远程 `/etc/hostname` | 主区出现 editor tab（preview），标题 `hostname`，内容显示主机名 |
| 2 | 双击远程 `/etc/passwd` | preview tab 被 hostname 替换（VSCode 风格） |
| 3 | 单击 preview tab 标题 | tab 转 persistent（pin） |
| 4 | 编辑 `/tmp/test.txt`（新建后）→ Ctrl+S | 远程文件确实保存（`cat /tmp/test.txt` 验证），dirty 圆点消失 |
| 5 | 同时打开 3 个远程文件 tab | 切换不丢失内容，无 reload 抖动 |
| 6 | 关闭远程 tab | editorRefs 清理，无报错 |
| 7 | 断开 SSH（侧栏点断开）→ 双击远程文件 | 报错 "SSH session not connected"（getRustSessionId 返回 null） |
| 8 | 重连 SSH → 重试打开远程文件 | 正常打开（rustSessionId 实时查询生效） |
| 9 | 本地文件编辑（不连 SSH） | 完全无回归（保存/LSP/格式化/图片预览） |
| 10 | 连接 SSH + 本地文件 + 远程文件混用 | 两种 tab 并存，互不干扰 |

**诊断手段**（参考 CLAUDE.md §5）：
- 若主区空白：CDP 连 9222 截图确认是否渲染。
- 若保存失败：console 看 `[editor] save failed` / `[sftp-bridge]` 日志。
- 若 dirty 不消失：检查 `diskMtimeRef.current` 是否正确设置（sftpStat 返回值 `* 1000`）。

---

## 5. 与 SshTerminalHost 兼容性确认

### 5.1 共用 SSH 连接（关键约束）

`SshTerminalHost.tsx:92-95` 明确：`close` 只 unsubscribe 前端订阅，不断底层 SSH 连接，因为 **SFTP 文件树共用同一条 SSH 连接**。

**本方案兼容性**：
- 编辑器调 `sftpRead/sftpWrite/sftpStat` 走的是 `rustSessionId`（来自 `sshStore.sessions[].rustSessionId`），与 `SshTerminalHost` 走的 `session.handle`（PTY channel）是同一条 SSH 连接的两个 channel（SFTP channel + PTY channel）。
- 编辑器**绝不调** `handle.close()`，与 SshTerminalHost 一致。
- 编辑器 tab 关闭只清理前端 state（`closeTab`），不影响 SSH 连接。

### 5.2 remote 标志位模式对齐

| 模块 | remote 标志位置 | 跳过的本地专属逻辑 |
|------|----------------|--------------------|
| SshTerminalHost | `src/modules/ssh-explorer/SshTerminalHost.tsx:121` (`<TerminalPane remote={true} />`) | pty_has_foreground_job / kickPty SIGWINCH / respawnSession / blocks |
| EditorPane（本方案） | `src/modules/editor/EditorPane.tsx` Props `remote` | LSP / 外部 formatter / convertFileSrc 媒体预览 |
| useDocument（本方案） | `src/modules/editor/lib/useDocument.ts` Options `remote` | fs_read_file → sftpRead / fs_write_file → sftpWrite / fs_stat → sftpStat |
| useEditorFileSync（本方案） | `src/modules/editor/useEditorFileSync.ts` 检查 `t.remote` | watchAdd/watchRemove / listenFsChanged / fs:file-written |

**同构性**：本方案完全复刻 SshTerminalHost 的 remote 护栏模式，架构一致。

### 5.3 leafId / allocId 不冲突

`SshTerminalHost.tsx:49-53` 通过 `allocId()` 分配稳定 leafId，与本地 leaf 共享 `useTabs.nextIdRef` 计数器。

**本方案**：EditorTab 的 `id` 由 `openFileTab` 内 `nextIdRef.current++` 分配（`useTabs.ts:637/674`），与 terminal leaf 共享同一计数器，**不会撞号**。

### 5.4 状态隔离

`SshTerminalHost` 订阅 `useSshStore(s => s.sessions.find(...))` 获取 session 状态；本方案 `useDocument` 通过 `useSshStore.getState().sessions.find(...)` 实时查询 rustSessionId。

**竞态**：
- 若 SSH 断开时用户尝试保存远程文件，`getRustSessionId` 返回 null，`writeToDisk` 抛 "SSH session not connected"，toast 提示用户。
- 若 SSH 重连后 rustSessionId 变化，`useDocument` 下次调用 `getRustSessionId` 自动取新值（不缓存）。
- 若 tab 打开后 SSH 断开，tab 内容仍在内存（bufferRef 不丢），用户重连后可继续保存。

### 5.5 WorkspaceSurface 接管模式对齐

`src/app/App.tsx:380` (`showSshTerminalInWorkspace`) + `:1580` (`sshSessionId` prop) 已经把 SSH 终端接管到主区 terminal tab。本方案把 SSH 文件编辑器也接管到主区 editor tab，**与终端接管模式完全对齐**，UI 一致性良好。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `sftpRead` 不返回 mtime，需额外 `sftpStat` | 读文件多一次往返 | 接受（保存冲突检测需要 mtime） |
| `sftpWrite` 无返回 mtime，需 `sftpStat` 补 | 写文件多一次往返 | 接受 |
| binary 检测在前端做，可能与 Rust 侧判定不一致 | 误判 binary / text | 用 NUL 字节检测（前 8KB），与 Rust 侧 `fs_read_file` 的 `is_binary` 判定一致 |
| `rustSessionId` 实时查询可能 race | 保存时连接断开 | `getRustSessionId` 返回 null 时抛错，toast 提示 |
| 远程大文件全量加载（sftpRead 不分块） | 内存占用 | 沿用 `FORCE_READ_LIMIT = 50MB`（`useDocument.ts:17`），超过走 toolarge 分支 |
| `editingFile` 单文件 state 废弃后，若有其他组件引用 | 编译错误 | 阶段 5 前全局 grep `editingFile` 确认引用范围；阶段 6 才删 store 成员 |
| LSP / 外部 formatter 跳过后用户体验下降 | 远程文件无补全/格式化 | 文档说明（本方案明确跳过）；后续可考虑远程 LSP over SSH（独立 PR） |
| 路径去重 key 改为 `path + sessionId` | 既有 tab 持久化（spaces persistence）可能不兼容 | 检查 `useSpacePersistence` 序列化逻辑，确保 `remote` 字段被正确序列化/反序列化；若不兼容，恢复后 remote tab 退化为本地 tab（path 找不到时报错，可接受） |

---

## 7. 与已废弃自研 v4.0.0 的隔离

按 `CLAUDE.md` §0 铁律 2：自研 "tdsf-terminal-agent v4.0.0" 已废弃，严禁引入其代码/配置/文档。

**本方案严格遵守**：
- 所有改造基于 crynta/terax-ai v0.8.6 既有架构（EditorTab / EditorStack / EditorPane / useDocument / useEditorFileSync）。
- 新增的 `remote` 字段、sftp 分流逻辑、LSP/formatter 跳过逻辑，均为对 terax 原生架构的**最小侵入扩展**，不引入任何自研 v4.0.0 概念。
- `SshFileEditor` 废弃后，不引入任何替代的"自研编辑器"，完全复用 terax 的 CodeMirror EditorPane。

---

## 8. 后续延伸（非本方案范围）

1. **远程 LSP over SSH**：通过 SSH channel 转发 LSP JSON-RPC，让远程文件也获得补全/跳转/格式化能力。独立 PR。
2. **远程文件 watch**：SFTP 协议支持 inotify 扩展（非标准），或用 SSH channel 跑 `inotifywait` 命令解析输出。独立 PR。
3. **远程文件大文件分块读写**：sftpRead/sftpWrite 改为分块流式，支持 >50MB 文件。独立 PR。
4. **远程文件 AI diff**：`openAiDiffTab` 支持远程 path，让 AI 修改远程文件。独立 PR。
5. **远程文件搜索/grep**：`source-control` 模块支持远程 git 仓库。独立 PR。

---

## 9. 引用索引（file:line）

### App.tsx
- `src/app/App.tsx:86` — SshFileEditor import
- `src/app/App.tsx:159` — openFileTab 解构
- `src/app/App.tsx:360-365` — activeSshSession / activeSshSessionId / isConnectedSsh
- `src/app/App.tsx:479` — useEditorFileSync 调用
- `src/app/App.tsx:765-774` — handleOpenFile
- `src/app/App.tsx:777-784` — handleOpenRemoteFile（待改造）
- `src/app/App.tsx:804-823` — handlePathRenamed
- `src/app/App.tsx:838-856` — activeFilePath / explorerActiveFilePath
- `src/app/App.tsx:1485-1489` — FileExplorer.onOpenFile 分流
- `src/app/App.tsx:1517-1519` — SshFileEditor 挂载（待删除）
- `src/app/App.tsx:1580-1581` — WorkspaceSurface sshSessionId/allocId

### tabs/lib/useTabs.ts
- `src/modules/tabs/lib/useTabs.ts:47-60` — EditorTab 类型（待扩展）
- `src/modules/tabs/lib/useTabs.ts:620-693` — openFileTab 实现（待改造）
- `src/modules/tabs/lib/useTabs.ts:625-627` / `:653-655` — path 去重（待改为 path + sessionId）

### editor/
- `src/modules/editor/EditorStack.tsx:7-14` — Props 类型
- `src/modules/editor/EditorStack.tsx:24-26` — editor tab filter
- `src/modules/editor/EditorStack.tsx:114-120` — EditorPane 实例化（待加 remote）
- `src/modules/editor/EditorPane.tsx:85-91` — Props 类型（待加 remote）
- `src/modules/editor/EditorPane.tsx:109-113` — useDocument 调用（待透传 remote）
- `src/modules/editor/EditorPane.tsx:182-235` — performSave（待跳过 remote format-on-save）
- `src/modules/editor/EditorPane.tsx:373` — useLspExtension（待对 remote 跳过）
- `src/modules/editor/EditorPane.tsx:516-575` — 媒体预览（待对 remote 退化）
- `src/modules/editor/EditorPane.tsx:532` — convertFileSrc（不适用远程）
- `src/modules/editor/lib/useDocument.ts:9-14` — ReadResult / FileStat 类型
- `src/modules/editor/lib/useDocument.ts:17` — FORCE_READ_LIMIT
- `src/modules/editor/lib/useDocument.ts:31` — useDocument 签名（待加 remote）
- `src/modules/editor/lib/useDocument.ts:63-68` — writeToDisk（待分流 sftpWrite）
- `src/modules/editor/lib/useDocument.ts:81-84` — saveNow stat（待分流 sftpStat）
- `src/modules/editor/lib/useDocument.ts:131-138` — readFromDisk（待分流 sftpRead）
- `src/modules/editor/useEditorFileSync.ts:49-62` — fs:file-written 监听（待跳过 remote）
- `src/modules/editor/useEditorFileSync.ts:69-78` — watchAdd/watchRemove（待跳过 remote）
- `src/modules/editor/useEditorFileSync.ts:83-94` — listenFsChanged（待跳过 remote）
- `src/modules/editor/index.ts` — 模块导出

### ssh-explorer/
- `src/modules/ssh-explorer/SshFileEditor.tsx:83-223` — textarea 实现（待删除）
- `src/modules/ssh-explorer/sshStore.ts:43-58` — SshSessionInfo
- `src/modules/ssh-explorer/sshStore.ts:47` — rustSessionId 字段
- `src/modules/ssh-explorer/sshStore.ts:61-78` — SshEditingFile 类型（阶段 6 删）
- `src/modules/ssh-explorer/sshStore.ts:133` — editingFile state（阶段 6 删）
- `src/modules/ssh-explorer/sshStore.ts:202-205` — openFile/saveFile/closeEditor/updateEditorContent actions（阶段 6 删）
- `src/modules/ssh-explorer/sshStore.ts:894-933` — openFile 实现（待废弃）
- `src/modules/ssh-explorer/sshStore.ts:935-967` — saveFile 实现（待废弃）
- `src/modules/ssh-explorer/sshStore.ts:1129-1132` — selectActiveSession
- `src/modules/ssh-explorer/SshTerminalHost.tsx:23-28` — remote=true 护栏模式（参考范本）
- `src/modules/ssh-explorer/SshTerminalHost.tsx:92-95` — close 不断底层 SSH（关键约束）
- `src/modules/ssh-explorer/SshTerminalHost.tsx:121` — remote={true} 标记
- `src/modules/ssh-explorer/index.ts:8` — SshFileEditor export（待删除）
- `src/modules/ssh-explorer/index.ts:12` — SshTerminalHost export

### lib/
- `src/lib/sftp-bridge.ts:58-71` — SftpAttrs 类型（modified 秒级）
- `src/lib/sftp-bridge.ts:105-110` — sftpStat
- `src/lib/sftp-bridge.ts:120-127` — sftpRead（返回 Uint8Array）
- `src/lib/sftp-bridge.ts:136-147` — sftpWrite（传 Uint8Array）
- `src/lib/sftp-bridge.ts:188-195` — decodeUtf8
- `src/lib/sftp-bridge.ts:202-204` — encodeUtf8
- `src/modules/explorer/lib/watch.ts:49` — parentDir

### app/components/
- `src/app/components/WorkspaceSurface.tsx:174` — EditorStack 实例化

### 文档
- `CLAUDE.md` §0 — 项目身份铁律
- `CLAUDE.md` §3 — 防污染红线
- `CLAUDE.md` §4 — 五绿门禁
- `CLAUDE.md` §5 — 诊断方法论
- `docs/dev-state.md` — 当前状态/已知问题
