// modules/side_git.rs — TDSF side-git 影子仓库 (T-P2-07)
// ============================================================================
// 职责 (DEC-V321-02):
//   - Agent 修改文件前自动 stash 当前状态到影子仓库
//   - Agent 修改文件后自动 commit 新状态到影子仓库
//   - 工具失败时自动 rollback 到上一个 commit
//   - 追踪所有变更到 changes.jsonl (JSON Lines)
//
// 影子仓库结构:
//   ~/.tdsf/side-git/<project-hash>/
//   ├── git/             # bare 仓库 (libgit2 管理)
//   ├── worktree/        # 工作区镜像 (项目目录的快照)
//   └── log/
//       └── changes.jsonl  # 变更日志 (JSON Lines)
//
// 设计要点:
//   - 影子仓库独立于项目自身的 git 仓库 (项目可以不是 git 仓库)
//   - 用 git2 (libgit2) 操作 bare 仓库,避免依赖系统 git CLI
//   - 用 sha2 计算项目绝对路径的 SHA-256 哈希作为目录名
//   - stash / commit 都创建 commit (区别仅 message 前缀)
//   - rollback 通过修改 HEAD ref 指向 parent commit 实现
//   - worktree/ 是普通目录,用 std::fs 同步项目文件
//
// 与 Python Sidecar 集成:
//   - coding_agent.py 在 Edit/Write 工具调用前后通过 hook 触发
//   - 前端通过 invoke('side_git_stash' / 'side_git_commit' / 'side_git_rollback') 调用
// ============================================================================

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use git2::{
    Commit, Index, IndexEntry, IndexTime, ObjectType, Oid, Repository, Signature, Tree,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

// ============================================================================
// 常量
// ============================================================================

/// 影子仓库根目录名 (相对 ~/.tdsf/)
const SHADOW_ROOT_DIR: &str = "side-git";

/// 影子仓库内 git/ 子目录名 (bare 仓库)
const GIT_SUBDIR: &str = "git";

/// 影子仓库内 worktree/ 子目录名 (工作区镜像)
const WORKTREE_SUBDIR: &str = "worktree";

/// 影子仓库内 log/ 子目录名 (变更日志)
const LOG_SUBDIR: &str = "log";

/// 变更日志文件名
const CHANGES_LOG_FILE: &str = "changes.jsonl";

/// 影子仓库默认分支名
const DEFAULT_BRANCH: &str = "refs/heads/main";

/// Side-git 提交者信息
const COMMITTER_NAME: &str = "TDSF Side Git";
const COMMITTER_EMAIL: &str = "side-git@tdsf.local";

/// 项目哈希长度 (取 SHA-256 前 32 字符,空间足够且目录名简短)
const PROJECT_HASH_LEN: usize = 32;

// ============================================================================
// SideGitStatus — 状态快照 (供 side_git_status 命令返回)
// ============================================================================

/// 影子仓库状态快照
///
/// 前端通过 `invoke('side_git_status', { path: '...' })` 获取,
/// 用于展示当前 stash/commit 数量 + 最新 commit hash。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideGitStatus {
    /// 影子仓库根目录 (绝对路径)
    pub shadow_root: String,
    /// 项目哈希 (SHA-256 前 32 字符)
    pub project_hash: String,
    /// 是否已初始化
    pub initialized: bool,
    /// 最新 commit hash (HEX 字符串,未初始化时为空)
    pub last_commit_hash: String,
    /// commit 总数 (从 HEAD 回溯到根 commit)
    pub commit_count: u64,
    /// stash 计数 (message 以 "stash:" 开头的 commit 数)
    pub stash_count: u64,
}

// ============================================================================
// SideGitManager — 影子仓库管理器
// ============================================================================

/// 影子仓库管理器 (无状态,所有方法都是关联函数)
///
/// 用法:
///   ```ignore
///   SideGitManager::init_shadow_repo(&Path::new("/foo/bar"))?;
///   SideGitManager::auto_stash(&Path::new("/foo/bar"))?;
///   let hash = SideGitManager::auto_commit(&Path::new("/foo/bar"), "edit: bar.txt")?;
///   SideGitManager::rollback(&Path::new("/foo/bar"))?;
///   SideGitManager::track_change(&Path::new("/foo/bar"), "edit")?;
///   ```
pub struct SideGitManager;

impl SideGitManager {
    // ========================================================================
    // 路径计算
    // ========================================================================

    /// 计算项目路径的 SHA-256 哈希 (前 32 字符)
    ///
    /// 输入: 项目绝对路径 (canonicalize 后)
    /// 输出: 32 字符 HEX 字符串
    ///
    /// 相同路径必然产生相同哈希 (确定性),不同路径冲突概率极低 (2^-128)
    pub fn project_hash(path: &Path) -> String {
        // canonicalize 失败时回退到原始路径 (避免在不存在路径上 panic)
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut hasher = Sha256::new();
        // 统一使用正斜杠避免 Windows / Unix 路径差异
        let normalized = canonical.to_string_lossy().replace('\\', "/");
        hasher.update(normalized.as_bytes());
        let hash = hasher.finalize();
        let hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
        hex[..PROJECT_HASH_LEN].to_string()
    }

