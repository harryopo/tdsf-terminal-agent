//! 已知主机管理 (P2-B T-P2-03)
//! ============================================================================
//! 基于 russh::keys::check_known_hosts / learn_known_hosts 实现 TOFU 策略
//!
//! ## 策略 (借鉴 OpenSSH + wezterm-ssh)
//! 1. **首次连接**: check_known_hosts 返回 false → 询问用户 → learn_known_hosts
//! 2. **已知主机 + key 匹配**: check_known_hosts 返回 true → 直接通过
//! 3. **已知主机 + key 不匹配**: check_known_hosts 返回 Err(KeyChanged) → 大字警告
//!
//! ## 文件位置
//! - 默认: `~/.ssh/known_hosts` (与 OpenSSH 兼容)
//! - 自定义: 通过 SSH_KNOWN_HOSTS_FILE 环境变量指定
//!
//! ## 格式
//! - 支持 hashed host (`|1|salt|hash`),与 OpenSSH 完全兼容
//! - 支持 `[host]:port` 格式 (非默认端口)
//! - russh 原生处理,无需应用层解析

use std::path::PathBuf;

use russh::keys::{self, known_hosts, PublicKey};

/// 已知主机管理错误
#[derive(Debug, thiserror::Error)]
pub enum KnownHostsError {
    /// 主机 key 不匹配 (可能中间人攻击)
    #[error("host key mismatch for {host}: {detail}")]
    KeyMismatch { host: String, detail: String },

    /// russh keys 错误
    #[error("russh keys error: {0}")]
    RusshKeys(#[from] keys::Error),

    /// IO 错误
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// 其他错误
    #[error("{0}")]
    Other(String),
}

/// 已知主机管理器
///
/// 封装 russh::keys 的 known_hosts 操作,提供 check / learn 接口。
/// 默认使用 `~/.ssh/known_hosts`,可通过环境变量覆盖。
#[derive(Debug, Clone)]
pub struct KnownHostsManager {
    /// known_hosts 文件路径
    ///
    /// - 默认: `~/.ssh/known_hosts`
    /// - 自定义: `SSH_KNOWN_HOSTS_FILE` 环境变量
    known_hosts_path: PathBuf,
}

impl KnownHostsManager {
    /// 创建默认 known_hosts 管理器
    ///
    /// 路径优先级:
    /// 1. `SSH_KNOWN_HOSTS_FILE` 环境变量
    /// 2. `~/.ssh/known_hosts` (用户 home 目录)
    pub fn new() -> Self {
        let known_hosts_path = if let Ok(custom) = std::env::var("SSH_KNOWN_HOSTS_FILE") {
            PathBuf::from(custom)
        } else {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(".ssh").join("known_hosts")
        };

        Self { known_hosts_path }
    }

    /// 创建指定路径的 known_hosts 管理器 (主要用于测试)
    pub fn with_path(path: PathBuf) -> Self {
        Self { known_hosts_path: path }
    }

    /// 获取 known_hosts 文件路径
    pub fn path(&self) -> &PathBuf {
        &self.known_hosts_path
    }

    /// 检查主机 key 是否在 known_hosts 中
    ///
    /// # 返回值
    /// - `Ok(true)`: 主机已知且 key 匹配
    /// - `Ok(false)`: 主机未知 (首次连接,需 TOFU 询问)
    /// - `Err(KeyMismatch)`: 主机已知但 key 不匹配 (中间人攻击警告)
    /// - `Err(other)`: 其他错误 (文件不存在/格式错误等)
    pub fn check(
        &self,
        host: &str,
        port: u16,
        public_key: &PublicKey,
    ) -> Result<bool, KnownHostsError> {
        log::debug!(
            "[ssh] check_known_hosts: host={} port={} file={:?}",
            host,
            port,
            self.known_hosts_path
        );

        // 文件不存在 → 视为未知主机 (返回 false,不报错)
        // 这样首次连接时不需要预先创建文件
        if !self.known_hosts_path.exists() {
            log::debug!(
                "[ssh] known_hosts file not found, treating as unknown host: {:?}",
                self.known_hosts_path
            );
            return Ok(false);
        }

        // 使用 russh::keys::check_known_hosts_path 检查
        // 该函数会读取文件,查找 host:port 对应的 key,与 public_key 比对
        match keys::check_known_hosts_path(host, port, public_key, &self.known_hosts_path) {
            Ok(true) => Ok(true),
            Ok(false) => Ok(false),
            Err(keys::Error::KeyChanged { .. }) => {
                // russh 0.61: KeyChanged 表示 known_hosts 中有该 host 但 key 不匹配
                // 转换为我们的 KeyMismatch 错误 (中间人攻击警告)
                Err(KnownHostsError::KeyMismatch {
                    host: host.to_string(),
                    detail: format!(
                        "host key for {}:{} has changed (possible MITM attack)",
                        host, port
                    ),
                })
            }
            Err(e) => {
                // 文件缺失 (从未学过任何主机) → 正常未知主机流程
                let is_missing = matches!(
                    &e,
                    keys::Error::IO(io) if io.kind() == std::io::ErrorKind::NotFound
                );
                if is_missing {
                    return Ok(false);
                }
                // TDSF 2026-08-04 (Rust-M5): 其他错误通常是 known_hosts 文件损坏,
                // 不再静默吞掉——明确告警 TOFU 防 MITM 保护已降级, 但仍不阻断连接
                log::warn!(
                    "[ssh] known_hosts check failed: {} (known_hosts 文件可能损坏, TOFU 防 MITM 保护降级)",
                    e
                );
                Ok(false)
            }
        }
    }

