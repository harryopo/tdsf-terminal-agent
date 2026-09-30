"""随安装包分发的精简知识库（#166 ⑥，2026-09-29 用户拍板「随包装」）。

要解决的问题：发布版里知识库是空的。三段断链（本轮量清）：

1. **打包侧**：`tdsf-sidecar.spec` 的 `datas` 只带 config / philosophy / builtin skills，
   没有任何 `.db`；而 `rag_slim.db` 躺在 gitignore 的 `.tdsf-data/` 里。
2. **运行侧**：frozen 模式下数据根是**只读资源目录之外**的用户目录
   （`%APPDATA%/tdsf-terminal-agent/.tdsf-data`，见 `main.py`），所以就算把库打进包里，
   运行时也不会去那儿读 —— 必须**播种**到可写目录。
3. **初始化侧**：启动自动初始化只爬**全量库**（`rag.db`），精简库空的时候
   只打一条 warning 就完了；而前端知识浏览器与 agent 检索**主读精简库**
   （`knowledge/rpc.py` 的 hybrid 走 `get_slim_rag()`）⇒ 用户看到的就是"空知识库"。

播种规则只有一条：**目标已存在就一个字都不动**。
用户自己重跑过提炼脚本、或者改过这个库，升级安装都不能把他的数据盖掉。
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path

logger = logging.getLogger("sidecar.knowledge.bundled")

#: 随包文件名（与运行时数据目录里的目标名同名，播种只是换个位置）
BUNDLED_DB_NAME = "rag_slim.db"


def bundled_slim_db_path() -> Path:
    """只读资源里那份精简库的路径。

    - dev（跑源码）：`src-tauri/sidecar/knowledge-bundled/rag_slim.db`
    - frozen：PyInstaller onedir 的 `_MEIPASS/knowledge-bundled/…`
      （spec 的 `datas` 把它解到那儿，见 `tdsf-sidecar.spec`）
    """
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return base / "knowledge-bundled" / BUNDLED_DB_NAME
    return (
        Path(__file__).resolve().parent.parent / "knowledge-bundled" / BUNDLED_DB_NAME
    )


def _data_dir_or_default() -> Path:
    """可写数据根：与 `main.py` / `knowledge/rag.py` 同一个口径（读环境变量，回退 sidecar/data）。"""
    return Path(
        os.environ.get(
            "TDSF_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")
        )
    )


def seed_bundled_slim_db(data_dir: Path | str | None = None) -> int:
    """把随包的精简库复制到可写数据目录（**仅在目标不存在时**）。

    Returns:
        1 = 播种了一份；0 = 什么都不做（已有库 / 包里没带 / 复制失败）。
        任何失败都只记日志不抛：知识库是增强能力，不该因为播种失败挡住启动。
    """
    target_dir = Path(data_dir) if data_dir else _data_dir_or_default()
    target = target_dir / BUNDLED_DB_NAME
    if target.exists():
        logger.debug("bundled slim kb skipped: %s already exists", target)
        return 0

    source = bundled_slim_db_path()
    if not source.is_file():
        # 开发环境里没跑过提炼脚本、或包里没有这个文件：说清楚，别让人以为"知识库坏了"
        logger.warning(
            "bundled slim kb not found (%s) — 知识库将为空，随包文件见 "
            "src-tauri/sidecar/knowledge-bundled/",
            source,
        )
        return 0

    tmp = target_dir / f"{BUNDLED_DB_NAME}.seed-tmp"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, tmp)
        # 原子换名：半份文件永远不会被 sqlite 当成合法库打开。
        # 这里**不再查一次存在性**：sidecar 是单进程（#64 二次启动只聚焦已有窗口），
        # 再查一遍既关不掉竞态（查完到换名之间同样有窗口），又只多一行没人能测的"防护"。
        os.replace(tmp, target)
    except OSError as exc:
        logger.warning("seed bundled slim kb failed: %s", exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return 0

    logger.info(
        "seeded bundled slim knowledge base: %s (%s bytes)",
        target,
        target.stat().st_size,
    )
    return 1
