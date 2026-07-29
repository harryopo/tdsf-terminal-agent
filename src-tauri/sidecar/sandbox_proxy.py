"""
sandbox_proxy.py — Docker 沙箱代理（T-P2-08.5, DEC-V321-10）
================================================================

职责：
- 提供 `sandbox.*` JSON-RPC 方法供 Agent 调用
- 通过 subprocess 调用 docker CLI 执行容器内命令（独立于 Rust bollard 通道）
- 与 Rust 侧 SandboxManager 共享容器命名前缀 `tdsf-sandbox-`，便于双向操作

方法清单（注册到 MethodDispatcher）：
- sandbox.status           检测 Docker daemon 可用性 + 版本
- sandbox.execute          在指定容器内执行命令并收集输出
- sandbox.list             列出所有 tdsf-sandbox-* 容器
- sandbox.parse_command    解析命令字符串为 argv（供 Agent 拼装命令时校验）

错误码：
- -32602 Invalid params    参数缺失或类型错误
- -32000   Server generic Docker 不可用 / 容器不存在 / 执行失败

注意：
- 本模块不创建/启动/停止/删除容器（生命周期管理由 Rust SandboxManager 负责）
- 仅提供 execute + status + list 三个读/执行方法，避免与 Rust 状态冲突
- Agent 通常通过 Rust 侧 invoke('sandbox_create') 创建容器，再调用本模块 execute
"""
from __future__ import annotations

import logging
import shlex
import subprocess
from typing import Any

logger = logging.getLogger("sidecar.sandbox")

# 与 Rust 侧 SANDBOX_NAME_PREFIX 对齐（src-tauri/src/modules/sandbox/manager.rs）
SANDBOX_NAME_PREFIX = "tdsf-sandbox-"

# docker CLI 默认执行超时（秒），与 Rust 侧 exec_in_container 内部 Instant 计时对齐
DEFAULT_EXEC_TIMEOUT = 30


def register_methods(dispatcher) -> None:
    """注册 sandbox.* JSON-RPC 方法到分发器

    Args:
        dispatcher: main.py 中的 MethodDispatcher 实例
    """
    dispatcher.register("sandbox.status", sandbox_status)
    dispatcher.register("sandbox.execute", sandbox_execute)
    dispatcher.register("sandbox.list", sandbox_list)
    dispatcher.register("sandbox.parse_command", sandbox_parse_command)
    logger.info("sandbox_proxy methods registered: sandbox.status/execute/list/parse_command")


# ============================================================================
# JSON-RPC 方法实现
# ============================================================================

