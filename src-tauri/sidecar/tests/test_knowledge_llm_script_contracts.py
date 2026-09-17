"""Offline smoke tests for the three knowledge-maintenance LLM callers."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load(name: str):
    path = ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _FakeLLM:
    def __init__(self, reply: str):
        self.reply = reply
        self.calls: list[list[dict[str, str]]] = []

    def __call__(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        return self.reply


def test_distill_uses_sync_messages_to_string_callable_without_network():
    script = _load("distill_knowledge")
    llm = _FakeLLM("Short summary.")
    source = "An original explanation with enough factual context. " * 4
    result = script._distill_single(llm, source)
    assert result == llm.reply
    assert len(llm.calls) == 1
    assert [m["role"] for m in llm.calls[0]] == ["system", "user"]


def test_translate_uses_sync_messages_to_string_callable_without_network():
    script = _load("translate_knowledge")
    source = "A short technical explanation."
    llm = _FakeLLM("一段简短的技术说明。")
    result = script._translate_single(llm, {"id": "1", "content": source})
    assert result == llm.reply
    assert len(llm.calls) == 1
    assert [m["role"] for m in llm.calls[0]] == ["system", "user"]


def test_generate_titles_main_uses_callable_and_fake_in_memory_rag(monkeypatch):
    script = _load("gen_titles_zh")
    llm = _FakeLLM(json.dumps({"0": {"t": "中文标题", "s": "摘要"}}))

    class FakeRag:
        db_path = ":memory:"

        def list_files(self, **_kwargs):
            return [
                {
                    "url": "https://example.test/doc",
                    "title0": "Original title",
                    "source": "nginx-docs",
                }
            ]

        def titles_zh(self):
            return []

        def get_doc(self, _url):
            return {"content": "source"}

        def upsert_titles_zh(self, mapping, summaries):
            assert mapping == {"https://example.test/doc": "中文标题"}
            assert summaries == {"https://example.test/doc": "摘要"}
            return 1

    core_llm = types.ModuleType("core.llm_config")
    core_llm.load_config = lambda: object()
    core_llm.make_llm_call = lambda _config: llm
    rag_module = types.ModuleType("knowledge.rag")
    rag_module.get_global_rag = FakeRag
    monkeypatch.setitem(sys.modules, "core.llm_config", core_llm)
    monkeypatch.setitem(sys.modules, "knowledge.rag", rag_module)

    assert script.main([]) == 0
    assert len(llm.calls) == 1
    assert [m["role"] for m in llm.calls[0]] == ["system", "user"]
