"""随包知识库的**分发范围**（#166 ⑥ 的许可收口，2026-09-29）

为什么需要这个模块：`knowledge-bundled/rag_slim.db` 会进公开仓库并随安装包分发，
而库里的条目来自十多个上游站点，各自的授权差别极大 —— 有的明文禁止再分发，有的要求
以相同许可共享（与 Apache-2.0 冲突），有的整站找不到任何许可授予。
**"能不能随包分发"是一个有唯一主人的判断**，不能散在 README 的一句话和某次脚本里。

三条约定：
1. 判据与剪枝脚本都从这里取名单，**上游许可变了只改这一处**；
2. 每个来源都要带**可点开的依据 URL**（没有依据的判断不进这张表）；
3. 未列入 `redistribution="allow"` 的来源一律**不随包**（"没找到许可"＝未获授权，
   与"找到宽松许可"不是同一档；这一条是 fail-closed 的方向）。

`redistribution` 三档：
- `allow`   —— 许可证允许再分发（含商业），只要履行署名/附声明义务
- `forbid`  —— 上游条款明文禁止再分发/转载
- `copyleft`—— 允许再分发但要求衍生作品以同一许可共享（FDL / CC BY-SA / CC BY-NC-SA），
              与本仓库 Apache-2.0 的口径冲突 ⇒ 同样不随包，除非将来单独按原许可发布这部分内容
- `unclear` —— 站点与发行包里都找不到覆盖**文档文字**的许可授予 ⇒ 不随包

依据是 2026-09-29 逐源核对的结果（多处直接抓页脚/条款原文；未能确证的项在 note 里写明）。
"""
from __future__ import annotations

from dataclasses import dataclass

BUNDLED_DB_NAME = "rag_slim.db"


@dataclass(frozen=True)
class BundledSource:
    """一个上游来源的分发判定。字段含义见模块 docstring。"""

    source: str
    license_name: str
    redistribution: str
    obligation: str
    evidence_url: str
    note: str = ""


# 自撰教学语料：作者是本项目，随包分发无第三方义务
SELF_AUTHORED = "philosophy"

