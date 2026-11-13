import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SIDECAR_ROOT.parents[1]
SCRIPTS = (
    "consolidate_knowledge.py",
    "rebuild_from_consolidated.py",
)


@pytest.mark.parametrize("script_name", SCRIPTS)
@pytest.mark.parametrize("configured", [True, False], ids=["caller-configured", "default"])
def test_script_import_respects_data_dir(script_name, configured, tmp_path):
    script = SIDECAR_ROOT / "scripts" / script_name
    caller_data = tmp_path / "caller-data"
    env = os.environ.copy()
    if configured:
        env["TDSF_DATA_DIR"] = str(caller_data)
    else:
        env.pop("TDSF_DATA_DIR", None)

    code = (
        "import json, os, runpy; "
        f"runpy.run_path({str(script)!r}, run_name='tdsf_import_contract'); "
        "print(json.dumps({'data_dir': os.environ['TDSF_DATA_DIR']}))"
    )
    result = subprocess.run(
        [sys.executable, "-B", "-X", "utf8", "-c", code],
        cwd=SIDECAR_ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    actual = Path(json.loads(result.stdout.strip().splitlines()[-1])["data_dir"])
    expected = caller_data if configured else PROJECT_ROOT / ".tdsf-data"
    assert actual == expected
    assert not caller_data.exists()
