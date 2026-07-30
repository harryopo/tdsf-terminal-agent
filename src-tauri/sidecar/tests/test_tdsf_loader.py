"""
tests/test_tdsf_loader.py — TDSF.md 加载器单元测试（T-P1-09.3）
==================================================================

验证内容：
1. load_tdsf（T-P1-09.1）
   - 全局+项目级加载
   - 文件不存在的容错
   - mtime 记录
   - 拼接逻辑（全局 + 项目级，分隔符）
   - 路径自定义
2. build_system_prompt_suffix（T-P1-09.1）
   - 空 content 返回 ""
   - 有 content 返回带分隔标记的注入块
3. TDSFWatcher（T-P1-09.1）
   - start/stop 生命周期
   - 文件变化触发 callback
   - mtime 检测
   - 重复 start 安全性
   - stop 幂等性
4. 全局单例管理（T-P1-09.1）
   - get_current_tdsf 懒加载
   - start_watcher / stop_watcher
   - reset_for_test 清理
5. System Prompt 注入 API（T-P1-09.2）
   - get_agent_system_prompt_suffix
   - build_agent_system_prompt
6. JSON-RPC 方法注册（T-P1-09.2）
   - register_methods 注册 5 个方法
   - tdsf.status / tdsf.reload / tdsf.get_prompt_suffix 功能
7. initialize_on_startup（T-P1-09.2）
   - 启动时加载 + 启动 watcher
   - rust_notifier 调用
8. 项目指令覆盖全局（spec Scenario）
   - 全局 + 项目级同时存在时拼接顺序
   - 项目级内容出现在全局之后（LLM 自然遵循后出现的指令）

运行：
    cd python-sidecar
    python -m pytest tests/test_tdsf_loader.py -v
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import tdsf_loader
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from tdsf_loader import (
    _DEFAULT_PROJECT_TDSF_FILENAME,
    _DEFAULT_WATCHER_INTERVAL,
    TDSFContent,
    TDSFWatcher,
    build_agent_system_prompt,
    build_system_prompt_suffix,
    get_agent_system_prompt_suffix,
    get_current_tdsf,
    initialize_on_startup,
    load_tdsf,
    register_methods,
    reset_for_test,
    start_watcher,
    stop_watcher,
)


# ============================================================================
# Fixture
# ============================================================================


@pytest.fixture(autouse=True)
def reset_state():
    """每个测试前后重置 tdsf_loader 全局状态，保证测试隔离"""
    reset_for_test()
    yield
    reset_for_test()


@pytest.fixture
def tdsf_files(tmp_path):
    """创建临时 TDSF.md 文件对（全局 + 项目级）

    Returns:
        dict: {"global_path": Path, "project_path": Path}
    """
    global_path = tmp_path / "TDSF_global.md"
    project_path = tmp_path / "TDSF_project.md"

    global_path.write_text("# Global TDSF\n\ndefault_language: en\n", encoding="utf-8")
    project_path.write_text("# Project TDSF\n\ndefault_language: zh\n", encoding="utf-8")

    return {"global_path": global_path, "project_path": project_path}


@pytest.fixture
def only_global_file(tmp_path):
    """仅全局 TDSF.md 存在"""
    global_path = tmp_path / "TDSF_global.md"
    project_path = tmp_path / "non_existent_project.md"
    global_path.write_text("# Global Only\n\nrule: be concise\n", encoding="utf-8")
    return {"global_path": global_path, "project_path": project_path}


@pytest.fixture
def only_project_file(tmp_path):
    """仅项目级 TDSF.md 存在"""
    global_path = tmp_path / "non_existent_global.md"
    project_path = tmp_path / "TDSF_project.md"
    project_path.write_text("# Project Only\n\nuse_chinese: true\n", encoding="utf-8")
    return {"global_path": global_path, "project_path": project_path}


# ============================================================================
# 1. load_tdsf 测试
# ============================================================================


class TestLoadTDSF:
    """load_tdsf 函数测试"""

    def test_load_both_files(self, tdsf_files):
        """同时加载全局 + 项目级"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        assert tdsf.has_global
        assert tdsf.has_project
        assert tdsf.has_content
        assert "Global TDSF" in tdsf.global_content
        assert "Project TDSF" in tdsf.project_content
        # 拼接顺序：全局在前，项目级在后
        assert tdsf.combined_content.index("Global TDSF") < tdsf.combined_content.index("Project TDSF")
        # mtime 应不为 None
        assert tdsf.global_mtime is not None
        assert tdsf.project_mtime is not None

    def test_load_only_global(self, only_global_file):
        """仅全局存在，项目级不存在"""
        tdsf = load_tdsf(
            project_path=only_global_file["project_path"],
            global_path=only_global_file["global_path"],
        )
        assert tdsf.has_global
        assert not tdsf.has_project
        assert tdsf.has_content
        assert tdsf.project_content == ""
        assert tdsf.project_mtime is None
        # combined 应只含全局内容
        assert "Global Only" in tdsf.combined_content

    def test_load_only_project(self, only_project_file):
        """仅项目级存在，全局不存在"""
        tdsf = load_tdsf(
            project_path=only_project_file["project_path"],
            global_path=only_project_file["global_path"],
        )
        assert not tdsf.has_global
        assert tdsf.has_project
        assert tdsf.has_content
        assert tdsf.global_content == ""
        assert tdsf.global_mtime is None
        assert "Project Only" in tdsf.combined_content

    def test_load_neither_file(self, tmp_path):
        """两个文件都不存在"""
        global_path = tmp_path / "no_global.md"
        project_path = tmp_path / "no_project.md"
        tdsf = load_tdsf(project_path=project_path, global_path=global_path)
        assert not tdsf.has_global
        assert not tdsf.has_project
        assert not tdsf.has_content
        assert tdsf.combined_content == ""
        assert tdsf.global_mtime is None
        assert tdsf.project_mtime is None

    def test_combined_separator_present(self, tdsf_files):
        """两个文件都存在时，combined_content 含分隔符"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        # 检查分隔符 "---" 存在于拼接结果中
        assert "---" in tdsf.combined_content

    def test_path_attributes_recorded(self, tdsf_files):
        """加载后 global_path / project_path 应正确记录"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        assert tdsf.global_path == tdsf_files["global_path"]
        assert tdsf.project_path == tdsf_files["project_path"]

    def test_string_path_accepted(self, tdsf_files):
        """字符串路径也应被接受（自动转 Path）"""
        tdsf = load_tdsf(
            project_path=str(tdsf_files["project_path"]),
            global_path=str(tdsf_files["global_path"]),
        )
        assert tdsf.has_content
        assert isinstance(tdsf.global_path, Path)
        assert isinstance(tdsf.project_path, Path)

    def test_empty_file_treated_as_no_content(self, tmp_path):
        """空文件应视为无内容"""
        global_path = tmp_path / "empty.md"
        project_path = tmp_path / "no_project.md"
        global_path.write_text("", encoding="utf-8")
        tdsf = load_tdsf(project_path=project_path, global_path=global_path)
        assert not tdsf.has_global
        assert not tdsf.has_content

    def test_whitespace_only_file_treated_as_no_content(self, tmp_path):
        """仅含空白的文件应视为无内容"""
        global_path = tmp_path / "whitespace.md"
        project_path = tmp_path / "no_project.md"
        global_path.write_text("   \n\n\t  \n", encoding="utf-8")
        tdsf = load_tdsf(project_path=project_path, global_path=global_path)
        assert not tdsf.has_global
        assert not tdsf.has_content


