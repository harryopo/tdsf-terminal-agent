"""
skills/parser.py — SKILL.md 解析器（T-P3-06）
================================================

职责：
- 解析 SKILL.md 文件，提取 YAML frontmatter + Markdown body
- 返回 Skill dataclass（name/description/version/author/tags + body sections）
- 兼容 PyYAML 不可用时退化为简单 key:value 解析

SKILL.md 格式（DEC-V321-13 标准 + T1 2026-08-28 扩展）：
    ---
    name: <skill-name>
    description: <一句话描述>
    version: 1.0.0
    author: TDSF
    tags: [linux, ops]
    triggers: [systemd, 服务启动失败]   # T1: 触发词（可选，search 命中用）
    allowed-tools: [ssh_command, read_remote_file]  # T1: 工具白名单（可选）
    ---

    # <Skill Name>

    ## When to use
    <触发条件>

    ## Steps
    1. <步骤 1>

    ## Examples
    <示例>

Skill dataclass 字段：
- name:        Skill 名称（必填，唯一标识）
- description: 一句话描述
- version:     版本号（默认 "0.0.0"）
- author:      作者
- tags:        标签列表
- triggers:    触发词列表（T1 2026-08-28，search 命中扩展；空 = 不参与触发匹配）
- when_to_use: "When to use" 章节内容
- steps:       "Steps" 章节内容
- examples:    "Examples" 章节内容
- body:        完整 Markdown body（备用）
- file_path:   源文件路径（None 表示内存创建）

降级策略：
- PyYAML 不可用 → 简单 key:value 解析 frontmatter（不支持复杂 YAML）
- markdown 库不可用 → 用字符串分割提取章节（不渲染 HTML）
- frontmatter 缺失 → name 用文件名兜底
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.skills.parser")


# ============================================================================
# 常量定义
# ============================================================================

# frontmatter 正则：--- 开头，--- 结尾，中间为 YAML
_FRONTMATTER_RE: re.Pattern[str] = re.compile(
    r"^---\s*\n(.*?)\n---\s*\n(.*)$",
    re.DOTALL,
)

# Markdown 章节正则：## <title>\n<content> 直到下一个 ## 或文件末尾
_SECTION_RE: re.Pattern[str] = re.compile(
    r"^##\s+(.+?)\s*\n(.*?)(?=^##\s+|\Z)",
    re.DOTALL | re.MULTILINE,
)


# ============================================================================
# Skill dataclass
# ============================================================================


@dataclass
class Skill:
    """Skill 数据结构（解析 SKILL.md 后的产物）

    Attributes:
        name:        Skill 名称（唯一标识，必填）
        description: 一句话描述
        version:     版本号（默认 "0.0.0"）
        author:      作者
        tags:        标签列表
        triggers:    触发词列表（T1 2026-08-28，search 命中扩展）
        when_to_use: "When to use" 章节内容
        steps:       "Steps" 章节内容
        examples:    "Examples" 章节内容
        body:        完整 Markdown body（备用，包含所有章节）
        file_path:   源文件路径（None 表示内存创建）
    """

    name: str
    description: str = ""
    version: str = "0.0.0"
    author: str = ""
    tags: list[str] = field(default_factory=list)
    triggers: list[str] = field(default_factory=list)
    when_to_use: str = ""
    steps: str = ""
    examples: str = ""
    body: str = ""
    file_path: str | None = None
    # TDSF 魔改 (P0-2 修复 2026-07-28): 可执行体描述
    # 来自 SKILL.md frontmatter 的 executor 块, 支持 shell/python/http 三种 type
    # - shell:  {type: shell,  command: "...", timeout: 5, args: ["--flag"]}
    # - python: {type: python, script: "import os; print(os.uname())"}
    # - http:   {type: http,   method: GET, url: "...", headers: {}}
    executor: dict[str, Any] | None = None
    # TDSF 魔改 (T1 2026-08-28): 工具白名单（可选）
    # 来自 SKILL.md frontmatter 的 allowed-tools 字段（list[str] 或逗号分隔 str）
    # 语义：该技能执行/推荐时允许使用的 Strands 工具名列表（对齐 Claude Code
    # Agent Skills 的 allowed-tools 前置声明）；空列表 = 不限制
    allowed_tools: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容字典"""
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "tags": list(self.tags),
            # TDSF 魔改 (T1 2026-08-28): 序列化 triggers
            "triggers": list(self.triggers),
            "when_to_use": self.when_to_use,
            "steps": self.steps,
            "examples": self.examples,
            "body": self.body,
            "file_path": self.file_path,
            # TDSF 魔改 (P0-2 修复 2026-07-28): 序列化 executor
            "executor": dict(self.executor) if self.executor else None,
            # TDSF 魔改 (T1 2026-08-28): 序列化 allowed-tools
            "allowed_tools": list(self.allowed_tools),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Skill":
        """从字典反序列化（容忍缺失字段）"""
        return cls(
            name=data.get("name", ""),
            description=data.get("description", ""),
            version=data.get("version", "0.0.0"),
            author=data.get("author", ""),
            tags=list(data.get("tags", [])),
            # TDSF 魔改 (T1 2026-08-28): 反序列化 triggers
            triggers=list(data.get("triggers") or []),
            when_to_use=data.get("when_to_use", ""),
            steps=data.get("steps", ""),
            examples=data.get("examples", ""),
            body=data.get("body", ""),
            file_path=data.get("file_path"),
            # TDSF 魔改 (P0-2 修复 2026-07-28): 反序列化 executor
            executor=data.get("executor"),
            # TDSF 魔改 (T1 2026-08-28): 反序列化 allowed-tools
            allowed_tools=list(data.get("allowed_tools") or []),
        )


