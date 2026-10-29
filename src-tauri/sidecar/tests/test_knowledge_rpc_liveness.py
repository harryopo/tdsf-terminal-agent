"""Knowledge database work must not stop the real stdio control loop."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
CHILD = """
from pathlib import Path
import sys
import main
from knowledge import bundled, collections, rag, rpc
from knowledge.fts5 import KnowledgeEntry

root = Path(sys.argv[1])
rag._load_embed_model = lambda: None
bundle = rag.RagIndex(root / 'bundle.db')
bundle.close()
bundled.bundled_slim_db_path = lambda: root / 'bundle.db'
bundled.seed_bundled_slim_db = lambda: None
source = rag.RagIndex(root / 'old.db')
source.add(KnowledgeEntry(id='restore-0', source='bash-docs', title='已有中文整理',
                          content='保留原文和代码', url='old.md'), dedupe=False)
target = collections.get_library('personal')
target.add(KnowledgeEntry(id='existing-0', source='imported-docs', title='现有文档',
                          content='现有正文不可覆盖', url='existing.md'), dedupe=False)

def register(dispatcher):
    rpc.register_methods(dispatcher)
    def hold():
        target._lock.acquire()
        return {'ok': True}
    def release():
        target._lock.release()
        return {'ok': True}
    dispatcher.register('fixture.hold', hold)
    dispatcher.register('fixture.release', release)

main.register_business_methods = register
main.main()
"""


@contextmanager
def peer(tmp_path):
    env = os.environ.copy()
    env.update(TDSF_DATA_DIR=str(tmp_path / "data"), TDSF_KB_AUTO_INIT="0")
    with (tmp_path / "stderr.log").open("w", encoding="utf-8") as errors:
        process = subprocess.Popen(
            [sys.executable, "-B", "-u", "-c", CHILD, str(tmp_path)],
            cwd=SIDECAR_ROOT, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8",
        )
        messages = queue.Queue()
        pending = {}

        def read():
            for line in process.stdout:
                messages.put(json.loads(line))

        reader = threading.Thread(target=read, daemon=True)
        reader.start()

        def send(method, params, req_id):
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method,
                                           "params": params, "id": req_id}) + "\n")
            process.stdin.flush()

        def receive(key):
            while key not in pending:
                try:
                    message = messages.get(timeout=5)
                except queue.Empty:
                    pytest.fail(f"stdio control loop did not return {key!r}")
                pending[message.get("id", message.get("method"))] = message
            return pending.pop(key)

        try:
            assert receive("ready")["params"]["methods"]
            yield send, receive
            send("shutdown", {}, 99)
            assert receive(99)["result"] == {"ok": True}
            process.wait(timeout=5)
            assert process.returncode == 0
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdin.close()
            reader.join(timeout=3)
            process.stdout.close()


@pytest.mark.parametrize("method,params", [
    ("knowledge.documents", {"library": "personal"}),
    ("knowledge.recovery_preview", {}),
    ("knowledge.recovery_apply", {}),
    ("knowledge.import_docs", {"library": "personal", "files": [{"name": "new.md", "content": "# 新文档\n\n新正文"}]}),
    ("knowledge.get", {"library": "personal", "id": "existing-0"}),
    ("knowledge.get_doc", {"library": "personal", "url": "existing.md"}),
    ("knowledge.list", {"library": "personal"}),
    ("knowledge.list_files", {"library": "personal"}),
    ("knowledge.titles_zh", {"library": "personal"}),
])
def test_locked_personal_library_keeps_ping_and_status_responsive(tmp_path, method, params):
    """Hold a real RAG mutex; ping must return before the mutex is released."""
    with peer(tmp_path) as (send, receive):
        params = dict(params)
        if method == "knowledge.recovery_preview":
            params["source_path"] = str(tmp_path / "old.db")
        if method == "knowledge.recovery_apply":
            send("knowledge.recovery_preview", {"source_path": str(tmp_path / "old.db")}, 10)
            preview = receive(10)["result"]
            assert preview["counts"]["new"] == 1
            params.update(token=preview["token"], urls=["old.md"])
        send("fixture.hold", {}, 11)
        assert receive(11)["result"] == {"ok": True}
        send(method, params, 12)
        send("ping", {}, 13)
        send("status", {}, 14)
        assert receive(13)["result"]["alive"] is True
        assert "knowledge.recovery_apply" in receive(14)["result"]["methods"]
        send("fixture.release", {}, 15)
        assert receive(15)["result"] == {"ok": True}
        result = receive(12)
        assert "error" not in result, result
        if method in {"knowledge.recovery_apply", "knowledge.import_docs"}:
            assert result["result"]["imported"] == 1
            assert Path(result["result"]["backup_path"]).is_file()
        if method == "knowledge.recovery_preview":
            send("knowledge.recovery_discard", {"token": result["result"]["token"]}, 16)
            assert receive(16)["result"] == {"ok": True}
        send("knowledge.get", {"id": "existing-0", "library": "personal"}, 17)
        assert receive(17)["result"]["entry"]["content"] == "现有正文不可覆盖"


def test_preview_apply_discard_cross_worker_lifecycle(tmp_path):
    """Snapshots survive worker changes and consumed/discarded tokens stay invalid."""
    with peer(tmp_path) as (send, receive):
        path = {"source_path": str(tmp_path / "old.db")}
        send("knowledge.recovery_preview", path, 20)
        preview = receive(20)["result"]
        send("fixture.hold", {}, 21)
        assert receive(21)["result"] == {"ok": True}
        send("knowledge.documents", {"library": "personal"}, 22)
        send("knowledge.recovery_apply", {"token": preview["token"], "urls": ["old.md"]}, 23)
        send("ping", {}, 24)
        assert receive(24)["result"]["alive"] is True
        send("fixture.release", {}, 25)
        assert receive(25)["result"] == {"ok": True}
        assert "error" not in receive(22)
        imported = receive(23)["result"]
        assert imported["imported"] == 1
        assert Path(imported["source_backup_path"]).is_file()
        send("knowledge.recovery_apply", {"token": preview["token"], "urls": ["old.md"]}, 26)
        assert receive(26)["error"]["code"] == -32603
        send("knowledge.recovery_preview", path, 27)
        again = receive(27)["result"]
        assert again["counts"]["duplicate"] == 1
        send("knowledge.recovery_discard", {"token": again["token"]}, 28)
        assert receive(28)["result"] == {"ok": True}
        send("knowledge.recovery_apply", {"token": again["token"], "urls": ["old.md"]}, 29)
        assert receive(29)["error"]["code"] == -32603
        send("knowledge.get_doc", {"url": "old.md", "library": "personal"}, 30)
        assert receive(30)["result"]["content"] == "保留原文和代码"
