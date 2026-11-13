"""Exercise env probing through the real sidecar stdio entry point."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
FAKE_PROBE_RESULT = {
    "ok": True,
    "output": (
        'PRETTY_NAME="Probe Linux"\nID=rocky\n__TDSF_KERNEL__\n'
        "6.1-fixture\n__TDSF_SHELL__\n/bin/bash\n"
    ),
    "exitCode": 0,
    "stderr": "",
    "duration": 0.1,
}


def _read_json_lines(stream, messages: queue.Queue) -> None:
    for line in iter(stream.readline, ""):
        try:
            messages.put_nowait(json.loads(line))
        except (json.JSONDecodeError, queue.Full):
            continue


def _drain(stream) -> None:
    for _ in iter(stream.readline, ""):
        pass


def _write_request(process: subprocess.Popen, method: str, params: dict, req_id: int) -> None:
    process.stdin.write(
        json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": req_id})
        + "\n"
    )
    process.stdin.flush()


def test_probe_env_through_real_main_entry(tmp_path: Path) -> None:
    """The real ``main.py`` entry must use its live bridge for remote probing."""
    env = os.environ.copy()
    env["TDSF_DATA_DIR"] = str(tmp_path / "tdsf-data")
    env["TDSF_KB_AUTO_INIT"] = "0"
    process = subprocess.Popen(
        [sys.executable, "-B", "-u", "main.py"],
        cwd=SIDECAR_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    messages: queue.Queue = queue.Queue(maxsize=200)
    stdout_thread = threading.Thread(
        target=_read_json_lines, args=(process.stdout, messages), daemon=True
    )
    stderr_thread = threading.Thread(target=_drain, args=(process.stderr,), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    ready = False
    reverse_seen = False
    probe_result = None
    health_result = None
    ping_result = None
    deadline = time.monotonic() + 35
    try:
        while time.monotonic() < deadline and not ready:
            try:
                message = messages.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            if message.get("method") == "ready":
                ready = True

        assert ready, "real sidecar did not reach ready within 35 seconds"

        _write_request(process, "system.probe_env", {"ssh_session_id": 15}, 101)
        probe_deadline = time.monotonic() + 5
        while time.monotonic() < probe_deadline and probe_result is None:
            try:
                message = messages.get(
                    timeout=min(0.25, max(0.01, probe_deadline - time.monotonic()))
                )
            except queue.Empty:
                continue
            if message.get("method") == "ssh_command" and int(message.get("id", 0)) >= 1_000_000:
                reverse_seen = True
                assert message["params"]["sessionId"] == 15
                assert message["params"]["timeout"] == 10
                assert message["params"]["command"] == (
                    'cat /etc/os-release 2>/dev/null; echo "__TDSF_KERNEL__"; '
                    'uname -r 2>/dev/null; echo "__TDSF_SHELL__"; echo "$SHELL"'
                )
                reverse_id = message["id"]
                _write_request(process, "sidecar.health", {}, 102)
                _write_request(process, "ping", {}, 103)
                control_deadline = time.monotonic() + 2
                while time.monotonic() < control_deadline and (
                    health_result is None or ping_result is None
                ):
                    try:
                        control_message = messages.get(
                            timeout=min(
                                0.25,
                                max(0.01, control_deadline - time.monotonic()),
                            )
                        )
                    except queue.Empty:
                        continue
                    if control_message.get("id") == 102:
                        health_result = control_message.get("result")
                    elif control_message.get("id") == 103:
                        ping_result = control_message.get("result")

                assert health_result is not None, "sidecar.health blocked while probe awaited Rust"
                assert ping_result and ping_result.get("alive") is True, "ping blocked while probe awaited Rust"
                process.stdin.write(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": reverse_id,
                            "result": FAKE_PROBE_RESULT,
                        }
                    )
                    + "\n"
                )
                process.stdin.flush()
            elif message.get("id") == 101:
                probe_result = message.get("result")

        if not reverse_seen:
            _write_request(process, "sidecar.health", {}, 102)
            _write_request(process, "ping", {}, 103)
            control_deadline = time.monotonic() + 2
            while time.monotonic() < control_deadline and (
                health_result is None or ping_result is None
            ):
                try:
                    message = messages.get(
                        timeout=min(
                            0.25,
                            max(0.01, control_deadline - time.monotonic()),
                        )
                    )
                except queue.Empty:
                    continue
                if message.get("id") == 102:
                    health_result = message.get("result")
                elif message.get("id") == 103:
                    ping_result = message.get("result")

        if reverse_seen:
            probe_deadline = time.monotonic() + 5
            while time.monotonic() < probe_deadline and probe_result is None:
                try:
                    message = messages.get(
                        timeout=min(
                            0.25,
                            max(0.01, probe_deadline - time.monotonic()),
                        )
                    )
                except queue.Empty:
                    continue
                if message.get("id") == 101:
                    probe_result = message.get("result")

        assert reverse_seen, "system.probe_env did not issue a reverse ssh_command request"
        assert probe_result and probe_result.get("ok") is True, (
            "system.probe_env did not return a successful result"
        )
        assert probe_result.get("source") == "ssh"
        assert probe_result.get("os_family") == "rhel"
        assert probe_result.get("os_pretty_name") == "Probe Linux"
        assert probe_result.get("kernel") == "6.1-fixture"
        assert probe_result.get("shell") == "/bin/bash"
        assert health_result is not None, "sidecar.health did not return a result"
        assert ping_result and ping_result.get("alive") is True, "ping did not return pong/alive"
        _write_request(process, "system.probe_env", {"sshSessionId": 15}, 104)
        cache_deadline = time.monotonic() + 2
        cached_result = None
        while time.monotonic() < cache_deadline and cached_result is None:
            try:
                message = messages.get(timeout=0.1)
            except queue.Empty:
                continue
            assert message.get("method") != "ssh_command", "same-session cache issued another command"
            if message.get("id") == 104:
                cached_result = message.get("result")
        assert cached_result and cached_result.get("source") == "cache"
        assert cached_result.get("os_pretty_name") == "Probe Linux"
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        if process.stdout and not process.stdout.closed:
            process.stdout.close()
        if process.stderr and not process.stderr.closed:
            process.stderr.close()
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