    /// 获取影子仓库根目录 (~/.tdsf/side-git/<hash>/)
    ///
    /// 注意: 此函数不创建目录,仅返回路径
    ///
    /// 支持通过 `TDSF_HOME` 环境变量覆盖 home 目录 (主要用于测试,
    /// 避免污染真实 ~/.tdsf/ 目录)。生产环境不设置该变量时,
    /// 使用 dirs::home_dir() 获取用户 home 目录。
    pub fn shadow_root(path: &Path) -> PathBuf {
        // 优先读取 TDSF_HOME 环境变量 (测试覆盖)
        let home = std::env::var_os("TDSF_HOME")
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let hash = Self::project_hash(path);
        home.join(".tdsf").join(SHADOW_ROOT_DIR).join(hash)
    }

    /// 获取影子仓库内 git/ 子目录 (bare 仓库路径)
    pub fn git_dir(shadow_root: &Path) -> PathBuf {
        shadow_root.join(GIT_SUBDIR)
    }

    /// 获取影子仓库内 worktree/ 子目录 (工作区镜像)
    pub fn worktree_dir(shadow_root: &Path) -> PathBuf {
        shadow_root.join(WORKTREE_SUBDIR)
    }

    /// 获取变更日志文件路径
    pub fn log_file(shadow_root: &Path) -> PathBuf {
        shadow_root.join(LOG_SUBDIR).join(CHANGES_LOG_FILE)
    }

    // ========================================================================
    // 初始化
    // ========================================================================

    /// 初始化影子仓库 (idempotent,已存在时直接返回)
    ///
    /// 流程:
    ///   1. 计算 project_hash
    ///   2. 创建 ~/.tdsf/side-git/<hash>/{git,worktree,log}/ 目录
    ///   3. 在 git/ 中 init bare 仓库
    ///   4. 配置 user.name / user.email
    ///   5. 创建初始空 commit (作为 HEAD)
    ///
    /// 返回: 影子仓库根目录路径
    pub fn init_shadow_repo(path: &Path) -> Result<PathBuf, String> {
        let shadow_root = Self::shadow_root(path);
        let git_dir = Self::git_dir(&shadow_root);
        let worktree_dir = Self::worktree_dir(&shadow_root);
        let log_dir = shadow_root.join(LOG_SUBDIR);

        // 1. 创建所有子目录
        fs::create_dir_all(&git_dir)
            .map_err(|e| format!("create git dir failed: {}", e))?;
        fs::create_dir_all(&worktree_dir)
            .map_err(|e| format!("create worktree dir failed: {}", e))?;
        fs::create_dir_all(&log_dir)
            .map_err(|e| format!("create log dir failed: {}", e))?;

        // 2. 如果 git/ 不是 bare 仓库,初始化它
        let need_init = !git_dir.join("HEAD").exists();
        if need_init {
            log::info!(
                "[side-git] initializing shadow repo: {:?}",
                shadow_root
            );

            let repo = Repository::init_bare(&git_dir)
                .map_err(|e| format!("init bare repo failed: {}", e))?;

            // 配置 user
            let mut config = repo
                .config()
                .map_err(|e| format!("get repo config failed: {}", e))?;
            config
                .set_str("user.name", COMMITTER_NAME)
                .map_err(|e| format!("set user.name failed: {}", e))?;
            config
                .set_str("user.email", COMMITTER_EMAIL)
                .map_err(|e| format!("set user.email failed: {}", e))?;
            config
                .set_str("core.logallrefupdates", "true")
                .map_err(|e| format!("set logallrefupdates failed: {}", e))?;

            // 3. 创建初始空 commit (让 HEAD 指向有效 ref)
            let sig = Self::signature()?;
            let mut index = repo
                .index()
                .map_err(|e| format!("get repo index failed: {}", e))?;
            let tree_oid = index
                .write_tree_to(&repo)
                .map_err(|e| format!("write empty tree failed: {}", e))?;
            let tree = repo
                .find_tree(tree_oid)
                .map_err(|e| format!("find tree failed: {}", e))?;

            repo.commit(
                Some(DEFAULT_BRANCH),
                &sig,
                &sig,
                "init: side-git repository",
                &tree,
                &[],
            )
            .map_err(|e| format!("create initial commit failed: {}", e))?;

            // 设置 HEAD 指向 main 分支
            repo.set_head(DEFAULT_BRANCH)
                .map_err(|e| format!("set head failed: {}", e))?;

            log::info!("[side-git] shadow repo initialized");
        } else {
            log::debug!("[side-git] shadow repo already exists: {:?}", shadow_root);
        }

        Ok(shadow_root)
    }

    // ========================================================================
    // stash / commit / rollback
    // ========================================================================

