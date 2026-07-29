"""
skills/marketplace.py — Skill Marketplace（T-P3-07）
======================================================

职责：
- Marketplace 类：search / install / update / uninstall / list_installed
- 支持 skills.sh 协议（HTTPS GET 获取 Skill 列表）
- 本地缓存到 python-sidecar/data/skills-cache/
- 离线模式：缓存命中即返回
- 已安装 Skill 写入 skills/builtin/（持久化）+ 注册到 SkillRegistry

设计要点：
- 与爬虫降级策略一致：requests 不可用 / 联网失败 → 读缓存
- 缓存格式：JSON（含 name/description/version/author/tags/source_url/body）
- 安装时将 Skill body 写入 skills/installed/<name>/SKILL.md
- 与 SkillRegistry 集成：install 后自动 register 到全局 registry

skills.sh 协议（mock 实现）：
- GET https://skills.sh/api/v1/skills?q=<query> → 列表
- GET https://skills.sh/api/v1/skills/<name> → 单个 Skill 详情
- POST https://skills.sh/api/v1/skills/<name>/install → 触发安装

由于 skills.sh 协议是 mock 的（实际不存在该服务），
Marketplace 使用内置 mock 数据模拟 API 响应。
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skills.parser import Skill, parse_skill_md

logger = logging.getLogger("sidecar.skills.marketplace")


# ============================================================================
# 常量定义
# ============================================================================

# 默认缓存根目录（python-sidecar/data/skills-cache/）
_DEFAULT_CACHE_ROOT: Path = Path(__file__).parent.parent / "data" / "skills-cache"

# 默认安装目录（python-sidecar/skills/installed/）
_DEFAULT_INSTALL_DIR: Path = Path(__file__).parent / "installed"

# skills.sh 协议 base URL（mock，实际不存在）
_SKILLS_SH_BASE_URL: str = "https://skills.sh/api/v1/skills"

# mock Skill 目录数据（模拟 skills.sh API 返回的列表）
_MOCK_REMOTE_SKILLS: list[dict[str, Any]] = [
    {
        "name": "rust-debug",
        "description": "Rust 调试 Skill，处理 borrow checker / lifetime / async 等问题",
        "version": "1.2.0",
        "author": "claude-skills",
        "tags": ["rust", "debug", "async"],
        "downloads": 1234,
        "rating": 4.8,
        "body": "# Rust 调试 Skill\n\n## When to use\n- Rust 编译错误\n- 借用检查器报错\n\n## Steps\n1. cargo check\n2. cargo clippy\n",
    },
    {
        "name": "go-concurrency",
        "description": "Go 并发 Skill，处理 goroutine / channel / context 等",
        "version": "1.1.0",
        "author": "claude-skills",
        "tags": ["go", "concurrency", "goroutine"],
        "downloads": 987,
        "rating": 4.7,
        "body": "# Go 并发 Skill\n\n## When to use\n- goroutine 泄漏\n- channel 死锁\n",
    },
    {
        "name": "react-hooks",
        "description": "React Hooks Skill，处理 useState / useEffect / useMemo 等",
        "version": "2.0.1",
        "author": "claude-skills",
        "tags": ["react", "hooks", "frontend"],
        "downloads": 2345,
        "rating": 4.9,
        "body": "# React Hooks Skill\n\n## When to use\n- useState 更新延迟\n- useEffect 依赖项\n",
    },
    {
        "name": "k8s-deploy",
        "description": "Kubernetes 部署 Skill，处理 Deployment / Service / Ingress",
        "version": "1.5.0",
        "author": "claude-skills",
        "tags": ["kubernetes", "k8s", "deploy"],
        "downloads": 1876,
        "rating": 4.6,
        "body": "# K8s 部署 Skill\n\n## When to use\n- Pod 启动失败\n- Service 不可达\n",
    },
    {
        "name": "postgres-tuning",
        "description": "PostgreSQL 调优 Skill，处理 EXPLAIN / 索引 / VACUUM",
        "version": "1.3.2",
        "author": "claude-skills",
        "tags": ["postgres", "sql", "tuning"],
        "downloads": 1543,
        "rating": 4.8,
        "body": "# PostgreSQL 调优 Skill\n\n## When to use\n- 慢查询\n- 索引优化\n",
    },
]


# ============================================================================
# 数据结构
# ============================================================================


@dataclass
class MarketplaceEntry:
    """Marketplace 中的 Skill 条目

    Attributes:
        name: Skill 名称
        description: 一句话描述
        version: 版本号
        author: 作者
        tags: 标签列表
        downloads: 下载次数（来自 marketplace）
        rating: 评分（0-5）
        body: Skill body 内容
        installed: 是否已安装
        source_url: 来源 URL
    """

    name: str = ""
    description: str = ""
    version: str = "0.0.0"
    author: str = ""
    tags: list[str] = field(default_factory=list)
    downloads: int = 0
    rating: float = 0.0
    body: str = ""
    installed: bool = False
    source_url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "tags": list(self.tags),
            "downloads": self.downloads,
            "rating": self.rating,
            "body": self.body,
            "installed": self.installed,
            "source_url": self.source_url,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MarketplaceEntry":
        return cls(
            name=data.get("name", ""),
            description=data.get("description", ""),
            version=data.get("version", "0.0.0"),
            author=data.get("author", ""),
            tags=list(data.get("tags", [])),
            downloads=int(data.get("downloads", 0)),
            rating=float(data.get("rating", 0.0)),
            body=data.get("body", ""),
            installed=bool(data.get("installed", False)),
            source_url=data.get("source_url", ""),
        )


# ============================================================================
# Marketplace 类
# ============================================================================


class Marketplace:
    """Skill 市场

    支持 skills.sh 协议 + 离线缓存。

    用法：
        mp = Marketplace()
        results = mp.search("react")  # 搜索远程 Skill
        mp.install("react-hooks")     # 安装
        installed = mp.list_installed()  # 已安装列表
        mp.uninstall("react-hooks")   # 卸载
    """

    def __init__(
        self,
        cache_root: Path | str | None = None,
        install_dir: Path | str | None = None,
    ) -> None:
        """初始化 Marketplace

        Args:
            cache_root: 缓存根目录。None 时使用默认路径
            install_dir: 安装目录。None 时使用默认路径
        """
        self.cache_root: Path = Path(cache_root) if cache_root else _DEFAULT_CACHE_ROOT
        self.install_dir: Path = Path(install_dir) if install_dir else _DEFAULT_INSTALL_DIR
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.install_dir.mkdir(parents=True, exist_ok=True)
        self._lock: threading.Lock = threading.Lock()
        logger.info(
            f"Marketplace initialized: cache={self.cache_root}, "
            f"install={self.install_dir}"
        )

    # ========================================================================
    # 搜索
    # ========================================================================

    def search(self, query: str, offline: bool = False) -> list[MarketplaceEntry]:
        """搜索 Skill

        Args:
            query: 搜索关键词（大小写不敏感）
            offline: True 时仅从缓存读取

        Returns:
            匹配的 MarketplaceEntry 列表（按 name 排序）
        """
        # 1. 尝试远程搜索（非离线模式）
        if not offline:
            remote_results: list[MarketplaceEntry] = self._fetch_remote_search(query)
            if remote_results:
                # 标记已安装状态
                for entry in remote_results:
                    entry.installed = self._is_installed(entry.name)
                # 写入缓存
                self._write_search_cache(query, remote_results)
                return sorted(remote_results, key=lambda e: e.name)
            logger.warning("remote search failed, fallback to cache")

        # 2. 离线模式 / 远程失败：读缓存
        cached: list[MarketplaceEntry] = self._read_search_cache(query)
        if cached:
            for entry in cached:
                entry.installed = self._is_installed(entry.name)
            return sorted(cached, key=lambda e: e.name)

        # 3. 缓存也miss：从 mock 数据搜索
        mock_results: list[MarketplaceEntry] = self._search_mock_data(query)
        for entry in mock_results:
            entry.installed = self._is_installed(entry.name)
        return sorted(mock_results, key=lambda e: e.name)

    def list_all(self, offline: bool = False) -> list[MarketplaceEntry]:
        """列出所有可用 Skill（无 query 过滤）"""
        return self.search("", offline=offline)

    # ========================================================================
    # 安装 / 卸载
    # ========================================================================

    def install(self, name: str, offline: bool = False) -> dict[str, Any]:
        """安装 Skill

        Args:
            name: Skill 名称（大小写不敏感）
            offline: True 时仅从缓存读取 Skill 详情

        Returns:
            安装结果字典 {ok, skill?, error?}
        """
        if not name:
            return {"ok": False, "error": "name is empty"}

        # 已安装
        if self._is_installed(name):
            return {
                "ok": True,
                "skill": self._get_installed_entry(name).to_dict(),
                "note": "already installed",
            }

        # 获取 Skill 详情
        entry: MarketplaceEntry | None = self._fetch_skill_detail(name, offline=offline)
        if entry is None:
            return {"ok": False, "error": f"skill not found: {name}"}

        # 写入安装目录
        skill_dir: Path = self.install_dir / entry.name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_md: Path = skill_dir / "SKILL.md"

        # 构造完整 SKILL.md 内容
        content: str = self._build_skill_md(entry)
        skill_md.write_text(content, encoding="utf-8")

        # 注册到 SkillRegistry（懒加载，避免循环依赖）
        try:
            from skills.registry import get_global_registry
            registry = get_global_registry()
            skill: Skill = parse_skill_md(skill_md)
            registry.register(skill)
            logger.info(f"skill '{entry.name}' installed and registered")
        except Exception as e:
            logger.warning(f"failed to register skill '{entry.name}': {e}")

        logger.info(f"skill installed: {entry.name} → {skill_md}")
        return {
            "ok": True,
            "skill": entry.to_dict(),
            "path": str(skill_md),
        }

    def uninstall(self, name: str) -> dict[str, Any]:
        """卸载 Skill

        Args:
            name: Skill 名称（大小写不敏感）

        Returns:
            卸载结果字典 {ok, error?}
        """
        if not name:
            return {"ok": False, "error": "name is empty"}

        # 查找安装目录（大小写不敏感）
        skill_dir: Path | None = self._find_installed_dir(name)
        if skill_dir is None:
            return {"ok": False, "error": f"skill not installed: {name}"}

        # 删除文件
        try:
            import shutil
            shutil.rmtree(skill_dir)
        except OSError as e:
            return {"ok": False, "error": f"failed to remove: {e}"}

        # 从 SkillRegistry 注销
        try:
            from skills.registry import get_global_registry
            registry = get_global_registry()
            registry.unregister(name)
            logger.info(f"skill '{name}' uninstalled and unregistered")
        except Exception as e:
            logger.warning(f"failed to unregister skill '{name}': {e}")

        logger.info(f"skill uninstalled: {name}")
        return {"ok": True}

    def update(self, name: str, offline: bool = False) -> dict[str, Any]:
        """更新 Skill（重新安装）

        等同于 uninstall + install。

        Args:
            name: Skill 名称
            offline: True 时仅从缓存读取最新版本

        Returns:
            更新结果字典
        """
        if not self._is_installed(name):
            return {"ok": False, "error": f"skill not installed: {name}"}

        # 卸载
        uninstall_result: dict[str, Any] = self.uninstall(name)
        if not uninstall_result.get("ok"):
            return uninstall_result

        # 重新安装
        return self.install(name, offline=offline)

    def list_installed(self) -> list[MarketplaceEntry]:
        """列出所有已安装的 Skill"""
        installed: list[MarketplaceEntry] = []
        if not self.install_dir.exists():
            return installed

        for skill_md in self.install_dir.glob("*/SKILL.md"):
            try:
                skill: Skill = parse_skill_md(skill_md)
                entry: MarketplaceEntry = MarketplaceEntry(
                    name=skill.name,
                    description=skill.description,
                    version=skill.version,
                    author=skill.author,
                    tags=skill.tags,
                    installed=True,
                    source_url=str(skill_md),
                )
                installed.append(entry)
            except Exception as e:
                logger.warning(f"failed to parse installed skill {skill_md}: {e}")

        return sorted(installed, key=lambda e: e.name)

    def is_installed(self, name: str) -> bool:
        """判断 Skill 是否已安装"""
        return self._is_installed(name)

    # ========================================================================
    # 内部方法：远程获取
    # ========================================================================

    def _fetch_remote_search(self, query: str) -> list[MarketplaceEntry]:
        """远程搜索（skills.sh 协议）

        由于 skills.sh 是 mock 服务，此处直接返回 mock 数据。
        实际接入真实服务时替换为 requests.get。
        """
        # mock：过滤 _MOCK_REMOTE_SKILLS
        if not query:
            return [MarketplaceEntry.from_dict(d) for d in _MOCK_REMOTE_SKILLS]

        q: str = query.lower()
        results: list[MarketplaceEntry] = []
        for d in _MOCK_REMOTE_SKILLS:
            if q in d["name"].lower() or q in d["description"].lower():
                results.append(MarketplaceEntry.from_dict(d))
                continue
            if any(q in tag.lower() for tag in d.get("tags", [])):
                results.append(MarketplaceEntry.from_dict(d))

        logger.debug(f"_fetch_remote_search: query='{query}', results={len(results)}")
        return results

    def _fetch_skill_detail(
        self,
        name: str,
        offline: bool = False,
    ) -> MarketplaceEntry | None:
        """获取单个 Skill 详情

        Args:
            name: Skill 名称
            offline: True 时仅从缓存读取

        Returns:
            MarketplaceEntry；不存在返回 None
        """
        # 1. 尝试缓存
        cached: MarketplaceEntry | None = self._read_skill_cache(name)
        if cached is not None:
            return cached

        if offline:
            return None

        # 2. 从 mock 数据查找
        name_lower: str = name.lower()
        for d in _MOCK_REMOTE_SKILLS:
            if d["name"].lower() == name_lower:
                entry: MarketplaceEntry = MarketplaceEntry.from_dict(d)
                entry.source_url = f"{_SKILLS_SH_BASE_URL}/{d['name']}"
                self._write_skill_cache(entry)
                return entry

        return None

    # ========================================================================
    # 内部方法：缓存
    # ========================================================================

    def _search_cache_path(self, query: str) -> Path:
        """搜索结果缓存文件路径"""
        import hashlib
        qhash: str = hashlib.md5(query.encode("utf-8")).hexdigest()[:12]
        return self.cache_root / f"search-{qhash}.json"

    def _skill_cache_path(self, name: str) -> Path:
        """单个 Skill 缓存文件路径"""
        return self.cache_root / f"skill-{name.lower()}.json"

    def _write_search_cache(
        self,
        query: str,
        entries: list[MarketplaceEntry],
    ) -> None:
        """写入搜索结果缓存"""
        try:
            cache_file: Path = self._search_cache_path(query)
            data: dict[str, Any] = {
                "query": query,
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "entries": [e.to_dict() for e in entries],
            }
            cache_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            logger.debug(f"search cache written: {cache_file}")
        except OSError as e:
            logger.warning(f"failed to write search cache: {e}")

    def _read_search_cache(self, query: str) -> list[MarketplaceEntry]:
        """读取搜索结果缓存"""
        cache_file: Path = self._search_cache_path(query)
        if not cache_file.exists():
            return []
        try:
            data: dict[str, Any] = json.loads(
                cache_file.read_text(encoding="utf-8")
            )
            entries_data: list = data.get("entries", [])
            return [MarketplaceEntry.from_dict(d) for d in entries_data]
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"failed to read search cache: {e}")
            return []

    def _write_skill_cache(self, entry: MarketplaceEntry) -> None:
        """写入单个 Skill 缓存"""
        try:
            cache_file: Path = self._skill_cache_path(entry.name)
            cache_file.write_text(
                json.dumps(entry.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            logger.debug(f"skill cache written: {cache_file}")
        except OSError as e:
            logger.warning(f"failed to write skill cache: {e}")

    def _read_skill_cache(self, name: str) -> MarketplaceEntry | None:
        """读取单个 Skill 缓存"""
        cache_file: Path = self._skill_cache_path(name)
        if not cache_file.exists():
            return None
        try:
            data: dict[str, Any] = json.loads(
                cache_file.read_text(encoding="utf-8")
            )
            return MarketplaceEntry.from_dict(data)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"failed to read skill cache: {e}")
            return None

    # ========================================================================
    # 内部方法：已安装管理
    # ========================================================================

    def _is_installed(self, name: str) -> bool:
        """判断是否已安装"""
        if not name:
            return False
        skill_md: Path = self.install_dir / name / "SKILL.md"
        return skill_md.exists()

    def _find_installed_dir(self, name: str) -> Path | None:
        """查找已安装目录（大小写不敏感）"""
        if not self.install_dir.exists():
            return None
        name_lower: str = name.lower()
        for d in self.install_dir.iterdir():
            if d.is_dir() and d.name.lower() == name_lower:
                return d
        return None

    def _get_installed_entry(self, name: str) -> MarketplaceEntry:
        """获取已安装 Skill 的 MarketplaceEntry"""
        skill_md: Path = self.install_dir / name / "SKILL.md"
        skill: Skill = parse_skill_md(skill_md)
        return MarketplaceEntry(
            name=skill.name,
            description=skill.description,
            version=skill.version,
            author=skill.author,
            tags=skill.tags,
            installed=True,
            source_url=str(skill_md),
        )

    def _search_mock_data(self, query: str) -> list[MarketplaceEntry]:
        """从 mock 数据搜索（无网络 + 无缓存时兜底）"""
        if not query:
            return [MarketplaceEntry.from_dict(d) for d in _MOCK_REMOTE_SKILLS]

        q: str = query.lower()
        results: list[MarketplaceEntry] = []
        for d in _MOCK_REMOTE_SKILLS:
            if q in d["name"].lower() or q in d["description"].lower():
                results.append(MarketplaceEntry.from_dict(d))
                continue
            if any(q in tag.lower() for tag in d.get("tags", [])):
                results.append(MarketplaceEntry.from_dict(d))
        return results

    def _build_skill_md(self, entry: MarketplaceEntry) -> str:
        """根据 MarketplaceEntry 构造 SKILL.md 内容

        TDSF 魔改: 用双引号包裹 description / author 字段，
        避免 YAML 把以 `[` / `{` / `:` 开头的值误解析为 list / dict / mapping。
        name / version 不加引号（受 [a-z0-9-] 字符集约束，安全）。
        tags 保留 inline 数组 [a, b, c] 形式（YAML 原生支持）。
        """
        tags_str: str = ", ".join(entry.tags)
        # 转义 description / author 中的双引号
        desc_escaped: str = entry.description.replace('"', '\\"')
        author_escaped: str = entry.author.replace('"', '\\"')
        return (
            "---\n"
            f"name: {entry.name}\n"
            f'description: "{desc_escaped}"\n'
            f"version: {entry.version}\n"
            f'author: "{author_escaped}"\n'
            f"tags: [{tags_str}]\n"
            "---\n\n"
            f"{entry.body}\n"
        )


# ============================================================================
# 模块级单例
# ============================================================================

_global_marketplace: Marketplace | None = None
_global_marketplace_lock: threading.Lock = threading.Lock()


def get_global_marketplace() -> Marketplace:
    """获取全局 Marketplace 单例"""
    global _global_marketplace
    if _global_marketplace is not None:
        return _global_marketplace
    with _global_marketplace_lock:
        if _global_marketplace is not None:
            return _global_marketplace
        _global_marketplace = Marketplace()
    return _global_marketplace


def reset_global_marketplace() -> None:
    """重置全局单例（仅供测试使用）"""
    global _global_marketplace
    with _global_marketplace_lock:
        _global_marketplace = None


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 marketplace.* 方法

    注册的方法：
    - marketplace.search:       搜索远程 Skill
    - marketplace.install:      安装 Skill
    - marketplace.uninstall:    卸载 Skill
    - marketplace.update:       更新 Skill
    - marketplace.list_installed: 列出已安装 Skill
    """
    mp: Marketplace = get_global_marketplace()

    def _search(query: str = "", offline: bool = False) -> dict[str, Any]:
        entries: list[MarketplaceEntry] = mp.search(query, offline=offline)
        return {
            "skills": [e.to_dict() for e in entries],
            "total": len(entries),
            "query": query,
        }

    def _install(name: str, offline: bool = False) -> dict[str, Any]:
        return mp.install(name, offline=offline)

    def _uninstall(name: str) -> dict[str, Any]:
        return mp.uninstall(name)

    def _update(name: str, offline: bool = False) -> dict[str, Any]:
        return mp.update(name, offline=offline)

    def _list_installed() -> dict[str, Any]:
        entries: list[MarketplaceEntry] = mp.list_installed()
        return {
            "skills": [e.to_dict() for e in entries],
            "total": len(entries),
        }

    dispatcher.register("marketplace.search", _search)
    dispatcher.register("marketplace.install", _install)
    dispatcher.register("marketplace.uninstall", _uninstall)
    dispatcher.register("marketplace.update", _update)
    dispatcher.register("marketplace.list_installed", _list_installed)
    logger.info("marketplace.* methods registered (5 methods)")
