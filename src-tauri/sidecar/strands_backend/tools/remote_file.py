"""
strands_backend/tools/remote_file.py — 远程文本文件读写工具
========================================================

职责：
- 通过 RustBridge 调用 Rust 后端 ``sftp_read`` Tauri command，
  读取 SSH 会话上的远程文件内容，返回结构化结果。
- 不直接 sftp（不引入 paramiko/asyncssh 等依赖），复用现有 Tauri invoke 机制
  + Rust russh-sftp 2.1 客户端，与 ``SshExplorer.tsx`` 共享会话。
- 大文件自动截断（默认 max_size=1MB），避免响应过大撑爆 agent 上下文。
- 二进制文件检测（含 NUL 字节）返回 binary 状态，不返回内容。
- 返回结构化 dict（不返回裸字符串）。

TDSF 2026-07-30 P0-C4 修复：
- 原 ipc_invoke 调用的 method 名为 "sftp_read_file"，但 Rust 侧实际命令为
  "sftp_read"（src-tauri/src/modules/ssh/mod.rs:416 + lib.rs:384），现已对齐。
- 调用结构：{session_id, path, max_size}（注：Rust sftp_read 当前签名是
  (app, state, session_id, path) -> Vec<u8>，max_size 字段 Rust 侧未支持，
  Python 端在拿到结果后自行截断；后续 Rust 扩展时再启用 max_size 透传）。

设计：
- ``invoke_remote_file_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_remote_file_tool(ctx)``：读取工厂，返回带 ctx 闭包的 @tool 装饰函数。
- ``make_write_remote_file_tool(ctx)``：覆盖写入工厂；写前备份、写后回读校验。

工具签名：
    read_remote_file(path, ssh_session_id="", max_size=1048576, encoding="utf-8") -> dict

返回结构：
    success:
        {status:"success", path, ssh_session_id, content, size, encoding, truncated}
    binary:
        {status:"binary", path, ssh_session_id, size, message}
    unavailable:
        {status:"unavailable", path, ssh_session_id, reason, message}
    error:
        {status:"error", path, ssh_session_id, error}
"""
from __future__ import annotations

import hashlib
import logging
import re
from uuid import uuid4
from typing import Any

from needs_you import NeedsYouStatus
from strands_backend.modes import AgentMode
from strands_backend.tools import (
    ToolContext,
    complete_approval_execution,
    request_approval_and_wait,
    tool,
)

logger = logging.getLogger("sidecar.strands_backend.tools.remote_file")

# 默认最大读取字节数（1MB，避免响应过大）
_DEFAULT_MAX_SIZE = 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _emit_tool_call(
    ctx: ToolContext,
    tool_name: str,
    params: dict[str, Any],
    status: str,
    result: dict[str, Any] | None = None,
) -> None:
    """Emit one terminal state transition; event failures never change I/O."""
    if ctx.event_bus is None:
        return
    try:
        ctx.event_bus.emit_tool_call(
            tool_name=tool_name,
            params=params,
            result=result,
            status=status,
            session_id=ctx.session_id or None,
            source=f"{ctx.agent_name}_agent.strands_tool.remote_file",
        )
    except Exception as e:  # noqa: BLE001 - UI telemetry must not block SFTP
        logger.debug("emit_tool_call failed: %s", e)


def _coerce_content(value: Any) -> bytes | str | None:
    """Accept the Rust protocol plus its JSON envelope variants, fail closed."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        if all(
            isinstance(item, int)
            and not isinstance(item, bool)
            and 0 <= item <= 255
            for item in value
        ):
            return bytes(value)
    return None


def _extract_content(result: Any) -> tuple[bytes | str | None, int | None, bool]:
    """Decode ``sftp_read`` replies without turning an unknown reply into text."""
    content = _coerce_content(result)
    if content is not None:
        return content, None, False
    if not isinstance(result, dict):
        return None, None, False

    declared_size = result.get("size")
    try:
        size = int(declared_size) if declared_size is not None else None
    except (TypeError, ValueError):
        size = None
    truncated = bool(result.get("truncated", False))
    for key in ("content", "data", "bytes", "result"):
        candidate = result.get(key)
        content = _coerce_content(candidate)
        if content is not None:
            return content, size, truncated
        if isinstance(candidate, dict):
            nested, nested_size, nested_truncated = _extract_content(candidate)
            if nested is not None:
                return nested, size if size is not None else nested_size, (
                    truncated or nested_truncated
                )
    return None, size, truncated


def _validate_remote_write_path(path: str) -> str:
    """Keep the write tool's path contract aligned with the Rust bridge."""
    normalized = path.strip()
    if (
        not normalized
        or not normalized.startswith("/")
        or "\x00" in normalized
        or normalized == ".."
        or "/../" in normalized
        or normalized.endswith("/..")
    ):
        raise ValueError("write_remote_file 只接受安全的远程绝对路径")
    return normalized