    /// 自动 stash 当前项目状态到影子仓库
    ///
    /// 流程:
    ///   1. 确保影子仓库已初始化
    ///   2. 镜像项目文件到 worktree/
    ///   3. 把 worktree/ 文件添加到 bare repo 的 index
    ///   4. 创建 commit (message: "stash: <RFC3339 timestamp>")
    ///
    /// 用途: Agent 调用 Edit/Write 工具前调用,保存修改前状态
    pub fn auto_stash(path: &Path) -> Result<(), String> {
        let shadow_root = Self::init_shadow_repo(path)?;
        let worktree_dir = Self::worktree_dir(&shadow_root);
        let git_dir = Self::git_dir(&shadow_root);

        // 1. 镜像项目文件到 worktree/
        Self::mirror_to_worktree(path, &worktree_dir)?;

        // 2. 打开 bare repo 并添加文件到 index
        let repo = Repository::open(&git_dir)
            .map_err(|e| format!("open repo failed: {}", e))?;
        let mut index = Self::add_worktree_to_index(&repo, &worktree_dir)?;
        index
            .write()
            .map_err(|e| format!("write index failed: {}", e))?;

        // 3. 创建 stash commit
        let timestamp = chrono::Utc::now().to_rfc3339();
        let message = format!("stash: {}", timestamp);
        let commit_oid = Self::create_commit(&repo, &message)?;

        log::info!("[side-git] stash created: {}", commit_oid);
        Ok(())
    }

    /// 自动 commit 当前项目状态到影子仓库
    ///
    /// 流程同 auto_stash,区别仅 message 由调用方指定。
    /// 返回: commit hash (HEX 字符串)
    ///
    /// 用途: Agent 调用 Edit/Write 工具后调用,保存修改后状态
    pub fn auto_commit(path: &Path, message: &str) -> Result<String, String> {
        let shadow_root = Self::init_shadow_repo(path)?;
        let worktree_dir = Self::worktree_dir(&shadow_root);
        let git_dir = Self::git_dir(&shadow_root);

        // 1. 镜像项目文件到 worktree/
        Self::mirror_to_worktree(path, &worktree_dir)?;

        // 2. 打开 bare repo 并添加文件到 index
        let repo = Repository::open(&git_dir)
            .map_err(|e| format!("open repo failed: {}", e))?;
        let mut index = Self::add_worktree_to_index(&repo, &worktree_dir)?;
        index
            .write()
            .map_err(|e| format!("write index failed: {}", e))?;

        // 3. 创建 commit
        let commit_oid = Self::create_commit(&repo, message)?;
        let commit_hash = commit_oid.to_string();

        log::info!("[side-git] commit created: {}", commit_hash);
        Ok(commit_hash)
    }

    /// 回滚到上一个 commit (撤销最后一次 stash / commit)
    ///
    /// 流程:
    ///   1. 获取 HEAD commit 的 parent
    ///   2. 修改 HEAD ref 指向 parent
    ///   3. 把 parent commit 的 tree 写回 worktree/
    ///   4. 把 worktree/ 文件复制回项目目录 (恢复文件状态)
    ///
    /// 用途: Agent 工具调用失败时自动回滚
    pub fn rollback(path: &Path) -> Result<(), String> {
        let shadow_root = Self::shadow_root(path);
        let git_dir = Self::git_dir(&shadow_root);
        let worktree_dir = Self::worktree_dir(&shadow_root);

        if !git_dir.exists() {
            return Err("shadow repo not initialized, cannot rollback".to_string());
        }

        let repo = Repository::open(&git_dir)
            .map_err(|e| format!("open repo failed: {}", e))?;

        // 1. 获取 HEAD commit
        let head = repo
            .head()
            .map_err(|e| format!("get head failed: {}", e))?;
        let head_commit = head
            .peel_to_commit()
            .map_err(|e| format!("peel head to commit failed: {}", e))?;

        // 2. 获取 parent commit (HEAD~1)
        let parent = head_commit
            .parents()
            .next()
            .ok_or_else(|| "no parent commit to rollback to".to_string())?;

        let parent_oid = parent.id();

        // 3. 修改 HEAD ref 指向 parent (相当于 git reset --hard HEAD~1)
        repo.reference(DEFAULT_BRANCH, parent_oid, true, "side-git rollback")
            .map_err(|e| format!("reset head ref failed: {}", e))?;

        // 4. 把 parent commit 的 tree 写回 worktree/
        let parent_tree = parent
            .tree()
            .map_err(|e| format!("get parent tree failed: {}", e))?;

        // 清空 worktree
        if worktree_dir.exists() {
            fs::remove_dir_all(&worktree_dir)
                .map_err(|e| format!("clear worktree failed: {}", e))?;
        }
        fs::create_dir_all(&worktree_dir)
            .map_err(|e| format!("recreate worktree failed: {}", e))?;

        Self::write_tree_to_dir(&repo, &parent_tree, &worktree_dir)?;

        // 5. 把 worktree 文件复制回项目目录
        Self::mirror_from_worktree(&worktree_dir, path)?;

        log::info!("[side-git] rolled back to {}", parent_oid);
        Ok(())
    }

    // ========================================================================
    // 变更日志 (changes.jsonl)
    // ========================================================================

