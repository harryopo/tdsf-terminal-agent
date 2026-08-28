"""
skills/registry.py — SkillRegistry（T-P3-05）
================================================

职责：
- SkillRegistry：管理 5 个内置 Skill（TDSF 实际可调用）
- 支持注册 / 查询 / 调用 / 注销
- 启动时自动从 skills/builtin/ 加载 5 内置 Skill
- 支持从外部目录加载用户自定义 Skill
- 大小写不敏感查询（get/list 容忍大小写）

设计要点：
- 单例模式（全局共享一个 registry 实例）
- 线程安全（threading.Lock 保护 _skills 字典）
- 内置 Skill invoke 分两路：
  - 含 executor 元数据 → 真正执行 shell/python/http，返回 stdout/stderr/exit_code
  - 无 executor → 返回 SKILL.md 内容（知识卡，Agent 用作参考）
- 调用接口已留扩展位（mock 列表 _MOCK_SKILL_NAMES 仍保留源码注释,
  便于后续在 Settings 中显式启用"市场/Marketplace"时重新加载）

invoke 行为：
- 内置 Skill（有 executor）: 真正执行 → {success, output: stdout+stderr, exit_code, executor}
- 内置 Skill（无 executor）: 返回 {content: skill.body, when_to_use, steps, examples, source: "builtin"}
- mock Skill:            返回 {content: "mock skill: ..."} (占位，无实际功能)
"""

from __future__ import annotations

import json
import logging
import shlex
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from skills.parser import Skill, parse_skill_md

logger = logging.getLogger("sidecar.skills.registry")


# ============================================================================
# 常量定义
# ============================================================================

# 内置 Skill 根目录（python-sidecar/skills/builtin/）
_BUILTIN_DIR: Path = Path(__file__).parent / "builtin"

# TDSF 魔改 (T1 2026-08-28): 用户自定义 Skill 目录（~/.tdsf/skills/）
# 启动时若存在则自动加载（<dir>/<skill_name>/SKILL.md 或 <dir>/*.md），
# 与 tdsf_loader 的 ~/TDSF.md 惯例对齐——用户无需改代码即可沉淀自己的技能包
_USER_SKILLS_DIR: Path = Path.home() / ".tdsf" / "skills"

# 65 mock 外部 Skill 名称（模拟 claude-skills 库的常见 Skill）
_MOCK_SKILL_NAMES: list[str] = [
    # === 编程语言类（10）===
    "rust-debug",
    "go-concurrency",
    "java-spring",
    "kotlin-coroutine",
    "swift-ui",
    "typescript-advanced",
    "c-memory",
    "cpp-stl",
    "ruby-rails",
    "php-laravel",
    # === Web 框架类（10）===
    "react-hooks",
    "vue-composition",
    "svelte-kit",
    "nextjs-app-router",
    "nuxt-3",
    "express-middleware",
    "fastapi-dependency",
    "django-orm",
    "flask-blueprint",
    "astro-islands",
    # === 数据库类（8）===
    "postgres-tuning",
    "mysql-replication",
    "redis-cluster",
    "mongodb-sharding",
    "sqlite-fts5",
    "elasticsearch-mapping",
    "cassandra-lsm",
    "neo4j-cypher",
    # === DevOps 类（10）===
    "k8s-deploy",
    "helm-chart",
    "terraform-module",
    "ansible-playbook",
    "jenkins-pipeline",
    "gitlab-ci",
    "github-actions",
    "argocd-gitops",
    "prometheus-alert",
    "grafana-dashboard",
    # === 监控日志类（6）===
    "loki-log",
    "tempo-trace",
    "jaeger-tracing",
    "opentelemetry-instr",
    "datadog-apm",
    "elk-stack",
    # === 安全类（6）===
    "openssl-cert",
    "gpg-encrypt",
    "ssh-hardening",
    "fail2ban-config",
    "ufw-firewall",
    "nmap-scan",
    # === AI/ML 类（5）===
    "pytorch-train",
    "tensorflow-serving",
    "huggingface-pipeline",
    "langchain-agent",
    "llama-index-rag",
    # === 工具类（10）===
    "git-rebase",
    "vim-macro",
    "tmux-session",
    "zsh-plugin",
    "fzf-finder",
    "ripgrep-search",
    "sed-awk",
    "cron-schedule",
    "systemd-timer",
    "rsync-backup",
]


