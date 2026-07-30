# SSH 文件编辑器集成 EditorStack — 实施 Diff

> **位置**：`docs/reports/ssh-editor-implementation-diff.md`
> **配套方案**：`docs/reports/ssh-editor-integration-plan.md`（824 行，6 阶段设计）
> **作者**：subagent B（场景 C，只写方案 diff，不动源码）
> **日期**：2026-07-30
> **基线**：crynta/terax-ai v0.8.6 魔改版（项目唯一基线，见 `CLAUDE.md` §0）
> **范围**：仅前端 TS/TSX 改造，不动 Rust、不动 SSH/SFTP 协议层。

---

## 0. 概述

| 项 | 值 |
|----|----|
| 阶段数 | **6**（按任务要求排序，与方案文档 §3 阶段划分不同：本 diff 把 `useEditorFileSync` 单列为阶段 3） |
| 改动文件 | **7 个**（5 改 + 1 删 + 1 改 export） |
| 新增概念 | `EditorTab.remote?: { sessionId: string } | null`（单一标志位，透传到底） |
| 废弃概念 | `sshStore.editingFile` 单文件 singleton + `SshFileEditor` 侧栏 textarea |
| 兼容性 | 本地文件编辑链路零回归（`remote` 默认 undefined/null，走原 fs_* 路径） |

### 阶段速览

| 阶段 | 文件 | 核心动作 |
|------|------|----------|
| 1 | `src/modules/tabs/lib/useTabs.ts` | `EditorTab` 加 `remote` 字段 + `openFileTab` 加第三参 + 去重 key 改 `path + sessionId` |
| 2 | `src/modules/editor/lib/useDocument.ts` | 3 处 fs 调用分流（read/write/stat → sftpRead/sftpWrite/sftpStat） |
| 3 | `src/modules/editor/useEditorFileSync.ts` | remote tab 跳过本地 watch（3 处 effect） |
| 4 | `src/modules/editor/EditorPane.tsx` | remote 跳过 LSP / 外部 formatter / convertFileSrc 媒体预览 |
| 5 | `src/modules/editor/EditorStack.tsx` | `<EditorPane>` 透传 `remote={t.remote ?? null}` |
| 6 | `src/app/App.tsx` + `src/modules/ssh-explorer/{SshFileEditor.tsx,index.ts}` | `handleOpenRemoteFile` 改调 `openFileTab` + 删侧栏挂载 + 删文件 + 删 export |

### 关键风险点（来自方案文档 §6，实施时必须遵守）

1. **`SftpAttrs.modified` 是秒级 Unix timestamp**，`FileStat.mtime` 是毫秒级。所有从 `sftpStat` 取到的 `modified` 必须 `* 1000` 才能赋给 `diskMtimeRef.current`，否则冲突检测永远误报（mtime 永远不等于 known）。见阶段 2 writeToDisk / saveNow / readFromDisk 三处。
2. **`sftpRead` / `sftpWrite` 不返回 mtime**。读盘后需额外调 `sftpStat` 补 mtime（冲突检测 baseline）；写盘后同样需 `sftpStat` 补 mtime（作为新 baseline）。每次读写多一次 SFTP 往返，接受。
3. **`rustSessionId` 必须实时从 store 查询，绝不缓存到 ref**。SSH 连接断开/重连后 `rustSessionId` 会变（`sshStore.ts:47` 字段 `rustSessionId: number | null`），缓存会导致重连后保存写到旧 session 失败。`useDocument` 内 `getRustSessionId()` 每次调用都从 `useSshStore.getState().sessions.find(...)` 取最新值。
4. **path 去重 key 必须改为 `path + sessionId`**。远程 path 可能与本地 path 撞车（如 `/etc/hosts`、`/tmp/test.txt`），若仍按 `path` 去重，打开远程 `/etc/hosts` 会激活本地 `/etc/hosts` tab（若存在），反之亦然。见阶段 1 `matchRemote` 辅助函数。

### 附加风险

| 风险 | 缓解 |
|------|------|
| binary 检测在前端做（NUL 字节扫描前 8KB），可能与 Rust 侧 `fs_read_file` 判定不一致 | 扫描前 8KB 内 NUL 字节，与 Rust 侧 `is_binary` 启发式一致；误判概率低 |
| 远程大文件全量加载（sftpRead 不分块） | 沿用 `FORCE_READ_LIMIT = 50MB`（`useDocument.ts:17`），超过走 `toolarge` 分支 |
| `editingFile` 单文件 state 废弃后若有残留引用 | 阶段 6 前全局 grep `editingFile` 确认；阶段 6 不删 store 成员（保留 `openFile/saveFile/closeEditor/updateEditorContent` 避免破坏面），只删组件挂载点；后续清理 PR 再移除 store 成员 |
| LSP / 外部 formatter 跳过后远程文件无补全/格式化 | 文档说明（本方案明确跳过）；后续可考虑远程 LSP over SSH（独立 PR） |
| spaces persistence 序列化 `remote` 字段可能不兼容 | `remote` 是可选字段，反序列化后若丢失则退化为本地 tab（path 找不到时报错，可接受） |

---

## 阶段 1：`useTabs.ts` EditorTab 类型扩展 + openFileTab 加第三参

**改动文件**：`src/modules/tabs/lib/useTabs.ts`

### 改动理由（WHY）

`EditorTab`（`useTabs.ts:47-60`）当前只有 `id/kind/title/path/dirty/preview/overrideLanguage` 七个字段，**没有 `remote` 字段**，下游 `useDocument` / `useEditorFileSync` / `EditorPane` 无法区分本地/远程 path，所有 fs 调用一律走本地 `invoke("fs_*")`。

`openFileTab`（`useTabs.ts:620-693`）当前签名 `(path: string, pin = true)`，去重 key 是纯 `t.path === path`（`:625-627` 持久 / `:653-655` preview / `:662-665` preview reuse）。远程 path 与本地 path 可能撞车（如 `/etc/hosts`），必须把 `sessionId` 纳入去重 key。

本阶段是整条链路的"源头"，下游阶段 2-5 全部依赖 `tab.remote` 字段透传。本阶段独立可验证（`openFileTab(path)` 不传 remote 时行为零变化）。

### 代码 Diff

#### 1.1 EditorTab 类型扩展（`src/modules/tabs/lib/useTabs.ts:47-60`）

```diff
--- a/src/modules/tabs/lib/useTabs.ts
+++ b/src/modules/tabs/lib/useTabs.ts
@@ -47,11 +47,19 @@ export type TerminalTab = TabBase & {
 export type EditorTab = TabBase & {
   id: number;
   kind: "editor";
   title: string;
   path: string;
   dirty: boolean;
   /**
    * True while the tab is in the transient "preview" state — opened by a
    * single-click in the explorer and not yet pinned by the user. A preview tab
    * is replaced by the next single-click rather than accumulating.
    */
   preview: boolean;
   overrideLanguage?: string | null;
+  /**
+   * TDSF 魔改 2026-07-30: 远程文件标记。
+   * - undefined / null: 本地文件，走 fs_read_file/fs_write_file/fs_stat + 本地 watch + LSP。
+   * - { sessionId }: SSH 远程文件，走 sftpRead/sftpWrite/sftpStat，跳过本地 watch / LSP / 外部 formatter。
+   *   sessionId 是前端 UUID (sshStore.sessions[].id)，rustSessionId 在 useDocument 内实时查询。
+   */
+  remote?: { sessionId: string } | null;
 };
```