# ============================================================================
# 公共接口
# ============================================================================


def parse_skill_md(file_path: Path | str) -> Skill:
    """解析 SKILL.md 文件

    Args:
        file_path: SKILL.md 文件路径

    Returns:
        Skill 对象

    Raises:
        FileNotFoundError: 文件不存在
        ValueError: frontmatter 缺少 name 字段（必填）
    """
    path: Path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"SKILL.md not found: {path}")

    content: str = path.read_text(encoding="utf-8")
    skill: Skill = parse_skill_content(content)
    skill.file_path = str(path)
    # 若 frontmatter 缺少 name，用文件父目录名兜底
    if not skill.name:
        skill.name = path.parent.name
        logger.warning(
            f"SKILL.md missing 'name' in frontmatter, "
            f"using directory name: {skill.name}"
        )
    return skill


def parse_skill_content(content: str) -> Skill:
    """解析 SKILL.md 内容字符串

    Args:
        content: SKILL.md 文件内容

    Returns:
        Skill 对象
    """
    if not content or not content.strip():
        return Skill(name="")

    # === 1. 分离 frontmatter 和 body ===
    match: re.Match[str] | None = _FRONTMATTER_RE.match(content)
    if match:
        yaml_text: str = match.group(1)
        body: str = match.group(2).strip()
    else:
        # 无 frontmatter，全部作为 body
        yaml_text = ""
        body = content.strip()

    # === 2. 解析 frontmatter ===
    meta: dict[str, Any] = _parse_frontmatter(yaml_text)

    # === 3. 解析 body 章节 ===
    sections: dict[str, str] = _parse_sections(body)

    return Skill(
        name=str(meta.get("name", "")),
        description=str(meta.get("description", "")),
        version=str(meta.get("version", "0.0.0")),
        author=str(meta.get("author", "")),
        tags=_normalize_tags(meta.get("tags")),
        # TDSF 魔改 (T1 2026-08-28): 解析 triggers 触发词
        triggers=_normalize_tags(meta.get("triggers")),
        when_to_use=sections.get("when to use", ""),
        steps=sections.get("steps", ""),
        examples=sections.get("examples", ""),
        body=body,
        # TDSF 魔改 (P0-2 修复 2026-07-28): 解析 SKILL.md 中的 executor 元数据
        # 支持让 Skill 真正执行 shell 命令, 而不是只回显 SKILL.md 文本
        executor=_parse_executor(meta.get("executor")),
        # TDSF 魔改 (T1 2026-08-28): 解析 allowed-tools 工具白名单
        allowed_tools=_normalize_tags(meta.get("allowed-tools")
                                      or meta.get("allowed_tools")),
    )