# ============================================================================
# SkillRegistry 类
# ============================================================================


class SkillRegistry:
    """Skill 注册表

    管理 70+ Skill（5 内置 + 65 mock 外部）。
    支持注册 / 查询 / 调用 / 注销，大小写不敏感。

    用法：
        registry = SkillRegistry()
        registry.load_builtin()              # 加载 5 内置 Skill
        registry.load_mock_external(65)      # 加载 65 mock Skill
        skill = registry.get("linux-ops")    # 查询
        result = registry.invoke("linux-ops", {})  # 调用
    """

    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}  # lowercased_name → Skill
        self._lock: threading.Lock = threading.Lock()
        logger.info("SkillRegistry initialized")

    # ========================================================================
    # 注册 / 注销
    # ========================================================================

    def register(self, skill: Skill) -> bool:
        """注册 Skill

        Args:
            skill: Skill 对象（name 必须非空）

        Returns:
            True 表示注册成功；False 表示 name 为空或已存在（同小写名）
        """
        if not skill.name or not skill.name.strip():
            logger.warning("register: skill name is empty, skipped")
            return False

        key: str = skill.name.lower()
        with self._lock:
            if key in self._skills:
                logger.warning(
                    f"register: skill '{skill.name}' already exists, "
                    f"overwriting"
                )
            self._skills[key] = skill
            logger.debug(f"registered skill: {skill.name}")
        return True

    def unregister(self, name: str) -> bool:
        """注销 Skill

        Args:
            name: Skill 名称（大小写不敏感）

        Returns:
            True 表示注销成功；False 表示不存在
        """
        if not name:
            return False
        key: str = name.lower()
        with self._lock:
            if key not in self._skills:
                logger.warning(f"unregister: skill '{name}' not found")
                return False
            del self._skills[key]
            logger.info(f"unregistered skill: {name}")
        return True

    # ========================================================================
    # 查询
    # ========================================================================

    def get(self, name: str) -> Skill | None:
        """查询 Skill（大小写不敏感）

        Args:
            name: Skill 名称

        Returns:
            Skill 对象；不存在返回 None
        """
        if not name:
            return None
        key: str = name.lower()
        with self._lock:
            return self._skills.get(key)

    def list(self) -> list[Skill]:
        """列出所有已注册的 Skill（按 name 排序）"""
        with self._lock:
            skills: list[Skill] = list(self._skills.values())
        skills.sort(key=lambda s: s.name)
        return skills

    def list_names(self) -> list[str]:
        """列出所有 Skill 名称（按字母排序）"""
        with self._lock:
            names: list[str] = sorted(s.name for s in self._skills.values())
        return names

    def count(self) -> int:
        """返回已注册 Skill 数量"""
        with self._lock:
            return len(self._skills)

    def exists(self, name: str) -> bool:
        """判断 Skill 是否存在（大小写不敏感）"""
        if not name:
            return False
        return name.lower() in self._skills

    def search(self, query: str) -> list[Skill]:
        """按 name / description / tags / triggers 搜索 Skill

        Args:
            query: 搜索关键词（大小写不敏感）

        Returns:
            匹配的 Skill 列表（按 name 排序）
        """
        if not query:
            return []
        q: str = query.lower()
        with self._lock:
            results: list[Skill] = []
            for skill in self._skills.values():
                if q in skill.name.lower():
                    results.append(skill)
                    continue
                if q in skill.description.lower():
                    results.append(skill)
                    continue
                if any(q in tag.lower() for tag in skill.tags):
                    results.append(skill)
                    continue
                # TDSF 魔改 (T1 2026-08-28): triggers 触发词参与命中
                if any(q in trig.lower() for trig in skill.triggers):
                    results.append(skill)
                    continue
        results.sort(key=lambda s: s.name)
        return results

    # ========================================================================
    # 调用
    # ========================================================================

    def invoke(self, name: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """调用 Skill

        调用行为（按优先级）:
        1. **有 executor 元数据**: 真正执行 shell/python/http, 返回 stdout/stderr/exit_code
        2. **无 executor**: 返回 SKILL.md 完整内容（作为 Agent 参考的知识卡）

        Args:
            name: Skill 名称（大小写不敏感）
            params: 调用参数（透传给 executor，部分 type 支持 ${input} 替换）

        Returns:
            调用结果字典:
            - 真正执行: {success, name, output, exit_code, executor, duration_ms}
            - 知识卡:   {name, content, when_to_use, steps, examples, params, source: "builtin"}

        Raises:
            KeyError: Skill 不存在
        """
        skill: Skill | None = self.get(name)
        if skill is None:
            raise KeyError(f"skill not found: {name}")

        params = params or {}

        # === 分支 1: 含 executor → 真正执行 (TDSF 魔改 P0-2 修复 2026-07-28) ===
        if skill.executor:
            try:
                exec_result: dict[str, Any] = _run_executor(skill.executor, params)
                return {
                    "name": skill.name,
                    "executor": skill.executor,
                    "success": exec_result["success"],
                    "exit_code": exec_result["exit_code"],
                    "output": exec_result["output"],
                    "stdout": exec_result["stdout"],
                    "stderr": exec_result["stderr"],
                    "duration_ms": exec_result["duration_ms"],
                    "params": params,
                    "source": "builtin",
                }
            except Exception as e:
                # 执行器本身抛错（不是被调命令出错）→ 记录并降级到知识卡
                logger.exception(
                    f"invoke: executor for skill '{name}' raised: {e}"
                )
                return {
                    "name": skill.name,
                    "executor": skill.executor,
                    "success": False,
                    "exit_code": -1,
                    "output": f"执行器异常: {e}",
                    "stdout": "",
                    "stderr": str(e),
                    "duration_ms": 0,
                    "params": params,
                    "source": "builtin",
                    "error": str(e),
                }

        # === 分支 2: 无 executor → 返回 SKILL.md 内容（知识卡） ===
        if skill.file_path:
            return {
                "name": skill.name,
                "description": skill.description,
                "content": skill.body,
                "when_to_use": skill.when_to_use,
                "steps": skill.steps,
                "examples": skill.examples,
                # TDSF 魔改 (T1 2026-08-28): 贯通 tags / triggers / allowed-tools，
                # 让 Agent 知道该技能的触发词与建议使用的工具白名单
                "tags": skill.tags,
                "triggers": skill.triggers,
                "allowed_tools": skill.allowed_tools,
                "params": params,
                "source": "builtin",
            }

        # mock Skill：返回模板
        return {
            "name": skill.name,
            "content": f"mock skill: {skill.name}",
            "description": skill.description,
            "tags": skill.tags,
            "params": params,
            "source": "mock",
            "note": "this is a mock external skill, install from marketplace to use",
        }

    # ========================================================================
    # 批量加载
    # ========================================================================

    def load_builtin(self, builtin_dir: Path | str | None = None) -> int:
        """从 builtin_dir 加载内置 Skill（5 个）

        Args:
            builtin_dir: 内置 Skill 根目录。None 时使用默认 _BUILTIN_DIR

        Returns:
            成功加载的 Skill 数量
        """
        bd: Path = Path(builtin_dir) if builtin_dir else _BUILTIN_DIR
        if not bd.exists():
            logger.warning(f"load_builtin: builtin dir not found: {bd}")
            return 0

        count: int = 0
        for skill_md in bd.glob("*/SKILL.md"):
            try:
                skill: Skill = parse_skill_md(skill_md)
                if self.register(skill):
                    count += 1
            except Exception as e:
                logger.exception(f"load_builtin: failed to parse {skill_md}: {e}")

        logger.info(f"load_builtin: loaded {count} skills from {bd}")
        return count

    def load_external_dir(self, external_dir: Path | str) -> int:
        """从外部目录加载用户自定义 Skill

        支持两种目录结构：
        - <dir>/<skill_name>/SKILL.md
        - <dir>/*.md（每文件一个 Skill）

        Args:
            external_dir: 外部 Skill 目录

        Returns:
            成功加载的 Skill 数量
        """
        ed: Path = Path(external_dir)
        if not ed.exists():
            logger.warning(f"load_external_dir: dir not found: {ed}")
            return 0

        count: int = 0
        # 模式 1：<dir>/<skill_name>/SKILL.md
        for skill_md in ed.glob("*/SKILL.md"):
            try:
                skill = parse_skill_md(skill_md)
                if self.register(skill):
                    count += 1
            except Exception as e:
                logger.exception(f"load_external_dir: parse {skill_md} failed: {e}")

        # 模式 2：<dir>/*.md（根目录的 md 文件）
        for skill_md in ed.glob("*.md"):
            try:
                skill = parse_skill_md(skill_md)
                if self.register(skill):
                    count += 1
            except Exception as e:
                logger.exception(f"load_external_dir: parse {skill_md} failed: {e}")

        logger.info(f"load_external_dir: loaded {count} skills from {ed}")
        return count

    def load_mock_external(self, count: int = 65) -> int:
        """加载 mock 外部 Skill（模拟 claude-skills 库）

        Args:
            count: 加载数量（默认 65，最大 65）

        Returns:
            成功加载的 mock Skill 数量
        """
        n: int = min(count, len(_MOCK_SKILL_NAMES))
        loaded: int = 0
        for i in range(n):
            name: str = _MOCK_SKILL_NAMES[i]
            skill: Skill = Skill(
                name=name,
                description=f"mock external skill: {name}",
                version="0.1.0",
                author="claude-skills",
                tags=_mock_tags_for(name),
                when_to_use=f"触发关键词：{name}",
                steps=f"1. 调用 {name} 处理任务\n2. 返回模板结果",
                examples=f"示例：使用 {name} 完成任务",
                body=f"# {name}\n\nmock skill body",
            )
            if self.register(skill):
                loaded += 1

        logger.info(f"load_mock_external: loaded {loaded} mock skills")
        return loaded

    # ========================================================================
    # JSON-RPC 兼容
    # ========================================================================

    def to_json(self) -> list[dict[str, Any]]:
        """序列化所有 Skill 为 JSON 兼容列表（供 skill.list 方法返回）"""
        with self._lock:
            return [s.to_dict() for s in self._skills.values()]


# ============================================================================
# 辅助函数
# ============================================================================


def _mock_tags_for(name: str) -> list[str]:
    """根据 mock skill 名称生成 tags"""
    if "-" not in name:
        return [name]
    parts: list[str] = name.split("-", 1)
    return [parts[0], name]


# TDSF 魔改 (P0-2 修复 2026-07-28): Skill 真正执行器
# ---------------------------------------------------------------------------
# 解析 executor 块并真正执行 shell/python/http, 替代原先的"返回 SKILL.md 文本"
# 返回结构: {success, exit_code, output, stdout, stderr, duration_ms}
# ---------------------------------------------------------------------------
def _run_executor(
    executor: dict[str, Any],
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """执行 Skill 的 executor 块

    Args:
        executor: parser._parse_executor() 解析后的执行器描述
        params: 调用参数（透传给 executor, 含 input/args 等）

    Returns:
        dict 含 success / exit_code / output / stdout / stderr / duration_ms

    Raises:
        ValueError: executor type 不支持
        RuntimeError: subprocess 自身失败（非被调命令的 exit_code != 0）
    """
    params = params or {}
    user_input: str = str(params.get("input", ""))
    exec_type: str = executor.get("type", "shell")
    timeout: int = int(executor.get("timeout", 30))
    description: str = executor.get("description", "")

    import time

    start: float = time.monotonic()

    if exec_type == "shell":
        result = _run_shell_executor(executor, user_input, timeout)
    elif exec_type == "python":
        result = _run_python_executor(executor, user_input, timeout)
    elif exec_type == "http":
        result = _run_http_executor(executor, user_input, timeout)
    else:
        raise ValueError(f"unsupported executor type: {exec_type}")

    duration_ms: int = int((time.monotonic() - start) * 1000)

    # 拼装 combined output 供 UI 展示
    stdout: str = result.get("stdout", "")
    stderr: str = result.get("stderr", "")
    combined: str = stdout
    if stderr and stderr.strip():
        if combined and not combined.endswith("\n"):
            combined += "\n"
        combined += f"[stderr]\n{stderr}"

    if description:
        combined = f"# {description}\n\n{combined}" if combined else f"# {description}"

    return {
        "success": result.get("success", False),
        "exit_code": result.get("exit_code", 0),
        "output": combined,
        "stdout": stdout,
        "stderr": stderr,
        "duration_ms": duration_ms,
    }


def _interpolate(template: str, user_input: str) -> str:
    """替换模板字符串中的 ${input} 占位符

    Args:
        template: 原始字符串（可能含 ${input}）
        user_input: 来自用户 args 字段的输入

    Returns:
        替换后的字符串
    """
    if "${input}" not in template:
        return template
    # 安全转义：防止用户输入包含 shell 注入字符
    # 用 shlex.quote 把 user_input 包成单参数字符串
    safe_input: str = shlex.quote(user_input) if user_input else ""
    return template.replace("${input}", safe_input)


def _run_shell_executor(
    executor: dict[str, Any],
    user_input: str,
    timeout: int,
) -> dict[str, Any]:
    """执行 shell executor"""
    command: str = _interpolate(executor.get("command", ""), user_input)
    args: list[str] = executor.get("args", [])

    if not command.strip():
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "executor.command is empty",
        }

    # Windows 下用 cmd.exe /c 执行 shlex 拆分的命令
    # POSIX 下用 sh -c
    full_cmd: list[str]
    if args and len(args) > 0:
        full_cmd = shlex.split(command) + args
    else:
        full_cmd = shlex.split(command)

    logger.info(
        f"shell executor: cmd={full_cmd}, timeout={timeout}, input='{user_input[:80]}'"
    )

    try:
        completed: subprocess.CompletedProcess[bytes] = subprocess.run(
            full_cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
            text=False,  # 保留 bytes, 手动 decode 防编码错误
        )
        try:
            stdout_str: str = completed.stdout.decode("utf-8", errors="replace")
        except Exception:
            stdout_str = str(completed.stdout)
        try:
            stderr_str: str = completed.stderr.decode("utf-8", errors="replace")
        except Exception:
            stderr_str = str(completed.stderr)
        return {
            "success": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout": stdout_str,
            "stderr": stderr_str,
        }
    except subprocess.TimeoutExpired as e:
        stdout_b = e.stdout or b""
        stderr_b = e.stderr or b""
        return {
            "success": False,
            "exit_code": -1,
            "stdout": stdout_b.decode("utf-8", errors="replace") if isinstance(stdout_b, bytes) else str(stdout_b),
            "stderr": f"命令执行超时（>{timeout}s）\n"
            + (stderr_b.decode("utf-8", errors="replace") if isinstance(stderr_b, bytes) else str(stderr_b)),
        }
    except FileNotFoundError as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"命令未找到: {e}",
        }
    except Exception as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"执行失败: {e}",
        }