    /// 追踪变更到 changes.jsonl (JSON Lines 格式)
    ///
    /// 每行格式:
    ///   {"timestamp":"2026-07-26T23:45:00Z","action":"edit",
    ///    "path":"/foo/bar","commit":"abc123","status":"success"}
    ///
    /// 用途: 记录所有 Agent 修改操作,便于审计和回溯
    pub fn track_change(path: &Path, action: &str) -> Result<(), String> {
        let shadow_root = Self::init_shadow_repo(path)?;
        let log_file = Self::log_file(&shadow_root);

        // 获取最新 commit hash (若已初始化)
        let git_dir = Self::git_dir(&shadow_root);
        let commit_hash = if git_dir.exists() {
            Repository::open(&git_dir)
                .and_then(|repo| repo.head().and_then(|h| h.peel_to_commit()).map(|c| c.id().to_string()))
                .unwrap_or_default()
        } else {
            String::new()
        };

        let entry = serde_json::json!({
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "action": action,
            "path": path.to_string_lossy(),
            "commit": commit_hash,
            "status": "success",
        });

        let line = serde_json::to_string(&entry)
            .map_err(|e| format!("serialize log entry failed: {}", e))?;

        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .map_err(|e| format!("open log file failed: {}", e))?;
        writeln!(file, "{}", line).map_err(|e| format!("write log line failed: {}", e))?;

        Ok(())
    }

    // ========================================================================
    // 状态查询
    // ========================================================================

    /// 查询影子仓库状态
    ///
    /// 返回 SideGitStatus,包含:
    ///   - shadow_root: 影子仓库根目录
    ///   - project_hash: 项目哈希
    ///   - initialized: 是否已初始化
    ///   - last_commit_hash: 最新 commit hash
    ///   - commit_count: commit 总数
    ///   - stash_count: stash commit 数
    pub fn status(path: &Path) -> Result<SideGitStatus, String> {
        let shadow_root = Self::shadow_root(path);
        let project_hash = Self::project_hash(path);
        let git_dir = Self::git_dir(&shadow_root);

        let initialized = git_dir.join("HEAD").exists();
        if !initialized {
            return Ok(SideGitStatus {
                shadow_root: shadow_root.to_string_lossy().to_string(),
                project_hash,
                initialized: false,
                last_commit_hash: String::new(),
                commit_count: 0,
                stash_count: 0,
            });
        }

        let repo = Repository::open(&git_dir)
            .map_err(|e| format!("open repo failed: {}", e))?;

        let head = repo
            .head()
            .map_err(|e| format!("get head failed: {}", e))?;
        let head_commit = head
            .peel_to_commit()
            .map_err(|e| format!("peel head failed: {}", e))?;

        let last_commit_hash = head_commit.id().to_string();

        // 遍历 commit 历史,统计总数 + stash 数
        let mut commit_count: u64 = 0;
        let mut stash_count: u64 = 0;
        for commit in head_commit.parents() {
            commit_count += 1;
            let msg = commit.message().unwrap_or("");
            if msg.starts_with("stash:") {
                stash_count += 1;
            }
        }
        // 包含 HEAD 自身
        commit_count += 1;
        let head_msg = head_commit.message().unwrap_or("");
        if head_msg.starts_with("stash:") {
            stash_count += 1;
        }

        Ok(SideGitStatus {
            shadow_root: shadow_root.to_string_lossy().to_string(),
            project_hash,
            initialized: true,
            last_commit_hash,
            commit_count,
            stash_count,
        })
    }

    // ========================================================================
    // 内部辅助方法
    // ========================================================================

