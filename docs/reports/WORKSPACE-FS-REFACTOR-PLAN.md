# TDSF 文件系统视图重构方案书：WorkspaceFs 抽象（v0.1 草案）

> **状态**：调研中（deep-research 进行时）· 待用户审阅
> **日期**：2026-08-08
> **背景**：SSH 资源管理器闪跳/空白根因（方案书 P2 已立项）——用户指定参考 yazi 架构，先调研后动手
> **对标**：[sxyazi/yazi](https://github.com/sxyazi/yazi)（41k stars，Rust 异步终端文件管理器）

---

## 1. 问题定义（现状诊断）

### 1.1 现象（用户实测 + 日志铁证）
1. 创建 SSH Space 后：左侧资源管理器**闪一下远程文件列表**（远程 `/` 22 entries 加载成功）→ **突然消失** → 回退"桌面资源管理器"且**一片空白**
2. 日志：远程 `/` 成功后，**持续用本地路径 `C:/Users/Lenovo` 请求 SFTP**（每秒一次，全部 `No such file`）
3. 窗口标题不同步（仍显示本地目录名）

### 1.2 结构性根因（非单一 bug）
| 问题 | 说明 |
|------|------|
| 双树 prop 切换 | FileExplorer 用 `source="local"\|"ssh"` 在 useFileTree / useRemoteFileTree 两套独立实现间切换 |
| 状态三分散 | 数据源（两套 hook）、路径（explorerRoot/effectiveExplorerRoot/currentPathBySession）、会话（spaceSshSession/全局 activeSshSession fallback）不在同一 store |
| 时序竞态 | 创建流程中 Space 切换（setActive）、会话状态（connected）、source 判定（isSpaceSshConnected）异步交错 → 中间态：source 闪回 local 但路径仍远程 → 本地树加载远程路径 → 空白 |
| 无能力声明 | 本地/远程功能差异（重命名/删除/拖拽）散落条件判断，无统一契约 |

---

## 2. 调研结论：yazi 架构借鉴（摘要，完整报告见 deep-research 输出）

### 2.1 yazi 的 Engine trait（核心对标）
```rust
pub trait Engine: Sized {
    type File: AsyncRead + AsyncSeek + AsyncWrite + Unpin;
    type ReadDir: DirReader + 'static;
    // 操作集: absolute/canonicalize/capabilities/casefold/copy/
    //         create/create_dir/read_dir/remove/rename/...（完整文件语义）
}
impl Engine for Local { type File = tokio::fs::File; ... }  // 本地实现
```
- **抽象层定义完整文件操作语义，实现层提供后端**（yazi 当前只有 Local；远程=未来 VFS provider）
- `capabilities()` 返回能力集（symlink/hard_link/trash/copy_progressive）——**远程实现可声明不同能力**，UI 按能力禁用操作
- 异步 IO（tokio）贯穿：所有文件操作 async，无阻塞

### 2.2 yazi 其他可借鉴点
- **异步任务调度**：进度/取消/优先级（批量复制/删除不卡 UI）
- **插件系统（Lua）**：UI 插件重写大部分界面——TDSF 不需要（React 已覆盖），但"fetcher/previewer 可插拔"思路可用于远程文件预览
- **数据分发（client-server + pub-sub）**：跨实例状态同步——TDSF 的 SSH 会话事件流可对标

### 2.3 TDSF 的约束差异（不能照搬）
| 维度 | yazi | TDSF |
|------|------|------|
| 前端 | 终端 TUI（Rust 全栈） | React 19 + Tauri（前端主导 UI） |
| 本地文件 | tokio::fs 直接访问 | Tauri FS 插件（Rust 侧） |
| 远程文件 | VFS provider（规划） | russh SFTP（已有，Rust 侧会话管理） |
| 架构约束 | 单进程 Rust | 三层（React ⇄ Tauri Rust ⇄ Python sidecar） |

**结论**：借鉴 **Engine trait 抽象思路**（定义操作契约 + 能力声明 + 实现分层），但落地为 **Rust 侧统一的 FsBackend trait + 前端单一 WorkspaceFs store**，而非照搬 yazi 代码。

---

## 3. 目标架构：WorkspaceFs

### 3.1 总览
```
┌─ 前端（React）─────────────────────────────┐
│  useWorkspaceFs(spaceId)                   │
│  ├─ 数据：单一 store（根路径/树状态/加载态） │
│  ├─ 操作：list/read/write/rename/delete/   │
│  │         mkdir/create（统一 API）         │
│  └─ 能力：capabilities（按 Space 环境）     │
└──────────────┬────────────────────────────┘
               │ Tauri invoke
┌──────────────▼────────────────────────────┐
│  Rust: FsBackend trait                    │
│  ├─ LocalFs   （tauri_plugin_fs / std::fs）│
│  └─ SftpFs    （russh SFTP 会话，复用现有） │
│  每个 Space 持有 backend 实例，生命周期    │
│  与会话绑定（断开→明确降级状态）            │
└───────────────────────────────────────────┘
```

### 3.2 核心设计
1. **Rust 侧 `FsBackend` trait**（新模块 `src-tauri/src/modules/fs_backend/`）：
   ```rust
   #[async_trait]
   pub trait FsBackend: Send + Sync {
       fn kind(&self) -> FsKind;                       // Local | Sftp
       fn capabilities(&self) -> FsCapabilities;        // rename/delete/trash...
       async fn list(&self, path: &str) -> Result<Vec<DirEntry>>;
       async fn read(&self, path: &str) -> Result<Vec<u8>>;
       async fn write(&self, path: &str, data: &[u8]) -> Result<()>;
       async fn rename(&self, from: &str, to: &str) -> Result<()>;
       async fn delete(&self, path: &str) -> Result<()>;
       async fn mkdir(&self, path: &str) -> Result<()>;
       fn resolve_root(&self, space_env: &WorkspaceEnv) -> String;  // 本地盘符 / 远程 root
   }
   ```
2. **前端单一 store `workspaceFsStore`**：`{ spaceId, backend, rootPath, tree, loading, error }`——**Space 切换时整体替换**（原子 set），无 prop 中间态
3. **Space 生命周期绑定**：Space 创建/激活时构建 backend（Local 恒有；Sftp 绑定会话，会话断开 → `error: "连接已断开"` 明确降级 + 重连入口，**绝不静默回退本地**）
4. **路径语义由实现层保证**：LocalFs 只接受盘符/UNC；SftpFs 只接受 `/` 开头绝对路径——**跨源路径泄漏在边界被拒绝**

### 3.3 迁移路径（渐进，不破坏现有）
| 阶段 | 内容 | 风险 |
|------|------|------|
| P2-1 | Rust FsBackend trait + LocalFs 实现（封装现有 fs 命令） | 低（纯新增） |
| P2-2 | SftpFs 实现（复用 russh SFTP 会话与缓存） | 中（并发/超时） |
| P2-3 | 前端 workspaceFsStore + FileExplorer 改为消费 store（删 useFileTree/useRemoteFileTree 双轨） | 高（UI 回归） |
| P2-4 | 能力声明接入 UI（远程禁操作项）、断开降级 UI、步骤链条可视化对接 | 低 |

### 3.4 验证标准（用户视角 R9）
- 创建 SSH Space → 资源管理器**无闪跳**直接显示远程树
- Space 切换（本地↔SSH）→ 树原子切换，无中间态/空白
- 会话断开 → 明确降级提示（非静默回退）
- 门禁：typecheck/lint/test/cargo/pytest 全绿 + CDP 用户视角断言（树内容/标题）

---

## 4. 待确认
1. 重构范围：是否含**编辑器远程文件**（当前 openRemoteFile 的读写路径）一并纳入 FsBackend？（建议纳入，统一读写语义）
2. 本地实现是否复用现有 `fs` Tauri 命令还是新建？——倾向复用现有命令做薄封装（减少回归面）
3. 优先级：P2-1 先行（低风险打地基）还是整体排期？
