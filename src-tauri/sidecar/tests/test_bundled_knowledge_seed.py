"""
tests/test_bundled_knowledge_seed.py — 随包知识库播种（#166 ⑥，2026-09-29）

背景：发布版知识库是空的。三段断链 ——
① 打包侧 `tdsf-sidecar.spec` 的 datas 里没有任何 .db（`rag_slim.db` 躺在 gitignore 的
   `.tdsf-data/`）；② 运行侧 frozen 的数据根是**用户可写目录**，就算打进包里也不会去读；
③ 初始化侧只爬**全量库**，精简库空时只打一条 warning，而前端与 agent 检索**主读精简库**。
所以"随包装"必须同时补上打包、播种、以及"缺件就构建失败"的闸。

这里钉住的是播种与接线；**随包那份 db 用真件复测**（打开它、数它有多少条），
不用合成样本 —— 合成 db 会让"包里带的是个空库"这种事故一路绿灯。
"""

from __future__ import annotations

import ast
import sqlite3
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from knowledge.bundled import (  # noqa: E402
    BUNDLED_DB_NAME,
    bundled_slim_db_path,
    seed_bundled_slim_db,
)


def _write_fake_bundle(tmp_path: Path, payload: bytes = b"kb-bytes") -> Path:
    """造一份"包里带的"库，并把 bundled_slim_db_path 指过去。"""
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    src = bundle_dir / BUNDLED_DB_NAME
    src.write_bytes(payload)
    return src


# ---------------------------------------------------------------------------
# 行为
# ---------------------------------------------------------------------------


def test_seeds_once_and_bytes_are_identical(tmp_path: Path, monkeypatch):
    """目标不存在 → 播种一份，且**逐字节等于随包那份**（正向配对：只断"文件出现了"
    会让"复制了个空文件"也通过）。"""
    src = _write_fake_bundle(tmp_path, b"kb-bytes-123")
    monkeypatch.setattr(
        "knowledge.bundled.bundled_slim_db_path", lambda: src, raising=True
    )
    data_dir = tmp_path / "data"

    assert seed_bundled_slim_db(data_dir) == 1
    target = data_dir / BUNDLED_DB_NAME
    assert target.read_bytes() == b"kb-bytes-123"


def test_never_overwrites_an_existing_user_db(tmp_path: Path, monkeypatch):
    """用户自己重跑过提炼脚本 → 升级安装一个字都不许动他的库。"""
    src = _write_fake_bundle(tmp_path, b"shipped")
    monkeypatch.setattr(
        "knowledge.bundled.bundled_slim_db_path", lambda: src, raising=True
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    target = data_dir / BUNDLED_DB_NAME
    target.write_bytes(b"user-regenerated")

    assert seed_bundled_slim_db(data_dir) == 0
    assert target.read_bytes() == b"user-regenerated"


def test_missing_bundle_is_not_fatal(tmp_path: Path, monkeypatch, caplog):
    """包里没带文件（比如有人删了 datas）→ 只告警、不抛、不建半个文件。"""
    monkeypatch.setattr(
        "knowledge.bundled.bundled_slim_db_path",
        lambda: tmp_path / "nowhere" / BUNDLED_DB_NAME,
        raising=True,
    )
    data_dir = tmp_path / "data"

    with caplog.at_level("WARNING"):
        assert seed_bundled_slim_db(data_dir) == 0
    assert not (data_dir / BUNDLED_DB_NAME).exists()
    assert "knowledge-bundled" in caplog.text


def test_copy_failure_leaves_no_partial_file(tmp_path: Path, monkeypatch):
    """复制中途失败：目标不许出现"半份 db"（sqlite 会把残缺文件当合法库打开，
    再留下 -wal/-shm 更难收拾），临时文件也必须清掉。"""
    src = _write_fake_bundle(tmp_path, b"shipped")
    monkeypatch.setattr(
        "knowledge.bundled.bundled_slim_db_path", lambda: src, raising=True
    )

    def boom(_a, _b):
        raise OSError("disk full")

    monkeypatch.setattr("knowledge.bundled.shutil.copyfile", boom, raising=True)
    data_dir = tmp_path / "data"

    assert seed_bundled_slim_db(data_dir) == 0
    assert not (data_dir / BUNDLED_DB_NAME).exists()
    assert not (data_dir / f"{BUNDLED_DB_NAME}.seed-tmp").exists()


# ---------------------------------------------------------------------------
# 随包那份 db 是真件（不是合成样本）
# ---------------------------------------------------------------------------


def test_shipped_slim_db_is_real_and_not_empty():
    """随包文件必须存在、体积有下限、**打开来数得到条目**。

    判据基准与运行时同一条链路：`knowledge.rag._slim_db_path()` 用的是
    `<TDSF_DATA_DIR>/rag_slim.db`，播种只是把它换个位置，schema 完全同源。
    """
    db = bundled_slim_db_path()
    assert db.is_file(), f"随包精简库不存在：{db}"
    assert db.stat().st_size > 5_000_000, f"随包精简库异常小：{db.stat().st_size} B"

    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        count = int(conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0])
    finally:
        conn.close()
    assert count >= 600, f"随包精简库只有 {count} 条，不像提炼完成的库"


def test_spec_still_ships_the_bundle():
    """防手抖：datas 里去掉 knowledge-bundled，安装包又会变成空知识库。"""
    spec = (SIDECAR_ROOT / "tdsf-sidecar.spec").read_text(encoding="utf-8")
    assert "('knowledge-bundled', 'knowledge-bundled')" in spec


def test_main_seeds_before_ready_notification():
    """接线：播种必须排在 ready 通知**之前**（ready 一到前端就可能去查知识库）。

    两条自己撞出来的规矩：
    - 顺序类判据一律走 AST 取真实调用行号 —— `src.index(...)` 会命中注释里的同名文字，
      把正确顺序判成反的（#158-③ / #158-① 同一课犯过两次）；
    - 而且**要限定在 `main()` 函数体内**：`send_notification` 在文件更早处就有别的调用
      （第一版就取到了 302 行那个，把正确顺序判成"播种排在后面"）。
    """
    tree = ast.parse((SIDECAR_ROOT / "main.py").read_text(encoding="utf-8"))
    mains = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    ]
    assert mains, "main.py 里找不到 main() 函数"

    lines: dict[str, int] = {}
    for node in ast.walk(mains[0]):
        if isinstance(node, ast.Call):
            fn = node.func
            name = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if name in {"seed_bundled_slim_db", "send_notification"}:
                lines.setdefault(name, node.lineno)
    assert "seed_bundled_slim_db" in lines, "main() 里没有播种调用"
    assert "send_notification" in lines, "main() 里找不到 ready 通知调用"
    assert lines["seed_bundled_slim_db"] < lines["send_notification"]
