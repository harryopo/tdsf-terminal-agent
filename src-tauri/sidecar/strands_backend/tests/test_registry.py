"""
tests/test_registry.py — 工具三角色注册表单元测试（T2 验证）
=============================================================

验证内容（方案书 v3.0 T2：工具实现/Policy/Schema 三角色解耦）：
1. TOOL_REGISTRY 完整性：19 个工具、key 与 spec.name 一致、factory 点路径合法
2. 所有 factory 可延迟解析（resolve_factory 返回 callable）
3. 关键不变量：factory(ctx) 产物的 __name__ == spec.name
   （L1 只读过滤 + 子 agent 白名单过滤都按 __name__ 匹配，错位 = 过滤失效）
4. READONLY_TOOL_NAMES / APPROVAL_TOOL_NAMES 派生正确
5. get_tool_policy 正/反例
6. tool_catalog_text 输出格式
7. OPS_TOOL_ALIASES 显示名映射可反查

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_registry.py -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# 确保能 import strands_backend（对齐 test_tools.py 的 sys.path 处理）
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.tools import ToolContext
from strands_backend.tools.registry import (
    APPROVAL_TOOL_NAMES,
    OPS_TOOL_ALIASES,
    READONLY_TOOL_NAMES,
    TOOL_REGISTRY,
    ToolPolicy,
    ToolSpec,
    get_tool_policy,
    resolve_factory,
    tool_catalog_text,
)


def _ctx() -> ToolContext:
    return ToolContext(agent_name="registry-test", session_id="s1")


class TestRegistryIntegrity(unittest.TestCase):
    """注册表完整性"""

    def test_registry_has_23_tools(self):
        """T2 后注册表 = 13 运维/知识 + 6 魔改增强 + T14 save_skill
        + 2026-08-31 knowledge_get_doc + T5 python_run
        + P2 #42 (2026-09-01) ssh_list_sessions = 23"""
        self.assertEqual(len(TOOL_REGISTRY), 23)

    def test_key_matches_spec_name(self):
        """dict key 必须与 spec.name 一致（防复制粘贴错位）"""
        for key, spec in TOOL_REGISTRY.items():
            self.assertEqual(key, spec.name, f"registry key '{key}' != spec.name")

    def test_factory_path_format(self):
        """factory 必须是 'module:attr' 点路径格式"""
        for spec in TOOL_REGISTRY.values():
            self.assertIn(":", spec.factory, f"{spec.name}: factory 缺少 ':' 分隔")
            module_name, _, attr = spec.factory.partition(":")
            self.assertTrue(module_name, f"{spec.name}: factory module 为空")
            self.assertTrue(attr, f"{spec.name}: factory attr 为空")
            self.assertTrue(
                module_name.startswith("strands_backend.tools."),
                f"{spec.name}: factory 应位于 strands_backend.tools 包内",
            )

    def test_expected_tools_registered(self):
        """核心工具名齐全（13 原有 + 6 收编 + T14 save_skill
        + 2026-08-31 knowledge_get_doc + T5 python_run
        + P2 #42 ssh_list_sessions）"""
        expected = {
            # 原 13
            "ssh_command", "read_remote_file", "analyze_logs",
            "inspect_processes", "network_diagnose", "skill_invoke",
            "suggest_command", "knowledge_search", "service_manage",
            "package_manage", "firewall_manage", "security_audit",
            "performance_analyze",
            # T2 收编 6
            "todo_write", "get_terminal_output", "config_diff",
            "backup_restore", "assess_confidence", "search_history",
            # T14 会话记忆沉淀
            "save_skill",
            # 2026-08-31 双库: 知识库完整文档读取
            "knowledge_get_doc",
            # T5 (2026-08-31, spec add-agent-loop-closure): python_run PTC 工具
            "python_run",
            # P2 #42 (2026-09-01, §37.90): SSH 会话枚举（多主机运维）
            "ssh_list_sessions",
        }
        self.assertEqual(expected, set(TOOL_REGISTRY.keys()))


