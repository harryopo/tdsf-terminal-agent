"""#156 安全复查：sidecar 自己直调 LLM 的两条路必须认同一个端点主人。

判据来源（2026-09-26 推送前安全复查）：`core.llm_config._resolve_base_url` 是
「配置的 provider → 该走哪个 URL」的唯一主人（显式 base_url 优先，已知国产
provider 回退官方端点）。但 `long_context._llm_summarize` 与
`session_memory._llm_complete` 两条 OpenAI 兼容直调都写成
`config.base_url or "https://api.openai.com/v1"`——base_url 一空就发 OpenAI
官方域，配了 zhipu/dashscope/moonshot 而没填 base_url 时把 api_key 送给
api.openai.com。更糟的是 `session_memory` 的 docstring 自称"base_url 走
llm_config._resolve_base_url"，注释撒了谎（同 #144「注释里的承诺也是要验的资产」）。

四条判据：
1+2 行为——两条路各自在 provider=zhipu + 空 base_url 下打到国产端点，且 key 随的是那一个请求
3   横扫——任何直拼 /chat/completions 的文件都必须引用主人
4   注释与实现对齐（session_memory 的承诺这次是真的）
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[1]


class _FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def _capture_urlopen(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """把 urllib.request.urlopen 换成记录器，返回 {url, headers}。"""
    seen: dict[str, object] = {}
    body = json.dumps({"choices": [{"message": {"content": "摘要"}}]}).encode("utf-8")

    def fake_urlopen(req, timeout=None):  # noqa: ANN001
        seen["url"] = req.full_url
        seen["headers"] = dict(req.header_items())
        return _FakeResponse(body)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    return seen


def _zhipu_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """provider 已知、base_url 留空——这正是旧代码会打错域的那一格。"""
    from core.llm_config import LLMConfig

    cfg = LLMConfig(provider="zhipu", api_key="sk-test-key-abcdef", base_url="", model="glm-4")
    monkeypatch.setattr("core.llm_config.load_config", lambda: cfg)


def test_session_memory_uses_the_resolved_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    import session_memory

    _zhipu_config(monkeypatch)
    seen = _capture_urlopen(monkeypatch)

    summary = session_memory._llm_complete("把这段总结一下", max_tokens=64)

    assert summary == "摘要"
    url = str(seen["url"])
    assert url.startswith("https://open.bigmodel.cn/api/paas/v4/"), url
    assert "api.openai.com" not in url
    # 正向配对：key 确实带在这个请求上（不是整个请求没发出去而"看起来没泄露"）
    assert seen["headers"].get("Authorization") == "Bearer sk-test-key-abcdef"


def test_long_context_uses_the_resolved_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    from long_context import LongContextManager

    _zhipu_config(monkeypatch)
    seen = _capture_urlopen(monkeypatch)

    out = LongContextManager(enabled=True)._llm_summarize("原始长文本" * 10, max_tokens=64)

    assert out is not None and out.endswith("摘要"), out
    url = str(seen["url"])
    assert url.startswith("https://open.bigmodel.cn/api/paas/v4/"), url
    assert "api.openai.com" not in url


def test_any_direct_chat_completion_url_goes_through_the_owner() -> None:
    """横扫同类：任何直拼 /chat/completions 的源文件都必须引用端点主人。

    只读扫描、不执行；venv / 测试 / node_modules 整片剪掉（上一版没剪 .release-venv，
    把 site-packages 里 openai SDK 自己的文件也算成违规，扫到 20 万文件跑了 54 秒）。
    """
    import os

    PRUNE = {"node_modules", "site-packages", "__pycache__", ".venv", ".release-venv"}
    offenders: list[str] = []
    for root, dirnames, filenames in os.walk(SIDECAR):
        rel_parts = Path(root).relative_to(SIDECAR).parts
        dirnames[:] = [
            d
            for d in dirnames
            if d not in PRUNE and not d.endswith("-venv") and d != "tests"
        ]
        if "tests" in rel_parts:
            dirnames[:] = []
            continue
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = Path(root) / name
            text = path.read_text(encoding="utf-8", errors="replace")
            if "chat/completions" not in text:
                continue
            if "_resolve_base_url" not in text:
                offenders.append(path.relative_to(SIDECAR).as_posix())

    assert offenders == [], (
        f"这些文件直拼了 /chat/completions 却没引用主人 _resolve_base_url：{offenders}"
        "（后果：base_url 留空时把 api_key 发给 api.openai.com）"
    )


def test_session_memory_docstring_promise_matches_code() -> None:
    """注释承诺走 _resolve_base_url ⇒ 代码必须真的走（注释也是待验资产，#144）。"""
    src = (SIDECAR / "session_memory.py").read_text(encoding="utf-8")
    assert re.search(r"llm_config import .*_resolve_base_url", src), (
        "session_memory 的 docstring 说 base_url 走 _resolve_base_url，代码没引进主人"
    )
    assert re.search(r"_resolve_base_url\(", src), "引进了主人却没调用"
