"""
tests/test_sidecar_version_parity.py — sidecar 自报版本必须是真的那个版本（#84）
================================================================================

起因：`main.py` 的 `sidecar.status` 与启动 `ready` 通知里 `"version": "1.0.0"` 是写死的，
而 app 已经升到 1.0.1。Rust 侧和用户看到的诊断都因此拿到一个假版本号 ——
排查"用户装的到底是哪一版"时会被它误导（这正是 #77 那一族"版本真值"病）。

修法是把真值收进 `sidecar_version.py` 一个常量，本文件钉两件事：
1. 这个常量与三处发布清单**完全相等**（package.json / tauri.conf.json / Cargo.toml）
   —— 不依赖打包脚本，普通 pytest 门禁就能挡住漂移；
2. `main.py` 里不再出现写死的版本号字面量，两处上报点都引用常量。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_SIDECAR_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _SIDECAR_DIR.parent.parent
sys.path.insert(0, str(_SIDECAR_DIR))

from sidecar_version import SIDECAR_VERSION  # noqa: E402


def _cargo_package_version() -> str:
    text = (_REPO_ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r"(?ms)^\[package\]\s*.*?^version\s*=\s*\"([^\"]+)\"", text)
    assert match, "Cargo.toml 里读不到 [package] version"
    return match.group(1)


def test_sidecar_version_matches_every_release_manifest() -> None:
    """五处版本声明必须是同一个字符串。"""
    package = json.loads(
        (_REPO_ROOT / "package.json").read_text(encoding="utf-8")
    )["version"]
    tauri = json.loads(
        (_REPO_ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )["version"]
    pyproject = re.search(
        r"(?ms)^\[project\]\s*.*?^version\s*=\s*\"([^\"]+)\"",
        (_SIDECAR_DIR / "pyproject.toml").read_text(encoding="utf-8"),
    )
    assert pyproject, "sidecar/pyproject.toml 里读不到 [project] version"
    assert (
        SIDECAR_VERSION
        == package
        == tauri
        == _cargo_package_version()
        == pyproject.group(1)
    ), (
        f"版本漂移：sidecar自报={SIDECAR_VERSION} package.json={package} "
        f"tauri.conf={tauri} Cargo={_cargo_package_version()} "
        f"sidecar/pyproject={pyproject.group(1)}"
    )


def test_main_py_reports_the_constant_not_a_literal() -> None:
    """`main.py` 不许再出现写死的版本号；status 与 ready 两处都引用 SIDECAR_VERSION。"""
    source = (_SIDECAR_DIR / "main.py").read_text(encoding="utf-8")
    hardcoded = re.findall(r'"version"\s*:\s*"\d[^"]*"', source)
    assert not hardcoded, f"main.py 里还有写死的版本号：{hardcoded}"
    assert source.count('"version": SIDECAR_VERSION') >= 2, (
        "sidecar.status 与 ready 通知都该上报 SIDECAR_VERSION，少一处就是有一处仍在撒谎"
    )


def test_sidecar_version_is_importable_when_frozen() -> None:
    """常量必须是**普通 import** 能拿到的模块（PyInstaller 静态分析才看得见）。

    #83 的教训：字符串路径的动态导入打包时静默丢失。这里直接确认模块可导入且
    落在 sidecar 根目录（entry 脚本的依赖，不进 hiddenimports 也不会掉）。
    """
    import sidecar_version

    assert sidecar_version.__file__ and Path(sidecar_version.__file__).parent == _SIDECAR_DIR
    assert re.fullmatch(r"\d+\.\d+\.\d+", SIDECAR_VERSION)


def test_status_payload_uses_real_version() -> None:
    """端到端一点：真正调用 `sidecar.status` 的处理函数，报的必须是常量。"""
    import main

    dispatcher = main.MethodDispatcher.__new__(main.MethodDispatcher)  # 不起线程，只验这个纯方法
    dispatcher.list_methods = lambda: []  # type: ignore[method-assign]
    status = dispatcher._status()
    assert status["version"] == SIDECAR_VERSION
    assert set(status) >= {"version", "python", "platform", "uptime", "methods"}
