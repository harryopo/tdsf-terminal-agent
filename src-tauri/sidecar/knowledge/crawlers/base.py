"""
knowledge/crawlers/base.py — 爬虫抽象基类（T-P3-03）
=====================================================

职责：
- 定义 BaseCrawler 抽象基类，14 个具体爬虫继承此类
- 统一接口：fetch() → parse(html) → to_entries() → List[KnowledgeEntry]
- 离线缓存：fetch 失败时从本地缓存读取，fetch 成功时写入缓存
- 离线模式：永远从缓存读取（不联网）

设计要点：
- 不直接依赖 requests/bs4（具体爬虫子类按需导入）
- fetch() 默认实现：requests.get + 缓存写入/读取
- parse(html) 抽象方法：子类实现 HTML 解析逻辑
- to_entries() 抽象方法：子类实现 KnowledgeEntry 转换
- 缓存路径：python-sidecar/data/crawlers-cache/<source>/

降级策略：
- requests 不可用 → 直接读缓存
- 缓存不存在 → 返回空列表 + 记录警告
"""

from __future__ import annotations

import abc
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from knowledge.fts5 import KnowledgeEntry

logger = logging.getLogger("sidecar.knowledge.crawlers.base")


# ============================================================================
# 常量定义
# ============================================================================

# 默认缓存根目录（统一读 TDSF_DATA_DIR，与应用 rag.db 同库目录；
# TDSF 2026-08-30 根因修复：dev 分支此前硬编码 sidecar/data/，与应用
# 实际读的 <项目根>/.tdsf-data/ 割裂成第二个库）
if getattr(sys, "frozen", False):
    _DEFAULT_CACHE_ROOT: Path = (
        Path(os.environ.get("TDSF_DATA_DIR", str(Path(sys.executable).resolve().parent / ".tdsf-data")))
        / "crawlers-cache"
    )
else:
    _DEFAULT_CACHE_ROOT: Path = (
        Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))
        / "crawlers-cache"
    )

# 默认 User-Agent（避免被反爬虫机制拒绝）
_DEFAULT_USER_AGENT: str = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


# ============================================================================
# 数据结构
# ============================================================================


@dataclass
class CrawlerResult:
    """爬虫单次抓取结果

    Attributes:
        source: 来源标识（如 "nginx-docs"）
        url: 抓取的 URL
        html: 原始 HTML 内容（fetch 后填充）
        entries: 解析后的知识条目列表
        from_cache: 是否来自缓存
        success: 是否成功
        error: 错误信息（失败时填充）
    """

    source: str = ""
    url: str = ""
    html: str = ""
    entries: list[KnowledgeEntry] = field(default_factory=list)
    from_cache: bool = False
    success: bool = False
    error: str = ""


# ============================================================================
# BaseCrawler 抽象基类
# ============================================================================


