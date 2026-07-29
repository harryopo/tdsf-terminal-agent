"""
TDSF Terminal Agent — stdio JSON-RPC 2.0 服务器（T-P1-02.1）
=============================================================

职责：
- 封装 stdio JSON-RPC 2.0 协议（stdin 读请求，stdout 写响应）
- 提供线程安全的消息写入（多线程可同时调用 send_notification）
- 内置方法分发器（区分请求/通知，自动路由到 handler）
- 内置默认方法（ping / shutdown / status）
- 信号处理（SIGTERM/SIGINT/SIGBREAK 优雅退出）

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

用法：
    from jsonrpc import JSONRPCServer

    server = JSONRPCServer()
    server.install_signal_handlers()

    # 注册业务方法
    server.register("agent.invoke", handle_agent_invoke)
    server.register_notification("event.subscribe", handle_event_subscribe)

    # 发送 ready 通知（Rust 侧阻塞等待）
    server.send_notification("ready", {"version": "1.0.0", ...})

    # 进入主循环（阻塞，直到 shutdown 或 stdin 关闭）
    server.run()
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import threading
import time
from typing import Any, Callable

# ============================================================================
# 模块级常量（供其他模块 import 复用）
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
ERR_WRITE_LEASE = -32002      # 写租约冲突（Project Service 并发写）


# ============================================================================
# JSONRPCError 异常
# ============================================================================

class JSONRPCError(Exception):
    """JSON-RPC 错误异常，携带错误码 + 消息 + 可选 data 字段

    用法：
        raise JSONRPCError(ERR_METHOD_NOT_FOUND, "Method not found: foo",
                          data={"available": ["ping", "status"]})

    在 handler 中 raise 后，JSONRPCServer 会自动捕获并发送 error 响应。
    """

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

    def __repr__(self) -> str:
        return f"JSONRPCError(code={self.code}, message={self.message!r})"


# ============================================================================
# JSONRPCServer 类
# ============================================================================

class JSONRPCServer:
    """stdio JSON-RPC 2.0 服务器

    特性：
    - 请求/响应/通知三态处理（自动区分有 id / 无 id 消息）
    - 线程安全 stdout 写入（多线程可同时调用 send_notification/send_response）
    - 内置方法分发器（register / register_notification）
    - 内置默认方法（ping / shutdown / status）
    - 信号处理（SIGTERM/SIGINT/SIGBREAK 优雅退出）
    - 错误码定义（JSON-RPC 2.0 标准 + TDSF 扩展）

    线程模型：
    - 主线程：run() 阻塞读 stdin，分发请求
    - 其他线程：可通过 send_notification/send_response 写 stdout（线程安全）
    - 信号线程：信号处理器设置 _shutdown_flag，主循环检测后退出
    """

    # 协议常量（类属性，方便外部通过类访问）
    JSONRPC_VERSION = JSONRPC_VERSION

    # 错误码（类属性，方便外部通过类访问）
    ERR_PARSE_ERROR = ERR_PARSE_ERROR
    ERR_INVALID_REQUEST = ERR_INVALID_REQUEST
    ERR_METHOD_NOT_FOUND = ERR_METHOD_NOT_FOUND
    ERR_INVALID_PARAMS = ERR_INVALID_PARAMS
    ERR_INTERNAL_ERROR = ERR_INTERNAL_ERROR
    ERR_SERVER_GENERIC = ERR_SERVER_GENERIC
    ERR_TIMEOUT = ERR_TIMEOUT
    ERR_WRITE_LEASE = ERR_WRITE_LEASE

    def __init__(
        self,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
    ):
        """
        Args:
            stdin:  输入流（默认 sys.stdin），按行读取 JSON-RPC 消息
            stdout: 输出流（默认 sys.stdout），写入 JSON-RPC 响应/通知
            stderr: 错误流（默认 sys.stderr），仅用于日志（避免污染 stdout）
        """
        self._stdin = stdin if stdin is not None else sys.stdin
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr

        # stdout 写入锁（多线程同时写时加锁，避免消息交错）
        self._write_lock = threading.Lock()

        # 请求方法表（method → handler，有 id，需响应）
        self._request_handlers: dict[str, Callable[..., Any]] = {}

        # 通知方法表（method → handler，无 id，无响应）
        self._notification_handlers: dict[str, Callable[..., Any]] = {}

        # shutdown 标志（由 shutdown 方法或信号处理设置）
        self._shutdown_flag = False

        # 启动时间（用于 uptime 计算）
        self._start_time = time.time()

        self._logger = logging.getLogger("sidecar.jsonrpc")

        # 注册默认方法
        self._register_defaults()

    # ========================================================================
    # 注册接口
    # ========================================================================

    def register(self, method: str, handler: Callable[..., Any]) -> None:
        """注册请求方法（有 id，需响应）

        Args:
            method:  方法名（如 "agent.invoke"）
            handler: 处理函数，签名取决于 params 类型：
                     - dict 参数: handler(**params)
                     - list 参数: handler(*params)
                     - None 参数: handler()
                     返回值作为 result 字段发送给调用方
        """
        self._request_handlers[method] = handler
        self._logger.debug(f"registered request method: {method}")

    def register_notification(self, method: str, handler: Callable[..., Any]) -> None:
        """注册通知方法（无 id，无响应）

        Args:
            method:  方法名（如 "event.subscribe"）
            handler: 处理函数，签名同 register()
        """
        self._notification_handlers[method] = handler
        self._logger.debug(f"registered notification method: {method}")

    def list_methods(self) -> list[str]:
        """返回已注册的所有请求方法名（不含通知方法）"""
        return sorted(self._request_handlers.keys())

    def list_notification_methods(self) -> list[str]:
        """返回已注册的所有通知方法名"""
        return sorted(self._notification_handlers.keys())

    # ========================================================================
    # 状态查询
    # ========================================================================

    @property
    def uptime(self) -> float:
        """返回服务器运行时长（秒）"""
        return time.time() - self._start_time

    @property
    def is_shutting_down(self) -> bool:
        """是否正在关闭"""
        return self._shutdown_flag

    # ========================================================================
    # 消息发送（线程安全，可从任意线程调用）
    # ========================================================================

    def send_response(self, result: Any, req_id: Any) -> None:
        """发送成功响应

        Args:
            result: 结果数据（任意可 JSON 序列化的对象）
            req_id: 请求 id（与请求中的 id 对应）
        """
        self._write_message({
            "jsonrpc": JSONRPC_VERSION,
            "result": result,
            "id": req_id,
        })

    def send_error(
        self,
        code: int,
        message: str,
        req_id: Any,
        data: Any = None,
    ) -> None:
        """发送错误响应

        Args:
            code:    错误码（见 ERR_* 常量）
            message: 错误消息
            req_id:  请求 id（与请求中的 id 对应，None 表示无法关联请求）
            data:    可选的附加数据（如 traceback、可用方法列表等）
        """
        err: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            err["data"] = data
        self._write_message({
            "jsonrpc": JSONRPC_VERSION,
            "error": err,
            "id": req_id,
        })

    def send_notification(self, method: str, params: Any = None) -> None:
        """发送通知（无 id，无响应）

        用于 Sidecar 主动通知 Rust 侧事件（如 ready / mood_change / agent_message）

        Args:
            method: 通知方法名（如 "ready" / "mood_change"）
            params: 通知参数（任意可 JSON 序列化的对象）
        """
        msg: dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "method": method}
        if params is not None:
            msg["params"] = params
        self._write_message(msg)

    def _write_message(self, msg: dict) -> None:
        """写一行 JSON-RPC 消息到 stdout（线程安全）

        Rust 侧按行读取（BufRead::read_line），因此每条消息必须以 \\n 结尾
        """
        line = json.dumps(msg, ensure_ascii=False)
        with self._write_lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()

    # ========================================================================
    # 信号处理
    # ========================================================================

    def install_signal_handlers(self) -> None:
        """安装信号处理器（SIGTERM/SIGINT/SIGBREAK 触发优雅退出）

        Windows 不支持 SIGTERM，用 SIGBREAK 替代
        """
        def handler(signum: int, frame: Any) -> None:
            self._logger.info(f"received signal {signum}, shutting down...")
            self._shutdown_flag = True

        signal.signal(signal.SIGINT, handler)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, handler)
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, handler)

    # ========================================================================
    # 主动关闭
    # ========================================================================

    def shutdown(self) -> None:
        """请求优雅退出（设置 _shutdown_flag，主循环检测后退出）"""
        self._shutdown_flag = True
        self._logger.info("shutdown requested")

    # ========================================================================
    # 主循环
    # ========================================================================

    def run(self) -> None:
        """进入主循环（阻塞，直到 shutdown 或 stdin 关闭）

        主循环逻辑：
        1. 逐行读取 stdin
        2. 解析 JSON-RPC 消息
        3. 区分请求（有 id）/ 通知（无 id）
        4. 分发到对应 handler
        5. 请求返回 result，通知无响应
        6. 异常时发送 error 响应
        """
        self._logger.info("JSONRPCServer entering main loop")

        while not self._shutdown_flag:
            try:
                line = self._stdin.readline()
                if not line:
                    # stdin 关闭（Rust 进程退出或主动关闭 pipe）
                    self._logger.info("stdin closed, exiting")
                    break

                line = line.strip()
                if not line:
                    continue

                self._handle_message(line)

            except KeyboardInterrupt:
                self._logger.info("KeyboardInterrupt, exiting")
                break
            except Exception as e:
                # 主循环异常不应退出（避免 Sidecar 崩溃）
                self._logger.exception(f"unexpected error in main loop: {e}")
                time.sleep(0.1)  # 避免忙循环消耗 CPU

        uptime = time.time() - self._start_time
        self._logger.info(f"JSONRPCServer stopped (uptime: {uptime:.1f}s)")

    # ========================================================================
    # 消息处理（内部）
    # ========================================================================

    def _handle_message(self, line: str) -> None:
        """处理一条 JSON-RPC 消息

        步骤：
        1. JSON 解析（失败 → -32700 Parse error）
        2. 格式校验（非 dict → -32600 Invalid Request）
        3. 区分请求（有 id）/ 通知（无 id）
        4. 分发到 handler
        5. 异常 → 发送 error 响应
        """
        # 1. JSON 解析
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            self._logger.error(f"JSON parse error: {e} (line: {line[:200]!r})")
            self.send_error(ERR_PARSE_ERROR, f"Parse error: {e}", None)
            return

        # 2. 格式校验
        if not isinstance(msg, dict):
            self.send_error(
                ERR_INVALID_REQUEST,
                "Message must be a JSON object",
                None,
            )
            return

        if "method" not in msg:
            # 不是请求/通知，可能是响应（Sidecar 不接收响应，忽略）
            self._logger.warning(f"ignoring non-method message: {msg}")
            return

        method = msg.get("method")
        params = msg.get("params")
        req_id = msg.get("id")

        # 3. 区分请求（有 id）/ 通知（无 id）
        is_notification = req_id is None

        # 4. 分发
        try:
            if is_notification:
                handler = self._notification_handlers.get(method)
                if handler is not None:
                    self._call_handler(handler, params)
                else:
                    self._logger.debug(f"unhandled notification: {method}")
            else:
                handler = self._request_handlers.get(method)
                if handler is None:
                    raise JSONRPCError(
                        ERR_METHOD_NOT_FOUND,
                        f"Method not found: {method}",
                        data={"available": self.list_methods()},
                    )
                result = self._call_handler(handler, params)
                self.send_response(result, req_id)

        except JSONRPCError as e:
            self._logger.warning(f"JSONRPCError in {method}: {e.message}")
            if not is_notification:
                self.send_error(e.code, e.message, req_id, e.data)
        except Exception as e:
            self._logger.exception(f"unexpected error in method {method}")
            if not is_notification:
                self.send_error(ERR_INTERNAL_ERROR, str(e), req_id)

    @staticmethod
    def _call_handler(handler: Callable[..., Any], params: Any) -> Any:
        """调用 handler，自动适配参数类型

        支持的 params 类型：
        - dict:   命名参数 handler(**params)
        - list:   位置参数 handler(*params)
        - None:   无参数 handler()
        - 其他:   抛出 -32602 Invalid params
        """
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

    # ========================================================================
    # 默认方法（ping / shutdown / status）
    # ========================================================================

    def _register_defaults(self) -> None:
        """注册默认方法"""
        self.register("ping", self._default_ping)
        self.register("shutdown", self._default_shutdown)
        self.register("status", self._default_status)

    def _default_ping(self) -> dict:
        """心跳响应（Rust 每 5s ping 一次，30s 无响应判定死锁）"""
        return {"alive": True, "uptime": self.uptime}

    def _default_shutdown(self) -> dict:
        """优雅退出（设置 _shutdown_flag，主循环检测后退出）"""
        self.shutdown()
        return {"ok": True}

    def _default_status(self) -> dict:
        """返回 Sidecar 状态（版本 + uptime + 已注册方法列表）"""
        return {
            "version": "1.0.0",
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "uptime": self.uptime,
            "methods": self.list_methods(),
            "notifications": self.list_notification_methods(),
            "ready": True,
        }
