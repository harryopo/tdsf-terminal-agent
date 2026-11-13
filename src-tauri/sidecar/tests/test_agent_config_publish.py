"""Configuration publication must preserve the previous live model on failure."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

FAKE_OLD_KEY = "fake-" + "old-key"
FAKE_NEW_KEY = "fake-" + "new-key"


@pytest.fixture
def seeded_config(tmp_path, monkeypatch):
    import agent_facade as facade
    from core import llm_config
    from strands_backend.adapter import StrandsAgentAdapter

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    for name in (
        "TDSF_LLM_API_KEY", "TDSF_LLM_BASE_URL", "TDSF_LLM_MODEL",
        "TDSF_LLM_PROVIDER",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(facade, "_global_backend", None)
    monkeypatch.setattr(facade, "_global_strands_adapter", None)
    monkeypatch.setattr(llm_config, "_RUNTIME_CONFIG", None)

    old_config = llm_config.LLMConfig(
        provider="openai", api_key=FAKE_OLD_KEY, base_url="https://old.invalid",
        model="old-model", temperature=0.2, max_tokens=100,
    )
    llm_config.set_runtime_config(old_config)
    llm_config.save_config(old_config)
    path = llm_config._get_config_path()
    old_disk = path.read_bytes()
    old_model = object()
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=old_model,
    )
    facade.set_strands_adapter(adapter)
    state = {
        "facade": facade,
        "llm_config": llm_config,
        "adapter": adapter,
        "old_config": old_config,
        "old_model": old_model,
        "path": path,
        "old_disk": old_disk,
    }
    yield state


def _assert_old_state(state):
    assert state["llm_config"].load_config() is state["old_config"]
    assert state["path"].read_bytes() == state["old_disk"]
    assert state["adapter"].strands_model is state["old_model"]
    assert state["adapter"]._model_available is True


def _new_payload():
    return {
        "provider": "openai", "api_key": FAKE_NEW_KEY,
        "base_url": "https://new.invalid", "model": "new-model",
        "temperature": 0.4, "max_tokens": 300,
    }


def test_missing_backend_does_not_publish_or_construct_model(seeded_config, monkeypatch):
    from strands_backend import model_adapter

    calls = []
    monkeypatch.setattr(model_adapter, "create_strands_model", lambda config: calls.append(config))
    seeded_config["facade"].set_strands_adapter(None)

    result = seeded_config["facade"].configure(_new_payload())

    assert result["ok"] is False
    assert calls == []
    _assert_old_state(seeded_config)


@pytest.mark.parametrize("factory_mode", ["none", "raises"])
def test_model_factory_failure_preserves_previous_configuration(
    factory_mode, seeded_config, monkeypatch,
):
    from strands_backend import model_adapter

    def create(_config):
        if factory_mode == "raises":
            raise RuntimeError("offline fixture factory failure")
        return None

    monkeypatch.setattr(model_adapter, "create_strands_model", create)
    result = seeded_config["facade"].configure(_new_payload())

    assert result["ok"] is False
    _assert_old_state(seeded_config)


def test_save_failure_preserves_previous_runtime_and_disk(
    seeded_config, monkeypatch,
):
    from strands_backend import model_adapter

    monkeypatch.setattr(model_adapter, "create_strands_model", lambda _config: object())

    def fail_before_write(_data):
        raise OSError("fixture write boundary failure")

    monkeypatch.setattr(seeded_config["llm_config"], "_write_config_dict", fail_before_write)
    result = seeded_config["facade"].configure(_new_payload())

    assert result["ok"] is False
    _assert_old_state(seeded_config)


def test_empty_key_preserves_previous_configuration_without_factory(
    seeded_config, monkeypatch,
):
    from strands_backend import model_adapter

    calls = []
    monkeypatch.setattr(model_adapter, "create_strands_model", lambda config: calls.append(config))
    payload = _new_payload()
    payload["api_key"] = ""

    result = seeded_config["facade"].configure(payload)

    assert result["ok"] is False
    assert calls == []
    _assert_old_state(seeded_config)


def test_success_constructs_before_publish_then_updates_real_adapter(
    seeded_config, monkeypatch,
):
    from strands_backend import model_adapter

    new_model = object()
    calls = []

    def create(config):
        assert seeded_config["llm_config"].load_config() is seeded_config["old_config"]
        assert seeded_config["path"].read_bytes() == seeded_config["old_disk"]
        calls.append(config)
        return new_model

    monkeypatch.setattr(model_adapter, "create_strands_model", create)
    result = seeded_config["facade"].configure(_new_payload())

    assert result["ok"] is True
    assert result["llm_call_set"] is True
    assert len(calls) == 1
    assert seeded_config["adapter"].strands_model is new_model
    current = seeded_config["llm_config"].load_config()
    assert current is calls[0]
    assert current.model == "new-model"
    assert current.api_key == FAKE_NEW_KEY
    disk_config = json.loads(seeded_config["path"].read_text(encoding="utf-8"))
    assert disk_config["provider"] == "openai"
    assert disk_config["base_url"] == "https://new.invalid"
    assert disk_config["model"] == "new-model"
    assert disk_config["temperature"] == 0.4
    assert disk_config["max_tokens"] == 300
    assert disk_config["api_key"] == ""
