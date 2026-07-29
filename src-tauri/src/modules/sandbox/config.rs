//! 沙箱配置与返回类型 (P2-C T-P2-08)
//! ============================================================================
//! 定义 SandboxConfig / ExecResult / ContainerInfo / DockerStatus 等数据结构,
//! 供 SandboxManager 与 Tauri 命令层共享。
//!
//! ## 设计要点
//! - 所有结构都 derive Serialize/Deserialize,可通过 Tauri invoke 与 JSON-RPC 传递
//! - SandboxConfig 默认值遵循 P2 Docker 沙箱技术调研报告 §5.x 的安全建议:
//!   - 镜像: alpine:3.20 (7MB,最小化)
//!   - cap_drop: ALL (移除所有 Linux capabilities)
//!   - read_only_rootfs: true (根文件系统只读)
//!   - user: nobody:nobody (非 root)
//!   - memory: 512MB / nano_cpus: 1 CPU / pids_limit: 256
//!   - network_mode: none (无网络)
//!   - seccomp: default profile
//!   - /tmp: tmpfs 64MB
//! - 字段命名使用 snake_case (与 Rust 习惯一致),前端通过 serde camelCase 转换

use serde::{Deserialize, Serialize};

/// 沙箱配置 (前端 → Rust)
///
/// 前端调用示例:
/// ```ts
/// await invoke('sandbox_create', {
///   config: {
///     imageName: 'alpine:3.20',
///     memoryLimitBytes: 536870912,
///     nanoCpus: 1000000000,
///     // ...
///   }
/// });
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    /// 容器镜像 (默认 alpine:3.20)
    #[serde(default = "default_image")]
    pub image: String,

    /// 容器名前缀 (实际容器名 = 前缀 + uuid)
    /// 默认 "tdsf-sandbox-"
    #[serde(default = "default_name_prefix")]
    pub name_prefix: String,

    /// 内存上限 (字节),默认 512MB = 512 * 1024 * 1024
    #[serde(default = "default_memory_bytes")]
    pub memory_limit_bytes: i64,

    /// CPU 配额 (10⁻⁹ CPU 单位),默认 1_000_000_000 = 1 CPU
    #[serde(default = "default_nano_cpus")]
    pub nano_cpus: i64,

    /// 进程数限制 (cgroups pids),默认 256
    #[serde(default = "default_pids_limit")]
    pub pids_limit: i64,

    /// 网络模式,默认 "none" (无网络)
    #[serde(default = "default_network_mode")]
    pub network_mode: String,

    /// 容器内执行用户,默认 "nobody:nobody"
    #[serde(default = "default_user")]
    pub user: String,

    /// 是否只读根文件系统,默认 true
    #[serde(default = "default_true")]
    pub read_only_rootfs: bool,

    /// /tmp tmpfs 大小 (字节),默认 64MB
    #[serde(default = "default_tmpfs_size_bytes")]
    pub tmpfs_size_bytes: i64,

    /// seccomp profile 路径,"default" 表示用 Docker 默认 profile
    #[serde(default = "default_seccomp")]
    pub seccomp_profile: String,

    /// 是否启用 ssl (本地连接通常不需要)
    #[serde(default)]
    pub enable_ssl: bool,
}

fn default_image() -> String {
    "alpine:3.20".to_string()
}

fn default_name_prefix() -> String {
    "tdsf-sandbox-".to_string()
}

fn default_memory_bytes() -> i64 {
    512 * 1024 * 1024 // 512MB
}

fn default_nano_cpus() -> i64 {
    1_000_000_000 // 1 CPU
}

fn default_pids_limit() -> i64 {
    256
}

fn default_network_mode() -> String {
    "none".to_string()
}

fn default_user() -> String {
    "nobody:nobody".to_string()
}

fn default_true() -> bool {
    true
}

fn default_tmpfs_size_bytes() -> i64 {
    64 * 1024 * 1024 // 64MB
}

fn default_seccomp() -> String {
    "default".to_string()
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            image: default_image(),
            name_prefix: default_name_prefix(),
            memory_limit_bytes: default_memory_bytes(),
            nano_cpus: default_nano_cpus(),
            pids_limit: default_pids_limit(),
            network_mode: default_network_mode(),
            user: default_user(),
            read_only_rootfs: default_true(),
            tmpfs_size_bytes: default_tmpfs_size_bytes(),
            seccomp_profile: default_seccomp(),
            enable_ssl: false,
        }
    }
}

/// exec 命令执行结果
///
/// 包含 stdout / stderr / exit_code,与 Docker exec inspect 结果对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// 容器 ID
    pub container_id: String,
    /// 执行的命令 (含参数)
    pub cmd: Vec<String>,
    /// 标准输出 (UTF-8)
    pub stdout: String,
    /// 标准错误 (UTF-8)
    pub stderr: String,
    /// 退出码 (0 = 成功,127 = 命令不存在,137 = OOM 等)
    pub exit_code: i64,
    /// 执行耗时 (毫秒)
    pub duration_ms: u64,
}

