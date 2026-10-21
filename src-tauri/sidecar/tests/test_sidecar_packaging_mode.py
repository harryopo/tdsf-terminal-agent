from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main()