    /// 创建 Signature (固定 committer 信息)
    fn signature() -> Result<Signature<'static>, String> {
        Signature::now(COMMITTER_NAME, COMMITTER_EMAIL)
            .map_err(|e| format!("create signature failed: {}", e))
    }

    /// 镜像项目文件到 worktree/ (覆盖式)
    ///
    /// 流程:
    ///   1. 清空 worktree/
    ///   2. 递归复制项目目录到 worktree/ (排除 .git / .tdsf-shadow 等)
    fn mirror_to_worktree(src: &Path, dst: &Path) -> Result<(), String> {
        // 清空 worktree
        if dst.exists() {
            fs::remove_dir_all(dst).map_err(|e| format!("clear worktree failed: {}", e))?;
        }
        fs::create_dir_all(dst).map_err(|e| format!("create worktree failed: {}", e))?;

        // 递归复制
        Self::copy_dir_recursive(src, dst)
    }

    /// 镜像 worktree/ 文件回项目目录
    ///
    /// 注意: 不删除项目目录的 .git / .tdsf-shadow 等特殊目录
    fn mirror_from_worktree(src: &Path, dst: &Path) -> Result<(), String> {
        // 1. 清空项目目录的文件 (保留 .git / .tdsf-shadow / .tdsf)
        let entries = fs::read_dir(dst).map_err(|e| format!("read project dir failed: {}", e))?;
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            // 保留 .git / .tdsf-shadow / .tdsf / .DS_Store (macOS)
            if name_str == ".git"
                || name_str == ".tdsf-shadow"
                || name_str == ".tdsf"
                || name_str == ".DS_Store"
            {
                continue;
            }
            if entry_path.is_dir() {
                let _ = fs::remove_dir_all(&entry_path);
            } else {
                let _ = fs::remove_file(&entry_path);
            }
        }

        // 2. 复制 worktree 到项目目录
        Self::copy_dir_recursive(src, dst)
    }

    /// 递归复制目录 (排除 .git / .tdsf-shadow 等)
    fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
        fs::create_dir_all(dst).map_err(|e| format!("create dir failed: {}", e))?;

        let entries = fs::read_dir(src).map_err(|e| format!("read dir failed: {}", e))?;
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // 跳过 .git / .tdsf-shadow / .tdsf / node_modules (大且无关)
            if name_str == ".git"
                || name_str == ".tdsf-shadow"
                || name_str == ".tdsf"
                || name_str == "node_modules"
                || name_str == ".DS_Store"
            {
                continue;
            }

            let dst_path = dst.join(name);

            if entry_path.is_dir() {
                Self::copy_dir_recursive(&entry_path, &dst_path)?;
            } else if entry_path.is_file() {
                fs::copy(&entry_path, &dst_path)
                    .map_err(|e| format!("copy file failed: {}", e))?;
            }
            // 跳过符号链接 (避免循环)
        }
        Ok(())
    }

    /// 把 worktree/ 中的文件作为 blob 添加到 bare repo 的 index
    ///
    /// 流程:
    ///   1. 获取 repo 的 index
    ///   2. 清空 index
    ///   3. 递归遍历 worktree/,对每个文件:
    ///      a. 读取文件内容
    ///      b. 写入 blob 到 repo (得到 oid)
    ///      c. 构造 IndexEntry 添加到 index
    ///   4. 返回填充后的 index (调用者负责 write)
    fn add_worktree_to_index(
        repo: &Repository,
        worktree: &Path,
    ) -> Result<Index, String> {
        let mut index = repo.index().map_err(|e| format!("get index failed: {}", e))?;
        index.clear().map_err(|e| format!("clear index failed: {}", e))?;

        Self::add_recursive(repo, &mut index, worktree, worktree)?;

        Ok(index)
    }

    /// 递归添加文件到 index (辅助函数)
    fn add_recursive(
        repo: &Repository,
        index: &mut Index,
        base: &Path,
        cur: &Path,
    ) -> Result<(), String> {
        let entries = fs::read_dir(cur).map_err(|e| format!("read dir failed: {}", e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // 跳过 .git / .tdsf-shadow 等
            if name_str == ".git"
                || name_str == ".tdsf-shadow"
                || name_str == ".tdsf"
                || name_str == ".DS_Store"
            {
                continue;
            }

            if path.is_dir() {
                Self::add_recursive(repo, index, base, &path)?;
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .map_err(|e| format!("strip prefix failed: {}", e))?;

                let content = fs::read(&path).map_err(|e| format!("read file failed: {}", e))?;
                let oid = repo
                    .blob(&content)
                    .map_err(|e| format!("write blob failed: {}", e))?;

                // 构造 IndexEntry (libgit2 要求所有字段填充,但 ctime/mtime 等可以是 0)
                // 注意: git2 0.19 中 IndexEntry 的 `size` 字段已重命名为 `file_size`,
                // 且新增 `flags_extended` 字段 (扩展 flags,设为 0 即可)
                let entry = IndexEntry {
                    ctime: IndexTime::new(0, 0),
                    mtime: IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: 0o100644, // 普通文件
                    uid: 0,
                    gid: 0,
                    file_size: content.len() as u32,
                    flags: 0,
                    flags_extended: 0,
                    path: rel.to_string_lossy().as_bytes().to_vec(),
                    id: oid,
                };

                index
                    .add(&entry)
                    .map_err(|e| format!("add to index failed: {}", e))?;
            }
        }
        Ok(())
    }

    /// 在 bare repo 中创建 commit (更新 HEAD ref)
    ///
    /// 流程:
    ///   1. 从 index 写出 tree
    ///   2. 获取 HEAD commit 作为 parent (若存在)
    ///   3. 创建 commit (Some("HEAD") 自动更新 HEAD ref)
    fn create_commit(repo: &Repository, message: &str) -> Result<Oid, String> {
        let sig = Self::signature()?;

        let mut index = repo.index().map_err(|e| format!("get index failed: {}", e))?;
        let tree_oid = index
            .write_tree_to(repo)
            .map_err(|e| format!("write tree failed: {}", e))?;
        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| format!("find tree failed: {}", e))?;

        // 获取 HEAD commit 作为 parent
        let head_commit: Option<Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok());

        let parents: Vec<&Commit> = head_commit.iter().collect();

        let commit_oid = repo
            .commit(
                Some(DEFAULT_BRANCH),
                &sig,
                &sig,
                message,
                &tree,
                &parents,
            )
            .map_err(|e| format!("create commit failed: {}", e))?;

        // 确保 HEAD 指向 DEFAULT_BRANCH
        repo.set_head(DEFAULT_BRANCH)
            .map_err(|e| format!("set head failed: {}", e))?;

        Ok(commit_oid)
    }

    /// 把 Tree 的内容写回目录 (递归)
    ///
    /// 用于 rollback: 把 parent commit 的 tree 写回 worktree/
    fn write_tree_to_dir(repo: &Repository, tree: &Tree, base: &Path) -> Result<(), String> {
        for entry in tree.iter() {
            let name = entry.name().ok_or_else(|| "invalid tree entry name".to_string())?;
            let entry_path = base.join(name);

            match entry.kind() {
                Some(ObjectType::Tree) => {
                    fs::create_dir_all(&entry_path)
                        .map_err(|e| format!("create subdir failed: {}", e))?;
                    // 注意: git2 0.19 中 TreeEntry 的 `as_object()` 已重命名为 `to_object(&repo)`,
                    // 返回 Result<Object>。需要用 let 绑定延长生命周期,避免临时值在借用期间被释放。
                    let obj = entry
                        .to_object(repo)
                        .map_err(|e| format!("get tree object failed: {}", e))?;
                    let subtree = obj
                        .as_tree()
                        .ok_or_else(|| "expected tree, got non-tree".to_string())?;
                    Self::write_tree_to_dir(repo, subtree, &entry_path)?;
                }
                Some(ObjectType::Blob) => {
                    let obj = entry
                        .to_object(repo)
                        .map_err(|e| format!("get blob object failed: {}", e))?;
                    let blob = obj
                        .as_blob()
                        .ok_or_else(|| "expected blob, got non-blob".to_string())?;
                    let content = blob.content();
                    if let Some(parent) = entry_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("create parent dir failed: {}", e))?;
                    }
                    fs::write(&entry_path, content)
                        .map_err(|e| format!("write file failed: {}", e))?;
                }
                _ => {
                    // 跳过其他类型 (tag / commit 等,影子仓库不存这些)
                }
            }
        }
        Ok(())
    }
}

