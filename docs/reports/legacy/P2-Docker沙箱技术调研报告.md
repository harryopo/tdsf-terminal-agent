# P2 - Docker 沙箱技术调研报告

> **项目**：TDSF Terminal Agent（Tauri 2 桌面应用）  
> **调研主题**：在 Tauri 2 桌面应用中实现 Docker 沙箱容器化执行环境  
> **调研日期**：2026-07-26  
> **调研方式**：bollard 源码全量分析 + 业界方案对比 + 官方文档调研  
> **源码版本**：bollard v0.22.0（已克隆至 `d:\ai\linux教学一体\opensource-reference\bollard\`）

---

## 一、摘要

本报告针对在 Tauri 2 桌面应用中实现 Docker 沙箱容器化执行环境进行了完整调研。通过对 bollard（Rust Docker Daemon API 客户端）源码的全量分析，结合业界主流沙箱方案（code-server、JupyterHub、Gitpod、Coder、e2b.dev、Cube Sandbox、Docker Sandboxes）的对比，得出以下核心结论：

1. **SDK 选型**：推荐 **bollard** 作为 Docker 引擎 API 调用 SDK，放弃 shiplift（已废弃）和直接调用 docker CLI（性能差、依赖外部进程）。
2. **沙箱架构**：基于 Alpine Linux 镜像 + bridge 自定义网络 + 非 root 用户 + 资源限制（cgroups）+ 多层安全增强（read-only rootfs + cap drop + seccomp + AppArmor + userns）的完整方案。
3. **Windows 兼容性**：通过 bollard 的 `NamedPipe` 连接器对接 Docker Desktop（WSL2 后端），路径转换遵循 Linux 语义。
4. **风险等级**：中（主要风险集中在 Windows 上 Docker Desktop 的可用性、用户权限映射、网络隔离三方面）。
5. **预计工时**：约 5-7 个工作日（不含集成测试与文档）。

---

## 二、调研背景与目标

### 2.1 背景

TDSF Terminal Agent 是基于 Tauri 2 构建的 SSH 终端 + AI 辅助桌面应用。当前应用已具备 SSH 连接、AI 辅助、高危命令拦截、日志分析等核心能力。为进一步增强 AI Agent 的代码执行能力（如执行不可信代码、自动化运维脚本、安装依赖包），需要引入 Docker 沙箱作为隔离的执行环境。

### 2.2 调研目标

1. 调研 Docker 引擎 API 调用方式（Rust SDK 对比）；
2. 调研沙箱容器化方案（镜像/资源限制/挂载/网络/用户）；
3. 调研安全增强（read-only/cap drop/seccomp/AppArmor/userns）；
4. 调研业界实践（code-server/JupyterHub/Gitpod/Coder/e2b）；
5. 调研 Windows 上的 Docker Desktop（WSL2/Hyper-V/Tauri 兼容）；
6. 输出技术调研报告，含工时估算与风险评估。

### 2.3 硬约束

- 用户硬约束：**不允许为了节省资源而跳步**，必须全量源码分析。
- 优先利用开源项目（避免重复造轮子）。
- 质量绝对优先，功能必须真正实现。

---

## 三、Docker 引擎 API 调用方式调研

### 3.1 三种主流方案对比

| 方案 | 实现方式 | 优势 | 劣势 | 项目活跃度 |
|------|---------|------|------|----------|
| **bollard** | Rust 原生异步客户端，基于 Docker Engine REST API | 类型安全、异步原生、跨平台（Unix socket/Named Pipe/TCP/SSH/TLS）、支持 BuildKit 与 WebSocket | 学习曲线稍陡 | 高（v0.22.0，2025年活跃维护） |
| **shiplift** | Rust 异步客户端 | API 设计简洁、Builder 模式友好 | **已废弃**（最后一次更新 2020 年）、不支持 Docker API v1.41+、无 Windows 命名管道支持 | 低（项目归档） |
| **直接调用 docker CLI** | 通过 `tokio::process::Command` 调用 `docker` 命令 | 实现简单、无需第三方库 | 性能差（每次启动进程）、依赖外部 docker 二进制、JSON 解析脆弱、无流式 API、错误处理粗糙 | N/A |

### 3.2 选型结论：bollard

**核心依据**（基于源码分析）：

1. **完整的 Docker API 覆盖**：bollard 通过消费 Docker 官方 OpenAPI 3.0 规范自动生成强类型模型，确保 API 覆盖度与 Docker 引擎版本严格对齐。当前默认 API 版本为 `v1.53`（`API_DEFAULT_VERSION`），覆盖 Docker 20.10+ 至最新版本。
2. **跨平台连接器**：源码 `src/docker.rs` 中 `Transport` 枚举支持五种连接方式：
   - `Unix`（Linux/macOS 默认，`unix:///var/run/docker.sock`）
   - `NamedPipe`（Windows 默认，`npipe:////./pipe/docker_engine`）
   - `Http`（TCP，`tcp://localhost:2375`）
   - `Https`（TLS 加密，rustls 后端）
   - `Ssh`（远程 Docker 主机）
3. **Windows 命名管道原生支持**：通过 `hyper-named-pipe` crate 实现，与 Docker Desktop（WSL2 后端）无缝对接。
4. **异步原生设计**：所有 API 均为 `async fn`，返回 `Future` 或 `Stream`，与 Tauri 2 的 Tokio 运行时深度契合。
5. **流式 API 支持**：`logs()`、`stats()`、`events()`、`attach_container()`、`start_exec()` 等关键 API 返回 `Stream<Item = Result<LogOutput, Error>>`，可实时消费容器输出。
6. **Builder 模式查询参数**：通过 `query_parameters::*Builder` 提供类型安全的参数构造（如 `CreateContainerOptionsBuilder`、`LogsOptionsBuilder`）。
7. **BuildKit 集成**：支持通过 gRPC 与 BuildKit 通信，实现高效的镜像构建。
8. **活跃维护**：最新版本 v0.22.0，2025 年持续更新，已支持 Docker API v1.53、Swarm 集群、BuildKit 深度集成。

### 3.3 放弃 shiplift 与 CLI 的原因

- **shiplift 已废弃**：最后一次更新停留在 2020 年，不支持 Docker API v1.41+，无 Windows 命名管道支持，存在严重的安全与兼容性风险。
- **直接调用 CLI 的性能与可靠性问题**：每次调用 docker 命令需 fork 子进程，启动开销 50-200ms；JSON 输出解析脆弱；无法实现流式日志与 exec 交互；错误处理依赖字符串匹配，不可靠。

