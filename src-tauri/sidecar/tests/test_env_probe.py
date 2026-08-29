"""
test_env_probe.py — env_probe（系统环境探测）单测
（方案书 v3.1 §4.7 B1 终端感知，2026-08-29）

覆盖：
- parse_os_release_pretty_name：引号/无引号/缺失
- parse_probe_output：合并命令输出三段解析（os-release + kernel + shell）
- probe_env 本地分支（platform 降级路径）
- probe_env SSH 分支：mock main._rust_bridge（成功/失败/rust_bridge 未注入）
- 会话级缓存命中 + TTL 过期 + 不同 ssh_session_id 隔离
- register_methods 注册协议（**kwargs 解包签名）
"""
import sys
import time
from pathlib import Path
from unittest import mock

import pytest

# sidecar 根目录加入 sys.path（与 tests/conftest 同级 import 惯例）
SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import env_probe  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_cache():
    env_probe.clear_cache()
    yield
    env_probe.clear_cache()


# ============================================================================
# os-release 解析
# ============================================================================

class TestParseOsRelease:
    def test_quoted_pretty_name(self):
        text = 'NAME="CentOS Linux"\nVERSION="7 (Core)"\nPRETTY_NAME="CentOS Linux 7 (Core)"\n'
        assert (
            env_probe.parse_os_release_pretty_name(text)
            == "CentOS Linux 7 (Core)"
        )

    def test_unquoted_pretty_name(self):
        assert env_probe.parse_os_release_pretty_name("PRETTY_NAME=Ubuntu\n") == "Ubuntu"

    def test_missing_returns_empty(self):
        assert env_probe.parse_os_release_pretty_name('NAME="X"\nID=x\n') == ""
        assert env_probe.parse_os_release_pretty_name("") == ""


# ============================================================================
# 合并命令输出解析
# ============================================================================

class TestParseProbeOutput:
    def test_full_structure(self):
        output = (
            'NAME="CentOS Linux"\nPRETTY_NAME="CentOS Linux 7 (Core)"\n\n'
            "__TDSF_KERNEL__\n"
            "3.10.0-1160.el7.x86_64\n"
            "__TDSF_SHELL__\n"
            "/bin/bash\n"
        )
        data = env_probe.parse_probe_output(output)
        assert data["os_pretty_name"] == "CentOS Linux 7 (Core)"
        assert data["kernel"] == "3.10.0-1160.el7.x86_64"
        assert data["shell"] == "/bin/bash"

    def test_missing_os_release_segment(self):
        # os-release 不存在（cat 失败静默）：第一段为空
        output = "__TDSF_KERNEL__\n5.15.0-generic\n__TDSF_SHELL__\n/bin/zsh\n"
        data = env_probe.parse_probe_output(output)
        assert data["os_pretty_name"] == ""
        assert data["kernel"] == "5.15.0-generic"
        assert data["shell"] == "/bin/zsh"

    def test_empty_output(self):
        assert env_probe.parse_probe_output("") == {
            "os_pretty_name": "",
            "kernel": "",
            "shell": "",
        }


# ============================================================================
# 本地探测
# ============================================================================

class TestProbeLocal:
    def test_returns_all_fields(self):
        data = env_probe.probe_local()
        assert "os_pretty_name" in data
        assert "kernel" in data
        assert "shell" in data
        # Windows 上 os_pretty_name 至少有 platform.platform() 兜底
        assert data["os_pretty_name"] != ""


# ============================================================================
# SSH 分支（mock RustBridge）
# ============================================================================

_PROBE_OUTPUT = (
    'PRETTY_NAME="Ubuntu 22.04.4 LTS"\n'
    "__TDSF_KERNEL__\n"
    "5.15.0-100-generic\n"
    "__TDSF_SHELL__\n"
    "/bin/bash\n"
)


def _mock_main_bridge(send_result, injected=True):
    """构造 main 模块 mock：_rust_bridge.send_request → send_result"""
    fake_bridge = mock.MagicMock()
    if injected:
        fake_bridge.send_request.return_value = send_result
    fake_main = mock.MagicMock()
    if injected:
        fake_main._rust_bridge = fake_bridge
    else:
        fake_main._rust_bridge = None
    return fake_main, fake_bridge


