"""
strands_backend/tests/test_python_credential_read.py — 读写凭据类文件必须过审批（#158-④）
==========================================================================================

背景：#66（2026-09-19 决策 3）把「读文件」整体算成 L0 免审批，说的是读日志、读配置
做统计；但 `print(open("/root/.ssh/id_rsa").read())` 用的是同一个 `open`。#155 给
`python_run` 的 stdout 补上脱敏之后，这条链剩下的洞是**用户没机会拒绝**——内容会被
送到模型提供商那一刻已经发生了。

所以这一条只把「凭据类文件」从 L0 里拿出来按 L3（auto 档也逐条审批，与删除/联网同级），
**不改** #66 的「纯算东西不打扰」。判据两层：

1. 提级：open/Path/copy/listdir 的路径字面量指向私钥、API key 配置、/etc/shadow、
   shell 历史 ⇒ L3；审批卡要说清是「读取」还是「写入」。
2. 不放宽：普通日志/配置读取、变量拼出来的路径、只是出现在字符串里的文件名 ⇒ 仍 L0-L1。
   （第 2 组是正向配对：没有它，"整条 open 全提级" 也能让第 1 组全绿。）

运行：
    cd src-tauri/sidecar
    python -B -m pytest strands_backend/tests/test_python_credential_read.py -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.modes import AgentMode  # noqa: E402
from strands_backend.tools import ToolContext  # noqa: E402
from strands_backend.tools.python_risk import analyze_python_code  # noqa: E402


def _level(code: str) -> int:
    return analyze_python_code(code)["risk_l"]


def _kinds(code: str) -> list[str]:
    return [a["kind"] for a in analyze_python_code(code)["actions"]]


def make_ctx(workspace: str = "", mode: str = "confirm") -> ToolContext:
    return ToolContext(
        event_bus=None,
        rust_bridge=None,
        agent_name="credential-read-test",
        session_id="s1",
        workspace=workspace,
        mode=AgentMode(mode),
    )


class TestCredentialPathEscalation(unittest.TestCase):
    """凭据路径 ⇒ L3（读与写都算）"""

    def test_reading_credentials_is_l3(self):
        cases = {
            "open_tilde_ssh_key": "print(open('~/.ssh/id_rsa').read())",
            "open_abs_ssh_key": "print(open('/root/.ssh/id_ed25519').read())",
            "path_read_text": (
                "from pathlib import Path\n"
                "print(Path('/root/.ssh/id_rsa').read_text())"
            ),
            "llm_config_mirror": "print(open('.tdsf-data/llm_config.json').read())",
            "ssh_credentials_json": (
                "print(open('C:\\\\Users\\\\op\\\\.tdsf-data\\\\ssh-credentials.json')"
                ".read())"
            ),
            "etc_shadow": "print(open('/etc/shadow').read())",
            "joined_parts": (
                "import os\n"
                "print(open(os.path.join('/root', '.ssh', 'id_rsa')).read())"
            ),
            "fstring": (
                "host = 'root'\nprint(open(f'/home/{host}/.ssh/id_ecdsa').read())"
            ),
            "listdir_ssh": "import os\nprint(os.listdir(os.path.expanduser('~/.ssh')))",
            "copy_key_out": (
                "import shutil\nshutil.copy('/root/.ssh/id_rsa', '/tmp/x')"
            ),
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertGreaterEqual(_level(code), 3, f"{name} 必须进审批")

    def test_writing_credentials_is_l3(self):
        cases = {
            "open_write": "open('/root/.ssh/authorized_keys', 'w').write('ssh-rsa x')",
            "write_text": (
                "from pathlib import Path\n"
                "Path('.tdsf-data/llm_config.json').write_text('{}')"
            ),
            "mode_keyword": "open('/etc/sudoers', mode='a').write('x')",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertGreaterEqual(_level(code), 3)

    def test_card_says_read_or_write_not_both(self):
        """审批卡的动作名要分开：把「读私钥」说成「写」是把事实报反"""
        read_kinds = _kinds("print(open('/root/.ssh/id_rsa').read())")
        self.assertIn("读取凭据类文件", read_kinds)
        self.assertNotIn("写入凭据类文件", read_kinds)

        write_kinds = _kinds("open('/root/.ssh/id_rsa', 'w').write('x')")
        self.assertIn("写入凭据类文件", write_kinds)
        self.assertNotIn("读取凭据类文件", write_kinds)

    def test_reason_names_the_path(self):
        """卡面理由要带上是哪个文件——只说「凭据类文件」等于让人对着未知去批准"""
        reasons = analyze_python_code("print(open('/root/.ssh/id_rsa').read())")[
            "reasons"
        ]
        self.assertTrue(any("id_rsa" in r for r in reasons), reasons)


class TestOrdinaryReadsStayQuiet(unittest.TestCase):
    """正向配对：没被提级的读取必须仍然不打扰，否则「全提级」也能让上面那组假绿"""

    def test_ordinary_reads_stay_low(self):
        cases = {
            "log_read": "print(open('/var/log/syslog').read())",
            "json_config": "import json\nprint(json.load(open('app/config.json')))",
            "path_read_text": (
                "from pathlib import Path\nprint(Path('notes.md').read_text())"
            ),
            "history_like_name": "print(open('query_history.txt').read())",
            "ssh_word_in_other_path": "print(open('/etc/ssh/sshd_config').read())",
            "listdir_etc": "import os\nprint(os.listdir('/etc'))",
            "summarize_dir": "import os\nprint(sum(os.path.getsize(f) for f in os.listdir('.')))",
        }
        for name, code in cases.items():
            with self.subTest(case=name):
                self.assertLessEqual(_level(code), 1, f"{name} 不该被提级")

    def test_credential_name_only_in_string_is_not_flagged(self):
        """字符串里出现文件名不是「读了它」——AST 分级必须免疫这种误报（#66 的老口径）"""
        code = "tip = '私钥在 ~/.ssh/id_rsa，别删'\nprint(tip)"
        self.assertLessEqual(_level(code), 1)

    def test_variable_built_path_is_not_followed(self):
        """诚实声明的边界：路径由变量拼出来时不追数据流（模块级"已知边界"）。

        这条不是在夸能力，是把洞钉成可回归的事实——真要覆盖得做常量传播或沙箱，
        本期目标是把直白写法拉进审批。
        """
        code = "name = 'id_' + 'rsa'\npath = '/root/.ssh/' + name\nprint(open(path).read())"
        self.assertLess(_level(code), 3)

    def test_write_makes_are_untouched_by_the_new_rule(self):
        """新增判据不许把普通写入抬到 L3（那是 #66 里 confirm 档逐条、auto 档放行的层）"""
        self.assertEqual(_level("open('out.txt', 'w').write('x')"), 2)


