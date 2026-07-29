//! 沙箱管理器 (P2-C T-P2-08.2 + T-P2-08.3)
//! ============================================================================
//! SandboxManager 封装 bollard::Docker 客户端,提供容器生命周期 + 命令执行高层 API:
//! - `new()`: 创建管理器 (含 Docker daemon 检测)
//! - `detect_docker()`: 检测 Docker Desktop / Engine 可用性
//! - `create_container()`: 创建沙箱容器 (应用完整安全配置)
//! - `start_container()` / `stop_container()` / `remove_container()`: 生命周期
//! - `exec_in_container()`: 容器内执行命令,返回 ExecResult
//! - `list_containers()`: 列出当前所有 tdsf-sandbox-* 容器
//!
//! ## 安全配置 (P2 Docker 沙箱技术调研报告 §6.7)
//! - cap_drop: ["ALL"]  移除所有 Linux capabilities
//! - readonly_rootfs: true  只读根文件系统
//! - user: nobody:nobody  非 root
//! - memory: 512MB  nano_cpus: 1 CPU  pids_limit: 256
//! - network_mode: "none"  无网络
//! - security_opt: ["no-new-privileges", "seccomp=default"]
//! - /tmp: tmpfs 64MB
//! - init: true (tini 作为 PID 1,回收僵尸进程)
//!
//! ## Docker 连接策略
//! - Windows: `connect_with_local_defaults()` → Named Pipe `\\.\pipe\docker_engine`
//! - Linux/macOS: `connect_with_local_defaults()` → Unix socket `/var/run/docker.sock`
//! - bollard 自动按 cfg(target_os) 选择 transport,无需应用层平台判断

use std::sync::Arc;
use std::time::Instant;

use bollard::container::{Config as ContainerCreateBody, ListContainersOptions, RemoveContainerOptions};
use bollard::models::{HostConfig, Mount, MountTmpfsOptions, PortMap};
use bollard::Docker;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::config::{ContainerInfo, DockerStatus, DockerVersion, ExecResult, SandboxConfig};
use super::exec::{create_exec, start_exec};

/// 沙箱容器名前缀 (全局唯一,避免与用户其他容器混淆)
const SANDBOX_NAME_PREFIX: &str = "tdsf-sandbox-";

/// 沙箱管理器
///
/// 内部用 `tokio::sync::Mutex<bollard::Docker>` 保护 Docker 客户端,
/// 因为 bollard::Docker 内部连接不可 Send 的 streaming 操作需要互斥访问
/// (Docker 本身是 Clone-able 的浅引用,但所有 async API 都需要 &self)。
///
/// 用法:
/// ```ignore
/// let manager = SandboxManager::new().map_err(|e| e)?;
/// let id = manager.create_container(SandboxConfig::default()).await?;
/// manager.start_container(&id).await?;
/// let result = manager.exec_in_container(&id, vec!["ls".into(), "-l".into()]).await?;
/// ```
pub struct SandboxManager {
    /// bollard Docker 客户端 (内部用 Mutex 保护)
    ///
    /// Docker 结构体本身是 Send + Sync (内部 hyper client 用 Arc),
    /// 但所有调用都需要 &self,在并发 Tauri 命令中需要 Mutex 串行化访问。
    docker: Arc<Mutex<Docker>>,
}

impl SandboxManager {
    /// 创建新的沙箱管理器
    ///
    /// 流程:
    /// 1. connect_with_local_defaults() 自动选择 transport
    ///    - Windows: Named Pipe `\\.\pipe\docker_engine`
    ///    - Linux/macOS: Unix socket `/var/run/docker.sock`
    /// 2. 不立即检测 daemon 可用性 (延迟到首次调用或显式 detect_docker)
    ///
    /// 返回错误仅当连接初始化失败 (如 Named Pipe 初始化异常)。
    /// 真实 daemon 可用性检测在 `detect_docker()` 中执行。
    pub fn new() -> Result<Self, String> {
        let docker = Docker::connect_with_local_defaults()
            .map_err(|e| format!("connect docker daemon failed: {e}"))?;
        Ok(Self {
            docker: Arc::new(Mutex::new(docker)),
        })
    }

