"""Recovery is previewed, WAL-consistent, atomic, idempotent and non-overwriting."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import RagIndex


def add(rag, entry_id="old-0", url="old.md", body="已有中文整理\n\n```sh\nsystemctl status nginx\n```\n\n> 注意先只读核查。", source="bash-docs"):
    rag.add(KnowledgeEntry(id=entry_id, source=source, title="旧中文整理", content=body, url=url, category="sys-admin"), dedupe=False)


@pytest.fixture
def recovery_setup(tmp_path, monkeypatch):
    import knowledge.rag as rag
    import knowledge.collections as collections
    import knowledge.bundled as bundled
    from knowledge import recovery

    monkeypatch.setattr(rag, "_load_embed_model", lambda: None)
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "user"))
    monkeypatch.setattr(collections, "_indexes", {})
    monkeypatch.setattr(recovery, "_previews", {})
    builtin = RagIndex(tmp_path / "bundle.db")
    builtin.close()
    monkeypatch.setattr(bundled, "bundled_slim_db_path", lambda: tmp_path / "bundle.db")
    source = RagIndex(tmp_path / "old.db")
    target = collections.get_library("personal")
    yield recovery, source, target, tmp_path
    for preview in recovery._previews.values():
        preview["snapshot"].close()
    for index in collections._indexes.values():
        index.close()
    source.close()


def test_preview_reads_committed_wal_without_changing_source_or_target(recovery_setup):
    recovery, source, target, _ = recovery_setup
    source._conn.execute("PRAGMA journal_mode=WAL")
    add(source)
    source.upsert_titles_zh({"old.md": "服务管理中文精华"}, {"old.md": "已有摘要"})
    preview = recovery.preview_recovery(str(source.db_path))
    assert preview["documents"][0]["title"] == "服务管理中文精华"
    assert preview["documents"][0]["status"] == "new"
    assert source.count() == 1 and target.count() == 0
    result = recovery.apply_recovery(preview["token"], ["old.md"])
    assert result["imported"] == 1
    assert target.get("old-0")["content"] == source.get("old-0")["content"]
    assert target.get_doc("old.md")["summary_zh"] == "已有摘要"
    with sqlite3.connect(result["source_backup_path"]) as backup:
        assert backup.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1
    with sqlite3.connect(result["backup_path"]) as backup:
        assert backup.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0


def test_snapshot_binding_ignores_subsequent_source_edits(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source, body="预览看到的中文")
    preview = recovery.preview_recovery(str(source.db_path))
    add(source, body="预览后被改动")
    recovery.apply_recovery(preview["token"], ["old.md"])
    assert target.get("old-0")["content"] == "预览看到的中文"
    assert source.get("old-0")["content"] == "预览后被改动"


def test_recovery_is_idempotent_and_conflicting_document_is_not_overwritten(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source)
    first = recovery.preview_recovery(str(source.db_path))
    recovery.apply_recovery(first["token"], ["old.md"])
    again = recovery.preview_recovery(str(source.db_path))
    assert again["documents"][0]["status"] == "duplicate"
    assert recovery.apply_recovery(again["token"], ["old.md"])["imported"] == 0
    add(source, body="不同正文，不应覆盖")
    conflict = recovery.preview_recovery(str(source.db_path))
    assert conflict["documents"][0]["status"] == "conflict"
    original = target.get("old-0")["content"]
    assert recovery.apply_recovery(conflict["token"], ["old.md"])["conflicts"] == 1
    assert target.get("old-0")["content"] == original


def test_target_is_rechecked_after_preview_and_id_collision_is_document_atomic(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source)
    add(source, "old-1", body="第二块不可单独落入")
    preview = recovery.preview_recovery(str(source.db_path))
    add(target, "old-1", url="different-version.md", body="已有别篇文档")
    result = recovery.apply_recovery(preview["token"], ["old.md"])
    assert result["conflicts"] == 1 and result["imported"] == 0
    assert target.get("old-0") is None
    assert target.get("old-1")["url"] == "different-version.md"


def test_backup_failure_prevents_any_insert(recovery_setup, monkeypatch):
    recovery, source, target, _ = recovery_setup
    add(source)
    preview = recovery.preview_recovery(str(source.db_path))
    def fail_backup(*_args, **_kwargs):
        raise OSError("backup unavailable")
    monkeypatch.setattr(recovery, "_backup", fail_backup)
    with pytest.raises(OSError, match="backup unavailable"):
        recovery.apply_recovery(preview["token"], ["old.md"])
    assert target.count() == 0


def test_insert_exception_rolls_back_entries_and_fts(recovery_setup, monkeypatch):
    recovery, source, target, _ = recovery_setup
    add(source)
    add(source, "old-1", body="第二块")
    preview = recovery.preview_recovery(str(source.db_path))
    write = target._write_entry
    def fail_second(entry):
        if entry.id == "old-1":
            raise RuntimeError("second insert failed")
        write(entry)
    monkeypatch.setattr(target, "_write_entry", fail_second)
    with pytest.raises(RuntimeError, match="second insert failed"):
        recovery.apply_recovery(preview["token"], ["old.md"])
    assert target.count() == 0
    assert target.hybrid_search("systemctl") == []


def test_private_records_are_excluded_and_unpreviewed_urls_are_rejected(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source)
    add(source, "private", url="memory://private", source="session-memory")
    preview = recovery.preview_recovery(str(source.db_path))
    assert [doc["url"] for doc in preview["documents"]] == ["old.md"]
    with pytest.raises(ValueError, match="预览"):
        recovery.apply_recovery(preview["token"], ["memory://private"])
    assert target.count() == 0
    with pytest.raises(ValueError, match="预览"):
        recovery.apply_recovery("unknown-token", ["old.md"])


def test_arbitrary_sqlite_and_relative_paths_are_not_accepted(recovery_setup):
    recovery, _, target, tmp_path = recovery_setup
    unrelated = tmp_path / "unrelated.db"
    with sqlite3.connect(unrelated) as conn:
        conn.execute("CREATE TABLE notes(body TEXT)")
    with pytest.raises(ValueError, match="知识库"):
        recovery.preview_recovery(str(unrelated))
    with pytest.raises(ValueError, match="绝对路径"):
        recovery.preview_recovery("relative.db")
    assert target.count() == 0


def test_different_version_and_translated_content_are_preserved(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source, "v1-0", url="v1/index.html", body="First version")
    add(source, "v2-0", url="v2/index.html", body="Second version")
    source.update_content_zh("v2-0", "已存在的中文译文")
    preview = recovery.preview_recovery(str(source.db_path))
    result = recovery.apply_recovery(preview["token"], ["v1/index.html", "v2/index.html"])
    assert result["imported"] == 2
    assert target.get("v2-0")["content_zh"] == "已存在的中文译文"
    assert {row["url"] for row in target.list_files()} == {"v1/index.html", "v2/index.html"}


def test_markdown_import_is_personal_and_same_name_conflict_is_reported(recovery_setup):
    recovery, _, target, _ = recovery_setup
    first = recovery.import_personal_docs([{"name": "notes.md", "content": "# 笔记\n\n已有个人整理"}])
    assert first["imported"] == 1
    again = recovery.import_personal_docs([{"name": "notes.md", "content": "# 笔记\n\n已有个人整理"}])
    assert again["duplicate"] == 1
    conflict = recovery.import_personal_docs([{"name": "notes.md", "content": "# 笔记\n\n不同正文"}])
    assert conflict["conflicts"] == 1
    assert "已有个人整理" in target.get_doc("notes.md")["content"]
    rejected = recovery.import_personal_docs([{"name": "notes.exe", "content": "not markdown"}])
    assert rejected["rejected"] == ["notes.exe"]


def test_existing_builtin_document_is_referenced_not_imported_twice(recovery_setup):
    recovery, source, target, tmp_path = recovery_setup
    add(source)
    builtin = RagIndex(tmp_path / "bundle.db")
    add(builtin)
    builtin.close()
    preview = recovery.preview_recovery(str(source.db_path))
    assert preview["documents"][0]["status"] == "builtin"
    result = recovery.apply_recovery(preview["token"], ["old.md"])
    assert result["duplicate"] == 1 and result["imported"] == 0
    assert target.count() == 0


def test_expired_or_cancelled_preview_cannot_write(recovery_setup):
    recovery, source, target, _ = recovery_setup
    add(source)
    preview = recovery.preview_recovery(str(source.db_path))
    recovery._previews[preview["token"]]["created"] -= 601
    with pytest.raises(ValueError, match="预览已过期"):
        recovery.apply_recovery(preview["token"], ["old.md"])
    second = recovery.preview_recovery(str(source.db_path))
    recovery.discard_recovery(second["token"])
    with pytest.raises(ValueError, match="预览不存在"):
        recovery.apply_recovery(second["token"], ["old.md"])
    assert target.count() == 0


def test_network_source_is_rejected_before_any_path_resolution(recovery_setup, monkeypatch):
    recovery, _, target, _ = recovery_setup
    def no_filesystem(*_args, **_kwargs):
        raise AssertionError("network path must not reach filesystem")
    monkeypatch.setattr(Path, "resolve", no_filesystem)
    with pytest.raises(ValueError, match="本机"):
        recovery.preview_recovery("//qa-unreachable-share/knowledge/old.db")
    assert target.count() == 0
