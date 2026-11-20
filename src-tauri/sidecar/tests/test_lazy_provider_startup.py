"""Fresh-process checks for lazy provider imports and retry compatibility."""
from __future__ import annotations

import ast
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from test_reference_rpc_capabilities import _isolated_environment  # noqa: E402


_NO_NETWORK = """
import socket
def _deny_network(*args, **kwargs):
    raise AssertionError('network access is forbidden in this test')
socket.socket.connect = _deny_network
socket.socket.connect_ex = _deny_network
socket.create_connection = _deny_network
"""


def _run_fresh(tmp_path: Path, body: str) -> dict:
    data = tmp_path / "data"
    data.mkdir()
    profile = tmp_path / "profile"
    env = _isolated_environment(profile)
    for name in ("hf", "hf-cache", "transformers"):
        (tmp_path / name).mkdir()
    env.update(
        {
            "TDSF_DATA_DIR": str(data),
            "TDSF_AGENT_BACKEND": "strands",
            "TDSF_KB_AUTO_INIT": "0",
            "TDSF_SIDECAR_LOG": "ERROR",
            "HF_HOME": str(tmp_path / "hf"),
            "HF_HUB_CACHE": str(tmp_path / "hf-cache"),
            "TRANSFORMERS_CACHE": str(tmp_path / "transformers"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "OTEL_SDK_DISABLED": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    stdout_path = tmp_path / "child.stdout.txt"
    stderr_path = tmp_path / "child.stderr.txt"
    with stdout_path.open("x", encoding="utf-8") as stdout_file, stderr_path.open(
        "x", encoding="utf-8"
    ) as stderr_file:
        result = subprocess.run(
            [sys.executable, "-B", "-c", _NO_NETWORK + "\n" + textwrap.dedent(body)],
            cwd=SIDECAR,
            env=env,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
    child_stdout = stdout_path.read_text(encoding="utf-8")
    child_stderr = stderr_path.read_text(encoding="utf-8")
    assert result.returncode == 0, (
        f"fresh child exited {result.returncode}\nstdout:\n{child_stdout}\n"
        f"stderr:\n{child_stderr}"
    )
    lines = [line for line in child_stdout.splitlines() if line.strip()]
    assert lines, child_stderr
    return json.loads(lines[-1])


def test_unconfigured_start_and_retry_setup_do_not_import_provider_sdks(tmp_path):
    result = _run_fresh(
        tmp_path,
        """
        import importlib, json, sys
        from types import SimpleNamespace
        from strands_backend.model_adapter import create_strands_model
        from strands_backend.retry_policy import build_retry_policy
        assert create_strands_model(SimpleNamespace(is_configured=False)) is None
        assert build_retry_policy() is not None
        forbidden = ('openai', 'anthropic', 'litellm',
                     'strands.models.openai', 'strands.models.anthropic',
                     'strands.models.litellm')
        assert not [name for name in forbidden if name in sys.modules]
        print(json.dumps({'providers_loaded': []}))
        """,
    )
    assert result["providers_loaded"] == []


@pytest.mark.parametrize(
    ("provider", "module", "other_sdk"),
    [("openai", "strands.models.openai", "anthropic"),
     ("anthropic", "strands.models.anthropic", "openai")],
)
def test_configured_provider_loads_only_its_official_sdk(tmp_path, provider, module, other_sdk):
    result = _run_fresh(
        tmp_path,
        f"""
        import json, sys
        from types import SimpleNamespace
        from strands_backend.model_adapter import create_strands_model
        config = SimpleNamespace(
            is_configured=True, provider={provider!r}, api_key='qa-only-key',
            base_url='http://127.0.0.1:9/v1', model='qa-model',
            temperature=0.2, max_tokens=64,
        )
        model = create_strands_model(config)
        assert model is not None
        assert type(model).__module__ == {module!r}
        assert {provider!r} in sys.modules
        assert {module!r} in sys.modules
        assert {other_sdk!r} not in sys.modules
        assert 'litellm' not in sys.modules
        if {provider!r} == 'openai':
            assert model.client_args['timeout'] == 300.0
            assert model.client_args['max_retries'] == 0
            assert model.client_args['base_url'] == 'http://127.0.0.1:9/v1'
        else:
            assert model.client.timeout == 300.0
            assert model.client.max_retries == 0
            assert model.client.base_url.host == 'api.anthropic.com'
        print(json.dumps({{'provider': {provider!r}, 'model_type': type(model).__name__}}))
        """,
    )
    assert result["provider"] == provider


def test_explicit_availability_queries_discover_real_importable_providers(tmp_path):
    result = _run_fresh(
        tmp_path,
        """
        import importlib, json, sys
        from strands_backend.model_adapter import (
            get_available_providers, is_strands_models_available,
        )
        providers = get_available_providers()
        assert is_strands_models_available() is bool(providers)
        modules = {
            'openai': 'strands.models.openai',
            'anthropic': 'strands.models.anthropic',
            'litellm': 'strands.models.litellm',
        }
        expected = []
        for provider, module in modules.items():
            try:
                importlib.import_module(module)
            except ImportError:
                continue
            expected.append(provider)
        assert providers == expected
        assert 'openai' in providers
        assert 'anthropic' in providers
        print(json.dumps({'providers': providers, 'expected': expected}))
        """,
    )
    assert isinstance(result["providers"], list)


def test_provider_imports_remain_static_for_frozen_bundle_analysis():
    tree = ast.parse((SIDECAR / "strands_backend" / "model_adapter.py").read_text(encoding="utf-8"))
    imports: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imports.setdefault(node.module, set()).update(alias.name for alias in node.names)
    assert "OpenAIModel" in imports.get("strands.models.openai", set())
    assert "AnthropicModel" in imports.get("strands.models.anthropic", set())
    assert "LiteLLMModel" in imports.get("strands.models.litellm", set())


@pytest.mark.parametrize(("provider", "blocked_sdk"),
                         [("openai", "openai"), ("anthropic", "anthropic")])
def test_missing_optional_sdk_returns_none_without_provider_fallback(
    tmp_path, provider, blocked_sdk
):
    result = _run_fresh(
        tmp_path,
        f"""
        import importlib.abc, json, sys
        class _BlockOptionalSdk(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == {blocked_sdk!r} or fullname.startswith({(blocked_sdk + '.')!r}):
                    raise ModuleNotFoundError('blocked optional SDK', name=fullname)
                return None
        sys.meta_path.insert(0, _BlockOptionalSdk())
        from types import SimpleNamespace
        from strands_backend.model_adapter import create_strands_model
        config = SimpleNamespace(
            is_configured=True, provider={provider!r}, api_key='qa-only-key',
            base_url='http://127.0.0.1:9/v1', model='qa-model',
            temperature=0.2, max_tokens=64,
        )
        assert create_strands_model(config) is None
        print(json.dumps({{'provider': {provider!r}, 'result': None}}))
        """,
    )
    assert result["provider"] == provider
    assert result["result"] is None


def test_real_provider_retry_exceptions_keep_existing_classification(tmp_path):
    result = _run_fresh(
        tmp_path,
        """
        import json
        import httpx
        from strands_backend.retry_policy import ModelCallBudgetExceeded, build_retry_policy
        policy = build_retry_policy()
        import openai, anthropic
        request = httpx.Request('GET', 'http://127.0.0.1:9/')
        sdk_types = (openai, anthropic)
        for sdk in sdk_types:
            assert policy.is_retryable(sdk.APIConnectionError(request=request)) is True
            assert policy.is_retryable(sdk.APITimeoutError(request=request)) is True
            for status in (408, 429, 500, 502, 503, 504):
                response = httpx.Response(status, request=request)
                error = sdk.APIStatusError('qa status', response=response, body=None)
                assert policy.is_retryable(error) is True, (sdk.__name__, status)
            for status in (400, 401, 403, 404, 422):
                response = httpx.Response(status, request=request)
                error = sdk.APIStatusError('qa status', response=response, body=None)
                assert policy.is_retryable(error) is False, (sdk.__name__, status)
        assert policy.is_retryable(ValueError('ordinary error')) is False
        assert policy.is_retryable(ModelCallBudgetExceeded('budget')) is False
        print(json.dumps({'sdk_exception_families': ['openai', 'anthropic']}))
        """,
    )
    assert result["sdk_exception_families"] == ["openai", "anthropic"]
