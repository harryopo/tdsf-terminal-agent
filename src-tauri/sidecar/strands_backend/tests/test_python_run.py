"""
strands_backend/tests/test_python_run.py — python_run 工具单元测试（T5）
=========================================================================

覆盖内容（spec add-agent-loop-closure Task 5，无沙箱版）：
1. 正常执行：print 输出捕获（stdout / exit_code=0 / status=success）
2. exit_code 非零：status=error + exit_code + stderr（"失败返回 exit_code+stderr"）
3. stderr 捕获：exit_code=0 但 stderr 有内容（警告通道不影响 success）
4. 超时 kill：timeout 短版触发 TimeoutExpired → status=timeout、子进程被终止
5. 输出截断：stdout 超 10KB → truncated=true + 原始长度（stdout_full_len）
6. cwd 锁定：subprocess 工作目录 = ctx.workspace（相对路径读写验证）
7. fail-closed：code 缺失 / 空 code / SSH 会话 / 无 workspace → error 未执行
8. 三模式可见性：readonly=False → observe/L1 只读集合不含 python_run
   （schema 级裁剪）；confirm/auto 全量可见

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_python_run.py -v
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

# 确保能 import strands_backend（对齐 test_tools.py 的 sys.path 处理）
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.tools import (
    ToolContext,
    filter_tools_readonly,
    make_all_ops_tools,
)
from strands_backend.tools.python_run import (
    MAX_OUTPUT_CHARS,
    invoke_python_run_tool,
    make_python_run_tool,
)
from strands_backend.tools.registry import (
    READONLY_TOOL_NAMES,
    TOOL_REGISTRY,
    get_tool_policy,
)


def make_ctx(
    workspace: str = "",
    ssh_session_id: str = "",
    permission_level: int = 2,
) -> ToolContext:
    """构建测试用 ToolContext（event_bus=None 跳过事件推送）"""
    return ToolContext(
        event_bus=None,
        rust_bridge=None,
        agent_name="python-run-test",
        session_id="s1",
        ssh_session_id=ssh_session_id,
        permission_level=permission_level,
        workspace=workspace,
    )


class TestPythonRunExecution(unittest.TestCase):
    """核心执行路径（真实 subprocess，本地 python 解释器）"""

    def test_print_output_captured(self):
        """正常执行：print 输出捕获，exit_code=0，status=success"""
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": "print('hello-python-run')"}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello-python-run", result["stdout"])
        self.assertFalse(result["truncated"])
        self.assertIsInstance(result["duration_ms"], int)
        self.assertGreaterEqual(result["duration_ms"], 0)

    def test_nonzero_exit_code(self):
        """exit_code 非零：status=error + exit_code 透传（失败返回 exit_code）"""
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": "import sys; sys.exit(3)"}, ctx
        )
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["exit_code"], 3)
        self.assertIn("退出码 3", result.get("message", ""))

    def test_stderr_captured(self):
        """stderr 捕获：脚本写 stderr（退出码仍 0 → success）"""
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": "import sys; print('warn-to-stderr', file=sys.stderr)"}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("warn-to-stderr", result["stderr"])

    def test_failure_returns_exit_code_and_stderr(self):
        """脚本抛异常：traceback 进 stderr + 非零 exit_code（fail 结构完整）"""
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": "raise ValueError('boom-marker')"}, ctx
        )
        self.assertEqual(result["status"], "error")
        self.assertNotEqual(result["exit_code"], 0)
        self.assertIn("boom-marker", result["stderr"])

    def test_timeout_killed(self):
        """超时 kill：sleep 超过短 timeout → status=timeout、子进程被终止

        timeout 经 params 传入（invoke 层夹取 [1,30]，@tool 签名不暴露）；
        subprocess.run 内部 kill 子进程后抛 TimeoutExpired。
        """
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": "import time; time.sleep(30)", "timeout": 1}, ctx
        )
        self.assertEqual(result["status"], "timeout")
        self.assertIsNone(result["exit_code"])
        # 至少跑了约 1s 才被 kill（防"根本没执行"的假超时）
        self.assertGreaterEqual(result["duration_ms"], 900)
        self.assertIn("终止", result["message"])

    def test_output_truncated(self):
        """输出截断：stdout 超 10KB → 截断到上限 + truncated=true + 原始长度"""
        ctx = make_ctx(workspace=os.getcwd())
        result = invoke_python_run_tool(
            {"code": f"print('x' * {MAX_OUTPUT_CHARS * 2})"}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["truncated"])
        # 截断到精确上限（10KB 按字符计）
        self.assertEqual(len(result["stdout"]), MAX_OUTPUT_CHARS)
        # 原始长度 = 2*MAX + 换行符
        self.assertEqual(result["stdout_full_len"], MAX_OUTPUT_CHARS * 2 + 1)
        self.assertEqual(result["stderr_full_len"], 0)

    def test_cwd_locked_to_workspace(self):
        """cwd 锁定：子进程工作目录 = ctx.workspace（相对路径可读 marker 文件）"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "marker.txt"
            marker.write_text("cwd-ok", encoding="utf-8")
            ctx = make_ctx(workspace=tmp)
            result = invoke_python_run_tool(
                {"code": "print(open('marker.txt').read())"}, ctx
            )
            self.assertEqual(result["status"], "success")
            self.assertIn("cwd-ok", result["stdout"])
            # 双保险：getcwd 直接对比（normcase 消除 Windows 大小写差异）
            result2 = invoke_python_run_tool(
                {"code": "import os; print(os.getcwd())"}, ctx
            )
            self.assertEqual(
                os.path.normcase(result2["stdout"].strip()),
                os.path.normcase(str(tmp)),
            )