class BaseCrawler(abc.ABC):
    """爬虫抽象基类

    子类必须实现：
        - parse(html: str) -> list[dict]: 解析 HTML，返回原始条目字典列表
        - to_entries(items: list[dict]) -> list[KnowledgeEntry]: 转换为 KnowledgeEntry

    可选重写：
        - get_urls() -> list[str]: 返回要抓取的 URL 列表（默认 [self.base_url]）
        - build_entry_id(item) -> str: 自定义 entry ID 生成策略

    用法：
        crawler = NginxCrawler()
        result = crawler.fetch()  # 联网抓取 + 缓存
        result = crawler.fetch(offline=True)  # 仅从缓存读取
    """

    def __init__(
        self,
        source: str,
        base_url: str,
        cache_root: Path | str | None = None,
    ) -> None:
        """初始化爬虫

        Args:
            source: 来源标识（如 "nginx-docs"）
            base_url: 基础 URL
            cache_root: 缓存根目录。None 时使用默认路径
        """
        self.source: str = source
        self.base_url: str = base_url
        self.cache_root: Path = Path(cache_root) if cache_root else _DEFAULT_CACHE_ROOT
        self.cache_dir: Path = self.cache_root / source
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ========================================================================
    # 抽象方法
    # ========================================================================

    @abc.abstractmethod
    def parse(self, html: str) -> list[dict[str, Any]]:
        """解析 HTML 内容，返回原始条目字典列表

        Args:
            html: 原始 HTML 字符串

        Returns:
            条目字典列表（每项含 title/content/url 等字段）
        """
        raise NotImplementedError

    @abc.abstractmethod
    def to_entries(self, items: list[dict[str, Any]]) -> list[KnowledgeEntry]:
        """将原始条目字典列表转换为 KnowledgeEntry 列表

        Args:
            items: parse() 返回的原始条目列表

        Returns:
            KnowledgeEntry 列表
        """
        raise NotImplementedError

    # ========================================================================
    # 公共接口
    # ========================================================================

    def get_urls(self) -> list[str]:
        """返回要抓取的 URL 列表（默认仅 base_url）"""
        return [self.base_url]

    def build_entry_id(self, item: dict[str, Any], index: int) -> str:
        """生成条目 ID（默认 source-md5hash-index）

        Args:
            item: 条目字典
            index: 在列表中的索引

        Returns:
            唯一 ID 字符串
        """
        content = item.get("title", "") + item.get("url", "")
        hash_str = hashlib.md5(content.encode("utf-8")).hexdigest()[:8]
        return f"{self.source}-{hash_str}-{index}"

    def fetch(self, offline: bool = False) -> CrawlerResult:
        """抓取内容

        Args:
            offline: True 时仅从缓存读取，不联网

        Returns:
            CrawlerResult（包含 entries + html + 状态信息）
        """
        urls = self.get_urls()
        all_entries: list[KnowledgeEntry] = []
        all_html: list[str] = []
        last_error: str = ""
        any_from_cache: bool = False
        any_success: bool = False

        for url in urls:
            result = self._fetch_single(url, offline=offline)
            all_html.append(result.html)
            all_entries.extend(result.entries)
            if result.from_cache:
                any_from_cache = True
            if result.success:
                any_success = True
            if result.error:
                last_error = result.error

        return CrawlerResult(
            source=self.source,
            url=urls[0] if urls else "",
            html="\n".join(all_html),
            entries=all_entries,
            from_cache=any_from_cache,
            success=any_success,
            error=last_error,
        )

    # ========================================================================
    # 内部辅助方法
    # ========================================================================

    def _cache_path(self, url: str) -> Path:
        """获取 URL 对应的缓存文件路径"""
        url_hash = hashlib.md5(url.encode("utf-8")).hexdigest()[:12]
        return self.cache_dir / f"{url_hash}.json"

    def _read_cache(self, url: str) -> str | None:
        """从缓存读取 HTML

        Returns:
            HTML 字符串；缓存不存在返回 None
        """
        cache_file = self._cache_path(url)
        if not cache_file.exists():
            return None
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            html = data.get("html", "")
            logger.debug(f"cache hit: {self.source} url={url[:60]}")
            return html
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"cache read failed: {e}")
            return None

    def _write_cache(self, url: str, html: str) -> None:
        """写入缓存"""
        cache_file = self._cache_path(url)
        try:
            data = {"url": url, "html": html, "source": self.source}
            cache_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            logger.debug(f"cache write: {self.source} url={url[:60]}")
        except OSError as e:
            logger.warning(f"cache write failed: {e}")

    def _fetch_single(self, url: str, offline: bool = False) -> CrawlerResult:
        """抓取单个 URL"""
        # 离线模式：仅读缓存
        if offline:
            html = self._read_cache(url)
            if html is None:
                return CrawlerResult(
                    source=self.source,
                    url=url,
                    success=False,
                    error=f"offline cache miss: {url}",
                )
            return self._build_result(url, html, from_cache=True)

        # 联网模式：先尝试网络抓取
        try:
            html = self._http_get(url)
            if html:
                self._write_cache(url, html)
                return self._build_result(url, html, from_cache=False)
        except Exception as e:
            logger.warning(f"http_get failed for {url}: {e}, fallback to cache")
            last_error = str(e)
        else:
            last_error = "http_get returned empty"

        # 网络失败 → 读缓存
        html = self._read_cache(url)
        if html is not None:
            return self._build_result(url, html, from_cache=True)

        return CrawlerResult(
            source=self.source,
            url=url,
            success=False,
            error=last_error,
        )

    def _http_get(self, url: str) -> str:
        """HTTP GET 请求

        Args:
            url: 目标 URL

        Returns:
            响应文本；失败抛异常
        """
        try:
            import requests  # type: ignore[import-untyped]
        except ImportError as e:
            raise RuntimeError(f"requests 未安装: {e}") from e

        resp = requests.get(
            url,
            headers={
                "User-Agent": _DEFAULT_USER_AGENT,
                # TDSF 2026-08-30: 固定英文协商——部分官方站（kubernetes/
                # bash 等）按 Accept-Language 返回西语/其他语言版本，
                # 污染知识库正文（实测 "Documentación"/"NOMBRE" 混入）
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=10,
        )
        resp.raise_for_status()
        return resp.text

    def _build_result(
        self,
        url: str,
        html: str,
        from_cache: bool,
    ) -> CrawlerResult:
        """根据 HTML 构建 CrawlerResult（parse + to_entries）"""
        try:
            items = self.parse(html)
            entries = self.to_entries(items)
            return CrawlerResult(
                source=self.source,
                url=url,
                html=html,
                entries=entries,
                from_cache=from_cache,
                success=True,
            )
        except Exception as e:
            logger.exception(f"parse/to_entries failed: {e}")
            return CrawlerResult(
                source=self.source,
                url=url,
                html=html,
                from_cache=from_cache,
                success=False,
                error=f"parse failed: {e}",
            )
