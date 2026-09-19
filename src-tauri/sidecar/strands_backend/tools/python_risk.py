"""
strands_backend/tools/python_risk.py — python_run 代码风险分级器（#66）
==========================================================================

职责：把一段 Python 源码按「有没有危险动作」分成 L0-L4，供 python_run 接入三模式
信任链（``decide(risk_l, ctx.mode)``）。用户 2026-09-19 决策 3 的口径：**只有代码里
有危险动作（删文件、联网、执行系统命令）才弹审批卡，纯算东西不打扰**。

为什么用 AST 而不是正则（ssh_command 那套文本规则搬不过来）：
- 正则版会把字符串 / docstring 里出现的 ``shutil.rmtree`` 当成危险动作（误报），
  也挡不住 ``import os as o; o.system(...)`` 这种改名（漏报）。AST 只看真实节点。
- Python 的副作用面是「调用了谁」，不是「文本里有什么」。

分级口径（与 ssh_command 的 risk_l 同一把尺子，裁决统一交给 decide）：
- L4 起子进程 / 动态执行代码 / 动态导入 / 反序列化 / ctypes
- L3 删除文件或目录、联网访问（用户点名的「删文件 / 联网」）
- L2 写入、改名、覆盖、改权限（confirm 档逐条确认，auto 档放行）
- L1 新建目录 / 空文件等轻副作用
- L0 只读与纯计算（json / re / csv / 统计 / open(...).read()）
- 语法解析失败 → 保守按 L3（fail-closed：看不清就先当高危）

已知边界（诚实声明，不是全覆盖检测）：
- 只做静态分级，不执行、不追踪数据流——``globals()["sys"]("rm -rf /")`` 这类刻意
  对抗仍可绕过；本期目标是把常见的直白写法拉进审批，而不是做沙箱。
- 变量绑定只认 ``p = Path(...)`` / ``f = open(...)`` 这类直接赋值（生成代码的常见
  形态），复杂别名不追。
"""
from __future__ import annotations

import ast
from typing import Any

RiskHit = tuple[int, str]  # (级别, 动作类别中文)

_L1, _L2, _L3, _L4 = 1, 2, 3, 4