    /// 学习新主机 (TOFU 写入)
    ///
    /// **先清掉这台主机已有的记录，再追加新钥匙** —— 与 `ssh-keygen -R host` 同一语义。
    /// 不能只追加：russh 的 `check_known_hosts_path` 会对该主机记下的每一行同算法记录
    /// 逐一比对，只要有一行不同就 `KeyChanged` 并短路
    /// (russh-0.61.2/src/keys/known_hosts.rs:30-48)。留着的旧行会让用户
    /// **点多少次「信任」都永远过不了检查**（#121，用户实测：虚机重装后反复弹密钥变更）。
    ///
    /// 文件不存在时会自动创建 (含父目录)。
    ///
    /// # 错误处理
    /// - 父目录创建失败 → 返回 Io 错误
    /// - 文件写入失败 → 返回 Io 错误
    /// - russh learn 失败 → 返回 RusshKeys 错误
    /// - 清理阶段读不动/解析不了 → 只告警并退回"直接追加"，不阻断连接
    pub fn learn(
        &self,
        host: &str,
        port: u16,
        public_key: &PublicKey,
    ) -> Result<(), KnownHostsError> {
        log::info!(
            "[ssh] learn_known_hosts: host={} port={} file={:?}",
            host,
            port,
            self.known_hosts_path
        );

        // 1. 确保父目录存在 (~/.ssh/)
        if let Some(parent) = self.known_hosts_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
                log::debug!("[ssh] created known_hosts parent dir: {:?}", parent);
            }
        }

        // 2. 先摘掉这台主机的旧记录（只这一台，别的主机一行不动）
        match self.forget_host_lines(host, port) {
            Ok(0) => {}
            Ok(n) => log::info!(
                "[ssh] learn_known_hosts: 覆盖 {}:{} 的 {} 行旧记录",
                host,
                port,
                n
            ),
            Err(e) => log::warn!(
                "[ssh] learn_known_hosts: 清理旧记录失败（退回追加写入）: {}",
                e
            ),
        }

        // 3. 调用 russh::keys::known_hosts::learn_known_hosts_path 追加写入
        //    russh 内部使用 OpenOptions::append 原子追加,无需应用层加锁
        known_hosts::learn_known_hosts_path(host, port, public_key, &self.known_hosts_path)?;

        log::info!(
            "[ssh] learned host: {}:{} → {:?}",
            host,
            port,
            self.known_hosts_path
        );
        Ok(())
    }

    /// 删除 known_hosts 中属于 `host:port` 的所有行，返回删掉的行数。
    ///
    /// 用 russh 自己的 `known_host_keys_path` 定位行号，而不是手写解析：
    /// 它已经处理了 `[host]:port` 写法、逗号分隔的多主机名、以及 `|1|` 哈希主机。
    /// 匹配不到任何行时不写文件（避免无谓地重写整个 known_hosts）。
    fn forget_host_lines(&self, host: &str, port: u16) -> Result<usize, KnownHostsError> {
        if !self.known_hosts_path.exists() {
            return Ok(0);
        }
        let matches =
            known_hosts::known_host_keys_path(host, port, &self.known_hosts_path)?;
        if matches.is_empty() {
            return Ok(0);
        }
        let doomed: std::collections::HashSet<usize> =
            matches.iter().map(|(line, _)| *line).collect();

        let content = std::fs::read_to_string(&self.known_hosts_path)?;
        // russh 报的行号从 1 开始
        let kept: Vec<&str> = content
            .lines()
            .enumerate()
            .filter(|(idx, _)| !doomed.contains(&(idx + 1)))
            .map(|(_, line)| line)
            .collect();
        if kept.len() == content.lines().count() {
            return Ok(0);
        }
        let mut rewritten = kept.join("\n");
        if !rewritten.is_empty() {
            rewritten.push('\n');
        }
        std::fs::write(&self.known_hosts_path, rewritten)?;
        Ok(doomed.len())
    }
}

