"""
strands_backend/tests/test_python_run_approval.py — python_run 分级审批门（#66）
=================================================================================

背景（用户 2026-09-19 决策 3）：python_run 此前在 confirm / teach 档**静默执行任意
代码**，绕开了三模式信任链（ssh_command 同风险等级要弹审批卡）。用户拍板的收紧口径：
「只在代码里有危险动作（删文件、联网、执行系统命令）才弹窗，纯算东西不打扰」。

覆盖两层：
1. analyze_python_code（AST 分级，不跑代码）
   - L4：起子进程 / 动态执行 / 动态导入 / 反序列化 / ctypes
   - L3：删除文件目录 / 联网
   - L2：写入改名（confirm 档逐条确认，auto 档放行）
   - L0-L1：只读与纯计算（三档都不打扰）
   - 别名导入 / getattr 动态取属性 也要命中；字符串里的危险词不算；
     语法不通 → fail-closed 按 L3 保守处理
2. invoke_python_run_tool 的审批门
   - 低风险不弹卡；高危弹卡且卡面主体是代码原文
   - 请求创建失败 / 超时 → fail-closed 不执行
   - 拒绝 → 不执行且回声用户附言
   - 批准 → 真执行，并且**必须释放 execution_gate**（A3 同类：不释放会永久卡死
     该会话后续所有审批）
   - auto 档仍拦 L3+；observe 档 command_blocked

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_python_run_approval.py -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# 确保能 import strands_backend（对齐 test_python_run.py 的 sys.path 处理）
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.modes import AgentMode  # noqa: E402
from strands_backend.tools import (  # noqa: E402
    NeedsYouStatus,
    ToolContext,
)
from strands_backend.tools.python_run import (  # noqa: E402
    invoke_python_run_tool,
)


def make_ctx(workspace: str = "", mode: str = "confirm") -> ToolContext:
    return ToolContext(
        event_bus=None,
        rust_bridge=None,
        agent_name="pyrun-gate-test",
        session_id="s1",
        workspace=workspace,
        mode=AgentMode(mode),
    )


class TestPythonRiskClassification(unittest.TestCase):
    """AST 分级表（#66 判级口径的唯一真值来源）"""

    def _level(self, code: str) -> int:
        from strands_backend.tools.python_risk import analyze_python_code

        return analyze_python_code(code)["risk_l"]

    def test_exec_capable_calls_are_l4(self):
        cases = {
            "os.system": "import os\nos.system('ls')",
            "subprocess": "import subprocess\nsubprocess.run(['ls'])",
            "eval": "eval('1+1')",
            "exec": "exec('x = 1')",
            "dunder_import": "__import__('os')",
            "ctypes": "import ctypes\nctypes.CDLL('libc.so')",
            "pickle_loads": "import pickle, base64\npickle.loads(base64.b64decode(''))",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertGreaterEqual(self._level(code), 4)

    def test_delete_and_network_are_l3(self):
        cases = {
            "rmtree": "import shutil\nshutil.rmtree('build')",
            "os_remove": "import os\nos.remove('a.txt')",
            "path_unlink": "from pathlib import Path\nPath('a.txt').unlink()",
            "socket": "import socket\nsocket.socket()",
            "urlopen": "import urllib.request\nurllib.request.urlopen('http://x')",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                level = self._level(code)
                self.assertGreaterEqual(level, 3, f"{name} 至少 L3")
                self.assertLess(level, 4, f"{name} 不该顶到 L4")

    def test_write_operations_are_l2(self):
        cases = {
            "open_write": "open('a.txt', 'w').write('x')",
            "write_text": "from pathlib import Path\nPath('a.txt').write_text('x')",
            "rename": "import os\nos.rename('a', 'b')",
            "shutil_move": "import shutil\nshutil.move('a', 'b')",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertEqual(self._level(code), 2)

    def test_pure_computation_stays_low_risk(self):
        cases = {
            "json_stat": (
                "import json, glob\n"
                "rows = [json.load(open(p)) for p in glob.glob('*.json')]\n"
                "print(len(rows))"
            ),
            "regex": "import re\nprint(len(re.findall(r'\\d+', 'a1b2')))",
            "math_only": "print(sum(range(100)))",
            "read_only": "print(open('marker.txt').read())",
            "csv": "import csv\nprint(list(csv.reader([])))",
            "os_import_only": "import os\nprint(os.sep)",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertLessEqual(self._level(code), 1)

    def test_dangerous_word_inside_string_is_not_flagged(self):
        """字符串常量里的危险词不算危险动作（正则版误报的典型，AST 版必须免疫）"""
        code = "msg = '记得先 shutil.rmtree 再 os.system(\"rm -rf /\")'\nprint(msg)"
        self.assertLessEqual(self._level(code), 1)

    def test_aliased_import_still_caught(self):
        cases = {
            "import_alias": ("import os as o\no.system('ls')", 4),
            "from_alias": ("from subprocess import run as r\nr(['ls'])", 4),
            "class_alias": (
                "from pathlib import Path as P\nP('a.txt').unlink()",
                3,
            ),
        }
        for name, (code, min_level) in cases.items():
            with self.subTest(case=name):
                self.assertGreaterEqual(self._level(code), min_level)

    def test_getattr_with_dangerous_attribute_caught(self):
        self.assertGreaterEqual(
            self._level("import os\ngetattr(os, 'system')('ls')"), 4
        )
        self.assertLessEqual(self._level("import os\ngetattr(os, 'sep')"), 1)

    def test_unparseable_code_is_conservative(self):
        from strands_backend.tools.python_risk import analyze_python_code

        result = analyze_python_code("def (")
        self.assertGreaterEqual(result["risk_l"], 3)
        self.assertTrue(result["parse_error"])

    def test_summary_names_the_concrete_action(self):
        from strands_backend.tools.python_risk import analyze_python_code

        result = analyze_python_code("import shutil\nshutil.rmtree('build')")
        self.assertIn("删除", result["summary"])
        self.assertIn("shutil.rmtree", result["summary"])
        # category 决定审批卡的事实文案（与 command_impact 同一套类别名）
        self.assertEqual(result["actions"][0]["category"], "delete")


class TestPythonRunApprovalGate(unittest.TestCase):
    """审批门（mock request_approval_and_wait，不碰真实 needs_you 队列）"""

    BENIGN = "import json\nprint(json.dumps({'ok': 1}))"
    DANGEROUS = "import shutil\nshutil.rmtree('build')"

    def _invoke(self, code: str, mode: str = "confirm", service_return="APPROVED"):
        """跑一次 python_run，返回 (result, approval_mock)

        service_return: "APPROVED" / "REJECTED" / "NONE"（请求创建失败）
        """
        from strands_backend.tools import NeedsYouStatus

        outcome = {
            "APPROVED": lambda: SimpleNamespace(
                id="req-1", status=NeedsYouStatus.APPROVED, response={}
            ),
            "REJECTED": lambda: SimpleNamespace(
                id="req-2",
                status=NeedsYouStatus.REJECTED,
                response={"reason": "别删"},
            ),
            "NONE": lambda: None,
        }[service_return]
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(workspace=tmp, mode=mode)
            with patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(side_effect=lambda *a, **k: outcome()),
            ) as approval, patch(
                "strands_backend.tools.python_run.complete_approval_execution",
                new=MagicMock(),
            ) as release:
                result = invoke_python_run_tool({"code": code}, ctx)
        return result, approval, release, tmp

    def test_benign_code_runs_without_card(self):
        for mode in ("confirm", "auto"):
            with self.subTest(mode=mode):
                result, approval, _release, _tmp = self._invoke(self.BENIGN, mode)
                self.assertEqual(result["status"], "success")
                approval.assert_not_called()

    def test_high_risk_code_requests_approval_on_the_code(self):
        result, approval, _release, _tmp = self._invoke(
            self.DANGEROUS, "confirm", service_return="NONE"
        )
        approval.assert_called_once()
        args, kwargs = approval.call_args
        self.assertEqual(args[1], self.DANGEROUS)  # 卡面主体 = 代码原文
        self.assertEqual(kwargs.get("tool_name"), "python_run")
        self.assertGreaterEqual(kwargs.get("risk_l"), 3)
        self.assertEqual(result["status"], "needs_approval")
        self.assertIn("未执行", result["message"])

    def test_approval_creation_failure_fails_closed(self):
        marker = None
        with tempfile.TemporaryDirectory() as tmp:
            code = "open('boom.txt', 'w').write('x')"  # L2 → confirm 档弹卡
            ctx = make_ctx(workspace=tmp)
            with patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(return_value=None),
            ):
                result = invoke_python_run_tool({"code": code}, ctx)
            marker = Path(tmp) / "boom.txt"
            self.assertEqual(result["status"], "needs_approval")
            self.assertFalse(marker.exists(), "审批没建立就不能执行一行代码")

    def test_rejected_not_executed_and_user_reason_echoed(self):
        code = "import os\nos.makedirs('build')\nopen('build/x.txt', 'w').write('1')"
        result, _approval, _release, tmp = self._invoke(
            code, "confirm", service_return="REJECTED"
        )
        self.assertEqual(result["status"], "rejected")
        self.assertIn("别删", result["message"])
        self.assertFalse((Path(tmp) / "build").exists(), "拒绝后不能留下任何副作用")

    def test_approved_code_actually_executes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(workspace=tmp)
            code = "open('marker.txt', 'w').write('done')"  # L2：confirm 档弹卡
            with patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(
                    return_value=SimpleNamespace(
                        id="r", status=NeedsYouStatus.APPROVED, response={}
                    )
                ),
            ) as approval, patch(
                "strands_backend.tools.python_run.complete_approval_execution",
                new=MagicMock(),
            ) as release:
                result = invoke_python_run_tool({"code": code}, ctx)
            approval.assert_called_once()
            self.assertEqual(result["status"], "success")
            self.assertEqual(
                (Path(tmp) / "marker.txt").read_text(encoding="utf-8"), "done"
            )
            # A3 同类不变量：批准后的执行必须释放 execution_gate，
            # 否则该会话后续所有审批永久卡死
            release.assert_called_once()

    def test_approval_card_text_uses_real_card_helpers(self):
        """卡面文案不能是空的：用真实的卡面辅助函数吃我们传进去的载荷

        request_approval_and_wait 内部靠 _semantic_from_impact / _approval_explanation
        生成第 1、3 层；这两条是纯函数，直接拿真函数验一次，避免"类别名拼错→
        卡片只显示未知命令段"这类只有真机才看得见的缺陷。
        """
        from strands_backend.tools import _approval_explanation, _semantic_from_impact

        _result, approval, _release, _tmp = self._invoke(
            self.DANGEROUS, "confirm", service_return="NONE"
        )
        _ctx, code_arg, risk_result = approval.call_args.args
        kwargs = approval.call_args.kwargs
        self.assertEqual(risk_result["level"], "L3")
        semantic = _semantic_from_impact(kwargs["impact"])
        self.assertIn("删除", semantic)
        factual = _approval_explanation(code_arg, kwargs["impact"], kwargs["explanation"])
        self.assertIn("删除", factual)

    def test_auto_mode_still_gates_destructive_code(self):
        _result, approval, _release, _tmp = self._invoke(
            self.DANGEROUS, "auto", service_return="NONE"
        )
        approval.assert_called_once()

    def test_observe_mode_blocks_without_card(self):
        result, approval, _release, _tmp = self._invoke(
            self.DANGEROUS, "observe", service_return="NONE"
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertTrue(result["message"].startswith("command_blocked!"))
        approval.assert_not_called()

    def test_write_only_code_allowed_in_auto_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(workspace=tmp, mode="auto")
            with patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(),
            ) as approval:
                result = invoke_python_run_tool(
                    {"code": "open('o.txt', 'w').write('x')"}, ctx
                )
            approval.assert_not_called()
            self.assertEqual(result["status"], "success")

    def test_risk_assessor_failure_does_not_run_silently(self):
        """分级器抛异常 → fail-closed 按高危处理，不能退回静默执行"""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(workspace=tmp)
            with patch(
                "strands_backend.tools.python_risk.analyze_python_code",
                new=MagicMock(side_effect=RuntimeError("boom")),
            ), patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(return_value=None),
            ) as approval:
                result = invoke_python_run_tool({"code": self.BENIGN}, ctx)
            approval.assert_called_once()
            self.assertEqual(result["status"], "needs_approval")


if __name__ == "__main__":
    unittest.main()
