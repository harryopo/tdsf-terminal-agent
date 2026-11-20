from __future__ import annotations

import json
from pathlib import Path

import pytest

from strands_backend.turn_policy import (
    assess_output_profile,
    render_turn_policy_prompt,
    route_turn,
)

SCENARIOS = json.loads(
    (Path(__file__).parent / "fixtures" / "turn_policy_scenarios.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda item: item["id"])
def test_thirty_synthetic_ops_scenarios_have_deterministic_profile(scenario: dict) -> None:
    first = route_turn(
        scenario["input"],
        teach=scenario.get("teach", False),
        skill=scenario.get("skill", False),
    )
    second = route_turn(
        scenario["input"],
        teach=scenario.get("teach", False),
        skill=scenario.get("skill", False),
    )

    assert first == second
    assert first.intent == scenario["intent"]


def test_route_does_not_mutate_permissions_tools_model_or_target() -> None:
    runtime = {
        "permission_mode": "confirm",
        "tools": ("readonly", "execute"),
        "model": "unchanged",
        "target": "real-session",
    }
    before = dict(runtime)

    decision = route_turn("请重启 nginx 并验证状态")

    assert decision.intent == "command"
    assert runtime == before
    assert not hasattr(decision, "permission_mode")
    assert not hasattr(decision, "tools")
    assert not hasattr(decision, "target")


def test_prompt_appends_profile_without_replacing_existing_instructions() -> None:
    original = "原始系统提示与真实工具约束"
    prompt = render_turn_policy_prompt(original, "请分析为什么磁盘写入失败")

    assert prompt.startswith(original)
    assert "最可能原因" in prompt
    assert "首选" in prompt
    assert "隐藏思维链" in prompt


def test_explicit_skill_and_ambiguity_do_not_invent_a_profile() -> None:
    skill = route_turn("/skill:linux 请巡检", skill=True)
    ambiguous = route_turn("error 生产")

    assert skill.intent == "general"
    assert skill.reason == "explicit_skill"
    assert ambiguous.intent == "general"
    assert ambiguous.reason == "no_high_confidence_rule"


def test_format_failure_keeps_real_output_and_reports_issue() -> None:
    real_output = "工具返回：退出码未知；原始输出保持原样。"

    assessment = assess_output_profile(real_output, "command")

    assert assessment.preserved_text == real_output
    assert assessment.issues
    assert assessment.ok is False

def test_empty_input_and_explicit_skill_prompt_passthrough() -> None:
    assert route_turn("  \n ").reason == "empty_input"
    original = "原始技能指令"
    assert render_turn_policy_prompt(original, "/skill:linux 巡检", skill=True) == original