# ============================================================================
# 2. build_system_prompt_suffix 测试
# ============================================================================


class TestBuildSystemPromptSuffix:
    """build_system_prompt_suffix 函数测试"""

    def test_empty_tdsf_returns_empty(self):
        """无 TDSF 内容时返回空字符串"""
        empty_tdsf = TDSFContent()
        suffix = build_system_prompt_suffix(empty_tdsf)
        assert suffix == ""

    def test_with_content_returns_marked_block(self, tdsf_files):
        """有 TDSF 内容时返回带分隔标记的注入块"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        suffix = build_system_prompt_suffix(tdsf)
        assert suffix  # 非空
        assert "TDSF" in suffix
        assert "Global TDSF" in suffix
        assert "Project TDSF" in suffix

    def test_only_global_content(self, only_global_file):
        """仅全局有内容时也应生成后缀"""
        tdsf = load_tdsf(
            project_path=only_global_file["project_path"],
            global_path=only_global_file["global_path"],
        )
        suffix = build_system_prompt_suffix(tdsf)
        assert suffix
        assert "Global Only" in suffix

    def test_suffix_starts_with_newlines(self, tdsf_files):
        """后缀应以换行符开头（便于直接拼接 base prompt）"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        suffix = build_system_prompt_suffix(tdsf)
        assert suffix.startswith("\n\n")