#### 1.2 openFileTab 加第三参 + 去重 key 改 path+sessionId + 注入 remote（`src/modules/tabs/lib/useTabs.ts:620-693`）

```diff
--- a/src/modules/tabs/lib/useTabs.ts
+++ b/src/modules/tabs/lib/useTabs.ts
@@ -617,7 +617,7 @@ export function useTabs(initial?: Partial<TerminalTab>) {
    *   otherwise the current preview slot is replaced with the new path.
    */
-  const openFileTab = useCallback((path: string, pin = true) => {
+  const openFileTab = useCallback((path: string, pin = true, remote?: { sessionId: string }) => {
     let targetId: number | null = null;
     setTabs((curr) => {
+      // TDSF 魔改 2026-07-30: 去重 key 改为 path + remote?.sessionId，
+      // 避免本地/远程同名文件（如 /etc/hosts）撞车导致打开错误 tab。
+      const matchRemote = (t: Tab): boolean =>
+        t.kind === "editor" &&
+        t.path === path &&
+        (remote ? t.remote?.sessionId === remote.sessionId : !t.remote);
       if (pin) {
         // Persistent open: find any existing editor tab, pin it if needed.
-        const existing = curr.find(
-          (t) => t.kind === "editor" && t.path === path,
-        );
+        const existing = curr.find(matchRemote);
         if (existing) {
           targetId = existing.id;
           if ((existing as EditorTab).preview) {
@@ -637,6 +637,7 @@ export function useTabs(initial?: Partial<TerminalTab>) {
             title: basename(path),
             path,
             dirty: false,
             preview: false,
+            remote: remote ?? null,
           } satisfies EditorTab,
         ];
       } else {
         // Preview open: persistent tab for this path takes priority.
-        const persistent = curr.find(
-          (t) =>
-            t.kind === "editor" && t.path === path && !(t as EditorTab).preview,
-        );
+        const persistent = curr.find(
+          (t) => matchRemote(t) && !(t as EditorTab).preview,
+        );
         if (persistent) {
           targetId = persistent.id;
           return curr;
         }
         // Reuse the slot if it already shows the same path.
-        const existingPreview = curr.find(
-          (t) =>
-            t.kind === "editor" && t.path === path && (t as EditorTab).preview,
-        );
+        const existingPreview = curr.find(
+          (t) => matchRemote(t) && (t as EditorTab).preview,
+        );
         if (existingPreview) {
           targetId = existingPreview.id;
           return curr;
@@ -676,6 +677,7 @@ export function useTabs(initial?: Partial<TerminalTab>) {
           title: basename(path),
           path,
           dirty: false,
           preview: true,
+          remote: remote ?? null,
         };
         if (previewIdx === -1) return [...curr, tab];
         const next = [...curr];
```

**注意**：`previewIdx`（替换 preview slot 的逻辑，`:671-673`）保留原样——它只看 `kind === "editor" && preview`，不区分本地/远程。这是 VSCode 风格的单一 preview slot：本地 preview 和远程 preview 共享一个槽位，后开者替换先开者。这是预期行为。

### 验证方法

```bash
pnpm typecheck   # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
                 # 关注：EditorTab.remote 在 Tab 联合类型解构处不报 undefined（已是可选字段）
pnpm lint        # eslint . --max-warnings 0，0 警告
pnpm test        # vitest run，既有 useTabs 测试不回归（openFileTab 第三参可选，不破坏既有调用）
```

桌面端实测（`pnpm tauri:dev`）：
- 本地文件双击 → 主区 editor tab 正常打开（`openFileTab(path)` 不传 remote，`matchRemote` 匹配 `!t.remote`，行为零变化）。
- 本地同名文件 `/etc/hosts`（若本地存在）打开 → 不与远程 tab 撞车（阶段 6 后验证）。

### 回滚方法

单文件 revert `src/modules/tabs/lib/useTabs.ts`。`remote` 字段是可选的，下游阶段 2-5 即使已改也兼容（`remote` undefined 时走原 fs_* 路径）。本阶段无下游破坏性依赖。

---

## 阶段 2：`useDocument.ts` 3 处 fs 调用按 tab.remote 分流

**改动文件**：`src/modules/editor/lib/useDocument.ts`

### 改动理由（WHY）

`useDocument`（`useDocument.ts:31`）是编辑器的 fs 唯一出入口，3 处 invoke 调用必须分流：

| 调用 | 位置 | 本地（原） | 远程（新） |
|------|------|-----------|-----------|
| 读盘 | `:131-138` readFromDisk | `invoke<ReadResult>("fs_read_file")` | `sftpRead` + 前端 binary 检测 + `sftpStat` 补 mtime |
| 写盘 | `:63-68` writeToDisk | `invoke<number>("fs_write_file")` 返回 mtime | `sftpWrite`（无返回）+ `sftpStat` 补 mtime |
| stat | `:81-84` saveNow 内 | `invoke<FileStat>("fs_stat")` | `sftpStat`（mtime 秒级 *1000） |

**关键差异**（来自方案文档 §1.7）：
1. `SftpAttrs.modified` 是**秒级**，`FileStat.mtime` 是**毫秒级**，必须 `* 1000`。
2. `sftpRead` 返回 `Uint8Array`，需前端做 binary 检测（NUL 字节扫描前 8KB）+ 大小限制判断，替代 Rust 侧 `ReadResult` 三态。
3. `sftpRead` / `sftpWrite` 不返回 mtime，需额外 `sftpStat` 补。
4. `sessionId` 参数是 Rust 端 `rustSessionId`（number），不是前端 UUID（string）。`getRustSessionId` 实时从 store 查询。

### 代码 Diff

#### 2.1 新增 import（`src/modules/editor/lib/useDocument.ts:1-7` 顶部）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -1,6 +1,10 @@
+import {
+  decodeUtf8,
+  encodeUtf8,
+  sftpRead,
+  sftpStat,
+  sftpWrite,
+} from "@/lib/sftp-bridge";
+import { useSshStore } from "@/modules/ssh-explorer";
 import { notifyDocumentSaved } from "@/modules/lsp";
 import { usePreferencesStore } from "@/modules/settings/preferences";
 import { currentWorkspaceEnv } from "@/modules/workspace";
```

> **lint 注意**：import 顺序需符合 eslint 排序规则（`@/lib/...` < `@/modules/...`，按字母序）。若 eslint 报 import-order，调整顺序即可。

#### 2.2 Options 类型加 remote（`src/modules/editor/lib/useDocument.ts:26-29`）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -26,6 +26,8 @@ export type DocumentState =
   | { status: "error"; message: string };

 type Options = {
   path: string;
+  /** TDSF 魔改 2026-07-30: 远程文件标记，非空时 fs 调用分流到 sftp-bridge。 */
+  remote?: { sessionId: string } | null;
   onDirtyChange?: (dirty: boolean) => void;
 };
```

