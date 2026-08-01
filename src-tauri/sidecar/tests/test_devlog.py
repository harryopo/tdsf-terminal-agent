"""devlog.py 离线分析器测试

用合成样例日志验证各诊断规则（崩溃/编码/重启/LLM 配置/invoke 失败等），
不依赖真实 sidecar 日志文件。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sidecar"))

from devlog import analyze_lines, default_log_path, parse_line  # noqa: E402


def _line(msg: str, level: str = "INFO", ts: str = "2026-07-31 23:53:17", name: str = "sidecar.main") -> str:
    return f"{ts} {level} {name}: {msg}"


class TestParseLine:
    def test_parses_standard_line(self):
        e = parse_line(_line("hello world"))
        assert e is not None
        # sidecar.log 是本地时间，保持原样
        assert e.ts == "2026-07-31 23:53:17"
        assert e.level == "INFO"
        assert e.message == "hello world"

    def test_returns_none_for_non_log_line(self):
        assert parse_line("  File \"main.py\", line 42") is None
        assert parse_line("") is None

    def test_parses_error_level(self):
        e = parse_line(_line("boom", level="ERROR"))
        assert e is not None
        assert e.level == "ERROR"


class TestAnalyzeRules:
    def test_crash_terminate_detected(self):
        findings = analyze_lines([_line("sidecar Crashed: reader exited", level="ERROR")])
        assert any(f.rule == "crash_terminate" and f.severity == "P0" for f in findings)

    def test_encoding_detected(self):
        findings = analyze_lines(
            [_line("UnicodeEncodeError: surrogates not allowed", level="ERROR")]
        )
        assert any(f.rule == "encoding" and f.severity == "P0" for f in findings)

    def test_restart_loop_detected(self):
        findings = analyze_lines([_line("restarting sidecar (retry 3/5)", level="WARNING")])
        assert any(f.rule == "restart_loop" for f in findings)

    def test_llm_not_configured_detected(self):
        findings = analyze_lines([_line("LLM not configured (no API Key)", level="WARNING")])
        assert any(f.rule == "llm_not_configured" for f in findings)

    def test_invoke_error_detected(self):
        findings = analyze_lines(
            [_line("StrandsAgentAdapter.invoke error: timeout", level="ERROR")]
        )
        assert any(f.rule == "invoke_error" for f in findings)
        assert any(f.rule == "strands_error" for f in findings)

    def test_timeout_detected(self):
        findings = analyze_lines([_line("Sidecar 调用超时（60s）", level="ERROR")])
        assert any(f.rule == "timeout" for f in findings)

    def test_clean_log_no_findings(self):
        findings = analyze_lines(
            [_line("registered 99 methods"), _line("ready notification sent")]
        )
        rules = {f.rule for f in findings}
        assert rules == {"session_stats"}

    def test_examples_capped_at_three(self):
        lines = [_line(f"UnicodeEncodeError #{i}", level="ERROR") for i in range(10)]
        findings = analyze_lines(lines)
        enc = next(f for f in findings if f.rule == "encoding")
        assert enc.count == 10
        assert len(enc.examples) == 3

    def test_findings_sorted_by_severity(self):
        findings = analyze_lines(
            [
                _line("timeout", level="ERROR"),
                _line("TerminateProcess", level="ERROR"),
                _line("LLM not configured", level="WARNING"),
            ]
        )
        severities = [f.severity for f in findings]
        assert severities == sorted(severities, key=lambda s: {"P0": 0, "P1": 1, "P2": 2, "INFO": 3}[s])


class TestLogPath:
    def test_default_log_path_points_to_project_tdsf_data(self):
        p = default_log_path()
        assert p.name == "sidecar.log"
        assert ".tdsf-data" in p.parts


class TestRustLogParsing:
    """tauri_plugin_log（Rust 侧）行解析与时区归一化"""

    def test_parses_rust_line(self):
        e = parse_line(
            '[2026-07-31][16:08:25][tdsf_terminal_agent_lib::modules::ssh][INFO] [ssh] connect success: id=4'
        )
        assert e is not None
        assert e.level == "INFO"
        assert "connect success" in e.message
        assert "tdsf_terminal_agent_lib" in e.logger
        # rust.log 是 UTC（16:08 UTC → 本地 +8 = 次日 00:08）
        assert e.ts == "2026-08-01 00:08:25"

    def test_rust_line_without_target(self):
        e = parse_line(
            '[2026-07-31][16:08:25][tdsf_terminal_agent_lib][WARNING] sidecar restarting'
        )
        assert e is not None
        assert e.level == "WARNING"
        assert "restarting" in e.message

    def test_sidecar_ts_kept_as_local(self):
        # sidecar.log 是本地时间（logging asctime 默认），不转换
        e = parse_line("2026-07-31 00:08:25 INFO sidecar.main: ready notification sent")
        assert e is not None
        assert e.ts == "2026-07-31 00:08:25"

    def test_rust_ssh_connect_rule_detected(self):
        from devlog import analyze_entries

        e = parse_line(
            '[2026-07-31][16:08:25][tdsf_terminal_agent_lib::modules::ssh][INFO] [ssh] connect success: id=4'
        )
        findings = analyze_entries([e])
        assert any(f.rule == "ssh_connect_loop" for f in findings)

    def test_rust_auth_failure_rule_detected(self):
        from devlog import analyze_entries

        e = parse_line(
            '[2026-07-31][16:09:00][tdsf_terminal_agent_lib::modules::ssh][ERROR] [ssh] authentication failed'
        )
        findings = analyze_entries([e])
        assert any(f.rule == "ssh_auth_failure" for f in findings)


class TestCollectEntries:
    def test_merges_and_sorts(self, tmp_path):
        from devlog import collect_entries

        a = tmp_path / "a.log"
        b = tmp_path / "b.log"
        a.write_text(
            "2026-07-31 08:10:00 INFO sidecar.main: b-msg\n"
            "2026-07-31 08:08:00 INFO sidecar.main: a-msg\n",
            encoding="utf-8",
        )
        b.write_text(
            "[2026-07-31][08:09:00][tdsf_terminal_agent_lib][INFO] rust-msg\n",
            encoding="utf-8",
        )
        entries = collect_entries([a, b])
        # 按时间排序
        times = [e.ts for e in entries]
        assert times == sorted(times)
        msgs = [e.message for e in entries]
        assert "a-msg" in msgs and "b-msg" in msgs and "rust-msg" in msgs
