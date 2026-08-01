"""
tests/test_main_register_methods.py — main.register_business_methods 测试（T-P5-08）
====================================================================================

验证内容：
1. register_business_methods 能成功注册所有 P1-P5 模块
2. P5 模块（squilla / long_context / self_evolution / langfuse）的 JSON-RPC 方法已注册
3. 注册过程不抛异常（即使某些模块初始化失败也不应中断整体注册）
4. 已注册方法列表中包含 P5 关键方法名

运行：
    cd python-sidecar
    python -m pytest tests/test_main_register_methods.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import main 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

# 导入被测对象
import main


# ============================================================================
# Fake Dispatcher
# ============================================================================


class FakeDispatcher:
    """伪造的 MethodDispatcher，记录所有注册的方法名"""

    def __init__(self) -> None:
        self.methods: dict[str, object] = {}

    def register(self, name: str, fn: object) -> None:
        self.methods[name] = fn

    def list_methods(self) -> list[str]:
        return sorted(self.methods.keys())

    def dispatch(self, name: str, params: object | None = None) -> object:
        if name not in self.methods:
            raise main.JSONRPCError(
                main.ERR_METHOD_NOT_FOUND, f"method not found: {name}"
            )
        fn = self.methods[name]
        if not callable(fn):
            return fn
        # 简化 dispatch：直接调用，不处理 params 解包
        try:
            if params is None:
                return fn()
            if isinstance(params, dict):
                return fn(**params)
            if isinstance(params, list):
                return fn(*params)
            return fn(params)
        except TypeError:
            # 函数签名不匹配时回退到直接调用
            return fn()


# ============================================================================
# register_business_methods 测试
# ============================================================================


class TestRegisterBusinessMethods:
    """register_business_methods 集成测试"""

    @pytest.fixture(scope="class")
    def registered_dispatcher(self) -> FakeDispatcher:
        """Class 级 fixture：所有测试共享一次注册过程

        注册过程会启动一些后台线程（needs_you 超时扫描），
        但这些线程在测试进程退出时会自动结束。
        """
        dispatcher = FakeDispatcher()
        main.register_business_methods(dispatcher)
        return dispatcher

    def test_registration_completes_without_exception(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """register_business_methods 应能完整执行不抛异常"""
        # 如果能到达此处，说明注册过程成功
        assert registered_dispatcher is not None
        assert len(registered_dispatcher.methods) > 0

    def test_all_p5_methods_registered(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """P5 阶段的 4 个模块方法应全部注册"""
        methods = registered_dispatcher.list_methods()
        # T-P5-01: SquillaRouter
        assert "squilla.route" in methods, f"squilla.route missing, got: {methods}"
        assert "squilla.list_tiers" in methods
        # T-P5-02: LongContextManager
        assert "long_context.chunk" in methods
        assert "long_context.merge" in methods
        assert "long_context.summarize" in methods
        assert "long_context.status" in methods
        # T-P5-03: KEPA + Skill auto-gen
        assert "kepa.propagate" in methods
        assert "kepa.update_weights" in methods
        assert "skill.auto_generate" in methods
        # T-P5-07: Langfuse
        assert "langfuse.event" in methods
        assert "langfuse.flush" in methods
        assert "langfuse.stats" in methods
        assert "langfuse.trace" in methods

    def test_p1_p4_methods_also_registered(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """P1-P4 模块方法应依然注册（向后兼容）"""
        methods = registered_dispatcher.list_methods()
        # 抽样验证 P1-P4 关键方法
        assert "ping" in methods or "project.list" in methods or "agent.invoke" in methods
        # 至少应有 30+ 方法（P1-P5 累积）
        assert len(methods) >= 30, f"too few methods: {len(methods)}"

    def test_registered_methods_are_callable(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """所有注册的方法应是可调用对象"""
        for name, fn in registered_dispatcher.methods.items():
            assert callable(fn), f"method {name} is not callable: {type(fn)}"

    def test_langfuse_stats_dispatch_returns_dict(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """langfuse.stats 应可 dispatch 并返回字典"""
        result = registered_dispatcher.dispatch("langfuse.stats")
        assert isinstance(result, dict)
        assert "offline" in result
        assert "db" in result

    def test_squilla_list_tiers_dispatch_returns_dict(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """squilla.list_tiers 应可 dispatch 并返回包含 tiers 的字典"""
        result = registered_dispatcher.dispatch("squilla.list_tiers")
        assert isinstance(result, dict)
        assert "tiers" in result

    def test_long_context_status_dispatch_returns_dict(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """long_context.status 应可 dispatch 并返回字典"""
        result = registered_dispatcher.dispatch("long_context.status")
        assert isinstance(result, dict)

    def test_method_count_meets_minimum(
        self, registered_dispatcher: FakeDispatcher
    ) -> None:
        """注册方法总数应满足 P5 完成后的最小预期

        P1-P5 累积应至少有 50 个 JSON-RPC 方法
        """
        methods = registered_dispatcher.list_methods()
        assert len(methods) >= 50, (
            f"expected >= 50 methods, got {len(methods)}: {methods}"
        )


# ============================================================================
# JSONRPCError 测试（覆盖 main.py 的错误类）
# ============================================================================


class TestJSONRPCError:
    """JSONRPCError 异常类测试"""

    def test_error_to_dict_basic(self) -> None:
        """JSONRPCError.to_dict 应返回正确的字典结构"""
        err = main.JSONRPCError(-32000, "test error")
        d = err.to_dict()
        assert d["code"] == -32000
        assert d["message"] == "test error"
        assert "data" not in d  # data 为 None 时不应包含

    def test_error_to_dict_with_data(self) -> None:
        """JSONRPCError 携带 data 时 to_dict 应包含 data 字段"""
        err = main.JSONRPCError(-32602, "invalid params", data={"key": "value"})
        d = err.to_dict()
        assert d["code"] == -32602
        assert d["data"] == {"key": "value"}

    def test_error_constants_exist(self) -> None:
        """JSON-RPC 标准错误码常量应存在"""
        assert main.ERR_PARSE_ERROR == -32700
        assert main.ERR_INVALID_REQUEST == -32600
        assert main.ERR_METHOD_NOT_FOUND == -32601
        assert main.ERR_INVALID_PARAMS == -32602
        assert main.ERR_INTERNAL_ERROR == -32603
        assert main.ERR_SERVER_GENERIC == -32000
        assert main.ERR_TIMEOUT == -32001
        assert main.ERR_WRITE_LEASE == -32002


# ============================================================================
# write_message 容错测试（2026-07-31 加固）
# ============================================================================


class _RaisingStdout:
    """模拟 stdout 写入失败（Windows 管道 EINVAL / 读端关闭）"""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc
        self.write_calls = 0

    def write(self, _data: str) -> int:
        self.write_calls += 1
        raise self._exc

    def flush(self) -> None:  # pragma: no cover - 不会到达
        raise self._exc


class _RecordingStderr:
    def __init__(self) -> None:
        self.buffer = ""

    def write(self, data: str) -> int:
        self.buffer += data
        return len(data)

    def flush(self) -> None:
        pass


class _OkStdout:
    def __init__(self) -> None:
        self.data = ""

    def write(self, data: str) -> int:
        self.data += data
        return len(data)

    def flush(self) -> None:
        pass


class TestWriteMessageResilience:
    """write_message 对 stdout 管道写失败的容错

    根因：Tauri spawn 下 sidecar 每次 stdout 写都得到 OSError(22) EINVAL，
    ready 通知写失败未捕获 → 进程退出 → Rust 判 "crashed during startup"。
    加固后写失败不再冒泡崩溃，降级到 stderr 记录一次。
    """

    def test_oserror_einval_does_not_raise(self, monkeypatch: pytest.MonkeyPatch) -> None:
        raising = _RaisingStdout(OSError(22, "Invalid argument"))
        stderr = _RecordingStderr()
        monkeypatch.setattr(main, "_stdout", raising)
        monkeypatch.setattr(main, "_stdout_broken", False)
        monkeypatch.setattr(main.sys, "stderr", stderr)

        # 不应抛出（否则会杀死 sidecar）
        main.write_message({"jsonrpc": "2.0", "method": "ready", "params": {"x": 1}})
        assert raising.write_calls == 1
        assert "stdout write failed" in stderr.buffer

    def test_valueerror_closed_file_does_not_raise(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raising = _RaisingStdout(ValueError("I/O operation on closed file"))
        stderr = _RecordingStderr()
        monkeypatch.setattr(main, "_stdout", raising)
        monkeypatch.setattr(main, "_stdout_broken", False)
        monkeypatch.setattr(main.sys, "stderr", stderr)

        main.write_message({"jsonrpc": "2.0", "method": "ping"})
        assert "stdout write failed" in stderr.buffer

    def test_stderr_logged_once_then_deduped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        raising = _RaisingStdout(OSError(22, "Invalid argument"))
        stderr = _RecordingStderr()
        monkeypatch.setattr(main, "_stdout", raising)
        monkeypatch.setattr(main, "_stdout_broken", False)
        monkeypatch.setattr(main.sys, "stderr", stderr)

        for _ in range(5):
            main.write_message({"jsonrpc": "2.0", "method": "sidecar:log"})
        # 5 次写失败，但 stderr 只记录一次（去重）
        assert stderr.buffer.count("stdout write failed") == 1

    def test_recovery_resets_broken_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ok = _OkStdout()
        monkeypatch.setattr(main, "_stdout", ok)
        monkeypatch.setattr(main, "_stdout_broken", True)  # 之前处于失败态
        monkeypatch.setattr(main.sys, "stderr", _RecordingStderr())

        main.write_message({"jsonrpc": "2.0", "method": "ping"})
        # 写成功后应复位 broken 标志，且内容真正写出
        assert main._stdout_broken is False
        assert '"ping"' in ok.data
