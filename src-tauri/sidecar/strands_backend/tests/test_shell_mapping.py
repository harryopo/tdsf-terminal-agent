"""
test_shell_mapping.py — A2 工具→Shell 命令映射单元测试
========================================================

覆盖：
- 每个 to_shell_command 函数的正常参数映射
- 边界参数（空字符串、特殊字符、超长输入）
- 映射失败返回 None（fail-closed）
- shell_mapping.resolve_shell_command 统一入口
"""
from __future__ import annotations

import pytest


# ============================================================================
# network_diagnostic.to_shell_command
# ============================================================================

class TestNetworkDiagnosticShellCommand:
    """network_diagnose 工具→命令映射测试"""

    def test_ping_basic(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ping", "target": "8.8.8.8", "count": 4})
        assert result == "ping -c 4 -W 2 '8.8.8.8'"

    def test_ping_default_count(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ping", "target": "google.com"})
        assert result is not None
        assert "ping -c 4" in result
        assert "'google.com'" in result

    def test_ping_count_clamped(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ping", "target": "x.com", "count": 100})
        assert result is not None
        assert "ping -c 20" in result  # max 20

    def test_ss_mode(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ss"})
        assert result == "ss -tulnp"

    def test_ss_with_port(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ss", "port": 80})
        assert result is not None
        assert "ss -tulnp" in result
        assert "| grep ':80" in result

    def test_netstat_mode(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "netstat", "port": 443})
        assert result is not None
        assert "netstat -tulnp" in result
        assert ":443" in result

    def test_ip_mode(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ip"})
        assert result is not None
        assert "ip addr" in result
        assert "ip route" in result

    def test_dns_mode(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "dns", "target": "example.com"})
        assert result is not None
        assert "nslookup" in result
        assert "'example.com'" in result

    def test_invalid_mode_returns_none(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "invalid_mode"})
        assert result is None

    def test_ping_missing_target_returns_none(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ping"})
        assert result is None

    def test_dns_missing_target_returns_none(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "dns"})
        assert result is None

    def test_shell_injection_target(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({"mode": "ping", "target": "'; rm -rf / ; '"})
        assert result is not None
        # 应该被转义，不包含原始危险字符
        assert "'; rm -rf / ; '" not in result or "'\"'\"'" in result

    def test_empty_params(self):
        from strands_backend.tools.network_diagnostic import to_shell_command
        result = to_shell_command({})
        # 默认 mode=ping 但 target 为空 → fail-closed
        assert result is None


# ============================================================================
# process_inspector.to_shell_command
# ============================================================================

class TestProcessInspectorShellCommand:
    """inspect_processes 工具→命令映射测试"""

    def test_list_mode_basic(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "list"})
        assert result == "ps aux"

    def test_list_with_user_filter(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "list", "filter_user": "root"})
        assert result is not None
        assert "ps aux" in result
        assert "-u 'root'" in result

    def test_list_with_name_filter(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "list", "filter_name": "nginx"})
        assert result is not None
        assert "ps aux" in result
        assert "grep 'nginx'" in result
        assert "grep -v grep" in result

    def test_top_mode(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "top", "top_n": 10})
        assert result is not None
        assert "ps aux --sort=-%cpu" in result
        assert "head -n 11" in result  # top_n + 1 for header

    def test_detail_mode_with_pid(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "detail", "pid": 1234})
        assert result is not None
        assert "ps -p 1234" in result

    def test_detail_mode_with_name(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "detail", "filter_name": "sshd"})
        assert result is not None
        assert "grep 'sshd'" in result

    def test_detail_mode_missing_both_returns_none(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "detail"})
        assert result is None

    def test_invalid_mode_returns_none(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "bogus"})
        assert result is None

    def test_shell_injection_filter(self):
        from strands_backend.tools.process_inspector import to_shell_command
        result = to_shell_command({"mode": "list", "filter_name": "'; cat /etc/passwd"})
        assert result is not None
        # 应该被转义
        assert "'\"'\"'" in result or "'; cat" not in result


# ============================================================================
# log_analyzer.to_shell_command
# ============================================================================

class TestLogAnalyzerShellCommand:
    """analyze_logs 工具→命令映射测试"""

    def test_tail_mode(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"log_path": "/var/log/syslog", "mode": "tail", "lines": 50})
        assert result is not None
        assert "tail -n 50" in result
        assert "'/var/log/syslog'" in result

    def test_grep_mode(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({
            "log_path": "/var/log/auth.log",
            "mode": "grep",
            "pattern": "Failed",
            "lines": 100,
        })
        assert result is not None
        assert "grep -Fn" in result
        assert "'Failed'" in result

    def test_regex_mode(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({
            "log_path": "/var/log/kern.log",
            "mode": "regex",
            "pattern": "error|warn",
        })
        assert result is not None
        assert "grep -En" in result

    def test_missing_log_path_returns_none(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"mode": "tail"})
        assert result is None

    def test_empty_log_path_returns_none(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"log_path": "", "mode": "tail"})
        assert result is None

    def test_grep_missing_pattern_returns_none(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"log_path": "/var/log/syslog", "mode": "grep"})
        assert result is None

    def test_invalid_mode_returns_none(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"log_path": "/var/log/x", "mode": "bogus"})
        assert result is None

    def test_lines_clamped(self):
        from strands_backend.tools.log_analyzer import to_shell_command
        result = to_shell_command({"log_path": "/var/log/x", "mode": "tail", "lines": 99999})
        assert result is not None
        assert "tail -n 2000" in result  # max 2000


# ============================================================================
# remote_file.to_shell_command
# ============================================================================