def _run_python_executor(
    executor: dict[str, Any],
    user_input: str,
    timeout: int,
) -> dict[str, Any]:
    """执行 python executor（在独立子进程中跑用户脚本，超时强杀）"""
    script: str = executor.get("script", "")
    if not script.strip():
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "executor.script is empty",
        }

    # 准备脚本：把 user_input 作为环境变量 TDSF_SKILL_INPUT 注入
    # 这样脚本可以用 os.environ["TDSF_SKILL_INPUT"] 拿到
    env_prefix: str = (
        "import os, sys, json\n"
        f"input_data = os.environ.get('TDSF_SKILL_INPUT', '')\n"
        "os.environ.pop('TDSF_SKILL_INPUT', None)\n"
    )
    full_script: str = env_prefix + script

    try:
        completed: subprocess.CompletedProcess[bytes] = subprocess.run(
            [sys.executable, "-c", full_script],
            capture_output=True,
            timeout=timeout,
            check=False,
            env={
                **__import__("os").environ,
                "TDSF_SKILL_INPUT": user_input,
                "PYTHONIOENCODING": "utf-8",
            },
        )
        return {
            "success": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout": completed.stdout.decode("utf-8", errors="replace"),
            "stderr": completed.stderr.decode("utf-8", errors="replace"),
        }
    except subprocess.TimeoutExpired as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": (e.stdout or b"").decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else "",
            "stderr": f"Python 脚本执行超时（>{timeout}s）",
        }
    except Exception as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Python 执行失败: {e}",
        }