def _resolve_session_id(params: dict[str, Any], ctx: ToolContext) -> tuple[str, int]:
    session_id = str(params.get("ssh_session_id", "") or ctx.ssh_session_id or "")
    try:
        session_id_int = int(session_id)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid ssh_session_id (expect int-convertible): {session_id!r}") from exc
    if session_id_int <= 0:
        raise ValueError("无活跃 SSH 会话，请先连接 SSH 再修改远程文件")
    return session_id, session_id_int


def _read_sftp_bytes(
    ctx: ToolContext, session_id: int, path: str
) -> tuple[bytes | None, str | None]:
    """Read raw SFTP bytes, rejecting ambiguous envelopes instead of guessing."""
    try:
        result = ctx.rust_bridge.ipc_invoke(
            "sftp_read", {"sessionId": session_id, "path": path}
        )
    except Exception as exc:  # noqa: BLE001 - bridge errors cross the IPC boundary
        return None, f"sftp_read 调用异常: {exc}"
    if isinstance(result, dict) and result.get("status") in {"unavailable", "error"}:
        detail = result.get("error") or result.get("message") or result.get("reason")
        return None, str(detail or "sftp_read 不可用")
    content, _, _ = _extract_content(result)
    if content is None:
        return None, "sftp_read 未返回可解码的文件内容"
    if isinstance(content, str):
        return content.encode("utf-8"), None
    return content, None


