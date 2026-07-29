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
                log::warn!(
                    "[ssh] check_known_hosts_path returned error: {} (treating as unknown)",
                    e
                );
                // 其他错误 (文件格式错误/主机未找到等) 视为未知主机,不阻断连接
                Ok(false)
            }
        }
    }

    /// 学习新主机 (TOFU 写入)
    ///
    /// 将 host:port + public_key 追加写入 known_hosts 文件。
    /// 文件不存在时会自动创建 (含父目录)。
    ///
    /// # 错误处理
    /// - 父目录创建失败 → 返回 Io 错误
    /// - 文件写入失败 → 返回 Io 错误
    /// - russh learn 失败 → 返回 RusshKeys 错误
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

        // 2. 调用 russh::keys::known_hosts::learn_known_hosts_path 追加写入
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
    fn test_check_unknown_host_returns_false() {
        let tmp = TempDir::new().unwrap();
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
}
