"""The frozen worker entry must execute one source string without starting sidecar."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


SIDECAR = Path(__file__).resolve().parents[1]
MAIN = SIDECAR / "main.py"


def _worker_env(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    data_dir = tmp_path / "data"
    home_dir = tmp_path / "home"
    temp_dir = tmp_path / "temp"
    for directory in (data_dir, home_dir, temp_dir):
        directory.mkdir()

    env = {
        key: os.environ[key]
        for key in ("SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATH", "PATHEXT")
        if key in os.environ
    }
    env.update(
        {
            "TDSF_DATA_DIR": str(data_dir),
            "TDSF_KB_AUTO_INIT": "0",
            "APPDATA": str(home_dir / "appdata"),
            "LOCALAPPDATA": str(home_dir / "localappdata"),
            "USERPROFILE": str(home_dir),
            "HOME": str(home_dir),
            "TEMP": str(temp_dir),
            "TMP": str(temp_dir),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "ascii",
            "PYTHONDONTWRITEBYTECODE": "1",
            "HF_HOME": str(home_dir / "hf"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "OTEL_SDK_DISABLED": "true",
        }
    )
    return env, data_dir, home_dir


def _run_worker(tmp_path: Path, *args: str, cwd: Path | None = None):
    env, data_dir, home_dir = _worker_env(tmp_path)
    completed = subprocess.run(
        [sys.executable, "-X", "utf8", "-B", str(MAIN), "--python-worker", *args],
        cwd=cwd or tmp_path,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
    )
    return completed, data_dir, home_dir


def _assert_no_sidecar_start(data_dir: Path, stdout: str) -> None:
    assert "\"method\": \"ready\"" not in stdout
    assert not list(data_dir.rglob("*"))


def test_worker_executes_code_in_isolated_process_without_sidecar_start(tmp_path: Path):
    marker = tmp_path / "marker.txt"
    source = (
        "from pathlib import Path; "
        f"Path({str(marker)!r}).write_text('worker-ran', encoding='utf-8'); "
        "print('worker-ok')"
    )

    result, data_dir, _ = _run_worker(tmp_path, source)

    assert result.returncode == 0
    assert result.stdout.strip() == "worker-ok"
    assert marker.read_text(encoding="utf-8") == "worker-ran"
    _assert_no_sidecar_start(data_dir, result.stdout)


def test_worker_preserves_utf8_streams_and_exit_code(tmp_path: Path):
    source = "import sys; print('中文输出'); print('错误输出', file=sys.stderr); raise SystemExit(7)"

    result, data_dir, _ = _run_worker(tmp_path, source)

    assert result.returncode == 7
    assert result.stdout.strip() == "中文输出"
    assert result.stderr.strip() == "错误输出"
    _assert_no_sidecar_start(data_dir, result.stdout)


def test_worker_returns_uncaught_exception_as_failure(tmp_path: Path):
    result, data_dir, _ = _run_worker(tmp_path, "raise ValueError('qa-worker-boom')")

    assert result.returncode == 1
    assert "ValueError: qa-worker-boom" in result.stderr
    _assert_no_sidecar_start(data_dir, result.stdout)


def test_worker_keeps_c_dash_argv_main_module_and_cwd(tmp_path: Path):
    (tmp_path / "qa_local_module.py").write_text("VALUE = 'local-import-ok'\n", encoding="utf-8")
    source = (
        "import __main__, os, sys, qa_local_module; "
        "assert __main__.worker_seed == 'main-visible'; "
        "assert sys.argv == ['-c']; "
        "assert os.getcwd() == __main__.expected_cwd; "
        "print(qa_local_module.VALUE)"
    )
    # The worker contract executes as __main__ with the traditional -c argv;
    # inject the expected values in source without relying on a test-only flag.
    source = (
        "worker_seed='main-visible'; "
        f"expected_cwd={str(tmp_path)!r}; "
        + source
    )

    result, data_dir, _ = _run_worker(tmp_path, source)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "local-import-ok"
    _assert_no_sidecar_start(data_dir, result.stdout)


@pytest.mark.parametrize("extra_source", [False, True], ids=["missing", "extra"])
def test_worker_rejects_missing_or_extra_source_arguments(tmp_path: Path, extra_source: bool):
    marker = tmp_path / "must-not-exist.txt"
    source = f"open({str(marker)!r}, 'w').write('must-not-run'); print('must-not-run')"
    args = (source, "extra") if extra_source else ()
    result, data_dir, _ = _run_worker(
        tmp_path,
        *args,
    )

    assert result.returncode == 2
    assert "must-not-run" not in result.stdout
    assert not marker.exists()
    _assert_no_sidecar_start(data_dir, result.stdout)
