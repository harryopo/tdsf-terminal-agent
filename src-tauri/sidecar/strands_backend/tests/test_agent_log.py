"""
strands_backend/tests/test_agent_log.py — 会话流水日志测试（2026-08-31）
==========================================================================

覆盖：
1. log_event / tail 往返（写入 → 读回一致）
2. content 截断 ≤2000 字符
3. 轮转：单文件超阈值（monkeypatch ROTATE_BYTES）→ .jsonl.1
4. type 过滤（debug.agent_log_tail type 参数）
5. session_id 文件名清洗（路径穿越防护）
6. debug.agent_log_tail RPC：带 session_id / 不带（列会话 + 最新 tail）
7. event_bus tool_call 事件桥接（started → tool_call / completed → tool_result）
8. TdsfStrandsCallbackHandler reasoning 增量聚合 → reasoning 行落盘

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_agent_log.py -v
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_agent_log(tmp_path, monkeypatch):
    """隔离：TDSF_DATA_DIR → tmp_path（agent_log 每次读环境变量，惰性建目录）"""
    from strands_backend.agent_log import reset_for_test

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    yield
    reset_for_test()


# ============================================================================
# 1. log_event / tail 往返
# ============================================================================


class TestLogEventTail:
    def test_roundtrip(self):
        from strands_backend.agent_log import log_event, tail

        assert log_event("s1", "user_msg", "查看目录", meta={"mode": "confirm"}) is True
        assert log_event("s1", "assistant_msg", "好的，当前目录是 ...")

        result = tail(session_id="s1", lines=10)
        assert result["ok"] is True
        assert result["returned"] == 2
        types = [line["type"] for line in result["lines"]]
        assert types == ["user_msg", "assistant_msg"]  # 正序
        assert result["lines"][0]["content"] == "查看目录"
        assert result["lines"][0]["meta"] == {"mode": "confirm"}
        assert isinstance(result["lines"][0]["ts"], float)

    def test_empty_session_goes_to_default(self):
        from strands_backend.agent_log import log_event, sanitize_session_id, tail

        log_event("", "user_msg", "无会话输入")
        result = tail(session_id="default", lines=5)
        assert result["returned"] == 1
        assert sanitize_session_id("") == "default"

    def test_non_string_content_jsonified(self):
        from strands_backend.agent_log import log_event, tail

        log_event("s1", "tool_result", {"stdout": "nginx is running", "exit": 0})
        line = tail(session_id="s1", lines=1)["lines"][0]
        assert "nginx is running" in line["content"]


# ============================================================================
# 2. content 截断
# ============================================================================


class TestContentClip:
    def test_content_truncated_to_2000(self):
        from strands_backend.agent_log import _MAX_CONTENT_LEN, log_event, tail

        log_event("s1", "assistant_msg", "x" * 5000)
        line = tail(session_id="s1", lines=1)["lines"][0]
        assert len(line["content"]) == _MAX_CONTENT_LEN + 1  # 含省略号
        assert line["content"].endswith("…")


# ============================================================================
# 3. 轮转
# ============================================================================


class TestRotation:
    def test_rotate_on_size_threshold(self, monkeypatch):
        from strands_backend import agent_log

        monkeypatch.setattr(agent_log, "ROTATE_BYTES", 100)
        for i in range(5):
            agent_log.log_event("s1", "user_msg", f"line-{i}-" + "y" * 40)

        log_file = agent_log._log_file("s1")
        backup = Path(str(log_file) + ".1")
        assert backup.exists(), "旧文件应轮转为 .1"
        assert log_file.exists(), "新文件继续写入"
        assert agent_log._stats["rotated"] >= 1
        # 新文件至少有最后一条
        assert "line-4" in log_file.read_text(encoding="utf-8")


# ============================================================================
# 4. type 过滤
# ============================================================================


class TestTypeFilter:
    def test_filter_by_type(self):
        from strands_backend.agent_log import log_event, tail

        log_event("s1", "user_msg", "问题")
        log_event("s1", "reasoning", "推理过程")
        log_event("s1", "tool_call", "ls")
        log_event("s1", "assistant_msg", "回答")

        result = tail(session_id="s1", lines=50, event_type="tool_call")
        assert result["returned"] == 1
        assert result["lines"][0]["type"] == "tool_call"


# ============================================================================
# 5. session_id 清洗
# ============================================================================


class TestSessionIdSanitize:
    def test_path_traversal_neutralized(self):
        from strands_backend.agent_log import _log_file, sanitize_session_id

        # "/" → "_" 且首尾 [._] 被 strip → 不含任何路径分隔/前导点
        assert sanitize_session_id("../../etc/passwd") == "etc_passwd"
        f = _log_file("../../etc/passwd")
        # 断言文件落在 agent-logs 目录内（无路径逃逸）
        assert f.parent.name == "agent-logs"
        assert f.name == "etc_passwd.jsonl"

    def test_special_chars_replaced(self):
        from strands_backend.agent_log import sanitize_session_id

        assert sanitize_session_id("a/b\\c:d*e") == "a_b_c_d_e"
        # 全非法字符 → strip 后为空 → 归 default（防空文件名）
        assert sanitize_session_id("中文会话") == "default"

    def test_long_id_truncated(self):
        from strands_backend.agent_log import sanitize_session_id

        assert len(sanitize_session_id("s" * 200)) <= 80


# ============================================================================
# 6. debug.agent_log_tail RPC
# ============================================================================


class TestRpcAgentLogTail:
    def _make_dispatcher(self):
        class _D:
            def __init__(self):
                self.methods = {}

            def register(self, name, handler):
                self.methods[name] = handler

        return _D()

    def test_rpc_registered_and_callable(self):
        from strands_backend.agent_log import log_event, register_methods

        d = self._make_dispatcher()
        register_methods(d)
        assert "debug.agent_log_tail" in d.methods

        log_event("s1", "user_msg", "hello")
        result = d.methods["debug.agent_log_tail"](session_id="s1", lines=10)
        assert result["ok"] is True
        assert result["returned"] == 1

    def test_rpc_without_session_lists_files_and_latest(self):
        from strands_backend.agent_log import log_event, register_methods

        d = self._make_dispatcher()
        register_methods(d)
        log_event("sess-a", "user_msg", "a 的问题")
        log_event("sess-b", "user_msg", "b 的问题")

        result = d.methods["debug.agent_log_tail"]()
        assert result["ok"] is True
        assert {f["session_id"] for f in result["files"]} >= {"sess-a", "sess-b"}
        assert result["latest_session_id"] in {"sess-a", "sess-b"}
        assert result["returned"] >= 1

    def test_rpc_no_files_at_all(self):
        from strands_backend.agent_log import register_methods

        d = self._make_dispatcher()
        register_methods(d)
        result = d.methods["debug.agent_log_tail"]()
        assert result["ok"] is True
        assert result["files"] == []
        assert result["lines"] == []


# ============================================================================
# 7. event_bus tool_call 桥接
# ============================================================================


class TestBusBridge:
    def _make_event(self, status: str, tool: str = "ssh_command"):
        from event_bus import Event

        payload = {"tool_name": tool, "params": {"command": "ls -la"}, "status": status}
        if status != "started":
            payload["result"] = {"output": "file1\nfile2", "exit_code": 0}
        return Event(
            event_type="tool_call",
            payload=payload,
            session_id="s1",
            source="test",
        )

    def test_tool_call_and_result_logged(self):
        from strands_backend.agent_log import _handle_bus_event, tail

        _handle_bus_event(self._make_event("started"))
        _handle_bus_event(self._make_event("completed"))

        result = tail(session_id="s1", lines=10)
        types = [line["type"] for line in result["lines"]]
        assert types == ["tool_call", "tool_result"]
        assert result["lines"][0]["meta"]["tool_name"] == "ssh_command"
        assert "ls -la" in result["lines"][0]["content"]
        assert "file1" in result["lines"][1]["content"]

    def test_non_tool_event_ignored(self):
        from strands_backend.agent_log import _handle_bus_event, tail
        from event_bus import Event

        _handle_bus_event(
            Event(event_type="mood_change", payload={"mood": "thinking"}, session_id="s1")
        )
        assert tail(session_id="s1", lines=10)["returned"] == 0

    def test_subscribe_via_register_methods(self):
        from strands_backend.agent_log import register_methods
        from event_bus import get_global_bus

        d = TestRpcAgentLogTail._make_dispatcher(self)
        register_methods(d)

        get_global_bus().publish(self._make_event("started"))
        from strands_backend.agent_log import tail

        assert tail(session_id="s1", lines=10)["returned"] == 1


# ============================================================================
# 8. handler reasoning 聚合
# ============================================================================


class TestHandlerReasoningAggregate:
    def _make_handler(self):
        from strands_backend.adapter import TdsfStrandsCallbackHandler

        return TdsfStrandsCallbackHandler(
            event_bus=None, agent_name="main", session_id="s1"
        )

    def test_reasoning_delta_aggregated_on_data(self):
        h = self._make_handler()
        h._handle_event({"reasoningText": "The user "})
        h._handle_event({"reasoningText": "asked about dirs. "})
        h._handle_event({"data": "你好"})  # 正文开始 → reasoning 落盘
        h._handle_event({"complete": True})

        from strands_backend.agent_log import tail

        result = tail(session_id="s1", lines=10, event_type="reasoning")
        assert result["returned"] == 1
        assert result["lines"][0]["content"] == "The user asked about dirs."
        assert h._stats["reasoning_logged"] == 1

    def test_reasoning_flushed_on_complete_without_data(self):
        h = self._make_handler()
        h._handle_event({"reasoningText": "只有推理没有正文"})
        h._handle_event({"complete": True})

        from strands_backend.agent_log import tail

        result = tail(session_id="s1", lines=10, event_type="reasoning")
        assert result["returned"] == 1

    def test_no_reasoning_no_line(self):
        h = self._make_handler()
        h._handle_event({"data": "直接回答"})
        h._handle_event({"complete": True})

        from strands_backend.agent_log import tail

        assert tail(session_id="s1", lines=10, event_type="reasoning")["returned"] == 0


# ============================================================================
# 9. adapter.invoke 埋点（_split_input_for_log 纯函数）
# ============================================================================


class TestSplitInputForLog:
    def test_user_text_and_env_blocks_split(self):
        from strands_backend.adapter import _split_input_for_log

        inp = (
            "<env>workspace_root: /proj\nactive_terminal_cwd: /proj</env>\n"
            "<environment>\nos_pretty_name: CentOS\n</environment>\n\n"
            "查看当前目录下的项目和文件夹结构"
        )
        user, ctx = _split_input_for_log(inp)
        assert user == "查看当前目录下的项目和文件夹结构"
        assert "<env>" in ctx
        assert "<environment>" in ctx
        assert "查看当前目录" not in ctx

    def test_plain_input_untouched(self):
        from strands_backend.adapter import _split_input_for_log

        user, ctx = _split_input_for_log("你好")
        assert user == "你好"
        assert ctx == ""

    def test_live_context_block_recognized(self):
        from strands_backend.adapter import _split_input_for_log

        inp = "问题\n\n<live_context>\n当前终端工作目录: /x\n</live_context>"
        user, ctx = _split_input_for_log(inp)
        assert user == "问题"
        assert "live_context" in ctx


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