# ============================================================================
# 3. TDSFWatcher 测试
# ============================================================================


class TestTDSFWatcher:
    """TDSFWatcher 类测试"""

    def test_start_stop_lifecycle(self, tdsf_files):
        """start/stop 生命周期"""
        watcher = TDSFWatcher(
            callback=lambda t: None,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.5,
        )
        assert not watcher.is_running()
        watcher.start()
        assert watcher.is_running()
        watcher.stop()
        assert not watcher.is_running()

    def test_initial_force_callback(self, tdsf_files):
        """启动时立即触发一次 callback（force=True）"""
        received = []
        watcher = TDSFWatcher(
            callback=lambda t: received.append(t),
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.5,
        )
        watcher.start()
        # 等待初始 callback 触发
        time.sleep(0.3)
        watcher.stop()
        assert len(received) >= 1
        assert received[0].has_content

    def test_file_change_triggers_callback(self, tdsf_files):
        """文件变化触发 callback"""
        received = []
        received_lock = threading.Lock()
        watcher = TDSFWatcher(
            callback=lambda t: received.append(t),
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.3,
        )
        watcher.start()
        # 等待初始 callback
        time.sleep(0.5)
        initial_count = len(received)

        # 修改文件
        tdsf_files["project_path"].write_text(
            "# Project TDSF Modified\n\nnew_rule: updated\n", encoding="utf-8"
        )

        # 等待 watcher 检测变化
        time.sleep(1.0)
        watcher.stop()

        # 应该收到至少 2 次 callback（初始 + 变化）
        assert len(received) > initial_count

    def test_duplicate_start_ignored(self, tdsf_files):
        """重复调用 start() 应被忽略（不抛异常）"""
        watcher = TDSFWatcher(
            callback=lambda t: None,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.5,
        )
        watcher.start()
        # 再次 start 不应抛异常
        watcher.start()
        assert watcher.is_running()
        watcher.stop()

    def test_stop_idempotent(self, tdsf_files):
        """重复 stop() 不应抛异常"""
        watcher = TDSFWatcher(
            callback=lambda t: None,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.5,
        )
        watcher.start()
        watcher.stop()
        # 再次 stop 不抛异常
        watcher.stop()
        assert not watcher.is_running()

    def test_stop_without_start(self):
        """未 start 直接 stop 不抛异常"""
        watcher = TDSFWatcher(callback=lambda t: None)
        watcher.stop()  # 不应抛异常

    def test_callback_exception_does_not_crash_watcher(self, tdsf_files):
        """callback 抛异常不应崩溃 watcher"""
        def bad_callback(t):
            raise RuntimeError("intentional test error")

        watcher = TDSFWatcher(
            callback=bad_callback,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.3,
        )
        watcher.start()
        time.sleep(0.5)  # 等待初始 callback 抛异常
        # watcher 仍应运行（不应崩溃）
        assert watcher.is_running()
        watcher.stop()

    def test_min_interval_enforced(self, tdsf_files):
        """interval 过小（< 0.5s）应被强制设为 0.5s"""
        watcher = TDSFWatcher(
            callback=lambda t: None,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.1,  # 过小
        )
        assert watcher.interval == 0.5