def _write_sftp_bytes(
    ctx: ToolContext, session_id: int, path: str, content: bytes
) -> str | None:
    """Write bytes through the Rust bridge and preserve non-success replies."""
    try:
        result = ctx.rust_bridge.ipc_invoke(
            "sftp_write",
            {"sessionId": session_id, "path": path, "content": list(content)},
        )
    except Exception as exc:  # noqa: BLE001 - target state is unknown after IPC failure
        return f"sftp_write 调用异常: {exc}"
    if isinstance(result, dict) and result.get("status") in {"unavailable", "error"}:
        detail = result.get("error") or result.get("message") or result.get("reason")
        return str(detail or "sftp_write 不可用")
    return None


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_remote_file_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """远程文件读取工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - path (str, 必填): 远程文件绝对路径
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
            - max_size (int, 可选): 最大读取字节数，默认 1048576（1MB）
            - encoding (str, 可选): 文件编码，默认 utf-8
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: path 参数缺失或为空
    """
    path = params.get("path", "").strip()
    if not path:
        raise ValueError("remote_file 工具必填参数缺失: path")

    ssh_session_id = params.get("ssh_session_id", "") or ""
    max_size = int(params.get("max_size", _DEFAULT_MAX_SIZE))
    encoding = params.get("encoding", "utf-8") or "utf-8"

    session_id = ssh_session_id or ctx.ssh_session_id

    # 推送 tool_call 开始事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="read_remote_file",
                params={"path": path, "ssh_session_id": session_id, "max_size": max_size},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.remote_file",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 检查 RustBridge 配置
    if ctx.rust_bridge is None:
        logger.warning(
            f"remote_file unavailable (no rust_bridge): path={path}"
        )
        return {
            "status": "unavailable",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "rust_bridge_not_injected",
            "message": "RustBridge 未注入，工具无法调用 Rust 后端",
        }

    # 通过 RustBridge 调 Rust 后端 sftp_read
    # TDSF 2026-07-30 P0-C4 修复:
    #   原 method 名 "sftp_read_file" 与 Rust 侧不匹配，
    #   Rust 实际命令为 "sftp_read"（mod.rs:416）。
    # TDSF 修复 2026-07-30 (Critical Bug): 参数名对齐 Rust camelCase (sessionId)，
    # 并把 str session_id 转为 int（Rust 侧期望 u32 via as_u64()）。
    try:
        session_id_int = int(session_id) if session_id else 0
    except (ValueError, TypeError) as e:
        logger.error(
            f"remote_file invalid session_id: id={session_id!r}, error={e}"
        )
        return {
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "error": f"invalid session_id (expect int-convertible): {session_id!r}",
        }

    if session_id_int <= 0:
        logger.warning(
            f"remote_file no active ssh session: path={path}"
        )
        return {
            "status": "unavailable",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "no_ssh_session",
            "message": "无活跃 SSH 会话，请先连接 SSH 再读取远程文件",
        }

    try:
        result = ctx.rust_bridge.ipc_invoke("sftp_read", {
            "sessionId": session_id_int,
            "path": path,
            # 注：Rust sftp_read 当前签名未支持 max_size，传了也会被忽略；
            # 截断在 Python 侧 content 处理时做（见下方 truncated 逻辑）。
            "max_size": max_size,
        })
    except Exception as e:
        logger.exception(f"remote_file ipc_invoke exception: path={path}, error={e}")
        return {
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "error": f"ipc_invoke 异常: {e}",
        }

    # RustBridge 未配置返回 unavailable
    if isinstance(result, dict) and result.get("status") in ("unavailable", "error"):
        return {
            "status": result.get("status", "error"),
            "path": path,
            "ssh_session_id": session_id,
            "reason": result.get("reason", ""),
            "error": result.get("error", result.get("message", "")),
        }

    # TDSF 2026-07-30 P0-C4: 适配 Rust sftp_read 实际返回值
    # Rust sftp_read 签名: (app, state, session_id, path) -> Result<Vec<u8>, String>
    # 序列化到 Python 即 list[int]（字节列表），而非 dict。
    # 旧代码假设 result 是 dict 并取 result.get("content")，导致 content 丢失。
    # 这里统一适配三种返回形态：
    #   1. list[int] / bytes / bytearray：直接当二进制内容
    #   2. dict 含 content 字段：旧路径（假设 Rust 未来扩展返回 dict）
    #   3. 其他：str(result) 兜底
    if isinstance(result, list) and _coerce_content(result) is None:
        response = {
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "remote_file_content_missing",
            "error": "sftp_read returned an invalid byte array",
        }
        _emit_tool_call(
            ctx,
            "read_remote_file",
            {"path": path, "ssh_session_id": session_id, "max_size": max_size},
            "error",
            response,
        )
        return response
    if not isinstance(result, (list, bytes, bytearray, str, dict)):
        response = {
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "remote_file_content_missing",
            "error": "sftp_read returned an unsupported response type",
        }
        _emit_tool_call(
            ctx,
            "read_remote_file",
            {"path": path, "ssh_session_id": session_id, "max_size": max_size},
            "error",
            response,
        )
        return response
    if isinstance(result, dict) and "content" not in result:
        extracted, _, _ = _extract_content(result)
        if extracted is None:
            response = {
                "status": "error",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "remote_file_content_missing",
                "error": "sftp_read returned no decodable file content",
            }
            _emit_tool_call(
                ctx,
                "read_remote_file",
                {"path": path, "ssh_session_id": session_id, "max_size": max_size},
                "error",
                response,
            )
            return response
        result = {**result, "content": extracted}

    truncated = False
    if isinstance(result, list) and all(isinstance(b, int) for b in result if result):
        # Rust sftp_read 实际返回路径：list[int] → bytes
        content_raw = bytes(result)
        size = len(content_raw)
    elif isinstance(result, (bytes, bytearray)):
        content_raw = bytes(result)
        size = len(content_raw)
    elif isinstance(result, dict):
        # 旧路径：假设 dict 含 content / size / truncated 字段
        content_raw = _coerce_content(result.get("content", ""))
        if content_raw is None:
            response = {
                "status": "error",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "remote_file_content_missing",
                "error": "sftp_read returned invalid file content",
            }
            _emit_tool_call(
                ctx,
                "read_remote_file",
                {"path": path, "ssh_session_id": session_id, "max_size": max_size},
                "error",
                response,
            )
            return response
        size = int(result.get("size", 0))
        truncated = bool(result.get("truncated", False))
        if size > 0 and len(content_raw) == 0:
            response = {
                "status": "error",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "remote_file_content_missing",
                "error": "sftp_read reported a non-empty file but returned no content",
            }
            _emit_tool_call(
                ctx,
                "read_remote_file",
                {"path": path, "ssh_session_id": session_id, "max_size": max_size},
                "error",
                response,
            )
            return response
    else:
        # 兜底：转字符串
        content_raw = str(result)
        size = len(content_raw)

    # Python 侧 max_size 截断（Rust sftp_read 不支持 max_size 字段，
    # 全量返回，Python 这里按 max_size 截断避免响应过大）
    if max_size > 0 and isinstance(content_raw, (bytes, bytearray)) and size > max_size:
        content_raw = content_raw[:max_size]
        size = max_size
        truncated = True
        logger.info(
            f"remote_file truncated by max_size: path={path}, "
            f"max_size={max_size}"
        )

    # 二进制文件检测（含 NUL 字节）
    is_binary = False
    if isinstance(content_raw, (bytes, bytearray)):
        is_binary = b"\x00" in content_raw
    elif isinstance(content_raw, str) and "\x00" in content_raw:
        is_binary = True

    if is_binary:
        logger.info(f"remote_file binary detected: path={path}, size={size}")
        return {
            "status": "binary",
            "path": path,
            "ssh_session_id": session_id,
            "size": size,
            "message": "文件为二进制格式，不返回内容（如需查看请用 ssh_command + xxd/head）",
        }

    # 文本文件
    try:
        content = content_raw.decode(encoding) if isinstance(content_raw, (bytes, bytearray)) else content_raw
    except (UnicodeDecodeError, LookupError) as e:
        logger.warning(f"remote_file decode failed: path={path}, encoding={encoding}, error={e}")
        # 解码失败降级为 latin-1（保证不抛错）
        try:
            content = content_raw.decode("latin-1") if isinstance(content_raw, (bytes, bytearray)) else content_raw
        except Exception:
            content = str(content_raw)

    content_bytes = (
        bytes(content_raw)
        if isinstance(content_raw, (bytes, bytearray))
        else str(content_raw).encode("utf-8")
    )
    content_sha256 = hashlib.sha256(content_bytes).hexdigest()

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="read_remote_file",
                params={"path": path, "ssh_session_id": session_id, "max_size": max_size},
                result={
                    "status": "success",
                    "size": size,
                    "truncated": truncated,
                    "sha256": content_sha256,
                },
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.remote_file",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return {
        "status": "success",
        "path": path,
        "ssh_session_id": session_id,
        "content": content,
        "size": size,
        "encoding": encoding,
        "truncated": truncated,
        "sha256": content_sha256,
        "message": (
            f"文件已读取（{size} 字节" + ("，已截断" if truncated else "") + "）"
        ),
    }