    /// 检测 Docker daemon 可用性与版本信息
    ///
    /// 流程:
    /// 1. 调用 docker.version() 获取版本信息
    /// 2. 转换为 DockerVersion 结构 (前端友好)
    ///
    /// 错误场景:
    /// - Docker Desktop 未安装 → connect_with_local_defaults 内部失败
    /// - Docker Desktop 已安装但未运行 → version() 调用超时/拒绝连接
    /// - WSL2 后端未启动 → 同上
    pub async fn detect_docker(&self) -> Result<DockerVersion, String> {
        let docker = self.docker.lock().await;
        let version = docker
            .version()
            .await
            .map_err(|e| format!("docker daemon not available: {e}"))?;

        let components = version
            .components
            .unwrap_or_default()
            .into_iter()
            .map(|c| c.name)
            .collect::<Vec<_>>();

        let os_arch = match (version.os, version.arch) {
            (Some(os), Some(arch)) => format!("{os}/{arch}"),
            (Some(os), None) => os,
            _ => "unknown".to_string(),
        };

        Ok(DockerVersion {
            version: version.version.unwrap_or_else(|| "unknown".to_string()),
            api_version: version.api_version.unwrap_or_else(|| "unknown".to_string()),
            components,
            os_arch,
        })
    }

    /// 检测 Docker 可用性并返回 DockerStatus (前端友好)
    ///
    /// 用于 sandbox_status 命令,包含详细错误信息引导用户安装/启动 Docker。
    pub async fn status(&self) -> DockerStatus {
        match self.detect_docker().await {
            Ok(version) => DockerStatus {
                available: true,
                version: Some(version),
                error: None,
                transport: Some(Self::detect_transport_name()),
            },
            Err(e) => {
                log::warn!("[sandbox] docker unavailable: {}", e);
                DockerStatus {
                    available: false,
                    version: None,
                    error: Some(format!(
                        "{e}\n\n请确认 Docker Desktop 已安装并运行:\n\
                         - Windows: 安装 Docker Desktop (https://www.docker.com/products/docker-desktop/)\n\
                         - Linux: sudo systemctl start docker\n\
                         - macOS: open -a Docker"
                    )),
                    transport: Some(Self::detect_transport_name()),
                }
            }
        }
    }

    /// 同步检测 Docker 是否可用 (快速判断,不调用 daemon)
    ///
    /// 仅检查 transport 是否初始化成功,不实际调用 daemon API。
    /// 用于启动时快速判断是否启用沙箱功能。
    pub fn is_docker_available() -> bool {
        match Docker::connect_with_local_defaults() {
            Ok(_) => true,
            Err(e) => {
                log::debug!("[sandbox] docker transport init failed: {}", e);
                false
            }
        }
    }