def _run_http_executor(
    executor: dict[str, Any],
    user_input: str,
    timeout: int,
) -> dict[str, Any]:
    """执行 http executor（用 urllib 标准库, 无第三方依赖）"""
    method: str = executor.get("method", "GET").upper()
    url: str = _interpolate(executor.get("url", ""), user_input)
    headers: dict[str, str] = executor.get("headers", {})

    if not url.strip():
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "executor.url is empty",
        }

    import urllib.error
    import urllib.request

    body: bytes | None = None
    if method in ("POST", "PUT", "PATCH") and user_input:
        body = user_input.encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers=headers,
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw: bytes = resp.read()
            return {
                "success": True,
                "exit_code": resp.status,
                "stdout": raw.decode("utf-8", errors="replace"),
                "stderr": "",
            }
    except urllib.error.HTTPError as e:
        return {
            "success": False,
            "exit_code": e.code,
            "stdout": e.read().decode("utf-8", errors="replace") if e.fp else "",
            "stderr": f"HTTP {e.code} {e.reason}",
        }
    except urllib.error.URLError as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"网络错误: {e.reason}",
        }
    except Exception as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"HTTP 执行失败: {e}",
        }


# ============================================================================
# 模块级单例
# ============================================================================

_global_registry: SkillRegistry | None = None
_global_registry_lock: threading.Lock = threading.Lock()