def sandbox_status() -> dict[str, Any]:
    """检测 Docker daemon 可用性与版本信息

    Returns:
        {
            "available": bool,
            "version": str | None,        # Docker 版本号
            "apiVersion": str | None,      # API 版本
            "os": str | None,              # OS (linux/windows)
            "arch": str | None,            # 架构 (amd64/arm64)
            "error": str | None            # 不可用时的友好提示
        }

    通过 `docker version --format '{{json .}}'` 调用，与 Rust bollard
    `Docker::version()` 等价但走 CLI 通道，便于 Python 独立检测。
    """
    try:
        result = subprocess.run(
            ["docker", "version", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError:
        return _unavailable("docker CLI not found, please install Docker Desktop")
    except subprocess.TimeoutExpired:
        return _unavailable("docker version timed out (10s)")

    if result.returncode != 0:
        return _unavailable(
            f"docker daemon not available: {result.stderr.strip() or 'unknown error'}"
        )

    # 解析 JSON 输出
    import json
    try:
        info = json.loads(result.stdout.strip())
    except json.JSONDecodeError as e:
        return _unavailable(f"docker version output parse error: {e}")

    # Docker version --format '{{json .}}' 返回结构含 Client + Server
    server = info.get("Server") or {}
    client = info.get("Client") or {}
    version = server.get("Version") or client.get("Version")
    api_version = server.get("ApiVersion") or client.get("ApiVersion")
    os_name = server.get("Os") or client.get("Os")
    arch = server.get("Arch") or client.get("Arch")

    if not version:
        return _unavailable("docker Server component missing (daemon not running?)")

    return {
        "available": True,
        "version": version,
        "apiVersion": api_version,
        "os": os_name,
        "arch": arch,
        "error": None,
    }


def sandbox_execute(
    container_id: str,
    cmd: list[str],
    timeout: int = DEFAULT_EXEC_TIMEOUT,
) -> dict[str, Any]:
    """在指定容器内执行命令并收集 stdout/stderr/exit_code

    Args:
        container_id: 容器 ID 或容器名（如 "tdsf-sandbox-abc123"）
        cmd: 命令 argv（如 ["ls", "-l", "/"]），不可为空
        timeout: 执行超时秒数（默认 30s），超时返回 exit_code=124

    Returns:
        {
            "containerId": str,
            "cmd": list[str],
            "stdout": str,
            "stderr": str,
            "exitCode": int,
            "durationMs": int
        }

    Raises:
        JSONRPCError(-32602): 参数缺失或 cmd 为空
        JSONRPCError(-32000): Docker 不可用 / 容器不存在 / 执行异常

    注意：与 Rust 侧 sandbox_exec 命令对齐（前端两种调用方式均可），
         本方法走 docker CLI，Rust 侧走 bollard API。
    """
    from main import JSONRPCError, ERR_INVALID_PARAMS, ERR_SERVER_GENERIC

    if not container_id:
        raise JSONRPCError(ERR_INVALID_PARAMS, "container_id must not be empty")
    if not cmd or not isinstance(cmd, list):
        raise JSONRPCError(ERR_INVALID_PARAMS, "cmd must be a non-empty list")

    # 拼装 docker exec 命令
    # -i: 保持 stdin 打开（即使没有 attach）
    # 不用 -t（非交互式，避免 TTY 转义序列污染输出）
    docker_cmd = ["docker", "exec", "-i", container_id] + [str(c) for c in cmd]

    logger.info(f"[sandbox.execute] exec: container={container_id} cmd={cmd}")

    import time
    started = time.time()
    try:
        result = subprocess.run(
            docker_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        raise JSONRPCError(
            ERR_SERVER_GENERIC,
            "docker CLI not found, please install Docker Desktop",
        )
    except subprocess.TimeoutExpired:
        duration_ms = int((time.time() - started) * 1000)
        return {
            "containerId": container_id,
            "cmd": cmd,
            "stdout": "",
            "stderr": f"[timeout after {timeout}s]",
            "exitCode": 124,  # 与 GNU timeout 一致的超时退出码
            "durationMs": duration_ms,
        }
    except Exception as e:
        raise JSONRPCError(
            ERR_SERVER_GENERIC,
            f"docker exec failed: {e}",
        )

    duration_ms = int((time.time() - started) * 1000)
    exit_code = result.returncode

    logger.info(
        f"[sandbox.execute] done: exit={exit_code} "
        f"stdout={len(result.stdout)}B stderr={len(result.stderr)}B "
        f"duration={duration_ms}ms"
    )

    return {
        "containerId": container_id,
        "cmd": cmd,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": exit_code,
        "durationMs": duration_ms,
    }


def sandbox_list() -> list[dict[str, Any]]:
    """列出所有 tdsf-sandbox-* 容器

    Returns:
        [
            {
                "id": str,
                "name": str,
                "image": str,
                "state": str,      # running / exited / created / paused
                "status": str,      # "Up 5 seconds" / "Exited (0) 2 minutes ago"
                "created": int      # Unix 秒
            },
            ...
        ]

    通过 `docker ps --filter name=tdsf-sandbox- --format '{{json .}}'` 调用，
    与 Rust 侧 list_containers 行为一致（同样过滤前缀）。
    """
    try:
        result = subprocess.run(
            [
                "docker", "ps", "-a",
                "--filter", f"name={SANDBOX_NAME_PREFIX}",
                "--format", "{{json .}}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("docker CLI not found, returning empty list")
        return []
    except subprocess.TimeoutExpired:
        logger.warning("docker ps timed out, returning empty list")
        return []

    if result.returncode != 0:
        logger.warning(f"docker ps failed: {result.stderr.strip()}")
        return []

    import json
    containers: list[dict[str, Any]] = []
    for line in result.stdout.strip().splitlines():
        if not line:
            continue
        try:
            c = json.loads(line)
        except json.JSONDecodeError as e:
            logger.warning(f"skip invalid container line: {e} (line: {line[:100]!r})")
            continue

        # docker ps --format '{{json .}}' 字段: ID / Names / Image / State / Status / CreatedAt
        # CreatedAt 是字符串（如 "2024-08-15 10:23:45 +0000 UTC"），转 Unix 秒
        created_at = c.get("CreatedAt", "")
        created_unix = _parse_docker_created_at(created_at)

        containers.append({
            "id": c.get("ID", ""),
            "name": c.get("Names", "").lstrip("/"),
            "image": c.get("Image", ""),
            "state": c.get("State", "unknown"),
            "status": c.get("Status", ""),
            "created": created_unix,
        })

    # 按 created 降序（最新的在前）
    containers.sort(key=lambda x: x["created"], reverse=True)
    return containers


def sandbox_parse_command(cmd_str: str) -> list[str]:
    """将命令字符串解析为 argv（供 Agent 拼装命令时校验）

    Args:
        cmd_str: 命令字符串（如 "ls -l /tmp && rm -f x"）

    Returns:
        argv 数组（如 ["ls", "-l", "/tmp", "&&", "rm", "-f", "x"]）

    注意：本方法仅做词法解析，不执行任何 shell 语义（管道 / 重定向等需 Agent 自行处理）。
    """
    from main import JSONRPCError, ERR_INVALID_PARAMS

    if not isinstance(cmd_str, str):
        raise JSONRPCError(ERR_INVALID_PARAMS, "cmd_str must be a string")
    if not cmd_str.strip():
        raise JSONRPCError(ERR_INVALID_PARAMS, "cmd_str must not be empty")

    return shlex.split(cmd_str)


# ============================================================================
# 内部辅助函数
# ============================================================================

def _unavailable(reason: str) -> dict[str, Any]:
    """构造 Docker 不可用时的状态返回

    与 Rust 侧 DockerStatus 结构对齐（available=false 时 error 字段含提示）
    """
    return {
        "available": False,
        "version": None,
        "apiVersion": None,
        "os": None,
        "arch": None,
        "error": (
            f"{reason}\n\n"
            "请确认 Docker Desktop 已安装并运行:\n"
            "  - Windows: 安装 Docker Desktop "
            "(https://www.docker.com/products/docker-desktop/)\n"
            "  - Linux: sudo systemctl start docker\n"
            "  - macOS: open -a Docker"
        ),
    }


def _parse_docker_created_at(created_at: str) -> int:
    """解析 docker ps 的 CreatedAt 字符串为 Unix 秒

    docker --format '{{json .}}' 返回的 CreatedAt 格式不固定：
    - 较新版本: "2024-08-15 10:23:45 +0000 UTC"
    - 较旧版本: "2024-08-15T10:23:45Z"

    解析失败时返回 0（前端可显示 "unknown"）。
    """
    if not created_at:
        return 0

    # 尝试多种格式
    from datetime import datetime
    formats = [
        "%Y-%m-%d %H:%M:%S %z %Z",  # 2024-08-15 10:23:45 +0000 UTC
        "%Y-%m-%d %H:%M:%S %z",     # 2024-08-15 10:23:45 +0000
        "%Y-%m-%dT%H:%M:%SZ",       # 2024-08-15T10:23:45Z (ISO 8601)
        "%Y-%m-%dT%H:%M:%S%z",      # 2024-08-15T10:23:45+0000
    ]
    for fmt in formats:
        try:
            # 截掉末尾的 " UTC" 等时区名（%Z 解析不稳）
            s = created_at.rstrip(" UTC")
            dt = datetime.strptime(s, fmt)
            return int(dt.timestamp())
        except ValueError:
            continue

    # 最后尝试 dateutil（若可用）
    try:
        from dateutil import parser as dateutil_parser  # type: ignore
        return int(dateutil_parser.parse(created_at).timestamp())
    except Exception:
        return 0