# 模块（含包路径前缀）→ 成员名 → 风险；成员名 "*" = 该模块上任何调用都同风险
_MODULE_MEMBERS: dict[str, dict[str, RiskHit]] = {
    "os": {
        "system": (_L4, "执行系统命令"),
        "popen": (_L4, "执行系统命令"),
        "startfile": (_L4, "启动外部程序"),
        "execv": (_L4, "执行系统命令"),
        "execve": (_L4, "执行系统命令"),
        "execvp": (_L4, "执行系统命令"),
        "execvpe": (_L4, "执行系统命令"),
        "execl": (_L4, "执行系统命令"),
        "execlp": (_L4, "执行系统命令"),
        "spawnl": (_L4, "执行系统命令"),
        "spawnle": (_L4, "执行系统命令"),
        "spawnlp": (_L4, "执行系统命令"),
        "spawnlpe": (_L4, "执行系统命令"),
        "spawnv": (_L4, "执行系统命令"),
        "spawnve": (_L4, "执行系统命令"),
        "spawnvp": (_L4, "执行系统命令"),
        "spawnvpe": (_L4, "执行系统命令"),
        "fork": (_L4, "创建子进程"),
        "kill": (_L4, "结束进程"),
        "killpg": (_L4, "结束进程组"),
        "remove": (_L3, "删除文件"),
        "unlink": (_L3, "删除文件"),
        "rmdir": (_L3, "删除目录"),
        "removedirs": (_L3, "删除目录树"),
        "rename": (_L2, "改名/覆盖文件"),
        "renames": (_L2, "改名/覆盖文件"),
        "replace": (_L2, "覆盖文件"),
        "truncate": (_L2, "截断文件"),
        "chmod": (_L2, "修改文件权限"),
        "lchmod": (_L2, "修改文件权限"),
        "chown": (_L2, "修改文件归属"),
        "link": (_L2, "创建硬链接"),
        "symlink": (_L2, "创建符号链接"),
        "makedirs": (_L1, "创建目录"),
        "mkdir": (_L1, "创建目录"),
    },
    "subprocess": {"*": (_L4, "执行系统命令")},
    "multiprocessing": {"*": (_L4, "创建子进程")},
    "ctypes": {"*": (_L4, "调用本机动态库")},
    "importlib": {"*": (_L4, "动态导入")},
    "socket": {"*": (_L3, "联网访问")},
    "ssl": {"*": (_L3, "联网访问")},
    "urllib3": {"*": (_L3, "联网访问")},
    "requests": {"*": (_L3, "联网访问")},
    "httpx": {"*": (_L3, "联网访问")},
    "aiohttp": {"*": (_L3, "联网访问")},
    "http.client": {"*": (_L3, "联网访问")},
    "ftplib": {"*": (_L3, "联网访问")},
    "smtplib": {"*": (_L3, "联网发送邮件")},
    "poplib": {"*": (_L3, "联网访问")},
    "imaplib": {"*": (_L3, "联网访问")},
    "telnetlib": {"*": (_L3, "联网访问")},
    "shutil": {
        "rmtree": (_L3, "删除目录树"),
        "move": (_L2, "移动/覆盖文件"),
        "copy": (_L2, "写入文件"),
        "copy2": (_L2, "写入文件"),
        "copyfile": (_L2, "写入文件"),
        "copytree": (_L2, "写入目录树"),
        "copystat": (_L2, "修改文件属性"),
    },
    "pathlib.Path": {
        "unlink": (_L3, "删除文件"),
        "rmdir": (_L3, "删除目录"),
        "write_text": (_L2, "写入文件"),
        "write_bytes": (_L2, "写入文件"),
        "chmod": (_L2, "修改文件权限"),
        "touch": (_L1, "创建文件"),
        "mkdir": (_L1, "创建目录"),
    },
    "urllib.request": {
        "urlopen": (_L3, "联网访问"),
        "urlretrieve": (_L3, "下载文件到本地"),
        "Request": (_L3, "联网访问"),
    },
    "pickle": {"load": (_L4, "反序列化执行"), "loads": (_L4, "反序列化执行")},
    "marshal": {"load": (_L4, "反序列化执行"), "loads": (_L4, "反序列化执行")},
    "yaml": {"load": (_L4, "反序列化执行")},
    "webbrowser": {"*": (_L2, "打开外部浏览器")},
}

# 裸函数名（内置函数，或 from x import y 之后的本地名）
_BARE_CALL_RISK: dict[str, RiskHit] = {
    "eval": (_L4, "动态执行代码"),
    "exec": (_L4, "动态执行代码"),
    "compile": (_L4, "动态执行代码"),
    "__import__": (_L4, "动态导入"),
    "breakpoint": (_L4, "进入调试器"),
}

# 接收者解析不出来时，仍凭「方法名」判定的无歧义危险 API。
# 故意不放 remove / run / loads / replace / move 这类通用名（list.remove、json.loads
# 会被误伤）——它们靠模块名或 from 导入别名命中。
_MEMBER_NAME_RISK: dict[str, RiskHit] = {
    "system": _MODULE_MEMBERS["os"]["system"],
    "popen": _MODULE_MEMBERS["os"]["popen"],
    "startfile": _MODULE_MEMBERS["os"]["startfile"],
    "fork": _MODULE_MEMBERS["os"]["fork"],
    "killpg": _MODULE_MEMBERS["os"]["killpg"],
    "unlink": _MODULE_MEMBERS["os"]["unlink"],
    "rmtree": _MODULE_MEMBERS["shutil"]["rmtree"],
    "urlopen": _MODULE_MEMBERS["urllib.request"]["urlopen"],
    "urlretrieve": _MODULE_MEMBERS["urllib.request"]["urlretrieve"],
    "write_text": _MODULE_MEMBERS["pathlib.Path"]["write_text"],
    "write_bytes": _MODULE_MEMBERS["pathlib.Path"]["write_bytes"],
}