class TestApprovalGateOnCredentialRead(unittest.TestCase):
    """端到端：auto 档也要拦下读私钥，且审批没建立/被拒时一个字节都不读"""

    CODE = "print(open('id_rsa').read())"

    def _invoke(self, mode: str, service_return: str, workspace: Path):
        from needs_you import NeedsYouStatus

        outcome = {
            "NONE": lambda: None,
            "REJECTED": lambda: SimpleNamespace(
                id="req-2",
                status=NeedsYouStatus.REJECTED,
                response={"reason": "不许读"},
            ),
        }[service_return]
        from strands_backend.tools.python_run import invoke_python_run_tool

        ctx = make_ctx(workspace=str(workspace), mode=mode)
        with patch(
            "strands_backend.tools.python_run.request_approval_and_wait",
            new=MagicMock(side_effect=lambda *a, **k: outcome()),
        ) as approval, patch(
            "strands_backend.tools.python_run.complete_approval_execution",
            new=MagicMock(),
        ):
            result = invoke_python_run_tool({"code": self.CODE}, ctx)
        return result, approval

    def test_auto_mode_asks_before_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "id_rsa").write_text("PRIVATE-KEY-SENTINEL", encoding="utf-8")
            result, approval = self._invoke("auto", "NONE", ws)
            approval.assert_called_once()
            _ctx, code_arg, risk_result = approval.call_args.args
            kwargs = approval.call_args.kwargs
            self.assertEqual(code_arg, self.CODE)
            self.assertEqual(risk_result["level"], "L3")
            self.assertEqual(kwargs.get("risk_l"), 3)
            self.assertEqual(result["status"], "needs_approval")
            # 内容一个字节都不能外送：stdout 里没有哨兵
            self.assertNotIn("PRIVATE-KEY-SENTINEL", str(result.get("stdout", "")))

    def test_rejected_read_returns_no_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "id_rsa").write_text("PRIVATE-KEY-SENTINEL", encoding="utf-8")
            result, _approval = self._invoke("confirm", "REJECTED", ws)
            self.assertEqual(result["status"], "rejected")
            self.assertIn("不许读", result["message"])
            self.assertNotIn("PRIVATE-KEY-SENTINEL", str(result))

    def test_ordinary_read_in_auto_mode_still_runs(self):
        """正向配对：auto 档读普通文件不该被这条新判据拦下来"""
        from strands_backend.tools.python_run import invoke_python_run_tool

        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "app.log").write_text("line1\nline2\n", encoding="utf-8")
            ctx = make_ctx(workspace=str(ws), mode="auto")
            with patch(
                "strands_backend.tools.python_run.request_approval_and_wait",
                new=MagicMock(),
            ) as approval:
                result = invoke_python_run_tool(
                    {"code": "print(len(open('app.log').read()))"}, ctx
                )
            approval.assert_not_called()
            self.assertEqual(result["status"], "success")
            self.assertIn("2", result["stdout"])


class TestModelManualMatchesCode(unittest.TestCase):
    """docstring 就是模型看到的说明书：代码提了级，说明书必须一起说（#155/#156 那类病）"""

    def test_python_run_docstring_mentions_credential_approval(self):
        from strands_backend.tools.python_run import make_python_run_tool

        # 模型的说明书 = 工具对象的 docstring（@tool 用 functools.wraps 带过来）
        tool_fn = make_python_run_tool(make_ctx(workspace="", mode="confirm"))
        doc = getattr(tool_fn, "__doc__", None) or getattr(
            getattr(tool_fn, "_tool_func", None), "__doc__", ""
        )
        self.assertIn("凭据", doc)
        self.assertIn("审批", doc)


if __name__ == "__main__":
    unittest.main()
