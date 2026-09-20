"""#90 门禁：prompt 不许指挥模型去调用「当前组合下没注册」的工具。

真机症状（用户 2026-09-20 实测截图）：确认档 + 教学开关打开时，教学皮肤
第一句写着「开场先调用 system_probe_teaching 采集环境基线」，而该工具的注册
条件与皮肤拼装条件是两套 —— 模型照着皮肤去调，撞一次失败后自己退回手敲
ssh_command 探测环境。用户判词：确认档不该有教学探测；教学档也不需要开场
全量探测，基础环境（发行版/内核/主机）由程序自动感知喂给模型。

按"以一次为例横扫同类"的要求，本文件钉的是整类问题而不是那一个工具：
1. 具体回归 —— system_probe_teaching 这条通道整体不存在了。
2. 类级别 —— 把工具集装配抽成 `resolve_runtime_toolset` 后，四种
   (mode, teach) 组合的 prompt 与注册集可以互相核对：prompt 里出现的任何
   已知工具名，要么该组合下真注册了，要么必须在同一段里用
   「本模式不可用：a, b, c」显式声明。新增工具时忘了声明就会红。
   （横扫当场又抓到两处：观察档此前一直在让模型调 python_run / skill_invoke /
   assess_confidence / search_history，而 schema 裁剪早把它们移除了。）
"""
from __future__ import annotations

import unittest

from strands_backend.adapter import (
    _DEFAULT_SYSTEM_PROMPT,
    _MODE_PROMPTS,
    _TEACH_MODE_PROMPT,
    _TEACH_SKIN_PROMPT,
    AgentMode,
    _compose_system_prompt,
    resolve_runtime_toolset,
)
from strands_backend.tools import ToolContext
from strands_backend.tools.registry import TOOL_REGISTRY

_ALL_MODES = (AgentMode.OBSERVE, AgentMode.CONFIRM, AgentMode.AUTO)

# prompt 里声明"这些工具本模式调不到"的固定前缀（与 adapter 的措辞同源）
_UNAVAILABLE_PREFIX = "本模式不可用："

# 已知工具名全集：注册表 + 运行时追加项（插件工具不在 TOOL_REGISTRY 里）
_KNOWN_TOOL_NAMES = frozenset(TOOL_REGISTRY) | {
    "teach_command",
    "retrieve_offloaded_content",
}


def _prompt_for(mode: AgentMode, teach: bool) -> str:
    return _compose_system_prompt(mode, teach, base=_DEFAULT_SYSTEM_PROMPT)


def _registered_names(mode: AgentMode, teach: bool) -> set[str]:
    ctx = ToolContext(teach=teach, permission_level=2)
    tools = resolve_runtime_toolset(ctx, mode=mode, teach=teach)
    return {getattr(t, "__name__", "") for t in tools}


def _mode_fragment(mode: AgentMode, teach: bool) -> str:
    """该组合实际拼进去的模式段（OBSERVE+teach 用 TEACH 段替掉 OBSERVE 段）"""
    return (
        _TEACH_MODE_PROMPT
        if teach and mode == AgentMode.OBSERVE
        else _MODE_PROMPTS[mode]
    )


def _mentioned_names(prompt: str) -> set[str]:
    return {name for name in _KNOWN_TOOL_NAMES if name in prompt}


def _declared_unavailable(prompt: str) -> set[str]:
    """解析「本模式不可用：a, b, c」声明（可多行，逗号分隔，允许尾随括注）"""
    declared: set[str] = set()
    for line in prompt.splitlines():
        idx = line.find(_UNAVAILABLE_PREFIX)
        if idx < 0:
            continue
        tail = line[idx + len(_UNAVAILABLE_PREFIX):]
        tail = tail.split("（", 1)[0]
        tokens = (tok.strip().rstrip("。").strip() for tok in tail.split(","))
        declared |= {tok for tok in tokens if tok}
    return declared