# 文件对象（f = open(...)）上的写操作
_FILE_MEMBER_RISK: dict[str, RiskHit] = {
    "write": (_L2, "写入文件"),
    "writelines": (_L2, "写入文件"),
    "truncate": (_L2, "截断文件"),
}

# 构造结果绑到变量后仍要能判级（p = Path(x); p.unlink()）
_BOUND_TYPE_BY_CONSTRUCTOR: dict[str, str] = {
    "pathlib.Path": "pathlib.Path",
    "Path": "pathlib.Path",
    "open": "_file",
    "socket.socket": "socket.socket",
}

# open(path, mode) 里算「写」的模式字符
_WRITE_MODE_MARKS = ("w", "a", "x", "+")


# 审批卡的事实说明按 category 选文案（与 command_impact 用的类别名对齐）
_CATEGORY_BY_KEYWORD: tuple[tuple[str, str], ...] = (
    ("删除", "delete"),
    ("联网", "network"),
    ("下载", "network"),
    ("发送", "network"),
    ("子进程", "code_execution"),
    ("进程", "code_execution"),
    ("执行", "code_execution"),
    ("动态", "code_execution"),
    ("反序列化", "code_execution"),
    ("调试器", "code_execution"),
    ("动态库", "code_execution"),
    ("线程", "code_execution"),
    ("权限", "perm"),
    ("归属", "perm"),
    ("属性", "perm"),
    ("写入", "file_write"),
    ("改名", "file_write"),
    ("覆盖", "file_write"),
    ("移动", "file_write"),
    ("截断", "file_write"),
    ("链接", "file_write"),
    ("创建", "file_write"),
    ("打开", "file_write"),
    ("持久化", "file_write"),
)


def _category_of(kind: str) -> str:
    for keyword, category in _CATEGORY_BY_KEYWORD:
        if keyword in kind:
            return category
    return "code_execution"


def _build_qualified_index() -> list[tuple[str, RiskHit]]:
    """(限定名 → 风险) 扁平表，级别高者优先匹配"""
    items: list[tuple[str, RiskHit]] = []
    for module, members in _MODULE_MEMBERS.items():
        for name, hit in members.items():
            if name != "*":
                items.append((f"{module}.{name}", hit))
    items.sort(key=lambda kv: -kv[1][0])
    return items


_QUALIFIED_INDEX = _build_qualified_index()