#### 2.3 useDocument 签名 + getRustSessionId 辅助（`src/modules/editor/lib/useDocument.ts:31-59`）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -31,7 +31,8 @@ type Options = {
-export function useDocument({ path, onDirtyChange }: Options) {
+export function useDocument({ path, remote, onDirtyChange }: Options) {
   const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
   const [dirty, setDirty] = useState(false);

   const autoSave = usePreferencesStore((s) => s.editorAutoSave);
@@ -58,6 +59,16 @@ export function useDocument({ path, onDirtyChange }: Options) {

   const diskMtimeRef = useRef<number | null>(null);

+  // TDSF 魔改 2026-07-30: 实时取 rustSessionId（应对连接断开/重连后的状态迁移）。
+  // 绝不缓存到 ref——SSH 重连后 rustSessionId 会变，缓存会导致保存写到旧 session。
+  const getRustSessionId = useCallback((): number | null => {
+    if (!remote) return null;
+    const s = useSshStore.getState().sessions.find(
+      (it) => it.id === remote.sessionId,
+    );
+    return s?.rustSessionId ?? null;
+  }, [remote]);
+
   const writeToDisk = useCallback(async () => {
```

#### 2.4 writeToDisk 分流（`src/modules/editor/lib/useDocument.ts:61-74`）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -61,11 +61,26 @@ export function useDocument({ path, onDirtyChange }: Options) {
   const writeToDisk = useCallback(async () => {
     const content = bufferRef.current;
+    // TDSF 魔改 2026-07-30: 远程文件分流到 sftpWrite。
+    // sftpWrite 不返回 mtime，需额外 sftpStat 补，作为下次冲突检测的 baseline。
+    if (remote) {
+      const sid = getRustSessionId();
+      if (sid === null) throw new Error("SSH session not connected");
+      await sftpWrite(
+        sid,
+        path,
+        encodeUtf8(restoreEol(content, eolRef.current)),
+      );
+      const attrs = await sftpStat(sid, path);
+      // SftpAttrs.modified 秒级 → 毫秒（与 FileStat.mtime 对齐）。
+      diskMtimeRef.current = attrs.modified * 1000;
+      savedRef.current = content;
+      setDirty(bufferRef.current !== content);
+      notifyDocumentSaved(path);
+      return;
+    }
     const mtime = await invoke<number>("fs_write_file", {
       path,
       content: restoreEol(content, eolRef.current),
       workspace: currentWorkspaceEnv(),
       source: "editor",
     });
     diskMtimeRef.current = mtime;
     savedRef.current = content;
     // Edits typed while the write was in flight must stay dirty.
     setDirty(bufferRef.current !== content);
     notifyDocumentSaved(path);
-  }, [path]);
+  }, [path, remote, getRustSessionId]);
```

#### 2.5 saveNow 分流（`src/modules/editor/lib/useDocument.ts:78-97`）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -78,12 +78,26 @@ export function useDocument({ path, onDirtyChange }: Options) {
   const saveNow = useCallback(async (): Promise<boolean> => {
     const known = diskMtimeRef.current;
     if (known !== null) {
-      const stat = await invoke<FileStat>("fs_stat", {
-        path,
-        workspace: currentWorkspaceEnv(),
-      }).catch(() => null);
-      if (stat && stat.mtime !== known) {
+      // TDSF 魔改 2026-07-30: 远程用 sftpStat，mtime 秒级 *1000 转毫秒。
+      let mtime: number | null = null;
+      if (remote) {
+        const sid = getRustSessionId();
+        if (sid === null) throw new Error("SSH session not connected");
+        const attrs = await sftpStat(sid, path).catch(() => null);
+        mtime = attrs ? attrs.modified * 1000 : null;
+      } else {
+        const stat = await invoke<FileStat>("fs_stat", {
+          path,
+          workspace: currentWorkspaceEnv(),
+        }).catch(() => null);
+        mtime = stat?.mtime ?? null;
+      }
+      if (mtime !== null && mtime !== known) {
         const name = path.split(/[\\/]/).pop() ?? path;
         toast.warning("File changed on disk", {
           id: `save-conflict:${path}`,
           description: `${name} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
           action: { label: "Overwrite", onClick: () => void writeToDisk() },
         });
         return false;
       }
     }
     await writeToDisk();
     return true;
-  }, [path, writeToDisk]);
+  }, [path, remote, writeToDisk, getRustSessionId]);
```

#### 2.6 readFromDisk 分流（`src/modules/editor/lib/useDocument.ts:130-138`）

```diff
--- a/src/modules/editor/lib/useDocument.ts
+++ b/src/modules/editor/lib/useDocument.ts
@@ -130,9 +130,43 @@ export function useDocument({ path, onDirtyChange }: Options) {
   const readFromDisk = useCallback(
-    (force: boolean) =>
-      invoke<ReadResult>("fs_read_file", {
-        path,
-        workspace: currentWorkspaceEnv(),
-        force,
-      }),
-    [path],
+    (force: boolean): Promise<ReadResult> => {
+      // TDSF 魔改 2026-07-30: 远程用 sftpRead，需前端做 binary 检测 + sftpStat 补 mtime。
+      // force 参数远程分支忽略（sftpRead 全量读取，无 force 概念，openAnyway 行为一致）。
+      if (remote) {
+        const sid = getRustSessionId();
+        if (sid === null) {
+          return Promise.reject(new Error("SSH session not connected"));
+        }
+        return sftpRead(sid, path).then((bytes): Promise<ReadResult> => {
+          const size = bytes.length;
+          // binary 检测：前 8KB 内含 NUL 字节则判定为二进制（与 Rust 侧 fs_read_file 一致）。
+          let isBinary = false;
+          const probeLen = Math.min(size, 8192);
+          for (let i = 0; i < probeLen; i++) {
+            if (bytes[i] === 0) {
+              isBinary = true;
+              break;
+            }
+          }
+          if (isBinary) return Promise.resolve({ kind: "binary", size });
+          const limit = FORCE_READ_LIMIT;
+          if (size > limit) {
+            return Promise.resolve({ kind: "toolarge", size, limit });
+          }
+          const content = decodeUtf8(bytes);
+          // sftpRead 不返回 mtime，用 sftpStat 补（冲突检测需要）。
+          return sftpStat(sid, path).then(
+            (attrs): ReadResult => ({
+              kind: "text",
+              content,
+              size,
+              mtime: attrs.modified * 1000,
+            }),
+          );
+        });
+      }
+      return invoke<ReadResult>("fs_read_file", {
+        path,
+        workspace: currentWorkspaceEnv(),
+        force,
+      });
+    },
-    [path],
+    [path, remote, getRustSessionId],
   );
```

### 验证方法

```bash
pnpm typecheck   # 关注：sftpRead/sftpWrite/sftpStat 返回类型与 ReadResult/FileStat 兼容
                 # 关注：useSshStore.getState().sessions.find 的类型推导（SshSessionInfo.rustSessionId: number | null）
pnpm lint        # 关注：import 顺序（@/lib/sftp-bridge < @/modules/ssh-explorer < @/modules/lsp）
pnpm test        # 既有 useDocument 测试不回归；建议补 useDocument.remote.test.ts（见下方）
```

建议新增单测 `src/modules/editor/lib/useDocument.remote.test.ts`：
- mock `sftpRead` 返回 `new Uint8Array([0x68, 0x69])`（"hi"）→ 验证 `doc.status === "ready"`、`doc.content === "hi"`。
- mock `sftpStat` 返回 `{ modified: 1700000000, ... }` → 验证 `diskMtimeRef` = `1700000000000`（秒→毫秒）。
- mock `sftpWrite` + `sftpStat` → 验证保存后 dirty=false、`diskMtimeRef` 更新。
- mock `useSshStore.getState().sessions = []` → 验证 `readFromDisk` reject "SSH session not connected"。

桌面端实测（阶段 6 后统一验证，本阶段单独测需手动注入 remote prop）。

### 回滚方法

单文件 revert `src/modules/editor/lib/useDocument.ts`。`EditorPane` 调用 `useDocument` 时 `remote` 默认 undefined，走原 `invoke("fs_*")` 路径，本地行为不变。

---

## 阶段 3：`useEditorFileSync.ts` 对 remote tab 跳过本地 watch

**改动文件**：`src/modules/editor/useEditorFileSync.ts`（注意：在 `src/modules/editor/` 下，**不是** `lib/` 子目录）

### 改动理由（WHY）

`useEditorFileSync`（`useEditorFileSync.ts:24`）维护本地 fs watch，3 处 effect 对远程 tab 全部无意义且有害：

| effect | 位置 | 远程 tab 的问题 |
|--------|------|----------------|
| `fs:file-written` 监听 | `:44-66` | 远程 `sftpWrite` 不触发本地 `fs:file-written` 事件；但若本地存在同名 path，本地写入会误触发远程 tab reload（path 撞车） |
| watch 集合计算 | `:68-78` | `watchAdd(parentDir(remotePath))` 把远程路径（如 `/etc`）加入本地 fs watch，Rust 侧要么报错要么 watch 无意义路径 |
| `listenFsChanged` 回调 | `:80-99` | 本地 fs:changed 事件不会覆盖远程 path，但 path 撞车时仍会误 reload |

**参考范本**：`SshTerminalHost.tsx:23-28` 的 `remote={true}` 护栏模式（跳过 `pty_has_foreground_job` / `kickPty` / `respawnSession` / `blocks`）。本阶段是对编辑器侧的同类护栏。

`appliedDiffsRef`（AI diff approved reload，`:30-42`）**不跳过**——远程 ai-diff 暂不支持，路径匹配自然 miss，无需特判（方案文档 §1.5）。

### 代码 Diff

#### 3.1 fs:file-written 监听跳过 remote（`src/modules/editor/useEditorFileSync.ts:44-66`）

```diff
--- a/src/modules/editor/useEditorFileSync.ts
+++ b/src/modules/editor/useEditorFileSync.ts
@@ -52,11 +52,14 @@ export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
         (event) => {
           if (event.payload.source === "editor") return;
           const normalizedPath = event.payload.path.replace(/\\/g, "/");
           const currentTabs = tabsRef.current;
           for (const t of currentTabs) {
             if (t.kind !== "editor") continue;
+            // TDSF 魔改 2026-07-30: 远程 tab 不响应本地 fs:file-written
+            // （sftpWrite 不触发此事件；且避免本地同名 path 撞车误 reload）。
+            if (t.remote) continue;
             if (t.path.replace(/\\/g, "/") === normalizedPath) {
               editorRefs.current.get(t.id)?.reload();
             }
           }
         },
```

#### 3.2 watch 集合计算跳过 remote（`src/modules/editor/useEditorFileSync.ts:68-78`）

```diff
--- a/src/modules/editor/useEditorFileSync.ts
+++ b/src/modules/editor/useEditorFileSync.ts
@@ -69,7 +69,11 @@ export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
   const editorWatchRef = useRef<Set<string>>(new Set());
   useEffect(() => {
     const want = new Set<string>();
-    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
+    for (const t of tabs) {
+      if (t.kind !== "editor") continue;
+      // TDSF 魔改 2026-07-30: 远程 tab 不加本地 fs watch（远程路径无意义）。
+      if (t.remote) continue;
+      want.add(parentDir(t.path));
+    }
     const prev = editorWatchRef.current;
     const toAdd = [...want].filter((d) => !prev.has(d));
     const toRemove = [...prev].filter((d) => !want.has(d));
```

#### 3.3 listenFsChanged 回调跳过 remote（`src/modules/editor/useEditorFileSync.ts:80-99`）

```diff
--- a/src/modules/editor/useEditorFileSync.ts
+++ b/src/modules/editor/useEditorFileSync.ts
@@ -83,10 +83,13 @@ export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
     void listenFsChanged((paths) => {
       const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
       for (const t of tabsRef.current) {
         if (t.kind !== "editor") continue;
+        // TDSF 魔改 2026-07-30: 远程 tab 不响应本地 fs:changed
+        // （远程文件变更不触发本地 watch；避免同名 path 撞车误 reload）。
+        if (t.remote) continue;
         if (changed.has(t.path.replace(/\\/g, "/"))) {
           editorRefs.current.get(t.id)?.reload();
         }
       }
     }).then((un) => {
```

### 验证方法

```bash
pnpm typecheck   # Tab 联合类型已含 remote 字段（阶段 1 已扩展），t.remote 访问合法
pnpm lint        # 0 警告
pnpm test        # 既有 useEditorFileSync 测试不回归；建议补 remote tab 跳过 watch 的断言
```

桌面端实测（阶段 6 后）：
- 打开远程文件 tab → 检查 Rust 日志无 `watch_add /etc` 之类远程路径（本地 fs watch 不应监听远程路径）。
- 本地同名文件 `/etc/hosts` 修改 → 远程 `/etc/hosts` tab **不**被误 reload（`fs:file-written` 监听跳过 `t.remote`）。

### 回滚方法

单文件 revert `src/modules/editor/useEditorFileSync.ts`。3 处 `if (t.remote) continue;` 删除后，远程 tab 会被加入本地 watch，但 Rust 侧 `watchAdd` 对远程路径通常报错（被 catch 或忽略），功能不会立即崩溃，只是有潜在误 reload 风险。

---

## 阶段 4：`EditorPane.tsx` 对 remote 跳过 LSP / 外部 formatter / convertFileSrc 媒体预览

**改动文件**：`src/modules/editor/EditorPane.tsx`

### 改动理由（WHY）

`EditorPane`（`EditorPane.tsx:105-627`）有 4 处本地专属逻辑必须对 remote 跳过：

| 逻辑 | 位置 | 跳过理由 |
|------|------|----------|
| `useLspExtension` | `:373-381` | LSP 绑定本地 fs + workspace，远程文件无 LSP server |
| format-on-save（LSP formatter） | `:186` performSave 内 | `lspFormatDocument` 走本地 LSP，远程文件无 LSP |
| format-on-save（外部 formatter） | `:216` performSave 内 | `runExternalFormatter` 起本地进程（prettier/ruff/...），无法处理远程文件 |
| `convertFileSrc` 媒体预览 | `:531-575` | `convertFileSrc` 只处理本地 fs 路径，远程路径返回无效 assetUrl |

**参考范本**：`SshTerminalHost.tsx:121` 的 `<TerminalPane remote={true} />` 标志位模式。本阶段是对编辑器侧的同类护栏，与 `useDocument` 的 `remote` 标志位同构。

### 代码 Diff

#### 4.1 Props 加 remote（`src/modules/editor/EditorPane.tsx:85-91`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -85,11 +85,14 @@ export type EditorPaneHandle = {
 type Props = {
   path: string;
   overrideLanguage?: string | null;
+  /** TDSF 魔改 2026-07-30: 远程文件标记，跳过 LSP/外部 formatter/convertFileSrc 媒体预览。 */
+  remote?: { sessionId: string } | null;
   onDirtyChange?: (dirty: boolean) => void;
   onSaved?: () => void;
   onClose?: () => void;
 };
```

#### 4.2 解构 remote（`src/modules/editor/EditorPane.tsx:107`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -107,7 +107,7 @@ export const EditorPane = memo(
   forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
-    const { path, overrideLanguage, onDirtyChange, onSaved, onClose } = props;
+    const { path, overrideLanguage, remote, onDirtyChange, onSaved, onClose } = props;
```

#### 4.3 useDocument 调用透传 remote（`src/modules/editor/EditorPane.tsx:109-113`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -109,8 +109,9 @@ export const EditorPane = memo(
     const { doc, onChange, save, reload, adoptDiskText, openAnyway } =
       useDocument({
         path,
+        remote,
         onDirtyChange,
       });
```

#### 4.4 performSave 跳过 remote format-on-save（`src/modules/editor/EditorPane.tsx:182-235`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -184,7 +184,9 @@ export const EditorPane = memo(
     const performSave = useCallback(async () => {
       const view = cmRef.current?.view;
       const prefs = usePreferencesStore.getState();
       const formatter = resolveFormatter(languageRef.current, prefs);
-      if (prefs.editorFormatOnSave && formatter === "lsp" && view) {
+      // TDSF 魔改 2026-07-30: 远程文件跳过 format-on-save（LSP/外部 formatter 均走本地，无法处理远程）。
+      if (prefs.editorFormatOnSave && formatter === "lsp" && view && !remote) {
         if (lspActiveRef.current) {
           let res: "done" | "unsupported" = "done";
@@ -213,7 +215,7 @@ export const EditorPane = memo(
       const docAtSave = view?.state.doc;
       const saved = await saveRef.current();
       if (!saved) return;
-      if (prefs.editorFormatOnSave && formatter !== "lsp") {
+      if (prefs.editorFormatOnSave && formatter !== "lsp" && !remote) {
         const error = await runExternalFormatter(
           formatter,
           pathRef.current,
@@ -234,7 +236,7 @@ export const EditorPane = memo(
       }
       onSavedRef.current?.();
-    }, []);
+    }, [remote]);
```

#### 4.5 useLspExtension effect 对 remote 跳过（`src/modules/editor/EditorPane.tsx:373-381`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -373,12 +373,20 @@ export const EditorPane = memo(
     const lspExt = useLspExtension(path, langId, doc.status === "ready");
     useEffect(() => {
+      // TDSF 魔改 2026-07-30: 远程文件不走 LSP（LSP 绑定本地 fs + workspace）。
+      // reconfigure 为空扩展，避免上次本地 tab 残留的 LSP 扩展继续作用于远程文件。
+      if (remote) {
+        lspActiveRef.current = false;
+        const view = cmRef.current?.view;
+        view?.dispatch({ effects: lspCompartment.reconfigure([]) });
+        return;
+      }
       lspActiveRef.current = lspExt !== null;
       const view = cmRef.current?.view;
       if (!view) return;
       view.dispatch({
         effects: lspCompartment.reconfigure(lspExt ?? []),
       });
-    }, [lspExt]);
+    }, [lspExt, remote]);
```

#### 4.6 媒体预览对 remote 退化（`src/modules/editor/EditorPane.tsx:531-575`）

```diff
--- a/src/modules/editor/EditorPane.tsx
+++ b/src/modules/editor/EditorPane.tsx
@@ -529,7 +529,9 @@ export const EditorPane = memo(
       const isPdf = ext === "pdf";

-      if (isImage || isVideo || isAudio || isPdf) {
+      // TDSF 魔改 2026-07-30: 远程文件不走 convertFileSrc（只处理本地 fs 路径），
+      // 退化到下方 "Binary file / File too large" 文案 + Open anyway 按钮。
+      if ((isImage || isVideo || isAudio || isPdf) && !remote) {
         const assetUrl = convertFileSrc(path);
         return (
           <div className="flex h-full min-h-0 flex-col items-center justify-center bg-background p-4 overflow-auto">
```

> **注意**：远程 binary/toolarge 文件会落到 `:578-599` 的 fallback 分支（"Binary file" / "File too large" 文案 + `Open anyway` 按钮）。`Open anyway` 调 `openAnyway` → `readFromDisk(true)`，远程分支忽略 force 全量重读，行为正确。

### 验证方法

```bash
pnpm typecheck   # Props 类型扩展后 EditorStack 传 remote 类型推导正确
pnpm lint        # 0 警告（performSave deps 加 remote，无 exhaustive-deps 警告）
pnpm test        # 0 失败
pnpm build:web   # tsc strict + vite build 成功
```

桌面端实测（阶段 6 后统一验证）：
- 远程 `.py` 文件 → 无 LSP 补全/诊断（`lspActiveRef.current = false`，`lspCompartment.reconfigure([])`）。
- 远程文件 Ctrl+S → 不调 `lspFormatDocument` / `runExternalFormatter`（`!remote` 守卫）。
- 远程 `.png` 文件 → 显示 "Binary file" 文案（不走 `convertFileSrc`）。
- 本地文件 → LSP / formatter / 图片预览全无回归。

### 回滚方法

单文件 revert `src/modules/editor/EditorPane.tsx`。`EditorStack` 传的 `remote` 字段被忽略（Props 无该字段），本地行为不变。

---

## 阶段 5：`EditorStack.tsx` 透传 remote 字段

**改动文件**：`src/modules/editor/EditorStack.tsx`

### 改动理由（WHY）

`EditorStack`（`EditorStack.tsx:16-127`）在 `:114-120` 实例化 `<EditorPane>`，当前只透传 `path/overrideLanguage/onDirtyChange/onClose`，**漏了 `remote`**。阶段 4 的 `EditorPane` Props 已加 `remote`，本阶段把 `EditorTab.remote` 透传过去，闭合整条链路。

`EditorStack` 的 `editors` filter（`:24-26`）按 `t.kind === "editor" && !t.cold`，**无需改动**——远程 tab 仍是 `kind === "editor"`，自然进入 filter。

### 代码 Diff

#### 5.1 EditorPane 实例化加 remote（`src/modules/editor/EditorStack.tsx:114-120`）

```diff
--- a/src/modules/editor/EditorStack.tsx
+++ b/src/modules/editor/EditorStack.tsx
@@ -114,11 +114,12 @@ export function EditorStack({
               )}
               <EditorPane
                 ref={getRefCallback(t.id)}
                 path={t.path}
                 overrideLanguage={t.overrideLanguage}
+                remote={t.remote ?? null}
                 onDirtyChange={getDirtyCallback(t.id)}
                 onClose={getCloseCallback(t.id)}
               />
```

### 验证方法

```bash
pnpm typecheck   # EditorTab.remote 已是可选字段，t.remote 访问合法
pnpm lint        # 0 警告
pnpm test        # 0 失败
pnpm build:web   # 成功
```

桌面端实测（阶段 6 后）：打开远程文件 → `EditorPane` 收到 `remote={{ sessionId: "..." }}` → `useDocument` 收到 → `sftpRead` 被调用（链路闭合验证）。

### 回滚方法

单文件 revert `src/modules/editor/EditorStack.tsx`。删除 `remote={t.remote ?? null}` 后，`EditorPane` 的 `remote` prop 为 undefined，走本地 fs 路径，本地行为不变。

---

## 阶段 6：`App.tsx` 改 handleOpenRemoteFile + 删侧栏 SshFileEditor 挂载

**改动文件**：
- `src/app/App.tsx`（改 `handleOpenRemoteFile` + 删 import + 删挂载）
- `src/modules/ssh-explorer/SshFileEditor.tsx`（**删除整个文件**）
- `src/modules/ssh-explorer/index.ts`（删 `:8` 的 `export { SshFileEditor }`）

### 改动理由（WHY）

当前远程文件点击走 `handleOpenRemoteFile`（`App.tsx:777-784`）→ `useSshStore.openFile`（`sshStore.ts:894-933`）→ 侧栏 `SshFileEditor`（`App.tsx:1517-1519` 挂载）的 **单文件 singleton textarea** 链路。这与本地文件走主区 `EditorStack` + CodeMirror 的体验严重割裂：

- 远程编辑器是原生 `<textarea>`（`SshFileEditor.tsx:207`），无语法高亮 / 无 LSP / 无快捷键 / 无多 tab。
- 一次只能编辑一个远程文件（`editingFile` singleton，`sshStore.ts:133`）。
- 与 `SshTerminalHost` 已接管主区终端的模式（`App.tsx:1580`）不一致。

本阶段把远程文件点击改走 `openFileTab(path, false, { sessionId })`（阶段 1 已支持第三参），让远程文件复用主区 `EditorStack` + CodeMirror + 多 tab，与本地文件体验一致。`SshFileEditor` 侧栏 textarea 整体废弃删除。

**`pin = false` 理由**：与本地单击行为一致（preview tab，VSCode 风格——二次单击其他文件替换槽位，双击 tab 标题转 persistent）。

**sshStore 成员保留**：`editingFile` / `openFile` / `saveFile` / `closeEditor` / `updateEditorContent` 五个成员**不删**（避免一次性删太多破坏面），阶段 6 后它们无任何组件引用，后续清理 PR 再移除。

### 代码 Diff

#### 6.1 handleOpenRemoteFile 改调 openFileTab（`src/app/App.tsx:776-784`）

```diff
--- a/src/app/App.tsx
+++ b/src/app/App.tsx
@@ -776,10 +776,11 @@
-  // TDSF 魔改 2026-07-29: 远程文件点击后调用 SSH 编辑器
+  // TDSF 魔改 2026-07-30: 远程文件点击改走主区 EditorStack（多 tab 并行），
+  // 废弃侧栏 SshFileEditor（单文件 singleton textarea）。
   const handleOpenRemoteFile = useCallback(
     (path: string) => {
       if (!activeSshSessionId) return;
-      const name = path.slice(path.lastIndexOf("/") + 1) || path;
-      void useSshStore.getState().openFile(activeSshSessionId, path, name);
+      openFileTab(path, false, { sessionId: activeSshSessionId });
     },
-    [activeSshSessionId],
+    [activeSshSessionId, openFileTab],
   );
```

#### 6.2 删 SshFileEditor import（`src/app/App.tsx:85-86`）

```diff
--- a/src/app/App.tsx
+++ b/src/app/App.tsx
@@ -83,7 +83,4 @@
   selectActiveSession,
   selectActiveSessionCurrentPath,
   useSshStore,
 } from "@/modules/ssh-explorer";
-// TDSF 魔改 2026-07-29: SSH 远程文件编辑器（远程文件点击后编辑）
-import { SshFileEditor } from "@/modules/ssh-explorer/SshFileEditor";
 import { StatusBar } from "@/modules/statusbar";
```

#### 6.3 删侧栏 SshFileEditor 挂载（`src/app/App.tsx:1515-1519`）

```diff
--- a/src/app/App.tsx
+++ b/src/app/App.tsx
@@ -1513,9 +1513,4 @@
                           />
                           </div>
-                          {/* TDSF 魔改 2026-07-30: 远程文件编辑器与文件树上下二分,
-                             避免被 FileExplorer(h-full) 挤成 1px 不可见 */}
-                          {explorerSource === "ssh" ? (
-                            <SshFileEditor className="min-h-0 flex-1" />
-                          ) : null}
                         </div>
                       ) : sidebarView === "source-control" ? (
```

> **注意**：删除后，`explorerSource === "ssh"` 分支只剩 `<FileExplorer source="ssh" .../>`（`:1485-1513`）。`FileExplorer` 的 `h-full` 不再被 `SshFileEditor` 二分，远程文件树占满整个侧栏高度，与本地文件树布局一致。这是预期行为。

#### 6.4 删 SshFileEditor.tsx 文件

```diff
--- a/src/modules/ssh-explorer/SshFileEditor.tsx
+++ /dev/null
@@ -1,224 +0,0 @@
-// TDSF 魔改 (P4-T4.1): SSH 远程文件编辑器
-// ...（整个文件 224 行全部删除）
-（内容见 src/modules/ssh-explorer/SshFileEditor.tsx:1-224，含 detectLang + SshFileEditor 组件）
```

#### 6.5 删 index.ts 的 SshFileEditor export（`src/modules/ssh-explorer/index.ts:8`）

```diff
--- a/src/modules/ssh-explorer/index.ts
+++ b/src/modules/ssh-explorer/index.ts
@@ -5,7 +5,6 @@
 export { SshConnectDialog } from './SshConnectDialog';
 export { SshFileTree } from './SshFileTree';
-export { SshFileEditor } from './SshFileEditor';
 export { SshFileTransfer } from './SshFileTransfer';
 // TDSF 魔改 (#19): SshTerminalPane（裸 xterm）已删除, 改用 SshTerminalHost
```

> **注意**：`index.ts:19` 的 `type SshEditingFile` export **保留**（`sshStore.ts` 的 `SshEditingFile` 类型仍存在，阶段 6 不删 store 成员）。若 lint 报 `SshEditingFile` unused export，可暂时保留（后续清理 PR 连同 store 成员一起删）。

### 验证方法

```bash
pnpm typecheck   # 关注：全局无残留 SshFileEditor 引用（grep -r "SshFileEditor" src/ 应只在 git 历史中）
pnpm lint        # 关注：无 unused import（App.tsx:86 import 已删）；无未使用变量
pnpm test        # 0 失败
pnpm build:web   # 成功
pnpm tauri:dev   # 桌面端实测（核心验证）
```

**桌面端实测脚本**（前置：SSH 自动登录最近会话，左侧 FileExplorer 切换为远程文件树）：

| # | 操作 | 预期 |
|---|------|------|
| 1 | 双击远程 `/etc/hostname` | 主区出现 editor tab（preview），标题 `hostname`，内容显示主机名（**不再是侧栏 textarea**） |
| 2 | 双击远程 `/etc/passwd` | preview tab 被 hostname 替换（VSCode 风格单一 preview slot） |
| 3 | 单击 preview tab 标题 | tab 转 persistent（pin） |
| 4 | 双击 tab 标题 | 同上（pinTab） |
| 5 | 编辑 `/tmp/test.txt`（远程先 `touch`）→ Ctrl+S | 远程文件确实保存（`cat /tmp/test.txt` 验证），dirty 圆点消失 |
| 6 | 同时打开 3 个远程文件 tab | 切换不丢失内容，无 reload 抖动 |
| 7 | 关闭远程 tab | editorRefs 清理（`EditorStack.tsx:78-89` 的 live set 清理），无报错 |
| 8 | 断开 SSH（侧栏点断开）→ 双击远程文件 | 报错 "SSH session not connected"（`getRustSessionId` 返回 null，`readFromDisk` reject） |
| 9 | 重连 SSH → 重试打开远程文件 | 正常打开（`rustSessionId` 实时查询生效，不缓存） |
| 10 | 本地文件编辑（不连 SSH） | 完全无回归（保存/LSP/格式化/图片预览） |
| 11 | 连接 SSH + 本地文件 + 远程文件混用 | 两种 tab 并存，互不干扰（去重 key = path + sessionId） |
| 12 | 远程 `.py` 文件 → Ctrl+S | 不调 LSP formatter / 外部 formatter（`!remote` 守卫） |
| 13 | 远程 `.png` 文件 | 显示 "Binary file" 文案（不走 `convertFileSrc`） |

**诊断手段**（参考 CLAUDE.md §5）：
- 若主区空白：CDP 连 9222 截图确认是否渲染。
- 若保存失败：console 看 `[editor] save failed` / `[sftp-bridge]` 日志；检查 `getRustSessionId` 是否返回 null。
- 若 dirty 不消失：检查 `diskMtimeRef.current` 是否正确设置（`sftpStat` 返回值 `* 1000`）。
- 若远程文件内容乱码：检查 `decodeUtf8` 是否正确（`sftp-bridge.ts:188`）。

### 回滚方法

保留阶段 6 之前的 commit，整体 revert 即可恢复 `SshFileEditor` 侧栏 textarea 链路。具体：
1. `git revert <阶段6 commit>` 恢复 `App.tsx` / `SshFileEditor.tsx` / `index.ts`。
2. 阶段 1-5 的 `remote` 字段保留也无害（`handleOpenRemoteFile` 走回 `sshStore.openFile`，`remote` 字段不被使用）。

---

## 五绿门禁汇总（CLAUDE.md §4）

按顺序执行，全绿才算完成：

```bash
pnpm typecheck        # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint             # eslint . --max-warnings 0，0 错误 0 警告
pnpm test             # vitest run，0 失败（建议补 useDocument.remote.test.ts）
pnpm build:web        # tsc -p app + vite build，成功出 dist
pnpm tauri:dev        # 桌面端实测（阶段 6 验证脚本 13 条用例）
```

### typecheck 关注点
- `EditorTab.remote` 在 `Tab` 联合类型解构处不报 undefined（已是可选字段）。
- `useDocument` 的 `Options.remote` 扩展后，`EditorPane` 调用处的类型推导正确。
- `sftpRead/sftpWrite/sftpStat` 返回类型与 `ReadResult/FileStat` 兼容（注意 mtime 秒→毫秒 `* 1000`）。
- `useSshStore.getState().sessions.find(...)?.rustSessionId` 类型推导为 `number | null`。

### lint 关注点
- 新增 import 顺序（`@/lib/sftp-bridge` < `@/modules/ssh-explorer` < `@/modules/lsp`）符合现有 import 排序规则。
- 无 `// @ts-ignore`、无散落 `eslint-disable`。
- `useDocument` 内 if/else 分支无未使用变量。
- `performSave` deps 加 `remote`，无 `react-hooks/exhaustive-deps` 警告。

### test 关注点
- 既有 `useTabs` 测试不回归（`openFileTab` 第三参可选，不破坏既有调用）。
- 既有 `useDocument` 若有单测，需补 remote 分支 mock。
- 既有 `useEditorFileSync` 若有单测，需补 remote tab 跳过 watch 的断言。
- 建议新增：`src/modules/editor/lib/useDocument.remote.test.ts`（mock `sftpRead/sftpWrite/sftpStat` + `useSshStore.getState()`，验证远程读/写/冲突检测路径）。

### build:web 关注点
- Vite 6 + tsc strict 不报类型错误。
- 无 dynamic import 失败（sftp-bridge 是同步 import，无 lazy）。

### tauri:dev 关注点
- 阶段 6 的 13 条桌面端实测用例全过。
- 诊断手段参考 CLAUDE.md §5（CDP 9222 + 截图 + Profiler）。

---

## 与 SshTerminalHost 兼容性确认（方案文档 §5 摘要）

### 共用 SSH 连接（关键约束）
`SshTerminalHost.tsx:92-95` 明确：`close` 只 unsubscribe 前端订阅，不断底层 SSH 连接，因为 **SFTP 文件树共用同一条 SSH 连接**。

本方案兼容性：
- 编辑器调 `sftpRead/sftpWrite/sftpStat` 走 `rustSessionId`（来自 `sshStore.sessions[].rustSessionId`），与 `SshTerminalHost` 走的 `session.handle`（PTY channel）是同一条 SSH 连接的两个 channel（SFTP channel + PTY channel）。
- 编辑器**绝不调** `handle.close()`，与 SshTerminalHost 一致。
- 编辑器 tab 关闭只清理前端 state（`closeTab`），不影响 SSH 连接。

### remote 标志位模式对齐

| 模块 | remote 标志位置 | 跳过的本地专属逻辑 |
|------|----------------|--------------------|
| SshTerminalHost | `SshTerminalHost.tsx:121` `<TerminalPane remote={true} />` | pty_has_foreground_job / kickPty SIGWINCH / respawnSession / blocks |
| EditorPane（本方案） | `EditorPane.tsx` Props `remote` | LSP / 外部 formatter / convertFileSrc 媒体预览 |
| useDocument（本方案） | `useDocument.ts` Options `remote` | fs_read_file → sftpRead / fs_write_file → sftpWrite / fs_stat → sftpStat |
| useEditorFileSync（本方案） | `useEditorFileSync.ts` 检查 `t.remote` | watchAdd/watchRemove / listenFsChanged / fs:file-written |

**同构性**：本方案完全复刻 SshTerminalHost 的 remote 护栏模式，架构一致。

### leafId / allocId 不冲突
`SshTerminalHost.tsx:49-53` 通过 `allocId()` 分配稳定 leafId，与本地 leaf 共享 `useTabs.nextIdRef` 计数器。本方案 `EditorTab.id` 由 `openFileTab` 内 `nextIdRef.current++` 分配（`useTabs.ts:637/674`），与 terminal leaf 共享同一计数器，**不会撞号**。

### 状态隔离与竞态
- SSH 断开时用户尝试保存远程文件 → `getRustSessionId` 返回 null → `writeToDisk` 抛 "SSH session not connected" → toast 提示。
- SSH 重连后 `rustSessionId` 变化 → `useDocument` 下次调用 `getRustSessionId` 自动取新值（不缓存）。
- tab 打开后 SSH 断开 → tab 内容仍在内存（`bufferRef` 不丢）→ 用户重连后可继续保存。

### WorkspaceSurface 接管模式对齐
`App.tsx:380` (`showSshTerminalInWorkspace`) + `:1580` (`sshSessionId` prop) 已把 SSH 终端接管到主区 terminal tab。本方案把 SSH 文件编辑器也接管到主区 editor tab，**与终端接管模式完全对齐**，UI 一致性良好。

---

## 与已废弃自研 v4.0.0 的隔离（CLAUDE.md §0 铁律 2）

本方案严格遵守：
- 所有改造基于 crynta/terax-ai v0.8.6 既有架构（EditorTab / EditorStack / EditorPane / useDocument / useEditorFileSync）。
- 新增的 `remote` 字段、sftp 分流逻辑、LSP/formatter 跳过逻辑，均为对 terax 原生架构的**最小侵入扩展**，不引入任何自研 v4.0.0 概念。
- `SshFileEditor` 废弃后，不引入任何替代的"自研编辑器"，完全复用 terax 的 CodeMirror EditorPane。

---

## 引用索引（file:line，实施时定位用）

### App.tsx
- `src/app/App.tsx:85-86` — SshFileEditor import（**阶段 6 删**）
- `src/app/App.tsx:159` — openFileTab 解构
- `src/app/App.tsx:360-365` — activeSshSession / activeSshSessionId / isConnectedSsh
- `src/app/App.tsx:479` — useEditorFileSync 调用
- `src/app/App.tsx:765-774` — handleOpenFile（本地，不改）
- `src/app/App.tsx:776-784` — handleOpenRemoteFile（**阶段 6 改**）
- `src/app/App.tsx:804-823` — handlePathRenamed（不改，远程不支持重命名）
- `src/app/App.tsx:838-856` — activeFilePath / explorerActiveFilePath（不改，远程 tab 同样适用）
- `src/app/App.tsx:1485-1489` — FileExplorer.onOpenFile 分流（不改）
- `src/app/App.tsx:1515-1519` — SshFileEditor 挂载（**阶段 6 删**）
- `src/app/App.tsx:1580-1581` — WorkspaceSurface sshSessionId/allocId（不改）

### tabs/lib/useTabs.ts
- `src/modules/tabs/lib/useTabs.ts:47-60` — EditorTab 类型（**阶段 1 扩展**）
- `src/modules/tabs/lib/useTabs.ts:620` — openFileTab 签名（**阶段 1 加第三参**）
- `src/modules/tabs/lib/useTabs.ts:625-627` — 持久 tab 去重（**阶段 1 改 matchRemote**）
- `src/modules/tabs/lib/useTabs.ts:637-650` — 持久 tab 新建（**阶段 1 注入 remote**）
- `src/modules/tabs/lib/useTabs.ts:653-655` — preview persistent 去重（**阶段 1 改 matchRemote**）
- `src/modules/tabs/lib/useTabs.ts:662-665` — preview reuse 去重（**阶段 1 改 matchRemote**）
- `src/modules/tabs/lib/useTabs.ts:676-684` — preview tab 新建（**阶段 1 注入 remote**）

### editor/lib/useDocument.ts
- `src/modules/editor/lib/useDocument.ts:9-14` — ReadResult / FileStat 类型（不改）
- `src/modules/editor/lib/useDocument.ts:17` — FORCE_READ_LIMIT（不改，远程沿用）
- `src/modules/editor/lib/useDocument.ts:26-29` — Options 类型（**阶段 2 加 remote**）
- `src/modules/editor/lib/useDocument.ts:31` — useDocument 签名（**阶段 2 加 remote**）
- `src/modules/editor/lib/useDocument.ts:61-74` — writeToDisk（**阶段 2 分流 sftpWrite**）
- `src/modules/editor/lib/useDocument.ts:78-97` — saveNow（**阶段 2 分流 sftpStat**）
- `src/modules/editor/lib/useDocument.ts:130-138` — readFromDisk（**阶段 2 分流 sftpRead**）

### editor/useEditorFileSync.ts
- `src/modules/editor/useEditorFileSync.ts:30-42` — AI diff approved reload（不改）
- `src/modules/editor/useEditorFileSync.ts:44-66` — fs:file-written 监听（**阶段 3 跳过 remote**）
- `src/modules/editor/useEditorFileSync.ts:68-78` — watchAdd/watchRemove（**阶段 3 跳过 remote**）
- `src/modules/editor/useEditorFileSync.ts:80-99` — listenFsChanged（**阶段 3 跳过 remote**）

### editor/EditorPane.tsx
- `src/modules/editor/EditorPane.tsx:85-91` — Props 类型（**阶段 4 加 remote**）
- `src/modules/editor/EditorPane.tsx:107` — 解构（**阶段 4 加 remote**）
- `src/modules/editor/EditorPane.tsx:109-113` — useDocument 调用（**阶段 4 透传 remote**）
- `src/modules/editor/EditorPane.tsx:182-235` — performSave（**阶段 4 跳过 remote format-on-save**）
- `src/modules/editor/EditorPane.tsx:373-381` — useLspExtension（**阶段 4 跳过 remote**）
- `src/modules/editor/EditorPane.tsx:516-575` — 媒体预览（**阶段 4 跳过 remote**）
- `src/modules/editor/EditorPane.tsx:532` — convertFileSrc（不适用远程，通过 :531 守卫跳过）

### editor/EditorStack.tsx
- `src/modules/editor/EditorStack.tsx:7-14` — Props 类型（不改）
- `src/modules/editor/EditorStack.tsx:24-26` — editor tab filter（不改，远程 tab 自然进入）
- `src/modules/editor/EditorStack.tsx:114-120` — EditorPane 实例化（**阶段 5 加 remote**）

### ssh-explorer/
- `src/modules/ssh-explorer/SshFileEditor.tsx:1-224` — 整个文件（**阶段 6 删除**）
- `src/modules/ssh-explorer/sshStore.ts:43-58` — SshSessionInfo（不改，rustSessionId 字段供 getRustSessionId 查询）
- `src/modules/ssh-explorer/sshStore.ts:61-78` — SshEditingFile 类型（阶段 6 保留，后续清理 PR 删）
- `src/modules/ssh-explorer/sshStore.ts:133` — editingFile state（阶段 6 保留）
- `src/modules/ssh-explorer/sshStore.ts:202-205` — openFile/saveFile/closeEditor/updateEditorContent actions（阶段 6 保留）
- `src/modules/ssh-explorer/sshStore.ts:894-933` — openFile 实现（阶段 6 后无引用，保留）
- `src/modules/ssh-explorer/sshStore.ts:1129-1132` — selectActiveSession（不改）
- `src/modules/ssh-explorer/SshTerminalHost.tsx:23-28` — remote=true 护栏模式（**参考范本**）
- `src/modules/ssh-explorer/SshTerminalHost.tsx:92-95` — close 不断底层 SSH（**关键约束**）
- `src/modules/ssh-explorer/SshTerminalHost.tsx:121` — remote={true} 标记（**参考范本**）
- `src/modules/ssh-explorer/index.ts:8` — SshFileEditor export（**阶段 6 删**）
- `src/modules/ssh-explorer/index.ts:12` — SshTerminalHost export（不改）
- `src/modules/ssh-explorer/index.ts:19` — SshEditingFile type export（阶段 6 保留）

### lib/
- `src/lib/sftp-bridge.ts:58-71` — SftpAttrs 类型（modified **秒级**，关键风险点 1）
- `src/lib/sftp-bridge.ts:105-110` — sftpStat（**阶段 2 调用**）
- `src/lib/sftp-bridge.ts:120-127` — sftpRead（返回 Uint8Array，**阶段 2 调用**）
- `src/lib/sftp-bridge.ts:136-147` — sftpWrite（传 Uint8Array，无返回 mtime，**阶段 2 调用**）
- `src/lib/sftp-bridge.ts:188-195` — decodeUtf8（**阶段 2 调用**）
- `src/lib/sftp-bridge.ts:202-204` — encodeUtf8（**阶段 2 调用**）
- `src/modules/explorer/lib/watch.ts:49` — parentDir（不改，阶段 3 调用）

### 文档
- `CLAUDE.md` §0 — 项目身份铁律
- `CLAUDE.md` §3 — 防污染红线
- `CLAUDE.md` §4 — 五绿门禁
- `CLAUDE.md` §5 — 诊断方法论
- `docs/dev-state.md` — 当前状态/已知问题
- `docs/reports/ssh-editor-integration-plan.md` — 配套方案（824 行）
