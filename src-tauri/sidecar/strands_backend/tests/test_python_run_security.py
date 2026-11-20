"""T5 回归：`python_run` 的混淆形态定级与子进程环境边界（V5）。

修复前：`getattr` / `globals()` / base64 解码可让危险调用绕过静态分级；
子进程 `env={**os.environ}` 会把父进程凭据与注入变量全部转发。
本文件只调用静态分析与环境构造函数，不执行任何被分析的代码。
"""
from __future__ import annotations

import pytest

from strands_backend.tools.python_risk import analyze_python_code
from strands_backend.tools.python_run import _minimal_subprocess_env


@pytest.mark.parametrize(
    "code",
    [
        'import os\ngetattr(os, "system")("id")',
        'import os\ngetattr(os, "sys" + "tem")("id")',
        'import os\nglobals()["os"].system("id")',
        'import os\nlocals()["os"].system("id")',
        'import base64\nbase64.b64decode("aWQ=")',
    ],
)
def test_obfuscation_at_least_l3(code: str) -> None:
    result = analyze_python_code(code)
    assert result["risk_l"] >= 3, f"混淆形态应不低于 L3：{code} → {result['risk_l']}"


def test_dunder_import_and_eval_stay_l4() -> None:
    assert analyze_python_code('__import__("os").system("id")')["risk_l"] >= 4
    assert analyze_python_code('eval("1+1")')["risk_l"] >= 4


def test_plain_string_mention_not_upgraded() -> None:
    """混淆 API 名只出现在普通字符串里，不得因此提级。"""
    result = analyze_python_code('text = "getattr(os, \'system\')"\nprint(text)')
    assert result["risk_l"] < 3


def test_pure_computation_stays_low() -> None:
    assert analyze_python_code("print(sum(range(10)))")["risk_l"] == 0


def test_minimal_env_excludes_secrets_and_injection(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-secret")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "synthetic-secret")
    monkeypatch.setenv("PYTHONPATH", "/tmp/inject")
    monkeypatch.setenv("LD_PRELOAD", "/tmp/inject.so")
    monkeypatch.setenv("PYTHONIOENCODING", "ascii")
    env = _minimal_subprocess_env()
    for key in ("OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "PYTHONPATH", "LD_PRELOAD"):
        assert key not in env, f"{key} 不应被转发给子进程"
    assert env["PYTHONIOENCODING"] == "utf-8", "父进程的同名值不得覆盖强制 UTF-8"
    assert "PATH" in env


def test_minimal_env_has_no_arbitrary_variables(monkeypatch) -> None:
    monkeypatch.setenv("TDSF_TEST_SECRET", "synthetic-secret")
    env = _minimal_subprocess_env()
    assert "TDSF_TEST_SECRET" not in env