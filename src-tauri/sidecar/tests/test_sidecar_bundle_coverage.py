"""
strands_backend/tests/test_sidecar_bundle_coverage.py — 打包能力覆盖（#83）
============================================================================

背景（2026-09-19 打 1.0.1 时实测到的产品级缺陷）：`registry.py` 用
"module:attr" 点路径字符串 + ``importlib`` 延迟解析工具工厂，**PyInstaller 的静态
分析看不见这种导入**。不带 hiddenimports 时，产物 PYZ 里只有 14/26 个工具模块，
而已装版 sidecar.log 里能数出 11 条 ``tool '<name>' build failed, skipped:
No module named ...`` —— 装完的 agent 静默少掉一半能力（python_run / ask_user /
knowledge_* / service/package/firewall/security / config_diff / backup_restore /
get_terminal_output / save_skill …），dev 跑源码时全都好着。

本文件钉住三件事，让这类"绿着但产物是空的"不再复发：
1. 每个工厂模块都必须是 ``strands_backend.tools.*`` 且文件真实存在
   —— spec 按目录列 hiddenimports，只有"文件在 tools/ 下"才保证会被收进包；
2. spec 不得退回 ``hiddenimports=[]``（有人手一抖就前功尽弃）；
3. ``_bundle_check.py`` 自己算得对（喂一份残缺 TOC 必须报缺失，喂全量必须 0 缺）。

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_sidecar_bundle_coverage.py -v
"""
from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SIDECAR_ROOT))

from _bundle_check import find_missing, registry_factory_modules  # noqa: E402

from strands_backend.tools.registry import TOOL_REGISTRY  # noqa: E402

SPEC_PATH = SIDECAR_ROOT / "tdsf-sidecar.spec"


class TestFactoryModulesAreCollectable(unittest.TestCase):
    """工厂模块必须落在 spec 的收集策略覆盖得到的位置"""

    def test_factory_modules_exist_and_import(self):
        for name, module in sorted(registry_factory_modules().items()):
            with self.subTest(tool=name):
                self.assertTrue(
                    module.startswith("strands_backend.tools."),
                    f"{name} 的工厂不在 tools/ 包内，spec 的目录列举收不到它",
                )
                rel = module.replace("strands_backend.tools.", "")
                self.assertTrue(
                    (SIDECAR_ROOT / "strands_backend" / "tools" / f"{rel}.py").exists(),
                    f"{module} 文件不存在（工厂点路径写错了）",
                )
                importlib.import_module(module)

    def test_registry_not_empty(self):
        # 空注册表会让上面两条断言一起变成空跑
        self.assertGreaterEqual(len(TOOL_REGISTRY), 20)


class TestSpecDeclaresHiddenImports(unittest.TestCase):
    def test_spec_does_not_revert_to_empty_hiddenimports(self):
        text = SPEC_PATH.read_text(encoding="utf-8")
        self.assertNotIn(
            "hiddenimports=[]",
            text,
            "spec 又退回空 hiddenimports 了 —— registry 的动态导入 PyInstaller 看不见，"
            "装出来的 sidecar 会静默少一半工具（#83）",
        )
        self.assertIn("strands_backend.tools.", text)

    def test_spec_prelude_runs_and_covers_every_factory(self):
        """真跑一遍 spec 的头部算 hiddenimports（spec 里没有 __file__，只能这样验）

        2026-09-19 实测：第一版写 ``pathlib.Path(__file__)`` —— PyInstaller 是把 spec
        exec 进自建命名空间的，``__file__`` 根本不存在，打包当场 NameError 失败。
        这类"spec 里引用了运行时不存在的东西"只能靠 exec 才验得出来。
        """
        text = SPEC_PATH.read_text(encoding="utf-8")
        prelude = text.partition("a = Analysis(")[0]
        code_only = "\n".join(
            line for line in prelude.splitlines() if not line.lstrip().startswith("#")
        )
        self.assertNotIn("__file__", code_only, "spec 头部没有 __file__，会 NameError")
        self.assertIn("SPECPATH", code_only, "要用 PyInstaller 注入的 SPECPATH 定位目录")

        namespace = {"SPECPATH": str(SIDECAR_ROOT)}
        exec(compile(prelude, str(SPEC_PATH), "exec"), namespace)
        hidden = namespace["_tool_hiddenimports"]
        self.assertTrue(hidden, "spec 算出来的 hiddenimports 是空的")
        required = set(registry_factory_modules().values())
        self.assertFalse(
            required - set(hidden),
            f"有工厂模块不在 hiddenimports 里: {sorted(required - set(hidden))}",
        )


class TestBundleCheckItself(unittest.TestCase):
    """门禁脚本自己也要被测一次（判据错了比没有判据更危险）"""

    def test_reports_missing_modules(self):
        required = set(registry_factory_modules().values())
        half = sorted(required)[: max(1, len(required) // 2)]
        toc_text = "\n".join(f"('{m}', 'x.py', 'PYMODULE')" for m in half) + "\n"
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            toc = Path(tmp) / "PYZ-00.toc"
            toc.write_text(toc_text, encoding="utf-8")
            missing_modules = {module for _name, module in find_missing(toc)}
        self.assertTrue(missing_modules)
        self.assertTrue(required.issuperset(missing_modules))
        self.assertFalse(missing_modules.intersection(half), "已收录的不该被报缺")

    def test_full_toc_passes(self):
        required = sorted(set(registry_factory_modules().values()))
        toc_text = "\n".join(f"('{m}', 'x.py', 'PYMODULE')" for m in required)
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            toc = Path(tmp) / "PYZ-00.toc"
            toc.write_text(toc_text, encoding="utf-8")
            self.assertEqual(find_missing(toc), [])

    def test_absent_toc_is_a_failure_not_a_pass(self):
        missing = find_missing(SIDECAR_ROOT / "no-such-dir" / "PYZ-00.toc")
        self.assertEqual(len(missing), 1)


if __name__ == "__main__":
    unittest.main()
