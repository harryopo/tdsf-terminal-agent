"""Deterministic output-profile routing without runtime or permission changes."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class TurnPolicy:
    intent: str
    profile: str
    reason: str


@dataclass(frozen=True)
class OutputAssessment:
    ok: bool
    issues: tuple[str, ...]
    preserved_text: str


_PROFILES = {
    "general": "先给简短结论，再给关键依据或必要下一步；不主动扩展命令。",
    "ops_report": "按状态表、异常项、首选处理、验证组织；先异常后正常。",
    "diagnose": "按最可能原因、首选检查/处理、验证、条件化备选组织。",
    "command": "按首选命令、必要风险/审批、验证、必要回退组织；只给一个首选方案。",
    "teach": "沿用现有教学命令卡与真实结果等待，不增加工具或权限。",
}

_REPORT_RE = re.compile(
    r"(巡检|健康检查|状态汇总|汇总.*(?:状态|负载|节点|主机)|(?:状态|负载|节点|主机).*汇总|异常项.*正常项)"
)
_DIAGNOSE_RE = re.compile(
    r"(故障|报错|失败|崩溃|异常|超时).*(?:排查|诊断|分析|定位|原因|根因|怎么)|"
    r"(?:排查|诊断|分析|定位|解释).*(?:故障|报错|失败|崩溃|异常|超时)|"
    r"为什么.*(?:失败|报错|异常)|根因"
)
_COMMAND_RE = re.compile(
    r"(?:帮我|请|给出|生成|写).*(?:命令|重启|关闭|创建|归档|清理|执行)|"
    r"^(?:执行|重启|停止|启动|关闭|创建|删除|安装|压缩|清理)|"
    r"^把.*(?:压缩|归档|清理|创建|删除|修改)|"
    r"如何(?:创建|删除|安装|配置|修改|关闭|重启)"
)


def route_turn(text: str, *, teach: bool = False, skill: bool = False) -> TurnPolicy:
    """Route only high-confidence requests; ambiguous text always uses general."""
    if skill or text.lstrip().startswith("/skill:"):
        return TurnPolicy("general", "general", "explicit_skill")
    if teach:
        return TurnPolicy("teach", "teach", "explicit_teach_mode")
    normalized = " ".join(text.strip().split())
    if not normalized:
        return TurnPolicy("general", "general", "empty_input")
    if _REPORT_RE.search(normalized):
        return TurnPolicy("ops_report", "ops_report", "explicit_ops_report")
    if _DIAGNOSE_RE.search(normalized):
        return TurnPolicy("diagnose", "diagnose", "explicit_diagnosis")
    if _COMMAND_RE.search(normalized):
        return TurnPolicy("command", "command", "explicit_command_request")
    return TurnPolicy("general", "general", "no_high_confidence_rule")


def render_turn_policy_prompt(
    prompt: str,
    user_input: str,
    *,
    teach: bool = False,
    skill: bool = False,
) -> str:
    """Append output guidance while preserving every existing instruction."""
    decision = route_turn(user_input, teach=teach, skill=skill)
    if decision.reason == "explicit_skill":
        return prompt
    return (
        f"{prompt}\n\n【输出策略：{decision.profile}】\n"
        f"{_PROFILES[decision.profile]}\n"
        "首选足以回答时不列等价备选；备选必须带触发条件。环境或结果未知时明确未知。"
        "只给简短关键依据，不输出隐藏思维链，不编造工具结果或成功结论。"
    )


def assess_output_profile(text: str, intent: str) -> OutputAssessment:
    """Report format gaps without replacing or rewriting real model/tool output."""
    required = {
        "command": ("命令", "验证"),
        "ops_report": ("状态", "异常", "验证"),
        "diagnose": ("原因", "首选", "验证"),
    }.get(intent, ())
    issues = tuple(f"missing_section:{marker}" for marker in required if marker not in text)
    return OutputAssessment(not issues, issues, text)


__all__ = [
    "OutputAssessment",
    "TurnPolicy",
    "assess_output_profile",
    "render_turn_policy_prompt",
    "route_turn",
]
