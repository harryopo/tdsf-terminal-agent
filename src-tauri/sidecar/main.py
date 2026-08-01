"""
TDSF Terminal Agent — Python Sidecar 入口（T-P1-01.1）
=====================================================

职责：
- stdio JSON-RPC 2.0 server（stdin 读取请求，stdout 写入响应）
- 信号处理（SIGTERM/SIGINT 优雅退出）
- 启动时发送 ready 通知（Rust 侧等待此信号判定启动成功）
- 方法分发（ping / shutdown / status + 后续注册的业务方法）

通信协议（与 Rust 侧 src-tauri/src/modules/ipc.rs 对齐）：
- 请求:    {"jsonrpc": "2.0", "method": "...", "params": {...}, "id": 1}
- 响应:    {"jsonrpc": "2.0", "result": {...}, "id": 1}
- 错误:    {"jsonrpc": "2.0", "error": {"code": -32000, "message": "..."}, "id": 1}
- 通知:    {"jsonrpc": "2.0", "method": "...", "params": {...}}（无 id，无响应）

启动握手：
- Rust spawn 后阻塞等待 Python 发送 ready 通知
- Python 启动完成后发送:
    {"jsonrpc": "2.0", "method": "ready",
     "params": {"version": "1.0.0", "python": "3.13.x", "platform": "win32"}}

心跳：
- Rust 每 5s 发送: {"jsonrpc": "2.0", "method": "ping", "id": N}
- Python 立即响应: {"jsonrpc": "2.0", "result": {"alive": true, "uptime": 12.3}, "id": N}
- 30s 无响应判定 Sidecar 死锁（DEC-V321-11）

错误码（JSON-RPC 2.0 标准 + TDSF 扩展）：
- -32700 Parse error          解析错误
- -32600 Invalid Request      无效请求
- -32601 Method not found     方法未找到
- -32602 Invalid params       无效参数
- -32603 Internal error       内部错误
- -32000 Server generic       TDSF 通用服务器错误
- -32001 Timeout              TDSF 超时（请求 30s）
- -32002 Write lease          TDSF 写租约冲突（Project Service 并发写）
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

# 将 sidecar 根目录加入 sys.path，确保 import sidecar_modules.* 可用
sys.path.insert(0, str(Path(__file__).parent))

# TDSF 魔改: 数据目录移到 src-tauri/ 之外，避免 Tauri dev watcher 检测到
# SQLite WAL 文件（.db-shm/.db-wal）变化导致循环重启（窗口反复弹出关闭）
# 路径: <项目根目录>/.tdsf-data/（在 src-tauri/ 之外，Tauri dev watcher 不会监听）
# 各模块通过 os.environ["TDSF_DATA_DIR"] 读取此路径，回退到原 sidecar/data/
_TDSF_DATA_DIR = Path(__file__).resolve().parent.parent.parent / ".tdsf-data"
_TDSF_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("TDSF_DATA_DIR", str(_TDSF_DATA_DIR))

# 2026-07-31 根因修复: 强制 stdio 为 UTF-8（Windows 中文系统默认 gbk）。
# JSON-RPC 线协议按行传给 Rust 侧，Rust 用 UTF-8 解析；若 Python 以 gbk 编码写出
# 含中文的行（如带中文路径的日志），Rust BufReader::lines() 报 InvalidData 退出
# reader → 误判子进程死亡 → TerminateProcess，sidecar 启动即被杀。stderr 同步
# 重配避免日志乱码（Rust stderr reader 同样按 UTF-8 转发）。
# stdin 方向同样关键：Rust 以 UTF-8 写请求行，Python 若按 gbk 解码，中文 input
# 会被破坏成孤立 surrogate → Strands 请求序列化抛 UnicodeEncodeError → invoke 失败。
for _stream_name in ("stdin", "stdout", "stderr"):
    try:
        getattr(sys, _stream_name).reconfigure(encoding="utf-8")
    except Exception:
        pass  # 非 TTY/重配失败时保持默认，不阻断启动


# ============================================================================
# 日志配置（stderr + 文件双通道）
# stderr 输出保留（Rust reader 转发到终端）；文件落盘供 dev-log.py 诊断。
# ============================================================================
logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("TDSF_SIDECAR_LOG", "INFO"),
    format="[sidecar] %(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# 2026-07-31: 日志落盘到 .tdsf-data/sidecar.log（5MB × 3 轮转）。
# 此前日志只走 stderr → Rust 转发 → 终端输出，进程退出即丢，排障只能现场抓。
# 落盘后 scripts/dev-log.py 可离线分析（崩溃/编码/超时/重启循环等）。
# 2026-08-01: pytest 运行会 import main.py（test_main_register_methods 等），
# 若不加隔离，测试日志会混入运行时 sidecar.log 污染诊断。pytest 加载时
# sys.modules 已有 pytest，据此跳过文件 handler（stderr 输出保留）。
try:
    from logging.handlers import RotatingFileHandler

    if "pytest" in sys.modules:
        sys.stderr.write("[sidecar] pytest environment detected, file log disabled\n")
    else:
        _log_file_handler = RotatingFileHandler(
            _TDSF_DATA_DIR / "sidecar.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _log_file_handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s: %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        logging.getLogger().addHandler(_log_file_handler)
except Exception as e:
    sys.stderr.write(f"[sidecar] log file handler install failed: {e}\n")
logger = logging.getLogger("sidecar.main")

# ============================================================================
# JSON-RPC 协议常量
# ============================================================================
JSONRPC_VERSION = "2.0"

# JSON-RPC 2.0 标准错误码
ERR_PARSE_ERROR = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL_ERROR = -32603

# TDSF 扩展错误码
ERR_SERVER_GENERIC = -32000  # 通用服务器错误
ERR_TIMEOUT = -32001          # 超时
ERR_WRITE_LEASE = -32002      # 写租约冲突


class JSONRPCError(Exception):
    """JSON-RPC 错误异常，携带错误码 + 消息 + 可选 data 字段"""

    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(message)

    def to_dict(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        return err


# ============================================================================
# stdio 读写（线程安全，stdout 同时被多线程写入需加锁）
# ============================================================================
_write_lock = threading.Lock()
_stdout = sys.stdout
# 2026-07-31 加固：stdout 管道写失败去重标志。stdout 写失败（读端关闭/EINVAL/
# 管道损坏）时只向 stderr 记录一次，避免刷屏；下次写成功自动清零。
_stdout_broken = False

# 启动时间（用于 uptime 计算）
START_TIME = time.time()

# TDSF P1-NEW-1 修复 (2026-07-30): 慢方法异步派发线程池
# ---------------------------------------------------------------
# 背景：原主循环单线程同步 dispatch，agent.invoke 内 call_llm 可能耗时 30-60s+，
# 期间 stdin 不被读取，Rust 侧 ping 请求堆积 → health_check 30s 无响应判定
# Sidecar Crashed（误报）+ agent.invoke 响应丢失。
#
# 修复：将慢方法（agent.invoke）提交到线程池异步执行，主循环立即返回继续读 stdin。
# - write_message 已用 _write_lock 保护，线程安全
# - MethodDispatcher 仅 dict 查找 + 调用，注册期完成后只读，线程安全
# - event_bus / rust_bridge 内部均有锁，线程安全
# - max_workers=2：允许一个 agent.invoke 在跑时另一个请求（如 ping）也能处理，
#   同时避免并发过多 LLM 调用导致资源紧张
_slow_methods: frozenset[str] = frozenset({"agent.invoke"})
_main_executor: ThreadPoolExecutor | None = None


def _dispatch_in_executor(
    dispatcher: "MethodDispatcher",
    method: str,
    params: Any,
    req_id: Any,
    is_notification: bool,
) -> None:
    """线程池中执行慢方法（agent.invoke），完成后发送响应

    主循环调用此函数将慢方法提交到线程池，立即返回继续读 stdin。
    线程内完成 dispatch 后，通过线程安全的 write_message 发送响应。

    异常处理与主循环同步派发路径一致：
    - JSONRPCError → send_error(code, message, req_id, data)
    - Exception → send_error(ERR_INTERNAL_ERROR, str(e), req_id)
    """
    global _shutdown_flag
    try:
        result = dispatcher.dispatch(method, params)
        if not is_notification:
            send_response(result, req_id)
    except JSONRPCError as e:
        logger.warning(f"JSONRPCError in async {method}: {e.message}")
        if not is_notification:
            send_error(e.code, e.message, req_id, e.data)
    except Exception as e:
        logger.exception(f"unexpected error in async method {method}")
        if not is_notification:
            send_error(ERR_INTERNAL_ERROR, str(e), req_id)

# 全局 shutdown 标志（由 shutdown 方法或信号处理设置）
_shutdown_flag = False

# TDSF P1-3/P1-4/P1-5（2026-07-30）: 全局 RustBridge 实例
# ---------------------------------------------------------------
# Python→Rust 反向 JSON-RPC 通道。在 main() 启动时创建并注入
# write_message 回调；业务代码（如 Strands 工具）通过它调用 Rust 后端
# 的 ssh_command / sftp_* 命令，阻塞等待响应（30s 超时）。
#
# 主循环收到消息时，先用 ``_rust_bridge.is_reverse_response(msg)`` 判定：
# - True → 调 ``dispatch_response(msg)`` 路由到对应 pending 请求（不进 dispatcher）
# - False → 走原有 MethodDispatcher.dispatch 逻辑
#
# 判定规则：id ≥ 1,000,000 且无 method = Python 反向请求的响应。
# ID 空间隔离详见 rust_bridge.py docstring。
_rust_bridge: Any = None  # type: ignore[assignment]

# TDSF P0-E（2026-07-30）: 后端状态跟踪（Critical-2 可观测性修复）
# ---------------------------------------------------------------
# 由 register_business_methods 中 Strands 注入段写入，供 sidecar.health
# JSON-RPC 读取。前端启动时调用 sidecar.health 拿到 backend_type，
# 渲染 Backend Pill（Strands 绿色 / LangGraph 黄色 / 降级红色）。
#
# 字段说明：
#   backend_type: "strands" | "langgraph"  (用户配置 TDSF_AGENT_BACKEND)
#   backend_activated: bool                (Strands 适配层是否真实激活)
#   strands_available: bool                (strands 包是否可导入)
#   rust_bridge_active: bool               (rust_bridge 是否注入)
#   llm_configured: bool                   (LLMConfig 是否配置 api_key)
#   fallback_reason: str | None            (Strands 启动失败时的异常信息)
#   activate_time: float                   (激活/降级时间戳)
_backend_status: dict[str, Any] = {
    "backend_type": "langgraph",
    "backend_activated": False,
    "strands_available": False,
    "rust_bridge_active": False,
    "llm_configured": False,
    "fallback_reason": None,
    "activate_time": 0.0,
}


def write_message(msg: dict) -> None:
    """写一行 JSON-RPC 消息到 stdout（线程安全，每条消息以换行符分隔）

    Rust 侧按行读取（BufRead::read_line），因此每条消息必须以 \\n 结尾
    """
    global _stdout_broken
    line = json.dumps(msg, ensure_ascii=False)
    with _write_lock:
        try:
            # 2026-07-31: 用 errors="replace" 编码。LLM 流式输出偶发含孤立
            # surrogate（httpx surrogateescape 解码非法 UTF-8 字节产生），
            # 严格 UTF-8 编码抛 UnicodeEncodeError → 消息被丢弃 → Rust 30s
            # 超时挂死。replace 保证任何消息都能送达（非法字符替换为 U+FFFD）。
            buffer = getattr(_stdout, "buffer", None)
            if buffer is not None:
                buffer.write(line.encode("utf-8", errors="replace") + b"\n")
                buffer.flush()
            else:
                _stdout.write(line + "\n")
                _stdout.flush()
            _stdout_broken = False
        except (OSError, ValueError) as e:
            # stdout 管道写失败（读端关闭 / Windows EINVAL / 管道损坏 / 已关闭）。
            # 绝不让写失败冒泡：否则 ready 通知或 RPC 响应的写异常会杀死进程，
            # Rust 侧判 "crashed during startup" 并反复重启，形成自我延续的崩溃循环。
            # stderr 是独立 handle，去重记录一次即可，避免刷屏。
            if not _stdout_broken:
                _stdout_broken = True
                try:
                    sys.stderr.write(
                        f"[sidecar] stdout write failed ({e!r}); message dropped, "
                        f"will keep retrying on next write\n"
                    )
                    sys.stderr.flush()
                except Exception:
                    pass


def send_response(result: Any, req_id: Any) -> None:
    """发送成功响应"""
    write_message({"jsonrpc": JSONRPC_VERSION, "result": result, "id": req_id})


def send_error(code: int, message: str, req_id: Any, data: Any = None) -> None:
    """发送错误响应"""
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    write_message({"jsonrpc": JSONRPC_VERSION, "error": err, "id": req_id})


def send_notification(method: str, params: Any = None) -> None:
    """发送通知（无 id，无响应）"""
    msg: dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "method": method}
    if params is not None:
        msg["params"] = params
    write_message(msg)


# ============================================================================
# 方法分发器（Method Dispatcher）
# ============================================================================
class MethodDispatcher:
    """JSON-RPC 方法分发器

    注册方法: dispatcher.register("agent.invoke", handler)
    调用:    dispatcher.dispatch("agent.invoke", {"input": "..."})
    """

    def __init__(self) -> None:
        self._methods: dict[str, Callable[..., Any]] = {}
        self._register_defaults()

    def register(self, name: str, handler: Callable[..., Any]) -> None:
        """注册方法（同名方法会被覆盖）"""
        self._methods[name] = handler
        logger.debug(f"registered method: {name}")

    def has(self, name: str) -> bool:
        return name in self._methods

    def list_methods(self) -> list[str]:
        return sorted(self._methods.keys())

    def dispatch(self, method: str, params: Any) -> Any:
        """分发方法调用

        params 支持:
        - dict: 命名参数 handler(**params)
        - list: 位置参数 handler(*params)
        - None: 无参数 handler()
        """
        if method not in self._methods:
            raise JSONRPCError(
                ERR_METHOD_NOT_FOUND,
                f"Method not found: {method}",
                data={"available": self.list_methods()},
            )
        handler = self._methods[method]
        if isinstance(params, dict):
            return handler(**params)
        elif isinstance(params, list):
            return handler(*params)
        elif params is None:
            return handler()
        else:
            raise JSONRPCError(
                ERR_INVALID_PARAMS,
                f"Invalid params type: {type(params).__name__}",
            )

    def _register_defaults(self) -> None:
        """注册默认方法（ping / shutdown / status）"""
        self.register("ping", self._ping)
        self.register("shutdown", self._shutdown)
        self.register("status", self._status)

    def _ping(self) -> dict:
        """心跳响应（Rust 每 5s ping 一次，30s 无响应判定死锁）"""
        return {"alive": True, "uptime": time.time() - START_TIME}

    def _shutdown(self) -> dict:
        """优雅退出（设置 _shutdown_flag，主循环检测后退出）"""
        global _shutdown_flag
        logger.info("shutdown requested, exiting gracefully...")
        _shutdown_flag = True
        return {"ok": True}

    def _status(self) -> dict:
        """返回 Sidecar 状态（版本 + uptime + 已注册方法列表）"""
        return {
            "version": "1.0.0",
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "uptime": time.time() - START_TIME,
            "methods": self.list_methods(),
            "ready": True,
        }


# ============================================================================
# 信号处理（SIGTERM/SIGINT 优雅退出）
# ============================================================================
def _handle_signal(signum: int, frame: Any) -> None:
    """信号处理函数（SIGTERM/SIGINT 触发优雅退出）"""
    global _shutdown_flag
    logger.info(f"received signal {signum}, shutting down...")
    _shutdown_flag = True


# Windows 不支持 SIGTERM，用 SIGBREAK 替代
signal.signal(signal.SIGINT, _handle_signal)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, _handle_signal)
if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, _handle_signal)


# ============================================================================
# 业务方法注册（后续 T-P1-02 ~ T-P1-11 会扩展）
# ============================================================================
def register_business_methods(dispatcher: MethodDispatcher) -> None:
    """注册所有业务模块的方法

    后续 task 会在这里追加:
    - T-P1-05: graph.register_methods(dispatcher)
    - T-P1-07: tools.register_methods(dispatcher)
    - T-P1-08: permissions.register_methods(dispatcher)
    - T-P1-09: tdsf_loader.register_methods(dispatcher)
    - T-P1-10: needs_you.register_methods(dispatcher)
    - T-P1-11: agents.register_methods(dispatcher)
    """
    # T-P1-03: Project Service（SQLite WAL + 5 表 CRUD + 写租约 + 事务）
    try:
        import project_service
        project_service.register_methods(dispatcher)
        logger.info("project_service methods registered")
    except Exception as e:
        logger.exception(f"failed to register project_service: {e}")
    
    # T-P1-04: 事件总线（pub-sub + Rust 推送）
    try:
        import event_bus
        event_bus.register_methods(dispatcher)
        # 注入 Rust 通知器：EventBus publish 时同步推送到 Rust 侧
        # Rust reader_task 接收后 emit Tauri event 到前端
        event_bus.set_rust_notifier(
            lambda event_type, payload: send_notification(event_type, payload)
        )
        logger.info("event_bus methods registered (with rust notifier)")
    except Exception as e:
        logger.exception(f"failed to register event_bus: {e}")
    
    # T-P1-10: needs-you 协调服务（4 类型 + 优先级 + 30s 超时）
    # 必须在 event_bus 之后注册（依赖 emit_needs_you 推送事件到前端）
    try:
        import needs_you
        # 注册 JSON-RPC 方法：needs_you.request / .respond / .list / .stats 等 15 个
        needs_you.register_methods(dispatcher)
        # 注入 EventBus 实例（needs_you 创建/响应/超时事件通过 event_bus 推送）
        needs_you.set_event_bus(event_bus.get_global_bus())
        # 启动超时扫描线程（每 1s 扫描，approval 30s 无响应自动拒绝）
        needs_you.start_global_service()
        logger.info("needs_you methods registered + service started (timeout scanner running)")
    except Exception as e:
        logger.exception(f"failed to register needs_you: {e}")
    
    # T-P2-12.2: Fix-loop max_retry=3（DEC-V321-11）
    # 必须在 event_bus + needs_you 之后注册：
    # - 依赖 event_bus 发布 fix_loop near_limit/exhausted 事件
    # - 依赖 needs_you 在超限时创建 HANDOFF 请求通知用户
    try:
        import fix_loop
        # 注册 JSON-RPC 方法：fix_loop.stats / .get / .is_exhausted /
        # .is_near_limit / .reset / .list_exhausted / .configure（共 7 个）
        fix_loop.register_methods(dispatcher)
        # 注入 EventBus 实例（near_limit/exhausted 事件通过 event_bus 推送到前端）
        fix_loop.set_event_bus(event_bus.get_global_bus())
        logger.info("fix_loop methods registered + event_bus injected (max_retry=3)")
    except Exception as e:
        logger.exception(f"failed to register fix_loop: {e}")

    # T-P1-09: TDSF.md 指令文件加载（启动加载 + watcher + system prompt 注入）
    try:
        import tdsf_loader
        # 注册 JSON-RPC 方法：tdsf.status / tdsf.reload / tdsf.start_watcher /
        # tdsf.stop_watcher / tdsf.get_prompt_suffix
        tdsf_loader.register_methods(dispatcher)
        # 启动时初始化：加载 ~/TDSF.md + ./TDSF.md，启动 watcher 监听变化
        # 文件变化时通过 event_bus + Rust 通知前端（tdsf.updated 事件）
        tdsf_loader.initialize_on_startup(
            start_watcher_on_init=True,
            watcher_interval=2.0,
            rust_notifier=lambda event_type, payload: send_notification(event_type, payload),
        )
        logger.info("tdsf_loader methods registered + initialized on startup")
    except Exception as e:
        logger.exception(f"failed to register tdsf_loader: {e}")

    # T-P1-11: Agent 框架（主 Agent + 4 子 Agent）
    # 必须在 event_bus 之后注册（Agent 通过 event_bus 推送 mood/message 事件）
    try:
        import agents
        # TDSF 魔改 P0-3 + P0-C5: LLM 配置加载与共享
        # ---------------------------------------------------------------
        # 从环境变量 / .tdsf-data/llm_config.json 加载 LLMConfig，
        # 同一份 config 同时供给 LangGraph 路径（make_llm_call）和 Strands 路径
        # （configure_strands → create_strands_model），避免双套配置导致行为分裂。
        # 未配置时 llm_call=None，Agent 降级到 mock LLM（保持离线可用）。
        from core.llm_config import load_config, make_llm_call
        llm_config = load_config()
        llm_call = make_llm_call(llm_config)
        if llm_call is not None:
            logger.info("LLM configured, agents will use real LLM")
        else:
            logger.warning("LLM not configured, agents will use mock LLM")

        # 注册 JSON-RPC 方法：agent.invoke / agent.list / agent.info / agent.configure
        agents.register_methods(dispatcher)
        # 配置全局依赖并实例化所有 Agent
        agents.configure_agents(
            event_bus=event_bus.get_global_bus(),
            llm_call=llm_call,
        )

        # TDSF 魔改 2026-07-30 P0-C1 + P0-C5 + P1-4: Strands 后端 feature flag 注入点
        # ---------------------------------------------------------------
        # 通过环境变量 TDSF_AGENT_BACKEND 切换 Agent 后端实现：
        #   - "langgraph"（默认）/ 未设置 / 其他值：走 BaseAgent PAOR 主路径
        #   - "strands"：注入 StrandsAgentAdapter，invoke_agent() 走 override
        #
        # 集成点对齐方案文档 §4.2 与 strands_backend/adapter.py docstring：
        #   - configure_strands 便捷构造 StrandsAgentAdapter
        #   - agents.set_backend() 注入 override（agents/__init__.py P0-C2 提供）
        #   - 失败时 clear_backend() 回退到 BaseAgent PAOR（保证 sidecar 可用）
        #
        # P0-C5（2026-07-30 完成）：strands_model 自动注入
        #   - configure_strands(strands_model=None) 内部自动调用
        #     create_strands_model(llm_config) 创建 Strands Model（OpenAI/Anthropic/LiteLLM）
        #   - 与 LangGraph 路径共享同一份 LLMConfig，前端 agent.configure RPC
        #     重新配置后下次 sidecar 启动自动生效（运行时切换待 P1 双向 JSON-RPC 桥）
        #   - LLM 未配置 / Strands 未安装 / provider 不支持时 strands_model 仍为 None，
        #     adapter.invoke 走降级路径（_check_degraded → emit_needs_you）
        #
        # P1-4（2026-07-30 完成）：rust_bridge 真实注入
        #   - main() 启动时已创建全局 _rust_bridge（RustBridge 实例）
        #   - 这里把它包装成 DefaultRustBridge 注入 Strands 适配层
        #   - 工具调用 ssh_command/sftp_* 通过 _rust_bridge.send_request 阻塞等响应
        #   - Rust 侧 reader_task 已支持反向请求路由（handle_reverse_request）
        #
        # P0-D（2026-07-30 完成）：Rust ssh_command 命令已实现
        #   - src-tauri/src/modules/ssh/mod.rs::ssh_command (russh channel exec 模式)
        #   - 返回 {ok, output, stderr, exitCode, duration} 结构化结果
        #
        # 当前限制（P2 阶段补充）：
        #   - Strands 真实端到端实测待 P0-E（设 TDSF_AGENT_BACKEND=strands 启动验证）
        # ---------------------------------------------------------------
        _tdsf_backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
        # P0-E: 写入 _backend_status（供 sidecar.health RPC 读取）
        _backend_status["backend_type"] = _tdsf_backend
        _backend_status["rust_bridge_active"] = _rust_bridge is not None
        _backend_status["llm_configured"] = bool(
            getattr(llm_config, "api_key", "") if llm_config else False
        )
        # 检测 strands 包是否可导入
        try:
            import strands  # type: ignore[import]
            _backend_status["strands_available"] = True
        except ImportError:
            _backend_status["strands_available"] = False

        if _tdsf_backend == "strands":
            try:
                from strands_backend import configure_strands
                from strands_backend.tools import DefaultRustBridge

                # P1-4: 用全局 _rust_bridge 包装成 DefaultRustBridge
                # RustBridge 协议 ipc_invoke(method, params) → send_request(method, params)
                if _rust_bridge is not None:
                    _rust_bridge_impl = DefaultRustBridge(
                        send_request=lambda m, p: _rust_bridge.send_request(m, p)
                    )
                    logger.info(
                        "rust_bridge injected into Strands "
                        f"(pending={_rust_bridge.pending_count()})"
                    )
                else:
                    _rust_bridge_impl = DefaultRustBridge()  # 未配置降级
                    logger.warning(
                        "rust_bridge not initialized, Strands tools will be unavailable"
                    )

                _strands_adapter = configure_strands(
                    event_bus=event_bus.get_global_bus(),
                    rust_bridge=_rust_bridge_impl,  # P1-4: 真实注入
                    llm_config=llm_config,  # P0-C5: 共享同一份 LLMConfig
                )
                agents.set_backend(
                    lambda agent_id, input, state: _strands_adapter.invoke(
                        agent_id, input, state
                    )
                )
                # P1-NEW-v3-1 修复 (2026-07-30): 注入 adapter 引用,
                # 让 agent.configure RPC 能调用 adapter.update_model
                # (否则 Strands 模式下重新配置 LLM 后仍用旧 model)
                agents.set_strands_adapter(_strands_adapter)
                # P0-E: 标记 Strands 真实激活
                _backend_status["backend_activated"] = True
                _backend_status["fallback_reason"] = None
                _backend_status["activate_time"] = time.time()
                logger.info(
                    f"Strands backend activated (TDSF_AGENT_BACKEND=strands): "
                    f"{_strands_adapter.get_stats()}"
                )
                # 推送 backend_status 事件给前端（前端 BackendPill 监听渲染）
                send_notification("backend_status", dict(_backend_status))
            except Exception as se:
                # Strands 注入失败：清空 override（防残留半初始化状态），回退 PAOR
                logger.exception(
                    f"failed to activate Strands backend, "
                    f"fallback to BaseAgent PAOR: {se}"
                )
                agents.clear_backend()
                # P0-E: 标记降级 + 推送 fallback 事件给前端
                # P1-NEW-v2-5 修复 (2026-07-30): 补重置 backend_type="langgraph"，
                # 否则前端 sidecar.health 拿到 backend_type="strands" + activated=false，
                # 语义上暗示"仍是 strands 后端"但实际已回退 LangGraph（状态机不一致）。
                _backend_status["backend_type"] = "langgraph"
                _backend_status["backend_activated"] = False
                _backend_status["fallback_reason"] = f"{type(se).__name__}: {se}"
                _backend_status["activate_time"] = time.time()
                send_notification("backend_status", dict(_backend_status))
        else:
            logger.info(
                f"agent backend: {_tdsf_backend} (default BaseAgent PAOR)"
            )
            # P0-E: langgraph 模式也推送状态给前端
            _backend_status["backend_activated"] = False
            _backend_status["activate_time"] = time.time()
            send_notification("backend_status", dict(_backend_status))

        logger.info(
            f"agents methods registered + configured: "
            f"{agents.list_agents()}"
        )
    except Exception as e:
        logger.exception(f"failed to register agents: {e}")

    # T-P2-08.5: Docker 沙箱代理（DEC-V321-10）
    # 提供 sandbox.status / sandbox.execute / sandbox.list / sandbox.parse_command
    # 通过 docker CLI 执行容器内命令，与 Rust SandboxManager（bollard）共享容器命名前缀
    # Agent 调用本模块在沙箱内执行 L3+ 风险命令（容器生命周期由 Rust 管理）
    try:
        import sandbox_proxy
        sandbox_proxy.register_methods(dispatcher)
        logger.info("sandbox_proxy methods registered (docker CLI bridge)")
    except Exception as e:
        logger.exception(f"failed to register sandbox_proxy: {e}")

    # TDSF 魔改 P0-3: 前端可直调的 risk/confidence/decision JSON-RPC
    # 原因: riskClient.ts / TDSFPanelSection / 风险评估面板都直接调
    #       "risk.evaluate" / "confidence.score" / "decision.list"
    # 旧版只有 invoke_*_tool 内部入口（graph/nodes.py tool_call_node 用），
    # 前端 fail-open 回退到本地 TS 评估，丢失了 Python 端的真实实现。
    try:
        from tools import rpc_methods
        rpc_methods.register_methods(dispatcher)
        logger.info("tools.rpc_methods methods registered (risk/confidence/decision)")
    except Exception as e:
        logger.exception(f"failed to register tools.rpc_methods: {e}")

    # T-P3-08: 知识库 JSON-RPC 方法（FTS5 + ChromaDB 双路检索）
    # 提供 knowledge.search / .add / .rebuild / .get / .count
    # observe_node 自动检索知识卡注入 AgentState + 推送到前端 AgentPanel
    try:
        from knowledge.rpc import register_methods as register_knowledge
        register_knowledge(dispatcher)
        logger.info("knowledge methods registered (FTS5 + Vector hybrid search)")
    except Exception as e:
        logger.exception(f"failed to register knowledge: {e}")

    # T-P3-05/06: Skill 注册表 + 解析器（70+ Skill + SKILL.md 解析）
    # 提供 skill.list / .get / .invoke / .search / .count
    # 启动时加载 5 内置 + 65 mock 外部 Skill
    try:
        from skills.registry import register_methods as register_skills
        register_skills(dispatcher)
        logger.info("skills.registry methods registered (70+ skills)")
    except Exception as e:
        logger.exception(f"failed to register skills.registry: {e}")

    # T-P3-07: Skill Marketplace（skills.sh 协议 + 离线缓存）
    # 提供 marketplace.search / .install / .uninstall / .update / .list_installed
    try:
        from skills.marketplace import register_methods as register_marketplace
        register_marketplace(dispatcher)
        logger.info("skills.marketplace methods registered (skills.sh protocol)")
    except Exception as e:
        logger.exception(f"failed to register skills.marketplace: {e}")

    # T-P3-09: 学习路径推荐（path.recommend）
    # 基于知识库 + 用户历史生成个性化学习路径
    try:
        from knowledge.path_recommender import register_methods as register_path
        register_path(dispatcher)
        logger.info("path_recommender methods registered (learning path)")
    except Exception as e:
        logger.exception(f"failed to register path_recommender: {e}")

    # ====================================================================
    # P5 阶段：高级 AI 能力（T-P5-01 ~ T-P5-03）
    # ====================================================================

    # T-P5-01: SquillaRouter 4 档模型路由（DEC-V32-01）
    # 提供 squilla.route / squilla.list_tiers
    # 基于任务复杂度评分 + 上下文长度 + 用户偏好决策使用 L1/L2/L3/L4 档模型
    try:
        import squilla_router
        squilla_router.register_methods(dispatcher)
        logger.info("squilla_router methods registered (4-tier routing)")
    except Exception as e:
        logger.exception(f"failed to register squilla_router: {e}")

    # T-P5-02: LongContextManager 1M Token 上下文（feature flag 开关）
    # 提供 long_context.chunk / .merge / .summarize / .status
    # feature_flags.long_context.enabled 控制是否启用真实分块/摘要逻辑
    try:
        import long_context
        long_context.register_methods(dispatcher)
        logger.info("long_context methods registered (1M token context)")
    except Exception as e:
        logger.exception(f"failed to register long_context: {e}")

    # T-P5-03: KEPA 反向传播 + Skill 自动生成（自我进化）
    # 提供 kepa.propagate / .update_weights / .status + skill.auto_generate / .list_auto / .status
    # KEPA 简化版梯度下降 + 从 Agent 执行历史自动生成 SKILL.md
    try:
        import self_evolution
        self_evolution.register_methods(dispatcher)
        logger.info("self_evolution methods registered (KEPA + Skill auto-gen)")
    except Exception as e:
        logger.exception(f"failed to register self_evolution: {e}")

    # T-P5-07: Langfuse 可观测性集成（OpenTelemetry 兼容 + 离线 SQLite 缓存）
    # 提供 langfuse.event / .flush / .stats / .trace
    # 离线模式将 trace/span/event 落盘到 data/langfuse.db
    try:
        from observability import langfuse_client
        langfuse_client.register_methods(dispatcher)
        logger.info("langfuse methods registered (offline SQLite observability)")
    except Exception as e:
        logger.exception(f"failed to register langfuse: {e}")

    # T-P4-LOG-01: 后端日志独立通路（2026-07-28 TDSF 魔改）
    # 提供 log.tail / .clear / .stats / .set_level / .levels
    # 专门为子审查 agent 配置: 不需要进入开发 agent 上下文就能看到所有后端日志
    # 实现: core/log_capture.py 把所有 logger 写入 5000 行 ringbuffer,
    #       通过 JSON-RPC log.tail 拉取, 通过 sidecar://log Tauri event 实时推送
    try:
        from core import log_capture
        log_capture.register_methods(dispatcher)
        logger.info("core.log_capture methods registered (5 methods: tail/clear/stats/set_level/levels)")
    except Exception as e:
        logger.exception(f"failed to register core.log_capture: {e}")

    # TDSF P0-E（2026-07-30）: sidecar.health JSON-RPC（Critical-2 可观测性修复）
    # ---------------------------------------------------------------
    # 提供后端运行时状态查询，让前端 BackendPill / 启动诊断能感知：
    #   - 当前 backend_type（strands / langgraph）
    #   - Strands 适配层是否真实激活（非 fallback）
    #   - strands 包是否可导入
    #   - rust_bridge 是否注入
    #   - LLM 是否配置
    #   - fallback 原因（如 Strands 启动失败）
    #   - agents 数量 + 列表
    #   - uptime / 启动时间
    #
    # 配合 sidecar:backend_status 事件（Strands 注入段推送），前端启动时调用
    # sidecar.health 拉取当前状态，之后监听事件实时更新 BackendPill。
    try:
        def _sidecar_health(_params: dict | None = None) -> dict:
            """sidecar.health: 返回 sidecar 后端运行时状态

            Returns:
                dict: 见 _backend_status 字段说明 + agents 元信息 + uptime
            """
            import agents as _agents_mod
            return {
                **_backend_status,
                "agents_count": len(_agents_mod.AGENT_REGISTRY),
                "agents_list": _agents_mod.list_agents(),
                "uptime_seconds": time.time() - START_TIME,
                "startup_time": START_TIME,
                "python_version": sys.version.split()[0],
                "platform": sys.platform,
            }

        dispatcher.register("sidecar.health", _sidecar_health)
        logger.info("sidecar.health method registered (backend observability)")
    except Exception as e:
        logger.exception(f"failed to register sidecar.health: {e}")


# ============================================================================
# 主循环
# ============================================================================
def main() -> None:
    """Sidecar 主入口"""
    global _rust_bridge
    logger.info("TDSF Python Sidecar starting...")
    logger.info(f"Python {sys.version.split()[0]} on {sys.platform}")

    # 0. TDSF 魔改 (2026-07-28): 安装后端日志 ringbuffer handler
    #    必须在任何业务模块 import 之前, 否则早期日志会丢失
    #    注入 rust_notifier 让新日志实时通过 sidecar:log event 推送到前端
    try:
        from core import log_capture
        log_capture.install_handler(
            rust_notifier=lambda event_name, payload: send_notification(event_name, payload)
        )
    except Exception as e:
        # 静默失败, 不阻断启动, log_capture 是 best-effort
        sys.stderr.write(f"[sidecar] log_capture install failed: {e}\n")

    # 0.5 TDSF P1-3 (2026-07-30): 创建全局 RustBridge 实例
    # ---------------------------------------------------------------
    # Python→Rust 反向 JSON-RPC 通道。注入 write_message 回调，
    # 让 send_request_to_rust 能把请求写到 stdout 给 Rust 侧 reader_task。
    # register_business_methods 中 Strands 注入段会读取全局 _rust_bridge
    # 包装成 DefaultRustBridge 给工具调用。
    # 主循环用 is_reverse_response 判定 Rust 返回的响应，路由到 pending。
    try:
        from rust_bridge import RustBridge
        _rust_bridge = RustBridge(write_message=write_message)
        logger.info(
            f"rust_bridge initialized "
            f"(reverse_id_start=1_000_000, timeout=30s)"
        )
    except Exception as e:
        logger.exception(f"failed to initialize rust_bridge: {e}")
        # _rust_bridge 保持 None，Strands 注入段会降级为 unavailable

    # 1. 初始化方法分发器
    dispatcher = MethodDispatcher()

    # 2. 注册业务方法（延迟导入，避免启动时副作用）
    try:
        register_business_methods(dispatcher)
        logger.info(
            f"registered {len(dispatcher.list_methods())} methods: "
            f"{dispatcher.list_methods()}"
        )
    except Exception as e:
        logger.exception(f"failed to register business methods: {e}")

    # 3. 发送 ready 通知（Rust 侧阻塞等待此信号判定启动成功）
    send_notification(
        "ready",
        {
            "version": "1.0.0",
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "methods": dispatcher.list_methods(),
            "startup_time": time.time() - START_TIME,
        },
    )
    logger.info("ready notification sent, entering main loop")

    # TDSF P1-NEW-1 修复 (2026-07-30): 初始化慢方法线程池
    # max_workers=2：允许一个 agent.invoke 在跑时，另一个工作线程处理
    # 同时到达的慢方法（罕见但可能），同时避免并发过多 LLM 调用。
    # 快方法（ping 等）仍在主线程同步执行，不经过线程池。
    global _main_executor
    _main_executor = ThreadPoolExecutor(
        max_workers=2,
        thread_name_prefix="sidecar-async",
    )
    logger.info("slow method executor initialized (max_workers=2)")

    # 4. 主循环：逐行读取 stdin
    while not _shutdown_flag:
        try:
            line = sys.stdin.readline()
            if not line:
                # stdin 关闭（Rust 进程退出或主动关闭 pipe）
                logger.info("stdin closed, exiting")
                break

            line = line.strip()
            if not line:
                continue

            # 解析 JSON-RPC 消息
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                logger.error(f"JSON parse error: {e} (line: {line[:200]!r})")
                send_error(ERR_PARSE_ERROR, f"Parse error: {e}", None)
                continue

            # 校验消息格式
            if not isinstance(msg, dict):
                send_error(ERR_INVALID_REQUEST, "Message must be a JSON object", None)
                continue

            # TDSF P1-5 (2026-07-30): 反向 JSON-RPC 响应分发
            # ---------------------------------------------------------------
            # 先判定是否是 Rust 返回的 Python→Rust 反向请求响应：
            #   - id ≥ 1,000,000 且无 method = Rust 回给 Python 反向请求的响应
            #   - 路由到 RustBridge.dispatch_response，唤醒对应的 pending send_request
            #   - 不进入 MethodDispatcher（响应不是请求，无需 dispatch）
            # 详见 rust_bridge.py docstring 与 sidecar.rs reader_task 注释。
            if _rust_bridge is not None and _rust_bridge.is_reverse_response(msg):
                _rust_bridge.dispatch_response(msg)
                continue

            if "method" not in msg:
                # 不是请求/通知，也不是反向响应（可能是 id < 1,000,000 的孤儿响应）
                logger.warning(f"ignoring non-method message: {msg}")
                continue

            method = msg.get("method")
            params = msg.get("params")
            req_id = msg.get("id")

            # 通知（无 id）vs 请求（有 id）
            is_notification = req_id is None

            # 分发方法调用
            # TDSF P1-NEW-1 修复 (2026-07-30): 慢方法（agent.invoke）提交到线程池
            # 异步执行，主循环立即继续读 stdin，保证 ping 响应不被 LLM 调用阻塞。
            # 快方法（ping / status / agent.list / sidecar.health 等）仍同步派发。
            if _main_executor is not None and method in _slow_methods:
                _main_executor.submit(
                    _dispatch_in_executor,
                    dispatcher,
                    method,
                    params,
                    req_id,
                    is_notification,
                )
                continue

            try:
                result = dispatcher.dispatch(method, params)
                if not is_notification:
                    send_response(result, req_id)
            except JSONRPCError as e:
                logger.warning(f"JSONRPCError in {method}: {e.message}")
                if not is_notification:
                    send_error(e.code, e.message, req_id, e.data)
            except Exception as e:
                logger.exception(f"unexpected error in method {method}")
                if not is_notification:
                    send_error(ERR_INTERNAL_ERROR, str(e), req_id)

        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt, exiting")
            break
        except Exception as e:
            logger.exception(f"unexpected error in main loop: {e}")
            time.sleep(0.1)  # 避免忙循环消耗 CPU

    # 5. 退出清理
    # 5.0 TDSF P1-NEW-1 (2026-07-30): 关闭慢方法线程池
    #     等待正在执行的 agent.invoke 完成（最多 5s），避免响应丢失。
    #     不阻塞过久以免 Rust 侧 SIGTERM 强杀。
    # P1-NEW-v2-6 修复 (2026-07-30): shutdown(wait=True) 无超时保护，
    # 若 LLM HTTP 请求 hang 住会导致 sidecar 退出卡死。改为 wait=False，
    # 不等待正在执行的 future，由 Rust 侧 SHUTDOWN_GRACE=3s + SIGKILL 兜底。
    # （cancel_futures=True 仍取消排队中的 future；正在执行的 future 在
    #   进程退出时由 OS 回收，LLM HTTP 连接会被强制断开）
    if _main_executor is not None:
        try:
            _main_executor.shutdown(wait=False, cancel_futures=True)
            logger.info("slow method executor shutdown initiated (non-blocking)")
        except Exception as e:
            logger.debug(f"executor shutdown on exit: {e}")
    # 5.0.1 TDSF P1-3 (2026-07-30): 关闭 RustBridge，唤醒所有 pending 请求
    #       避免主线程退出时悬挂在 Event.wait 的工具调用永远阻塞
    if _rust_bridge is not None:
        try:
            _rust_bridge.stop()
            logger.info("rust_bridge stopped")
        except Exception as e:
            logger.debug(f"rust_bridge stop on exit: {e}")
    # 5.1 停止 needs_you 超时扫描线程（避免主进程退出时线程残留告警）
    try:
        import needs_you
        needs_you.stop_global_service()
    except Exception as e:
        logger.debug(f"needs_you stop on exit: {e}")
    # 5.2 计算 uptime 并记录
    uptime = time.time() - START_TIME
    logger.info(f"TDSF Python Sidecar stopped (uptime: {uptime:.1f}s)")

    # P1-NEW-v3-4 修复 (2026-07-30): 强制 os._exit(0) 跳过 Python atexit
    # _python_exit handler (concurrent.futures.thread 模块级 atexit 注册)。
    #
    # 根因: ThreadPoolExecutor 创建的工作线程默认 daemon=False,
    # Python 解释器退出时 _python_exit 会 join 所有非 daemon 线程。
    # 若 LLM HTTP 请求 hang 住, 工作线程不会退出, _python_exit 卡死,
    # sidecar 进程无法退出 (与 P1-NEW-v2-6 改 wait=False 的修复预期不符)。
    #
    # 修复: 在所有手动清理 (5.0/5.0.1/5.1/5.2) 完成后, 调 os._exit(0)
    # 强制退出, 跳过 _python_exit。手动清理已在上面 try/except 保护,
    # 确保一定执行。os._exit(0) 会跳过 atexit 但不会跳过已 flush 的日志。
    #
    # 安全性:
    # - 5.0 executor.shutdown(wait=False, cancel_futures=True) 已取消排队 future
    # - 5.0.1 rust_bridge.stop() 已唤醒所有 pending 工具调用
    # - 5.1 needs_you.stop_global_service() 已停超时扫描线程
    # - 正在执行的 LLM HTTP 请求会被 OS 强制断开 (TCP RST)
    # - Rust 侧 SHUTDOWN_GRACE=3s + SIGKILL 兜底 (sidecar.rs)
    import os as _os_exit_mod
    _os_exit_mod._exit(0)


if __name__ == "__main__":
    main()
