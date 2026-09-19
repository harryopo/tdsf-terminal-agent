"""运行时版本收口（ROADMAP #77 / 深度体检 A5）：三处声明必须是同一个下限。

背景：2026-09-19 那次体检里，同一份代码在三个地方跑在三个不同 strands 上
（`.venv` 1.53 跑门禁 / `target/debug/sidecar` 1.50.2 做桌面实测 / 安装包 1.56），
于是"测试通过"根本推不出"用户跑的那版没问题"。宽 pin `>=1.0,<2.0` 已经在
本仓造成过真实故障（`Agent(max_iterations=)` 在 1.50.2 被移除）。

下限的唯一真值是 `sidecar/STRANDS_RUNTIME_VERSION`；requirements.txt、
pyproject.toml 与实际装上的包都必须跟住它。
"""
from __future__ import annotations

import re
from importlib import metadata
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[2]
FLOOR = (SIDECAR / "STRANDS_RUNTIME_VERSION").read_text(encoding="utf-8").strip()
PIN_RE = re.compile(r"strands-agents>=(\d+\.\d+)")


def _pin_of(path: Path) -> str:
    match = PIN_RE.search(path.read_text(encoding="utf-8"))
    assert match, f"{path.name} 里找不到 strands-agents>=X.Y 的下限声明"
    return match.group(1)


def test_floor_marker_looks_like_a_release() -> None:
    assert re.fullmatch(r"\d+\.\d+", FLOOR), f"版本下限写法异常: {FLOOR!r}"


@pytest.mark.parametrize("name", ["requirements.txt", "pyproject.toml"])
def test_declared_pins_match_the_floor_marker(name: str) -> None:
    assert _pin_of(SIDECAR / name) == FLOOR, (
        f"{name} 的 strands-agents 下限与 STRANDS_RUNTIME_VERSION({FLOOR}) 不一致"
    )


def test_installed_runtime_is_not_older_than_the_floor() -> None:
    try:
        installed = metadata.version("strands-agents")
    except metadata.PackageNotFoundError:
        pytest.skip("strands-agents 未安装（该环境不跑真运行时）")

    major, minor = (int(x) for x in installed.split(".")[:2])
    floor_major, floor_minor = (int(x) for x in FLOOR.split("."))
    assert (major, minor) >= (floor_major, floor_minor), (
        f"实际装的 strands-agents {installed} 低于下限 {FLOOR}："
        "门禁跑的与产物里的运行时又分叉了（见 ROADMAP #77）"
    )