def get_global_registry() -> SkillRegistry:
    """获取全局 SkillRegistry 单例

    首次调用时自动加载：
    - 5+ 内置 Skill（linux-ops / docker-management / selinux-baseline /
      ssh-troubleshoot / python-debug / systemd-troubleshoot / samba-setup）
    - 用户自定义 Skill（~/.tdsf/skills/，存在则加载；T1 2026-08-28）

    Returns:
        SkillRegistry 实例（已加载内置 + 用户 Skill）
    """
    global _global_registry
    if _global_registry is not None:
        return _global_registry
    with _global_registry_lock:
        if _global_registry is not None:
            return _global_registry
        registry: SkillRegistry = SkillRegistry()
        registry.load_builtin()
        # TDSF 魔改 (T1 2026-08-28): 加载用户自定义 Skill 目录
        # ~/.tdsf/skills/ 不存在时静默跳过（load_external_dir 内部处理）
        user_loaded: int = registry.load_external_dir(_USER_SKILLS_DIR)
        # TDSF 魔改：不再自动加载 65 个 mock 外部 skill
        # 原逻辑会注册 "argocd-gitops" / "rust-debug" 等用户不需要的占位 skill,
        # 前端打开后内容是 "mock skill body", 没有实际价值, 干扰用户判断.
        # 如未来需要"市场/Marketplace"功能, 在 Settings 中提供显式开关调用
        # registry.load_mock_external() 即可. _MOCK_SKILL_NAMES 列表保留.
        _global_registry = registry
        logger.info(
            f"global SkillRegistry initialized: "
            f"{registry.count()} skills loaded "
            f"(builtin + user={user_loaded}, mock disabled)"
        )
    return _global_registry


