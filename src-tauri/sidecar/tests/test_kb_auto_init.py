"""
tests/test_kb_auto_init.py — 知识库启动自动初始化测试（TDSF 2026-08-30）
=========================================================================

覆盖 main.schedule_kb_auto_init / _kb_auto_init_worker：
1. 空库（官方源 0 条）→ 触发后台线程，逐源调 crawl_and_index（mock 计数）
2. 非空库 → 跳过（返回 None，不触发）
3. TDSF_KB_AUTO_INIT=0 → 禁用（返回 None）
4. pytest 环境默认禁用（schedule 直接返回 None——真实爬网绝不在测试跑）
5. worker 单源失败 → warning 不抛，继续其余源
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import main  # noqa: E402


@pytest.fixture
def allow_trigger(monkeypatch: pytest.MonkeyPatch) -> None:
    """放行触发路径：pytest 环境检测改为 False（模拟生产进程）"""
    monkeypatch.setattr(main, "_in_pytest_env", lambda: False)


@pytest.fixture
def fake_sources(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """mock 爬虫注册表（不碰真实 registry 的 17 源网络配置）"""
    names = ["nginx-docs", "apache-docs", "archwiki"]
    import knowledge.crawlers.registry as registry_mod

    monkeypatch.setattr(registry_mod, "list_crawlers", lambda: list(names))
    return names


class TestScheduleKbAutoInit:
    def test_empty_db_triggers_thread(self, allow_trigger, fake_sources, monkeypatch):
        """空库触发：返回线程，worker 逐源调 crawl_and_index"""
        calls: list[str] = []
        import knowledge.sources as sources_mod

        def fake_crawl(source_key: str, url=None, offline: bool = False):
            calls.append(source_key)
            assert offline is False  # 生产路径必须联网爬
            return {"added": 2, "entries": 2}

        monkeypatch.setattr(sources_mod, "crawl_and_index", fake_crawl)
        monkeypatch.setattr(main, "_official_kb_entry_count", lambda: 0)

        t = main.schedule_kb_auto_init()
        assert t is not None
        assert t.daemon
        t.join(timeout=10)
        assert not t.is_alive()
        assert calls == fake_sources  # 3 源全部触发

    def test_nonempty_db_skips(self, allow_trigger, fake_sources, monkeypatch):
        """已有官方数据 → 幂等跳过，不触发线程"""
        import knowledge.sources as sources_mod

        def fail_crawl(*a, **k):  # pragma: no cover
            raise AssertionError("must not crawl when db non-empty")

        monkeypatch.setattr(sources_mod, "crawl_and_index", fail_crawl)
        monkeypatch.setattr(main, "_official_kb_entry_count", lambda: 42)
        assert main.schedule_kb_auto_init() is None

    def test_env_switch_disables(self, allow_trigger, fake_sources, monkeypatch):
        """TDSF_KB_AUTO_INIT=0 → 禁用（即使空库也不触发）"""
        monkeypatch.setenv("TDSF_KB_AUTO_INIT", "0")
        monkeypatch.setattr(main, "_official_kb_entry_count", lambda: 0)
        assert main.schedule_kb_auto_init() is None

    def test_pytest_env_skips_by_default(self, fake_sources, monkeypatch):
        """pytest 环境（不 monkeypatch _in_pytest_env）默认禁用 → 测试不爬网"""
        monkeypatch.setattr(main, "_official_kb_entry_count", lambda: 0)
        assert main.schedule_kb_auto_init() is None

    def test_count_check_failure_skips(self, allow_trigger, monkeypatch):
        """计数检查抛异常 → 跳过不阻断（返回 None）"""

        def boom() -> int:
            raise RuntimeError("db locked")

        monkeypatch.setattr(main, "_official_kb_entry_count", boom)
        assert main.schedule_kb_auto_init() is None


class TestKbAutoInitWorker:
    def test_single_source_failure_continues(self, fake_sources, monkeypatch, caplog):
        """逐源失败 warning 不抛，其余源继续爬"""
        import logging

        calls: list[str] = []
        import knowledge.sources as sources_mod

        def flaky_crawl(source_key: str, url=None, offline: bool = False):
            calls.append(source_key)
            if source_key == "apache-docs":
                return {"added": 0, "entries": 0, "error": "http 403"}
            return {"added": 1, "entries": 1}

        monkeypatch.setattr(sources_mod, "crawl_and_index", flaky_crawl)
        with caplog.at_level(logging.WARNING, logger="sidecar.main"):
            main._kb_auto_init_worker()  # 直接同步跑 worker 体
        assert calls == fake_sources  # 失败源之后仍继续
        assert any("apache-docs" in r.message for r in caplog.records)

    def test_worker_exception_not_raised(self, fake_sources, monkeypatch, caplog):
        """crawl_and_index 抛异常 → worker 吞掉记 warning，线程不崩"""
        import logging

        import knowledge.sources as sources_mod

        def boom(source_key: str, url=None, offline: bool = False):
            raise ConnectionError("network down")

        monkeypatch.setattr(sources_mod, "crawl_and_index", boom)
        with caplog.at_level(logging.WARNING, logger="sidecar.main"):
            main._kb_auto_init_worker()  # 不应向上抛
        assert len(caplog.records) >= 3  # 3 源各一条 warning