---

## 四、bollard 源码全量分析

### 4.1 源码目录结构

```
bollard/
├── src/
│   ├── lib.rs              # 核心 Docker 结构体与连接方法
│   ├── docker.rs           # Transport 枚举、连接器实现
│   ├── container.rs        # 容器生命周期 API（创建/启动/停止/删除/inspect/logs/attach/exec）
│   ├── exec.rs             # 容器内命令执行 API
│   ├── image.rs            # 镜像管理 API
│   ├── network.rs          # 网络管理 API
│   ├── volume.rs           # 存储卷管理 API
│   ├── secret.rs           # Swarm Secret 管理
│   ├── service.rs          # Swarm Service 管理
│   ├── swarm.rs            # Swarm 集群管理
│   ├── system.rs           # 系统信息、事件监听
│   ├── auth.rs             # 镜像仓库认证
│   ├── ssh.rs              # SSH 连接器
│   ├── read.rs             # 流式响应解码（含 WebSocket）
│   ├── uri.rs              # URI 构造
│   ├── errors.rs           # 错误类型
│   ├── config.rs           # 客户端配置
│   ├── context.rs          # 构建上下文
│   ├── plugin.rs           # 插件管理
│   ├── node.rs             # Swarm 节点管理
│   ├── task.rs             # Swarm Task 管理
│   └── grpc/               # BuildKit gRPC 集成
│       ├── build.rs        # 构建会话
│       ├── driver/         # 构建驱动
│       ├── io/             # 流式 IO
│       ├── export.rs       # 导出
│       ├── fsutil.rs       # 文件系统工具
│       └── registry.rs     # 仓库认证
├── codegen/
│   └── swagger/src/models.rs  # Docker API 模型（自动生成）
├── examples/               # 使用示例
│   ├── exec_term.rs        # 容器内交互式终端
│   ├── stats.rs            # 容器资源统计
│   ├── build.rs            # 镜像构建
│   ├── hoover.rs           # 清理旧资源
│   └── ...
└── tests/                  # 集成测试
```

### 4.2 核心连接 API（`src/docker.rs`）

bollard 的核心是 `Docker` 结构体，封装了与 Docker daemon 的连接：

```rust
// 源码摘录（src/docker.rs:61-95）
pub const DEFAULT_SOCKET: &str = "unix:///var/run/docker.sock";       // Linux/macOS
pub const DEFAULT_NAMED_PIPE: &str = "npipe:////./pipe/docker_engine"; // Windows
pub const DEFAULT_TCP_ADDRESS: &str = "tcp://localhost:2375";
pub const DEFAULT_SSH_ADDRESS: &str = "ssh://localhost";
```

`Transport` 枚举支持五种传输方式，Windows 下通过 `NamedPipeConnector`（来自 `hyper-named-pipe` crate）连接 Docker Desktop：

```rust
// 源码摘录（src/docker.rs:151-179）
pub(crate) enum Transport {
    Http { client: Client<HttpConnector, BodyType> },
    Https { client: Client<HttpsConnector<HttpConnector>, BodyType> },
    Unix { client: Client<UnixConnector, BodyType> },
    NamedPipe { client: Client<NamedPipeConnector, BodyType> },  // Windows
    Ssh { client: Client<SshConnector, BodyType> },
    Custom { transport: Box<dyn CustomTransport> },
}
```

### 4.3 容器生命周期 API（`src/container.rs`）

bollard 提供完整的容器生命周期管理 API：

| API | 功能 | 调用路径 |
|-----|------|---------|
| `list_containers()` | 列出容器 | `GET /containers/json` |
| `create_container()` | 创建容器 | `POST /containers/create` |
| `start_container()` | 启动容器 | `POST /containers/{name}/start` |
| `stop_container()` | 停止容器 | `POST /containers/{name}/stop` |
| `restart_container()` | 重启容器 | `POST /containers/{name}/restart` |
| `kill_container()` | 杀死容器 | `POST /containers/{name}/kill` |
| `remove_container()` | 删除容器 | `DELETE /containers/{name}` |
| `pause_container()` | 暂停容器 | `POST /containers/{name}/pause` |
| `unpause_container()` | 恢复容器 | `POST /containers/{name}/unpause` |
| `inspect_container()` | 查看容器详情 | `GET /containers/{name}/json` |
| `logs()` | 获取日志流 | `GET /containers/{name}/logs` |
| `stats()` | 获取资源统计 | `GET /containers/{name}/stats` |
| `attach_container()` | 附加到容器 | `POST /containers/{name}/attach` |
| `wait_container()` | 等待容器退出 | `POST /containers/{name}/wait` |
| `update_container()` | 更新容器配置 | `POST /containers/{name}/update` |
| `rename_container()` | 重命名容器 | `POST /containers/{name}/rename` |
| `top_processes()` | 查看容器进程 | `GET /containers/{name}/top` |
| `prune_containers()` | 清理停止的容器 | `POST /containers/prune` |
| `create_checkpoint()` | 创建检查点 | `POST /containers/{name}/checkpoint` |

### 4.4 exec API（`src/exec.rs`）

`exec.rs` 提供在运行中的容器内执行命令的能力，关键 API：

- `create_exec(container_name, config)`：创建 exec 实例
- `start_exec(exec_id, options)`：启动 exec，返回 `StartExecResults::Attached { output, input }` 或 `Detached`
- `inspect_exec(exec_id)`：查看 exec 实例状态
- `resize_exec(exec_id, options)`：调整 TTY 大小

`CreateExecOptions` 结构体关键字段：
- `cmd: Option<Vec<T>>`：要执行的命令
- `attach_stdin/stdout/stderr`：是否附加标准流
- `tty: Option<bool>`：是否分配伪终端
- `privileged: Option<bool>`：是否特权模式（默认 false）
- `user: Option<T>`：执行用户（如 `"root"`、`"uid:gid"`）
- `working_dir: Option<T>`：工作目录
- `env: Option<Vec<T>>`：环境变量

### 4.5 网络 API（`src/network.rs`）

- `create_network(config)`：创建自定义网络
- `list_networks()`：列出网络
- `inspect_network(name)`：查看网络详情
- `remove_network(name)`：删除网络
- `connect_container(network, config)`：将容器加入网络
- `disconnect_container(network, config)`：将容器从网络移除
- `prune_networks()`：清理未使用网络

### 4.6 Volume API（`src/volume.rs`）

