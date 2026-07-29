"""
tdsf_loader.py — TDSF.md 指令文件加载（T-P1-09）
==================================================

spec 要求（DEC-V321-06 TDSF.md 指令文件加载）：
1. **全局指令**：``~/TDSF.md``（用户级，所有项目共享）
2. **项目指令**：``./TDSF.md``（项目级，覆盖全局）
3. **加载时机**：Sidecar 启动时 + 文件变化时（watcher）
4. **注入位置**：Agent system prompt

设计要点：
1. **覆盖语义**：Markdown 是文档形式，无 key-value 结构。"覆盖"通过拼接实现
   （全局 + 项目级），LLM 自然遵循后出现的指令（项目级）。
2. **轮询 watcher**：用 mtime 轮询检测变化，不依赖 watchdog 第三方库，
   保证跨平台兼容（Windows / Linux / macOS）。
3. **线程安全**：watcher 后台线程 + 锁保护，主进程退出时自动结束（daemon）。
4. **懒加载 + 单例**：首次 ``get_current_tdsf()`` 触发加载，
   ``start_watcher()`` 后变化自动更新单例。
5. **错误容忍**：文件读取失败不抛异常，返回空内容（fail-safe）。
6. **测试友好**：``reset_for_test()`` 清理单例状态，便于单元测试隔离。

模块导出：
- ``TDSFContent``：加载结果 dataclass
- ``TDSFWatcher``：文件 watcher 类
- ``load_tdsf()``：一次性加载函数
- ``build_system_prompt_suffix()``：构建 system prompt 注入后缀
- ``get_current_tdsf()``：获取当前 TDSF 内容（单例）
- ``start_watcher() / stop_watcher()``：全局 watcher 控制
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final

logger = logging.getLogger("sidecar.tdsf_loader")


# ============================================================================
# 常量定义
# ============================================================================

# 全局 TDSF.md 路径（~/TDSF.md，用户级，所有项目共享）
_GLOBAL_TDSF_PATH: Final[Path] = Path.home() / "TDSF.md"

# 默认项目级 TDSF.md 文件名
_DEFAULT_PROJECT_TDSF_FILENAME: Final[str] = "TDSF.md"

# Watcher 默认轮询间隔（秒）
_DEFAULT_WATCHER_INTERVAL: Final[float] = 2.0

# 拼接全局 + 项目级时使用的分隔符（让 LLM 知道这是两段不同来源）
_COMBINED_SEPARATOR: Final[str] = "\n\n---\n\n"


# ============================================================================
# 数据结构
# ============================================================================


@dataclass
class TDSFContent:
    """TDSF.md 加载结果

    Attributes:
        global_content:   全局 ~/TDSF.md 内容（文件不存在/为空时返回 ""）
        project_content:  项目级 ./TDSF.md 内容（文件不存在/为空时返回 ""）
        combined_content: 拼接后的内容（全局 + 项目级），用于注入 system prompt
        global_path:      全局文件路径
        project_path:     项目文件路径
        global_mtime:     全局文件 mtime（None 表示文件不存在）
        project_mtime:    项目文件 mtime（None 表示文件不存在）
    """

    global_content: str = ""
    project_content: str = ""
    combined_content: str = ""
    global_path: Path = None  # type: ignore[assignment]
    project_path: Path = None  # type: ignore[assignment]
    global_mtime: float | None = None
    project_mtime: float | None = None

    @property
    def has_content(self) -> bool:
        """是否有任何 TDSF 指令内容（全局或项目级）"""
        return bool(self.combined_content.strip())

    @property
    def has_global(self) -> bool:
        """是否加载到全局指令"""
        return bool(self.global_content.strip())

    @property
    def has_project(self) -> bool:
        """是否加载到项目级指令"""
        return bool(self.project_content.strip())


# ============================================================================
# 文件读取工具
# ============================================================================


def _read_file_safe(path: Path) -> tuple[str, float | None]:
    """安全读取文件，返回 (content, mtime)

    Args:
        path: 文件路径

    Returns:
        (content, mtime) 元组：
        - 文件存在：返回 (文件内容, mtime)
        - 文件不存在：返回 ("", None)
        - 读取失败：返回 ("", None)，并记录 warning 日志
    """
    try:
        if not path.exists():
            return "", None
        stat = path.stat()
        content = path.read_text(encoding="utf-8")
        return content, stat.st_mtime
    except OSError as e:
        logger.warning(f"tdsf_loader: failed to read {path}: {e}")
        return "", None


# ============================================================================
# 核心 API: load_tdsf
# ============================================================================


def load_tdsf(
    project_path: Path | str | None = None,
    global_path: Path | str | None = None,
) -> TDSFContent:
    """加载 TDSF.md 指令文件（一次性加载，无 watcher）

    优先级：项目级 > 全局级
    实现方式：拼接（全局 + 项目级），项目级在后，LLM 自然遵循后出现的指令。

    Args:
        project_path: 项目级 TDSF.md 路径
                      - None 时使用 ``./TDSF.md``（当前工作目录）
        global_path:  全局 TDSF.md 路径
                      - None 时使用 ``~/TDSF.md``（用户主目录）

    Returns:
        TDSFContent 加载结果（即使文件不存在也返回空 content，不抛异常）

    Example:
        >>> tdsf = load_tdsf()
        >>> if tdsf.has_content:
        ...     suffix = build_system_prompt_suffix(tdsf)
        ...     system_prompt = base_prompt + suffix
    """
    g_path = Path(global_path) if global_path else _GLOBAL_TDSF_PATH
    p_path = (
        Path(project_path)
        if project_path
        else Path.cwd() / _DEFAULT_PROJECT_TDSF_FILENAME
    )

    g_content, g_mtime = _read_file_safe(g_path)
    p_content, p_mtime = _read_file_safe(p_path)

    # 拼接：全局 + 项目级（项目级在后，覆盖全局语义）
    parts: list[str] = []
    if g_content.strip():
        parts.append(g_content.strip())
    if p_content.strip():
        parts.append(p_content.strip())
    combined = _COMBINED_SEPARATOR.join(parts) if parts else ""

    if g_content.strip() or p_content.strip():
        logger.info(
            f"load_tdsf: global={'yes' if g_content.strip() else 'no'} "
            f"(mtime={g_mtime}), project={'yes' if p_content.strip() else 'no'} "
            f"(mtime={p_mtime}), combined_len={len(combined)}"
        )
    else:
        logger.debug("load_tdsf: no TDSF.md found (global and project both empty)")

    return TDSFContent(
        global_content=g_content,
        project_content=p_content,
        combined_content=combined,
        global_path=g_path,
        project_path=p_path,
        global_mtime=g_mtime,
        project_mtime=p_mtime,
    )


# ============================================================================
# 核心 API: build_system_prompt_suffix
# ============================================================================


def build_system_prompt_suffix(tdsf: TDSFContent) -> str:
    """构建注入 Agent system prompt 的 TDSF 指令后缀

    Args:
        tdsf: TDSFContent 加载结果

    Returns:
        system prompt 后缀字符串：
        - 有 TDSF 内容：返回带分隔标记的指令块
        - 无 TDSF 内容：返回空字符串（不污染 prompt）

    Example:
        >>> suffix = build_system_prompt_suffix(tdsf)
        >>> full_prompt = base_system_prompt + suffix
    """
    if not tdsf.has_content:
        return ""
    return (
        "\n\n=== TDSF 用户指令（全局 ~/TDSF.md + 项目级 ./TDSF.md） ===\n"
        f"{tdsf.combined_content}\n"
        "=== TDSF 用户指令结束 ===\n"
    )


# ============================================================================
# 文件 Watcher
# ============================================================================


class TDSFWatcher:
    """TDSF.md 文件 watcher（mtime 轮询检测变化）

    设计要点：
    1. **轮询 mtime**：不依赖 watchdog，跨平台兼容（Windows/Linux/macOS）
    2. **后台守护线程**：``daemon=True``，主进程退出时自动结束
    3. **回调通知**：文件变化时调用 ``callback(tdsf_content)``
    4. **线程安全**：start/stop 用锁保护，防止并发启动
    5. **错误容忍**：轮询异常不退出，记录日志后继续

    Usage:
        >>> watcher = TDSFWatcher(callback=my_callback)
        >>> watcher.start()
        >>> # ... 运行期间文件变化会触发 my_callback
        >>> watcher.stop()
    """

    def __init__(
        self,
        callback: Callable[[TDSFContent], None],
        project_path: Path | str | None = None,
        global_path: Path | str | None = None,
        interval: float = _DEFAULT_WATCHER_INTERVAL,
    ) -> None:
        """初始化 watcher

        Args:
            callback:     文件变化时的回调函数（接收 TDSFContent 参数）
            project_path: 项目级 TDSF.md 路径（None 时使用 ./TDSF.md）
            global_path:  全局 TDSF.md 路径（None 时使用 ~/TDSF.md）
            interval:     轮询间隔（秒，默认 2.0s）
        """
        self.callback = callback
        self.project_path = (
            Path(project_path)
            if project_path
            else Path.cwd() / _DEFAULT_PROJECT_TDSF_FILENAME
        )
        self.global_path = (
            Path(global_path) if global_path else _GLOBAL_TDSF_PATH
        )
        self.interval = max(0.5, float(interval))  # 防止过小
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._last_tdsf: TDSFContent | None = None

    def start(self) -> None:
        """启动 watcher（后台轮询线程）

        线程启动后立即触发一次加载（force=True），随后按 interval 轮询。
        重复调用 start() 会被忽略（带 warning 日志）。
        """
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                logger.warning("TDSFWatcher already running, ignore start()")
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                daemon=True,
                name="tdsf-watcher",
            )
            self._thread.start()
            logger.info(
                f"TDSFWatcher started: global={self.global_path}, "
                f"project={self.project_path}, interval={self.interval}s"
            )

    def stop(self, timeout: float = 1.0) -> None:
        """停止 watcher

        Args:
            timeout: 等待线程退出的超时时间（秒）
        """
        with self._lock:
            if self._thread is None:
                return
            self._stop_event.set()
            self._thread.join(timeout=timeout)
            self._thread = None
            logger.info("TDSFWatcher stopped")

    def is_running(self) -> bool:
        """检查 watcher 是否正在运行"""
        return self._thread is not None and self._thread.is_alive()

    def _run(self) -> None:
        """轮询主循环（在后台线程中执行）"""
        # 立即触发一次加载（force=True，确保初始状态被通知）
        self._check_and_notify(force=True)
        while not self._stop_event.is_set():
            # 用 wait 替代 sleep，便于响应 stop 信号
            self._stop_event.wait(self.interval)
            if self._stop_event.is_set():
                break
            self._check_and_notify()

    def _check_and_notify(self, force: bool = False) -> None:
        """检查 mtime 是否变化，变化则触发 callback

        Args:
            force: True 时强制触发 callback（用于首次加载）
        """
        try:
            current = load_tdsf(self.project_path, self.global_path)
            if force or self._has_changed(current):
                self._last_tdsf = current
                logger.info(
                    f"TDSFWatcher: files changed (force={force}), "
                    f"global_mtime={current.global_mtime}, "
                    f"project_mtime={current.project_mtime}"
                )
                try:
                    self.callback(current)
                except Exception as e:
                    logger.error(
                        f"TDSFWatcher callback failed: {e}",
                        exc_info=True,
                    )
        except Exception as e:
            logger.error(f"TDSFWatcher check failed: {e}", exc_info=True)

    def _has_changed(self, current: TDSFContent) -> bool:
        """检测 TDSF 内容是否变化（基于 mtime）

        Args:
            current: 当前加载的 TDSFContent

        Returns:
            True 如果 mtime 变化（文件被修改/创建/删除）
        """
        if self._last_tdsf is None:
            return True
        return (
            current.global_mtime != self._last_tdsf.global_mtime
            or current.project_mtime != self._last_tdsf.project_mtime
        )


# ============================================================================
# 全局单例管理
# ============================================================================

_watcher: TDSFWatcher | None = None
_watcher_lock = threading.Lock()
_current_tdsf: TDSFContent | None = None
_current_tdsf_lock = threading.Lock()
# 上次 initialize_on_startup 使用的路径（reload 时复用，避免回到默认路径）
_last_project_path: Path | None = None
_last_global_path: Path | None = None


def get_current_tdsf() -> TDSFContent:
    """获取当前 TDSF 内容（懒加载单例）

    首次调用时触发文件加载，后续调用返回缓存值。
    如果 ``start_watcher()`` 已启动，watcher 会在文件变化时自动更新缓存。

    Returns:
        TDSFContent 当前内容（可能为空 content，如果文件不存在）
    """
    global _current_tdsf
    with _current_tdsf_lock:
        if _current_tdsf is None:
            _current_tdsf = load_tdsf()
        return _current_tdsf


def _default_watcher_callback(tdsf: TDSFContent) -> None:
    """默认 watcher 回调：更新全局 _current_tdsf 单例"""
    global _current_tdsf
    with _current_tdsf_lock:
        _current_tdsf = tdsf
    logger.info(
        f"TDSF content updated by watcher: "
        f"global={'yes' if tdsf.has_global else 'no'}, "
        f"project={'yes' if tdsf.has_project else 'no'}"
    )


def start_watcher(
    callback: Callable[[TDSFContent], None] | None = None,
    project_path: Path | str | None = None,
    global_path: Path | str | None = None,
    interval: float = _DEFAULT_WATCHER_INTERVAL,
) -> TDSFWatcher:
    """启动全局 TDSF watcher（单例）

    Args:
        callback:     文件变化回调（None 时使用默认回调，仅更新单例缓存）
        project_path: 项目级 TDSF.md 路径
        global_path:  全局 TDSF.md 路径
        interval:     轮询间隔（秒）

    Returns:
        TDSFWatcher 实例（已启动）
    """
    global _watcher
    actual_callback = callback if callback is not None else _default_watcher_callback

    with _watcher_lock:
        if (
            _watcher is not None
            and _watcher.is_running()
        ):
            logger.warning("global TDSFWatcher already running, stopping first")
            _watcher.stop()
        _watcher = TDSFWatcher(
            callback=actual_callback,
            project_path=project_path,
            global_path=global_path,
            interval=interval,
        )
        _watcher.start()
        return _watcher


def stop_watcher() -> None:
    """停止全局 TDSF watcher（单例）"""
    global _watcher
    with _watcher_lock:
        if _watcher is not None:
            _watcher.stop()
            _watcher = None


def reset_for_test() -> None:
    """重置单例状态（测试专用）

    清理内容：
    - 停止 watcher（如果在运行）
    - 清空 _current_tdsf 缓存
    - 清空 _last_project_path / _last_global_path（避免测试间路径污染）
    """
    global _current_tdsf, _last_project_path, _last_global_path
    stop_watcher()
    with _current_tdsf_lock:
        _current_tdsf = None
        _last_project_path = None
        _last_global_path = None
    logger.debug("tdsf_loader: reset_for_test completed")


# ============================================================================
# System Prompt 注入 API（T-P1-09.2）
# ============================================================================


def get_agent_system_prompt_suffix() -> str:
    """获取 Agent system prompt 的 TDSF 注入后缀（运行时调用）

    Agent 在初始化 LLM 时调用此函数，将 TDSF 用户指令拼接到 base system prompt 之后。

    实现：
    1. 从全局单例 ``get_current_tdsf()`` 获取当前 TDSF 内容
    2. 调用 ``build_system_prompt_suffix()`` 生成注入字符串
    3. 返回结果（无 TDSF 内容时返回空字符串）

    Returns:
        system prompt 后缀字符串（无内容时返回 ""）

    Example:
        >>> base_prompt = "你是 Linux 运维教学 Agent..."
        >>> suffix = get_agent_system_prompt_suffix()
        >>> full_prompt = base_prompt + suffix
    """
    tdsf = get_current_tdsf()
    return build_system_prompt_suffix(tdsf)


def build_agent_system_prompt(base_prompt: str) -> str:
    """构建完整的 Agent system prompt（base + TDSF 后缀）

    Args:
        base_prompt: Agent 基础 system prompt（不含 TDSF 指令）

    Returns:
        完整的 system prompt（base + TDSF 后缀，无 TDSF 时返回 base）

    Example:
        >>> prompt = build_agent_system_prompt("你是 Linux 运维 Agent")
        >>> # prompt = "你是 Linux 运维 Agent\\n\\n=== TDSF 用户指令 ... ==="
    """
    suffix = get_agent_system_prompt_suffix()
    if suffix:
        return base_prompt + suffix
    return base_prompt


def _create_change_callback(rust_notifier=None):
    """构建 TDSF 变化时的回调函数（更新单例 + 通知 event_bus）

    Args:
        rust_notifier: 可选的 Rust 通知函数 (event_type: str, payload: dict) -> None
                       用于通过 JSON-RPC 通知 Rust 侧转发到前端

    Returns:
        回调函数 (tdsf: TDSFContent) -> None
    """
    def _on_tdsf_changed(tdsf: TDSFContent) -> None:
        # 默认回调已更新 _current_tdsf，这里追加 event_bus 通知
        global _current_tdsf
        with _current_tdsf_lock:
            _current_tdsf = tdsf
        logger.info(
            f"TDSF content updated: global={'yes' if tdsf.has_global else 'no'}, "
            f"project={'yes' if tdsf.has_project else 'no'}, "
            f"combined_len={len(tdsf.combined_content)}"
        )
        # 通知 event_bus（如果可用）：用 SIDECAR_EVENT 类型包装 tdsf.updated
        # event_bus 仅支持 6 种 EventType，自定义事件统一走 SIDECAR_EVENT
        # payload 中 sub_type 字段标识具体子类型（前端按 sub_type 分发）
        try:
            import event_bus  # 延迟导入，避免循环依赖
            from event_bus import Event, EventType, get_global_bus
            get_global_bus().publish(
                Event(
                    event_type=EventType.SIDECAR_EVENT.value,
                    payload={
                        "sub_type": "tdsf.updated",
                        "has_global": tdsf.has_global,
                        "has_project": tdsf.has_project,
                        "combined_len": len(tdsf.combined_content),
                        "global_mtime": tdsf.global_mtime,
                        "project_mtime": tdsf.project_mtime,
                    },
                    source="tdsf_loader",
                )
            )
        except ImportError:
            logger.debug("event_bus not available, skip tdsf.updated event")
        except Exception as e:
            logger.warning(f"failed to publish tdsf.updated event: {e}")
        # 通知 Rust 侧（如果提供 notifier）
        if rust_notifier is not None:
            try:
                rust_notifier("tdsf.updated", {
                    "has_global": tdsf.has_global,
                    "has_project": tdsf.has_project,
                    "combined_len": len(tdsf.combined_content),
                })
            except Exception as e:
                logger.warning(f"rust_notifier failed for tdsf.updated: {e}")

    return _on_tdsf_changed


# ============================================================================
# JSON-RPC 方法注册（T-P1-09.2）
# ============================================================================


def register_methods(dispatcher) -> None:
    """向 JSON-RPC 方法分发器注册 TDSF 加载相关方法

    注册的方法：
    - tdsf.status: 返回当前 TDSF 加载状态（路径/mtime/has_content）
    - tdsf.reload: 强制重新加载 TDSF（手动触发，例如用户在 UI 点击"刷新"）
    - tdsf.start_watcher: 启动文件 watcher（如果尚未启动）
    - tdsf.stop_watcher: 停止文件 watcher
    - tdsf.get_prompt_suffix: 获取当前 system prompt 注入后缀

    Args:
        dispatcher: MethodDispatcher 实例（来自 main.py）
    """
    dispatcher.register("tdsf.status", _rpc_tdsf_status)
    dispatcher.register("tdsf.reload", _rpc_tdsf_reload)
    dispatcher.register("tdsf.start_watcher", _rpc_tdsf_start_watcher)
    dispatcher.register("tdsf.stop_watcher", _rpc_tdsf_stop_watcher)
    dispatcher.register("tdsf.get_prompt_suffix", _rpc_tdsf_get_prompt_suffix)
    logger.info("tdsf_loader methods registered: tdsf.status/reload/start_watcher/stop_watcher/get_prompt_suffix")


def _rpc_tdsf_status() -> dict:
    """RPC: tdsf.status - 返回当前 TDSF 加载状态"""
    tdsf = get_current_tdsf()
    return {
        "has_global": tdsf.has_global,
        "has_project": tdsf.has_project,
        "has_content": tdsf.has_content,
        "global_path": str(tdsf.global_path) if tdsf.global_path else "",
        "project_path": str(tdsf.project_path) if tdsf.project_path else "",
        "global_mtime": tdsf.global_mtime,
        "project_mtime": tdsf.project_mtime,
        "combined_len": len(tdsf.combined_content),
        "watcher_running": _watcher is not None and _watcher.is_running(),
    }


def _rpc_tdsf_reload() -> dict:
    """RPC: tdsf.reload - 强制重新加载 TDSF（手动触发）

    使用上次 ``initialize_on_startup`` 记录的路径（如有），
    避免回到默认 ~/TDSF.md + ./TDSF.md 路径。

    Returns:
        重载后的状态摘要
    """
    global _current_tdsf
    # 清空缓存，使用上次记录的路径重新加载
    with _current_tdsf_lock:
        _current_tdsf = None
        # 复用上次 initialize_on_startup 的路径
        _current_tdsf = load_tdsf(
            project_path=_last_project_path,
            global_path=_last_global_path,
        )
    tdsf = _current_tdsf
    logger.info(
        f"tdsf.reload: forced reload, has_content={tdsf.has_content}, "
        f"combined_len={len(tdsf.combined_content)}"
    )
    # 同步发布一次 tdsf.updated 事件（通知前端状态变化）
    # 通过 event_bus 的 SIDECAR_EVENT 类型包装（payload.sub_type=tdsf.updated）
    try:
        import event_bus
        from event_bus import Event, EventType, get_global_bus
        get_global_bus().publish(
            Event(
                event_type=EventType.SIDECAR_EVENT.value,
                payload={
                    "sub_type": "tdsf.updated",
                    "has_global": tdsf.has_global,
                    "has_project": tdsf.has_project,
                    "combined_len": len(tdsf.combined_content),
                    "trigger": "manual_reload",
                },
                source="tdsf_loader",
            )
        )
    except Exception as e:
        logger.warning(f"tdsf.reload: failed to publish event: {e}")
    return {
        "has_content": tdsf.has_content,
        "has_global": tdsf.has_global,
        "has_project": tdsf.has_project,
        "combined_len": len(tdsf.combined_content),
    }


def _rpc_tdsf_start_watcher(
    project_path: str | None = None,
    global_path: str | None = None,
    interval: float = _DEFAULT_WATCHER_INTERVAL,
) -> dict:
    """RPC: tdsf.start_watcher - 启动文件 watcher

    Args:
        project_path: 项目级 TDSF.md 路径（None 时使用 ./TDSF.md）
        global_path:  全局 TDSF.md 路径（None 时使用 ~/TDSF.md）
        interval:     轮询间隔（秒，默认 2.0）
    """
    start_watcher(
        callback=None,  # 使用默认回调（更新 _current_tdsf 单例）
        project_path=project_path,
        global_path=global_path,
        interval=interval,
    )
    return {
        "running": True,
        "project_path": str(Path(project_path)) if project_path else str(Path.cwd() / _DEFAULT_PROJECT_TDSF_FILENAME),
        "global_path": str(Path(global_path)) if global_path else str(_GLOBAL_TDSF_PATH),
        "interval": interval,
    }


def _rpc_tdsf_stop_watcher() -> dict:
    """RPC: tdsf.stop_watcher - 停止文件 watcher"""
    stop_watcher()
    return {"running": False}


def _rpc_tdsf_get_prompt_suffix() -> dict:
    """RPC: tdsf.get_prompt_suffix - 获取当前 system prompt 注入后缀

    Agent 实例化 LLM 时调用此方法获取 TDSF 注入内容。

    Returns:
        {"suffix": "...", "has_content": bool, "combined_len": int}
    """
    suffix = get_agent_system_prompt_suffix()
    tdsf = get_current_tdsf()
    return {
        "suffix": suffix,
        "has_content": tdsf.has_content,
        "combined_len": len(tdsf.combined_content),
    }


# ============================================================================
# Sidecar 启动钩子（main.py 调用）
# ============================================================================


def initialize_on_startup(
    project_path: Path | str | None = None,
    global_path: Path | str | None = None,
    start_watcher_on_init: bool = True,
    watcher_interval: float = _DEFAULT_WATCHER_INTERVAL,
    rust_notifier=None,
) -> TDSFContent:
    """Sidecar 启动时初始化 TDSF 加载（main.py 调用）

    执行步骤：
    1. 首次加载 TDSF（写入 _current_tdsf 单例）
    2. 启动文件 watcher（监听变化自动重载）
    3. 注册变化回调（更新单例 + 通知 event_bus + 通知 Rust）

    Args:
        project_path:        项目级 TDSF.md 路径（None 时使用 ./TDSF.md）
        global_path:         全局 TDSF.md 路径（None 时使用 ~/TDSF.md）
        start_watcher_on_init: 是否启动 watcher（默认 True）
        watcher_interval:    watcher 轮询间隔（秒）
        rust_notifier:       Rust 通知函数 (event_type, payload) -> None
                            用于通过 JSON-RPC 推送 tdsf.updated 事件到前端

    Returns:
        初始加载的 TDSFContent

    Example:
        >>> # 在 main.py 启动时：
        >>> from tdsf_loader import initialize_on_startup
        >>> tdsf = initialize_on_startup(rust_notifier=send_notification)
    """
    logger.info(
        f"initialize_on_startup: project_path={project_path}, "
        f"global_path={global_path}, start_watcher={start_watcher_on_init}"
    )

    # 1. 首次加载（写入单例）
    global _current_tdsf, _last_project_path, _last_global_path
    # 记录本次路径，供 _rpc_tdsf_reload 复用
    _last_project_path = Path(project_path) if project_path else None
    _last_global_path = Path(global_path) if global_path else None
    initial_tdsf = load_tdsf(project_path=project_path, global_path=global_path)
    with _current_tdsf_lock:
        _current_tdsf = initial_tdsf

    logger.info(
        f"TDSF initialized: has_global={initial_tdsf.has_global}, "
        f"has_project={initial_tdsf.has_project}, "
        f"combined_len={len(initial_tdsf.combined_content)}"
    )

    # 2. 启动 watcher（监听变化）
    if start_watcher_on_init:
        callback = _create_change_callback(rust_notifier=rust_notifier)
        start_watcher(
            callback=callback,
            project_path=project_path,
            global_path=global_path,
            interval=watcher_interval,
        )
        logger.info(f"TDSF watcher started (interval={watcher_interval}s)")

    return initial_tdsf


# ============================================================================
# 模块导出
# ============================================================================


__all__ = [
    # 数据结构
    "TDSFContent",
    # 核心加载
    "load_tdsf",
    "build_system_prompt_suffix",
    # Watcher
    "TDSFWatcher",
    "start_watcher",
    "stop_watcher",
    # 单例访问
    "get_current_tdsf",
    # System Prompt 注入 API（T-P1-09.2）
    "get_agent_system_prompt_suffix",
    "build_agent_system_prompt",
    # 启动初始化（T-P1-09.2）
    "initialize_on_startup",
    # JSON-RPC 方法注册（T-P1-09.2）
    "register_methods",
    # 测试辅助
    "reset_for_test",
    # 常量（便于测试覆盖）
    "_GLOBAL_TDSF_PATH",
    "_DEFAULT_PROJECT_TDSF_FILENAME",
    "_DEFAULT_WATCHER_INTERVAL",
]


# ============================================================================
# 模块自检
# ============================================================================


if __name__ == "__main__":
    # 打印当前 TDSF 加载状态
    tdsf = load_tdsf()
    print(f"Global path:  {tdsf.global_path}")
    print(f"Project path: {tdsf.project_path}")
    print(f"Has global:   {tdsf.has_global} (mtime={tdsf.global_mtime})")
    print(f"Has project:  {tdsf.has_project} (mtime={tdsf.project_mtime})")
    print(f"Combined len: {len(tdsf.combined_content)} chars")
    if tdsf.has_content:
        print("\n--- Combined content preview ---")
        preview = tdsf.combined_content[:500]
        print(preview + ("..." if len(tdsf.combined_content) > 500 else ""))