def reload_global_registry() -> SkillRegistry:
    """热重载全局 SkillRegistry（T1 2026-08-28 新增）

    清空现有注册表并重新加载内置 + 用户目录 Skill。
    用途：skill.reload JSON-RPC 方法——用户新增/修改 SKILL.md 后
    无需重启 sidecar 即可生效。

    Returns:
        重建后的 SkillRegistry 实例
    """
    global _global_registry
    with _global_registry_lock:
        registry: SkillRegistry = SkillRegistry()
        registry.load_builtin()
        user_loaded: int = registry.load_external_dir(_USER_SKILLS_DIR)
        _global_registry = registry
        logger.info(
            f"global SkillRegistry reloaded: "
            f"{registry.count()} skills loaded "
            f"(builtin + user={user_loaded}, mock disabled)"
        )
    return _global_registry


def reset_global_registry() -> None:
    """重置全局单例（仅供测试使用）"""
    global _global_registry
    with _global_registry_lock:
        _global_registry = None


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 skill.* 方法

    注册的方法：
    - skill.list:    列出所有 Skill
    - skill.get:     查询指定 Skill 详情
    - skill.invoke:  调用指定 Skill
    - skill.search:  搜索 Skill
    - skill.register: 注册新 Skill（仅元数据）
    - skill.unregister: 注销 Skill
    """
    registry: SkillRegistry = get_global_registry()

    def _skill_list(
        limit: int | None = None,
        offset: int = 0,
        tag: str | None = None,
    ) -> dict[str, Any]:
        """列出所有已注册的 Skill

        Args:
            limit: 返回数量上限（None 表示全部）
            offset: 跳过前 N 个（用于分页）
            tag: 按 tag 过滤（None 不过滤）
        """
        skills: list[Skill] = registry.list()
        if tag:
            skills = [s for s in skills if tag in s.tags]
        total = len(skills)
        if offset > 0:
            skills = skills[offset:]
        if limit is not None and limit > 0:
            skills = skills[:limit]
        return {
            "skills": [s.to_dict() for s in skills],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def _skill_get(name: str) -> dict[str, Any]:
        """查询指定 Skill 详情"""
        skill: Skill | None = registry.get(name)
        if skill is None:
            return {"ok": False, "error": f"skill not found: {name}"}
        return {"ok": True, "skill": skill.to_dict()}

    def _skill_invoke(name: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """调用指定 Skill"""
        try:
            result: dict[str, Any] = registry.invoke(name, params)
            return {"ok": True, "result": result}
        except KeyError as e:
            return {"ok": False, "error": str(e)}

    def _skill_search(query: str) -> dict[str, Any]:
        """搜索 Skill（按 name / description / tags）"""
        skills: list[Skill] = registry.search(query)
        return {
            "skills": [s.to_dict() for s in skills],
            "total": len(skills),
            "query": query,
        }

    def _skill_count() -> dict[str, Any]:
        """返回已注册 Skill 总数"""
        return {"count": registry.count()}

    def _skill_reload() -> dict[str, Any]:
        """热重载 Skill 注册表（T1 2026-08-28 新增）

        重新加载内置 + 用户目录（~/.tdsf/skills/）的 SKILL.md，
        新增/修改技能包后无需重启 sidecar。
        """
        try:
            new_registry: SkillRegistry = reload_global_registry()
            return {
                "ok": True,
                "count": new_registry.count(),
                "names": new_registry.list_names(),
            }
        except Exception as e:
            logger.exception(f"skill.reload failed: {e}")
            return {"ok": False, "error": f"skill reload failed: {e}"}

    dispatcher.register("skill.list", _skill_list)
    dispatcher.register("skill.get", _skill_get)
    dispatcher.register("skill.invoke", _skill_invoke)
    dispatcher.register("skill.search", _skill_search)
    dispatcher.register("skill.count", _skill_count)
    dispatcher.register("skill.reload", _skill_reload)
    logger.info("skill.* methods registered (6 methods)")