    /// 检测当前使用的 transport 名 (用于 status 返回)
    fn detect_transport_name() -> String {
        if cfg!(target_os = "windows") {
            "named_pipe".to_string()
        } else if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
            "unix_socket".to_string()
        } else {
            "unknown".to_string()
        }
    }

    /// 创建沙箱容器
    ///
    /// 流程:
    /// 1. 生成容器名 (前缀 + uuid,如 "tdsf-sandbox-a1b2c3d4-...")
    /// 2. 构造 ContainerCreateBody,应用完整安全配置
    /// 3. 调用 docker.create_container()
    ///
    /// 返回: 容器 ID (64 字符 hex)
    pub async fn create_container(&self, config: SandboxConfig) -> Result<String, String> {
        let container_name = format!("{}{}", SANDBOX_NAME_PREFIX, Uuid::new_v4());
        log::info!(
            "[sandbox] creating container: name={} image={}",
            container_name,
            config.image
        );

        let create_body = Self::build_create_body(&config);

        let docker = self.docker.lock().await;
        let result = docker
            .create_container(
                Some(bollard::container::CreateContainerOptions::<String> {
                    name: container_name.clone(),
                    platform: None,
                }),
                create_body,
            )
            .await
            .map_err(|e| {
                log::error!("[sandbox] create_container failed: {}", e);
                format!("create_container failed: {e}")
            })?;

        log::info!(
            "[sandbox] container created: id={} name={}",
            result.id,
            container_name
        );
        Ok(result.id)
    }

    /// 启动容器
    pub async fn start_container(&self, id: &str) -> Result<(), String> {
        log::info!("[sandbox] start_container: id={}", id);
        let docker = self.docker.lock().await;
        docker
            .start_container::<String>(id, None)
            .await
            .map_err(|e| format!("start_container failed: {e}"))?;
        log::info!("[sandbox] container started: id={}", id);
        Ok(())
    }

    /// 停止容器 (优雅停止,默认 10 秒超时后强制 kill)
    pub async fn stop_container(&self, id: &str) -> Result<(), String> {
        log::info!("[sandbox] stop_container: id={}", id);
        let docker = self.docker.lock().await;
        docker
            .stop_container(id, None)
            .await
            .map_err(|e| format!("stop_container failed: {e}"))?;
        log::info!("[sandbox] container stopped: id={}", id);
        Ok(())
    }

    /// 删除容器 (force=true 时即使运行中也会强制 kill+remove)
    pub async fn remove_container(&self, id: &str) -> Result<(), String> {
        log::info!("[sandbox] remove_container: id={}", id);
        let docker = self.docker.lock().await;
        docker
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| format!("remove_container failed: {e}"))?;
        log::info!("[sandbox] container removed: id={}", id);
        Ok(())
    }

    /// 在容器内执行命令
    ///
    /// 流程:
    /// 1. create_exec 创建 exec 实例
    /// 2. start_exec 启动并收集 stdout/stderr/exit_code
    /// 3. 包装为 ExecResult 返回 (含耗时)
    pub async fn exec_in_container(
        &self,
        id: &str,
        cmd: Vec<String>,
    ) -> Result<ExecResult, String> {
        let started = Instant::now();
        let docker = self.docker.lock().await;

        log::info!(
            "[sandbox] exec_in_container: id={} cmd={:?}",
            id,
            cmd
        );

        let exec_id = create_exec(&docker, id, &cmd).await?;
        let output = start_exec(&docker, &exec_id).await?;

        let duration_ms = started.elapsed().as_millis() as u64;

        Ok(ExecResult {
            container_id: id.to_string(),
            cmd,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.exit_code,
            duration_ms,
        })
    }

    /// 列出所有沙箱容器 (过滤 SANDBOX_NAME_PREFIX)
    ///
    /// 用于 sandbox_list 命令,前端展示当前活跃沙箱。
    pub async fn list_containers(&self) -> Result<Vec<ContainerInfo>, String> {
        let docker = self.docker.lock().await;
        let options = ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        };
        let summaries = docker
            .list_containers(Some(options))
            .await
            .map_err(|e| format!("list_containers failed: {e}"))?;

        let result: Vec<ContainerInfo> = summaries
            .into_iter()
            .filter_map(|s| {
                // 取第一个 name,过滤前缀不匹配的容器
                let name = s.names.as_ref()?.first()?.trim_start_matches('/').to_string();
                if !name.starts_with(SANDBOX_NAME_PREFIX) {
                    return None;
                }
                Some(ContainerInfo {
                    id: s.id.unwrap_or_default(),
                    name,
                    image: s.image.unwrap_or_default(),
                    state: s.state.unwrap_or_else(|| "unknown".to_string()),
                    status: s.status.unwrap_or_default(),
                    created: s.created.unwrap_or(0),
                })
            })
            .collect();

        Ok(result)
    }

    // ========================================================================
    // 内部: 构造 bollard ContainerCreateBody
    // ========================================================================

    /// 构造 bollard ContainerCreateBody,应用完整安全配置
    ///
    /// 字段对齐 bollard 0.17 / bollard-stubs 1.45:
    /// - HostConfig.memory / nano_cpus / pids_limit / cap_drop / cap_add
    /// - HostConfig.readonly_rootfs / security_opt / init / network_mode
    /// - HostConfig.mounts (tmpfs /tmp)
    /// - ContainerCreateBody.image / user / tty / open_stdin
    fn build_create_body(config: &SandboxConfig) -> ContainerCreateBody<String> {
        // /tmp tmpfs mount (默认 64MB)
        let tmp_mount = Mount {
            target: Some("/tmp".to_string()),
            typ: Some(bollard::models::MountTypeEnum::TMPFS),
            tmpfs_options: Some(MountTmpfsOptions {
                size_bytes: Some(config.tmpfs_size_bytes),
                mode: None,
                ..Default::default()
            }),
            ..Default::default()
        };

        // 安全配置: cap_drop ALL + no-new-privileges + seccomp
        let mut security_opt = vec!["no-new-privileges".to_string()];
        if config.seccomp_profile == "default" || config.seccomp_profile.is_empty() {
            // Docker 默认应用 default seccomp profile,无需显式声明
        } else {
            security_opt.push(format!("seccomp={}", config.seccomp_profile));
        }

        let host_config = HostConfig {
            // 资源限制
            memory: Some(config.memory_limit_bytes),
            memory_swap: Some(config.memory_limit_bytes), // 禁止 swap 扩展
            nano_cpus: Some(config.nano_cpus),
            pids_limit: Some(config.pids_limit),
            // 安全
            cap_drop: Some(vec!["ALL".to_string()]),
            cap_add: None,
            security_opt: Some(security_opt),
            readonly_rootfs: Some(config.read_only_rootfs),
            init: Some(true),
            // 网络
            network_mode: Some(config.network_mode.clone()),
            // 挂载
            mounts: Some(vec![tmp_mount]),
            // 端口映射 (无,网络 none 模式不需要)
            port_bindings: Some(PortMap::default()),
            ..Default::default()
        };

        ContainerCreateBody {
            image: Some(config.image.clone()),
            user: Some(config.user.clone()),
            // 不分配 TTY (非交互式 exec 模式)
            tty: Some(false),
            open_stdin: Some(false),
            attach_stdin: Some(false),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            host_config: Some(host_config),
            ..Default::default()
        }
    }
}