class TestPromptToolParity(unittest.TestCase):
    def test_every_combination_composes_mode_fragment_and_skin(self):
        """四种组合各自拼对的模式段；皮肤只在 observe+teach 拼（#90）"""
        for mode in _ALL_MODES:
            for teach in (False, True):
                with self.subTest(mode=mode.value, teach=teach):
                    prompt = _prompt_for(mode, teach)
                    self.assertGreater(
                        len(prompt), len(_DEFAULT_SYSTEM_PROMPT)
                    )
                    self.assertIn(_mode_fragment(mode, teach), prompt)
                    self.assertEqual(
                        _TEACH_SKIN_PROMPT in prompt,
                        teach and mode == AgentMode.OBSERVE,
                    )

    def test_teach_switch_alone_never_leaks_teach_contract(self):
        """确认/自动档 + 教学开关：不得拿到任何教学说明书（用户 2026-09-20 判词）"""
        for mode in (AgentMode.CONFIRM, AgentMode.AUTO):
            prompt = _prompt_for(mode, teach=True)
            self.assertEqual(prompt, _prompt_for(mode, teach=False))
            for fragment in (_TEACH_SKIN_PROMPT, _TEACH_MODE_PROMPT):
                self.assertNotIn(fragment[:24], prompt)

    def test_prompt_never_refs_undeclared_unregistered_tool(self):
        """prompt 提到的已知工具：要么注册了，要么显式声明本模式不可用"""
        for mode in _ALL_MODES:
            for teach in (False, True):
                with self.subTest(mode=mode.value, teach=teach):
                    prompt = _prompt_for(mode, teach)
                    allowed = (
                        _registered_names(mode, teach)
                        | _declared_unavailable(prompt)
                    )
                    self.assertEqual(
                        _mentioned_names(prompt) - allowed,
                        set(),
                        f"{mode.value}/teach={teach}：prompt 指挥模型调用未注册工具",
                    )

    def test_unavailable_declaration_is_not_stale(self):
        """声明「不可用」的工具必须真的没注册，也不能一条都没提到"""
        for mode in _ALL_MODES:
            for teach in (False, True):
                with self.subTest(mode=mode.value, teach=teach):
                    prompt = _prompt_for(mode, teach)
                    declared = _declared_unavailable(prompt)
                    self.assertEqual(
                        declared & _registered_names(mode, teach), set()
                    )
                    self.assertTrue(declared <= _mentioned_names(prompt))

    def test_observe_declares_what_its_schema_filter_strips(self):
        """观察档的裁剪必须逐项写进声明，不能只靠模型自己试出来"""
        for teach in (False, True):
            with self.subTest(teach=teach):
                prompt = _prompt_for(AgentMode.OBSERVE, teach)
                missing = _mentioned_names(prompt) - _registered_names(
                    AgentMode.OBSERVE, teach
                )
                self.assertTrue(missing, "观察档本该裁掉若干工具")
                self.assertTrue(missing <= _declared_unavailable(prompt))


class TestOpeningProbeRetired(unittest.TestCase):
    """#90 本体：开场环境探测整体下线（用户 2026-09-20 决策）"""

    def test_tool_absent_from_registry(self):
        self.assertNotIn("system_probe_teaching", TOOL_REGISTRY)

    def test_module_deleted(self):
        import importlib

        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module(
                "strands_backend.tools.system_probe_teaching"
            )

    def test_no_prompt_fragment_mentions_it(self):
        for fragment in (
            _DEFAULT_SYSTEM_PROMPT,
            _TEACH_MODE_PROMPT,
            _TEACH_SKIN_PROMPT,
            *_MODE_PROMPTS.values(),
        ):
            self.assertNotIn("system_probe_teaching", fragment)

    def test_teach_skin_has_no_opening_probe_script(self):
        """皮肤不得再要求开场采集环境（要看什么就出对应命令卡）"""
        for banned in ("探测", "基线", "开场先"):
            self.assertNotIn(banned, _TEACH_SKIN_PROMPT)

    def test_basic_environment_reaches_model_via_context_not_tool(self):
        """基础环境改由程序喂：皮肤必须指向 <environment> 而不是让模型自己采"""
        self.assertIn("<environment>", _TEACH_SKIN_PROMPT)


class TestRuntimeToolsetSingleSource(unittest.TestCase):
    """注册集由 resolve_runtime_toolset 一处决定（与皮肤同一张矩阵）"""

    def test_observe_teach_keeps_card_chain_and_drops_suggest(self):
        names = _registered_names(AgentMode.OBSERVE, teach=True)
        self.assertIn("teach_command", names)
        self.assertNotIn("suggest_command", names)

    def test_observe_without_teach_has_no_card_primitive_or_exec_tool(self):
        names = _registered_names(AgentMode.OBSERVE, teach=False)
        self.assertNotIn("teach_command", names)
        self.assertNotIn("ssh_command", names)
        self.assertNotIn("python_run", names)

    def test_confirm_registers_everything_the_base_prompt_relies_on(self):
        """确认/自动档是基准面：基础皮肤依赖的工具在此必须全注册"""
        for mode in (AgentMode.CONFIRM, AgentMode.AUTO):
            names = _registered_names(mode, teach=False)
            for required in ("ssh_command", "python_run", "skill_invoke"):
                self.assertIn(required, names)


if __name__ == "__main__":
    unittest.main()