class TestFactoryResolution(unittest.TestCase):
    """factory 延迟解析 + 关键不变量"""

    def test_all_factories_resolvable(self):
        """所有 factory 点路径都能解析出 callable"""
        for spec in TOOL_REGISTRY.values():
            factory = resolve_factory(spec)
            self.assertTrue(callable(factory), f"{spec.name}: factory 不可调用")

    def test_product_name_matches_spec_name(self):
        """关键不变量：factory(ctx) 产物的 __name__ == spec.name

        L1 只读过滤（READONLY_TOOL_NAMES）与子 agent 白名单都按
        __name__ 匹配——此处错位会导致过滤静默失效。
        """
        ctx = _ctx()
        for spec in TOOL_REGISTRY.values():
            factory = resolve_factory(spec)
            tool_fn = factory(ctx)
            self.assertEqual(
                getattr(tool_fn, "__name__", ""),
                spec.name,
                f"{spec.name}: @tool 函数名与注册名不一致（白名单过滤将失效）",
            )


class TestDerivedPolicies(unittest.TestCase):
    """派生只读/审批集合"""

    def test_readonly_set_matches_policy(self):
        expected = frozenset(
            s.name for s in TOOL_REGISTRY.values() if s.policy.readonly
        )
        self.assertEqual(READONLY_TOOL_NAMES, expected)

    def test_approval_set_matches_policy(self):
        expected = frozenset(
            s.name for s in TOOL_REGISTRY.values() if s.policy.needs_approval
        )
        self.assertEqual(APPROVAL_TOOL_NAMES, expected)

    def test_readonly_and_approval_disjoint(self):
        """readonly 工具不应同时 needs_approval（L1 裁剪与审批语义互斥）"""
        self.assertFalse(READONLY_TOOL_NAMES & APPROVAL_TOOL_NAMES)

    def test_execution_tools_need_approval(self):
        """执行/写类核心工具必须在审批集合内（T3 fail-closed 判定输入）"""
        for name in ("ssh_command", "service_manage", "package_manage",
                     "firewall_manage", "backup_restore"):
            self.assertIn(name, APPROVAL_TOOL_NAMES, f"{name} 应 needs_approval")

    def test_readonly_tools_not_in_approval(self):
        for name in ("read_remote_file", "analyze_logs", "suggest_command",
                     "security_audit", "performance_analyze", "todo_write"):
            self.assertIn(name, READONLY_TOOL_NAMES, f"{name} 应 readonly")
            self.assertNotIn(name, APPROVAL_TOOL_NAMES)


class TestPolicyQuery(unittest.TestCase):
    """get_tool_policy 查询"""

    def test_query_existing(self):
        p = get_tool_policy("ssh_command")
        self.assertIsInstance(p, ToolPolicy)
        self.assertFalse(p.readonly)
        self.assertTrue(p.needs_approval)

    def test_query_missing_returns_none(self):
        self.assertIsNone(get_tool_policy("no_such_tool"))

    def test_policy_frozen(self):
        """ToolPolicy 不可变（frozen dataclass）"""
        p = get_tool_policy("ssh_command")
        with self.assertRaises(Exception):
            p.readonly = True  # type: ignore[misc]


class TestToolCatalog(unittest.TestCase):
    """tool_catalog_text 输出（Schema 角色批量出口）"""

    def test_catalog_contains_all_tools(self):
        text = tool_catalog_text()
        lines = [ln for ln in text.splitlines() if ln.strip()]
        self.assertEqual(len(lines), len(TOOL_REGISTRY))
        for spec in TOOL_REGISTRY.values():
            self.assertIn(f"- {spec.name}: {spec.description}", text)

    def test_aliases_resolve_to_registered_names(self):
        """OPS_TOOL_ALIASES 的值应是某 spec 的显示名对应关系（历史显示名集合）"""
        # 显示名映射：函数名 → 历史注册显示名
        for fn_name, display in OPS_TOOL_ALIASES.items():
            self.assertIn(fn_name, TOOL_REGISTRY, f"别名源 {fn_name} 未注册")
            self.assertNotEqual(fn_name, display)


class TestToolSpecDataclass(unittest.TestCase):
    """ToolSpec 数据类"""

    def test_frozen(self):
        spec = TOOL_REGISTRY["ssh_command"]
        with self.assertRaises(Exception):
            spec.name = "hacked"  # type: ignore[misc]

    def test_policy_default_not_readonly(self):
        """默认 policy 非 readonly（新增工具若漏标 policy 会走审批侧，fail-closed）"""
        p = ToolPolicy()
        self.assertFalse(p.readonly)
        self.assertFalse(p.needs_approval)


if __name__ == "__main__":
    unittest.main()