class TestPythonRunFailClosed(unittest.TestCase):
    """fail-closed 路径（参数/环境拒绝 → error，未执行任何代码）"""

    def test_missing_code(self):
        """code 参数缺失 → error"""
        result = invoke_python_run_tool({}, make_ctx(workspace=os.getcwd()))
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["exit_code"])
        self.assertIn("code", result["message"])

    def test_empty_code(self):
        """空 code（纯空白）→ error"""
        result = invoke_python_run_tool(
            {"code": "   \n\t "}, make_ctx(workspace=os.getcwd())
        )
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["exit_code"])

    def test_ssh_session_rejected(self):
        """SSH 会话 → error（本期仅本地工作区，不静默错跑在别的机器）"""
        ctx = make_ctx(workspace=os.getcwd(), ssh_session_id="5")
        result = invoke_python_run_tool({"code": "print('should-not-run')"}, ctx)
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["stdout"], "")
        self.assertIn("本地", result["message"])

    def test_no_workspace_rejected(self):
        """workspace 不可得 → error（不臆测目录）"""
        ctx = make_ctx(workspace="")
        result = invoke_python_run_tool({"code": "print('should-not-run')"}, ctx)
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["stdout"], "")
        self.assertIn("工作区", result["message"])


class TestPythonRunVisibility(unittest.TestCase):
    """三模式可见性（observe/L1 schema 级裁剪；confirm/auto 全量）"""

    def test_policy_registered(self):
        """registry 注册：readonly=False / needs_approval=False（T5 拍板）"""
        policy = get_tool_policy("python_run")
        self.assertIsNotNone(policy)
        self.assertFalse(policy.readonly)
        self.assertFalse(policy.needs_approval)

    def test_not_in_readonly_set(self):
        """observe 只读集合不含 python_run（readonly=False → schema 裁剪）"""
        self.assertIn("python_run", TOOL_REGISTRY)
        self.assertNotIn("python_run", READONLY_TOOL_NAMES)

    def test_filtered_out_by_readonly_filter(self):
        """filter_tools_readonly（observe/L1 单一真源）裁掉 python_run"""
        def python_run_stub():
            pass

        python_run_stub.__name__ = "python_run"
        self.assertEqual(filter_tools_readonly([python_run_stub]), [])

    def test_full_toolset_contains_python_run(self):
        """confirm/auto（全量工具集）含 python_run；L1 权限下被裁剪"""
        ctx = make_ctx(workspace=os.getcwd())
        names = {getattr(t, "__name__", "") for t in make_all_ops_tools(ctx)}
        self.assertIn("python_run", names)

        ctx_l1 = make_ctx(workspace=os.getcwd(), permission_level=1)
        names_l1 = {
            getattr(t, "__name__", "") for t in make_all_ops_tools(ctx_l1)
        }
        self.assertNotIn("python_run", names_l1)

    def test_factory_returns_named_callable(self):
        """工厂产物 __name__ == 注册名（白名单过滤依赖此不变量）"""
        tool_fn = make_python_run_tool(make_ctx(workspace=os.getcwd()))
        self.assertTrue(callable(tool_fn))
        self.assertEqual(getattr(tool_fn, "__name__", ""), "python_run")

    def test_system_prompt_mentions_python_run(self):
        """系统提示含 python_run 用途指引（T5.3）"""
        from strands_backend.adapter import _DEFAULT_SYSTEM_PROMPT

        self.assertIn("python_run(code)", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("优于逐工具往返", _DEFAULT_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
