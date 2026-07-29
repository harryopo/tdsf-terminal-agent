// modules/fs/mod.rs — 文件系统工具 (terax-ai 搬运 + TDSF 扩展)
// ============================================================================
// 包含 to_canon 路径规范化函数, 以及以下子模块:
// - file: 文件读写 / stat / canonicalize
// - tree: 目录树列举 (list_subdirs / fs_read_dir)
// - mutate: 文件创建 / 删除 / 重命名 / 复制
// - watch: 文件监听 (FsWatchState + fs_watch_add / fs_watch_remove)
// - search: 文件搜索 (fs_search / fs_list_files)
// - grep: 内容搜索 (ContentSearchState + fs_grep / fs_grep_interactive / fs_glob)
use std::path::Path;

// 子模块声明
pub mod file;
pub mod grep;
pub mod mutate;
pub mod search;
pub mod tree;
pub mod watch;

/// 单一路径转显示格式: 正斜杠, Windows verbatim `\\?\` 前缀去除
pub fn to_canon(p: impl AsRef<Path>) -> String {
    let s = p.as_ref().to_string_lossy();
    #[cfg(windows)]
    {
        strip_verbatim(&s)
    }
    #[cfg(not(windows))]
    {
        s.into_owned()
    }
}

#[cfg(windows)]
fn strip_verbatim(s: &str) -> String {
    let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    };
    stripped.replace('\\', "/")
}