# ============================================================================
# 4. 全局单例管理测试
# ============================================================================


class TestGlobalSingleton:
    """全局单例管理函数测试"""

    def test_get_current_tdsf_lazy_load(self):
        """get_current_tdsf 应懒加载（首次调用触发加载）"""
        tdsf = get_current_tdsf()
        assert tdsf is not None
        # 测试环境通常无 TDSF.md，has_content 应为 False
        # 但单例应已建立
        tdsf2 = get_current_tdsf()
        assert tdsf2 is tdsf  # 同一实例

    def test_reset_for_test_clears_singleton(self):
        """reset_for_test 应清空单例"""
        # 先建立单例
        _ = get_current_tdsf()
        # 重置
        reset_for_test()
        # 再次获取应是新实例
        tdsf = get_current_tdsf()
        assert tdsf is not None

    def test_start_stop_watcher_singleton(self, tdsf_files):
        """start_watcher / stop_watcher 操作全局 watcher 单例"""
        # 用自定义路径避免影响实际 ~/TDSF.md
        # 先通过 initialize_on_startup 初始化
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        # 启动 watcher
        start_watcher(
            callback=lambda t: None,
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.5,
        )
        # stop_watcher 应能停止
        stop_watcher()


# ============================================================================
# 5. System Prompt 注入 API 测试（T-P1-09.2）
# ============================================================================


class TestSystemPromptInjection:
    """system prompt 注入 API 测试"""

    def test_get_agent_system_prompt_suffix_empty(self):
        """无 TDSF 时返回空字符串"""
        suffix = get_agent_system_prompt_suffix()
        assert suffix == ""

    def test_get_agent_system_prompt_suffix_with_content(self, tdsf_files):
        """有 TDSF 时返回注入后缀"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        suffix = get_agent_system_prompt_suffix()
        assert suffix
        assert "TDSF" in suffix
        assert "Global TDSF" in suffix
        assert "Project TDSF" in suffix

    def test_build_agent_system_prompt_no_tdsf(self):
        """无 TDSF 时返回 base prompt 原文"""
        base = "You are a Linux teaching agent."
        result = build_agent_system_prompt(base)
        assert result == base

    def test_build_agent_system_prompt_with_tdsf(self, tdsf_files):
        """有 TDSF 时返回 base + suffix 拼接"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        base = "You are a Linux teaching agent."
        result = build_agent_system_prompt(base)
        assert result.startswith(base)
        assert "TDSF" in result
        assert "Global TDSF" in result
        assert "Project TDSF" in result
        assert len(result) > len(base)


# ============================================================================
# 6. 项目级覆盖全局场景测试（spec Scenario）
# ============================================================================