class TestRemoteFileShellCommand:
    """read_remote_file 工具→命令映射测试"""

    def test_basic_path(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({"path": "/etc/nginx/nginx.conf"})
        assert result == "cat '/etc/nginx/nginx.conf'"

    def test_missing_path_returns_none(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({})
        assert result is None

    def test_empty_path_returns_none(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({"path": ""})
        assert result is None

    def test_whitespace_path_returns_none(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({"path": "   "})
        assert result is None

    def test_path_with_spaces(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({"path": "/etc/my config/file.conf"})
        assert result is not None
        assert "'/etc/my config/file.conf'" in result

    def test_path_with_special_chars(self):
        from strands_backend.tools.remote_file import to_shell_command
        result = to_shell_command({"path": "/tmp/file'with'quotes.txt"})
        assert result is not None
        # 单引号应该被转义
        assert "'\"'\"'" in result


# ============================================================================
# config_diff.to_shell_command
# ============================================================================

class TestConfigDiffShellCommand:
    """config_diff 工具→命令映射测试"""

    def test_basic_diff(self):
        from strands_backend.tools.config_diff import to_shell_command
        result = to_shell_command({"file_a": "/etc/nginx/nginx.conf", "file_b": "/etc/nginx/nginx.conf.bak"})
        assert result is not None
        assert "diff -u" in result
        assert "/etc/nginx/nginx.conf" in result
        assert "/etc/nginx/nginx.conf.bak" in result

    def test_missing_file_a_returns_none(self):
        from strands_backend.tools.config_diff import to_shell_command
        result = to_shell_command({"file_b": "/etc/x"})
        assert result is None

    def test_missing_file_b_returns_none(self):
        from strands_backend.tools.config_diff import to_shell_command
        result = to_shell_command({"file_a": "/etc/x"})
        assert result is None

    def test_both_empty_returns_none(self):
        from strands_backend.tools.config_diff import to_shell_command
        result = to_shell_command({"file_a": "", "file_b": ""})
        assert result is None

    def test_paths_with_spaces(self):
        from strands_backend.tools.config_diff import to_shell_command
        result = to_shell_command({"file_a": "/etc/my file", "file_b": "/etc/other file"})
        assert result is not None
        # shlex.quote 应该加引号
        assert "'/etc/my file'" in result
        assert "'/etc/other file'" in result


# ============================================================================
# ops_extended.performance_analyze_to_shell_command
# ============================================================================

class TestPerformanceAnalyzeShellCommand:
    """performance_analyze 工具→命令映射测试"""

    def test_cpu_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "cpu"})
        assert result == "top -bn1 | head -12"

    def test_memory_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "memory"})
        assert result == "free -m"

    def test_disk_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "disk"})
        assert result is not None
        assert "df -hT" in result

    def test_load_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "load"})
        assert result == "uptime"

    def test_top_processes_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "top_processes"})
        assert result is not None
        assert "ps aux" in result

    def test_default_metric(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({})
        assert result == "uptime"  # default is "load"

    def test_invalid_metric_returns_none(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": "bogus"})
        assert result is None

    def test_empty_metric_defaults_to_load(self):
        from strands_backend.tools.ops_extended import performance_analyze_to_shell_command
        result = performance_analyze_to_shell_command({"metric": ""})
        assert result == "uptime"


# ============================================================================
# shell_mapping.resolve_shell_command（统一入口）
# ============================================================================

class TestResolveShellCommand:
    """resolve_shell_command 统一入口测试"""

    def test_network_diagnose_ping(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("network_diagnose", {"mode": "ping", "target": "8.8.8.8"})
        assert result is not None
        assert "ping" in result
        assert "8.8.8.8" in result

    def test_inspect_processes_list(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("inspect_processes", {"mode": "list"})
        assert result == "ps aux"

    def test_analyze_logs_tail(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("analyze_logs", {"log_path": "/var/log/syslog", "mode": "tail"})
        assert result is not None
        assert "tail" in result

    def test_read_remote_file(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("read_remote_file", {"path": "/etc/hosts"})
        assert result is not None
        assert "cat" in result

    def test_config_diff(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("config_diff", {"file_a": "/etc/a", "file_b": "/etc/b"})
        assert result is not None
        assert "diff -u" in result

    def test_performance_analyze(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("performance_analyze", {"metric": "cpu"})
        assert result is not None
        assert "top" in result

    def test_unknown_tool_returns_none(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        result = resolve_shell_command("nonexistent_tool", {})
        assert result is None

    def test_tool_without_mapping_returns_none(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        # knowledge_search 没有注册 to_shell_command
        result = resolve_shell_command("knowledge_search", {"query": "test"})
        assert result is None

    def test_mapping_failure_returns_none(self):
        from strands_backend.tools.shell_mapping import resolve_shell_command
        # 参数不合法 → fail-closed
        result = resolve_shell_command("network_diagnose", {"mode": "invalid"})
        assert result is None

    def test_has_shell_mapping_true(self):
        from strands_backend.tools.shell_mapping import has_shell_mapping
        assert has_shell_mapping("network_diagnose") is True
        assert has_shell_mapping("inspect_processes") is True
        assert has_shell_mapping("analyze_logs") is True
        assert has_shell_mapping("read_remote_file") is True
        assert has_shell_mapping("config_diff") is True
        assert has_shell_mapping("performance_analyze") is True

    def test_has_shell_mapping_false(self):
        from strands_backend.tools.shell_mapping import has_shell_mapping
        assert has_shell_mapping("knowledge_search") is False
        assert has_shell_mapping("todo_write") is False
        assert has_shell_mapping("nonexistent") is False