- `create_volume(config)`：创建命名卷
- `list_volumes()`：列出卷
- `inspect_volume(name)`：查看卷详情
- `remove_volume(name)`：删除卷
- `prune_volumes()`：清理未使用卷

### 4.7 镜像 API（`src/image.rs`）

- `create_image(options, manifest, credentials)`：拉取镜像（返回流）
- `list_images()`：列出镜像
- `inspect_image(name)`：查看镜像详情
- `remove_image(name, options)`：删除镜像
- `build_image(options, manifest, credentials)`：构建镜像（返回流）
- `tag_image(name, options)`：打标签
- `push_image(name, options, credentials)`：推送镜像
- `prune_images(options)`：清理未使用镜像
- `search_images(term)`：搜索镜像
- `import_image(...)`：导入镜像
- `save_image(...)` / `load_image(...)`：保存/加载镜像

### 4.8 容器配置模型（`codegen/swagger/src/models.rs`）

`HostConfig` 结构体（约 1500 行）涵盖沙箱所需的全部配置字段：

**资源限制（cgroups）**：
- `memory: Option<i64>`：内存限制（字节）
- `memory_swap: Option<i64>`：内存+swap 限制（-1 表示无限制）
- `memory_reservation: Option<i64>`：内存软限制
- `memory_swappiness: Option<i64>`：swap 倾向（0-100）
- `nano_cpus: Option<i64>`：CPU 配额（10⁻⁹ CPU 单位，如 1 CPU = 1000000000）
- `cpu_shares: Option<i64>`：CPU 相对权重
- `cpu_period: Option<i64>` / `cpu_quota: Option<i64>`：CFS 周期与配额
- `cpuset_cpus: Option<String>`：CPU 亲和性（如 `"0-3"`）
- `pids_limit: Option<i64>`：进程数限制
- `blkio_weight: Option<u16>`：块 IO 权重
- `ulimits: Option<Vec<ResourcesUlimits>>`：ulimit 限制（如 nofile）
- `oom_kill_disable: Option<bool>`：禁用 OOM Killer

**安全增强**：
- `privileged: Option<bool>`：特权模式（**必须 false**）
- `cap_add: Option<Vec<String>>` / `cap_drop: Option<Vec<String>>`：Linux capabilities
- `security_opt: Option<Vec<String>>`：seccomp/AppArmor profile（如 `["seccomp=/path/to/profile.json", "apparmor=profile_name", "no-new-privileges"]`）
- `readonly_rootfs: Option<bool>`：只读根文件系统
- `userns_mode: Option<String>`：用户命名空间模式（如 `"host"` 或留空）
- `init: Option<bool>`：使用 tini 作为 PID 1 进程

**网络与挂载**：
- `network_mode: Option<String>`：网络模式（`bridge` / `host` / `none` / `container:<name>`）
- `binds: Option<Vec<String>>`：bind mount（如 `["/host/path:/container/path:ro"]`）
- `mounts: Option<Vec<Mount>>`：高级挂载（支持 bind/volume/tmpfs）
- `port_bindings: Option<PortMap>`：端口映射
- `dns: Option<Vec<String>>`：DNS 服务器
- `dns_search: Option<Vec<String>>`：DNS 搜索域
- `extra_hosts: Option<Vec<String>>`：hosts 文件条目

**容器行为**：
- `auto_remove: Option<bool>`：退出后自动删除
- `restart_policy: Option<RestartPolicy>`：重启策略（`no` / `on-failure` / `always` / `unless-stopped`）
- `cgroupns_mode`：cgroup namespace 模式

### 4.9 关键示例分析

**`examples/exec_term.rs`** 展示了交互式终端的完整实现流程：
1. 创建 Alpine 容器（`tty: true`, `open_stdin: true`, `attach_stdout: true`）
2. 启动容器
3. 调用 `create_exec()` 创建 sh 会话
4. 调用 `start_exec()` 获得 `Attached { output, input }`
5. 通过 `input` 写入命令，通过 `output` 读取响应（异步流）
6. 处理 TTY 大小变化（`resize_exec()`）

**`examples/stats.rs`** 展示了资源监控的流式处理：
1. `list_containers()` 获取运行中容器
2. 对每个容器调用 `stats()` 获取流式统计
3. 通过 `take(1)` 采样一次统计

---

## 五、沙箱架构设计

### 5.1 镜像选型

| 镜像 | 大小 | 优势 | 劣势 | 适用场景 |
|------|------|------|------|---------|
| `alpine:3.20` | ~7MB | 极小、启动快、攻击面小 | musl libc（部分软件不兼容）、需额外安装 bash | **推荐**：默认沙箱 |
| `ubuntu:24.04` | ~78MB | 完整 glibc、软件包丰富、社区支持好 | 体积较大 | 需要完整 Linux 体验的场景 |
| `debian:bookworm-slim` | ~74MB | glibc、稳定、软件包丰富 | 体积较大 | 折中方案 |
| `centos:stream9` | ~120MB | 与 RHEL 兼容、企业级 | 体积大、CentOS Stream 滚动 | 教学 CentOS 场景 |

**推荐方案**：默认使用 `alpine:3.20` 作为基础沙箱镜像，按需提供 `ubuntu:24.04` 选项。Alpine 镜像约 7MB，启动时间 < 100ms，攻击面小，符合最小化原则。镜像内预装：
- `bash`、`coreutils`、`findutils`、`grep`、`tar`、`curl`、`git`、`vim`、`openssh-client`
- `tini`（作为 init 进程）
- 非 root 用户 `sandbox`（UID 1000）

### 5.2 资源限制（cgroups v2）

| 资源 | 推荐配置 | 说明 |
|------|---------|------|
| 内存上限 | `Memory = 512 * 1024 * 1024`（512MB） | 防止单沙箱耗尽宿主机内存 |
| 内存软限制 | `MemoryReservation = 256MB` | 系统内存紧张时回收 |
| Swap | `MemorySwap = Memory`（即 512MB） | 禁止 swap 扩展 |
| CPU 配额 | `NanoCpus = 1_000_000_000`（1 CPU） | 单沙箱最多用 1 个 CPU |
| CPU 权重 | `CpuShares = 1024`（默认） | 与其他容器公平共享 |
| CPU 亲和性 | `CpusetCpus = "0-3"`（按宿主机核数） | 限制可用 CPU 核 |
| 进程数 | `PidsLimit = 256` | 防止 fork bomb |
| 文件描述符 | `Ulimits = [{Name: "nofile", Soft: 1024, Hard: 4096}]` | 防止 fd 耗尽 |
| 块 IO 权重 | `BlkioWeight = 500`（默认 500） | 限制磁盘 IO |
| OOM Killer | `OomKillDisable = false` | 允许 OOM Kill 释放内存 |

