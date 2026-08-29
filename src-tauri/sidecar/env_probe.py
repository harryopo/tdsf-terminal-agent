"""
env_probe.py — 系统环境探测（方案书 v3.1 §4.7 B1 终端感知，2026-08-29）
========================================================================

职责：为 agent 的 ``<environment>`` 上下文分区提供
``{os_pretty_name, kernel, shell}`` 探测，让 agent 执行命令"因地制宜"
（CentOS→yum / Ubuntu→apt / systemd 版本差异）。

JSON-RPC 方法（register_methods 注册，前端经 ipc_invoke 调用）：
- system.probe_env: {session_id?, ssh_session_id?} →
    {ok, os_pretty_name, kernel, shell, source}
  - ssh_session_id 非 None/0：经 RustBridge ``ssh_command`` 反向 RPC 在
    目标机执行**一次往返合并命令**（cat /etc/os-release + uname -r +
    echo $SHELL），复用现有 russh exec 通道（不引入新依赖）
  - 否则：本地探测（Linux 读 /etc/os-release；Windows/macOS 用 platform）
  - **会话级缓存**：key = ``ssh:<rust_session_id>`` / ``local``——SSH 重连后
    rustSessionId 变化自动失效，TTL 5 分钟兜底（长连接下发行版不会变）

设计约束：
- 遵循 RustBridge 命令注册模式（tools/__init__.py ipc_invoke("ssh_command")）
- 探测失败显式 log.warning + 返回 ok=False，**不抛异常**（前端静默降级，
  绝不阻塞对话首响——红线 3.5 #4 不静默吞错：warning 日志 + 显式降级值）
- 不脱敏输出（os-release/内核无敏感信息；echo $SHELL 只是路径）
"""
from __future__ import annotations

import logging
import platform
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.env_probe")

# 会话级缓存: key → {data..., _ts}（SSH 重连后 rustSessionId 变化 → key 变 → 自动失效）
_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_TTL_MS = 5 * 60 * 1000

# 合并命令一次往返（exec 通道每条命令有固定握手开销，三次往返 ≈ 3× 延迟）。
# 分隔哨兵用非常量字符串避免与 os-release 内容撞车。
_PROBE_CMD = (
    'cat /etc/os-release 2>/dev/null; echo "__TDSF_KERNEL__"; '
    'uname -r 2>/dev/null; echo "__TDSF_SHELL__"; echo "$SHELL"'
)
_KERNEL_MARK = "__TDSF_KERNEL__"
_SHELL_MARK = "__TDSF_SHELL__"

# 探测超时（秒）——经 RustBridge ssh_command 的 timeout 参数下发
_PROBE_TIMEOUT_S = 10


# ============================================================================
# os-release / 探测输出解析
# ============================================================================

def parse_os_release_pretty_name(os_release_text: str) -> str:
    """从 /etc/os-release 文本解析 PRETTY_NAME（缺失返回 ""）

    兼容引号形式：PRETTY_NAME="CentOS Linux 7 (Core)"
    """
    for line in os_release_text.splitlines():
        line = line.strip()
        if line.startswith("PRETTY_NAME="):
            value = line.split("=", 1)[1].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            return value
    return ""


def parse_probe_output(output: str) -> dict[str, str]:
    """解析合并命令输出 → {os_pretty_name, kernel, shell}

    结构：os-release 全文 → _KERNEL_MARK → 内核版本 → _SHELL_MARK → $SHELL
    任一段缺失返回空字符串（调用方决定降级文案）。
    """
    result = {"os_pretty_name": "", "kernel": "", "shell": ""}
    if not output:
        return result
    # cat 失败时 os-release 段为空（stderr 已 2>/dev/null 吞掉）
    kernel_idx = output.find(_KERNEL_MARK)
    shell_idx = output.find(_SHELL_MARK)
    os_release_text = output[:kernel_idx] if kernel_idx >= 0 else ""
    result["os_pretty_name"] = parse_os_release_pretty_name(os_release_text)
    if kernel_idx >= 0:
        after_kernel = output[kernel_idx + len(_KERNEL_MARK):]
        kernel_end = after_kernel.find(_SHELL_MARK)
        kernel_raw = after_kernel if kernel_end < 0 else after_kernel[:kernel_end]
        result["kernel"] = kernel_raw.strip()
    if shell_idx >= 0:
        result["shell"] = output[shell_idx + len(_SHELL_MARK):].strip()
    return result


# ============================================================================
# 本地 / 远端探测
# ============================================================================

