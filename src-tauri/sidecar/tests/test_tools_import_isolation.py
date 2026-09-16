"""现役 RPC 与旧工具依赖的导入隔离回归。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_rpc_import_does_not_require_langgraph() -> None:
    """注册现役 RPC 时不能被未使用的 LangGraph 旧工具绑死。"""
    sidecar_dir = Path(__file__).resolve().parents[1]
    code = """
import builtins

real_import = builtins.__import__

def guarded_import(name, *args, **kwargs):
    if name == "langgraph" or name.startswith("langgraph."):
        raise ModuleNotFoundError("langgraph intentionally unavailable")
    return real_import(name, *args, **kwargs)

builtins.__import__ = guarded_import
import tools
from tools import rpc_methods

assert len(tools.TOOL_REGISTRY) == 8
assert callable(rpc_methods.register_methods)
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(path for path in sys.path if path)
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=sidecar_dir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