# ============================================================================
# 内部辅助函数
# ============================================================================


def _parse_frontmatter(yaml_text: str) -> dict[str, Any]:
    """解析 YAML frontmatter

    优先使用 PyYAML；不可用时退化为简单 key:value 解析。

    Args:
        yaml_text: frontmatter 文本（不含 --- 分隔符）

    Returns:
        字典（key → value，tags 解析为 list）
    """
    if not yaml_text or not yaml_text.strip():
        return {}

    # === 优先尝试 PyYAML ===
    try:
        import yaml  # type: ignore[import-untyped]
        meta: dict[str, Any] = yaml.safe_load(yaml_text) or {}
        if isinstance(meta, dict):
            return meta
        logger.warning(
            f"YAML frontmatter parsed as {type(meta).__name__}, expected dict"
        )
    except ImportError:
        logger.debug("PyYAML not available, fallback to simple key:value parser")
    except Exception as e:
        logger.warning(f"PyYAML parse failed, fallback to simple parser: {e}")

    # === 退化：简单 key:value 解析 ===
    return _simple_yaml_parse(yaml_text)


def _simple_yaml_parse(yaml_text: str) -> dict[str, Any]:
    """简单 YAML 解析（不支持嵌套 / 复杂类型）

    支持格式：
        name: value
        tags: [a, b, c]
        tags:
          - a
          - b

    Args:
        yaml_text: frontmatter 文本

    Returns:
        字典
    """
    result: dict[str, Any] = {}
    current_key: str | None = None
    current_list: list[str] | None = None

    for line in yaml_text.splitlines():
        stripped: str = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # 数组项（- value）
        if stripped.startswith("- ") and current_key is not None:
            value: str = stripped[2:].strip()
            if current_list is None:
                current_list = []
            current_list.append(_strip_quotes(value))
            continue

        # key: value
        if ":" in stripped:
            # 保存上一个 list
            if current_key is not None and current_list is not None:
                result[current_key] = current_list
                current_list = None

            key, _, value = stripped.partition(":")
            key = key.strip()
            value = value.strip()
            if not value:
                # 可能是多行数组开头
                current_key = key
                current_list = None  # 重置，等待 - 项
            elif value.startswith("[") and value.endswith("]"):
                # inline 数组 [a, b, c]
                inner: str = value[1:-1]
                result[key] = [
                    _strip_quotes(v.strip())
                    for v in inner.split(",")
                    if v.strip()
                ]
                current_key = None
            else:
                result[key] = _strip_quotes(value)
                current_key = None

    # 收尾：最后一个 list
    if current_key is not None and current_list is not None:
        result[current_key] = current_list

    return result


def _strip_quotes(value: str) -> str:
    """去除字符串两端的引号（单引号或双引号）"""
    if len(value) >= 2:
        if (value[0] == '"' and value[-1] == '"') or (
            value[0] == "'" and value[-1] == "'"
        ):
            return value[1:-1]
    return value


def _normalize_tags(tags: Any) -> list[str]:
    """规范化 tags 字段为字符串列表

    Args:
        tags: 可能是 list / tuple / str / None

    Returns:
        字符串列表
    """
    if tags is None:
        return []
    if isinstance(tags, (list, tuple)):
        return [str(t).strip() for t in tags if str(t).strip()]
    if isinstance(tags, str):
        # 字符串形式：可能是 "a, b, c" 或 "[a, b, c]"
        s: str = tags.strip()
        if s.startswith("[") and s.endswith("]"):
            s = s[1:-1]
        if not s:
            return []
        return [t.strip() for t in s.split(",") if t.strip()]
    return []


