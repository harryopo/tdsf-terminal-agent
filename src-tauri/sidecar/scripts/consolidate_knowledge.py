#!/usr/bin/env python
"""
scripts/consolidate_knowledge.py — 知识库大整合：7 分类 × ≤5 合并 md（TDSF 2026-08-31）
========================================================================================

用户钦定形态：
- 7 个分类目录不变，每目录内合并成 ≤5 个大 md（内容相似合并、格式整洁，
  方便 RAG 检索与人工阅读；同一软件/工具的文档聚一个文件）
- 合并文件结构：`# 中文大标题` + 简短目录（来源章节列表）+ 各来源章节
  （`## 序号. 来源标题（中文）`，正文整段插入、来源 url 注释保留、
  来源之间 `---` 分隔）
- 格式整理：①标题降级（来源内 #/##/### → ####/#####/######，代码围栏内
  不碰）②表格/代码围栏原样保留（已是 GFM）③相邻空行压 1
  ④相邻重复标题去重（含来源正文开头与章节标题重复）
- philosophy 4 篇（第 7 分类「Linux哲学与命令对照」）保持独立，不参与合并

数据流（三个脚本分工，db 才是 RAG 主体）：
1. 本脚本：rag.db 官方条目（682 网页）→ knowledge-preview/<分类>/<合并文件>.md
2. rebuild_from_consolidated.py：合并 md → 按标题边界分块入库重建 rag.db
   （合并文件在入库层按 _chunk_markdown 分块——单条几十万字符超出嵌入
   限制；块 title=`合并标题 · 章节标题`，url=合并文件逻辑 id，检索命中块 →
   前端 get_doc 按 url 聚合显示完整合并文档）
3. export_knowledge_md.py：rag.db → 重新导出 preview（幂等校验）

映射表：CONSOLIDATED_DOCS（27 个合并文件；archwiki basic-ops 与 ssh-docs
按 title 精确列表分组，其余按 source 整源归入）。fail-closed：任何官方条目
未被映射覆盖 → 报错退出（防漏）。

幂等：重跑覆盖（先清空 knowledge-preview 再写）。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/consolidate_knowledge.py
    .venv/Scripts/python.exe scripts/consolidate_knowledge.py --out D:/preview
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

# 与应用/rebuild/export 读写同一个 rag.db（<项目根>/.tdsf-data）
PROJECT_ROOT = Path(__file__).resolve().parents[3]
os.environ["TDSF_DATA_DIR"] = str(PROJECT_ROOT / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.consolidate_knowledge")

# ============================================================================
# 1. 合并映射表（用户钦定 7 分类 × ≤5 文件，共 27 个合并文件）
# ============================================================================
# 匹配规则（按顺序，assign_doc 逐条尝试）：
# - "sources": [source, ...]     → 整源全部条目归入（跨源合并）
# - "source" + "require_category"（无 "titles"）→ 该源指定 category 整类归入
#   （archwiki sys-admin 31 条，category 由 category_for 入库时已定）
# - "source" + "titles": [...]   → 该源命中 title 列表的条目归入
# 顺序敏感：archwiki 的 sys-admin 整类规则必须排在 basic-ops title 列表前。

CONSOLIDATED_DOCS: list[dict] = [
    # ── 服务部署（services，253 条 → 4 文件）─────────────────────────
    {
        "dir": "服务部署",
        "filename": "Web 服务器（Nginx 与 Apache）.md",
        "title": "Web 服务器（Nginx 与 Apache）",
        "category": "services",
        "sources": ["nginx-docs", "apache-docs"],
    },
    {
        "dir": "服务部署",
        "filename": "数据库（MariaDB 与 Redis）.md",
        "title": "数据库（MariaDB 与 Redis）",
        "category": "services",
        "sources": ["mariadb-docs", "redis-docs"],
    },
    {
        "dir": "服务部署",
        "filename": "容器运行时（Docker）.md",
        "title": "容器运行时（Docker）",
        "category": "services",
        "sources": ["docker-docs"],
    },
    {
        "dir": "服务部署",
        "filename": "容器编排（Kubernetes）.md",
        "title": "容器编排（Kubernetes）",
        "category": "services",
        "sources": ["kubernetes-docs"],
    },
    # ── 命令与工具（cmd-tools，177 条 → 5 文件）─────────────────────
    {
        "dir": "命令与工具",
        "filename": "Bash 与 Shell 手册.md",
        "title": "Bash 与 Shell 手册",
        "category": "cmd-tools",
        "sources": ["bash-docs"],
    },
    {
        "dir": "命令与工具",
        "filename": "Git 版本控制.md",
        "title": "Git 版本控制",
        "category": "cmd-tools",
        "sources": ["git-docs"],
    },
    {
        "dir": "命令与工具",
        "filename": "Python 官方文档.md",
        "title": "Python 官方文档",
        "category": "cmd-tools",
        "sources": ["python-docs"],
    },
    {
        "dir": "命令与工具",
        "filename": "Rust 语言与工具链.md",
        "title": "Rust 语言与工具链",
        "category": "cmd-tools",
        "sources": ["rust-docs"],
    },
    # systemd-docs 实际内容为 Linux man 手册（intro/signal/socket/pthreads 等
    # libc 与系统调用页），故命名「Linux man 手册精选」而非 systemd 文档
    {
        "dir": "命令与工具",
        "filename": "Linux man 手册精选.md",
        "title": "Linux man 手册精选",
        "category": "cmd-tools",
        "sources": ["systemd-docs"],
    },
    # ── 安全加固（security，104 条 → 3 文件）────────────────────────
    {
        "dir": "安全加固",
        "filename": "SELinux 与强制访问控制.md",
        "title": "SELinux 与强制访问控制",
        "category": "security",
        "sources": ["selinux-docs"],
    },
    {
        "dir": "安全加固",
        "filename": "netfilter 与 iptables.md",
        "title": "netfilter 与 iptables",
        "category": "security",
        "sources": ["iptables-docs"],
    },
    {
        "dir": "安全加固",
        "filename": "firewalld 防火墙.md",
        "title": "firewalld 防火墙",
        "category": "security",
        "sources": ["firewalld-docs"],
    },
    # ── 系统管理（sys-admin，56 条 → 2 文件）────────────────────────
    {
        "dir": "系统管理",
        "filename": "DNF 包管理器.md",
        "title": "DNF 包管理器",
        "category": "sys-admin",
        "sources": ["dnf-docs"],
    },
    {
        "dir": "系统管理",
        "filename": "系统启动、内核与 systemd（Arch Wiki）.md",
        "title": "系统启动、内核与 systemd（Arch Wiki）",
        "category": "sys-admin",
        "source": "archwiki",
        "require_category": "sys-admin",
    },
    # ── 基础概念（basic-ops，archwiki 48 条 → 5 文件，按 title 分组）──
    {
        "dir": "基础概念",
        "filename": "网络基础（Arch Wiki）.md",
        "title": "网络基础（Arch Wiki）",
        "category": "basic-ops",
        "source": "archwiki",
        "require_category": "basic-ops",
        "titles": [
            "Domain name resolution",
            "Network Time Protocol daemon",
            "Network configuration",
            "NetworkManager",
            "Samba",
            "Secure Shell",
            "Transport Layer Security",
            "netctl",
        ],
    },
    {
        "dir": "基础概念",
        "filename": "安全与访问控制（Arch Wiki）.md",
        "title": "安全与访问控制（Arch Wiki）",
        "category": "basic-ops",
        "source": "archwiki",
        "require_category": "basic-ops",
        "titles": [
            "Access Control Lists",
            "AppArmor",
            "Core dump",
            "Firejail",
            "Security",
            "dm-crypt",
            "polkit",
        ],
    },
    {
        "dir": "基础概念",
        "filename": "系统核心概念（Arch Wiki）.md",
        "title": "系统核心概念（Arch Wiki）",
        "category": "basic-ops",
        "source": "archwiki",
        "require_category": "basic-ops",
        "titles": [
            "Core utilities",
            "D-Bus",
            "Docker",
            "Environment variables",
            "General troubleshooting",
            "Persistent block device naming",
            "Power management",
            "System time",
            "Users and groups",
            "XDG Base Directory",
            "cgroups",
            "cron",
            "getty",
            "init",
            "rsyslog",
            "sSMTP",
            "syslog-ng",
            "udisks",
        ],
    },
    {
        "dir": "基础概念",
        "filename": "存储与引导（Arch Wiki）.md",
        "title": "存储与引导（Arch Wiki）",
        "category": "basic-ops",
        "source": "archwiki",
        "require_category": "basic-ops",
        "titles": ["GPT fdisk", "Kexec", "Limine", "rEFInd"],
    },
    {
        "dir": "基础概念",
        "filename": "桌面与终端应用（Arch Wiki）.md",
        "title": "桌面与终端应用（Arch Wiki）",
        "category": "basic-ops",
        "source": "archwiki",
        "require_category": "basic-ops",
        "titles": [
            "Desktop entries",
            "Desktop notifications",
            "Emacs",
            "Folding@home",
            "GNU Screen",
            "Music Player Daemon",
            "Plasma",
            "Xorg",
            "awesome",
            "tmux",
            "xinit",
        ],
    },
    # ── 网络与远程（net-remote，ssh-docs 44 条 → 4 文件，按 title 分组）──
    {
        "dir": "网络与远程",
        "filename": "OpenSSH 客户端与服务器.md",
        "title": "OpenSSH 客户端与服务器",
        "category": "net-remote",
        "source": "ssh-docs",
        "require_category": "net-remote",
        "titles": [
            "Ssh config(5)",
            "Sshd config(5)",
            "moduli(5)",
            "scp(1)",
            "sftp(1)",
            "sftp-server(8)",
            "ssh(1)",
            "ssh-add(1)",
            "ssh-agent(1)",
            "ssh-askpass(1)",
            "ssh-keygen(1)",
            "ssh-keyscan(1)",
            "ssh-keysign(8)",
            "sshd(8)",
        ],
    },
    {
        "dir": "网络与远程",
        "filename": "终端与 Shell 工具手册.md",
        "title": "终端与 Shell 工具手册",
        "category": "net-remote",
        "source": "ssh-docs",
        "require_category": "net-remote",
        "titles": [
            "cat(1)",
            "chroot(2)",
            "environ(7)",
            "fd(4)",
            "fsync(2)",
            "glob(3)",
            "glob(7)",
            "login.conf(5)",
            "nc(1)",
            "null(4)",
            "pty(4)",
            "rdomain(4)",
            "sh(1)",
            "syslog(3)",
            "tty(4)",
        ],
    },
    {
        "dir": "网络与远程",
        "filename": "压缩与 X11 工具手册.md",
        "title": "压缩与 X11 工具手册",
        "category": "net-remote",
        "source": "ssh-docs",
        "require_category": "net-remote",
        "titles": [
            "X(7)",
            "compress(1)",
            "compress(3)",
            "gzexe(1)",
            "gzip(1)",
            "xauth(1)",
            "xrdb(1)",
            "zdiff(1)",
            "zforce(1)",
            "zmore(1)",
            "znew(1)",
        ],
    },
    {
        "dir": "网络与远程",
        "filename": "网络与 VPN 工具手册.md",
        "title": "网络与 VPN 工具手册",
        "category": "net-remote",
        "source": "ssh-docs",
        "require_category": "net-remote",
        "titles": ["ftp(1)", "ipsecctl(8)", "isakmpd(8)", "tun(4)"],
    },
]

# 7 分类目录名（与 export_knowledge_md.CATEGORY_DIR_NAMES 对齐）
CATEGORY_DIR_NAMES: dict[str, str] = {
    "linux-philosophy": "Linux哲学与命令对照",
    "basic-ops": "基础概念",
    "cmd-tools": "命令与工具",
    "sys-admin": "系统管理",
    "net-remote": "网络与远程",
    "security": "安全加固",
    "services": "服务部署",
}

_FENCE_RE = re.compile(r"^(```|~~~)")
_HEADING_RE = re.compile(r"^(#+)(\s+.*)?$")


# ============================================================================
# 2. 分组映射（fail-closed：全覆盖校验）
# ============================================================================


def assign_doc(entry: dict) -> dict | None:
    """官方条目 → 所属合并文件定义；未命中返回 None（调用方 fail-closed）"""
    source = str(entry.get("source", ""))
    category = str(entry.get("category", ""))
    title = str(entry.get("title", ""))
    for doc in CONSOLIDATED_DOCS:
        if "sources" in doc:
            if source in doc["sources"]:
                return doc
            continue
        if source != doc.get("source") or category != doc.get("require_category"):
            continue
        titles = doc.get("titles")
        if titles is None or title in titles:
            return doc
    return None


def consolidated_url(doc: dict) -> str:
    """合并文件逻辑 id（RAG 入库 url；前端/导出按最后一段取文件名）"""
    return f"consolidated/{doc['category']}/{doc['filename']}"


# ============================================================================
# 3. 格式整理（用户钦定五条）
# ============================================================================


def demote_headings(text: str, levels: int = 3) -> str:
    """来源正文标题统一降级（#→#### 起），代码围栏内不碰，6 级封顶

    合并文件层级：# 大标题 / ## 来源章节；来源内标题从 #### 开始，
    保证 _chunk_markdown 的 1-3 级标题边界只落在「## 序号. 来源标题」，
    块 title 语义 =「合并标题 · 来源章节」。
    """
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            out.append(line)
            continue
        if not in_fence:
            m = _HEADING_RE.match(line)
            if m:
                hashes = (m.group(1) + "#" * levels)[:6]
                line = hashes + (m.group(2) or "")
        out.append(line)
    return "\n".join(out)


def strip_leading_duplicate_heading(body: str, label: str) -> str:
    """删除来源正文开头与章节标题重复的标题行（爬虫整页常以 # 标题开头）"""
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue
        m = _HEADING_RE.match(s)
        if m and (m.group(2) or "").strip() == label:
            lines.pop(idx)
            # 顺带删掉紧随的一个空行，避免头部留双空行
            if idx < len(lines) and not lines[idx].strip():
                lines.pop(idx)
        break  # 第一个非空行不是标题或不是重复标题 → 原样
    return "\n".join(lines).strip()


