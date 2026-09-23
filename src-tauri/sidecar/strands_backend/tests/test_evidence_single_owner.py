"""证据面板：一次工具调用只许留一条证据（2026-09-23 实测抓到的重复记账）。

实测复现：`service_manage` 一次调用落 **2 条**证据 ——
- `_execute_via_ssh_impl` 记一条（source=`strands_tool`，`tools/__init__.py:1703`）；
- adapter 的 after-tool hook 又记一条（source=`main_agent.strands.hook`，`adapter.py:990`），
  因为它的免记判断写的是 `name == "ssh_command"`（`adapter.py:936`）——**按一个名字**排除，
  而证据的真正主人是"走不走 execute_via_ssh"这条**代码路径**。
受影响的是全部经 execute_via_ssh 的非 ssh_command 工具（service_manage / package_manage /
firewall_manage / security_audit / performance_analyze / analyze_logs / inspect_processes /
network_diagnose / backup_restore / config_diff）。

修法：把"证据由谁记"变成注册表里的一句声明（`ToolPolicy.via_ssh_executor`），
hook 按声明免记；再用一条静态门禁测试把"声明"和"模块是否真的调 execute_via_ssh"钉成
完全一致 —— 新增工具忘了声明就直接红，不再靠人记得改一张名字名单。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.ops_extended import invoke_service_manage_tool

_ALLOW = {
    "decision": "allow",
    "risk": {"level": "L0", "high_risk": False},
    "impact": {"segments": [], "max_risk_l": 0},
    "risk_l": 0,
}
_SESSION = "t-evidence-dedup"


def setup_function() -> None:
    """pytest 的模块级逐用例钩子叫 setup_function（写成 setup_method 不会被调用）。"""
    get_global_tracker().clear(_SESSION)


def _ctx() -> ToolContext:
    bridge = MagicMock()
    bridge.ipc_invoke = MagicMock(
        return_value={"ok": True, "output": "active", "exit_code": 0, "duration": 0.1}
    )
    return ToolContext(
        event_bus=MagicMock(), rust_bridge=bridge, agent_name="main",
        session_id=_SESSION, ssh_session_id="1",
    )


def _rows(tool: str = "service_manage") -> list[dict]:
    return [r for r in get_global_tracker().list(_SESSION) if r["tool_name"] == tool]


def test_one_call_leaves_exactly_one_evidence_row():
    """执行器记过之后，hook 不许再为同一次调用补一条。"""
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW):
        invoke_service_manage_tool({"action": "status", "service": "nginx"}, ctx)
    hook = ToolCallLimitHook(agent_name="main", session_id=_SESSION)
    hook._record_evidence(
        "service_manage",
        {"action": "status", "service": "nginx"},
        {"status": "success", "command": "systemctl status nginx --no-pager -l"},
        False,
    )
    rows = _rows()
    assert len(rows) == 1, f"一次调用留了 {len(rows)} 条证据：{rows}"


def test_dedup_is_scoped_to_the_same_command_not_the_tool():
    """同工具、不同命令（真跑了两次）各留一条——去重不许吞掉真实操作。"""
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW):
        invoke_service_manage_tool({"action": "status", "service": "nginx"}, ctx)
        invoke_service_manage_tool({"action": "status", "service": "sshd"}, ctx)
    assert len(_rows()) == 2


def test_hook_still_records_tools_outside_the_executor():
    """反向保底：不经 SSH 执行器的工具（如 todo_write）仍由 hook 记账，别一刀切静音。"""
    hook = ToolCallLimitHook(agent_name="main", session_id=_SESSION)
    hook._record_evidence("todo_write", {"items": []}, {"status": "success"}, False)
    rows = [r for r in get_global_tracker().list(_SESSION) if r["tool_name"] == "todo_write"]
    assert len(rows) == 1


def test_ssh_routed_tools_all_declare_their_owner():
    """免记名单不许靠人记得改：注册表声明必须和"模块是否调 execute_via_ssh"完全一致。

    新增一个走 SSH 执行器的工具却忘了声明 → 这条红（就会又长出第二条证据）。
    """
    import pathlib
    import re

    from strands_backend.tools.registry import TOOL_REGISTRY

    root = pathlib.Path(__file__).resolve().parents[2] / "strands_backend" / "tools"
    routed_modules = set()
    for path in root.glob("*.py"):
        if path.name == "__init__.py":
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"execute_via_ssh\(|invoke_ssh_command_tool\(", text):
            routed_modules.add(path.stem)

    declared = {
        name
        for name, spec in TOOL_REGISTRY.items()
        if spec.factory and spec.factory.split(":")[0].split(".")[-1] in routed_modules
    }
    missing = sorted(
        name
        for name in declared
        if not getattr(TOOL_REGISTRY[name].policy, "via_ssh_executor", False)
    )
    wrongly_marked = sorted(
        spec.name
        for spec in TOOL_REGISTRY.values()
        if getattr(spec.policy, "via_ssh_executor", False)
        and (not spec.factory or spec.factory.split(":")[0].split(".")[-1] not in routed_modules)
    )
    assert not missing, f"这些工具经 SSH 执行器执行却没声明 via_ssh_executor：{missing}"
    assert not wrongly_marked, f"声明了 via_ssh_executor 但其实不走执行器：{wrongly_marked}"
    assert len(declared) >= 10, f"识别到的执行器工具只有 {len(declared)} 个，判据可能失效"


def test_hook_no_longer_special_cases_ssh_command_by_name():
    """`name == "ssh_command"` 那条按名字的免记必须删掉（11 个工具里它只挡住 1 个）。"""
    import inspect

    src = inspect.getsource(ToolCallLimitHook._record_evidence)
    assert '== "ssh_command"' not in src and "== 'ssh_command'" not in src