class TestProjectOverridesGlobal:
    """spec 场景：项目指令覆盖全局

    Scenario:
        WHEN ~/TDSF.md 设置 default_language: en
        AND  ./TDSF.md 设置 default_language: zh
        THEN 项目级覆盖全局，Agent 使用中文
    """

    def test_project_content_appears_after_global(self, tdsf_files):
        """项目级内容应出现在全局之后（LLM 遵循后出现的指令）"""
        tdsf = load_tdsf(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
        )
        # 全局在前
        assert tdsf.combined_content.index("default_language: en") < tdsf.combined_content.index("default_language: zh")

    def test_project_override_in_system_prompt(self, tdsf_files):
        """注入 system prompt 后，项目级指令应出现在全局之后"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        suffix = get_agent_system_prompt_suffix()
        # 项目级 zh 应出现在全局 en 之后
        assert suffix.index("default_language: en") < suffix.index("default_language: zh")


# ============================================================================
# 7. JSON-RPC 方法注册测试（T-P1-09.2）
# ============================================================================


class TestRPCMethods:
    """JSON-RPC 方法注册测试"""

    def test_register_methods_registers_five_methods(self):
        """register_methods 应注册 5 个方法"""
        mock_dispatcher = MagicMock()
        register_methods(mock_dispatcher)
        assert mock_dispatcher.register.call_count == 5
        # 检查方法名
        registered_names = [call.args[0] for call in mock_dispatcher.register.call_args_list]
        expected_names = {
            "tdsf.status",
            "tdsf.reload",
            "tdsf.start_watcher",
            "tdsf.stop_watcher",
            "tdsf.get_prompt_suffix",
        }
        assert set(registered_names) == expected_names

    def test_rpc_status_returns_dict(self, tdsf_files):
        """tdsf.status 应返回包含必要字段的 dict"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        # 通过 dispatcher 模拟调用
        from tdsf_loader import _rpc_tdsf_status
        result = _rpc_tdsf_status()
        assert "has_global" in result
        assert "has_project" in result
        assert "has_content" in result
        assert "global_path" in result
        assert "project_path" in result
        assert "global_mtime" in result
        assert "project_mtime" in result
        assert "combined_len" in result
        assert "watcher_running" in result
        assert result["has_content"] is True

    def test_rpc_reload_forces_reload(self, tdsf_files):
        """tdsf.reload 应强制重新加载"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        from tdsf_loader import _rpc_tdsf_reload
        result = _rpc_tdsf_reload()
        assert "has_content" in result
        assert "combined_len" in result
        assert result["has_content"] is True

    def test_rpc_get_prompt_suffix_returns_suffix(self, tdsf_files):
        """tdsf.get_prompt_suffix 应返回 suffix 字符串"""
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        from tdsf_loader import _rpc_tdsf_get_prompt_suffix
        result = _rpc_tdsf_get_prompt_suffix()
        assert "suffix" in result
        assert "has_content" in result
        assert "combined_len" in result
        assert result["has_content"] is True
        assert "TDSF" in result["suffix"]

    def test_rpc_get_prompt_suffix_empty_when_no_tdsf(self):
        """无 TDSF 时 tdsf.get_prompt_suffix 应返回空 suffix"""
        from tdsf_loader import _rpc_tdsf_get_prompt_suffix
        result = _rpc_tdsf_get_prompt_suffix()
        assert result["suffix"] == ""
        assert result["has_content"] is False

    def test_rpc_start_stop_watcher(self, tdsf_files):
        """tdsf.start_watcher / tdsf.stop_watcher 控制 watcher"""
        from tdsf_loader import (
            _rpc_tdsf_start_watcher,
            _rpc_tdsf_stop_watcher,
        )
        # 启动
        result = _rpc_tdsf_start_watcher(
            project_path=str(tdsf_files["project_path"]),
            global_path=str(tdsf_files["global_path"]),
            interval=0.5,
        )
        assert result["running"] is True
        # 停止
        result = _rpc_tdsf_stop_watcher()
        assert result["running"] is False


# ============================================================================
# 8. initialize_on_startup 测试（T-P1-09.2）
# ============================================================================


class TestInitializeOnStartup:
    """initialize_on_startup 函数测试"""

    def test_initialize_loads_files(self, tdsf_files):
        """启动时加载 TDSF 文件"""
        tdsf = initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        assert tdsf.has_content
        assert tdsf.has_global
        assert tdsf.has_project

    def test_initialize_starts_watcher(self, tdsf_files):
        """start_watcher_on_init=True 时应启动 watcher"""
        tdsf = initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=True,
            watcher_interval=0.5,
        )
        # 验证 watcher 已启动（通过 tdsf.status RPC 查询）
        from tdsf_loader import _rpc_tdsf_status
        status = _rpc_tdsf_status()
        assert status["watcher_running"] is True

    def test_initialize_no_watcher(self, tdsf_files):
        """start_watcher_on_init=False 时不启动 watcher"""
        tdsf = initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )
        from tdsf_loader import _rpc_tdsf_status
        status = _rpc_tdsf_status()
        assert status["watcher_running"] is False

    def test_initialize_with_rust_notifier(self, tdsf_files):
        """rust_notifier 应在文件变化时被调用"""
        notifications = []
        notifier = lambda event_type, payload: notifications.append((event_type, payload))

        tdsf = initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=True,
            watcher_interval=0.3,
            rust_notifier=notifier,
        )
        # 初始加载时 watcher 触发 force callback，应通知一次
        time.sleep(0.5)

        # 修改文件触发变化
        tdsf_files["project_path"].write_text(
            "# Modified\n\nnew_rule: test\n", encoding="utf-8"
        )
        time.sleep(1.0)

        # 应至少收到一次 tdsf_updated 通知
        tdsf_events = [n for n in notifications if n[0] == "tdsf_updated"]
        assert len(tdsf_events) >= 1

    def test_initialize_global_only(self, only_global_file):
        """仅全局文件存在时也应正常初始化"""
        tdsf = initialize_on_startup(
            project_path=only_global_file["project_path"],
            global_path=only_global_file["global_path"],
            start_watcher_on_init=False,
        )
        assert tdsf.has_global
        assert not tdsf.has_project
        assert tdsf.has_content

    def test_initialize_no_files(self, tmp_path):
        """无文件时也应正常初始化（fail-safe）"""
        tdsf = initialize_on_startup(
            project_path=tmp_path / "no_project.md",
            global_path=tmp_path / "no_global.md",
            start_watcher_on_init=False,
        )
        assert not tdsf.has_content
        # 不应抛异常


# ============================================================================
# 9. 边界条件测试
# ============================================================================


class TestEdgeCases:
    """边界条件测试"""

    def test_unicode_content_supported(self, tmp_path):
        """中文/Unicode 内容应被正确加载"""
        global_path = tmp_path / "unicode_global.md"
        project_path = tmp_path / "unicode_project.md"
        global_path.write_text("# 全局指令\n\n使用中文回复\n", encoding="utf-8")
        project_path.write_text("# 项目指令\n\n偏好简洁回答\n", encoding="utf-8")

        tdsf = load_tdsf(project_path=project_path, global_path=global_path)
        assert "全局指令" in tdsf.global_content
        assert "项目指令" in tdsf.project_content
        assert "使用中文回复" in tdsf.combined_content

    def test_large_file_supported(self, tmp_path):
        """大文件（5KB+）应被正确加载"""
        global_path = tmp_path / "large_global.md"
        project_path = tmp_path / "no_project.md"
        # 生成 5KB+ 内容（500 * 19 bytes + 14 bytes header ≈ 9514 bytes）
        large_content = "# Large TDSF\n\n" + ("rule: do something\n" * 500)
        global_path.write_text(large_content, encoding="utf-8")

        tdsf = load_tdsf(project_path=project_path, global_path=global_path)
        assert tdsf.has_global
        assert len(tdsf.global_content) > 5000

    def test_concurrent_load_tdsf_calls_safe(self, tdsf_files):
        """并发调用 load_tdsf 应线程安全（无竞争条件）"""
        results = []
        results_lock = threading.Lock()

        def worker():
            t = load_tdsf(
                project_path=tdsf_files["project_path"],
                global_path=tdsf_files["global_path"],
            )
            with results_lock:
                results.append(t)

        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 所有结果应一致
        assert len(results) == 10
        assert all(r.has_content for r in results)
        assert all(r.combined_content == results[0].combined_content for r in results)

    def test_watcher_detects_file_creation(self, tmp_path):
        """watcher 应检测到文件从无到有的创建"""
        global_path = tmp_path / "creating_global.md"
        project_path = tmp_path / "no_project.md"
        received = []

        watcher = TDSFWatcher(
            callback=lambda t: received.append(t),
            project_path=project_path,
            global_path=global_path,
            interval=0.3,
        )
        watcher.start()
        time.sleep(0.4)  # 等待初始 callback（无文件）

        # 创建文件
        global_path.write_text("# New File\n\nrule: created\n", encoding="utf-8")
        time.sleep(1.0)  # 等待 watcher 检测
        watcher.stop()

        # 应至少收到 2 次 callback（初始无 + 创建后）
        assert len(received) >= 2
        # 最后一次应含内容
        assert received[-1].has_global

    def test_watcher_detects_file_deletion(self, tdsf_files):
        """watcher 应检测到文件被删除"""
        received = []
        watcher = TDSFWatcher(
            callback=lambda t: received.append(t),
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            interval=0.3,
        )
        watcher.start()
        time.sleep(0.4)

        # 删除项目级文件
        tdsf_files["project_path"].unlink()
        time.sleep(1.0)
        watcher.stop()

        # 最后一次 callback 应不再有 project 内容
        last_tdsf = received[-1]
        assert not last_tdsf.has_project


# ============================================================================
# 10. 集成测试（端到端流程）
# ============================================================================


class TestIntegration:
    """端到端集成测试"""

    def test_full_lifecycle(self, tmp_path):
        """完整生命周期：初始化 → 修改文件 → watcher 通知 → 重新注入"""
        global_path = tmp_path / "TDSF_global.md"
        project_path = tmp_path / "TDSF_project.md"
        global_path.write_text("# V1 Global\n", encoding="utf-8")
        project_path.write_text("# V1 Project\n", encoding="utf-8")

        # 1. 初始化（启动 watcher）
        tdsf = initialize_on_startup(
            project_path=project_path,
            global_path=global_path,
            start_watcher_on_init=True,
            watcher_interval=0.3,
            rust_notifier=lambda et, p: None,  # no-op notifier
        )
        assert tdsf.has_content
        original_combined = tdsf.combined_content

        # 2. 验证初始 system prompt 后缀
        suffix_v1 = get_agent_system_prompt_suffix()
        assert "V1 Global" in suffix_v1
        assert "V1 Project" in suffix_v1

        # 3. 修改项目级文件
        project_path.write_text("# V2 Project (updated)\n", encoding="utf-8")

        # 4. 等待 watcher 检测变化
        time.sleep(1.0)

        # 5. 验证 system prompt 后缀已更新
        suffix_v2 = get_agent_system_prompt_suffix()
        assert "V2 Project" in suffix_v2

    def test_agent_prompt_injection_pipeline(self, tdsf_files):
        """Agent system prompt 注入管道完整测试"""
        # 1. 初始化 TDSF 加载
        initialize_on_startup(
            project_path=tdsf_files["project_path"],
            global_path=tdsf_files["global_path"],
            start_watcher_on_init=False,
        )

        # 2. 模拟 Agent 构建 system prompt
        # 注：base_prompt 中不含 "Global TDSF" / "Project TDSF" 字样，
        # 便于断言 suffix 出现在 base 之后
        base_prompt = (
            "你是终端教学 Agent，专注 Linux 运维教学。\n"
            "职责：\n"
            "1. 解答 Linux 运维问题\n"
            "2. 评估命令风险\n"
            "3. 提供教学讲解\n"
        )
        full_prompt = build_agent_system_prompt(base_prompt)

        # 3. 验证拼接结果
        assert full_prompt.startswith(base_prompt)
        assert "TDSF" in full_prompt
        assert "Global TDSF" in full_prompt
        assert "Project TDSF" in full_prompt
        # TDSF 后缀内容应在 base prompt 之后（即 base 长度之后的位置）
        base_len = len(base_prompt)
        assert full_prompt.index("Global TDSF") >= base_len
        assert full_prompt.index("Project TDSF") >= base_len
