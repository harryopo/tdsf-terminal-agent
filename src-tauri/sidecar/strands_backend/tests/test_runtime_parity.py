"""运行时版本收口（ROADMAP #77 / 深度体检 A5）：**三处声明必须是同一个精确版本**。

背景（两次事故，同一成因）：宽 pin 让同一份代码在三个 strands 上跑 ——
`.venv` 1.53 跑门禁、`target/debug/sidecar` 1.50.2 做桌面实测、安装包 onedir 1.56，
于是"测试通过"推不出"用户机器上那版没问题"。`Agent(max_iterations=)` 在 1.50.2
被移除是第一次真实故障；2026-09-19 复核 #77 时发现更难看的证据：
`src-tauri/target/debug/sidecar/tdsf-sidecar/_internal` 里 **1.50.2 与 1.56.0 两份
dist-info 同时存在**（历次打包混在一个目录里），而 `.release-venv` 这个词
在全仓任何脚本/配置里都不存在 —— 打包用的是 `build-sidecar.ps1` 的默认值
`-Python python`，即 PATH 上当时是谁就算谁。

所以这里从"下限"改成"精确"：应用不是库，装什么版本必须写死且可核对。
`sidecar/STRANDS_RUNTIME_VERSION` 是唯一真值（完整三段号），requirements.txt、
pyproject.toml、实际装上的包、以及打包脚本，四者都必须等于它。
"""
from __future__ import annotations

import re
from importlib import metadata
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[2]
RUNTIME_VERSION = (SIDECAR / "STRANDS_RUNTIME_VERSION").read_text(encoding="utf-8").strip()

# 声明必须写成 `strands-agents==X.Y.Z`：`>=` / `~=` / 带逗号的上界都算没收口
EXACT_PIN_RE = re.compile(r"""strands-agents\s*==\s*["']?(\d+\.\d+\.\d+)["']?""")


def _declared_pin(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    match = EXACT_PIN_RE.search(text)
    assert match, (
        f"{path.name} 里没有 `strands-agents==X.Y.Z` 的精确声明。\n"
        f"宽 pin（>= / ~= / ,<2.0）就是 #77 的成因：门禁、产物、用户机器会各装一版。"
    )
    return match.group(1)


def test_runtime_version_file_is_a_full_release_number() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", RUNTIME_VERSION), (
        f"STRANDS_RUNTIME_VERSION 必须是完整三段号（要能精确装上去），当前 {RUNTIME_VERSION!r}"
    )


@pytest.mark.parametrize("name", ["requirements.txt", "requirements-build.txt", "pyproject.toml"])
def test_declared_pin_equals_the_runtime_version_file(name: str) -> None:
    path = SIDECAR / name
    if name == "requirements-build.txt":
        # 这份只 `-r requirements.txt` + 打包工具，不该另写一条 strands 声明
        assert "strands-agents" not in path.read_text(encoding="utf-8"), (
            "requirements-build.txt 里另写 strands 版本 = 第二个真值，迟早分叉"
        )
        return
    assert _declared_pin(path) == RUNTIME_VERSION, (
        f"{name} 的 strands-agents 精确版本与 STRANDS_RUNTIME_VERSION({RUNTIME_VERSION}) 不一致"
    )


def test_no_upper_bound_range_left_in_the_pin() -> None:
    """`==1.53.0,<2.0` 这种写法是自相矛盾的糊弄，扫一遍杜绝。"""
    for name in ("requirements.txt", "pyproject.toml"):
        line = next(
            (l for l in (SIDECAR / name).read_text(encoding="utf-8").splitlines()
             if "strands-agents" in l and not l.strip().startswith("#")),
            "",
        )
        assert "<" not in line and ">" not in line, f"{name} 的声明还带范围：{line.strip()}"


def test_installed_runtime_equals_the_declared_version() -> None:
    """跑测试的这个解释器装的版本必须**等于**声明值，不是"不低于"。

    ">=下限"正是过去骗过我们的那句话：1.53 和 1.56 都满足它，行为却不同。
    """
    try:
        installed = metadata.version("strands-agents")
    except metadata.PackageNotFoundError:
        pytest.skip("strands-agents 未安装（该环境不跑真运行时）")

    assert installed == RUNTIME_VERSION, (
        f"实际装的是 strands-agents {installed}，声明是 {RUNTIME_VERSION}："
        "门禁跑的运行时与产物里的又分叉了（见 ROADMAP #77）"
    )