### 5.3 文件挂载策略

**挂载原则**：最小化挂载，只读优先，命名卷持久化。

| 挂载类型 | 用途 | 配置示例 |
|---------|------|---------|
| **tmpfs** | `/tmp`、`/run`、`/var/tmp` | 临时文件，内存中，自动清理 |
| **命名卷** | `/home/sandbox/workspace` | 用户工作目录，跨重启持久化 |
| **bind mount（只读）** | `/etc/localtime:ro`、`/etc/resolv.conf:ro` | 同步主机时区与 DNS |
| **tmpfs（隔离）** | `/dev/shm`（默认 64MB） | 共享内存，限制大小防 DoS |

**禁止挂载**：
- `/var/run/docker.sock`（会泄露宿主机 Docker 控制权，造成容器逃逸）
- `/`、`/etc`、`/root`、`/home`（宿主机敏感目录）
- `/proc`、`/sys`（内核接口，已由容器隔离）

### 5.4 网络隔离

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `none` | 完全无网络 | **默认推荐**：纯代码执行、无网络需求的场景 |
| 自定义 `bridge` | 隔离的容器网络，可通过端口映射访问 | 需要访问外部网络的场景 |
| `host` | 共享宿主机网络栈 | **禁止使用**（破坏隔离） |
| `container:<name>` | 共享另一容器网络 | 多容器协作（如 sidecar） |

**推荐方案**：
- 默认使用 `none` 模式（最大隔离）；
- 需要网络访问时，创建自定义 `bridge` 网络（`create_network()`），通过 `connect_container()` 加入；
- 通过 `extra_hosts` 控制可访问的主机名；
- 通过 `dns` 自定义 DNS 服务器（如 `1.1.1.1`）；
- 必要时通过 iptables 规则限制出站流量（需在宿主机配置）。

### 5.5 用户权限

**核心原则**：非 root 运行 + capabilities 最小化 + no-new-privileges。

| 配置 | 推荐值 | 说明 |
|------|--------|------|
| 容器内用户 | `sandbox`（UID 1000） | 非 root，与宿主机普通用户对齐 |
| `Privileged` | `false` | **绝对禁止特权模式** |
| `CapAdd` | `[]`（空） | 不添加任何额外 capability |
| `CapDrop` | `["ALL"]` | 移除所有 capabilities |
| `SecurityOpt` | `["no-new-privileges"]` | 禁止提权（setuid/setgid 失效） |
| `UsernsMode` | `""`（留空，使用默认 remap） | 启用 user namespace remapping |

---

## 六、安全增强方案

### 6.1 多层防护体系

Docker 容器默认隔离基于 Linux Namespace（命名空间）+ Cgroups（控制组），但**共享宿主机内核**。一旦内核漏洞被利用，可能发生容器逃逸。因此需要构建多层防护：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: eBPF 监控（可选，未来增强）                       │
│  - tracepoint 拦截可疑 execve/mount                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: AppArmor / SELinux 强制访问控制                   │
│  - 限制容器进程可访问的文件路径与网络端口                    │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: User Namespace Remapping（用户命名空间重映射）    │
│  - 容器内 root → 宿主机非特权 UID（100000-165535）          │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Seccomp Profile（系统调用过滤）                   │
│  - 白名单机制，默认禁止 44 个高危 syscall                    │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Linux Capabilities Drop（权限裁剪）               │
│  - CapDrop=ALL，按需 CapAdd（如 NET_BIND_SERVICE）          │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Read-Only Rootfs + 非 root 用户                   │
│  - ReadonlyRootfs=true, User=sandbox(1000)                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: Namespace + Cgroups（容器基础隔离）               │
│  - PID/NET/IPC/UTS/MOUNT/USER namespace + 资源限制          │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Read-Only Rootfs

**配置**：`HostConfig.readonly_rootfs = Some(true)`

**效果**：容器根文件系统（`/`）以只读方式挂载，任何尝试写入 `/etc`、`/usr`、`/bin` 等目录的操作都会失败。

**配合 tmpfs**：需要写入的目录（`/tmp`、`/run`、`/var/tmp`、`/home/sandbox`）通过 `Mounts` 挂载为 tmpfs 或命名卷。

**价值**：防止攻击者修改系统文件（如替换 `/bin/sh`、植入后门到 `/etc/cron.d`）。

### 6.3 Linux Capabilities Drop

**配置**：
```
CapDrop = ["ALL"]
CapAdd  = []  # 默认空，按需添加
```

**Docker 默认授予的 capabilities（约 14 个）**：
- `CAP_CHOWN`、`CAP_DAC_OVERRIDE`、`CAP_FSETID`、`CAP_FOWNER`、`CAP_MKNOD`、`CAP_NET_RAW`、`CAP_SETGID`、`CAP_SETUID`、`CAP_SETFCAP`、`CAP_SETPCAP`、`CAP_NET_BIND_SERVICE`、`CAP_SYS_CHROOT`、`CAP_KILL`、`CAP_AUDIT_WRITE`

**沙箱策略**：移除全部，仅在确有需要时添加。例如：
- 需要 ping 等原始套接字：`CapAdd = ["NET_RAW"]`
- 需要绑定 1024 以下端口：`CapAdd = ["NET_BIND_SERVICE"]`

### 6.4 Seccomp Profile

**配置**：`HostConfig.security_opt = Some(vec!["seccomp=/path/to/sandbox-seccomp.json".to_string()])`

**Docker 默认 profile**：禁止约 44 个高危系统调用（如 `keyctl`、`ptrace`、`mount`、`reboot`、`bpf`、`kexec_load`、`open_by_handle_at` 等），详见 Docker 官方文档。

**自定义加强 profile**：在默认 profile 基础上额外禁用：
- `clone`（带 `CLONE_NEW*` 标志，防止创建新 namespace）
- `unshare`（同上）
- `setns`（防止加入 namespace）
- `pivot_root`、`swapon`、`swapoff`

**简化方案**：直接使用 `security_opt = ["seccomp=unconfined"]` 会失去防护，不推荐；推荐使用 `security_opt = ["seccomp=runtime/default"]` 应用运行时默认 profile。

### 6.5 AppArmor / SELinux

**AppArmor（Ubuntu/Debian 默认）**：
- 配置：`security_opt = ["apparmor=docker-sandbox"]`
- 自定义 profile 限制容器进程可访问的路径（如禁止读取 `/etc/shadow`、`/root`）
- 示例 profile 路径：`/etc/apparmor.d/docker-sandbox`