def dedupe_adjacent_headings(text: str) -> str:
    """相邻重复标题去重（同文本标题行连续出现只留第一个；围栏内不碰）"""
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    last_heading_text: str | None = None
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            out.append(line)
            last_heading_text = None
            continue
        if not in_fence:
            m = _HEADING_RE.match(line)
            if m:
                text_part = (m.group(2) or "").strip()
                if last_heading_text is not None and text_part == last_heading_text:
                    continue  # 相邻重复标题，丢弃
                last_heading_text = text_part
            elif line.strip():
                # 隔了正文（非空非标题行）才不算"相邻"；空行保持状态
                # （两个标题之间常隔空行）
                last_heading_text = None
        out.append(line)
    return "\n".join(out)


def collapse_blank_lines(text: str) -> str:
    """相邻空行压 1（代码围栏内不碰——代码块内空行有语义）"""
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    blank_run = 0
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            blank_run = 0
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        if not line.strip():
            blank_run += 1
            continue
        if blank_run:
            out.append("")
            blank_run = 0
        out.append(line)
    if out and not out[-1].strip():
        out.append("")  # 保留单个收尾空行
    return "\n".join(out).rstrip() + "\n"


# ============================================================================
# 4. 合并文件生成
# ============================================================================


def chapter_label(entry: dict, zh_map: dict[str, str]) -> str:
    """来源章节标题（中文优先，回退英文原标题）"""
    zh = zh_map.get(str(entry.get("url", "")), "").strip()
    return zh or str(entry.get("title", "")) or "（无标题）"