BUNDLED_SOURCES: tuple[BundledSource, ...] = (
    BundledSource(
        source=SELF_AUTHORED,
        license_name="本项目自撰（Apache-2.0 仓库内）",
        redistribution="allow",
        obligation="无（自撰）",
        evidence_url="",
        note="Linux 哲学与命令对照教学语料，随源码分发在 knowledge/philosophy/",
    ),
    BundledSource(
        source="apache-docs",
        license_name="Apache License 2.0",
        redistribution="allow",
        obligation="保留版权与许可声明、随分发附许可（见 THIRD-PARTY-NOTICES.md）",
        evidence_url="https://httpd.apache.org/docs/2.4/",
        note="Apache HTTP Server 项目文档页脚声明 Apache License 2.0",
    ),
    BundledSource(
        source="docker-docs",
        license_name="Apache License 2.0",
        redistribution="allow",
        obligation="保留版权与许可声明、随分发附许可",
        evidence_url="https://raw.githubusercontent.com/docker/docs/main/README.md",
        note='docs.docker.com 源码仓库 README："Copyright 2013-2026 Docker, Inc., '
        'released under the Apache 2.0 license"',
    ),
    BundledSource(
        source="kubernetes-docs",
        license_name="CC BY 4.0（仅文档；代码为 Apache-2.0）",
        redistribution="allow",
        obligation='署名 "The Kubernetes Authors" + 指向许可 + 标注已修改；'
        "另受 Linux 基金会商标政策约束（不得暗示官方背书）",
        evidence_url="https://kubernetes.io/docs/home/",
        note="页脚原文：Documentation Distributed under CC BY 4.0（无 NC、无 SA）",
    ),
    BundledSource(
        source="firewalld-docs",
        license_name="The Unlicense（公共领域奉献）",
        redistribution="allow",
        obligation="无",
        evidence_url="https://firewalld.org/documentation/",
        note="站点原文：All website content subject to the Unlicense",
    ),
    # ---- 以下一律**不**随包分发 -------------------------------------------------
    BundledSource(
        source="redis-docs",
        license_name="未授予许可（网站条款保留全部权利）",
        redistribution="forbid",
        obligation="不适用 —— 禁止再分发",
        evidence_url="https://redis.io/legal/redis-website-terms-of-use/",
        note="条款 §7 原文：You may not modify, alter, republish, redistribute, resend, "
        "sell or broadcast any material on this Site … without our prior written "
        "permission；内容仅限 personal use or internal company use",
    ),
    BundledSource(
        source="git-docs",
        license_name="Pro Git 书：CC BY-NC-SA 3.0；man 页：Debian 记 GPL-2",
        redistribution="copyleft",
        obligation="不适用 —— SA 要求衍生作品仍以同要素 CC 共享",
        evidence_url="https://git-scm.com/book/en/v2",
        note="书站原文：All content is licensed under the Creative Commons "
        "Attribution Non Commercial Share Alike 3.0 license ⇒ NC + SA 双重限制，"
        "与 Apache-2.0 仓库口径直接冲突",
    ),
    BundledSource(
        source="archwiki",
        license_name="GNU FDL 1.3 or later（无不变章节/封面文字）",
        redistribution="copyleft",
        obligation="要求随分发附许可全文、保留全部版权声明、声明本作品适用该许可，"
        "且 Modified Version 必须以同一许可共享（另有透明副本要求）",
        evidence_url="https://wiki.archlinux.org/title/ArchWiki:Copyrights",
        note="页脚原文：Content is available under GNU Free Documentation License "
        '1.3 or later unless otherwise noted。**修正：先前记成"CC BY-SA"是错的**',
    ),
    BundledSource(
        source="bash-docs",
        license_name="GNU FDL 1.3+（参考手册 bashref）",
        redistribution="copyleft",
        obligation="同 FDL 系列：附许可全文 + 保留声明 + 同许可共享衍生作品",
        evidence_url="https://sources.debian.org/src/bash/unstable/debian/copyright/",
        note="Debian 记 License: GFDL-NIV-1.3（Files: doc/bashref.texi 等）；"
        "bash.1 man 页自身只有版权行、无文字许可",
    ),
    BundledSource(
        source="selinux-docs",
        license_name="CC BY-SA 4.0（Gentoo Wiki）",
        redistribution="copyleft",
        obligation="SA 要求改编版以 BY-SA 4.0 共享 ⇒ 与 Apache-2.0 口径冲突",
        evidence_url="https://wiki.gentoo.org/wiki/SELinux",
        note="站点原文：unless otherwise expressly stated, licensed under CC-BY-SA-4.0。"
        "（抓的是 Gentoo wiki 页；SELinux 项目/NSA 官方文档自身条款**未查证**）",
    ),
    BundledSource(
        source="ssh-docs",
        license_name="未找到覆盖 man page 文字的许可授予",
        redistribution="unclear",
        obligation="不适用 —— 无依据判定可再分发",
        evidence_url="https://www.openbsd.org/policy.html",
        note="渲染页与 policy 页都只讲**代码**许可（"
        "freely used, copied, modified, and distributed）；man page 源文件头未能抓取核对",
    ),
    BundledSource(
        source="iptables-docs",
        license_name="站点只有版权行，无文档许可声明",
        redistribution="unclear",
        obligation="不适用",
        evidence_url="https://www.netfilter.org/documentation/",
        note="站点仅 Copyright © The Netfilter webmasters；about#license 的 GPLv2 说的是软件",
    ),
    BundledSource(
        source="systemd-docs",
        license_name="未找到上游对文档文字的自述许可",
        redistribution="unclear",
        obligation="不适用",
        evidence_url="https://sources.debian.org/src/systemd/unstable/debian/copyright/",
        note="Debian 记 Files: * License: LGPL-2.1+；把 LGPL 套到文档文字属归类可疑，"
        "且渲染 man 页无声明 ⇒ 按 fail-closed 不随包",
    ),
    BundledSource(
        source="dnf-docs",
        license_name="未找到上游对文档的自述许可",
        redistribution="unclear",
        obligation="不适用",
        evidence_url="https://sources.debian.org/src/dnf/unstable/debian/copyright/",
        note="readthedocs 页无许可脚注；Debian 记 Files: * License: GPL-2+ ⇒ 按 fail-closed 不随包",
    ),
)