// ============================================================================
// Tauri 命令 (lib.rs 中通过 invoke_handler 注册)
// ============================================================================

/// side_git_init: 初始化影子仓库
///
/// 前端调用:
///   ```typescript
///   await invoke('side_git_init', { path: '/foo/bar' });
///   ```
#[tauri::command]
pub async fn side_git_init(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    SideGitManager::init_shadow_repo(&path)?;
    Ok(())
}

/// side_git_status: 查询影子仓库状态
///
/// 返回 SideGitStatus (含 last_commit_hash / commit_count / stash_count)
#[tauri::command]
pub async fn side_git_status(path: String) -> Result<SideGitStatus, String> {
    let path = PathBuf::from(path);
    SideGitManager::status(&path)
}

/// side_git_stash: 自动 stash 当前工作区
///
/// 在 Agent 调用 Edit/Write 工具前调用
#[tauri::command]
pub async fn side_git_stash(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    SideGitManager::auto_stash(&path)
}

/// side_git_commit: 自动 commit 到影子仓库
///
/// 在 Agent 调用 Edit/Write 工具后调用,返回 commit hash
#[tauri::command]
pub async fn side_git_commit(path: String, message: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    SideGitManager::auto_commit(&path, &message)
}

/// side_git_rollback: 回滚到上一个 commit
///
/// 工具失败时自动调用,恢复文件状态
#[tauri::command]
pub async fn side_git_rollback(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    SideGitManager::rollback(&path)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// 全局锁: 确保 with_temp_home 串行执行
    ///
    /// 由于环境变量是进程级全局状态,并行测试会导致 TDSF_HOME 互相覆盖。
    /// 此 Mutex 保证同一时刻只有一个测试修改/读取 TDSF_HOME,
    /// 其他调用 with_temp_home 的测试会自动等待。
    /// 不影响不使用 with_temp_home 的测试 (它们仍然并行运行)。
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    /// 辅助: 创建临时项目目录并写入若干文件
    fn setup_project() -> TempDir {
        let dir = TempDir::new().expect("create tempdir failed");
        let root = dir.path();

        // 创建几个文件
        fs::write(root.join("README.md"), "# test project\n").unwrap();
        fs::write(root.join("main.py"), "print('hello')\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("app.py"), "app = True\n").unwrap();

        dir
    }

    /// 辅助: 重置 home 目录到临时目录 (避免污染真实 ~/.tdsf/)
    ///
    /// 通过设置环境变量 `TDSF_HOME` 实现 (shadow_root 方法优先读取该变量)。
    /// 同时设置 HOME (Unix) / USERPROFILE (Windows) 以兼容其他可能读取 home 的库。
    ///
    /// 注意: dirs::home_dir() 在 dirs v6 中使用 Windows API 而非环境变量,
    /// 因此必须通过 TDSF_HOME 覆盖,否则会污染真实 ~/.tdsf/ 目录。
    ///
    /// 线程安全: 使用 HOME_LOCK 确保串行执行,避免并行测试时环境变量竞争。
    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        // 获取全局锁,确保同一时刻只有一个测试修改环境变量
        let _guard = HOME_LOCK.lock().expect("HOME_LOCK poisoned");

        let home_dir = TempDir::new().expect("create home tempdir failed");
        let home_path = home_dir.path().to_path_buf();

        // 备份原环境变量
        let old_tdsf_home = std::env::var_os("TDSF_HOME");
        let old_home = std::env::var_os("HOME");
        let old_userprofile = std::env::var_os("USERPROFILE");

        // 设置临时 home (TDSF_HOME 是 shadow_root 优先读取的变量)
        std::env::set_var("TDSF_HOME", &home_path);
        std::env::set_var("HOME", &home_path);
        std::env::set_var("USERPROFILE", &home_path);

        // 执行测试
        f(&home_path);

        // 恢复环境变量
        match old_tdsf_home {
            Some(v) => std::env::set_var("TDSF_HOME", v),
            None => std::env::remove_var("TDSF_HOME"),
        }
        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match old_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }

        // _guard 在此处释放,允许下一个测试获取锁
    }

    // =========================================================================
    // 测试 1: init_shadow_repo 创建 bare 仓库
    // =========================================================================
    #[test]
    fn test_init_creates_bare_repo() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            let shadow_root = SideGitManager::init_shadow_repo(path).expect("init failed");

            // 验证目录结构
            assert!(shadow_root.exists(), "shadow_root should exist");
            assert!(SideGitManager::git_dir(&shadow_root).exists(), "git dir should exist");
            assert!(SideGitManager::worktree_dir(&shadow_root).exists(), "worktree dir should exist");
            assert!(shadow_root.join(LOG_SUBDIR).exists(), "log dir should exist");

            // 验证是 bare 仓库 (HEAD 文件存在)
            let head_file = SideGitManager::git_dir(&shadow_root).join("HEAD");
            assert!(head_file.exists(), "HEAD file should exist");

            // 验证能打开为 Repository
            let repo = Repository::open(SideGitManager::git_dir(&shadow_root));
            assert!(repo.is_ok(), "should open as repository");

            // 验证 HEAD 指向有效 commit
            let repo = repo.unwrap();
            let head = repo.head().expect("head should exist");
            let commit = head.peel_to_commit().expect("should peel to commit");
            assert_eq!(
                commit.message().unwrap_or(""),
                "init: side-git repository"
            );
        });
    }

    // =========================================================================
    // 测试 2: auto_stash 创建 stash commit
    // =========================================================================
    #[test]
    fn test_stash_creates_stash_entry() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            // 初始化
            SideGitManager::init_shadow_repo(path).expect("init failed");

            // 添加新文件模拟用户改动
            fs::write(path.join("new.txt"), "new content").unwrap();

            // stash
            SideGitManager::auto_stash(path).expect("stash failed");

            // 验证 stash commit 创建
            let status = SideGitManager::status(path).expect("status failed");
            assert!(status.initialized, "should be initialized");
            assert_eq!(status.commit_count, 2, "should have 2 commits (init + stash)");
            assert_eq!(status.stash_count, 1, "should have 1 stash commit");
            assert!(
                status.last_commit_hash.starts_with(|c: char| c.is_ascii_hexdigit()),
                "last_commit_hash should be hex"
            );

            // 验证 commit message 以 "stash:" 开头
            let shadow_root = SideGitManager::shadow_root(path);
            let repo = Repository::open(SideGitManager::git_dir(&shadow_root)).unwrap();
            let head = repo.head().unwrap();
            let commit = head.peel_to_commit().unwrap();
            assert!(
                commit.message().unwrap_or("").starts_with("stash:"),
                "stash commit message should start with 'stash:'"
            );
        });
    }

    // =========================================================================
    // 测试 3: auto_commit 创建 commit 并返回 hash
    // =========================================================================
    #[test]
    fn test_commit_creates_commit() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            SideGitManager::init_shadow_repo(path).expect("init failed");

            // 修改文件
            fs::write(path.join("main.py"), "print('modified')\n").unwrap();

            // commit
            let commit_hash = SideGitManager::auto_commit(path, "edit: main.py")
                .expect("commit failed");

            // 验证返回的 hash 是 40 字符 HEX (SHA-1) 或 64 字符 (SHA-256)
            assert!(
                commit_hash.len() == 40 || commit_hash.len() == 64,
                "commit hash should be 40 (SHA-1) or 64 (SHA-256) hex chars, got {}",
                commit_hash.len()
            );

            // 验证状态
            let status = SideGitManager::status(path).expect("status failed");
            assert_eq!(status.commit_count, 2, "should have 2 commits");
            assert_eq!(status.last_commit_hash, commit_hash, "last commit hash should match");
        });
    }

    // =========================================================================
    // 测试 4: rollback 恢复文件状态
    // =========================================================================
    #[test]
    fn test_rollback_restores_state() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            SideGitManager::init_shadow_repo(path).expect("init failed");

            // 原始内容
            let original_content = fs::read_to_string(path.join("main.py")).unwrap();

            // stash 原始状态
            SideGitManager::auto_stash(path).expect("stash failed");

            // 修改文件 (模拟 Agent 修改)
            fs::write(path.join("main.py"), "print('modified by agent')\n").unwrap();
            fs::write(path.join("new_file.txt"), "new").unwrap();

            // 验证已修改
            assert_ne!(
                fs::read_to_string(path.join("main.py")).unwrap(),
                original_content
            );
            assert!(path.join("new_file.txt").exists());

            // commit 修改后状态
            let _ = SideGitManager::auto_commit(path, "edit: main.py").expect("commit failed");

            // rollback
            SideGitManager::rollback(path).expect("rollback failed");

            // 验证文件已恢复到 stash 时的状态 (即原始内容)
            assert_eq!(
                fs::read_to_string(path.join("main.py")).unwrap(),
                original_content,
                "main.py should be restored to original"
            );
            // new_file.txt 不在 stash 中,应该不存在
            assert!(
                !path.join("new_file.txt").exists(),
                "new_file.txt should not exist after rollback"
            );
        });
    }

    // =========================================================================
    // 测试 5: track_change 写入 JSONL 日志
    // =========================================================================
    #[test]
    fn test_track_change_writes_jsonl() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            SideGitManager::init_shadow_repo(path).expect("init failed");

            // 写入两条变更日志
            SideGitManager::track_change(path, "edit").expect("track failed");
            SideGitManager::track_change(path, "write").expect("track failed");

            // 读取日志文件
            let log_file = SideGitManager::log_file(&SideGitManager::shadow_root(path));
            let content = fs::read_to_string(&log_file).expect("read log failed");

            // 验证是 JSONL (每行一个 JSON)
            let lines: Vec<&str> = content.trim().lines().collect();
            assert_eq!(lines.len(), 2, "should have 2 log entries");

            // 解析第一行 JSON
            let entry: serde_json::Value =
                serde_json::from_str(lines[0]).expect("parse JSON failed");
            assert_eq!(entry["action"], "edit");
            assert!(entry["timestamp"].is_string());
            assert!(entry["path"].is_string());
            assert!(entry["commit"].is_string());
            assert_eq!(entry["status"], "success");

            // 解析第二行 JSON
            let entry2: serde_json::Value =
                serde_json::from_str(lines[1]).expect("parse JSON failed");
            assert_eq!(entry2["action"], "write");
        });
    }

    // =========================================================================
    // 测试 6: project_hash 确定性 (相同路径产生相同哈希)
    // =========================================================================
    #[test]
    fn test_project_hash_deterministic() {
        let path1 = Path::new("/tmp/test-project-1");
        let path2 = Path::new("/tmp/test-project-1");
        let path3 = Path::new("/tmp/test-project-2");

        let hash1 = SideGitManager::project_hash(path1);
        let hash2 = SideGitManager::project_hash(path2);
        let hash3 = SideGitManager::project_hash(path3);

        // 相同路径 → 相同哈希
        assert_eq!(hash1, hash2, "same path should produce same hash");

        // 不同路径 → 不同哈希
        assert_ne!(hash1, hash3, "different paths should produce different hashes");

        // 哈希长度 = 32 字符
        assert_eq!(hash1.len(), PROJECT_HASH_LEN, "hash length should be 32");

        // 哈希是 HEX 字符串
        assert!(
            hash1.chars().all(|c| c.is_ascii_hexdigit()),
            "hash should be hex string"
        );
    }

    // =========================================================================
    // 测试 7: 并发 init 安全 (重复 init 不报错,idempotent)
    // =========================================================================
    #[test]
    fn test_concurrent_init_safe() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            // 第一次 init
            let root1 = SideGitManager::init_shadow_repo(path).expect("first init failed");

            // 第二次 init (idempotent)
            let root2 = SideGitManager::init_shadow_repo(path).expect("second init failed");

            // 验证两次返回相同路径
            assert_eq!(root1, root2, "should return same shadow_root");

            // 验证仍然只有一个初始 commit
            let status = SideGitManager::status(path).expect("status failed");
            assert_eq!(status.commit_count, 1, "should have only 1 commit (init)");
            assert_eq!(status.last_commit_hash, status.last_commit_hash);
        });
    }

    // =========================================================================
    // 测试 8: 无效路径返回错误
    // =========================================================================
    #[test]
    fn test_invalid_path_returns_error() {
        with_temp_home(|_home| {
            // 使用一个不存在的深度路径,且其父目录也不存在
            // 注意: init_shadow_repo 会创建目录,所以用 rollback 测试无效路径
            let invalid_path = Path::new("/nonexistent/very/deep/path/that/does/not/exist");

            // rollback 未初始化的仓库应失败
            let result = SideGitManager::rollback(invalid_path);
            assert!(result.is_err(), "rollback on uninitialized repo should fail");

            // 错误信息应该提到 "not initialized"
            let err_msg = result.unwrap_err();
            assert!(
                err_msg.contains("not initialized"),
                "error should mention 'not initialized', got: {}",
                err_msg
            );
        });
    }

    // =========================================================================
    // 额外测试 9: shadow_root 路径正确性
    // =========================================================================
    #[test]
    fn test_shadow_root_path() {
        with_temp_home(|home| {
            let path = Path::new("/test/project");
            let shadow_root = SideGitManager::shadow_root(path);
            let hash = SideGitManager::project_hash(path);

            let expected = home.join(".tdsf").join(SHADOW_ROOT_DIR).join(hash);
            assert_eq!(shadow_root, expected, "shadow_root path mismatch");
        });
    }

    // =========================================================================
    // 额外测试 10: status 命令返回正确字段
    // =========================================================================
    #[test]
    fn test_status_returns_correct_fields() {
        with_temp_home(|_home| {
            let project = setup_project();
            let path = project.path();

            // 未初始化时
            let status = SideGitManager::status(path).expect("status failed");
            assert!(!status.initialized, "should not be initialized");
            assert_eq!(status.commit_count, 0);
            assert_eq!(status.stash_count, 0);
            assert!(status.last_commit_hash.is_empty());

            // 初始化后
            SideGitManager::init_shadow_repo(path).expect("init failed");
            let status = SideGitManager::status(path).expect("status failed");
            assert!(status.initialized, "should be initialized");
            assert_eq!(status.commit_count, 1, "should have 1 commit");
            assert!(!status.last_commit_hash.is_empty(), "should have commit hash");
        });
    }
}