class TestProbeRemote:
    def test_success_via_rust_bridge(self):
        fake_main, fake_bridge = _mock_main_bridge(
            {"ok": True, "output": _PROBE_OUTPUT, "exit_code": 0, "duration": 0.1}
        )
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            data = env_probe.probe_remote(15)
        assert data == {
            "os_pretty_name": "Ubuntu 22.04.4 LTS",
            "kernel": "5.15.0-100-generic",
            "shell": "/bin/bash",
        }
        # 合并命令一次往返：单次 send_request + sessionId/timeout 参数
        fake_bridge.send_request.assert_called_once()
        args = fake_bridge.send_request.call_args
        assert args[0][0] == "ssh_command"
        params = args[0][1]
        assert params["sessionId"] == 15
        assert params["timeout"] == env_probe._PROBE_TIMEOUT_S
        assert "os-release" in params["command"] and "uname -r" in params["command"]

    def test_failure_returns_none(self):
        fake_main, _ = _mock_main_bridge(
            {"ok": False, "output": "", "exit_code": -1}
        )
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            assert env_probe.probe_remote(15) is None

    def test_bridge_not_injected_returns_none(self):
        fake_main, _ = _mock_main_bridge(None, injected=False)
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            assert env_probe.probe_remote(15) is None

    def test_exception_returns_none(self):
        with mock.patch.dict(
            "sys.modules",
            {"main": mock.MagicMock(side_effect=RuntimeError("boom"))},
        ):
            # import main 抛异常也要降级 None，不向上抛
            assert env_probe.probe_remote(15) is None


# ============================================================================
# 入口 + 会话级缓存
# ============================================================================

class TestProbeEnv:
    def test_local_mode_no_ssh(self):
        result = env_probe.probe_env(session_id="s1", ssh_session_id=None)
        assert result["ok"] is True
        assert result["source"] == "local"
        assert "os_pretty_name" in result

    def test_ssh_mode_and_cache_hit(self):
        fake_main, fake_bridge = _mock_main_bridge(
            {"ok": True, "output": _PROBE_OUTPUT, "exit_code": 0}
        )
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            first = env_probe.probe_env(session_id="s1", ssh_session_id=15)
            assert first["source"] == "ssh"
            assert first["ok"] is True
            # 第二次命中缓存：send_request 不再被调用
            second = env_probe.probe_env(session_id="s1", ssh_session_id=15)
            assert second["source"] == "cache"
            assert second["os_pretty_name"] == "Ubuntu 22.04.4 LTS"
        assert fake_bridge.send_request.call_count == 1

    def test_different_ssh_sessions_isolated(self):
        fake_main, fake_bridge = _mock_main_bridge(
            {"ok": True, "output": _PROBE_OUTPUT, "exit_code": 0}
        )
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            env_probe.probe_env(ssh_session_id=15)
            env_probe.probe_env(ssh_session_id=16)
        assert fake_bridge.send_request.call_count == 2

    def test_ttl_expiry(self):
        fake_main, fake_bridge = _mock_main_bridge(
            {"ok": True, "output": _PROBE_OUTPUT, "exit_code": 0}
        )
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            env_probe.probe_env(ssh_session_id=15)
            # 手动把缓存时间戳拨到 TTL 之前
            key = "ssh:15"
            entry = dict(env_probe._CACHE[key])
            entry["_ts"] = int(time.time() * 1000) - env_probe._CACHE_TTL_MS - 1
            env_probe._CACHE[key] = entry
            env_probe.probe_env(ssh_session_id=15)
        assert fake_bridge.send_request.call_count == 2

    def test_remote_failure_returns_ok_false(self):
        fake_main, _ = _mock_main_bridge({"ok": False, "output": "", "exit_code": -1})
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            result = env_probe.probe_env(ssh_session_id=15)
        assert result["ok"] is False
        assert result["os_pretty_name"] == ""
        # 失败结果不进缓存（下次重试）
        assert "ssh:15" not in env_probe._CACHE


# ============================================================================
# JSON-RPC 注册
# ============================================================================

class TestRegisterMethods:
    def test_registers_system_probe_env(self):
        dispatcher = mock.MagicMock()
        env_probe.register_methods(dispatcher)
        dispatcher.register.assert_called_once()
        name, handler = dispatcher.register.call_args[0]
        assert name == "system.probe_env"
        # **kwargs 解包签名兼容（MethodDispatcher dict params 语义）
        result = handler(session_id="s1", ssh_session_id=None)
        assert result["ok"] is True
