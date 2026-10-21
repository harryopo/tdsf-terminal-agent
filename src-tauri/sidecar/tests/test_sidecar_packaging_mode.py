from __future__ import annotations

import ast
import fnmatch
import unittest
from pathlib import Path
from types import SimpleNamespace

from _bundle_check import registry_factory_modules
from strands_backend.tools.registry import TOOL_REGISTRY

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = SIDECAR_ROOT / "tdsf-sidecar.spec"


class TestSidecarPackagingMode(unittest.TestCase):
    def setUp(self):
        self.calls = {}
        self.pure = [object()]
        self.scripts = [object()]
        self.binaries = [object()]
        self.datas = [object()]
        self.pyz = object()
        self.exe = object()
        self.collected = object()

        def analysis(*args, **kwargs):
            result = SimpleNamespace(
                pure=self.pure,
                scripts=self.scripts,
                binaries=self.binaries,
                datas=self.datas,
            )
            self.calls["analysis"] = {
                "args": args,
                "kwargs": kwargs,
                "result": result,
            }
            return result

        def make_pyz(*args, **kwargs):
            self.calls["pyz"] = {"args": args, "kwargs": kwargs}
            return self.pyz

        def make_exe(*args, **kwargs):
            # kwargs intentionally has no exclude_binaries default: the real spec
            # must pass the mode explicitly instead of inheriting a mock default.
            self.calls["exe"] = {"args": args, "kwargs": kwargs}
            return self.exe

        def collect(*args, **kwargs):
            self.calls["collect"] = {"args": args, "kwargs": kwargs}
            return self.collected

        namespace = {
            "SPECPATH": str(SIDECAR_ROOT),
            "Analysis": analysis,
            "PYZ": make_pyz,
            "EXE": make_exe,
            "COLLECT": collect,
        }
        source = SPEC_PATH.read_text(encoding="utf-8")
        exec(compile(source, str(SPEC_PATH), "exec"), namespace)
        self.namespace = namespace

    def test_exe_explicitly_excludes_binaries_for_onedir(self):
        exe_call = self.calls["exe"]
        self.assertIn(
            "exclude_binaries",
            exe_call["kwargs"],
            "onedir EXE must explicitly exclude binaries before COLLECT assembles them",
        )
        self.assertIs(exe_call["kwargs"]["exclude_binaries"], True)

    def test_collect_receives_original_analysis_resources(self):
        collect_call = self.calls["collect"]
        self.assertIs(collect_call["args"][0], self.exe)
        self.assertIs(collect_call["args"][1], self.binaries)
        self.assertIs(collect_call["args"][2], self.datas)
        self.assertEqual(collect_call["kwargs"]["name"], "tdsf-sidecar")
        self.assertIs(self.namespace["coll"], self.collected)

    def test_spec_hiddenimports_cover_the_real_registry(self):
        analysis_call = self.calls["analysis"]
        hiddenimports = analysis_call["kwargs"]["hiddenimports"]
        required_modules = set(registry_factory_modules().values())
        self.assertTrue(TOOL_REGISTRY, "the real tool registry must not be empty")
        self.assertFalse(required_modules - set(hiddenimports))

    def test_spec_loads_the_sidecar_pyinstaller_hooks(self):
        hook_dir = SIDECAR_ROOT / "pyinstaller-hooks"
        hookspath = self.calls["analysis"]["kwargs"]["hookspath"]
        self.assertIn(str(hook_dir), hookspath)
        self.assertTrue(hook_dir.is_dir())

    def test_sqlite_vec_hook_collects_platform_dynamic_libraries(self):
        hook_path = SIDECAR_ROOT / "pyinstaller-hooks" / "hook-sqlite_vec.py"
        self.assertTrue(hook_path.is_file())
        hook_tree = ast.parse(hook_path.read_text(encoding="utf-8"))
        patterns = None
        for node in ast.walk(hook_tree):
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(target, ast.Name) and target.id == "binaries" for target in node.targets):
                continue
            call = node.value
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
                continue
            if call.func.id != "collect_dynamic_libs":
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant) or call.args[0].value != "sqlite_vec":
                continue
            pattern_arg = next((kw.value for kw in call.keywords if kw.arg == "search_patterns"), None)
            if pattern_arg is not None:
                patterns = ast.literal_eval(pattern_arg)
                break

        self.assertIsNotNone(patterns, "binaries must collect sqlite_vec dynamic libraries with search_patterns")
        self.assertIsInstance(patterns, list)
        for library_name in ("vec0.dll", "vec0.so", "vec0.dylib"):
            self.assertTrue(
                any(fnmatch.fnmatchcase(library_name, pattern) for pattern in patterns),
                f"search_patterns must cover {library_name}",
            )


if __name__ == "__main__":
    unittest.main()