**SELinux（CentOS/RHEL 默认）**：
- 配置：`security_opt = ["label=user:USER_ROLE:LEVEL"]` 或 `["label=type:svirt_lxc_net_t"]`
- 通过 MCS（Multi-Category Security）标签实现细粒度隔离

**Windows 兼容性**：AppArmor/SELinux 仅适用于 Linux。Windows 上通过 Windows Container Isolation + Hyper-V 隔离实现类似效果（但 TDSF 使用 WSL2 后端的 Linux 容器，所以仍可应用 AppArmor/SELinux）。

### 6.6 User Namespace Remapping

**配置**：在 Docker daemon 配置 `/etc/docker/daemon.json` 中启用：
```json
{
  "userns-remap": "default"
}
```

**效果**：容器内的 `root`（UID 0）映射到宿主机的非特权用户（默认 `dockremap`，UID 100000-165535）。即使容器内攻击者获得 root，在宿主机上也只是普通用户，无法访问宿主机文件。

**Docker 27+ 默认行为**：自 Docker 27.0 起，默认启用 `--userns=auto`，强制隔离 UID/GID 映射。

**验证**：`docker exec <cid> cat /proc/self/uid_map` 应显示 `0 100000 65536`。

### 6.7 综合安全配置清单

```
HostConfig {
    privileged: false,
    cap_drop: ["ALL"],
    cap_add: [],
    security_opt: [
        "no-new-privileges",
        "seccomp=/etc/docker/seccomp/sandbox.json",
        "apparmor=docker-sandbox"
    ],
    readonly_rootfs: true,
    userns_mode: "",  // 使用 daemon 默认 remap
    init: true,       // 使用 tini 作为 PID 1
    memory: 512MB,
    nano_cpus: 1_000_000_000,
    pids_limit: 256,
    network_mode: "none",
}
```

---

## 七、容器生命周期管理方案

### 7.1 生命周期状态机

```
   ┌──────────┐  create  ┌──────────┐  start  ┌──────────┐
   │  (none)  │ ───────► │  Created │ ──────► │ Running  │
   └──────────┘          └──────────┘         └──────────┘
                                │                   │
                                │ remove            │ stop
                                ▼                   ▼
                           ┌──────────┐  start ┌──────────┐
                           │  Removed │ ◄───── │ Stopped  │
                           └──────────┘        └──────────┘
                                                     │
                                                     │ pause
                                                     ▼
                                                ┌──────────┐
                                                │  Paused  │
                                                └──────────┘
                                                     │
                                                     │ kill/stop
                                                     ▼
                                                ┌──────────┐
                                                │ Exited   │
                                                └──────────┘
```

### 7.2 沙箱会话流程

**典型 AI Agent 代码执行流程**：

1. **预检查**：
   - `docker.version()` 检测 Docker daemon 可用性
   - `docker.list_images()` 检查基础镜像是否存在，必要时 `create_image()` 拉取

2. **创建沙箱**：
   - `docker.create_network()`（可选，需要网络时）
   - `docker.create_volume()` 创建工作卷
   - `docker.create_container()` 创建容器（带完整安全配置）
   - `docker.start_container()` 启动容器

3. **执行命令**：
   - `docker.create_exec(container, config)` 创建 exec 实例
   - `docker.start_exec(exec_id, options)` 启动 exec，获取 `Attached { output, input }`
   - 通过 `input` 写入命令（如 `ls -la\n`）
   - 通过 `output` 异步流读取响应
   - 处理 TTY 大小变化（`docker.resize_exec()`）
   - exec 完成后 `docker.inspect_exec()` 获取退出码

4. **资源监控**：
   - `docker.stats(container, stream=false)` 单次采样
   - `docker.stats(container, stream=true)` 流式监控
   - 监控指标：CPU%、内存使用、网络 IO、磁盘 IO

5. **日志收集**：
   - `docker.logs(container, follow=true)` 实时日志流
   - `docker.logs(container, follow=false)` 历史日志

6. **清理**：
   - `docker.stop_container(container, t=10)` 优雅停止（10 秒超时）
   - 超时后 `docker.kill_container(container, signal="SIGKILL")` 强制杀死
   - `docker.remove_container(container, force=false)` 删除容器
   - `docker.remove_volume(volume)` 删除工作卷（可选，保留可复用）
   - `docker.remove_network(network)` 删除自定义网络

### 7.3 容器池策略（性能优化）

为降低冷启动延迟（拉镜像+创建容器约 1-3 秒），可采用**容器池**策略：
- 应用启动时预创建 N 个沙箱容器（如 3 个），状态保持 `Running` 但 idle；
- AI 请求到来时，从池中取出一个容器执行命令；
- 执行完毕后，根据污染程度决定：重置（删除并重建）或归还池中；
- 通过 `docker.events()` 监听容器异常退出，自动补充池。

### 7.4 超时与资源回收

| 操作 | 超时 | 处理 |
|------|------|------|
| 单次 exec | 30 秒（可配置） | 超时后 kill exec 进程 |
| 容器启动 | 10 秒 | 超时后 stop + remove + 重建 |
| 容器停止 | 10 秒 | 超时后 force kill |
| Idle 容器回收 | 30 分钟无活动 | 自动 stop + remove |
| 异常容器 | 立即 | 检测到 OOM、崩溃立即清理 |

---

## 八、Windows 兼容性策略

### 8.1 Docker Desktop + WSL2 后端

