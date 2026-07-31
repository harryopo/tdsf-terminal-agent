#!/usr/bin/env python3
"""dev-log — TDSF sidecar 日志诊断 CLI

用法（在项目根目录执行）:
    python scripts/dev-log.py              # 分析最近 2000 行日志，输出诊断报告
    python scripts/dev-log.py --tail 500   # 只分析最近 500 行
    python scripts/dev-log.py --raw        # 直接输出原始日志
    python scripts/dev-log.py --follow     # tail -f 跟随新日志
    python scripts/dev-log.py --log <path> # 指定日志文件

实现：分析逻辑在 src-tauri/sidecar/devlog.py（纯函数，可被 pytest 测试）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src-tauri" / "sidecar"))

from devlog import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
