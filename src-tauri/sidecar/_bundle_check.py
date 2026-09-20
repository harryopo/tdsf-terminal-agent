"""_bundle_check.py — 校验打好的 sidecar 里真的带着每一个 agent 工具模块（#83）

为什么要有这一步（2026-09-19 实测）：`registry.py` 用 "module:attr" 点路径字符串 +
``importlib`` 延迟解析工具工厂（防循环依赖），**PyInstaller 的静态分析看不见这种导入**。
后果不是报错而是静默降级：装好的 sidecar 的 PYZ 里只有 14/26 个
``strands_backend.tools.*`` 模块，而已装版 sidecar.log 里能数出 11 个
``tool '<name>' build failed, skipped: No module named 'strands_backend.tools.x'``
—— python_run / ask_user / knowledge_* / service/package/firewall/security
（ops_extended）/ config_diff / backup_restore / get_terminal_output /
assess_confidence / search_history / save_skill 在**安装包里根本不存在**，
dev 跑源码时全都好着。单测与 exe 冒烟都抓不到（冒烟不构建工具集）。

判据取两处真值对撞：
1. ``TOOL_REGISTRY`` 里所有工厂模块（运行时的真实需求）；
2. PyInstaller 产物 workpath 下的 ``PYZ-00.toc``（产物里到底装了什么）。

缺一个就非零退出 —— 让 "安装包能力不全" 变成构建失败，而不是用户发现的问题。

    python _bundle_check.py            # 用默认路径（sidecar 同级 build-sidecar/）
    python _bundle_check.py --toc path/to/PYZ-00.toc
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

DEFAULT_TOC = SIDECAR_ROOT / "build-sidecar" / "tdsf-sidecar" / "PYZ-00.toc"


def registry_factory_modules() -> dict[str, str]:
    """{工具名: 工厂模块} —— 运行时真的会 import 的那些模块"""
    from strands_backend.tools.registry import TOOL_REGISTRY

    return {
        name: spec.factory.partition(":")[0]
        for name, spec in TOOL_REGISTRY.items()
    }


def pyz_modules(toc_path: Path) -> set[str]:
    """从 PYZ-00.toc 里读出已收集模块名（TOC 条目是 Python repr，模块名带引号）"""
    text = toc_path.read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r"['\"](strands_backend[\w.]*)['\"]", text))


def find_missing(toc_path: Path) -> list[tuple[str, str]]:
    """返回 [(工具名, 缺失模块)]；toc 不存在时也报（用 [(<no PYZ-00.toc>, path)] 形式）"""
    required = registry_factory_modules()
    if not toc_path.exists():
        return [("<no PYZ-00.toc>", str(toc_path))]
    collected = pyz_modules(toc_path)
    return sorted(
        (name, module) for name, module in required.items() if module not in collected
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--toc",
        type=Path,
        default=DEFAULT_TOC,
        help="PyInstaller 的 PYZ-00.toc 路径（workpath 下）",
    )
    args = parser.parse_args(argv)

    required = registry_factory_modules()
    missing = find_missing(args.toc)
    if missing:
        pairs = ", ".join(f"{name}={module}" for name, module in missing)
        # 纯 ASCII：这段输出会被构建脚本当作门禁判据，不能依赖控制台编码
        print(f"[bundle-check] FAIL: {len(missing)}/{len(required)} tool modules missing from bundle: {pairs}")
        print(
            "[bundle-check] fix: add them to hiddenimports in tdsf-sidecar.spec "
            "(registry resolves factories via dotted-path strings, so static "
            "analysis cannot see the import)"
        )
        return 1
    print(
        f"[bundle-check] OK: all {len(required)} tool factory modules are in the "
        f"bundle (toc={args.toc})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