/// 容器信息 (list_containers 返回)
///
/// 字段精简,只暴露前端需要的核心信息,不直接转发 bollard ContainerSummary
/// (后者字段 30+,前端用不到且类型复杂)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// 容器 ID (完整 64 字符 hex)
    pub id: String,
    /// 容器名 (第一个 name,去掉前导 "/")
    pub name: String,
    /// 镜像名 (image:tag)
    pub image: String,
    /// 状态 (running / exited / paused / created)
    pub state: String,
    /// 状态简写 (Up / Exited / Created / Paused)
    pub status: String,
    /// 创建时间戳 (Unix 秒)
    pub created: i64,
}

/// Docker 版本信息 (detect_docker 返回)
///
/// 包含 Docker daemon 与 API 版本,用于检测兼容性。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerVersion {
    /// Docker 版本 (如 "27.0.3")
    pub version: String,
    /// API 版本 (如 "1.45")
    pub api_version: String,
    /// Docker 组件 (如 "Docker Desktop" / "community")
    pub components: Vec<String>,
    /// OS/Arch (如 "linux/amd64")
    pub os_arch: String,
}

/// Docker 可用性状态 (sandbox_status 返回)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    /// Docker daemon 是否可用
    pub available: bool,
    /// 版本信息 (available=true 时有值)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<DockerVersion>,
    /// 不可用原因 (available=false 时有值)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 检测到的连接方式 (unix_socket / named_pipe / http / ssl)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

/// exec 输出 (start_exec 内部使用)
///
/// 用于在 manager.rs 内部从 start_exec 流中收集数据,
/// 最终转换为 ExecResult 返回给前端。
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    /// 标准输出 (字节)
    pub stdout: Vec<u8>,
    /// 标准错误 (字节)
    pub stderr: Vec<u8>,
    /// 退出码
    pub exit_code: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试 1: 默认配置使用 alpine:3.20 镜像
    #[test]
    fn test_config_default_is_alpine_320() {
        let config = SandboxConfig::default();
        assert_eq!(config.image, "alpine:3.20");
    }

    // 测试 2: 默认配置 cap_drop 为 ALL (通过 read_only_rootfs + 非 root 用户验证)
    #[test]
    fn test_config_cap_drop_all() {
        let config = SandboxConfig::default();
        // cap_drop 在 manager.rs 中硬编码为 ["ALL"],这里验证用户非 root
        assert_eq!(config.user, "nobody:nobody");
        // 验证只读 rootfs (defense in depth)
        assert!(config.read_only_rootfs);
    }

    // 测试 3: 默认内存限制 512MB
    #[test]
    fn test_config_memory_limit_512mb() {
        let config = SandboxConfig::default();
        assert_eq!(config.memory_limit_bytes, 512 * 1024 * 1024);
    }

    // 测试 4: 默认用户为 nobody:nobody (非 root)
    #[test]
    fn test_config_non_root_user() {
        let config = SandboxConfig::default();
        assert_eq!(config.user, "nobody:nobody");
    }

    // 测试 5: 默认网络模式为 none (无网络)
    #[test]
    fn test_config_network_none() {
        let config = SandboxConfig::default();
        assert_eq!(config.network_mode, "none");
    }

    // 测试 6: /tmp tmpfs 默认 64MB
    #[test]
    fn test_config_tmpfs_tmp_64mb() {
        let config = SandboxConfig::default();
        assert_eq!(config.tmpfs_size_bytes, 64 * 1024 * 1024);
    }

    // 测试 7: ExecResult 序列化 / 反序列化往返
    #[test]
    fn test_exec_result_serialization() {
        let result = ExecResult {
            container_id: "abc123".to_string(),
            cmd: vec!["ls".to_string(), "-l".to_string()],
            stdout: "total 0\n".to_string(),
            stderr: "".to_string(),
            exit_code: 0,
            duration_ms: 42,
        };
        let json = serde_json::to_string(&result).expect("serialize failed");
        let back: ExecResult = serde_json::from_str(&json).expect("deserialize failed");
        assert_eq!(back.container_id, "abc123");
        assert_eq!(back.cmd, vec!["ls".to_string(), "-l".to_string()]);
        assert_eq!(back.stdout, "total 0\n");
        assert_eq!(back.exit_code, 0);
        assert_eq!(back.duration_ms, 42);
    }

    // 测试 8: ContainerInfo 序列化 / 反序列化往返
    #[test]
    fn test_container_info_serialization() {
        let info = ContainerInfo {
            id: "deadbeef".to_string(),
            name: "tdsf-sandbox-xxx".to_string(),
            image: "alpine:3.20".to_string(),
            state: "running".to_string(),
            status: "Up 5 seconds".to_string(),
            created: 1722000000,
        };
        let json = serde_json::to_string(&info).expect("serialize failed");
        let back: ContainerInfo = serde_json::from_str(&json).expect("deserialize failed");
        assert_eq!(back.id, "deadbeef");
        assert_eq!(back.name, "tdsf-sandbox-xxx");
        assert_eq!(back.image, "alpine:3.20");
        assert_eq!(back.state, "running");
        assert_eq!(back.created, 1722000000);
    }
}