# ============================================================================
# 覆盖写入（确认模式审批 + 备份 + 回读校验）
# ============================================================================

def invoke_write_remote_file_tool(
    params: dict[str, Any], ctx: ToolContext
) -> dict[str, Any]:
    """Safely overwrite one existing remote UTF-8 text file.

    The caller must supply the SHA-256 returned by ``read_remote_file``. This
    prevents an agent from overwriting a newer remote revision it has not read.
    A same-directory SFTP backup is made before the target is written, then the
    target is read again and compared byte-for-byte. The tool never creates a
    new file and never performs an automatic rollback after an uncertain write.
    """
    path = _validate_remote_write_path(str(params.get("path", "")))
    content = params.get("content")
    expected_sha256 = str(params.get("expected_sha256", "")).lower()
    if not isinstance(content, str):
        raise ValueError("write_remote_file 的 content 必须是 UTF-8 文本")
    if not _SHA256_RE.fullmatch(expected_sha256):
        raise ValueError("write_remote_file 必须使用 read_remote_file 返回的 sha256")
    try:
        content_bytes = content.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("write_remote_file 的 content 无法编码为 UTF-8") from exc
    if len(content_bytes) > _DEFAULT_MAX_SIZE:
        raise ValueError("write_remote_file 仅支持不超过 1 MiB 的文本文件")

    session_id, session_id_int = _resolve_session_id(params, ctx)
    backup_path = f"{path}.tdsf-backup-{uuid4().hex[:12]}"
    descriptor = (
        f"覆盖写入远程文件 {path}（{len(content_bytes)} 字节）；"
        f"写前备份到 {backup_path}，写后回读校验"
    )
    event_params = {
        "path": path,
        "ssh_session_id": session_id,
        "size": len(content_bytes),
        "expected_sha256": expected_sha256,
        "backup_path": backup_path,
    }
    _emit_tool_call(ctx, "write_remote_file", event_params, "started")
    operation_id = ""
    approved_request: Any | None = None

    def _finish(response: dict[str, Any]) -> dict[str, Any]:
        is_success = response.get("status") == "success"
        _emit_tool_call(
            ctx,
            "write_remote_file",
            event_params,
            "completed" if is_success else "error",
            response,
        )
        if approved_request is not None:
            complete_approval_execution(approved_request)
        if operation_id:
            response["operation_id"] = operation_id
        return response

    mode = getattr(ctx.mode, "value", str(ctx.mode))
    if mode == AgentMode.OBSERVE.value:
        return _finish({
            "status": "command_blocked",
            "path": path,
            "ssh_session_id": session_id,
            "message": "只读模式不提供远程文件写入工具；未写入文件。",
        })
    if ctx.rust_bridge is None:
        return _finish({
            "status": "unavailable",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "rust_bridge_not_injected",
            "message": "RustBridge 未注入；未尝试写入远程文件。",
        })

    operation_service = getattr(ctx, "operation_service", None)

    def _transition(state: str, *, error_code: str | None = None) -> bool:
        if operation_service is None or not operation_id:
            return True
        try:
            operation_service.transition_operation(
                operation_id, state, error_code=error_code
            )
            return True
        except Exception as exc:  # noqa: BLE001 - dispatch must fail closed
            logger.exception(
                "remote file operation transition failed: id=%s state=%s error=%s",
                operation_id,
                state,
                exc,
            )
            return False

    def _cancel(error_code: str) -> None:
        _transition("cancelled", error_code=error_code)

    needs_approval = mode == AgentMode.CONFIRM.value
    if operation_service is None:
        if getattr(ctx, "require_operation_ledger", False):
            return _finish({
                "status": "unavailable",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "operation_ledger_unavailable",
                "message": "操作账本不可用；未尝试写入远程文件。",
            })
    else:
        try:
            operation = operation_service.create_operation(
                intent_id=str(uuid4()),
                conversation_session_id=ctx.session_id,
                ssh_session_id=session_id,
                target_endpoint=None,
                command_hash="sha256:" + hashlib.sha256(descriptor.encode("utf-8")).hexdigest(),
                metadata={
                    "tool_name": "write_remote_file",
                    "risk_l": 3,
                    "readonly": False,
                    "path": path,
                    "backup_path": backup_path,
                    "content_sha256": hashlib.sha256(content_bytes).hexdigest(),
                },
            )
            operation_id = str(operation["id"])
            if not _transition("awaiting_approval" if needs_approval else "approved"):
                return _finish({
                    "status": "error",
                    "path": path,
                    "ssh_session_id": session_id,
                    "reason": "operation_ledger_transition_failed",
                    "message": "操作账本无法记录写入前状态；未写入文件。",
                })
        except Exception as exc:  # noqa: BLE001 - ledger failure blocks mutation
            logger.exception("remote file operation creation failed: %s", exc)
            return _finish({
                "status": "unavailable",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "operation_ledger_unavailable",
                "message": "操作账本无法创建记录；未尝试写入远程文件。",
            })

    if needs_approval:
        risk = {
            "level": "L3",
            "high_risk": False,
            "write": True,
            "matched_rules": ["remote_file_overwrite"],
            "reason": "覆盖远程配置文件会改变服务器状态",
        }
        impact = {
            "max_risk_l": 3,
            "summary": f"覆盖 {path}；先备份到 {backup_path}，写后重新读取校验。",
            "segments": [{
                "command": descriptor,
                "category": "file_write",
                "category_label": "覆盖写入远程文件",
                "objects": [path, backup_path],
                "risk_l": 3,
            }],
        }
        request = request_approval_and_wait(
            ctx,
            descriptor,
            risk,
            tool_name="write_remote_file",
            explanation="按已读取的版本覆盖指定远程文本文件。",
            impact=impact,
            risk_l=3,
        )
        if request is None:
            _cancel("approval_request_failed")
            return _finish({
                "status": "needs_approval",
                "path": path,
                "ssh_session_id": session_id,
                "message": "审批请求创建失败；未写入文件。",
            })
        if request.status != NeedsYouStatus.APPROVED:
            _cancel(
                "approval_rejected"
                if request.status == NeedsYouStatus.REJECTED
                else "approval_not_granted"
            )
            return _finish({
                "status": "rejected" if request.status == NeedsYouStatus.REJECTED else "needs_approval",
                "path": path,
                "ssh_session_id": session_id,
                "message": (
                    "用户拒绝了远程文件写入；未写入文件。"
                    if request.status == NeedsYouStatus.REJECTED
                    else "审批未获通过；未写入文件。"
                ),
            })
        approved_request = request
        if not _transition("approved"):
            return _finish({
                "status": "error",
                "path": path,
                "ssh_session_id": session_id,
                "reason": "operation_ledger_transition_failed",
                "message": "操作账本无法记录批准状态；未写入文件。",
            })

    source_bytes, source_error = _read_sftp_bytes(ctx, session_id_int, path)
    if source_error or source_bytes is None:
        _cancel("source_read_failed")
        return _finish({
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "source_read_failed",
            "message": f"写入前无法读取原文件；未写入文件。{source_error or ''}",
        })
    if len(source_bytes) > _DEFAULT_MAX_SIZE or b"\x00" in source_bytes:
        _cancel("source_not_supported")
        return _finish({
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "source_not_supported",
            "message": "只允许覆盖不超过 1 MiB 的非二进制文本文件；未写入文件。",
        })
    actual_sha256 = hashlib.sha256(source_bytes).hexdigest()
    if actual_sha256 != expected_sha256:
        _cancel("stale_source")
        return _finish({
            "status": "stale_source",
            "path": path,
            "ssh_session_id": session_id,
            "expected_sha256": expected_sha256,
            "actual_sha256": actual_sha256,
            "message": "文件在读取后已变化；为避免覆盖新版本，未写入文件。",
        })
    try:
        source_bytes.decode("utf-8")
    except UnicodeDecodeError:
        _cancel("source_not_utf8")
        return _finish({
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "source_not_utf8",
            "message": "只允许覆盖 UTF-8 文本文件；未写入文件。",
        })

    if not _transition("dispatching"):
        return _finish({
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "operation_ledger_transition_failed",
            "message": "操作账本无法记录派发状态；未写入文件。",
        })
    backup_error = _write_sftp_bytes(ctx, session_id_int, backup_path, source_bytes)
    if backup_error:
        _transition("indeterminate", error_code="backup_write_failed")
        return _finish({
            "status": "indeterminate",
            "path": path,
            "ssh_session_id": session_id,
            "backup_path": backup_path,
            "reason": "backup_write_failed",
            "message": f"备份回包异常，未继续覆盖目标文件。{backup_error}",
        })
    write_error = _write_sftp_bytes(ctx, session_id_int, path, content_bytes)
    if write_error:
        _transition("indeterminate", error_code="target_write_failed")
        return _finish({
            "status": "indeterminate",
            "path": path,
            "ssh_session_id": session_id,
            "backup_path": backup_path,
            "reason": "target_write_failed",
            "message": f"覆盖写入回包异常；目标状态不确定。备份位置：{backup_path}。{write_error}",
        })
    if not _transition("dispatched"):
        return _finish({
            "status": "indeterminate",
            "path": path,
            "ssh_session_id": session_id,
            "backup_path": backup_path,
            "reason": "operation_ledger_transition_failed",
            "message": "文件可能已写入，但操作账本未记录派发完成；状态不确定。",
        })
    verified_bytes, verify_error = _read_sftp_bytes(ctx, session_id_int, path)
    if verify_error or verified_bytes != content_bytes:
        _transition("indeterminate", error_code="read_after_write_failed")
        return _finish({
            "status": "indeterminate",
            "path": path,
            "ssh_session_id": session_id,
            "backup_path": backup_path,
            "reason": "read_after_write_failed",
            "message": "写后回读未能确认目标内容；状态不确定，未自动恢复。",
        })
    if not _transition("succeeded"):
        return _finish({
            "status": "indeterminate",
            "path": path,
            "ssh_session_id": session_id,
            "backup_path": backup_path,
            "reason": "operation_ledger_transition_failed",
            "message": "写后校验通过，但操作账本未完成持久化；状态不确定。",
        })
    return _finish({
        "status": "success",
        "path": path,
        "ssh_session_id": session_id,
        "backup_path": backup_path,
        "sha256": hashlib.sha256(content_bytes).hexdigest(),
        "size": len(content_bytes),
        "message": "远程文本文件已备份、写入并通过回读校验。",
    })


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_remote_file_tool(ctx: ToolContext):
    """构建远程文件读取工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数
    """
    @tool
    def read_remote_file(
        path: str,
        ssh_session_id: str = "",
        max_size: int = _DEFAULT_MAX_SIZE,
        encoding: str = "utf-8",
    ) -> dict:
        """读取 SSH 会话上的远程文件内容。

        通过 SFTP 读取远程文件，自动检测二进制文件（含 NUL 字节）并返回
        binary 状态。大文件自动截断（默认 1MB），避免响应过大。

        Args:
            path (str): 远程文件绝对路径。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。
            max_size (int): 最大读取字节数，默认 1048576（1MB）。
            encoding (str): 文件编码，默认 utf-8。

        Returns:
            dict: 结构化结果，含 status / path / content / size / truncated 等字段。
                status 取值: success | binary | unavailable | error
        """
        return invoke_remote_file_tool(
            params={
                "path": path,
                "ssh_session_id": ssh_session_id,
                "max_size": max_size,
                "encoding": encoding,
            },
            ctx=ctx,
        )

    read_remote_file.__name__ = "read_remote_file"
    return read_remote_file


