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

# ============================================================================
# 日志配置（输出到 stderr，避免污染 stdout JSON-RPC 流）
# ============================================================================
logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("TDSF_SIDECAR_LOG", "INFO"),
    format="[sidecar] %(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
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

# 启动时间（用于 uptime 计算）
START_TIME = time.time()

# 全局 shutdown 标志（由 shutdown 方法或信号处理设置）
_shutdown_flag = False


def write_message(msg: dict) -> None:
    """写一行 JSON-RPC 消息到 stdout（线程安全，每条消息以换行符分隔）

    Rust 侧按行读取（BufRead::read_line），因此每条消息必须以 \\n 结尾
    """
    line = json.dumps(msg, ensure_ascii=False)
    with _write_lock:
        _stdout.write(line + "\n")
        _stdout.flush()


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
        # TDSF 魔改 P0-3: 注入真实 LLM 调用（取代 llm_call=None 的 mock 模式）
        # 从环境变量 / .tdsf-data/llm_config.json 加载配置
        # 未配置时返回 None，Agent 降级到 mock LLM（保持离线可用）
        from core.llm_config import make_llm_call
        llm_call = make_llm_call()
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


# ============================================================================
# 主循环
# ============================================================================
def main() -> None:
    """Sidecar 主入口"""
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

            if "method" not in msg:
                # 不是请求/通知，可能是响应（Sidecar 不接收响应，忽略）
                logger.warning(f"ignoring non-method message: {msg}")
                continue

            method = msg.get("method")
            params = msg.get("params")
            req_id = msg.get("id")

            # 通知（无 id）vs 请求（有 id）
            is_notification = req_id is None

            # 分发方法调用
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
    # 5.1 停止 needs_you 超时扫描线程（避免主进程退出时线程残留告警）
    try:
        import needs_you
        needs_you.stop_global_service()
    except Exception as e:
        logger.debug(f"needs_you stop on exit: {e}")
    # 5.2 计算 uptime 并记录
    uptime = time.time() - START_TIME
    logger.info(f"TDSF Python Sidecar stopped (uptime: {uptime:.1f}s)")


if __name__ == "__main__":
    main()