impl Clone for SandboxManager {
    fn clone(&self) -> Self {
        Self {
            docker: self.docker.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::config::SandboxConfig;

    // 测试 1: 默认配置使用 alpine:3.20 (重复 config.rs 的测试,但验证 manager 视角)
    #[test]
    fn test_config_default_is_alpine_320() {
        let config = SandboxConfig::default();
        assert_eq!(config.image, "alpine:3.20");
    }

    // 测试 2: 默认配置 cap_drop 为 ALL (在 build_create_body 中硬编码)
    #[test]
    fn test_config_cap_drop_all() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        let cap_drop = host_config.cap_drop.expect("cap_drop missing");
        assert_eq!(cap_drop, vec!["ALL".to_string()]);
    }

    // 测试 3: 默认内存限制 512MB (在 HostConfig.memory 中正确设置)
    #[test]
    fn test_config_memory_limit_512mb() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.memory, Some(512 * 1024 * 1024));
        // memory_swap 应等于 memory (禁止 swap)
        assert_eq!(host_config.memory_swap, Some(512 * 1024 * 1024));
    }

    // 测试 4: 默认用户为 nobody:nobody (在 ContainerCreateBody.user 中)
    #[test]
    fn test_config_non_root_user() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        assert_eq!(body.user, Some("nobody:nobody".to_string()));
    }

    // 测试 5: 默认网络模式为 none
    #[test]
    fn test_config_network_none() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.network_mode, Some("none".to_string()));
    }

    // 测试 6: /tmp tmpfs 默认 64MB
    #[test]
    fn test_config_tmpfs_tmp_64mb() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        let mounts = host_config.mounts.expect("mounts missing");
        assert_eq!(mounts.len(), 1);
        let tmp_mount = &mounts[0];
        assert_eq!(tmp_mount.target.as_deref(), Some("/tmp"));
        let tmpfs_opts = tmp_mount.tmpfs_options.as_ref().expect("tmpfs_options missing");
        assert_eq!(tmpfs_opts.size_bytes, Some(64 * 1024 * 1024));
    }

    // 测试 7: 沙箱名前缀固定为 "tdsf-sandbox-"
    #[test]
    fn test_sandbox_name_prefix() {
        assert_eq!(SANDBOX_NAME_PREFIX, "tdsf-sandbox-");
    }

    // 测试 8: read_only_rootfs 默认为 true (defense in depth)
    #[test]
    fn test_readonly_rootfs_default_true() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.readonly_rootfs, Some(true));
    }

    // 测试 9: init 进程启用 (回收僵尸进程,防止 fork bomb 残留)
    #[test]
    fn test_init_enabled() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.init, Some(true));
    }

    // 测试 10: pids_limit 默认 256
    #[test]
    fn test_pids_limit_256() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.pids_limit, Some(256));
    }

    // 测试 11: nano_cpus 默认 1 CPU (1_000_000_000)
    #[test]
    fn test_nano_cpus_1_core() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.nano_cpus, Some(1_000_000_000));
    }

    // 测试 12: security_opt 包含 no-new-privileges
    #[test]
    fn test_security_opt_no_new_privileges() {
        let config = SandboxConfig::default();
        let body = SandboxManager::build_create_body(&config);
        let host_config = body.host_config.expect("host_config missing");
        let security_opt = host_config.security_opt.expect("security_opt missing");
        assert!(
            security_opt.iter().any(|s| s == "no-new-privileges"),
            "security_opt missing no-new-privileges: {:?}",
            security_opt
        );
    }

    // 测试 13: 自定义配置能正确传递 (如 ubuntu:24.04)
    #[test]
    fn test_custom_config_propagates() {
        let mut config = SandboxConfig::default();
        config.image = "ubuntu:24.04".to_string();
        config.memory_limit_bytes = 1024 * 1024 * 1024; // 1GB
        config.network_mode = "bridge".to_string();
        config.user = "sandbox:1000".to_string();

        let body = SandboxManager::build_create_body(&config);
        assert_eq!(body.image, Some("ubuntu:24.04".to_string()));
        let host_config = body.host_config.expect("host_config missing");
        assert_eq!(host_config.memory, Some(1024 * 1024 * 1024));
        assert_eq!(host_config.network_mode, Some("bridge".to_string()));
        assert_eq!(body.user, Some("sandbox:1000".to_string()));
    }

    // 测试 14: detect_transport_name 在不同平台返回正确值
    #[test]
    fn test_detect_transport_name() {
        let transport = SandboxManager::detect_transport_name();
        if cfg!(target_os = "windows") {
            assert_eq!(transport, "named_pipe");
        } else if cfg!(target_os = "linux") {
            assert_eq!(transport, "unix_socket");
        } else if cfg!(target_os = "macos") {
            assert_eq!(transport, "unix_socket");
        }
    }

    // 测试 15: is_docker_available 同步检测 (无 Docker 时不 panic)
    #[test]
    fn test_is_docker_available_does_not_panic() {
        // 仅验证函数能调用,不要求一定返回 true (CI 环境可能无 Docker)
        let _ = SandboxManager::is_docker_available();
    }

    // ---- 真实 Docker 集成测试 (#[ignore],CI 不跑) ----

    // 真实 Docker: 创建容器 → 启动 → exec → 删除
    #[tokio::test]
    #[ignore = "需要真实 Docker daemon,CI 不执行"]
    async fn integration_create_start_exec_remove() {
        let manager = match SandboxManager::new() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[integration] docker not available: {e}");
                return;
            }
        };

        // 创建
        let id = manager
            .create_container(SandboxConfig::default())
            .await
            .expect("create failed");
        eprintln!("[integration] container id: {id}");

        // 启动
        manager
            .start_container(&id)
            .await
            .expect("start failed");

        // exec
        let result = manager
            .exec_in_container(&id, vec!["echo".into(), "hello".into()])
            .await
            .expect("exec failed");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello"), "stdout: {}", result.stdout);

        // 删除
        manager
            .remove_container(&id)
            .await
            .expect("remove failed");
    }

    // 真实 Docker: detect_docker 返回版本信息
    #[tokio::test]
    #[ignore = "需要真实 Docker daemon,CI 不执行"]
    async fn integration_detect_docker() {
        let manager = match SandboxManager::new() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[integration] docker not available: {e}");
                return;
            }
        };
        let version = manager.detect_docker().await.expect("detect failed");
        eprintln!("[integration] docker version: {:?}", version);
        assert!(!version.version.is_empty());
        assert!(!version.api_version.is_empty());
    }

    // 真实 Docker: list_containers 返回沙箱列表
    #[tokio::test]
    #[ignore = "需要真实 Docker daemon,CI 不执行"]
    async fn integration_list_containers() {
        let manager = match SandboxManager::new() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[integration] docker not available: {e}");
                return;
            }
        };
        let list = manager.list_containers().await.expect("list failed");
        eprintln!("[integration] sandbox containers: {}", list.len());
    }
}