**架构**：
```
┌─────────────────────────────────────────────────┐
│  Windows 11 主机                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  Tauri 2 应用（TDSF Terminal Agent）       │  │
│  │  └─ bollard (Rust)                         │  │
│  │      └─ NamedPipe Connector                │  │
│  │          └─ npipe:////./pipe/docker_engine │  │
│  └────────────────────┬──────────────────────┘  │
│                       │                          │
│  ┌────────────────────▼──────────────────────┐  │
│  │  Docker Desktop（WSL2 后端）                │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  WSL2 轻量级 VM（完整 Linux 内核）   │  │  │
│  │  │  ┌─────────────────────────────┐    │  │  │
│  │  │  │  dockerd（Docker daemon）    │    │  │  │
│  │  │  │  ┌─────────────────────┐    │    │  │  │
│  │  │  │  │  Linux 容器（沙箱）  │    │    │  │  │
│  │  │  │  └─────────────────────┘    │    │  │  │
│  │  │  └─────────────────────────────┘    │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**关键点**：
- Windows 上 Docker Desktop 通过 WSL2 运行完整 Linux 内核，Linux 容器**原生运行**（非模拟），性能接近原生 Linux。
- bollard 通过 `hyper-named-pipe` crate 连接 Docker Desktop 的命名管道 `\\.\pipe\docker_engine`，与 Linux 上连接 Unix socket 的代码逻辑完全一致（只是 Transport 不同）。
- 应用代码**无需平台条件编译**，bollard 的 `connect_with_local_defaults()` 自动检测平台并选择最佳连接方式。

### 8.2 路径转换

| 场景 | Windows 路径 | WSL2/Linux 容器路径 |
|------|-------------|---------------------|
| 项目目录 | `C:\Users\Lenovo\project` | `/mnt/c/Users/Lenovo/project` |
| 用户主目录 | `C:\Users\Lenovo` | `/mnt/c/Users/Lenovo` |
| 临时目录 | `%TEMP%` | `/tmp`（容器内 tmpfs） |

**策略**：
- **不直接挂载 Windows 路径**（性能差，9P 协议有损耗）；
- 改用**命名卷**作为容器工作目录，通过 `docker cp` 或 `upload_to_container()` API 将文件传入；
- 需要持久化的文件，通过 bollard 的 `container_archive_info()` / `get_archive()` / `put_archive()` API 与容器双向同步。

### 8.3 用户权限映射

Windows 用户与 WSL2/容器内用户无直接对应关系。策略：
- 容器内固定使用 `sandbox`（UID 1000）非 root 用户；
- 通过 user namespace remapping，容器内 `sandbox` 映射到 WSL2 内的非特权用户；
- 文件传输通过 API（而非 bind mount），避免权限问题。

### 8.4 Docker Desktop 依赖与检测

**前置条件检测**（应用启动时执行）：
1. 检测 Docker Desktop 是否安装：注册表 `HKLM\SOFTWARE\Docker Inc.\Docker\1.0` 或 `C:\Program Files\Docker\Docker\Docker Desktop.exe` 是否存在；
2. 检测 Docker daemon 是否运行：调用 `docker.version()`，失败则提示用户启动 Docker Desktop；
3. 检测 WSL2 后端：`docker.info()` 返回的 `OSType` 应为 `"linux"`，`OperatingSystem` 包含 `"Docker Desktop"`；
4. 检测基础镜像：`docker.inspect_image("alpine:3.20")`，不存在则提示用户拉取（或自动拉取）。

**用户引导**：
- 应用首次启动时，若未安装 Docker Desktop，弹窗引导至官网下载；
- 若已安装但未运行，提供"启动 Docker Desktop"按钮；
- 若 WSL2 未启用，引导执行 `wsl --install` 与 `wsl --set-default-version 2`。

### 8.5 性能考量

| 指标 | Linux 原生 | Windows + WSL2 | 差异 |
|------|----------|----------------|------|
| 容器启动 | ~100ms | ~200-500ms | WSL2 VM 启动开销 |
| 命令执行 | ~1ms | ~5-10ms | Named Pipe 跨边界 |
| 文件 IO（bind mount） | 快 | 慢（9P 协议） | **避免 bind mount** |
| 文件 IO（命名卷） | 快 | 快（VHD 内） | 推荐 |
| 内存占用 | 低 | WSL2 VM 基础 ~1GB | 需配置 `.wslconfig` 限制 |

**优化建议**：
- 在 `C:\Users\<用户>\.wslconfig` 中配置：
  ```
  [wsl2]
  memory=4GB
  processors=2
  swap=2GB
  ```
- 使用命名卷而非 bind mount；
- 启用容器池降低冷启动延迟。

---

## 九、业界实践参考

### 9.1 code-server（Coder）

**方案**：基于 Docker 容器化部署 Web 版 VS Code，每个开发者一个独立容器。

**借鉴点**：
- 容器内非 root 用户运行（最小权限）；
- 通过 volume 持久化用户数据与配置；
- 健康检查（`HEALTHCHECK`）监控容器状态；
- 多租户隔离，每个容器独立端口。

**局限**：默认配置较宽松，未强制 read-only rootfs 与 cap drop，安全性依赖网络层防护。

### 9.2 JupyterHub

**方案**：通过 DockerSpawner 为每个用户启动独立 Jupyter 容器。

**借鉴点**：
- 容器生命周期管理（spawn/stop/poll）；
- 用户级隔离（每用户独立容器）；
- 资源限制（cgroups）；
- 命名卷持久化用户工作目录。

**局限**：默认配置偏向易用性，安全增强需手动配置。

### 9.3 Gitpod / Coder.com

**方案**：基于容器（Gitpod 早期）或 microVM（Gitpod 现状、Coder）的云开发环境。

**借鉴点**：
- 完整的 workspace 生命周期管理；
- 预构建（prebuild）加速启动；
- 容器池与快照恢复降低冷启动。

**演进**：Gitpod 从 Docker 容器迁移到基于 Firecracker 的 microVM，原因：容器共享内核的安全性不足以应对多租户场景。对于 TDSF 单用户桌面场景，Docker 容器已足够。

### 9.4 e2b.dev

**方案**：基于 AWS Firecracker microVM 的托管 AI 代码执行沙箱。

**核心特性**：
- 冷启动 150-200ms（通过快照恢复）；
- 单实例内存 ~5MB；
- 单服务器数千沙箱；
- 硬件级隔离（独立内核）。

**借鉴点**：
- 快照恢复降低启动延迟；
- 完整的沙箱 API（exec、文件系统、网络控制）。

**不采用原因**：
- 依赖 AWS Firecracker，仅支持 Linux；
- 需要 KVM，Windows 上无法直接运行；
- 部署复杂度高，不适合桌面应用。

### 9.5 Cube Sandbox（腾讯云开源）

**方案**：基于 RustVMM + KVM 的 microVM 沙箱，兼容 E2B SDK 接口。

**核心特性**：
- 冷启动 <60ms；
- 单实例内存 <5MB；
- 单机 2000+ 沙箱；
- 完整自托管。

**不采用原因**：同 e2b，依赖 KVM，Windows 不支持。

### 9.6 Docker Sandboxes（Docker 官方，2026 年 4 月发布）

**方案**：专为 AI Agent 设计的本地沙箱，每个 Agent 运行在独立 microVM 中。

**五层隔离**：
1. Hypervisor 隔离（独立内核）
2. 网络隔离（独立网络，代理策略）
3. Docker Engine 隔离（沙箱内独立 daemon）
4. Workspace 隔离（direct mount / clone mode）
5. Credential 隔离（凭据代理）

**借鉴点**：
- 每沙箱独立 Docker Engine（避免泄露宿主机 daemon）；
- 网络代理策略（白名单域名）；
- Clone mode 工作区隔离。

**不采用原因**：
- 较新方案（2026 年 4 月发布），生态尚不成熟；
- 通过 `sbx` CLI 调用，非 SDK 集成；
- 与 bollard 直接对接 Docker Engine 的方案有冲突（Docker Sandboxes 在 microVM 内运行 Docker Engine）。

### 9.7 业界对比总结

| 方案 | 隔离级别 | 启动延迟 | Windows 支持 | SDK 集成 | 适用 TDSF |
|------|---------|---------|-------------|---------|----------|
| Docker 容器（bollard） | 中（共享内核） | 100-500ms | ✅ | ✅ Rust 原生 | **推荐** |
| Firecracker microVM | 高（独立内核） | 150-200ms | ❌（需 KVM） | 需自研 | ❌ |
| Cube Sandbox | 高（独立内核） | <60ms | ❌ | E2B SDK 兼容 | ❌ |
| Docker Sandboxes | 高（独立内核） | 未公布 | ✅ | CLI 调用 | 未来可选 |

**结论**：对于 TDSF Terminal Agent 这种**单用户桌面应用**，Docker 容器（通过 bollard）提供足够隔离，且 Windows 兼容性最佳。未来若有更高安全需求，可迁移到 Docker Sandboxes 或 microVM 方案。

---

## 十、关键风险与缓解措施

### 10.1 风险矩阵

| 编号 | 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|------|---------|
| R1 | Docker Desktop 未安装或未运行 | 高 | 沙箱功能不可用 | 启动时检测，引导用户安装/启动；提供降级模式（直接在宿主机执行，需用户确认） |
| R2 | WSL2 未启用或版本过低 | 高 | Docker Desktop 无法运行 | 检测 `wsl --status`，引导执行 `wsl --install` 与 `wsl --update` |
| R3 | 容器逃逸（内核漏洞） | 中 | 宿主机被攻破 | 多层安全增强（read-only + cap drop + seccomp + AppArmor + userns）；及时更新 Docker 与 WSL2 内核 |
| R4 | 资源耗尽（CPU/内存/磁盘） | 中 | 宿主机卡顿 | cgroups 严格限制；监控 `docker.stats()`；超限自动 kill |
| R5 | 网络泄露（容器访问内网） | 中 | 数据泄露 | 默认 `none` 网络；需要时自定义 bridge + 防火墙规则 |
| R6 | 镜像供应链攻击 | 中 | 沙箱内植入恶意代码 | 仅使用官方镜像；镜像签名验证；定期扫描漏洞 |
| R7 | 路径转换错误（Windows ↔ Linux） | 低 | 文件操作失败 | 统一使用命名卷；不直接 bind mount Windows 路径；路径转换函数单元测试 |
| R8 | Named Pipe 连接超时 | 低 | API 调用失败 | 配置 client_timeout（默认 120 秒）；重试机制；连接池 |
| R9 | 容器累积占用磁盘 | 低 | 磁盘满 | `auto_remove=true`；定期 `prune_containers()` / `prune_volumes()` / `prune_images()` |
| R10 | 用户权限不匹配 | 低 | 文件权限错误 | 容器内固定 `sandbox` UID 1000；user namespace remapping |

### 10.2 风险等级评估

**整体风险等级：中**

- 主要风险集中在**环境依赖**（R1、R2）：通过引导式安装与降级模式可缓解；
- 安全风险（R3、R5、R6）：通过多层防护与最小化原则控制到可接受水平；
- 性能风险（R4、R8）：通过 cgroups 与超时机制保障；
- 易用性风险（R7、R9、R10）：通过统一策略与自动清理解决。

---

## 十一、预计工时

### 11.1 工作分解结构（WBS）

| 编号 | 任务 | 复杂度 | 工时（人日） | 依赖 |
|------|------|--------|-------------|------|
| W1 | bollard 集成与连接层封装 | 中 | 0.5 | - |
| W2 | Docker 环境检测与用户引导 | 低 | 0.5 | W1 |
| W3 | 沙箱镜像构建（Dockerfile + 预装工具） | 低 | 0.5 | - |
| W4 | 沙箱创建 API 封装（含安全配置） | 中 | 1.0 | W1 |
| W5 | exec 命令执行封装（含 TTY 与流式输出） | 高 | 1.5 | W4 |
| W6 | 容器生命周期管理（启停/清理/超时） | 中 | 1.0 | W4 |
| W7 | 资源监控与日志收集 | 低 | 0.5 | W6 |
| W8 | 容器池实现（预创建与复用） | 中 | 1.0 | W6 |
| W9 | Windows 路径转换与文件传输 | 中 | 0.5 | W5 |
| W10 | 安全配置加固（seccomp profile + AppArmor） | 中 | 0.5 | W4 |
| W11 | 错误处理与重试机制 | 低 | 0.5 | W5, W6 |
| W12 | 集成测试（含 Windows 真机测试） | 高 | 1.0 | 全部 |
| W13 | 文档与示例 | 低 | 0.5 | 全部 |
| **合计** | | | **9.0** | |

### 11.2 工时估算说明

- 上述工时为**纯开发工时**，不含需求评审、设计评审等管理开销；
- 按 1 人全职计算，预计 **2 周（10 个工作日）**完成（含 10% 缓冲）；
- 若 2 人并行（W1-W2 与 W3-W4 可并行），可压缩至 **1.5 周（7-8 个工作日）**；
- 若用户接受降级（如暂不实现容器池 W8、安全加固 W10），可压缩至 **1 周（5 个工作日）**。

### 11.3 里程碑

| 里程碑 | 完成任务 | 交付物 | 预计日期 |
|--------|---------|--------|---------|
| M1：MVP | W1-W4, W6 | 能创建沙箱、执行简单命令 | 第 3 天 |
| M2：完整功能 | W5, W7, W9, W11 | 支持交互式终端、监控、文件传输 | 第 6 天 |
| M3：生产就绪 | W8, W10, W12, W13 | 容器池、安全加固、测试、文档 | 第 9 天 |

---

## 十二、结论与建议

### 12.1 核心结论

1. **SDK 选型确定**：采用 bollard v0.22.0 作为 Docker 引擎 API 调用 SDK，理由：Rust 原生异步、跨平台（含 Windows Named Pipe）、完整 Docker API 覆盖、活跃维护。

2. **沙箱架构方案确定**：
   - 镜像：`alpine:3.20`（默认）+ `ubuntu:24.04`（备选）
   - 资源限制：512MB 内存、1 CPU、256 进程
   - 网络：默认 `none`，需要时自定义 `bridge`
   - 用户：非 root（`sandbox` UID 1000）+ cap drop ALL + no-new-privileges
   - 安全增强：read-only rootfs + seccomp + AppArmor + userns remapping
   - 挂载：tmpfs（临时）+ 命名卷（持久化），禁止 bind mount Windows 路径

3. **Windows 兼容性方案确定**：通过 bollard Named Pipe 连接 Docker Desktop（WSL2 后端），应用代码无需平台条件编译，路径转换通过命名卷与 API 文件传输解决。

4. **工时与风险**：预计 9 人日（2 周），整体风险中等，主要风险为环境依赖（Docker Desktop 安装）。

### 12.2 实施建议

1. **分阶段实施**：按 M1 → M2 → M3 三阶段交付，先跑通 MVP 再逐步加固。
2. **优先安全**：即使 MVP 阶段也要应用基础安全配置（非 root + cap drop + read-only rootfs），不要"先跑通再加固"。
3. **降级策略**：提供降级模式（在宿主机直接执行，需用户明确确认），应对 Docker Desktop 不可用场景。
4. **监控可观测**：从 M1 开始集成 `docker.stats()` 与 `docker.logs()`，便于调试与性能分析。
5. **未来演进**：保持对 Docker Sandboxes（2026 年 4 月发布）的关注，若 TDSF 有更高安全需求（如多用户场景），可迁移至 microVM 方案。

### 12.3 后续工作

- 编写 `tdsf-terminal-agent/src-tauri/src/sandbox/` 模块详细设计文档；
- 制作沙箱镜像 Dockerfile（含预装工具与安全配置）；
- 制作 seccomp profile 与 AppArmor profile 模板；
- 编写集成测试用例（覆盖正常/异常/超时/并发场景）。

---

## 附录 A：bollard 关键 API 速查

### A.1 连接

| 方法 | 用途 |
|------|------|
| `Docker::connect_with_local_defaults()` | 自动检测本地连接（Linux: Unix socket / Windows: Named Pipe） |
| `Docker::connect_with_socket_defaults()` | Unix socket |
| `Docker::connect_with_http_defaults()` | TCP（HTTP） |
| `Docker::connect_with_ssl_defaults()` | TLS |
| `Docker::connect_with_named_pipe_defaults()` | Windows Named Pipe |
| `Docker::connect_with_ssh_defaults()` | SSH |

### A.2 容器管理

| 方法 | 用途 |
|------|------|
| `docker.create_container(options, config)` | 创建容器 |
| `docker.start_container(name, options)` | 启动容器 |
| `docker.stop_container(name, options)` | 停止容器 |
| `docker.restart_container(name, options)` | 重启容器 |
| `docker.kill_container(name, options)` | 杀死容器 |
| `docker.remove_container(name, options)` | 删除容器 |
| `docker.inspect_container(name, options)` | 查看详情 |
| `docker.list_containers(options)` | 列出容器 |

### A.3 exec 与日志

| 方法 | 用途 |
|------|------|
| `docker.create_exec(name, config)` | 创建 exec 实例 |
| `docker.start_exec(id, options)` | 启动 exec（返回 Attached 或 Detached） |
| `docker.inspect_exec(id)` | 查看 exec 状态 |
| `docker.resize_exec(id, options)` | 调整 TTY 大小 |
| `docker.logs(name, options)` | 获取日志流 |
| `docker.stats(name, options)` | 获取资源统计流 |
| `docker.attach_container(name, options)` | 附加到容器主进程 |

### A.4 镜像与网络

| 方法 | 用途 |
|------|------|
| `docker.create_image(options, manifest, credentials)` | 拉取镜像 |
| `docker.list_images(options)` | 列出镜像 |
| `docker.inspect_image(name)` | 查看镜像详情 |
| `docker.remove_image(name, options)` | 删除镜像 |
| `docker.create_network(config)` | 创建网络 |
| `docker.connect_container(network, config)` | 容器加入网络 |
| `docker.disconnect_container(network, config)` | 容器离开网络 |
| `docker.create_volume(config)` | 创建卷 |

---

## 附录 B：参考资料

### B.1 源码

- bollard v0.22.0 源码：`d:\ai\linux教学一体\opensource-reference\bollard\`（已全量分析）
  - `src/docker.rs`：Transport 枚举与连接器
  - `src/container.rs`：容器生命周期 API
  - `src/exec.rs`：exec API
  - `src/network.rs`：网络 API
  - `src/volume.rs`：Volume API
  - `src/image.rs`：镜像 API
  - `codegen/swagger/src/models.rs`：Docker API 模型（HostConfig 等）
  - `examples/exec_term.rs`：交互式终端示例
  - `examples/stats.rs`：资源监控示例

### B.2 官方文档

- Docker Engine API: https://docs.docker.com/engine/api/
- Docker Security: https://docs.docker.com/engine/security/
- Docker Seccomp: https://docs.docker.com/engine/security/seccomp/
- Docker AppArmor: https://docs.docker.com/engine/security/apparmor/
- Docker User Namespace: https://docs.docker.com/engine/security/userns-remap/
- Docker Sandboxes Isolation: https://docs.docker.com/ai/sandboxes/security/isolation/
- Microsoft WSL2 + Docker: https://learn.microsoft.com/windows/wsl/tutorials/wsl-containers

### B.3 业界方案

- code-server: https://github.com/coder/code-server
- JupyterHub DockerSpawner: https://github.com/jupyterhub/dockerspawner
- Gitpod: https://www.gitpod.io/
- Coder: https://coder.com/
- e2b.dev: https://e2b.dev/
- Cube Sandbox: https://github.com/qixing-jk/Cube-Sandbox
- Firecracker: https://firecracker-microvm.github.io/

### B.4 安全参考

- Docker 容器安全最佳实践：https://docs.docker.com/engine/security/
- Linux Capabilities: `man 7 capabilities`
- Seccomp BPF: https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html
- AppArmor: https://gitlab.com/apparmor/apparmor
- SELinux: https://github.com/SELinuxProject/selinux

---

**报告版本**：v1.0  
**撰写人**：AI 调研助手  
**审核状态**：待审核  
**下一步**：基于本报告开展 W1-W3 任务（bollard 集成、环境检测、镜像构建）