def make_write_remote_file_tool(ctx: ToolContext):
    """Build the confirmed remote text-file overwrite tool."""
    @tool
    def write_remote_file(
        path: str,
        content: str,
        expected_sha256: str,
        ssh_session_id: str = "",
    ) -> dict:
        """覆盖已有远程 UTF-8 文本文件。

        先用 read_remote_file 获取 sha256；确认模式下需用户逐条批准。写入前
        自动在同目录生成备份，写后回读校验；任何不确定状态都不会假报成功。
        """
        return invoke_write_remote_file_tool(
            {
                "path": path,
                "content": content,
                "expected_sha256": expected_sha256,
                "ssh_session_id": ssh_session_id,
            },
            ctx,
        )

    write_remote_file.__name__ = "write_remote_file"
    return write_remote_file


__all__ = [
    "invoke_remote_file_tool",
    "invoke_write_remote_file_tool",
    "make_remote_file_tool",
    "make_write_remote_file_tool",
    "to_shell_command",
]


def _shell_escape(s: str) -> str:
    """shell 单引号转义（防注入）"""
    return "'" + s.replace("'", "'\"'\"'") + "'"


def to_shell_command(params: dict[str, Any]) -> str | None:
    """工具参数 → 等价 shell 命令映射（纯函数，fail-closed）

    read_remote_file(path) → cat path

    Args:
        params: 工具参数 dict（path）

    Returns:
        shell 命令字符串；映射失败返回 None（不抛异常）
    """
    try:
        path = (params.get("path") or "").strip()
        if not path:
            return None
        return f"cat {_shell_escape(path)}"
    except (ValueError, TypeError, KeyError):
        return None