class _Analyzer(ast.NodeVisitor):
    """遍历 AST 收集危险调用（只看节点，不执行代码）"""

    def __init__(self) -> None:
        self.actions: list[dict[str, Any]] = []
        # 本地名 → 规范名：模块别名（import os as o）与 from 导入（run → subprocess.run）
        self._alias: dict[str, str] = {}
        # 本地名 → 类型规范名（p = Path(...) 之后的 p.unlink()）
        self._binding: dict[str, str] = {}

    def _add(self, level: int, kind: str, call: str, line: int) -> None:
        self.actions.append(
            {
                "call": call,
                "kind": kind,
                "category": _category_of(kind),
                "level": level,
                "line": line,
            }
        )

    # ---- 名字解析 ----
    def _dotted(self, node: ast.AST) -> str:
        """把 a.b.c 形态还原成规范点号名；接收者是 Path('a') 这类构造时也展开"""
        parts: list[str] = []
        cur: ast.AST = node
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            root = cur.id
            parts.append(self._alias.get(root, self._binding.get(root, root)))
        elif isinstance(cur, ast.Call):
            parts.append(self._dotted(cur.func))
        else:
            return ""
        return ".".join(reversed([p for p in parts if p]))

    def _match(self, canonical: str, attr: str) -> tuple[RiskHit, str] | None:
        """按「裸内置名 → 完全限定名 → 模块任意调用 → 无歧义方法名」四级查风险表"""
        if "." not in canonical:
            hit = _BARE_CALL_RISK.get(canonical)
            if hit is not None:
                return hit, canonical
        for key, hit in _QUALIFIED_INDEX:
            if canonical == key or canonical.endswith("." + key):
                return hit, key
        head = canonical.split(".", 1)[0]
        wildcard = _MODULE_MEMBERS.get(head, {}).get("*")
        if wildcard is not None:
            return wildcard, canonical
        if canonical.startswith("_file.") and attr in _FILE_MEMBER_RISK:
            return _FILE_MEMBER_RISK[attr], canonical
        # 接收者解析不出来时兜底：表里只有 system / unlink / rmtree 这类无歧义名字
        hit = _MEMBER_NAME_RISK.get(attr)
        if hit is not None:
            return hit, canonical or attr
        return None

    # ---- 节点访问 ----
    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            # import a.b.c 绑定的名字是根 a（属性链天然成立）；只有 as 改名才换根
            root = alias.name.split(".", 1)[0]
            self._alias[alias.asname or root] = alias.name if alias.asname else root
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        pkg = node.module or ""
        for alias in node.names:
            self._alias[alias.asname or alias.name] = (
                f"{pkg}.{alias.name}" if pkg else alias.name
            )
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        value = node.value
        if isinstance(value, ast.Call):
            bound = _BOUND_TYPE_BY_CONSTRUCTOR.get(self._dotted(value.func), "")
            if bound:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        self._binding[target.id] = bound
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        if isinstance(func, ast.Attribute):
            attr = func.attr
        elif isinstance(func, ast.Name):
            attr = func.id
        else:
            attr = ""
        canonical = self._dotted(func)

        if canonical == "open" or (not canonical and attr == "open"):
            self._check_open(node)
        elif attr in ("getattr", "__getattribute__"):
            # getattr(os, "system") —— 属性名写在常量里，照样按该属性判级
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                name = node.args[1].value
                if isinstance(name, str):
                    hit = _MEMBER_NAME_RISK.get(name) or _BARE_CALL_RISK.get(name)
                    if hit:
                        self._add(hit[0], hit[1], f"getattr(..., '{name}')", node.lineno)
        else:
            matched = self._match(canonical, attr)
            if matched is not None:
                (level, kind), _shown = matched
                self._add(level, kind, canonical or attr, node.lineno)
        self.generic_visit(node)

    def _check_open(self, node: ast.Call) -> None:
        """open(path, mode)：写模式算 L2，只读模式不算风险"""
        mode = ""
        if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
            mode = str(node.args[1].value)
        for keyword in node.keywords:
            if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                mode = str(keyword.value.value)
        if mode and any(mark in mode for mark in _WRITE_MODE_MARKS):
            self._add(_L2, "写入文件", f"open(..., '{mode}')", node.lineno)


def analyze_python_code(code: str) -> dict[str, Any]:
    """静态分级一段 Python 代码（不执行、不导入被分析代码）

    Args:
        code: python_run 收到的源码

    Returns:
        dict：{risk_l, level, summary, reasons, actions, parse_error}
        risk_l 0-4；parse_error 非空表示语法不通（此时按 L3 保守处理）。
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {
            "risk_l": _L3,
            "level": f"L{_L3}",
            "summary": f"代码无法解析（{exc.msg}），按高危保守处理",
            "reasons": [f"语法解析失败：{exc.msg}"],
            "actions": [],
            "parse_error": str(exc.msg or exc),
        }

    analyzer = _Analyzer()
    analyzer.visit(tree)
    actions = analyzer.actions
    risk_l = max((a["level"] for a in actions), default=0)
    reasons: list[str] = []
    for action in sorted(actions, key=lambda a: -a["level"]):
        text = f"{action['kind']}（{action['call']}）"
        if text not in reasons:
            reasons.append(text)
    return {
        "risk_l": risk_l,
        "level": f"L{risk_l}",
        "summary": reasons[0] if reasons else "只读与纯计算，无副作用",
        "reasons": reasons,
        "actions": actions,
        "parse_error": "",
    }


__all__ = ["analyze_python_code"]