def _parse_sections(body: str) -> dict[str, str]:
    """解析 Markdown body 的章节（## 标题）

    Args:
        body: Markdown body（不含 frontmatter）

    Returns:
        dict[lowered_title → content]（标题小写化便于查询）
    """
    sections: dict[str, str] = {}
    for match in _SECTION_RE.finditer(body):
        title: str = match.group(1).strip()
        content: str = match.group(2).strip()
        sections[title.lower()] = content
    return sections


# TDSF 魔改 (P0-2 修复 2026-07-28): 解析 executor 元数据
# ---------------------------------------------------------------------------
# SKILL.md frontmatter 支持以下三种 executor 格式:
#
#   executor:
#     type: shell
#     command: "docker ps -a"
#     timeout: 5
#     args: ["--format", "{{.Names}}"]
#
#   executor:
#     type: python
#     script: |
#       import platform
#       print(platform.uname())
#
#   executor:
#     type: http
#     method: GET
#     url: "https://api.example.com/v1/health"
#     headers:
#       X-Auth: "bearer xxx"
#     timeout: 5
#
# 返回值:
#   - None: frontmatter 无 executor 字段 → Skill 是纯知识卡
#   - dict: 解析后的执行器描述（含 type + 必要参数）
# ---------------------------------------------------------------------------
def _parse_executor(raw: Any) -> dict[str, Any] | None:
    """解析 frontmatter 中的 executor 块

    Args:
        raw: frontmatter 中 executor 字段的原始值（可能为 None / dict / str）

    Returns:
        dict: 标准化执行器描述（含 type / 命令 / 超时等）
        None: 无 executor 或解析失败
    """
    if not raw:
        return None
    if not isinstance(raw, dict):
        # 字符串形式 executor: "echo hello" 等价于 {type: shell, command: "echo hello"}
        if isinstance(raw, str) and raw.strip():
            return {"type": "shell", "command": raw.strip(), "timeout": 30}
        logger.warning(
            f"_parse_executor: unexpected type {type(raw).__name__}, "
            f"expect dict or str"
        )
        return None

    exec_type: str = str(raw.get("type", "shell")).lower()
    if exec_type not in ("shell", "python", "http"):
        logger.warning(
            f"_parse_executor: unknown executor type '{exec_type}', "
            f"fallback to shell"
        )
        exec_type = "shell"

    # === 提取公共字段 ===
    timeout_raw: Any = raw.get("timeout", 30)
    try:
        timeout: int = max(1, min(int(timeout_raw), 300))  # 1-300s
    except (TypeError, ValueError):
        timeout = 30

    description: str = str(raw.get("description", "")).strip()

    # === 按 type 提取特定字段 ===
    if exec_type == "shell":
        command: str = str(raw.get("command", "")).strip()
        if not command:
            logger.warning(
                "_parse_executor: shell executor missing 'command' field"
            )
            return None
        args_raw: Any = raw.get("args", [])
        args: list[str] = (
            [str(a) for a in args_raw] if isinstance(args_raw, list) else []
        )
        return {
            "type": "shell",
            "command": command,
            "args": args,
            "timeout": timeout,
            "description": description,
        }

    if exec_type == "python":
        script: str = str(raw.get("script", "")).strip()
        if not script:
            logger.warning(
                "_parse_executor: python executor missing 'script' field"
            )
            return None
        return {
            "type": "python",
            "script": script,
            "timeout": timeout,
            "description": description,
        }

    # http
    url: str = str(raw.get("url", "")).strip()
    if not url:
        logger.warning(
            "_parse_executor: http executor missing 'url' field"
        )
        return None
    method: str = str(raw.get("method", "GET")).upper()
    headers_raw: Any = raw.get("headers", {})
    headers: dict[str, str] = (
        {str(k): str(v) for k, v in headers_raw.items()}
        if isinstance(headers_raw, dict)
        else {}
    )
    return {
        "type": "http",
        "method": method,
        "url": url,
        "headers": headers,
        "timeout": timeout,
        "description": description,
    }