impl Default for KnownHostsManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // 生成 Ed25519 测试私钥
    // russh 0.61 测试代码用 rand::rng() (rand 0.9 兼容 rand_core 0.10)
    fn generate_test_key() -> russh::keys::PrivateKey {
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("failed to generate Ed25519 test key")
    }

    #[test]
    fn test_check_nonexistent_file_returns_false() {
        // 文件不存在时应返回 Ok(false),不报错
        let tmp = TempDir::new().unwrap();
        let manager = KnownHostsManager::with_path(tmp.path().join("known_hosts"));

        let key = generate_test_key();
        let public_key = key.public_key();

        let result = manager.check("example.com", 22, public_key);
        assert!(result.is_ok());
        assert!(!result.unwrap()); // 文件不存在 → false
    }

    #[test]
    fn test_learn_then_check_matches() {
        let tmp = TempDir::new().unwrap();
        let manager = KnownHostsManager::with_path(tmp.path().join("known_hosts"));

        let key = generate_test_key();
        let public_key = key.public_key();

        // 1. learn
        let learn_result = manager.learn("test.example.com", 22, public_key);
        assert!(learn_result.is_ok(), "learn failed: {:?}", learn_result);

        // 2. check 应返回 true (匹配)
        let check_result = manager.check("test.example.com", 22, public_key);
        assert!(check_result.is_ok());
        assert!(
            check_result.unwrap(),
            "check should return true after learn"
        );
    }

    #[test]
    fn test_check_unknown_host_returns_false() {        let tmp = TempDir::new().unwrap();
        let manager = KnownHostsManager::with_path(tmp.path().join("known_hosts"));

        // 先 learn host A
        let key_a = generate_test_key();
        manager
            .learn("host-a.example.com", 22, key_a.public_key())
            .unwrap();

        // 检查 host B (未知) 应返回 false
        let key_b = generate_test_key();
        let result = manager.check("host-b.example.com", 22, key_b.public_key());
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    /// #121 —— 用户实测：虚机重装后他点了「信任并连接」，下一次重连**还是**报密钥变更。
    ///
    /// 根因不在检查逻辑，在写入：`learn` 只会追加，而 russh 的
    /// `check_known_hosts_path` 对该主机记下的**每一行**同算法记录逐一比对，
    /// 只要有一行不同就返回 `KeyChanged` 并短路
    /// （russh-0.61.2/src/keys/known_hosts.rs:30-48，注释原文
    /// "If any Err was returned, we stop here"）。
    /// ⇒ 旧行不删，用户永远信任不上；审批队列 5 分钟超时，连接就一直失败。
    #[test]
    fn test_relearn_replaces_the_stale_key_for_the_same_host() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("known_hosts");
        let manager = KnownHostsManager::with_path(path.clone());

        let old_key = generate_test_key();
        let new_key = generate_test_key();
        manager
            .learn("192.168.45.128", 22, old_key.public_key())
            .unwrap();
        manager
            .learn("192.168.45.128", 22, new_key.public_key())
            .unwrap();

        // 用户刚刚明确信任过这把新钥匙，它就必须检查通过
        let checked = manager.check("192.168.45.128", 22, new_key.public_key());
        assert!(
            matches!(checked, Ok(true)),
            "重新学习之后仍然判成密钥变更 —— 用户的「信任」白点了：{checked:?}"
        );

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content
                .lines()
                .filter(|l| l.contains("192.168.45.128"))
                .count(),
            1,
            "同一主机留下两行，下一次检查必然又被旧行判成 KeyChanged：{content}"
        );
    }

    /// 配对：清理只许针对**这一台主机**。别的主机的记录一行都不许动，
    /// 否则一次重装会连带把其他服务器全部退回"首次连接"。
    #[test]
    fn test_relearn_does_not_touch_other_hosts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("known_hosts");
        let manager = KnownHostsManager::with_path(path.clone());

        let keep_key = generate_test_key();
        manager
            .learn("host-keep.example.com", 22, keep_key.public_key())
            .unwrap();
        let other_key = generate_test_key();
        manager
            .learn("192.168.45.128", 22, other_key.public_key())
            .unwrap();
        manager
            .learn(
                "192.168.45.128",
                22,
                generate_test_key().public_key(),
            )
            .unwrap();

        let kept = manager.check("host-keep.example.com", 22, keep_key.public_key());
        assert!(
            matches!(kept, Ok(true)),
            "另一台主机的记录被顺手清掉了：{kept:?}"
        );
    }
}
