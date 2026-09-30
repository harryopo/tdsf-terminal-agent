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

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from knowledge.bundled import (  # noqa: E402
    BUNDLED_DB_NAME,
    bundled_slim_db_path,
    seed_bundled_slim_db,
)
from knowledge.bundled_scope import (  # noqa: E402
    BUNDLED_SOURCES,
    allowed_sources,
    disallowed_sources,
    is_bundlable,
    source_policy,
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

    2026-09-29 许可收口后条数从 660 降到 247（见 `knowledge/bundled_scope.py`），
    所以"下限"从 600 改成 200 —— 但真正的承重判据换成了下面那条**来源白名单**：
    条数只能证明"不是空库"，证明不了"带的是可分发的内容"。
    """
    db = bundled_slim_db_path()
    assert db.is_file(), f"随包精简库不存在：{db}"
    assert db.stat().st_size > 1_000_000, f"随包精简库异常小：{db.stat().st_size} B"

    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        count = int(conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0])
    finally:
        conn.close()
    assert count >= 200, f"随包精简库只有 {count} 条，不像提炼完成的库"


def test_shipped_slim_db_contains_only_bundlable_sources():
    """**许可收口的承重判据**：随包件里每一行的来源都必须是"允许再分发"的那几个。

    为什么不只数条数：随包 db 的价值就在于"别人拿到安装包得到了什么内容"。
    Redis 站点条款明文禁止再分发、Pro Git 是 CC BY-NC-SA、Arch Wiki 是 GFDL ——
    只要这些来源的行还在包里，条数与体积的判据全都是绿的。
    """
    db = bundled_slim_db_path()
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        sources = {str(r[0]) for r in conn.execute("SELECT DISTINCT source FROM entries")}
        counts = {
            str(r[0]): int(r[1])
            for r in conn.execute(
                "SELECT source, COUNT(*) FROM entries GROUP BY source"
            )
        }
    finally:
        conn.close()

    keep = allowed_sources()
    offenders = sorted(sources - keep)
    assert not offenders, (
        f"随包件里含不可分发来源 {offenders}（跑 scripts/prune_bundled_knowledge.py --write）"
    )
    # 正向配对：允许名单里的来源**确实有内容**（否则上面那条"没有越界来源"
    # 会因为"整库被清空"而通过 —— 负向断言必须配一条该发生的确实发生了）
    for source in sorted(keep):
        assert counts.get(source, 0) > 0, f"允许随包的 {source} 在库里一条都没有"


@pytest.mark.parametrize(
    "source",
    [
        "redis-docs",
        "git-docs",
        "archwiki",
        "bash-docs",
        "selinux-docs",
        "ssh-docs",
        "iptables-docs",
        "systemd-docs",
        "dnf-docs",
    ],
)
def test_each_excluded_source_is_absent_from_the_shipped_db(source: str):
    """逐个点名"这条不许在包里"。合并成一条集合断言的话，加回一个来源和加回九个
    报的是同一条红 —— 点名才看得出是哪一个回来了。"""
    db = bundled_slim_db_path()
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        n = int(
            conn.execute(
                "SELECT COUNT(*) FROM entries WHERE source = ?", (source,)
            ).fetchone()[0]
        )
    finally:
        conn.close()
    assert n == 0, f"{source} 有 {n} 条仍随包分发"


def test_shipped_db_has_no_orphan_derived_data():
    """剪枝只删 `entries` 是不够的：两张派生表也带着被删来源的痕迹。

    - `doc_titles_zh`：无主标题行 = 继续分发被删来源的页面标题；
    - `embed_cache`：存的是 content→向量，属于被删正文的衍生数据，运行时不需要它。
    """
    db = bundled_slim_db_path()
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        orphan_titles = int(
            conn.execute(
                "SELECT COUNT(*) FROM doc_titles_zh "
                "WHERE url NOT IN (SELECT url FROM entries)"
            ).fetchone()[0]
        )
        cache = int(conn.execute("SELECT COUNT(*) FROM embed_cache").fetchone()[0])
        # 三表 rowid 对齐（rag.py 那条教训：不对齐的症状是"检索回查为空"）
        entries = {int(r[0]) for r in conn.execute("SELECT rowid FROM entries")}
        fts = {int(r[0]) for r in conn.execute("SELECT rowid FROM fts_entries")}
        vec = {int(r[0]) for r in conn.execute("SELECT rowid FROM vec_entries_rowids")}
    finally:
        conn.close()
    assert orphan_titles == 0, f"doc_titles_zh 残留 {orphan_titles} 条无主标题"
    assert cache == 0, f"embed_cache 残留 {cache} 条向量缓存"
    assert fts == entries, "fts_entries 与 entries 的 rowid 不一致（检索会回查为空）"
    assert vec == entries, "vec_entries 与 entries 的 rowid 不一致（向量检索会命中空行）"


def test_notices_document_every_source_in_the_policy():
    """声明文件与判定表**不许两个主人**：随包/不随包的每个来源都要在
    `THIRD-PARTY-NOTICES.md` 里点名并带依据链接。

    这是 #158-① 那类病的反面用法：名单改了、给终端用户的声明还写旧内容，
    编译器与单测都看不见，只有"两处对齐"这条闸看得见。
    """
    notices = (
        SIDECAR_ROOT / "knowledge-bundled" / "THIRD-PARTY-NOTICES.md"
    ).read_text(encoding="utf-8")
    for s in BUNDLED_SOURCES:
        assert f"`{s.source}`" in notices, f"声明文件没点名来源 {s.source}"
    for s in BUNDLED_SOURCES:
        if s.evidence_url:
            assert (
                s.evidence_url in notices
            ), f"来源 {s.source} 的判定依据没写进声明文件：{s.evidence_url}"


def test_spec_still_ships_the_bundle():
    """防手抖：datas 里去掉 knowledge-bundled，安装包又会变成空知识库。"""
    spec = (SIDECAR_ROOT / "tdsf-sidecar.spec").read_text(encoding="utf-8")
    assert "('knowledge-bundled', 'knowledge-bundled')" in spec


def test_bundle_ships_apache_license_copy():
    license_copy = SIDECAR_ROOT / "knowledge-bundled" / "LICENSE-APACHE-2.0.txt"
    source_license = SIDECAR_ROOT.parents[1] / "LICENSE"
    notices = (
        SIDECAR_ROOT / "knowledge-bundled" / "THIRD-PARTY-NOTICES.md"
    ).read_text(encoding="utf-8")
    assert license_copy.is_file(), f"随包缺少 Apache 许可证全文：{license_copy}"
    assert license_copy.read_text(encoding="utf-8") == source_license.read_text(encoding="utf-8")
    assert "LICENSE-APACHE-2.0.txt" in notices


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


# ---------------------------------------------------------------------------
# 分发范围判定表本身（`knowledge/bundled_scope.py` 是唯一主人）
# ---------------------------------------------------------------------------


def test_scope_is_fail_closed_for_unregistered_source():
    """库里冒出没登记过的来源 ⇒ 一律**不随包**。

    登记表的默认方向必须是"没查过＝不能带"，否则以后加一个爬取源就自动进安装包，
    而那个人没查过它的许可。正向配对：登记为可分发的来源要认得。
    """
    assert is_bundlable("brand-new-crawler") is False
    assert source_policy("brand-new-crawler") is None
    assert is_bundlable("philosophy") is True


def test_scope_partitions_and_uses_known_verdicts():
    """每个来源恰好落进"可"或"不可"一边，且判定词只能是那四个（拼错一个词
    会让它既不算允许也不算剔除，静默地从随包件里消失或出现）。"""
    known = {"allow", "forbid", "copyleft", "unclear"}
    all_sources = {s.source for s in BUNDLED_SOURCES}
    assert all_sources == allowed_sources() | disallowed_sources()
    assert not (allowed_sources() & disallowed_sources())
    for s in BUNDLED_SOURCES:
        assert s.redistribution in known, f"{s.source} 的判定词不在允许的词表里：{s.redistribution}"


def test_every_third_party_verdict_carries_evidence():
    """**不许有无依据的判定**：第三方来源无论结论是"可"还是"不可"，
    都必须带一条能点开的依据 URL；自撰语料除外（它不需要外部依据）。

    为什么钉这条：这张表是给"能不能公开分发"定口径的，一句"我记得它是 CC"
    不够 —— 上一版 README 就把 Arch Wiki 记成了 CC BY-SA，实际是 GNU FDL 1.3+。
    """
    for s in BUNDLED_SOURCES:
        if s.source == "philosophy":
            continue
        assert s.evidence_url.startswith("https://"), f"{s.source} 缺依据 URL"
        assert len(s.note) >= 20, f"{s.source} 的判定说明太短，看不出依据是什么"