def probe_local() -> dict[str, str]:
    """本地环境探测（前端无 SSH 会话活跃时）

    Linux：读 /etc/os-release（PRETTY_NAME）+ platform.release()
    Windows/macOS：platform.platform() 作 pretty name（教学一体机默认路径）
    """
    import os

    os_pretty_name = ""
    try:
        if platform.system() == "Linux":
            os_release = Path("/etc/os-release")
            if os_release.is_file():
                os_pretty_name = parse_os_release_pretty_name(
                    os_release.read_text(encoding="utf-8", errors="replace")
                )
        if not os_pretty_name:
            os_pretty_name = platform.platform()
    except Exception as e:  # noqa: BLE001 — 探测失败降级空值，不中断
        logger.warning(f"probe_env local os-release read failed (fallback: {e})")
    try:
        shell = os.environ.get("COMSPEC", "") if platform.system() == "Windows" else os.environ.get("SHELL", "")
    except Exception:  # noqa: BLE001
        shell = ""
    return {
        "os_pretty_name": os_pretty_name,
        "kernel": platform.release() or "",
        "shell": shell or "",
    }


def probe_remote(ssh_session_id: int) -> dict[str, str] | None:
    """远端环境探测：经 RustBridge ssh_command 在目标机执行合并命令

    Returns:
        解析后的字段 dict；RustBridge 未注入 / 执行失败返回 None（调用方降级）
    """
    try:
        # 惰性导入 main 拿全局 RustBridge（main 启动时已创建；此模块在
        # register_methods 阶段才被导入，main 模块已完全加载，无循环导入风险）
        import main as _main

        bridge = getattr(_main, "_rust_bridge", None)
        if bridge is None:
            logger.warning("probe_env remote skipped: rust_bridge not injected")
            return None
        result = bridge.send_request(
            "ssh_command",
            {
                "sessionId": int(ssh_session_id),
                "command": _PROBE_CMD,
                "timeout": _PROBE_TIMEOUT_S,
            },
        )
        if not isinstance(result, dict) or not result.get("ok", False):
            logger.warning(
                f"probe_env remote failed: "
                f"result_type={type(result).__name__}, "
                f"exit_code={result.get('exit_code') if isinstance(result, dict) else 'N/A'}"
            )
            return None
        return parse_probe_output(str(result.get("output", "")))
    except Exception as e:  # noqa: BLE001 — 探测失败必须降级，不阻塞对话
        logger.warning(f"probe_env remote exception (fallback: {e})")
        return None


# ============================================================================
# 入口（会话级缓存）
# ============================================================================

def probe_env(
    session_id: str = "",
    ssh_session_id: int | None = None,
) -> dict[str, Any]:
    """system.probe_env 入口（会话级缓存）

    Args:
        session_id: 对话会话 id（仅日志追踪用，缓存 key 用 ssh_session_id）
        ssh_session_id: SSH Rust session_id；None/0 = 本地模式

    Returns:
        {ok, os_pretty_name, kernel, shell, source}
        - source: "ssh" / "local" / "cache"
        - 探测失败时 ok=False + 字段全空（前端静默省略 <environment> 分区）
    """
    key = f"ssh:{ssh_session_id}" if ssh_session_id else "local"
    cached = _CACHE.get(key)
    now_ms = int(time.time() * 1000)
    if cached and now_ms - int(cached.get("_ts", 0)) < _CACHE_TTL_MS:
        logger.debug(
            f"probe_env cache hit: key={key} session={session_id or '-'}"
        )
        return {**cached, "source": "cache", "ok": True}

    if ssh_session_id:
        data = probe_remote(int(ssh_session_id))
        source = "ssh"
    else:
        data = probe_local()
        source = "local"

    if data is None:
        return {
            "ok": False,
            "os_pretty_name": "",
            "kernel": "",
            "shell": "",
            "source": source,
        }

    entry = {**data, "_ts": now_ms}
    _CACHE[key] = entry
    logger.info(
        f"probe_env ok: key={key} session={session_id or '-'} "
        f"os={data['os_pretty_name'][:60]} kernel={data['kernel'][:40]} "
        f"shell={data['shell'][:20]}"
    )
    return {**data, "source": source, "ok": True}


def clear_cache() -> None:
    """清空缓存（测试用）"""
    _CACHE.clear()


# ============================================================================
# JSON-RPC 注册
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """注册 system.* JSON-RPC 方法（main.register_business_methods 调用）"""

    # MethodDispatcher.dispatch 对 dict params 走 handler(**params) 解包
    # （与 session_memory.register_methods 同模式）
    def _probe_env(
        session_id: str = "",
        ssh_session_id: int | None = None,
    ) -> dict[str, Any]:
        return probe_env(
            session_id=str(session_id or ""),
            ssh_session_id=ssh_session_id,
        )

    dispatcher.register("system.probe_env", _probe_env)
    logger.info("system.* methods registered (probe_env)")
