from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
MAIN_SOURCE = SIDECAR_ROOT / "main.py"


def _run_data_dir_block(
    *, tmp_path: Path, frozen: bool, os_name: str, configured: str | None
) -> dict[str, object]:
    tree = ast.parse(MAIN_SOURCE.read_text(encoding="utf-8"))
    mkdir_index = next(
        index
        for index, node in enumerate(tree.body)
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and ast.unparse(node.value.func) == "_TDSF_DATA_DIR.mkdir"
    )
    init_index = next(
        index
        for index in range(mkdir_index - 1, -1, -1)
        if isinstance(tree.body[index], ast.If)
        and any(
            isinstance(target, ast.Name) and target.id == "_TDSF_DATA_DIR"
            for child in ast.walk(tree.body[index])
            if isinstance(child, ast.Assign)
            for target in child.targets
        )
    )
    start = init_index
    if init_index > 0:
        prior = tree.body[init_index - 1]
        if isinstance(prior, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "_configured_data_dir"
            for target in prior.targets
        ):
            start -= 1
    block = ast.Module(body=tree.body[start : mkdir_index + 2], type_ignores=[])
    env: dict[str, str] = {
        "APPDATA": str(tmp_path / "appdata"),
        "XDG_DATA_HOME": str(tmp_path / "xdg"),
    }
    if configured is not None:
        env["TDSF_DATA_DIR"] = configured
    fake_sys = SimpleNamespace(
        frozen=frozen,
        executable=str(tmp_path / "app" / "sidecar.exe"),
    )
    namespace = {
        "sys": fake_sys,
        "os": SimpleNamespace(name=os_name, environ=env),
        "Path": Path,
        "__file__": str(tmp_path / "repo" / "src-tauri" / "sidecar" / "main.py"),
    }
    exec(compile(block, str(MAIN_SOURCE), "exec"), namespace)
    return {"data_dir": namespace["_TDSF_DATA_DIR"], "env": env}


@pytest.mark.parametrize(
    ("frozen", "os_name", "configured", "expected"),
    [
        (False, "nt", None, "repo/.tdsf-data"),
        (False, "nt", "caller-data", "caller-data"),
        (True, "nt", None, "appdata/tdsf-terminal-agent/.tdsf-data"),
        (True, "nt", "caller-data", "caller-data"),
        (True, "posix", None, "xdg/tdsf-terminal-agent/.tdsf-data"),
        (True, "posix", "caller-data", "caller-data"),
    ],
    ids=[
        "dev-default",
        "dev-configured",
        "frozen-windows-default",
        "frozen-windows-configured",
        "frozen-linux-default",
        "frozen-linux-configured",
    ],
)
def test_data_dir_initialization_preserves_defaults_and_honors_nonempty_env(
    tmp_path: Path,
    frozen: bool,
    os_name: str,
    configured: str | None,
    expected: str,
) -> None:
    configured_path = tmp_path / configured if configured else None
    result = _run_data_dir_block(
        tmp_path=tmp_path,
        frozen=frozen,
        os_name=os_name,
        configured=str(configured_path) if configured_path else None,
    )

    actual = Path(result["data_dir"])
    if configured_path:
        assert actual == configured_path
        assert actual.is_dir()
    else:
        assert actual == tmp_path / expected
        assert actual.is_dir()
    assert Path(result["env"]["TDSF_DATA_DIR"]) == actual


def test_empty_data_dir_env_falls_back_to_default(tmp_path: Path) -> None:
    result = _run_data_dir_block(
        tmp_path=tmp_path, frozen=False, os_name="nt", configured=""
    )

    expected = tmp_path / "repo" / ".tdsf-data"
    assert Path(result["data_dir"]) == expected
    assert Path(result["env"]["TDSF_DATA_DIR"]) == expected


def test_import_writes_sidecar_log_under_configured_data_dir(tmp_path: Path) -> None:
    data_dir = tmp_path / "configured-data"
    isolated_main = tmp_path / "repo" / "src-tauri" / "sidecar" / "main.py"
    isolated_main.parent.mkdir(parents=True)
    shutil.copyfile(MAIN_SOURCE, isolated_main)
    default_log = isolated_main.parents[2] / ".tdsf-data" / "sidecar.log"
    default_log_mtime = default_log.stat().st_mtime_ns if default_log.exists() else None
    code = (
        "import json, logging, runpy, sys; "
        "main = runpy.run_path(sys.argv[1], run_name='isolated_main'); "
        "logging.getLogger('sidecar.main').warning('isolated data directory probe'); "
        "[h.flush() for h in logging.getLogger().handlers]; "
        "print(json.dumps({'data_dir': str(main['_TDSF_DATA_DIR']), "
        "'file_handlers': [getattr(h, 'baseFilename', None) "
        "for h in logging.getLogger().handlers]}))"
    )
    result = subprocess.run(
        [sys.executable, "-B", "-X", "utf8", "-c", code, str(isolated_main)],
        cwd=SIDECAR_ROOT,
        env={
            **os.environ,
            "TDSF_DATA_DIR": str(data_dir),
            "PYTHONPATH": str(SIDECAR_ROOT),
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert Path(payload["data_dir"]) == data_dir
    assert str(data_dir / "sidecar.log") in payload["file_handlers"]
    assert (data_dir / "sidecar.log").is_file()
    assert (
        default_log.stat().st_mtime_ns if default_log.exists() else None
    ) == default_log_mtime