def chapter_labels(entries: list[dict], zh_map: dict[str, str]) -> list[str]:
    """组内全部章节标题；中文标题重复时（LLM 翻译撞车，如 Apache 多页
    译文均为「要点」）追加英文原标题消歧，保证目录可区分"""
    labels = [chapter_label(e, zh_map) for e in entries]
    counts = Counter(labels)
    return [
        lab if counts[lab] == 1 else f"{lab} · {str(e.get('title', ''))}"
        for lab, e in zip(labels, entries)
    ]


def build_consolidated_markdown(
    doc: dict, entries: list[dict], zh_map: dict[str, str]
) -> str:
    """一个合并文件 = frontmatter + # 大标题 + 目录 + 各来源章节"""
    entries = sorted(entries, key=lambda e: str(e["title"]).lower())
    n = len(entries)
    total_chars = sum(len(str(e["content"])) for e in entries)
    src_counts = Counter(str(e["source"]) for e in entries)
    # 主来源 = 字符数最多的 source（平局取字母序第一）；整源单源时即该源
    src_chars: dict[str, int] = {}
    for e in entries:
        src_chars[str(e["source"])] = (
            src_chars.get(str(e["source"]), 0) + len(str(e["content"]))
        )
    primary_source = sorted(src_chars.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    src_desc = "、".join(f"{s} {c} 页" for s, c in sorted(src_counts.items()))
    summary_zh = (
        f"本文件合并 {src_desc}，共 {n} 个官方文档页、约 {total_chars} 字，"
        f"按主题聚合便于 RAG 检索与人工阅读。"
    )

    lines: list[str] = [
        "---",
        f"source: {primary_source}",
        f"category: {doc['category']}",
        f"url: {consolidated_url(doc)}",
        f"title: {doc['title']}",
        f"zh_title: {doc['title']}",
        f"summary_zh: {summary_zh}",
        f"sources_count: {n}",
        "---",
        "",
        f"# {doc['title']}",
        "",
        f"> 合并自 {n} 个官方文档页（{src_desc}）。各来源章节以 `## 序号. 标题` 划分，",
        f"> 检索命中分块后按 url 聚合即本文档。",
        "",
        "**目录**",
        "",
    ]
    labels = chapter_labels(entries, zh_map)
    for i, lab in enumerate(labels, 1):
        lines.append(f"{i}. {lab}")
    lines.append("")

    for i, (e, label) in enumerate(zip(entries, labels), 1):
        body = demote_headings(str(e["content"]), levels=3)
        body = strip_leading_duplicate_heading(body, label)
        lines.append("---")
        lines.append("")
        lines.append(f"## {i}. {label}")
        lines.append("")
        # 来源 url 注释保留（任务钦定；clean_markdown 不删注释行，
        # 分块入库后仍随正文可追溯）
        lines.append(f"<!-- 来源: {e['source']} | {e['url']} -->")
        lines.append("")
        body_text = body.rstrip()
        if body_text:
            lines.append(body_text)
            lines.append("")

    text = "\n".join(lines)
    text = dedupe_adjacent_headings(text)
    return collapse_blank_lines(text)


def consolidate(out_dir: Path) -> dict[str, dict]:
    """读 rag.db 官方条目 → 生成合并 md，返回 {分类目录: {文件名: 条目数}}"""
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    entries = rag.official_entries()
    if not entries:
        raise SystemExit("rag.db 无官方条目（先跑 rebuild_knowledge.py --crawl-all）")
    # 防误操作：db 已是合并块结构（url 以 consolidated/ 开头）时拒绝重入
    # ——本脚本输入是原始网页条目；合并后重建走 rebuild_from_consolidated.py
    # （幂等），重新合并需先 rebuild_knowledge.py --crawl-all --offline 恢复
    if any(str(e["url"]).startswith("consolidated/") for e in entries):
        raise SystemExit(
            "rag.db 已是合并后结构（含 consolidated/ 条目）。"
            "重建请直接跑 rebuild_from_consolidated.py（幂等）；"
            "如需重新合并，先 rebuild_knowledge.py --crawl-all --offline 恢复原始条目"
        )
    zh_map = {str(t["url"]): str(t.get("zh") or "") for t in rag.titles_zh()}

    # fail-closed 分组：任何未映射条目报错退出（防漏）
    groups: dict[str, list[dict]] = {}
    unmatched: list[dict] = []
    for e in entries:
        doc = assign_doc(e)
        if doc is None:
            unmatched.append(e)
            continue
        groups.setdefault(consolidated_url(doc), {"doc": doc, "entries": []})
        groups[consolidated_url(doc)]["entries"].append(e)
    if unmatched:
        for e in unmatched[:20]:
            logger.error(
                f"unmapped entry: source={e['source']} title={e['title']!r} url={e['url']}"
            )
        raise SystemExit(f"{len(unmatched)} 条官方条目未命中映射表（fail-closed）")

    # 每分类目录文件数 ≤5 校验（用户钦定形态）
    per_dir: dict[str, int] = Counter()
    for g in groups.values():
        per_dir[g["doc"]["dir"]] += 1
    for d, n in sorted(per_dir.items()):
        if n > 5:
            raise SystemExit(f"分类「{d}」合并文件数 {n} > 5，违反用户钦定形态")

    # 幂等：清空导出目录再写（旧两级结构 <分类>/<源>/<标题>.md 一并清除）
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    stats: dict[str, dict] = {}
    for url in sorted(groups):
        g = groups[url]
        doc, group_entries = g["doc"], g["entries"]
        text = build_consolidated_markdown(doc, group_entries, zh_map)
        path = out_dir / doc["dir"] / doc["filename"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        logger.info(
            f"consolidated: {doc['dir']}/{doc['filename']} "
            f"({len(group_entries)} pages, {len(text)} chars)"
        )
        stats.setdefault(doc["dir"], {})[doc["filename"]] = len(group_entries)
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库大整合：合并 md 生成")
    parser.add_argument(
        "--out",
        default=None,
        help="输出目录（默认 <项目根>/knowledge-preview）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    out_dir = Path(args.out) if args.out else PROJECT_ROOT / "knowledge-preview"
    stats = consolidate(out_dir)

    total_files = sum(len(v) for v in stats.values())
    print("\n=== 知识库大整合完成（7 分类 × ≤5 合并文件） ===")
    print(f"{'分类目录':<20}{'文件数':>6}{'总页数':>8}")
    for d in sorted(stats):
        pages = sum(stats[d].values())
        print(f"{d:<20}{len(stats[d]):>6}{pages:>8}")
    print(f"{'TOTAL':<20}{total_files:>6}{sum(sum(v.values()) for v in stats.values()):>8}")
    print(f"\n输出目录：{out_dir}")
    print("下一步：.venv/Scripts/python.exe scripts/rebuild_from_consolidated.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
