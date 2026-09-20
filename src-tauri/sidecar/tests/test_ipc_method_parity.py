"""
tests/test_ipc_method_parity.py —— 前端调用的 RPC 方法必须都被 sidecar 注册（#67 前提）
=====================================================================================

Rust 侧 `ipc_invoke` 的方法白名单（#67）**以 sidecar ready 快照里的 `methods`
为唯一真源**。这条链上最危险的失效不是"放行多了"，而是**前端有个调用点没被注册**
—— 那样白名单一上线就静默打断功能，而"grep 一遍前端"并不可信（人一定会漏）。

所以本文件把两件事钉成测试：
1. 前端源码里出现的每个 sidecar 命名空间下的方法字面量，都必须在注册表里；
2. `invokeRpc(...)` 的方法名必须是字面量 —— 传变量意味着本文件的扫描看不到它，
   白名单就会在运行时把它拒掉（要动态派发请走已注册的方法，别绕开这张表）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_SIDECAR_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _SIDECAR_DIR.parent.parent
sys.path.insert(0, str(_SIDECAR_DIR))

import main  # noqa: E402  — 复用其 register_business_methods 作为注册真源

SRC_DIR = _REPO_ROOT / "src"

# 前端 → sidecar 的三种真实调用形状。**按形状扫，不按"看起来像方法名"扫** ——
# 第一版用"已注册命名空间 + 点号字面量"做过滤，立刻误报了 `agent.focusAttention`
# （Tauri 事件名）和 `tdsf.sidecarTimeoutMs`（配置键）：命名空间会撞车。
_INVOKE_RPC_RE = re.compile(r"""invokeRpc\s*(?:<[^<>]*>)?\(\s*['"]([\w.]+)['"]""")
# `notify(` 但排除 `xxx.notify(`（LSP 客户端也有同名方法，走的是另一条通道）
_BRIDGE_NOTIFY_RE = re.compile(r"""(?:^|[^\w.$])notify\(\s*['"]([\w.]+)['"]""", re.M)
# invoke<...>("ipc_invoke", { method: "a.b" ... })：method 可能换行，故允许 200 字符窗口
_DIRECT_INVOKE_RE = re.compile(
    r"""ipc_(?:invoke|notify)['"]?\s*,\s*\{[^{}]{0,200}?method:\s*['"]([\w.]+)['"]""",
    re.S,
)

# 扫描器不能悄悄退化：这几个方法在，才说明式子还在工作
_CRITICAL_METHODS = {
    "agent.invoke",
    "agent.configure",
    "risk.evaluate",
    "skill.list",
    "skill.invoke",
    "system.probe_env",
    "evidence.assess",
    "knowledge.search_full",
    "memory.summarize_session",
}


class _FakeDispatcher:
    """只收集方法名（与 tests/test_main_register_methods.py 同一手法）。"""

    def __init__(self) -> None:
        self.methods: dict[str, object] = {}
        self.notifications: dict[str, object] = {}

    def register(self, name: str, fn: object) -> None:
        self.methods[name] = fn

    def register_notification(self, name: str, fn: object) -> None:
        self.notifications[name] = fn

    def add_method(self, name: str, **kwargs: object) -> None:  # 兼容装饰器式注册
        self.methods[name] = True

    def list_methods(self) -> list[str]:
        return sorted(self.methods)


def _registered_methods() -> set[str]:
    dispatcher = _FakeDispatcher()
    main.register_business_methods(dispatcher)
    return set(dispatcher.methods)


def _frontend_source_files() -> list[Path]:
    files: list[Path] = []
    for path in SRC_DIR.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        # 测试文件里的假方法名不代表生产调用面（且常有 "not.a.method" 之类占位）
        if ".test." in path.name or path.name.endswith(".d.ts"):
            continue
        files.append(path)
    return files


def _strip_comments(text: str) -> str:
    """JSDoc 里的示例调用不是生产调用面。

    第一版没剥注释，把 `sidecar-bridge.ts` 文档示例里的 `notify('task.cancel')`
    当成真实调用点报了"未注册"—— 而它报得也对：`task.cancel` 确实没注册，
    那句示例本身就是假的（真取消语义还没做，见 ROADMAP #69）。示例已改掉。
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def _frontend_calls() -> dict[str, list[str]]:
    """method 字面量 → 调用它的文件（相对路径）。"""
    calls: dict[str, list[str]] = {}
    for path in _frontend_source_files():
        text = _strip_comments(path.read_text(encoding="utf-8"))
        rel = str(path.relative_to(_REPO_ROOT))
        for pattern in (_INVOKE_RPC_RE, _BRIDGE_NOTIFY_RE, _DIRECT_INVOKE_RE):
            for literal in pattern.findall(text):
                calls.setdefault(literal, []).append(rel)
    return calls


def test_registered_method_set_is_not_empty():
    """注册表本身要是空的，下面的断言会全绿但什么都没说 —— 先自我把关。"""
    registered = _registered_methods()
    assert len(registered) > 50, f"注册方法数异常少：{len(registered)}"
    assert "agent.invoke" in registered


def test_every_sidecar_method_the_frontend_calls_is_registered():
    """前端每个 RPC 调用点的方法，sidecar 必须真的注册了。"""
    registered = _registered_methods()
    calls = _frontend_calls()

    missing = {m: fs for m, fs in calls.items() if m not in registered}
    assert not missing, (
        "前端调用了 sidecar 未注册的方法，#67 白名单会上线即静默打断这些调用点：\n"
        + "\n".join(f"  {m} ← {', '.join(sorted(set(fs)))}" for m, fs in sorted(missing.items()))
    )
    # 扫描器退化（有人换了调用写法 / 改了导入名）会让这条测试假绿，所以钉住关键面
    assert _CRITICAL_METHODS <= set(calls), (
        f"没扫到这些必在的调用点，说明扫描式子已失效：{sorted(_CRITICAL_METHODS - set(calls))}"
    )


def test_frontend_never_passes_a_computed_method_name():
    """`invokeRpc(变量)` 会让本文件的扫描瞎掉 —— 动态方法名一律禁止。"""
    dynamic = re.compile(r"invokeRpc\s*(?:<[^<>]*>)?\(\s*[A-Za-z_$][\w$]*\s*[,)]")
    offenders: list[str] = []
    for path in _frontend_source_files():
        if dynamic.search(_strip_comments(path.read_text(encoding="utf-8"))):
            offenders.append(str(path.relative_to(_REPO_ROOT)))
    assert not offenders, (
        "这些文件用变量当 RPC 方法名，白名单无法静态校验，请改回字面量：\n"
        + "\n".join(f"  {o}" for o in offenders)
    )


def test_inject_terminal_channel_stays_retired():
    """#71（2026-09-20 用户拍板整体下线）：inject_terminal 两头都不许再出现代码级引用。

    发送端原先是 `ssh_command.py` 里的 `if False:` 死块，前端仍留一个
    `sidecar:inject_terminal` 监听器 —— 半退役通道比没有更危险：下一次有人把
    `if False` 改回来，就会和 execute_via_ssh 双重执行同一条服务器命令，正是
    当初停掉它的理由。用户可见执行只有一条路（visible-terminal 通道）。

    判据用**调用形态**而不是裸子串，注释里讲历史不算复活
    （第一版用子串匹配，被自己写的解释性注释误报过一次）。
    """
    sender_re = re.compile(r"""send_notification\(\s*['"]inject_terminal""")
    listeners_re = re.compile(r"""['"]sidecar:inject_terminal['"]""")
    # 只扫真正的生产源码目录：sidecar 下还有 PyInstaller 产物/虚拟环境，rglob 全仓
    # 会把门禁耗时交给磁盘上有多少拷贝。
    sidecar_sources = [
        *(_SIDECAR_DIR / "strands_backend").rglob("*.py"),
        *_SIDECAR_DIR.glob("*.py"),
    ]
    senders = [
        str(p.relative_to(_REPO_ROOT))
        for p in sidecar_sources
        if "tests" not in p.parts
        and sender_re.search(p.read_text(encoding="utf-8"))
    ]
    listeners = [
        str(p.relative_to(_REPO_ROOT))
        for p in _frontend_source_files()
        if listeners_re.search(_strip_comments(p.read_text(encoding="utf-8")))
    ]
    assert not senders, f"sidecar 又出现 inject_terminal 发送端: {senders}"
    assert not listeners, f"前端又出现 inject_terminal 监听器: {listeners}"


def test_notification_channel_still_has_no_production_caller():
    """#67 的白名单只拦请求通道，理由必须可测：sidecar 没注册任何通知方法，
    生产代码也没有 `ipc_notify` 调用点。任何一条不再成立，就必须回去给通知通道
    也补上真源与校验 —— 别让它悄悄变成白名单的旁路。"""
    fake = _FakeDispatcher()
    main.register_business_methods(fake)
    assert not fake.notifications, (
        f"sidecar 开始注册通知方法了（{sorted(fake.notifications)}），"
        "ipc_notify 也需要方法白名单"
    )
    notify_callers = [
        str(p.relative_to(_REPO_ROOT))
        for p in _frontend_source_files()
        if _BRIDGE_NOTIFY_RE.search(_strip_comments(p.read_text(encoding="utf-8")))
    ]
    assert not notify_callers, (
        f"前端出现了 ipc_notify 调用点（{notify_callers}），"
        "但通知通道没有白名单 —— 补校验再合入"
    )