_BY_SOURCE = {s.source: s for s in BUNDLED_SOURCES}


def source_policy(source: str) -> BundledSource | None:
    """取一个来源的判定；库里出现**没登记过**的来源时返回 None（调用方按不可分发处理）。"""
    return _BY_SOURCE.get(source)


def allowed_sources() -> frozenset[str]:
    """唯一可随包分发的来源集合：判据、剪枝脚本、NOTICES 都从这里取。"""
    return frozenset(
        s.source
        for s in BUNDLED_SOURCES
        if s.redistribution == "allow"
    )


def is_bundlable(source: str) -> bool:
    """库里的一条是否允许随包。未登记来源一律 False（fail-closed）。"""
    policy = source_policy(source)
    return policy is not None and policy.redistribution == "allow"


def disallowed_sources() -> frozenset[str]:
    return frozenset(s.source for s in BUNDLED_SOURCES if s.source not in allowed_sources())


def prune_to_bundled_scope(db_path: str | object) -> dict[str, int]:
    """把一个 db 剪到允许随包的范围（原地修改），返回 {source: 删除条数}。

    删除必须走 `RagIndex.delete()` —— 它管着 entries / fts_entries / vec_entries 三表
    的确定性 rowid（`_rowid_for(md5)`）对齐。手写 `DELETE FROM entries` 会留下 FTS 与
    向量的孤儿行，症状是"检索回查为空"（rag.py 里那条教训）。

    另外两张**派生表**也要一起剪，否则"剔除"只做到一半：
    - `doc_titles_zh`：URL→中文标题映射（`gen_titles_zh.py` 生成，按 url 关联条目）。
      留着就等于继续分发已剔除来源的页面标题 ⇒ 按"该 url 下还有没有活条目"筛；
    - `embed_cache`：content_hash→向量的**复用缓存**（少算一次 embedding 用的）。
      随包件里直接清空：① 里面存着被剔除正文的向量表示（原作品的衍生数据）；
      ② 运行时不需要它 —— 缓存未命中只是"新内容入库时重算一次向量"，与检索无关。
      不去按哈希筛是为了不依赖 `RagIndex.add()` 里那个缓存键算法（它变了随包判据不会察觉）。
    """
    from pathlib import Path

    from knowledge.rag import RagIndex

    path = Path(str(db_path))
    index = RagIndex(db_path=path)
    removed: dict[str, int] = {}
    try:
        conn = index._conn
        assert conn is not None
        keep = allowed_sources()
        rows = conn.execute("SELECT id, source FROM entries").fetchall()
        for row in rows:
            source = str(row["source"] or "")
            if source in keep:
                continue
            index.delete(str(row["id"]))
            removed[source or "<empty>"] = removed.get(source or "<empty>", 0) + 1

        # 派生表跟着正文走（见 docstring）
        titles_before = conn.execute("SELECT COUNT(*) FROM doc_titles_zh").fetchone()[0]
        conn.execute(
            "DELETE FROM doc_titles_zh WHERE url NOT IN (SELECT url FROM entries)"
        )
        titles_removed = titles_before - conn.execute(
            "SELECT COUNT(*) FROM doc_titles_zh"
        ).fetchone()[0]

        cache_before = conn.execute("SELECT COUNT(*) FROM embed_cache").fetchone()[0]
        conn.execute("DELETE FROM embed_cache")
        conn.commit()
        if titles_removed:
            removed["<doc_titles_zh>"] = titles_removed
        if cache_before:
            removed["<embed_cache>"] = cache_before
    finally:
        index.close()
    return removed


