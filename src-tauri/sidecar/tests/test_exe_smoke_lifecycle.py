import io
import json
import runpy
import subprocess
from pathlib import Path

import pytest


SMOKE_SCRIPT = Path(__file__).resolve().parents[1] / "_exe_smoke.py"
SIDECAR_ROOT = SMOKE_SCRIPT.parent


class FakeStdin:
    def __init__(self):
        self.requests = []

    def write(self, line):
        self.requests.append(json.loads(line)["method"])

    def flush(self):
        pass


class FakeProcess:
    def __init__(self, output, exit_code, *, terminate_wait_times_out=False):
        self.stdin = FakeStdin()
        self.stdout = io.StringIO("".join(json.dumps(item) + "\n" for item in output))
        self.returncode = None
        self._exit_code = exit_code
        self._terminate_wait_times_out = terminate_wait_times_out
        self.terminated = False
        self.killed = False
        self.wait_calls = 0

    def wait(self, timeout=None):
        self.wait_calls += 1
        if self.terminated and self._terminate_wait_times_out and not self.killed:
            raise subprocess.TimeoutExpired("fake-sidecar", timeout)
        if self.returncode is None:
            self.returncode = self._exit_code
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


def install_fake_process(
    monkeypatch, tmp_path, *, exit_code=0, alive=True, terminate_wait_times_out=False
):
    monkeypatch.syspath_prepend(str(SIDECAR_ROOT))
    from sidecar_version import SIDECAR_VERSION

    exe = tmp_path / "fake-sidecar.exe"
    exe.touch()
    appdata = tmp_path / "appdata"
    monkeypatch.setenv("TDSF_SIDECAR_EXE", str(exe))
    monkeypatch.setenv("APPDATA", str(appdata))

    methods = ["sidecar.health", "agent.invoke", "agent.list", "skill.list"]
    methods.extend(f"test.method.{index}" for index in range(100))
    output = [
        {"jsonrpc": "2.0", "method": "ready", "params": {"version": SIDECAR_VERSION}},
        {"jsonrpc": "2.0", "id": 2, "result": {"alive": alive}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "result": {"version": SIDECAR_VERSION, "methods": methods},
        },
        {"jsonrpc": "2.0", "id": 4, "result": {"shutdown": True}},
    ]
    process = FakeProcess(
        output, exit_code, terminate_wait_times_out=terminate_wait_times_out
    )

    def fake_popen(command, **kwargs):
        assert kwargs["stderr"] is subprocess.DEVNULL
        (appdata / "tdsf-terminal-agent" / ".tdsf-data").mkdir(parents=True)
        return process

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    return process


def test_exe_smoke_accepts_ready_status_methods_shutdown_and_zero_exit(
    monkeypatch, tmp_path, capsys
):
    process = install_fake_process(monkeypatch, tmp_path)

    runpy.run_path(str(SMOKE_SCRIPT), run_name="__main__")

    output = capsys.readouterr().out
    assert process.stdin.requests == ["ping", "status", "shutdown"]
    assert process.wait_calls == 1
    assert process.returncode == 0
    assert "methods registered: 104" in output
    assert "ALL CHECKS PASSED" in output


def test_exe_smoke_rejects_nonzero_exit_after_successful_rpc_flow(
    monkeypatch, tmp_path, capsys
):
    process = install_fake_process(monkeypatch, tmp_path, exit_code=17)

    try:
        runpy.run_path(str(SMOKE_SCRIPT), run_name="__main__")
    except SystemExit as error:
        exit_code = error.code
    else:
        exit_code = 0
    output = capsys.readouterr().out

    assert exit_code != 0 and "ALL CHECKS PASSED" not in output, (
        f"smoke accepted child exit {process.returncode}; output was {output!r}"
    )


def test_exe_smoke_reaps_started_process_when_a_check_fails(
    monkeypatch, tmp_path
):
    process = install_fake_process(monkeypatch, tmp_path, alive=False)

    with pytest.raises(SystemExit) as error:
        runpy.run_path(str(SMOKE_SCRIPT), run_name="__main__")

    assert error.value.code == 1
    assert (process.terminated or process.killed) and process.wait_calls > 0, (
        "failed smoke did not terminate/kill and wait for its child process"
    )


def test_exe_smoke_kills_and_rewaits_when_terminate_wait_times_out(
    monkeypatch, tmp_path
):
    process = install_fake_process(
        monkeypatch, tmp_path, alive=False, terminate_wait_times_out=True
    )

    with pytest.raises(SystemExit) as error:
        runpy.run_path(str(SMOKE_SCRIPT), run_name="__main__")

    assert error.value.code == 1
    assert process.terminated and process.killed and process.wait_calls == 2
