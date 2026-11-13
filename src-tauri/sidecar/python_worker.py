"""Run Python source without initializing the sidecar application."""

from __future__ import annotations

import sys
import types

WORKER_ARG = "--python-worker"


def run_worker(arguments: list[str]) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")

    if len(arguments) != 1:
        print("Python 执行入口需要且仅接受一段源码。", file=sys.stderr)
        return 2

    sys.argv = ["-c"]
    sys.path.insert(0, "")
    module = types.ModuleType("__main__")
    sys.modules["__main__"] = module
    exec(compile(arguments[0], "<string>", "exec"), module.__dict__)
    return 0
